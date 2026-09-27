// Inicio: resumen de la casa, gráficos de ganancia, ronda en vivo, jugadores en línea y actividad.
import { h, fmtGs, fmtNum, fmtSigned, fmtTime, timeAgo } from './shared.js';
import {
  state,
  call,
  icon,
  scope,
  card,
  viewHead,
  refreshBtn,
  fmtPct,
  fmtCompact,
  signClass,
  segmented,
  avatar,
  openUser,
  syncList,
  setText,
  emptyState,
  errorState,
  loadingState,
  plural,
} from './admin-core.js';
import { roundHero, stopButton, totalsStrip } from './admin-live.js';

const PERIODS = [
  ['today', 'Hoy'],
  ['week', '7 días'],
  ['all', 'Total'],
];
const PERIOD_TEXT = { today: 'hoy', week: 'en los últimos 7 días', all: 'desde que abriste' };
let period = 'today';

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

// ───────────────────────── Tarjetas de números ─────────────────────────

function tile({ label, value, sub, cls = '', href, icon: ic }) {
  const body = [
    h('div', { class: 'tile-label' }, ic ? icon(ic, 15) : null, label),
    h('div', { class: `tile-value ${cls}`.trim() }, value),
    sub ? h('div', { class: 'tile-sub' }, sub) : null,
  ];
  return href ? h('a', { class: 'tile tile-link', href }, body) : h('div', { class: 'tile' }, body);
}

// ───────────────────────── Gráfico de barras divergente ─────────────────────────

function niceCeil(v) {
  if (v <= 0) return 0;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/**
 * Barras de ganancia: arriba de la línea del cero = ganó la casa (verde), abajo = perdió (rojo).
 * El signo también se lee por la dirección de la barra, no solo por el color.
 */
function profitChart(rows, { xLabel, tipTitle, labelEvery }) {
  const vals = rows.map((r) => r.profit);
  const hasData = rows.some((r) => r.rounds > 0);
  let top = niceCeil(Math.max(0, ...vals));
  const bottom = niceCeil(Math.max(0, ...vals.map((v) => -v)));
  if (!top && !bottom) top = 1;
  const span = top + bottom;
  const zero = top / span;

  const tip = h('div', { class: 'chart-tip', role: 'tooltip', hidden: true });
  const grid = h(
    'div',
    { class: 'chart-grid', 'aria-hidden': 'true' },
    top ? h('div', { class: 'chart-line', style: 'top:0' }, h('span', null, hasData ? '+' + fmtCompact(top) : '')) : null,
    h('div', { class: 'chart-line chart-zero', style: `top:${(zero * 100).toFixed(3)}%` }, h('span', null, '0')),
    bottom ? h('div', { class: 'chart-line', style: 'top:100%' }, h('span', null, fmtCompact(-bottom))) : null,
  );
  const cols = h('div', { class: 'chart-cols' });
  const plot = h('div', { class: 'chart-plot' }, grid, cols, tip);
  let pinned = null;

  const showTip = (col, r) => {
    tip.replaceChildren(
      h('div', { class: 'tip-value' }, h('strong', { class: signClass(r.profit) }, fmtSigned(r.profit)), h('span', null, ' ganancia')),
      h('div', { class: 'tip-title' }, tipTitle(r)),
      h('div', { class: 'tip-row' }, h('span', null, 'Apostado'), h('b', null, fmtGs(r.bet))),
      h('div', { class: 'tip-row' }, h('span', null, 'Pagado'), h('b', null, fmtGs(r.payout))),
      h('div', { class: 'tip-row' }, h('span', null, 'Rondas'), h('b', null, fmtNum(r.rounds))),
    );
    tip.hidden = false;
    const pw = plot.clientWidth;
    const tw = tip.offsetWidth;
    const cx = col.offsetLeft + col.offsetWidth / 2 + cols.offsetLeft;
    tip.style.left = `${Math.max(0, Math.min(pw - tw, cx - tw / 2))}px`;
    for (const c of cols.children) c.classList.toggle('is-hover', c === col);
  };
  const hideTip = () => {
    tip.hidden = true;
    for (const c of cols.children) c.classList.remove('is-hover');
  };

  rows.forEach((r) => {
    const v = r.profit;
    const hPct = span ? (Math.abs(v) / span) * 100 : 0;
    const bar = h('span', {
      class: `chart-bar ${v >= 0 ? 'pos' : 'neg'}`,
      style:
        v >= 0
          ? `bottom:${((1 - zero) * 100).toFixed(3)}%;height:max(${v ? 2 : 0}px, ${hPct.toFixed(3)}%)`
          : `top:${(zero * 100).toFixed(3)}%;height:max(2px, ${hPct.toFixed(3)}%)`,
    });
    const col = h(
      'button',
      { type: 'button', class: 'chart-col', 'aria-label': `${tipTitle(r)}: ${fmtSigned(v)}` },
      bar,
    );
    col.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') showTip(col, r);
    });
    col.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && pinned !== col) hideTip();
    });
    col.addEventListener('click', () => {
      pinned = pinned === col ? null : col;
      if (pinned) showTip(col, r);
      else hideTip();
    });
    col.addEventListener('focus', () => showTip(col, r));
    col.addEventListener('blur', () => {
      if (pinned !== col) hideTip();
    });
    cols.append(col);
  });
  plot.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pinned) hideTip();
  });

  const xAxis = h(
    'div',
    { class: 'chart-x', 'aria-hidden': 'true' },
    rows.map((r, i) => h('span', null, i % labelEvery === labelEvery - 1 || i === rows.length - 1 ? xLabel(r) : '')),
  );
  return h(
    'div',
    { class: `chart${hasData ? '' : ' is-empty'}` },
    plot,
    xAxis,
    hasData ? null : h('div', { class: 'chart-empty' }, 'Todavía no hay rondas en este período'),
  );
}

