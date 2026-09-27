// CrashPY · aplicación del jugador: sesión, saldo, billetera, chat, menú y los juegos.
import { $, $$, h, api, fmtGs, fmtNum, fmtMult, fmtSigned, parseAmount, fmtDate, fmtTime, multClass, colorFor, toast, openModal, copyText } from './shared.js';
import { Sound } from './sound.js';
import { GAMES, GAME_BY_ID, SEED_GAMES, store, vibrate, avatar, openPlay, openFairness, openDoubleRound } from './games/common.js';
import { createCrash } from './games/crash.js';
import { createMines } from './games/mines.js';
import { createPenalty } from './games/penalty.js';
import { createDouble } from './games/double.js';
import { createPlinko } from './games/plinko.js';
import { createRoulette } from './games/roulette.js';

// ═══════════════ Estado ═══════════════

const state = {
  user: null,
  settings: { min_bet: 1000, max_bet: 1000000, max_profit: 20000000, quick_amounts: '2000,5000,10000,50000', chat_enabled: true },
  fair: null,
  connected: false,
  online: { n: 0, users: 0 },
  unread: 0,
  sideTab: 'bets',
  topPeriod: 'day',
  feed: [],
  lastInit: null,
};

const els = {
  balance: $('#balance'),
  balancePill: $('#balancePill'),
  guestActions: $('#guestActions'),
  userActions: $('#userActions'),
  onlineCount: $('#onlineCount'),
  gameNav: $('#gameNav'),
  sideCol: $('#sideCol'),
  crashLive: $('#crashLive'),
  feedLive: $('#feedLive'),
  feedList: $('#feedList'),
  betsCount: $('#betsCount'),
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
const socket = io();

// ═══════════════ Saldo ═══════════════
// El saldo real llega del servidor. Mientras un juego anima un resultado (la bolita del Plinko
// cayendo, la ruleta girando…) el premio se "esconde" para no arruinar la sorpresa.

const bal = { server: 0, shown: 0, locks: 0, hidden: new Map(), seq: 0, anim: 0 };

function setBalance(value, animate = true) {
  if (!Number.isFinite(value)) return;
  bal.server = value;
  renderBalance(animate);
}

function renderBalance(animate = true) {
  if (bal.locks > 0) return;
  let hidden = 0;
  for (const v of bal.hidden.values()) hidden += v;
  showBalance(Math.max(0, bal.server - hidden), animate);
}

function showBalance(value, animate) {
  const prev = bal.shown;
  bal.shown = value;
  cancelAnimationFrame(bal.anim);
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
    if (k < 1) bal.anim = requestAnimationFrame(step);
  };
  bal.anim = requestAnimationFrame(step);
}

/** Congela el saldo que se ve (por ejemplo mientras gira la rueda). Devuelve la función para soltarlo. */
function lockBalance(maxMs = 15000) {
  bal.locks++;
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    bal.locks--;
    renderBalance();
  };
  const timer = setTimeout(release, maxMs);
  return release;
}

/** Esconde un premio que ya está en el saldo hasta que termine la animación. Devuelve la función para mostrarlo. */
function hideBalance(amount, maxMs = 15000) {
  if (!(amount > 0)) return () => {};
  const id = ++bal.seq;
  bal.hidden.set(id, amount);
  renderBalance(false);
  const timer = setTimeout(() => reveal(), maxMs);
  function reveal() {
    clearTimeout(timer);
    if (bal.hidden.delete(id)) renderBalance();
  }
  return reveal;
}

// ═══════════════ Interfaz que usan los juegos ═══════════════

