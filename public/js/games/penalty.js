// ⚽ Penales de la Albirroja: 5 penales contra el arquero rival. Cada gol sube el multiplicador;
// retirás cuando quieras, pero si el arquero ataja perdés la apuesta.
import { h, fmtGs, fmtMult, toast } from '../shared.js';
import { core, AmountControl, actionButton, winPop, confetti, pausedNotice, loadPlays, setText, setClass, vibrate, resultOverlay, panelHead, isBigWin, ease, reducedMotion, sleep } from './common.js';

const KICKS = core.PENALTY_KICKS; // 5 penales
const ZONES = core.PENALTY_ZONES; // 0 = izquierda, 1 = centro, 2 = derecha
const ZONE_NAMES = ['izquierda', 'centro', 'derecha'];
const ZONE_ARROWS = ['←', '↑', '→'];
const ALBIRROJA = ['#d52b1e', '#ffffff', '#0038a8'];

// ───────────────────────── Geometría de la escena (unidades del viewBox) ─────────────────────────
// Zona segura que siempre se ve: x 40…440, y 0…360. El viewBox se ajusta al tamaño del escenario.
const SAFE = { cx: 240, w: 400, h: 360, bottom: 360 };
const SPOT = { x: 240, y: 325 }; // punto penal
const VP = { x: 240, y: 101 }; // punto de fuga (profundidad del arco)
const KEEPER_X = 240;
const KEEPER_Y = 180;
const KEEPER_PIVOT = -38; // centro del cuerpo del arquero (coordenadas locales)
// Dónde queda el arquero cuando se tira a cada zona
const DIVES = [
  { tx: -68, ty: -9, rot: -78, pose: 'dive' },
  { tx: 0, ty: -8, rot: 0, pose: 'jump' },
  { tx: 68, ty: -9, rot: 78, pose: 'dive' },
];
const ZONE_X = [
  [92, 197.7],
  [197.7, 282.3],
  [282.3, 388],
];
const MOUTH = [113, 197.7, 282.3, 367]; // divisiones de la boca del arco
const CROSS = [
  { x: 155.3, y: 136 },
  { x: 240, y: 128 },
  { x: 324.7, y: 136 },
];