function chartTable(rows, first) {
  const data = rows.filter((r) => r.rounds > 0).reverse();
  if (!data.length) return emptyState('Todavía no hay rondas en este período', '📉');
  return h(
    'div',
    { class: 'table-wrap chart-table' },
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, first), h('th', { class: 'num' }, 'Apostado'), h('th', { class: 'num' }, 'Pagado'), h('th', { class: 'num' }, 'Ganancia'), h('th', { class: 'num' }, 'Rondas')),
      ),
      h(
        'tbody',
        null,
        data.map((r) =>
          h(
            'tr',
            null,
            h('td', null, r.label),
            h('td', { class: 'num' }, fmtGs(r.bet)),
            h('td', { class: 'num' }, fmtGs(r.payout)),
            h('td', { class: `num ${signClass(r.profit)}` }, fmtSigned(r.profit)),
            h('td', { class: 'num' }, fmtNum(r.rounds)),
          ),
        ),
      ),
    ),
  );
}

function hourlyRows(hourly) {
  const byT = new Map((hourly || []).map((r) => [r.t, r]));
  const HOUR = 3_600_000;
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const t = now - i * HOUR;
    const r = byT.get(t) || { bet: 0, payout: 0, profit: 0, rounds: 0 };
    const d = new Date(t);
    const hh = pad2(d.getHours());
    const next = pad2(new Date(t + HOUR).getHours());
    out.push({ ...r, t, short: `${hh}h`, label: `${hh}:00 – ${next}:00` });
  }
  return out;
}

function dailyRows(daily) {
  const byDay = new Map((daily || []).map((r) => [r.day, r]));
  const out = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const r = byDay.get(key) || { bet: 0, payout: 0, profit: 0, rounds: 0 };
    const short = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
    out.push({ ...r, day: key, short, label: `${i === 0 ? 'Hoy' : WEEKDAYS[d.getDay()]} ${short}` });
  }
  return out;
}

function chartCard(title, sub, cls) {
  let asTable = false;
  let last = null;
  const total = h('span', { class: 'chart-total' });
  const body = h('div', { class: 'chart-body' }, loadingState());
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false' }, icon('table', 15), 'Tabla');
  const draw = () => {
    if (!last) return;
    body.replaceChildren(asTable ? chartTable(last.rows, last.first) : profitChart(last.rows, last.opts));
  };
  toggle.addEventListener('click', () => {
    asTable = !asTable;
    toggle.setAttribute('aria-pressed', String(asTable));
    toggle.replaceChildren(icon(asTable ? 'chart' : 'table', 15), asTable ? 'Gráfico' : 'Tabla');
    draw();
  });
  const el = card(title, { cls, icon: 'chart', sub, actions: h('div', { class: 'chart-head-right' }, total, toggle) }, body);
  return {
    el,
    update(rows, first, opts) {
      last = { rows, first, opts };
      const sum = rows.reduce((a, r) => a + r.profit, 0);
      total.className = `chart-total ${signClass(sum)}`;
      total.textContent = fmtSigned(sum);
      draw();
    },
  };
}

