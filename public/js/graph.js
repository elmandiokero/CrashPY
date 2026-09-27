// Animación del juego en <canvas>: fondo espacial, curva, cohete, estela, explosión y marcas de retiro.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FIRE = ['#fff6c9', '#ffd84d', '#ffab3d', '#ff6a2b', '#ff3b4e'];
const FLAG = ['#ffffff', '#d52b1e', '#0038a8', '#c8d1ec'];
const CONFETTI = ['#ff3b4e', '#ffffff', '#3d7bff', '#ffc53d', '#2bd96b', '#ff4fa8'];

export class CrashGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.s = 1;
    this.stars = [];
    this.parts = [];
    this.rings = [];
    this.markers = [];
    this.speed = 0.02;
    this.shakeUntil = 0;
    this.shakePower = 0;
    this.last = performance.now();
    this.rocket = null;
    this.bg = null;
    this.lastScale = { xMax: 8000, yMax: 1.8 };
    this.font = 'Rubik, system-ui, sans-serif';
    this._resize();
    if ('ResizeObserver' in window) new ResizeObserver(() => this._resize()).observe(canvas);
    else window.addEventListener('resize', () => this._resize());
    for (let i = 0; i < 120; i++) this.stars.push(this._star(true));
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.s = clamp(Math.min(w, h * 1.6) / 560, 0.68, 1.3);
    this.pad = { l: 44 * clamp(this.s, 0.85, 1.1), r: 22, t: 38, b: 28 };
    this._buildBackground();
  }

  _buildBackground() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.scale(this.dpr, this.dpr);
    const grad = g.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, '#0b1033');
    grad.addColorStop(0.6, '#070a1d');
    grad.addColorStop(1, '#04060f');
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);
    const blob = (x, y, r, color) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, this.w, this.h);
    };
    blob(this.w * 0.85, this.h * 0.1, this.w * 0.55, 'rgba(213,43,30,0.20)');
    blob(this.w * 0.1, this.h * 0.95, this.w * 0.6, 'rgba(0,56,168,0.28)');
    blob(this.w * 0.5, this.h * 0.45, this.w * 0.35, 'rgba(120,80,255,0.06)');
    this.bg = c;
  }

  _star(initial) {
    return {
      x: Math.random(),
      y: initial ? Math.random() : -0.02,
      z: rand(0.25, 1),
      tw: Math.random() * TAU,
    };
  }

  // ───────── API para app.js ─────────

  /** Explosión en la posición actual del cohete. */
  explode(big = true) {
    const r = this.rocket || { x: this.pad.l + 30, y: this.h - this.pad.b - 10 };
    const s = this.s;
    const n = big ? 70 : 40;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = rand(0.04, 0.36) * s;
      this.parts.push({
        kind: 'fire', x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(450, 1100), age: 0, size: rand(3, 8) * s, color: FIRE[(Math.random() * FIRE.length) | 0], drag: 0.986,
      });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * TAU;
      const sp = rand(0.01, 0.08) * s;
      this.parts.push({
        kind: 'smoke', x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.01,
        life: rand(900, 1900), age: 0, size: rand(8, 16) * s, grow: 0.018 * s, drag: 0.99,
      });
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * TAU;
      const sp = rand(0.12, 0.42) * s;
      this.parts.push({
        kind: 'debris', x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.1 * s,
        life: rand(1300, 2200), age: 0, w: rand(3, 7) * s, h: rand(2, 4) * s, rot: Math.random() * TAU, vr: rand(-0.02, 0.02),
        color: FLAG[(Math.random() * FLAG.length) | 0], gravity: 0.00055 * s, drag: 0.995,
      });
    }
    this.rings.push({ x: r.x, y: r.y, age: 0, life: 560, max: 120 * s });
    this.rings.push({ x: r.x, y: r.y, age: -90, life: 700, max: 170 * s });
    this.shakeUntil = performance.now() + 520;
    this.shakePower = 9 * s;
    this.rocket = null;
  }

  /** Lluvia de papelitos para ganancias grandes. */
  confetti() {
    for (let i = 0; i < 90; i++) {
      this.parts.push({
        kind: 'debris', x: rand(0.2, 0.8) * this.w, y: rand(-40, -5), vx: rand(-0.12, 0.12), vy: rand(0.02, 0.2),
        life: rand(2200, 3400), age: 0, w: rand(5, 9), h: rand(3, 5), rot: Math.random() * TAU, vr: rand(-0.015, 0.015),
        color: CONFETTI[(Math.random() * CONFETTI.length) | 0], gravity: 0.00018, drag: 0.996,
      });
    }
  }

  /** Marca un retiro sobre la curva. t = ms de vuelo, m = centésimas. */
  addMarker(t, m, label, own = false) {
    this.markers.push({ t, m, label, own, born: performance.now() });
    if (this.markers.length > 14) this.markers.shift();
  }

  clearRound() {
    this.markers = [];
    this.rocket = null;
  }

  // ───────── Dibujo ─────────

  /**
   * view = { phase, elapsed, crashElapsed, crashM, growth, cancelled, bettingFrac }
   */
  frame(view) {
    const now = performance.now();
    const dt = clamp(now - this.last, 0, 60);
    this.last = now;
    const ctx = this.ctx;
    const { w, h, s } = this;
    const pad = this.pad;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const baseY = pad.t + plotH;

    let shakeX = 0;
    let shakeY = 0;
    if (now < this.shakeUntil) {
      const k = (this.shakeUntil - now) / 520;
      shakeX = rand(-1, 1) * this.shakePower * k;
      shakeY = rand(-1, 1) * this.shakePower * k;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, shakeX * this.dpr, shakeY * this.dpr);
    ctx.clearRect(-20, -20, w + 40, h + 40);
    if (this.bg) ctx.drawImage(this.bg, 0, 0, w, h);

    // Escala y estado de la curva
    const phase = view.phase;
    let tMs = 0;
    let m = 1;
    let showCurve = false;
    if (phase === 'RUNNING') {
      tMs = Math.max(0, view.elapsed);
      m = Math.exp(view.growth * tMs);
      showCurve = true;
    } else if (phase === 'CRASHED') {
      tMs = Math.max(0, view.crashElapsed || 0);
      m = Math.max(1, (view.crashM || 100) / 100);
      showCurve = tMs > 0;
    }
    const scale = showCurve
      ? { xMax: Math.max(8000, tMs / 0.8), yMax: Math.max(1.8, 1 + (m - 1) / 0.72) }
      : { xMax: 8000, yMax: 1.8 };
    this.lastScale = scale;
    const toX = (t) => pad.l + (t / scale.xMax) * plotW;
    const toY = (mm) => baseY - ((mm - 1) / (scale.yMax - 1)) * plotH;

    // Estrellas (velocidad según el multiplicador)
    let target = 0.012;
    if (phase === 'RUNNING') target = 0.05 + 0.16 * Math.min(4, Math.log(m));
    if (phase === 'BETTING') target = 0.018;
    this.speed += (target - this.speed) * Math.min(1, dt / 500);
    this._drawStars(dt, now);

    // Grilla y ejes
    this._drawGrid(scale, toX, toY, baseY, plotW);

    // Curva
    if (showCurve) {
      const crashed = phase === 'CRASHED';
      const N = 90;
      const g = view.growth;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = (tMs * i) / N;
        pts.push([toX(t), toY(Math.min(m, Math.exp(g * t)))]);
      }
      const tip = pts[pts.length - 1];
      // Área bajo la curva
      const area = ctx.createLinearGradient(0, tip[1], 0, baseY);
      area.addColorStop(0, crashed ? 'rgba(255,59,78,0.12)' : 'rgba(255,59,78,0.22)');
      area.addColorStop(1, 'rgba(61,123,255,0.02)');
      ctx.beginPath();
      ctx.moveTo(pts[0][0], baseY);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(tip[0], baseY);
      ctx.closePath();
      ctx.fillStyle = area;
      ctx.fill();
      // Línea (resplandor + trazo)
      let stroke;
      if (crashed) {
        stroke = 'rgba(255,70,90,0.85)';
      } else {
        stroke = ctx.createLinearGradient(pts[0][0], 0, Math.max(pts[0][0] + 1, tip[0]), 0);
        stroke.addColorStop(0, '#3d7bff');
        stroke.addColorStop(0.55, '#ffffff');
        stroke.addColorStop(1, '#ff3b4e');
      }
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.strokeStyle = stroke;
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 11 * s;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4.2 * s;
      ctx.stroke();

      // Marcas de retiros
      this._drawMarkers(now, tMs, toX, toY);

      if (!crashed) {
        // Posición y ángulo del cohete siguiendo la tangente
        const back = Math.max(0, tMs - scale.xMax * 0.02);
        const bx = toX(back);
        const by = toY(Math.exp(g * back));
        let angle = Math.atan2(tip[1] - by, tip[0] - bx);
        if (!Number.isFinite(angle) || tMs < 50) angle = -0.12;
        angle = clamp(angle, -1.35, 0) + Math.sin(now / 110) * 0.03;
        this.rocket = { x: tip[0], y: tip[1], a: angle };
        this._emitExhaust(dt, s);
        this._glow(tip[0], tip[1], s);
      }
    } else if (phase === 'BETTING' || phase === 'PAUSED' || phase === 'CONNECTING') {
      // Cohete en la plataforma
      const x = pad.l + 26 * s;
      const y = baseY - 12 * s + Math.sin(now / 260) * 1.6;
      this.rocket = { x, y, a: -0.35 + Math.sin(now / 700) * 0.02 };
      this._drawPad(x, baseY, s, phase === 'BETTING');
      if (phase === 'BETTING' && Math.random() < dt / 90) this._puff(x, y, s);
    } else if (phase === 'CRASHED') {
      this.rocket = null;
    }

    // Partículas debajo del cohete
    this._drawParticles(dt);

    if (this.rocket && phase !== 'CRASHED') {
      this._drawRocket(this.rocket.x, this.rocket.y, this.rocket.a, s * (phase === 'RUNNING' ? 1 : 0.95), phase === 'RUNNING', now);
    }

    this._drawRings(dt);
  }

  _drawStars(dt, now) {
    const ctx = this.ctx;
    const { w, h, s } = this;
    const sp = this.speed;
    const streak = sp > 0.22;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    for (const st of this.stars) {
      st.x -= sp * st.z * (dt / 1000);
      st.y += sp * st.z * 0.55 * (dt / 1000);
      if (st.x < -0.02 || st.y > 1.02) {
        if (Math.random() < 0.6) {
          st.x = 1.02;
          st.y = Math.random();
        } else {
          st.x = Math.random();
          st.y = -0.02;
        }
        st.z = rand(0.25, 1);
      }
      const x = st.x * w;
      const y = st.y * h;
      const alpha = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 600 + st.tw))) * st.z;
      ctx.globalAlpha = streak ? alpha * 0.55 : alpha;
      if (streak) {
        const len = Math.min(50, sp * st.z * 120) * s;
        ctx.lineWidth = st.z * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y - len * 0.55);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, st.z * 1.3 * s, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _niceStep(range, maxTicks, steps) {
    for (const st of steps) if (range / st <= maxTicks) return st;
    return steps[steps.length - 1];
  }

  _drawGrid(scale, toX, toY, baseY, plotW) {
    const ctx = this.ctx;
    const pad = this.pad;
    const fs = Math.round(10.5 * clamp(this.s, 0.9, 1.15));
    ctx.save();
    ctx.font = `600 ${fs}px ${this.font}`;
    ctx.fillStyle = 'rgba(160,170,215,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    // Eje Y (multiplicador)
    const ySteps = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000, 100000, 1e6, 1e7];
    const yStep = this._niceStep(scale.yMax - 1, 4, ySteps);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Valores "redondos": 1.2x, 1.4x… o 2x, 4x, 20x, 40x…
    const yStart = yStep < 1 ? 1 + yStep : Math.max(yStep, Math.ceil(1.0001 / yStep) * yStep);
    for (let v = yStart; v < scale.yMax; v += yStep) {
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
      const label = v >= 100 ? `${Math.round(v)}x` : v >= 10 ? `${v.toFixed(0)}x` : `${v.toFixed(1)}x`;
      ctx.fillText(label, pad.l - 7, y);
    }
    // Eje X (segundos)
    const xSteps = [2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 1200, 3600];
    const xStep = this._niceStep(scale.xMax / 1000, 5, xSteps);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let sec = xStep; sec * 1000 < scale.xMax; sec += xStep) {
      const x = toX(sec * 1000);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, baseY);
      ctx.stroke();
      ctx.fillText(sec >= 60 && sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`, x, baseY + 8);
    }
    ctx.setLineDash([]);
    // Ejes principales
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t - 6);
    ctx.lineTo(pad.l, baseY);
    ctx.lineTo(pad.l + plotW, baseY);
    ctx.stroke();
    ctx.restore();
  }

  _drawMarkers(now, tMs, toX, toY) {
    const ctx = this.ctx;
    const s = this.s;
    ctx.save();
    ctx.font = `700 ${Math.round(11 * clamp(s, 0.9, 1.15))}px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.markers = this.markers.filter((mk) => now - mk.born < (mk.own ? 5000 : 3400));
    for (const mk of this.markers) {
      if (mk.t > tMs + 50) continue;
      const age = now - mk.born;
      const ttl = mk.own ? 5000 : 3400;
      const alpha = Math.min(1, age / 160) * Math.min(1, (ttl - age) / 600);
      const x = toX(mk.t);
      const y = toY(mk.m / 100);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = mk.own ? '#2bd96b' : '#ffc53d';
      ctx.beginPath();
      ctx.arc(x, y, (mk.own ? 5.5 : 4) * s, 0, TAU);
      ctx.fill();
      if (mk.own) {
        // Tu retiro: anillo verde que se expande (el monto ya se muestra grande en pantalla)
        const k = Math.min(1, age / 900);
        ctx.strokeStyle = '#2bd96b';
        ctx.lineWidth = 2.5 * s * (1 - k) + 0.5;
        ctx.globalAlpha = alpha * (1 - k * 0.7);
        ctx.beginPath();
        ctx.arc(x, y, (6 + k * 18) * s, 0, TAU);
        ctx.stroke();
        continue;
      }
      const ly = y - (18 + age * 0.006) * s;
      const tw = ctx.measureText(mk.label).width + 14;
      const th = 20 * clamp(s, 0.9, 1.1);
      ctx.fillStyle = mk.own ? 'rgba(10,60,30,0.85)' : 'rgba(8,10,24,0.78)';
      ctx.strokeStyle = mk.own ? 'rgba(43,217,107,0.9)' : 'rgba(255,197,61,0.55)';
      ctx.lineWidth = 1;
      this._roundRect(x - tw / 2, ly - th / 2, tw, th, th / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = mk.own ? '#bfffd6' : '#ffe7a8';
      ctx.fillText(mk.label, x, ly + 0.5);
    }
    ctx.restore();
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _glow(x, y, s) {
    const ctx = this.ctx;
    const r = 70 * s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,140,90,0.22)');
    g.addColorStop(1, 'rgba(255,140,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  _drawPad(x, baseY, s, active) {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(x, baseY, 0, x, baseY, 46 * s);
    g.addColorStop(0, active ? 'rgba(255,197,61,0.35)' : 'rgba(120,140,220,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, baseY, 46 * s, 12 * s, 0, 0, TAU);
    ctx.fill();
  }

  _puff(x, y, s) {
    this.parts.push({
      kind: 'smoke', x: x - 16 * s, y: y + 6 * s, vx: rand(-0.03, -0.01), vy: rand(-0.01, 0.01),
      life: rand(700, 1300), age: 0, size: rand(3, 6) * s, grow: 0.01 * s, drag: 0.99,
    });
  }

  _emitExhaust(dt, s) {
    const r = this.rocket;
    if (!r) return;
    const cos = Math.cos(r.a);
    const sin = Math.sin(r.a);
    const tx = r.x - cos * 20 * s;
    const ty = r.y - sin * 20 * s;
    const count = Math.min(6, Math.floor(dt / 14) + (Math.random() < 0.5 ? 1 : 0));
    for (let i = 0; i < count; i++) {
      const sp = rand(0.04, 0.12) * s;
      const jitter = rand(-0.035, 0.035) * s;
      this.parts.push({
        kind: 'exhaust', x: tx + rand(-2, 2), y: ty + rand(-2, 2),
        vx: -cos * sp - sin * jitter, vy: -sin * sp + cos * jitter,
        life: rand(320, 720), age: 0, size: rand(2, 3.8) * s, drag: 0.985,
      });
    }
    if (this.parts.length > 520) this.parts.splice(0, this.parts.length - 520);
  }

  _drawParticles(dt) {
    const ctx = this.ctx;
    const alive = [];
    ctx.save();
    for (const p of this.parts) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      const drag = Math.pow(p.drag || 1, dt / 16);
      p.vx *= drag;
      p.vy *= drag;
      if (p.gravity) p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      alive.push(p);
      if (p.kind === 'exhaust') {
        const size = p.size * (1 + k * 2.4);
        ctx.globalCompositeOperation = k < 0.45 ? 'lighter' : 'source-over';
        ctx.globalAlpha = (1 - k) * (k < 0.45 ? 0.9 : 0.35);
        ctx.fillStyle = k < 0.15 ? '#fff4c2' : k < 0.3 ? '#ffc23d' : k < 0.45 ? '#ff6a2b' : '#7a7f99';
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'fire') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (1 - k) * 0.95;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, TAU);
        ctx.fill();
      } else if (p.kind === 'smoke') {
        ctx.globalCompositeOperation = 'source-over';
        p.size += (p.grow || 0) * dt;
        ctx.globalAlpha = (1 - k) * 0.28;
        ctx.fillStyle = '#8a90aa';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'debris') {
        ctx.globalCompositeOperation = 'source-over';
        p.rot += p.vr * dt;
        ctx.globalAlpha = Math.min(1, (1 - k) * 2.2);
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    ctx.restore();
    this.parts = alive;
  }

  _drawRings(dt) {
    const ctx = this.ctx;
    ctx.save();
    this.rings = this.rings.filter((r) => {
      r.age += dt;
      if (r.age < 0) return true;
      if (r.age >= r.life) return false;
      const k = r.age / r.life;
      const ease = 1 - Math.pow(1 - k, 3);
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = '#ffc98a';
      ctx.lineWidth = Math.max(0.5, 7 * (1 - k)) * this.s;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 4 + ease * r.max, 0, TAU);
      ctx.stroke();
      return true;
    });
    ctx.restore();
  }

  _drawRocket(x, y, a, s, flying, now) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.scale(s, s);
    // Llama
    const flicker = flying ? 20 + Math.sin(now / 40) * 4 + Math.random() * 7 : 7 + Math.random() * 3;
    const fg = ctx.createLinearGradient(-15, 0, -15 - flicker, 0);
    fg.addColorStop(0, 'rgba(255,250,215,1)');
    fg.addColorStop(0.3, 'rgba(255,200,70,0.95)');
    fg.addColorStop(0.7, 'rgba(255,100,40,0.7)');
    fg.addColorStop(1, 'rgba(255,50,60,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-14, -5.5);
    ctx.quadraticCurveTo(-15 - flicker * 1.1, 0, -14, 5.5);
    ctx.closePath();
    ctx.fill();
    // Aletas
    ctx.fillStyle = '#d52b1e';
    ctx.beginPath();
    ctx.moveTo(-10, -7);
    ctx.lineTo(-19, -16);
    ctx.lineTo(-3, -7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0038a8';
    ctx.beginPath();
    ctx.moveTo(-10, 7);
    ctx.lineTo(-19, 16);
    ctx.lineTo(-3, 7);
    ctx.closePath();
    ctx.fill();
    // Cuerpo
    const bg = ctx.createLinearGradient(0, -8, 0, 8);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(1, '#bfc9e8');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(-15, -7.5);
    ctx.lineTo(8, -7.5);
    ctx.quadraticCurveTo(22, -6.5, 27, 0);
    ctx.quadraticCurveTo(22, 6.5, 8, 7.5);
    ctx.lineTo(-15, 7.5);
    ctx.closePath();
    ctx.fill();
    // Punta roja
    ctx.fillStyle = '#e0302a';
    ctx.beginPath();
    ctx.moveTo(15, -6.6);
    ctx.quadraticCurveTo(22, -5.4, 27, 0);
    ctx.quadraticCurveTo(22, 5.4, 15, 6.6);
    ctx.closePath();
    ctx.fill();
    // Franjas de la bandera
    ctx.fillStyle = '#d52b1e';
    ctx.fillRect(-13, -7.5, 3.2, 15);
    ctx.fillStyle = '#0038a8';
    ctx.fillRect(-6.6, -7.5, 3.2, 15);
    // Ventanilla
    ctx.fillStyle = '#86d8ff';
    ctx.strokeStyle = '#0038a8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(4.5, 0, 4.2, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(3.3, -1.3, 1.3, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
