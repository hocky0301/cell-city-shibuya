/**
 * CityMesh — PLATEAU 渋谷の建物チャンクを描く
 * シェーダは cellGcm の精神で手書き: Blinn-Phong + 手続き窓グリッド + 用途別ネオン
 */
import * as THREE from 'three';

export const BAND_TEX_W = 8192;

const VERT = /* glsl */`
precision highp float;
in float aHeight;   // 建物の計測高さ
in float aRelH;     // 建物内相対高さ 0..1 (normalized u8)
in float aSeed;     // 建物シード 0..1 (normalized u8)
in float aBld;      // 建物グローバルID (u16 -> float)
out vec3 vWorld;
out vec3 vNormal;
out float vHeight;
out float vRelH;
out float vSeed;
flat out int vBld;
void main() {
  vWorld = position;
  vNormal = normal;   // ベイク済みワールド法線 (i8 normalized)
  vHeight = aHeight;
  vRelH = aRelH;
  vSeed = aSeed;
  vBld = int(aBld + 0.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vHeight;
in float vRelH;
in float vSeed;
flat in int vBld;
out vec4 outColor;

uniform sampler2D uBands;     // 建物ごと縦4バンドの点灯率 (SPUが書く)
uniform sampler2D uUsage;     // 建物ごとの用途 (u8: 0..4)
uniform vec3 uCam;
uniform float uTime;
uniform float uFloorH;
uniform int uToon;
uniform vec3 uFog;
uniform vec3 uPalette[5];

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  float dist = distance(uCam, vWorld);

  int usage = int(texelFetch(uUsage, ivec2(vBld % ${BAND_TEX_W}, 0), 0).r * 255.0 + 0.5);
  vec3 neon = uPalette[usage > 4 ? 4 : usage];

  // ---- ベース材質 (コンクリート) ----
  float wallTone = 0.045 + 0.025 * h21(vec2(vSeed * 255.0, 7.0));
  vec3 albedo = vec3(wallTone) * (vec3(0.9, 0.95, 1.1) + 0.15 * neon);
  bool roof = N.y > 0.55;
  if (roof) albedo *= 0.55;

  // ---- Blinn-Phong (記事の最初の灯) ----
  vec3 Ldir = normalize(vec3(0.42, 0.78, 0.30));     // 月
  vec3 moonC = vec3(0.62, 0.70, 1.0);
  float ndl = max(dot(N, Ldir), 0.0);
  vec3 H = normalize(Ldir + V);
  float spec = pow(max(dot(N, H), 0.0), 64.0);
  // 半球環境光 (空のネオン照り返し)
  vec3 hemi = mix(vec3(0.030, 0.034, 0.052), vec3(0.078, 0.085, 0.135), N.y * 0.5 + 0.5);
  hemi += neon * 0.012;
  if (uToon == 1) {
    ndl = floor(ndl * 3.0 + 0.5) / 3.0;
    spec = step(0.5, spec);
  }
  vec3 lit = albedo * (hemi + moonC * ndl * 0.16) + moonC * spec * 0.10;

  // ---- 窓グリッド ----
  float hAbove = vRelH * max(vHeight, 0.01);
  float winDetail = smoothstep(700.0, 260.0, dist);
  vec4 bands = texelFetch(uBands, ivec2(vBld % ${BAND_TEX_W}, 0), 0); // 0..1 ×4バンド
  float bandT = clamp(vRelH * 4.0, 0.0, 3.999);
  int bi = int(bandT);
  float band = mix(bands[bi], bands[min(bi + 1, 3)], fract(bandT)) ;

  vec3 emissive = vec3(0.0);
  if (!roof && vHeight > 3.5) {
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
    float u = dot(vWorld.xz, T.xz);
    float colW = 2.6, fH = uFloorH;
    float colI = floor(u / colW), floorI = floor(hAbove / fH);
    vec2 cell = vec2(fract(u / colW), fract(hAbove / fH));
    float rnd = h21(vec2(vSeed * 941.0 + colI, floorI * 13.7));
    // 窓のかたち
    float wmask = step(0.16, cell.x) * step(cell.x, 0.84) * step(0.22, cell.y) * step(cell.y, 0.80);
    if (uToon == 0) {
      // ガラスのグラデ
      wmask *= 0.75 + 0.25 * cell.y;
    }
    float on = step(rnd, band * 1.15) * step(0.02, band);
    float warmth = h21(vec2(colI * 3.1, vSeed * 533.0));
    vec3 winC = mix(vec3(1.0, 0.86, 0.62), neon, 0.25 + 0.45 * warmth); // 生活の灯〜ネオン
    float winB = (0.55 + 0.45 * h21(vec2(rnd, floorI))) * band;
    emissive += winC * wmask * on * winB * 2.4 * winDetail;
    // 遠距離: 窓を畳んでファサード全体の光に
    emissive += winC * band * 0.16 * (1.0 - winDetail);
    // ---- 低層ネオンサイン (商業) ----
    if (usage == 0 && hAbove < 13.0 && vHeight > 6.0) {
      float sign = step(0.55, h21(vec2(vSeed * 77.0, floor(hAbove / 3.0))));
      float hue = h21(vec2(vSeed * 991.0, 3.0));
      vec3 signC = mix(vec3(1.0, 0.18, 0.55), vec3(0.2, 0.85, 1.0), hue);
      signC = mix(signC, vec3(1.0, 0.65, 0.1), step(0.66, h21(vec2(vSeed, 9.1))));
      float flick = 0.8 + 0.2 * sin(uTime * (2.0 + vSeed * 9.0) + u * 0.8);
      emissive += signC * sign * bands[0] * flick * 1.9;
    }
  }
  if (roof && vHeight > 40.0) {
    // 屋上の縁にうっすら
    emissive += neon * 0.05 * band;
  }

  // 足元AO
  float ao = mix(0.45, 1.0, smoothstep(0.0, 16.0, hAbove + (roof ? 16.0 : 0.0)));
  vec3 col = lit * ao + emissive;
  if (uToon == 1) {
    col = floor(col * 5.0) / 5.0;
    // トゥーンの輪郭: フレネルで縁を落とす
    col *= smoothstep(-0.1, 0.25, dot(N, V));
  }

  // ---- フォグ (高所ほど薄い / 遠景は空のグロウへ) ----
  float fogAmt = 1.0 - exp(-pow(dist * 0.00095, 1.6) * (1.0 + max(0.0, 30.0 - vWorld.y) * 0.012));
  vec3 horizon = uFog + vec3(0.14, 0.06, 0.13) * 0.55;
  vec3 fogC = mix(uFog, horizon, smoothstep(500.0, 2200.0, dist));
  col = mix(col, fogC, clamp(fogAmt, 0.0, 1.0));
  outColor = vec4(col, 1.0);
}`;

