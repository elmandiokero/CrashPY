// Panel de administración de CrashPY — punto de entrada: acceso, estructura, navegación y tiempo real.
import { h, api, toast, confirmDialog, fmtGs, fmtNum } from './shared.js';
import { bus, state, icon, avatar, field, modalForm, errorState, setText } from './admin-core.js';
import { initGame, game, livePill, pauseState, togglePause, liveView } from './admin-live.js';
import { dashboardView } from './admin-dashboard.js';
import { usersView } from './admin-users.js';
import { depositsView, withdrawalsView } from './admin-money.js';
import { chatView } from './admin-chat.js';
import { settingsView, fairView } from './admin-settings.js';
import { ledgerView, auditView } from './admin-logs.js';
import { gamesView } from './admin-games.js';

const VIEWS = [
  { id: 'inicio', path: 'inicio', label: 'Inicio', icon: 'grid', group: 'op', mod: dashboardView, bottom: true },
  { id: 'vivo', path: 'en-vivo', label: 'En vivo', icon: 'activity', group: 'op', mod: liveView, bottom: true },
  { id: 'juegos', path: 'juegos', label: 'Juegos', icon: 'gamepad', group: 'op', mod: gamesView },
  { id: 'usuarios', path: 'usuarios', label: 'Usuarios', icon: 'users', group: 'op', mod: usersView, bottom: true },
  { id: 'depositos', path: 'depositos', label: 'Depósitos', icon: 'deposit', group: 'op', mod: depositsView, bottom: true, badge: 'deposits' },
  { id: 'retiros', path: 'retiros', label: 'Retiros', icon: 'withdraw', group: 'op', mod: withdrawalsView, bottom: true, badge: 'withdrawals' },
  { id: 'chat', path: 'chat', label: 'Chat', icon: 'chat', group: 'op', mod: chatView },
  { id: 'config', path: 'configuracion', label: 'Configuración', icon: 'sliders', group: 'sys', mod: settingsView },
  { id: 'fair', path: 'provably-fair', label: 'Provably fair', icon: 'shield', group: 'sys', mod: fairView },
  { id: 'movimientos', path: 'movimientos', label: 'Movimientos', icon: 'book', group: 'sys', mod: ledgerView },
  { id: 'auditoria', path: 'auditoria', label: 'Auditoría', icon: 'clipboard', group: 'sys', mod: auditView },
];

const app = document.getElementById('app');
const ui = {};
const badges = { deposits: [], withdrawals: [] };
let started = false;
let sockets = null;
let current = null;
let authLost = false;
let adminRetries = 0;

// ───────────────────────── Sonido de avisos ─────────────────────────

const sound = { on: true, ctx: null, unlocked: false };
try {
  sound.on = localStorage.getItem('cpy_admin_sound') !== '0';
} catch {
  /* sin almacenamiento: queda activado */
}

function unlockAudio() {
  sound.unlocked = true;
  if (!sound.on) return;
  try {
    if (!sound.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) sound.ctx = new AC();
    }
    if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
  } catch {
    /* sin audio */
  }
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlockAudio, { passive: true, capture: true });

function beep(kind) {
  if (!sound.on || !sound.unlocked || !sound.ctx) return;
  try {
    const ctx = sound.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    const notes =
      kind === 'withdraw'
        ? [
            [740, 0],
            [554, 0.17],
          ]
        : [
            [880, 0],
            [1175, 0.12],
            [1568, 0.24],
          ];
    for (const [freq, dt] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.25);
    }
  } catch {
    /* sin audio */
  }
}

function toggleSound() {
  sound.on = !sound.on;
  try {
    localStorage.setItem('cpy_admin_sound', sound.on ? '1' : '0');
  } catch {
    /* ignorar */
  }
  renderSound();
  if (sound.on) {
    unlockAudio();
    beep('deposit');
  }
  toast(sound.on ? 'Vas a escuchar un aviso con cada depósito o retiro nuevo' : 'Avisos sin sonido', 'info', sound.on ? '🔔 Sonido activado' : '🔕 Sonido apagado');
}

