// Juegos: prender/pausar cada juego, Double en vivo, jugadas en vivo e historial de jugadas de todos.
import { h, fmtGs, fmtNum, fmtMult, fmtDate, fmtTime, toast, confirmDialog, openModal } from './shared.js';
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
import { core, playVisual, DOUBLE_COLORS } from './games/common.js';

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
  if (id === 'double' && state.settings.game_double !== false && state.stats?.double?.phase === 'PAUSED') return ['warn', 'Arrancando…'];
  return state.settings[`game_${id}`] === false ? ['off', 'Pausado'] : ['on', 'Activo'];
}

async function setEnabled(id, on) {
  const meta = GAME_META[id];
  if (id === 'crash') return togglePause();
  if (!on) {
    const msg =
      id === 'double'
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
          h('div', { class: 'dbl-if' }, 'Si sale: ', h('span', { class: `num ${signClass(house)}` }, (house > 0 ? '+' : '') + fmtGs(house))),
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

// ───────────────────────── Jugadas en vivo ─────────────────────────

function feedCard() {
  const list = h('div', { class: 'gm-feed' });
  const empty = emptyState('Acá aparecen al instante las jugadas de todos los juegos.', '🎲');
  const el = card('Jugadas en vivo', { icon: 'activity', cls: 'gm-feed-card' }, list, empty);
  const row = (f) => {
    const meta = GAME_META[f.game] || GAME_META.crash;
    const won = f.payout > 0;
    return h(
      'div',
      { class: `gm-feed-row ${won ? 'won' : 'lost'}` },
      h('span', { class: 'gm-feed-time' }, fmtTime(f.ts)),
      h('span', { class: 'gm-feed-game', title: meta.name }, meta.icon),
      h('span', { class: 'gm-feed-user' }, f.user),
      h('span', { class: 'num' }, fmtGs(f.amount)),
      h('span', { class: `num ${won ? 'green' : 'faint'}` }, won ? fmtMult(f.multiplier) : '0.00x'),
      h('span', { class: `num ${won ? 'green' : 'red'}` }, won ? '+' + fmtGs(f.payout - f.amount) : '−' + fmtGs(f.amount)),
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

async function openDetail(p) {
  const meta = GAME_META[p.game] || GAME_META.crash;
  const body = h('div', null, loadingState());
  openModal({ title: `${meta.icon} ${meta.name} · ${p.game === 'double' ? `ronda #${p.round_id}` : `jugada #${p.id}`}`, content: body, wide: true });
  const summary = h(
    'dl',
    { class: 'kv' },
    h('dt', null, 'Jugador'),
    h('dd', null, userLink(p.user_id, p.username)),
    h('dt', null, 'Apuesta'),
    h('dd', null, fmtGs(p.amount)),
    h('dt', null, 'Resultado'),
    h('dd', null, p.status === 'active' ? 'En curso' : p.status === 'refunded' ? 'Devuelta' : signedMoney(p.payout - p.amount), p.status === 'won' ? ` (${fmtMult(p.multiplier)})` : ''),
    h('dt', null, 'Detalle'),
    h('dd', null, p.detail),
    h('dt', null, 'Fecha'),
    h('dd', null, fmtDate(p.created_at)),
  );
  try {
    if (p.game === 'double') {
      const d = await call(`/api/double/rounds/${p.round_id}`);
      const r = d.round;
      const extra = r.hash
        ? h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Salió'),
            h('dd', null, `${COLOR_EMOJI[core.doubleColor(r.result)]} ${r.result} (${DOUBLE_COLORS[core.doubleColor(r.result)]})`),
            h('dt', null, 'Hash'),
            h('dd', { class: 'mono' }, r.hash),
            h('dt', null, 'Sal'),
            h('dd', { class: 'mono' }, d.chain.salt),
          )
        : h('p', { class: 'hint' }, 'La ronda todavía no giró.');
      body.replaceChildren(summary, extra, r.hash ? h('a', { class: 'btn btn-ghost btn-sm', href: `/fair?game=double&hash=${r.hash}&salt=${d.chain.salt}`, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Verificar') : '');
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
        'dl',
        { class: 'kv' },
        h('dt', null, 'Semilla servidor'),
        h('dd', { class: 'mono' }, s.revealed ? s.serverSeed : '🔒 Todavía en uso (se revela cuando el jugador cambie sus semillas)'),
        h('dt', null, 'Hash servidor'),
        h('dd', { class: 'mono' }, s.serverHash),
        h('dt', null, 'Semilla cliente'),
        h('dd', { class: 'mono' }, s.clientSeed),
        h('dt', null, 'Nonce'),
        h('dd', null, String(d.play.nonce)),
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
      return h('div', { class: 'gm-play-main' }, h('span', { class: 'gm-play-ic' }, meta.icon), h('div', null, h('b', null, `${meta.name} ${p.game === 'double' ? `· ronda #${p.round_id}` : `#${p.id}`}`), h('small', null, fmtDate(p.created_at))));
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
      status.render();
    });
    sc.on('settings', () => status.render());
    sc.on('game:state', () => status.render());
    sc.on('feed', (batch) => feed.add(batch));
    sc.interval(loadOverview, 15_000);
    el.append(
      viewHead(
        'Juegos',
        'Prendé o pausá cada juego, mirá el Double en vivo y todas las jugadas.',
        refreshBtn(async () => {
          await loadOverview();
          await history.load();
        }),
      ),
      h('div', { class: 'gm-grid' }, status.el, dbl.el, feed.el),
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
