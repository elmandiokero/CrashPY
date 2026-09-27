import {
  $,
  $$,
  h,
  api,
  fmtGs,
  fmtNum,
  fmtMult,
  fmtSigned,
  parseAmount,
  parseMult,
  fmtDate,
  fmtTime,
  multClass,
  colorFor,
  multiplierAt,
  msForMultiplier,
  toast,
  openModal,
  copyText,
  sha256Hex,
  crashFromHash,
} from './shared.js';
import { CrashGraph } from './graph.js';
import { Sound } from './sound.js';

// ═══════════════ Estado ═══════════════

const store = {
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

const state = {
  user: null,
  balance: 0,
  settings: { min_bet: 1000, max_bet: 1000000, quick_amounts: '2000,5000,10000,50000', chat_enabled: true },
  fair: null,
  connected: false,
  phase: 'CONNECTING',
  paused: false,
  roundId: null,
  growth: 0.00006,
  startLocal: 0,
  bettingEndsLocal: 0,
  bettingMs: 7000,
  nextLocal: 0,
  crash: null,
  crashElapsed: 0,
  launchUntil: 0,
  bets: new Map(),
  betsDirty: true,
  history: [],
  online: { n: 0, users: 0 },
  unread: 0,
  sideTab: 'bets',
  topPeriod: 'day',
};

const els = {
  balance: $('#balance'),
  balancePill: $('#balancePill'),
  guestActions: $('#guestActions'),
  userActions: $('#userActions'),
  onlineCount: $('#onlineCount'),
  historyList: $('#historyList'),
  stage: $('#stage'),
  stageStatus: $('#stageStatus'),
  stageMult: $('#stageMult'),
  stageSub: $('#stageSub'),
  countdown: $('#countdown'),
  countdownBar: $('#countdownBar'),
  roundLabel: $('#roundLabel'),
  roundPlayers: $('#roundPlayers'),
  roundTotal: $('#roundTotal'),
  stageFlash: $('#stageFlash'),
  winLayer: $('#winLayer'),
  betPanels: $('#betPanels'),
  addPanel: $('#btnAddPanel'),
  betsCount: $('#betsCount'),
  betsPlayers: $('#betsPlayers'),
  betsTotal: $('#betsTotal'),
  betsList: $('#betsList'),
  mineList: $('#mineList'),
  topList: $('#topList'),
  chat: $('#chat'),
  chatList: $('#chatList'),
  chatForm: $('#chatForm'),
  chatInput: $('#chatInput'),
  chatNew: $('#chatNew'),
  chatFab: $('#chatFab'),
  chatBadge: $('#chatBadge'),
  chatOnline: $('#chatOnline'),
  emojiPicker: $('#emojiPicker'),
  drawer: $('#drawer'),
  drawerBackdrop: $('#drawerBackdrop'),
  connBanner: $('#connBanner'),
  siteBanner: $('#siteBanner'),
  soundBtn: $('#btnSound'),
};

const sound = new Sound();
const graph = new CrashGraph($('#graph'));
const socket = io();

const vibrate = (pattern) => {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* sin soporte */
  }
};

function setText(el, text) {
  if (el._t !== text) {
    el._t = text;
    el.textContent = text;
  }
}

function setClass(el, cls) {
  if (el._c !== cls) {
    el._c = cls;
    el.className = cls;
  }
}

function avatar(name, size) {
  const style = { background: colorFor(name) };
  if (size) Object.assign(style, { width: size + 'px', height: size + 'px', fontSize: size * 0.4 + 'px' });
  return h('span', { class: 'avatar', style }, String(name || '?').slice(0, 1));
}

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace('.', ',') + 'K';
  return String(n);
}

function stepFor(v) {
  if (v < 10000) return 1000;
  if (v < 50000) return 5000;
  if (v < 200000) return 10000;
  if (v < 1000000) return 50000;
  return 100000;
}

// ═══════════════ Paneles de apuesta ═══════════════

class BetPanel {
  constructor(slot) {
    this.slot = slot;
    const node = $('#tplBetPanel').content.firstElementChild.cloneNode(true);
    node.dataset.slot = String(slot);
    this.el = node;
    this.input = $('.amount-input', node);
    this.btn = $('.bp-action', node);
    this.title = $('.bp-action-title', node);
    this.sub = $('.bp-action-sub', node);
    this.quick = $('.quick-row', node);
    this.autoBetEl = $('.auto-bet', node);
    this.autoCashOnEl = $('.auto-cash-on', node);
    this.autoCashInput = $('.auto-cash-input', node);
    this.autoCashField = $('.auto-cash-field', node);
    this.noteEl = $('.bp-note', node);

    const saved = store.get(`cpy_panel${slot}`, {});
    this.amount = saved.amount || (slot === 0 ? 5000 : 10000);
    this.autoCashOn = !!saved.autoCashOn;
    this.autoCash = saved.autoCash || 200;
    this.autoBet = false;
    this.status = 'idle';
    this.bet = null;
    this.celebrated = null;
    this.noteTimer = null;

    this.input.value = fmtNum(this.amount);
    this.autoCashOnEl.checked = this.autoCashOn;
    this.autoCashInput.value = (this.autoCash / 100).toFixed(2);
    this.autoCashField.classList.toggle('off', !this.autoCashOn);

    this.input.addEventListener('input', () => {
      const v = parseAmount(this.input.value);
      this.input.value = Number.isFinite(v) ? fmtNum(v) : '';
      if (Number.isFinite(v)) this.amount = v;
      this.render();
    });
    this.input.addEventListener('blur', () => this.setAmount(this.amount));
    $('[data-act="minus"]', node).addEventListener('click', () => this.setAmount(this.amount - stepFor(this.amount - 1)));
    $('[data-act="plus"]', node).addEventListener('click', () => this.setAmount(this.amount + stepFor(this.amount)));
    this.btn.addEventListener('click', () => this.onAction());
    this.autoCashOnEl.addEventListener('change', () => {
      this.autoCashOn = this.autoCashOnEl.checked;
      this.autoCashField.classList.toggle('off', !this.autoCashOn);
      this.save();
    });
    this.autoCashInput.addEventListener('blur', () => {
      let v = parseMult(this.autoCashInput.value);
      if (!Number.isFinite(v) || v < 101) v = 101;
      v = Math.min(v, 100000000);
      this.autoCash = v;
      this.autoCashInput.value = (v / 100).toFixed(2);
      this.save();
    });
    this.autoCashInput.addEventListener('focus', () => {
      if (!this.autoCashOn) {
        this.autoCashOn = true;
        this.autoCashOnEl.checked = true;
        this.autoCashField.classList.remove('off');
      }
    });
    this.autoBetEl.addEventListener('change', () => {
      if (!state.user) {
        this.autoBetEl.checked = false;
        openAuth('login');
        return;
      }
      this.autoBet = this.autoBetEl.checked;
      if (this.autoBet) {
        toast(`Auto apuesta activada: ${fmtGs(this.amount)} en cada ronda`, 'info');
        if (this.status === 'idle') this.onAction();
      }
    });
    node.querySelector('.bp-remove').addEventListener('click', () => setSecondPanel(false));
    this.buildQuick();
    this.render();
  }

  buildQuick() {
    const list = String(state.settings.quick_amounts || '')
      .split(',')
      .map((v) => parseInt(v, 10))
      .filter((v) => v > 0)
      .slice(0, 4);
    this.quick.replaceChildren(
      ...list.map((v) =>
        h('button', { type: 'button', onclick: () => this.setAmount(v), title: fmtGs(v) }, compact(v)),
      ),
    );
    this.quick.style.gridTemplateColumns = `repeat(${Math.max(1, list.length)}, minmax(0, 1fr))`;
  }

  setAmount(v) {
    const { min_bet: min, max_bet: max } = state.settings;
    if (!Number.isFinite(v)) v = min;
    v = Math.max(min, Math.min(max, Math.round(v)));
    this.amount = v;
    this.input.value = fmtNum(v);
    this.save();
    this.render();
  }

  save() {
    store.set(`cpy_panel${this.slot}`, { amount: this.amount, autoCashOn: this.autoCashOn, autoCash: this.autoCash });
  }

  note(text, ms = 0) {
    clearTimeout(this.noteTimer);
    this.noteEl.textContent = text || '';
    if (ms) this.noteTimer = setTimeout(() => (this.noteEl.textContent = ''), ms);
  }

  onAction() {
    if (!state.user) {
      openAuth('login');
      return;
    }
    sound._ensure();
    switch (this.status) {
      case 'idle':
        if (state.phase === 'BETTING') this.place();
        else {
          this.status = 'queued';
          this.render();
        }
        break;
      case 'queued':
        this.status = 'idle';
        if (this.autoBet) {
          this.autoBet = false;
          this.autoBetEl.checked = false;
        }
        this.render();
        break;
      case 'placed':
        this.cancel();
        break;
      case 'active':
        this.cashout();
        break;
      default:
        break;
    }
  }