// ───────────────────────── Jugadores en línea ─────────────────────────

function onlineRow() {
  const refs = {
    avatarBox: h('span', { class: 'orow-av' }),
    name: h('span', { class: 'orow-name-text' }),
    chips: h('span', { class: 'orow-chips' }),
    bet: h('span', { class: 'orow-bet' }),
    meta: h('span', { class: 'orow-meta-text' }),
    bal: h('span', { class: 'orow-bal' }),
  };
  const el = h(
    'button',
    { type: 'button', class: 'orow' },
    refs.avatarBox,
    h('span', { class: 'orow-main' }, h('span', { class: 'orow-name' }, refs.name, refs.chips), h('span', { class: 'orow-meta' }, refs.bet, refs.meta)),
    refs.bal,
  );
  el._r = refs;
  el.addEventListener('click', () => openUser(el._id));
  return el;
}

function updateOnlineRow(el, u) {
  const r = el._r;
  el._id = u.id;
  if (el._name !== u.username) {
    el._name = u.username;
    r.avatarBox.replaceChildren(avatar(u.username), h('span', { class: 'dot dot-on' }));
    setText(r.name, u.username);
  }
  const chipKey = `${u.role}|${u.muted}`;
  if (el._chips !== chipKey) {
    el._chips = chipKey;
    r.chips.replaceChildren(
      ...[u.role === 'admin' ? h('span', { class: 'chip chip-gold' }, 'ADMIN') : null, u.muted ? h('span', { class: 'chip', title: 'Silenciado' }, '🔇') : null].filter(Boolean),
    );
  }
  setText(r.bet, u.betting ? `🎯 ${fmtGs(u.betting)}` : '');
  r.bet.hidden = !u.betting;
  setText(r.meta, `${u.ip || 'IP ?'} · ${u.since ? `conectado ${timeAgo(u.since)}` : ''}`);
  setText(r.bal, fmtGs(u.balance));
}

function onlineCard() {
  const count = h('span', { class: 'acard-sub' });
  const list = h('div', { class: 'olist' });
  const empty = emptyState('No hay jugadores conectados en este momento', '😴');
  const el = card('Jugadores en línea', { cls: 'dash-online', icon: 'users', actions: count }, list, empty);
  const render = () => {
    const users = state.online || [];
    count.textContent = users.length ? `${fmtNum(users.length)} en línea · ${plural(state.connections || 0, 'conexión', 'conexiones')}` : '';
    empty.hidden = users.length > 0;
    list.hidden = !users.length;
    syncList(list, users.slice(0, 100), (u) => u.id, onlineRow, updateOnlineRow);
  };
  render();
  return { el, render };
}

// ───────────────────────── Actividad ─────────────────────────

const ACT_KIND = { admin: 'act-admin', register: 'act-register', deposit: 'act-deposit', withdraw: 'act-withdraw', bigwin: 'act-bigwin' };

function activityRow(a) {
  const clickable = !!a.userId;
  return h(
    clickable ? 'button' : 'div',
    { type: clickable ? 'button' : null, class: `act ${ACT_KIND[a.kind] || ''}${clickable ? ' is-link' : ''}`, onclick: clickable ? () => openUser(a.userId) : null },
    h('span', { class: 'act-time' }, fmtTime(a.ts)),
    h('span', { class: 'act-text' }, a.text),
  );
}

function activityCard() {
  const list = h('div', { class: 'alist' });
  const empty = emptyState('Acá vas a ver en vivo los registros, depósitos, retiros, ganancias grandes y lo que hacen los admins.', '📡');
  const el = card('Actividad en vivo', { cls: 'dash-activity', icon: 'activity' }, list, empty);
  const renderAll = () => {
    list.replaceChildren(...state.activity.map(activityRow));
    empty.hidden = state.activity.length > 0;
  };
  renderAll();
  return {
    el,
    add(a) {
      const row = activityRow(a);
      row.classList.add('is-new');
      list.prepend(row);
      while (list.children.length > 100) list.lastChild.remove();
      empty.hidden = true;
    },
  };
}

// ───────────────────────── Avisos de pendientes ─────────────────────────

