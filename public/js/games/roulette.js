// 🎰 Ruleta europea (un solo 0): poné fichas en la mesa, tocá GIRAR y mirá dónde cae la bolita.
// La rueda se dibuja en <canvas> (una capa fija, una que gira y el brillo) y la bolita es un
// elemento que se mueve con transform: así la animación es liviana incluso en celulares.
import { h, fmtGs, toast } from '../shared.js';
import {
  core,
  store,
  actionButton,
  winPop,
  confetti,
  pausedNotice,
  loadPlays,
  setText,
  vibrate,
  resultOverlay,
  panelHead,
  isBigWin,
  compact,
  ease,
  rouletteBetName,
} from './common.js';

const TAU = Math.PI * 2;
const WHEEL = core.ROULETTE_WHEEL; // orden real, en sentido horario empezando por el 0
const SEG = TAU / WHEEL.length;
const HISTORY_MAX = 12;
const MAX_BETS = 60;
// Desde 540px de ancho la mesa horizontal ya entra: panel al costado, rueda y mesa abajo (PC en
// 1280px deja solo ~570px para el juego). Más angosto: mesa vertical y barra fija de fichas.
const NARROW_BELOW = 540;
const IDLE_SPEED = 0.22; // rad/s: antes del primer giro la rueda gira despacito
const COLOR_EMOJI = { red: '🔴', black: '⚫️', green: '🟢' };
const COLOR_NAME = { red: 'rojo', black: 'negro', green: 'verde' };
const mod = (a, m) => ((a % m) + m) % m;
const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const reduced = () => !!(reducedQuery && reducedQuery.matches);

// Radios de la rueda (fracción del radio exterior)
const RAD = {
  rim: 0.915, // madera → pista de la bolita
  track: 0.8, // borde interior de la pista
  apron: 0.738, // zona de los rombos → anillo de números
  numbers: 0.605, // números → casilleros
  pockets: 0.49, // casilleros → cono central
  ballTrack: 0.858, // la bolita girando por la pista
  ballRing: 0.705, // donde pega al bajar
  ballPocket: 0.548, // la bolita quieta en el casillero
  ball: 0.037, // radio de la bolita
};

const POCKET = {
  red: { hi: '#ec3346', mid: '#b8162b', lo: '#5a0812', pk: '#96112a' },
  black: { hi: '#363a50', mid: '#1b1e2c', lo: '#06070c', pk: '#141622' },
  green: { hi: '#1fbd69', mid: '#0c8444', lo: '#033b1d', pk: '#0a6a36' },
};

// Fichas: blanca, roja, azul, verde, negra y violeta (como en el casino)
const CHIP_STYLES = [
  { c: '#eef1f8', e: '#3d7bff', t: '#172042' },
  { c: '#e5303f', e: '#ffffff', t: '#ffffff' },
  { c: '#2f6bff', e: '#ffffff', t: '#ffffff' },
  { c: '#14a150', e: '#ffffff', t: '#ffffff' },
  { c: '#22263a', e: '#ffc53d', t: '#ffffff' },
  { c: '#8b5cf6', e: '#ffffff', t: '#ffffff' },
];

// Íconos y dibujos (constantes nuestras, sin datos del usuario)
const ICONS = {
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  clear:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
  double: '<b>×2</b>',
  repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
};
const DIAMOND = (color) =>
  `<svg class="rl-dm" viewBox="0 0 40 24" preserveAspectRatio="none" aria-hidden="true"><polygon class="rl-dm-${color}" points="20,1.5 38.5,12 20,22.5 1.5,12"/><polygon points="20,1.5 38.5,12 1.5,12" fill="rgba(255,255,255,0.2)"/></svg>`;

// ───────────────────────── Mesa ─────────────────────────
// Cada casilla sabe dónde va en la mesa horizontal (--ha, PC) y en la vertical (--va, celular).

const betKey = (type, value) => (value === null || value === undefined ? type : `${type}:${value}`);
const PAY_X = (type) => `${core.ROULETTE_PAYS[type] / 100}x`;

const OUTSIDE = [
  { type: 'low', label: '1–18' },
  { type: 'even', label: 'PAR' },
  { type: 'red', diamond: 'red' },
  { type: 'black', diamond: 'black' },
  { type: 'odd', label: 'IMPAR' },
  { type: 'high', label: '19–36' },
];

const CELLS = buildCells();
const CELL_BY_KEY = new Map(CELLS.map((c) => [c.key, c]));

function buildCells() {
  const list = [];
  const add = (c) => {
    c.key = betKey(c.type, c.value);
    c.name = rouletteBetName(c);
    c.covers = [];
    for (let n = 0; n <= 36; n++) if (core.rouletteWins(c, n)) c.covers.push(n);
    list.push(c);
  };
  add({ type: 'n', value: 0, label: '0', color: 'green', ha: '1 / 1 / span 3 / span 1', va: '1 / 3 / span 1 / span 3' });
  for (let n = 1; n <= 36; n++) {
    const col = Math.floor((n - 1) / 3); // columna de la mesa horizontal (0 a 11)
    const row = (n - 1) % 3; // 0 = fila del 1, 4, 7…
    add({ type: 'n', value: n, label: String(n), color: core.rouletteColor(n), ha: `${3 - row} / ${col + 2}`, va: `${col + 2} / ${row + 3}` });
  }
  for (let v = 1; v <= 3; v++) add({ type: 'column', value: v, label: '2:1', ha: `${4 - v} / 14`, va: `14 / ${v + 2}` });
  ['1–12', '13–24', '25–36'].forEach((label, i) =>
    add({ type: 'dozen', value: i + 1, label, ha: `4 / ${2 + 4 * i} / span 1 / span 4`, va: `${2 + 4 * i} / 2 / span 4 / span 1` }),
  );
  OUTSIDE.forEach((o, i) =>
    add({ type: o.type, value: null, label: o.label || '', diamond: o.diamond || null, ha: `5 / ${2 + 2 * i} / span 1 / span 2`, va: `${2 + 2 * i} / 1 / span 2 / span 1` }),
  );
  for (const c of list) {
    let extra = '';
    if (c.type === 'column') extra = ` (${c.value}, ${c.value + 3}, ${c.value + 6}… ${c.value + 33})`;
    else if (c.type === 'dozen') extra = ` (${c.label.replace('–', ' a ')})`;
    c.title = `${c.name}${extra} · paga ${PAY_X(c.type)}`;
  }
  return list;
}

// ───────────────────────── Fichas ─────────────────────────

function niceUp(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function nextNice(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v) + 1e-9));
  const m = Math.round(v / p);
  return m === 1 ? 2 * p : m === 2 ? 5 * p : 10 * p;
}

/** Seis valores de ficha "redondos" a partir de la apuesta mínima (1K, 5K, 10K, 50K, 100K, 500K…). */
function computeChips(s) {
  const min = Math.max(1, Math.floor(Number(s.min_bet) || 1000));
  const max = Math.max(min, Math.floor(Number(s.max_bet) || min));
  const base = niceUp(min);
  const out = [];
  for (const k of [1, 5, 10, 50, 100, 500]) if (base * k <= max) out.push(base * k);
  if (out.length < 6) {
    // Con un máximo chico se completa con la serie 1-2-5 (de las más grandes a las más chicas)
    const series = [];
    for (let v = base; v <= max && series.length < 40; v = nextNice(v)) series.push(v);
    for (let i = series.length - 1; i >= 0 && out.length < 6; i--) if (!out.includes(series[i])) out.push(series[i]);
    out.sort((a, b) => a - b);
  }
  if (!out.length) out.push(min);
  return out.slice(0, 6);
}

