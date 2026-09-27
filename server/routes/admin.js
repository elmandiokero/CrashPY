'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { AppError, cleanText, clientIp, fmtGs, fmtMult } = require('../util');
const { hashPassword, requireAdmin } = require('../auth');
const stats = require('../stats');
const core = require('../../public/js/games-core.js');

const PAGE = 50;
const USER_SORTS = {
  id: 'id',
  username: 'username',
  balance: 'balance',
  created: 'created_at',
  seen: 'last_seen',
  bet: 'total_bet',
  deposit: 'total_deposit',
  withdraw: 'total_withdraw',
  profit: '(total_bet - total_won)',
};

const toId = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('Identificador inválido');
  return n;
};
const pageOf = (req) => Math.max(0, (parseInt(req.query.page, 10) || 1) - 1);

const parseJSON = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};
const COLOR_NAMES = { red: '🔴 rojo', black: '⚫ negro', white: '⚪ blanco' };
const RISK_NAMES = { low: 'bajo', medium: 'medio', high: 'alto' };
const GAME_KEYS = new Set(['mines', 'penalty', 'plinko', 'roulette', 'double']);

/** Jugadas de todos los juegos (menos el Crash, que tiene su propia tabla) con la misma forma. */
const UNIFIED_PLAYS = `
  SELECT p.id, p.game, p.user_id, p.amount, p.multiplier, p.payout, p.status, p.created_at, p.ended_at,
         p.params, p.state, p.result, NULL AS color, NULL AS round_id, NULL AS round_result
  FROM plays p
  UNION ALL
  SELECT d.id, 'double', d.user_id, d.amount,
         CASE WHEN d.status = 'won' THEN (d.payout * 100) / d.amount ELSE 0 END,
         d.payout, d.status, d.created_at, r.ended_at, NULL, NULL, NULL, d.color, d.round_id,
         CASE WHEN r.status IN ('spinning', 'ended', 'cancelled') THEN r.result END
  FROM double_bets d JOIN double_rounds r ON r.id = d.round_id`;

/** Resumen corto de la jugada para las tablas del panel (nunca muestra el resultado de una partida en curso). */
function describePlay(row) {
  const params = parseJSON(row.params);
  const state = parseJSON(row.state);
  const result = parseJSON(row.result);
  switch (row.game) {
    case 'mines': {
      const n = (state.revealed || []).length - (state.hit !== undefined && state.hit !== null ? 1 : 0);
      return `${params.mines} minas · ${n} destapada${n === 1 ? '' : 's'}${state.hit !== undefined && state.hit !== null ? ' · 💥' : ''}`;
    }
    case 'penalty': {
      const kicks = state.kicks || [];
      const goals = kicks.filter((k) => k.goal).length;
      return `${goals} gol${goals === 1 ? '' : 'es'}${kicks.some((k) => !k.goal) ? ' · atajado 🧤' : ''}`;
    }
    case 'plinko':
      return `${params.rows} filas · riesgo ${RISK_NAMES[params.risk] || params.risk}`;
    case 'roulette': {
      const n = (params.bets || []).length;
      return `${n} apuesta${n === 1 ? '' : 's'}${row.status !== 'active' && result.number !== undefined ? ` · salió ${result.number}` : ''}`;
    }
    case 'double':
      return `${COLOR_NAMES[row.color] || row.color}${
        row.round_result !== null && row.round_result !== undefined ? ` · salió ${COLOR_NAMES[core.doubleColor(row.round_result)]}` : ''
      }`;
    default:
      return '';
  }
}

const playView = (row) => ({
  id: row.id,
  game: row.game,
  user_id: row.user_id,
  username: row.username,
  amount: row.amount,
  multiplier: row.multiplier,
  payout: row.payout,
  status: row.status,
  created_at: row.created_at,
  ended_at: row.ended_at,
  round_id: row.round_id,
  detail: describePlay(row),
});

