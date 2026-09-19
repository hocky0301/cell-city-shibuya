#!/usr/bin/env python3
"""
CELL CITY: SHIBUYA — 建物の高さの出どころを元タイルから確定する

bake_plateau.py は各建物の高さを「PLATEAU の『計測高さ』属性があり 1.5 m 超ならその値、
それ以外はメッシュの高さ max(ymax - ymin, 3.0)」で決めるが、焼いた後の data/city.bin には
最終の高さしか残らない。このスクリプトは同じタイルを取り直して建物ごとに属性の有無を読み、
city.bin の建物表と座標・高さで突き合わせてから data/height_provenance.json に書く。

使い方:
  python3 tools/height_provenance.py           # タイル取得(キャッシュ) → 判定 → 照合 → JSON 出力
  python3 tools/height_provenance.py --check   # ダウンロードなし。既存 JSON と city.bin の整合だけ確認

出典: 国土交通省 Project PLATEAU 渋谷区 3D Tiles (notexture)。bake_plateau.py と同じ URL・同じ範囲。
"""
import hashlib, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_plateau as bp  # noqa: E402

DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "height_provenance.json")
HEIGHT_TOL = 1e-4  # m。city.bin は float32 なので 1e-5 程度の丸めは出る


def load_citybin_table():
    meta = json.load(open(os.path.join(DATA, "city.meta.json"), encoding="utf-8"))
    blob = open(os.path.join(DATA, "city.bin"), "rb").read()
    nb = meta["counts"]["buildings"]
    btf = np.frombuffer(blob, np.float32, count=nb * 4, offset=meta["sections"]["btabF"]).reshape(nb, 4)
    return meta, btf  # 列: cx, cz, height, radius


def mesh_heights_from_citybin(meta, blob_path):
    """頂点から建物ごとの ymax - ymin を復元する（--check 用。fallback 建物は格納高さと一致するはず）"""
    blob = open(blob_path, "rb").read()
    nb, nv = meta["counts"]["buildings"], meta["counts"]["verts"]
    V = np.frombuffer(blob, np.float32, count=nv * 6, offset=meta["sections"]["verts"]).reshape(nv, 6)
    extra = V[:, 5].copy().view(np.uint8).reshape(nv, 4)
    kb = extra[:, 2].astype(np.int32) | (extra[:, 3].astype(np.int32) << 8)
    ymin = np.full(nb, np.inf); ymax = np.full(nb, -np.inf)
    for c in meta["chunks"]:
        v0, vc = c["vOff"], c["vCount"]
        gid = c["bBase"] + kb[v0:v0 + vc]
        y = V[v0:v0 + vc, 1].astype(np.float64)
        np.minimum.at(ymin, gid, y); np.maximum.at(ymax, gid, y)
    return ymax - ymin


def classify_from_tiles():
    os.makedirs(bp.CACHE, exist_ok=True)
    t0 = time.time()
    tileset = json.load(open(bp.fetch(bp.BASE + "tileset.json", os.path.join(bp.CACHE, "tileset.json"))))
    uris = bp.collect_tiles(tileset)
    print(f"[1/4] tiles intersecting bbox: {len(uris)}")

    def dl(uri):
        return uri, bp.fetch(bp.BASE + uri, os.path.join(bp.CACHE, uri.replace("/", "_")))

    with ThreadPoolExecutor(8) as ex:
        files = dict(ex.map(dl, uris))
    total = sum(os.path.getsize(p) for p in files.values())
    print(f"[2/4] downloaded: {len(files)}/{len(uris)}  {total / 1e6:.1f} MB  ({time.time() - t0:.0f}s)")

    seen, rows = set(), []
    for uri, path in files.items():
        ft, bt, bt_bin, _nrm, bid, idx, pos_ecef = bp.parse_b3dm(path)
        n_batch = ft.get("BATCH_LENGTH", int(bid.max()) + 1 if len(bid) else 0)
        gml = bp.bt_column(bt, bt_bin, "_gml_id", n_batch)
        h_meas = bp.bt_column(bt, bt_bin, "計測高さ", n_batch)
        local = bp.ecef_to_local(pos_ecef).astype(np.float32)
        tri_bid = bid[idx[0::3]]
        order = np.argsort(tri_bid, kind="stable")
        bounds = np.searchsorted(tri_bid[order], np.arange(n_batch + 1))
        for b in range(n_batch):
            t0_, t1_ = bounds[b], bounds[b + 1]
            if t1_ <= t0_:
                continue
            g = gml[b] if isinstance(gml, list) else str(gml[b])
            if g in seen:
                continue
            tri_idx = idx.reshape(-1, 3)[order[t0_:t1_]].reshape(-1)
            v = local[np.unique(tri_idx)]
            cx, cz = float(v[:, 0].mean()), float(v[:, 2].mean())
            if abs(cx) > bp.HALF_EXTENT or abs(cz) > bp.HALF_EXTENT:
                continue
            seen.add(g)
            ymin, ymax = float(v[:, 1].min()), float(v[:, 1].max())
            raw = h_meas[b]
            try:
                hm = float(raw) if raw is not None and not (isinstance(raw, float) and math.isnan(raw)) else None
            except (TypeError, ValueError):
                hm = None
            measured = bool(hm and hm > 1.5)          # bake_plateau.py と同じ規則
            height = hm if measured else max(ymax - ymin, 3.0)
            rows.append(dict(gml_id=g, x=cx, z=cz, height=float(height), mesh_height=ymax - ymin,
                             measured=measured, attr=hm, tile=uri))
    print(f"[3/4] buildings in area: {len(rows)}")
    sha = {u: hashlib.sha256(open(p, "rb").read()).hexdigest() for u, p in sorted(files.items())}
    return rows, uris, total, sha


