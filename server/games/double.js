'use strict';
const EventEmitter = require('events');
const crypto = require('crypto');
const core = require('../../public/js/games-core.js');
const { AppError, fmtGs, fmtMult, parseAmount } = require('../util');

const SPIN_MS = 6000; // lo que dura el giro (el resultado se paga al terminar)
const RESULT_MS = 4000; // pausa mostrando el resultado
const HISTORY_SIZE = 60;
const COLORS = ['red', 'black', 'white'];
const COLOR_NAMES = { red: 'rojo', black: 'negro', white: 'blanco' };

/**
 * Casilla ganadora de una ronda: HMAC_SHA256(clave = sal, mensaje = hash de la ronda),
 * primeros 52 bits → número entre 0 y 1 → casilla de 0 a 30.
 */
function doubleResult(hash, salt) {
  return core.doubleTileFromHmac(crypto.createHmac('sha256', salt).update(hash).digest('hex'));
}

/**
 * 🎡 Double: ruleta de colores multijugador con 31 casillas (15 rojas, 15 negras y 1 blanca).
 * Ciclo: BETTING (apuestas) → SPINNING (gira, ya se conoce el resultado) → RESULT → BETTING ...
 * Cada ronda usa un hash de su propia cadena provably fair (igual que el crash).
 */
class DoubleEngine extends EventEmitter {
  constructor({ db, chains, settings, wallet, bus, log = console.log }) {
    super();
    this.db = db;
    this.chains = chains;
    this.settings = settings;
    this.wallet = wallet;
    this.bus = bus;
    this.log = log;
    this.phase = 'IDLE';
    this.round = null;
    this.bets = new Map(); // "userId:color" → apuesta (acumulada) de la ronda actual
    this.history = [];
    this.paused = false;
    this.timer = null;
  }

  // ───────────────────────── Ciclo de vida ─────────────────────────

  start() {
    this.paused = !this.settings.get('game_double');
    this._recover();
    this.history = this.db
      .all("SELECT id, result FROM double_rounds WHERE status = 'ended' ORDER BY id DESC LIMIT ?", HISTORY_SIZE)
      .map((r) => ({ id: r.id, result: r.result }));
    this.bus.on('settings', () => this._safe(() => this._onSettings()));
    this._startBetting();
  }

  /** Después de un corte: las rondas que estaban girando se pagan y las apuestas abiertas se devuelven. */
  _recover() {
    this._settleLeftovers();
    const pending = this.db.all("SELECT * FROM double_rounds WHERE status = 'betting' ORDER BY id DESC");
    pending.forEach((row, i) => {
      this.db.tx(() => {
        for (const b of this.db.all("SELECT * FROM double_bets WHERE round_id = ? AND status = 'active'", row.id)) {
          this._refundRow(b, `Double #${row.id}: apuesta devuelta (reinicio del servidor)`);
        }
        if (i > 0) this.db.run("UPDATE double_rounds SET status = 'cancelled', ended_at = ? WHERE id = ?", Date.now(), row.id);
      });
    });
    if (pending.length) this.round = this._roundFromRow(pending[0]);
  }

