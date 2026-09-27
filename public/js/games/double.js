// 🎡 Double: ruleta de colores multijugador (como la de Blaze). Todos juegan la misma ronda:
// mientras corre la cuenta regresiva se apuesta a ROJO (2x), NEGRO (2x) o BLANCO (30x);
// después la cinta gira y frena en la casilla que sale del hash de la ronda.
import { h, api, fmtGs, fmtNum, fmtMult, fmtSigned, fmtTime, toast } from '../shared.js';
import {
  core,
  AmountControl,
  panelHead,
  resultOverlay,
  winPop,
  confetti,
  pausedNotice,
  setText,
  setClass,
  vibrate,
  avatar,
  compact,
  isBigWin,
  reducedMotion,
  openDoubleRound,
  DOUBLE_COLORS,
} from './common.js';

const N = core.DOUBLE_TILES; // 31 casillas: 0 blanca, impares rojas, pares negras
const PAYS = core.DOUBLE_PAYS; // en centésimas: rojo y negro 200, blanco 3000
const COLORS = ['red', 'white', 'black']; // orden de los botones y de las columnas
// Orden fijo de la cinta: rojo y negro siempre alternados y el blanco una vez por vuelta.
const ORDER = [0, 17, 8, 25, 14, 3, 30, 11, 22, 7, 28, 19, 4, 13, 26, 1, 20, 9, 16, 27, 6, 15, 24, 5, 12, 29, 18, 23, 10, 21, 2];
const INDEX = [];
ORDER.forEach((n, i) => (INDEX[n] = i));
const STRIP_CYCLES = 3; // vueltas dibujadas en la cinta: la del medio es la que queda bajo la marca
const SPIN_CYCLES = 3; // vueltas completas que recorre cada giro (como mínimo)
const LAND_EARLY = 300; // la cinta frena un poquito antes de que el servidor pague
const MAX_ROWS = 30; // apuestas que se listan por color
const CLS = { red: 'db-red', black: 'db-black', white: 'db-white' };
const NAME = { red: 'ROJO', black: 'NEGRO', white: 'BLANCO' };
const MULT = { red: '2x', black: '2x', white: '30x' };
const ZERO = () => ({ red: 0, black: 0, white: 0 });

// Estrella del blanco (dibujo propio, constante)
const STAR = '<svg class="db-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.47 6.6 7.04.31-5.52 4.39 1.89 6.79L12 17.2l-5.88 3.89 1.89-6.79-5.52-4.39 7.04-.31z"/></svg>';

const mod = (a, n) => ((a % n) + n) % n;

/** Corrimiento dentro de la casilla (±35 %) que sale del número de ronda: la cinta frena igual para todos. */
function landOffset(id) {
  let x = Math.imul((Number(id) | 0) ^ 0x5bd1e995, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967296 - 0.5) * 0.7;
}

/** Posición (en casillas) donde queda la cinta después de una ronda. */
function restPos(r) {
  return r && INDEX[r.result] !== undefined ? INDEX[r.result] + landOffset(r.id) : 0;
}

/** Frenado del giro: arranca a toda velocidad y se arrastra en las últimas casillas. */
const spinEase = (k) => 1 - Math.pow(1 - k, 2.6);

/** Monto con dos formatos: completo (PC) y corto (columnas angostas del celular). */
function money(v, gs = false) {
  return [h('span', { class: 'db-full' }, gs ? fmtGs(v) : fmtNum(v)), h('span', { class: 'db-short' }, (gs ? 'Gs. ' : '') + compact(v))];
}

function starNode(tag = 'span', cls = '') {
  const n = h(tag, cls ? { class: cls } : null);
  n.innerHTML = STAR; // dibujo propio (constante)
  return n;
}

