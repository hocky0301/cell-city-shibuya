#!/usr/bin/env python3
"""
CELL CITY: SHIBUYA — PLATEAU bake pipeline
PLATEAU 3D Tiles (渋谷区 LOD1, notexture) をダウンロードし、
渋谷駅スクランブル交差点を原点とするローカル座標系のチャンク分割バイナリに焼く。

出典: 国土交通省 Project PLATEAU (CC BY 4.0 相当 / 政府標準利用規約)
"""
import json, math, os, struct, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np

BASE = "https://plateau.geospatial.jp/main/data/3d-tiles/bldg/13100_tokyo/13113_shibuya-ku/notexture/"
CACHE = "/tmp/plateau_cache"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# 渋谷スクランブル交差点
CENTER_LAT = 35.65945
CENTER_LON = 139.70056
HALF_EXTENT = 1050.0   # m (正方形の半辺)
CHUNK_SIZE = 128.0     # m
FLOOR_H = 3.1          # 窓グリッド用想定階高

# ---- WGS84 / ECEF / ENU ----
A = 6378137.0
E2 = 6.69437999014e-3

def geodetic_to_ecef(lat, lon, h):
    phi, lam = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(phi) ** 2)
    x = (n + h) * math.cos(phi) * math.cos(lam)
    y = (n + h) * math.cos(phi) * math.sin(lam)
    z = (n * (1 - E2) + h) * math.sin(phi)
    return np.array([x, y, z])

C_ECEF = geodetic_to_ecef(CENTER_LAT, CENTER_LON, 30.0)
phi, lam = math.radians(CENTER_LAT), math.radians(CENTER_LON)
EAST = np.array([-math.sin(lam), math.cos(lam), 0.0])
NORTH = np.array([-math.sin(phi) * math.cos(lam), -math.sin(phi) * math.sin(lam), math.cos(phi)])
UP = np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])
R_ENU = np.stack([EAST, NORTH, UP])  # rows

def ecef_to_local(p):  # p: (N,3) ECEF -> three.js (x=east, y=up, z=-north)
    enu = (p - C_ECEF) @ R_ENU.T
    out = np.empty_like(enu)
    out[:, 0] = enu[:, 0]
    out[:, 1] = enu[:, 2]
    out[:, 2] = -enu[:, 1]
    return out

def ecef_dir_to_local(v):  # 方向ベクトル(法線)用: 回転のみ
    enu = v @ R_ENU.T
    out = np.empty_like(enu)
    out[:, 0] = enu[:, 0]
    out[:, 1] = enu[:, 2]
    out[:, 2] = -enu[:, 1]
    return out

def gltf_yup_to_ecef_axes(v):
    # b3dm内のglTFはy-up: ecef = (x, -z, y)
    out = np.empty_like(v)
    out[:, 0] = v[:, 0]
    out[:, 1] = -v[:, 2]
    out[:, 2] = v[:, 1]
    return out

