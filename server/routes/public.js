'use strict';
const express = require('express');
const { AppError, cleanText, clientIp, startOfDay } = require('../util');
const { hashPassword, verifyPassword, requireUser, publicUser } = require('../auth');

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,16}$/;
const DAY = 86_400_000;

module.exports = function publicRoutes(ctx) {
  const { db, auth, wallet, settings, chains, bus, limiter } = ctx;
  const router = express.Router();
  const ipOf = (req) => clientIp(req.headers, req.socket.remoteAddress);

  router.get('/config', (req, res) => {
    res.json({ settings: settings.publicAll(), fair: chains.summary(), user: publicUser(req.user) });
  });

  // ───────────────────────── Cuentas ─────────────────────────

  router.post('/auth/register', async (req, res) => {
    const body = req.body || {};
    const ip = ipOf(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const phone = cleanText(body.phone, 20);
    if (!USERNAME_RE.test(username)) {
      throw new AppError('El usuario debe tener de 3 a 16 caracteres (letras, números, punto o guion bajo)');
    }
    if (password.length < 6) throw new AppError('La contraseña debe tener al menos 6 caracteres');
    if (password.length > 100) throw new AppError('La contraseña es demasiado larga');
    if (phone && !/^[+\d\s()-]{6,20}$/.test(phone)) throw new AppError('Número de teléfono inválido');
    if (body.adult !== true) throw new AppError('Tenés que confirmar que sos mayor de 18 años');
    if (db.get('SELECT id FROM users WHERE username = ?', username)) throw new AppError('Ese usuario ya existe, elegí otro', 409);
    // Límite generoso: en Paraguay muchas conexiones móviles comparten IP (CGNAT)
    if (!limiter.hit('reg:' + ip, 20, 3600_000)) throw new AppError('Demasiados registros desde tu conexión. Probá más tarde.', 429);

    const passHash = await hashPassword(password);
    const now = Date.now();
    let userId;
    try {
      const r = db.run(
        `INSERT INTO users (username, pass_hash, phone, role, created_at, created_ip, last_seen, last_ip)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
        username,
        passHash,
        phone || null,
        now,
        ip,
        now,
        ip,
      );
      userId = Number(r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new AppError('Ese usuario ya existe, elegí otro', 409);
      throw err;
    }
    const bonus = settings.get('signup_bonus');
    if (bonus > 0) wallet.change(userId, bonus, 'bonus', { note: 'Bono de bienvenida 🎁' });
    const token = auth.createSession(userId, ip, req.headers['user-agent']);
    auth.setCookie(req, res, token);
    bus.emit('activity', { kind: 'register', text: `🆕 Nuevo jugador: ${username}`, userId });
    res.json({ user: publicUser(db.get('SELECT * FROM users WHERE id = ?', userId)) });
  });

  router.post('/auth/login', async (req, res) => {
    const body = req.body || {};
    const ip = ipOf(req);
    const username = String(body.username || '').trim().slice(0, 32);
    const password = String(body.password || '');
    const userKey = 'login-u:' + username.toLowerCase();
    if (!limiter.hit('login-ip:' + ip, 100, 15 * 60_000) || !limiter.hit(userKey, 10, 15 * 60_000)) {
      throw new AppError('Demasiados intentos. Esperá unos minutos y probá de nuevo.', 429);
    }
    const user = username ? db.get('SELECT * FROM users WHERE username = ?', username) : null;
    const ok = user ? await verifyPassword(password, user.pass_hash) : false;
    if (!user || !ok) throw new AppError('Usuario o contraseña incorrectos', 401);
    if (user.banned) throw new AppError('Tu cuenta está suspendida. Contactá al soporte.', 403);
    limiter.reset(userKey);
    db.run('UPDATE users SET last_seen = ?, last_ip = ? WHERE id = ?', Date.now(), ip, user.id);
    const token = auth.createSession(user.id, ip, req.headers['user-agent']);
    auth.setCookie(req, res, token);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    auth.destroyToken(auth.tokenFromRequest(req));
    auth.clearCookie(req, res);
    res.json({ ok: true });
  });

  // ───────────────────────── Mi cuenta ─────────────────────────

  router.get('/me', requireUser, (req, res) => {
    const u = req.user;
    res.json({
      user: publicUser(u),
      stats: {
        total_bet: u.total_bet,
        total_won: u.total_won,
        bets_count: u.bets_count,
        best_cashout: u.best_cashout,
        total_deposit: u.total_deposit,
        total_withdraw: u.total_withdraw,
      },
    });
  });

  router.post('/me/password', requireUser, async (req, res) => {
    const { current, password } = req.body || {};
    if (!(await verifyPassword(String(current || ''), req.user.pass_hash))) {
      throw new AppError('La contraseña actual no es correcta', 401);
    }
    const next = String(password || '');
    if (next.length < 6) throw new AppError('La nueva contraseña debe tener al menos 6 caracteres');
    if (next.length > 100) throw new AppError('La contraseña es demasiado larga');
    db.run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashPassword(next), req.user.id);
    auth.destroyUserSessions(req.user.id, auth.tokenFromRequest(req));
    if (req.user.role === 'admin') {
      db.run(
        "INSERT INTO audit (admin_id, admin_name, action, target_user_id, details, ip, created_at) VALUES (?, ?, 'own_password', ?, NULL, ?, ?)",
        req.user.id,
        req.user.username,
        req.user.id,
        ipOf(req),
        Date.now(),
      );
    }
    res.json({ ok: true });
  });

  router.get('/me/ledger', requireUser, (req, res) => {
    const items = db.all(
      'SELECT id, type, amount, balance_after, ref_id, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      req.user.id,
    );
    res.json({ items });
  });

  router.get('/me/bets', requireUser, (req, res) => {
    const rows = db.all(
      `SELECT b.id, b.round_id, b.slot, b.amount, b.auto_cashout, b.cashout, b.payout, b.status, b.created_at,
              r.status AS round_status, r.crash_point, r.ended_multiplier
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE b.user_id = ? AND b.status IN ('active', 'won', 'lost', 'refunded')
       ORDER BY b.id DESC LIMIT 50`,
      req.user.id,
    );
    // Nunca revelar el punto de explosión de una ronda que no terminó
    const items = rows.map((r) => {
      const ended = r.round_status === 'crashed' || r.round_status === 'cancelled';
      return {
        id: r.id,
        round_id: r.round_id,
        slot: r.slot,
        amount: r.amount,
        auto_cashout: r.auto_cashout,
        cashout: r.cashout,
        payout: r.payout,
        status: r.status,
        created_at: r.created_at,
        round_status: r.round_status,
        crash: ended ? (r.round_status === 'crashed' ? r.crash_point : r.ended_multiplier) : null,
      };
    });
    res.json({ items });
  });

  // ───────────────────────── Billetera ─────────────────────────

  router.get('/wallet/info', requireUser, (req, res) => {
    res.json({ bank: settings.bankInfo(), balance: req.user.balance });
  });

  router.post('/wallet/deposit', requireUser, (req, res) => {
    if (!limiter.hit('dep:' + req.user.id, 10, 3600_000)) {
      throw new AppError('Hiciste muchas solicitudes seguidas, esperá un rato', 429);
    }
    const d = wallet.createDeposit(req.user, req.body || {});
    res.json({ deposit: { id: d.id, amount: d.amount, status: d.status, created_at: d.created_at } });
  });

  router.post('/wallet/withdraw', requireUser, (req, res) => {
    if (!limiter.hit('wd:' + req.user.id, 10, 3600_000)) {
      throw new AppError('Hiciste muchas solicitudes seguidas, esperá un rato', 429);
    }
    const w = wallet.createWithdrawal(req.user, req.body || {});
    res.json({ withdrawal: { id: w.id, amount: w.amount, status: w.status, created_at: w.created_at }, balance: wallet.balanceOf(req.user.id) });
  });

  router.get('/wallet/requests', requireUser, (req, res) => {
    const deposits = db.all(
      'SELECT id, amount, credited, reference, status, admin_note, created_at, processed_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 30',
      req.user.id,
    );
    const withdrawals = db.all(
      'SELECT id, amount, bank, account, holder, status, admin_note, created_at, processed_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30',
      req.user.id,
    );
    res.json({ deposits, withdrawals });
  });

  // ───────────────────────── Rondas y provably fair ─────────────────────────

  router.get('/rounds', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = db.all(
      `SELECT id, chain_id, chain_index, hash, crash_point, ended_multiplier, status, cancel_mode, ended_at, total_bet, total_payout, players
       FROM rounds WHERE status IN ('crashed', 'cancelled') ORDER BY id DESC LIMIT ?`,
      limit,
    );
    res.json({ items });
  });

  router.get('/rounds/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = Number.isFinite(id) ? db.get('SELECT * FROM rounds WHERE id = ?', id) : null;
    if (!r) throw new AppError('Ronda no encontrada', 404);
    const ended = r.status === 'crashed' || r.status === 'cancelled';
    if (!ended) return res.json({ round: { id: r.id, status: r.status } });
    const chain = db.get('SELECT id, salt, house_edge_bps, terminal_hash, length FROM chains WHERE id = ?', r.chain_id);
    const previous = db.get(
      "SELECT id, hash FROM rounds WHERE chain_id = ? AND chain_index = ? AND status IN ('crashed', 'cancelled')",
      r.chain_id,
      r.chain_index - 1,
    );
    const bets = db.all(
      `SELECT b.id, b.slot, b.amount, b.cashout, b.payout, b.status, u.username AS user
       FROM bets b JOIN users u ON u.id = b.user_id
       WHERE b.round_id = ? AND b.status IN ('won', 'lost', 'refunded')
       ORDER BY b.amount DESC LIMIT 300`,
      r.id,
    );
    res.json({
      round: {
        id: r.id,
        chain_id: r.chain_id,
        chain_index: r.chain_index,
        hash: r.hash,
        crash_point: r.crash_point,
        ended_multiplier: r.ended_multiplier,
        status: r.status,
        cancel_mode: r.cancel_mode,
        started_at: r.started_at,
        ended_at: r.ended_at,
        total_bet: r.total_bet,
        total_payout: r.total_payout,
        players: r.players,
      },
      chain,
      previous: previous || null,
      bets,
    });
  });

  router.get('/fair', (req, res) => {
    res.json(chains.publicInfo());
  });

  router.get('/top', (req, res) => {
    const periodName = req.query.period;
    const today = startOfDay();
    const since = periodName === 'week' ? today - 6 * DAY : periodName === 'month' ? today - 29 * DAY : today;
    const base = `SELECT b.round_id, b.amount, b.cashout, b.payout, u.username AS user
                  FROM bets b JOIN users u ON u.id = b.user_id
                  WHERE b.status = 'won' AND b.created_at >= ?`;
    const wins = db.all(`${base} ORDER BY (b.payout - b.amount) DESC LIMIT 15`, since);
    const multipliers = db.all(`${base} ORDER BY b.cashout DESC, b.payout DESC LIMIT 15`, since);
    const rounds = db.all(
      "SELECT id, crash_point FROM rounds WHERE status = 'crashed' AND ended_at >= ? ORDER BY crash_point DESC LIMIT 15",
      since,
    );
    res.json({ wins, multipliers, rounds });
  });

  return router;
};
