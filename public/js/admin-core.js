// Núcleo del panel de administración: estado compartido, bus de eventos, íconos y componentes de UI.
import { h, api, toast, fmtGs, fmtNum, fmtSigned, fmtDate, timeAgo, colorFor, openModal, copyText } from './shared.js';

// ───────────────────────── Bus de eventos ─────────────────────────

const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => bus.off(event, fn);
  },
  off(event, fn) {
    listeners.get(event)?.delete(fn);
  },
  emit(event, ...args) {
    for (const fn of [...(listeners.get(event) || [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[admin:${event}]`, err);
      }
    }
  },
};

/** Suscripciones de una vista: todo lo que se registra acá se limpia al salir de la vista. */
export function scope() {
  const offs = [];
  return {
    on(event, fn) {
      offs.push(bus.on(event, fn));
    },
    add(off) {
      offs.push(off);
    },
    interval(fn, ms) {
      const t = setInterval(() => {
        if (!document.hidden) fn();
      }, ms);
      offs.push(() => clearInterval(t));
    },
    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (err) {
          console.error(err);
        }
      }
    },
  };
}

// ───────────────────────── Estado compartido ─────────────────────────

export const state = {
  me: null,
  settings: {},
  stats: null,
  online: [],
  connections: 0,
  pending: { deposits: { n: 0, total: 0 }, withdrawals: { n: 0, total: 0 } },
  activity: [],
  conn: 'connecting',
};

/** Llama a la API. Si la sesión venció avisa al resto de la app (muestra el login). */
export async function call(path, opts) {
  try {
    return await api(path, opts);
  } catch (err) {
    if ((err.status === 401 && err.code === 'AUTH') || (err.status === 403 && err.code === 'FORBIDDEN')) {
      bus.emit('auth:lost', err);
    }
    throw err;
  }
}

export const post = (path, body = {}) => call(path, { method: 'POST', body });

// ───────────────────────── Íconos (SVG de trazo) ─────────────────────────

const ICONS = {
  grid: ['r 3 3 7 7 1.5', 'r 14 3 7 7 1.5', 'r 14 14 7 7 1.5', 'r 3 14 7 7 1.5'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'c 9 7 4', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  deposit: ['c 12 12 10', 'M12 7v10', 'm8 13 4 4 4-4'],
  withdraw: ['c 12 12 10', 'M12 17V7', 'm8 11 4-4 4 4'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  clipboard: ['r 8 2 8 4 1', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M12 11h4', 'M12 16h4', 'M8 11h.01', 'M8 16h.01'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  gamepad: ['r 2 6 20 12 4', 'M6 12h4', 'M8 10v4', 'M15 13h.01', 'M18 11h.01'],
  key: ['c 7.5 15.5 5.5', 'm21 2-9.6 9.6', 'm15.5 7.5 3 3L22 7l-3-3'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  bellOff: ['M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5', 'M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7', 'M10.3 21a1.94 1.94 0 0 0 3.4 0', 'm2 2 20 20'],
  search: ['c 11 11 7', 'm21 21-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36L21 8', 'M21 3v5h-5'],
  copy: ['r 9 9 13 13 2', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  pause: ['r 6 4 4 16 1', 'r 14 4 4 16 1'],
  play: ['M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  chevLeft: ['m15 18-6-6 6-6'],
  chevRight: ['m9 18 6-6-6-6'],
  chevDown: ['m6 9 6 6 6-6'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  mute: ['M11 5 6 9H2v6h4l5 4V5z', 'm22 9-6 6', 'm16 9 6 6'],
  volume: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
  ban: ['c 12 12 10', 'm4.9 4.9 14.2 14.2'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  image: ['r 3 3 18 18 2', 'c 9 9 2', 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'],
  megaphone: ['m3 11 18-5v12L3 14v-3z', 'M11.6 16.8a3 3 0 1 1-5.8-1.6'],
  trend: ['m22 7-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
  clock: ['c 12 12 10', 'M12 6v6l4 2'],
  crown: ['m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z', 'M5 20h14'],
  lock: ['r 3 11 18 11 2', 'M7 11V7a5 5 0 0 1 10 0v4'],
  send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13'],
  table: ['r 3 3 18 18 2', 'M3 9h18', 'M3 15h18', 'M9 3v18'],
  chart: ['M3 3v18h18', 'M7 16v-3', 'M12 16V8', 'M17 16v-6'],
  phone: [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  ],
  globe: ['c 12 12 10', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z', 'c 12 12 3'],
  arrowUp: ['M12 19V5', 'm5 12 7-7 7 7'],
  arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
  wallet: ['M20 12V8H6a2 2 0 0 1 0-4h12v4', 'M4 6v12a2 2 0 0 0 2 2h14v-4', 'M18 12a2 2 0 0 0 0 4h4v-4z'],
  rocket: [
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
    'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
    'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0',
    'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  ],
};

const SVGNS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVGNS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'ic',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const spec of ICONS[name] || []) {
    let el;
    if (spec.startsWith('c ')) {
      const [cx, cy, r] = spec.slice(2).split(' ');
      el = document.createElementNS(SVGNS, 'circle');
      el.setAttribute('cx', cx);
      el.setAttribute('cy', cy);
      el.setAttribute('r', r);
    } else if (spec.startsWith('r ')) {
      const [x, y, w, hh, rx] = spec.slice(2).split(' ');
      el = document.createElementNS(SVGNS, 'rect');
      el.setAttribute('x', x);
      el.setAttribute('y', y);
      el.setAttribute('width', w);
      el.setAttribute('height', hh);
      if (rx) el.setAttribute('rx', rx);
    } else {
      el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', spec);
    }
    svg.append(el);
  }
  return svg;
}

// ───────────────────────── Formatos ─────────────────────────

export const fmtPct = (n, digits = 1) =>
  Number.isFinite(n) ? n.toLocaleString('es-PY', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%' : '—';

const compactPart = (x) => x.toLocaleString('es-PY', { maximumFractionDigits: x < 10 ? 1 : 0 });

/** 1.250.000 → "1,3 M" · 350.000 → "350 mil" (para ejes de gráficos). */
export function fmtCompact(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e9) return sign + compactPart(a / 1e9) + ' mil M';
  if (a >= 1e6) return sign + compactPart(a / 1e6) + ' M';
  if (a >= 1e3) return sign + compactPart(a / 1e3) + ' mil';
  return sign + fmtNum(a);
}

export const signClass = (n) => (n > 0 ? 'green' : n < 0 ? 'red' : 'muted');

/** Monto con signo y color (ganancia de la casa, movimientos). */
export const signedMoney = (n) => h('span', { class: `num ${signClass(n)}` }, fmtSigned(n));

export function setText(el, text) {
  const t = String(text);
  if (el.textContent !== t) el.textContent = t;
}

export const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// ───────────────────────── Etiquetas ─────────────────────────

export const LEDGER_LABELS = {
  deposit: 'Depósito',
  withdraw: 'Retiro',
  withdraw_refund: 'Retiro devuelto',
  bet: 'Apuesta',
  bet_cancel: 'Apuesta cancelada',
  win: 'Ganancia',
  refund: 'Reembolso',
  admin: 'Ajuste admin',
  bonus: 'Bono',
};

const LEDGER_CHIP = {
  deposit: 'chip-green',
  withdraw: 'chip-red',
  withdraw_refund: 'chip-blue',
  bet: '',
  bet_cancel: '',
  win: 'chip-green',
  refund: 'chip-blue',
  admin: 'chip-gold',
  bonus: 'chip-purple',
};

export const ledgerChip = (type) => h('span', { class: `chip ${LEDGER_CHIP[type] ?? ''}` }, LEDGER_LABELS[type] || type);

const REQ_STATUS = {
  pending: ['Pendiente', 'chip-gold'],
  approved: ['Aprobado', 'chip-green'],
  paid: ['Pagado', 'chip-green'],
  rejected: ['Rechazado', 'chip-red'],
};
export const reqChip = (status) => {
  const [text, cls] = REQ_STATUS[status] || [status, ''];
  return h('span', { class: `chip ${cls}` }, text);
};

const BET_STATUS = {
  active: ['En juego', 'chip-blue chip-live'],
  won: ['Retiró', 'chip-green'],
  lost: ['Perdió', 'chip-red'],
  refunded: ['Devuelta', ''],
  cancelled: ['Cancelada', ''],
};
export const betChip = (status) => {
  const [text, cls] = BET_STATUS[status] || [status, ''];
  return h('span', { class: `chip ${cls}` }, text);
};

// ───────────────────────── Usuarios ─────────────────────────

export function avatar(name, size) {
  const n = String(name || '?');
  return h(
    'span',
    { class: 'avatar', style: size ? `background:${colorFor(n)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` : `background:${colorFor(n)}` },
    n.slice(0, 1),
  );
}

let userOpener = null;
export const setUserOpener = (fn) => {
  userOpener = fn;
};
export const openUser = (id) => {
  if (id && userOpener) userOpener(Number(id));
};

/** Nombre de usuario clickeable que abre la ficha del jugador. */
export function userLink(id, name, { withAvatar = true, cls = '' } = {}) {
  if (!id) return h('span', { class: 'muted' }, name || '—');
  return h(
    'button',
    {
      type: 'button',
      class: `ulink ${cls}`.trim(),
      title: 'Ver ficha del jugador',
      onclick: (e) => {
        e.stopPropagation();
        openUser(id);
      },
    },
    withAvatar ? avatar(name) : null,
    h('span', { class: 'ulink-name' }, name || `#${id}`),
  );
}

export const onlineDot = (on) => h('span', { class: `dot ${on ? 'dot-on' : 'dot-off'}`, title: on ? 'En línea' : 'Desconectado' });

/** Número para wa.me: "0981 123 456" → "595981123456". */
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('09')) d = '595' + d.slice(1);
  else if (d.length === 9 && d.startsWith('9')) d = '595' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** Navegador y sistema a partir del user-agent. */
export function uaShort(ua) {
  if (!ua) return '—';
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iPhone'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS/i.test(ua)
          ? 'Mac'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  return [br, os].filter(Boolean).join(' · ') || String(ua).slice(0, 40);
}

// ───────────────────────── Componentes ─────────────────────────

/** Tiempo relativo que se actualiza solo ("hace 3 min"). */
export const ago = (ts) => h('span', { class: 'ago', 'data-ts': ts || null, title: ts ? fmtDate(ts) : null }, timeAgo(ts));

setInterval(() => {
  for (const el of document.querySelectorAll('.ago[data-ts]')) setText(el, timeAgo(Number(el.dataset.ts)));
}, 20_000);

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const isDesktop = () => window.matchMedia('(min-width: 980px)').matches;
const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function viewHead(title, subtitle, ...actions) {
  return h(
    'div',
    { class: 'vhead' },
    h('div', { class: 'vhead-text' }, h('h1', null, title), subtitle ? h('p', null, subtitle) : null),
    actions.length ? h('div', { class: 'vhead-actions' }, actions) : null,
  );
}

export function card(title, { actions, cls = '', icon: ic, sub } = {}, ...children) {
  return h(
    'section',
    { class: `acard ${cls}`.trim() },
    title
      ? h(
          'div',
          { class: 'acard-head' },
          h('h2', { class: 'acard-title' }, ic ? icon(ic, 18) : null, h('span', null, title), sub ? h('span', { class: 'acard-sub' }, sub) : null),
          actions ? h('div', { class: 'acard-actions' }, actions) : null,
        )
      : null,
    children,
  );
}

export const emptyState = (text, emoji = '🗂️') => h('div', { class: 'empty' }, h('div', { class: 'empty-ic' }, emoji), h('div', null, text));

export const loadingState = (text = 'Cargando…') => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, text));

export const errorState = (err, retry) =>
  h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-ic' }, '⚠️'),
    h('div', null, err?.message || String(err)),
    retry ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: 'margin-top:10px', onclick: retry }, icon('refresh', 16), 'Reintentar') : null,
  );