function renderSound() {
  if (!ui.soundBtn) return;
  ui.soundBtn.replaceChildren(h('span', { class: 'side-link-ic' }, sound.on ? '🔔' : '🔕'), h('span', null, sound.on ? 'Sonido de avisos: sí' : 'Sonido de avisos: no'));
}

// ───────────────────────── Marca ─────────────────────────

function brandName(small = false) {
  const name = state.settings.site_name || 'CrashPY';
  const m = /^(.*?)(PY)$/.exec(name);
  return h('span', { class: `brand-name${small ? ' sm' : ''}` }, m ? [m[1], h('span', { class: 'py' }, m[2])] : name);
}

function brand(sub = 'Panel de administración') {
  return h(
    'div',
    { class: 'brand' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '🚀'),
    h('span', { class: 'brand-text' }, brandName(), h('span', { class: 'brand-sub' }, sub)),
  );
}

// ───────────────────────── Acceso ─────────────────────────

function gate(...children) {
  document.title = `Admin · ${state.settings.site_name || 'CrashPY'}`;
  return h(
    'div',
    { class: 'gate' },
    h('div', { class: 'gate-card' }, h('div', { class: 'flagbar' }), brand(), children),
    h('a', { class: 'gate-back', href: '/' }, '← Volver al juego'),
  );
}

function renderLogin(message = '') {
  const user = h('input', { class: 'input input-lg', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 32 });
  const pass = h('input', { class: 'input input-lg', type: 'password', name: 'password', autocomplete: 'current-password', maxlength: 100 });
  const show = h('button', { type: 'button', class: 'pass-toggle', 'aria-label': 'Mostrar contraseña', title: 'Mostrar contraseña' }, icon('eye', 18));
  show.addEventListener('click', () => {
    pass.type = pass.type === 'password' ? 'text' : 'password';
  });
  const err = h('div', { class: 'form-error', role: 'alert' }, message);
  const btn = h('button', { type: 'submit', class: 'btn btn-gold btn-block btn-lg' }, 'Ingresar al panel');
  const form = h(
    'form',
    { class: 'gate-form', novalidate: true },
    h('h1', { class: 'gate-title' }, 'Ingresá como administrador'),
    h('p', { class: 'gate-sub' }, 'Usá tu usuario y contraseña de admin.'),
    field('Usuario', user),
    h('div', { class: 'field' }, h('label', { for: 'gate-pass' }, 'Contraseña'), h('div', { class: 'pass-wrap' }, pass, show)),
    err,
    btn,
  );
  pass.id = 'gate-pass';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!user.value.trim() || !pass.value) {
      err.textContent = 'Ingresá tu usuario y contraseña';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Ingresando…';
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      if (started) location.reload();
      else await boot();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Ingresar al panel';
      pass.select();
    }
  });
  app.replaceChildren(gate(form));
  setTimeout(() => (user.value ? pass : user).focus(), 60);
}

function renderForbidden(user) {
  const out = h('button', { type: 'button', class: 'btn btn-danger' }, icon('logout', 17), 'Cerrar sesión');
  out.addEventListener('click', async () => {
    out.disabled = true;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* igual mostramos el login */
    }
    renderLogin();
  });
  app.replaceChildren(
    gate(
      h('div', { class: 'gate-icon' }, '⛔'),
      h('h1', { class: 'gate-title' }, 'Acceso solo para administradores'),
      h('p', { class: 'gate-sub' }, 'Entraste como ', h('b', null, user.username), '. Esta cuenta no tiene permisos para usar el panel.'),
      h('div', { class: 'gate-actions' }, h('a', { class: 'btn btn-ghost', href: '/' }, '🎮 Ir al juego'), out),
    ),
  );
}