module.exports = function adminRoutes(ctx) {
  const { db, auth, wallet, settings, chains, engine, chat, bus, double, doubleChains } = ctx;
  const router = express.Router();
  router.use(requireAdmin);

  const ipOf = (req) => clientIp(req.headers, req.socket.remoteAddress);

  /** Deja registro de toda acción administrativa. */
  function audit(req, action, targetUserId, details, text) {
    db.run(
      'INSERT INTO audit (admin_id, admin_name, action, target_user_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.user.id,
      req.user.username,
      action,
      targetUserId ?? null,
      details ? JSON.stringify(details) : null,
      ipOf(req),
      Date.now(),
    );
    if (text) bus.emit('activity', { kind: 'admin', text: `🛡️ ${req.user.username}: ${text}` });
  }

  const userName = (id) => db.get('SELECT username FROM users WHERE id = ?', id)?.username || `#${id}`;

  // ───────────────────────── Resumen ─────────────────────────

  router.get('/overview', (req, res) => {
    res.json({
      stats: stats.overview(db),
      charts: stats.charts(db),
      game: engine.adminState(),
      double: double.adminState(),
      fair: chains.summary(),
      doubleFair: doubleChains.summary(),
      online: ctx.presence ? ctx.presence.list().length : 0,
      connections: ctx.presence ? ctx.presence.connections() : 0,
    });
  });

  // ───────────────────────── Usuarios ─────────────────────────

  router.get('/users', (req, res) => {
    const q = cleanText(req.query.q, 40);
    const filter = String(req.query.filter || '');
    const sortKey = USER_SORTS[req.query.sort] ? req.query.sort : 'id';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const where = ['1 = 1'];
    const params = [];
    if (q) {
      where.push('(username LIKE ? OR phone LIKE ? OR last_ip LIKE ? OR created_ip LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (filter === 'banned') where.push('banned = 1');
    if (filter === 'muted') where.push('muted = 1');
    if (filter === 'admins') where.push("role = 'admin'");
    if (filter === 'balance') where.push('balance > 0');
    if (filter === 'online') {
      const ids = ctx.presence ? ctx.presence.list().map((o) => o.id) : [];
      if (!ids.length) return res.json({ items: [], total: 0, page: 1, pages: 1 });
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS c FROM users WHERE ${w}`, ...params).c;
    const page = pageOf(req);
    const items = db
      .all(
        `SELECT id, username, phone, role, balance, banned, muted, total_bet, total_won, total_deposit, total_withdraw,
                bets_count, best_cashout, created_at, last_seen, last_ip
         FROM users WHERE ${w} ORDER BY ${USER_SORTS[sortKey]} ${order}, id DESC LIMIT ? OFFSET ?`,
        ...params,
        PAGE,
        page * PAGE,
      )
      .map((u) => ({ ...u, online: ctx.presence ? ctx.presence.isOnline(u.id) : false }));
    res.json({ items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) });
  });

  router.get('/users/:id', (req, res) => {
    const id = toId(req.params.id);
    const user = db.get(
      `SELECT id, username, phone, role, balance, banned, muted, total_bet, total_won, total_deposit, total_withdraw,
              bets_count, best_cashout, note, created_at, created_ip, last_seen, last_ip
       FROM users WHERE id = ?`,
      id,
    );
    if (!user) throw new AppError('Usuario no encontrado', 404);
    const bets = db.all(
      `SELECT b.id, b.round_id, b.slot, b.amount, b.auto_cashout, b.cashout, b.payout, b.status, b.created_at,
              CASE WHEN r.status = 'crashed' THEN r.crash_point WHEN r.status = 'cancelled' THEN r.ended_multiplier END AS crash
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 60`,
      id,
    );
    const ledger = db.all(
      `SELECT l.id, l.type, l.amount, l.balance_after, l.ref_id, l.note, l.created_at, a.username AS admin
       FROM ledger l LEFT JOIN users a ON a.id = l.admin_id
       WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 150`,
      id,
    );
    const deposits = db.all('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 30', id);
    const withdrawals = db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30', id);
    const sessions = db.all(
      'SELECT created_at, expires_at, ip, ua FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
      id,
    );
    const games = db
      .all(`SELECT x.* FROM (${UNIFIED_PLAYS}) x WHERE x.user_id = ? ORDER BY x.created_at DESC, x.id DESC LIMIT 60`, id)
      .map(playView);
    const sameIp = user.last_ip
      ? db.all('SELECT id, username FROM users WHERE (last_ip = ? OR created_ip = ?) AND id != ? LIMIT 20', user.last_ip, user.last_ip, id)
      : [];
    res.json({
      user: { ...user, online: ctx.presence ? ctx.presence.isOnline(id) : false },
      bets,
      games,
      ledger,
      deposits,
      withdrawals,
      sessions,
      sameIp,
    });
  });

  router.post('/users/:id/balance', (req, res) => {
    const id = toId(req.params.id);
    const { op, amount, note } = req.body || {};
    const before = wallet.balanceOf(id);
    const result = wallet.adminAdjust(id, op, amount, note, req.user);
    audit(
      req,
      'balance',
      id,
      { op, amount, note, before, after: result.balance },
      `ajustó el saldo de ${userName(id)} (${result.delta >= 0 ? '+' : '−'}${fmtGs(Math.abs(result.delta))}) → ${fmtGs(result.balance)}`,
    );
    res.json(result);
  });

  router.post('/users/:id/flags', (req, res) => {
    const id = toId(req.params.id);
    const body = req.body || {};
    const u = db.get('SELECT id, username, role, banned, muted FROM users WHERE id = ?', id);
    if (!u) throw new AppError('Usuario no encontrado', 404);
    const changes = {};
    if (typeof body.banned === 'boolean') {
      if (id === req.user.id && body.banned) throw new AppError('No te podés suspender a vos mismo');
      changes.banned = body.banned ? 1 : 0;
    }
    if (typeof body.muted === 'boolean') changes.muted = body.muted ? 1 : 0;
    if (!Object.keys(changes).length) throw new AppError('Nada para cambiar');
    const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
    db.run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(changes), id);
    if (changes.banned === 1) {
      auth.destroyUserSessions(id);
      bus.emit('kick', id);
    }
    if ('muted' in changes) {
      bus.emit('userUpdate', id);
      bus.emit('notify', id, changes.muted
        ? { kind: 'error', title: 'Chat', text: 'Fuiste silenciado en el chat 🔇' }
        : { kind: 'info', title: 'Chat', text: 'Ya podés volver a escribir en el chat 🙂' });
    }
    const words = [];
    if ('banned' in changes) words.push(changes.banned ? 'suspendió' : 'reactivó');
    if ('muted' in changes) words.push(changes.muted ? 'silenció' : 'quitó el silencio a');
    audit(req, 'flags', id, changes, `${words.join(' y ')} a ${u.username}`);
    res.json({ ok: true, ...changes });
  });

  router.post('/users/:id/password', async (req, res) => {
    const id = toId(req.params.id);
    const password = String((req.body || {}).password || '');
    if (password.length < 6) throw new AppError('La contraseña debe tener al menos 6 caracteres');
    if (!db.get('SELECT id FROM users WHERE id = ?', id)) throw new AppError('Usuario no encontrado', 404);
    db.run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashPassword(password), id);
    if (id !== req.user.id) auth.destroyUserSessions(id);
    audit(req, 'password', id, null, `cambió la contraseña de ${userName(id)}`);
    res.json({ ok: true });
  });

  router.post('/users/:id/note', (req, res) => {
    const id = toId(req.params.id);
    const note = cleanText((req.body || {}).note, 500);
    if (!db.get('SELECT id FROM users WHERE id = ?', id)) throw new AppError('Usuario no encontrado', 404);
    db.run('UPDATE users SET note = ? WHERE id = ?', note || null, id);
    audit(req, 'note', id, { note });
    res.json({ ok: true });
  });

  router.post('/users/:id/role', (req, res) => {
    const id = toId(req.params.id);
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'user';
    if (id === req.user.id && role !== 'admin') throw new AppError('No te podés quitar el rol de admin a vos mismo');
    const u = db.get('SELECT id, username FROM users WHERE id = ?', id);
    if (!u) throw new AppError('Usuario no encontrado', 404);
    db.run('UPDATE users SET role = ? WHERE id = ?', role, id);
    auth.destroyUserSessions(id); // que vuelva a entrar con el rol nuevo
    bus.emit('kick', id, 'Tus permisos cambiaron. Volvé a ingresar.');
    audit(req, 'role', id, { role }, `${role === 'admin' ? 'hizo administrador a' : 'quitó el rol de admin a'} ${u.username}`);
    res.json({ ok: true, role });
  });

  // ───────────────────────── Depósitos ─────────────────────────

  function listRequests(table, req) {
    const status = String(req.query.status || 'pending');
    const q = cleanText(req.query.q, 40);
    const where = [];
    const params = [];
    if (status !== 'all') {
      where.push('t.status = ?');
      params.push(status);
    }
    if (q) {
      where.push('u.username LIKE ?');
      params.push(`%${q}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM ${table} t JOIN users u ON u.id = t.user_id ${w}`, ...params).c;
    const page = pageOf(req);
    const items = db.all(
      `SELECT t.*, u.username, u.balance AS user_balance, a.username AS admin_name
       FROM ${table} t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.admin_id
       ${w} ORDER BY t.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
      ...params,
      PAGE,
      page * PAGE,
    );
    return { items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) };
  }

  router.get('/deposits', (req, res) => res.json(listRequests('deposits', req)));

  router.get('/deposits/:id/receipt', (req, res) => {
    const d = db.get('SELECT receipt FROM deposits WHERE id = ?', toId(req.params.id));
    const file = d && wallet.receiptPath(d.receipt);
    if (!file) throw new AppError('Este depósito no tiene comprobante', 404);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  });

  router.post('/deposits/:id/approve', (req, res) => {
    const id = toId(req.params.id);
    const { amount, note } = req.body || {};
    const result = wallet.approveDeposit(id, req.user, { amount, note });
    const d = wallet.getDeposit(id);
    audit(req, 'deposit_approve', d.user_id, { id, credited: result.credited }, `aprobó el depósito #${id} de ${d.username} (${fmtGs(result.credited)})`);
    res.json({ ok: true, ...result });
  });

  router.post('/deposits/:id/reject', (req, res) => {
    const id = toId(req.params.id);
    const note = (req.body || {}).note;
    wallet.rejectDeposit(id, req.user, note);
    const d = wallet.getDeposit(id);
    audit(req, 'deposit_reject', d.user_id, { id, note }, `rechazó el depósito #${id} de ${d.username}`);
    res.json({ ok: true });
  });

  // ───────────────────────── Retiros ─────────────────────────

  router.get('/withdrawals', (req, res) => res.json(listRequests('withdrawals', req)));

  router.post('/withdrawals/:id/pay', (req, res) => {
    const id = toId(req.params.id);
    wallet.payWithdrawal(id, req.user, (req.body || {}).note);
    const w = wallet.getWithdrawal(id);
    audit(req, 'withdraw_pay', w.user_id, { id }, `marcó como pagado el retiro #${id} de ${w.username} (${fmtGs(w.amount)})`);
    res.json({ ok: true });
  });

  router.post('/withdrawals/:id/reject', (req, res) => {
    const id = toId(req.params.id);
    const note = (req.body || {}).note;
    wallet.rejectWithdrawal(id, req.user, note);
    const w = wallet.getWithdrawal(id);
    audit(req, 'withdraw_reject', w.user_id, { id, note }, `rechazó el retiro #${id} de ${w.username} (se devolvió el saldo)`);
    res.json({ ok: true });
  });

  // ───────────────────────── Juego ─────────────────────────

  router.get('/game', (req, res) => {
    res.json({ game: engine.adminState(), fair: chains.summary() });
  });

  router.get('/rounds', (req, res) => {
    const page = pageOf(req);
    const total = db.get("SELECT COUNT(*) AS c FROM rounds WHERE status IN ('crashed', 'cancelled')").c;
    const items = db.all(
      `SELECT id, chain_id, chain_index, hash, crash_point, ended_multiplier, status, cancel_mode, started_at, ended_at,
              total_bet, total_payout, total_refund, players
       FROM rounds WHERE status IN ('crashed', 'cancelled') ORDER BY id DESC LIMIT ? OFFSET ?`,
      PAGE,
      page * PAGE,
    );
    res.json({ items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) });
  });

  /** Jugadas de Minas, Penales, Plinko, Ruleta y Double de todos los jugadores. */
  router.get('/plays', (req, res) => {
    const game = String(req.query.game || '');
    const status = String(req.query.status || '');
    const q = cleanText(req.query.q, 40);
    const where = [];
    const params = [];
    if (GAME_KEYS.has(game)) {
      where.push('x.game = ?');
      params.push(game);
    }
    if (['active', 'won', 'lost', 'refunded'].includes(status)) {
      where.push('x.status = ?');
      params.push(status);
    }
    if (q) {
      where.push('u.username LIKE ?');
      params.push(`%${q}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = `FROM (${UNIFIED_PLAYS}) x JOIN users u ON u.id = x.user_id ${w}`;
    const total = db.get(`SELECT COUNT(*) AS c ${from}`, ...params).c;
    const page = pageOf(req);
    const items = db
      .all(`SELECT x.*, u.username ${from} ORDER BY x.created_at DESC, x.id DESC LIMIT ? OFFSET ?`, ...params, PAGE, page * PAGE)
      .map(playView);
    res.json({ items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) });
  });

  router.get('/bots', (req, res) => {
    res.json(ctx.bots.report());
  });

  router.get('/double', (req, res) => {
    const items = db.all(
      `SELECT id, chain_id, chain_index, hash, result, status, spun_at, ended_at, total_bet, total_payout, total_refund, players
       FROM double_rounds WHERE status IN ('ended', 'cancelled') ORDER BY id DESC LIMIT ? OFFSET ?`,
      PAGE,
      pageOf(req) * PAGE,
    );
    res.json({ double: double.adminState(), fair: doubleChains.summary(), items });
  });

  router.post('/game/stop', (req, res) => {
    const mode = (req.body || {}).mode === 'pay' ? 'pay' : 'refund';
    const result = engine.adminStop(mode);
    audit(
      req,
      'game_stop',
      null,
      { mode, ...result, roundId: engine.round && engine.round.id },
      `💥 explotó la ronda #${engine.round.id} en ${fmtMult(result.multiplier)} (${mode === 'pay' ? 'pagando a todos' : 'devolviendo apuestas'}, ${result.affected} apuestas)`,
    );
    res.json({ ok: true, ...result });
  });

  router.post('/game/pause', (req, res) => {
    engine.pause();
    audit(req, 'game_pause', null, null, 'pausó el juego ⏸️');
    res.json({ ok: true, phase: engine.phase });
  });

  router.post('/game/resume', (req, res) => {
    engine.resume();
    audit(req, 'game_resume', null, null, 'reanudó el juego ▶️');
    res.json({ ok: true, phase: engine.phase });
  });

  // ───────────────────────── Configuración ─────────────────────────

  router.get('/settings', (req, res) => {
    res.json({ values: settings.all(), schema: settings.schema(), fair: chains.summary() });
  });

  router.post('/settings', (req, res) => {
    const changed = settings.update(req.body || {});
    if (changed.length) {
      audit(req, 'settings', null, Object.fromEntries(changed.map((k) => [k, settings.get(k)])), `cambió la configuración (${changed.join(', ')})`);
    }
    res.json({ ok: true, changed, values: settings.all() });
  });

  router.post('/chain/rotate', (req, res) => {
    const percent = parseFloat(String((req.body || {}).houseEdge ?? '').replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 20) {
      throw new AppError('La ventaja de la casa debe estar entre 0% y 20%');
    }
    const bps = Math.round(percent * 100);
    chains.requestRotation(bps);
    audit(req, 'chain_rotate', null, { houseEdgeBps: bps }, `pidió una cadena nueva con ventaja ${percent}% (se aplica en la próxima ronda)`);
    res.json({ ok: true, fair: chains.summary() });
  });

  // ───────────────────────── Chat ─────────────────────────

  router.get('/chat', (req, res) => {
    res.json({ items: chat.recent });
  });

  router.post('/chat/announce', (req, res) => {
    const msg = chat.announce(req.user, (req.body || {}).text);
    audit(req, 'chat_announce', null, { text: msg.text });
    res.json({ ok: true, message: msg });
  });

  router.post('/chat/clear', (req, res) => {
    chat.clear();
    audit(req, 'chat_clear', null, null, 'limpió el chat');
    res.json({ ok: true });
  });

  router.post('/chat/:id/delete', (req, res) => {
    const id = toId(req.params.id);
    const msg = db.get('SELECT user_id, username, text FROM chat WHERE id = ?', id);
    chat.remove(id);
    audit(req, 'chat_delete', msg ? msg.user_id : null, msg ? { user: msg.username, text: msg.text } : { id });
    res.json({ ok: true });
  });

  // ───────────────────────── Respaldos ─────────────────────────

  router.get('/backups', (req, res) => {
    res.json({ items: ctx.backups.list(), everyHours: ctx.backups.everyMs / 3600_000 });
  });

  router.post('/backups', (req, res) => {
    const file = path.basename(ctx.backups.create('-manual'));
    audit(req, 'backup', null, { file }, `creó un respaldo de la base de datos (${file})`);
    res.json({ ok: true, file, items: ctx.backups.list() });
  });

  router.get('/backups/:file', (req, res) => {
    const name = String(req.params.file);
    if (!/^crashpy-[\w-]+\.db$/.test(name)) throw new AppError('Archivo inválido', 400);
    const full = path.join(ctx.backups.dir, name);
    if (!fs.existsSync(full)) throw new AppError('Respaldo no encontrado', 404);
    res.download(full, name);
  });

  // ───────────────────────── Auditoría y movimientos ─────────────────────────

  router.get('/audit', (req, res) => {
    const page = pageOf(req);
    const total = db.get('SELECT COUNT(*) AS c FROM audit').c;
    const items = db.all(
      `SELECT a.*, u.username AS target_name FROM audit a LEFT JOIN users u ON u.id = a.target_user_id
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      PAGE,
      page * PAGE,
    );
    res.json({ items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) });
  });

  router.get('/ledger', (req, res) => {
    const type = cleanText(req.query.type, 20);
    const q = cleanText(req.query.q, 40);
    const where = [];
    const params = [];
    if (type) {
      where.push('l.type = ?');
      params.push(type);
    }
    if (q) {
      where.push('u.username LIKE ?');
      params.push(`%${q}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = pageOf(req);
    const total = db.get(`SELECT COUNT(*) AS c FROM ledger l JOIN users u ON u.id = l.user_id ${w}`, ...params).c;
    const items = db.all(
      `SELECT l.*, u.username, a.username AS admin FROM ledger l
       JOIN users u ON u.id = l.user_id LEFT JOIN users a ON a.id = l.admin_id
       ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      ...params,
      PAGE,
      page * PAGE,
    );
    res.json({ items, total, page: page + 1, pages: Math.max(1, Math.ceil(total / PAGE)) });
  });

  return router;
};
