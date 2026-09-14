#!/usr/bin/env python3
"""
CELL CITY: SHIBUYA — 道路/鉄道ベイク (OpenStreetMap © contributors, ODbL)
Overpassから渋谷の道路・鉄道を取得し、地形に沿わせたネオンリボンとして焼く。
"""
import json, math, os, urllib.request, urllib.parse
import numpy as np

D = os.path.join(os.path.dirname(__file__), "..", "data")
T = json.load(open(os.path.join(D, "transform.json")))
LAT, LON, HALF, GW = T["lat"], T["lon"], T["halfExtent"], T["gridW"]
BASE_Y = T["baseY"]
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT))

grid = None  # height grid from city.bin
def load_grid():
    global grid
    meta = json.load(open(os.path.join(D, "city.meta.json")))
    off = meta["sections"]["grid"]
    raw = open(os.path.join(D, "city.bin"), "rb").read()
    g = np.frombuffer(raw, np.float32, GW * GW, off).reshape(GW, GW)
    return g

def ground_y(x, z):
    fx = (x + HALF) / (2 * HALF) * (GW - 1)
    fz = (z + HALF) / (2 * HALF) * (GW - 1)
    i0, j0 = int(np.clip(fx, 0, GW - 2)), int(np.clip(fz, 0, GW - 2))
    tx, tz = fx - i0, fz - j0
    g = grid
    return float((g[j0, i0] * (1 - tx) + g[j0, i0 + 1] * tx) * (1 - tz) +
                 (g[j0 + 1, i0] * (1 - tx) + g[j0 + 1, i0 + 1] * tx) * tz)

def to_local(lat, lon):
    return ((lon - LON) * M_LON, -(lat - LAT) * M_LAT)  # x=east, z=south

CLASSES = {
    "motorway": (0, 15.0), "motorway_link": (0, 8.0), "trunk": (1, 13.0), "trunk_link": (1, 7.0),
    "primary": (1, 11.0), "secondary": (2, 8.5), "tertiary": (3, 6.5),
    "unclassified": (4, 4.5), "residential": (4, 4.5), "living_street": (4, 4.0),
    "pedestrian": (5, 5.5),
    "rail": (6, 3.2), "light_rail": (6, 3.0), "subway": (7, 3.0),
}

def main():
    global grid
    grid = load_grid()
    dlat, dlon = (HALF + 80) / M_LAT, (HALF + 80) / M_LON
    bbox = f"{LAT-dlat},{LON-dlon},{LAT+dlat},{LON+dlon}"
    q = f"""[out:json][timeout:90];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"]({bbox});
  way["railway"~"^(rail|subway|light_rail)$"]({bbox});
);
out geom tags;"""
    cache = "/tmp/overpass_roads.json"
    if not os.path.exists(cache):
        data = urllib.parse.urlencode({"data": q}).encode()
        req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=data,
                                     headers={"User-Agent": "cell-city-bake/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            open(cache, "wb").write(r.read())
    js = json.load(open(cache))
    ways = js["elements"]
    print(f"ways: {len(ways)}")

    verts, idxs = [], []
    vcount = 0
    rail_paths = []  # 電車アニメ用に主要railの中心線も保存
    for w in ways:
        tags = w.get("tags", {})
        key = tags.get("highway") or tags.get("railway")
        if key not in CLASSES:
            continue
        cls, width = CLASSES[key]
        if tags.get("tunnel") in ("yes", "building_passage") and cls != 7:
            continue  # 地上道路のトンネル区間は描かない(subwayはcls7として残す)
        if tags.get("railway") == "subway" and tags.get("tunnel") != "yes":
            cls = 6  # 地上に出ている地下鉄は鉄道扱い
        pts = [(to_local(g["lat"], g["lon"])) for g in w.get("geometry", [])]
        pts = [(x, z) for x, z in pts if abs(x) < HALF + 60 and abs(z) < HALF + 60]
        if len(pts) < 2:
            continue
        elevated = tags.get("bridge") in ("yes", "viaduct")
        layer = int(tags.get("layer", "0") or 0)
        if cls == 0:
            lift = 14.0 if elevated or layer > 0 else 2.0  # 首都高
        elif cls == 6:
            lift = 8.0 if elevated or layer > 0 else 1.2   # JR/山手線の高架
        elif cls == 7:
            lift = 0.18  # 地下鉄: 路面すれすれのゴースト
        else:
            lift = 6.0 if elevated else 0.25
        rnd = (hash(str(w.get("id"))) & 0xFF)
        # ポリライン → リボン
        dist = 0.0
        prev_dir = None
        row = []
        for i, (x, z) in enumerate(pts):
            if i > 0:
                dx, dz = x - pts[i-1][0], z - pts[i-1][1]
                seg = math.hypot(dx, dz)
                dist += seg
                d = (dx / max(seg, 1e-6), dz / max(seg, 1e-6))
            if i == 0:
                dx, dz = pts[1][0] - x, pts[1][1] - z
                seg = math.hypot(dx, dz)
                d = (dx / max(seg, 1e-6), dz / max(seg, 1e-6))
            nx, nz = -d[1], d[0]
            y = ground_y(x, z) + lift
            hw = width / 2
            row.append((x - nx * hw, y, z - nz * hw, x + nx * hw, y, z + nz * hw, dist))
        if cls in (6,) and tags.get("railway") == "rail":
            rail_paths.append(dict(usage=tags.get("usage", ""), name=tags.get("name", ""),
                                   pts=[[round(p[0]+ (p[3]-p[0])/2,1), round(p[1],2), round(p[2]+(p[5]-p[2])/2,1)] for p in row]))
        base = vcount
        for k, (lx, ly, lz, rx, ry, rz, dd) in enumerate(row):
            verts.append((lx, ly, lz, cls, 0, rnd, dd))
            verts.append((rx, ry, rz, cls, 255, rnd, dd))
        n = len(row)
        for k in range(n - 1):
            a = base + k * 2
            idxs += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
        vcount += n * 2

    V = np.zeros((len(verts), 5), np.float32)
    for i, (x, y, z, cls, side, rnd, dd) in enumerate(verts):
        V[i, 0:3] = (x, y, z)
        V[i, 3] = np.frombuffer(np.array([cls, side, rnd, 0], np.uint8).tobytes(), np.float32)[0]
        V[i, 4] = dd
    I = np.array(idxs, np.uint32)
    blob = V.tobytes() + I.tobytes()
    open(os.path.join(D, "roads.bin"), "wb").write(blob)
    meta = dict(vCount=len(verts), iCount=len(I), vBytes=len(V.tobytes()), stride=20,
                source="© OpenStreetMap contributors (ODbL)")
    json.dump(meta, open(os.path.join(D, "roads.meta.json"), "w"))
    # 山手線・埼京線等の本線だけ抽出して電車アニメ用パスに
    main_rails = [r for r in rail_paths if r["usage"] == "main" or "山手" in (r["name"] or "")]
    json.dump(main_rails if main_rails else rail_paths[:40],
              open(os.path.join(D, "rails.json"), "w"), ensure_ascii=False)
    print(f"roads.bin: {len(blob)/1e6:.1f} MB  verts={len(verts)} tris={len(I)//3}  railPaths={len(rail_paths)} (main={len(main_rails)})")

if __name__ == "__main__":
    main()