export function iconBtn(name, label, onclick, cls = '') {
  return h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), title: label, 'aria-label': label, onclick }, icon(name, 18));
}

export function refreshBtn(onclick) {
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Actualizar' }, icon('refresh', 16), h('span', { class: 'hide-xs' }, 'Actualizar'));
  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    try {
      await onclick();
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 350);
    }
  });
  return btn;
}

export function copyBtn(text, label = 'Copiar') {
  return h(
    'button',
    {
      type: 'button',
      class: 'copy-btn',
      title: label,
      'aria-label': label,
      onclick: (e) => {
        e.stopPropagation();
        copyText(String(text ?? ''));
      },
    },
    icon('copy', 15),
  );
}

/** Control segmentado (usa el estilo .tabs de base.css). */
export function segmented(options, value, onChange, cls = '') {
  const root = h('div', { class: `tabs seg ${cls}`.trim(), role: 'tablist' });
  const render = () => {
    root.replaceChildren(
      ...options.map(([v, label, badge]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: v === value ? 'active' : null,
            'aria-selected': String(v === value),
            onclick: () => {
              if (v === value) return;
              value = v;
              render();
              onChange(v);
            },
          },
          label,
          badge ? h('span', { class: 'seg-badge' }, badge) : null,
        ),
      ),
    );
  };
  render();
  root.setValue = (v) => {
    value = v;
    render();
  };
  root.setOptions = (next) => {
    options = next;
    render();
  };
  return root;
}

