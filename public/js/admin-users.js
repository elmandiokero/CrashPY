// Usuarios: listado con filtros y la ficha completa de cada jugador (saldo, bloqueos, historial).
import { h, toast, confirmDialog, fmtGs, fmtNum, fmtSigned, fmtMult, fmtDate, parseAmount, multClass, copyText } from './shared.js';
import {
  bus,
  state,
  call,
  post,
  icon,
  viewHead,
  refreshBtn,
  dataTable,
  pager,
  searchBox,
  filterChips,
  segmented,
  avatar,
  userLink,
  setUserOpener,
  onlineDot,
  ledgerChip,
  reqChip,
  betChip,
  waNumber,
  uaShort,
  ago,
  emptyState,
  errorState,
  loadingState,
  moneyInput,
  adorn,
  field,
  modalForm,
  quickPicks,
  signedMoney,
  signClass,
  setText,
  notifyError,
  plural,
  copyBtn,
} from './admin-core.js';
import { approveDeposit, rejectDeposit, payWithdrawal, rejectWithdrawal } from './admin-money.js';

// ───────────────────────── Acciones reutilizables ─────────────────────────

export async function setUserFlags(id, name, flags, { confirm = true } = {}) {
  if (flags.banned === true && confirm) {
    const ok = await confirmDialog(
      `Se cierran todas las sesiones de ${name} y no va a poder entrar ni jugar. Su saldo queda guardado y lo podés reactivar cuando quieras.`,
      { title: '🚫 Suspender cuenta', okText: 'Suspender', danger: true },
    );
    if (!ok) return false;
  }
  try {
    await post(`/api/admin/users/${id}/flags`, flags);
    const msg =
      flags.banned === true
        ? `${name} quedó suspendido`
        : flags.banned === false
          ? `${name} fue reactivado`
          : flags.muted
            ? `${name} fue silenciado en el chat 🔇`
            : `${name} puede volver a escribir en el chat`;
    toast(msg, 'success');
    return true;
  } catch (err) {
    notifyError(err);
    return false;
  }
}

