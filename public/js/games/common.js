// Piezas compartidas por todos los juegos (Crash, Minas, Penales, Double, Plinko y Ruleta).
import { $, h, api, fmtGs, fmtNum, fmtMult, fmtSigned, parseAmount, fmtDate, fmtTime, multClass, colorFor, toast, openModal, copyText, hmacSha256Bytes, hmacSha256Hex, sha256Hex } from '../shared.js';

/** Matemática de los juegos (public/js/games-core.js, cargado como script clásico). */
export const core = window.GamesCore;

export const GAMES = [
  { id: 'crash', path: '/', name: 'Crash', icon: '🚀', tagline: 'Retirá antes de que explote' },
  { id: 'mines', path: '/minas', name: 'Minas', icon: '💣', tagline: 'Encontrá diamantes, esquivá las minas' },
  { id: 'penalty', path: '/penales', name: 'Penales', icon: '⚽', tagline: 'Penales de la Albirroja' },
  { id: 'double', path: '/double', name: 'Double', icon: '🎡', tagline: 'Rojo, negro o blanco 30x' },
  { id: 'plinko', path: '/plinko', name: 'Plinko', icon: '🔴', tagline: 'Soltá la bolita y mirá dónde cae' },
  { id: 'roulette', path: '/ruleta', name: 'Ruleta', icon: '🎰', tagline: 'En vivo · ruleta europea' },
];
export const GAME_BY_ID = Object.fromEntries(GAMES.map((g) => [g.id, g]));
export const SEED_GAMES = ['mines', 'penalty', 'plinko'];

// ───────────────────────── Utilidades ─────────────────────────

export const store = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* modo privado */
    }
  },
};

export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* sin soporte */
  }
}

/** Cambia el texto solo si es distinto (evita trabajo del navegador en cada cuadro). */
export function setText(el, text) {
  if (el._t !== text) {
    el._t = text;
    el.textContent = text;
  }
}

export function setClass(el, cls) {
  if (el._c !== cls) {
    el._c = cls;
    el.className = cls;
  }
}

export function avatar(name, size) {
  const style = { background: colorFor(name) };
  if (size) Object.assign(style, { width: size + 'px', height: size + 'px', fontSize: size * 0.4 + 'px' });
  // Array.from separa bien los emojis (ej. "🤖 Tito")
  return h('span', { class: 'avatar', style }, Array.from(String(name || '?'))[0]);
}

export function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace('.', ',') + 'K';
  return String(n);
}