/** Chips de filtro (una sola fila que se desplaza en el celular). */
export function filterChips(options, value, onChange) {
  const root = h('div', { class: 'fchips', role: 'tablist' });
  const render = () => {
    root.replaceChildren(
      ...options.map(([v, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `fchip${v === value ? ' active' : ''}`,
            'aria-pressed': String(v === value),
            onclick: () => {
              if (v === value) return;
              value = v;
              render();
              onChange(v);
            },
          },
          label,
        ),
      ),
    );
  };
  render();
  return root;
}

export function searchBox(value, placeholder, onChange, ms = 300) {
  const input = h('input', { class: 'input', type: 'search', placeholder, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  input.value = value || '';
  const fire = debounce(() => onChange(input.value.trim()), ms);
  input.addEventListener('input', fire);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onChange(input.value.trim());
    }
  });
  return h('label', { class: 'search' }, icon('search', 17), input);
}

export function pager(res, label, onPage) {
  const { page = 1, pages = 1, total = 0 } = res || {};
  const info = h('span', { class: 'pager-info' }, `${fmtNum(total)} ${label}${pages > 1 ? ` · página ${page} de ${pages}` : ''}`);
  if (pages <= 1) return h('div', { class: 'pager' }, info);
  return h(
    'div',
    { class: 'pager' },
    info,
    h(
      'div',
      { class: 'pager-btns' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: page <= 1, onclick: () => onPage(page - 1) }, icon('chevLeft', 16), 'Anterior'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Siguiente', icon('chevRight', 16)),
    ),
  );
}