function randomPass(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

// ───────────────────────── Listado ─────────────────────────

const uq = { q: '', filter: '', sort: 'id', order: 'desc', page: 1 };

const FILTERS = [
  ['', 'Todos'],
  ['online', '🟢 En línea'],
  ['balance', 'Con saldo'],
  ['banned', 'Suspendidos'],
  ['muted', 'Silenciados'],
  ['admins', 'Admins'],
];

const SORTS = [
  ['id', 'Registro'],
  ['balance', 'Saldo'],
  ['bet', 'Apostado'],
  ['deposit', 'Depositado'],
  ['profit', 'Ganancia casa'],
  ['seen', 'Último acceso'],
  ['username', 'Nombre'],
];

function userCell(u) {
  return h(
    'div',
    { class: 'ucell' },
    h('span', { class: 'ucell-av' }, avatar(u.username), onlineDot(u.online)),
    h(
      'div',
      { class: 'ucell-main' },
      h(
        'div',
        { class: 'ucell-name' },
        h('span', null, u.username),
        u.role === 'admin' ? h('span', { class: 'chip chip-gold' }, 'ADMIN') : null,
        u.banned ? h('span', { class: 'chip chip-red' }, 'SUSPENDIDO') : null,
        u.muted ? h('span', { class: 'chip' }, '🔇 SILENCIADO') : null,
      ),
      h('div', { class: 'ucell-sub' }, `#${u.id}`, u.phone ? ` · ${u.phone}` : ''),
    ),
  );
}

const USER_COLS = [
  { label: 'Usuario', main: true, sort: 'username', render: userCell },
  { label: 'Saldo', cls: 'num', sort: 'balance', render: (u) => h('b', { class: u.balance ? '' : 'faint' }, fmtGs(u.balance)) },
  { label: 'Depositado', cls: 'num', sort: 'deposit', render: (u) => fmtGs(u.total_deposit) },
  { label: 'Retirado', cls: 'num', sort: 'withdraw', hideSm: true, render: (u) => fmtGs(u.total_withdraw) },
  { label: 'Apostado', cls: 'num', sort: 'bet', render: (u) => fmtGs(u.total_bet) },
  { label: 'Ganancia casa', cls: 'num', sort: 'profit', render: (u) => signedMoney(u.total_bet - u.total_won) },
  { label: 'Último acceso', sort: 'seen', render: (u) => (u.online ? h('span', { class: 'green' }, 'En línea') : ago(u.last_seen)) },
  { label: 'IP', hideSm: true, render: (u) => (u.last_ip ? h('span', { class: 'mono ip' }, u.last_ip) : null) },
];

export const usersView = {
  seq: 0,
  mount(el) {
    const list = h('div', { class: 'users-list' }, loadingState());
    const order = h('button', { type: 'button', class: 'btn btn-ghost order-btn', title: 'Cambiar el orden' });
    const sortSel = h(
      'select',
      { class: 'input sort-sel', 'aria-label': 'Ordenar por' },
      SORTS.map(([v, label]) => h('option', { value: v }, `Ordenar: ${label}`)),
    );
    sortSel.value = uq.sort;
    const renderOrder = () => order.replaceChildren(icon(uq.order === 'asc' ? 'arrowUp' : 'arrowDown', 16), uq.order === 'asc' ? 'Menor a mayor' : 'Mayor a menor');
    renderOrder();

    const load = async () => {
      const seq = ++this.seq;
      list.classList.add('is-refreshing');
      const qs = new URLSearchParams({ q: uq.q, filter: uq.filter, sort: uq.sort, order: uq.order, page: String(uq.page) });
      try {
        const res = await call(`/api/admin/users?${qs}`);
        if (seq !== this.seq) return;
        list.replaceChildren(
          dataTable(USER_COLS, res.items, {
            onRow: (u) => openUserDetail(u.id),
            empty: uq.q || uq.filter ? 'No hay usuarios con ese filtro' : 'Todavía no hay usuarios registrados',
            emptyEmoji: '🔎',
            rowClass: (u) => (u.banned ? 'row-banned' : ''),
            sort: {
              key: uq.sort,
              order: uq.order,
              onSort: (key) => {
                if (uq.sort === key) uq.order = uq.order === 'asc' ? 'desc' : 'asc';
                else {
                  uq.sort = key;
                  uq.order = key === 'username' ? 'asc' : 'desc';
                }
                sortSel.value = uq.sort;
                renderOrder();
                uq.page = 1;
                load();
              },
            },
          }),
          pager(res, res.total === 1 ? 'usuario' : 'usuarios', (p) => {
            uq.page = p;
            load();
            el.scrollIntoView({ block: 'start' });
          }),
        );
      } catch (err) {
        if (seq === this.seq) list.replaceChildren(errorState(err, load));
      } finally {
        if (seq === this.seq) list.classList.remove('is-refreshing');
      }
    };

    sortSel.addEventListener('change', () => {
      uq.sort = sortSel.value;
      uq.order = uq.sort === 'username' ? 'asc' : 'desc';
      renderOrder();
      uq.page = 1;
      load();
    });
    order.addEventListener('click', () => {
      uq.order = uq.order === 'asc' ? 'desc' : 'asc';
      renderOrder();
      uq.page = 1;
      load();
    });

    el.append(
      viewHead('Usuarios', 'Buscá jugadores, revisá su historial y ajustá saldos.', refreshBtn(load)),
      h(
        'div',
        { class: 'toolbar' },
        searchBox(uq.q, 'Buscar por usuario, teléfono o IP…', (q) => {
          if (q === uq.q) return;
          uq.q = q;
          uq.page = 1;
          load();
        }),
        h('div', { class: 'toolbar-row' }, sortSel, order),
      ),
      filterChips(FILTERS, uq.filter, (f) => {
        uq.filter = f;
        uq.page = 1;
        load();
      }),
      h('section', { class: 'acard acard-flush' }, list),
    );
    load();
  },
  unmount() {
    this.seq++;
  },
};

/** Busca una IP en el listado de usuarios (desde la ficha). */
function searchIp(ip) {
  uq.q = ip;
  uq.filter = '';
  uq.page = 1;
  if (location.hash === '#/usuarios') {
    closeDrawer();
    bus.emit('route:reload');
  } else location.hash = '#/usuarios';
}

// ───────────────────────── Ficha del jugador (panel lateral) ─────────────────────────

const D = {
  root: null,
  panel: null,
  body: null,
  titleEl: null,
  open: false,
  pushed: false,
  id: null,
  data: null,
  tab: 'bets',
  seq: 0,
  refs: {},
  lastFocus: null,
};

function ensureDrawer() {
  if (D.root) return;
  D.titleEl = h('div', { class: 'drawer-title' }, 'Ficha del jugador');
  const refresh = h('button', { type: 'button', class: 'icon-btn', title: 'Actualizar', 'aria-label': 'Actualizar' }, icon('refresh', 17));
  refresh.addEventListener('click', () => reload());
  const close = h('button', { type: 'button', class: 'icon-btn', title: 'Cerrar', 'aria-label': 'Cerrar' }, icon('x', 18));
  close.addEventListener('click', () => closeDrawer());
  D.body = h('div', { class: 'drawer-body' });
  D.panel = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ficha del jugador', tabindex: '-1' },
    h('div', { class: 'drawer-head' }, h('span', { class: 'drawer-kicker' }, icon('users', 16)), D.titleEl, h('div', { class: 'drawer-head-actions' }, refresh, close)),
    D.body,
  );
  D.root = h('div', { class: 'drawer-backdrop' }, D.panel);
  D.root.addEventListener('mousedown', (e) => {
    if (e.target === D.root) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && D.open && !document.querySelector('.modal-backdrop')) closeDrawer();
  });
  window.addEventListener('popstate', () => {
    if (D.open && !(history.state && history.state.cpyDrawer)) hideDrawer();
  });
  window.addEventListener('hashchange', () => {
    if (D.open) hideDrawer();
  });
  bus.on('stats', liveUpdate);
  bus.on('auth:lost', hideDrawer);
}

