// 🎰 Ruleta europea EN VIVO (un solo 0): todos apuestan en la misma mesa durante la cuenta regresiva
// y una sola bolita decide para todos. Las fichas que ponés quedan "sin confirmar" hasta que tocás
// APOSTAR; mientras tanto ves en vivo lo que apuesta cada uno (jugadores y 🤖 bots).
// La rueda se dibuja en <canvas> (una capa fija, una que gira y el brillo) y la bolita es un
// elemento que se mueve con transform: así la animación es liviana incluso en celulares.
import { h, api, fmtGs, toast } from '../shared.js';
import {
  core,
  store,
  actionButton,
  winPop,
  confetti,
  pausedNotice,
  setText,
  setClass,
  vibrate,
  resultOverlay,
  panelHead,
  isBigWin,
  compact,
  ease,
  avatar,
  rouletteBetName,
  rouletteBetsLabel,
  rouletteBall,
  openRouletteRound,
  loadRouletteMine,
  ROULETTE_EMOJI,
  ROULETTE_COLOR_NAMES,
} from './common.js';

const TAU = Math.PI * 2;
const WHEEL = core.ROULETTE_WHEEL; // orden real, en sentido horario empezando por el 0
const SEG = TAU / WHEEL.length;
const MAX_SPOTS = 60; // lugares distintos de la mesa por ronda (igual que el servidor)
// Desde 540px de ancho la mesa horizontal ya entra: panel al costado, rueda y mesa abajo (PC en
// 1280px deja solo ~570px para el juego). Más angosto: mesa vertical y barra fija de fichas.
const NARROW_BELOW = 540;
const TIGHT_BELOW = 760; // por debajo, en la mesa horizontal cada número mide menos de ~48px
const IDLE_SPEED = 0.22; // rad/s: entre rondas la rueda gira despacito con la bolita en el último número
const LAND_EARLY = 600; // la bolita queda quieta un poco antes de que el servidor pague la ronda
const HIST_SHOW = 16; // números del historial en la tira de arriba
const MAX_ROWS = 40; // apuestas que se listan en "Apuestas de la ronda"
const EMPTY = new Map();
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
    for (let n = 0; n < core.ROULETTE_NUMBERS; n++) if (core.rouletteWins(c, n)) c.covers.push(n);
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
// El servidor avisa el número al empezar el giro. La rueda frena sola y el casillero ganador termina
// arriba; la bolita da vueltas al revés por la pista, pierde velocidad, baja, pega un par de saltitos y
// queda en el casillero justo un poco antes de que el servidor pague (LAND_EARLY). Todo sale de una
// función del tiempo desde que empezó el giro: quien entra con el giro empezado lo ve en el mismo punto.
// Durante la caída el ángulo de la bolita se calcula RELATIVO a la rueda, así el final siempre coincide.

