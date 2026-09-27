// Juegos: prender/pausar cada juego, Double y Ruleta en vivo, jugadas en vivo e historial de jugadas de todos.
import { h, fmtGs, fmtNum, fmtMult, fmtSigned, fmtDate, fmtTime, toast, confirmDialog, openModal } from './shared.js';
import {
  state,
  call,
  post,
  icon,
  scope,
  card,
  viewHead,
  refreshBtn,
  dataTable,
  pager,
  searchBox,
  filterChips,
  userLink,
  errorState,
  loadingState,
  emptyState,
  signedMoney,
  signClass,
  segmented,
  fmtPct,
  plural,
  notifyError,
  setText,
  GAME_META,
  GAME_ORDER,
} from './admin-core.js';
import { pauseState, togglePause } from './admin-live.js';
import { core, playVisual, DOUBLE_COLORS, ROULETTE_EMOJI, ROULETTE_COLOR_NAMES, rouletteBetsLabel } from './games/common.js';

const COLOR_EMOJI = { red: '🔴', black: '⚫', white: '⚪' };
const PERIODS = [
  ['today', 'Hoy'],
  ['week', '7 días'],
  ['all', 'Total'],
];
let period = 'today';

// ───────────────────────── Estado de cada juego ─────────────────────────

function gameStatus(id) {
  if (id === 'crash') {
    const s = pauseState();
    return s === 'running' ? ['on', 'Activo'] : s === 'paused' ? ['off', 'Pausado'] : ['warn', 'Se pausa al terminar la ronda'];
  }
  if ((id === 'double' || id === 'roulette') && state.settings[`game_${id}`] !== false && state.stats?.[id]?.phase === 'PAUSED') return ['warn', 'Arrancando…'];
  return state.settings[`game_${id}`] === false ? ['off', 'Pausado'] : ['on', 'Activo'];
}

async function setEnabled(id, on) {
  const meta = GAME_META[id];
  if (id === 'crash') return togglePause();
  if (!on) {
    const msg =
      id === 'double' || id === 'roulette'
        ? 'Si hay apuestas en la ronda actual se devuelven. Si la rueda está girando, la ronda termina normal y después se pausa.'
        : id === 'mines' || id === 'penalty'
          ? 'Nadie va a poder empezar partidas nuevas. Las partidas que ya están en curso se pueden terminar.'
          : 'Nadie va a poder jugar hasta que lo vuelvas a activar.';
    const ok = await confirmDialog(msg, { title: `⏸ Pausar ${meta.name}`, okText: 'Pausar', danger: true });
    if (!ok) return;
  }
  try {
    await post('/api/admin/settings', { [`game_${id}`]: on });
    state.settings[`game_${id}`] = on;
    toast(on ? `${meta.icon} ${meta.name} está activo otra vez` : `${meta.icon} ${meta.name} quedó en pausa`, on ? 'success' : 'info');
  } catch (err) {
    notifyError(err);
  }
}

function statusCard(getOverview) {
  const list = h('div', { class: 'gm-list' });
  const seg = segmented(PERIODS, period, (p) => {
    period = p;
    render();
  });
  const el = card('Juegos', { icon: 'gamepad', cls: 'gm-status', actions: seg }, list);
  let key = '';
  const render = () => {
    const ov = getOverview();
    const stats = ov ? ov.stats[period] : null;
    const k = JSON.stringify([period, stats && stats.games, GAME_ORDER.map(gameStatus)]);
    if (k === key) return;
    key = k;
    list.replaceChildren(
      ...GAME_ORDER.map((id) => {
        const meta = GAME_META[id];
        const g = stats ? stats.games[id] : null;
        const [st, label] = gameStatus(id);
        const on = st !== 'off';
        const sw = h('input', { type: 'checkbox', checked: on, 'aria-label': `${meta.name} activo` });
        sw.addEventListener('change', async () => {
          sw.disabled = true;
          await setEnabled(id, sw.checked);
          sw.disabled = false;
          key = '';
          render();
        });
        const margin = g && g.bet ? (g.profit / g.bet) * 100 : null;
        return h(
          'div',
          { class: `gm-row gm-${st}` },
          h('span', { class: 'gm-ic' }, meta.icon),
          h(
            'div',
            { class: 'gm-main' },
            h('b', null, meta.name, h('span', { class: `chip ${st === 'on' ? 'chip-green' : st === 'off' ? 'chip-red' : 'chip-gold'}` }, label)),
            h(
              'small',
              null,
              g
                ? `${plural(g.plays, 'jugada', 'jugadas')}${g.rounds ? ` · ${plural(g.rounds, 'ronda', 'rondas')}` : ''} · apostado ${fmtGs(g.bet)}${margin === null ? '' : ` · margen ${fmtPct(margin)}`}`
                : '—',
            ),
          ),
          h('div', { class: 'gm-profit' }, g ? h('span', { class: `num ${signClass(g.profit)}` }, (g.profit > 0 ? '+' : '') + fmtGs(g.profit)) : '—', h('small', null, 'ganancia')),
          h('label', { class: 'switch gm-switch', title: on ? 'Pausar' : 'Activar' }, sw, h('span', { class: 'track' })),
        );
      }),
    );
  };
  return { el, render };
}