function renderFatal(err) {
  app.replaceChildren(
    gate(
      h('div', { class: 'gate-icon' }, '📡'),
      h('h1', { class: 'gate-title' }, 'No se pudo conectar con el servidor'),
      h('p', { class: 'gate-sub' }, err?.message || 'Revisá tu conexión.'),
      h('div', { class: 'gate-actions' }, h('button', { type: 'button', class: 'btn btn-gold', onclick: () => boot() }, icon('refresh', 16), 'Reintentar')),
    ),
  );
}

async function onAuthLost() {
  if (authLost) return;
  authLost = true;
  let user = null;
  try {
    user = (await api('/api/config')).user;
  } catch {
    /* sin conexión: mostramos el login igual */
  }
  if (user && user.role === 'admin') {
    // Falsa alarma (por ejemplo el servidor se estaba reiniciando): reintentamos la conexión de admin.
    authLost = false;
    if (sockets && !sockets.adminSock.connected) {
      if (adminRetries++ < 5) setTimeout(() => sockets.adminSock.connect(), 2000 * adminRetries);
      else setConn('down');
    }
    return;
  }
  if (current) {
    try {
      current.mod.unmount?.();
    } catch {
      /* ignorar */
    }
    current = null;
  }
  if (sockets) {
    sockets.adminSock.disconnect();
    sockets.gameSock.disconnect();
  }
  document.querySelectorAll('.modal-backdrop, .drawer-backdrop').forEach((n) => n.remove());
  document.body.classList.remove('nav-open', 'drawer-open', 'modal-open');
  if (user) renderForbidden(user);
  else renderLogin('Tu sesión se cerró. Ingresá de nuevo.');
}

// ───────────────────────── Cuenta ─────────────────────────

function changeOwnPassword() {
  closeNav();
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 100 });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 100 });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 100 });
  modalForm({
    title: '🔑 Cambiar mi contraseña',
    content: h(
      'div',
      null,
      field('Contraseña actual', cur),
      field('Contraseña nueva', next, 'Mínimo 6 caracteres.'),
      field('Repetí la contraseña nueva', again),
      h('p', { class: 'hint' }, 'Por seguridad se cierran tus otras sesiones abiertas (otros celulares o computadoras).'),
    ),
    submitText: 'Cambiar contraseña',
    onSubmit: async () => {
      if (!cur.value) throw new Error('Ingresá tu contraseña actual');
      if (next.value.length < 6) throw new Error('La contraseña nueva debe tener al menos 6 caracteres');
      if (next.value !== again.value) throw new Error('Las contraseñas nuevas no coinciden');
      await api('/api/me/password', { method: 'POST', body: { current: cur.value, password: next.value } });
      toast('Tu contraseña se cambió correctamente', 'success', '🔑 Listo');
    },
  });
}

async function logout() {
  closeNav();
  const ok = await confirmDialog('¿Cerrar la sesión de administrador en este dispositivo?', { title: 'Cerrar sesión', okText: 'Cerrar sesión', danger: true });
  if (!ok) return;
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* igual recargamos */
  }
  location.replace('/admin');
}

// ───────────────────────── Estructura ─────────────────────────

const openNav = () => {
  document.body.classList.add('nav-open');
  ui.side?.focus({ preventScroll: true });
};
const closeNav = () => document.body.classList.remove('nav-open');

function navLink(v, cls) {
  const badge = v.badge ? h('span', { class: 'nav-badge', hidden: true }) : null;
  if (badge) badges[v.badge].push(badge);
  const inIcon = cls === 'bnav-item';
  return h(
    'a',
    { class: cls, href: `#/${v.path}`, dataset: { view: v.id } },
    h('span', { class: 'nav-ic' }, icon(v.icon, inIcon ? 22 : 19), inIcon ? badge : null),
    h('span', { class: 'nav-label' }, v.label),
    inIcon ? null : badge,
  );
}