export function createDouble(shell) {
  const { socket, sound } = shell;
  const S = () => shell.state.settings;
  const myId = () => (shell.state.user ? shell.state.user.id : null);
  const isMine = (b) => !!b && !b.bot && myId() !== null && b.uid === myId();
  const visible = () => shell.isVisible('double');

  // ───────────────────────── Estado (se mantiene al día aunque el juego no esté en pantalla) ─────────────────────────

  const st = {
    phase: 'CONNECTING',
    paused: false,
    roundId: null,
    bettingMs: 15000,
    spinMs: 6000,
    resultMs: 4000,
    bettingEndsAt: 0, // performance.now() en que se cierran las apuestas
    nextAt: 0, // performance.now() en que arranca la próxima ronda (fase RESULT)
    history: [], // [{ id, result }] la más nueva primero
    bets: new Map(), // "uid:color" → { id, uid, user, color, amount, status, payout, bot? }
  };
  let mine = { roundId: null, bets: ZERO() }; // mis apuestas de la ronda actual (totales por color)
  let last100 = null; // [{ id, result }] de las últimas 100 rondas (null hasta que carguen)
  let last100Loading = false;
  let spin = null; // { roundId, result, color, from, dist, t0, dur, landed, still }
  let pos = 0; // posición de la cinta en casillas: ORDER[round(pos) mod N] queda bajo la marca
  let shown = null; // resultado en pantalla con la cinta detenida { id, result, color }
  let landTimer = null;
  let releaseLock = null; // suelta el saldo congelado mientras gira la cinta
  let pendingMine = null; // resultado privado que llegó antes de que la cinta frene
  let resultNote = null; // { roundId, text, kind }
  let busy = false;
  let pendingColor = null;
  let betsDirty = true;
  let lastBetsRender = 0;
  let lastTickSecond = -1;
  let lastTile = null;
  let lastWheelTick = 0;

  let el = null;
  let amount = null;
  let geo = null; // medidas de la cinta { W, c0, step }
  let lastX = null;

  const spinning = () => !!(spin && !spin.landed);
  const myBets = () => (mine.roundId === st.roundId ? mine.bets : ZERO());
  const myTotal = () => {
    const b = myBets();
    return b.red + b.black + b.white;
  };
  const bettingLeft = (now = performance.now()) => Math.max(0, st.bettingEndsAt - now);
  const offline = () => S().game_double === false || st.paused || st.phase === 'PAUSED';
  const midRound = () => spinning() || st.phase === 'SPINNING' || st.phase === 'RESULT';
  const pausedView = () => offline() && !midRound();
  const canBet = () => st.phase === 'BETTING' && !offline() && bettingLeft() > 0;
  const payoutOf = (b) => {
    const maxProfit = Number(S().max_profit) || Infinity;
    return Math.min(Math.floor((b.amount * PAYS[b.color]) / 100), b.amount + maxProfit);
  };

  // ───────────────────────── Saldo ─────────────────────────
  // Mientras gira la cinta el saldo que se ve queda congelado: el premio aparece cuando frena.

  function lockBalance(ms) {
    if (!releaseLock) releaseLock = shell.lockBalance(ms);
  }

  function unlockBalance(delay = 0) {
    if (!releaseLock) return;
    const release = releaseLock;
    releaseLock = null;
    if (delay > 0) setTimeout(release, delay);
    else release();
  }

  // ───────────────────────── Giro de la cinta ─────────────────────────

  function spinPos(now) {
    const k = (now - spin.t0) / spin.dur;
    if (k >= 1) return spin.from + spin.dist;
    if (spin.still) return spin.from;
    return spin.from + spin.dist * spinEase(Math.max(0, k));
  }

  const currentPos = (now) => (spinning() ? spinPos(now) : pos);

  /**
   * Arranca el giro de una ronda. `canonical`: se une a un giro ya empezado (recién conectado), así que parte
   * del mismo lugar que todos (donde frenó la ronda anterior) para ver exactamente la misma cinta.
   */
  function beginSpin(roundId, result, elapsed = 0, canonical = false) {
    if (spinning()) land(true);
    clearTimeout(landTimer);
    const from = canonical ? restPos(st.history[0]) : pos;
    const target = INDEX[result] + landOffset(roundId);
    const dur = Math.max(1000, st.spinMs - LAND_EARLY);
    spin = {
      roundId,
      result,
      color: core.doubleColor(result),
      from,
      dist: N * SPIN_CYCLES + mod(target - from, N),
      t0: performance.now() - Math.max(0, elapsed),
      dur,
      landed: false,
      still: reducedMotion(),
    };
    shown = null;
    lastTile = null;
    const left = spin.t0 + dur - performance.now();
    if (left <= 0) land(true);
    else landTimer = setTimeout(() => land(), left);
  }

  /** Muestra una ronda ya terminada (por ejemplo al conectarse durante el resultado). */
  function showLanded(roundId, result) {
    spin = { roundId, result, color: core.doubleColor(result), from: restPos({ id: roundId, result }), dist: 0, t0: 0, dur: 1, landed: false, still: true };
    land(true);
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

  /** La cinta se detuvo: se muestra el resultado (historial, columnas, cartel) y se suelta el saldo. */
  function land(silent = false) {
    if (!spinning()) return;
    clearTimeout(landTimer);
    landTimer = null;
    const s = spin;
    s.landed = true;
    pos = mod(s.from + s.dist, N);
    shown = { id: s.roundId, result: s.result, color: s.color };
    if (st.phase === 'SPINNING') st.nextAt = performance.now() + LAND_EARLY + st.resultMs;
    const fresh = addResult({ id: s.roundId, result: s.result });
    for (const b of st.bets.values()) {
      if (b.status !== 'active') continue;
      const won = b.color === s.color;
      b.status = won ? 'won' : 'lost';
      b.payout = won ? payoutOf(b) : 0;
    }
    betsDirty = true;
    const fx = !silent && !!el && visible();
    if (el) {
      placeBand(pos, false);
      markWinner();
      renderBanner(fx);
      renderHistory(fresh && fx);
      renderStats();
      renderBets();
      setClass(el.glow, `db-glow ${CLS[s.color]} on`);
      if (fx) {
        el.flash.className = `db-flash ${CLS[s.color]}`;
        void el.flash.offsetWidth;
        el.flash.classList.add('go');
        sound.land(100);
        if (s.color === 'white') sound.gem(14);
      }
    }
    render();
    unlockBalance(200);
    const d = pendingMine;
    pendingMine = null;
    if (d && d.roundId === s.roundId) setTimeout(() => showMine(d), 250);
  }

  function clearShown() {
    shown = null;
    if (!el) return;
    markWinner();
    renderBanner(false);
    el.glow.classList.remove('on');
    clearTimeout(el.celebrateTimer);
    el.status.classList.remove('celebrating');
  }

  // ───────────────────────── Eventos del servidor ─────────────────────────

  function applySnapshot(d) {
    const g = d.double;
    if (!g) return;
    const now = performance.now();
    st.paused = !!g.paused;
    if (g.bettingMs) st.bettingMs = g.bettingMs;
    if (g.spinMs) st.spinMs = g.spinMs;
    if (g.resultMs) st.resultMs = g.resultMs;
    st.history = Array.isArray(g.history) ? g.history.map((r) => ({ id: r.id, result: r.result })) : [];
    st.bets = new Map((g.bets || []).map((b) => [`${b.uid}:${b.color}`, { ...b }]));
    betsDirty = true;
    const md = d.myDouble;
    mine = md && md.bets ? { roundId: md.roundId, bets: { ...ZERO(), ...md.bets } } : { roundId: g.roundId, bets: ZERO() };
    const sameSpin = !!(spin && spin.roundId === g.roundId);
    st.phase = g.phase;
    st.roundId = g.roundId;
    // Si la cinta ya frenó acá pero el servidor todavía no pagó, conservamos ese resultado en el historial
    if (sameSpin && spin.landed) addResult({ id: spin.roundId, result: spin.result });
    switch (g.phase) {
      case 'BETTING':
        if (spinning()) land(true);
        spin = null;
        pendingMine = null;
        resultNote = null;
        unlockBalance();
        st.bettingEndsAt = now + (g.bettingLeft || 0);
        pos = restPos(st.history[0]);
        clearShown();
        break;
      case 'SPINNING':
        if (!sameSpin) beginSpin(g.roundId, g.result, g.spinElapsed || 0, true);
        if (spinning() && myTotal() > 0) lockBalance(Math.max(0, spin.t0 + spin.dur - now) + 3200);
        break;
      case 'RESULT':
        st.nextAt = now + (g.nextIn || 0);
        // Si la cinta todavía está frenando la dejamos terminar; si no la vimos girar, mostramos el resultado
        if (!sameSpin) showLanded(g.roundId, g.result);
        break;
      default:
        // PAUSED / IDLE
        if (spinning()) land(true);
        spin = null;
        unlockBalance();
        pos = restPos(st.history[0]);
        clearShown();
    }
  }

  socket.on('double:betting', (d) => {
    if (!d) return;
    if (spinning()) land(true);
    st.phase = 'BETTING';
    st.paused = false;
    st.roundId = d.roundId;
    if (d.ms) st.bettingMs = d.ms;
    st.bettingEndsAt = performance.now() + (d.ms || 0);
    st.bets.clear();
    betsDirty = true;
    mine = { roundId: d.roundId, bets: ZERO() };
    spin = null;
    pendingMine = null;
    resultNote = null;
    clearShown();
    if (el && visible()) renderBets();
    render();
  });

  socket.on('double:bet', (b) => {
    if (!b || !CLS[b.color]) return;
    st.bets.set(`${b.uid}:${b.color}`, { ...b });
    betsDirty = true;
    if (isMine(b) && st.phase === 'BETTING') {
      if (mine.roundId !== st.roundId) mine = { roundId: st.roundId, bets: ZERO() };
      mine.bets[b.color] = b.amount; // el servidor manda mi total en ese color
      render();
    }
  });

  socket.on('double:spin', (d) => {
    if (!d) return;
    st.phase = 'SPINNING';
    st.roundId = d.roundId;
    if (d.ms) st.spinMs = d.ms;
    if (myTotal() > 0) lockBalance((d.ms || st.spinMs) + 3000);
    beginSpin(d.roundId, d.result, 0, false);
    if (visible() && !spin.still) sound.rouletteBall(1.4);
    if (el) {
      markWinner();
      renderBanner(false);
      el.glow.classList.remove('on');
    }
    render();
  });

  socket.on('double:result', (d) => {
    if (!d) return;
    st.phase = 'RESULT';
    st.roundId = d.roundId;
    st.nextAt = performance.now() + (d.nextIn || st.resultMs);
    // Si no vimos el giro (reconexión), mostramos el resultado directo. Si la cinta sigue frenando, termina sola.
    if (!spin || spin.roundId !== d.roundId) showLanded(d.roundId, d.result);
    render();
  });

  socket.on('double:refund', (d) => {
    if (d && st.roundId !== null && d.roundId !== st.roundId) return;
    st.bets.clear();
    betsDirty = true;
    mine = { roundId: st.roundId, bets: ZERO() };
    if (el && visible()) renderBets();
    render();
  });

  socket.on('double:paused', (d) => {
    if (!d) return;
    st.paused = !!d.paused;
    if (d.paused) {
      if (d.phase === 'SPINNING' || d.phase === 'RESULT') {
        if (visible()) toast('⏸ El Double se pausa al terminar esta ronda', 'info');
      } else st.phase = 'PAUSED';
    }
    render();
  });

  socket.on('myDouble', (d) => {
    if (!d) return;
    if (d.refunded) {
      if (mine.roundId === d.roundId) mine = { roundId: d.roundId, bets: ZERO() };
      toast(`Te devolvimos ${fmtGs(d.bet)} que tenías apostado en el Double`, 'info', '↩ Apuesta devuelta');
      render();
      shell.refreshMine();
      return;
    }
    // El servidor avisa al terminar su giro: si nuestra cinta sigue frenando, esperamos a que se detenga
    if (spin && spin.roundId === d.roundId && !spin.landed) pendingMine = d;
    else showMine(d);
  });

  /** Mi resultado de la ronda (ya con la cinta detenida). */
  function showMine(d) {
    const color = d.color || core.doubleColor(d.result);
    const net = d.payout - d.bet;
    const here = !!el && visible();
    if (d.payout > 0 && net > 0) {
      const pays = PAYS[color];
      const big = isBigWin(d.payout, d.bet, pays);
      resultNote = { roundId: d.roundId, kind: 'good', text: `✅ Ganaste ${fmtGs(d.payout)} con el ${color === 'white' ? 'BLANCO' : NAME[color].toLowerCase()}` };
      if (here) {
        el.result.show({ win: true, head: fmtMult(pays), detail: `Ganaste ${fmtGs(d.payout)}`, big });
        // El premio aparece donde está el cartel del resultado: lo escondemos mientras tanto
        winPop(el.winLayer, { amount: net, label: color === 'white' ? '¡Salió BLANCO! ⭐' : `¡Salió ${NAME[color]}! 🎉`, big });
        el.status.classList.add('celebrating');
        clearTimeout(el.celebrateTimer);
        el.celebrateTimer = setTimeout(() => el.status.classList.remove('celebrating'), 2300);
        if (big) confetti(el.stage, { colors: color === 'white' ? ['#ffffff', '#f12c4c', '#ffc53d', '#ffe38a'] : ['#f12c4c', '#ffffff', '#ffc53d', '#3d7bff'] });
        sound.win(big);
        vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
      } else {
        toast(`Salió ${NAME[color].toLowerCase()}: ganaste ${fmtGs(d.payout)}`, 'win', '🎡 Double');
      }
    } else if (d.payout > 0) {
      // Apostó a más de un color y lo cobrado no supera lo apostado
      resultNote = { roundId: d.roundId, kind: '', text: net === 0 ? `Recuperaste lo apostado (${fmtGs(d.payout)})` : `Cobraste ${fmtGs(d.payout)} · en total ${fmtSigned(net)}` };
      if (here) sound.coin();
    } else {
      resultNote = { roundId: d.roundId, kind: 'bad', text: `Perdiste ${fmtGs(d.bet)} · salió ${NAME[color].toLowerCase()}` };
      if (here) sound.lose();
    }
    render();
    shell.refreshMine();
  }

  // ───────────────────────── Apostar ─────────────────────────

  async function placeBet(color) {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (busy) return;
    if (!canBet()) {
      toast(offline() ? 'El Double está en pausa por un momento' : 'Las apuestas están cerradas, esperá la próxima ronda', 'info');
      return;
    }
    const value = amount.value;
    if (value > shell.balance) {
      toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return;
    }
    busy = true;
    pendingColor = color;
    render();
    const res = await shell.emit('double:bet', { color, amount: value });
    busy = false;
    pendingColor = null;
    if (!res.ok) {
      toast(res.error || 'No se pudo apostar', 'error');
      render();
      return;
    }
    if (res.mine && res.mine.bets) mine = { roundId: res.mine.roundId, bets: { ...ZERO(), ...res.mine.bets } };
    shell.setBalance(res.balance);
    sound.bet();
    vibrate(15);
    if (el) {
      const b = el.btns[color];
      b.main.classList.remove('bump');
      void b.main.offsetWidth;
      b.main.classList.add('bump');
    }
    render();
  }

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function colorButton(c) {
    const mineValue = h('b');
    const mineEl = h('span', { class: 'db-cb-mine', hidden: true }, h('small', null, 'Tu apuesta'), mineValue);
    const name = h('span', { class: 'db-cb-name' }, c === 'white' ? starNode('span', 'db-cb-star') : null, NAME[c]);
    const main = h('span', { class: 'db-cb-main' }, name, h('span', { class: 'db-cb-sep' }, '·'), h('span', { class: 'db-cb-mult' }, MULT[c]));
    const btn = h('button', { type: 'button', class: `db-cb ${CLS[c]}`, 'aria-label': `Apostar a ${DOUBLE_COLORS[c].toLowerCase()} (paga ${MULT[c]})` }, main, mineEl);
    btn.addEventListener('click', () => placeBet(c));
    return { btn, main, mine: mineEl, mineValue };
  }

  function buildColumn(c) {
    const chip = h('span', { class: `db-col-chip ${CLS[c]}` }, MULT[c]);
    const total = h('b', { class: 'db-col-total' });
    const count = h('small', { class: 'db-col-count' });
    const list = h('div', { class: 'db-col-list' });
    const node = h('div', { class: `db-col ${CLS[c]}` }, h('div', { class: 'db-col-head' }, chip, h('div', { class: 'db-col-sum' }, total, count)), list);
    return { el: node, total, count, list };
  }

  function mount(root) {
    const round = h('span', { class: 'db-round' });
    const l100 = h('div', { class: 'db-l100' });
    const history = h('div', { class: 'db-history', 'aria-label': 'Últimos resultados' });

    const tiles = [];
    for (let j = 0; j < N * STRIP_CYCLES; j++) {
      const n = ORDER[j % N];
      const c = core.doubleColor(n);
      const t = h('div', { class: `db-tile ${CLS[c]}` });
      if (c === 'white') t.innerHTML = `${STAR}<span class="db-x">30x</span>`; // dibujo propio (constante)
      else t.append(h('span', { class: 'db-num' }, String(n)));
      tiles.push(t);
    }
    const strip = h('div', { class: 'db-strip' }, ...tiles, h('div', { class: 'db-dim' }));
    const win = h('div', { class: 'db-window' }, strip);
    const band = h('div', { class: 'db-band', 'aria-hidden': 'true' }, win, h('div', { class: 'db-marker' }));

    const secs = h('b', { class: 'db-secs' });
    const barFill = h('i');
    const msg = h('div', { class: 'db-msg' });
    const banner = h('div', { class: 'db-banner', 'aria-live': 'polite' });
    const sub = h('div', { class: 'db-sub' });
    const status = h('div', { class: 'db-status' }, h('div', { class: 'db-count' }, 'Girando en ', secs), h('div', { class: 'db-bar' }, barFill), msg, banner, sub);

    const glow = h('div', { class: 'db-glow' });
    const flash = h('div', { class: 'db-flash' });
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused = pausedNotice();
    const stage = h('div', { class: 'gv-stage db-stage' }, glow, h('div', { class: 'db-top' }, round, l100), history, band, status, flash, result.el, winLayer, paused);

    amount = new AmountControl(shell, { key: 'cpy_dbl_amt', def: 5000, onChange: () => render() });
    const btns = {};
    const colors = h('div', { class: 'db-colors' }, ...COLORS.map((c) => (btns[c] = colorButton(c)).btn));
    const note = h('div', { class: 'gv-note db-note' });
    const panel = h(
      'div',
      { class: 'gv-panel db-panel' },
      panelHead(shell, { icon: '🎡', name: 'Double', seeds: false }),
      h('div', { class: 'db-amount' }, h('div', { class: 'gv-label' }, 'Monto'), amount.el),
      h('div', { class: 'db-pick' }, h('div', { class: 'gv-label' }, 'Elegí un color'), colors),
      note,
    );

    const cols = {};
    const betsPlayers = h('span');
    const betsTotal = h('b');
    const bets = h(
      'section',
      { class: 'db-bets', 'aria-label': 'Apuestas de la ronda' },
      h('div', { class: 'db-bets-head' }, h('span', { class: 'db-bets-title' }, 'Apuestas de la ronda'), h('span', { class: 'db-bets-sum' }, betsPlayers, ' · Total ', betsTotal)),
      h('div', { class: 'db-cols' }, ...COLORS.map((c) => (cols[c] = buildColumn(c)).el)),
    );

    root.append(h('div', { class: 'gv gv-double' }, stage, panel, bets));
    el = { stage, round, l100, history, band, win, strip, tiles, status, secs, barFill, msg, banner, sub, glow, flash, result, winLayer, paused, btns, colors, note, cols, betsPlayers, betsTotal, winTile: null, mode: '', hurry: false };

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        geo = null;
        if (shell.current === 'double') placeBand(currentPos(performance.now()), spinning());
      }).observe(win);
    }
    renderAll();
    loadLast100();
  }

  // ───────────────────────── Dibujo ─────────────────────────

  function measure() {
    if (!el) return false;
    const W = el.win.clientWidth;
    const t0 = el.tiles[0];
    const t1 = el.tiles[1];
    if (!W || !t0.offsetWidth) {
      geo = null;
      return false;
    }
    geo = { W, c0: t0.offsetLeft + t0.offsetWidth / 2, step: t1.offsetLeft - t0.offsetLeft };
    lastX = null;
    return true;
  }

  /** Ubica la cinta para que la posición `p` (en casillas) quede justo bajo la marca. */
  function placeBand(p, moving) {
    if (!el || (!geo && !measure())) return;
    let x = geo.W / 2 - (geo.c0 + (N + mod(p, N)) * geo.step);
    if (!moving) {
      const dpr = window.devicePixelRatio || 1;
      x = Math.round(x * dpr) / dpr;
    }
    if (x !== lastX) {
      lastX = x;
      el.strip.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
    }
  }

  function markWinner() {
    if (!el) return;
    if (el.winTile) el.winTile.classList.remove('win');
    el.winTile = null;
    if (shown) {
      const tile = el.tiles[Math.round(N + mod(pos, N))];
      if (tile) {
        tile.classList.add('win');
        el.winTile = tile;
      }
    }
    el.band.classList.toggle('landed', !!shown);
  }

  function renderBanner(pop) {
    if (!el) return;
    if (!shown) {
      el.banner.replaceChildren();
      el.banner.className = 'db-banner';
      return;
    }
    const c = shown.color;
    const tile = c === 'white' ? starNode('span', `db-bn-tile ${CLS[c]}`) : h('span', { class: `db-bn-tile ${CLS[c]}` }, String(shown.result));
    const text = c === 'white' ? h('span', { class: 'db-bn-text' }, '¡BLANCO! ', h('b', null, '30x')) : h('span', { class: 'db-bn-text' }, 'Salió ', h('b', null, `${NAME[c]} ${shown.result}`));
    el.banner.replaceChildren(tile, text);
    el.banner.className = `db-banner ${CLS[c]}${pop ? ' pop' : ''}`;
  }

  function histItem(r, extra = '') {
    const c = core.doubleColor(r.result);
    const b = h('button', {
      type: 'button',
      class: `db-hist ${CLS[c]}${extra}`,
      title: `Ronda #${r.id} · ${DOUBLE_COLORS[c]} ${r.result}`,
      'aria-label': `Ronda ${r.id}: ${DOUBLE_COLORS[c].toLowerCase()} ${r.result}`,
      onclick: () => openDoubleRound(shell, r.id),
    });
    if (c === 'white') b.innerHTML = STAR; // dibujo propio (constante)
    else b.textContent = String(r.result);
    return b;
  }

  function renderHistory(animate = false) {
    if (!el) return;
    const items = st.history.slice(0, 20).map((r, i) => histItem(r, animate && i === 0 ? ' new' : ''));
    if (!items.length) items.push(h('span', { class: 'db-hist-empty' }, 'Todavía no hay rondas'));
    el.history.replaceChildren(...items);
    el.history.scrollLeft = 0;
  }

  function renderStats() {
    if (!el) return;
    const list = (last100 || st.history).slice(0, 100);
    const n = list.length;
    const count = ZERO();
    for (const r of list) count[core.doubleColor(r.result)]++;
    el.l100.replaceChildren(
      h('span', { class: 'db-l100-label' }, `Últimas ${n}`),
      ...COLORS.map((c) =>
        h(
          'span',
          { class: `db-l100-chip ${CLS[c]}`, title: `${DOUBLE_COLORS[c]}: ${count[c]} de ${n}` },
          c === 'white' ? starNode('i') : h('i'),
          `${n ? Math.round((count[c] * 100) / n) : 0}%`,
        ),
      ),
    );
  }

  function betRow(b, res, uid) {
    const won = !!res && b.color === res;
    const payout = won ? b.payout || payoutOf(b) : 0;
    let cls = 'db-row';
    if (b.bot) cls += ' db-bot';
    else if (uid !== null && b.uid === uid) cls += ' me';
    if (res) cls += won ? ' won' : ' lost';
    const name = String(b.user || '?');
    const av = b.bot ? avatar(name.replace(/^\s*🤖\s*/u, '') || 'Bot', 20) : avatar(name, 20);
    if (b.bot) av.classList.add('db-bot-av');
    return h(
      'div',
      { class: cls, title: won ? `${name} · cobró ${fmtGs(payout)}` : `${name} · ${fmtGs(b.amount)}` },
      av,
      h('span', { class: 'db-row-user' }, name),
      h('span', { class: 'db-row-amt' }, ...money(won ? payout : b.amount)),
    );
  }

  function renderBets() {
    if (!el) return;
    betsDirty = false;
    const uid = myId();
    const groups = { red: [], black: [], white: [] };
    const players = new Set();
    const bots = new Set();
    let total = 0;
    for (const b of st.bets.values()) {
      if (b.status === 'refunded' || !groups[b.color]) continue;
      groups[b.color].push(b);
      (b.bot ? bots : players).add(String(b.uid));
      total += b.amount;
    }
    const res = shown ? shown.color : null;
    for (const c of COLORS) {
      const list = groups[c].sort((a, b) => b.amount - a.amount || String(a.user).localeCompare(String(b.user)));
      const col = el.cols[c];
      const sum = list.reduce((s, b) => s + b.amount, 0);
      setClass(col.el, `db-col ${CLS[c]}${res ? (res === c ? ' win' : ' lose') : ''}`);
      col.total.replaceChildren(...money(sum, true));
      setText(col.count, `${list.length} apuesta${list.length === 1 ? '' : 's'}`);
      const rows = list.slice(0, MAX_ROWS).map((b) => betRow(b, res, uid));
      if (list.length > MAX_ROWS) rows.push(h('div', { class: 'db-more' }, `y ${list.length - MAX_ROWS} más`));
      if (!rows.length) rows.push(h('div', { class: 'db-col-empty' }, st.phase === 'BETTING' && !res ? 'Sin apuestas todavía' : 'Sin apuestas'));
      col.list.replaceChildren(...rows);
    }
    // Los bots se cuentan aparte: nunca se hacen pasar por jugadores
    setText(el.betsPlayers, `👥 ${players.size} jugador${players.size === 1 ? '' : 'es'}${bots.size ? ` · 🤖 ${bots.size} bot${bots.size === 1 ? '' : 's'}` : ''}`);
    setText(el.betsTotal, fmtGs(total));
  }

  function renderButtons() {
    const open = canBet();
    const bets = myBets();
    for (const c of COLORS) {
      const b = el.btns[c];
      const v = bets[c] || 0;
      b.btn.disabled = !open;
      b.mine.hidden = !v;
      if (v) setText(b.mineValue, fmtGs(v));
      b.btn.classList.toggle('has', v > 0);
      b.btn.classList.toggle('pending', pendingColor === c);
    }
    el.colors.classList.toggle('closed', !open);
  }

  function renderNote() {
    let text = '';
    let kind = '';
    const total = myTotal();
    if (pausedView()) text = '⏸ El Double está en pausa por un momento';
    else if (resultNote && resultNote.roundId === st.roundId && shown) ({ text, kind } = resultNote);
    else if (!shell.state.user) text = 'Ingresá para apostar 🎯';
    else if (canBet()) text = total ? '✓ ¡Listo! Tocá de nuevo para sumar' : 'Apostá antes de que gire ⏳';
    else if (spinning() || (st.phase === 'SPINNING' && total)) text = total ? '🍀 ¡Suerte! Tu apuesta está en juego' : 'Apuestas cerradas · esperá la próxima ronda';
    else if (shown || st.phase === 'RESULT') text = 'Apostá en la próxima ronda 🎯';
    else if (st.phase === 'BETTING') text = 'Apuestas cerradas';
    setText(el.note, text);
    setClass(el.note, `gv-note db-note${kind ? ' ' + kind : ''}`);
  }

  function updateBadge() {
    shell.setNavBadge('double', myTotal() > 0 && !shown && (st.phase === 'BETTING' || st.phase === 'SPINNING'));
  }

  /** Estado general (barato): botones, nota, pausa, número de ronda, puntito del menú. */
  function render() {
    updateBadge();
    if (!el) return;
    setText(el.round, st.roundId ? `Ronda #${st.roundId}` : 'Ronda #—');
    el.paused.hidden = !pausedView();
    renderButtons();
    renderNote();
  }

  function renderAll() {
    if (!el) return;
    renderHistory(false);
    renderStats();
    renderBanner(false);
    markWinner();
    setClass(el.glow, shown ? `db-glow ${CLS[shown.color]} on` : 'db-glow');
    renderBets();
    render();
    el.mode = '';
    geo = null;
    placeBand(currentPos(performance.now()), spinning());
    updateStatus(performance.now());
  }

  function statusMode(now) {
    if (pausedView()) return 'pause';
    if (spinning()) return 'spin';
    if (shown) return 'result';
    if (st.phase === 'BETTING') return bettingLeft(now) > 0 ? 'bet' : 'closing';
    return 'wait';
  }

  /** Cuenta regresiva / cartel del resultado (se llama en cada cuadro mientras el juego está a la vista). */
  function updateStatus(now) {
    const mode = statusMode(now);
    if (mode !== el.mode) {
      el.mode = mode;
      setClass(el.status, `db-status m-${mode}`);
      if (mode === 'spin') {
        setText(el.msg, '¡Girando! 🎡');
        setText(el.sub, 'No va más: apuestas cerradas');
      } else if (mode === 'closing') {
        setText(el.msg, '¡No va más!');
        setText(el.sub, 'Cerrando las apuestas…');
        render();
      } else if (mode === 'pause') {
        setText(el.msg, '⏸ Juego en pausa');
        setText(el.sub, 'Volvemos enseguida 🙏');
      } else if (mode === 'wait') {
        setText(el.msg, st.phase === 'CONNECTING' ? 'Conectando…' : 'Esperando la próxima ronda…');
        setText(el.sub, '');
      }
      if (mode !== 'bet') lastTickSecond = -1;
    }
    if (mode === 'bet') {
      const left = bettingLeft(now);
      setText(el.secs, `${(left / 1000).toFixed(1)}s`);
      el.barFill.style.transform = `scaleX(${st.bettingMs ? Math.min(1, left / st.bettingMs).toFixed(4) : 0})`;
      const sec = Math.ceil(left / 1000);
      const hurry = sec <= 3;
      if (hurry !== el.hurry) {
        el.hurry = hurry;
        el.status.classList.toggle('hurry', hurry);
      }
      if (hurry && sec > 0 && sec !== lastTickSecond) {
        lastTickSecond = sec;
        sound.tick();
      }
    } else if (el.hurry) {
      el.hurry = false;
      el.status.classList.remove('hurry');
    }
    if (mode === 'result') {
      const left = Math.ceil((st.nextAt - now) / 1000);
      setText(el.sub, st.paused ? '⏸ El juego se pausa ahora' : left > 0 ? `Nueva ronda en ${left}s` : 'Arranca la nueva ronda…');
    }
  }

  // ───────────────────────── Últimas 100 rondas ─────────────────────────

  async function loadLast100() {
    if (last100 || last100Loading) return;
    last100Loading = true;
    try {
      // Solo rondas jugadas (las anuladas no cuentan)
      const { items } = await api('/api/double/rounds?limit=100&played=1');
      const list = items.filter((r) => r.status === 'ended').map((r) => ({ id: r.id, result: r.result }));
      // Rondas que terminaron mientras cargaba (o que la cinta ya mostró)
      for (const r of st.history.slice().reverse()) if (!list.length || r.id > list[0].id) list.unshift(r);
      last100 = list.slice(0, 100);
    } catch {
      /* se vuelve a intentar la próxima vez que se muestre el juego */
    }
    last100Loading = false;
    renderStats();
  }

  // ───────────────────────── Mis apuestas ─────────────────────────

  function mineRow(p) {
    const won = p.status === 'won';
    const refunded = p.status === 'refunded';
    const cls = CLS[p.color] || '';
    const badge = h('span', { class: `mr-badge db-mr-badge ${cls}${won ? '' : ' off'}` }, p.color === 'white' ? starNode('span', 'db-mr-star') : null, MULT[p.color] || '');
    const result = won
      ? h('span', { class: 'green' }, fmtSigned(p.payout - p.amount))
      : refunded
        ? h('span', { class: 'muted' }, 'Devuelta')
        : h('span', { class: 'red' }, fmtSigned(-p.amount));
    const rc = core.doubleColor(p.result);
    const sub = refunded
      ? [`Ronda #${p.roundId} · apuesta devuelta · ${fmtTime(p.createdAt)}`]
      : [`Ronda #${p.roundId} · salió `, h('span', { class: `dbl-dot ${rc}` }), ` ${rc === 'white' ? 'BLANCO' : p.result} · ${fmtTime(p.createdAt)}`];
    return h(
      'div',
      { class: 'mine-row db-mine-row', style: { cursor: 'pointer' }, title: 'Ver la ronda y verificarla', onclick: () => openDoubleRound(shell, p.roundId) },
      badge,
      h('div', { class: 'mr-main' }, h('div', { class: 'mr-top' }, `Apostaste ${fmtGs(p.amount)} a ${NAME[p.color] || p.color}`), h('div', { class: 'mr-sub' }, ...sub)),
      h('div', { class: 'mr-result' }, result),
    );
  }

  async function loadMine(container) {
    if (!shell.state.user) {
      container.replaceChildren(
        h('div', { class: 'empty' }, 'Ingresá para ver tus apuestas', h('br'), h('br'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => shell.openAuth('login') }, 'Ingresar')),
      );
      return;
    }
    try {
      const { items } = await api('/api/plays?game=double&limit=40');
      if (!items.length) {
        container.replaceChildren(h('div', { class: 'empty' }, 'Todavía no jugaste acá. ¡Probá suerte! 🍀'));
        return;
      }
      container.replaceChildren(...items.map(mineRow));
    } catch (err) {
      container.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }

  // ───────────────────────── Reglas ─────────────────────────

  function rules() {
    const s = S();
    const li = (...c) => h('li', null, ...c);
    const whiteMax = s.max_profit ? Math.min(s.max_bet, Math.floor((s.max_profit * 100) / (PAYS.white - 100))) : 0;
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('Elegí el monto y tocá un color mientras corre la cuenta regresiva: ', h('b', null, 'ROJO'), ' y ', h('b', null, 'NEGRO'), ' pagan 2x, el ', h('b', null, 'BLANCO ⭐'), ' paga 30x.'),
        li('Cada toque suma otra apuesta del mismo monto. Podés apostar a más de un color en la misma ronda.'),
        li('Cuando la cuenta llega a cero, la cinta gira y frena bajo la marca dorada. Si la casilla es de tu color, cobrás apuesta × multiplicador.'),
      ),
      h(
        'ul',
        null,
        li('La cinta tiene 31 casillas: 15 rojas (números impares), 15 negras (pares) y 1 blanca (el 0).'),
        li('Todos juegan la misma ronda: abajo de la cinta ves en vivo lo que apuesta cada uno.'),
        li(`Máximo ${fmtGs(s.max_bet)} por color en cada ronda${whiteMax ? ` (en blanco, hasta ${fmtGs(whiteMax)})` : ''}.`),
        li('Cada resultado sale de una cadena de hashes publicada de antemano: tocá cualquier casilla del historial para verificarla.'),
      ),
    );
  }

  // ───────────────────────── Interfaz para la app ─────────────────────────

  return {
    id: 'double',
    mount,
    show() {
      lastTile = null;
      renderAll();
      loadLast100();
    },
    hide() {
      lastTile = null;
    },
    onInit(d) {
      applySnapshot(d);
      if (el) renderAll();
      else updateBadge();
    },
    onUser(user) {
      if (!user) {
        mine = { roundId: st.roundId, bets: ZERO() };
        busy = false;
        pendingColor = null;
        pendingMine = null;
        resultNote = null;
        unlockBalance();
      }
      betsDirty = true;
      render();
    },
    onSettings() {
      if (!el) return;
      amount.refresh();
      render();
    },
    frame(now) {
      if (!el) return;
      if (spinning()) {
        if (now >= spin.t0 + spin.dur) land();
        else {
          const p = spinPos(now);
          placeBand(p, true);
          const tile = Math.floor(p + 0.5);
          if (lastTile !== null && tile !== lastTile && now - lastWheelTick > 45) {
            lastWheelTick = now;
            sound.wheelTick();
          }
          lastTile = tile;
        }
      } else if (!geo) placeBand(pos, false);
      updateStatus(now);
      if (betsDirty && now - lastBetsRender > 200) {
        lastBetsRender = now;
        renderBets();
      }
    },
    loadMine,
    rules,
  };
}
