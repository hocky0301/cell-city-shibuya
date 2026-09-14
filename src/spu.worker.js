/**
 * SPU — Synergistic Processing Unit (simulated)
 *
 * Cell B.E. の SPU と同じ規律で動く Web Worker:
 *  - メインメモリ(メインスレッドの都市データ)には直接触れない
 *  - 必要なデータは DMA (postMessage + Transferable) でローカルストアへ
 *  - ローカルストアは 256KB。あふれたら LRU で追い出す
 *  - PPU(メインスレッド)から飛んでくるジョブを処理して結果を DMA で返す
 *
 * ジョブ内容: チャンクの視錐台カリング + 建物の窓明かりシミュレーション
 * (窓1枚1枚の点灯状態を持続的に持つ — これが LS を本当に圧迫する)
 */

const LS_CAPACITY = 256 * 1024; // 256KB — 鉄の掟

let spuId = -1;
let chunkMeta = null;       // 軽量: チャンクのAABB等 (これはレジスタ扱い)
let floorH = 3.1;

// ---- Local Store ----
const ls = new Map();       // chunkId -> { table: Float32Array, usage: Uint8Array, win: Uint8Array|null, winMeta, lastUse }
let lsBytes = 0;
let evictCount = 0;
let dmaInBytes = 0;

function lsSize(e) {
  return e.table.byteLength + e.usage.byteLength + (e.win ? e.win.byteLength : 0)
       + (e.winMeta ? e.winMeta.byteLength : 0) + (e.bandsCache ? e.bandsCache.byteLength : 0);
}
function evictIfNeeded(frame) {
  while (lsBytes > LS_CAPACITY && ls.size > 1) {
    let oldK = -1, oldT = Infinity;
    for (const [k, e] of ls) if (e.lastUse < oldT) { oldT = e.lastUse; oldK = k; }
    if (oldK < 0) break;
    const e = ls.get(oldK);
    lsBytes -= lsSize(e);
    ls.delete(oldK);
    evictCount++;
  }
}

// 決定論的ハッシュ (Date.now禁止の世界観: シードから再現)
function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

function ensureWindows(e, chunkId) {
  if (e.win) return;
  // 建物ごと: floors × cols 枚の窓状態 (u8: 0=消灯 1..255=点灯強度)
  const n = e.table.length / 4;
  const counts = new Int32Array(n * 2); // floors, cols
  let total = 0;
  for (let i = 0; i < n; i++) {
    const h = e.table[i * 4 + 2];
    const r = e.table[i * 4 + 3];
    const floors = Math.max(1, Math.min(80, Math.round(h / floorH)));
    const cols = Math.max(4, Math.min(72, Math.round(r * 2.2)));
    counts[i * 2] = floors; counts[i * 2 + 1] = cols;
    total += floors * cols;
  }
  e.winMeta = counts;
  lsBytes += counts.byteLength;
  e.win = new Uint8Array(total);
  // 初期パターン: 用途別の在室率で決定論的に点灯
  let o = 0;
  for (let i = 0; i < n; i++) {
    const usage = e.usage[i * 4];
    const seed = e.usage[i * 4 + 1];
    const occ = usage === 0 ? 0.62 : usage === 1 ? 0.5 : usage === 2 ? 0.34 : usage === 3 ? 0.28 : 0.42;
    const floors = e.winMeta[i * 2], cols = e.winMeta[i * 2 + 1];
    for (let f = 0; f < floors; f++) {
      // フロアごとの一斉消灯 (オフィスの闇)
      const floorOn = hash(seed * 7919 + f * 131 + chunkId) < (usage === 1 ? 0.75 : 0.95);
      for (let c = 0; c < cols; c++) {
        const r = hash(seed * 104729 + f * 1009 + c * 17);
        e.win[o++] = (floorOn && r < occ) ? (140 + ((r * 1e4) % 100) | 0) : 0;
      }
    }
  }
  lsBytes += e.win.byteLength;
}

function simulateWindows(e, chunkId, time, dt, out, outOff) {
  // 窓のスイッチング: まれに点く/消える (持続的な状態変化)
  const n = e.table.length / 4;
  let o = 0;
  const switchP = dt * 0.018;
  for (let i = 0; i < n; i++) {
    const usage = e.usage[i * 4];
    const seed = e.usage[i * 4 + 1];
    const floors = e.winMeta[i * 2], cols = e.winMeta[i * 2 + 1];
    const wpb = floors * cols;
    // 縦4バンドの点灯率を集計 → RGBA
    const q = Math.max(1, floors >> 2);
    const acc = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
    for (let f = 0; f < floors; f++) {
      const band = Math.min(3, (f / q) | 0);
      for (let c = 0; c < cols; c++) {
        let w = e.win[o];
        // 確率的スイッチ (時間バケットで決定論化)
        const tb = (time * 0.25 + hash(seed + f * 31 + c) * 4) | 0;
        const r = hash(seed * 31 + f * 977 + c * 7919 + tb * 104729 + chunkId);
        if (r < switchP) w = w > 0 ? 0 : 150 + ((r * 1e5) % 105 | 0);
        e.win[o] = w;
        acc[band] += w; cnt[band]++;
        o++;
      }
    }
    // 商業ビル低層はネオンサイン: 脈動を上乗せ
    const neonPulse = usage === 0 ? 0.75 + 0.25 * Math.sin(time * (1.2 + hash(seed) * 2.5) + seed) : 1.0;
    for (let b = 0; b < 4; b++) {
      let v = cnt[b] ? acc[b] / cnt[b] : 0;
      if (b === 0 && usage === 0) v = Math.min(255, v * 1.35 * neonPulse + 36 * neonPulse);
      out[outOff + i * 4 + b] = v;
    }
  }
}

