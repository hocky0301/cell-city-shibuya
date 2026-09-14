/**
 * Post — tiny3Dを捨ててcellGcmへ降りた人への敬意として、
 * EffectComposerを使わずレンダーパスを手書きする。
 * bright pass → 2段ブラー → 合成 (ACES / グレイン / 走査線 / 収差 / ビネット)
 */
import * as THREE from 'three';

const FSQ_VERT = /* glsl */`
precision highp float;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

function pass(frag, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    vertexShader: FSQ_VERT, fragmentShader: frag, uniforms,
  });
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.crt = false;

    const opt = { type: THREE.HalfFloatType, depthBuffer: true };
    const optNB = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtScene = new THREE.WebGLRenderTarget(2, 2, opt);
    this.rtBrightH = new THREE.WebGLRenderTarget(2, 2, optNB);
    this.rtBlurHa = new THREE.WebGLRenderTarget(2, 2, optNB);
    this.rtBlurHb = new THREE.WebGLRenderTarget(2, 2, optNB);
    this.rtBlurQa = new THREE.WebGLRenderTarget(2, 2, optNB);
    this.rtBlurQb = new THREE.WebGLRenderTarget(2, 2, optNB);
    for (const rt of [this.rtScene, this.rtBrightH, this.rtBlurHa, this.rtBlurHb, this.rtBlurQa, this.rtBlurQb]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
    }

    this.matBright = pass(/* glsl */`
      precision highp float;
      in vec2 vUv; uniform sampler2D tIn; out vec4 o;
      void main() {
        vec3 c = texture(tIn, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float k = smoothstep(0.62, 1.4, l);
        o = vec4(c * k, 1.0);
      }`, { tIn: { value: null } });

    this.matBlur = pass(/* glsl */`
      precision highp float;
      in vec2 vUv; uniform sampler2D tIn; uniform vec2 uDir; out vec4 o;
      void main() {
        vec3 a = vec3(0.0);
        float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
        a += texture(tIn, vUv).rgb * w[0];
        for (int i = 1; i < 5; i++) {
          a += texture(tIn, vUv + uDir * float(i)).rgb * w[i];
          a += texture(tIn, vUv - uDir * float(i)).rgb * w[i];
        }
        o = vec4(a, 1.0);
      }`, { tIn: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.matComposite = pass(/* glsl */`
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tScene; uniform sampler2D tBloomH; uniform sampler2D tBloomQ;
      uniform float uTime; uniform float uCRT; uniform vec2 uRes;
      out vec4 o;
      vec3 aces(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
      void main() {
        vec2 uv = vUv;
        if (uCRT > 0.5) {
          // ブラウン管の樽歪み
          vec2 c = uv - 0.5;
          uv = 0.5 + c * (1.0 + dot(c, c) * 0.22);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
        }
        // 色収差
        float ab = (0.0009 + uCRT * 0.0024) * (0.5 + length(uv - 0.5));
        vec3 c;
        c.r = texture(tScene, uv + vec2(ab, 0.0)).r;
        c.g = texture(tScene, uv).g;
        c.b = texture(tScene, uv - vec2(ab, 0.0)).b;
        vec3 bloom = texture(tBloomH, uv).rgb * 0.85 + texture(tBloomQ, uv).rgb * 1.15;
        c += bloom * 0.75;
        c = aces(c * 1.25);
        // 走査線
        if (uCRT > 0.5) {
          float sl = 0.78 + 0.22 * sin(uv.y * 480.0 * 3.14159);
          c *= sl;
          float mask = 0.92 + 0.08 * sin(uv.x * uRes.x * 3.14159);
          c *= mask;
          c *= 1.18;
        }
        // フィルムグレイン
        c += (h21(uv * uRes + fract(uTime) * 100.0) - 0.5) * 0.028;
        // ビネット
        float vig = 1.0 - dot(uv - 0.5, uv - 0.5) * (0.55 + uCRT * 0.4);
        c *= vig;
        c = pow(max(c, 0.0), vec3(1.0 / 2.2));
        o = vec4(c, 1.0);
      }`, {
      tScene: { value: null }, tBloomH: { value: null }, tBloomQ: { value: null },
      uTime: { value: 0 }, uCRT: { value: 0 }, uRes: { value: new THREE.Vector2() },
    });
  }

  setSize(w, h, dpr) {
    this.w = w; this.h = h;
    const sw = this.crt ? 854 : Math.round(w * dpr);
    const sh = this.crt ? 480 : Math.round(h * dpr);
    this.rtScene.setSize(sw, sh);
    this.rtBrightH.setSize(sw >> 1, sh >> 1);
    this.rtBlurHa.setSize(sw >> 1, sh >> 1);
    this.rtBlurHb.setSize(sw >> 1, sh >> 1);
    this.rtBlurQa.setSize(sw >> 2, sh >> 2);
    this.rtBlurQb.setSize(sw >> 2, sh >> 2);
    this.matComposite.uniforms.uRes.value.set(sw, sh);
    if (this.crt) {
      this.rtScene.texture.magFilter = THREE.NearestFilter; // SDTVのジャギ
    } else {
      this.rtScene.texture.magFilter = THREE.LinearFilter;
    }
  }
  setCRT(on, dpr) { this.crt = on; this.setSize(this.w, this.h, dpr); }

  blit(mat, rtOut) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(rtOut);
    this.renderer.render(this.scene, this.cam);
  }

  render(scene3d, cam3d, time) {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.render(scene3d, cam3d);
    this.sceneCalls = r.info.render.calls;
    this.sceneTris = r.info.render.triangles;
    // bright
    this.matBright.uniforms.tIn.value = this.rtScene.texture;
    this.blit(this.matBright, this.rtBrightH);
    // half blur ×2
    let src = this.rtBrightH, a = this.rtBlurHa, b = this.rtBlurHb;
    for (let i = 0; i < 2; i++) {
      this.matBlur.uniforms.tIn.value = src.texture;
      this.matBlur.uniforms.uDir.value.set(1.6 / a.width, 0);
      this.blit(this.matBlur, a);
      this.matBlur.uniforms.tIn.value = a.texture;
      this.matBlur.uniforms.uDir.value.set(0, 1.6 / a.height);
      this.blit(this.matBlur, b);
      src = b; const t = a; a = this.rtBlurHa === a ? this.rtBlurHa : t; // keep ping-pong simple
    }
    // quarter blur (広いボケ)
    this.matBlur.uniforms.tIn.value = src.texture;
    this.matBlur.uniforms.uDir.value.set(2.2 / this.rtBlurQa.width, 0);
    this.blit(this.matBlur, this.rtBlurQa);
    this.matBlur.uniforms.tIn.value = this.rtBlurQa.texture;
    this.matBlur.uniforms.uDir.value.set(0, 2.2 / this.rtBlurQa.height);
    this.blit(this.matBlur, this.rtBlurQb);
    // composite
    this.matComposite.uniforms.tScene.value = this.rtScene.texture;
    this.matComposite.uniforms.tBloomH.value = src.texture;
    this.matComposite.uniforms.tBloomQ.value = this.rtBlurQb.texture;
    this.matComposite.uniforms.uTime.value = time;
    this.matComposite.uniforms.uCRT.value = this.crt ? 1 : 0;
    this.blit(this.matComposite, null);
    r.setRenderTarget(null);
  }
}