function renderShell() {
  ui.soundBtn = h('button', { type: 'button', class: 'side-link', onclick: toggleSound });
  renderSound();
  const sideLink = (emoji, label, attrs) => h(attrs.href ? 'a' : 'button', { class: 'side-link', ...(attrs.href ? {} : { type: 'button' }), ...attrs }, h('span', { class: 'side-link-ic' }, emoji), h('span', null, label));

  ui.side = h(
    'aside',
    { class: 'side', 'aria-label': 'Menú', tabindex: '-1' },
    h('div', { class: 'flagbar' }),
    h('div', { class: 'side-head' }, brand('Administración'), h('button', { type: 'button', class: 'icon-btn side-close', 'aria-label': 'Cerrar menú', onclick: closeNav }, icon('x', 18))),
    h(
      'nav',
      { class: 'side-nav' },
      h('div', { class: 'nav-group' }, 'Operación'),
      VIEWS.filter((v) => v.group === 'op').map((v) => navLink(v, 'nav-item')),
      h('div', { class: 'nav-group' }, 'Sistema'),
      VIEWS.filter((v) => v.group === 'sys').map((v) => navLink(v, 'nav-item')),
    ),
    h(
      'div',
      { class: 'side-foot' },
      h('div', { class: 'me' }, avatar(state.me.username, 38), h('div', { class: 'me-text' }, h('div', { class: 'me-name' }, state.me.username), h('div', { class: 'me-role' }, '👑 Administrador'))),
      sideLink('🎮', 'Ir al juego', { href: '/' }),
      sideLink('🔐', 'Verificación pública', { href: '/fair', target: '_blank', rel: 'noopener' }),
      sideLink('🔑', 'Cambiar contraseña', { onclick: changeOwnPassword }),
      ui.soundBtn,
      sideLink('🚪', 'Cerrar sesión', { onclick: logout, class: 'side-link side-link-danger' }),
    ),
  );

  const pill = livePill();
  ui.onlineN = h('span', null, '0');
  ui.conn = h('span', { class: 'conn conn-connecting', title: 'Conectando…' }, h('span', { class: 'conn-dot' }), h('span', { class: 'conn-text' }, 'Conectando'));
  const today = new Date().toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long' });
  ui.title = h('div', { class: 'top-title' }, `Hola, ${state.me.username} 👋`, h('span', { class: 'top-date' }, today));
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'top-brand', href: '#/inicio', 'aria-label': 'Ir al inicio' }, h('span', { class: 'brand-mark sm', 'aria-hidden': 'true' }, '🚀'), brandName(true), h('span', { class: 'chip chip-gold top-admin' }, 'ADMIN')),
    ui.title,
    h(
      'div',
      { class: 'top-right' },
      pill.el,
      h('a', { class: 'top-pill', href: '#/inicio', title: 'Jugadores en línea' }, icon('users', 15), ui.onlineN),
      ui.conn,
      h(
        'div',
        { class: 'top-links' },
        h('a', { class: 'btn btn-ghost btn-sm top-link', href: '/', title: 'Ir al juego' }, h('span', { 'aria-hidden': 'true' }, '🎮'), h('span', { class: 'top-link-text' }, 'Ir al juego')),
        h(
          'a',
          { class: 'btn btn-ghost btn-sm top-link', href: '/fair', target: '_blank', rel: 'noopener', title: 'Provably fair (página pública)' },
          h('span', { 'aria-hidden': 'true' }, '🔐'),
          h('span', { class: 'top-link-text' }, 'Provably fair'),
        ),
      ),
    ),
  );

  ui.banners = h('div', { class: 'banners' });
  ui.view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  ui.more = h(
    'button',
    { type: 'button', class: 'bnav-item bnav-more', 'aria-label': 'Más secciones', onclick: openNav },
    h('span', { class: 'nav-ic' }, icon('menu', 22)),
    h('span', { class: 'nav-label' }, 'Más'),
  );
  const bnav = h('nav', { class: 'bnav', 'aria-label': 'Secciones' }, VIEWS.filter((v) => v.bottom).map((v) => navLink(v, 'bnav-item')), ui.more);
  const scrim = h('div', { class: 'scrim', onclick: closeNav });

  app.replaceChildren(h('div', { class: 'shell' }, ui.side, h('div', { class: 'main' }, topbar, ui.banners, ui.view)), bnav, scrim);
  for (const a of ui.side.querySelectorAll('a.nav-item')) a.addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav();
  });
}