function renderAlerts(box) {
  const { deposits, withdrawals } = state.pending;
  const items = [];
  if (deposits.n) {
    items.push(
      h(
        'a',
        { class: 'alert alert-deposit', href: '#/depositos' },
        h('span', { class: 'alert-ic' }, '💰'),
        h('span', { class: 'alert-text' }, h('strong', null, plural(deposits.n, 'depósito pendiente', 'depósitos pendientes')), h('span', null, fmtGs(deposits.total))),
        h('span', { class: 'alert-go' }, 'Revisar', icon('chevRight', 16)),
      ),
    );
  }
  if (withdrawals.n) {
    items.push(
      h(
        'a',
        { class: 'alert alert-withdraw', href: '#/retiros' },
        h('span', { class: 'alert-ic' }, '🏦'),
        h('span', { class: 'alert-text' }, h('strong', null, plural(withdrawals.n, 'retiro pendiente', 'retiros pendientes')), h('span', null, fmtGs(withdrawals.total))),
        h('span', { class: 'alert-go' }, 'Pagar', icon('chevRight', 16)),
      ),
    );
  }
  const key = `${deposits.n}|${deposits.total}|${withdrawals.n}|${withdrawals.total}`;
  if (box._key === key) return;
  box._key = key;
  box.replaceChildren(...items);
  box.hidden = !items.length;
}

// ───────────────────────── Vista ─────────────────────────