export function stepFor(v) {
  if (v < 10000) return 1000;
  if (v < 50000) return 5000;
  if (v < 200000) return 10000;
  if (v < 1000000) return 50000;
  return 100000;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Suavizados para las animaciones. */
export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────── Monto de la apuesta ─────────────────────────

/**
 * Campo de monto con − / +, mitad / doble y montos rápidos (los de la configuración).
 * El valor se guarda por juego en el navegador.
 */
export class AmountControl {
  constructor(shell, { key, def = 5000, onChange = () => {} } = {}) {
    this.shell = shell;
    this.key = key;
    this.onChange = onChange;
    this.value = Number(store.get(key, def)) || def;
    this.disabled = false;
    this.input = h('input', { class: 'amount-input', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Monto de la apuesta en guaraníes' });
    this.minus = h('button', { class: 'amt-btn', type: 'button', 'aria-label': 'Menos' }, '−');
    this.plus = h('button', { class: 'amt-btn', type: 'button', 'aria-label': 'Más' }, '+');
    this.half = h('button', { class: 'amt-mini', type: 'button', title: 'Mitad' }, '½');
    this.double = h('button', { class: 'amt-mini', type: 'button', title: 'Doble' }, '2x');
    this.quick = h('div', { class: 'quick-row' });
    this.el = h(
      'div',
      { class: 'amount-ctl' },
      h('div', { class: 'amount-row' }, this.minus, h('label', { class: 'amount-field' }, this.input), this.half, this.double, this.plus),
      this.quick,
    );
    this.input.addEventListener('input', () => {
      const v = parseAmount(this.input.value);
      this.input.value = Number.isFinite(v) ? fmtNum(v) : '';
      if (Number.isFinite(v)) {
        this.value = v;
        this.onChange(v);
      }
    });
    this.input.addEventListener('blur', () => this.set(this.value));
    this.minus.addEventListener('click', () => this.set(this.value - stepFor(this.value - 1)));
    this.plus.addEventListener('click', () => this.set(this.value + stepFor(this.value)));
    this.half.addEventListener('click', () => this.set(Math.floor(this.value / 2)));
    this.double.addEventListener('click', () => this.set(this.value * 2));
    this.refresh();
  }

  /** Vuelve a armar los montos rápidos y ajusta el valor a los límites actuales. */
  refresh() {
    const s = this.shell.state.settings;
    const list = String(s.quick_amounts || '')
      .split(',')
      .map((v) => parseInt(v, 10))
      .filter((v) => v > 0)
      .slice(0, 4);
    this.quick.replaceChildren(...list.map((v) => h('button', { type: 'button', title: fmtGs(v), onclick: () => this.set(v) }, compact(v))));
    this.quick.style.gridTemplateColumns = `repeat(${Math.max(1, list.length)}, minmax(0, 1fr))`;
    this.set(this.value, false);
  }

  set(v, notify = true) {
    const { min_bet: min, max_bet: max } = this.shell.state.settings;
    if (!Number.isFinite(v)) v = min;
    v = Math.max(min, Math.min(max, Math.round(v)));
    this.value = v;
    this.input.value = fmtNum(v);
    store.set(this.key, v);
    if (notify) this.onChange(v);
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    this.el.classList.toggle('locked', disabled);
    for (const b of [this.input, this.minus, this.plus, this.half, this.double, ...this.quick.children]) b.disabled = disabled;
  }
}

/** Botón grande de acción (APOSTAR / RETIRAR…), con el mismo estilo que el del Crash. */
export function actionButton(onClick) {
  const title = h('span', { class: 'bp-action-title' });
  const sub = h('span', { class: 'bp-action-sub' });
  const el = h('button', { class: 'bp-action', type: 'button' }, title, sub);
  el.addEventListener('click', onClick);
  return {
    el,
    set({ text, detail = '', color = '', disabled = false }) {
      setClass(el, `bp-action${color ? ' ' + color : ''}`);
      setText(title, text);
      setText(sub, detail);
      el.disabled = disabled;
    },
  };
}

/** Selector de opciones en forma de pastillas (riesgo, filas, minas…). */
export function segmented(options, { value, onChange, className = '' } = {}) {
  const el = h('div', { class: `segmented ${className}`, role: 'radiogroup' });
  let current = value;
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'data-value': String(o.value),
        title: o.title || '',
        onclick: () => {
          if (el.classList.contains('locked')) return;
          api_.set(o.value);
          onChange(o.value);
        },
      },
      o.label,
    ),
  );
  el.append(...buttons);
  const api_ = {
    el,
    get value() {
      return current;
    },
    set(v) {
      current = v;
      buttons.forEach((b, i) => {
        const on = options[i].value === v;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    },
    setDisabled(d) {
      el.classList.toggle('locked', d);
      buttons.forEach((b) => (b.disabled = d));
    },
  };
  api_.set(value);
  return api_;
}

/** Cartel animado de premio dentro del escenario del juego. */
export function winPop(layer, { amount, label, big = false }) {
  const node = h('div', { class: `win-pop${big ? ' big' : ''}` }, h('span', { class: 'wp-amount' }, `+${fmtGs(amount)}`), h('span', { class: 'wp-label' }, label));
  layer.append(node);
  setTimeout(() => node.remove(), 2500);
}

/** ¿Es una ganancia grande? (para festejar más fuerte) */
export const isBigWin = (payout, amount, multiplier) => multiplier >= 1000 || payout - amount >= 500000;

/** Cartel grande de resultado sobre el escenario (ganaste / perdiste). */
export function resultOverlay() {
  const title = h('span', { class: 'r-mult' });
  const text = h('span', { class: 'r-amount' });
  const el = h('div', { class: 'gv-result' }, title, text);
  let timer = null;
  return {
    el,
    show({ win, head, detail = '', big = false, ms = win ? 2600 : 2000 }) {
      clearTimeout(timer);
      el.className = `gv-result${win ? '' : ' lose'}${big ? ' big' : ''}`;
      title.textContent = head;
      text.textContent = detail;
      void el.offsetWidth;
      el.classList.add('show');
      if (ms) timer = setTimeout(() => el.classList.remove('show'), ms);
    },
    hide() {
      clearTimeout(timer);
      el.classList.remove('show');
    },
  };
}

/** Encabezado del panel de un juego: nombre + botones (semillas provably fair, reglas). */
export function panelHead(shell, { icon, name, seeds = true, extra = [] }) {
  return h(
    'div',
    { class: 'gv-head' },
    h('div', { class: 'gv-title' }, h('span', { class: 'gv-icon' }, icon), name),
    h(
      'div',
      { class: 'gv-tools' },
      ...extra,
      seeds ? h('button', { class: 'gv-tool', type: 'button', title: 'Provably fair: tus semillas', onclick: () => openFairness(shell) }, '🔐 Justo') : null,
      h('button', { class: 'gv-tool', type: 'button', title: 'Cómo jugar', onclick: () => shell.openRules() }, '❓ Reglas'),
    ),
  );
}

/** Lluvia de papelitos (albirroja) sobre un contenedor. */
export function confetti(layer, { count = 60, colors = ['#ff3b4e', '#ffffff', '#3d7bff', '#ffc53d'] } = {}) {
  if (reducedMotion()) return;
  const box = h('div', { class: 'confetti' });
  for (let i = 0; i < count; i++) {
    const piece = h('i');
    piece.style.left = Math.random() * 100 + '%';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = Math.random() * 0.35 + 's';
    piece.style.animationDuration = 1.3 + Math.random() * 1.1 + 's';
    piece.style.setProperty('--dx', (Math.random() * 2 - 1) * 90 + 'px');
    piece.style.setProperty('--rot', Math.random() * 720 - 360 + 'deg');
    box.append(piece);
  }
  layer.append(box);
  setTimeout(() => box.remove(), 2800);
}

/** Marca "juego pausado por el administrador" sobre el escenario de un juego. */
export function pausedNotice() {
  return h('div', { class: 'game-paused', hidden: true }, h('b', null, '⏸ Juego en pausa'), h('span', null, 'El administrador pausó este juego por un momento. Probá los demás 🙌'));
}

// ───────────────────────── Mis apuestas / detalle de jugadas ─────────────────────────

const RISK_NAMES = { low: 'bajo', medium: 'medio', high: 'alto' };
const ROULETTE_BET_NAMES = {
  red: 'Rojo',
  black: 'Negro',
  odd: 'Impar',
  even: 'Par',
  low: '1 a 18',
  high: '19 a 36',
};

export function rouletteBetName(b) {
  if (b.type === 'n') return `Pleno ${b.value}`;
  if (b.type === 'dozen') return `${b.value}ª docena`;
  if (b.type === 'column') return `${b.value}ª columna`;
  return ROULETTE_BET_NAMES[b.type] || b.type;
}

export const ROULETTE_EMOJI = { red: '🔴', black: '⚫\uFE0F', green: '🟢' };
export const ROULETTE_COLOR_NAMES = { red: 'rojo', black: 'negro', green: 'verde' };

/** Resumen de las fichas de una apuesta: las más grandes primero ("Rojo, Pleno 17 y 2 más"). */
export function rouletteBetsLabel(bets, max = 2) {
  const names = [...(bets || [])].sort((a, b) => b.amount - a.amount).map(rouletteBetName);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} y ${names.length - max} más`;
}

/** Resumen corto de una jugada (para listas). */
export function playSummary(p) {
  switch (p.game) {
    case 'mines': {
      const n = (p.revealed || []).length - (p.hit !== null && p.hit !== undefined ? 1 : 0);
      return `${p.params.mines} mina${p.params.mines === 1 ? '' : 's'} · ${n} diamante${n === 1 ? '' : 's'}`;
    }
    case 'penalty': {
      const goals = (p.kicks || []).filter((k) => k.goal).length;
      return `${goals} gol${goals === 1 ? '' : 'es'}${(p.kicks || []).some((k) => !k.goal) ? ' · atajado' : ''}`;
    }
    case 'plinko':
      return `${p.params.rows} filas · riesgo ${RISK_NAMES[p.params.risk] || p.params.risk}`;
    case 'roulette': {
      if (p.status === 'refunded') return `${rouletteBetsLabel(p.bets)} · devuelta`;
      const n = p.result ?? p.number;
      return `${rouletteBetsLabel(p.bets)} · salió ${n} ${ROULETTE_EMOJI[core.rouletteColor(n)]}`;
    }
    default:
      return '';
  }
}

/** Lista "Mis apuestas" de un juego con semillas. */
export async function loadPlays(shell, container, game) {
  if (!shell.state.user) {
    container.replaceChildren(
      h('div', { class: 'empty' }, 'Ingresá para ver tus jugadas', h('br'), h('br'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => shell.openAuth('login') }, 'Ingresar')),
    );
    return;
  }
  try {
    const { items } = await api(`/api/plays?game=${game}&limit=40`);
    if (!items.length) {
      container.replaceChildren(h('div', { class: 'empty' }, 'Todavía no jugaste acá. ¡Probá suerte! 🍀'));
      return;
    }
    container.replaceChildren(
      h(
        'button',
        { class: 'btn btn-ghost btn-sm btn-block mine-fair', type: 'button', onclick: () => openFairness(shell) },
        '🔐 Mis semillas (provably fair)',
      ),
      ...items.map((p) => playRow(shell, p)),
    );
  } catch (err) {
    container.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

export function playRow(shell, p, onclick) {
  // En Plinko se puede cobrar menos de lo apostado (ej. 0.49x): eso es una pérdida, no una ganancia
  const net = p.payout - p.amount;
  const back = p.payout > 0;
  const badge = h('span', { class: `mr-badge ${back ? (net > 0 ? multClass(p.multiplier) : 'muted') : 'red'}` }, back ? fmtMult(p.multiplier) : GAME_BY_ID[p.game].icon);
  const result = h('span', { class: net > 0 ? 'green' : net < 0 ? 'red' : 'muted' }, fmtSigned(net));
  return h(
    'div',
    { class: 'mine-row', style: { cursor: 'pointer' }, onclick: onclick || (() => openPlay(shell, p.id)) },
    badge,
    h('div', { class: 'mr-main' }, h('div', { class: 'mr-top' }, `Apostaste ${fmtGs(p.amount)}`), h('div', { class: 'mr-sub' }, `${playSummary(p)} · ${fmtTime(p.createdAt)}`)),
    h('div', { class: 'mr-result' }, result),
  );
}

/** Dibujo del resultado de una jugada (para el detalle y el verificador). */
export function playVisual(p) {
  switch (p.game) {
    case 'mines': {
      const mines = new Set(p.mines || []);
      const revealed = new Set(p.revealed || []);
      return h(
        'div',
        { class: 'mini-mines' },
        ...Array.from({ length: 25 }, (_, i) => {
          const isMine = mines.has(i);
          const cls = i === p.hit ? 'hit' : revealed.has(i) ? 'gem' : isMine ? 'mine' : '';
          return h('span', { class: `mm ${cls}` }, i === p.hit ? '💥' : isMine ? '💣' : revealed.has(i) ? '💎' : '');
        }),
      );
    }
    case 'penalty': {
      const zones = ['Izquierda', 'Centro', 'Derecha'];
      const kicks = p.kicks || [];
      return h(
        'div',
        { class: 'mini-kicks' },
        ...Array.from({ length: core.PENALTY_KICKS }, (_, i) => {
          const k = kicks[i];
          const keeper = p.keepers ? p.keepers[i] : null;
          if (!k) return h('div', { class: 'mk pending' }, h('b', null, `${i + 1}`), h('small', null, keeper !== null ? `🧤 ${zones[keeper]}` : '—'));
          return h('div', { class: `mk ${k.goal ? 'goal' : 'saved'}` }, h('b', null, k.goal ? '⚽ Gol' : '🧤 Atajó'), h('small', null, `Pateaste ${zones[k.zone].toLowerCase()} · arquero ${zones[k.keeper].toLowerCase()}`));
        }),
      );
    }
    case 'plinko': {
      const table = core.PLINKO[p.params.rows][p.params.risk];
      return h(
        'div',
        { class: 'mini-plinko' },
        h('div', { class: 'mp-path' }, ...(p.path || []).map((d) => h('span', null, d ? '↘' : '↙'))),
        h(
          'div',
          { class: 'mp-buckets' },
          ...table.map((m, i) => h('span', { class: `${i === p.bucket ? 'on ' : ''}${m >= 1000 ? 'hot' : m >= 200 ? 'warm' : m >= 100 ? 'mid' : 'cold'}` }, (m / 100).toString())),
        ),
      );
    }
    case 'roulette': {
      // Sirve para una apuesta de la ruleta en vivo ({ result, bets })
      const n = p.result ?? p.number;
      const color = core.rouletteColor(n);
      const bets = (p.bets || (p.params && p.params.bets) || []).map((b) => {
        const win = core.rouletteWins(b, n);
        return h(
          'tr',
          null,
          h('td', null, rouletteBetName(b)),
          h('td', { class: 'num' }, fmtGs(b.amount)),
          h('td', { class: `num ${win ? 'green' : 'muted'}` }, win ? fmtGs(Math.floor((b.amount * core.ROULETTE_PAYS[b.type]) / 100)) : '—'),
        );
      });
      return h(
        'div',
        { class: 'mini-roulette' },
        h('div', { class: `mr-number ${color}` }, String(n)),
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Apuesta'), h('th', { class: 'num' }, 'Monto'), h('th', { class: 'num' }, 'Cobro'))), h('tbody', null, ...bets)),
        ),
      );
    }
    default:
      return null;
  }
}

/** Recalcula el resultado de una jugada con las semillas (lo mismo que hace el servidor). */
export function recompute(game, params, serverSeed, clientSeed, nonce) {
  const floats = core.seedFloats(hmacSha256Bytes, serverSeed, clientSeed, nonce, 24);
  switch (game) {
    case 'mines':
      return { mines: core.minesPositions(floats, params.mines) };
    case 'penalty':
      return { keepers: core.penaltyKeepers(floats) };
    case 'plinko':
      return core.plinkoResult(floats, params.rows, params.risk);
    default:
      return null;
  }
}

function sameResult(p, r) {
  switch (p.game) {
    case 'mines':
      return JSON.stringify(r.mines) === JSON.stringify(p.mines);
    case 'penalty':
      return JSON.stringify(r.keepers) === JSON.stringify(p.keepers);
    case 'plinko':
      return JSON.stringify(r.path) === JSON.stringify(p.path) && r.bucket === p.bucket;
    default:
      return false;
  }
}

/** Detalle de una jugada con su verificación. */
export async function openPlay(shell, id) {
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  const modal = openModal({ title: `Jugada #${id}`, content: body, wide: true });
  try {
    const { play: p, user, seed } = await api(`/api/plays/${id}`);
    const g = GAME_BY_ID[p.game];
    modal.modal.querySelector('.modal-head h3').textContent = `${g.icon} ${g.name} · jugada #${p.id}`;
    const verifyOut = h('div');
    const verify = () => {
      const r = recompute(p.game, p.params, seed.serverSeed, seed.clientSeed, p.nonce);
      const hashOk = sha256Hex(seed.serverSeed) === seed.serverHash;
      const ok = hashOk && sameResult(p, r);
      verifyOut.replaceChildren(
        h(
          'div',
          { class: `verify-box ${ok ? 'ok' : 'bad'}` },
          h('div', null, `${hashOk ? '✅' : '❌'} SHA-256 de la semilla del servidor = hash que se mostró antes de jugar`),
          h('div', null, `${sameResult(p, r) ? '✅' : '❌'} Con las semillas y el nonce ${p.nonce} sale exactamente este resultado`),
        ),
      );
    };
    body.replaceChildren(
      h(
        'div',
        { class: 'round-hero' },
        h('div', { class: `rh-mult ${p.status === 'won' ? multClass(p.multiplier) : 'muted'}` }, p.status === 'won' ? fmtMult(p.multiplier) : '0.00x'),
        h('small', null, `${user} · ${fmtDate(p.createdAt)} · apostó ${fmtGs(p.amount)} · ${p.status === 'won' ? 'cobró ' + fmtGs(p.payout) : 'perdió'}`),
      ),
      playVisual(p),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Semilla servidor'),
        h('dd', { class: 'mono' }, seed.revealed ? seed.serverSeed : '🔒 Se revela cuando cambies tus semillas'),
        h('dt', null, 'Hash servidor'),
        h('dd', { class: 'mono' }, seed.serverHash),
        h('dt', null, 'Semilla cliente'),
        h('dd', { class: 'mono' }, seed.clientSeed),
        h('dt', null, 'Nonce'),
        h('dd', null, String(p.nonce)),
      ),
      seed.revealed
        ? h('button', { class: 'btn btn-blue btn-block', type: 'button', onclick: verify }, '✔ Verificar en este dispositivo')
        : h(
            'div',
            { class: 'verify-box' },
            'La semilla del servidor todavía está en uso. Cuando la cambies desde ',
            h('b', null, '🔐 Mis semillas'),
            ' se revela y podés comprobar esta jugada.',
            shell.state.user && shell.state.user.username === user
              ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => (modal.close(), openFairness(shell)) }, '🔐 Mis semillas'))
              : null,
          ),
      verifyOut,
      h(
        'p',
        { style: { textAlign: 'center', margin: '10px 0 0' } },
        h('a', { href: `/fair?game=${p.game}&play=${p.id}` }, '¿Cómo funciona? Verificación completa →'),
      ),
    );
    if (seed.revealed) verify();
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

