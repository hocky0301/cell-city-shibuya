/**
 * CELL CITY: SHIBUYA — PPU (main thread orchestrator)
 *
 * 「2026年、PS3を開発する」へのオマージュ。
 * 6基のWeb WorkerをSPUとして扱い、256KBのローカルストア制約とDMA転送で
 * PLATEAU実測の渋谷 7,770棟を駆動する。
 */
import * as THREE from 'three';
import { CityMesh, BAND_TEX_W } from './citymesh.js';
import { Ground, Sky, Wave, Sparkles, xmbColorForMonth } from './environment.js';
import { Roads, Trains } from './roads.js';
import { Monolith, Shards } from './monolith.js';
import { Post } from './post.js';
import { CityAudio } from './audio.js';

const N_SPU = 6;
const $ = (s) => document.querySelector(s);

// ---------- ストーリー ----------
const STORY = [
  { x: 0, z: 0, ch: '第0章 — スクランブル交差点', title: '散歩とファミコンとCellの亡霊',
    body: '2026年2月23日。散歩の途中、スマホでAIチャットを開いた。「ファミコンのゲーム作ってくれ」——ほとんど冗談のような依頼から、すべてが始まった。コードの知識ゼロのままNESのROMが動いたとき、次に頭へ浮かんだのは、なぜかPlayStation 3だった。実家には初期型CECHA00が眠っていた。' },
  { x: 45, z: 75, ch: '第1章 — ハチ公前', title: '開発地獄',
    body: 'PS3の心臓・Cell Broadband Engineは異形のチップだった。汎用コアPPEの周りに6基のSPU。各SPUは256KBのローカルストアしか持たず、メインメモリにはDMA転送でしか触れない。if文ひとつで18サイクルのペナルティ。「PS3は開発地獄」——その悪名は開発者の怠慢ではなく、アーキテクチャの必然だった。画面左のメーターは、いまこの瞬間も6基のWorker-SPUが渋谷の窓明かりを並列計算している証拠だ。' },
  { x: -330, z: 250, ch: '第2章 — 道玄坂上', title: 'バイナリの沼',
    body: 'PSL1GHT、ppu-gcc、ELFとSELFの違い、16バイト境界を1つ外すだけでクラッシュする世界。WSLの中にクロスコンパイラを組み、RPCS3の上で何度も画面を凍らせた。人間は仕様書を読み、AIはコードを書き、二人三脚で沼を片足ずつ抜けていった。' },
  { x: 300, z: 30, ch: '第3章 — ヒカリエ前', title: '15年間誰も開けなかった扉',
    body: 'PSL1GHTのソースには「Fragment shaders don\'t exist yet」というコメントが15年間残されていた。誰も開けなかった扉。cgcompでCgシェーダをコンパイルし、row-majorとcolumn-majorの転置の罠を越え、cellGcmを直接叩いて——Blinn-Phongの光が灯った。いまあなたを照らすこの街の照明モデルも、同じBlinn-Phongだ。キー[1]で確かめてほしい。' },
  { x: -100, z: 330, ch: '第4章 — セルリアンタワー', title: 'FIFO DEAD',
    body: 'VRChatのワールドをPS3に移植する。lilToonシェーダはRSXのコマンドバッファを何度も殺し、画面はFIFO DEADで凍りついた。シェーダバイナリのレイアウトが変わるだけで死ぬ世界で、トゥーンの陰影とXMBのスパークルをひとつずつ取り戻した。キー[2]でlilToonモードを試せる。……FIFOが死んでも、恨まないでほしい。' },
  { x: 233, z: 245, ch: '終章 — 渋谷ストリーム', title: 'グリッドの都市から、実在の渋谷へ',
    body: '7×7のグリッドに48棟のビル、1080pの自由カメラ、5基のSPUが並列で回る街。PS3の上でファミコンのエミュレータが動いた日、記録は終わる。——いまあなたが歩いているのは、その続きだ。国土交通省PLATEAUが実測した渋谷7,770棟。6基のWorker-SPUが窓を灯し、DMAが街を運ぶ。1行もコードを書けない人間とAIが辿り着いた場所から、さらに先へ。頭上のモノリスの周りを回る8つのキューブのうち、輝くのは6つ。1つは鈍く、1つは死んでいる——Cellと同じように。' },
];

