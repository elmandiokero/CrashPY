'use strict';
const { AppError, clientIp, RateLimiter, fmtGs, fmtMult } = require('./util');
const { publicUser } = require('./auth');
const stats = require('./stats');

/**
 * Tiempo real con Socket.IO.
 *  - Namespace "/"      → jugadores y espectadores (juego, apuestas, chat).
 *  - Namespace "/admin" → solo administradores (estadísticas en vivo, avisos de depósitos/retiros, actividad).
 */
module.exports = function setupSockets(io, ctx) {
  const { db, auth, engine, chat, bus, settings, chains } = ctx;
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
  const onlinePayload = () => ({ n: io.of('/').sockets.size, users: online.size });
  const onlineTimer = setInterval(() => {
    if (!onlineDirty) return;
    onlineDirty = false;
    io.emit('online', onlinePayload());
  }, 3000);
  onlineTimer.unref();

  function snapshot(user) {
    return {
      serverTime: Date.now(),
      user: publicUser(user),
      settings: settings.publicAll(),
      fair: chains.summary(),
      game: engine.publicState(),
      mine: user ? engine.userBets(user.id) : [null, null],
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
        if (!limiter.hit('s:' + socket.id, 40, 10_000)) {
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

  // Eventos privados de cada usuario
  bus.on('balance', (userId, balance) => io.to('u:' + userId).emit('balance', { balance }));
  bus.on('myBet', (userId, bet) => io.to('u:' + userId).emit('myBet', bet));
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
    chat.system(`🔥 ${w.user} retiró a ${fmtMult(w.cashout)} y ganó ${fmtGs(w.payout)}`, 'win');
    bus.emit('activity', { kind: 'bigwin', text: `🔥 ${w.user} ganó ${fmtGs(w.payout)} (${fmtMult(w.cashout)}) en la ronda #${w.roundId}`, userId: w.userId });
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

  return { snapshot };
};