// ───────────────────────── Movimiento de la rueda y la bolita ─────────────────────────
// La rueda frena sola y el casillero ganador termina arriba. La bolita da vueltas al revés por
// la pista, pierde velocidad, baja, pega un par de saltitos y queda en el casillero de la jugada.
// Durante la caída su ángulo se calcula RELATIVO a la rueda, así el final siempre coincide.

const MOTION = {
  full: { T: 6.2, td: 3.35, ts: 4.75, tr: 0.5, b: 2.2, vNom: 13, lift: 0.35, hit: 0.3, bounce: true, wobble: 1.15, minTurn: 1.2 * Math.PI, minPeak: 1.4 },
  reduced: { T: 2.2, td: 0.9, ts: 1.5, tr: 0.25, b: 2, vNom: 6.5, lift: 0.2, hit: 0.35, bounce: false, wobble: 0, minTurn: 0.5 * Math.PI, minPeak: 0.6 },
};

const decay = (p, t) => Math.pow(Math.max(0, 1 - t / p.T), p.b);
const ramp = (p, t) => (t >= p.tr ? 1 : 1 - Math.pow(1 - t / p.tr, 2));
const J1 = (p, t) => (p.T / (p.b + 1)) * (1 - Math.pow(Math.max(0, 1 - t / p.T), p.b + 1));

function J2(p, t) {
  if (t >= p.tr) return p.J2tab[p.steps] + J1(p, t) - J1(p, p.tr);
  const x = (Math.max(0, t) / p.tr) * p.steps;
  const i = Math.min(p.steps - 1, Math.floor(x));
  return p.J2tab[i] + (p.J2tab[i + 1] - p.J2tab[i]) * (x - i);
}

const spinOmega = (p, t) => (p.w0 + (p.wPeak - p.w0) * ramp(p, t)) * decay(p, t);
const spinAngle = (p, t) => {
  const u = Math.min(Math.max(0, t), p.T);
  return p.A0 + p.w0 * J1(p, u) + (p.wPeak - p.w0) * J2(p, u);
};

function planSpin(wh, number, reducedMotion) {
  const M = reducedMotion ? MOTION.reduced : MOTION.full;
  const p = { ...M, k: WHEEL.indexOf(number), A0: wh.angle, w0: Math.max(0, wh.omega), tick: 0, revealed: false, start: performance.now() };
  // ∫ rampa × frenado entre 0 y tr (el resto tiene fórmula)
  p.steps = 48;
  p.J2tab = new Float64Array(p.steps + 1);
  let prev = 0;
  for (let i = 1; i <= p.steps; i++) {
    const t = (p.tr * i) / p.steps;
    const v = ramp(p, t) * decay(p, t);
    p.J2tab[i] = p.J2tab[i - 1] + ((prev + v) / 2) * (p.tr / p.steps);
    prev = v;
  }
  // Cuánto gira la rueda: lo justo para que el casillero ganador termine arriba
  const j1 = J1(p, p.T);
  const j2 = J2(p, p.T);
  let turn = mod(-p.k * SEG - p.A0, TAU);
  if (turn < p.minTurn) turn += TAU;
  p.wPeak = p.w0 + (turn - p.w0 * j1) / j2;
  while (p.wPeak < Math.max(p.minPeak, p.w0 * 0.9)) {
    turn += TAU;
    p.wPeak = p.w0 + (turn - p.w0 * j1) / j2;
  }
  // Bolita en la pista: frena sola; su velocidad inicial se ajusta para llegar a la caída
  // con la distancia justa (relativa a la rueda) hasta el casillero ganador.
  p.tx = p.td * 1.4;
  p.c = 1.5;
  const K = (p.tx / (p.c + 1)) * (1 - Math.pow(1 - p.td / p.tx, p.c + 1));
  const kd = Math.pow(1 - p.td / p.tx, p.c);
  p.beta0 = wh.ballOn ? wh.ballAngle : Math.random() * TAU;
  p.rho0 = wh.ballOn ? wh.ballRadius : RAD.ballTrack;
  p.fade = !wh.ballOn;
  const Ad = spinAngle(p, p.td);
  const wd = spinOmega(p, p.td);
  const D = p.ts - p.td;
  p.Rd = (p.vNom * kd + wd) * D * (0.5 + Math.random() * 0.12);
  const target = p.beta0 - (Ad + p.k * SEG + p.Rd);
  const nominal = K * p.vNom;
  let omega = target + Math.round((nominal - target) / TAU) * TAU;
  if (omega < nominal * 0.6) omega += TAU;
  p.V0 = omega / K;
  p.RdDot = -p.V0 * kd - wd;
  // Golpecitos: al bajar, en cada rebote y al quedar quieta
  p.ticks = p.bounce ? [p.td + p.hit * D, p.td + (p.hit + (1 - p.hit) * 0.2) * D, p.td + (p.hit + (1 - p.hit) * 0.6) * D, p.ts] : [p.ts];
  return p;
}

/** Posición de la bolita (ángulo en sentido horario desde arriba y radio) en el segundo t. */
function ballAt(p, t, A) {
  if (t < p.td) {
    const om = p.V0 * (p.tx / (p.c + 1)) * (1 - Math.pow(1 - t / p.tx, p.c + 1));
    let rho = RAD.ballTrack;
    if (p.rho0 < RAD.ballTrack && t < p.lift) rho = p.rho0 + (RAD.ballTrack - p.rho0) * ease.outCubic(t / p.lift);
    return { beta: p.beta0 - om, rho, alpha: p.fade ? Math.min(1, t / 0.3) : 1 };
  }
  if (t >= p.ts) return { beta: A + p.k * SEG, rho: RAD.ballPocket, alpha: 1 };
  const D = p.ts - p.td;
  const s = (t - p.td) / D;
  const s2 = s * s;
  const s3 = s2 * s;
  let rel = p.Rd * (2 * s3 - 3 * s2 + 1) + D * p.RdDot * (s3 - 2 * s2 + s);
  let rho;
  if (s < p.hit) {
    const q = s / p.hit;
    rho = RAD.ballTrack - (RAD.ballTrack - RAD.ballRing) * q * q;
  } else {
    const u = (s - p.hit) / (1 - p.hit);
    if (p.bounce) {
      rho = RAD.ballPocket + (RAD.ballRing - RAD.ballPocket) * Math.pow(1 - u, 1.4) * Math.abs(Math.cos(2.5 * Math.PI * u));
      rel += p.wobble * SEG * 4 * u * (1 - u) * (1 - u) * Math.sin(2.6 * Math.PI * u);
    } else rho = RAD.ballRing + (RAD.ballPocket - RAD.ballRing) * ease.outCubic(u);
  }
  return { beta: A + p.k * SEG + rel, rho, alpha: 1 };
}

// ───────────────────────── Dibujo de la rueda ─────────────────────────

function circlePath(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
}

function ringPath(g, c, r1, r2) {
  g.beginPath();
  g.arc(c, c, r1, 0, TAU);
  g.arc(c, c, r2, 0, TAU, true);
}

function wedgePath(g, c, r1, r2, a0, a1) {
  g.beginPath();
  g.arc(c, c, r1, a0, a1);
  g.arc(c, c, r2, a1, a0, true);
  g.closePath();
}

