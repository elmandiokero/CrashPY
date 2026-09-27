// Movimientos (libro contable global) y auditoría de acciones de los administradores.
import { h, fmtGs, fmtNum, fmtMult, fmtDate } from './shared.js';
import {
  call,
  viewHead,
  refreshBtn,
  dataTable,
  pager,
  searchBox,
  userLink,
  ledgerChip,
  LEDGER_LABELS,
  errorState,
  loadingState,
  signedMoney,
  fmtPct,
} from './admin-core.js';

// ───────────────────────── Movimientos ─────────────────────────

const lq = { type: '', q: '', page: 1 };

const LEDGER_COLS = [
  { label: 'Movimiento', main: true, render: (l) => h('div', { class: 'led-main' }, ledgerChip(l.type), userLink(l.user_id, l.username)) },
  { label: 'Monto', cls: 'num', render: (l) => signedMoney(l.amount) },
  { label: 'Saldo después', cls: 'num', render: (l) => fmtGs(l.balance_after) },
  { label: 'Nota', cls: 'wrap-cell', render: (l) => l.note },
  { label: 'Admin', render: (l) => (l.admin ? h('span', { class: 'chip chip-gold' }, l.admin) : null) },
  { label: 'Fecha', cls: 'num', render: (l) => fmtDate(l.created_at) },
];

export const ledgerView = {
  seq: 0,
  mount(el) {
    const box = h('div', { class: 'log-box' }, loadingState());
    const type = h(
      'select',
      { class: 'input', 'aria-label': 'Tipo de movimiento' },
      h('option', { value: '' }, 'Todos los tipos'),
      Object.entries(LEDGER_LABELS).map(([k, v]) => h('option', { value: k }, v)),
    );
    type.value = lq.type;
    const load = async () => {
      const seq = ++this.seq;
      box.classList.add('is-refreshing');
      try {
        const qs = new URLSearchParams({ type: lq.type, q: lq.q, page: String(lq.page) });
        const res = await call(`/api/admin/ledger?${qs}`);
        if (seq !== this.seq) return;
        box.replaceChildren(
          h('section', { class: 'acard acard-flush' }, dataTable(LEDGER_COLS, res.items, { empty: 'No hay movimientos con ese filtro', emptyEmoji: '📒' })),
          pager(res, res.total === 1 ? 'movimiento' : 'movimientos', (p) => {
            lq.page = p;
            load();
          }),
        );
      } catch (err) {
        if (seq === this.seq) box.replaceChildren(errorState(err, load));
      } finally {
        if (seq === this.seq) box.classList.remove('is-refreshing');
      }
    };
    type.addEventListener('change', () => {
      lq.type = type.value;
      lq.page = 1;
      load();
    });
    el.append(
      viewHead('Movimientos', 'Cada cambio de saldo de cada jugador queda registrado acá.', refreshBtn(load)),
      h(
        'div',
        { class: 'toolbar' },
        searchBox(lq.q, 'Buscar por usuario…', (q) => {
          lq.q = q;
          lq.page = 1;
          load();
        }),
        h('div', { class: 'toolbar-row' }, type),
      ),
      box,
    );
    load();
  },
  unmount() {
    this.seq++;
  },
};

// ───────────────────────── Auditoría ─────────────────────────

const ACTIONS = {
  balance: ['💰', 'Ajuste de saldo'],
  flags: ['🚫', 'Suspensión / silencio'],
  password: ['🔑', 'Cambio de contraseña'],
  note: ['📝', 'Nota interna'],
  role: ['👑', 'Cambio de rol'],
  deposit_approve: ['✅', 'Depósito aprobado'],
  deposit_reject: ['❌', 'Depósito rechazado'],
  withdraw_pay: ['💸', 'Retiro pagado'],
  withdraw_reject: ['↩️', 'Retiro rechazado'],
  game_stop: ['💥', 'Ronda explotada'],
  game_pause: ['⏸️', 'Juego pausado'],
  game_resume: ['▶️', 'Juego reanudado'],
  settings: ['⚙️', 'Configuración'],
  chain_rotate: ['🔐', 'Cadena nueva'],
  chat_announce: ['📢', 'Anuncio en el chat'],
  chat_clear: ['🧹', 'Chat limpiado'],
  chat_delete: ['🗑️', 'Mensaje borrado'],
  backup: ['💾', 'Respaldo creado'],
};

const yesNo = (v) => (v ? 'Sí' : 'No');
const text = (v) => String(v);

