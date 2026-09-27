'use strict';
const EventEmitter = require('events');
const crypto = require('crypto');
const { AppError, fmtMult, parseAmount } = require('../util');

const HISTORY_SIZE = 60;

/** HMAC_SHA256(clave = sal, mensaje = hash de la ronda) en hexadecimal: de acá sale el resultado de cada ronda. */
const roundHmac = (hash, salt) => crypto.createHmac('sha256', salt).update(hash).digest('hex');

/**
 * Base de los juegos en vivo por rondas (🎡 Double y 🎰 Ruleta): todos apuestan a la misma ronda y ven lo mismo.
 * Ciclo: BETTING (apuestas) → SPINNING (gira; el resultado ya se conoce) → se paga → RESULT → BETTING ...
 * Cada ronda usa un hash de su propia cadena provably fair (igual que el crash).
 *
 * Tablas: <table>_rounds (una fila por ronda) y <table>_bets (apuestas; el juego decide cómo se agrupan).
 * Cada juego define:
 *   resultFrom(hmacHex)   → resultado de la ronda
 *   colorOf(result)       → color del resultado (para mostrarlo)
 *   describe(result)      → texto corto para el libro contable ("salió rojo")
 *   payoutFor(row, result)→ lo que cobra una apuesta guardada, antes del tope de ganancia máxima
 *   placeBet, publicBet, userBets, userHistory y adminState
 */
class RoundEngine extends EventEmitter {
  constructor({ db, chains, settings, wallet, bus, log = console.log }, { game, name, table, spinMs, resultMs, privateEvent, pausedMsg }) {
    super();
    this.db = db;
    this.chains = chains;
    this.settings = settings;
    this.wallet = wallet;
    this.bus = bus;
    this.log = log;
    this.game = game;
    this.name = name;
    this.T = { rounds: `${table}_rounds`, bets: `${table}_bets` };
    this.spinMs = spinMs;
    this.resultMs = resultMs;
    this.privateEvent = privateEvent;
    this.pausedMsg = pausedMsg;
    this.enabledKey = `game_${game}`;
    this.bettingKey = `${game}_betting_seconds`;
    this.phase = 'IDLE';
    this.round = null;
    this.bets = new Map(); // apuestas de la ronda actual (la clave la decide cada juego)
    this.history = [];
    this.paused = false;
    this.timer = null;
  }

  // ───────────────────────── Ciclo de vida ─────────────────────────

  start() {
    this.paused = !this.settings.get(this.enabledKey);
    this._recover();
    this.history = this.db
      .all(`SELECT id, result FROM ${this.T.rounds} WHERE status = 'ended' ORDER BY id DESC LIMIT ?`, HISTORY_SIZE)
      .map((r) => ({ id: r.id, result: r.result }));
    this.bus.on('settings', () => this._safe(() => this._onSettings()));
    this._startBetting();
  }

  /** Después de un corte: las rondas que estaban girando se pagan y las apuestas abiertas se devuelven. */
  _recover() {
    this._settleLeftovers();
    const pending = this.db.all(`SELECT * FROM ${this.T.rounds} WHERE status = 'betting' ORDER BY id DESC`);
    pending.forEach((row, i) => {
      this.db.tx(() => {
        for (const b of this.db.all(`SELECT * FROM ${this.T.bets} WHERE round_id = ? AND status = 'active'`, row.id)) {
          this._refundRow(b, this._refundNote(row.id, 'reinicio del servidor'));
        }
        if (i > 0) this.db.run(`UPDATE ${this.T.rounds} SET status = 'cancelled', ended_at = ? WHERE id = ?`, Date.now(), row.id);
      });
    });
    // La ronda más nueva nunca mostró su resultado: se vuelve a usar
    if (pending.length) this.round = this._roundFromRow(pending[0]);
  }

  /** Rondas que quedaron girando sin pagarse (reinicio o error): el resultado ya se mostró, así que se pagan. */
  _settleLeftovers() {
    for (const row of this.db.all(`SELECT * FROM ${this.T.rounds} WHERE status = 'spinning' ORDER BY id`)) {
      const r = this._roundFromRow(row);
      this._settle(r);
      this.log(`♻️  ${this.name} #${r.id}: ronda pagada después de un corte (${this.describe(r.result)})`);
    }
  }