// ---------- 状態 ----------
const state = {
  mode: 'menu', booted: false,
  yaw: 0, pitch: -0.1,
  pos: new THREE.Vector3(0, 380, 1200),
  vel: new THREE.Vector3(),
  speed: 38,
  keys: {},
  toon: false, fifoSeen: false, fifoUntil: 0,
  hudVisible: true,
  cardOpen: false,
  bootT: -1,
  frame: 0,
};

const audio = new CityAudio();

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('#gl'), antialias: false, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.NoToneMapping;
const DPR = Math.min(window.devicePixelRatio || 1, 1.75);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 6000);
const post = new Post(renderer);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(1); // RT側で解像度管理
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.setSize(w, h, DPR);
}
window.addEventListener('resize', resize);
resize();

// ---------- XMB ----------
const juneColor = xmbColorForMonth(new Date().getMonth());
const sky = new Sky(); scene.add(sky.mesh);
const wave = new Wave(juneColor.clone()); scene.add(wave.mesh);
const sparkles = new Sparkles(1600, juneColor.clone().lerp(new THREE.Color(0xffffff), 0.3)); scene.add(sparkles.mesh);

const CATS = [
  { ico: '⚙', lbl: '設定', items: [
    { label: 'SDTVモード', note: 'ブラウン管 480i の渋谷へ', act: () => { toggleCRT(); } },
    { label: 'サウンド', note: 'ON / OFF', act: () => { audio.setMute(!audio.muted); xmbMsg(audio.muted ? 'サウンド: OFF' : 'サウンド: ON'); } },
    { label: 'クレジット', note: '出典とライセンス', act: showCredits },
  ] },
  { ico: '▣', lbl: 'フォト', msg: 'メモリーカードが挿入されていません。' },
  { ico: '♪', lbl: 'ミュージック', msg: 'ATRAC3データが見つかりません。' },
  { ico: '◳', lbl: 'ゲーム', items: [
    { label: 'CELL CITY: SHIBUYA', note: 'インストール中…', act: tryBoot, id: 'boot' },
  ] },
  { ico: '◍', lbl: 'ネットワーク', msg: 'RPCS3@localhost に接続しました。PSNは応答しません。' },
];
let xmbCat = 3, xmbItem = 0;

