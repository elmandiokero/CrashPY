// 🔴 Plinko: soltás bolitas sobre una pirámide de clavos. En cada fila la bolita rebota a la
// izquierda o a la derecha (el camino ya lo decidió el servidor con tus semillas) y termina en una
// casilla que paga su multiplicador. Se pueden tirar muchas bolitas a la vez y hay modo automático.
import { h, fmtGs, fmtMult, toast } from '../shared.js';
import {
  core,
  store,
  AmountControl,
  actionButton,
  segmented,
  winPop,
  confetti,
  pausedNotice,
  loadPlays,
  openPlay,
  setText,
  vibrate,
  resultOverlay,
  panelHead,
  isBigWin,
  reducedMotion,
} from './common.js';

const ROWS = core.PLINKO_ROWS; // [8, 10, 12, 14, 16]
const RISKS = core.PLINKO_RISKS; // ['low', 'medium', 'high']
const RISK_NAMES = { low: 'Bajo', medium: 'Medio', high: 'Alto' };
const AUTO_COUNTS = [10, 25, 50, 100];
const MAX_BALLS = 30; // bolitas animándose a la vez (si hay más, la más vieja cae al instante)
const MIN_GAP_MS = 150; // entre bolitas soltadas a mano
const AUTO_GAP_MS = 350; // entre bolitas del modo automático
const MAX_PENDING = 3; // pedidos al servidor todavía sin respuesta
const HISTORY = 8; // últimos resultados que se muestran

// Animación (milisegundos)
const PEG_GLOW_MS = 300;
const BUCKET_MS = 700;
const FADE_MS = 220;
const FLOAT_MS = 1100;
const TRAIL = [
  { dt: 16, a: 0.3, r: 0.84 },
  { dt: 32, a: 0.17, r: 0.68 },
  { dt: 48, a: 0.08, r: 0.54 },
];

const TAU = Math.PI * 2;
const FONT = "Rubik, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

// Colores de las casillas: amarillo en el centro → naranja → rojo en los bordes
const HEAT = [
  [255, 214, 72],
  [255, 140, 52],
  [255, 58, 80],
];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const mix = (c, d, f) => c.map((v, i) => Math.round(v + (d[i] - v) * f));
const rgb = (c, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

function heat(t) {
  const x = clamp(t, 0, 1) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  return mix(HEAT[i], HEAT[i + 1], x - i);
}

/** "Gs. 1.450" sin que el renglón se corte entre "Gs." y el número. */
const gsNb = (n) => fmtGs(n).replace(' ', ' ');

/** Qué tan "al borde" está una casilla (0 = centro, 1 = borde). */
const edgeOf = (bucket, rows) => Math.abs(bucket - rows / 2) / (rows / 2);

/** Multiplicador corto y exacto para las casillas: 987 · 25.6 · 1.37 · 0.49 (nunca 0.98 → "1"). */
function multLabel(m100) {
  const v = m100 / 100;
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 100) / 100);
}

const TOP_MULT = Math.max(...ROWS.flatMap((r) => RISKS.map((k) => Math.max(...core.PLINKO[r][k]))));

function roundRect(x, px, py, w, hh, r) {
  const rr = Math.max(0, Math.min(r, w / 2, hh / 2));
  x.beginPath();
  x.moveTo(px + rr, py);
  x.arcTo(px + w, py, px + w, py + hh, rr);
  x.arcTo(px + w, py + hh, px, py + hh, rr);
  x.arcTo(px, py + hh, px, py, rr);
  x.arcTo(px, py, px + w, py, rr);
  x.closePath();
}

function makeCanvas(w, hh, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * dpr));
  c.height = Math.max(1, Math.ceil(hh * dpr));
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, x };
}

// ═══════════════════════════ Tablero (canvas) ═══════════════════════════

/**
 * Dibuja la pirámide y anima las bolitas. La fila r (desde 0) tiene r + 3 clavos; la bolita
 * arranca arriba del centro, en cada fila se corre medio espacio a la izquierda o a la derecha
 * según el camino del servidor y al final cae en la casilla = cantidad de "derechas".
 */