export function openUserDetail(id) {
  if (!id) return;
  ensureDrawer();
  if (!D.open) {
    D.open = true;
    D.lastFocus = document.activeElement;
    document.body.append(D.root);
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => {
      D.root.classList.add('show');
      D.panel.focus({ preventScroll: true });
    });
    try {
      history.pushState({ ...(history.state || {}), cpyDrawer: true }, '');
      D.pushed = true;
    } catch {
      D.pushed = false;
    }
  }
  loadUser(id, false);
}

setUserOpener(openUserDetail);

function closeDrawer() {
  if (!D.open) return;
  if (D.pushed && history.state && history.state.cpyDrawer) history.back();
  else hideDrawer();
}

function hideDrawer() {
  if (!D.open) return;
  D.open = false;
  D.pushed = false;
  D.seq++;
  D.root.classList.remove('show');
  document.body.classList.remove('drawer-open');
  setTimeout(() => {
    if (!D.open) D.root.remove();
  }, 260);
  D.id = null;
  D.data = null;
  if (D.lastFocus && D.lastFocus.isConnected) D.lastFocus.focus({ preventScroll: true });
}

async function loadUser(id, keep) {
  const seq = ++D.seq;
  const same = D.id === id && D.data;
  D.id = id;
  if (!same) {
    D.data = null;
    if (!keep) D.tab = 'bets';
    D.titleEl.textContent = 'Ficha del jugador';
    D.body.replaceChildren(loadingState('Cargando ficha…'));
    D.body.scrollTop = 0;
  } else D.body.classList.add('is-refreshing');
  try {
    const data = await call(`/api/admin/users/${id}`);
    if (seq !== D.seq || !D.open) return;
    const scroll = D.body.scrollTop;
    D.data = data;
    renderDetail();
    if (same) D.body.scrollTop = scroll;
  } catch (err) {
    if (seq === D.seq) D.body.replaceChildren(errorState(err, () => loadUser(id, true)));
  } finally {
    D.body.classList.remove('is-refreshing');
  }
}