function buildXMB() {
  const bar = $('#xmb-bar');
  bar.innerHTML = '';
  CATS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'xmb-cat' + (i === xmbCat ? ' sel' : '');
    d.innerHTML = `<span class="ico">${c.ico}</span><span class="lbl">${c.lbl}</span>`;
    d.onclick = () => { xmbCat = i; xmbItem = 0; audio.tick(); buildXMB(); };
    bar.appendChild(d);
  });
  const itemsEl = $('#xmb-items');
  itemsEl.innerHTML = '';
  const cat = CATS[xmbCat];
  (cat.items || []).forEach((it, j) => {
    const d = document.createElement('div');
    d.className = 'xmb-item' + (j === xmbItem ? ' sel' : '');
    d.innerHTML = `${it.label}<span class="note">${it.note || ''}</span>`;
    d.onclick = () => { xmbItem = j; audio.confirm(); it.act(); buildXMB(); };
    itemsEl.appendChild(d);
  });
  $('#xmb-msg').textContent = cat.msg && !cat.items ? '' : '';
}
function xmbMsg(s) { $('#xmb-msg').textContent = s; }
function xmbClock() {
  const d = new Date();
  $('#xmb-clock').textContent =
    `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
setInterval(xmbClock, 5000); xmbClock();
buildXMB();

window.addEventListener('keydown', (e) => {
  if (state.mode === 'menu') {
    if (e.key === 'ArrowLeft') { xmbCat = (xmbCat + CATS.length - 1) % CATS.length; xmbItem = 0; audio.tick(); buildXMB(); xmbShowCatMsg(); }
    else if (e.key === 'ArrowRight') { xmbCat = (xmbCat + 1) % CATS.length; xmbItem = 0; audio.tick(); buildXMB(); xmbShowCatMsg(); }
    else if (e.key === 'ArrowUp') { const n = (CATS[xmbCat].items || []).length; if (n) { xmbItem = (xmbItem + n - 1) % n; audio.tick(); buildXMB(); } }
    else if (e.key === 'ArrowDown') { const n = (CATS[xmbCat].items || []).length; if (n) { xmbItem = (xmbItem + 1) % n; audio.tick(); buildXMB(); } }
    else if (e.key === 'Enter') {
      const cat = CATS[xmbCat];
      if (cat.items && cat.items[xmbItem]) { audio.confirm(); cat.items[xmbItem].act(); buildXMB(); }
      else if (cat.msg) { audio.tick(); xmbMsg(cat.msg); }
    }
    return;
  }
  // ---- city mode ----
  state.keys[e.code] = true;
  if (e.code === 'KeyR') { resetCam(); }
  else if (e.code === 'Digit1') { setToon(false); }
  else if (e.code === 'Digit2') { setToon(true); }
  else if (e.code === 'Digit3') { toggleCRT(); }
  else if (e.code === 'KeyM') { audio.setMute(!audio.muted); }
  else if (e.code === 'KeyH') { state.hudVisible = !state.hudVisible; applyHudVis(); }
  else if (e.code === 'Escape') {
    if (state.cardOpen) closeCard();
    else returnToMenu();
  }
});
window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });
function xmbShowCatMsg() { const c = CATS[xmbCat]; xmbMsg(c.msg || ''); }

function showCredits() {
  openCard('クレジット', 'CELL CITY: SHIBUYA',
    '建物: 国土交通省 Project PLATEAU 渋谷区(2020) LOD1 — CC BY 4.0相当(政府標準利用規約)を加工して作成。' +
    '道路・鉄道: © OpenStreetMap contributors (ODbL)。' +
    'エンジン: three.js + 手書きGLSL + Web Worker ×6 (SPUシミュレーション)。' +
    '原作インスピレーション: 『2026年、PS3を開発する』——1行もコードを書けない人間がAIと組み、15年間誰も開けられなかった扉をこじ開けた記録。' +
    'このデモはその記録に捧げる。Cellの魂は、ブラウザの中でも並列に生きる。');
}

// ---------- データロード ----------
async function fetchProgress(url, onP) {
  const res = await fetch(url);
  const total = +res.headers.get('Content-Length') || 0;
  if (!total || !res.body) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got); got += value.length;
    onP(got / total);
  }
  return buf.buffer;
}

let city = null, ground = null, roads = null, trains = null, monolith = null, shards = null;
let meta = null, groundGrid = null;
let ppu = null;

function groundYAt(x, z) {
  if (!groundGrid) return 0;
  const GW = meta.gridW, HALF = meta.halfExtent;
  const fx = THREE.MathUtils.clamp((x + HALF) / (2 * HALF) * (GW - 1), 0, GW - 1.001);
  const fz = THREE.MathUtils.clamp((z + HALF) / (2 * HALF) * (GW - 1), 0, GW - 1.001);
  const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
  return (groundGrid[j0 * GW + i0] * (1 - tx) + groundGrid[j0 * GW + i0 + 1] * tx) * (1 - tz)
       + (groundGrid[(j0 + 1) * GW + i0] * (1 - tx) + groundGrid[(j0 + 1) * GW + i0 + 1] * tx) * tz;
}

async function loadAll() {
  $('#xmb-load').style.display = 'block';
  const setP = (p) => {
    $('#load-fill').style.width = `${(p * 100).toFixed(0)}%`;
    $('#load-pct').textContent = `${(p * 100).toFixed(0)}%`;
    const boot = CATS[3].items[0];
    boot.note = `インストール中… ${(p * 100).toFixed(0)}%`;
    if (state.mode === 'menu' && xmbCat === 3) buildXMB();
  };
  const [metaRes, roadsMetaRes, railsRes] = await Promise.all([
    fetch('./data/city.meta.json').then(r => r.json()),
    fetch('./data/roads.meta.json').then(r => r.json()),
    fetch('./data/rails.json').then(r => r.json()),
  ]);
  meta = metaRes;
  const blob = await fetchProgress('./data/city.bin', (p) => setP(p * 0.85));
  const roadsBlob = await fetchProgress('./data/roads.bin', (p) => setP(0.85 + p * 0.15));
  groundGrid = new Float32Array(blob, meta.sections.grid, meta.gridW * meta.gridW);

  city = new CityMesh(meta, blob); scene.add(city.group);
  ground = new Ground(meta, blob); scene.add(ground.mesh);
  roads = new Roads(roadsMetaRes, roadsBlob); scene.add(roads.mesh);
  trains = new Trains(railsRes); scene.add(trains.group);
  monolith = new Monolith(); scene.add(monolith.group);
  shards = new Shards(STORY); scene.add(shards.group);
  shards.setGroundY(groundYAt);

  ppu = new PPU(meta, city);
  await ppu.init();

  const boot = CATS[3].items[0];
  boot.note = `準備完了 — ${meta.counts.buildings.toLocaleString()}棟 / ${meta.counts.tris.toLocaleString()}三角形`;
  $('#load-cap').textContent = '都市データ インストール完了';
  if (state.mode === 'menu') buildXMB();
  setTimeout(() => { $('#xmb-load').style.display = 'none'; }, 1800);
}
loadAll().catch(err => {
  console.error(err);
  xmbMsg('データの読み込みに失敗しました: ' + err.message);
});

// ---------- PPU / SPU ----------
class PPU {
  constructor(meta, city) {
    this.meta = meta;
    this.city = city;
    this.workers = [];
    this.busy = new Array(N_SPU).fill(false);
    this.stats = Array.from({ length: N_SPU }, () => ({ us: 0, ls: 0, evict: 0 }));
    this.dmaOut = 0; this.dmaIn = 0;
    this.dmaRate = 0;
    this.assign = meta.chunks.map((_, i) => i % N_SPU);
    this.planes = new Float32Array(24);
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
  }
  init() {
    const lite = this.meta.chunks.map(c => ({ cx: c.cx, cz: c.cz, yMin: c.yMin, yMax: c.yMax, bBase: c.bBase, bCount: c.bCount }));
    return new Promise((resolve) => {
      let ready = 0;
      for (let i = 0; i < N_SPU; i++) {
        const w = new Worker(new URL('./spu.worker.js', import.meta.url));
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { if (++ready === N_SPU) { this.pushAllTables(); resolve(); } return; }
          if (m.type === 'done') this.onDone(m);
        };
        w.postMessage({ type: 'init', id: i, chunks: lite, floorH: this.meta.floorH });
        this.workers.push(w);
      }
    });
  }
  sendTable(cid) {
    const c = this.meta.chunks[cid];
    const f32 = this.city.btabF.slice(c.bBase * 4, (c.bBase + c.bCount) * 4);
    const u8 = this.city.btabB.slice(c.bBase * 4, (c.bBase + c.bCount) * 4);
    this.dmaOut += f32.buffer.byteLength + u8.buffer.byteLength;
    this.workers[this.assign[cid]].postMessage(
      { type: 'table', chunkId: cid, f32: f32.buffer, u8: u8.buffer, frame: state.frame },
      [f32.buffer, u8.buffer]);
  }
  pushAllTables() {
    for (let cid = 0; cid < this.meta.chunks.length; cid++) this.sendTable(cid);
  }
  dispatch(time, dt) {
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    for (let p = 0; p < 6; p++) {
      const pl = this._frustum.planes[p];
      this.planes[p * 4] = pl.normal.x; this.planes[p * 4 + 1] = pl.normal.y;
      this.planes[p * 4 + 2] = pl.normal.z; this.planes[p * 4 + 3] = pl.constant;
    }
    const jobsPer = Array.from({ length: N_SPU }, () => []);
    for (let cid = 0; cid < this.meta.chunks.length; cid++) jobsPer[this.assign[cid]].push(cid);
    for (let i = 0; i < N_SPU; i++) {
      if (this.busy[i]) continue;
      this.busy[i] = true;
      const planes = this.planes.slice();
      this.dmaOut += planes.byteLength + jobsPer[i].length * 4 + 32;
      this.workers[i].postMessage({
        type: 'jobs', frame: state.frame, time, dt,
        planes, camX: state.pos.x, camZ: state.pos.z, jobs: jobsPer[i],
      });
    }
  }
  onDone(m) {
    this.busy[m.id] = false;
    const st = this.stats[m.id];
    st.us = st.us * 0.8 + m.us * 0.2;
    st.ls = m.ls; st.evict = m.evict;
    this.dmaIn += m.results.byteLength + m.bands.byteLength;
    const res = new Int32Array(m.results);
    const bands = new Uint8Array(m.bands);
    for (let i = 0; i < res.length; i += 4) {
      const cid = res[i], vis = res[i + 1], bandsOff = res[i + 3];
      this.city.setChunkVisible(cid, vis === 1);
      if (bandsOff >= 0) {
        const c = this.meta.chunks[cid];
        this.city.bandData.set(bands.subarray(bandsOff, bandsOff + c.bCount * 4), c.bBase * 4);
      }
    }
    this.city.applyBands();
    for (const cid of m.misses) this.sendTable(cid);
  }
  tickRates(dt) {
    const total = this.dmaOut + this.dmaIn;
    this.dmaRate = this.dmaRate * 0.92 + (total / Math.max(dt, 0.001)) * 0.08;
    this.lastDma = total;
    this.dmaOut = 0; this.dmaIn = 0;
  }
}

// ---------- HUD ----------
function buildHUD() {
  const h = $('#hud');
  let rows = `<div class="ttl">CELL CITY: SHIBUYA — RSX→WebGL2</div>`;
  for (let i = 0; i < N_SPU; i++) {
    rows += `<div class="row"><span class="k">SPU${i}</span><span class="bar"><i id="spu${i}"></i></span><span class="v" id="spuv${i}">—</span></div>`;
  }
  rows += `<div class="sep"></div>
  <div class="row"><span class="k">DMA</span><span class="bar"><i id="dmab" style="background:#7fb7ff"></i></span><span class="v" id="dmav">—</span></div>
  <div class="row"><span class="k">LS</span><span class="bar"><i id="lsb" style="background:#c9a7ff"></i></span><span class="v" id="lsv">—</span></div>
  <div class="row"><span class="k">RSX</span><span class="bar"><i id="rsxb" style="background:#ffd27f"></i></span><span class="v" id="rsxv">—</span></div>
  <div class="row"><span class="k">FIFO</span><span class="v" style="text-align:left;width:auto" id="fifov"><span class="fifo-ok">ALIVE</span></span></div>`;
  h.innerHTML = rows;
}
buildHUD();
let fpsEMA = 60;
function updateHUD() {
  if (!ppu || !state.hudVisible) return;
  for (let i = 0; i < N_SPU; i++) {
    const st = ppu.stats[i];
    const pct = Math.min(100, st.us / 1000 / 8.0 * 100); // 8msでフル
    const bar = $(`#spu${i}`);
    bar.style.width = pct + '%';
    bar.className = pct > 85 ? 'hot' : '';
    $(`#spuv${i}`).textContent = `${(st.us / 1000).toFixed(2)}ms`;
  }
  $('#dmab').style.width = Math.min(100, ppu.dmaRate / 1e6 * 18) + '%';
  $('#dmav').textContent = `${(ppu.dmaRate / 1e6).toFixed(2)}MB/s`;
  let ls = 0, evict = 0;
  for (const st of ppu.stats) { ls += st.ls; evict += st.evict; }
  $('#lsb').style.width = Math.min(100, ls / (N_SPU * 262144) * 100) + '%';
  $('#lsv').textContent = `${(ls / 1024).toFixed(0)}/${N_SPU * 256}KB·E${evict}`;
  $('#rsxb').style.width = Math.min(100, fpsEMA / 60 * 100) + '%';
  $('#rsxv').textContent = `${fpsEMA.toFixed(0)}fps·${post.sceneCalls || 0}dc·${((post.sceneTris || 0) / 1000).toFixed(0)}k△`;
  const fifoDead = performance.now() < state.fifoUntil;
  $('#fifov').innerHTML = fifoDead ? '<span class="fifo-dead">DEAD</span>' : '<span class="fifo-ok">ALIVE</span>';
}
function applyHudVis() {
  const v = state.hudVisible && state.mode === 'city' ? 'block' : 'none';
  $('#hud').style.display = v;
  $('#controls').style.display = v;
  $('#attrib').style.display = v;
}

