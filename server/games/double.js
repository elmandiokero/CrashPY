'use strict';
const core = require('../../public/js/games-core.js');
const { AppError, fmtGs } = require('../util');
const { RoundEngine, roundHmac } = require('./rounds');

const SPIN_MS = 6000; // lo que dura el giro (el resultado se paga al terminar)
const RESULT_MS = 4000; // pausa mostrando el resultado
const COLORS = ['red', 'black', 'white'];
const COLOR_NAMES = { red: 'rojo', black: 'negro', white: 'blanco' };

/**
 * Casilla ganadora de una ronda: HMAC_SHA256(clave = sal, mensaje = hash de la ronda),
 * primeros 52 bits → número entre 0 y 1 → casilla de 0 a 30.
 */
function doubleResult(hash, salt) {
  return core.doubleTileFromHmac(roundHmac(hash, salt));
}

/**
 * 🎡 Double: ruleta de colores multijugador con 31 casillas (15 rojas, 15 negras y 1 blanca).
 * Cada jugador puede apostar a uno o más colores; lo que suma a un mismo color se acumula en una sola apuesta.
 */
class DoubleEngine extends RoundEngine {
  constructor(deps) {
    super(deps, {
      game: 'double',
      name: 'Double',
      table: 'double',
      spinMs: SPIN_MS,
      resultMs: RESULT_MS,
      privateEvent: 'myDouble',
      pausedMsg: 'El Double está pausado por el momento',
    });
    // this.bets: "userId:color" → apuesta (acumulada) de la ronda actual
  }

  resultFrom(hmacHex) {
    return core.doubleTileFromHmac(hmacHex);
  }

  colorOf(result) {
    return core.doubleColor(result);
  }

  describe(result) {
    return `salió ${COLOR_NAMES[core.doubleColor(result)]}`;
  }

  payoutFor(row, result) {
    const color = core.doubleColor(result);
    return row.color === color ? Math.floor((row.amount * core.DOUBLE_PAYS[color]) / 100) : 0;
  }

  // ───────────────────────── Apuestas ─────────────────────────

  placeBet(userId, data = {}) {
    this._checkBetting();
    const color = String(data.color || '');
    if (!COLORS.includes(color)) throw new AppError('Elegí rojo, negro o blanco');
    const amount = this._positiveAmount(data.amount);
    const minBet = this.settings.get('min_bet');
    const maxBet = this.settings.get('max_bet');
    if (amount < minBet) throw new AppError(`La apuesta mínima es ${fmtGs(minBet)}`);
    const user = this._checkUser(userId);

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
      this.db.run('UPDATE users SET total_bet = total_bet + ?, bets_count = bets_count + ? WHERE id = ?', amount, prev ? 0 : 1, userId);
      return betId;
    });
    const bet = prev || { id, roundId: r.id, userId, username: user.username, color, amount: 0, status: 'active', payout: 0, createdAt: now };
    bet.amount = total;
    this.bets.set(key, bet);
    this.emit('bet', this.publicBet(bet));
    return this.userBets(userId);
  }

  // ───────────────────────── Vistas ─────────────────────────

  publicBet(b) {
    return { id: b.id, uid: b.userId, user: b.username, color: b.color, amount: b.amount, status: b.status, payout: b.payout };
  }

  userBets(userId) {
    const out = { red: 0, black: 0, white: 0 };
    for (const b of this.bets.values()) if (b.userId === userId && b.status !== 'refunded') out[b.color] += b.amount;
    return { roundId: this.round ? this.round.id : null, bets: out };
  }

  /** Mis apuestas en el Double (rondas terminadas). */
  userHistory(userId, limit = 30) {
    return this.db
      .all(
        `SELECT b.id, b.round_id, b.color, b.amount, b.payout, b.status, b.created_at, r.result
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
    const totals = { red: { amount: 0, players: 0 }, black: { amount: 0, players: 0 }, white: { amount: 0, players: 0 } };
    for (const b of this.bets.values()) {
      if (b.status === 'refunded') continue;
      totals[b.color].amount += b.amount;
      totals[b.color].players++;
    }
    const total = totals.red.amount + totals.black.amount + totals.white.amount;
    const houseIf = {};
    for (const c of COLORS) houseIf[c] = total - Math.floor((totals[c].amount * core.DOUBLE_PAYS[c]) / 100);
    return { ...this._adminBase(), total, totals, houseIf };
  }
}

module.exports = { DoubleEngine, doubleResult, SPIN_MS, RESULT_MS, COLOR_NAMES };