/** Mis semillas: ver el par actual, elegir mi semilla y cambiar el par (revela la semilla vieja). */
export async function openFairness(shell) {
  if (!shell.requireUser()) return;
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  openModal({ title: '🔐 Mis semillas · Provably fair', content: body, wide: true });
  const render = (info, revealed) => {
    const input = h('input', { class: 'input mono', maxlength: 32, value: info.current.clientSeed, autocomplete: 'off', spellcheck: 'false' });
    const random = h('button', { class: 'btn btn-ghost', type: 'button', title: 'Semilla al azar' }, '🎲');
    random.addEventListener('click', () => {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      input.value = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    });
    const error = h('div', { class: 'form-error' });
    const rotate = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, '🔄 Cambiar semillas');
    rotate.addEventListener('click', async () => {
      error.textContent = '';
      const clientSeed = input.value.trim();
      if (clientSeed && !/^[A-Za-z0-9_-]{1,32}$/.test(clientSeed)) {
        error.textContent = 'Usá hasta 32 letras, números, guiones o guiones bajos';
        return;
      }
      rotate.disabled = true;
      try {
        const next = await api('/api/seeds/rotate', { method: 'POST', body: { clientSeed } });
        toast('Semillas cambiadas. La anterior ya se puede verificar ✅', 'success');
        render(next, next.previous[0]);
      } catch (err) {
        error.textContent = err.message;
        rotate.disabled = false;
      }
    });
    const prev = info.previous.map((s) =>
      h(
        'div',
        { class: `seed-card${revealed && revealed.id === s.id ? ' fresh' : ''}` },
        h(
          'dl',
          { class: 'kv' },
          h('dt', null, 'Semilla servidor'),
          h('dd', { class: 'mono' }, s.serverSeed, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(s.serverSeed) }, '📋')),
          h('dt', null, 'Hash'),
          h('dd', { class: 'mono' }, s.serverHash),
          h('dt', null, 'Semilla cliente'),
          h('dd', { class: 'mono' }, s.clientSeed),
          h('dt', null, 'Jugadas'),
          h('dd', null, `${fmtNum(s.nonce)} (nonce 0 a ${Math.max(0, s.nonce - 1)}) · usada hasta ${fmtDate(s.revealedAt)}`),
        ),
        h('a', { class: 'seed-verify', href: `/fair?game=seeds&server=${s.serverSeed}&client=${encodeURIComponent(s.clientSeed)}` }, 'Verificar estas jugadas →'),
      ),
    );
    body.replaceChildren(
      h(
        'p',
        { class: 'hint', style: { marginTop: 0 } },
        'Cada resultado de Minas, Penales y Plinko sale de tres datos: la semilla del servidor (secreta; antes de jugar ves su hash), tu semilla y el número de jugada (nonce). Como el hash ya está publicado, el casino no puede cambiar nada. Al cambiar las semillas se revela la del servidor y podés comprobar todas tus jugadas. (El Crash, el Double y la Ruleta son en vivo: se verifican con su cadena de hashes.)',
      ),
      h(
        'div',
        { class: 'seed-current' },
        h('div', { class: 'field' }, h('label', null, 'Hash de la semilla del servidor (activa)'), h('div', { class: 'mono seed-hash' }, info.current.serverHash, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(info.current.serverHash) }, '📋'))),
        h('div', { class: 'field' }, h('label', null, 'Tu semilla (cliente)'), h('div', { class: 'seed-input' }, input, random), h('span', { class: 'hint' }, 'Podés escribir la que quieras. Se usa desde el próximo cambio de semillas.')),
        h('div', { class: 'field' }, h('label', null, 'Jugadas con este par (nonce)'), h('b', null, fmtNum(info.current.nonce))),
        error,
        rotate,
      ),
      info.previous.length ? h('h4', { style: { margin: '18px 0 8px' } }, 'Semillas anteriores (ya reveladas)') : null,
      ...prev,
    );
  };
  try {
    render(await api('/api/seeds'));
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ───────────────────────── Double: detalle de ronda ─────────────────────────

export const DOUBLE_COLORS = { red: 'Rojo', black: 'Negro', white: 'Blanco' };

export async function openDoubleRound(shell, id) {
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  openModal({ title: `🎡 Double · ronda #${id}`, content: body, wide: true });
  try {
    const data = await api(`/api/double/rounds/${id}`);
    const r = data.round;
    if (!r.hash) {
      body.replaceChildren(h('div', { class: 'empty' }, 'Esta ronda todavía no giró. El hash se revela cuando gira 🔒'));
      return;
    }
    const chain = data.chain;
    const color = core.doubleColor(r.result);
    const prevHash = data.previous ? data.previous.hash : r.chain_index === 1 ? chain.terminal_hash : null;
    const verifyOut = h('div');
    const verify = () => {
      const tile = core.doubleTileFromHmac(hmacSha256Hex(chain.salt, r.hash));
      const link = prevHash ? sha256Hex(r.hash) === prevHash : null;
      const ok = tile === r.result && link !== false;
      verifyOut.replaceChildren(
        h(
          'div',
          { class: `verify-box ${ok ? 'ok' : 'bad'}` },
          h('div', null, `${tile === r.result ? '✅' : '❌'} El hash da la casilla ${tile} (${DOUBLE_COLORS[core.doubleColor(tile)].toLowerCase()})`),
          link === null ? h('div', null, 'ℹ️ No tenemos el hash anterior para comprobar la cadena.') : h('div', null, `${link ? '✅' : '❌'} SHA-256 de este hash = hash de la ronda anterior`),
        ),
      );
    };
    const rows = data.bets.map((b) =>
      h(
        'tr',
        null,
        h('td', null, b.user),
        h('td', null, h('span', { class: `dbl-dot ${b.color}` }), ' ', DOUBLE_COLORS[b.color]),
        h('td', { class: 'num' }, fmtGs(b.amount)),
        h('td', { class: `num ${b.status === 'won' ? 'green' : b.status === 'lost' ? 'red' : 'muted'}` }, b.status === 'won' ? fmtSigned(b.payout - b.amount) : b.status === 'lost' ? fmtSigned(-b.amount) : 'devuelta'),
      ),
    );
    body.replaceChildren(
      h(
        'div',
        { class: 'round-hero' },
        h('div', { class: `dbl-result-tile ${color}` }, color === 'white' ? '★' : String(r.result)),
        h('small', null, r.status === 'cancelled' ? 'Ronda anulada (no se jugó)' : `${fmtDate(r.ended_at)} · ${r.players} jugador${r.players === 1 ? '' : 'es'} · apostado ${fmtGs(r.total_bet)}`),
      ),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Hash'),
        h('dd', { class: 'mono' }, r.hash, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(r.hash) }, '📋')),
        h('dt', null, r.chain_index === 1 ? 'Hash terminal' : 'Hash anterior'),
        h('dd', { class: 'mono' }, prevHash || '—'),
        h('dt', null, 'Sal (salt)'),
        h('dd', { class: 'mono' }, chain.salt),
        h('dt', null, 'Cadena'),
        h('dd', null, `#${chain.id} · ronda ${fmtNum(r.chain_index)} de ${fmtNum(chain.length)}`),
      ),
      h('button', { class: 'btn btn-blue btn-block', type: 'button', onclick: verify }, '✔ Verificar en este dispositivo'),
      verifyOut,
      h('p', { style: { textAlign: 'center', margin: '10px 0' } }, h('a', { href: `/fair?game=double&hash=${r.hash}&salt=${chain.salt}` }, '¿Cómo funciona? Verificación completa →')),
      rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Jugador'), h('th', null, 'Color'), h('th', { class: 'num' }, 'Apuesta'), h('th', { class: 'num' }, 'Resultado'))),
              h('tbody', null, ...rows),
            ),
          )
        : h('div', { class: 'empty' }, 'Nadie apostó en esta ronda'),
    );
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ───────────────────────── 🎰 Ruleta en vivo: detalle de ronda y mis apuestas ─────────────────────────