  place() {
    const { min_bet: min, max_bet: max } = state.settings;
    const amount = this.amount;
    const fail = (msg) => {
      toast(msg, 'error');
      if (this.autoBet) {
        this.autoBet = false;
        this.autoBetEl.checked = false;
      }
      this.status = 'idle';
      this.render();
    };
    if (amount < min) return fail(`La apuesta mínima es ${fmtGs(min)}`);
    if (amount > max) return fail(`La apuesta máxima es ${fmtGs(max)}`);
    if (amount > state.balance) {
      fail('No te alcanza el saldo 😕 Cargá saldo para seguir jugando');
      return;
    }
    if (!socket.connected) return fail('Sin conexión, esperá un momento');
    this.status = 'sending';
    this.render();
    const payload = { slot: this.slot, amount, auto: this.autoCashOn ? (this.autoCash / 100).toFixed(2) : null };
    socket.timeout(8000).emit('bet', payload, (err, res) => {
      if (err) {
        if (this.status === 'sending') {
          this.status = 'idle';
          toast('El servidor no respondió, probá de nuevo', 'error');
          this.render();
        }
        return;
      }
      if (res.ok) {
        this.bet = res.bet;
        if (this.status === 'sending' || this.status === 'idle') this.status = state.phase === 'RUNNING' ? 'active' : 'placed';
        setBalance(res.balance);
        sound.bet();
        vibrate(20);
        this.note('');
      } else if (res.code === 'NOT_BETTING') {
        this.status = 'queued';
        toast('Llegaste justo tarde: tu apuesta va para la próxima ronda', 'info');
      } else if (res.code === 'DUPLICATE') {
        this.status = state.phase === 'RUNNING' ? 'active' : 'placed';
      } else {
        fail(res.error || 'No se pudo apostar');
        return;
      }
      this.render();
    });
  }

  cancel() {
    if (!socket.connected) return toast('Sin conexión', 'error');
    this.status = 'sending';
    this.render();
    socket.timeout(8000).emit('cancelBet', { slot: this.slot }, (err, res) => {
      if (err || !res.ok) {
        if (res && res.code === 'NOT_BETTING') {
          this.status = 'active';
          toast('La ronda ya despegó, no se puede cancelar', 'info');
        } else {
          this.status = this.bet ? 'placed' : 'idle';
          toast((res && res.error) || 'No se pudo cancelar', 'error');
        }
      } else {
        this.bet = null;
        this.status = 'idle';
        setBalance(res.balance);
        sound.cancel();
      }
      if (this.autoBet) {
        this.autoBet = false;
        this.autoBetEl.checked = false;
      }
      this.render();
    });
  }

  cashout() {
    if (!socket.connected) return toast('Sin conexión', 'error');
    this.status = 'cashing';
    this.render();
    socket.timeout(8000).emit('cashout', { slot: this.slot }, (err, res) => {
      if (err) {
        if (this.status === 'cashing') this.status = state.phase === 'RUNNING' ? 'active' : 'idle';
        toast('El servidor no respondió', 'error');
        this.render();
        return;
      }
      if (res.ok) {
        setBalance(res.balance);
        this.onServerBet(res.bet);
      } else {
        if (this.status === 'cashing') this.status = state.phase === 'RUNNING' && this.bet && this.bet.status === 'active' ? 'active' : 'idle';
        toast(res.error || 'No se pudo retirar', 'error');
        this.render();
      }
    });
  }

  /** Sincroniza con el estado real de la apuesta que manda el servidor. */
  onServerBet(b) {
    if (!b) return;
    if (b.roundId && state.roundId && b.roundId !== state.roundId) return;
    switch (b.status) {
      case 'active':
        this.bet = b;
        if (this.status !== 'cashing') this.status = state.phase === 'RUNNING' ? 'active' : 'placed';
        break;
      case 'won':
        this.bet = b;
        this.celebrate(b);
        break;
      case 'lost':
        this.bet = null;
        if (this.status !== 'queued') this.status = 'idle';
        break;
      case 'refunded':
        this.bet = null;
        if (this.status !== 'queued') this.status = 'idle';
        this.note('↩ Apuesta devuelta a tu saldo', 5000);
        break;
      case 'cancelled':
        this.bet = null;
        if (this.status !== 'queued') this.status = 'idle';
        break;
      default:
        break;
    }
    this.render();
  }

  celebrate(b) {
    if (this.celebrated === b.id) return;
    this.celebrated = b.id;
    this.status = 'won';
    const big = b.cashout >= 1000 || b.payout - b.amount >= 500000;
    showWinPop(b.payout, b.cashout, big);
    sound.cashout(big);
    vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
    if (big) graph.confetti();
    this.note(`✅ Retiraste a ${fmtMult(b.cashout)} · ganaste ${fmtGs(b.payout - b.amount)}`, 6000);
    this.render();
    setTimeout(() => {
      if (this.status === 'won') {
        this.status = 'idle';
        this.render();
      }
    }, 1800);
  }

  onBetting() {
    if (['won', 'active', 'cashing', 'placed'].includes(this.status)) {
      this.status = 'idle';
      this.bet = null;
    }
    if (this.status === 'queued' || (this.autoBet && this.status === 'idle')) this.place();
    this.render();
  }

  onStart() {
    if (this.status === 'placed') this.status = 'active';
    this.render();
  }

  onCrash(d) {
    if ((this.status === 'active' || this.status === 'cashing') && this.bet) {
      if (!d.cancelled) {
        this.note(`💥 Perdiste ${fmtGs(this.bet.amount)}`, 5000);
        els.stage.classList.remove('lost-flash');
        void els.stage.offsetWidth;
        els.stage.classList.add('lost-flash');
        sound.lose();
        vibrate(120);
      }
      this.status = 'idle';
      this.bet = null;
    }
    this.render();
  }

  reset() {
    this.status = 'idle';
    this.bet = null;
    this.autoBet = false;
    this.autoBetEl.checked = false;
    this.render();
  }

  render() {
    const s = this.status;
    const locked = s !== 'idle';
    setClass(this.el, `bet-panel st-${s}${locked ? ' locked' : ''}`);
    this.el.hidden = this.hidden;
    let cls = 'bp-action';
    let title = 'APOSTAR';
    let sub = fmtGs(this.amount);
    switch (s) {
      case 'idle':
        if (!state.user) sub = 'Ingresá para jugar';
        break;
      case 'queued':
        cls += ' red';
        title = 'CANCELAR';
        sub = 'Esperando próxima ronda';
        break;
      case 'sending':
        title = 'ENVIANDO…';
        break;
      case 'placed':
        cls += ' red';
        title = 'CANCELAR';
        sub = fmtGs(this.bet ? this.bet.amount : this.amount);
        break;
      case 'active':
      case 'cashing':
        cls += ' orange';
        title = s === 'cashing' ? 'RETIRANDO…' : 'RETIRAR';
        sub = this.sub._t || fmtGs(this.bet ? this.bet.amount : this.amount);
        break;
      case 'won':
        cls += ' gold';
        title = '¡GANASTE!';
        sub = fmtGs(this.bet ? this.bet.payout : 0);
        break;
      default:
        break;
    }
    setClass(this.btn, cls);
    setText(this.title, title);
    setText(this.sub, sub);
    this.btn.disabled = s === 'sending' || s === 'cashing' || s === 'won';
    if (s === 'placed' && !this.noteEl.textContent) this.noteEl.textContent = '✓ Apuesta lista, esperando el despegue';
    if (s !== 'placed' && this.noteEl.textContent === '✓ Apuesta lista, esperando el despegue') this.noteEl.textContent = '';
  }

  /** Actualiza en cada cuadro el monto que se cobraría al retirar. */
  frame(view) {
    if (this.status === 'active' && view.phase === 'RUNNING' && this.bet) {
      let m = multiplierAt(view.elapsed, state.growth);
      if (this.bet.auto && m >= this.bet.auto) m = this.bet.auto;
      setText(this.sub, fmtGs(Math.floor((this.bet.amount * m) / 100)));
    }
  }
}

const panels = [new BetPanel(0), new BetPanel(1)];
panels.forEach((p) => els.betPanels.append(p.el));

function setSecondPanel(show) {
  const p = panels[1];
  if (!show && p.status !== 'idle' && p.status !== 'queued') {
    toast('Tenés una apuesta en curso en ese panel', 'info');
    return;
  }
  if (!show && p.status === 'queued') p.status = 'idle';
  p.hidden = !show;
  if (!show) p.reset();
  p.render();
  els.betPanels.classList.toggle('two', show);
  els.addPanel.hidden = show;
  store.set('cpy_two', show);
}
setSecondPanel(store.get('cpy_two', window.innerWidth >= 1100));
els.addPanel.addEventListener('click', () => setSecondPanel(true));

// ═══════════════ Saldo ═══════════════

let balanceAnim = 0;
function setBalance(value, animate = true) {
  if (!Number.isFinite(value)) return;
  const prev = state.balance;
  state.balance = value;
  cancelAnimationFrame(balanceAnim);
  if (!animate || prev === value) {
    els.balance.textContent = fmtGs(value);
    return;
  }
  els.balancePill.classList.remove('up', 'down');
  void els.balancePill.offsetWidth;
  els.balancePill.classList.add(value > prev ? 'up' : 'down');
  setTimeout(() => els.balancePill.classList.remove('up', 'down'), 900);
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 550);
    const e = 1 - Math.pow(1 - k, 3);
    els.balance.textContent = fmtGs(prev + (value - prev) * e);
    if (k < 1) balanceAnim = requestAnimationFrame(step);
  };
  balanceAnim = requestAnimationFrame(step);
}