export class CityMesh {
  constructor(meta, blob) {
    this.meta = meta;
    this.group = new THREE.Group();
    this.chunkMeshes = [];

    const nB = meta.counts.buildings;
    // SPUが書き込む点灯バンドテクスチャ (初期値: SPU未処理の遠方チャンクも薄く灯る)
    this.bandData = new Uint8Array(BAND_TEX_W * 4).fill(96);
    this.bandTex = new THREE.DataTexture(this.bandData, BAND_TEX_W, 1, THREE.RGBAFormat);
    this.bandTex.needsUpdate = true;
    // 用途テクスチャ (静的)
    const s = meta.sections;
    const btabF = new Float32Array(blob, s.btabF, nB * 4);
    const btabB = new Uint8Array(blob, s.btabB, nB * 4);
    const usageData = new Uint8Array(BAND_TEX_W * 4);
    for (let i = 0; i < nB; i++) usageData[i * 4] = btabB[i * 4];
    this.usageTex = new THREE.DataTexture(usageData, BAND_TEX_W, 1, THREE.RGBAFormat);
    this.usageTex.needsUpdate = true;
    this.btabF = btabF;
    this.btabB = btabB;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uBands: { value: this.bandTex },
        uUsage: { value: this.usageTex },
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uFloorH: { value: meta.floorH },
        uToon: { value: 0 },
        uFog: { value: new THREE.Color(0x05060d) },
        uPalette: { value: [
          new THREE.Color(0xff2d95), // 0 商業 マゼンタ
          new THREE.Color(0x38d9ff), // 1 業務 シアン
          new THREE.Color(0xffb24d), // 2 住宅 アンバー
          new THREE.Color(0x7dffa0), // 3 公共 グリーン
          new THREE.Color(0x9b8cff), // 4 その他 バイオレット
        ] },
      },
    });

    // 頂点blob: batchLocal → batchGlobal へ書き換え (チャンク全体で1マテリアル共有)
    const vBytes = meta.counts.verts * 24;
    const u16All = new Uint16Array(blob, s.verts, vBytes / 2);
    for (const c of meta.chunks) {
      for (let v = 0; v < c.vCount; v++) {
        u16All[(c.vOff + v) * 12 + 11] += c.bBase;
      }
    }

    for (const c of meta.chunks) {
      const f32 = new Float32Array(blob, s.verts + c.vOff * 24, c.vCount * 6);
      const i8 = new Int8Array(blob, s.verts + c.vOff * 24, c.vCount * 24);
      const u8 = new Uint8Array(blob, s.verts + c.vOff * 24, c.vCount * 24);
      const u16 = new Uint16Array(blob, s.verts + c.vOff * 24, c.vCount * 12);
      const bf = new THREE.InterleavedBuffer(f32, 6);
      const b8 = new THREE.InterleavedBuffer(i8, 24);
      const bu8 = new THREE.InterleavedBuffer(u8, 24);
      const b16 = new THREE.InterleavedBuffer(u16, 12);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.InterleavedBufferAttribute(bf, 3, 0));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(b8, 3, 12, true));
      g.setAttribute('aHeight', new THREE.InterleavedBufferAttribute(bf, 1, 4));
      g.setAttribute('aRelH', new THREE.InterleavedBufferAttribute(bu8, 1, 20, true));
      g.setAttribute('aSeed', new THREE.InterleavedBufferAttribute(bu8, 1, 21, true));
      g.setAttribute('aBld', new THREE.InterleavedBufferAttribute(b16, 1, 11, false));
      const idx = c.i32
        ? new Uint32Array(blob, s.idx + c.iOff * 2, c.iCount)
        : new Uint16Array(blob, s.idx + c.iOff * 2, c.iCount);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      const mesh = new THREE.Mesh(g, this.material);
      mesh.frustumCulled = false; // カリングはSPUの仕事
      mesh.visible = false;
      this.group.add(mesh);
      this.chunkMeshes.push(mesh);
    }

    // ---- 航空障害灯 (70m以上の建物) ----
    const beacons = [];
    for (const c of meta.chunks) {
      for (let i = 0; i < c.bCount; i++) {
        const gi = c.bBase + i;
        const h = btabF[gi * 4 + 2];
        if (h >= 70) {
          const groundY = c.yMin;
          beacons.push(btabF[gi * 4], groundY + h + 2.5, btabF[gi * 4 + 1], btabB[gi * 4 + 1]);
        }
      }
    }
    if (beacons.length) {
      const bg = new THREE.BufferGeometry();
      const pos = new Float32Array(beacons.length / 4 * 3);
      const seed = new Float32Array(beacons.length / 4);
      for (let i = 0; i < beacons.length / 4; i++) {
        pos[i * 3] = beacons[i * 4]; pos[i * 3 + 1] = beacons[i * 4 + 1]; pos[i * 3 + 2] = beacons[i * 4 + 2];
        seed[i] = beacons[i * 4 + 3] / 255;
      }
      bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      bg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const bm = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: /* glsl */`
          precision highp float;
          in float aSeed;
          uniform float uTime;
          out float vA;
          void main() {
            vec4 mv = viewMatrix * vec4(position, 1.0);
            float pulse = 0.5 + 0.5 * sin(uTime * 1.6 + aSeed * 31.0);
            vA = pulse;
            gl_PointSize = clamp(340.0 / -mv.z, 2.0, 9.0) * (0.7 + 0.3 * pulse);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */`
          precision highp float;
          in float vA;
          out vec4 o;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float a = smoothstep(1.0, 0.1, d);
            o = vec4(vec3(1.0, 0.12, 0.10) * a * vA * 1.6, a * vA);
          }`,
      });
      const pts = new THREE.Points(bg, bm);
      pts.frustumCulled = false;
      this.group.add(pts);
      this.beaconMat = bm;
    }
  }

  setToon(on) { this.material.uniforms.uToon.value = on ? 1 : 0; }

  update(time, camPos) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uCam.value.copy(camPos);
    if (this.beaconMat) this.beaconMat.uniforms.uTime.value = time;
  }

  // SPUの結果を反映
  applyBands() { this.bandTex.needsUpdate = true; }
  setChunkVisible(i, v) { this.chunkMeshes[i].visible = v; }
}