const DETAIL_KEYS = {
  op: ['Operación', (v) => ({ add: 'Sumar', sub: 'Restar', set: 'Fijar saldo' })[v] || v],
  amount: ['Monto', (v) => (Number.isFinite(Number(v)) ? fmtGs(Number(String(v).replace(/[^\d]/g, ''))) : text(v))],
  before: ['Antes', fmtGs],
  after: ['Después', fmtGs],
  credited: ['Acreditado', fmtGs],
  note: ['Motivo', text],
  banned: ['Suspendido', yesNo],
  muted: ['Silenciado', yesNo],
  role: ['Rol', (v) => (v === 'admin' ? 'Administrador' : 'Jugador')],
  id: ['Nro.', (v) => `#${v}`],
  mode: ['Modo', (v) => (v === 'pay' ? 'Pagar a todos' : v === 'refund' ? 'Devolver apuestas' : v)],
  multiplier: ['Cortada en', fmtMult],
  affected: ['Apuestas afectadas', fmtNum],
  roundId: ['Ronda', (v) => `#${fmtNum(v)}`],
  houseEdgeBps: ['Ventaja', (v) => fmtPct(v / 100, 2)],
  text: ['Texto', text],
  user: ['Usuario', text],
  file: ['Archivo', text],
};
// Nunca se muestra el punto real de explosión de una ronda cortada a mano.
const HIDDEN = new Set(['realCrash']);

let settingsLabels = null;
async function loadSettingsLabels() {
  if (settingsLabels) return settingsLabels;
  try {
    const r = await call('/api/admin/settings');
    settingsLabels = Object.fromEntries(Object.entries(r.schema || {}).map(([k, d]) => [k, d.label]));
  } catch {
    settingsLabels = {};
  }
  return settingsLabels;
}

function fmtSettingValue(v) {
  if (typeof v === 'boolean') return yesNo(v);
  if (typeof v === 'number') return Number.isInteger(v) ? fmtNum(v) : String(v).replace('.', ',');
  const s = String(v ?? '');
  return s === '' ? '(vacío)' : s;
}

function auditDetails(a) {
  if (!a.details) return null;
  let obj;
  try {
    obj = JSON.parse(a.details);
  } catch {
    return h('span', { class: 'mono' }, a.details);
  }
  if (!obj || typeof obj !== 'object') return String(obj);
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (HIDDEN.has(k) || v === null || v === undefined) continue;
    let label;
    let value;
    if (a.action === 'settings') {
      label = (settingsLabels && settingsLabels[k]) || k;
      value = fmtSettingValue(v);
    } else if (DETAIL_KEYS[k]) {
      const [l, fn] = DETAIL_KEYS[k];
      label = l;
      value = v === '' ? '(vacío)' : fn(v);
    } else {
      label = k;
      value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    parts.push(h('span', { class: 'kvp' }, h('span', { class: 'kvp-k' }, label), h('span', { class: 'kvp-v' }, value)));
  }
  return parts.length ? h('div', { class: 'kvps' }, parts) : null;
}

const AUDIT_COLS = [
  { label: 'Fecha', cls: 'num', render: (a) => fmtDate(a.created_at) },
  { label: 'Admin', render: (a) => h('span', { class: 'chip chip-gold' }, a.admin_name || `#${a.admin_id}`) },
  {
    label: 'Acción',
    main: true,
    render: (a) => {
      const [emoji, label] = ACTIONS[a.action] || ['•', a.action];
      return h('span', { class: 'aud-main' }, h('span', { class: 'aud-ic', 'aria-hidden': 'true' }, emoji), h('b', null, label));
    },
  },
  { label: 'Usuario afectado', render: (a) => (a.target_user_id ? userLink(a.target_user_id, a.target_name || `#${a.target_user_id}`) : null) },
  { label: 'Detalles', cls: 'wrap-cell aud-details', full: true, render: auditDetails },
  { label: 'IP', render: (a) => (a.ip ? h('span', { class: 'mono ip' }, a.ip) : null) },
];

let auditPage = 1;

export const auditView = {
  seq: 0,
  mount(el) {
    const box = h('div', { class: 'log-box' }, loadingState());
    const load = async () => {
      const seq = ++this.seq;
      box.classList.add('is-refreshing');
      try {
        const [res] = await Promise.all([call(`/api/admin/audit?page=${auditPage}`), loadSettingsLabels()]);
        if (seq !== this.seq) return;
        box.replaceChildren(
          h('section', { class: 'acard acard-flush' }, dataTable(AUDIT_COLS, res.items, { empty: 'Todavía no hay acciones registradas', emptyEmoji: '🛡️' })),
          pager(res, res.total === 1 ? 'acción' : 'acciones', (p) => {
            auditPage = p;
            load();
          }),
        );
      } catch (err) {
        if (seq === this.seq) box.replaceChildren(errorState(err, load));
      } finally {
        if (seq === this.seq) box.classList.remove('is-refreshing');
      }
    };
    el.append(viewHead('Auditoría', 'Todo lo que hacen los administradores queda registrado, con fecha e IP.', refreshBtn(load)), box);
    load();
  },
  unmount() {
    this.seq++;
  },
};