function setConn(s) {
  if (state.conn === s) return;
  state.conn = s;
  const text = { ok: 'En vivo', connecting: 'Conectando', retry: 'Reconectando', down: 'Sin conexión' }[s];
  ui.conn.className = `conn conn-${s}`;
  ui.conn.title = s === 'ok' ? 'Conectado en tiempo real' : text;
  setText(ui.conn.querySelector('.conn-text'), text);
  renderBanners();
}

let bannerKey = '';
function renderBanners() {
  if (!ui.banners) return;
  const ps = game.phase ? pauseState() : 'running';
  const lost = state.conn === 'retry' || state.conn === 'down';
  const key = `${ps}|${lost}`;
  if (key === bannerKey) return;
  bannerKey = key;
  const items = [];
  if (ps !== 'running') {
    items.push(
      h(
        'div',
        { class: `banner banner-${ps}` },
        h('span', { class: 'banner-ic' }, ps === 'paused' ? '⏸️' : '⏳'),
        h(
          'span',
          { class: 'banner-text' },
          h('b', null, ps === 'paused' ? 'El juego está pausado.' : 'El juego se pausa al terminar esta ronda.'),
          ps === 'paused' ? ' Nadie puede apostar hasta que lo reanudes.' : ' La ronda en curso termina normalmente.',
        ),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: togglePause }, icon('play', 15), ps === 'paused' ? 'Reanudar' : 'Cancelar pausa'),
      ),
    );
  }
  if (lost) {
    items.push(
      h(
        'div',
        { class: 'banner banner-conn' },
        h('span', { class: 'banner-ic' }, '📡'),
        h('span', { class: 'banner-text' }, h('b', null, 'Sin conexión en tiempo real.'), ' Reintentando… los números pueden estar desactualizados.'),
      ),
    );
  }
  ui.banners.replaceChildren(...items);
}

function renderBadges() {
  const set = (list, n) => {
    for (const b of list) {
      b.textContent = n > 99 ? '99+' : String(n);
      b.hidden = !n;
    }
  };
  set(badges.deposits, state.pending.deposits.n);
  set(badges.withdrawals, state.pending.withdrawals.n);
  const n = state.pending.deposits.n + state.pending.withdrawals.n;
  const title = `${n > 0 ? `(${n}) ` : ''}Admin · ${state.settings.site_name || 'CrashPY'}`;
  if (document.title !== title) document.title = title;
}

// ───────────────────────── Navegación ─────────────────────────

function route(force = false) {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0] || 'inicio';
  const v = VIEWS.find((x) => x.path === path) || VIEWS[0];
  closeNav();
  if (!force && current === v) return;
  if (current) {
    try {
      current.mod.unmount?.();
    } catch (err) {
      console.error(err);
    }
  }
  current = v;
  ui.view.replaceChildren();
  ui.view.className = `view view-${v.id}`;
  try {
    v.mod.mount(ui.view);
  } catch (err) {
    console.error(err);
    ui.view.replaceChildren(errorState(err));
  }
  for (const a of document.querySelectorAll('[data-view]')) {
    const on = a.dataset.view === v.id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  ui.more.classList.toggle('active', !v.bottom);
  window.scrollTo(0, 0);
}

// ───────────────────────── Tiempo real ─────────────────────────