function showWinPop(payout, cashout, big) {
  const node = h(
    'div',
    { class: `win-pop${big ? ' big' : ''}` },
    h('span', { class: 'wp-amount' }, `+${fmtGs(payout)}`),
    h('span', { class: 'wp-label' }, `¡Retiraste a ${fmtMult(cashout)}! 🔥`),
  );
  els.winLayer.append(node);
  setTimeout(() => node.remove(), 2500);
}

// ═══════════════ Interfaz de usuario / sesión ═══════════════

function updateAuthUI() {
  const u = state.user;
  els.guestActions.hidden = !!u;
  els.userActions.hidden = !u;
  if (u) setBalance(u.balance, false);
  const chatDisabled = !u || u.muted || (!state.settings.chat_enabled && u.role !== 'admin');
  els.chatInput.disabled = chatDisabled;
  els.chatInput.placeholder = !u
    ? 'Ingresá para chatear'
    : u.muted
      ? 'Estás silenciado 🔇'
      : !state.settings.chat_enabled && u.role !== 'admin'
        ? 'El chat está desactivado'
        : 'Escribí un mensaje…';
  panels.forEach((p) => p.render());
  renderDrawer();
}

function applySettings() {
  const s = state.settings;
  const banner = (s.banner || '').trim();
  els.siteBanner.hidden = !banner;
  els.siteBanner.textContent = banner;
  panels.forEach((p) => {
    p.buildQuick();
    if (p.amount < s.min_bet || p.amount > s.max_bet) p.setAmount(p.amount);
  });
  updateAuthUI();
}

function reconnect() {
  socket.disconnect();
  socket.connect();
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* igual cerramos */
  }
  state.user = null;
  panels.forEach((p) => p.reset());
  updateAuthUI();
  closeDrawer();
  reconnect();
  toast('Cerraste sesión. ¡Aguyje! 👋', 'info');
}

function onLoggedIn(user, isNew) {
  state.user = user;
  updateAuthUI();
  reconnect();
  toast(isNew ? `¡Bienvenido/a a CrashPY, ${user.username}! 🚀` : `¡Mba'éichapa, ${user.username}! 👋`, 'success');
  if (isNew && user.balance <= 0) setTimeout(() => openWallet('deposit'), 700);
}

// ═══════════════ Socket: eventos del juego ═══════════════

socket.on('connect', () => {
  state.connected = true;
  els.connBanner.hidden = true;
});

socket.on('disconnect', () => {
  state.connected = false;
  setTimeout(() => {
    if (!state.connected) els.connBanner.hidden = false;
  }, 1200);
  sound.engineStop();
});

socket.on('init', (d) => {
  state.settings = { ...state.settings, ...d.settings };
  state.fair = d.fair;
  state.user = d.user;
  state.online = d.online;
  applySettings();
  applyGame(d.game);
  d.mine.forEach((b, slot) => {
    const p = panels[slot];
    if (b) p.onServerBet(b);
    else if (['placed', 'active', 'cashing', 'sending', 'won'].includes(p.status)) {
      p.status = 'idle';
      p.bet = null;
      p.render();
    }
  });
  if (!d.user) panels.forEach((p) => p.reset());
  renderChat(d.chat);
  renderOnline();
  if (state.sideTab === 'mine') loadMine();
});

function applyGame(g) {
  const now = performance.now();
  state.phase = g.phase;
  state.paused = g.paused;
  state.roundId = g.roundId;
  state.growth = g.growth;
  state.bettingMs = g.bettingMs || state.bettingMs;
  state.history = g.history || [];
  state.bets = new Map((g.bets || []).map((b) => [b.id, b]));
  state.betsDirty = true;
  if (g.phase === 'BETTING') state.bettingEndsLocal = now + (g.bettingLeft || 0);
  if (g.phase === 'RUNNING') state.startLocal = now - (g.elapsed || 0);
  if (g.phase === 'CRASHED' && g.last) {
    state.crash = g.last;
    state.crashElapsed = msForMultiplier(Math.max(100, g.last.crash || 100), g.growth);
    state.nextLocal = now + (g.last.nextIn || 0);
  }
  if (g.phase !== 'RUNNING') graph.clearRound();
  renderHistory();
  els.roundLabel.textContent = `Ronda #${g.roundId || '—'}`;
}

socket.on('betting', (d) => {
  state.phase = 'BETTING';
  state.paused = false;
  state.roundId = d.roundId;
  state.growth = d.growth;
  state.bettingMs = d.ms;
  state.bettingEndsLocal = performance.now() + d.ms;
  state.crash = null;
  state.bets.clear();
  state.betsDirty = true;
  graph.clearRound();
  els.roundLabel.textContent = `Ronda #${d.roundId}`;
  panels.forEach((p) => p.onBetting());
});

socket.on('start', (d) => {
  state.phase = 'RUNNING';
  state.roundId = d.roundId;
  state.growth = d.growth;
  state.startLocal = performance.now();
  state.launchUntil = performance.now() + 1000;
  panels.forEach((p) => p.onStart());
  if (!document.hidden) sound.launch();
});

socket.on('tick', (d) => {
  if (state.phase !== 'RUNNING') return;
  const candidate = performance.now() - d.e;
  // Nos quedamos con la estimación más temprana (la de menor latencia)
  if (candidate < state.startLocal) state.startLocal = candidate;
});

socket.on('crash', (d) => {
  state.phase = 'CRASHED';
  state.crash = d;
  state.crashElapsed = msForMultiplier(Math.max(100, d.crash || 100), state.growth);
  state.nextLocal = performance.now() + (d.nextIn || 4000);
  for (const b of state.bets.values()) if (b.status === 'active') b.status = d.cancelled ? 'refunded' : 'lost';
  state.betsDirty = true;
  state.history.unshift({ id: d.roundId, crash: d.crash, cancelled: !!d.cancelled });
  if (state.history.length > 50) state.history.length = 50;
  renderHistory(true);
  graph.explode();
  els.stageFlash.classList.remove('go');
  void els.stageFlash.offsetWidth;
  els.stageFlash.classList.add('go');
  if (!document.hidden) sound.crash();
  else sound.engineStop();
  panels.forEach((p) => p.onCrash(d));
  if (state.sideTab === 'mine') setTimeout(loadMine, 600);
});

socket.on('paused', (d) => {
  state.paused = d.paused;
  if (d.paused && d.phase === 'PAUSED') {
    state.phase = 'PAUSED';
    graph.clearRound();
  }
  if (d.paused && d.phase !== 'PAUSED') toast('⏸ El juego se va a pausar al terminar esta ronda', 'info');
});

socket.on('bet', (b) => {
  state.bets.set(b.id, b);
  state.betsDirty = true;
});

socket.on('cashout', (d) => {
  const b = state.bets.get(d.id);
  if (b) Object.assign(b, { status: 'won', cashout: d.cashout, payout: d.payout });
  state.betsDirty = true;
  const own = !!(state.user && d.uid === state.user.id);
  const label = own ? `+${fmtGs(d.payout - d.amount)}` : `${d.user} ${fmtMult(d.cashout)}`;
  graph.addMarker(msForMultiplier(d.cashout, state.growth), d.cashout, label, own);
});

socket.on('betCancel', (d) => {
  state.bets.delete(d.id);
  state.betsDirty = true;
});

socket.on('betRefund', (d) => {
  const b = state.bets.get(d.id);
  if (b) b.status = 'refunded';
  state.betsDirty = true;
});

socket.on('myBet', (b) => {
  const p = panels[b.slot];
  if (p) p.onServerBet(b);
});

socket.on('balance', (d) => setBalance(d.balance));

socket.on('me', (u) => {
  if (!state.user || u.id !== state.user.id) return;
  state.user = { ...state.user, ...u };
  updateAuthUI();
});

socket.on('notify', (n) => {
  toast(n.text, n.kind === 'success' ? 'success' : n.kind === 'error' ? 'error' : 'info', n.title);
  if (n.kind === 'success') sound.coin();
  if (walletModal && walletModal.refresh) walletModal.refresh();
});

socket.on('settings', (s) => {
  state.settings = { ...state.settings, ...s };
  applySettings();
});

socket.on('online', (o) => {
  state.online = o;
  renderOnline();
});

function renderOnline() {
  els.onlineCount.textContent = fmtNum(state.online.n);
  els.chatOnline.textContent = `· ${fmtNum(state.online.n)} en línea`;
}

// ═══════════════ Bucle de animación ═══════════════

let lastTickSecond = -1;

function computeView(now) {
  const v = { phase: state.phase, growth: state.growth };
  if (state.phase === 'RUNNING') v.elapsed = Math.max(0, now - state.startLocal);
  if (state.phase === 'CRASHED' && state.crash) {
    v.crashElapsed = state.crashElapsed;
    v.crashM = state.crash.crash;
    v.cancelled = !!state.crash.cancelled;
  }
  if (state.phase === 'BETTING') {
    v.left = Math.max(0, state.bettingEndsLocal - now);
    v.bettingFrac = state.bettingMs ? v.left / state.bettingMs : 0;
  }
  return v;
}