// ───────────────────────── Double en vivo ─────────────────────────

function doubleCard() {
  const phase = h('span', { class: 'chip' });
  const round = h('span', { class: 'acard-sub' });
  const cols = h('div', { class: 'dbl-cols' });
  const hist = h('div', { class: 'dbl-hist' });
  const bets = h('div', { class: 'dbl-bets' });
  const el = card('🎡 Double en vivo', { cls: 'gm-double', actions: h('div', { class: 'dbl-head' }, round, phase) }, cols, h('div', { class: 'dbl-sub' }, 'Últimos resultados'), hist, bets);
  let key = '';
  const render = () => {
    const d = state.stats && state.stats.double;
    if (!d) {
      cols.replaceChildren(loadingState());
      return;
    }
    const k = JSON.stringify([d.phase, d.roundId, Math.ceil((d.bettingLeft || 0) / 1000), d.totals, d.lastResult, d.history && d.history[0], d.bets.length]);
    if (k === key) return;
    key = k;
    setText(round, d.roundId ? `Ronda #${d.roundId}` : '');
    const phases = {
      BETTING: ['chip-green', `Apostando · ${Math.ceil((d.bettingLeft || 0) / 1000)} s`],
      SPINNING: ['chip-gold', 'Girando'],
      RESULT: ['chip-blue', d.lastResult !== null ? `Salió ${COLOR_EMOJI[core.doubleColor(d.lastResult)]} ${d.lastResult}` : 'Resultado'],
      PAUSED: ['chip-red', 'Pausado'],
      IDLE: ['chip', '—'],
    };
    const [pc, pt] = phases[d.phase] || ['chip', d.phase];
    phase.className = `chip ${pc}`;
    phase.textContent = pt;
    cols.replaceChildren(
      ...['red', 'white', 'black'].map((c) => {
        const t = d.totals[c];
        const house = d.houseIf[c];
        return h(
          'div',
          { class: `dbl-col dbl-${c}` },
          h('div', { class: 'dbl-col-head' }, h('span', { class: `dbl-dot ${c}` }), DOUBLE_COLORS[c], h('small', null, c === 'white' ? '30x' : '2x')),
          h('b', { class: 'dbl-amount' }, fmtGs(t.amount)),
          h('small', null, plural(t.players, 'jugador', 'jugadores')),
          h('div', { class: 'dbl-if' }, 'Si sale: ', h('span', { class: `num ${signClass(house)}` }, fmtSigned(house))),
        );
      }),
    );
    hist.replaceChildren(
      ...(d.history || []).map((r) => {
        const c = core.doubleColor(r.result);
        return h('span', { class: `dbl-pill ${c}`, title: `Ronda #${r.id}` }, c === 'white' ? '★' : String(r.result));
      }),
    );
    bets.replaceChildren(
      ...(d.bets.length
        ? d.bets.slice(0, 12).map((b) =>
            h(
              'div',
              { class: `dbl-bet ${b.status}` },
              h('span', { class: `dbl-dot ${b.color}` }),
              userLink(b.uid, b.user, { withAvatar: false }),
              h('span', { class: 'num' }, fmtGs(b.amount)),
              b.status === 'won' ? h('span', { class: 'num green' }, '+' + fmtGs(b.payout - b.amount)) : b.status === 'lost' ? h('span', { class: 'num red' }, '−' + fmtGs(b.amount)) : h('span', { class: 'faint' }, '…'),
            ),
          )
        : [emptyState('Nadie apostó en esta ronda todavía', '🎡')]),
    );
  };
  render();
  return { el, render };
}