// ---------- カード ----------
function openCard(ch, title, body) {
  $('#card .ch').textContent = ch;
  $('#card h2').textContent = title;
  $('#card p').textContent = body;
  $('#card').classList.add('show');
  state.cardOpen = true;
}
function closeCard() { $('#card').classList.remove('show'); state.cardOpen = false; state.cardCooldown = performance.now() + 4000; }
$('#card').addEventListener('click', closeCard);

// ---------- 操作 ----------
const canvas = $('#gl');
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!dragging || state.mode !== 'city') return;
  state.yaw -= (e.clientX - lastX) * 0.0028;
  state.pitch = THREE.MathUtils.clamp(state.pitch - (e.clientY - lastY) * 0.0028, -1.45, 1.45);
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('wheel', (e) => {
  if (state.mode !== 'city') return;
  state.speed = THREE.MathUtils.clamp(state.speed * (e.deltaY > 0 ? 0.88 : 1.14), 6, 280);
});
// touch
const touches = new Map();
canvas.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, side: t.clientX < window.innerWidth * 0.42 ? 'L' : 'R' });
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (state.mode !== 'city') return;
  for (const t of e.changedTouches) {
    const o = touches.get(t.identifier); if (!o) continue;
    const dx = t.clientX - o.x, dy = t.clientY - o.y;
    if (o.side === 'R') {
      state.yaw -= dx * 0.004;
      state.pitch = THREE.MathUtils.clamp(state.pitch - dy * 0.004, -1.45, 1.45);
    } else {
      o.mx = (t.clientX - o.sx) / 60; o.my = (t.clientY - o.sy) / 60;
    }
    o.x = t.clientX; o.y = t.clientY;
  }
}, { passive: true });
canvas.addEventListener('touchend', (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); }, { passive: true });