function tierClass(m) {
  if (m < 200) return 't1';
  if (m < 500) return 't2';
  if (m < 1000) return 't3';
  return 't4';
}

let engineUpdateAt = 0;

function updateOverlay(v, now) {
  const st = els.stageStatus;
  const mult = els.stageMult;
  const sub = els.stageSub;
  let showCountdown = false;
  switch (v.phase) {
    case 'RUNNING': {
      const m = multiplierAt(v.elapsed, state.growth);
      setText(mult, fmtMult(m));
      setClass(mult, `stage-mult ${tierClass(m)}`);
      if (now < state.launchUntil) {
        setText(st, '¡JAHA! 🚀');
        setClass(st, 'stage-status launch');
      } else {
        setText(st, '');
        setClass(st, 'stage-status');
      }
      setText(sub, state.paused ? '⏸ Pausa al terminar esta ronda' : '');
      if (now > engineUpdateAt) {
        engineUpdateAt = now + 120;
        sound.engineUpdate(m / 100);
      }
      break;
    }
    case 'BETTING': {
      const secs = v.left / 1000;
      setText(st, 'PRÓXIMA RONDA EN');
      setClass(st, 'stage-status');
      setText(mult, `${secs.toFixed(1)}s`);
      setClass(mult, 'stage-mult waiting');
      setText(sub, state.user ? '¡Hacé tu apuesta! 🎯' : 'Ingresá para apostar 🎯');
      showCountdown = true;
      els.countdownBar.style.transform = `scaleX(${Math.max(0, Math.min(1, v.bettingFrac))})`;
      const sec = Math.ceil(secs);
      if (sec <= 3 && sec > 0 && sec !== lastTickSecond) {
        lastTickSecond = sec;
        sound.tick();
      }
      break;
    }
    case 'CRASHED': {
      const c = state.crash || {};
      setText(st, c.cancelled ? 'RONDA ANULADA' : '¡EXPLOTÓ!');
      setClass(st, 'stage-status crashed');
      setText(mult, fmtMult(c.crash));
      setClass(mult, `stage-mult ${c.cancelled ? 'cancelled' : 'crashed'}`);
      let text;
      if (c.cancelled) {
        text =
          c.mode === 'pay'
            ? `El admin detuvo la ronda: se pagó a todos a ${fmtMult(c.crash)}`
            : 'La ronda se anuló: se devolvieron las apuestas';
      } else {
        const left = Math.max(0, Math.ceil((state.nextLocal - now) / 1000));
        text = state.paused ? '⏸ El juego se pausa ahora' : `Próxima ronda en ${left}s`;
      }
      setText(sub, text);
      break;
    }
    case 'PAUSED':
      setText(st, 'JUEGO EN PAUSA');
      setClass(st, 'stage-status');
      setText(mult, '⏸');
      setClass(mult, 'stage-mult waiting');
      setText(sub, 'Volvemos enseguida 🙏');
      break;
    default:
      setText(st, '');
      setText(mult, '···');
      setClass(mult, 'stage-mult waiting');
      setText(sub, 'Conectando…');
  }
  if (els.countdown.hidden === showCountdown) els.countdown.hidden = !showCountdown;
  if (v.phase !== 'BETTING') lastTickSecond = -1;
}

let lastBetsRender = 0;

function loop(now) {
  const view = computeView(now);
  graph.frame(view);
  updateOverlay(view, now);
  for (const p of panels) p.frame(view);
  if (state.betsDirty && now - lastBetsRender > 180) {
    lastBetsRender = now;
    renderBets();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.engineStop();
});

// Barra espaciadora = retirar (panel 1) cuando hay apuesta en vuelo
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(tag) || document.body.classList.contains('modal-open')) return;
  const p = panels.find((x) => x.status === 'active');
  if (p) {
    e.preventDefault();
    p.cashout();
  }
});

// ═══════════════ Historial y lista de apuestas ═══════════════

function renderHistory(animateFirst = false) {
  const items = state.history.slice(0, 30).map((r, i) =>
    h(
      'button',
      {
        type: 'button',
        class: `hist-pill ${r.cancelled ? 'cancelled' : multClass(r.crash)}${animateFirst && i === 0 ? ' new' : ''}`,
        title: `Ronda #${r.id}${r.cancelled ? ' (anulada)' : ''}`,
        onclick: () => openRound(r.id),
      },
      fmtMult(r.crash),
    ),
  );
  els.historyList.replaceChildren(...items);
  els.historyList.scrollLeft = 0;
}

function renderBets() {
  state.betsDirty = false;
  const list = [...state.bets.values()].filter((b) => b.status !== 'cancelled');
  list.sort((a, b) => b.amount - a.amount || a.id - b.id);
  const total = list.reduce((sum, b) => sum + (b.status === 'refunded' ? 0 : b.amount), 0);
  const players = new Set(list.map((b) => b.uid)).size;
  els.betsCount.textContent = String(list.length);
  els.betsPlayers.textContent = `${players} jugador${players === 1 ? '' : 'es'}`;
  els.betsTotal.textContent = fmtGs(total);
  els.roundPlayers.textContent = `👥 ${players}`;
  els.roundTotal.textContent = fmtGs(total);
  const me = state.user ? state.user.id : null;
  const rows = list.slice(0, 150).map((b) => {
    const lost = b.status === 'lost' || (state.phase === 'CRASHED' && b.status === 'active');
    const cls = b.status === 'won' ? 'won' : lost ? 'lost' : b.status === 'refunded' ? 'refunded' : '';
    return h(
      'div',
      { class: `bet-row ${cls}${b.uid === me ? ' me' : ''}` },
      h('div', { class: 'bet-user' }, avatar(b.user), h('span', null, b.user)),
      h('div', { class: 'bet-amount' }, fmtNum(b.amount)),
      h('div', { class: `bet-mult ${b.cashout ? multClass(b.cashout) : 'muted'}` }, b.cashout ? fmtMult(b.cashout) : b.status === 'refunded' ? '↩' : '—'),
      h('div', { class: 'bet-win' }, b.payout ? fmtNum(b.payout) : lost ? '💥' : '—'),
    );
  });
  if (!rows.length) rows.push(h('div', { class: 'empty' }, state.phase === 'BETTING' ? '¡Sé el primero en apostar! 🚀' : 'Sin apuestas en esta ronda'));
  els.betsList.replaceChildren(...rows);
}

// ═══════════════ Pestañas laterales ═══════════════

$('#sideTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showSideTab(btn.dataset.tab);
});

function showSideTab(tab) {
  state.sideTab = tab;
  $$('#sideTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.side-body .tab-pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
  if (tab === 'mine') loadMine();
  if (tab === 'top') loadTop();
}

async function loadMine() {
  if (!state.user) {
    els.mineList.replaceChildren(
      h('div', { class: 'empty' }, 'Ingresá para ver tus apuestas', h('br'), h('br'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openAuth('login') }, 'Ingresar')),
    );
    return;
  }
  try {
    const { items } = await api('/api/me/bets');
    if (!items.length) {
      els.mineList.replaceChildren(h('div', { class: 'empty' }, 'Todavía no apostaste. ¡Probá suerte! 🍀'));
      return;
    }
    els.mineList.replaceChildren(
      ...items.map((b) => {
        let result;
        let badge;
        if (b.status === 'won') {
          result = h('span', { class: 'green' }, fmtSigned(b.payout - b.amount));
          badge = h('span', { class: `mr-badge ${multClass(b.cashout)}` }, fmtMult(b.cashout));
        } else if (b.status === 'lost') {
          result = h('span', { class: 'red' }, fmtSigned(-b.amount));
          badge = h('span', { class: 'mr-badge red' }, '💥');
        } else if (b.status === 'refunded') {
          result = h('span', { class: 'muted' }, 'Devuelta');
          badge = h('span', { class: 'mr-badge' }, '↩');
        } else {
          result = h('span', { class: 'gold' }, 'En juego');
          badge = h('span', { class: 'mr-badge' }, '🚀');
        }
        return h(
          'div',
          { class: 'mine-row', onclick: () => b.crash != null && openRound(b.round_id), style: { cursor: 'pointer' } },
          badge,
          h(
            'div',
            { class: 'mr-main' },
            h('div', { class: 'mr-top' }, `Apostaste ${fmtGs(b.amount)}`),
            h('div', { class: 'mr-sub' }, `Ronda #${b.round_id} · ${fmtTime(b.created_at)}${b.crash != null ? ` · explotó en ${fmtMult(b.crash)}` : ''}`),
          ),
          h('div', { class: 'mr-result' }, result),
        );
      }),
    );
  } catch (err) {
    els.mineList.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

$('#topPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-period]');
  if (!btn) return;
  state.topPeriod = btn.dataset.period;
  $$('#topPeriod button').forEach((b) => b.classList.toggle('active', b === btn));
  loadTop();
});

