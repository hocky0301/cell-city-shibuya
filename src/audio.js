/**
 * Audio — 全てWebAudioで合成。アセットなし。
 * ブートの和音 / 都市の底鳴り / XMBのクリック / シャードのベル / FIFO DEADのノイズ
 */
export class CityAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  setMute(m) {
    this.muted = m;
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 0.55, this.ctx.currentTime + 0.15);
  }

  /** XMBナビゲーションのチック */
  tick() {
    const ctx = this.ensure(); const t = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 1240;
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.06);
  }
  /** 決定音 — 上昇する二音 */
  confirm() {
    const ctx = this.ensure(); const t = ctx.currentTime;
    for (const [f, dt, dur] of [[880, 0, 0.07], [1318.5, 0.06, 0.22]]) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0, t + dt);
      g.gain.linearRampToValueAtTime(0.16, t + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + dur);
      o.connect(g); g.connect(this.master);
      o.start(t + dt); o.stop(t + dt + dur + 0.05);
    }
  }
  /** ブート — 弦楽の代わりに正弦波の大伽藍 */
  gong() {
    const ctx = this.ensure(); const t = ctx.currentTime;
    const chord = [110, 164.8, 220, 277.2, 329.6, 440];
    chord.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = i < 2 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f * 0.985, t);
      o.frequency.linearRampToValueAtTime(f, t + 2.2);
      const peak = 0.10 - i * 0.01;
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(peak, t + 0.9 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.12); o.stop(t + 6);
    });
  }
  /** 都市のドローン (入場後ループ) */
  startDrone() {
    if (this.started) return;
    this.started = true;
    const ctx = this.ensure(); const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.05, t + 4);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 0.7;
    for (const f of [55, 55.35, 82.4, 110.3]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start(t);
    }
    lp.connect(g); g.connect(this.master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain(); lfoG.gain.value = 90;
    lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start(t);
    // 街のノイズ (ピンク風)
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
      d[i] = (b0 + b1 + b2) * 0.32;
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 480;
    const ng = ctx.createGain(); ng.gain.value = 0;
    ng.gain.linearRampToValueAtTime(0.030, t + 6);
    src.connect(nlp); nlp.connect(ng); ng.connect(this.master);
    src.start(t);
  }
  /** シャード開封のベル (FM) */
  chime() {
    const ctx = this.ensure(); const t = ctx.currentTime;
    const car = ctx.createOscillator(); const mod = ctx.createOscillator();
    const mg = ctx.createGain(); const g = ctx.createGain();
    car.frequency.value = 1047; mod.frequency.value = 1047 * 1.4;
    mg.gain.setValueAtTime(420, t); mg.gain.exponentialRampToValueAtTime(1, t + 1.2);
    g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    mod.connect(mg); mg.connect(car.frequency);
    car.connect(g); g.connect(this.master);
    car.start(t); mod.start(t); car.stop(t + 1.7); mod.stop(t + 1.7);
  }
  /** FIFO DEAD */
  fifoDead() {
    const ctx = this.ensure(); const t = ctx.currentTime;
    const len = ctx.sampleRate * 1.2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + 1.1);
    const g = ctx.createGain(); g.gain.value = 0.16;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t);
  }
}