function resetCam() {
  state.pos.set(0, groundYAt(0, 0) + 26, 120);
  state.yaw = 0; state.pitch = -0.06;
}

// ---------- モード遷移 ----------
function tryBoot() {
  if (!ppu) { xmbMsg('まだインストール中です…'); return; }
  bootCity();
}
function bootCity() {
  if (state.mode !== 'menu') return;
  state.mode = 'boot';
  $('#xmb').classList.add('hidden');
  audio.gong();
  if (state.booted) {
    // 再開: 演出短縮
    state.mode = 'city';
    applyHudVis();
    return;
  }
  state.booted = true;
  state.bootT = 0;
}
function returnToMenu() {
  state.mode = 'menu';
  $('#xmb').classList.remove('hidden');
  applyHudVis();
  xmbMsg('');
  buildXMB();
}
function setToon(on) {
  if (on && !state.fifoSeen) {
    // 初回lilToonはFIFOを殺す (記事再現)
    state.fifoSeen = true;
    state.fifoUntil = performance.now() + 1600;
    $('#fifo').style.display = 'block';
    audio.fifoDead();
    setTimeout(() => {
      $('#fifo').style.display = 'none';
      state.toon = true; city && city.setToon(true);
    }, 1600);
    return;
  }
  state.toon = on;
  city && city.setToon(on);
}
function toggleCRT() {
  post.setCRT(!post.crt, DPR);
  xmbMsg(post.crt ? 'SDTVモード: ON — 854×480' : 'SDTVモード: OFF — 1080p');
}