def match_to_citybin(rows, btf):
    """座標(float32 完全一致)で city.bin の建物表へ対応づけ、高さも一致することを確かめる"""
    key = {(np.float32(btf[i, 0]).tobytes(), np.float32(btf[i, 1]).tobytes()): i for i in range(len(btf))}
    assert len(key) == len(btf), "city.bin に同一座標の建物がある"
    idx = np.empty(len(rows), np.int64)
    for k, r in enumerate(rows):
        i = key.get((np.float32(r["x"]).tobytes(), np.float32(r["z"]).tobytes()))
        if i is None:  # 念のため最近傍
            d = np.hypot(btf[:, 0] - r["x"], btf[:, 1] - r["z"]); i = int(d.argmin())
            assert d[i] < 0.01, f"座標が合わない建物: {r['gml_id']} (最近傍 {d[i]:.3f} m)"
        idx[k] = i
    assert len(set(idx.tolist())) == len(rows) == len(btf), "建物数または対応が一致しない"
    pos_diff = float(np.max(np.hypot(btf[idx, 0] - [r["x"] for r in rows], btf[idx, 1] - [r["z"] for r in rows])))
    h_diff = float(np.max(np.abs(btf[idx, 2] - [r["height"] for r in rows])))
    assert h_diff <= HEIGHT_TOL, f"高さが city.bin と合わない (max {h_diff} m)。タイルが更新された可能性"
    return idx, pos_diff, h_diff


def write_json(rows, idx, uris, total, sha, pos_diff, h_diff):
    prov = np.full(len(rows), "?", dtype="<U1")
    prov[idx] = ["M" if r["measured"] else "F" for r in rows]
    assert "?" not in prov
    fallback = sorted(
        (dict(index=int(idx[k]), gml_id=r["gml_id"], x=round(r["x"], 2), z=round(r["z"], 2),
              height=round(r["height"], 3), mesh_height=round(r["mesh_height"], 3), tile=r["tile"])
         for k, r in enumerate(rows) if not r["measured"]), key=lambda d: d["index"])
    attrs = [r["attr"] for r in rows]
    out = dict(
        generated=date.today().isoformat(),
        source=bp.BASE,
        rule="height = 計測高さ if (属性あり and > 1.5 m) else max(mesh ymax - ymin, 3.0)  (tools/bake_plateau.py と同一)",
        counts=dict(buildings=len(rows),
                    measured=int(sum(r["measured"] for r in rows)),
                    fallback_mesh=len(fallback),
                    attr_absent=int(sum(a is None for a in attrs)),
                    attr_le_1p5=int(sum(a is not None and a <= 1.5 for a in attrs))),
        verification=dict(tiles=len(uris), tile_bytes=total,
                          position_max_abs_diff_m=pos_diff, height_max_abs_diff_m=h_diff,
                          note="city.bin の建物表 (btabF) と座標・高さで全建物を突き合わせた結果"),
        fallback_buildings=fallback,
        provenance="".join(prov.tolist()),
        provenance_legend="city.bin の建物順 (btabF の行順)。M=計測高さ属性, F=メッシュ高さへフォールバック",
        tile_sha256=sha,
    )
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[4/4] wrote {os.path.relpath(OUT, os.path.join(HERE, '..'))}: "
          f"measured={out['counts']['measured']} fallback={out['counts']['fallback_mesh']}  "
          f"pos diff {pos_diff} m, height diff {h_diff:.2e} m")


def check():
    meta, btf = load_citybin_table()
    j = json.load(open(OUT, encoding="utf-8"))
    prov = j["provenance"]
    assert len(prov) == len(btf) == j["counts"]["buildings"], "建物数が city.bin と合わない"
    assert prov.count("M") == j["counts"]["measured"] and prov.count("F") == j["counts"]["fallback_mesh"]
    mesh = mesh_heights_from_citybin(meta, os.path.join(DATA, "city.bin"))
    for fb in j["fallback_buildings"]:
        i = fb["index"]
        assert prov[i] == "F"
        exp = max(mesh[i], 3.0)
        assert abs(btf[i, 2] - exp) <= 1e-3, f"fallback 建物 {i} の格納高さ {btf[i,2]} がメッシュ高さ {exp} と合わない"
        assert abs(btf[i, 0] - fb["x"]) < 0.01 and abs(btf[i, 1] - fb["z"]) < 0.01
    print(f"check OK: buildings={len(prov)} measured={prov.count('M')} fallback={prov.count('F')} "
          f"(fallback 建物の格納高さは city.bin の頂点から復元したメッシュ高さと一致)")


def main():
    if "--check" in sys.argv[1:]:
        return check()
    _meta, btf = load_citybin_table()
    rows, uris, total, sha = classify_from_tiles()
    idx, pos_diff, h_diff = match_to_citybin(rows, btf)
    write_json(rows, idx, uris, total, sha, pos_diff, h_diff)
    check()


if __name__ == "__main__":
    main()