  _roundFromRow(row) {
    return {
      id: row.id,
      chainId: row.chain_id,
      chainIndex: row.chain_index,
      hash: row.hash,
      result: row.result,
      status: row.status,
      bettingEndsAt: 0,
      spunAt: row.spun_at,
      endedAt: row.ended_at,
    };
  }

  _clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Ejecuta un paso del ciclo sin que un error inesperado frene el juego. */
  _safe(fn) {
    try {
      fn();
    } catch (err) {
      this.log(`❌ Error en ${this.name}:`, err);
      this._clearTimer();
      try {
        if (this.phase === 'BETTING') this._refundAll('error del servidor');
      } catch (err2) {
        this.log(`❌ No se pudieron devolver las apuestas (${this.name}):`, err2);
      }
      this.phase = 'IDLE';
      this.timer = setTimeout(() => this._safe(() => this._startBetting()), 5000);
    }
  }

  _startBetting() {
    this._clearTimer();
    this._settleLeftovers();
    this.bets.clear();
    if (this.paused) {
      this.phase = 'PAUSED';
      this.emit('paused', { paused: true });
      return;
    }
    if (!this.round || this.round.status !== 'betting') this.round = this._createRound();
    const ms = this.settings.get(this.bettingKey) * 1000;
    this.round.bettingEndsAt = Date.now() + ms;
    this.phase = 'BETTING';
    this.emit('betting', { roundId: this.round.id, ms });
    this.timer = setTimeout(() => this._safe(() => this._spin()), ms);
  }

  _createRound() {
    return this.db.tx(() => {
      const next = this.chains.next();
      const result = this.resultFrom(roundHmac(next.hash, next.salt));
      const res = this.db.run(
        `INSERT INTO ${this.T.rounds} (chain_id, chain_index, hash, result, status, created_at) VALUES (?, ?, ?, ?, 'betting', ?)`,
        next.chainId,
        next.index,
        next.hash,
        result,
        Date.now(),
      );
      return {
        id: Number(res.lastInsertRowid),
        chainId: next.chainId,
        chainIndex: next.index,
        hash: next.hash,
        result,
        status: 'betting',
        bettingEndsAt: 0,
        spunAt: null,
        endedAt: null,
      };
    });
  }

  _spin() {
    this._clearTimer();
    const r = this.round;
    r.status = 'spinning';
    r.spunAt = Date.now();
    this.db.run(`UPDATE ${this.T.rounds} SET status = 'spinning', spun_at = ? WHERE id = ?`, r.spunAt, r.id);
    this.phase = 'SPINNING';
    this.emit('spin', { roundId: r.id, result: r.result, color: this.colorOf(r.result), hash: r.hash, ms: this.spinMs });
    this.timer = setTimeout(() => this._safe(() => this._finishSpin()), this.spinMs);
  }

  _finishSpin() {
    this._clearTimer();
    this._settle(this.round);
    this.phase = 'RESULT';
    this.timer = setTimeout(() => this._safe(() => this._startBetting()), this.resultMs);
  }