async function loadTop() {
  els.topList.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  try {
    const data = await api('/api/top?period=' + state.topPeriod);
    const section = (title, rows) =>
      h('div', { class: 'top-section' }, h('h4', null, title), rows.length ? rows : h('div', { class: 'empty' }, 'Todavía nada por acá'));
    const winRow = (w, i, mode) =>
      h(
        'div',
        { class: 'top-row', onclick: () => openRound(w.round_id), style: { cursor: 'pointer' } },
        h('span', { class: 'top-rank' }, i + 1),
        h('div', { class: 'top-main' }, h('b', null, w.user), h('small', null, `Apostó ${fmtGs(w.amount)} · ronda #${w.round_id}`)),
        h(
          'div',
          { class: 'top-value' },
          mode === 'mult' ? h('span', { class: multClass(w.cashout) }, fmtMult(w.cashout)) : h('span', { class: 'green' }, fmtGs(w.payout)),
          h('small', null, mode === 'mult' ? fmtGs(w.payout) : `a ${fmtMult(w.cashout)}`),
        ),
      );
    els.topList.replaceChildren(
      section('🤑 Mayores ganancias', data.wins.map((w, i) => winRow(w, i, 'win'))),
      section('🚀 Mejores retiros', data.multipliers.map((w, i) => winRow(w, i, 'mult'))),
      section(
        '💥 Rondas más altas',
        data.rounds.map((r, i) =>
          h(
            'div',
            { class: 'top-row', onclick: () => openRound(r.id), style: { cursor: 'pointer' } },
            h('span', { class: 'top-rank' }, i + 1),
            h('div', { class: 'top-main' }, h('b', null, `Ronda #${r.id}`)),
            h('div', { class: 'top-value' }, h('span', { class: multClass(r.crash_point) }, fmtMult(r.crash_point))),
          ),
        ),
      ),
    );
  } catch (err) {
    els.topList.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ═══════════════ Chat ═══════════════

const EMOJIS = ['😀', '😂', '🤣', '😎', '😍', '🤑', '😱', '😭', '😡', '🥳', '🙏', '👏', '👍', '💪', '🔥', '🚀', '💥', '💸', '💰', '🍀', '🎯', '🤞', '🇵🇾', '🧉', '⚽', '❤️', '💙', '👀', '🤡', '😴', '🥶', '🫡'];

els.emojiPicker.replaceChildren(
  ...EMOJIS.map((e) =>
    h('button', {
      type: 'button',
      onclick: () => {
        els.chatInput.value += e;
        els.chatInput.focus();
      },
    }, e),
  ),
);

$('#emojiBtn').addEventListener('click', () => {
  if (els.chatInput.disabled) return;
  els.emojiPicker.hidden = !els.emojiPicker.hidden;
});

document.addEventListener('click', (e) => {
  if (!els.emojiPicker.hidden && !e.target.closest('#emojiPicker') && !e.target.closest('#emojiBtn')) els.emojiPicker.hidden = true;
});

function chatMessageNode(m) {
  if (m.kind === 'user') {
    const mine = !!(state.user && m.uid === state.user.id);
    const isAdmin = m.role === 'admin';
    return h(
      'div',
      { class: `msg${mine ? ' me' : ''}${isAdmin ? ' admin' : ''}`, 'data-id': m.id },
      avatar(m.user),
      h(
        'div',
        { class: 'msg-body' },
        h(
          'div',
          { class: 'msg-meta' },
          h('span', { class: 'msg-user', style: { color: isAdmin ? 'var(--gold)' : colorFor(m.user) } }, m.user),
          isAdmin ? h('span', { class: 'admin-badge' }, 'ADMIN') : null,
          h('span', { class: 'msg-time' }, fmtTime(m.ts)),
        ),
        h('div', { class: 'msg-text' }, m.text),
      ),
    );
  }
  const text = m.kind === 'announce' ? `📢 ${m.text}` : m.text;
  return h('div', { class: `msg-sys ${m.kind}`, 'data-id': m.id }, text);
}

function chatNearBottom() {
  const l = els.chatList;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}

function scrollChat() {
  els.chatList.scrollTop = els.chatList.scrollHeight;
  els.chatNew.hidden = true;
}

function renderChat(messages) {
  els.chatList.replaceChildren(...(messages || []).map(chatMessageNode));
  if (!messages || !messages.length) els.chatList.append(h('div', { class: 'msg-sys' }, '¡Mba\'éichapa! Saludá a la hinchada 👋'));
  requestAnimationFrame(scrollChat);
}

function chatVisible() {
  return window.innerWidth >= 860 || els.chat.classList.contains('open');
}

socket.on('chat', (m) => {
  const near = chatNearBottom();
  els.chatList.append(chatMessageNode(m));
  while (els.chatList.children.length > 120) els.chatList.firstChild.remove();
  const mine = !!(state.user && m.uid === state.user.id);
  if (near || mine) scrollChat();
  else els.chatNew.hidden = false;
  if (!chatVisible() && !mine) {
    state.unread++;
    els.chatBadge.hidden = false;
    els.chatBadge.textContent = state.unread > 99 ? '99+' : String(state.unread);
  }
});

socket.on('chatDelete', ({ id }) => {
  const node = els.chatList.querySelector(`[data-id="${Number(id)}"]`);
  if (node) node.remove();
});

socket.on('chatClear', () => renderChat([]));

els.chatNew.addEventListener('click', scrollChat);
els.chatList.addEventListener('scroll', () => {
  if (chatNearBottom()) els.chatNew.hidden = true;
});

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.user) return openAuth('login');
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.emojiPicker.hidden = true;
  socket.timeout(6000).emit('chat', { text }, (err, res) => {
    if (err) return toast('No se pudo enviar el mensaje', 'error');
    if (!res.ok) return toast(res.error, 'error');
    els.chatInput.value = '';
  });
});

els.chatInput.addEventListener('focus', () => {
  if (!state.user) {
    els.chatInput.blur();
    openAuth('login');
  }
});

function openChat() {
  els.chat.classList.add('open');
  document.body.classList.add('chat-open');
  state.unread = 0;
  els.chatBadge.hidden = true;
  requestAnimationFrame(scrollChat);
}

function closeChat() {
  els.chat.classList.remove('open');
  document.body.classList.remove('chat-open');
  els.emojiPicker.hidden = true;
}

els.chatFab.addEventListener('click', openChat);
$('#chatClose').addEventListener('click', closeChat);

// ═══════════════ Menú ═══════════════

function openDrawer() {
  renderDrawer();
  els.drawer.classList.add('open');
  els.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  els.drawer.classList.remove('open');
  els.drawerBackdrop.hidden = true;
}