const reload = () => {
  if (D.id) loadUser(D.id, true);
};

function liveUpdate() {
  if (!D.open || !D.data || !D.refs.bal) return;
  const u = D.data.user;
  const o = (state.online || []).find((x) => x.id === D.id);
  if (o) {
    if (o.balance !== u.balance) {
      u.balance = o.balance;
      setText(D.refs.bal, fmtGs(o.balance));
      D.refs.balanceChanged?.();
    }
    setText(D.refs.betting, o.betting ? `🎯 Apostando ${fmtGs(o.betting)} en esta ronda` : '');
  } else setText(D.refs.betting, '');
  const on = !!o;
  if (on !== D.refs.online) {
    D.refs.online = on;
    D.refs.status.replaceChildren(...statusLine(on, u.last_seen));
  }
}

function statusLine(online, lastSeen) {
  return online ? [h('span', { class: 'dot dot-on' }), h('span', { class: 'green' }, 'En línea ahora')] : [h('span', { class: 'dot dot-off' }), 'Última vez ', ago(lastSeen)];
}

function ipTag(ip) {
  return h('button', { type: 'button', class: 'ip-tag mono', title: 'Buscar cuentas con esta IP', onclick: () => searchIp(ip) }, ip);
}

function infoRow(emoji, label, ...value) {
  return h('div', { class: 'ud-info-row' }, h('span', { class: 'ud-info-ic' }, emoji), h('span', { class: 'ud-info-label' }, label), h('span', { class: 'ud-info-value' }, value));
}

function renderDetail() {
  const { user: u, bets, ledger, deposits, withdrawals, sessions, sameIp } = D.data;
  D.refs = { online: !!u.online };
  D.titleEl.textContent = u.username;

  D.refs.bal = h('div', { class: 'ud-balance-value' }, fmtGs(u.balance));
  D.refs.betting = h('div', { class: 'ud-betting' });
  D.refs.status = h('span', { class: 'ud-status' }, ...statusLine(!!u.online, u.last_seen));

  const head = h(
    'div',
    { class: 'ud-head' },
    h(
      'div',
      { class: 'ud-id' },
      avatar(u.username, 56),
      h(
        'div',
        { class: 'ud-id-text' },
        h(
          'div',
          { class: 'ud-name' },
          h('span', null, u.username),
          u.role === 'admin' ? h('span', { class: 'chip chip-gold' }, '👑 ADMIN') : null,
          u.banned ? h('span', { class: 'chip chip-red' }, '🚫 SUSPENDIDO') : null,
          u.muted ? h('span', { class: 'chip' }, '🔇 SILENCIADO') : null,
        ),
        h('div', { class: 'ud-sub' }, h('span', { class: 'mono' }, `#${u.id}`), D.refs.status),
      ),
    ),
    h('div', { class: 'ud-balance' }, h('div', { class: 'ud-balance-label' }, 'Saldo'), D.refs.bal, D.refs.betting),
  );

  const houseProfit = u.total_bet - u.total_won;
  const cash = u.total_deposit - u.total_withdraw;
  const st = (label, value, cls = '') => h('div', { class: 'ud-stat' }, h('div', { class: 'ud-stat-label' }, label), h('div', { class: `ud-stat-value ${cls}` }, value));
  const stats = h(
    'div',
    { class: 'ud-stats' },
    st('Apostado', fmtGs(u.total_bet)),
    st('Ganado (cobros)', fmtGs(u.total_won)),
    st('Ganancia casa', fmtSigned(houseProfit), signClass(houseProfit)),
    st('Apuestas', fmtNum(u.bets_count)),
    st('Mejor retiro', u.best_cashout ? fmtMult(u.best_cashout) : '—', u.best_cashout ? multClass(u.best_cashout) : ''),
    st('Depositado', fmtGs(u.total_deposit)),
    st('Retirado', fmtGs(u.total_withdraw)),
    st('Depósitos − retiros', fmtSigned(cash), signClass(cash)),
  );

  const wa = waNumber(u.phone);
  const info = h(
    'div',
    { class: 'ud-info' },
    infoRow('📅', 'Registro', fmtDate(u.created_at), u.created_ip ? ipTag(u.created_ip) : null),
    infoRow('🕒', 'Último acceso', u.last_seen ? fmtDate(u.last_seen) : 'nunca', u.last_ip ? ipTag(u.last_ip) : null),
    infoRow(
      '📱',
      'Teléfono',
      u.phone ? h('span', { class: 'mono' }, u.phone) : h('span', { class: 'faint' }, 'No cargó teléfono'),
      u.phone ? copyBtn(u.phone, 'Copiar teléfono') : null,
      wa ? h('a', { class: 'btn btn-sm wa-btn', href: `https://wa.me/${wa}`, target: '_blank', rel: 'noopener noreferrer' }, '💬 WhatsApp') : null,
    ),
  );

  const manage = h(
    'section',
    { class: 'ud-manage' },
    h('div', { class: 'ud-block' }, h('h3', { class: 'ud-block-title' }, icon('wallet', 17), 'Editar saldo'), balanceEditor(u)),
    h('div', { class: 'ud-block' }, h('h3', { class: 'ud-block-title' }, icon('lock', 17), 'Cuenta'), accountActions(u), noteEditor(u)),
  );

  const tabBody = h('div', { class: 'ud-tab-body' });
  const tabs = [
    ['bets', 'Apuestas', bets.length],
    ['ledger', 'Movimientos', ledger.length],
    ['deposits', 'Depósitos', deposits.length],
    ['withdrawals', 'Retiros', withdrawals.length],
    ['sessions', 'Sesiones', sessions.length],
    ['sameip', 'Misma IP', sameIp.length],
  ].map(([k, label, n]) => [k, label, n ? String(n) : null]);
  const renderTab = () => tabBody.replaceChildren(tabContent(D.tab, u));
  const seg = segmented(tabs, D.tab, (t) => {
    D.tab = t;
    renderTab();
  }, 'ud-tabs');
  renderTab();

  D.body.replaceChildren(head, stats, info, manage, h('section', { class: 'ud-history' }, seg, tabBody));
}