const shellListeners = {};
const shell = {
  socket,
  sound,
  state,
  current: null,
  get balance() {
    return bal.server;
  },
  setBalance,
  lockBalance,
  hideBalance,
  on(evt, fn) {
    (shellListeners[evt] = shellListeners[evt] || []).push(fn);
  },
  /** Emite al servidor y devuelve la respuesta ({ ok, ... }); nunca lanza error. */
  emit(name, data = {}, timeout = 8000) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Sin conexión, esperá un momento', code: 'OFFLINE' });
        return;
      }
      socket.timeout(timeout).emit(name, data, (err, res) => {
        if (err) resolve({ ok: false, error: 'El servidor no respondió, probá de nuevo', code: 'TIMEOUT' });
        else resolve(res || { ok: false, error: 'Respuesta inválida' });
      });
    });
  },
  requireUser() {
    if (state.user) return true;
    openAuth('login');
    return false;
  },
  openAuth: (mode) => openAuth(mode),
  openWallet: (tab) => openWallet(tab),
  openRules: () => openRules(),
  setNavBadge(gameId, on) {
    const a = els.gameNav.querySelector(`[data-game="${gameId}"]`);
    if (a) a.classList.toggle('busy', !!on);
  },
  refreshMine() {
    if (state.sideTab === 'mine') loadMine();
  },
  showSideTab: (tab) => showSideTab(tab),
  isVisible: (id) => shell.current === id && !document.hidden,
};

function fire(evt, ...args) {
  for (const fn of shellListeners[evt] || []) {
    try {
      fn(...args);
    } catch (err) {
      console.error(err);
    }
  }
}

const games = {
  crash: createCrash(shell),
  mines: createMines(shell),
  penalty: createPenalty(shell),
  double: createDouble(shell),
  plinko: createPlinko(shell),
  roulette: createRoulette(shell),
};

function eachGame(method, ...args) {
  for (const g of Object.values(games)) {
    if (typeof g[method] !== 'function') continue;
    try {
      g[method](...args);
    } catch (err) {
      console.error(`[${g.id}.${method}]`, err);
    }
  }
}

// ═══════════════ Navegación entre juegos ═══════════════

function gameFromPath(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/crash') return 'crash';
  const g = GAMES.find((x) => x.path === p);
  return g ? g.id : 'crash';
}

function route(id, { push = false } = {}) {
  const g = GAME_BY_ID[id] || GAME_BY_ID.crash;
  if (push && location.pathname !== g.path) history.pushState({ game: g.id }, '', g.path);
  if (shell.current === g.id) return;
  const prev = shell.current && games[shell.current];
  if (prev && prev.hide) prev.hide();
  shell.current = g.id;
  $$('.game-view').forEach((v) => (v.hidden = v.dataset.view !== g.id));
  const game = games[g.id];
  const view = $(`.game-view[data-view="${g.id}"]`);
  try {
    if (!game.mounted) {
      game.mounted = true;
      game.mount(view);
    }
    if (game.show) game.show();
  } catch (err) {
    // Si un juego falla, el resto de la app sigue funcionando
    console.error(`[${g.id}]`, err);
    view.replaceChildren(h('div', { class: 'gv-stage', style: { padding: '50px 20px', textAlign: 'center' } }, `😕 No se pudo abrir ${g.name}. Recargá la página para intentar de nuevo.`));
  }
  document.title = g.id === 'crash' ? 'CrashPY · El crash paraguayo 🇵🇾' : `${g.icon} ${g.name} · CrashPY`;
  $$('a', els.gameNav).forEach((a) => {
    const on = a.dataset.game === g.id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const activeLink = els.gameNav.querySelector('a.active');
  if (activeLink && activeLink.scrollIntoView) activeLink.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  els.crashLive.hidden = g.id !== 'crash';
  els.feedLive.hidden = g.id === 'crash';
  els.betsCount.hidden = g.id !== 'crash';
  if (state.sideTab === 'mine') loadMine();
  if (push) window.scrollTo({ top: 0, behavior: 'smooth' });
}

els.gameNav.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-game]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  sound._ensure();
  route(a.dataset.game, { push: true });
});

window.addEventListener('popstate', () => route(gameFromPath(location.pathname)));

function renderNavState() {
  for (const g of GAMES) {
    if (g.id === 'crash') continue;
    const a = els.gameNav.querySelector(`[data-game="${g.id}"]`);
    if (a) a.classList.toggle('off', state.settings['game_' + g.id] === false);
  }
}

// ═══════════════ Sesión ═══════════════

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
  renderDrawer();
}