// 最初のユーザー操作で音を起こす
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });
// ブート演出はクリックでスキップ可
window.addEventListener('pointerdown', () => { if (state.mode === 'boot') state.bootT = 7.4; });

// ---------- 近接トースト ----------
let lastLandmark = null;
function updateLandmark() {
  if (!meta) return;
  let best = null, bd = 1e9;
  for (const l of meta.landmarks) {
    if (!l.name || l.name.startsWith('BLD_')) continue;
    const d = Math.hypot(l.x - state.pos.x, l.z - state.pos.z);
    if (d < bd) { bd = d; best = l; }
  }
  const el = $('#landmark');
  if (best && bd < 150) {
    if (lastLandmark !== best.name) {
      el.querySelector('.nm').textContent = best.name;
      el.querySelector('.ht').textContent = `計測高さ ${best.h.toFixed(1)} m — PLATEAU実測値`;
      el.style.display = 'block';
      lastLandmark = best.name;
    }
  } else { el.style.display = 'none'; lastLandmark = null; }
}

function updateShards() {
  if (!shards || state.cardOpen) return;
  if (performance.now() < (state.cardCooldown || 0)) return;
  for (const it of shards.items) {
    const d = Math.hypot(it.story.x - state.pos.x, it.story.z - state.pos.z);
    const dy = Math.abs(it.baseY + 8 - state.pos.y);
    if (d < 24 && dy < 60) {
      openCard(it.story.ch, it.story.title, it.story.body);
      if (!it.read) { it.read = true; audio.chime(); }
      break;
    }
  }
}

// ---------- debug ----------
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message) + ' @' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason)));
window.CC = {
  state, scene, camera, renderer, post,
  get ppu() { return ppu; }, get city() { return city; }, get meta() { return meta; },
  boot: () => tryBoot(),
  step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) frame(dt); },
  warp: (x, y, z, yaw = 0, pitch = 0) => {
    state.mode = 'city'; state.booted = true;
    $('#xmb').classList.add('hidden');
    state.pos.set(x, y, z); state.yaw = yaw; state.pitch = pitch;
    applyHudVis();
  },
};