// ── Editar saldo

function balanceEditor(u) {
  let op = 'add';
  const amount = moneyInput('', { placeholder: '0', 'aria-label': 'Monto en guaraníes' });
  const note = h('input', { class: 'input', maxlength: 200, placeholder: 'Ej: depósito por WhatsApp' });
  const preview = h('div', { class: 'bal-preview', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn btn-gold' }, icon('check', 17), 'Aplicar ajuste');
  const labels = { add: 'Monto a sumar', sub: 'Monto a restar', set: 'Saldo final' };
  const amountLabel = h('label', { class: 'field-label', for: 'bal-amount' }, labels[op]);
  amount.id = 'bal-amount';

  const next = () => {
    const a = parseAmount(amount.value);
    if (!Number.isFinite(a)) return null;
    return op === 'add' ? u.balance + a : op === 'sub' ? u.balance - a : a;
  };
  const update = () => {
    amountLabel.textContent = labels[op];
    const nb = next();
    if (nb === null) {
      preview.replaceChildren(h('span', { class: 'muted' }, 'Saldo actual'), h('b', null, fmtGs(u.balance)));
      submit.disabled = true;
      return;
    }
    const delta = nb - u.balance;
    preview.replaceChildren(
      ...[
        h('b', null, fmtGs(u.balance)),
        h('span', { class: 'bal-arrow' }, '→'),
        nb < 0 ? h('b', { class: 'red' }, 'Saldo insuficiente') : h('b', { class: signClass(delta) }, fmtGs(nb)),
        nb >= 0 ? h('span', { class: `bal-delta ${signClass(delta)}` }, delta ? `(${fmtSigned(delta)})` : '(sin cambios)') : null,
      ].filter(Boolean),
    );
    submit.disabled = nb < 0 || delta === 0;
  };
  D.refs.balanceChanged = update;
  const seg = segmented(
    [
      ['add', '＋ Sumar'],
      ['sub', '－ Restar'],
      ['set', '＝ Fijar saldo'],
    ],
    op,
    (v) => {
      op = v;
      update();
    },
    'bal-seg',
  );
  amount.addEventListener('input', update);
  update();

  const form = h(
    'form',
    { class: 'bal-form', novalidate: true },
    seg,
    h('div', { class: 'field' }, amountLabel, adorn(amount, 'Gs.'), quickPicks([10000, 20000, 50000, 100000, 500000], amount, (v) => fmtNum(v))),
    field('Motivo', note),
    h('div', { class: 'bal-foot' }, preview, submit),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = parseAmount(amount.value);
    const nb = next();
    if (!Number.isFinite(a) || (op !== 'set' && a <= 0)) {
      toast('Ingresá un monto válido', 'error');
      return;
    }
    if (nb < 0) {
      toast(`No se puede restar más que el saldo actual (${fmtGs(u.balance)})`, 'error');
      return;
    }
    const reason = note.value.trim();
    const ok = await confirmDialog(
      `Jugador: ${u.username}\nSaldo actual: ${fmtGs(u.balance)}\nNuevo saldo: ${fmtGs(nb)}  (${fmtSigned(nb - u.balance)})\nMotivo: ${reason || 'sin motivo (queda como «Ajuste del administrador»)'}`,
      { title: 'Confirmar ajuste de saldo', okText: 'Sí, aplicar' },
    );
    if (!ok) return;
    submit.disabled = true;
    try {
      const r = await post(`/api/admin/users/${u.id}/balance`, { op, amount: a, note: reason });
      toast(`Nuevo saldo de ${u.username}: ${fmtGs(r.balance)}`, 'success', 'Saldo actualizado');
      reload();
    } catch (err) {
      notifyError(err);
      update();
    }
  });
  return form;
}

// ── Cuenta: suspender, silenciar, contraseña, rol, nota

function accountActions(u) {
  const act = (label, ic, cls, fn) => h('button', { type: 'button', class: `btn btn-sm ${cls}`, onclick: fn }, icon(ic, 16), label);
  const flags = async (f) => {
    if (await setUserFlags(u.id, u.username, f)) reload();
  };
  return h(
    'div',
    { class: 'ud-btns' },
    u.banned ? act('Reactivar cuenta', 'check', 'btn-primary', () => flags({ banned: false })) : act('Suspender', 'ban', 'btn-danger', () => flags({ banned: true })),
    u.muted ? act('Quitar silencio', 'volume', 'btn-ghost', () => flags({ muted: false })) : act('Silenciar en chat', 'mute', 'btn-ghost', () => flags({ muted: true })),
    act('Cambiar contraseña', 'key', 'btn-ghost', () => passwordModal(u)),
    u.role === 'admin' ? act('Quitar admin', 'crown', 'btn-ghost', () => setRole(u, 'user')) : act('Hacer admin', 'crown', 'btn-ghost', () => setRole(u, 'admin')),
  );
}

function passwordModal(u) {
  const input = h('input', { class: 'input mono', type: 'text', autocomplete: 'off', maxlength: 100, placeholder: 'Mínimo 6 caracteres', spellcheck: 'false', autocapitalize: 'none' });
  const gen = h('button', { type: 'button', class: 'btn btn-ghost' }, '🎲 Generar');
  const cp = h('button', { type: 'button', class: 'btn btn-ghost', title: 'Copiar' }, icon('copy', 16));
  gen.addEventListener('click', () => {
    input.value = randomPass();
    input.focus();
  });
  cp.addEventListener('click', () => {
    if (input.value) copyText(input.value);
  });
  modalForm({
    title: `🔑 Contraseña de ${u.username}`,
    content: h(
      'div',
      null,
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Contraseña nueva'), h('div', { class: 'pass-row' }, input, gen, cp)),
      h('p', { class: 'hint' }, 'Pasásela al jugador (por ejemplo por WhatsApp). Se cierran sus sesiones abiertas y tiene que volver a entrar.'),
    ),
    submitText: 'Cambiar contraseña',
    onSubmit: async () => {
      if (input.value.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
      await post(`/api/admin/users/${u.id}/password`, { password: input.value });
      toast(`La contraseña de ${u.username} se cambió`, 'success');
    },
  });
}

async function setRole(u, role) {
  const makeAdmin = role === 'admin';
  const ok = await confirmDialog(
    makeAdmin
      ? `${u.username} va a tener acceso TOTAL a este panel: saldos, depósitos, retiros, configuración y el botón 💥.\nSus sesiones se cierran y tiene que volver a entrar.`
      : `${u.username} deja de ser administrador y se cierran sus sesiones.`,
    { title: makeAdmin ? '👑 Hacer administrador' : 'Quitar rol de admin', okText: makeAdmin ? 'Sí, hacer admin' : 'Quitar admin', danger: true },
  );
  if (!ok) return;
  try {
    await post(`/api/admin/users/${u.id}/role`, { role });
    toast(makeAdmin ? `${u.username} ahora es administrador` : `${u.username} ya no es administrador`, 'success');
    reload();
  } catch (err) {
    notifyError(err);
  }
}

function noteEditor(u) {
  const ta = h('textarea', { class: 'input', maxlength: 500, rows: 3, placeholder: 'Solo la ven los admins. Ej: cliente de confianza, transfiere desde Itaú…' });
  ta.value = u.note || '';
  const saved = h('span', { class: 'hint' });
  const save = h('button', { type: 'button', class: 'btn btn-blue btn-sm' }, icon('check', 15), 'Guardar nota');
  ta.addEventListener('input', () => {
    saved.textContent = ta.value !== (u.note || '') ? 'Sin guardar' : '';
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await post(`/api/admin/users/${u.id}/note`, { note: ta.value });
      u.note = ta.value;
      saved.textContent = '✓ Guardada';
      toast('Nota guardada', 'success');
    } catch (err) {
      notifyError(err);
    } finally {
      save.disabled = false;
    }
  });
  return h('div', { class: 'ud-note' }, field('Nota interna', ta), h('div', { class: 'ud-note-actions' }, saved, save));
}

// ── Pestañas de historial

const BET_COLS = [
  { label: 'Ronda', main: true, render: (b) => h('span', { class: 'round-id' }, `Ronda #${fmtNum(b.round_id)}`) },
  { label: 'Monto', cls: 'num', render: (b) => fmtGs(b.amount) },
  {
    label: 'Retiro',
    cls: 'num',
    render: (b) =>
      b.cashout
        ? h('b', { class: multClass(b.cashout) }, fmtMult(b.cashout))
        : b.auto_cashout
          ? h('span', { class: 'faint', title: 'Retiro automático configurado' }, `auto ${fmtMult(b.auto_cashout)}`)
          : null,
  },
  { label: 'Pago', cls: 'num', render: (b) => (b.payout ? h('span', { class: 'green' }, fmtGs(b.payout)) : null) },
  { label: 'Estado', render: (b) => betChip(b.status) },
  { label: 'Explotó en', cls: 'num', render: (b) => (b.crash != null ? h('span', { class: multClass(b.crash) }, fmtMult(b.crash)) : null) },
  { label: 'Fecha', cls: 'num', render: (b) => fmtDate(b.created_at) },
];

export const LEDGER_COLS = [
  { label: 'Tipo', main: true, render: (l) => ledgerChip(l.type) },
  { label: 'Monto', cls: 'num', render: (l) => signedMoney(l.amount) },
  { label: 'Saldo después', cls: 'num', render: (l) => fmtGs(l.balance_after) },
  { label: 'Nota', cls: 'wrap-cell', render: (l) => l.note },
  { label: 'Admin', render: (l) => (l.admin ? h('span', { class: 'chip chip-gold' }, l.admin) : null) },
  { label: 'Fecha', cls: 'num', render: (l) => fmtDate(l.created_at) },
];

function depositCols(u) {
  return [
    { label: 'Depósito', main: true, render: (d) => h('span', { class: 'req-main' }, h('b', null, `#${d.id}`), reqChip(d.status)) },
    { label: 'Monto', cls: 'num', render: (d) => fmtGs(d.amount) },
    { label: 'Acreditado', cls: 'num', render: (d) => (d.credited != null ? h('span', { class: 'green' }, fmtGs(d.credited)) : null) },
    { label: 'Referencia', cls: 'wrap-cell', render: (d) => d.reference },
    { label: 'Nota admin', cls: 'wrap-cell', render: (d) => d.admin_note },
    { label: 'Fecha', cls: 'num', render: (d) => fmtDate(d.created_at) },
    {
      label: 'Acciones',
      render: (d) =>
        d.status === 'pending'
          ? h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => approveDeposit({ ...d, username: u.username, user_balance: u.balance }, reload) }, 'Aprobar'),
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => rejectDeposit({ ...d, username: u.username }, reload) }, 'Rechazar'),
            )
          : null,
    },
  ];
}