class PlinkoBoard {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.wrap = canvas.parentElement;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers; // { onPeg(ball, row, late), onLand(ball, quiet) }
    this.rows = 0;
    this.table = [];
    this.balls = [];
    this.floats = [];
    this.g = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.layer = null;
    this.halo = null;
    this.ballSprite = null;
    this.buckets = [];
    this.pegHit = new Float64Array(0);
    this.bucketHit = new Float64Array(0);
    this.animUntil = 0;
    this.raf = 0;
    this.enabled = false;
    this.reduced = false;
    this.pt = { x: 0, y: 0 };
    this.tick = (now) => this._tick(now);
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(this.wrap);
    else window.addEventListener('resize', () => this.resize());
  }

  // ───────── Tamaño y armado ─────────

  setTable(rows, risk) {
    const rowsChanged = rows !== this.rows;
    this.rows = rows;
    this.table = core.PLINKO[rows][risk];
    if (rowsChanged) this.layout();
    else this.buildBuckets();
    this.redraw();
  }

  resize() {
    const w = this.wrap.clientWidth;
    const hh = this.wrap.clientHeight;
    if (w < 40 || hh < 40) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && hh === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = hh;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hh * dpr);
    this.layout();
    this.redraw();
  }

  layout() {
    if (!this.w || !this.rows) return;
    const R = this.rows;
    const W = this.w;
    const H = this.h;
    // Proporciones en unidades de "s" (distancia horizontal entre clavos)
    const kTop = 1.15; // lugar para la caída inicial
    const kRow = 0.9; // distancia vertical entre filas
    const kGap = 0.62; // última fila → casillas
    const kBucket = 0.8; // alto de las casillas
    const bottom = 9; // lugar para el rebote de las casillas
    const padX = clamp(W * 0.012, 3, 10);
    const kH = kTop + (R - 1) * kRow + kGap + kBucket;
    const s = Math.max(6, Math.min((W - padX * 2) / (R + 1), (H - bottom - 4) / kH));
    const vs = s * kRow;
    const top = Math.max(2, (H - bottom - s * kH) / 2);
    const row0 = top + s * kTop;
    const cx = W / 2;
    const pr = clamp(s * 0.12, 1.8, 5);
    const br = clamp(s * 0.27, 3.4, 11);
    const gap = clamp(s * 0.1, 1.5, 5);
    const pegs = [];
    const rowStart = [];
    for (let r = 0; r < R; r++) {
      rowStart.push(pegs.length);
      for (let j = 0; j < r + 3; j++) pegs.push({ x: cx + ((2 * j - r - 2) * s) / 2, y: row0 + r * vs });
    }
    this.g = {
      R,
      s,
      vs,
      cx,
      row0,
      pr,
      br,
      pegs,
      rowStart,
      contact: (pr + br) * 0.92,
      spawnY: row0 - s * 0.85,
      bucketY: row0 + (R - 1) * vs + s * kGap,
      bh: Math.max(12, s * kBucket),
      bw: s - gap,
    };
    this.pegHit = new Float64Array(pegs.length).fill(-1e9);
    this.bucketHit = new Float64Array(R + 1).fill(-1e9);
    this.buildLayer();
    this.buildSprites();
    this.buildBuckets();
  }

  /** Capa fija: brillo de fondo y clavos (se dibuja una sola vez por tamaño). */
  buildLayer() {
    const { w, h: hh, dpr, g } = this;
    const { c, x } = makeCanvas(w, hh, dpr);
    const span = (g.R + 1) * g.s;
    const midY = g.row0 + (g.R - 1) * g.vs * 0.55;
    const glow = (gx, gy, r, color) => {
      const gr = x.createRadialGradient(gx, gy, 0, gx, gy, r);
      gr.addColorStop(0, color);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gr;
      x.fillRect(0, 0, w, hh);
    };
    glow(g.cx, midY, span * 0.62, 'rgba(92, 112, 255, 0.11)');
    glow(g.cx, g.bucketY + g.bh * 0.5, span * 0.55, 'rgba(255, 96, 64, 0.1)');
    // Clavos
    x.shadowColor = 'rgba(160, 180, 255, 0.65)';
    x.shadowBlur = g.pr * 2.4;
    x.fillStyle = '#e3e8ff';
    x.beginPath();
    for (const p of g.pegs) {
      x.moveTo(p.x + g.pr, p.y);
      x.arc(p.x, p.y, g.pr, 0, TAU);
    }
    x.fill();
    this.layer = c;
  }

  /** Bolita y brillo de los clavos, pre-dibujados. */
  buildSprites() {
    const { g, dpr } = this;
    const size = g.br * 5;
    const b = makeCanvas(size, size, dpr);
    const c0 = size / 2;
    b.x.shadowColor = 'rgba(255, 59, 78, 0.8)';
    b.x.shadowBlur = g.br * 1.4;
    const gr = b.x.createRadialGradient(c0 - g.br * 0.35, c0 - g.br * 0.4, g.br * 0.08, c0, c0, g.br);
    gr.addColorStop(0, '#fff4f5');
    gr.addColorStop(0.3, '#ff8f9a');
    gr.addColorStop(0.68, '#ff3b4e');
    gr.addColorStop(1, '#b0102a');
    b.x.fillStyle = gr;
    b.x.beginPath();
    b.x.arc(c0, c0, g.br, 0, TAU);
    b.x.fill();
    this.ballSprite = { c: b.c, size };

    const hs = Math.max(14, g.pr * 9);
    const hl = makeCanvas(hs, hs, dpr);
    const hg = hl.x.createRadialGradient(hs / 2, hs / 2, 0, hs / 2, hs / 2, hs / 2);
    hg.addColorStop(0, 'rgba(255, 255, 255, 1)');
    hg.addColorStop(0.2, 'rgba(255, 236, 240, 0.95)');
    hg.addColorStop(0.45, 'rgba(255, 120, 140, 0.38)');
    hg.addColorStop(1, 'rgba(255, 59, 78, 0)');
    hl.x.fillStyle = hg;
    hl.x.fillRect(0, 0, hs, hs);
    this.halo = { c: hl.c, size: hs };
  }

  /** Casillas con su multiplicador (normal e iluminada), con la misma letra para todas. */
  buildBuckets() {
    const { g, dpr } = this;
    if (!g || this.table.length !== g.R + 1) return;
    const labels = this.table.map(multLabel);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `800 100px ${FONT}`;
    const emOf = (list) => Math.max(...list.map((t) => ctx.measureText(t).width / 100));
    const emX = emOf(labels.map((t) => t + 'x'));
    const emN = emOf(labels);
    ctx.restore();
    const avail = g.bw - 3;
    const maxFont = clamp(g.s * 0.5, 7.5, 14);
    // Letra un poco más angosta antes que más chica (hasta 80% si no queda otra)
    const fit = (em) => {
      const f = Math.min(maxFont, avail / em / 0.88);
      return f >= 9 ? f : Math.min(maxFont, avail / em / 0.8);
    };
    const fontN = fit(emN);
    const fontX = fit(emX);
    // Con "x" solo si se sigue leyendo bien
    const withX = fontX >= Math.max(10, fontN * 0.8);
    const em = withX ? emX : emN;
    const font = Math.max(6, withX ? fontX : fontN);
    const scaleX = Math.min(1, avail / (em * font));
    this.buckets = this.table.map((m, k) => {
      const col = heat(edgeOf(k, g.R));
      const text = withX ? labels[k] + 'x' : labels[k];
      return { col, normal: this.bucketSprite(col, text, font, scaleX, false, dpr), lit: this.bucketSprite(col, text, font, scaleX, true, dpr) };
    });
  }

  bucketSprite(col, text, font, scaleX, lit, dpr) {
    const { bw, bh } = this.g;
    const pad = Math.ceil(bh * 0.9);
    const cw = bw + pad * 2;
    const ch = bh + pad * 2;
    const { c, x } = makeCanvas(cw, ch, dpr);
    const r = Math.min(bw * 0.24, bh * 0.3, 7);
    const lip = Math.max(2, Math.round(bh * 0.14));
    if (lit) {
      x.shadowColor = rgb(col, 0.95);
      x.shadowBlur = bh * 0.9;
    }
    x.fillStyle = rgb(mix(col, BLACK, 0.42));
    roundRect(x, pad, pad + lip, bw, bh - lip, r);
    x.fill();
    x.shadowBlur = 0;
    x.shadowColor = 'rgba(0,0,0,0)';
    const gr = x.createLinearGradient(0, pad, 0, pad + bh - lip);
    gr.addColorStop(0, rgb(mix(col, WHITE, lit ? 0.6 : 0.3)));
    gr.addColorStop(1, rgb(lit ? mix(col, WHITE, 0.22) : col));
    x.fillStyle = gr;
    roundRect(x, pad, pad, bw, bh - lip, r);
    x.fill();
    x.fillStyle = 'rgba(38, 12, 0, 0.92)';
    x.font = `800 ${font}px ${FONT}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.save();
    x.translate(pad + bw / 2, pad + (bh - lip) / 2 + font * 0.07);
    x.scale(scaleX, 1);
    x.fillText(text, 0, 0);
    x.restore();
    return { c, pad, cw, ch };
  }

  // ───────── Bolitas ─────────

  /** Agrega una bolita con su recorrido (tiempos y pequeñas variaciones para que se vea natural). */
  addBall(ball) {
    const p = ball.play;
    const R = p.path.length;
    const now = performance.now();
    const fast = this.reduced;
    const base = fast ? 55 : rand(116, 132);
    const ends = new Float64Array(R + 1);
    let acc = fast ? 80 : rand(185, 215);
    ends[0] = acc;
    for (let r = 1; r < R; r++) {
      acc += base * (fast ? 1 : rand(0.93, 1.07));
      ends[r] = acc;
    }
    acc += base * (fast ? 1.1 : 1.3);
    ends[R] = acc;
    const m = new Int8Array(R + 1);
    const off = new Float32Array(R);
    const hop = new Float32Array(R + 1);
    for (let r = 0; r < R; r++) {
      const d = p.path[r] ? 1 : -1;
      m[r + 1] = m[r] + d;
      off[r] = fast ? 0 : d * rand(0.04, 0.11);
    }
    for (let r = 1; r <= R; r++) hop[r] = fast ? 0 : r === R ? rand(0.8, 1.1) : rand(1.35, 1.95);
    Object.assign(ball, { R, k: p.bucket, t0: now, ends, total: acc, m, off, hop, dx0: fast ? 0 : rand(-0.04, 0.04), seg: 0, done: false, landedAt: 0 });
    let flying = 0;
    for (const b of this.balls) if (!b.done) flying++;
    if (flying >= MAX_BALLS) {
      const old = this.balls.find((b) => !b.done);
      if (old) this.land(old, now, true);
    }
    this.balls.push(ball);
    this.start();
  }

  flying() {
    let n = 0;
    for (const b of this.balls) if (!b.done) n++;
    return n;
  }

  /** Saca todas las bolitas que todavía caen (para terminarlas al instante). */
  takeFlying() {
    const list = this.balls.filter((b) => !b.done);
    for (const b of list) b.done = true;
    this.balls = [];
    this.floats = [];
    this.redraw();
    return list;
  }

  land(b, now, quiet) {
    b.done = true;
    b.landedAt = now;
    this.bucketHit[b.k] = now;
    this.animUntil = Math.max(this.animUntil, now + BUCKET_MS);
    this.handlers.onLand(b, quiet);
  }

  /** Posición de la bolita `b` a los `e` ms de soltada (el camino es fijo; solo cambia el tamaño). */
  pos(b, e, out) {
    const g = this.g;
    const s = g.s;
    const R = b.R;
    if (e >= b.total) {
      out.x = g.cx + (b.m[R] * s) / 2;
      out.y = g.bucketY + g.bh * 0.22;
      return out;
    }
    if (e <= 0) {
      out.x = g.cx + b.dx0 * s;
      out.y = g.spawnY;
      return out;
    }
    let i = 0;
    while (e >= b.ends[i]) i++;
    const start = i ? b.ends[i - 1] : 0;
    const u = (e - start) / (b.ends[i] - start);
    let ax;
    let ay;
    if (i === 0) {
      ax = g.cx + b.dx0 * s;
      ay = g.spawnY;
    } else {
      ax = g.cx + (b.m[i - 1] * s) / 2 + b.off[i - 1] * s;
      ay = g.row0 + (i - 1) * g.vs - g.contact;
    }
    let bx;
    let by;
    if (i < R) {
      bx = g.cx + (b.m[i] * s) / 2 + b.off[i] * s;
      by = g.row0 + i * g.vs - g.contact;
    } else {
      bx = g.cx + (b.m[R] * s) / 2;
      by = g.bucketY + g.bh * 0.22;
    }
    out.x = ax + (bx - ax) * u;
    if (i === 0) out.y = ay + (by - ay) * u * u;
    else {
      // Salto parabólico: rebota un poquito para arriba y cae al clavo siguiente
      const k = b.hop[i] * g.vs;
      out.y = ay + (by - ay + k) * u * u - k * u;
    }
    return out;
  }

  addFloat(k, text, color, small = false) {
    const g = this.g;
    if (!g) return;
    const now = performance.now();
    const size = clamp(g.s * 0.55, 11, 16) * (small ? 0.86 : 1);
    this.ctx.font = `800 ${size}px ${FONT}`;
    const w = this.ctx.measureText(text).width;
    const x = g.cx + (k - g.R / 2) * g.s;
    // Si otro texto reciente está al lado, este sube un renglón para no pisarse
    let lane = 0;
    for (const f of this.floats) {
      const fx = g.cx + (f.k - g.R / 2) * g.s;
      if (now - f.t0 < 480 && Math.abs(fx - x) < (f.w + w) / 2 + 4) lane = Math.max(lane, f.lane + 1);
    }
    this.floats.push({ k, text, color, size, w, t0: now, lane: Math.min(lane, 3) });
    if (this.floats.length > 8) this.floats.shift();
    this.animUntil = Math.max(this.animUntil, now + FLOAT_MS);
    this.start();
  }

  // ───────── Bucle de animación ─────────

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    this.resize();
    this.redraw();
  }

  start() {
    if (!this.enabled || this.raf || !this.g) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Dibuja un cuadro suelto (por ejemplo después de cambiar filas o el tamaño). */
  redraw() {
    if (!this.enabled || !this.g || this.raf) return;
    const now = performance.now();
    this.draw(now);
    if (this.balls.length || this.floats.length || now < this.animUntil) this.start();
  }

  _tick(now) {
    this.raf = 0;
    if (!this.enabled || !this.g) return;
    this.step(now);
    this.draw(now);
    if (this.balls.length || this.floats.length || now < this.animUntil) this.raf = requestAnimationFrame(this.tick);
  }

  /** Avanza los eventos: golpes en los clavos y caída en las casillas. */
  step(now) {
    const g = this.g;
    let faded = false;
    for (const b of this.balls) {
      if (b.done) {
        if (now - b.landedAt >= FADE_MS) faded = true;
        continue;
      }
      const e = now - b.t0;
      while (!b.done && e >= b.ends[b.seg]) {
        const late = e - b.ends[b.seg] > 150;
        if (b.seg < b.R) {
          const r = b.seg;
          this.pegHit[g.rowStart[r] + (b.m[r] + r + 2) / 2] = now;
          this.animUntil = Math.max(this.animUntil, now + PEG_GLOW_MS);
          b.seg++;
          this.handlers.onPeg(b, r, late);
        } else this.land(b, now, false);
      }
    }
    if (faded) this.balls = this.balls.filter((b) => !b.done || now - b.landedAt < FADE_MS);
    if (this.floats.length && now - this.floats[0].t0 >= FLOAT_MS) this.floats = this.floats.filter((f) => now - f.t0 < FLOAT_MS);
  }

  draw(now) {
    const { ctx, g } = this;
    if (!g || !this.layer) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.layer, 0, 0, this.w, this.h);

    // Clavos que acaban de recibir un golpe
    const hs = this.halo.size;
    for (let i = 0; i < this.pegHit.length; i++) {
      const dt = now - this.pegHit[i];
      if (dt >= PEG_GLOW_MS || dt < 0) continue;
      const p = g.pegs[i];
      ctx.globalAlpha = Math.pow(1 - dt / PEG_GLOW_MS, 1.4);
      ctx.drawImage(this.halo.c, p.x - hs / 2, p.y - hs / 2, hs, hs);
    }
    ctx.globalAlpha = 1;

    // Casillas (la que recibe una bolita se hunde, rebota y brilla)
    for (let k = 0; k < this.buckets.length; k++) {
      const bk = this.buckets[k];
      const x = g.cx + (k - g.R / 2) * g.s - g.bw / 2 - bk.normal.pad;
      let y = g.bucketY - bk.normal.pad;
      const dt = now - this.bucketHit[k];
      if (dt >= 0 && dt < 420 && !this.reduced) {
        y += (dt < 150 ? 0.26 * Math.sin((dt / 150) * Math.PI) : -0.07 * Math.sin(((dt - 150) / 270) * Math.PI)) * g.bh;
      }
      ctx.drawImage(bk.normal.c, x, y, bk.normal.cw, bk.normal.ch);
      if (dt >= 0 && dt < BUCKET_MS) {
        ctx.globalAlpha = Math.pow(1 - dt / BUCKET_MS, 1.3);
        ctx.drawImage(bk.lit.c, x, y, bk.lit.cw, bk.lit.ch);
        ctx.globalAlpha = 1;
      }
    }

    // Bolitas (con una estela cortita)
    const P = this.pt;
    const sp = this.ballSprite;
    for (const b of this.balls) {
      if (b.done) {
        const t = (now - b.landedAt) / FADE_MS;
        if (t >= 1 || t < 0) continue;
        this.pos(b, b.total, P);
        ctx.globalAlpha = 1 - t;
        this.drawBall(sp, P.x, P.y + t * g.bh * 0.3, 1 - 0.45 * t);
        continue;
      }
      const e = now - b.t0;
      if (!this.reduced) {
        for (let k = TRAIL.length - 1; k >= 0; k--) {
          const te = e - TRAIL[k].dt;
          if (te <= 0) continue;
          this.pos(b, te, P);
          ctx.globalAlpha = TRAIL[k].a;
          this.drawBall(sp, P.x, P.y, TRAIL[k].r);
        }
      }
      this.pos(b, e, P);
      ctx.globalAlpha = clamp(e / 70, 0, 1);
      this.drawBall(sp, P.x, P.y, 1);
    }
    ctx.globalAlpha = 1;

    // Textos que suben desde la casilla (multiplicador o ganancia)
    if (this.floats.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(6, 9, 19, 0.88)';
      for (const f of this.floats) {
        const t = (now - f.t0) / FLOAT_MS;
        if (t >= 1 || t < 0) continue;
        const half = f.w / 2 + 3;
        const x = clamp(g.cx + (f.k - g.R / 2) * g.s, half, this.w - half);
        const y = Math.max(f.size, g.bucketY - f.size * 0.8 - f.lane * (f.size + 3) - 30 * (1 - Math.pow(1 - t, 3)));
        const pop = t < 0.12 ? 0.6 + (0.4 * t) / 0.12 : 1;
        ctx.globalAlpha = t < 0.62 ? 1 : 1 - (t - 0.62) / 0.38;
        ctx.font = `800 ${f.size}px ${FONT}`;
        ctx.lineWidth = Math.max(3, f.size * 0.28);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(pop, pop);
        ctx.strokeText(f.text, 0, 0);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawBall(sp, x, y, scale) {
    const size = sp.size * scale;
    this.ctx.drawImage(sp.c, x - size / 2, y - size / 2, size, size);
  }
}

// ═══════════════════════════ Juego ═══════════════════════════

export function createPlinko(shell) {
  const { sound } = shell;
  const S = () => shell.state.settings;

  let el = null;
  let amount = null;
  let board = null;
  let rows = pickRows(store.get('cpy_plk_rows', 16));
  let risk = RISKS.includes(store.get('cpy_plk_risk', 'medium')) ? store.get('cpy_plk_risk', 'medium') : 'medium';
  let visible = false;
  let pending = 0; // pedidos al servidor sin respuesta
  let lastDrop = 0;
  let auto = null; // { total, sent, landed, net, running, reason, timer, inflight, done }
  let lastPegSound = 0;
  let lastLandSound = 0;
  let lastConfetti = 0;
  let mineTimer = 0;

  const flying = () => (board ? board.flying() : 0);
  const busy = () => pending > 0 || flying() > 0;
  const paused = () => S().game_plinko === false;

  function pickRows(v) {
    const n = Number(v);
    return ROWS.includes(n) ? n : 16;
  }

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function mount(root) {
    const canvas = h('canvas', { class: 'pk-canvas', role: 'img' });
    const boardWrap = h('div', { class: 'pk-board' }, canvas);
    const hist = h('div', { class: 'pk-hist', 'aria-label': 'Últimos resultados' });
    for (let i = 0; i < HISTORY; i++) hist.append(h('span', { class: 'pk-chip pk-empty' }));
    const infoLeft = h('span', { class: 'pk-info-l' });
    const infoMax = h('b');
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused_ = pausedNotice();
    const stage = h(
      'div',
      { class: 'gv-stage pk-stage' },
      h('div', { class: 'pk-layout' }, h('div', { class: 'pk-info' }, infoLeft, h('span', { class: 'pk-info-r' }, 'Máximo ', infoMax)), hist, boardWrap),
      result.el,
      winLayer,
      paused_,
    );

    amount = new AmountControl(shell, { key: 'cpy_plk_amt', def: 5000, onChange: () => render() });
    const riskSeg = segmented(
      RISKS.map((k) => ({ value: k, label: RISK_NAMES[k] })),
      { value: risk, onChange: setRisk, className: 'pk-risk' },
    );
    const rowsSeg = segmented(
      ROWS.map((n) => ({ value: n, label: String(n) })),
      { value: rows, onChange: setRows, className: 'pk-rows' },
    );
    const statMax = h('b');
    const statPrize = h('b');
    const action = actionButton(() => onAction());

    const autoBtns = AUTO_COUNTS.map((n) => h('button', { type: 'button', title: `Soltar ${n} bolitas`, onclick: () => startAuto(n) }, String(n)));
    const autoPick = h('div', { class: 'quick-row pk-auto-pick' }, ...autoBtns);
    const autoFill = h('i');
    const autoCount = h('b');
    const autoStop = h('button', { class: 'btn btn-danger btn-sm pk-auto-stop', type: 'button', onclick: () => stopAuto('user') }, 'DETENER');
    const autoRun = h(
      'div',
      { class: 'pk-auto-run', hidden: true },
      h('div', { class: 'pk-auto-meter' }, h('div', { class: 'pk-auto-info' }, h('span', null, '🔁 Auto'), autoCount), h('div', { class: 'pk-auto-bar' }, autoFill)),
      autoStop,
    );
    const noteEl = h('div', { class: 'gv-note' });

    const panel = h(
      'div',
      { class: 'gv-panel' },
      panelHead(shell, { icon: '🔴', name: 'Plinko' }),
      h('div', null, h('div', { class: 'gv-label' }, 'Monto'), amount.el),
      h('div', null, h('div', { class: 'gv-label' }, 'Riesgo'), riskSeg.el),
      h('div', null, h('div', { class: 'gv-label' }, 'Filas'), rowsSeg.el),
      h('div', { class: 'gv-stats pk-stats' }, h('div', { class: 'gv-stat' }, h('small', null, 'Máximo'), statMax), h('div', { class: 'gv-stat' }, h('small', null, 'Premio máximo'), statPrize)),
      action.el,
      h('div', { class: 'pk-auto' }, h('div', { class: 'gv-label' }, 'Auto', h('span', { class: 'pk-auto-hint' }, 'bolitas seguidas')), autoPick, autoRun),
      noteEl,
    );

    root.append(h('div', { class: 'gv gv-plinko' }, stage, panel));
    el = { stage, canvas, hist, infoLeft, infoMax, result, winLayer, paused: paused_, riskSeg, rowsSeg, statMax, statPrize, action, autoBtns, autoPick, autoRun, autoFill, autoCount, note: noteEl };

    board = new PlinkoBoard(canvas, { onPeg, onLand: (b, quiet) => settle(b, quiet) });
    board.reduced = reducedMotion();
    board.setTable(rows, risk);
    // La letra de las casillas se dibuja en el canvas: la volvemos a armar cuando carga Rubik
    if (document.fonts && document.fonts.load) {
      document.fonts
        .load(`800 12px Rubik`)
        .then(() => {
          board.buildBuckets();
          board.redraw();
        })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && visible) {
        // Pestaña en segundo plano: no se anima fuera de la pantalla
        stopAuto('hidden');
        finishAll();
      } else if (!document.hidden && visible) board.redraw();
    });
    note('Elegí el riesgo y las filas, y soltá la bolita\u00a0🔴');
    render();
  }

  function setRisk(k) {
    if (busy() || auto || !RISKS.includes(k)) {
      el.riskSeg.set(risk);
      return;
    }
    risk = k;
    store.set('cpy_plk_risk', k);
    board.setTable(rows, risk);
    sound.click(1.1);
    render();
  }

  function setRows(n) {
    if (busy() || auto || !ROWS.includes(n)) {
      el.rowsSeg.set(rows);
      return;
    }
    rows = n;
    store.set('cpy_plk_rows', n);
    board.setTable(rows, risk);
    sound.click(1.1);
    render();
  }

  function note(text, kind = '') {
    if (!el) return;
    el.note.textContent = text || '';
    el.note.className = `gv-note${kind ? ' ' + kind : ''}`;
  }

  function render() {
    if (!el) return;
    const inPlay = busy();
    const off = paused();
    const table = core.PLINKO[rows][risk];
    const max = Math.max(...table);
    amount.setDisabled(!!auto);
    el.riskSeg.setDisabled(inPlay || !!auto);
    el.rowsSeg.setDisabled(inPlay || !!auto);

    if (!shell.state.user) el.action.set({ text: 'SOLTAR', detail: 'Ingresá para jugar' });
    else if (auto) el.action.set({ text: 'DETENER', detail: `Auto · ${auto.sent} de ${auto.total}`, color: 'red' });
    else if (off) el.action.set({ text: 'SOLTAR', detail: 'Juego en pausa', disabled: true });
    else el.action.set({ text: 'SOLTAR', detail: fmtGs(amount.value) });

    el.autoPick.hidden = !!auto;
    el.autoRun.hidden = !auto;
    for (const b of el.autoBtns) b.disabled = off;
    if (auto) {
      setText(el.autoCount, `${auto.sent} / ${auto.total}`);
      el.autoFill.style.transform = `scaleX(${auto.sent / auto.total})`;
    }

    setText(el.infoLeft, `${rows} filas · riesgo ${RISK_NAMES[risk].toLowerCase()}`);
    setText(el.infoMax, `${multLabel(max)}x`);
    setText(el.statMax, `${multLabel(max)}x`);
    const prize = Math.min(Math.floor((amount.value * max) / 100), amount.value + (Number(S().max_profit) || Infinity));
    setText(el.statPrize, fmtGs(prize));
    const label = `Tablero de Plinko: ${rows} filas, riesgo ${RISK_NAMES[risk].toLowerCase()}`;
    if (el.canvas.getAttribute('aria-label') !== label) el.canvas.setAttribute('aria-label', label);

    el.paused.hidden = !(off && !inPlay);
    shell.setNavBadge('plinko', !!auto || inPlay);
  }

  // ───────────────────────── Jugar ─────────────────────────

  function onAction() {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (auto) {
      stopAuto('user');
      return;
    }
    drop(null);
  }

  const canAfford = () => amount.value <= shell.balance;

  /** Suelta una bolita. `session` = sesión del modo automático (o null si es a mano). */
  async function drop(session) {
    if (!el || !shell.state.user) return false;
    if (paused()) {
      if (!session) toast('Plinko está en pausa por un momento ⏸', 'error');
      return false;
    }
    if (!canAfford()) {
      if (!session) toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return false;
    }
    const now = performance.now();
    if (!session && now - lastDrop < MIN_GAP_MS) return false;
    if (pending >= MAX_PENDING) return false;
    lastDrop = now;
    pending++;
    if (!session) {
      sound.bet();
      vibrate(10);
    }
    render();
    const value = amount.value;
    const release = shell.lockBalance();
    const res = await shell.emit('plinko:drop', { amount: value, rows, risk });
    pending--;
    if (!res.ok) {
      release();
      toast(res.error || 'No se pudo soltar la bolita', 'error');
      render();
      return false;
    }
    const play = res.play;
    // La apuesta se descuenta ya; el premio queda escondido hasta que ESTA bolita caiga
    const reveal = shell.hideBalance(play.payout);
    shell.setBalance(res.balance);
    release();
    if (session) session.sent++;
    launch({ play, reveal, session });
    render();
    return true;
  }

  function launch(ball) {
    const p = ball.play;
    if (!board || !visible || !shell.isVisible('plinko') || !board.g || !p.path || p.params.rows !== board.rows) {
      settle(ball, true); // no se puede animar: el resultado se muestra al instante
      return;
    }
    board.addBall(ball);
  }

  /** Termina al instante todas las bolitas que todavía caen (mostrando sus premios). */
  function finishAll() {
    if (!board) return;
    for (const b of board.takeFlying()) settle(b, true);
  }

  function onPeg(b, row, late) {
    if (late) return;
    const now = performance.now();
    const n = flying();
    if (now - lastPegSound < (n > 8 ? 55 : n > 3 ? 34 : 16)) return;
    lastPegSound = now;
    sound.peg(row);
  }

  /** La bolita llegó a su casilla (o se terminó al instante si `quiet`). */
  function settle(ball, quiet) {
    const p = ball.play;
    ball.reveal();
    pushHistory(p);
    const s = ball.session;
    if (s) {
      s.landed++;
      s.net += p.payout - p.amount;
    }
    if (!quiet) effects(ball);
    if (s) summary(s);
    else if (!quiet) {
      const win = p.payout > p.amount;
      note(`🔴 ${fmtMult(p.multiplier)} · ${win ? 'ganaste' : 'cobraste'} ${gsNb(p.payout)}`, win ? 'good' : 'bad');
    }
    clearTimeout(mineTimer);
    mineTimer = setTimeout(() => shell.refreshMine(), 900);
    render();
  }

  function effects(ball) {
    const p = ball.play;
    const win = p.payout > p.amount;
    const big = isBigWin(p.payout, p.amount, p.multiplier);
    const now = performance.now();
    if (big) celebrate(p);
    else if (now - lastLandSound > 70 || p.multiplier >= 200) {
      lastLandSound = now;
      sound.land(p.multiplier);
    }
    if (win && !big) vibrate(12);
    // Con muchas bolitas se muestran solo las ganancias, para no llenar el tablero de textos
    // (en los premios grandes el monto ya lo muestra el cartel)
    if (win && !big) board.addFloat(p.bucket, `+${fmtGs(p.payout - p.amount)}`, '#5ff29a');
    else if (!win && !auto && flying() <= 3) board.addFloat(p.bucket, fmtMult(p.multiplier), '#ff9aa6', true);
  }

  function celebrate(p) {
    const now = performance.now();
    el.result.show({ win: true, head: fmtMult(p.multiplier), detail: `Ganaste ${fmtGs(p.payout)}`, big: true });
    winPop(el.winLayer, { amount: p.payout - p.amount, label: `¡La bolita cayó en ${fmtMult(p.multiplier)}! 🔴`, big: true });
    if (now - lastConfetti > 2600) {
      lastConfetti = now;
      confetti(el.stage);
    }
    sound.win(true);
    vibrate([30, 40, 30, 40, 60]);
  }

  /** Agrega el resultado a "últimos resultados" (el más nuevo primero). */
  function pushHistory(p) {
    if (!el) return;
    const edge = edgeOf(p.bucket, p.params.rows);
    const col = heat(edge);
    const chip = h(
      'button',
      {
        class: `pk-chip pk-new${edge >= 0.75 ? ' pk-hot' : ''}`,
        type: 'button',
        title: `${fmtMult(p.multiplier)} · ${fmtGs(p.payout)} · ver jugada #${p.id}`,
        onclick: () => openPlay(shell, p.id),
      },
      `${multLabel(p.multiplier)}x`,
    );
    chip.style.background = `linear-gradient(180deg, ${rgb(mix(col, WHITE, 0.28))}, ${rgb(col)})`;
    chip.style.setProperty('--pk-glow', rgb(col, 0.55));
    el.hist.prepend(chip);
    while (el.hist.children.length > HISTORY) el.hist.lastElementChild.remove();
  }

  // ───────────────────────── Modo automático ─────────────────────────

  function startAuto(n) {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (auto || !el) return;
    if (paused()) {
      toast('Plinko está en pausa por un momento ⏸', 'error');
      return;
    }
    if (!canAfford()) {
      toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return;
    }
    auto = { total: n, sent: 0, landed: 0, net: 0, running: true, reason: '', timer: 0, inflight: false, done: false };
    sound.bet();
    vibrate(10);
    note(`🔁 Soltando ${n} bolitas…`);
    render();
    autoStep(auto);
  }

  async function autoStep(s) {
    s.timer = 0;
    if (auto !== s || !s.running) return;
    if (s.sent >= s.total) return stopAuto('done');
    if (paused()) return stopAuto('paused');
    if (!canAfford()) return stopAuto('funds');
    const started = performance.now();
    s.inflight = true;
    const ok = await drop(s);
    s.inflight = false;
    if (auto !== s || !s.running) {
      summary(s);
      return;
    }
    if (!ok) return stopAuto(paused() ? 'paused' : 'error');
    if (s.sent >= s.total) return stopAuto('done');
    s.timer = setTimeout(() => autoStep(s), Math.max(0, AUTO_GAP_MS - (performance.now() - started)));
  }

  function stopAuto(reason) {
    const s = auto;
    if (!s) return;
    auto = null;
    s.running = false;
    s.reason = reason;
    clearTimeout(s.timer);
    if (reason === 'funds') toast('Auto detenido: no te alcanza el saldo 😕', 'error');
    summary(s);
    render();
  }

  /** Resumen del modo automático cuando cayó la última bolita. */
  function summary(s) {
    if (s.running || s.inflight || s.done || s.landed < s.sent) return;
    s.done = true;
    const heads = {
      done: '🏁 Auto terminado',
      user: '⏹ Auto detenido',
      funds: '😕 Auto detenido por saldo',
      paused: '⏸ Auto detenido: juego en pausa',
      offline: '📡 Auto detenido: se cortó la conexión',
    };
    const head = heads[s.reason] || '⏹ Auto detenido';
    if (!s.sent) {
      note(head, 'bad');
      return;
    }
    const net = `${s.net >= 0 ? '+' : '−'}${gsNb(Math.abs(s.net))}`;
    const text = `${head} · ${s.sent} bolita${s.sent === 1 ? '' : 's'} · ${net}`;
    note(text, s.net >= 0 ? 'good' : 'bad');
    if (s.reason === 'done') toast(`${s.sent} bolitas · resultado ${net}`, s.net >= 0 ? 'success' : 'info', 'Auto terminado');
  }

  // ───────────────────────── Interfaz para la app ─────────────────────────

  function rules() {
    const li = (...c) => h('li', null, ...c);
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('Elegí cuánto apostar, el ', h('b', null, 'riesgo'), ' (bajo, medio o alto) y cuántas ', h('b', null, 'filas'), ' de clavos querés (de 8 a 16).'),
        li('Tocá ', h('b', null, 'SOLTAR'), ': la bolita cae por la pirámide y en cada clavo rebota al azar, a la izquierda o a la derecha.'),
        li('Al final cae en una casilla y cobrás tu apuesta × el ', h('b', null, 'multiplicador'), ' de esa casilla.'),
        li('Las casillas del medio son las más probables y pagan poco; las de los bordes son difíciles pero pagan muchísimo (hasta ', h('b', null, `${multLabel(TOP_MULT)}x`), ').'),
        li('Más riesgo y más filas = premios más grandes en los bordes, pero más casillas que pagan menos de lo apostado.'),
      ),
      h(
        'ul',
        null,
        li('Podés soltar varias bolitas seguidas sin esperar a que caigan.'),
        li(h('b', null, 'Auto'), ': elegí 10, 25, 50 o 100 bolitas y se sueltan solas. Se detiene cuando tocás DETENER, si no te alcanza el saldo o si salís del juego.'),
        li('El camino de cada bolita sale de tus semillas (provably fair): lo podés verificar en Mis apuestas.'),
      ),
    );
  }

  return {
    id: 'plinko',
    mount,
    show() {
      visible = true;
      if (board) {
        board.reduced = reducedMotion();
        board.setEnabled(true);
      }
      render();
    },
    hide() {
      visible = false;
      stopAuto('hidden');
      finishAll();
      if (board) board.setEnabled(false);
      if (el) el.result.hide();
      render();
    },
    onInit() {
      // Cada bolita se resuelve al instante en el servidor: no hay partidas que recuperar
      if (el) render();
    },
    onUser() {
      stopAuto('user');
      finishAll();
      if (el) render();
    },
    onSettings() {
      if (!el) return;
      amount.refresh();
      if (paused()) stopAuto('paused');
      render();
    },
    onDisconnect() {
      stopAuto('offline');
    },
    loadMine: (container) => loadPlays(shell, container, 'plinko'),
    rules,
  };
}