function notifyNew(kind, row) {
  const p = state.pending[kind === 'deposit' ? 'deposits' : 'withdrawals'];
  p.n += 1;
  p.total += row.amount || 0;
  renderBadges();
  if (kind === 'deposit') {
    toast(`${row.username} informó ${fmtGs(row.amount)}${row.reference ? ` · ref. ${row.reference}` : ''}`, 'success', '💰 Nuevo depósito');
  } else {
    toast(`${row.username} pidió retirar ${fmtGs(row.amount)}`, 'win', '🏦 Nuevo retiro');
  }
  beep(kind);
  if (sound.unlocked && navigator.vibrate) {
    try {
      navigator.vibrate(kind === 'deposit' ? [70, 50, 70] : [150]);
    } catch {
      /* ignorar */
    }
  }
}

function connect() {
  const adminSock = io('/admin');
  const gameSock = io('/');
  sockets = { adminSock, gameSock };
  state.gameSock = gameSock;
  initGame(gameSock);

  let everConnected = false;
  const refresh = () => {
    if (adminSock.connected && gameSock.connected) {
      everConnected = true;
      setConn('ok');
    } else setConn(everConnected ? 'retry' : 'connecting');
  };
  for (const s of [adminSock, gameSock]) {
    s.on('connect', refresh);
    s.on('disconnect', (reason) => {
      refresh();
      // Si el servidor cortó la conexión a propósito, socket.io no reintenta solo.
      if (reason === 'io server disconnect' && !authLost) setTimeout(() => s.connect(), 1500);
    });
  }
  adminSock.on('connect', () => {
    adminRetries = 0;
  });
  adminSock.on('connect_error', (err) => {
    if (/autorizado/i.test(err && err.message)) onAuthLost();
    else refresh();
  });

  adminSock.on('stats', (s) => {
    state.stats = s;
    state.online = s.onlineUsers || [];
    state.connections = s.connections || 0;
    if (s.pending) state.pending = s.pending;
    setText(ui.onlineN, fmtNum(state.online.length));
    renderBadges();
    bus.emit('stats', s);
  });
  adminSock.on('deposit:new', (d) => {
    notifyNew('deposit', d);
    bus.emit('deposit:new', d);
  });
  adminSock.on('withdraw:new', (w) => {
    notifyNew('withdraw', w);
    bus.emit('withdraw:new', w);
  });
  adminSock.on('deposit:update', (d) => bus.emit('deposit:update', d));
  adminSock.on('withdraw:update', (w) => bus.emit('withdraw:update', w));
  adminSock.on('activity', (a) => {
    state.activity.unshift(a);
    if (state.activity.length > 100) state.activity.length = 100;
    bus.emit('activity', a);
  });
  adminSock.on('presence', (p) => bus.emit('presence', p));
  adminSock.on('roundEnd', (d) => bus.emit('roundEnd', d));
  adminSock.on('doubleEnd', (d) => bus.emit('doubleEnd', d));
  adminSock.on('feed', (batch) => {
    if (!Array.isArray(batch)) return;
    for (const f of batch) state.feed.unshift(f);
    if (state.feed.length > 60) state.feed.length = 60;
    bus.emit('feed', batch);
  });

  gameSock.on('chat', (m) => bus.emit('chat', m));
  gameSock.on('chatDelete', (d) => bus.emit('chatDelete', d));
  gameSock.on('chatClear', () => bus.emit('chatClear'));
  gameSock.on('settings', (s) => {
    Object.assign(state.settings, s);
    renderBadges();
    bus.emit('settings', s);
  });
}

// ───────────────────────── Arranque ─────────────────────────

function startApp() {
  started = true;
  renderShell();
  connect();
  bus.on('game:state', renderBanners);
  bus.on('auth:lost', onAuthLost);
  bus.on('route:reload', () => route(true));
  window.addEventListener('hashchange', () => route());
  route();
  renderBadges();
}

async function boot() {
  let cfg;
  try {
    cfg = await api('/api/config');
  } catch (err) {
    renderFatal(err);
    return;
  }
  state.settings = cfg.settings || {};
  if (!cfg.user) return renderLogin();
  if (cfg.user.role !== 'admin') return renderForbidden(cfg.user);
  state.me = cfg.user;
  if (!started) startApp();
}

boot();