function withdrawalCols(u) {
  return [
    { label: 'Retiro', main: true, render: (w) => h('span', { class: 'req-main' }, h('b', null, `#${w.id}`), reqChip(w.status)) },
    { label: 'Monto', cls: 'num', render: (w) => h('b', null, fmtGs(w.amount)) },
    { label: 'Banco', render: (w) => w.bank },
    { label: 'Cuenta', cls: 'wrap-cell', render: (w) => h('span', { class: 'mono' }, w.account) },
    { label: 'Titular', cls: 'wrap-cell', render: (w) => w.holder },
    { label: 'Nota admin', cls: 'wrap-cell', render: (w) => w.admin_note },
    { label: 'Fecha', cls: 'num', render: (w) => fmtDate(w.created_at) },
    {
      label: 'Acciones',
      render: (w) =>
        w.status === 'pending'
          ? h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => payWithdrawal({ ...w, username: u.username, user_balance: u.balance }, reload) }, 'Pagado'),
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => rejectWithdrawal({ ...w, username: u.username }, reload) }, 'Rechazar'),
            )
          : null,
    },
  ];
}

const SESSION_COLS = [
  { label: 'Dispositivo', main: true, render: (s) => h('span', { title: s.ua || '' }, uaShort(s.ua)) },
  { label: 'Inicio', cls: 'num', render: (s) => fmtDate(s.created_at) },
  { label: 'Vence', cls: 'num', render: (s) => fmtDate(s.expires_at) },
  { label: 'IP', render: (s) => (s.ip ? ipTag(s.ip) : null) },
];