function goldRing(g, c, r, w, alpha = 1) {
  const gr = g.createLinearGradient(c - r, c - r, c + r, c + r);
  gr.addColorStop(0, `rgba(255, 243, 200, ${alpha})`);
  gr.addColorStop(0.3, `rgba(226, 180, 90, ${alpha})`);
  gr.addColorStop(0.65, `rgba(150, 108, 36, ${alpha})`);
  gr.addColorStop(1, `rgba(244, 214, 138, ${alpha})`);
  g.lineWidth = w;
  g.strokeStyle = gr;
  circlePath(g, c, c, r);
  g.stroke();
}

/** Parte fija: borde de madera lustrada, pista de la bolita y rombos. */
function drawBowl(g, S) {
  const c = S / 2;
  const R = S / 2 - 2;
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.6)';
  g.shadowBlur = R * 0.1;
  g.shadowOffsetY = R * 0.04;
  circlePath(g, c, c, R);
  g.fillStyle = '#26120a';
  g.fill();
  g.restore();

  // Madera
  let gr = g.createRadialGradient(c - R * 0.3, c - R * 0.42, R * 0.2, c, c, R);
  gr.addColorStop(0, '#a8672f');
  gr.addColorStop(0.62, '#763b17');
  gr.addColorStop(0.9, '#4e240c');
  gr.addColorStop(1, '#2c1206');
  ringPath(g, c, R, R * RAD.rim);
  g.fillStyle = gr;
  g.fill();
  // Vetas (pseudoaleatorio fijo: siempre dibuja lo mismo)
  g.save();
  ringPath(g, c, R, R * RAD.rim);
  g.clip();
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 30; i++) {
    const r = R * (RAD.rim + 0.006 + rnd() * (1 - RAD.rim - 0.01));
    const a = rnd() * TAU;
    g.beginPath();
    g.arc(c, c, r, a, a + 0.35 + rnd() * 1.7);
    g.strokeStyle = rnd() < 0.55 ? `rgba(40, 14, 3, ${0.14 + rnd() * 0.16})` : `rgba(214, 150, 84, ${0.08 + rnd() * 0.12})`;
    g.lineWidth = Math.max(0.6, R * (0.003 + rnd() * 0.005));
    g.stroke();
  }
  g.restore();
  // Barniz (luz arriba a la izquierda)
  gr = g.createLinearGradient(c - R, c - R, c + R * 0.5, c + R * 0.5);
  gr.addColorStop(0, 'rgba(255, 236, 205, 0.34)');
  gr.addColorStop(0.45, 'rgba(255, 236, 205, 0.05)');
  gr.addColorStop(1, 'rgba(255, 236, 205, 0)');
  ringPath(g, c, R, R * RAD.rim);
  g.fillStyle = gr;
  g.fill();
  g.lineWidth = Math.max(1, R * 0.01);
  g.strokeStyle = 'rgba(255, 222, 160, 0.5)';
  circlePath(g, c, c, R - g.lineWidth / 2);
  g.stroke();

  // Pista de la bolita
  gr = g.createRadialGradient(c, c, R * RAD.track, c, c, R * RAD.rim);
  gr.addColorStop(0, '#170c05');
  gr.addColorStop(0.35, '#3b2413');
  gr.addColorStop(0.78, '#2c180b');
  gr.addColorStop(1, '#130903');
  ringPath(g, c, R * RAD.rim, R * RAD.track);
  g.fillStyle = gr;
  g.fill();
  gr = g.createLinearGradient(c - R, c - R, c + R, c + R);
  gr.addColorStop(0, 'rgba(255, 220, 170, 0.16)');
  gr.addColorStop(0.5, 'rgba(255, 220, 170, 0)');
  gr.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
  ringPath(g, c, R * RAD.rim, R * RAD.track);
  g.fillStyle = gr;
  g.fill();
  goldRing(g, c, R * RAD.rim, Math.max(1.2, R * 0.016));
  goldRing(g, c, R * RAD.track, Math.max(1, R * 0.011), 0.9);

  // Zona de los rombos (baja hacia los números)
  gr = g.createRadialGradient(c, c, R * RAD.apron, c, c, R * RAD.track);
  gr.addColorStop(0, '#100703');
  gr.addColorStop(1, '#3d2414');
  ringPath(g, c, R * RAD.track, R * RAD.apron);
  g.fillStyle = gr;
  g.fill();
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) * TAU) / 8;
    const r = R * 0.769;
    g.save();
    g.translate(c + r * Math.sin(a), c - r * Math.cos(a));
    g.rotate(a + (i % 2 ? Math.PI / 2 : 0));
    const lw = R * 0.022;
    const lh = R * 0.046;
    g.beginPath();
    g.moveTo(0, -lh);
    g.lineTo(lw, 0);
    g.lineTo(0, lh);
    g.lineTo(-lw, 0);
    g.closePath();
    const dg = g.createLinearGradient(-lw, -lh, lw, lh);
    dg.addColorStop(0, '#fff3c8');
    dg.addColorStop(0.5, '#d4a24a');
    dg.addColorStop(1, '#7a561b');
    g.fillStyle = dg;
    g.fill();
    g.lineWidth = Math.max(0.6, R * 0.004);
    g.strokeStyle = 'rgba(60, 35, 5, 0.85)';
    g.stroke();
    g.restore();
  }
}