/** Bolita con el número y su color (para listas y detalles). Clase rn-ball (rl-* es de la pantalla de la Ruleta). */
export function rouletteBall(n, extra = '') {
  return h('span', { class: `rn-ball ${core.rouletteColor(n)}${extra ? ' ' + extra : ''}` }, String(n));
}

export async function openRouletteRound(shell, id) {
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  openModal({ title: `🎰 Ruleta · ronda #${id}`, content: body, wide: true });
  try {
    const data = await api(`/api/roulette/rounds/${id}`);
    const r = data.round;
    if (!r.hash) {
      body.replaceChildren(h('div', { class: 'empty' }, 'Esta ronda todavía no giró. El hash se revela cuando gira 🔒'));
      return;
    }
    const chain = data.chain;
    const color = core.rouletteColor(r.result);
    const prevHash = data.previous ? data.previous.hash : r.chain_index === 1 ? chain.terminal_hash : null;
    const verifyOut = h('div');
    const verify = () => {
      const n = core.rouletteNumberFromHmac(hmacSha256Hex(chain.salt, r.hash));
      const link = prevHash ? sha256Hex(r.hash) === prevHash : null;
      const ok = n === r.result && link !== false;
      verifyOut.replaceChildren(
        h(
          'div',
          { class: `verify-box ${ok ? 'ok' : 'bad'}` },
          h('div', null, `${n === r.result ? '✅' : '❌'} El hash da el número ${n} (${ROULETTE_COLOR_NAMES[core.rouletteColor(n)]})`),
          link === null ? h('div', null, 'ℹ️ No tenemos el hash anterior para comprobar la cadena.') : h('div', null, `${link ? '✅' : '❌'} SHA-256 de este hash = hash de la ronda anterior`),
        ),
      );
    };
    const rows = data.bets.map((b) =>
      h(
        'tr',
        null,
        h('td', null, b.user),
        h('td', { class: 'rn-bets-cell' }, rouletteBetsLabel(b.bets, 3)),
        h('td', { class: 'num' }, fmtGs(b.amount)),
        h(
          'td',
          { class: `num ${b.status === 'refunded' ? 'muted' : b.payout > b.amount ? 'green' : b.payout < b.amount ? 'red' : 'muted'}` },
          b.status === 'refunded' ? 'devuelta' : fmtSigned(b.payout - b.amount),
        ),
      ),
    );
    body.replaceChildren(
      h(
        'div',
        { class: 'round-hero' },
        rouletteBall(r.result, 'big'),
        h('small', null, r.status === 'cancelled' ? 'Ronda anulada (no se jugó)' : `${fmtDate(r.ended_at)} · ${r.players} jugador${r.players === 1 ? '' : 'es'} · apostado ${fmtGs(r.total_bet)}`),
        r.status === 'cancelled' ? null : h('div', { class: 'rn-hero-name' }, `Salió el ${r.result} ${ROULETTE_EMOJI[color]} ${ROULETTE_COLOR_NAMES[color]}`),
      ),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Hash'),
        h('dd', { class: 'mono' }, r.hash, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(r.hash) }, '📋')),
        h('dt', null, r.chain_index === 1 ? 'Hash terminal' : 'Hash anterior'),
        h('dd', { class: 'mono' }, prevHash || '—'),
        h('dt', null, 'Sal (salt)'),
        h('dd', { class: 'mono' }, chain.salt),
        h('dt', null, 'Cadena'),
        h('dd', null, `#${chain.id} · ronda ${fmtNum(r.chain_index)} de ${fmtNum(chain.length)}`),
      ),
      h('button', { class: 'btn btn-blue btn-block', type: 'button', onclick: verify }, '✔ Verificar en este dispositivo'),
      verifyOut,
      h('p', { style: { textAlign: 'center', margin: '10px 0' } }, h('a', { href: `/fair?game=roulette&hash=${r.hash}&salt=${chain.salt}` }, '¿Cómo funciona? Verificación completa →')),
      rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Jugador'), h('th', null, 'Fichas'), h('th', { class: 'num' }, 'Apuesta'), h('th', { class: 'num' }, 'Resultado'))),
              h('tbody', null, ...rows),
            ),
          )
        : h('div', { class: 'empty' }, 'Nadie apostó en esta ronda'),
    );
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