function renderDrawer() {
  const u = state.user;
  const item = (icon, label, fn, href) => {
    const attrs = { class: 'drawer-item' };
    if (href) return h('a', { ...attrs, href }, h('span', { class: 'di-icon' }, icon), label);
    return h(
      'button',
      {
        ...attrs,
        type: 'button',
        onclick: () => {
          closeDrawer();
          fn();
        },
      },
      h('span', { class: 'di-icon' }, icon),
      label,
    );
  };
  const nodes = [];
  if (u) {
    nodes.push(
      h('div', { class: 'drawer-user' }, avatar(u.username, 42), h('div', null, h('b', null, u.username), h('small', null, `Saldo: ${fmtGs(state.balance)}`))),
      h(
        'div',
        { class: 'drawer-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (closeDrawer(), openWallet('deposit')) }, '💰 Depositar'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (closeDrawer(), openWallet('withdraw')) }, '🏦 Retirar'),
      ),
      item('📜', 'Movimientos', () => openWallet('history')),
      item('🧾', 'Mis depósitos y retiros', () => openWallet('requests')),
      item('🎯', 'Mis apuestas', () => {
        showSideTab('mine');
        $('#sideCol').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
      item('👤', 'Mi perfil', openProfile),
    );
  } else {
    nodes.push(
      h(
        'div',
        { class: 'drawer-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (closeDrawer(), openAuth('login')) }, 'Ingresar'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (closeDrawer(), openAuth('register')) }, 'Registrarse'),
      ),
    );
  }
  nodes.push(
    h('div', { class: 'drawer-sep' }),
    item('🏆', 'Top ganadores', () => {
      showSideTab('top');
      $('#sideCol').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
    item('🕒', 'Historial de rondas', openHistory),
    item('🔐', 'Provably fair (verificar)', null, '/fair'),
    item('📖', 'Cómo jugar y reglas', openRules),
    item(sound.enabled ? '🔊' : '🔇', `Sonido: ${sound.enabled ? 'activado' : 'apagado'}`, toggleSound),
  );
  const wa = String(state.settings.support_whatsapp || '').replace(/[^\d]/g, '');
  if (wa) {
    const number = wa.startsWith('0') ? '595' + wa.slice(1) : wa;
    nodes.push(h('a', { class: 'drawer-item', href: `https://wa.me/${number}`, target: '_blank', rel: 'noopener' }, h('span', { class: 'di-icon' }, '💬'), 'Soporte por WhatsApp'));
  }
  if (u && u.role === 'admin') nodes.push(item('🛡️', 'Panel de administración', null, '/admin'));
  if (u) nodes.push(h('div', { class: 'drawer-sep' }), item('🚪', 'Cerrar sesión', logout));
  nodes.push(h('div', { class: 'drawer-foot' }, '🇵🇾 CrashPY · +18 · Jugá con responsabilidad'));
  els.drawer.replaceChildren(...nodes);
}

$('#btnMenu').addEventListener('click', openDrawer);
els.drawerBackdrop.addEventListener('click', closeDrawer);
$('#btnLogin').addEventListener('click', () => openAuth('login'));
$('#btnRegister').addEventListener('click', () => openAuth('register'));
$('#btnDeposit').addEventListener('click', () => openWallet('deposit'));
els.balancePill.addEventListener('click', () => openWallet('deposit'));
$('#btnHistory').addEventListener('click', openHistory);
$('#linkRules').addEventListener('click', (e) => {
  e.preventDefault();
  openRules();
});

function toggleSound() {
  const on = sound.toggle();
  els.soundBtn.textContent = on ? '🔊' : '🔇';
  toast(on ? 'Sonido activado 🔊' : 'Sonido apagado 🔇', 'info');
}
els.soundBtn.textContent = sound.enabled ? '🔊' : '🔇';
els.soundBtn.addEventListener('click', toggleSound);

// ═══════════════ Ingreso / registro ═══════════════

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function openAuth(mode = 'login') {
  const tabs = h(
    'div',
    { class: 'tabs auth-tabs' },
    h('button', { type: 'button', 'data-mode': 'login' }, 'Ingresar'),
    h('button', { type: 'button', 'data-mode': 'register' }, 'Crear cuenta'),
  );
  const body = h('div');
  const hero = h('div', { class: 'auth-hero' }, h('img', { src: '/img/icon.svg', alt: '' }), h('p', null, 'El crash paraguayo en guaraníes 🇵🇾'));
  const modal = openModal({ title: '', content: h('div', null, hero, tabs, body) });

  const show = (m) => {
    $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    body.replaceChildren(m === 'login' ? loginForm() : registerForm());
    setTimeout(() => {
      const first = $('input', body);
      if (first && window.innerWidth > 700) first.focus();
    }, 60);
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) show(b.dataset.mode);
  });

  function loginForm() {
    const user = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Tu usuario', required: true });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Tu contraseña', required: true });
    const error = h('div', { class: 'form-error' });
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Ingresar');
    const form = h('form', null, field('Usuario', user), field('Contraseña', pass), error, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        const { user: u } = await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
        modal.close();
        onLoggedIn(u, false);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function registerForm() {
    const user = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Ej: juanpy', maxlength: 16, required: true });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Mínimo 6 caracteres', required: true });
    const pass2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repetí la contraseña', required: true });
    const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '09xx xxx xxx (opcional)' });
    const adult = h('input', { type: 'checkbox' });
    const error = h('div', { class: 'form-error' });
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Crear cuenta 🚀');
    const form = h(
      'form',
      null,
      field('Usuario', user, 'De 3 a 16 caracteres: letras, números, punto o guion bajo'),
      h('div', { class: 'field-row' }, field('Contraseña', pass), field('Repetir', pass2)),
      field('WhatsApp', phone, 'Para ayudarte con depósitos y retiros'),
      h('label', { class: 'check' }, adult, h('span', null, 'Confirmo que soy mayor de 18 años y que juego con responsabilidad.')),
      error,
      submit,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (pass.value !== pass2.value) {
        error.textContent = 'Las contraseñas no coinciden';
        return;
      }
      if (!adult.checked) {
        error.textContent = 'Tenés que confirmar que sos mayor de 18 años';
        return;
      }
      submit.disabled = true;
      try {
        const { user: u } = await api('/api/auth/register', {
          method: 'POST',
          body: { username: user.value.trim(), password: pass.value, phone: phone.value.trim(), adult: true },
        });
        modal.close();
        onLoggedIn(u, true);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  show(mode);
}

// ═══════════════ Billetera ═══════════════

let walletModal = null;

const LEDGER_TYPES = {
  deposit: ['💰', 'Depósito'],
  withdraw: ['🏦', 'Retiro'],
  withdraw_refund: ['↩️', 'Retiro devuelto'],
  bet: ['🎯', 'Apuesta'],
  bet_cancel: ['↩️', 'Apuesta cancelada'],
  win: ['🤑', 'Ganancia'],
  refund: ['↩️', 'Apuesta devuelta'],
  admin: ['🛡️', 'Ajuste del administrador'],
  bonus: ['🎁', 'Bono'],
};

const STATUS_CHIPS = {
  pending: ['chip chip-gold', 'En revisión'],
  approved: ['chip chip-green', 'Acreditado'],
  paid: ['chip chip-green', 'Pagado'],
  rejected: ['chip chip-red', 'Rechazado'],
};

const BANKS = [
  'Banco Itaú',
  'Banco Continental',
  'ueno bank',
  'Banco Basa',
  'Sudameris Bank',
  'Banco GNB',
  'Banco Familiar',
  'Banco Atlas',
  'Interfisa Banco',
  'Banco Nacional de Fomento (BNF)',
  'Banco Río',
  'Zeta Banco',
  'Solar Banco',
  'Bancop',
  'Financiera FIC',
  'Financiera Paraguayo Japonesa',
  'Tu Financiera',
  'Cooperativa',
  'Tigo Money',
  'Billetera Personal',
  'Wally',
  'Eko',
  'Zimple',
];

function amountInput(placeholder) {
  const input = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'off', placeholder });
  input.addEventListener('input', () => {
    const v = parseAmount(input.value);
    input.value = Number.isFinite(v) ? fmtNum(v) : '';
  });
  return input;
}

function openWallet(tab = 'deposit') {
  if (!state.user) {
    openAuth('login');
    return;
  }
  const tabs = h(
    'div',
    { class: 'tabs wallet-tabs' },
    ...[
      ['deposit', 'Depositar'],
      ['withdraw', 'Retirar'],
      ['history', 'Movimientos'],
      ['requests', 'Solicitudes'],
    ].map(([k, label]) => h('button', { type: 'button', 'data-tab': k }, label)),
  );
  const body = h('div');
  let current = tab;
  const modal = openModal({
    title: '💰 Mi billetera',
    content: h('div', null, tabs, body),
    onClose: () => {
      walletModal = null;
    },
  });
  const views = { deposit: depositView, withdraw: withdrawView, history: ledgerView, requests: requestsView };
  const show = async (k) => {
    current = k;
    $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
    body.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
    try {
      const view = await views[k]();
      if (current === k) body.replaceChildren(view);
    } catch (err) {
      if (err.status === 401) {
        modal.close();
        openAuth('login');
        return;
      }
      body.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) show(b.dataset.tab);
  });
  walletModal = {
    refresh: () => {
      if (current === 'history' || current === 'requests') show(current);
    },
    show,
    close: modal.close,
  };
  show(tab);
}

async function depositView() {
  const { bank } = await api('/api/wallet/info');
  const hasBank = bank.bank_name || bank.bank_account || bank.bank_alias;
  const row = (label, value) =>
    value
      ? h(
          'div',
          { class: 'bank-row' },
          h('span', null, label),
          h('div', { class: 'bank-val' }, h('b', null, value), h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(value), title: 'Copiar' }, '📋')),
        )
      : null;
  const card = hasBank
    ? h(
        'div',
        { class: 'bank-card' },
        row('Banco', bank.bank_name),
        row('Titular', bank.bank_holder),
        row('CI / RUC', bank.bank_doc),
        row('Nº de cuenta', bank.bank_account),
        row('Alias', bank.bank_alias),
      )
    : h('div', { class: 'verify-box bad' }, 'Todavía no se cargaron los datos para transferir. Consultá al soporte.');

  const amount = amountInput(`Mínimo ${fmtGs(bank.min_deposit)}`);
  const reference = h('input', { class: 'input', placeholder: 'Ej: 123456789', maxlength: 60 });
  const sender = h('input', { class: 'input', placeholder: 'Nombre de quien transfirió', maxlength: 80 });
  const file = h('input', { type: 'file', accept: 'image/*' });
  const preview = h('img', { class: 'file-preview', alt: '', hidden: true });
  const fileLabel = h('span', null, '📷 Subir foto o captura del comprobante');
  const drop = h('label', { class: 'file-drop' }, file, preview, fileLabel);
  let receipt = null;
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    fileLabel.textContent = 'Procesando imagen…';
    try {
      receipt = await compressImage(f);
      preview.src = receipt;
      preview.hidden = false;
      fileLabel.textContent = '✅ Comprobante listo (tocá para cambiarlo)';
    } catch (err) {
      receipt = null;
      preview.hidden = true;
      fileLabel.textContent = err.message;
    }
  });
  const error = h('div', { class: 'form-error' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Enviar comprobante');
  const wrap = h('div');
  const form = h(
    'form',
    null,
    h('div', { class: 'step-title' }, h('span', { class: 'step-num' }, '1'), 'Transferí a esta cuenta'),
    card,
    bank.bank_notes ? h('p', { class: 'hint' }, bank.bank_notes) : null,
    h('div', { class: 'step-title' }, h('span', { class: 'step-num' }, '2'), 'Avisanos tu transferencia'),
    field('Monto transferido (Gs.)', amount),
    field('Nº de comprobante / referencia', reference),
    field('Titular de la cuenta de origen (opcional)', sender),
    drop,
    error,
    submit,
    h('p', { class: 'hint', style: { marginTop: '10px', textAlign: 'center' } }, 'Un administrador revisa la transferencia y acredita tu saldo. Te avisamos al instante 🔔'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const value = parseAmount(amount.value);
    if (!Number.isFinite(value) || value <= 0) {
      error.textContent = 'Ingresá el monto que transferiste';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Enviando…';
    try {
      await api('/api/wallet/deposit', {
        method: 'POST',
        body: { amount: value, reference: reference.value.trim(), senderName: sender.value.trim(), receipt },
      });
      wrap.replaceChildren(
        h(
          'div',
          { class: 'success-box' },
          h('div', { class: 'big-icon' }, '⏳'),
          h('h3', null, '¡Recibimos tu aviso!'),
          h('p', null, `Tu depósito de ${fmtGs(value)} está en revisión. Apenas se confirme la transferencia se acredita tu saldo.`),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => walletModal && walletModal.show('requests') }, 'Ver mis solicitudes'),
        ),
      );
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'Enviar comprobante';
    }
  });
  wrap.append(form);
  return wrap;
}

