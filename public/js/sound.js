// Efectos de sonido sintetizados con WebAudio (no hace falta descargar archivos).

export class Sound {
  constructor() {
    this.enabled = safeGet('cpy_sound') !== 'off';
    this.ctx = null;
    this.master = null;
    this.engine = null;
    this.noiseBuffer = null;
    const unlock = () => {
      this._ensure();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.55 : 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  get ready() {
    return !!(this.ctx && this.enabled && this.ctx.state === 'running');
  }

  toggle() {
    this.enabled = !this.enabled;
    safeSet('cpy_sound', this.enabled ? 'on' : 'off');
    this._ensure();
    if (this.master) this.master.gain.setTargetAtTime(this.enabled ? 0.55 : 0, this.ctx.currentTime, 0.05);
    if (!this.enabled) this.engineStop();
    return this.enabled;
  }

  _tone(freq, dur, { type = 'sine', vol = 0.2, when = 0, slide = null } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _noise(dur, { vol = 0.5, from = 2000, to = 100, type = 'lowpass', when = 0, q = 0.7 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (!this.noiseBuffer) {
      const len = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  bet() {
    this._tone(520, 0.09, { type: 'triangle', vol: 0.16 });
    this._tone(780, 0.12, { type: 'triangle', vol: 0.13, when: 0.06 });
  }

  cancel() {
    this._tone(600, 0.1, { type: 'triangle', vol: 0.12, slide: 380 });
  }

  tick() {
    this._tone(1180, 0.05, { type: 'square', vol: 0.035 });
  }

  launch() {
    this._noise(1.3, { vol: 0.22, from: 250, to: 2600, type: 'bandpass', q: 1.2 });
    this._tone(110, 0.9, { type: 'sawtooth', vol: 0.05, slide: 220 });
    this.engineStart();
  }

  engineStart() {
    if (!this.ready || this.engine) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = 70;
    f.type = 'lowpass';
    f.frequency.value = 320;
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.03, ctx.currentTime + 0.4);
    o.connect(f);
    f.connect(g);
    g.connect(this.master);
    o.start();
    this.engine = { o, f, g };
  }

  engineUpdate(m) {
    if (!this.engine || !this.ctx) return;
    const l = Math.log2(Math.max(1, m));
    const t = this.ctx.currentTime;
    this.engine.o.frequency.setTargetAtTime(Math.min(420, 70 + 46 * l), t, 0.1);
    this.engine.f.frequency.setTargetAtTime(Math.min(2400, 320 + 260 * l), t, 0.1);
  }

  engineStop() {
    if (!this.engine || !this.ctx) return;
    const { o, g } = this.engine;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0.0001, t, 0.05);
    o.stop(t + 0.3);
    this.engine = null;
  }

  crash() {
    this.engineStop();
    this._noise(1.7, { vol: 0.9, from: 3200, to: 60 });
    this._tone(80, 0.9, { type: 'sine', vol: 0.5, slide: 28 });
    this._tone(160, 0.35, { type: 'square', vol: 0.05, slide: 50 });
  }

  cashout(big = false) {
    const notes = big ? [784, 988, 1175, 1568, 1976] : [880, 1320, 1760];
    notes.forEach((f, i) => this._tone(f, 0.22, { type: 'triangle', vol: 0.16, when: i * 0.065 }));
    this._noise(0.25, { vol: 0.08, from: 6000, to: 3000, type: 'highpass', when: 0.05 });
  }

  coin() {
    this._tone(988, 0.1, { type: 'square', vol: 0.06 });
    this._tone(1319, 0.3, { type: 'square', vol: 0.06, when: 0.08 });
  }

  lose() {
    this._tone(330, 0.3, { type: 'sawtooth', vol: 0.05, slide: 150 });
  }

  message() {
    this._tone(1400, 0.06, { type: 'sine', vol: 0.05 });
  }

  // ───────── Efectos de los demás juegos ─────────

  /** Clic suave de interfaz (fichas, selección). */
  click(pitch = 1) {
    this._tone(900 * pitch, 0.04, { type: 'triangle', vol: 0.07 });
  }

  /** Ficha apoyada en la mesa. */
  chip() {
    this._noise(0.05, { vol: 0.18, from: 5200, to: 2400, type: 'bandpass', q: 3 });
    this._tone(2100, 0.035, { type: 'sine', vol: 0.04 });
  }

  /** Diamante encontrado: cada vez un poco más agudo. */
  gem(step = 0) {
    const base = 660 * Math.pow(1.06, Math.min(step, 20));
    this._tone(base, 0.12, { type: 'triangle', vol: 0.13 });
    this._tone(base * 1.5, 0.18, { type: 'sine', vol: 0.09, when: 0.05 });
    this._noise(0.12, { vol: 0.04, from: 9000, to: 5000, type: 'highpass', when: 0.03 });
  }

  /** Explosión corta (mina). */
  boom() {
    this._noise(0.9, { vol: 0.8, from: 2600, to: 50 });
    this._tone(70, 0.6, { type: 'sine', vol: 0.45, slide: 30 });
    this._tone(140, 0.25, { type: 'square', vol: 0.05, slide: 45 });
  }

  /** Patada a la pelota. */
  kick() {
    this._noise(0.08, { vol: 0.5, from: 1800, to: 200 });
    this._tone(150, 0.12, { type: 'sine', vol: 0.35, slide: 70 });
  }

  /** ¡Gol! Hinchada festejando. */
  goal() {
    this._noise(1.6, { vol: 0.28, from: 900, to: 2600, type: 'bandpass', q: 0.6 });
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.25, { type: 'triangle', vol: 0.12, when: 0.05 + i * 0.08 }));
  }

  /** Atajada: pelota contra los guantes y un "uhh" de la tribuna. */
  save() {
    this._noise(0.1, { vol: 0.45, from: 1200, to: 150 });
    this._noise(0.9, { vol: 0.16, from: 700, to: 300, type: 'bandpass', q: 0.8, when: 0.08 });
    this._tone(300, 0.45, { type: 'sawtooth', vol: 0.04, slide: 160, when: 0.05 });
  }

  /** Silbato del árbitro. */
  whistle() {
    this._tone(2600, 0.16, { type: 'sine', vol: 0.08 });
    this._tone(2750, 0.22, { type: 'sine', vol: 0.07, when: 0.18 });
  }

  /** Rebote en un clavo del Plinko. */
  peg(i = 0) {
    this._tone(1200 + (i % 8) * 90, 0.03, { type: 'sine', vol: 0.035 });
  }

  /** La bolita cae en una casilla: más festivo cuanto mayor el multiplicador. */
  land(m100 = 100) {
    if (m100 >= 1000) this.cashout(true);
    else if (m100 >= 200) this.cashout(false);
    else if (m100 >= 100) this._tone(740, 0.12, { type: 'triangle', vol: 0.1 });
    else this._tone(330, 0.14, { type: 'triangle', vol: 0.07, slide: 260 });
  }

  /** "Tic" de la rueda al pasar cada casilla. */
  wheelTick() {
    this._tone(1500, 0.018, { type: 'square', vol: 0.02 });
  }

  /** Bolita de la ruleta rodando (dura `seconds`). */
  rouletteBall(seconds = 4) {
    this._noise(seconds, { vol: 0.07, from: 3800, to: 900, type: 'bandpass', q: 2.5 });
  }

  /** Premio (genérico). */
  win(big = false) {
    this.cashout(big);
  }
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* modo privado */
  }
}