const n2 = (v) => Math.round(v * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const quad = (a, c, b, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;

/** Pseudoaleatorio con semilla (solo para dibujar la hinchada siempre igual). */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Punto del cuerpo del arquero (coordenadas locales) → coordenadas de la escena, para una pose. */
function keeperPoint(pose, lx, ly) {
  const a = (pose.rot * Math.PI) / 180;
  const dx = lx;
  const dy = ly - KEEPER_PIVOT;
  return {
    x: KEEPER_X + pose.tx + dx * Math.cos(a) - dy * Math.sin(a),
    y: KEEPER_Y + pose.ty + KEEPER_PIVOT + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

// ───────────────────────── Dibujos (constantes nuestras, sin datos del usuario) ─────────────────────────

/** La hinchada: miles de puntitos agrupados por color en pocos <path>. */
function crowdMarkup() {
  const rand = seeded(1811);
  const shirts = ['#d52b1e', '#d52b1e', '#d52b1e', '#b81d22', '#eef1f8', '#eef1f8', '#dde3f1', '#1d4fc2', '#0038a8', '#272e52', '#343b64'];
  const skins = ['#23160e', '#23160e', '#3a2618', '#5e3d27', '#9c6d48'];
  const bodies = new Map();
  const heads = new Map();
  let arms = '';
  const add = (map, key, d) => map.set(key, (map.get(key) || '') + d);
  const tiers = [
    { y0: 45, rows: 6, dy: 6.3, dx: 6.2, hr: 1.7, bw: 4.4, bh: 3.8 },
    { y0: 97, rows: 7, dy: 6.9, dx: 7.1, hr: 2.05, bw: 5.3, bh: 4.6 },
  ];
  for (const t of tiers) {
    for (let r = 0; r < t.rows; r++) {
      const y = t.y0 + r * t.dy;
      for (let x = -170 + (r % 2) * t.dx * 0.5; x < 650; x += t.dx) {
        if (rand() < 0.05) continue; // asiento vacío
        const jx = x + (rand() - 0.5) * 1.6;
        const jy = y + (rand() - 0.5) * 1.1;
        const w = t.bw;
        add(bodies, shirts[Math.floor(rand() * shirts.length)], `M${n2(jx - w / 2)} ${n2(jy + t.bh)}v${n2(1.2 - t.bh)}q0-1.2 1.2-1.2h${n2(w - 2.4)}q1.2 0 1.2 1.2v${n2(t.bh - 1.2)}z`);
        const r0 = t.hr;
        const cy = jy - r0 * 0.7;
        add(heads, skins[Math.floor(rand() * skins.length)], `M${n2(jx - r0)} ${n2(cy)}a${r0} ${r0} 0 1 0 ${n2(2 * r0)} 0a${r0} ${r0} 0 1 0 ${n2(-2 * r0)} 0`);
        if (rand() < 0.07) arms += `M${n2(jx - w / 2 + 0.6)} ${n2(jy + 0.6)}l-1.3-4.4M${n2(jx + w / 2 - 0.6)} ${n2(jy + 0.6)}l1.3-4.4`;
      }
    }
  }
  let out = '';
  for (const [c, d] of bodies) out += `<path fill="${c}" d="${d}"/>`;
  for (const [c, d] of heads) out += `<path fill="${c}" d="${d}"/>`;
  out += `<path d="${arms}" stroke="#b88258" stroke-width="1.2" stroke-linecap="round" fill="none"/>`;
  return out;
}

/** Torre de reflectores con su resplandor. */
function lampMarkup(x) {
  let lamps = '';
  for (let row = 0; row < 2; row++) for (let i = 0; i < 6; i++) lamps += `<circle cx="${n2(x - 17.5 + i * 7)}" cy="${n2(12.5 + row * 6)}" r="2.3"/>`;
  return `
    <circle cx="${x}" cy="16" r="92" fill="url(#pnGlow)"/>
    <path d="M${x - 16} 25 L${x + 16} 25 L${x + 118} 250 L${x - 96} 250Z" fill="url(#pnBeam)"/>
    <path d="M${x - 5} 25 L${x - 9} 40 M${x + 5} 25 L${x + 9} 40" stroke="#1d2340" stroke-width="2.4"/>
    <rect x="${x - 23}" y="7" width="46" height="18" rx="3" fill="#1b2136" stroke="#39436e" stroke-width="0.8"/>
    <g fill="#fffdf2">${lamps}</g>
    <ellipse cx="${x}" cy="16" rx="58" ry="1.6" fill="#fff" opacity="0.45"/>
    <circle cx="${x}" cy="16" r="26" fill="url(#pnCore)"/>`;
}

/** Fondo fijo: cielo, reflectores, tribunas, carteles, cancha y líneas. */
function bgMarkup() {
  const rand = seeded(1935);
  let stars = '';
  for (let i = 0; i < 46; i++) {
    stars += `<circle cx="${n2(-320 + rand() * 1120)}" cy="${n2(-380 + rand() * 402)}" r="${n2(0.4 + rand() * 0.8)}" opacity="${n2(0.25 + rand() * 0.6)}"/>`;
  }
  // Franjas del césped (más anchas cuanto más cerca de la cámara)
  const cuts = [166, 171.6, 180, 193.6, 208.5, 223.2, 242.6, 269.2, 299, 341.5, 381.6, 440, 520, 640];
  let stripes = '';
  for (let i = 0; i + 1 < cuts.length; i += 2) stripes += `M-500 ${cuts[i]}H980V${cuts[i + 1]}H-500Z`;
  let roofLights = '';
  for (let x = -176; x < 660; x += 58) {
    roofLights += `<circle cx="${x}" cy="31" r="17" fill="url(#pnGlow)"/><circle cx="${x}" cy="31" r="1.6" fill="#fffbea"/>`;
  }
  let boards = '';
  const texts = ['CRASHPY', 'VAMOS ALBIRROJA', 'CRASHPY', '¡DALE PARAGUAY!'];
  for (let i = 0; i < 9; i++) {
    const x = -200 + i * 112;
    boards += `<rect x="${x}" y="151.5" width="3" height="9" fill="#d52b1e"/><rect x="${x + 3}" y="151.5" width="3" height="9" fill="#fff"/><rect x="${x + 6}" y="151.5" width="3" height="9" fill="#2f6bff"/>`;
    boards += `<text x="${x + 13}" y="159.6">${texts[i % texts.length]}</text>`;
  }
  return `
<svg class="pn-bg" xmlns="http://www.w3.org/2000/svg" viewBox="40 0 400 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="pnSky" x1="0" y1="-420" x2="0" y2="40" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#010208"/><stop offset="0.72" stop-color="#060a1f"/><stop offset="1" stop-color="#121a45"/>
    </linearGradient>
    <radialGradient id="pnGlow"><stop offset="0" stop-color="#fff6d8" stop-opacity="0.55"/><stop offset="0.35" stop-color="#cfd8ff" stop-opacity="0.18"/><stop offset="1" stop-color="#cfd8ff" stop-opacity="0"/></radialGradient>
    <radialGradient id="pnCore"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff6d8" stop-opacity="0"/></radialGradient>
    <linearGradient id="pnBeam" x1="0" y1="25" x2="0" y2="250" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e8eeff" stop-opacity="0.13"/><stop offset="1" stop-color="#e8eeff" stop-opacity="0"/></linearGradient>
    <linearGradient id="pnUpper" x1="0" y1="38" x2="0" y2="84" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03050f" stop-opacity="0.75"/><stop offset="1" stop-color="#03050f" stop-opacity="0.3"/></linearGradient>
    <linearGradient id="pnBoard" x1="0" y1="146" x2="0" y2="166" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0d2a7a"/><stop offset="1" stop-color="#061336"/></linearGradient>
    <linearGradient id="pnPitch" x1="0" y1="160" x2="0" y2="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b4524"/><stop offset="0.45" stop-color="#11703a"/><stop offset="1" stop-color="#138a42"/></linearGradient>
    <radialGradient id="pnPool"><stop offset="0" stop-color="#e9ffe9" stop-opacity="0.13"/><stop offset="1" stop-color="#e9ffe9" stop-opacity="0"/></radialGradient>
    <linearGradient id="pnHaze" x1="0" y1="140" x2="0" y2="200" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9fb4ff" stop-opacity="0"/><stop offset="0.5" stop-color="#9fb4ff" stop-opacity="0.07"/><stop offset="1" stop-color="#9fb4ff" stop-opacity="0"/></linearGradient>
    <linearGradient id="pnFloor" x1="0" y1="290" x2="0" y2="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.34"/></linearGradient>
  </defs>
  <rect x="-500" y="-500" width="1480" height="540" fill="url(#pnSky)"/>
  <g fill="#ffffff">${stars}</g>
  <ellipse cx="240" cy="34" rx="560" ry="70" fill="#3b4fb0" opacity="0.12"/>
  <path d="M-500 26H980V38H-500Z" fill="#0a0e21"/>
  <path d="M-500 37.4H980" stroke="#2c3668" stroke-width="1.2"/>
  <path d="M-500 38H980V84H-500Z" fill="#121838"/>
  <path d="M-500 92H980V147H-500Z" fill="#151b3d"/>
  <g class="pn-crowd">${crowdMarkup()}</g>
  <path d="M-500 38H980V84H-500Z" fill="url(#pnUpper)"/>
  <path d="M-500 92H980V147H-500Z" fill="#05081a" opacity="0.3"/>
  <g>${roofLights}</g>
  <path d="M-500 84H980V92H-500Z" fill="#0c112c"/>
  <path d="M-500 85.3H980" stroke="#d52b1e" stroke-width="1.3"/>
  <path d="M-500 87.3H980" stroke="#f1f3fa" stroke-width="1.3"/>
  <path d="M-500 89.3H980" stroke="#2456d6" stroke-width="1.3"/>
  ${[-150, 70, 410, 630].map(lampMarkup).join('')}
  <path d="M-500 146H980V166H-500Z" fill="url(#pnBoard)"/>
  <path d="M-500 146.6H980" stroke="#5b8dff" stroke-opacity="0.7" stroke-width="1"/>
  <g class="pn-boards" fill="#f4f7ff" font-size="8.4" font-weight="800" font-style="italic" letter-spacing="0.4">${boards}</g>
  <path d="M-500 166H980V700H-500Z" fill="url(#pnPitch)"/>
  <path d="${stripes}" fill="#eaffea" opacity="0.05"/>
  <ellipse cx="30" cy="236" rx="230" ry="80" fill="url(#pnPool)"/>
  <ellipse cx="450" cy="236" rx="230" ry="80" fill="url(#pnPool)"/>
  <ellipse cx="240" cy="300" rx="200" ry="70" fill="url(#pnPool)"/>
  <path d="M-500 140H980V200H-500Z" fill="url(#pnHaze)"/>
  <g stroke="#f3f6ff" stroke-opacity="0.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-500 180.6H980" stroke-width="1.7"/>
    <path d="M-248 218.2L-90 180.6M-248 218.2H728L570 180.6" stroke-width="2.1"/>
  </g>
  <ellipse cx="240" cy="327.5" rx="7" ry="2.4" fill="#f3f6ff" opacity="0.88"/>
  <path d="M-500 290H980V700H-500Z" fill="url(#pnFloor)"/>
</svg>`;
}

function pentagon(cx, cy, r, rotDeg) {
  let d = '';
  for (let i = 0; i < 5; i++) {
    const a = ((rotDeg + i * 72) * Math.PI) / 180;
    d += `${i ? 'L' : 'M'}${n2(cx + r * Math.cos(a))} ${n2(cy + r * Math.sin(a))}`;
  }
  return d + 'Z';
}

/** Pelota clásica: pentágonos negros sobre blanco (los parches giran, el brillo no). */
function ballMarkup() {
  let patches = pentagon(0, 0, 4.7, -90);
  let seams = '';
  for (let k = 0; k < 5; k++) {
    const deg = -90 + 72 * k;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    patches += pentagon(12.3 * c, 12.3 * s, 4.7, deg + 180);
    seams += `M${n2(4.7 * c)} ${n2(4.7 * s)}L${n2(7.6 * c)} ${n2(7.6 * s)}`;
    const b = ((deg + 36) * Math.PI) / 180;
    seams += `M${n2(9.2 * Math.cos(b))} ${n2(9.2 * Math.sin(b))}L${n2(13 * Math.cos(b))} ${n2(13 * Math.sin(b))}`;
  }
  return `
    <g class="pn-ball-spin">
      <circle r="13" fill="#f5f7fc"/>
      <g clip-path="url(#pnBallClip)"><path d="${patches}" fill="#1a1f30"/><path d="${seams}" stroke="#1a1f30" stroke-width="0.9" fill="none"/></g>
    </g>
    <circle r="13" fill="url(#pnBallShade)"/>
    <ellipse cx="-4.4" cy="-5.6" rx="3.9" ry="2.3" fill="#fff" opacity="0.8" transform="rotate(-32 -4.4 -5.6)"/>`;
}

function flagMarkup(x, y, delay, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M0 0V36" stroke="#c9ced9" stroke-width="1.1"/>
    <g class="pn-flag" style="animation-delay:${delay}s">
      <path d="M0.5 0.4h25v5.2h-25z" fill="#d52b1e"/><path d="M0.5 5.6h25v5.2h-25z" fill="#f4f6fb"/><path d="M0.5 10.8h25v5.2h-25z" fill="#0038a8"/>
      <circle cx="13" cy="8.2" r="1.8" fill="none" stroke="#1f8a4c" stroke-width="0.6"/>
    </g>
  </g>`;
}

/** El arquero rival (de frente): buzo negro, guantes verde flúor. */
const KEEPER_SVG = `
  <g class="pn-sway">
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M-5.5 -22L-9 -11.5L-10 -3M5.5 -22L9 -11.5L10 -3" stroke="#11131a" stroke-width="6.4"/>
      <path d="M-9.3 -9.4L-9.6 -6.8M9.3 -9.4L9.6 -6.8" stroke="#b6ff2e" stroke-width="6.6" stroke-linecap="butt"/>
    </g>
    <ellipse cx="-11.2" cy="-1.8" rx="4.6" ry="2.3" fill="#07080c"/><ellipse cx="11.2" cy="-1.8" rx="4.6" ry="2.3" fill="#07080c"/>
    <path d="M-11.6 -31.5H11.6L12.6 -20H1.6L0 -22.6L-1.6 -20H-12.6Z" fill="#0f1016"/>
    <path d="M-12.2 -50Q0 -53.6 12.2 -50L11.2 -30H-11.2Z" fill="url(#pnKeeperBody)"/>
    <path d="M-12.2 -50L-11.2 -30M12.2 -50L11.2 -30" stroke="#b6ff2e" stroke-width="1.3" fill="none"/>
    <path d="M-3.6 -52L0 -48L3.6 -52" stroke="#b6ff2e" stroke-width="1.3" fill="none" stroke-linejoin="round"/>
    <text x="0" y="-34.5" text-anchor="middle" font-size="10.5" font-weight="900" fill="#b6ff2e">1</text>
    <g class="pn-arms pn-arms-ready">
      <path d="M-10.5 -47.5L-19.5 -40.5L-23.5 -49.5M10.5 -47.5L19.5 -40.5L23.5 -49.5" stroke="#1a1c25" stroke-width="5.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="-28.6" y="-58" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
      <rect x="19" y="-58" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
    </g>
    <g class="pn-arms pn-arms-dive">
      <path d="M-7.5 -48L-9 -62L-8.6 -72.5M7.5 -48L9 -62L8.6 -72.5" stroke="#1a1c25" stroke-width="5.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="-13.6" y="-82.5" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
      <rect x="4" y="-82.5" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
    </g>
    <g class="pn-arms pn-arms-jump">
      <path d="M-9.5 -48L-17 -58.5L-20.5 -67.5M9.5 -48L17 -58.5L20.5 -67.5" stroke="#1a1c25" stroke-width="5.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="-26.4" y="-77.5" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
      <rect x="16.8" y="-77.5" width="9.6" height="10.6" rx="3.6" fill="#b6ff2e" stroke="#6fbf00" stroke-width="0.8"/>
    </g>
    <path d="M-2.7 -55H2.7V-50.5H-2.7Z" fill="#a86d47"/>
    <circle cx="0" cy="-59" r="6.7" fill="#c98b5f"/>
    <path d="M-6.8 -59.6Q-7 -66.8 0 -67.1Q7 -66.8 6.8 -59.6Q3.2 -63.2 0 -63Q-3.2 -63.2 -6.8 -59.6Z" fill="#1c120b"/>
    <circle cx="-2.4" cy="-58.4" r="0.8" fill="#150d08"/><circle cx="2.4" cy="-58.4" r="0.8" fill="#150d08"/>
  </g>`;

/** El 10 de la Albirroja, de espaldas: camiseta a rayas rojas y blancas, short azul. */
const KICKER_SVG = `
  <ellipse cx="3" cy="0.5" rx="25" ry="5.2" fill="#000" opacity="0.38"/>
  <g class="pn-kl" fill="none">
    <path d="M-7.5 -48Q-9.5 -30 -8.5 -9" stroke="#c78a5d" stroke-width="9" stroke-linecap="round"/>
    <path d="M-8.9 -29L-8.5 -9" stroke="#0038a8" stroke-width="9.6" stroke-linecap="round"/>
    <path d="M-8.95 -29.6L-8.9 -26.4" stroke="#f4f6fb" stroke-width="9.8"/>
    <path d="M-13.8 -1Q-14 -9 -8.5 -9.5Q-3.2 -9 -3.4 -1.5Q-3.6 0.6 -6 0.6H-11.6Q-13.8 0.6 -13.8 -1Z" fill="#ffc53d"/>
    <path d="M-12.8 -4.2H-4.4" stroke="#1b1f2e" stroke-width="1"/>
  </g>
  <g class="pn-kr" fill="none">
    <path d="M7.5 -48Q9.5 -30 8.5 -9" stroke="#c78a5d" stroke-width="9" stroke-linecap="round"/>
    <path d="M8.9 -29L8.5 -9" stroke="#0038a8" stroke-width="9.6" stroke-linecap="round"/>
    <path d="M8.95 -29.6L8.9 -26.4" stroke="#f4f6fb" stroke-width="9.8"/>
    <path d="M3.4 -1.5Q3.2 -9 8.5 -9.5Q14 -9 13.8 -1Q13.8 0.6 11.6 0.6H6Q3.6 0.6 3.4 -1.5Z" fill="#ffc53d"/>
    <path d="M4.4 -4.2H12.8" stroke="#1b1f2e" stroke-width="1"/>
  </g>
  <path d="M-16.5 -63H16.5L18 -45.5Q10 -42.5 1.2 -46.5L0 -48L-1.2 -46.5Q-10 -42.5 -18 -45.5Z" fill="#0038a8"/>
  <path d="M-16.5 -63L-18 -45.5M16.5 -63L18 -45.5" stroke="#f4f6fb" stroke-width="1.4" opacity="0.9"/>
  <path d="M-16.5 -63H16.5L17 -58H-17Z" fill="#002a80"/>
  <g class="pn-kal">
    <path d="M-17.5 -94Q-24.5 -80 -25 -65" stroke="#c78a5d" stroke-width="6.2" stroke-linecap="round" fill="none"/>
    <path d="M-12.5 -101L-22.8 -96L-26.2 -85L-17.6 -82.4Z" fill="url(#pnStripes)"/>
  </g>
  <g class="pn-kar">
    <path d="M17.5 -94Q24.5 -80 25 -65" stroke="#c78a5d" stroke-width="6.2" stroke-linecap="round" fill="none"/>
    <path d="M12.5 -101L22.8 -96L26.2 -85L17.6 -82.4Z" fill="url(#pnStripes)"/>
  </g>
  <path d="M-14.5 -62L-19.5 -96Q-11 -103 0 -103.5Q11 -103 19.5 -96L14.5 -62Z" fill="url(#pnStripes)"/>
  <path d="M-14.5 -62L-19.5 -96Q-11 -103 0 -103.5Q11 -103 19.5 -96L14.5 -62Z" fill="url(#pnTorsoShade)"/>
  <text x="0" y="-70.5" text-anchor="middle" font-size="18" font-weight="900" fill="#0b2c86" stroke="#f4f6fb" stroke-width="2" paint-order="stroke" letter-spacing="-0.5">10</text>
  <path d="M-6.5 -102.8Q0 -100.2 6.5 -102.8" stroke="#0038a8" stroke-width="2.2" fill="none"/>
  <path d="M-4.2 -107.5H4.2V-101.5H-4.2Z" fill="#b07650"/>
  <ellipse cx="-8.4" cy="-111.5" rx="1.6" ry="2.6" fill="#b98052"/><ellipse cx="8.4" cy="-111.5" rx="1.6" ry="2.6" fill="#b98052"/>
  <circle cx="0" cy="-113" r="8.6" fill="#22150d"/>
  <path d="M-5.6 -118.4Q0 -122 5.6 -118.4" stroke="#3d2818" stroke-width="1.3" fill="none"/>`;

function zonesMarkup() {
  const labels = ['Patear a la izquierda', 'Patear al centro', 'Patear a la derecha'];
  let out = '';
  for (let z = 0; z < ZONES; z++) {
    const [x0, x1] = ZONE_X[z];
    const c = CROSS[z];
    out += `<g class="pn-zone" data-zone="${z}" role="button" tabindex="-1" aria-label="${labels[z]} (tecla ${z + 1})">
      <rect class="pn-zhit" x="${x0}" y="74" width="${n2(x1 - x0)}" height="128" fill="transparent"/>
      <rect class="pn-zfill" x="${n2(MOUTH[z] + 2)}" y="97.5" width="${n2(MOUTH[z + 1] - MOUTH[z] - 4)}" height="80" rx="5"/>
      <g transform="translate(${c.x} ${c.y})"><g class="pn-cross">
        <circle class="pn-cross-glow" r="12.5"/>
        <circle class="pn-cross-ring" r="12.5"/>
        <path class="pn-cross-tick" d="M0 -18V-8.5M0 8.5V18M-18 0H-8.5M8.5 0H18"/>
        <circle class="pn-cross-dot" r="2.2"/>
      </g></g>
    </g>`;
  }
  return out;
}

/** Escena con movimiento: banderas, arco, arquero, pelota, pateador y las 3 zonas para patear. */
function fgMarkup() {
  const flags = [
    [-112, 104, 0.1],
    [-40, 98, 0.7],
    [48, 99, 0.35],
    [84, 106, 1],
    [398, 99, 0.55],
    [432, 106, 0.15],
    [520, 98, 0.85],
    [592, 104, 0.4],
  ]
    .map(([x, y, d]) => flagMarkup(x, y, d))
    .join('');
  return `
<svg class="pn-fg" xmlns="http://www.w3.org/2000/svg" viewBox="40 0 400 360" preserveAspectRatio="xMidYMid slice" focusable="false">
  <defs>
    <pattern id="pnNet" width="6.4" height="6.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0H6.4M0 0V6.4" stroke="#eef2ff" stroke-width="0.55" stroke-opacity="0.55" fill="none"/>
    </pattern>
    <pattern id="pnNetHi" width="7.4" height="7.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0H7.4M0 0V7.4" stroke="#ffffff" stroke-width="0.8" stroke-opacity="0.95" fill="none"/>
    </pattern>
    <linearGradient id="pnSideL" x1="110" y1="0" x2="130" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/><stop offset="1" stop-color="#03061a" stop-opacity="0.4"/></linearGradient>
    <linearGradient id="pnSideR" x1="370" y1="0" x2="350" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/><stop offset="1" stop-color="#03061a" stop-opacity="0.4"/></linearGradient>
    <linearGradient id="pnPostG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#aeb8d6"/><stop offset="0.45" stop-color="#ffffff"/><stop offset="1" stop-color="#c3cbe3"/></linearGradient>
    <linearGradient id="pnBarG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b3bcd8"/></linearGradient>
    <radialGradient id="pnBulgeG"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <radialGradient id="pnBallShade" cx="0.36" cy="0.3" r="0.78"><stop offset="0.45" stop-color="#0b1130" stop-opacity="0"/><stop offset="1" stop-color="#0b1130" stop-opacity="0.5"/></radialGradient>
    <clipPath id="pnBallClip"><circle r="13"/></clipPath>
    <pattern id="pnStripes" x="-2.25" width="9" height="40" patternUnits="userSpaceOnUse">
      <rect width="4.5" height="40" fill="#d52b1e"/><rect x="4.5" width="4.5" height="40" fill="#f6f7fb"/>
    </pattern>
    <linearGradient id="pnTorsoShade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.42"/><stop offset="0.3" stop-color="#000" stop-opacity="0"/><stop offset="0.7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></linearGradient>
    <linearGradient id="pnKeeperBody" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#101118"/><stop offset="0.5" stop-color="#2a2d3a"/><stop offset="1" stop-color="#101118"/></linearGradient>
  </defs>
  <g class="pn-flags" aria-hidden="true">${flags}${flagMarkup(166, 60, 0.25, 0.72)}${flagMarkup(296, 60, 0.9, 0.72)}</g>
  <g class="pn-goal" aria-hidden="true">
    <path d="M110 181.5L370 181.5L350 170.5L130 170.5Z" fill="#021208" opacity="0.4"/>
    <g class="pn-net">
      <path d="M130 103H350V170.5H130Z" fill="#050a1c" opacity="0.3"/>
      <path d="M130 103H350V170.5H130Z" fill="url(#pnNet)"/>
      <path d="M110 92L130 103V170.5L110 181.5Z" fill="url(#pnSideL)"/>
      <path d="M110 92L130 103V170.5L110 181.5Z" fill="url(#pnNet)"/>
      <path d="M370 92L350 103V170.5L370 181.5Z" fill="url(#pnSideR)"/>
      <path d="M370 92L350 103V170.5L370 181.5Z" fill="url(#pnNet)"/>
      <path d="M110 92H370L350 103H130Z" fill="url(#pnNet)"/>
      <path d="M130 103H350V170.5M130 103V170.5M112 93.5L130 103M368 93.5L350 103" stroke="#dfe5f7" stroke-opacity="0.45" stroke-width="1.1" fill="none"/>
    </g>
    <g class="pn-bulge" opacity="0" transform="translate(240 130)">
      <circle r="16" fill="url(#pnBulgeG)"/>
      <circle r="16" fill="url(#pnNetHi)"/>
      <circle class="pn-ring" r="10" fill="none" stroke="#ffffff" stroke-width="1.3"/>
    </g>
    <ellipse cx="107" cy="182.2" rx="6" ry="1.8" fill="#000" opacity="0.35"/>
    <ellipse cx="373" cy="182.2" rx="6" ry="1.8" fill="#000" opacity="0.35"/>
    <path d="M107 90V182M373 90V182M104 92H376" stroke="#ffffff" stroke-opacity="0.13" stroke-width="13" stroke-linecap="round" fill="none"/>
    <rect x="103.9" y="89" width="6.2" height="93.4" rx="2.2" fill="url(#pnPostG)"/>
    <rect x="369.9" y="89" width="6.2" height="93.4" rx="2.2" fill="url(#pnPostG)"/>
    <rect x="103.9" y="88.9" width="272.2" height="6.2" rx="2.4" fill="url(#pnBarG)"/>
  </g>
  <ellipse class="pn-kshadow" aria-hidden="true" rx="14" ry="3.2" fill="#000" opacity="0.42" transform="translate(240 181.5)"/>
  <g class="pn-keeper" aria-hidden="true" data-pose="ready" transform="translate(240 180)">${KEEPER_SVG}</g>
  <ellipse class="pn-bshadow" aria-hidden="true" rx="13.5" ry="3.8" fill="#000" opacity="0.4" transform="translate(240 330)"/>
  <g class="pn-ball" aria-hidden="true" transform="translate(240 325)">${ballMarkup()}</g>
  <g class="pn-kicker" aria-hidden="true" transform="translate(172 358) scale(1.08)">${KICKER_SVG}</g>
  <g class="pn-zones">${zonesMarkup()}</g>
</svg>`;
}

export function createPenalty(shell) {
  const { sound } = shell;
  const S = () => shell.state.settings;

  let el = null;
  let amount = null;
  let play = null; // tanda en curso (o la última terminada, para mostrar cómo quedó)
  let busy = false;
  let starting = false; // esperando la respuesta de "JUGAR"
  let seq = 0; // cambia cuando hay que cortar una animación en curso (logout, reconexión)
  let deferredInit = null; // snapshot que llegó en medio de una patada
  let sceneDirty = false; // quedó el arquero tirado o la pelota en la red
  let idleTimer = 0;
  let tipHold = 0;

  const active = () => !!(play && play.status === 'active');
  const kicksOf = () => (play && play.kicks) || [];
  const goals = () => kicksOf().filter((k) => k.goal).length;
  const canKick = () => active() && !busy && !!shell.state.user;
  const visible = () => shell.isVisible('penalty');

  // Estado de los personajes (lo que se dibuja)
  const kicker = { p: 0, bob: 0, leg: 0, legS: 1, arm: 0, lean: 0 };
  const keeper = { tx: 0, ty: 0, rot: 0, pose: 'ready' };
  const ball = { x: SPOT.x, y: SPOT.y, s: 1, rot: 0, o: 1 };
  const shadow = { x: SPOT.x, y: SPOT.y + 5, s: 1, o: 0.4 };

  // ───────────────────────── Animaciones (avanzan en frame(); si el juego no se ve, un timer las termina) ─────────────────────────

  const tweens = new Set();

  function tween(ms, step) {
    return new Promise((resolve) => {
      const tw = { ms: Math.max(1, ms), step, resolve, start: -1 };
      tw.timer = setTimeout(() => endTween(tw), tw.ms + 150);
      tweens.add(tw);
      step(0);
    });
  }

  function endTween(tw) {
    if (!tweens.delete(tw)) return;
    clearTimeout(tw.timer);
    try {
      tw.step(1);
    } catch (err) {
      console.error(err);
    }
    tw.resolve();
  }

  function runTweens(now) {
    for (const tw of [...tweens]) {
      if (tw.start < 0) tw.start = now;
      const k = (now - tw.start) / tw.ms;
      if (k >= 1) endTween(tw);
      else
        try {
          tw.step(k);
        } catch (err) {
          console.error(err);
          endTween(tw);
        }
    }
  }

  function stopTweens() {
    for (const tw of [...tweens]) endTween(tw);
  }

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function mount(root) {
    const holder = document.createElement('div');
    holder.innerHTML = bgMarkup() + fgMarkup(); // dibujos propios (constantes)
    const bg = holder.querySelector('.pn-bg');
    const fg = holder.querySelector('.pn-fg');
    const q = (s) => fg.querySelector(s);

    const kickDots = Array.from({ length: KICKS }, (_, i) => h('span', { class: 'pn-kick' }, String(i + 1)));
    const chipLabel = h('small');
    const chipValue = h('b');
    const chip = h('div', { class: 'pn-chip' }, chipLabel, chipValue);
    const hud = h('div', { class: 'pn-hud' }, h('div', { class: 'pn-kicks', role: 'list', 'aria-label': 'Tus 5 penales' }, ...kickDots), chip);
    const steps = Array.from({ length: KICKS }, (_, i) =>
      h('div', { class: 'pn-step' }, h('small', null, `${i + 1} ⚽`), h('b', null, fmtMult(core.penaltyMultiplier(i + 1)))),
    );
    const ladder = h('div', { class: 'pn-ladder', 'aria-label': 'Multiplicador por cantidad de goles' }, ...steps.slice().reverse());
    const bannerText = h('b');
    const bannerSub = h('small');
    const banner = h('div', { class: 'pn-banner', 'aria-live': 'polite' }, bannerText, bannerSub);
    const flash = h('div', { class: 'pn-flash' });
    const tip = h('div', { class: 'pn-tip' });
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused = pausedNotice();
    const stage = h('div', { class: 'gv-stage pn-stage' }, bg, fg, h('div', { class: 'pn-vignette' }), flash, hud, ladder, tip, banner, result.el, winLayer, paused);

    amount = new AmountControl(shell, { key: 'cpy_pen_amt', def: 5000, onChange: () => render() });
    const statMult = h('b');
    const statProfit = h('b');
    const action = actionButton(() => onAction());
    const random = h('button', { class: 'btn btn-ghost btn-sm btn-block', type: 'button' }, '🎲 Patear al azar');
    random.addEventListener('click', pickRandom);
    const note = h('div', { class: 'gv-note' });
    const panel = h(
      'div',
      { class: 'gv-panel' },
      panelHead(shell, { icon: '⚽', name: 'Penales' }),
      h('div', null, h('div', { class: 'gv-label' }, 'Monto'), amount.el),
      h('div', { class: 'gv-stats' }, h('div', { class: 'gv-stat' }, h('small', null, 'Multiplicador'), statMult), h('div', { class: 'gv-stat' }, h('small', null, 'Ganancia'), statProfit)),
      action.el,
      random,
      note,
    );
    root.append(h('div', { class: 'gv gv-penalty' }, stage, panel));

    const zones = [...fg.querySelectorAll('.pn-zone')];
    zones.forEach((z, i) => {
      z.addEventListener('click', () => onZone(i));
      z.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onZone(i);
        }
      });
      z.addEventListener('pointerdown', () => canKick() && z.classList.add('pn-press'));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) z.addEventListener(ev, () => z.classList.remove('pn-press'));
    });

    el = {
      stage,
      bg,
      fg,
      crowd: bg.querySelector('.pn-crowd'),
      keeper: q('.pn-keeper'),
      kShadow: q('.pn-kshadow'),
      ball: q('.pn-ball'),
      ballSpin: q('.pn-ball-spin'),
      bShadow: q('.pn-bshadow'),
      kicker: q('.pn-kicker'),
      kLegR: q('.pn-kr'),
      kArmL: q('.pn-kal'),
      kArmR: q('.pn-kar'),
      net: q('.pn-net'),
      bulge: q('.pn-bulge'),
      ring: q('.pn-ring'),
      zones,
      kickDots,
      chip,
      chipLabel,
      chipValue,
      steps,
      banner,
      bannerText,
      bannerSub,
      flash,
      tip,
      result,
      winLayer,
      paused,
      statMult,
      statProfit,
      action,
      random,
      note,
      vb: '',
      tabbable: null,
    };

    if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(stage);
    document.addEventListener('keydown', onKey);

    const init = shell.state.lastInit;
    if (init && init.plays && init.plays.penalty) play = init.plays.penalty;
    neutralScene();
    drawHud();
    render();
    if (active()) note(kickHint(true));
  }

  /** Ajusta el viewBox al tamaño del escenario: la zona importante (arco, pelota, pateador) siempre entra. */
  function fit() {
    if (!el) return;
    const w = el.stage.clientWidth;
    const hh = el.stage.clientHeight;
    if (!w || !hh) return;
    const r = w / hh;
    let vw = SAFE.w;
    let vh = SAFE.h;
    let y = 0;
    if (r >= SAFE.w / SAFE.h) vw = SAFE.h * r;
    else {
      vh = SAFE.w / r;
      y = -(vh - SAFE.h) * 0.75;
    }
    const vb = `${n2(SAFE.cx - vw / 2)} ${n2(y)} ${n2(vw)} ${n2(vh)}`;
    if (vb === el.vb) return;
    el.vb = vb;
    el.bg.setAttribute('viewBox', vb);
    el.fg.setAttribute('viewBox', vb);
  }

  // ───────────────────────── Dibujo de los personajes ─────────────────────────

  function drawKicker() {
    const k = kicker;
    const x = lerp(172, 213, k.p);
    const y = lerp(358, 339, k.p) - k.bob;
    const s = lerp(1.08, 0.95, k.p);
    el.kicker.setAttribute('transform', `translate(${n2(x)} ${n2(y)}) rotate(${n2(k.lean)}) scale(${n2(s)})`);
    el.kLegR.setAttribute('transform', `translate(8 -48) rotate(${n2(k.leg)}) scale(1 ${n2(k.legS)}) translate(-8 48)`);
    el.kArmL.setAttribute('transform', `rotate(${n2(k.arm)} -15 -97)`);
    el.kArmR.setAttribute('transform', `rotate(${n2(-k.arm * 0.45)} 15 -97)`);
  }

  function drawKeeper() {
    const k = keeper;
    el.keeper.setAttribute('transform', `translate(${n2(KEEPER_X + k.tx)} ${n2(KEEPER_Y + k.ty)}) rotate(${n2(k.rot)} 0 ${KEEPER_PIVOT})`);
    if (el.keeper.getAttribute('data-pose') !== k.pose) el.keeper.setAttribute('data-pose', k.pose);
    const spread = Math.min(1, Math.abs(k.rot) / 80);
    const lift = Math.max(0, -k.ty);
    el.kShadow.setAttribute('transform', `translate(${n2(KEEPER_X + k.tx * 0.92)} 181.5) scale(${n2(1 + spread * 1.7)} ${n2(1 - spread * 0.15)})`);
    el.kShadow.setAttribute('opacity', n2(0.42 - lift * 0.012));
  }

  function drawBall() {
    const b = ball;
    el.ball.setAttribute('transform', `translate(${n2(b.x)} ${n2(b.y)}) scale(${n2(b.s)})`);
    el.ballSpin.setAttribute('transform', `rotate(${n2(b.rot % 360)})`);
    el.ball.setAttribute('opacity', n2(b.o));
    el.bShadow.setAttribute('transform', `translate(${n2(shadow.x)} ${n2(shadow.y)}) scale(${n2(shadow.s)})`);
    el.bShadow.setAttribute('opacity', n2(shadow.o));
  }

  /** Todo en su lugar: pelota en el punto penal, arquero al medio, pateador atrás. */
  function neutralScene() {
    Object.assign(kicker, { p: 0, bob: 0, leg: 0, legS: 1, arm: 0, lean: 0 });
    Object.assign(keeper, { tx: 0, ty: 0, rot: 0, pose: 'ready' });
    Object.assign(ball, { x: SPOT.x, y: SPOT.y, s: 1, rot: 0, o: 1 });
    Object.assign(shadow, { x: SPOT.x, y: SPOT.y + 5, s: 1, o: 0.4 });
    sceneDirty = false;
    if (!el) return;
    el.bulge.setAttribute('opacity', '0');
    el.net.removeAttribute('transform');
    drawKicker();
    drawKeeper();
    drawBall();
    aim(-1);
  }

  /** Vuelve la escena a su lugar con una animación corta. */
  async function resetScene(ms = 560) {
    clearTimeout(idleTimer);
    if (!el) return;
    sceneDirty = false;
    if (ms <= 0 || reducedMotion()) {
      neutralScene();
      return;
    }
    const k0 = { ...kicker };
    const g0 = { ...keeper };
    const b0 = { ...ball };
    const s0 = { ...shadow };
    aim(-1);
    const ballBack = (async () => {
      await tween(ms * 0.32, (t) => {
        ball.o = b0.o * (1 - t);
        shadow.o = s0.o * (1 - t);
        drawBall();
      });
      Object.assign(ball, { x: SPOT.x, y: SPOT.y, rot: 0, s: 0.4, o: 0 });
      Object.assign(shadow, { x: SPOT.x, y: SPOT.y + 5, s: 0.4, o: 0 });
      el.bulge.setAttribute('opacity', '0');
      await tween(ms * 0.6, (t) => {
        const e = ease.outBack(t);
        ball.s = lerp(0.4, 1, e);
        ball.o = clamp01(t * 2);
        shadow.s = lerp(0.4, 1, e);
        shadow.o = 0.4 * clamp01(t * 2);
        drawBall();
      });
    })();
    const people = tween(ms, (t) => {
      const e = ease.inOutCubic(t);
      keeper.tx = lerp(g0.tx, 0, e);
      keeper.ty = lerp(g0.ty, 0, e);
      keeper.rot = lerp(g0.rot, 0, e);
      if (t > 0.5) keeper.pose = 'ready';
      kicker.p = lerp(k0.p, 0, e);
      kicker.leg = lerp(k0.leg, 0, e);
      kicker.legS = lerp(k0.legS, 1, e);
      kicker.arm = lerp(k0.arm, 0, e);
      kicker.lean = lerp(k0.lean, 0, e);
      kicker.bob = Math.sin(t * Math.PI * 2) * 2 * (1 - t);
      drawKeeper();
      drawKicker();
    });
    await Promise.all([ballBack, people]);
    el.net.removeAttribute('transform');
  }

  /** Marca la zona elegida (mira dorada). -1 = ninguna. */
  function aim(zone) {
    if (!el) return;
    el.zones.forEach((z, i) => z.classList.toggle('pn-aim', i === zone));
  }

  // ───────────────────────── Marcador y panel ─────────────────────────

  function drawHud() {
    if (!el) return;
    const kicks = kicksOf();
    const isActive = active();
    const ended = !!(play && !isActive);
    const g = goals();
    const where = ['a la izquierda', 'al centro', 'a la derecha'];
    el.kickDots.forEach((d, i) => {
      const k = kicks[i];
      let cls = 'pn-kick';
      let txt = String(i + 1);
      let title = `Penal ${i + 1}`;
      if (k) {
        cls += k.goal ? ' pn-is-goal' : ' pn-is-saved';
        txt = k.goal ? '⚽' : '🧤';
        title = k.goal ? `Penal ${i + 1}: ¡gol! Pateaste ${where[k.zone]}` : `Penal ${i + 1}: atajado ${where[k.keeper]}`;
      } else if (isActive && i === kicks.length) cls += ' pn-is-next';
      else if (ended && play.keepers && play.keepers[i] != null) {
        cls += ' pn-is-ghost';
        txt = ZONE_ARROWS[play.keepers[i]];
        title = `Penal ${i + 1}: el arquero se iba a tirar ${where[play.keepers[i]]}`;
      }
      setClass(d, cls);
      setText(d, txt);
      d.title = title;
      d.setAttribute('role', 'listitem');
      d.setAttribute('aria-label', title);
    });
    el.steps.forEach((s, i) => {
      const n = i + 1;
      let cls = 'pn-step';
      if (n <= g) cls += ' pn-is-done';
      else if (isActive && n === g + 1) cls += ' pn-is-next';
      else if (ended && play.status === 'lost' && n === g + 1) cls += ' pn-is-lost';
      setClass(s, cls);
    });
    let label = '1er gol';
    let value = fmtMult(core.penaltyMultiplier(1));
    let cls = 'pn-chip';
    if (isActive && g) {
      label = 'Premio';
      value = fmtMult(play.current);
      cls += ' pn-is-live';
    } else if (ended && play.status === 'won') {
      label = 'Cobraste';
      value = fmtMult(play.multiplier);
      cls += ' pn-is-won';
    } else if (ended && play.status === 'lost') {
      label = 'Atajado';
      value = '0.00x';
      cls += ' pn-is-lost';
    }
    setText(el.chipLabel, label);
    setText(el.chipValue, value);
    setClass(el.chip, cls);
  }

  function render() {
    if (!el) return;
    const isActive = active();
    const g = goals();
    const current = isActive && g ? play.current : 0;
    const payout = g ? Math.floor((play.amount * current) / 100) : 0;
    setText(el.statMult, isActive ? fmtMult(current || 100) : fmtMult(core.penaltyMultiplier(1)));
    setText(el.statProfit, isActive && g ? fmtGs(payout - play.amount) : fmtGs(0));
    amount.setDisabled(isActive || busy);
    const paused = S().game_penalty === false && !isActive;
    if (!shell.state.user) el.action.set({ text: 'JUGAR', detail: 'Ingresá para jugar' });
    else if (isActive) el.action.set({ text: busy ? 'ESPERÁ…' : 'RETIRAR', detail: g ? fmtGs(payout) : 'Pateá tu primer penal', color: 'orange', disabled: busy || !g });
    else if (paused) el.action.set({ text: 'JUGAR', detail: 'Juego en pausa ⏸', disabled: true });
    else el.action.set({ text: starting ? 'ENVIANDO…' : 'JUGAR', detail: fmtGs(amount.value), disabled: busy });
    el.random.hidden = !isActive;
    el.random.disabled = busy;
    el.paused.hidden = !paused;
    const can = canKick();
    el.fg.classList.toggle('pn-can-kick', can);
    if (el.tabbable !== can) {
      el.tabbable = can;
      el.zones.forEach((z) => z.setAttribute('tabindex', can ? '0' : '-1'));
    }
    renderTip();
    shell.setNavBadge('penalty', isActive);
  }

  function renderTip() {
    let text = '';
    if (!busy && performance.now() >= tipHold) {
      if (active()) text = goals() ? `Próximo gol: ${fmtMult(play.next)} ⚽` : 'Tocá el arco para patear ⚽';
      else if (S().game_penalty !== false) text = `5 penales · hasta ${fmtMult(core.penaltyMultiplier(KICKS))} 🇵🇾`;
    }
    setText(el.tip, text);
    el.tip.classList.toggle('pn-show', !!text);
    el.tip.classList.remove('pn-alert');
  }

  /** Esconde el cartelito de ayuda un rato (mientras se muestra un resultado). */
  function holdTip(ms) {
    tipHold = performance.now() + ms;
    setTimeout(() => el && !busy && renderTip(), ms + 30);
  }

  function note(text, kind = '') {
    if (!el) return;
    el.note.textContent = text || '';
    el.note.className = `gv-note${kind ? ' ' + kind : ''}`;
  }

  // ───────────────────────── Efectos ─────────────────────────

  let bannerTimer = 0;
  function showBanner(text, sub, kind, ms = 1300) {
    clearTimeout(bannerTimer);
    setText(el.bannerText, text);
    setText(el.bannerSub, sub || '');
    el.banner.className = `pn-banner pn-banner-${kind}`;
    void el.banner.offsetWidth;
    el.banner.classList.add('pn-show');
    bannerTimer = setTimeout(() => el && el.banner.classList.remove('pn-show'), ms);
  }

  function flashFx(kind) {
    el.flash.className = 'pn-flash';
    void el.flash.offsetWidth;
    el.flash.className = `pn-flash ${kind}`;
  }

  function shake() {
    el.stage.classList.remove('pn-shake');
    void el.stage.offsetWidth;
    el.stage.classList.add('pn-shake');
  }

  /** La hinchada salta con el gol. */
  function cheer() {
    const c = el.crowd;
    c.classList.remove('pn-cheer');
    c.getBoundingClientRect();
    c.classList.add('pn-cheer');
    setTimeout(() => c.classList.remove('pn-cheer'), 1500);
  }

  /** La red se infla donde entra la pelota. */
  function netHit(target) {
    const x = target.x + (VP.x - target.x) * 0.1;
    const y = target.y + (VP.y - target.y) * 0.1;
    tween(680, (t) => {
      const grow = t < 0.22 ? ease.outCubic(t / 0.22) : 1 - ease.inOutCubic((t - 0.22) / 0.78) * 0.3;
      el.bulge.setAttribute('transform', `translate(${n2(x)} ${n2(y)}) scale(${n2(0.3 + grow * 0.9)})`);
      el.bulge.setAttribute('opacity', n2(t < 0.22 ? 1 : 1 - (t - 0.22) / 0.78));
      el.ring.setAttribute('r', n2(7 + t * 24));
      el.ring.setAttribute('stroke-opacity', n2(0.9 * (1 - t)));
    });
    const dx = (x - VP.x) * 0.03;
    tween(560, (t) => {
      const w = Math.sin(t * Math.PI * 3) * (1 - t);
      el.net.setAttribute('transform', `translate(${n2(dx * w)} ${n2(-w * 2.2)})`);
    });
  }

  // ───────────────────────── La patada ─────────────────────────

  /** Dónde termina la pelota: en la red (gol) o contra los guantes del arquero (atajada). */
  function ballTarget(zone, goal) {
    if (!goal) {
      const p = zone === 1 ? keeperPoint(DIVES[1], 0, -47) : keeperPoint(DIVES[zone], 0, -77);
      return { x: p.x + (zone === 0 ? 5 : zone === 2 ? -5 : 0), y: p.y + 2 };
    }
    const r = Math.random;
    if (zone === 1) return { x: 229 + r() * 22, y: 110 + r() * 40 };
    const x = 132 + r() * 42;
    return { x: zone === 0 ? x : 2 * KEEPER_X - x, y: 108 + r() * 56 };
  }

  /** Carrerita del pateador hasta la pelota (se anima mientras llega la respuesta del servidor). */
  function runUp(ms) {
    const k0 = { ...kicker };
    return tween(ms, (t) => {
      const e = ease.inOutCubic(t);
      kicker.p = lerp(k0.p, 1, e);
      kicker.bob = Math.abs(Math.sin(t * Math.PI * 3)) * 3.2 * (1 - t * 0.7);
      kicker.lean = lerp(k0.lean, -4, e);
      const back = clamp01((t - 0.5) / 0.5);
      kicker.leg = lerp(0, 12, back);
      kicker.legS = lerp(1, 0.6, back);
      kicker.arm = lerp(0, 18, back);
      drawKicker();
    });
  }

  /** Remate: la pelota vuela a la zona y el arquero se tira a SU zona (lo que dijo el servidor). */
  async function shoot(k, target, rm) {
    if (visible()) {
      sound.kick();
      vibrate(12);
    }
    const k0 = { ...kicker };
    const swing = tween(rm ? 1 : 180, (t) => {
      const e = ease.outCubic(t);
      kicker.p = lerp(k0.p, 1, e);
      kicker.leg = lerp(k0.leg, -30, e);
      kicker.legS = lerp(k0.legS, 1, e);
      kicker.arm = lerp(k0.arm, 36, e);
      kicker.lean = lerp(k0.lean, -7, e);
      kicker.bob = 0;
      drawKicker();
    });
    const from = { x: ball.x, y: ball.y };
    const ctrl = { x: (from.x + target.x) / 2 + (target.x - KEEPER_X) * 0.22, y: (from.y + target.y) / 2 - 24 };
    const spin = (k.zone === 0 ? -1 : 1) * (rm ? 120 : 760);
    const flight = tween(rm ? 180 : 540, (t) => {
      const u = 1 - Math.pow(1 - t, 1.55);
      ball.x = quad(from.x, ctrl.x, target.x, u);
      ball.y = quad(from.y, ctrl.y, target.y, u);
      ball.s = lerp(1, 0.4, u);
      ball.rot = spin * t;
      ball.o = 1;
      shadow.x = lerp(from.x, target.x, u);
      shadow.y = lerp(SPOT.y + 5, 182.5, u);
      shadow.s = lerp(1, 0.34, u);
      shadow.o = lerp(0.4, 0.2, u);
      drawBall();
    });
    const d = DIVES[k.keeper];
    const dive = (async () => {
      if (!rm) await sleep(50);
      keeper.pose = d.pose;
      await tween(rm ? 120 : 440, (t) => {
        const e = ease.outCubic(t);
        keeper.tx = lerp(0, d.tx, e);
        keeper.ty = lerp(0, d.ty, e) - Math.sin(t * Math.PI) * (k.keeper === 1 ? 5 : 9);
        keeper.rot = lerp(0, d.rot, e);
        drawKeeper();
      });
    })();
    await Promise.all([swing, flight, dive]);
  }

  /** Gol: la pelota se mete en la red y cae. */
  async function ballIntoNet(target, my, rm) {
    const p0 = { ...ball };
    const deep = { x: target.x + (VP.x - target.x) * 0.12, y: target.y + (VP.y - target.y) * 0.12 };
    await tween(rm ? 1 : 170, (t) => {
      const e = ease.outCubic(t);
      ball.x = lerp(p0.x, deep.x, e);
      ball.y = lerp(p0.y, deep.y, e);
      ball.s = lerp(p0.s, 0.35, e);
      ball.rot = p0.rot + 60 * t;
      drawBall();
    });
    if (my !== seq) return;
    const y0 = ball.y;
    const floor = 170;
    const r0 = ball.rot;
    await tween(rm ? 1 : Math.max(180, (floor - y0) * 5), (t) => {
      ball.y = lerp(y0, floor, t * t);
      ball.rot = r0 + 90 * t;
      shadow.x = ball.x;
      shadow.y = 172;
      shadow.s = 0.3;
      shadow.o = 0.25 * t;
      drawBall();
    });
    if (my !== seq || rm) return;
    await tween(240, (t) => {
      ball.y = floor - Math.sin(t * Math.PI) * 4;
      drawBall();
    });
  }

  /** Atajada: la pelota rebota en los guantes y sale despedida. */
  async function ballDeflect(zone, rm) {
    const p0 = { ...ball };
    const dir = zone === 0 ? -1 : zone === 2 ? 1 : Math.random() < 0.5 ? -1 : 1;
    const to = zone === 1 ? { x: KEEPER_X + dir * 64, y: 246 } : { x: p0.x + dir * 96, y: 206 };
    const ctrl = { x: lerp(p0.x, to.x, 0.45), y: Math.min(p0.y, to.y) - 34 };
    await tween(rm ? 1 : 560, (t) => {
      const e = ease.outCubic(t);
      ball.x = quad(p0.x, ctrl.x, to.x, e);
      ball.y = quad(p0.y, ctrl.y, to.y, e);
      ball.s = lerp(p0.s, 0.62, e);
      ball.rot = p0.rot - dir * 420 * t;
      ball.o = t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
      shadow.x = ball.x;
      shadow.y = lerp(182.5, to.y + 9, e);
      shadow.s = lerp(0.34, 0.62, e);
      shadow.o = 0.22 * ball.o;
      drawBall();
    });
  }

  /** Después de tirarse, el arquero cae al pasto. */
  async function keeperLand(zone, rm) {
    const g0 = { ...keeper };
    if (zone === 1) {
      await tween(rm ? 1 : 260, (t) => {
        keeper.ty = lerp(g0.ty, 0, ease.inOutCubic(t));
        drawKeeper();
      });
      return;
    }
    const side = zone === 0 ? -1 : 1;
    await tween(rm ? 1 : 320, (t) => {
      const e = t * t;
      keeper.ty = lerp(g0.ty, 31, e);
      keeper.rot = lerp(g0.rot, side * 90, e);
      keeper.tx = lerp(g0.tx, g0.tx + side * 6, e);
      drawKeeper();
    });
  }

  async function kick(zone) {
    if (!el || !canKick() || !Number.isInteger(zone) || zone < 0 || zone >= ZONES) return;
    sound._ensure();
    busy = true;
    const my = ++seq;
    const release = shell.lockBalance(20000);
    clearTimeout(idleTimer);
    el.result.hide();
    aim(zone);
    tipHold = 0;
    note('');
    render();
    const rm = reducedMotion();
    const request = shell.emit('penalty:kick', { id: play.id, zone });
    if (sceneDirty) await resetScene(rm ? 0 : 300);
    await runUp(rm ? 1 : 400);
    const res = await request;
    if (my !== seq) return release();
    if (!res.ok) {
      const k0 = { ...kicker };
      await tween(rm ? 1 : 280, (t) => {
        const e = ease.inOutCubic(t);
        kicker.p = lerp(k0.p, 0, e);
        kicker.leg = lerp(k0.leg, 0, e);
        kicker.legS = lerp(k0.legS, 1, e);
        kicker.arm = lerp(k0.arm, 0, e);
        kicker.lean = lerp(k0.lean, 0, e);
        drawKicker();
      });
      if (my !== seq) return release();
      busy = false;
      aim(-1);
      release();
      flushInit(); // primero el snapshot guardado; después lo último del servidor
      if (['ENDED', 'NO_PLAY', 'TIMEOUT', 'OFFLINE'].includes(res.code)) await resync();
      toast(res.error || 'No se pudo patear', 'error');
      drawHud();
      render();
      return;
    }
    const next = res.play;
    shell.setBalance(res.balance); // queda congelado hasta que termine la animación
    const k = next.kicks[next.kicks.length - 1] || { zone, keeper: (zone + 1) % ZONES, goal: true };
    const target = ballTarget(k.zone, k.goal);
    await shoot(k, target, rm);
    if (my !== seq) return release();

    // ¡Resultado a la vista!
    play = next;
    sceneDirty = true;
    drawHud();
    render();
    const n = kicksOf().length;
    const ended = play.status !== 'active';
    let after;
    if (k.goal) {
      netHit(target);
      flashFx('pn-flash-goal');
      const sub = ended ? (goals() === KICKS ? '¡Tanda perfecta! 🇵🇾' : '¡Ganancia máxima!') : `Ya vas ${fmtMult(play.current)}`;
      showBanner('¡GOOOL!', sub, 'goal', ended ? 1050 : 1300);
      if (visible()) {
        sound.goal();
        confetti(el.stage, { colors: ALBIRROJA, count: 70 });
        vibrate([25, 40, 35]);
      }
      cheer();
      after = ballIntoNet(target, my, rm);
      if (!ended) note(`⚽ ¡Gol! Ya vas ${fmtMult(play.current)} · el próximo paga ${fmtMult(play.next)}`, 'good');
    } else {
      flashFx('pn-flash-save');
      showBanner('¡ATAJÓ!', 'El arquero adivinó 🧤', 'save', 1050);
      shake();
      if (visible()) {
        sound.save();
        vibrate([70, 40, 110]);
      }
      after = ballDeflect(k.zone, rm);
      note(`🧤 Te atajaron el ${n}º penal.`, 'bad');
    }
    const land = keeperLand(k.keeper, rm);

    if (!ended) {
      await Promise.all([after, land]);
      await sleep(rm ? 250 : 420);
      if (my !== seq) return release();
      await resetScene(rm ? 0 : 580);
      if (my !== seq) return release();
      busy = false;
      release();
      render();
      flushInit();
      return;
    }

    // La tanda terminó: primero el festejo o el lamento, después el cartel del resultado
    holdTip(3600);
    await sleep(rm ? 250 : 1150);
    if (my !== seq) return release();
    release();
    if (play.status === 'won') celebrate(goals() < KICKS);
    else lost();
    busy = false;
    render();
    flushInit();
    scheduleIdleReset();
  }

  /** Si la tanda terminó y nadie juega, la escena vuelve sola a su lugar. */
  function scheduleIdleReset() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!el || busy || !sceneDirty) return;
      ++seq;
      stopTweens();
      resetScene();
    }, 3600);
  }

  function celebrate(capped = false) {
    const perfect = goals() === KICKS;
    const big = isBigWin(play.payout, play.amount, play.multiplier) || perfect;
    const label = perfect ? '¡Tanda perfecta! 🇵🇾' : capped ? '¡Llegaste a la ganancia máxima! ⚽' : `¡Retiraste a ${fmtMult(play.multiplier)}! ⚽`;
    if (visible()) {
      el.result.show({ win: true, head: fmtMult(play.multiplier), detail: `Ganaste ${fmtGs(play.payout)}`, big });
      winPop(el.winLayer, { amount: play.payout - play.amount, label, big });
      if (big) confetti(el.stage, { colors: ALBIRROJA, count: 90 });
      sound.win(big);
      vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
    } else toast(`⚽ Penales: ganaste ${fmtGs(play.payout)} (${fmtMult(play.multiplier)})`, 'win');
    note(perfect ? '🏆 ¡Metiste los 5 penales! Tanda perfecta' : `✅ Cobraste ${fmtGs(play.payout)}`, 'good');
    holdTip(3000);
    shell.refreshMine();
  }

  function lost() {
    if (visible()) el.result.show({ win: false, head: 'Perdiste', detail: fmtGs(play.amount) });
    shell.refreshMine();
  }

  function onAction() {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (active()) cashout();
    else start();
  }

  async function start() {
    if (busy || !el) return;
    const value = amount.value;
    if (value > shell.balance) {
      toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return;
    }
    busy = true;
    starting = true;
    const my = ++seq;
    stopTweens();
    clearTimeout(idleTimer);
    el.result.hide();
    note('');
    render();
    const resetting = sceneDirty ? resetScene(380) : null;
    const res = await shell.emit('penalty:start', { amount: value });
    await resetting;
    starting = false;
    if (my !== seq) return;
    busy = false;
    if (!res.ok) {
      flushInit();
      if (res.code === 'ACTIVE') await resync();
      toast(res.error || 'No se pudo empezar la tanda', 'error');
      drawHud();
      render();
      return;
    }
    play = res.play;
    shell.setBalance(res.balance);
    sound.bet();
    setTimeout(() => visible() && sound.whistle(), 150);
    vibrate(15);
    drawHud();
    render();
    note(kickHint());
    flushInit();
  }

  async function cashout() {
    if (!active() || busy || !goals()) return;
    busy = true;
    render();
    const res = await shell.emit('penalty:cashout', { id: play.id });
    busy = false;
    if (!res.ok) {
      flushInit();
      if (['ENDED', 'NO_PLAY', 'TIMEOUT', 'OFFLINE'].includes(res.code)) await resync();
      toast(res.error || 'No se pudo retirar', 'error');
      drawHud();
      render();
      return;
    }
    play = res.play;
    shell.setBalance(res.balance);
    drawHud();
    celebrate();
    render();
    flushInit();
  }

  function pickRandom() {
    if (!canKick()) return;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    kick(bytes[0] % ZONES);
  }

  function onZone(zone) {
    if (!shell.state.user) {
      shell.requireUser();
      return;
    }
    if (busy) return;
    if (!active()) {
      // Todavía no empezó la tanda: avisamos dónde tocar
      sound._ensure();
      setText(el.tip, 'Primero tocá JUGAR 👇');
      el.tip.classList.add('pn-show');
      el.tip.classList.remove('pn-alert');
      void el.tip.offsetWidth;
      el.tip.classList.add('pn-alert');
      note('Elegí el monto y tocá JUGAR para empezar la tanda ⚽');
      return;
    }
    kick(zone);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const zone = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[e.code];
    if (zone === undefined || !el || !visible() || !canKick()) return;
    if (document.body.classList.contains('modal-open')) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    kick(zone);
  }

  /** Vuelve a pedir el estado real (por ejemplo si la tanda terminó en otra pestaña). */
  async function resync() {
    const res = await shell.emit('plays:active');
    if (res.ok) play = res.plays.penalty || (active() ? null : play);
    drawHud();
  }

  function applyInit(d) {
    const serverPlay = d.plays ? d.plays.penalty : null;
    const restored = !!serverPlay && !(active() && play.id === serverPlay.id);
    if (serverPlay) play = serverPlay;
    else if (active()) play = null;
    if (el) {
      drawHud();
      render();
      if (restored) note(kickHint(true));
    } else shell.setNavBadge('penalty', !!serverPlay);
  }

  /** Texto de ayuda para patear (en la compu también con el teclado). */
  function kickHint(restored = false) {
    const keys = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches ? ' (o con las teclas 1, 2 y 3)' : '';
    if (restored && goals()) return `Tu tanda te estaba esperando. ¡Seguí pateando! ⚽${keys}`;
    return `Tocá el arco para patear ⚽${keys}`;
  }

  function flushInit() {
    if (!deferredInit) return;
    const d = deferredInit;
    deferredInit = null;
    applyInit(d);
  }

  /** Corta cualquier animación y deja todo quieto (cierre de sesión, cambio de usuario). */
  function hardReset() {
    ++seq;
    stopTweens();
    clearTimeout(idleTimer);
    busy = false;
    starting = false;
    deferredInit = null;
    if (el) {
      neutralScene();
      el.result.hide();
      el.banner.classList.remove('pn-show');
    }
  }

  // ───────────────────────── Interfaz para la app ─────────────────────────

  function rules() {
    const li = (...c) => h('li', null, ...c);
    const steps = Array.from({ length: KICKS }, (_, i) => `${i + 1} gol${i ? 'es' : ''} ${fmtMult(core.penaltyMultiplier(i + 1))}`).join(' · ');
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('Elegí cuánto apostar y tocá ', h('b', null, 'JUGAR'), ': empieza una tanda de ', h('b', null, '5 penales'), ' contra el arquero rival.'),
        li('Tocá el arco para patear a la ', h('b', null, 'izquierda, al centro o a la derecha'), ' (en la compu también con las teclas 1, 2 y 3).'),
        li('El arquero se tira a una de las 3 zonas. Si elegiste otra, es ', h('b', null, '¡gol! ⚽'), ' y el multiplicador sube.'),
        li('Tocá ', h('b', null, 'RETIRAR'), ' cuando quieras (después del primer gol) para cobrar apuesta × multiplicador.'),
        li('Si el arquero ', h('b', null, 'ataja 🧤'), ', perdés la apuesta.'),
      ),
      h('p', { class: 'hint' }, `Multiplicadores: ${steps}.`),
      h(
        'ul',
        null,
        li('Cada penal tiene 2 de 3 chances de ser gol. Si metés los 5, se cobra solo.'),
        li('Si cerrás la página, tu tanda te espera: al volver seguís pateando donde estabas.'),
        li('Hacia dónde se tira el arquero en cada penal queda fijado con tus semillas antes de patear (provably fair): al terminar la tanda ves adónde iba en los que faltaban.'),
      ),
    );
  }

  return {
    id: 'penalty',
    mount,
    show() {
      fit();
      render();
    },
    hide() {},
    onInit(d) {
      if (busy && el) deferredInit = d;
      else applyInit(d);
    },
    onUser(user) {
      if (!user) {
        hardReset();
        play = null;
      }
      if (el) {
        drawHud();
        render();
      }
    },
    onSettings() {
      if (!el) return;
      amount.refresh();
      render();
    },
    frame(now) {
      if (tweens.size) runTweens(now);
    },
    loadMine: (container) => loadPlays(shell, container, 'penalty'),
    rules,
  };
}