function compressImage(fileObj, maxSide = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileObj);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen. Probá con una captura en JPG o PNG.'));
    };
    img.src = url;
  });
}

async function withdrawView() {
  const { bank: info, balance } = await api('/api/wallet/info');
  setBalance(balance, false);
  const saved = store.get('cpy_wd', {});
  const amount = amountInput(`Mínimo ${fmtGs(info.min_withdraw)}`);
  const listId = 'banks-list';
  const bankInput = h('input', { class: 'input', list: listId, placeholder: 'Elegí o escribí tu banco', value: saved.bank || '', maxlength: 60 });
  const datalist = h('datalist', { id: listId }, ...BANKS.map((b) => h('option', { value: b })));
  const type = h(
    'select',
    { class: 'input' },
    ...['Caja de ahorro', 'Cuenta corriente', 'Billetera electrónica', 'Alias SIPAP (CI / celular)'].map((t) =>
      h('option', { value: t, selected: saved.accountType === t }, t),
    ),
  );
  const account = h('input', { class: 'input', placeholder: 'Número de cuenta o alias', value: saved.account || '', maxlength: 60 });
  const holder = h('input', { class: 'input', placeholder: 'Nombre y apellido', value: saved.holder || '', maxlength: 80 });
  const doc = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'Nº de cédula', value: saved.holderDoc || '', maxlength: 20 });
  const error = h('div', { class: 'form-error' });
  const submit = h('button', { class: 'btn btn-blue btn-block', type: 'submit' }, 'Solicitar retiro');
  const wrap = h('div');
  const maxHint = info.max_withdraw > 0 ? ` · máximo ${fmtGs(info.max_withdraw)}` : '';
  const form = h(
    'form',
    null,
    h('div', { class: 'balance-big' }, h('small', null, 'Saldo disponible'), h('b', null, fmtGs(balance))),
    field('Monto a retirar (Gs.)', amount, `Mínimo ${fmtGs(info.min_withdraw)}${maxHint}`),
    field('Banco o billetera', bankInput),
    datalist,
    h('div', { class: 'field-row' }, field('Tipo de cuenta', type), field('CI del titular', doc)),
    field('Nº de cuenta / alias', account),
    field('Titular de la cuenta', holder),
    error,
    submit,
    h('p', { class: 'hint', style: { marginTop: '10px', textAlign: 'center' } }, 'El monto se descuenta ahora de tu saldo. Si el retiro se rechaza, se te devuelve automáticamente.'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const value = parseAmount(amount.value);
    if (!Number.isFinite(value) || value <= 0) {
      error.textContent = 'Ingresá el monto a retirar';
      return;
    }
    if (value > state.balance) {
      error.textContent = 'No tenés saldo suficiente';
      return;
    }
    const data = {
      amount: value,
      bank: bankInput.value.trim(),
      accountType: type.value,
      account: account.value.trim(),
      holder: holder.value.trim(),
      holderDoc: doc.value.trim(),
    };
    submit.disabled = true;
    submit.textContent = 'Enviando…';
    try {
      const res = await api('/api/wallet/withdraw', { method: 'POST', body: data });
      store.set('cpy_wd', { bank: data.bank, accountType: data.accountType, account: data.account, holder: data.holder, holderDoc: data.holderDoc });
      setBalance(res.balance);
      wrap.replaceChildren(
        h(
          'div',
          { class: 'success-box' },
          h('div', { class: 'big-icon' }, '🏦'),
          h('h3', null, '¡Retiro solicitado!'),
          h('p', null, `Vamos a transferir ${fmtGs(value)} a tu cuenta de ${data.bank}. Te avisamos cuando esté hecho.`),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => walletModal && walletModal.show('requests') }, 'Ver mis solicitudes'),
        ),
      );
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'Solicitar retiro';
    }
  });
  wrap.append(form);
  return wrap;
}

async function ledgerView() {
  const { items } = await api('/api/me/ledger');
  if (!items.length) return h('div', { class: 'empty' }, 'Todavía no tenés movimientos');
  return h(
    'div',
    null,
    ...items.map((it) => {
      const [icon, label] = LEDGER_TYPES[it.type] || ['•', it.type];
      return h(
        'div',
        { class: 'list-item' },
        h('div', { class: 'li-main' }, h('b', null, `${icon} ${label}`), h('small', null, `${it.note || ''}${it.note ? ' · ' : ''}${fmtDate(it.created_at)}`)),
        h('div', { class: 'li-amount' }, h('span', { class: it.amount >= 0 ? 'green' : 'red' }, fmtSigned(it.amount)), h('small', null, `Saldo: ${fmtGs(it.balance_after)}`)),
      );
    }),
  );
}

async function requestsView() {
  const { deposits, withdrawals } = await api('/api/wallet/requests');
  const chip = (status) => {
    const [cls, label] = STATUS_CHIPS[status] || ['chip', status];
    return h('span', { class: cls }, label);
  };
  const dep = deposits.map((d) =>
    h(
      'div',
      { class: 'list-item' },
      h(
        'div',
        { class: 'li-main' },
        h('b', null, `💰 Depósito #${d.id}`),
        h('small', null, `${fmtDate(d.created_at)}${d.reference ? ' · Ref. ' + d.reference : ''}`),
        d.admin_note && d.status === 'rejected' ? h('small', { class: 'red' }, d.admin_note) : null,
      ),
      h('div', { class: 'li-amount' }, fmtGs(d.credited || d.amount), h('small', null, chip(d.status))),
    ),
  );
  const wd = withdrawals.map((w) =>
    h(
      'div',
      { class: 'list-item' },
      h(
        'div',
        { class: 'li-main' },
        h('b', null, `🏦 Retiro #${w.id}`),
        h('small', null, `${fmtDate(w.created_at)} · ${w.bank}`),
        w.admin_note ? h('small', { class: w.status === 'rejected' ? 'red' : 'muted' }, w.admin_note) : null,
      ),
      h('div', { class: 'li-amount' }, fmtGs(w.amount), h('small', null, chip(w.status))),
    ),
  );
  return h(
    'div',
    null,
    h('h4', { style: { margin: '6px 0' } }, 'Depósitos'),
    dep.length ? h('div', null, ...dep) : h('div', { class: 'empty' }, 'Sin depósitos todavía'),
    h('h4', { style: { margin: '16px 0 6px' } }, 'Retiros'),
    wd.length ? h('div', null, ...wd) : h('div', { class: 'empty' }, 'Sin retiros todavía'),
  );
}

// ═══════════════ Perfil ═══════════════