function tabContent(tab, u) {
  const d = D.data;
  switch (tab) {
    case 'bets':
      return dataTable(BET_COLS, d.bets, { empty: 'Todavía no apostó', emptyEmoji: '🎯' });
    case 'ledger':
      return dataTable(LEDGER_COLS, d.ledger, { empty: 'Sin movimientos de saldo', emptyEmoji: '📒' });
    case 'deposits':
      return dataTable(depositCols(u), d.deposits, { empty: 'No informó depósitos', emptyEmoji: '💰' });
    case 'withdrawals':
      return dataTable(withdrawalCols(u), d.withdrawals, { empty: 'No pidió retiros', emptyEmoji: '🏦' });
    case 'sessions':
      return h(
        'div',
        null,
        dataTable(SESSION_COLS, d.sessions, { empty: 'No tiene sesiones abiertas', emptyEmoji: '🔌' }),
        u.online ? null : h('p', { class: 'hint tab-hint' }, 'Se muestran las últimas 10 sesiones (inicios de sesión) que siguen vigentes.'),
      );
    case 'sameip':
      if (!d.sameIp.length) return emptyState('No hay otras cuentas con la misma IP', '🧭');
      return h(
        'div',
        { class: 'sameip' },
        h('p', { class: 'hint' }, `Cuentas que usaron la IP ${u.last_ip}. Puede ser la misma persona con varias cuentas (o una red compartida).`),
        h('div', { class: 'sameip-list' }, d.sameIp.map((x) => userLink(x.id, x.username, { cls: 'ulink-chip' }))),
      );
    default:
      return emptyState('Sin datos');
  }
}