// ───────────────────────── Ruleta en vivo ─────────────────────────

// Mesa de la ruleta: fila de arriba 3, 6, … 36; la del medio 2, 5, … 35; la de abajo 1, 4, … 34
const TABLE_ROWS = [3, 2, 1].map((r) => Array.from({ length: 12 }, (_, c) => c * 3 + r));

function rouletteCard() {
  const phase = h('span', { class: 'chip' });
  const round = h('span', { class: 'acard-sub' });
  const summary = h('div', { class: 'arl-sum' });
  const table = h('div', { class: 'arl-heat', role: 'img', 'aria-label': 'Resultado de la casa según el número que salga' });
  const hist = h('div', { class: 'dbl-hist' });
  const bets = h('div', { class: 'dbl-bets' });
  const el = card(
    '🎰 Ruleta en vivo',
    { cls: 'gm-roulette', actions: h('div', { class: 'dbl-head' }, round, phase) },
    summary,
    h('div', { class: 'dbl-sub' }, 'Si sale cada número, la casa…'),
    table,
    h('div', { class: 'dbl-sub' }, 'Últimos números'),
    hist,
    bets,
  );
  let key = '';
  const cell = (n, d) => {
    const house = d.houseIf ? d.houseIf[n] : 0;
    const scale = Math.max(1, ...(d.houseIf || []).map(Math.abs));
    const k = house ? Math.min(1, Math.abs(house) / scale) : 0;
    const bg = house > 0 ? `rgba(43, 217, 107, ${0.12 + 0.5 * k})` : house < 0 ? `rgba(241, 44, 76, ${0.15 + 0.6 * k})` : '';
    const on = d.lastResult === n;
    return h(
      'span',
      {
        class: `arl-cell arl-c-${core.rouletteColor(n)}${on ? ' on' : ''}${n === 0 ? ' zero' : ''}`,
        style: bg ? { background: bg } : null,
        title: house >= 0 ? `Si sale el ${n}: la casa gana ${fmtGs(house)}` : `Si sale el ${n}: la casa pierde ${fmtGs(-house)}`,
      },
      String(n),
    );
  };
  const render = () => {
    const d = state.stats && state.stats.roulette;
    if (!d) {
      summary.replaceChildren(loadingState());
      return;
    }
    const k = JSON.stringify([d.phase, d.roundId, Math.ceil((d.bettingLeft || 0) / 1000), d.total, d.houseIf, d.lastResult, d.history && d.history[0], d.bets.length]);
    if (k === key) return;
    key = k;
    setText(round, d.roundId ? `Ronda #${d.roundId}` : '');
    const last = d.lastResult;
    const phases = {
      BETTING: ['chip-green', `Apostando · ${Math.ceil((d.bettingLeft || 0) / 1000)} s`],
      SPINNING: ['chip-gold', 'Girando'],
      RESULT: ['chip-blue', last !== null ? `Salió ${ROULETTE_EMOJI[core.rouletteColor(last)]} ${last}` : 'Resultado'],
      PAUSED: ['chip-red', 'Pausada'],
      IDLE: ['chip', '—'],
    };
    const [pc, pt] = phases[d.phase] || ['chip', d.phase];
    phase.className = `chip ${pc}`;
    phase.textContent = pt;
    const box = (label, value, sub) => h('div', { class: 'arl-sum-box' }, h('small', null, label), value, sub ? h('small', { class: 'arl-sum-sub' }, sub) : null);
    const house = (v) => h('b', { class: `num ${signClass(v)}` }, fmtSigned(v));
    summary.replaceChildren(
      box('Apostado', h('b', null, fmtGs(d.total))),
      box('Jugadores', h('b', null, fmtNum(d.players))),
      box('Peor caso', d.total ? house(d.worst.house) : h('b', null, '—'), d.total ? `si sale el ${d.worst.n}` : null),
      box('Mejor caso', d.total ? house(d.best.house) : h('b', null, '—'), d.total ? `si sale el ${d.best.n}` : null),
    );
    table.replaceChildren(cell(0, d), h('div', { class: 'arl-heat-grid' }, ...TABLE_ROWS.flat().map((n) => cell(n, d))));
    hist.replaceChildren(
      ...(d.history || []).map((r) => h('span', { class: `dbl-pill arl-pill ${core.rouletteColor(r.result)}`, title: `Ronda #${r.id}` }, String(r.result))),
    );
    bets.replaceChildren(
      ...(d.bets.length
        ? d.bets.slice(0, 12).map((b) =>
            h(
              'div',
              { class: `dbl-bet arl-bet ${b.status}` },
              userLink(b.uid, b.user, { withAvatar: false }),
              h('span', { class: 'arl-bet-spots', title: rouletteBetsLabel(b.bets, 20) }, rouletteBetsLabel(b.bets, 2)),
              h('span', { class: 'num' }, fmtGs(b.amount)),
              b.status === 'won' || b.status === 'lost' ? signedMoney(b.payout - b.amount) : h('span', { class: 'faint' }, '…'),
            ),
          )
        : [emptyState('Nadie apostó en esta ronda todavía', '🎰')]),
    );
  };
  render();
  return { el, render };
}