async function openProfile() {
  if (!state.user) return openAuth('login');
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  const modal = openModal({ title: '👤 Mi perfil', content: body });
  try {
    const { user, stats } = await api('/api/me');
    const net = stats.total_won - stats.total_bet;
    const stat = (label, value, cls) => h('div', { class: 'stat' }, h('small', null, label), h('b', { class: cls || '' }, value));
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Mínimo 6 caracteres' });
    const error = h('div', { class: 'form-error' });
    const submit = h('button', { class: 'btn btn-blue btn-block', type: 'submit' }, 'Cambiar contraseña');
    const form = h('form', null, h('h4', { style: { margin: '6px 0 10px' } }, '🔑 Cambiar contraseña'), field('Contraseña actual', current), field('Nueva contraseña', next), error, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await api('/api/me/password', { method: 'POST', body: { current: current.value, password: next.value } });
        toast('Contraseña actualizada ✅', 'success');
        modal.close();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
    body.replaceChildren(
      h('div', { class: 'drawer-user' }, avatar(user.username, 42), h('div', null, h('b', null, user.username), h('small', null, `Miembro desde ${fmtDate(user.created_at)}`))),
      h(
        'div',
        { class: 'stat-grid' },
        stat('Saldo', fmtGs(user.balance)),
        stat('Resultado neto', fmtSigned(net), net >= 0 ? 'green' : 'red'),
        stat('Total apostado', fmtGs(stats.total_bet)),
        stat('Total cobrado', fmtGs(stats.total_won)),
        stat('Apuestas', fmtNum(stats.bets_count)),
        stat('Mejor retiro', stats.best_cashout ? fmtMult(stats.best_cashout) : '—'),
        stat('Depositado', fmtGs(stats.total_deposit)),
        stat('Retirado', fmtGs(stats.total_withdraw)),
      ),
      form,
    );
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ═══════════════ Rondas y verificación ═══════════════

function openHistory() {
  const grid = h(
    'div',
    { class: 'history-grid' },
    ...state.history.map((r) =>
      h(
        'button',
        { type: 'button', class: `hist-pill ${r.cancelled ? 'cancelled' : multClass(r.crash)}`, onclick: () => openRound(r.id) },
        fmtMult(r.crash),
        h('small', null, `#${r.id}`),
      ),
    ),
  );
  openModal({
    title: '🕒 Últimas rondas',
    content: h('div', null, grid, h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Tocá una ronda para ver su hash y verificarla.')),
  });
}

async function openRound(id) {
  const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  openModal({ title: `Ronda #${id}`, content: body, wide: true });
  try {
    const data = await api(`/api/rounds/${id}`);
    const r = data.round;
    if (!r.hash) {
      body.replaceChildren(h('div', { class: 'empty' }, 'Esta ronda todavía está en juego. El hash se revela cuando explota 🔒'));
      return;
    }
    const chain = data.chain;
    const shown = r.status === 'crashed' ? r.crash_point : r.ended_multiplier;
    const prevHash = data.previous ? data.previous.hash : r.chain_index === 1 ? chain.terminal_hash : null;
    const cancelledText = {
      refund: 'El administrador detuvo la ronda y se devolvieron las apuestas.',
      pay: 'El administrador detuvo la ronda y se pagó a todos al multiplicador de ese momento.',
      server: 'La ronda se anuló por un reinicio del servidor y se devolvieron las apuestas.',
    };
    const verifyOut = h('div');
    const verifyBtn = h('button', { class: 'btn btn-blue btn-block', type: 'button' }, '✔ Verificar en este dispositivo');
    verifyBtn.addEventListener('click', () => {
      const computed = crashFromHash(r.hash, chain.salt, chain.house_edge_bps);
      const link = prevHash ? sha256Hex(r.hash) === prevHash : null;
      const ok = computed === r.crash_point && link !== false;
      verifyOut.replaceChildren(
        h(
          'div',
          { class: `verify-box ${ok ? 'ok' : 'bad'}` },
          h('div', null, `${computed === r.crash_point ? '✅' : '❌'} El hash da un punto de explosión de ${fmtMult(computed)}${r.status === 'crashed' ? ' (coincide con la ronda)' : ''}`),
          link === null
            ? h('div', null, 'ℹ️ No tenemos el hash anterior para comprobar la cadena.')
            : h('div', null, `${link ? '✅' : '❌'} SHA-256 de este hash = hash de la ronda anterior${r.chain_index === 1 ? ' (hash terminal publicado)' : ''}`),
        ),
      );
    });
    const betsRows = data.bets.map((b) =>
      h(
        'tr',
        null,
        h('td', null, b.user),
        h('td', { class: 'num' }, fmtGs(b.amount)),
        h('td', { class: `num ${b.cashout ? multClass(b.cashout) : 'muted'}` }, b.cashout ? fmtMult(b.cashout) : b.status === 'refunded' ? 'devuelta' : '—'),
        h('td', { class: `num ${b.status === 'won' ? 'green' : b.status === 'lost' ? 'red' : 'muted'}` }, b.status === 'won' ? fmtSigned(b.payout - b.amount) : b.status === 'lost' ? fmtSigned(-b.amount) : '0'),
      ),
    );
    const fairLink = `/fair?hash=${encodeURIComponent(r.hash)}&salt=${encodeURIComponent(chain.salt)}&edge=${chain.house_edge_bps}`;
    body.replaceChildren(h('div', null,
      h(
        'div',
        { class: 'round-hero' },
        h('div', { class: `rh-mult ${r.status === 'cancelled' ? 'muted' : multClass(shown)}` }, fmtMult(shown)),
        h('small', null, `${fmtDate(r.ended_at)} · ${r.players} jugador${r.players === 1 ? '' : 'es'} · apostado ${fmtGs(r.total_bet)}`),
      ),
      r.status === 'cancelled'
        ? h(
            'div',
            { class: 'verify-box' },
            `⚠️ Ronda anulada. ${cancelledText[r.cancel_mode] || ''} Según el hash iba a explotar en ${fmtMult(r.crash_point)}.`,
          )
        : null,
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Hash'),
        h('dd', { class: 'mono' }, r.hash, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(r.hash) }, '📋')),
        h('dt', null, r.chain_index === 1 ? 'Hash terminal' : 'Hash anterior'),
        h('dd', { class: 'mono' }, prevHash || '—'),
        h('dt', null, 'Sal (salt)'),
        h('dd', { class: 'mono' }, chain.salt),
        h('dt', null, 'Ventaja casa'),
        h('dd', null, `${(chain.house_edge_bps / 100).toFixed(2)}% (RTP ${(100 - chain.house_edge_bps / 100).toFixed(2)}%)`),
        h('dt', null, 'Cadena'),
        h('dd', null, `#${chain.id} · ronda ${fmtNum(r.chain_index)} de ${fmtNum(chain.length)}`),
      ),
      verifyBtn,
      verifyOut,
      h('p', { style: { textAlign: 'center', margin: '10px 0' } }, h('a', { href: fairLink }, '¿Cómo funciona? Verificación completa →')),
      data.bets.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Jugador'), h('th', { class: 'num' }, 'Apuesta'), h('th', { class: 'num' }, 'Retiro'), h('th', { class: 'num' }, 'Resultado'))),
              h('tbody', null, ...betsRows),
            ),
          )
        : h('div', { class: 'empty' }, 'Nadie apostó en esta ronda'),
    ));
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ═══════════════ Reglas ═══════════════

function openRules() {
  const s = state.settings;
  const edge = state.fair ? state.fair.houseEdgeBps / 100 : 3;
  const li = (...c) => h('li', null, ...c);
  openModal({
    title: '📖 Cómo jugar',
    content: h(
      'div',
      { class: 'rules' },
      h(
        'ol',
        null,
        li('Elegí cuánto apostar y tocá ', h('b', null, 'APOSTAR'), ' antes de que despegue el cohete 🚀.'),
        li('El multiplicador sube desde 1.00x. Lo que cobrás = apuesta × multiplicador.'),
        li('Tocá ', h('b', null, 'RETIRAR'), ' cuando quieras. Si el cohete explota antes 💥, perdés la apuesta.'),
        li(h('b', null, 'Auto retiro:'), ' el sistema retira por vos al llegar al multiplicador que elegiste (funciona aunque se te corte internet).'),
        li(h('b', null, 'Auto apuesta:'), ' repite tu apuesta en cada ronda.'),
        li('Podés tener 2 apuestas por ronda con el botón “Agregar segunda apuesta”.'),
      ),
      h('h4', null, '📋 Reglas'),
      h(
        'ul',
        null,
        li(`Apuesta mínima ${fmtGs(s.min_bet)} · máxima ${fmtGs(s.max_bet)}.`),
        li(`Ganancia máxima por apuesta: ${fmtGs(s.max_profit)} (al llegar, se retira sola).`),
        li(`Retorno al jugador (RTP): ${(100 - edge).toFixed(2)}% · ventaja de la casa ${edge.toFixed(2)}%.`),
        li('Una ronda puede explotar en 1.00x, sin tiempo para retirar.'),
        li('Si el servidor se reinicia o el administrador detiene una ronda, la ronda se anula: nadie pierde su apuesta.'),
        li('Los resultados se pueden verificar con el sistema Provably Fair (hash SHA-256).'),
      ),
      h('h4', null, '🔐 Juego comprobable'),
      h(
        'p',
        { class: 'hint' },
        'Todas las rondas salen de una cadena de hashes publicada de antemano. Nadie (ni el casino) puede cambiar un resultado. Tocá cualquier ronda del historial para verificarla, o mirá ',
        h('a', { href: '/fair' }, 'la página de verificación'),
        '.',
      ),
      h('h4', null, '🧉 Juego responsable'),
      h(
        'p',
        { class: 'hint' },
        'Solo para mayores de 18 años. Apostá solo lo que podés permitirte perder, poné un límite y tomá descansos. Si sentís que perdiste el control, pedí ayuda.',
      ),
    ),
  });
}

// ═══════════════ Inicio ═══════════════

// Mantener la pantalla del celular encendida mientras se juega
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* sin soporte o sin HTTPS */
  }
}
document.addEventListener('pointerdown', keepAwake, { once: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) keepAwake();
});

if (document.fonts && document.fonts.load) document.fonts.load('700 12px Rubik').catch(() => {});
renderDrawer();
renderHistory();