const MOTION = {
  full: { dropDur: 1.45, stopAfter: 1.6, tr: 0.5, b: 2.2, vNom: 13, lift: 0.4, hit: 0.3, bounce: true, wobble: 1.15, minTurn: 2 * Math.PI, minPeak: 1.2 },
  // Con "reducir movimiento": la rueda queda quieta y la bolita se mueve solo en el último segundo y medio
  reduced: { dur: 1.6, dropDur: 0.6, stopAfter: 0.7, tr: 0.25, b: 2, vNom: 6.5, lift: 0.2, hit: 0.35, bounce: false, wobble: 0, minTurn: 0.5 * Math.PI, minPeak: 0.6 },
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

/**
 * Plan del giro. `landAt`: segundos desde `start` (performance.now() del inicio del giro) en que la
 * bolita tiene que quedar quieta. `now`: momento en que se arma el plan (si el giro ya venía empezado).
 */
function planSpin(wh, number, reducedMotion, landAt, start, now) {
  const M = reducedMotion ? MOTION.reduced : MOTION.full;
  const delay = reducedMotion ? Math.max(0, landAt - M.dur) : 0;
  const ts = Math.max(0.6, landAt - delay);
  const p = {
    ...M,
    k: WHEEL.indexOf(number),
    ts,
    td: Math.max(ts * 0.55, ts - M.dropDur),
    T: ts + M.stopAfter,
    start: start + delay * 1000,
    A0: wh.angle,
    w0: Math.max(0, wh.omega),
    tick: 0,
  };
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
  const late = (now - p.start) / 1000; // > 0 si el giro ya venía empezado
  p.beta0 = wh.ballOn ? wh.ballAngle : Math.random() * TAU;
  p.rho0 = wh.ballOn && late <= 0.05 ? wh.ballRadius : RAD.ballTrack;
  p.fade = !wh.ballOn || late > 0.05;
  p.fadeFrom = Math.max(0, late);
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
  while (p.tick < p.ticks.length && p.ticks[p.tick] < late) p.tick++;
  return p;
}

/** Posición de la bolita (ángulo en sentido horario desde arriba y radio) en el segundo t. */
function ballAt(p, t, A) {
  const alpha = p.fade ? Math.max(0, Math.min(1, (t - p.fadeFrom) / 0.3)) : 1;
  if (t < p.td) {
    const om = p.V0 * (p.tx / (p.c + 1)) * (1 - Math.pow(1 - t / p.tx, p.c + 1));
    let rho = RAD.ballTrack;
    if (p.rho0 < RAD.ballTrack && t < p.lift) rho = p.rho0 + (RAD.ballTrack - p.rho0) * ease.outCubic(t / p.lift);
    return { beta: p.beta0 - om, rho, alpha };
  }
  if (t >= p.ts) return { beta: A + p.k * SEG, rho: RAD.ballPocket, alpha };
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
  return { beta: A + p.k * SEG + rel, rho, alpha };
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
    this.ball = h('div', { class: 'rl-wl-ball', hidden: true });
    this.el.append(this.bowl, this.rotor, this.shine, this.ball);
    this.size = 0;
    this.dpr = 1;
    this.angle = Math.random() * TAU; // giro de la rueda (sentido horario)
    this.omega = 0;
    this.idle = true; // entre rondas gira despacito
    this.restK = null; // casillero donde descansa la bolita entre rondas
    this.ballOn = false;
    this.ballAngle = 0;
    this.ballRadius = RAD.ballTrack;
    this.ballAlpha = 1;
    this.ballSpeed = 0; // rad/s (para el "barrido" cuando va rápido)
    this.win = null;
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(this.el);
    else window.addEventListener('resize', () => this.resize());
    // Los números de la rueda usan Rubik: se redibuja cuando termina de cargar
    if (document.fonts && document.fonts.load) {
      document.fonts
        .load('800 20px Rubik')
        .then(() => this.size && this.draw())
        .catch(() => {});
    }
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
    const on = k !== null && k !== undefined && k >= 0;
    if (on === !this.glow.hidden && k === this.win) return;
    this.win = on ? k : null;
    this.glow.hidden = !on;
    if (on) {
      this.glow.style.transform = `rotate(${k * SEG}rad)`;
      this.glow.classList.remove('on');
      void this.glow.offsetWidth;
      this.glow.classList.add('on');
    }
  }

  /** Fin de un giro: la bolita queda en el casillero k, que termina arriba de todo. */
  rest(k) {
    if (k < 0) return;
    this.angle = mod(-k * SEG, TAU);
    this.omega = 0;
    this.restK = k;
    this.ride();
    this.render();
  }

  /** Entre rondas la bolita viaja con la rueda en su casillero. */
  ride() {
    if (this.restK === null || this.restK < 0) {
      this.ballOn = false;
      return;
    }
    this.ballOn = true;
    this.ballAngle = this.angle + this.restK * SEG;
    this.ballRadius = RAD.ballPocket;
    this.ballAlpha = 1;
    this.ballSpeed = 0;
  }

  render() {
    this.rotor.style.transform = `rotate(${this.angle}rad)`;
    if (this.ball.hidden === this.ballOn) this.ball.hidden = !this.ballOn;
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

const sumOf = (map) => {
  let t = 0;
  for (const v of map.values()) t += v;
  return t;
};

const mergeMaps = (a, b) => {
  const m = new Map(a);
  for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v);
  return m;
};

const toList = (map) =>
  [...map].map(([key, amount]) => {
    const c = CELL_BY_KEY.get(key);
    return { type: c.type, value: c.value, amount };
  });

const spotsMap = (bets) => {
  const m = new Map();
  for (const b of bets || []) {
    const key = betKey(b.type, b.value);
    if (CELL_BY_KEY.has(key) && b.amount > 0) m.set(key, (m.get(key) || 0) + b.amount);
  }
  return m;
};

export function createRoulette(shell) {
  const { socket, sound } = shell;
  const S = () => shell.state.settings;
  const myId = () => (shell.state.user ? shell.state.user.id : null);
  const isMine = (b) => !!b && !b.bot && myId() !== null && b.uid === myId();
  const visible = () => shell.isVisible('roulette');

  // ───────────────────────── Estado (se mantiene al día aunque el juego no esté en pantalla) ─────────────────────────

  const st = {
    phase: 'CONNECTING',
    paused: false,
    roundId: null,
    bettingMs: 20000,
    spinMs: 8000,
    resultMs: 5000,
    bettingEndsAt: 0, // performance.now() en que se cierran las apuestas
    nextAt: 0, // performance.now() en que arranca la próxima ronda (fase RESULT)
    history: [], // [{ id, result }] la más nueva primero (lo mismo para todos)
    bets: new Map(), // uid → apuesta de la ronda { id, uid, user, amount, bets, status, payout, bot? }
  };
  let mine = { roundId: null, spots: new Map(), amount: 0 }; // mis fichas CONFIRMADAS en la ronda
  const pending = new Map(); // fichas en la mesa todavía sin confirmar: clave → monto
  const undoStack = []; // estados anteriores de las fichas sin confirmar
  let lastConfirmed = loadLastBets(); // lo que confirmé en la ronda anterior (para "Repetir")
  let cur = null; // giro de la ronda { roundId, result, k, start, landAt, landed }
  let plan = null; // animación de la rueda para ese giro (solo con la pantalla armada)
  let shown = null; // resultado en la mesa con la bolita quieta { id, result }
  let landTimer = null;
  let releaseLock = null; // suelta el saldo congelado mientras gira
  let fallbackTimer = null;
  let pendingMine = null; // mi resultado si llegó antes de que la bolita quede quieta
  let resultNote = null; // { roundId, text, kind }
  let busy = false;
  let connLost = false;
  let last100 = null; // [{ id, result }] de las últimas 100 rondas
  let last100Loading = false;
  let betsDirty = true;
  let lastLive = 0;
  let liveSeen = null; // uid → monto ya mostrado (para resaltar apuestas nuevas)
  let crowd = new Map(); // casilla → { n, amount } de todos los jugadores
  let chipValues = [];
  let chip = Number(store.get('cpy_rl_chip', 5000)) || 5000;
  let el = null;
  let wheel = null;
  let narrow = null;
  let lastNow = 0;
  let lastTickSecond = -1;
  let press = null; // mantener apretado (celular) para sacar una ficha
  let pointerType = 'mouse';
  let hovered = null;

  const sameRound = () => mine.roundId !== null && mine.roundId === st.roundId;
  const mySpots = () => (sameRound() ? mine.spots : EMPTY);
  const myAmount = () => (sameRound() ? mine.amount : 0);
  const pendingTotal = () => sumOf(pending);
  const bettingLeft = (now = performance.now()) => Math.max(0, st.bettingEndsAt - now);
  const offline = () => S().game_roulette === false || st.paused || st.phase === 'PAUSED';
  const landing = () => !!(cur && !cur.landed);
  const midRound = () => landing() || st.phase === 'SPINNING' || st.phase === 'RESULT';
  const pausedView = () => offline() && !midRound();
  const canBet = () => !connLost && st.phase === 'BETTING' && !offline() && bettingLeft() > 0;
  const payoutOf = (bets, amount, n) => Math.min(core.roulettePayout(bets || [], n), amount + (Number(S().max_profit) || Infinity));

  function setMine(m) {
    mine = { roundId: m.roundId, spots: spotsMap(m.bets), amount: Number(m.amount) || 0 };
  }

  function saveLast(spots) {
    if (!spots || !spots.size) return;
    lastConfirmed = new Map(spots);
    store.set('cpy_rl_last', [...lastConfirmed]);
  }

  // ───────────────────────── Saldo ─────────────────────────
  // Mientras gira el saldo que se ve queda congelado: el premio aparece junto con el resultado.

  function lockBalance(ms) {
    if (!releaseLock) releaseLock = shell.lockBalance(ms);
  }

  function unlockBalance() {
    clearTimeout(fallbackTimer);
    if (!releaseLock) return;
    const release = releaseLock;
    releaseLock = null;
    release();
  }

  // ───────────────────────── Giro ─────────────────────────

  /** Arranca el giro de una ronda (`elapsed`: ms que ya pasaron si entramos con el giro empezado). */
  function beginSpin(roundId, result, elapsed = 0) {
    if (landing()) land(true);
    clearTimeout(landTimer);
    const start = performance.now() - Math.max(0, elapsed);
    const landAt = Math.max(0.8, (st.spinMs - LAND_EARLY) / 1000);
    cur = { roundId, result, k: WHEEL.indexOf(result), start, landAt, landed: false };
    shown = null;
    plan = null;
    const left = start + landAt * 1000 - performance.now();
    if (left <= 0) land(true);
    else landTimer = setTimeout(() => land(), left);
    makePlan();
  }

  function makePlan() {
    if (!wheel || !cur) return;
    const now = performance.now();
    const M = reduced() ? MOTION.reduced : MOTION.full;
    if (now >= cur.start + (cur.landAt + M.stopAfter) * 1000) {
      plan = null;
      wheel.rest(cur.k);
      if (cur.landed) wheel.setWin(cur.k);
      return;
    }
    plan = planSpin(wheel, cur.result, reduced(), cur.landAt, cur.start, now);
    wheel.idle = false;
    if (!cur.landed) wheel.setWin(null);
  }

  /** Muestra una ronda que ya terminó (por ejemplo al conectarse durante el resultado). */
  function showLanded(roundId, result) {
    if (landing()) land(true);
    clearTimeout(landTimer);
    cur = { roundId, result, k: WHEEL.indexOf(result), start: performance.now() - 60000, landAt: 0, landed: false };
    plan = null;
    land(true);
  }

  /** Si quedaba un giro a medias (ronda nueva, pausa…), se termina al instante. */
  function settleSpin() {
    if (landing()) land(true);
    clearTimeout(landTimer);
    if (plan && wheel && cur) wheel.rest(cur.k);
    plan = null;
  }

  function addResult(r) {
    const fresh = !st.history.some((x) => x.id === r.id);
    if (fresh) {
      st.history.unshift(r);
      if (st.history.length > 60) st.history.length = 60;
    }
    if (last100 && !last100.some((x) => x.id === r.id)) {
      last100.unshift(r);
      if (last100.length > 100) last100.length = 100;
    }
    return fresh;
  }

  /** La bolita quedó quieta: resultado en la mesa, historial y apuestas de todos. */
  function land(silent = false) {
    if (!cur || cur.landed) return;
    clearTimeout(landTimer);
    landTimer = null;
    cur.landed = true;
    const n = cur.result;
    shown = { id: cur.roundId, result: n };
    if (st.phase === 'SPINNING') st.nextAt = performance.now() + LAND_EARLY + st.resultMs;
    const fresh = addResult({ id: cur.roundId, result: n });
    for (const b of st.bets.values()) {
      if (b.status !== 'active') continue;
      b.payout = payoutOf(b.bets, b.amount, n);
      b.status = b.payout > 0 ? 'won' : 'lost';
    }
    betsDirty = true;
    const fx = !silent && !!el && visible();
    if (el && wheel) {
      if (!plan) wheel.rest(cur.k);
      wheel.setWin(cur.k);
      showResult(n);
      renderHistory(fresh && fx);
      renderStats();
      renderLive();
    }
    const d = pendingMine;
    pendingMine = null;
    if (d && d.roundId === cur.roundId) setTimeout(() => showMine(d), 220);
    else if (releaseLock) {
      // El aviso privado llega cuando el servidor paga (un instante después); si no llega, soltamos igual
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => unlockBalance(), 2500);
    }
    render();
  }

  /** Mi resultado de la ronda (con la bolita ya quieta). */
  function showMine(d) {
    unlockBalance();
    const n = d.result;
    const color = d.color || core.rouletteColor(n);
    const tag = `${n} ${ROULETTE_EMOJI[color]}`;
    const payout = Number(d.payout) || 0;
    const bet = Number(d.bet) || 0;
    const here = !!el && visible();
    const mult = bet ? Math.floor((payout * 100) / bet) : 0;
    const big = payout > bet && isBigWin(payout, bet, mult);
    const straight = mine.roundId === d.roundId && mine.spots.has(`n:${n}`);
    if (payout > bet) resultNote = { roundId: d.roundId, kind: 'good', text: `🎉 Salió el ${tag} · cobraste ${fmtGs(payout)}` };
    else if (payout > 0 && payout === bet) resultNote = { roundId: d.roundId, kind: '', text: `Salió el ${tag} · recuperaste tu apuesta` };
    else if (payout > 0) resultNote = { roundId: d.roundId, kind: '', text: `Salió el ${tag} · recuperaste ${fmtGs(payout)} de ${fmtGs(bet)}` };
    else resultNote = { roundId: d.roundId, kind: 'bad', text: `Salió el ${tag} · perdiste ${fmtGs(bet)}` };
    if (here) {
      if (payout > bet) {
        el.result.show({ win: true, head: tag, detail: `Ganaste ${fmtGs(payout)}`, big, ms: big ? 3200 : 2600 });
        if (big) {
          winPop(el.winLayer, { amount: payout - bet, label: straight ? `¡Pleno al ${n}! 🎯` : `¡Salió el ${n}!`, big });
          confetti(el.stage);
        }
        sound.win(big);
        vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
      } else if (payout > 0) {
        el.result.show({ win: payout === bet, head: tag, detail: payout === bet ? `Recuperaste ${fmtGs(payout)}` : `Cobraste ${fmtGs(payout)}` });
        sound.coin();
        vibrate(15);
      } else {
        el.result.show({ win: false, head: tag, detail: `Perdiste ${fmtGs(bet)}` });
        sound.lose();
        vibrate(40);
      }
    } else if (bet > 0) {
      toast(resultNote.text, payout > bet ? 'win' : 'info', '🎰 Ruleta');
    }
    shell.refreshMine();
    render();
  }

  /** Ronda nueva: lo confirmado pasa a ser "Repetir"; las fichas sin confirmar se quedan en la mesa. */
  function startRound(roundId) {
    if (mine.spots.size && mine.roundId !== roundId) saveLast(mine.spots);
    mine = { roundId, spots: new Map(), amount: 0 };
    cur = null;
    shown = null;
    pendingMine = null;
    resultNote = null;
    unlockBalance();
    liveSeen = new Map();
    if (wheel) {
      wheel.idle = true;
      wheel.setWin(null);
    }
    if (el) {
      el.result.hide();
      clearResult();
      renderTable();
    }
  }

  // ───────────────────────── Eventos del servidor ─────────────────────────

  function applySnapshot(d) {
    const g = d.roulette;
    if (!g) return;
    const now = performance.now();
    connLost = false;
    st.paused = !!g.paused;
    if (g.bettingMs) st.bettingMs = g.bettingMs;
    if (g.spinMs) st.spinMs = g.spinMs;
    if (g.resultMs) st.resultMs = g.resultMs;
    st.history = Array.isArray(g.history) ? g.history.map((r) => ({ id: r.id, result: r.result })) : [];
    st.bets = new Map((g.bets || []).map((b) => [String(b.uid), { ...b, bets: (b.bets || []).map((s) => ({ ...s })) }]));
    betsDirty = true;
    liveSeen = null; // no resaltar lo que ya estaba al conectarse
    const md = d.myRoulette;
    // Si se perdió el cambio de ronda (reconexión), lo confirmado antes queda para "Repetir"
    if (mine.spots.size && mine.roundId !== g.roundId) saveLast(mine.spots);
    if (md && md.roundId !== null && md.roundId !== undefined) setMine(md);
    else mine = { roundId: g.roundId, spots: new Map(), amount: 0 };
    const sameSpin = !!(cur && cur.roundId === g.roundId);
    st.phase = g.phase;
    st.roundId = g.roundId;
    // Si la bolita ya quedó quieta acá pero el servidor todavía no pagó, conservamos el resultado
    if (sameSpin && cur.landed) addResult({ id: cur.roundId, result: cur.result });
    switch (g.phase) {
      case 'BETTING':
        settleSpin();
        cur = null;
        shown = null;
        pendingMine = null;
        resultNote = null;
        unlockBalance();
        st.bettingEndsAt = now + (g.bettingLeft || 0);
        if (wheel) {
          wheel.idle = true;
          wheel.setWin(null);
        }
        break;
      case 'SPINNING':
        if (!sameSpin) beginSpin(g.roundId, g.result, g.spinElapsed || 0);
        else if (!plan) makePlan();
        if (landing() && myAmount() > 0) lockBalance(Math.max(0, cur.start + cur.landAt * 1000 - now) + 3500);
        break;
      case 'RESULT':
        st.nextAt = now + (g.nextIn || 0);
        if (!sameSpin) showLanded(g.roundId, g.result);
        break;
      default:
        // PAUSED / IDLE / STOPPED
        settleSpin();
        cur = null;
        shown = null;
        unlockBalance();
        if (wheel) wheel.idle = true;
    }
    if (wheel && wheel.restK === null && !cur && st.history.length) {
      wheel.restK = WHEEL.indexOf(st.history[0].result);
      wheel.ride();
    }
  }

  socket.on('roulette:betting', (d) => {
    if (!d) return;
    settleSpin();
    st.phase = 'BETTING';
    st.paused = false;
    st.roundId = d.roundId;
    if (d.ms) st.bettingMs = d.ms;
    st.bettingEndsAt = performance.now() + (d.ms || 0);
    st.bets.clear();
    betsDirty = true;
    startRound(d.roundId);
    if (el && visible()) renderLive();
    render();
  });

  socket.on('roulette:bet', (b) => {
    if (!b || b.uid === undefined || b.uid === null) return;
    st.bets.set(String(b.uid), { ...b, bets: (b.bets || []).map((s) => ({ ...s })) });
    betsDirty = true;
    // Mis fichas confirmadas desde otra pestaña (la confirmación de esta pestaña llega con la respuesta)
    if (isMine(b) && st.phase === 'BETTING' && !busy) {
      setMine({ roundId: st.roundId, bets: b.bets, amount: b.amount });
      if (el) renderTable();
      render();
    }
  });

  socket.on('roulette:spin', (d) => {
    if (!d) return;
    st.phase = 'SPINNING';
    st.roundId = d.roundId;
    if (d.ms) st.spinMs = d.ms;
    if (pending.size && shell.state.user && visible()) warn('Tus fichas sin confirmar no entraron en esta ronda: quedan para la próxima', 'info');
    if (myAmount() > 0) lockBalance((d.ms || st.spinMs) + 3500);
    beginSpin(d.roundId, d.result, 0);
    if (el && narrow && visible() && myAmount() > 0) revealWheel();
    if (visible() && plan && !reduced()) sound.rouletteBall(Math.max(1.2, plan.td + 0.4));
    render();
  });

  socket.on('roulette:result', (d) => {
    if (!d) return;
    st.phase = 'RESULT';
    st.roundId = d.roundId;
    st.nextAt = performance.now() + (d.nextIn || st.resultMs);
    // Si no vimos el giro (reconexión) mostramos el resultado directo; si la bolita sigue, termina sola
    if (!cur || cur.roundId !== d.roundId) showLanded(d.roundId, d.result);
    render();
  });

  socket.on('roulette:refund', (d) => {
    if (d && st.roundId !== null && d.roundId !== st.roundId) return;
    st.bets.clear();
    betsDirty = true;
    if (el && visible()) renderLive();
    render();
  });

  socket.on('roulette:paused', (d) => {
    if (!d) return;
    st.paused = !!d.paused;
    if (d.paused) {
      if (d.phase === 'SPINNING' || d.phase === 'RESULT') {
        if (visible()) toast('⏸ La ruleta se pausa al terminar esta ronda', 'info');
      } else st.phase = 'PAUSED';
    }
    render();
  });

  socket.on('myRoulette', (d) => {
    if (!d) return;
    if (d.refunded) {
      if (mine.roundId === d.roundId) {
        saveLast(mine.spots);
        mine = { roundId: d.roundId, spots: new Map(), amount: 0 };
      }
      unlockBalance();
      toast(`Te devolvimos ${fmtGs(d.bet)} de la Ruleta`, 'info', '↩ Apuesta devuelta');
      if (el) renderTable();
      render();
      shell.refreshMine();
      return;
    }
    // El servidor avisa al pagar: si la bolita todavía no quedó quieta, esperamos
    if (cur && cur.roundId === d.roundId && !cur.landed) pendingMine = d;
    else showMine(d);
  });

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function mount(root) {
    wheel = new Wheel();
    const hist = h('div', { class: 'rl-hist', 'aria-label': 'Últimos números (tocá uno para ver la ronda)' });
    const histEmpty = h('span', { class: 'rl-hist-empty' }, 'Todavía no hay rondas');
    const stMsg = h('span', { class: 'rl-st-msg', 'aria-live': 'polite' });
    const stAside = h('span', { class: 'rl-st-aside' });
    const stSecs = h('b', { class: 'rl-st-secs' });
    const stFill = h('i');
    const status = h('div', { class: 'rl-status' }, h('div', { class: 'rl-st-line' }, stMsg, stAside, stSecs), h('div', { class: 'rl-st-bar' }, stFill));
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused = pausedNotice();
    // El cartel del resultado va sobre el centro de la rueda: el casillero ganador (arriba) queda a la vista
    const wheelWrap = h('div', { class: 'rl-wheel-wrap' }, wheel.el, result.el);
    const stage = h(
      'div',
      { class: 'gv-stage rl-stage' },
      h('div', { class: 'rl-top' }, h('span', { class: 'rl-top-label' }, 'Últimos'), hist, histEmpty),
      status,
      wheelWrap,
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
      const crowdEl = h('span', { class: 'rl-crowd', hidden: true });
      const badge = h('span', { class: 'rl-bet', hidden: true });
      const plus = h('span', { class: 'rl-plus', hidden: true });
      const cls = `rl-cell rl-t-${c.type}${c.color ? ` rl-num rl-${c.color}` : ''}`;
      const btn = h('button', { class: cls, type: 'button', 'data-key': c.key, title: c.title, 'aria-label': c.name }, content, crowdEl, badge, plus);
      btn.style.setProperty('--ha', c.ha);
      btn.style.setProperty('--va', c.va);
      table.append(btn);
      cells.set(c.key, { btn, badge, plus, crowd: crowdEl, sig: '', crowdSig: '' });
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
        if (!pending.get(btn.dataset.key)) {
          press = null; // sin fichas para sacar: al soltar cuenta como un toque normal
          return;
        }
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
    const undoBtn = tool('undo', 'Deshacer', 'Deshacer la última ficha sin confirmar', undo);
    const clearBtn = tool('clear', 'Limpiar', 'Sacar las fichas sin confirmar', clearPending);
    const dblBtn = tool('double', 'Doblar', 'Doblar tus apuestas (queda sin confirmar)', doubleBets);
    const repeatBtn = tool('repeat', 'Repetir', 'Repetir lo que apostaste en la ronda anterior', repeatBets);
    const action = actionButton(() => confirmBets());

    const dockFill = h('i');
    const dockSecs = h('b');
    const dockTime = h('div', { class: 'rl-dock-time', 'aria-hidden': 'true' }, dockSecs, h('small', null, 'seg'));
    const dockChips = h('div', { class: 'rl-dock-row rl-dock-chips' });
    const dockGo = h('div', { class: 'rl-dock-row rl-dock-go' }, dockTime);
    const dock = h('div', { class: 'rl-dock' }, h('div', { class: 'rl-dock-bar', 'aria-hidden': 'true' }, dockFill), dockChips, dockGo);
    const board = h('div', { class: 'rl-board' }, table, dock);

    const chipLabel = h('b');
    const chipsSlot = h('div', { class: 'rl-chips-slot' });
    const chipBox = h('div', { class: 'rl-chipbox' }, h('div', { class: 'gv-label' }, h('span', null, 'Ficha'), chipLabel), chipsSlot);
    const tools = h('div', { class: 'rl-tools' });
    const sumMine = h('b');
    const sumPend = h('small', { class: 'rl-sum-pend', hidden: true });
    const sumMax = h('b');
    const note = h('div', { class: 'gv-note', 'aria-live': 'polite' });
    const panel = h(
      'div',
      { class: 'gv-panel rl-panel' },
      panelHead(shell, { icon: '🎰', name: 'Ruleta', seeds: false }),
      chipBox,
      tools,
      h(
        'div',
        { class: 'rl-sums' },
        h('div', { class: 'rl-sum-mine' }, h('span', null, 'Tu apuesta en esta ronda'), sumMine, sumPend),
        h('div', { title: 'Lo máximo que podés cobrar con tus fichas si sale el mejor número para vos' }, h('span', null, 'Premio posible'), sumMax),
      ),
      note,
    );

    // Apuestas de la ronda (en vivo) y estadísticas de las últimas rondas
    const liveCount = h('span');
    const liveTotal = h('b');
    const stats = h('div', { class: 'rl-stats', hidden: true });
    const liveList = h('div', { class: 'rl-live-list' });
    const live = h(
      'section',
      { class: 'rl-live', 'aria-label': 'Apuestas de la ronda' },
      h('div', { class: 'rl-live-head' }, h('span', { class: 'rl-live-title' }, 'Apuestas de la ronda'), h('span', { class: 'rl-live-sum' }, liveCount, ' · ', liveTotal)),
      liveList,
      stats,
    );

    const gv = h('div', { class: 'gv gv-roulette' }, stage, board, panel, live);
    root.append(gv);
    el = {
      root,
      gv,
      stage,
      wheelWrap,
      hist,
      histEmpty,
      status,
      stMsg,
      stAside,
      stSecs,
      stFill,
      result,
      winLayer,
      paused,
      table,
      cells,
      board,
      dock,
      dockFill,
      dockSecs,
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
      sumMine,
      sumPend,
      sumMax,
      note,
      panel,
      live,
      liveCount,
      liveTotal,
      liveList,
      stats,
      mode: '',
      hurry: false,
    };

    const fit = (w) => {
      // Mesa horizontal con casillas angostas: la marca de jugadores de cada casilla queda en un puntito
      gv.classList.toggle('rl-tight', w < TIGHT_BELOW);
      placeControls(w < NARROW_BELOW);
    };
    fit(root.getBoundingClientRect().width);
    if ('ResizeObserver' in window) {
      new ResizeObserver((entries) => {
        const w = entries[0].contentRect.width;
        if (w > 0) fit(w);
      }).observe(root);
    }
    buildChips();
    syncWheel();
    renderAll();
    loadLast100();
  }

  /** En el celular las fichas y APOSTAR van en una barra pegada abajo; en la PC, en el panel. */
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
    render();
  }

  /** Pone la rueda de acuerdo al estado de la ronda (al armar la pantalla o al reconectar). */
  function syncWheel() {
    if (!wheel) return;
    if (landing()) {
      if (!plan) makePlan();
      return;
    }
    if (plan) return; // la bolita ya quedó quieta y la rueda termina de frenar
    if (cur && cur.landed) {
      wheel.rest(cur.k);
      wheel.setWin(cur.k);
      wheel.idle = false;
      return;
    }
    wheel.setWin(null);
    wheel.idle = true;
    if (wheel.restK === null && st.history.length) {
      wheel.restK = WHEEL.indexOf(st.history[0].result);
      wheel.ride();
    }
    wheel.render();
  }

  /** Celular: si el jugador quedó abajo en la mesa cuando empieza el giro, le mostramos la rueda. */
  function revealWheel() {
    const r = el.wheelWrap.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const seen = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (!r.height || seen >= r.height * 0.6) return;
    el.wheelWrap.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  }

  function note(text, kind = '') {
    setText(el.note, text || '');
    setClass(el.note, `gv-note${kind ? ' ' + kind : ''}`);
  }

  // ───────────────────────── Fichas ─────────────────────────

  function chipStyle(amount) {
    let idx = 0;
    chipValues.forEach((v, i) => {
      if (amount >= v) idx = i;
    });
    return idx;
  }

  function paintChip(node, style) {
    const s = CHIP_STYLES[Math.min(style, CHIP_STYLES.length - 1)];
    node.style.setProperty('--c', s.c);
    node.style.setProperty('--e', s.e);
    node.style.setProperty('--t', s.t);
  }

  function buildChips() {
    chipValues = computeChips(S());
    const wanted = Number(store.get('cpy_rl_chip', chip)) || chip; // la ficha que eligió el jugador
    if (chipValues.includes(wanted)) chip = wanted;
    else {
      const lower = chipValues.filter((v) => v <= wanted);
      chip = lower.length ? lower[lower.length - 1] : chipValues[0];
    }
    el.chips.replaceChildren(
      ...chipValues.map((v, i) => {
        const label = compact(v);
        const b = h(
          'button',
          { class: `rl-chip${label.length >= 4 ? ' rl-long' : ''}`, type: 'button', role: 'radio', 'data-v': String(v), title: `Ficha de ${fmtGs(v)}`, 'aria-label': `Ficha de ${fmtGs(v)}` },
          h('span', null, label),
        );
        paintChip(b, i);
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

  // ───────────────────────── Fichas en la mesa (sin confirmar) ─────────────────────────

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

  /** ¿Se pueden tener estas fichas sin confirmar (además de las ya confirmadas)? */
  function fits(next, what) {
    const s = S();
    const conf = myAmount();
    const pend = sumOf(next);
    if (conf + pend > s.max_bet) {
      warn(`${what}: el máximo por ronda es ${fmtGs(s.max_bet)}${conf ? ` (ya confirmaste ${fmtGs(conf)})` : ''}`);
      return false;
    }
    if (shell.state.user && pend > shell.balance) {
      warn('No te alcanza el saldo 😕 Cargá saldo para seguir jugando');
      return false;
    }
    const all = mergeMaps(mySpots(), next);
    if (all.size > MAX_SPOTS) {
      warn('Demasiadas apuestas distintas en una misma ronda');
      return false;
    }
    const maxProfit = Number(s.max_profit) || 0;
    if (maxProfit && core.rouletteMaxPayout(toList(all)) - (conf + pend) > maxProfit) {
      warn(`Con esas fichas podrías ganar más de ${fmtGs(maxProfit)} (la ganancia máxima por ronda). Bajá lo que pusiste en los plenos.`);
      return false;
    }
    return true;
  }

  function pushUndo() {
    undoStack.push(new Map(pending));
    if (undoStack.length > 80) undoStack.shift();
  }

  function addChip(key, btn) {
    if (!canBet()) {
      bump(btn);
      if (connLost || pausedView()) return;
      warn(st.phase === 'BETTING' && bettingLeft() <= 0 ? '¡No va más! Las apuestas ya cerraron' : 'Esperá a que abran las apuestas de la próxima ronda ⏳', 'info');
      return;
    }
    const next = new Map(pending);
    next.set(key, (next.get(key) || 0) + chip);
    if (!fits(next, 'No entra otra ficha')) return bump(btn);
    pushUndo();
    pending.set(key, next.get(key));
    sound.chip();
    vibrate(8);
    renderCell(key, true);
    render();
  }

  function removeChip(key) {
    const pend = pending.get(key) || 0;
    if (!pend) {
      if (mySpots().get(key)) warn('Esas fichas ya están confirmadas: no se pueden sacar', 'info');
      return;
    }
    pushUndo();
    const left = pend - chip;
    if (left > 0) pending.set(key, left);
    else pending.delete(key);
    sound.click(0.7);
    renderCell(key);
    render();
  }

  function setPending(map) {
    pending.clear();
    for (const [k, v] of map) if (v > 0) pending.set(k, v);
    renderTable();
    render();
  }

  function undo() {
    if (!undoStack.length) return;
    setPending(undoStack.pop());
    sound.cancel();
  }

  function clearPending() {
    if (!pending.size) return;
    pushUndo();
    setPending(new Map());
    sound.cancel();
  }

  function doubleBets() {
    if (!canBet()) return;
    const base = mergeMaps(mySpots(), pending);
    if (!base.size) return;
    const next = new Map(pending);
    for (const [k, v] of base) next.set(k, (next.get(k) || 0) + v);
    if (!fits(next, 'No se puede doblar')) return;
    pushUndo();
    setPending(next);
    sound.chip();
    setTimeout(() => sound.chip(), 80);
  }

  function repeatBets() {
    if (!canBet() || !lastConfirmed || !lastConfirmed.size) return;
    const next = new Map(lastConfirmed);
    if (!fits(next, 'No se puede repetir')) return;
    pushUndo();
    setPending(next);
    sound.chip();
  }

  // ───────────────────────── Confirmar (APOSTAR) ─────────────────────────

  async function confirmBets() {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (busy) return;
    if (!canBet()) {
      toast(connLost ? 'Sin conexión con la mesa, esperá un momento' : pausedView() ? 'La ruleta está en pausa por un momento ⏸' : 'Las apuestas están cerradas, esperá la próxima ronda', 'info');
      return;
    }
    if (!pending.size) {
      toast('Poné tus fichas en la mesa y después tocá APOSTAR 👇', 'info');
      return;
    }
    const s = S();
    const sent = new Map(pending);
    const batch = sumOf(sent);
    if (batch < s.min_bet) {
      toast(`La apuesta mínima es ${fmtGs(s.min_bet)} por vez: sumá más fichas`, 'error');
      return;
    }
    if (!fits(sent, 'No se puede apostar')) return;
    busy = true;
    render();
    const res = await shell.emit('roulette:bet', { bets: toList(sent) });
    busy = false;
    if (!res.ok) {
      toast(res.error || 'No se pudo apostar, probá de nuevo', 'error');
      render();
      return;
    }
    // Lo enviado pasa a confirmado; lo que se sumó mientras tanto sigue sin confirmar
    for (const [k, v] of sent) {
      const left = (pending.get(k) || 0) - v;
      if (left > 0) pending.set(k, left);
      else pending.delete(k);
    }
    undoStack.length = 0;
    if (res.mine) setMine(res.mine);
    shell.setBalance(res.balance);
    sound.bet();
    vibrate(15);
    if (el) {
      // Destello verde en el botón (con la API de animaciones: el botón cambia de clase solo)
      if (el.action.el.animate && !reduced()) {
        el.action.el.animate([{ boxShadow: '0 0 0 0 rgba(46, 224, 123, 0.75)' }, { boxShadow: '0 0 0 16px rgba(46, 224, 123, 0)' }], { duration: 650, easing: 'ease-out' });
      }
      renderTable(true);
    }
    render();
  }

  // ───────────────────────── Dibujo de la mesa ─────────────────────────

  /** Ficha de una casilla: sólida si está confirmada, punteada si todavía no; "+X" si hay de las dos. */
  function renderCell(key, pop = false) {
    const cell = el.cells.get(key);
    const conf = mySpots().get(key) || 0;
    const pend = pending.get(key) || 0;
    const main = conf || pend;
    const style = main ? chipStyle(main) : -1;
    const sig = `${conf}|${pend}|${style}`;
    if (sig === cell.sig && !pop) return;
    cell.sig = sig;
    const c = CELL_BY_KEY.get(key);
    cell.btn.classList.toggle('rl-has', main > 0);
    let label = c.name;
    if (conf) label += `: ${fmtGs(conf)} confirmado`;
    if (pend) label += `${conf ? ' y' : ':'} ${fmtGs(pend)} sin confirmar`;
    cell.btn.setAttribute('aria-label', label);
    if (!main) {
      cell.badge.hidden = true;
      cell.plus.hidden = true;
      return;
    }
    const text = compact(main);
    cell.badge.textContent = text;
    cell.badge.classList.toggle('rl-long', text.length >= 4);
    cell.badge.classList.toggle('rl-pend', !conf);
    cell.badge.title = conf ? `Confirmado: ${fmtGs(conf)}` : `Sin confirmar: ${fmtGs(pend)}`;
    paintChip(cell.badge, style);
    cell.badge.hidden = false;
    if (conf && pend) {
      cell.plus.textContent = `+${compact(pend)}`;
      cell.plus.hidden = false;
    } else cell.plus.hidden = true;
    if (pop) {
      const target = conf && pend ? cell.plus : cell.badge;
      target.classList.remove('rl-pop');
      void target.offsetWidth;
      target.classList.add('rl-pop');
    }
  }

  function renderTable(force = false) {
    if (!el) return;
    for (const c of CELLS) {
      if (force) el.cells.get(c.key).sig = '';
      renderCell(c.key);
    }
  }

  /** Cuántos jugadores (y cuánto) hay en cada casilla: un puntito con el número en la esquina. */
  function renderCrowd() {
    for (const c of CELLS) {
      const cell = el.cells.get(c.key);
      const a = crowd.get(c.key);
      const sig = a ? `${a.n}|${a.amount}` : '';
      if (sig === cell.crowdSig) continue;
      cell.crowdSig = sig;
      cell.crowd.hidden = !a;
      if (a) cell.crowd.textContent = String(a.n);
      // La marca no recibe el mouse: el detalle va en el título de la casilla
      cell.btn.title = a ? `${c.title} · en juego: ${a.n} apuesta${a.n === 1 ? '' : 's'} (${fmtGs(a.amount)})` : c.title;
    }
  }

  function hover(btn) {
    if (btn === hovered) return;
    if (hovered) for (const n of CELL_BY_KEY.get(hovered.dataset.key).covers) el.cells.get(betKey('n', n)).btn.classList.remove('rl-cover');
    hovered = btn;
    if (!btn || btn.classList.contains('rl-num') || !canBet()) return;
    for (const n of CELL_BY_KEY.get(btn.dataset.key).covers) el.cells.get(betKey('n', n)).btn.classList.add('rl-cover');
  }

  /** Marca en la mesa el número que salió y cómo le fue a cada una de mis fichas confirmadas. */
  function showResult(n) {
    if (!el) return;
    const spots = mySpots();
    el.table.classList.add('rl-result');
    for (const c of CELLS) {
      const { btn } = el.cells.get(c.key);
      const has = (spots.get(c.key) || 0) > 0;
      const wins = c.covers.includes(n);
      btn.classList.toggle('rl-hit', c.type === 'n' && c.value === n);
      btn.classList.toggle('rl-won', has && wins);
      btn.classList.toggle('rl-lost', has && !wins);
      btn.classList.toggle('rl-area', !has && wins && c.type !== 'n');
    }
  }

  function clearResult() {
    if (!el) return;
    el.table.classList.remove('rl-result');
    for (const { btn } of el.cells.values()) btn.classList.remove('rl-hit', 'rl-won', 'rl-lost', 'rl-area');
  }

  function maxPossible() {
    const all = mergeMaps(mySpots(), pending);
    if (!all.size) return 0;
    return Math.min(core.rouletteMaxPayout(toList(all)), sumOf(all) + (Number(S().max_profit) || Infinity));
  }

  // ───────────────────────── Historial, estadísticas y apuestas de todos ─────────────────────────

  function renderHistory(animate = false) {
    if (!el) return;
    const items = st.history.slice(0, HIST_SHOW).map((r, i) => {
      const color = core.rouletteColor(r.result);
      return h(
        'button',
        {
          type: 'button',
          class: `rl-hbtn${i === 0 ? ' rl-last' : ''}${i === 0 && animate ? ' rl-new' : ''}`,
          title: `Ronda #${r.id} · ${r.result} ${ROULETTE_COLOR_NAMES[color]} (tocá para verla)`,
          'aria-label': `Ronda ${r.id}: salió el ${r.result} ${ROULETTE_COLOR_NAMES[color]}`,
          onclick: () => openRouletteRound(shell, r.id),
        },
        rouletteBall(r.result),
      );
    });
    el.hist.replaceChildren(...items);
    el.histEmpty.hidden = items.length > 0;
  }

  function renderStats() {
    if (!el) return;
    const list = (last100 || st.history).slice(0, 100);
    const n = list.length;
    el.stats.hidden = n < 5;
    if (n < 5) return;
    const byColor = { red: 0, black: 0, green: 0 };
    const freq = new Array(core.ROULETTE_NUMBERS).fill(0);
    for (const r of list) {
      byColor[core.rouletteColor(r.result)]++;
      freq[r.result]++;
    }
    const nums = [...freq.keys()];
    const hot = nums.slice().sort((a, b) => freq[b] - freq[a] || a - b).slice(0, 3);
    const cold = nums.slice().sort((a, b) => freq[a] - freq[b] || a - b).slice(0, 3);
    const pct = (c) => Math.round((byColor[c] * 100) / n);
    el.stats.replaceChildren(
      h('span', { class: 'rl-sx-label' }, `Últimas ${n} rondas`),
      h(
        'span',
        { class: 'rl-sx-group' },
        ...['red', 'black', 'green'].map((c) => h('span', { class: `rl-sx-pct rl-${c}`, title: `${ROULETTE_COLOR_NAMES[c]}: ${byColor[c]} de ${n}` }, h('i'), `${pct(c)}%`)),
      ),
      h('span', { class: 'rl-sx-group', title: 'Los que más salieron' }, h('span', { class: 'rl-sx-tag' }, '🔥 Calientes'), ...hot.map((x) => rouletteBall(x))),
      h('span', { class: 'rl-sx-group', title: 'Los que menos salieron' }, h('span', { class: 'rl-sx-tag' }, '🧊 Fríos'), ...cold.map((x) => rouletteBall(x))),
    );
  }

  async function loadLast100() {
    if (last100 || last100Loading) return;
    last100Loading = true;
    try {
      const { items } = await api('/api/roulette/rounds?limit=100&played=1');
      const list = items.filter((r) => r.status === 'ended').map((r) => ({ id: r.id, result: r.result }));
      // Rondas que terminaron mientras cargaba (o que la bolita ya mostró)
      for (const r of st.history.slice().reverse()) if (!list.length || r.id > list[0].id) list.unshift(r);
      last100 = list.slice(0, 100);
    } catch {
      /* se vuelve a intentar la próxima vez que se muestre el juego */
    }
    last100Loading = false;
    renderStats();
  }

  function liveRow(b, res, uid, animate) {
    const me = uid !== null && !b.bot && b.uid === uid;
    const settled = res !== null && b.status !== 'active';
    const fresh = animate && liveSeen.get(String(b.uid)) !== b.amount; // apuesta nueva o que creció
    let cls = 'rl-lr';
    if (b.bot) cls += ' bot';
    if (me) cls += ' me';
    if (settled) cls += b.payout > b.amount ? ' won' : b.payout > 0 ? ' part' : ' lost';
    if (fresh && !settled) cls += ' fresh';
    const name = String(b.user || '?');
    const clean = b.bot ? name.replace(/^\s*🤖\s*/u, '') || 'Bot' : name;
    const av = b.bot ? h('span', { class: 'avatar bot-avatar', title: 'Bot de la sala (no es un jugador real)' }, '🤖') : avatar(name, 26);
    const amount = settled && b.payout > 0 ? `+${fmtGs(b.payout)}` : fmtGs(b.amount);
    return h(
      'div',
      { class: cls, title: settled ? `${clean} · apostó ${fmtGs(b.amount)} · ${b.payout > 0 ? 'cobró ' + fmtGs(b.payout) : 'perdió'}` : `${clean} · ${fmtGs(b.amount)}` },
      av,
      h(
        'div',
        { class: 'rl-lr-main' },
        h('div', { class: 'rl-lr-name' }, h('span', null, clean), b.bot ? h('span', { class: 'bot-badge' }, 'BOT') : null, me ? h('span', { class: 'rl-lr-you' }, 'VOS') : null),
        h('div', { class: 'rl-lr-bets' }, rouletteBetsLabel(b.bets, 2)),
      ),
      h('div', { class: 'rl-lr-amt' }, amount),
    );
  }

  function renderLive() {
    if (!el) return;
    betsDirty = false;
    lastLive = performance.now();
    const uid = myId();
    const list = [...st.bets.values()]
      .filter((b) => b.status !== 'refunded' && b.amount > 0)
      .sort((a, b) => b.amount - a.amount || String(a.user).localeCompare(String(b.user)));
    let players = 0;
    let bots = 0;
    let total = 0;
    const agg = new Map();
    for (const b of list) {
      if (b.bot) bots++;
      else players++;
      total += b.amount;
      for (const s of b.bets || []) {
        const key = betKey(s.type, s.value);
        const a = agg.get(key) || { n: 0, amount: 0 };
        a.n++;
        a.amount += s.amount;
        agg.set(key, a);
      }
    }
    crowd = agg;
    // Los bots se cuentan aparte: nunca se hacen pasar por jugadores
    setText(el.liveCount, `👥 ${players} jugador${players === 1 ? '' : 'es'}${bots ? ` · 🤖 ${bots} bot${bots === 1 ? '' : 's'}` : ''}`);
    setText(el.liveTotal, fmtGs(total));
    const res = shown ? shown.result : null;
    const animate = !!liveSeen; // la primera vez (al conectarse) no se resalta nada
    if (!liveSeen) liveSeen = new Map();
    const rows = list.slice(0, MAX_ROWS).map((b) => liveRow(b, res, uid, animate));
    for (const b of list) liveSeen.set(String(b.uid), b.amount);
    if (list.length > MAX_ROWS) rows.push(h('div', { class: 'rl-live-more' }, `y ${list.length - MAX_ROWS} apuestas más`));
    if (!rows.length) rows.push(h('div', { class: 'rl-live-empty' }, st.phase === 'BETTING' ? 'Todavía nadie apostó en esta ronda.' : 'Sin apuestas en esta ronda'));
    el.liveList.replaceChildren(...rows);
    renderCrowd();
  }

  // ───────────────────────── Estado general ─────────────────────────

  function updateBadge() {
    shell.setNavBadge('roulette', myAmount() > 0 && !shown && (st.phase === 'BETTING' || st.phase === 'SPINNING'));
  }

  function renderNote() {
    let text = '';
    let kind = '';
    const conf = myAmount();
    const pend = pendingTotal();
    if (connLost) text = 'Reconectando con la mesa…';
    else if (pausedView()) text = '⏸ La ruleta está en pausa por un momento';
    else if (resultNote && shown && resultNote.roundId === shown.id) ({ text, kind } = resultNote);
    else if (!shell.state.user) text = pend ? 'Ingresá para confirmar tus fichas 🎯' : 'Ingresá para apostar 🎯';
    else if (canBet()) {
      if (pend) {
        text = `Tenés ${fmtGs(pend)} sin confirmar · tocá APOSTAR`;
        kind = 'warn';
      } else if (conf) {
        text = '✓ Apuesta confirmada · podés sumar más fichas';
        kind = 'good';
      } else text = narrow ? 'Tocá la mesa para poner fichas · mantené apretado para sacar' : 'Clic en la mesa: poner ficha · clic derecho: sacar una';
    } else if (landing() || st.phase === 'SPINNING') text = conf ? '🍀 ¡Suerte! Tu apuesta está en juego' : 'No va más · esperá la próxima ronda';
    else if (shown || st.phase === 'RESULT') text = pend ? 'Tus fichas sin confirmar quedan para la próxima ronda' : 'Apostá en la próxima ronda 🎯';
    else text = 'Esperando la próxima ronda…';
    note(text, kind);
  }

  /** Estado general (barato): botón principal, herramientas, totales, nota y pausa. */
  function render() {
    updateBadge();
    if (!el) return;
    const conf = myAmount();
    const pend = pendingTotal();
    const open = canBet();
    const paused = pausedView();
    el.paused.hidden = !paused;
    el.board.classList.toggle('rl-off', paused);
    el.table.classList.toggle('rl-lock', !open);
    setText(el.sumMine, fmtGs(conf));
    el.sumPend.hidden = !pend;
    if (pend) setText(el.sumPend, `+ ${fmtGs(pend)} sin confirmar`);
    setText(el.sumMax, fmtGs(maxPossible()));
    el.undoBtn.disabled = !undoStack.length;
    el.clearBtn.disabled = !pend;
    el.dblBtn.disabled = !open || !(conf + pend);
    el.repeatBtn.disabled = !open || !lastConfirmed || !lastConfirmed.size;
    const hurry = open && bettingLeft() <= 3000;
    if (!shell.state.user) el.action.set({ text: 'APOSTAR', detail: 'Ingresá para jugar' });
    else if (busy) el.action.set({ text: 'ENVIANDO…', detail: fmtGs(pend), disabled: true });
    else if (connLost) el.action.set({ text: 'APOSTAR', detail: 'Reconectando…', disabled: true });
    else if (paused) el.action.set({ text: 'APOSTAR', detail: 'Juego en pausa', disabled: true });
    else if (open) {
      if (pend) el.action.set({ text: 'APOSTAR', detail: fmtGs(pend), color: hurry ? 'orange' : '' });
      else el.action.set({ text: 'APOSTAR', detail: conf ? '✓ Apuesta confirmada' : 'Poné tus fichas', disabled: true });
    } else if (landing() || st.phase === 'SPINNING') el.action.set({ text: 'GIRANDO…', detail: conf ? `En juego: ${fmtGs(conf)}` : 'Apuestas cerradas', disabled: true });
    else el.action.set({ text: 'APOSTAR', detail: 'Esperá la próxima ronda', disabled: true });
    renderNote();
  }

  function renderAll() {
    if (!el) return;
    renderHistory(false);
    renderStats();
    renderTable(true);
    if (shown) showResult(shown.result);
    else clearResult();
    renderLive();
    el.mode = '';
    updateStatus(performance.now());
    render();
  }

  function statusMode(now) {
    if (connLost || st.phase === 'CONNECTING') return 'wait';
    if (pausedView()) return 'pause';
    if (landing()) return 'spin';
    if (shown) return 'result';
    if (st.phase === 'BETTING') return bettingLeft(now) > 0 ? 'bet' : 'closing';
    if (st.phase === 'SPINNING') return 'spin';
    return 'wait';
  }

  /** Cuenta regresiva / giro / resultado (en cada cuadro mientras el juego está a la vista). */
  function updateStatus(now) {
    const mode = statusMode(now);
    const key = mode === 'result' ? `result:${shown.id}` : mode;
    if (key !== el.mode) {
      el.mode = key;
      setClass(el.status, `rl-status m-${mode}${mode === 'result' ? ` rl-res-${core.rouletteColor(shown.result)}` : ''}`);
      el.dock.classList.toggle('rl-open', mode === 'bet');
      setText(el.stSecs, '');
      el.stMsg._t = null;
      if (mode === 'result') {
        const n = shown.result;
        el.stMsg.replaceChildren(h('span', { class: 'rl-st-ball' }, rouletteBall(n)), `Salió el ${n} · ${ROULETTE_COLOR_NAMES[core.rouletteColor(n)]}`);
      } else {
        const wait = connLost ? 'Reconectando…' : st.phase === 'CONNECTING' ? 'Conectando con la mesa…' : 'Esperando la próxima ronda…';
        setText(el.stMsg, { bet: 'Apuestas abiertas', closing: '¡No va más!', spin: '¡No va más! La bolita gira…', pause: '⏸ Juego en pausa', wait }[mode]);
      }
      render();
    }
    if (mode === 'bet') {
      const left = bettingLeft(now);
      const sec = Math.ceil(left / 1000);
      setText(el.stSecs, `${sec}s`);
      setText(el.dockSecs, String(sec));
      setText(el.stAside, st.roundId ? `Ronda #${st.roundId}` : '');
      const k = st.bettingMs ? Math.min(1, left / st.bettingMs) : 0;
      const tr = `scaleX(${k.toFixed(4)})`;
      el.stFill.style.transform = tr;
      el.dockFill.style.transform = tr;
      const hurry = sec <= 3;
      if (hurry !== el.hurry) {
        el.hurry = hurry;
        el.status.classList.toggle('hurry', hurry);
        el.dock.classList.toggle('hurry', hurry);
        render();
      }
      if (hurry && sec > 0 && sec !== lastTickSecond) {
        lastTickSecond = sec;
        sound.tick();
      }
      return;
    }
    if (el.hurry) {
      el.hurry = false;
      el.status.classList.remove('hurry');
      el.dock.classList.remove('hurry');
    }
    lastTickSecond = -1;
    if (mode === 'result') {
      // La barra muestra cuánto falta para la próxima ronda (en pantallas angostas es lo único que se ve)
      const left = st.nextAt - now;
      const s = Math.ceil(left / 1000);
      setText(el.stAside, st.paused ? 'La ruleta se pausa ⏸' : s > 0 ? `Nueva ronda en ${s}s` : 'Arranca la nueva ronda…');
      const k = st.paused ? 0 : Math.max(0, Math.min(1, left / (st.resultMs + LAND_EARLY)));
      el.stFill.style.transform = `scaleX(${k.toFixed(4)})`;
    } else setText(el.stAside, (mode === 'spin' || mode === 'closing') && st.roundId ? `Ronda #${st.roundId}` : '');
  }

  // ───────────────────────── Animación ─────────────────────────

  function stepPlan(now) {
    const p = plan;
    const t = (now - p.start) / 1000;
    if (t < 0) return; // reducir movimiento: todavía no arranca
    if (t >= p.T) {
      plan = null;
      wheel.rest(p.k);
      if (shown) wheel.setWin(p.k);
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
    if (landing() && t >= p.ts) land();
    wheel.render();
  }

  function frame(now) {
    if (!el || !wheel) return;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (!plan && landing()) makePlan();
    if (plan) stepPlan(now);
    else if (wheel.idle && !reduced()) {
      wheel.omega += (IDLE_SPEED - wheel.omega) * Math.min(1, dt * 1.2);
      wheel.angle = mod(wheel.angle + wheel.omega * dt, TAU);
      wheel.ride();
      wheel.render();
    }
    updateStatus(now);
    if (betsDirty && now - lastLive > 200) renderLive();
  }

  // ───────────────────────── Reglas ─────────────────────────

  function rules() {
    const s = S();
    const li = (...c) => h('li', null, ...c);
    const secs = Math.round((st.bettingMs || 20000) / 1000);
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('La Ruleta es ', h('b', null, 'en vivo'), ': todos juegan la misma ronda y una sola bolita decide para todos.'),
        li(`Cada ronda arranca con una cuenta regresiva de ${secs} segundos. Elegí el valor de la ficha y tocá la mesa: esas fichas quedan `, h('b', null, 'sin confirmar'), ' (punteadas).'),
        li('Tocá ', h('b', null, 'APOSTAR'), ' para confirmarlas antes de que termine la cuenta. Podés confirmar varias veces en la misma ronda.'),
        li('Las fichas confirmadas ya no se pueden sacar. Las que no confirmaste a tiempo no entran: quedan en la mesa para la ronda siguiente.'),
        li('Cuando termina la cuenta, la bolita gira y cae en uno de los 37 números (del 0 al 36). Cobrás cada apuesta que acierta, con tu ficha incluida:'),
      ),
      h(
        'ul',
        null,
        li(h('b', null, 'Pleno'), ' (un número, del 0 al 36): paga ', h('b', null, '36x'), ' (35 a 1 más tu ficha).'),
        li(h('b', null, 'Docena'), ' (1–12, 13–24, 25–36) o ', h('b', null, 'columna'), ' (2:1): paga ', h('b', null, '3x'), '.'),
        li(h('b', null, 'Rojo / negro'), ', ', h('b', null, 'par / impar'), ', ', h('b', null, '1–18 / 19–36'), ': paga ', h('b', null, '2x'), '.'),
        li('Si sale el ', h('b', null, '0'), ', pierden todas las apuestas externas (colores, par/impar, mitades, docenas y columnas).'),
        li('Es ruleta europea: tiene un solo 0.'),
        li(`Cada confirmación es de al menos ${fmtGs(s.min_bet)}; en total podés tener hasta ${fmtGs(s.max_bet)} por ronda y ganar hasta ${fmtGs(s.max_profit)}.`),
        li('Herramientas: ↶ deshace la última ficha sin confirmar, ×2 dobla todo lo que tenés en la mesa y ↻ repite lo que confirmaste en la ronda anterior (quedan sin confirmar hasta que toques APOSTAR).'),
        li('Para sacar una ficha sin confirmar: clic derecho en la PC, o mantené apretada la casilla en el celular.'),
        li('Abajo ves en vivo lo que apuesta cada uno. Los jugadores con 🤖 son bots de la sala.'),
        li(
          'Juego comprobable: cada ronda sale de una cadena de hashes publicada de antemano. El número es HMAC_SHA256(sal, hash de la ronda) → primeros 52 bits → 0 a 36. Tocá cualquier número del historial para ver la ronda y verificarla, o entrá a ',
          h('a', { href: '/fair' }, 'la página de verificación'),
          '.',
        ),
      ),
    );
  }

  // ───────────────────────── Interfaz para la app ─────────────────────────

  return {
    id: 'roulette',
    mount,
    show() {
      lastNow = 0;
      if (wheel) {
        wheel.resize();
        syncWheel();
      }
      renderAll();
      loadLast100();
    },
    hide() {
      if (el) el.result.hide();
      hover(null);
      press = null;
    },
    onInit(d) {
      applySnapshot(d);
      if (el) {
        syncWheel();
        renderAll();
      } else updateBadge();
    },
    onUser(user) {
      if (!user) {
        mine = { roundId: st.roundId, spots: new Map(), amount: 0 };
        pending.clear();
        undoStack.length = 0;
        busy = false;
        pendingMine = null;
        resultNote = null;
        unlockBalance();
      }
      betsDirty = true;
      if (el) {
        renderTable();
        render();
      } else updateBadge();
    },
    onSettings() {
      if (!el) return;
      buildChips();
      renderTable(true);
      render();
    },
    onDisconnect() {
      connLost = true;
      if (el) render();
    },
    frame,
    loadMine: (container) => loadRouletteMine(shell, container),
    rules,
  };
}