function applySettings() {
  const s = state.settings;
  const banner = (s.banner || '').trim();
  els.siteBanner.hidden = !banner;
  els.siteBanner.textContent = banner;
  renderNavState();
  eachGame('onSettings', s);
  fire('settings', s);
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
  updateAuthUI();
  eachGame('onUser', null);
  fire('user', null);
  closeDrawer();
  reconnect();
  toast('Cerraste sesión. ¡Aguyje! 👋', 'info');
}

function onLoggedIn(user, isNew) {
  state.user = user;
  updateAuthUI();
  eachGame('onUser', user);
  fire('user', user);
  reconnect();
  toast(isNew ? `¡Bienvenido/a a CrashPY, ${user.username}! 🚀` : `¡Mba'éichapa, ${user.username}! 👋`, 'success');
  if (isNew && user.balance <= 0) setTimeout(() => openWallet('deposit'), 700);
}

// ═══════════════ Conexión ═══════════════

socket.on('connect', () => {
  state.connected = true;
  els.connBanner.hidden = true;
});

socket.on('disconnect', () => {
  state.connected = false;
  setTimeout(() => {
    if (!state.connected) els.connBanner.hidden = false;
  }, 1200);
  eachGame('onDisconnect');
});

socket.on('init', (d) => {
  state.lastInit = d;
  state.settings = { ...state.settings, ...d.settings };
  state.fair = d.fair;
  const userChanged = (state.user && state.user.id) !== (d.user && d.user.id);
  state.user = d.user;
  state.online = d.online;
  state.feed = d.feed || [];
  applySettings();
  eachGame('onInit', d);
  if (userChanged) eachGame('onUser', d.user);
  fire('init', d);
  renderChat(d.chat);
  renderOnline();
  renderFeed();
  if (state.sideTab === 'mine') loadMine();
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

// ═══════════════ Jugadas en vivo (todos los juegos) ═══════════════

socket.on('feed', (batch) => {
  if (!Array.isArray(batch) || !batch.length) return;
  for (const f of batch) state.feed.unshift(f);
  if (state.feed.length > 30) state.feed.length = 30;
  renderFeed(batch.length);
});

function renderFeed(fresh = 0) {
  const me = state.user ? state.user.username : null;
  const rows = state.feed.slice(0, 25).map((f, i) => {
    const g = GAME_BY_ID[f.game] || GAME_BY_ID.crash;
    const won = f.payout > 0;
    return h(
      'div',
      { class: `bet-row feed-row ${won ? 'won' : 'lost'}${f.user === me ? ' me' : ''}${i < fresh ? ' fresh' : ''}${f.game === shell.current ? ' here' : ''}` },
      h('div', { class: 'bet-user' }, h('span', { class: 'feed-game', title: g.name }, g.icon), h('span', null, f.user)),
      h('div', { class: 'bet-amount' }, fmtNum(f.amount)),
      h('div', { class: `bet-mult ${won ? multClass(f.multiplier) : 'muted'}` }, won ? fmtMult(f.multiplier) : '0.00x'),
      h('div', { class: 'bet-win' }, won ? fmtNum(f.payout) : '—'),
    );
  });
  if (!rows.length) rows.push(h('div', { class: 'empty' }, 'Todavía no hay jugadas. ¡Arrancá vos! 🎲'));
  els.feedList.replaceChildren(...rows);
}

// ═══════════════ Bucle de animación ═══════════════

function loop(now) {
  const g = games[shell.current];
  if (g && g.frame && !document.hidden) {
    try {
      g.frame(now);
    } catch (err) {
      console.error(err);
    }
  }
  requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.engineStop();
});

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

function loadMine() {
  const g = games[shell.current];
  if (g && g.loadMine) g.loadMine(els.mineList);
}

$('#topPeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-period]');
  if (!btn) return;
  state.topPeriod = btn.dataset.period;
  $$('#topPeriod button').forEach((b) => b.classList.toggle('active', b === btn));
  loadTop();
});