  /** Paga la ronda (sirve tanto para la ronda en curso como para una que quedó colgada). */
  _settle(r) {
    const maxProfit = this.settings.get('max_profit');
    const now = Date.now();
    const settled = [];
    this.db.tx(() => {
      const rows = this.db.all(
        `SELECT b.*, u.username FROM ${this.T.bets} b JOIN users u ON u.id = b.user_id
         WHERE b.round_id = ? AND b.status = 'active' ORDER BY b.id`,
        r.id,
      );
      for (const b of rows) {
        const payout = Math.max(0, Math.min(this.payoutFor(b, r.result), b.amount + maxProfit));
        if (payout > 0) {
          const mult = Math.floor((payout * 100) / b.amount);
          this.db.run(`UPDATE ${this.T.bets} SET status = 'won', payout = ? WHERE id = ?`, payout, b.id);
          this.wallet.change(b.user_id, payout, 'win', { refId: b.id, note: `${this.name} #${r.id} · ${this.describe(r.result)} (${fmtMult(mult)})` });
          this.db.run('UPDATE users SET total_won = total_won + ?, best_cashout = MAX(best_cashout, ?) WHERE id = ?', payout, mult, b.user_id);
          settled.push({ ...b, status: 'won', payout });
        } else {
          this.db.run(`UPDATE ${this.T.bets} SET status = 'lost' WHERE id = ?`, b.id);
          settled.push({ ...b, status: 'lost', payout: 0 });
        }
      }
      const t = this.db.get(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN amount END), 0) AS bet,
                COALESCE(SUM(payout), 0) AS payout,
                COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount END), 0) AS refund,
                COUNT(DISTINCT CASE WHEN status IN ('won', 'lost') THEN user_id END) AS players
         FROM ${this.T.bets} WHERE round_id = ?`,
        r.id,
      );
      this.db.run(
        `UPDATE ${this.T.rounds} SET status = 'ended', ended_at = ?, total_bet = ?, total_payout = ?, total_refund = ?, players = ?
         WHERE id = ?`,
        now,
        t.bet,
        t.payout,
        t.refund,
        t.players,
        r.id,
      );
      r.totalBet = t.bet;
      r.totalPayout = t.payout;
    });
    r.status = 'ended';
    r.endedAt = now;
    const byId = new Map(settled.map((s) => [s.id, s]));
    for (const b of this.bets.values()) {
      const row = b.roundId === r.id ? byId.get(b.id) : null;
      if (!row) continue;
      b.status = row.status;
      b.payout = row.payout;
    }
    this.history.unshift({ id: r.id, result: r.result });
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    this.emit('result', {
      roundId: r.id,
      result: r.result,
      color: this.colorOf(r.result),
      hash: r.hash,
      nextIn: this.resultMs,
      totalBet: r.totalBet,
      totalPayout: r.totalPayout,
    });
    this._announce(r, settled);
  }

  /** Avisos después de pagar: resultado privado de cada jugador, jugadas en vivo y ganancias grandes. */
  _announce(r, settled) {
    const color = this.colorOf(r.result);
    const byUser = new Map();
    const multOf = (b) => (b.payout > 0 ? Math.floor((b.payout * 100) / b.amount) : 0);
    for (const b of settled) {
      const u = byUser.get(b.user_id) || { bet: 0, payout: 0 };
      u.bet += b.amount;
      u.payout += b.payout;
      byUser.set(b.user_id, u);
      this.bus.emit('feed', { game: this.game, user: b.username, amount: b.amount, multiplier: multOf(b), payout: b.payout, ts: r.endedAt });
    }
    for (const [userId, u] of byUser) {
      this.bus.emit(this.privateEvent, userId, { roundId: r.id, result: r.result, color, bet: u.bet, payout: u.payout });
    }
    const bigMult = Math.round(this.settings.get('bigwin_multiplier') * 100);
    const bigAmount = this.settings.get('bigwin_amount');
    settled
      .filter((b) => b.payout > b.amount && (multOf(b) >= bigMult || (bigAmount > 0 && b.payout - b.amount >= bigAmount)))
      .sort((a, b) => b.payout - b.amount - (a.payout - a.amount))
      .slice(0, 3)
      .forEach((b) =>
        this.bus.emit('bigwin', {
          game: this.game,
          user: b.username,
          userId: b.user_id,
          amount: b.amount,
          cashout: multOf(b),
          payout: b.payout,
          roundId: r.id,
        }),
      );
  }

  _refundRow(row, note) {
    const res = this.db.run(`UPDATE ${this.T.bets} SET status = 'refunded' WHERE id = ? AND status = 'active'`, row.id);
    if (res.changes !== 1) return;
    this.wallet.change(row.user_id, row.amount, 'refund', { refId: row.id, note });
    this.db.run('UPDATE users SET total_bet = total_bet - ?, bets_count = bets_count - 1 WHERE id = ?', row.amount, row.user_id);
  }

  /** Texto del libro contable para una apuesta devuelta ("Ruleta #12: apuesta devuelta (juego en pausa)"). */
  _refundNote(roundId, reason) {
    return `${this.name} #${roundId}: apuesta devuelta (${reason})`;
  }

  /** Devuelve todas las apuestas abiertas de la ronda actual (pausa, apagado o error). */
  _refundAll(reason) {
    const r = this.round;
    if (!r) return;
    const note = this._refundNote(r.id, reason);
    this.db.tx(() => {
      for (const b of this.db.all(`SELECT * FROM ${this.T.bets} WHERE round_id = ? AND status = 'active'`, r.id)) this._refundRow(b, note);
    });
    const byUser = new Map();
    for (const b of this.bets.values()) {
      if (b.status !== 'active') continue;
      b.status = 'refunded';
      byUser.set(b.userId, (byUser.get(b.userId) || 0) + b.amount);
    }
    for (const [userId, amount] of byUser) this.bus.emit(this.privateEvent, userId, { roundId: r.id, refunded: true, bet: amount, payout: 0 });
    this.bets.clear();
    this.emit('refund', { roundId: r.id });
  }

  // ───────────────────────── Apuestas (ayudantes) ─────────────────────────

  _checkBetting() {
    if (this.phase !== 'BETTING') {
      const msg = this.phase === 'PAUSED' ? this.pausedMsg : 'Las apuestas están cerradas, esperá la próxima ronda';
      throw new AppError(msg, 409, 'NOT_BETTING');
    }
  }

  _checkUser(userId) {
    const user = this.db.get('SELECT id, username, banned FROM users WHERE id = ?', userId);
    if (!user || user.banned) throw new AppError('Tu cuenta no está habilitada para jugar', 403, 'BANNED');
    return user;
  }

  _positiveAmount(raw, msg = 'Monto inválido') {
    const amount = parseAmount(raw);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError(msg);
    return amount;
  }

  // ───────────────────────── Pausa (se maneja desde la configuración) ─────────────────────────

  _onSettings() {
    const enabled = !!this.settings.get(this.enabledKey);
    if (!enabled && !this.paused) {
      this.paused = true;
      if (this.phase === 'BETTING') {
        this._clearTimer();
        this._refundAll('juego en pausa');
        this.phase = 'PAUSED';
      }
      // Si está girando, la ronda termina normalmente y recién ahí se pausa.
      this.emit('paused', { paused: true, phase: this.phase });
    } else if (enabled && this.paused) {
      this.paused = false;
      this.emit('paused', { paused: false, phase: this.phase });
      if (this.phase === 'PAUSED') this._startBetting();
    }
  }

  shutdown() {
    this._clearTimer();
    try {
      if (this.phase === 'BETTING') this._refundAll('el servidor se apagó');
      else if (this.phase === 'SPINNING') this._settle(this.round);
    } catch (err) {
      this.log(`Error al cerrar la ronda (${this.name}):`, err);
    }
    this.phase = 'STOPPED';
  }

  // ───────────────────────── Vistas ─────────────────────────

  publicBets() {
    const out = [];
    for (const b of this.bets.values()) if (b.status !== 'refunded') out.push(this.publicBet(b));
    return out.sort((a, b) => b.amount - a.amount);
  }

  publicState() {
    const r = this.round;
    const now = Date.now();
    const s = {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      bettingMs: this.settings.get(this.bettingKey) * 1000,
      spinMs: this.spinMs,
      resultMs: this.resultMs,
      history: this.history,
      bets: this.publicBets(),
    };
    if (this.phase === 'BETTING') s.bettingLeft = Math.max(0, r.bettingEndsAt - now);
    if ((this.phase === 'SPINNING' || this.phase === 'RESULT') && r) {
      s.result = r.result;
      s.color = this.colorOf(r.result);
      s.hash = r.hash;
      s.spinElapsed = now - r.spunAt;
    }
    if (this.phase === 'RESULT' && r) s.nextIn = Math.max(0, r.endedAt + this.resultMs - now);
    return s;
  }

  /** Lo común del estado para el panel de admin (nunca muestra el resultado antes del giro). */
  _adminBase() {
    const r = this.round;
    return {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      bettingLeft: this.phase === 'BETTING' && r ? Math.max(0, r.bettingEndsAt - Date.now()) : null,
      lastResult: (this.phase === 'SPINNING' || this.phase === 'RESULT') && r ? r.result : null,
      history: this.history.slice(0, 20),
      bets: this.publicBets().slice(0, 50),
    };
  }
}

module.exports = { RoundEngine, roundHmac, HISTORY_SIZE };