/** Una fila de "Mis apuestas" de la Ruleta (abre la ronda para verla y verificarla). */
export function rouletteMineRow(shell, p) {
  const refunded = p.status === 'refunded';
  const net = p.payout - p.amount;
  const badge = refunded
    ? h('span', { class: 'mr-badge muted' }, '↩')
    : h('span', { class: `mr-badge rn-badge ${core.rouletteColor(p.result)}${p.payout > 0 ? '' : ' off'}` }, String(p.result));
  const result = refunded ? h('span', { class: 'muted' }, 'Devuelta') : h('span', { class: net > 0 ? 'green' : net < 0 ? 'red' : 'muted' }, fmtSigned(net));
  const sub = refunded
    ? `Ronda #${p.roundId} · apuesta devuelta · ${fmtTime(p.createdAt)}`
    : `Ronda #${p.roundId} · salió ${p.result} ${ROULETTE_EMOJI[core.rouletteColor(p.result)]} · ${fmtTime(p.createdAt)}`;
  return h(
    'div',
    { class: 'mine-row', style: { cursor: 'pointer' }, title: 'Ver la ronda y verificarla', onclick: () => openRouletteRound(shell, p.roundId) },
    badge,
    h('div', { class: 'mr-main' }, h('div', { class: 'mr-top' }, `Apostaste ${fmtGs(p.amount)} · ${rouletteBetsLabel(p.bets)}`), h('div', { class: 'mr-sub' }, sub)),
    h('div', { class: 'mr-result' }, result),
  );
}

/** Lista "Mis apuestas" de la Ruleta. */
export async function loadRouletteMine(shell, container) {
  if (!shell.state.user) {
    container.replaceChildren(
      h('div', { class: 'empty' }, 'Ingresá para ver tus apuestas', h('br'), h('br'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => shell.openAuth('login') }, 'Ingresar')),
    );
    return;
  }
  try {
    const { items } = await api('/api/plays?game=roulette&limit=40');
    if (!items.length) {
      container.replaceChildren(h('div', { class: 'empty' }, 'Todavía no jugaste acá. ¡Probá suerte! 🍀'));
      return;
    }
    container.replaceChildren(...items.map((p) => rouletteMineRow(shell, p)));
  } catch (err) {
    container.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

export { $, h, api, fmtGs, fmtNum, fmtMult, fmtSigned, parseAmount, fmtDate, fmtTime, multClass, toast, openModal, copyText };