/** Parte que gira: números, casilleros, separadores dorados, cono y torreta. */
function drawHead(g, S) {
  const c = S / 2;
  const R = S / 2 - 2;
  const rO = R * RAD.apron;
  const rN = R * RAD.numbers;
  const rP = R * RAD.pockets;
  ringPath(g, c, rO, rP);
  g.fillStyle = '#0c0d15';
  g.fill();
  for (let i = 0; i < WHEEL.length; i++) {
    const col = POCKET[core.rouletteColor(WHEEL[i])];
    const a0 = -Math.PI / 2 + (i - 0.5) * SEG;
    const a1 = a0 + SEG;
    let gr = g.createRadialGradient(c, c, rN, c, c, rO);
    gr.addColorStop(0, col.mid);
    gr.addColorStop(1, col.hi);
    wedgePath(g, c, rO, rN, a0 - 0.002, a1 + 0.002);
    g.fillStyle = gr;
    g.fill();
    // Casillero: más oscuro y hundido
    gr = g.createRadialGradient(c, c, rP, c, c, rN);
    gr.addColorStop(0, col.lo);
    gr.addColorStop(0.55, col.pk);
    gr.addColorStop(1, col.lo);
    wedgePath(g, c, rN, rP, a0 - 0.002, a1 + 0.002);
    g.fillStyle = gr;
    g.fill();
  }
  // Separadores dorados
  g.lineCap = 'round';
  for (let i = 0; i < WHEEL.length; i++) {
    const a = (i - 0.5) * SEG;
    const s = Math.sin(a);
    const co = Math.cos(a);
    g.beginPath();
    g.moveTo(c + rP * s, c - rP * co);
    g.lineTo(c + rO * s, c - rO * co);
    g.lineWidth = Math.max(1, R * 0.0105);
    g.strokeStyle = '#b8893a';
    g.stroke();
    g.lineWidth = Math.max(0.5, R * 0.0038);
    g.strokeStyle = 'rgba(255, 244, 205, 0.9)';
    g.stroke();
  }
  goldRing(g, c, rO, Math.max(1.2, R * 0.015));
  goldRing(g, c, rN, Math.max(0.8, R * 0.009));
  goldRing(g, c, rP, Math.max(1.2, R * 0.015));
  // Números
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.max(7, R * 0.08)}px Rubik, system-ui, sans-serif`;
  g.shadowColor = 'rgba(0, 0, 0, 0.45)';
  g.shadowBlur = R * 0.01;
  const rt = (rO + rN) / 2;
  for (let i = 0; i < WHEEL.length; i++) {
    const a = i * SEG;
    g.save();
    g.translate(c + rt * Math.sin(a), c - rt * Math.cos(a));
    g.rotate(a);
    g.fillText(String(WHEEL[i]), 0, R * 0.004);
    g.restore();
  }
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  // Cono central de madera
  let gr = g.createRadialGradient(c, c, R * 0.1, c, c, rP);
  gr.addColorStop(0, '#8d5227');
  gr.addColorStop(0.55, '#6d3817');
  gr.addColorStop(1, '#3a1a08');
  circlePath(g, c, c, rP - R * 0.006);
  g.fillStyle = gr;
  g.fill();
  // Vetas del cono
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 18; i++) {
    const r = R * (0.2 + rnd() * 0.27);
    const a = rnd() * TAU;
    g.beginPath();
    g.arc(c, c, r, a, a + 0.4 + rnd() * 1.4);
    g.strokeStyle = rnd() < 0.5 ? 'rgba(40, 14, 3, 0.18)' : 'rgba(214, 150, 84, 0.1)';
    g.lineWidth = Math.max(0.5, R * 0.004);
    g.stroke();
  }
  goldRing(g, c, R * 0.44, Math.max(0.8, R * 0.007), 0.85);
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8 + TAU / 16;
    g.beginPath();
    g.moveTo(c + R * 0.22 * Math.sin(a), c - R * 0.22 * Math.cos(a));
    g.lineTo(c + R * 0.44 * Math.sin(a), c - R * 0.44 * Math.cos(a));
    g.lineWidth = Math.max(0.6, R * 0.005);
    g.strokeStyle = 'rgba(232, 190, 104, 0.55)';
    g.stroke();
  }
  goldRing(g, c, R * 0.215, Math.max(1, R * 0.012));
  // Torreta: cuatro brazos con perilla
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(c, c);
    g.rotate((i * TAU) / 4);
    const arm = g.createLinearGradient(-R * 0.03, 0, R * 0.03, 0);
    arm.addColorStop(0, '#7d5a1d');
    arm.addColorStop(0.45, '#fff0bd');
    arm.addColorStop(1, '#9d7328');
    g.beginPath();
    g.moveTo(-R * 0.03, -R * 0.07);
    g.lineTo(R * 0.03, -R * 0.07);
    g.lineTo(R * 0.013, -R * 0.315);
    g.lineTo(-R * 0.013, -R * 0.315);
    g.closePath();
    g.fillStyle = arm;
    g.fill();
    const kn = g.createRadialGradient(0, -R * 0.335, R * 0.004, 0, -R * 0.335, R * 0.036);
    kn.addColorStop(0, '#fff6d8');
    kn.addColorStop(0.55, '#d8aa4d');
    kn.addColorStop(1, '#6f4c15');
    circlePath(g, 0, -R * 0.335, R * 0.033);
    g.fillStyle = kn;
    g.fill();
    g.restore();
  }
  // Domo central (el reflejo va en la capa fija)
  gr = g.createRadialGradient(c, c, R * 0.01, c, c, R * 0.11);
  gr.addColorStop(0, '#f3d27e');
  gr.addColorStop(0.6, '#c3923a');
  gr.addColorStop(1, '#6a4912');
  circlePath(g, c, c, R * 0.105);
  g.fillStyle = gr;
  g.fill();
  goldRing(g, c, R * 0.105, Math.max(0.8, R * 0.008));
  goldRing(g, c, R * 0.06, Math.max(0.6, R * 0.005), 0.8);
}

/** Brillo fijo por encima de la parte que gira (la luz no gira con la rueda). */
function drawShine(g, S) {
  const c = S / 2;
  const R = S / 2 - 2;
  let gr = g.createLinearGradient(c - R * 0.7, c - R * 0.7, c + R * 0.7, c + R * 0.7);
  gr.addColorStop(0, 'rgba(255, 255, 255, 0.13)');
  gr.addColorStop(0.42, 'rgba(255, 255, 255, 0.02)');
  gr.addColorStop(0.6, 'rgba(0, 0, 0, 0)');
  gr.addColorStop(1, 'rgba(0, 0, 0, 0.24)');
  circlePath(g, c, c, R * RAD.apron);
  g.fillStyle = gr;
  g.fill();
  // Sombra interior del anillo de números (da profundidad)
  gr = g.createRadialGradient(c, c, R * 0.68, c, c, R * RAD.apron);
  gr.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gr.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
  ringPath(g, c, R * RAD.apron, R * 0.68);
  g.fillStyle = gr;
  g.fill();
  // Reflejo del domo
  const x = c - R * 0.035;
  const y = c - R * 0.045;
  gr = g.createRadialGradient(x, y, 0, x, y, R * 0.075);
  gr.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  gr.addColorStop(0.4, 'rgba(255, 255, 255, 0.35)');
  gr.addColorStop(1, 'rgba(255, 255, 255, 0)');
  circlePath(g, x, y, R * 0.075);
  g.fillStyle = gr;
  g.fill();
}

class Wheel {
  constructor() {
    this.el = h('div', { class: 'rl-wheel', role: 'img', 'aria-label': 'Rueda de la ruleta' });
    this.bowl = h('canvas', { class: 'rl-wl-layer' });
    this.head = h('canvas', { class: 'rl-wl-layer' });
    this.glow = h('div', { class: 'rl-wl-glow', hidden: true }, h('i'));
    this.rotor = h('div', { class: 'rl-wl-rotor' }, this.head, this.glow);
    this.shine = h('canvas', { class: 'rl-wl-layer' });
    this.ball = h('div', { class: 'rl-ball', hidden: true });
    this.el.append(this.bowl, this.rotor, this.shine, this.ball);
    this.size = 0;
    this.dpr = 1;
    this.angle = Math.random() * TAU; // giro de la rueda (sentido horario)
    this.omega = IDLE_SPEED;
    this.idle = true;
    this.ballOn = false;
    this.ballAngle = 0;
    this.ballRadius = RAD.ballTrack;
    this.ballAlpha = 1;
    this.ballSpeed = 0; // rad/s (para el "barrido" cuando va rápido)
    this.win = null;
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(this.el);
    else window.addEventListener('resize', () => this.resize());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.size && this.draw());
  }

  resize() {
    const w = Math.round(this.el.clientWidth);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || (w === this.size && dpr === this.dpr)) return;
    this.size = w;
    this.dpr = dpr;
    for (const c of [this.bowl, this.head, this.shine]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(w * dpr);
    }
    const R = w / 2 - 2;
    const d = Math.max(6, RAD.ball * 2 * R);
    this.ballSize = d;
    this.ball.style.width = `${d}px`;
    this.ball.style.height = `${d}px`;
    // Brillo del casillero ganador (dentro del rotor: gira con la rueda)
    const glow = this.glow.firstChild;
    const top = w / 2 - R * (RAD.apron + 0.004);
    const height = R * (RAD.apron - RAD.pockets + 0.008);
    const width = R * SEG * (RAD.apron + 0.01);
    Object.assign(glow.style, { top: `${top}px`, height: `${height}px`, width: `${width}px`, marginLeft: `${-width / 2}px` });
    this.draw();
    this.render();
  }

  layer(canvas) {
    const g = canvas.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.size, this.size);
    return g;
  }

  draw() {
    if (!this.size) return;
    drawBowl(this.layer(this.bowl), this.size);
    drawHead(this.layer(this.head), this.size);
    drawShine(this.layer(this.shine), this.size);
  }

  setWin(k) {
    this.win = k;
    this.glow.hidden = k === null || k === undefined;
    if (!this.glow.hidden) {
      this.glow.style.transform = `rotate(${k * SEG}rad)`;
      this.glow.classList.remove('on');
      void this.glow.offsetWidth;
      this.glow.classList.add('on');
    }
  }

  render() {
    this.rotor.style.transform = `rotate(${this.angle}rad)`;
    this.ball.hidden = !this.ballOn;
    if (!this.ballOn || !this.size) return;
    const c = this.size / 2;
    const R = c - 2;
    const d = this.ballSize;
    const x = c + this.ballRadius * R * Math.sin(this.ballAngle) - d / 2;
    const y = c - this.ballRadius * R * Math.cos(this.ballAngle) - d / 2;
    // Cuando va rápido se estira un poco en la dirección del movimiento (barrido)
    const px = this.ballSpeed * this.ballRadius * R; // px por segundo
    const stretch = Math.min(2.4, 1 + px / (140 * d));
    this.ball.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${this.ballAngle.toFixed(4)}rad) scaleX(${stretch.toFixed(3)})`;
    this.ball.style.opacity = String(this.ballAlpha * (stretch > 1.05 ? 0.92 : 1));
  }
}