/** Abre el detalle correcto según el juego (ronda del Crash, ronda del Double o jugada). */
function openWin(w) {
  if (w.game === 'crash') games.crash.openRound(w.round_id);
  else if (w.game === 'double') openDoubleRound(shell, w.round_id);
  else openPlay(shell, w.round_id);
}

async function loadTop() {
  els.topList.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  try {
    const data = await api('/api/top?period=' + state.topPeriod);
    const section = (title, rows) => h('div', { class: 'top-section' }, h('h4', null, title), rows.length ? rows : h('div', { class: 'empty' }, 'Todavía nada por acá'));
    const winRow = (w, i, mode) => {
      const g = GAME_BY_ID[w.game] || GAME_BY_ID.crash;
      const where = w.game === 'crash' || w.game === 'double' ? `ronda #${w.round_id}` : `jugada #${w.round_id}`;
      return h(
        'div',
        { class: 'top-row', onclick: () => openWin(w), style: { cursor: 'pointer' } },
        h('span', { class: 'top-rank' }, i + 1),
        h('div', { class: 'top-main' }, h('b', null, w.user), h('small', null, `${g.icon} ${g.name} · apostó ${fmtGs(w.amount)} · ${where}`)),
        h(
          'div',
          { class: 'top-value' },
          mode === 'mult' ? h('span', { class: multClass(w.cashout) }, fmtMult(w.cashout)) : h('span', { class: 'green' }, fmtGs(w.payout)),
          h('small', null, mode === 'mult' ? fmtGs(w.payout) : `a ${fmtMult(w.cashout)}`),
        ),
      );
    };
    els.topList.replaceChildren(
      section('🤑 Mayores ganancias', data.wins.map((w, i) => winRow(w, i, 'win'))),
      section('🔥 Mejores multiplicadores', data.multipliers.map((w, i) => winRow(w, i, 'mult'))),
      section(
        '💥 Rondas más altas del Crash',
        data.rounds.map((r, i) =>
          h(
            'div',
            { class: 'top-row', onclick: () => games.crash.openRound(r.id), style: { cursor: 'pointer' } },
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

const EMOJIS = ['😀', '😂', '🤣', '😎', '😍', '🤑', '😱', '😭', '😡', '🥳', '🙏', '👏', '👍', '💪', '🔥', '🚀', '💥', '💸', '💰', '🍀', '🎯', '🤞', '🇵🇾', '🧉', '⚽', '💣', '💎', '🎰', '❤️', '💙', '👀', '🤡'];

els.emojiPicker.replaceChildren(
  ...EMOJIS.map((e) =>
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          els.chatInput.value += e;
          els.chatInput.focus();
        },
      },
      e,
    ),
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
  if (!messages || !messages.length) els.chatList.append(h('div', { class: 'msg-sys' }, "¡Mba'éichapa! Saludá a la hinchada 👋"));
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

function scrollToSide(tab) {
  showSideTab(tab);
  els.sideCol.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      h('div', { class: 'drawer-user' }, avatar(u.username, 42), h('div', null, h('b', null, u.username), h('small', null, `Saldo: ${fmtGs(bal.shown)}`))),
      h(
        'div',
        { class: 'drawer-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (closeDrawer(), openWallet('deposit')) }, '💰 Depositar'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (closeDrawer(), openWallet('withdraw')) }, '🏦 Retirar'),
      ),
      item('📜', 'Movimientos', () => openWallet('history')),
      item('🧾', 'Mis depósitos y retiros', () => openWallet('requests')),
      item('🎯', 'Mis apuestas', () => scrollToSide('mine')),
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
    h('div', { class: 'drawer-label' }, 'Juegos'),
    h(
      'div',
      { class: 'drawer-games' },
      ...GAMES.map((g) =>
        h(
          'a',
          {
            class: `drawer-game${shell.current === g.id ? ' active' : ''}`,
            href: g.path,
            onclick: (e) => {
              e.preventDefault();
              closeDrawer();
              route(g.id, { push: true });
            },
          },
          h('span', null, g.icon),
          g.name,
        ),
      ),
    ),
    h('div', { class: 'drawer-sep' }),
    item('🏆', 'Top ganadores', () => scrollToSide('top')),
    item('🔐', 'Provably fair (verificar)', null, '/fair'),
  );
  if (u) nodes.push(item('🎲', 'Mis semillas', () => openFairness(shell)));
  nodes.push(item('📖', 'Cómo jugar y reglas', openRules), item(sound.enabled ? '🔊' : '🔇', `Sonido: ${sound.enabled ? 'activado' : 'apagado'}`, toggleSound));
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
  const tabs = h('div', { class: 'tabs auth-tabs' }, h('button', { type: 'button', 'data-mode': 'login' }, 'Ingresar'), h('button', { type: 'button', 'data-mode': 'register' }, 'Crear cuenta'));
  const body = h('div');
  const hero = h('div', { class: 'auth-hero' }, h('img', { src: '/img/icon.svg', alt: '' }), h('p', null, 'El casino paraguayo en guaraníes 🇵🇾'));
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
    ? h('div', { class: 'bank-card' }, row('Banco', bank.bank_name), row('Titular', bank.bank_holder), row('CI / RUC', bank.bank_doc), row('Nº de cuenta', bank.bank_account), row('Alias', bank.bank_alias))
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
    ...['Caja de ahorro', 'Cuenta corriente', 'Billetera electrónica', 'Alias SIPAP (CI / celular)'].map((t) => h('option', { value: t, selected: saved.accountType === t }, t)),
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
    if (value > bal.server) {
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
        stat('Mejor multiplicador', stats.best_cashout ? fmtMult(stats.best_cashout) : '—'),
        stat('Depositado', fmtGs(stats.total_deposit)),
        stat('Retirado', fmtGs(stats.total_withdraw)),
      ),
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', style: { margin: '4px 0 14px' }, onclick: () => (modal.close(), openFairness(shell)) }, '🎲 Mis semillas (provably fair)'),
      form,
    );
  } catch (err) {
    body.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

// ═══════════════ Reglas ═══════════════

function openRules() {
  const s = state.settings;
  const g = GAME_BY_ID[shell.current] || GAME_BY_ID.crash;
  const game = games[g.id];
  const li = (...c) => h('li', null, ...c);
  openModal({
    title: `📖 Cómo jugar · ${g.icon} ${g.name}`,
    content: h(
      'div',
      { class: 'rules' },
      game && game.rules ? game.rules() : null,
      h('h4', null, '📋 Reglas generales'),
      h(
        'ul',
        null,
        li(`Apuesta mínima ${fmtGs(s.min_bet)} · máxima ${fmtGs(s.max_bet)}.`),
        li(`Ganancia máxima por apuesta o jugada: ${fmtGs(s.max_profit)}.`),
        li('Retorno al jugador (RTP): 97% en Crash, Minas, Penales y Plinko · 97,3% en la Ruleta · 96,8% en el Double.'),
        li('Si el servidor se reinicia en medio de una ronda, nadie pierde: las apuestas se devuelven (o se pagan si el resultado ya se había mostrado).'),
      ),
      h('h4', null, '🔐 Juego comprobable'),
      h(
        'p',
        { class: 'hint' },
        'Crash y Double salen de cadenas de hashes publicadas de antemano. Minas, Penales, Plinko y Ruleta usan tus semillas: la del servidor queda fijada (ves su hash) antes de jugar y vos elegís la tuya. Nadie (ni el casino) puede cambiar un resultado. Mirá ',
        h('a', { href: '/fair' }, 'la página de verificación'),
        SEED_GAMES.includes(g.id) ? [' o tus ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), openFairness(shell)) }, 'semillas')] : null,
        '.',
      ),
      h('h4', null, '🧉 Juego responsable'),
      h('p', { class: 'hint' }, 'Solo para mayores de 18 años. Apostá solo lo que podés permitirte perder, poné un límite y tomá descansos. Si sentís que perdiste el control, pedí ayuda.'),
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
renderFeed();
route(gameFromPath(location.pathname));
requestAnimationFrame(loop);