/**
 * Tabla que en el celular se convierte en tarjetas.
 * cols: [{ label, key, render(row), cls, main, hideSm, sort }]
 */
export function dataTable(
  cols,
  rows,
  { onRow, empty = 'No hay datos para mostrar', emptyEmoji, rowClass, sort, compact = false, inlineMain = false, mobileLimit = 0 } = {},
) {
  if (!rows || !rows.length) return emptyState(empty, emptyEmoji);
  const head = h(
    'tr',
    null,
    cols.map((c) => {
      const cls = [c.cls, c.hideSm ? 'hide-sm' : ''].filter(Boolean).join(' ') || null;
      if (sort && c.sort) {
        const active = sort.key === c.sort;
        return h(
          'th',
          { class: cls, 'aria-sort': active ? (sort.order === 'asc' ? 'ascending' : 'descending') : null },
          h(
            'button',
            { type: 'button', class: `th-sort${active ? ' active' : ''}`, onclick: () => sort.onSort(c.sort) },
            c.label,
            active ? icon(sort.order === 'asc' ? 'arrowUp' : 'arrowDown', 13) : null,
          ),
        );
      }
      return h('th', { class: cls }, c.label);
    }),
  );
  const renderRow = (row) => {
    const tr = h(
      'tr',
      { class: [onRow ? 'clickable' : '', rowClass ? rowClass(row) : ''].filter(Boolean).join(' ') || null },
      cols.map((c) => {
        const value = c.render ? c.render(row) : row[c.key];
        const empty = value === null || value === undefined || value === '';
        return h(
          'td',
          {
            class: [c.cls, c.main ? 'rt-main' : '', c.hideSm ? 'hide-sm' : '', c.full ? 'rt-full' : '', empty ? 'is-empty' : ''].filter(Boolean).join(' ') || null,
            'data-label': c.main ? null : c.label,
          },
          empty ? h('span', { class: 'faint' }, '—') : value,
        );
      }),
    );
    if (onRow) {
      tr.tabIndex = 0;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea')) return;
        onRow(row);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === tr) onRow(row);
      });
    }
    return tr;
  };
  // En el celular las tablas largas muestran primero unas pocas filas (se ven como tarjetas).
  const narrow = mobileLimit > 0 && window.matchMedia('(max-width: 720px)').matches;
  let shown = narrow ? Math.min(rows.length, mobileLimit) : rows.length;
  const tbody = h('tbody', null, rows.slice(0, shown).map(renderRow));
  const cls = ['table', 'rt', compact ? 'rt-3' : '', inlineMain ? 'rt-inline-main' : ''].filter(Boolean).join(' ');
  const wrap = h('div', { class: 'table-wrap rt-wrap' }, h('table', { class: cls }, h('thead', null, head), tbody));
  if (shown < rows.length) {
    const more = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block rt-more' }, icon('chevDown', 16), `Ver ${rows.length - shown} más`);
    more.addEventListener('click', () => {
      tbody.append(...rows.slice(shown).map(renderRow));
      shown = rows.length;
      more.remove();
    });
    wrap.append(more);
  }
  return wrap;
}