// ───────────────────────── El juego ─────────────────────────

function loadLastBets() {
  const raw = store.get('cpy_rl_last', null);
  if (!Array.isArray(raw)) return null;
  const map = new Map();
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    const [key, amount] = item;
    if (CELL_BY_KEY.has(key) && Number.isSafeInteger(amount) && amount > 0) map.set(key, amount);
  }
  return map.size ? map : null;
}

export function createRoulette(shell) {
  const { sound } = shell;
  const S = () => shell.state.settings;

  let el = null;
  let wheel = null;
  const bets = new Map(); // clave de la casilla → monto apostado
  const undoStack = [];
  let lastBets = loadLastBets(); // apuestas del último giro (para "Repetir")
  let chipValues = [];
  let chip = Number(store.get('cpy_rl_chip', 5000)) || 5000;
  let spinning = false; // desde que se manda la jugada hasta que la bolita se detiene
  let spin = null; // animación en curso
  let shownResult = null; // número marcado en la mesa (se limpia al tocar la mesa)
  const history = [];
  let narrow = null;
  let lastNow = 0;
  let press = null; // mantener apretado (celular) para sacar una ficha
  let pointerType = 'mouse';
  let hovered = null;

  const total = (map = bets) => {
    let t = 0;
    for (const v of map.values()) t += v;
    return t;
  };
  const betList = (map = bets) =>
    [...map].map(([key, amount]) => {
      const c = CELL_BY_KEY.get(key);
      return { type: c.type, value: c.value, amount };
    });
  const sameBets = (a, b) => {
    if (!a || !b || a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
  };
  const isPaused = () => S().game_roulette === false;

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function mount(root) {
    wheel = new Wheel();
    const hist = h('div', { class: 'rl-hist', 'aria-label': 'Últimos números' });
    const histEmpty = h('span', { class: 'rl-hist-empty' }, 'Acá vas a ver los últimos números');
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused = pausedNotice();
    const wheelWrap = h('div', { class: 'rl-wheel-wrap' }, wheel.el);
    const stage = h(
      'div',
      { class: 'gv-stage rl-stage' },
      h('div', { class: 'rl-top' }, h('span', { class: 'rl-top-label' }, 'Últimos'), hist, histEmpty),
      wheelWrap,
      result.el,
      winLayer,
      paused,
    );

    // Mesa
    const table = h('div', { class: 'rl-table', role: 'group', 'aria-label': 'Mesa de apuestas' });
    const cells = new Map();
    for (const c of CELLS) {
      const content = h('span', { class: 'rl-lbl' });
      if (c.diamond) content.innerHTML = DIAMOND(c.diamond); // dibujo propio (constante)
      else content.textContent = c.label;
      const badge = h('span', { class: 'rl-bet', hidden: true });
      const cls = `rl-cell rl-t-${c.type}${c.color ? ` rl-num rl-${c.color}` : ''}`;
      const btn = h('button', { class: cls, type: 'button', 'data-key': c.key, title: c.title, 'aria-label': c.name }, content, badge);
      btn.style.setProperty('--ha', c.ha);
      btn.style.setProperty('--va', c.va);
      table.append(btn);
      cells.set(c.key, { btn, badge, amount: 0, style: -1 });
    }
    table.addEventListener('click', (e) => {
      const btn = e.target.closest('.rl-cell');
      if (!btn) return;
      if (press && press.fired && press.btn === btn) {
        press = null;
        return;
      }
      sound._ensure();
      addChip(btn.dataset.key, btn);
    });
    table.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('.rl-cell');
      if (!btn) return;
      e.preventDefault();
      if (pointerType === 'mouse') removeChip(btn.dataset.key);
    });
    table.addEventListener('pointerdown', (e) => {
      pointerType = e.pointerType || 'mouse';
      if (press) clearTimeout(press.timer);
      press = null;
      const btn = e.target.closest('.rl-cell');
      if (!btn || pointerType === 'mouse') return;
      const p = { btn, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
      p.timer = setTimeout(() => {
        if (press !== p) return;
        p.fired = true;
        removeChip(btn.dataset.key);
        vibrate(25);
        setTimeout(() => press === p && (press = null), 900);
      }, 480);
      press = p;
    });
    const cancelPress = () => {
      if (press && !press.fired) {
        clearTimeout(press.timer);
        press = null;
      }
    };
    table.addEventListener('pointermove', (e) => {
      if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
    });
    table.addEventListener('pointerup', cancelPress);
    table.addEventListener('pointercancel', cancelPress);
    table.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const btn = e.target.closest('.rl-cell');
      if (!btn) return;
      e.preventDefault();
      removeChip(btn.dataset.key);
    });
    // Con el mouse encima de una apuesta externa se iluminan los números que cubre
    table.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'mouse') hover(e.target.closest('.rl-cell'));
    });
    table.addEventListener('pointerleave', () => hover(null));

    // Fichas, herramientas y botón principal (en el celular van en una barra fija abajo)
    const chips = h('div', { class: 'rl-chips', role: 'radiogroup', 'aria-label': 'Valor de la ficha' });
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.rl-chip');
      if (!b) return;
      sound._ensure();
      selectChip(Number(b.dataset.v));
    });
    const tool = (name, label, title, fn) => {
      const icon = h('span', { class: 'rl-tool-ic' });
      icon.innerHTML = ICONS[name]; // dibujo propio (constante)
      const b = h('button', { class: `rl-tool rl-tool-${name}`, type: 'button', title, 'aria-label': title }, icon, h('span', { class: 'rl-tool-tx' }, label));
      b.addEventListener('click', () => {
        sound._ensure();
        fn();
      });
      return b;
    };
    const undoBtn = tool('undo', 'Deshacer', 'Deshacer la última ficha', undo);
    const clearBtn = tool('clear', 'Limpiar', 'Sacar todas las fichas', clearBets);
    const dblBtn = tool('double', 'Doblar', 'Doblar todas las apuestas', doubleBets);
    const repeatBtn = tool('repeat', 'Repetir', 'Repetir las apuestas del último giro', repeatBets);
    const action = actionButton(() => onSpin());

    const dockChips = h('div', { class: 'rl-dock-row rl-dock-chips' });
    const dockGo = h('div', { class: 'rl-dock-row rl-dock-go' });
    const dock = h('div', { class: 'rl-dock' }, dockChips, dockGo);
    const board = h('div', { class: 'rl-board' }, table, dock);

    const chipLabel = h('b');
    const chipsSlot = h('div', { class: 'rl-chips-slot' });
    const chipBox = h('div', { class: 'rl-chipbox' }, h('div', { class: 'gv-label' }, h('span', null, 'Ficha'), chipLabel), chipsSlot);
    const tools = h('div', { class: 'rl-tools' });
    const statTotal = h('b');
    const statMax = h('b');
    const note = h('div', { class: 'gv-note', 'aria-live': 'polite' });
    const panel = h(
      'div',
      { class: 'gv-panel rl-panel' },
      panelHead(shell, { icon: '🎰', name: 'Ruleta' }),
      chipBox,
      tools,
      h(
        'div',
        { class: 'rl-sums' },
        h('div', null, h('span', null, 'Total apostado'), statTotal),
        h('div', { title: 'Lo máximo que podés cobrar con estas fichas si sale el mejor número' }, h('span', null, 'Premio máximo'), statMax),
      ),
      note,
    );

    const gv = h('div', { class: 'gv gv-roulette' }, stage, board, panel);
    root.append(gv);
    el = {
      root,
      gv,
      stage,
      wheelWrap,
      hist,
      histEmpty,
      result,
      winLayer,
      paused,
      table,
      cells,
      board,
      dock,
      dockChips,
      dockGo,
      chips,
      chipBox,
      chipsSlot,
      chipLabel,
      tools,
      undoBtn,
      clearBtn,
      dblBtn,
      repeatBtn,
      action,
      statTotal,
      statMax,
      note,
      panel,
    };

    placeControls(root.getBoundingClientRect().width < NARROW_BELOW);
    if ('ResizeObserver' in window) {
      new ResizeObserver((entries) => {
        const w = entries[0].contentRect.width;
        if (w > 0) placeControls(w < NARROW_BELOW);
      }).observe(root);
    }
    buildChips();
    renderHistory();
    renderBets(null, true);
    hint();
    render();
  }

  /** En el celular las fichas y GIRAR van en una barra pegada abajo; en la PC, en el panel. */
  function placeControls(isNarrow) {
    if (isNarrow === narrow) return;
    narrow = isNarrow;
    el.gv.classList.toggle('rl-narrow', narrow);
    el.gv.classList.toggle('rl-wide', !narrow);
    if (narrow) {
      el.dockChips.append(el.chips, el.undoBtn);
      el.dockGo.append(el.action.el);
      el.tools.append(el.clearBtn, el.dblBtn, el.repeatBtn);
    } else {
      el.chipsSlot.append(el.chips);
      el.tools.append(el.undoBtn, el.clearBtn, el.dblBtn, el.repeatBtn);
      el.panel.insertBefore(el.action.el, el.note);
    }
    if (!spinning && !shownResult) hint();
  }

  function hint() {
    if (!el) return;
    note(narrow ? 'Tocá la mesa para poner fichas · mantené apretado para sacar una' : 'Clic en la mesa: poner ficha · clic derecho: sacar una');
  }

  function note(text, kind = '') {
    el.note.textContent = text || '';
    el.note.className = `gv-note${kind ? ' ' + kind : ''}`;
  }

  // ───────────────────────── Fichas ─────────────────────────

  function chipStyle(amount) {
    let idx = 0;
    chipValues.forEach((v, i) => {
      if (amount >= v) idx = i;
    });
    return idx;
  }

  function buildChips() {
    chipValues = computeChips(S());
    if (!chipValues.includes(chip)) {
      const lower = chipValues.filter((v) => v <= chip);
      chip = lower.length ? lower[lower.length - 1] : chipValues[0];
    }
    el.chips.replaceChildren(
      ...chipValues.map((v, i) => {
        const st = CHIP_STYLES[Math.min(i, CHIP_STYLES.length - 1)];
        const label = compact(v);
        const b = h(
          'button',
          { class: `rl-chip${label.length >= 4 ? ' rl-long' : ''}`, type: 'button', role: 'radio', 'data-v': String(v), title: `Ficha de ${fmtGs(v)}`, 'aria-label': `Ficha de ${fmtGs(v)}` },
          h('span', null, label),
        );
        b.style.setProperty('--c', st.c);
        b.style.setProperty('--e', st.e);
        b.style.setProperty('--t', st.t);
        return b;
      }),
    );
    renderChips();
  }

  function selectChip(v) {
    if (!chipValues.includes(v)) return;
    chip = v;
    store.set('cpy_rl_chip', v);
    sound.click(1.25);
    renderChips();
  }

  function renderChips() {
    for (const b of el.chips.children) {
      const on = Number(b.dataset.v) === chip;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setText(el.chipLabel, fmtGs(chip));
  }

  // ───────────────────────── Apuestas en la mesa ─────────────────────────

  function bump(btn) {
    if (!btn) return;
    btn.classList.remove('rl-nope');
    void btn.offsetWidth;
    btn.classList.add('rl-nope');
  }

  /** Aviso sin repetir el mismo cartel si el jugador sigue tocando. */
  let lastWarn = { text: '', at: 0 };
  function warn(text, kind = 'error') {
    const now = Date.now();
    if (text === lastWarn.text && now - lastWarn.at < 2500) return;
    lastWarn = { text, at: now };
    toast(text, kind);
  }

  function canAfford(newTotal, what) {
    const s = S();
    if (newTotal > s.max_bet) {
      warn(`${what}: el máximo por giro es ${fmtGs(s.max_bet)}`);
      return false;
    }
    if (shell.state.user && newTotal > shell.balance) {
      warn('No te alcanza el saldo 😕 Cargá saldo para seguir jugando');
      return false;
    }
    return true;
  }

  function pushUndo() {
    undoStack.push(new Map(bets));
    if (undoStack.length > 80) undoStack.shift();
  }

  function addChip(key, btn) {
    if (spinning || isPaused()) return bump(btn);
    if (!bets.has(key) && bets.size >= MAX_BETS) {
      warn('Demasiadas apuestas en un solo giro');
      return bump(btn);
    }
    if (!canAfford(total() + chip, 'No entra otra ficha')) return bump(btn);
    pushUndo();
    bets.set(key, (bets.get(key) || 0) + chip);
    clearResult();
    sound.chip();
    vibrate(8);
    renderBets(key);
    render();
  }

  function removeChip(key) {
    if (spinning) return;
    const cur = bets.get(key);
    if (!cur) return;
    pushUndo();
    const next = cur - chip;
    if (next > 0) bets.set(key, next);
    else bets.delete(key);
    clearResult();
    sound.click(0.7);
    renderBets(key);
    render();
  }

  function setBets(map) {
    bets.clear();
    for (const [k, v] of map) bets.set(k, v);
    clearResult();
    renderBets();
    render();
  }

  function undo() {
    if (spinning || !undoStack.length) return;
    setBets(undoStack.pop());
    sound.cancel();
  }

  function clearBets() {
    if (spinning || !bets.size) return;
    pushUndo();
    setBets(new Map());
    sound.cancel();
  }

  function doubleBets() {
    if (spinning || !bets.size) return;
    if (!canAfford(total() * 2, 'No se puede doblar')) return;
    pushUndo();
    const next = new Map();
    for (const [k, v] of bets) next.set(k, v * 2);
    setBets(next);
    sound.chip();
    setTimeout(() => sound.chip(), 80);
  }

  function repeatBets() {
    if (spinning || !lastBets || sameBets(bets, lastBets)) return;
    if (!canAfford(total(lastBets), 'No se puede repetir')) return;
    pushUndo();
    setBets(new Map(lastBets));
    sound.chip();
  }

  /** Dibuja las fichas de la mesa (solo las que cambiaron, salvo que se pida todo). */
  function renderBets(onlyKey = null, force = false) {
    const keys = onlyKey ? [onlyKey] : CELLS.map((c) => c.key);
    for (const key of keys) {
      const cell = el.cells.get(key);
      const amount = bets.get(key) || 0;
      const style = amount ? chipStyle(amount) : -1;
      if (!force && amount === cell.amount && style === cell.style) continue;
      const grew = amount > cell.amount;
      cell.amount = amount;
      cell.style = style;
      const c = CELL_BY_KEY.get(key);
      cell.btn.classList.toggle('rl-has', amount > 0);
      cell.btn.setAttribute('aria-label', amount ? `${c.name}: ${fmtGs(amount)}` : c.name);
      if (!amount) {
        cell.badge.hidden = true;
        continue;
      }
      const st = CHIP_STYLES[Math.min(style, CHIP_STYLES.length - 1)];
      const label = compact(amount);
      cell.badge.textContent = label;
      cell.badge.classList.toggle('rl-long', label.length >= 4);
      cell.badge.style.setProperty('--c', st.c);
      cell.badge.style.setProperty('--e', st.e);
      cell.badge.style.setProperty('--t', st.t);
      cell.badge.hidden = false;
      if (grew && onlyKey) {
        cell.badge.classList.remove('rl-pop');
        void cell.badge.offsetWidth;
        cell.badge.classList.add('rl-pop');
      }
    }
  }

  function hover(btn) {
    if (btn === hovered) return;
    if (hovered) for (const n of CELL_BY_KEY.get(hovered.dataset.key).covers) el.cells.get(betKey('n', n)).btn.classList.remove('rl-cover');
    hovered = btn;
    if (!btn || btn.classList.contains('rl-num') || spinning) return;
    for (const n of CELL_BY_KEY.get(btn.dataset.key).covers) el.cells.get(betKey('n', n)).btn.classList.add('rl-cover');
  }

  /** Marca en la mesa el número que salió, las apuestas ganadoras y las perdedoras. */
  function showResult(n) {
    shownResult = { n };
    el.table.classList.add('rl-result');
    for (const c of CELLS) {
      const { btn } = el.cells.get(c.key);
      const has = (bets.get(c.key) || 0) > 0;
      const wins = c.covers.includes(n);
      btn.classList.toggle('rl-hit', c.type === 'n' && c.value === n);
      btn.classList.toggle('rl-won', has && wins);
      btn.classList.toggle('rl-lost', has && !wins);
      btn.classList.toggle('rl-area', !has && wins && c.type !== 'n');
    }
  }

  function clearResult() {
    if (!shownResult) return;
    shownResult = null;
    el.table.classList.remove('rl-result');
    for (const { btn } of el.cells.values()) btn.classList.remove('rl-hit', 'rl-won', 'rl-lost', 'rl-area');
  }

  function maxPayout() {
    if (!bets.size) return 0;
    const list = betList();
    let best = 0;
    for (let n = 0; n <= 36; n++) best = Math.max(best, core.roulettePayout(list, n));
    return Math.min(best, total() + S().max_profit);
  }

  function renderHistory(fresh = false) {
    el.hist.replaceChildren(
      ...history.map((n, i) => {
        const color = core.rouletteColor(n);
        return h('span', { class: `rl-hn rl-${color}${i === 0 ? ' rl-last' : ''}${i === 0 && fresh ? ' rl-new' : ''}`, title: `${n} ${COLOR_NAME[color]}` }, String(n));
      }),
    );
    el.histEmpty.hidden = history.length > 0;
  }

  function render() {
    if (!el) return;
    const t = total();
    const count = bets.size;
    const paused = isPaused();
    el.paused.hidden = !(paused && !spinning);
    el.board.classList.toggle('rl-off', paused && !spinning);
    el.table.classList.toggle('rl-lock', spinning);
    setText(el.statTotal, fmtGs(t));
    setText(el.statMax, fmtGs(maxPayout()));
    el.undoBtn.disabled = spinning || !undoStack.length;
    el.clearBtn.disabled = spinning || !count;
    el.dblBtn.disabled = spinning || !count;
    el.repeatBtn.disabled = spinning || !lastBets || sameBets(bets, lastBets);
    if (!shell.state.user) el.action.set({ text: 'GIRAR', detail: 'Ingresá para jugar' });
    else if (spinning) el.action.set({ text: 'GIRANDO…', detail: fmtGs(t), disabled: true });
    else if (paused) el.action.set({ text: 'GIRAR', detail: 'Juego en pausa', disabled: true });
    else if (!count) el.action.set({ text: 'GIRAR', detail: 'Poné tus fichas', disabled: true });
    else el.action.set({ text: 'GIRAR', detail: fmtGs(t) });
    shell.setNavBadge('roulette', spinning);
  }

  // ───────────────────────── Girar ─────────────────────────

  /** En el celular, si la rueda quedó fuera de la pantalla, sube para que se vea el giro. */
  function focusWheel() {
    if (!narrow) return;
    const r = el.stage.getBoundingClientRect();
    const bar = document.querySelector('.topbar');
    const top = (bar ? bar.offsetHeight : 56) + 6;
    if (r.top < top - 1 || r.top > window.innerHeight * 0.5) {
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - top), behavior: reduced() ? 'auto' : 'smooth' });
    }
  }

  async function onSpin() {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (spinning) return;
    const s = S();
    if (isPaused()) {
      toast('La ruleta está en pausa por un momento ⏸', 'error');
      return;
    }
    const list = betList();
    const t = total();
    if (!list.length) {
      toast('Poné al menos una ficha en la mesa 👇', 'info');
      return;
    }
    if (list.length > MAX_BETS) {
      toast('Demasiadas apuestas en un solo giro', 'error');
      return;
    }
    if (t < s.min_bet) {
      toast(`La apuesta mínima por giro es ${fmtGs(s.min_bet)} (sumando todas tus fichas)`, 'error');
      return;
    }
    if (t > s.max_bet) {
      toast(`La apuesta máxima por giro es ${fmtGs(s.max_bet)}`, 'error');
      return;
    }
    if (t > shell.balance) {
      toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return;
    }
    spinning = true;
    hover(null);
    clearResult();
    el.result.hide();
    note('No va más… 🎰');
    render();
    focusWheel();
    const sent = new Map(bets);
    const release = shell.lockBalance();
    const res = await shell.emit('roulette:spin', { bets: list });
    let revealBalance = () => {};
    if (res.ok) {
      revealBalance = shell.hideBalance(res.play.payout);
      shell.setBalance(res.balance);
    }
    release();
    if (!res.ok) {
      spinning = false;
      toast(res.error || 'No se pudo girar, probá de nuevo', 'error');
      hint();
      render();
      return;
    }
    lastBets = sent;
    store.set('cpy_rl_last', [...sent]);
    undoStack.length = 0;
    sound.bet();
    vibrate(15);
    startSpin(res.play, revealBalance);
  }

  function startSpin(play, revealBalance) {
    const p = planSpin(wheel, play.number, reduced());
    p.play = play;
    p.revealBalance = revealBalance;
    wheel.setWin(null);
    wheel.idle = false;
    spin = p;
    if (!shell.isVisible('roulette')) {
      finishSpin(true, true);
      return;
    }
    sound.rouletteBall(p.td + 0.45);
    render();
  }

  function stepSpin(now) {
    const p = spin;
    const t = Math.max(0, (now - p.start) / 1000);
    if (t >= p.T) {
      finishSpin(false);
      return;
    }
    const A = spinAngle(p, t);
    const b = ballAt(p, t, A);
    const dt = p.lastT === undefined ? 0 : t - p.lastT;
    wheel.ballSpeed = dt > 0 ? Math.abs(b.beta - p.lastBeta) / dt : 0;
    p.lastT = t;
    p.lastBeta = b.beta;
    wheel.angle = A;
    wheel.omega = spinOmega(p, t);
    wheel.ballOn = true;
    wheel.ballAngle = b.beta;
    wheel.ballRadius = b.rho;
    wheel.ballAlpha = b.alpha;
    while (p.tick < p.ticks.length && t >= p.ticks[p.tick]) {
      p.tick++;
      sound.wheelTick();
    }
    if (!p.revealed && t >= p.ts + 0.1) {
      wheel.setWin(p.k);
      reveal(p, false);
    }
    wheel.render();
  }

  /** Termina el giro al instante (por ejemplo si el jugador se fue a otro juego: away). */
  function finishSpin(silent, away = false) {
    const p = spin;
    if (!p) return;
    spin = null;
    const A = mod(spinAngle(p, p.T), TAU);
    wheel.angle = A;
    wheel.omega = 0;
    wheel.idle = false;
    wheel.ballOn = true;
    wheel.ballAngle = mod(A + p.k * SEG, TAU);
    wheel.ballRadius = RAD.ballPocket;
    wheel.ballAlpha = 1;
    wheel.ballSpeed = 0;
    wheel.setWin(p.k);
    wheel.render();
    if (!p.revealed) reveal(p, silent, away);
    render();
  }

  function reveal(p, silent, away = false) {
    p.revealed = true;
    spinning = false;
    p.revealBalance();
    const play = p.play;
    const n = play.number;
    const color = core.rouletteColor(n);
    const tag = `${n} ${COLOR_EMOJI[color]}`;
    history.unshift(n);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    renderHistory(!silent);
    showResult(n);
    wheel.el.setAttribute('aria-label', `Rueda de la ruleta: salió el ${n} ${COLOR_NAME[color]}`);
    const { payout, amount } = play;
    const big = payout > amount && isBigWin(payout, amount, play.multiplier);
    const straight = (play.params.bets || []).some((b) => b.type === 'n' && b.value === n);
    if (payout > amount) note(`🎉 Salió el ${tag} · cobraste ${fmtGs(payout)}`, 'good');
    else if (payout === amount) note(`Salió el ${tag} · recuperaste tu apuesta`);
    else if (payout > 0) note(`Salió el ${tag} · recuperaste ${fmtGs(payout)} de ${fmtGs(amount)}`);
    else note(`Salió el ${tag} · suerte la próxima 🍀`, 'bad');
    if (!silent) {
      if (payout > amount) {
        el.result.show({ win: true, head: tag, detail: `Ganaste ${fmtGs(payout)}`, big });
        winPop(el.winLayer, { amount: payout - amount, label: straight ? `¡Pleno al ${n}! 🎯` : `¡Salió el ${n}!`, big });
        if (big) confetti(el.stage);
        sound.win(big);
        vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
      } else if (payout > 0) {
        el.result.show({ win: payout === amount, head: tag, detail: payout === amount ? `Recuperaste ${fmtGs(payout)}` : `Cobraste ${fmtGs(payout)}` });
        sound.coin();
        vibrate(15);
      } else {
        el.result.show({ win: false, head: tag, detail: `Perdiste ${fmtGs(amount)}` });
        sound.lose();
        vibrate(40);
      }
    } else if (away || !shell.isVisible('roulette')) {
      toast(`🎰 Ruleta: salió el ${tag} · ${payout > 0 ? 'cobraste ' + fmtGs(payout) : 'perdiste ' + fmtGs(amount)}`, payout > amount ? 'win' : 'info');
    }
    shell.refreshMine();
    render();
  }

  function frame(now) {
    if (!wheel) return;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (spin) stepSpin(now);
    else if (wheel.idle && !reduced()) {
      wheel.angle = mod(wheel.angle + IDLE_SPEED * dt, TAU);
      wheel.omega = IDLE_SPEED;
      wheel.render();
    }
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
        li('Elegí el valor de la ficha y tocá la mesa para apostar. Podés poner fichas en varios lugares a la vez.'),
        li('Tocá ', h('b', null, 'GIRAR'), ': la bolita cae en uno de los 37 números (del 0 al 36).'),
        li('Cobrás cada apuesta que acierta. El premio incluye tu ficha:'),
      ),
      h(
        'ul',
        null,
        li(h('b', null, 'Pleno'), ' (un número, del 0 al 36): paga ', h('b', null, '36x'), ' (35 a 1 más tu ficha).'),
        li(h('b', null, 'Docena'), ' (1–12, 13–24, 25–36) o ', h('b', null, 'columna'), ' (2:1): paga ', h('b', null, '3x'), '.'),
        li(h('b', null, 'Rojo / negro'), ', ', h('b', null, 'par / impar'), ', ', h('b', null, '1–18 / 19–36'), ': paga ', h('b', null, '2x'), '.'),
        li('Si sale el ', h('b', null, '0'), ', pierden todas las apuestas externas (colores, par/impar, mitades, docenas y columnas).'),
        li('Es ruleta europea: tiene un solo 0.'),
        li('Tus fichas quedan en la mesa después de cada giro: tocá GIRAR para repetir la jugada. Con ↶ deshacés, con ×2 doblás todo y con ↻ repetís el último giro.'),
        li('Para sacar una ficha: clic derecho en la PC, o mantené apretada la casilla en el celular.'),
        li('El total de tus fichas en un giro tiene que estar entre la apuesta mínima y la máxima.'),
      ),
    );
  }

  return {
    id: 'roulette',
    mount,
    show() {
      lastNow = 0;
      if (wheel) wheel.resize();
      render();
    },
    hide() {
      if (spin) finishSpin(true, true);
      if (el) el.result.hide();
      hover(null);
      press = null;
    },
    onInit() {
      if (el) render();
    },
    onUser(user) {
      if (!user) {
        if (spin) finishSpin(true);
        history.length = 0;
        undoStack.length = 0;
      }
      if (el) {
        renderHistory();
        render();
      }
    },
    onSettings() {
      if (!el) return;
      buildChips();
      renderBets(null, true);
      render();
    },
    frame,
    loadMine: (container) => loadPlays(shell, container, 'roulette'),
    rules,
  };
}