export const dashboardView = {
  sc: null,
  data: null,
  mount(el) {
    const sc = scope();
    this.sc = sc;

    const alerts = h('div', { class: 'dash-alerts', hidden: true });
    const heroValue = h('div', { class: 'dhero-value' }, '—');
    const heroMeta = h('div', { class: 'dhero-meta' });
    const heroLabel = h('div', { class: 'dhero-label' });
    const periodSeg = segmented(PERIODS, period, (p) => {
      period = p;
      renderStats();
    });
    const heroCard = h(
      'section',
      { class: 'acard dash-hero' },
      h('div', { class: 'dhero-head' }, h('h2', { class: 'acard-title' }, icon('trend', 18), h('span', null, 'Ganancia de la casa')), periodSeg),
      heroValue,
      heroLabel,
      heroMeta,
    );
    const tiles = h('div', { class: 'tiles dash-tiles' });
    const glob = h('div', { class: 'tiles tiles-6 dash-glob' });

    const mini = roundHero({ mini: true });
    const stop = stopButton();
    const tot = totalsStrip();
    sc.add(mini.dispose);
    sc.add(stop.dispose);
    sc.add(tot.dispose);
    const live = card(
      'Ronda en vivo',
      { cls: 'dash-live', icon: 'activity', actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/en-vivo' }, 'Abrir', icon('chevRight', 15)) },
      mini.el,
      tot.el,
      stop.el,
    );

    const chH = chartCard('Ganancia por hora', 'últimas 24 h', 'dash-ch1');
    const chD = chartCard('Ganancia por día', 'últimos 14 días', 'dash-ch2');
    const online = onlineCard();
    const activity = activityCard();

    let globKey = '';
    const renderGlobal = () => {
      const d = this.data;
      const s = d ? d.stats : null;
      const pend = state.pending;
      const onlineN = (state.online || []).length;
      // Solo se redibuja si algo cambió (llega un "stats" cada 1,5 s).
      const key = JSON.stringify([s && s.users, s && s.adjustments, pend, onlineN, state.connections]);
      if (key === globKey) return;
      globKey = key;
      glob.replaceChildren(
        tile({
          label: 'Usuarios registrados',
          icon: 'users',
          value: s ? fmtNum(s.users.total) : '—',
          sub: s ? `${plural(s.users.today, 'nuevo', 'nuevos')} hoy · ${plural(s.users.banned, 'suspendido', 'suspendidos')}` : '',
          href: '#/usuarios',
        }),
        tile({
          label: 'Saldo de jugadores (pasivo)',
          icon: 'wallet',
          value: s ? fmtGs(s.users.balances) : '—',
          sub: 'Lo que pagarías si todos retiran hoy',
          cls: 'gold',
        }),
        tile({
          label: 'Depósitos pendientes',
          icon: 'deposit',
          value: fmtNum(pend.deposits.n),
          sub: pend.deposits.n ? fmtGs(pend.deposits.total) : 'Nada por revisar',
          cls: pend.deposits.n ? 'gold' : '',
          href: '#/depositos',
        }),
        tile({
          label: 'Retiros pendientes',
          icon: 'withdraw',
          value: fmtNum(pend.withdrawals.n),
          sub: pend.withdrawals.n ? fmtGs(pend.withdrawals.total) : 'Nada por pagar',
          cls: pend.withdrawals.n ? 'gold' : '',
          href: '#/retiros',
        }),
        tile({
          label: 'En línea ahora',
          icon: 'globe',
          value: fmtNum(onlineN),
          sub: plural(state.connections || 0, 'conexión abierta', 'conexiones abiertas'),
        }),
        tile({
          label: 'Ajustes y bonos',
          icon: 'edit',
          value: s ? fmtSigned(s.adjustments) : '—',
          sub: 'Saldo agregado a mano o como bono',
        }),
      );
    };

    let statsKey = '';
    const renderStats = () => {
      const d = this.data;
      if (!d) return;
      const key = JSON.stringify([period, d.stats[period], d.charts, new Date().getHours()]);
      if (key === statsKey) return;
      statsKey = key;
      const p = d.stats[period];
      heroValue.className = `dhero-value ${signClass(p.profit)}`;
      heroValue.textContent = fmtSigned(p.profit);
      heroLabel.textContent = `Apostado − pagado ${PERIOD_TEXT[period]}`;
      const margin = p.bet ? (p.profit / p.bet) * 100 : null;
      heroMeta.replaceChildren(
        h('span', null, 'Margen ', h('b', null, margin === null ? '—' : fmtPct(margin))),
        h('span', null, 'RTP real ', h('b', null, p.bet ? fmtPct((p.payout / p.bet) * 100) : '—')),
        h('span', null, h('b', null, fmtNum(p.rounds)), ' rondas'),
      );
      const net = p.deposits.total - p.withdrawals.total;
      tiles.replaceChildren(
        tile({ label: 'Apostado', icon: 'rocket', value: fmtGs(p.bet), sub: p.rounds ? `Promedio ${(p.plays / p.rounds).toLocaleString('es-PY', { maximumFractionDigits: 1 })} jugadores por ronda` : 'Sin rondas todavía' }),
        tile({ label: 'Pagado a jugadores', icon: 'trend', value: fmtGs(p.payout), sub: p.bet ? `${fmtPct((p.payout / p.bet) * 100)} de lo apostado` : '—' }),
        tile({ label: 'Rondas jugadas', icon: 'clock', value: fmtNum(p.rounds), sub: plural(p.plays, 'participación', 'participaciones') }),
        tile({ label: 'Depósitos aprobados', icon: 'deposit', value: fmtGs(p.deposits.total), sub: plural(p.deposits.n, 'depósito', 'depósitos'), cls: p.deposits.total ? 'green' : '' }),
        tile({ label: 'Retiros pagados', icon: 'withdraw', value: fmtGs(p.withdrawals.total), sub: plural(p.withdrawals.n, 'retiro', 'retiros') }),
        tile({ label: 'Caja neta', icon: 'wallet', value: fmtSigned(net), sub: 'Depósitos − retiros', cls: signClass(net) }),
      );
      chH.update(hourlyRows(d.charts.hourly), 'Hora', {
        xLabel: (r) => r.short,
        tipTitle: (r) => r.label,
        labelEvery: 4,
      });
      chD.update(dailyRows(d.charts.daily), 'Día', {
        xLabel: (r) => r.short,
        tipTitle: (r) => r.label,
        labelEvery: 2,
      });
    };

    const load = async () => {
      heroCard.classList.add('is-refreshing');
      try {
        this.data = await call('/api/admin/overview');
        renderStats();
        renderGlobal();
      } catch (err) {
        if (!this.data) heroValue.replaceChildren(errorState(err, load));
      } finally {
        heroCard.classList.remove('is-refreshing');
      }
    };

    sc.on('stats', () => {
      online.render();
      renderAlerts(alerts);
      renderGlobal();
    });
    sc.on('activity', (a) => activity.add(a));
    sc.interval(load, 15_000);

    el.append(
      viewHead('Inicio', 'Así está tu casino ahora mismo.', refreshBtn(load)),
      alerts,
      h('div', { class: 'dash' }, live, heroCard, tiles, glob, chH.el, chD.el, online.el, activity.el),
    );
    renderAlerts(alerts);
    renderGlobal();
    load();
  },
  unmount() {
    this.sc?.dispose();
    this.sc = null;
  },
};