/**
 * Sincroniza una lista con claves: reutiliza los nodos existentes (no parpadea y no se pierden clics).
 */
export function syncList(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const el of [...container.children]) {
    if (el.dataset.key !== undefined) existing.set(el.dataset.key, el);
    else el.remove();
  }
  const next = items.map((item) => {
    const key = String(keyOf(item));
    let el = existing.get(key);
    if (el) existing.delete(key);
    else {
      el = create(item);
      el.dataset.key = key;
    }
    if (update) update(el, item);
    return el;
  });
  for (const el of existing.values()) el.remove();
  next.forEach((el, i) => {
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
}

// ───────────────────────── Formularios ─────────────────────────

let fieldSeq = 0;

export function field(label, control, hint) {
  if (control && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) && !control.id) control.id = `f-${++fieldSeq}`;
  const target = control && control.id ? control.id : null;
  return h('div', { class: 'field' }, h('label', { for: target }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

function reformatMoney(input) {
  const raw = input.value;
  const caret = input.selectionStart ?? raw.length;
  const digitsBefore = raw.slice(0, caret).replace(/\D/g, '').length;
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
  const out = digits ? fmtNum(Number(digits)) : '';
  if (out === raw) return;
  input.value = out;
  let pos = 0;
  let seen = 0;
  while (pos < out.length && seen < digitsBefore) {
    if (/\d/.test(out[pos])) seen++;
    pos++;
  }
  try {
    input.setSelectionRange(pos, pos);
  } catch {
    /* algunos tipos de input no soportan selección */
  }
}

/** Input de guaraníes que agrega los puntos de miles mientras se escribe. */
export function moneyInput(value, attrs = {}) {
  const input = h('input', {
    class: 'input input-money',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    enterkeyhint: 'done',
    ...attrs,
  });
  if (value !== undefined && value !== null && value !== '') input.value = fmtNum(value);
  input.addEventListener('input', () => reformatMoney(input));
  return input;
}

/** Envuelve un input con un prefijo/sufijo visual ("Gs.", "x", "s"). */
export const adorn = (input, prefix, suffix) =>
  h(
    'div',
    { class: `adorn${prefix ? ' has-pre' : ''}${suffix ? ' has-suf' : ''}` },
    prefix ? h('span', { class: 'adorn-pre', 'aria-hidden': 'true' }, prefix) : null,
    input,
    suffix ? h('span', { class: 'adorn-suf', 'aria-hidden': 'true' }, suffix) : null,
  );

/** Chips de texto rápido que completan un input. */
export function quickPicks(values, input, format = (v) => v) {
  return h(
    'div',
    { class: 'qpicks' },
    values.map((v) =>
      h(
        'button',
        {
          type: 'button',
          class: 'qpick',
          onclick: () => {
            input.value = format(v);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
          },
        },
        typeof v === 'number' ? fmtNum(v) : v,
      ),
    ),
  );
}

/**
 * Modal con formulario: maneja el envío, el botón ocupado y muestra los errores del servidor.
 * onSubmit puede devolver false para no cerrar el modal.
 */
export function modalForm({ title, content, submitText = 'Guardar', submitClass = 'btn-primary', wide = false, onSubmit, onClose }) {
  const error = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: `btn ${submitClass}` }, submitText);
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancelar');
  const form = h('form', { class: 'mform', novalidate: true }, content, error, h('div', { class: 'modal-actions' }, cancel, submit));
  const m = openModal({ title, content: form, wide, onClose });
  cancel.addEventListener('click', () => m.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    error.textContent = '';
    submit.disabled = true;
    submit.classList.add('is-busy');
    try {
      const keep = await onSubmit({ close: m.close, setError: (t) => (error.textContent = t) });
      if (keep !== false) m.close();
    } catch (err) {
      error.textContent = err.message || 'Algo salió mal, probá de nuevo';
    } finally {
      submit.disabled = false;
      submit.classList.remove('is-busy');
    }
  });
  if (finePointer()) {
    setTimeout(() => form.querySelector('input:not([type=hidden]), textarea')?.focus(), 80);
  }
  return m;
}

/** Visor de imagen (comprobantes). */
export function imageModal(src, title = 'Comprobante') {
  openModal({
    title,
    wide: true,
    content: h(
      'div',
      { class: 'img-viewer' },
      h('img', { src, alt: title }),
      h('a', { class: 'btn btn-ghost btn-sm', href: src, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Abrir en otra pestaña'),
    ),
  });
}

export function notifyError(err) {
  toast(err?.message || 'Algo salió mal, probá de nuevo', 'error');
}

export { fmtGs };
