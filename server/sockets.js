'use strict';
const { AppError, clientIp, RateLimiter, fmtGs, fmtMult } = require('./util');
const { publicUser } = require('./auth');
const stats = require('./stats');

const GAME_ICONS = { crash: '🚀', mines: '💣', penalty: '⚽', double: '🎡', plinko: '🔴', roulette: '🎰' };
const GAME_LABELS = { crash: 'el Crash', mines: 'Minas', penalty: 'los Penales', double: 'el Double', plinko: 'Plinko', roulette: 'la Ruleta' };
const FEED_SIZE = 30; // jugadas en vivo que se guardan para quien recién entra
const FEED_EVERY_MS = 600; // las jugadas se envían agrupadas para no saturar a los celulares
const ACTIONS_PER_10S = 80;

/**
 * Tiempo real con Socket.IO.
 *  - Namespace "/"      → jugadores y espectadores (juego, apuestas, chat).
 *  - Namespace "/admin" → solo administradores (estadísticas en vivo, avisos de depósitos/retiros, actividad).
 */
module.exports = function setupSockets(io, ctx) {
  const { db, auth, engine, chat, bus, settings, chains, plays, double, roulette, bots } = ctx;
  const limiter = new RateLimiter();
  const online = new Map(); // userId → { id, username, sockets, since, ip, ua }

  const loadUser = (id) => db.get('SELECT * FROM users WHERE id = ?', id);

  ctx.presence = {
    isOnline: (id) => online.has(id),
    list: () => [...online.values()],
    connections: () => io.of('/').sockets.size,
  };

  // ───────────────────────── Jugadores ─────────────────────────

  io.use((socket, next) => {
    const h = socket.request.headers;
    socket.data.ip = clientIp(h, socket.handshake.address);
    socket.data.ua = String(h['user-agent'] || '').slice(0, 160);
    const user = auth.userFromCookieHeader(h.cookie);
    socket.data.userId = user ? user.id : null;
    next();
  });

  let onlineDirty = true;
  const onlinePayload = () => ({ n: io.of('/').sockets.size, users: online.size, bots: bots.activeCount() });
  const onlineTimer = setInterval(() => {
    if (!onlineDirty) return;
    onlineDirty = false;
    io.emit('online', onlinePayload());
  }, 3000);
  onlineTimer.unref();

  // Jugadas en vivo de todos los juegos (se envían en tandas)
  const recentFeed = [];
  let feedQueue = [];
  bus.on('feed', (item) => {
    feedQueue.push(item);
    recentFeed.unshift(item);
    if (recentFeed.length > FEED_SIZE) recentFeed.length = FEED_SIZE;
  });
  const feedTimer = setInterval(() => {
    if (!feedQueue.length) return;
    const batch = feedQueue.slice(-FEED_SIZE);
    feedQueue = [];
    io.emit('feed', batch);
    // El panel de admin solo ve jugadas reales (los bots tienen su propia sección)
    const real = batch.filter((f) => !f.bot);
    if (real.length) io.of('/admin').emit('feed', real);
  }, FEED_EVERY_MS);
  feedTimer.unref();

  /** Suma las apuestas de los bots (marcadas con bot: true) al estado público de un juego. */
  const withBots = (state, botBets) => (botBets.length ? { ...state, bets: [...state.bets, ...botBets] } : state);

  function snapshot(user) {
    return {
      serverTime: Date.now(),
      user: publicUser(user),
      settings: settings.publicAll(),
      fair: chains.summary(),
      game: withBots(engine.publicState(), bots.crashBets()),
      mine: user ? engine.userBets(user.id) : [null, null],
      double: withBots(double.publicState(), bots.doubleBets()),
      myDouble: user ? double.userBets(user.id) : null,
      roulette: withBots(roulette.publicState(), bots.rouletteBets()),
      myRoulette: user ? roulette.userBets(user.id) : null,
      plays: user ? plays.activePlays(user.id) : { mines: null, penalty: null },
      feed: recentFeed,
      chat: chat.recent,
      online: onlinePayload(),
    };
  }

  io.on('connection', (socket) => {
    onlineDirty = true;
    const uid = socket.data.userId;
    const user = uid ? loadUser(uid) : null;
    if (user) {
      socket.join('u:' + user.id);
      const entry = online.get(user.id);
      if (entry) entry.sockets++;
      else {
        online.set(user.id, {
          id: user.id,
          username: user.username,
          sockets: 1,
          since: Date.now(),
          ip: socket.data.ip,
          ua: socket.data.ua,
        });
        bus.emit('presence', { id: user.id, username: user.username, online: true });
      }
      db.run('UPDATE users SET last_seen = ?, last_ip = ? WHERE id = ?', Date.now(), socket.data.ip, user.id);
    }
    socket.emit('init', snapshot(user));

    /** Registra un evento que requiere sesión y responde por "ack". */
    const handle = (name, fn) => {
      socket.on(name, (data, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!limiter.hit('s:' + socket.id, ACTIONS_PER_10S, 10_000)) {
          reply({ ok: false, error: 'Demasiadas acciones seguidas, esperá un momento' });
          return;
        }
        try {
          if (!socket.data.userId) throw new AppError('Iniciá sesión para jugar', 401, 'AUTH');
          const fresh = loadUser(socket.data.userId);
          if (!fresh || fresh.banned) {
            socket.disconnect(true);
            throw new AppError('Tu cuenta está suspendida', 403, 'BANNED');
          }
          const result = fn(fresh, data && typeof data === 'object' ? data : {});
          reply({ ok: true, ...result });
        } catch (err) {
          if (!(err instanceof AppError)) console.error(`[socket:${name}]`, err);
          reply({ ok: false, error: err instanceof AppError ? err.message : 'Error interno, probá de nuevo', code: err.code });
        }
      });
    };

    const slotOf = (d) => (Number(d.slot) === 1 ? 1 : 0);

    handle('bet', (u, d) => {
      const bet = engine.placeBet(u.id, d);
      return { bet: engine.privateBet(bet), balance: ctx.wallet.balanceOf(u.id) };
    });
    handle('cancelBet', (u, d) => {
      const bet = engine.cancelBet(u.id, slotOf(d));
      return { bet: engine.privateBet(bet), balance: ctx.wallet.balanceOf(u.id) };
    });
    handle('cashout', (u, d) => {
      const bet = engine.cashout(u.id, slotOf(d));
      return { bet: engine.privateBet(bet), balance: ctx.wallet.balanceOf(u.id) };
    });
    handle('chat', (u, d) => {
      chat.post(u, d.text);
      return {};
    });

    // Juegos individuales: la respuesta trae la jugada y el saldo final
    const balanceOf = (u) => ctx.wallet.balanceOf(u.id);
    const playHandler = (name, method) =>
      handle(name, (u, d) => {
        const play = plays[method](u.id, d);
        return { play, balance: balanceOf(u) };
      });
    handle('plays:active', (u) => ({ plays: plays.activePlays(u.id) }));
    playHandler('mines:start', 'minesStart');
    playHandler('mines:reveal', 'minesReveal');
    playHandler('mines:cashout', 'minesCashout');
    playHandler('penalty:start', 'penaltyStart');
    playHandler('penalty:kick', 'penaltyKick');
    playHandler('penalty:cashout', 'penaltyCashout');
    playHandler('plinko:drop', 'plinkoDrop');
    // Juegos en vivo: la respuesta trae mis apuestas de la ronda y el saldo
    handle('double:bet', (u, d) => ({ mine: double.placeBet(u.id, d), balance: balanceOf(u) }));
    handle('roulette:bet', (u, d) => ({ mine: roulette.placeBet(u.id, d), balance: balanceOf(u) }));

    socket.on('disconnect', () => {
      onlineDirty = true;
      if (!uid) return;
      const entry = online.get(uid);
      if (entry && --entry.sockets <= 0) {
        online.delete(uid);
        bus.emit('presence', { id: uid, username: entry.username, online: false });
        db.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), uid);
      }
    });
  });

  // Motor del juego → todos
  engine.on('betting', (d) => io.emit('betting', d));
  engine.on('start', (d) => io.emit('start', d));
  engine.on('tick', (d) => io.volatile.emit('tick', d));
  engine.on('crash', (d) => io.emit('crash', d));
  engine.on('bet', (d) => io.emit('bet', d));
  engine.on('cashout', (d) => io.emit('cashout', d));
  engine.on('betCancel', (d) => io.emit('betCancel', d));
  engine.on('betRefund', (d) => io.emit('betRefund', d));
  engine.on('paused', (d) => io.emit('paused', d));

  // Double y Ruleta → todos
  for (const name of ['betting', 'bet', 'spin', 'result', 'refund', 'paused']) {
    double.on(name, (d) => io.emit('double:' + name, d));
    roulette.on(name, (d) => io.emit('roulette:' + name, d));
  }

  // Bots → mismos eventos que los jugadores, siempre con bot: true y 🤖 en el nombre
  bots.on('crash:bet', (b) => io.emit('bet', b));
  bots.on('crash:cashout', (d) => io.emit('cashout', d));
  bots.on('crash:refund', (d) => io.emit('betRefund', d));
  bots.on('double:bet', (b) => io.emit('double:bet', b));
  bots.on('roulette:bet', (b) => io.emit('roulette:bet', b));
  bots.on('online', () => {
    onlineDirty = true;
  });

  // Eventos privados de cada usuario
  bus.on('balance', (userId, balance) => io.to('u:' + userId).emit('balance', { balance }));
  bus.on('myBet', (userId, bet) => io.to('u:' + userId).emit('myBet', bet));
  bus.on('myDouble', (userId, d) => io.to('u:' + userId).emit('myDouble', d));
  bus.on('myRoulette', (userId, d) => io.to('u:' + userId).emit('myRoulette', d));
  bus.on('notify', (userId, n) => io.to('u:' + userId).emit('notify', n));
  bus.on('userUpdate', (userId) => {
    const u = loadUser(userId);
    if (u) io.to('u:' + userId).emit('me', publicUser(u));
  });
  bus.on('kick', (userId, reason = 'Tu cuenta fue suspendida.') => {
    io.to('u:' + userId).emit('notify', { kind: 'error', title: 'Sesión cerrada', text: reason });
    io.in('u:' + userId).disconnectSockets(true);
    io.of('/admin').in('u:' + userId).disconnectSockets(true);
  });

  // Chat y configuración
  bus.on('chat', (m) => io.emit('chat', m));
  bus.on('chatDelete', (id) => io.emit('chatDelete', { id }));
  bus.on('chatClear', () => io.emit('chatClear'));
  bus.on('settings', (s) => io.emit('settings', s));

  // Ganancias grandes → mensaje en el chat
  bus.on('bigwin', (w) => {
    const game = GAME_ICONS[w.game] ? w.game : 'crash';
    if (game === 'crash') {
      chat.system(`🔥 ${w.user} retiró a ${fmtMult(w.cashout)} y ganó ${fmtGs(w.payout)}`, 'win');
      bus.emit('activity', { kind: 'bigwin', text: `🔥 ${w.user} ganó ${fmtGs(w.payout)} (${fmtMult(w.cashout)}) en la ronda #${w.roundId}`, userId: w.userId });
      return;
    }
    const icon = GAME_ICONS[game];
    chat.system(`${icon} ${w.user} ganó ${fmtGs(w.payout)} (${fmtMult(w.cashout)}) en ${GAME_LABELS[game]}`, 'win');
    bus.emit('activity', {
      kind: 'bigwin',
      text: `${icon} ${w.user} ganó ${fmtGs(w.payout)} (${fmtMult(w.cashout)}) en ${GAME_LABELS[game]} #${w.roundId}`,
      userId: w.userId,
    });
  });

  // ───────────────────────── Administradores ─────────────────────────

  const adminNs = io.of('/admin');
  adminNs.use((socket, next) => {
    const user = auth.userFromCookieHeader(socket.request.headers.cookie);
    if (!user || user.role !== 'admin') return next(new Error('No autorizado'));
    socket.data.userId = user.id;
    next();
  });

  function onlineUsers() {
    const list = [...online.values()];
    if (!list.length) return [];
    const ids = list.map((o) => o.id);
    const rows = db.all(
      `SELECT id, balance, role, muted FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ...ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const inRound = new Map();
    for (const b of engine.bets.values()) {
      if (b.status === 'cancelled' || b.status === 'refunded') continue;
      inRound.set(b.userId, (inRound.get(b.userId) || 0) + b.amount);
    }
    for (const b of [...double.bets.values(), ...roulette.bets.values()]) {
      if (b.status === 'refunded') continue;
      inRound.set(b.userId, (inRound.get(b.userId) || 0) + b.amount);
    }
    return list
      .map(({ ua, ...o }) => ({
        ...o,
        balance: byId.get(o.id)?.balance ?? 0,
        role: byId.get(o.id)?.role ?? 'user',
        muted: !!byId.get(o.id)?.muted,
        betting: inRound.get(o.id) || 0,
      }))
      .sort((a, b) => b.betting - a.betting || b.balance - a.balance);
  }

  function liveStats() {
    return {
      ts: Date.now(),
      connections: io.of('/').sockets.size,
      onlineUsers: onlineUsers(),
      game: engine.adminState(),
      double: double.adminState(),
      roulette: roulette.adminState(),
      pending: stats.pending(db),
    };
  }

  adminNs.on('connection', (socket) => {
    socket.join('u:' + socket.data.userId);
    socket.emit('stats', liveStats());
  });

  const statsTimer = setInterval(() => {
    if (!adminNs.sockets.size) return;
    // Si a alguien le quitaron el rol, lo suspendieron o cerró sesión, deja de recibir datos de admin
    for (const s of adminNs.sockets.values()) {
      const u = auth.userFromCookieHeader(s.request.headers.cookie);
      if (!u || u.role !== 'admin' || u.id !== s.data.userId) s.disconnect(true);
    }
    if (adminNs.sockets.size) adminNs.emit('stats', liveStats());
  }, 1500);
  statsTimer.unref();

  for (const name of ['deposit:new', 'deposit:update', 'withdraw:new', 'withdraw:update', 'presence']) {
    bus.on(name, (payload) => adminNs.emit(name, payload));
  }
  bus.on('activity', (a) => adminNs.emit('activity', { ...a, ts: Date.now() }));
  engine.on('crash', (d) => adminNs.emit('roundEnd', d));
  double.on('result', (d) => adminNs.emit('doubleEnd', d));
  roulette.on('result', (d) => adminNs.emit('rouletteEnd', d));

  return { snapshot };
};