// ───────────────────────── Jugadas en vivo ─────────────────────────

function feedCard() {
  const list = h('div', { class: 'gm-feed' });
  const empty = emptyState('Acá aparecen al instante las jugadas de todos los juegos.', '🎲');
  const el = card('Jugadas en vivo', { icon: 'activity', cls: 'gm-feed-card' }, list, empty);
  const row = (f) => {
    const meta = GAME_META[f.game] || GAME_META.crash;
    const net = f.payout - f.amount;
    return h(
      'div',
      { class: `gm-feed-row ${net > 0 ? 'won' : 'lost'}` },
      h('span', { class: 'gm-feed-time' }, fmtTime(f.ts)),
      h('span', { class: 'gm-feed-game', title: meta.name }, meta.icon),
      h('span', { class: 'gm-feed-user' }, f.user),
      h('span', { class: 'num' }, fmtGs(f.amount)),
      h('span', { class: `num ${net > 0 ? 'green' : 'faint'}` }, fmtMult(f.payout > 0 ? f.multiplier : 0)),
      h('span', { class: `num ${signClass(net)}` }, (net > 0 ? '+' : net < 0 ? '−' : '') + fmtGs(Math.abs(net))),
    );
  };
  const renderAll = () => {
    list.replaceChildren(...(state.feed || []).slice(0, 40).map(row));
    empty.hidden = !!(state.feed && state.feed.length);
  };
  renderAll();
  return {
    el,
    add(batch) {
      for (const f of batch) {
        const r = row(f);
        r.classList.add('is-new');
        list.prepend(r);
      }
      while (list.children.length > 40) list.lastChild.remove();
      empty.hidden = true;
    },
  };
}

// ───────────────────────── Detalle de una jugada ─────────────────────────

/** Fila "dato: valor" con el estilo del panel. */
const kv = (label, value, { mono = false } = {}) =>
  h('div', { class: 'kv' }, h('span', { class: 'kv-k' }, label), h('span', { class: `kv-v${mono ? ' mono' : ''}` }, value));