  /** Rondas que quedaron girando sin pagarse (reinicio o error): el resultado ya se mostró, así que se pagan. */
  _settleLeftovers() {
    for (const row of this.db.all("SELECT * FROM double_rounds WHERE status = 'spinning' ORDER BY id")) {
      const r = this._roundFromRow(row);
      this._settle(r);
      this.log(`♻️  Double #${r.id}: ronda pagada después de un corte (salió ${r.result})`);
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
      this.log('❌ Error en el Double:', err);
      this._clearTimer();
      try {
        if (this.phase === 'BETTING') this._refundAll('Double: apuesta devuelta por un error del servidor');
      } catch (err2) {
        this.log('❌ No se pudieron devolver las apuestas del Double:', err2);
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
    const ms = this.settings.get('double_betting_seconds') * 1000;
    this.round.bettingEndsAt = Date.now() + ms;
    this.phase = 'BETTING';
    this.emit('betting', { roundId: this.round.id, ms });
    this.timer = setTimeout(() => this._safe(() => this._spin()), ms);
  }

  _createRound() {
    return this.db.tx(() => {
      const next = this.chains.next();
      const result = doubleResult(next.hash, next.salt);
      const res = this.db.run(
        "INSERT INTO double_rounds (chain_id, chain_index, hash, result, status, created_at) VALUES (?, ?, ?, ?, 'betting', ?)",
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
    this.db.run("UPDATE double_rounds SET status = 'spinning', spun_at = ? WHERE id = ?", r.spunAt, r.id);
    this.phase = 'SPINNING';
    this.emit('spin', { roundId: r.id, result: r.result, color: core.doubleColor(r.result), hash: r.hash, ms: SPIN_MS });
    this.timer = setTimeout(() => this._safe(() => this._finishSpin()), SPIN_MS);
  }

  _finishSpin() {
    this._clearTimer();
    const r = this.round;
    this._settle(r);
    this.phase = 'RESULT';
    this.timer = setTimeout(() => this._safe(() => this._startBetting()), RESULT_MS);
  }

  /** Paga la ronda (sirve tanto para la ronda en curso como para una que quedó colgada). */
  _settle(r) {
    const color = core.doubleColor(r.result);
    const pays = core.DOUBLE_PAYS[color];
    const maxProfit = this.settings.get('max_profit');
    const now = Date.now();
    const settled = [];
    this.db.tx(() => {
      const rows = this.db.all(
        `SELECT b.*, u.username FROM double_bets b JOIN users u ON u.id = b.user_id
         WHERE b.round_id = ? AND b.status = 'active' ORDER BY b.id`,
        r.id,
      );
      for (const b of rows) {
        if (b.color === color) {
          const payout = Math.min(Math.floor((b.amount * pays) / 100), b.amount + maxProfit);
          this.db.run("UPDATE double_bets SET status = 'won', payout = ? WHERE id = ?", payout, b.id);
          this.wallet.change(b.user_id, payout, 'win', {
            refId: b.id,
            note: `Double #${r.id} · salió ${COLOR_NAMES[color]} (${fmtMult(pays)})`,
          });
          this.db.run(
            'UPDATE users SET total_won = total_won + ?, best_cashout = MAX(best_cashout, ?) WHERE id = ?',
            payout,
            pays,
            b.user_id,
          );
          settled.push({ ...b, status: 'won', payout });
        } else {
          this.db.run("UPDATE double_bets SET status = 'lost' WHERE id = ?", b.id);
          settled.push({ ...b, status: 'lost', payout: 0 });
        }
      }
      const t = this.db.get(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN amount END), 0) AS bet,
                COALESCE(SUM(payout), 0) AS payout,
                COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount END), 0) AS refund,
                COUNT(DISTINCT CASE WHEN status IN ('won', 'lost') THEN user_id END) AS players
         FROM double_bets WHERE round_id = ?`,
        r.id,
      );
      this.db.run(
        `UPDATE double_rounds SET status = 'ended', ended_at = ?, total_bet = ?, total_payout = ?, total_refund = ?, players = ?
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
    for (const b of this.bets.values()) {
      if (b.roundId !== r.id) continue;
      b.status = b.color === color ? 'won' : 'lost';
      const row = settled.find((s) => s.id === b.id);
      b.payout = row ? row.payout : 0;
    }
    this.history.unshift({ id: r.id, result: r.result });
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    this.emit('result', {
      roundId: r.id,
      result: r.result,
      color,
      hash: r.hash,
      nextIn: RESULT_MS,
      totalBet: r.totalBet,
      totalPayout: r.totalPayout,
    });
    this._announce(r, color, pays, settled);
  }

  /** Avisos después de pagar: resultado privado de cada jugador, jugadas en vivo y ganancias grandes. */
  _announce(r, color, pays, settled) {
    const byUser = new Map();
    for (const b of settled) {
      const u = byUser.get(b.user_id) || { bet: 0, payout: 0 };
      u.bet += b.amount;
      u.payout += b.payout;
      byUser.set(b.user_id, u);
      this.bus.emit('feed', {
        game: 'double',
        user: b.username,
        amount: b.amount,
        multiplier: b.status === 'won' ? Math.floor((b.payout * 100) / b.amount) : 0,
        payout: b.payout,
        ts: r.endedAt,
      });
    }
    for (const [userId, u] of byUser) {
      this.bus.emit('myDouble', userId, { roundId: r.id, result: r.result, color, bet: u.bet, payout: u.payout });
    }
    const bigMult = Math.round(this.settings.get('bigwin_multiplier') * 100);
    const bigAmount = this.settings.get('bigwin_amount');
    settled
      .filter((b) => b.status === 'won' && (pays >= bigMult || (bigAmount > 0 && b.payout - b.amount >= bigAmount)))
      .sort((a, b) => b.payout - a.payout)
      .slice(0, 3)
      .forEach((b) =>
        this.bus.emit('bigwin', {
          game: 'double',
          user: b.username,
          userId: b.user_id,
          amount: b.amount,
          cashout: Math.floor((b.payout * 100) / b.amount),
          payout: b.payout,
          roundId: r.id,
        }),
      );
  }

  _refundRow(row, note) {
    const res = this.db.run("UPDATE double_bets SET status = 'refunded' WHERE id = ? AND status = 'active'", row.id);
    if (res.changes !== 1) return;
    this.wallet.change(row.user_id, row.amount, 'refund', { refId: row.id, note });
    this.db.run('UPDATE users SET total_bet = total_bet - ?, bets_count = bets_count - 1 WHERE id = ?', row.amount, row.user_id);
  }

  /** Devuelve todas las apuestas abiertas de la ronda actual (pausa, apagado o error). */
  _refundAll(note) {
    const r = this.round;
    if (!r) return;
    this.db.tx(() => {
      for (const b of this.db.all("SELECT * FROM double_bets WHERE round_id = ? AND status = 'active'", r.id)) this._refundRow(b, note);
    });
    for (const b of this.bets.values()) {
      if (b.status !== 'active') continue;
      b.status = 'refunded';
      this.bus.emit('myDouble', b.userId, { roundId: r.id, refunded: true, bet: b.amount, payout: 0 });
    }
    this.bets.clear();
    this.emit('refund', { roundId: r.id });
  }

  // ───────────────────────── Apuestas ─────────────────────────

  placeBet(userId, data = {}) {
    if (this.phase !== 'BETTING') {
      const msg = this.phase === 'PAUSED' ? 'El Double está pausado por el momento' : 'Las apuestas están cerradas, esperá la próxima ronda';
      throw new AppError(msg, 409, 'NOT_BETTING');
    }
    const color = String(data.color || '');
    if (!COLORS.includes(color)) throw new AppError('Elegí rojo, negro o blanco');
    const amount = parseAmount(data.amount);
    const minBet = this.settings.get('min_bet');
    const maxBet = this.settings.get('max_bet');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Monto inválido');
    if (amount < minBet) throw new AppError(`La apuesta mínima es ${fmtGs(minBet)}`);
    const user = this.db.get('SELECT id, username, banned FROM users WHERE id = ?', userId);
    if (!user || user.banned) throw new AppError('Tu cuenta no está habilitada para jugar', 403, 'BANNED');

    const r = this.round;
    const key = `${userId}:${color}`;
    const prev = this.bets.get(key);
    const total = (prev ? prev.amount : 0) + amount;
    if (total > maxBet) {
      throw new AppError(
        prev ? `La apuesta máxima por color es ${fmtGs(maxBet)} (ya tenés ${fmtGs(prev.amount)} en ${COLOR_NAMES[color]})` : `La apuesta máxima es ${fmtGs(maxBet)}`,
      );
    }
    const pays = core.DOUBLE_PAYS[color];
    const maxProfit = this.settings.get('max_profit');
    if (Math.floor((total * pays) / 100) - total > maxProfit) {
      const limit = Math.floor((maxProfit * 100) / (pays - 100));
      throw new AppError(`En ${COLOR_NAMES[color]} podés apostar hasta ${fmtGs(limit)} por ronda (ganancia máxima ${fmtGs(maxProfit)})`);
    }
    const now = Date.now();
    const id = this.db.tx(() => {
      let betId;
      if (prev) {
        betId = prev.id;
        this.db.run("UPDATE double_bets SET amount = amount + ? WHERE id = ? AND status = 'active'", amount, betId);
      } else {
        const res = this.db.run(
          "INSERT INTO double_bets (round_id, user_id, color, amount, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
          r.id,
          userId,
          color,
          amount,
          now,
        );
        betId = Number(res.lastInsertRowid);
      }
      this.wallet.change(userId, -amount, 'bet', { refId: betId, note: `Double #${r.id} · ${COLOR_NAMES[color]}` });
      this.db.run(
        'UPDATE users SET total_bet = total_bet + ?, bets_count = bets_count + ? WHERE id = ?',
        amount,
        prev ? 0 : 1,
        userId,
      );
      return betId;
    });
    const bet = prev || { id, roundId: r.id, userId, username: user.username, color, amount: 0, status: 'active', payout: 0, createdAt: now };
    bet.amount = total;
    this.bets.set(key, bet);
    this.emit('bet', this.publicBet(bet));
    return this.userBets(userId);
  }

  // ───────────────────────── Pausa (se maneja desde la configuración) ─────────────────────────

  _onSettings() {
    const enabled = !!this.settings.get('game_double');
    if (!enabled && !this.paused) {
      this.paused = true;
      if (this.phase === 'BETTING') {
        this._clearTimer();
        this._refundAll('Double pausado: apuesta devuelta');
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
      if (this.phase === 'BETTING') this._refundAll('Double: apuesta devuelta (el servidor se apagó)');
      else if (this.phase === 'SPINNING') this._settle(this.round);
    } catch (err) {
      this.log('Error al cerrar la ronda del Double:', err);
    }
    this.phase = 'STOPPED';
  }

  // ───────────────────────── Vistas ─────────────────────────

  publicBet(b) {
    return { id: b.id, uid: b.userId, user: b.username, color: b.color, amount: b.amount, status: b.status, payout: b.payout };
  }

  publicBets() {
    const out = [];
    for (const b of this.bets.values()) if (b.status !== 'refunded') out.push(this.publicBet(b));
    return out.sort((a, b) => b.amount - a.amount);
  }

  userBets(userId) {
    const out = { red: 0, black: 0, white: 0 };
    for (const b of this.bets.values()) if (b.userId === userId && b.status !== 'refunded') out[b.color] += b.amount;
    return { roundId: this.round ? this.round.id : null, bets: out };
  }

  publicState() {
    const r = this.round;
    const now = Date.now();
    const s = {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      bettingMs: this.settings.get('double_betting_seconds') * 1000,
      spinMs: SPIN_MS,
      resultMs: RESULT_MS,
      history: this.history,
      bets: this.publicBets(),
    };
    if (this.phase === 'BETTING') s.bettingLeft = Math.max(0, r.bettingEndsAt - now);
    if ((this.phase === 'SPINNING' || this.phase === 'RESULT') && r) {
      s.result = r.result;
      s.color = core.doubleColor(r.result);
      s.hash = r.hash;
      s.spinElapsed = now - r.spunAt;
    }
    if (this.phase === 'RESULT' && r) s.nextIn = Math.max(0, r.endedAt + RESULT_MS - now);
    return s;
  }

  /** Mis apuestas en el Double (rondas terminadas). */
  userHistory(userId, limit = 30) {
    return this.db
      .all(
        `SELECT b.id, b.round_id, b.color, b.amount, b.payout, b.status, b.created_at, r.result, r.hash
         FROM double_bets b JOIN double_rounds r ON r.id = b.round_id
         WHERE b.user_id = ? AND b.status IN ('won', 'lost', 'refunded')
         ORDER BY b.id DESC LIMIT ?`,
        userId,
        limit,
      )
      .map((b) => ({
        id: b.id,
        game: 'double',
        roundId: b.round_id,
        color: b.color,
        amount: b.amount,
        payout: b.payout,
        status: b.status,
        multiplier: b.status === 'won' ? Math.floor((b.payout * 100) / b.amount) : 0,
        result: b.result,
        createdAt: b.created_at,
      }));
  }

  /** Para el panel de admin: lo apostado a cada color y cuánto pagaría la casa según lo que salga (nunca el resultado). */
  adminState() {
    const r = this.round;
    const totals = { red: { amount: 0, players: 0 }, black: { amount: 0, players: 0 }, white: { amount: 0, players: 0 } };
    for (const b of this.bets.values()) {
      if (b.status === 'refunded') continue;
      totals[b.color].amount += b.amount;
      totals[b.color].players++;
    }
    const total = totals.red.amount + totals.black.amount + totals.white.amount;
    const houseIf = {};
    for (const c of COLORS) houseIf[c] = total - Math.floor((totals[c].amount * core.DOUBLE_PAYS[c]) / 100);
    return {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      bettingLeft: this.phase === 'BETTING' && r ? Math.max(0, r.bettingEndsAt - Date.now()) : null,
      lastResult: this.phase === 'SPINNING' || this.phase === 'RESULT' ? r.result : null,
      total,
      totals,
      houseIf,
      history: this.history.slice(0, 20),
      bets: this.publicBets().slice(0, 50),
    };
  }
}

module.exports = { DoubleEngine, doubleResult, SPIN_MS, RESULT_MS, COLOR_NAMES };
