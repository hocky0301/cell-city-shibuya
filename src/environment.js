/**
 * Environment — 地形グラウンド / 夜空 / XMBの波 / スパークル
 */
import * as THREE from 'three';

// XMB月別テーマ色 (PS3の床屋暦)
const XMB_MONTH = [
  0xdfe6ef, 0xf3d24b, 0x9fd65f, 0xf2a3c0, 0x77c98f, 0x9b8cff,
  0x65c8e8, 0x2f6fd8, 0xb88ae0, 0xd9a05a, 0x8a6f4d, 0xd2495a,
];
export function xmbColorForMonth(m) { return new THREE.Color(XMB_MONTH[m % 12]); }

export class Ground {
  constructor(meta, blob) {
    const GW = meta.gridW, HALF = meta.halfExtent;
    const grid = new Float32Array(blob, meta.sections.grid, GW * GW);
    const segs = 95;
    const g = new THREE.PlaneGeometry(HALF * 8.0, HALF * 8.0, segs, segs);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const fx = THREE.MathUtils.clamp((x + HALF) / (2 * HALF) * (GW - 1), 0, GW - 1.001);
      const fz = THREE.MathUtils.clamp((z + HALF) / (2 * HALF) * (GW - 1), 0, GW - 1.001);
      const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
      const y = (grid[j0 * GW + i0] * (1 - tx) + grid[j0 * GW + i0 + 1] * tx) * (1 - tz)
              + (grid[(j0 + 1) * GW + i0] * (1 - tx) + grid[(j0 + 1) * GW + i0 + 1] * tx) * tz;
      pos.setY(i, y - 0.15);
    }
    g.computeVertexNormals();
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uFog: { value: new THREE.Color(0x05060d) },
      },
      vertexShader: /* glsl */`
        precision highp float;
        out vec3 vW; out vec3 vN;
        void main() {
          vW = position; vN = normal;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec3 vW; in vec3 vN;
        uniform vec3 uCam; uniform float uTime; uniform vec3 uFog;
        out vec4 o;
        float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(uCam - vW);
          float dist = distance(uCam, vW);
          // 濡れたアスファルト
          vec3 albedo = vec3(0.020, 0.022, 0.030) * (0.8 + 0.4 * h21(floor(vW.xz * 0.5)));
          vec3 Ldir = normalize(vec3(0.42, 0.78, 0.30));
          vec3 H = normalize(Ldir + V);
          float spec = pow(max(dot(N, H), 0.0), 90.0);
          vec3 col = albedo * vec3(0.5, 0.55, 0.8)
                   + vec3(0.62, 0.70, 1.0) * spec * 0.05;
          // 街の照り返し: 中心に近いほどわずかに明るい
          float cityGlow = exp(-length(vW.xz) * 0.0016);
          col += vec3(0.10, 0.045, 0.10) * cityGlow * 0.32;
          // スクランブル交差点: 横断歩道の白線
          vec2 p = vW.xz;
          float r = length(p);
          if (r < 46.0) {
            float fade = smoothstep(46.0, 20.0, r);
            float sx = step(fract(p.x / 1.45), 0.52) * step(abs(p.y), 0.0); // dummy
            float bandA = step(abs(p.y), 14.0) * step(abs(p.x), 30.0) * step(fract(p.x / 1.5), 0.55);
            float bandB = step(abs(p.x), 14.0) * step(abs(p.y), 30.0) * step(fract(p.y / 1.5), 0.55);
            vec2 q = vec2(dot(p, vec2(0.707, 0.707)), dot(p, vec2(-0.707, 0.707)));
            float bandC = step(abs(q.y), 10.0) * step(abs(q.x), 34.0) * step(fract(q.x / 1.5), 0.55);
            float zebra = max(max(bandA * step(14.0, abs(p.x)), bandB * step(14.0, abs(p.y))), bandC * step(18.0, abs(q.x)));
            col += vec3(0.16, 0.17, 0.22) * zebra * fade;
          }
          // 遠景: 開発機グリッド
          vec2 gp = abs(fract(vW.xz / 64.0) - 0.5);
          float gridL = smoothstep(0.495, 0.5, max(gp.x, gp.y)) * smoothstep(300.0, 900.0, r);
          col += vec3(0.05, 0.1, 0.18) * gridL * 0.5;
          float fogAmt = 1.0 - exp(-pow(dist * 0.00095, 1.6) * 1.35);
          // 遠景は空のホライズングロウへ溶ける (地面の果てを見せない)
          vec3 horizon = uFog + vec3(0.14, 0.06, 0.13) * 0.55;
          vec3 fogC = mix(uFog, horizon, smoothstep(500.0, 2200.0, dist));
          col = mix(col, fogC, clamp(fogAmt, 0.0, 1.0));
          o = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  update(t, cam) { this.mat.uniforms.uTime.value = t; this.mat.uniforms.uCam.value.copy(cam); }
}

export class Sky {
  constructor() {
    const g = new THREE.SphereGeometry(4200, 32, 16);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        precision highp float;
        out vec3 vD;
        void main() {
          vD = position;
          vec4 mv = viewMatrix * vec4(position + cameraPosition, 1.0);
          gl_Position = (projectionMatrix * mv).xyww;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec3 vD; uniform float uTime; out vec4 o;
        float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
        void main() {
          vec3 d = normalize(vD);
          float h = clamp(d.y, -0.1, 1.0);
          vec3 col = mix(vec3(0.030, 0.024, 0.058), vec3(0.003, 0.004, 0.010), smoothstep(-0.02, 0.30, h));
          // 地平の街明かり
          col += vec3(0.14, 0.06, 0.13) * exp(-abs(d.y) * 14.0) * 0.45;
          // 星 (セル内に丸い点を打つ)
          vec2 sp = d.xz / (d.y + 0.25);
          vec2 cell = floor(sp * 60.0);
          vec2 f = fract(sp * 60.0) - 0.5;
          vec2 jit = vec2(h21(cell + 3.7), h21(cell + 9.1)) - 0.5;
          float dd = length(f - jit * 0.6);
          float star = step(0.992, h21(cell)) * smoothstep(0.12, 0.02, dd) * smoothstep(0.1, 0.45, d.y);
          float tw = 0.6 + 0.4 * sin(uTime * (1.0 + h21(cell + 7.0) * 3.0) + h21(cell) * 31.0);
          col += vec3(0.9, 0.95, 1.0) * star * tw;
          o = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  update(t) { this.mat.uniforms.uTime.value = t; }
}

/** XMBの波 — 渋谷上空に流れるリボン */
export class Wave {
  constructor(color) {
    const g = new THREE.PlaneGeometry(4200, 1500, 160, 28);
    g.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: color },
        uAmp: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        precision highp float;
        uniform float uTime; uniform float uAmp;
        out float vGlow; out vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          float t = uTime * 0.21;
          float w = sin(p.x * 0.0021 + t) * 46.0
                  + sin(p.x * 0.0048 - t * 1.7 + p.z * 0.002) * 26.0
                  + sin(p.x * 0.0009 + t * 0.6 + p.z * 0.004) * 60.0;
          p.y += w * uAmp;
          // 法線っぽい傾きで輝度
          float dw = cos(p.x * 0.0021 + t) * 0.0021 * 46.0 + cos(p.x * 0.0048 - t * 1.7) * 0.0048 * 26.0;
          vGlow = clamp(0.5 + dw * 220.0, 0.0, 1.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in float vGlow; in vec2 vUv;
        uniform vec3 uColor;
        out vec4 o;
        void main() {
          float edge = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
          float core = exp(-pow((vUv.y - 0.5) * 4.6, 2.0));
          float a = (0.012 + 0.34 * core) * edge * (0.35 + 0.65 * vGlow);
          // 上から見下ろした時は薄く (街を覆い隠さない)
          if (gl_FrontFacing) a *= 0.16;
          o = vec4(uColor * (0.5 + 0.9 * vGlow), a * 0.40);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = 410;
    this.mesh.rotation.z = 0.055;
    this.mesh.rotation.y = -0.35;
    this.mesh.frustumCulled = false;
  }
  update(t) { this.mat.uniforms.uTime.value = t; }
}

/** XMBスパークル — 街に漂う星屑 */
export class Sparkles {
  constructor(count = 1600, color) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 2000;
      pos[i * 3 + 1] = Math.random() * 480 + 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 2000;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: color } },
      vertexShader: /* glsl */`
        precision highp float;
        in float aSeed;
        uniform float uTime;
        out float vA;
        void main() {
          vec3 p = position;
          p.y += mod(uTime * (2.0 + aSeed * 5.0) + aSeed * 480.0, 480.0) - 0.0;
          p.y = mod(p.y, 490.0);
          p.x += sin(uTime * 0.3 + aSeed * 50.0) * 9.0;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float tw = 0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 7.0) + aSeed * 99.0);
          vA = tw;
          gl_PointSize = clamp(170.0 / -mv.z, 0.6, 5.0) * (0.5 + tw);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in float vA; uniform vec3 uColor; out vec4 o;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          o = vec4(mix(vec3(1.0), uColor, 0.55) * a * vA, a * vA * 0.85);
        }`,
    });
    this.mesh = new THREE.Points(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  update(t) { this.mat.uniforms.uTime.value = t; }
}