// ---------- メインループ ----------
const clock = new THREE.Clock();
let timeAcc = 0;

function loop() {
  requestAnimationFrame(loop);
  frame(Math.min(clock.getDelta(), 0.1));
}

function frame(dt) {
  const t = (timeAcc += dt);
  state.frame++;
  fpsEMA = fpsEMA * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

  const fifoDead = performance.now() < state.fifoUntil;
  if (fifoDead) return; // 画面ごと凍る (本物の絶望)

  // カメラ
  if (state.mode === 'menu') {
    const a = t * 0.018;
    state.pos.set(Math.sin(a) * 1150, 360 + Math.sin(t * 0.05) * 30, Math.cos(a) * 1150);
    camera.position.copy(state.pos);
    camera.lookAt(0, 250, 0);
  } else if (state.mode === 'boot') {
    state.bootT += dt;
    const k = THREE.MathUtils.smoothstep(state.bootT / 7.5, 0, 1);
    const ang = -0.6 + k * 1.9;
    const r = 1150 - k * 1030;
    const y = 620 - k * 580;
    state.pos.set(Math.sin(ang) * r, y + groundYAt(0, 0), Math.cos(ang) * r);
    camera.position.copy(state.pos);
    const look = new THREE.Vector3(0, 30 + (1 - k) * 120, 0);
    camera.lookAt(look);
    if (state.bootT >= 7.5) {
      state.mode = 'city';
      // lookAtからyaw/pitchを引き継ぐ
      const d = look.sub(camera.position).normalize();
      state.yaw = Math.atan2(-d.x, -d.z);
      state.pitch = Math.asin(d.y);
      applyHudVis();
      audio.startDrone();
    }
  } else if (state.mode === 'city' && !state.cardOpen) {
    const k = state.keys;
    const boost = (k['ShiftLeft'] || k['ShiftRight']) ? 4 : 1;
    const sp = state.speed * boost;
    const fwd = new THREE.Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    const up = Math.sin(state.pitch);
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (k['KeyW'] || k['ArrowUp']) { move.addScaledVector(fwd, 1); move.y += up; }
    if (k['KeyS'] || k['ArrowDown']) { move.addScaledVector(fwd, -1); move.y -= up; }
    if (k['KeyA'] || k['ArrowLeft']) move.addScaledVector(right, -1);
    if (k['KeyD'] || k['ArrowRight']) move.addScaledVector(right, 1);
    if (k['KeyE'] || k['Space']) move.y += 1;
    if (k['KeyQ'] || k['KeyC']) move.y -= 1;
    // タッチ移動
    for (const o of touches.values()) {
      if (o.side === 'L' && o.mx !== undefined) {
        move.addScaledVector(fwd, -THREE.MathUtils.clamp(o.my, -1.5, 1.5));
        move.addScaledVector(right, THREE.MathUtils.clamp(o.mx, -1.5, 1.5));
      }
    }
    if (move.lengthSq() > 0) move.normalize();
    state.vel.lerp(move.multiplyScalar(sp), 1 - Math.pow(0.0001, dt));
    state.pos.addScaledVector(state.vel, dt);
    const gy = groundYAt(state.pos.x, state.pos.z) + 2.2;
    if (state.pos.y < gy) { state.pos.y = gy; state.vel.y = 0; }
    state.pos.x = THREE.MathUtils.clamp(state.pos.x, -1400, 1400);
    state.pos.z = THREE.MathUtils.clamp(state.pos.z, -1400, 1400);
    state.pos.y = Math.min(state.pos.y, 900);
    camera.position.copy(state.pos);
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  } else {
    camera.position.copy(state.pos);
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  }

  // SPUディスパッチ & 環境更新
  if (ppu) {
    ppu.dispatch(t, dt);
    ppu.tickRates(dt);
  }
  sky.update(t);
  wave.update(t);
  sparkles.update(t);
  if (city) city.update(t, camera.position);
  if (ground) ground.update(t, camera.position);
  if (roads) roads.update(t, camera.position);
  if (trains) trains.update(t);
  if (monolith) monolith.update(t, camera.position);
  if (shards) shards.update(t);

  if (state.mode === 'city') {
    updateLandmark();
    updateShards();
  }
  post.render(scene, camera, t);
  if (state.frame % 6 === 0) updateHUD();
}
loop();