function frustumTest(planes, cx, cy, cz, rx, ry, rz) {
  // AABB vs 6平面 (球近似でなく拡張半径)
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
    const e = rx * Math.abs(a) + ry * Math.abs(b) + rz * Math.abs(c);
    if (a * cx + b * cy + c * cz + d < -e) return false;
  }
  return true;
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    spuId = m.id;
    chunkMeta = m.chunks;     // [{cx,cz,yMin,yMax,bBase,bCount}] 全チャンク分の軽量メタ
    floorH = m.floorH;
    self.postMessage({ type: 'ready', id: spuId });
    return;
  }
  if (m.type === 'table') {
    // DMA-in: チャンクの建物テーブル (静的)
    dmaInBytes += m.f32.byteLength + m.u8.byteLength;
    const e = { table: new Float32Array(m.f32), usage: new Uint8Array(m.u8), win: null, winMeta: null, lastUse: m.frame || 0 };
    const old = ls.get(m.chunkId);
    if (old) lsBytes -= lsSize(old);
    ls.set(m.chunkId, e);
    lsBytes += lsSize(e);
    evictIfNeeded();
    return;
  }
  if (m.type === 'jobs') {
    const t0 = performance.now();
    const { frame, time, dt, planes, camX, camZ, jobs } = m;
    dmaInBytes += 24 * 4 + jobs.length * 4;
    const results = [];
    const misses = [];
    // 出力バッファ: このSPUが担当する建物ぶんのバンドデータ
    let outTotal = 0;
    for (const cid of jobs) outTotal += chunkMeta[cid].bCount * 4;
    const out = new Uint8Array(outTotal);
    let outOff = 0;
    for (const cid of jobs) {
      const c = chunkMeta[cid];
      const cy = (c.yMin + c.yMax) / 2, ry = (c.yMax - c.yMin) / 2 + 4;
      const half = 64 + 18; // チャンク半径 + 余白(1フレーム遅延を隠す)
      const vis = frustumTest(planes, c.cx, cy, c.cz, half, ry, half);
      const dx = c.cx - camX, dz = c.cz - camZ;
      const dist = Math.hypot(dx, dz);
      let bandsOff = -1;
      const e = ls.get(cid);
      if (vis && dist < 1050) {
        if (!e) {
          misses.push(cid); // DMAミス → PPUに要求
        } else {
          e.lastUse = frame;
          if (dist < 560) {
            ensureWindows(e, cid);
            evictIfNeeded(frame);
          }
          if (e.win) {
            bandsOff = outOff;
            // スタガー更新: 3フレームに1回だけ窓を再シミュレート、他はキャッシュ再送
            if (!e.bandsCache) { e.bandsCache = new Uint8Array((e.table.length / 4) * 4); lsBytes += e.bandsCache.byteLength; }
            if ((frame + cid) % 3 === 0 || !e.bandsFresh) {
              simulateWindows(e, cid, time, dt * 3.0, e.bandsCache, 0);
              e.bandsFresh = true;
            }
            out.set(e.bandsCache, outOff);
          } else if (e) {
            // 遠距離: 解析的フォールバック (窓状態なし)
            bandsOff = outOff;
            const n = e.table.length / 4;
            for (let i = 0; i < n; i++) {
              const usage = e.usage[i * 4], seed = e.usage[i * 4 + 1];
              const base = usage === 0 ? 120 : usage === 1 ? 95 : usage === 2 ? 60 : 70;
              const tw = 0.8 + 0.2 * Math.sin(time * 0.5 + seed);
              for (let b = 0; b < 4; b++) out[outOff + i * 4 + b] = base * tw;
            }
          }
        }
      } else if (e && dist > 1150 && e.win) {
        // 遠く離れたら窓状態を解放 (LS節約)
        lsBytes -= e.win.byteLength + (e.winMeta ? e.winMeta.byteLength : 0) + (e.bandsCache ? e.bandsCache.byteLength : 0);
        e.win = null; e.winMeta = null; e.bandsCache = null; e.bandsFresh = false;
      }
      results.push(cid, vis ? 1 : 0, dist | 0, bandsOff);
      if (bandsOff >= 0) outOff += c.bCount * 4;
    }
    const us = (performance.now() - t0) * 1000;
    const res = new Int32Array(results);
    self.postMessage({
      type: 'done', id: spuId, frame, us,
      results: res.buffer, bands: out.buffer, misses,
      ls: lsBytes, evict: evictCount, dmaIn: dmaInBytes,
    }, [res.buffer, out.buffer]);
    return;
  }
};
