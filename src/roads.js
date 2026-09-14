/**
 * Roads & Trains — ネオン街路と走る山手線
 * 道路: © OpenStreetMap contributors (ODbL)
 */
import * as THREE from 'three';

export class Roads {
  constructor(meta, blob) {
    const f32 = new Float32Array(blob, 0, meta.vCount * 5);
    const u8 = new Uint8Array(blob, 0, meta.vCount * 20);
    const idx = new Uint32Array(blob, meta.vBytes, meta.iCount);
    const bf = new THREE.InterleavedBuffer(f32, 5);
    const bu = new THREE.InterleavedBuffer(u8, 20);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(bf, 3, 0));
    g.setAttribute('aDist', new THREE.InterleavedBufferAttribute(bf, 1, 4));
    g.setAttribute('aCls', new THREE.InterleavedBufferAttribute(bu, 1, 12, false));
    g.setAttribute('aSide', new THREE.InterleavedBufferAttribute(bu, 1, 13, true));
    g.setAttribute('aRnd', new THREE.InterleavedBufferAttribute(bu, 1, 14, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uColors: { value: [
          new THREE.Color(0xffac38), // 0 首都高 アンバー
          new THREE.Color(0xfff3d8), // 1 国道・主要道 ウォームホワイト
          new THREE.Color(0xcfe5ff), // 2 補助幹線 クールホワイト
          new THREE.Color(0x8f9cc8), // 3 一般道
          new THREE.Color(0x6f76a8), // 4 生活道路
          new THREE.Color(0xff5fb0), // 5 歩行者天国 ピンク (センター街)
          new THREE.Color(0xbfffe8), // 6 鉄道 アイス
          new THREE.Color(0x2fd8c8), // 7 地下鉄ゴースト
        ] },
      },
      vertexShader: /* glsl */`
        precision highp float;
        in float aDist; in float aCls; in float aSide; in float aRnd;
        out float vDist; out float vSide; out float vRnd; flat out int vCls;
        out vec3 vW;
        void main() {
          vDist = aDist; vSide = aSide; vRnd = aRnd; vCls = int(aCls + 0.5);
          vW = position;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in float vDist; in float vSide; in float vRnd; flat in int vCls; in vec3 vW;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uColors[8];
        out vec4 o;
        void main() {
          vec3 c = uColors[vCls];
          float edge = 1.0 - abs(vSide * 2.0 - 1.0);
          float core = pow(edge, 2.2);
          float a = 0.16 + 0.5 * core;
          // 流れ: 首都高と幹線はヘッドライトの帯が走る
          if (vCls <= 1) {
            float f = fract(vDist * 0.012 - uTime * (0.55 + vRnd * 0.2));
            a += 0.5 * pow(1.0 - f, 6.0) * core;
          } else if (vCls == 5) {
            a *= 0.85 + 0.3 * sin(uTime * 2.2 + vDist * 0.05);
          } else if (vCls == 6) {
            a *= 0.55 + 0.15 * sin(uTime * 0.8 + vDist * 0.01);
          } else if (vCls == 7) {
            float f = fract(vDist * 0.004 - uTime * 0.12);
            a = (0.05 + 0.5 * pow(1.0 - f, 8.0)) * core; // 地中を走る光のパルス
          }
          float dist = distance(uCam, vW);
          float fade = exp(-dist * 0.0012);
          float brightness = (vCls == 4 || vCls == 3) ? 0.4 : 0.85;
          o = vec4(c * a * brightness, a * fade * 0.85);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = 0.6; // 地面メッシュの粗いテッセレーションに沈まないよう浮かす
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  update(t, cam) { this.mat.uniforms.uTime.value = t; this.mat.uniforms.uCam.value.copy(cam); }
}

export class Trains {
  constructor(rails) {
    this.group = new THREE.Group();
    this.trains = [];
    // 経路を長さ順に: 山手線などの本線が先頭に来る
    const paths = rails
      .map(r => {
        let len = 0;
        const cum = [0];
        for (let i = 1; i < r.pts.length; i++) {
          len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][2] - r.pts[i - 1][2]);
          cum.push(len);
        }
        return { ...r, len, cum };
      })
      .filter(r => r.len > 380)
      .sort((a, b) => b.len - a.len)
      .slice(0, 14);

    const geo = new THREE.PlaneGeometry(1, 1, 24, 1);
    for (let pi = 0; pi < paths.length; pi++) {
      const p = paths[pi];
      const yamanote = (p.name || '').includes('山手');
      const n = Math.min(3, 1 + Math.floor(p.len / 900));
      for (let k = 0; k < n; k++) {
        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          uniforms: {
            uColor: { value: new THREE.Color(yamanote ? 0xa6f060 : 0xbfe8ff) },
            uHead: { value: 1 },
          },
          vertexShader: /* glsl */`
            precision highp float;
            out vec2 vUv;
            void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */`
            precision highp float;
            in vec2 vUv; uniform vec3 uColor; uniform float uHead; out vec4 o;
            void main() {
              float u = uHead > 0.0 ? vUv.x : 1.0 - vUv.x;
              float body = pow(u, 2.5);                       // 後ろに減衰する光
              float win = step(0.35, fract(u * 22.0));        // 車窓
              float a = body * (0.45 + 0.55 * win) * smoothstep(0.5, 0.34, abs(vUv.y - 0.5));
              o = vec4(uColor * a * 1.7, a);
            }`,
        });
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(120, 4.2, 1);
        m.frustumCulled = false;
        this.group.add(m);
        this.trains.push({
          mesh: m, path: p, mat,
          offset: (k / n) * p.len,
          speed: (yamanote ? 16 : 13) * (0.9 + Math.random() * 0.25),
          dir: Math.random() < 0.5 ? 1 : -1,
        });
      }
    }
  }
  posAt(p, d) {
    const cum = p.cum, pts = p.pts;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const t = (d - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-5);
    const a = pts[lo], b = pts[lo + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
            b[0] - a[0], b[2] - a[2]];
  }
  update(t) {
    for (const tr of this.trains) {
      const d = ((tr.offset + t * tr.speed * tr.dir) % tr.path.len + tr.path.len) % tr.path.len;
      const [x, y, z, dx, dz] = this.posAt(tr.path, d);
      tr.mesh.position.set(x, y + 2.2, z);
      tr.mesh.rotation.y = -Math.atan2(dz, dx);
      tr.mat.uniforms.uHead.value = tr.dir;
    }
  }
}
