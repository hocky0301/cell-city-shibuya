/**
 * Monolith & Story Shards
 * スクランブル交差点上空に浮かぶ黒い直方体(1:4:9)。
 * 周囲を8つのキューブが回る — 6つは輝き(可用SPU)、1つは鈍く(OS予約)、1つは消えている(歩留まり)。
 */
import * as THREE from 'three';

export class Monolith {
  constructor() {
    this.group = new THREE.Group();
    // 1:4:9 — 2001年宇宙の旅の比率
    const g = new THREE.BoxGeometry(18, 40.5, 4.5);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */`
        precision highp float;
        out vec3 vN; out vec3 vW; out vec3 vL;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vL = position;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec3 vN; in vec3 vW; in vec3 vL;
        uniform float uTime; uniform vec3 uCam;
        out vec4 o;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(uCam - vW);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = vec3(0.004, 0.005, 0.008);
          col += vec3(0.35, 0.45, 0.9) * fres * 0.5;
          // 走査線のようなシーム
          float seam = exp(-pow((fract(vL.y * 0.05 - uTime * 0.07) - 0.5) * 18.0, 2.0));
          col += vec3(0.3, 0.8, 1.0) * seam * 0.35;
          o = vec4(col, 1.0);
        }`,
    });
    this.core = new THREE.Mesh(g, this.mat);
    this.group.add(this.core);

    // SPUキューブ ×8
    this.spus = [];
    const cg = new THREE.BoxGeometry(2.6, 2.6, 2.6);
    for (let i = 0; i < 8; i++) {
      const state = i < 6 ? 1.0 : i === 6 ? 0.22 : 0.0; // 6可用 / OS予約 / 無効
      const cm = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: { uTime: { value: 0 }, uState: { value: state }, uSeed: { value: i } },
        vertexShader: /* glsl */`
          precision highp float;
          out vec3 vL;
          void main() { vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          precision highp float;
          in vec3 vL; uniform float uTime; uniform float uState; uniform float uSeed;
          out vec4 o;
          void main() {
            float pulse = 0.6 + 0.4 * sin(uTime * 2.4 + uSeed * 2.2);
            vec3 c = mix(vec3(0.05, 0.4, 0.5), vec3(0.45, 0.9, 1.0), pulse);
            float dead = step(uState, 0.01);
            // 死んだSPUはたまに明滅する亡霊
            float ghost = dead * step(0.992, fract(sin(floor(uTime * 3.0) * 12.99) * 43758.5));
            float k = uState * pulse + ghost * 0.5;
            o = vec4(c * k * 1.6, k * 0.9);
          }`,
      });
      const m = new THREE.Mesh(cg, cm);
      m.frustumCulled = false;
      this.group.add(m);
      this.spus.push({ mesh: m, mat: cm, i });
    }

    // ビーム
    const beamG = new THREE.CylinderGeometry(3.0, 9.0, 130, 24, 1, true);
    const beamM = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        precision highp float;
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec2 vUv; uniform float uTime; out vec4 o;
        void main() {
          float a = pow(vUv.y, 2.0) * 0.13 * (0.8 + 0.2 * sin(uTime * 1.1 + vUv.y * 9.0));
          o = vec4(vec3(0.4, 0.75, 1.0) * a, a);
        }`,
    });
    this.beam = new THREE.Mesh(beamG, beamM);
    this.beam.position.y = -85;
    this.beamM = beamM;
    this.group.add(this.beam);
    this.group.position.set(0, 150, 0);
  }
  update(t, cam) {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uCam.value.copy(cam);
    this.beamM.uniforms.uTime.value = t;
    this.core.rotation.y = t * 0.08;
    for (const s of this.spus) {
      const a = t * 0.32 + (s.i / 8) * Math.PI * 2;
      const r = 26 + Math.sin(t * 0.5 + s.i) * 2.5;
      s.mesh.position.set(Math.cos(a) * r, Math.sin(t * 0.7 + s.i * 1.7) * 14, Math.sin(a) * r);
      s.mesh.rotation.set(t * 0.7 + s.i, t * 0.9, 0);
      s.mat.uniforms.uTime.value = t;
    }
  }
}

export class Shards {
  constructor(story) {
    this.group = new THREE.Group();
    this.items = [];
    const g = new THREE.OctahedronGeometry(3.2, 0);
    for (let i = 0; i < story.length; i++) {
      const st = story[i];
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: { uTime: { value: 0 }, uSeed: { value: i }, uRead: { value: 0 } },
        vertexShader: /* glsl */`
          precision highp float;
          uniform float uTime; uniform float uSeed;
          out vec3 vN; out vec3 vP;
          void main() {
            vN = normal; vP = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          precision highp float;
          in vec3 vN; in vec3 vP;
          uniform float uTime; uniform float uSeed; uniform float uRead;
          out vec4 o;
          void main() {
            float pulse = 0.55 + 0.45 * sin(uTime * 2.0 + uSeed * 2.4);
            vec3 unread = vec3(0.62, 0.5, 1.0);
            vec3 read = vec3(0.25, 0.85, 0.6);
            vec3 c = mix(unread, read, uRead);
            float k = (0.5 + 0.5 * pulse) * (uRead > 0.5 ? 0.45 : 1.0);
            o = vec4(c * k * 1.8, k * 0.85);
          }`,
      });
      const m = new THREE.Mesh(g, mat);
      m.position.set(st.x, 0, st.z); // yはmainで地面に合わせる
      m.frustumCulled = false;
      this.group.add(m);
      // 足元のリング
      const ringG = new THREE.RingGeometry(4.6, 5.4, 48);
      ringG.rotateX(-Math.PI / 2);
      const ringM = new THREE.MeshBasicMaterial({ color: 0x9b8cff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      const ring = new THREE.Mesh(ringG, ringM);
      ring.position.set(st.x, 0, st.z);
      this.group.add(ring);
      this.items.push({ mesh: m, ring, mat, story: st, read: false, baseY: 0 });
    }
  }
  setGroundY(fn) {
    for (const it of this.items) {
      const y = fn(it.story.x, it.story.z);
      it.baseY = y;
      it.ring.position.y = y + 0.4;
    }
  }
  update(t) {
    for (const it of this.items) {
      it.mesh.position.y = it.baseY + 7.5 + Math.sin(t * 1.1 + it.story.x) * 1.2;
      it.mesh.rotation.y = t * 0.8;
      it.mat.uniforms.uTime.value = t;
      it.mat.uniforms.uRead.value = it.read ? 1 : 0;
    }
  }
}