async function openDetail(p) {
  const meta = GAME_META[p.game] || GAME_META.crash;
  const live = p.game === 'double' || p.game === 'roulette';
  const body = h('div', { class: 'gm-detail' }, loadingState());
  openModal({ title: `${meta.icon} ${meta.name} · ${live ? `ronda #${p.round_id}` : `jugada #${p.id}`}`, content: body, wide: true });
  const summary = h(
    'div',
    { class: 'kvs' },
    kv('Jugador', userLink(p.user_id, p.username)),
    kv('Apuesta', fmtGs(p.amount)),
    kv(
      'Resultado',
      h(
        'span',
        null,
        p.status === 'active' ? 'En curso' : p.status === 'refunded' ? 'Devuelta' : signedMoney(p.payout - p.amount),
        p.status === 'won' ? ` (${fmtMult(p.multiplier)})` : '',
      ),
    ),
    kv('Detalle', p.detail || '—'),
    kv('Fecha', fmtDate(p.created_at)),
  );
  const verifyLink = (game, hash, salt) =>
    h('a', { class: 'btn btn-ghost btn-sm', href: `/fair?game=${game}&hash=${hash}&salt=${salt}`, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Verificar');
  try {
    if (live) {
      const d = await call(`/api/${p.game}/rounds/${p.round_id}`);
      const r = d.round;
      if (!r.hash) {
        body.replaceChildren(summary, h('p', { class: 'hint' }, 'La ronda todavía no giró: el resultado se muestra recién cuando gira.'));
        return;
      }
      let shown;
      let visual = null;
      if (p.game === 'double') {
        const c = core.doubleColor(r.result);
        shown = `${COLOR_EMOJI[c]} ${r.result} (${DOUBLE_COLORS[c]})`;
      } else {
        const c = core.rouletteColor(r.result);
        shown = `${ROULETTE_EMOJI[c]} ${r.result} (${ROULETTE_COLOR_NAMES[c]})`;
        const mine = (d.bets || []).find((b) => b.id === p.id);
        if (mine) visual = h('div', { class: 'gm-visual' }, playVisual({ game: 'roulette', result: r.result, bets: mine.bets }));
      }
      body.replaceChildren(
        summary,
        visual || '',
        h('div', { class: 'kvs kvs-soft gm-detail-fair' }, kv('Salió', shown), kv('Hash', r.hash, { mono: true }), kv('Sal', d.chain.salt, { mono: true })),
        verifyLink(p.game, r.hash, d.chain.salt),
      );
      return;
    }
    if (p.status === 'active') {
      body.replaceChildren(summary, h('p', { class: 'hint' }, 'La partida sigue en curso: el resultado (dónde están las minas o hacia dónde se tira el arquero) se muestra recién cuando termina.'));
      return;
    }
    const d = await call(`/api/plays/${p.id}`);
    const s = d.seed;
    body.replaceChildren(
      summary,
      h('div', { class: 'gm-visual' }, playVisual(d.play)),
      h(
        'div',
        { class: 'kvs kvs-soft gm-detail-fair' },
        kv('Semilla servidor', s.revealed ? s.serverSeed : '🔒 Todavía en uso (se revela cuando el jugador cambie sus semillas)', { mono: s.revealed }),
        kv('Hash servidor', s.serverHash, { mono: true }),
        kv('Semilla cliente', s.clientSeed, { mono: true }),
        kv('Nonce', String(d.play.nonce)),
      ),
      h('a', { class: 'btn btn-ghost btn-sm', href: `/fair?game=${p.game}&play=${p.id}`, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Abrir en la página de verificación'),
    );
  } catch (err) {
    body.replaceChildren(summary, errorState(err));
  }
}

// ───────────────────────── Historial de jugadas ─────────────────────────

const pq = { game: '', status: '', q: '', page: 1 };

const PLAY_COLS = [
  {
    label: 'Jugada',
    main: true,
    render: (p) => {
      const meta = GAME_META[p.game] || GAME_META.crash;
      const live = p.game === 'double' || p.game === 'roulette';
      return h('div', { class: 'gm-play-main' }, h('span', { class: 'gm-play-ic' }, meta.icon), h('div', null, h('b', null, `${meta.name} ${live ? `· ronda #${p.round_id}` : `#${p.id}`}`), h('small', null, fmtDate(p.created_at))));
    },
  },
  { label: 'Jugador', render: (p) => userLink(p.user_id, p.username) },
  { label: 'Apuesta', cls: 'num', render: (p) => fmtGs(p.amount) },
  { label: 'Detalle', cls: 'wrap-cell', render: (p) => p.detail },
  { label: 'x', cls: 'num', render: (p) => (p.status === 'won' ? h('span', { class: 'green' }, fmtMult(p.multiplier)) : null) },
  {
    label: 'Resultado',
    cls: 'num',
    render: (p) =>
      p.status === 'active'
        ? h('span', { class: 'chip chip-gold' }, 'En curso')
        : p.status === 'refunded'
          ? h('span', { class: 'chip' }, 'Devuelta')
          : signedMoney(p.payout - p.amount),
  },
];

function playsCard(seqRef) {
  const box = h('div', { class: 'log-box' }, loadingState());
  const load = async () => {
    const seq = ++seqRef.n;
    box.classList.add('is-refreshing');
    try {
      const qs = new URLSearchParams({ game: pq.game, status: pq.status, q: pq.q, page: String(pq.page) });
      const res = await call(`/api/admin/plays?${qs}`);
      if (seq !== seqRef.n) return;
      box.replaceChildren(
        h('section', { class: 'acard acard-flush' }, dataTable(PLAY_COLS, res.items, { onRow: openDetail, empty: 'No hay jugadas con ese filtro', emptyEmoji: '🎲', compact: true, mobileLimit: 20 })),
        pager(res, res.total === 1 ? 'jugada' : 'jugadas', (p) => {
          pq.page = p;
          load();
        }),
      );
    } catch (err) {
      if (seq === seqRef.n) box.replaceChildren(errorState(err, load));
    } finally {
      if (seq === seqRef.n) box.classList.remove('is-refreshing');
    }
  };
  const games = filterChips(
    [['', 'Todos'], ...GAME_ORDER.filter((g) => g !== 'crash').map((g) => [g, `${GAME_META[g].icon} ${GAME_META[g].name}`])],
    pq.game,
    (v) => {
      pq.game = v;
      pq.page = 1;
      load();
    },
  );
  const statuses = filterChips(
    [
      ['', 'Todas'],
      ['won', 'Ganadas'],
      ['lost', 'Perdidas'],
      ['active', 'En curso'],
      ['refunded', 'Devueltas'],
    ],
    pq.status,
    (v) => {
      pq.status = v;
      pq.page = 1;
      load();
    },
  );
  const el = h(
    'div',
    { class: 'gm-history' },
    h('h2', { class: 'gm-h2' }, icon('table', 18), 'Historial de jugadas', h('small', null, 'Minas, Penales, Double, Plinko y Ruleta (las apuestas del Crash están en cada ronda y en cada usuario)')),
    h(
      'div',
      { class: 'toolbar' },
      searchBox(pq.q, 'Buscar por usuario…', (q) => {
        pq.q = q;
        pq.page = 1;
        load();
      }),
      games,
      statuses,
    ),
    box,
  );
  return { el, load };
}

// ───────────────────────── Vista ─────────────────────────

export const gamesView = {
  sc: null,
  seq: { n: 0 },
  overview: null,
  mount(el) {
    const sc = scope();
    this.sc = sc;
    const status = statusCard(() => this.overview);
    const dbl = doubleCard();
    const rl = rouletteCard();
    const feed = feedCard();
    const history = playsCard(this.seq);
    const loadOverview = async () => {
      try {
        this.overview = await call('/api/admin/overview');
        status.render();
      } catch (err) {
        if (!this.overview) notifyError(err);
      }
    };
    sc.on('stats', () => {
      dbl.render();
      rl.render();
      status.render();
    });
    sc.on('settings', () => status.render());
    sc.on('game:state', () => status.render());
    sc.on('feed', (batch) => feed.add(batch));
    sc.interval(loadOverview, 15_000);
    el.append(
      viewHead(
        'Juegos',
        'Prendé o pausá cada juego, mirá el Double y la Ruleta en vivo y todas las jugadas.',
        refreshBtn(async () => {
          await loadOverview();
          await history.load();
        }),
      ),
      // Dos columnas independientes en la PC (así no quedan huecos); en el celular, una debajo de la otra
      h('div', { class: 'gm-grid' }, h('div', { class: 'gm-col' }, status.el, rl.el), h('div', { class: 'gm-col' }, dbl.el, feed.el)),
      history.el,
    );
    loadOverview();
    history.load();
  },
  unmount() {
    this.sc?.dispose();
    this.sc = null;
    this.seq.n++;
  },
};

export { openDetail as openPlayDetail };