# ---- tile selection ----
def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    req = urllib.request.Request(url, headers={"User-Agent": "cell-city-bake/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest + ".tmp", "wb") as f:
        f.write(r.read())
    os.rename(dest + ".tmp", dest)
    return dest

def collect_tiles(tileset):
    # bbox in radians
    dlat = HALF_EXTENT / 111320.0 * 1.15
    dlon = HALF_EXTENT / (111320.0 * math.cos(phi)) * 1.15
    w, s = math.radians(CENTER_LON - dlon), math.radians(CENTER_LAT - dlat)
    e, n = math.radians(CENTER_LON + dlon), math.radians(CENTER_LAT + dlat)
    hits = []
    def walk(node):
        bv = node.get("boundingVolume", {}).get("region")
        if bv and (bv[2] < w or bv[0] > e or bv[3] < s or bv[1] > n):
            return  # disjoint -> children も region 内に含まれるので打ち切り
        c = node.get("content")
        if c:
            uri = c.get("uri") or c.get("url")
            if uri:
                hits.append(uri)
        for ch in node.get("children", []):
            walk(ch)
    walk(tileset["root"])
    return hits

# ---- b3dm / glb parsing ----
CT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
CT_NP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
TYPE_N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def read_accessor(gltf, bin_chunk, idx):
    acc = gltf["accessors"][idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    comp = acc["componentType"]; n = TYPE_N[acc["type"]]; count = acc["count"]
    stride = bv.get("byteStride") or CT_SIZE[comp] * n
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    raw = bin_chunk[off: off + stride * (count - 1) + CT_SIZE[comp] * n]
    if stride == CT_SIZE[comp] * n:
        arr = np.frombuffer(raw, dtype=CT_NP[comp], count=count * n)
    else:
        arr = np.lib.stride_tricks.as_strided(
            np.frombuffer(raw, dtype=np.uint8), shape=(count, CT_SIZE[comp] * n), strides=(stride, 1)
        ).copy().view(CT_NP[comp])
    return arr.reshape(count, n) if n > 1 else arr.reshape(count)

def parse_b3dm(path):
    raw = open(path, "rb").read()
    magic, ver, blen, ftj, ftb, btj, btb = struct.unpack("<4s6I", raw[:28])
    assert magic == b"b3dm", path
    o = 28
    ft = json.loads(raw[o:o + ftj]) if ftj else {}
    o += ftj + ftb
    bt = json.loads(raw[o:o + btj]) if btj else {}
    bt_bin = raw[o + btj: o + btj + btb]
    o += btj + btb
    glb = raw[o:]
    jlen, = struct.unpack("<I", glb[12:16])
    gltf = json.loads(glb[20:20 + jlen])
    bo = 20 + jlen
    bin_chunk = b""
    if bo < len(glb):
        clen, ctype = struct.unpack("<I4s", glb[bo:bo + 8])
        bin_chunk = glb[bo + 8: bo + 8 + clen]
    rtc = np.array(gltf.get("extensions", {}).get("CESIUM_RTC", {}).get("center", ft.get("RTC_CENTER", [0, 0, 0])))
    pos_l, nrm_l, bid_l, idx_l = [], [], [], []
    vbase = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            p = read_accessor(gltf, bin_chunk, at["POSITION"]).astype(np.float64)
            nrm = read_accessor(gltf, bin_chunk, at["NORMAL"]).astype(np.float32) if "NORMAL" in at else None
            bid = read_accessor(gltf, bin_chunk, at["_BATCHID"]).astype(np.int32) if "_BATCHID" in at else np.zeros(len(p), np.int32)
            if "indices" in prim:
                ind = read_accessor(gltf, bin_chunk, prim["indices"]).astype(np.uint32)
            else:
                ind = np.arange(len(p), dtype=np.uint32)
            pos_l.append(p); nrm_l.append(nrm if nrm is not None else np.zeros((len(p), 3), np.float32))
            bid_l.append(bid); idx_l.append(ind + vbase)
            vbase += len(p)
    pos = gltf_yup_to_ecef_axes(np.concatenate(pos_l)) + rtc
    nrm = gltf_yup_to_ecef_axes(np.concatenate(nrm_l).astype(np.float64))
    return ft, bt, bt_bin, nrm, np.concatenate(bid_l), np.concatenate(idx_l), pos

def bt_column(bt, bt_bin, key, n):
    v = bt.get(key)
    if v is None:
        return [None] * n
    if isinstance(v, list):
        return v
    # binary reference
    ct = {"BYTE": np.int8, "UNSIGNED_BYTE": np.uint8, "SHORT": np.int16, "UNSIGNED_SHORT": np.uint16,
          "INT": np.int32, "UNSIGNED_INT": np.uint32, "FLOAT": np.float32, "DOUBLE": np.float64}[v["componentType"]]
    cn = TYPE_N[v.get("type", "SCALAR")]
    arr = np.frombuffer(bt_bin, dtype=ct, count=n * cn, offset=v["byteOffset"])
    return arr.reshape(n, cn) if cn > 1 else arr

USAGE_MAP = [
    (("商業", "宿泊", "住商", "娯楽"), 0),   # commercial -> neon magenta
    (("業務", "事務"), 1),                    # office -> cyan/white
    (("住宅", "共同"), 2),                    # residential -> warm amber
    (("官公", "文教", "厚生", "供給", "公共"), 3),  # public -> green
]
def usage_class(s):
    if not s:
        return 4
    for keys, cls in USAGE_MAP:
        if any(k in s for k in keys):
            return cls
    return 4

def main():
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    ts_path = fetch(BASE + "tileset.json", os.path.join(CACHE, "tileset.json"))
    tileset = json.load(open(ts_path))
    uris = collect_tiles(tileset)
    print(f"[1/5] tiles intersecting bbox: {len(uris)}")

    def dl(uri):
        dest = os.path.join(CACHE, uri.replace("/", "_"))
        try:
            return uri, fetch(BASE + uri, dest)
        except Exception as ex:
            print("  !! download failed:", uri, ex)
            return uri, None
    with ThreadPoolExecutor(8) as ex:
        files = dict(ex.map(dl, uris))
    ok = {k: v for k, v in files.items() if v}
    print(f"[2/5] downloaded: {len(ok)}/{len(uris)}")

    # ---- per-building assembly ----
    seen = set()
    buildings = []  # dict per building
    for uri, path in ok.items():
        try:
            ft, bt, bt_bin, nrm, bid, idx, pos_ecef = parse_b3dm(path)
        except Exception as ex:
            print("  !! parse failed:", uri, ex); continue
        n_batch = ft.get("BATCH_LENGTH", int(bid.max()) + 1 if len(bid) else 0)
        gml = bt_column(bt, bt_bin, "_gml_id", n_batch)
        h_meas = bt_column(bt, bt_bin, "計測高さ", n_batch)
        usage = bt_column(bt, bt_bin, "用途", n_batch)
        name = bt_column(bt, bt_bin, "名称", n_batch)
        floors = bt_column(bt, bt_bin, "地上階数", n_batch)
        local = ecef_to_local(pos_ecef).astype(np.float32)
        nrm = ecef_dir_to_local(nrm).astype(np.float32)
        # 三角形を建物ごとに振り分け(頂点のbatchidで判定)
        tri_bid = bid[idx[0::3]]
        order = np.argsort(tri_bid, kind="stable")
        tri_sorted = order
        bounds = np.searchsorted(tri_bid[order], np.arange(n_batch + 1))
        for b in range(n_batch):
            t0, t1 = bounds[b], bounds[b + 1]
            if t1 <= t0:
                continue
            g = gml[b] if isinstance(gml, list) else str(gml[b])
            if g in seen:
                continue
            tri_idx = idx.reshape(-1, 3)[tri_sorted[t0:t1]].reshape(-1)
            uniq, inv = np.unique(tri_idx, return_inverse=True)
            v = local[uniq]
            cx, cz = float(v[:, 0].mean()), float(v[:, 2].mean())
            if abs(cx) > HALF_EXTENT or abs(cz) > HALF_EXTENT:
                continue
            seen.add(g)
            ymin, ymax = float(v[:, 1].min()), float(v[:, 1].max())
            hm = h_meas[b] if h_meas[b] is not None else None
            try:
                hm = float(hm) if hm is not None and not (isinstance(hm, float) and math.isnan(hm)) else None
            except (TypeError, ValueError):
                hm = None
            height = hm if hm and hm > 1.5 else max(ymax - ymin, 3.0)
            us = usage[b] if isinstance(usage, list) else None
            nm = name[b] if isinstance(name, list) else None
            buildings.append(dict(
                v=v, n=nrm[uniq], i=inv.astype(np.uint32), cx=cx, cz=cz,
                ymin=ymin, ymax=ymax, height=float(height),
                usage=usage_class(us if isinstance(us, str) else None),
                name=nm if isinstance(nm, str) and nm else None,
                radius=float(np.max(np.hypot(v[:, 0] - cx, v[:, 2] - cz))),
            ))
    print(f"[3/5] buildings in area: {len(buildings)}")

    # ---- ground height grid (IDW from building base elevations) ----
    GW = 64
    gxs = np.linspace(-HALF_EXTENT, HALF_EXTENT, GW)
    samples = np.array([[b["cx"], b["cz"], b["ymin"]] for b in buildings])
    # 原点近傍の地面高さで全体をリベース(スクランブル交差点 ≈ y0)
    near = samples[np.hypot(samples[:, 0], samples[:, 1]) < 120]
    base_y = float(np.median(near[:, 2])) if len(near) else float(np.median(samples[:, 2]))
    print(f"      base elevation at center: {base_y:.1f} m")
    grid = np.zeros((GW, GW), np.float32)
    for j, gz in enumerate(gxs):
        d2 = (samples[:, 0][None, :] - gxs[:, None]) ** 2 + (samples[:, 1][None, :] - gz) ** 2
        wgt = 1.0 / (d2 + 400.0)
        grid[j] = (wgt @ samples[:, 2]) / wgt.sum(axis=1)
    grid -= base_y
    # smooth
    k = np.array([0.25, 0.5, 0.25])
    for _ in range(2):
        grid = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 0, grid)
        grid = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, grid)

    # ---- chunking ----
    ncell = int(2 * HALF_EXTENT / CHUNK_SIZE)  # 16
    chunk_map = {}
    for b in buildings:
        ci = min(ncell - 1, max(0, int((b["cx"] + HALF_EXTENT) / CHUNK_SIZE)))
        cj = min(ncell - 1, max(0, int((b["cz"] + HALF_EXTENT) / CHUNK_SIZE)))
        chunk_map.setdefault((ci, cj), []).append(b)

    chunks_meta = []
    vert_blobs, idx_blobs, btab_f_blobs, btab_b_blobs = [], [], [], []
    v_off = i_off = b_off = 0
    landmarks = []
    gid = 0
    for (ci, cj), blist in sorted(chunk_map.items()):
        blist.sort(key=lambda b: -b["height"])
        vparts, iparts = [], []
        bf = np.zeros((len(blist), 4), np.float32)
        bb = np.zeros((len(blist), 4), np.uint8)
        vbase = 0
        base_gid = gid
        ymin_c, ymax_c = 1e9, -1e9
        for k_b, b in enumerate(blist):
            nv = len(b["v"])
            seed = (hash(str(b["cx"]) + str(b["cz"])) & 0xFF)
            rel = np.clip((b["v"][:, 1] - b["ymin"]) / max(b["ymax"] - b["ymin"], 0.01), 0, 1)
            inter = np.zeros((nv, 6), np.float32)
            inter[:, 0:3] = b["v"] - np.array([0, base_y, 0], np.float32)
            # normal as i8x3 + pad, packed into one f32 slot via view
            n8 = np.clip(np.round(b["n"] * 127), -127, 127).astype(np.int8)
            packed = np.zeros((nv, 4), np.int8); packed[:, 0:3] = n8
            inter[:, 3] = packed.view(np.float32)[:, 0] if False else np.frombuffer(packed.tobytes(), np.float32)
            inter[:, 4] = b["height"]
            extra = np.zeros((nv, 4), np.uint8)
            extra[:, 0] = np.round(rel * 255)
            extra[:, 1] = seed
            extra16 = (k_b).to_bytes(2, "little")
            extra[:, 2] = extra16[0]; extra[:, 3] = extra16[1]
            inter[:, 5] = np.frombuffer(extra.tobytes(), np.float32)
            vparts.append(inter)
            iparts.append(b["i"] + vbase)
            vbase += nv
            bf[k_b] = [b["cx"], b["cz"], b["height"], b["radius"]]
            bb[k_b] = [b["usage"], seed, 0, 0]
            ymin_c = min(ymin_c, b["ymin"] - base_y); ymax_c = max(ymax_c, b["ymax"] - base_y)
            if b["name"] and b["height"] > 60:
                landmarks.append(dict(name=b["name"], x=b["cx"], z=b["cz"], h=b["height"]))
            gid += 1
        V = np.concatenate(vparts).astype(np.float32)
        I = np.concatenate(iparts)
        I = I.astype(np.uint16) if vbase < 65536 else I.astype(np.uint32)
        if len(I) % 2 == 1 and I.dtype == np.uint16:
            I = np.append(I, I[-1])  # 4B align
        chunks_meta.append(dict(
            cx=round((ci + 0.5) * CHUNK_SIZE - HALF_EXTENT, 1),
            cz=round((cj + 0.5) * CHUNK_SIZE - HALF_EXTENT, 1),
            yMin=round(float(ymin_c), 1), yMax=round(float(ymax_c), 1),
            vOff=v_off, vCount=len(V), iOff=i_off, iCount=len(I),
            i32=int(I.dtype == np.uint32),
            bBase=base_gid, bCount=len(blist),
        ))
        vert_blobs.append(V.tobytes()); idx_blobs.append(I.tobytes())
        btab_f_blobs.append(bf.tobytes()); btab_b_blobs.append(bb.tobytes())
        v_off += len(V); i_off += len(I) + (0 if I.dtype == np.uint16 else len(I))  # element counts handled below
        i_off = sum(len(x) // 2 for x in idx_blobs)  # u16単位の積算(u32は2単位)
        b_off += len(blist)

    # ---- write binary ----
    vert_bin = b"".join(vert_blobs)
    idx_bin = b"".join(idx_blobs)
    btf_bin = b"".join(btab_f_blobs)
    btb_bin = b"".join(btab_b_blobs)
    grid_bin = grid.astype(np.float32).tobytes()
    sections = [grid_bin, btf_bin, btb_bin, vert_bin, idx_bin]
    offs, cur = [], 0
    for s in sections:
        offs.append(cur); cur += len(s)
        cur = (cur + 3) & ~3
    blob = bytearray(cur)
    for s, o in zip(sections, offs):
        blob[o:o + len(s)] = s

    landmarks.sort(key=lambda l: -l["h"])
    meta = dict(
        name="CELL CITY: SHIBUYA",
        source="国土交通省 Project PLATEAU 渋谷区 LOD1 (CC BY 4.0)",
        center=dict(lat=CENTER_LAT, lon=CENTER_LON, baseY=round(base_y, 2)),
        halfExtent=HALF_EXTENT, chunkSize=CHUNK_SIZE, floorH=FLOOR_H,
        gridW=GW,
        counts=dict(buildings=gid, chunks=len(chunks_meta),
                    verts=v_off, tris=sum(c["iCount"] for c in chunks_meta) // 3),
        sections=dict(grid=offs[0], btabF=offs[1], btabB=offs[2], verts=offs[3], idx=offs[4]),
        vertexStride=24,
        chunks=chunks_meta,
        landmarks=[dict(name=l["name"], x=round(l["x"], 1), z=round(l["z"], 1), h=round(l["h"], 1)) for l in landmarks[:24]],
    )
    open(os.path.join(OUT_DIR, "city.bin"), "wb").write(bytes(blob))
    json.dump(meta, open(os.path.join(OUT_DIR, "city.meta.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    # 道路ベイク用に変換パラメータも出力
    json.dump(dict(lat=CENTER_LAT, lon=CENTER_LON, baseY=base_y, halfExtent=HALF_EXTENT, gridW=GW),
              open(os.path.join(OUT_DIR, "transform.json"), "w"))
    print(f"[4/5] chunks: {len(chunks_meta)}  buildings: {gid}  verts: {v_off}  tris: {meta['counts']['tris']}")
    print(f"[5/5] city.bin: {len(blob)/1e6:.1f} MB")
    print("      tallest landmarks:")
    for l in landmarks[:8]:
        print(f"        {l['h']:6.1f}m  {l['name']}  ({l['x']:.0f},{l['z']:.0f})")

if __name__ == "__main__":
    main()
