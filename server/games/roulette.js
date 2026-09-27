'use strict';
const core = require('../../public/js/games-core.js');
const { AppError, fmtGs } = require('../util');
const { RoundEngine, roundHmac } = require('./rounds');

const SPIN_MS = 8000; // lo que tarda la bolita en caer (el resultado se paga al terminar)
const RESULT_MS = 5000; // pausa mostrando el número ganador
const MAX_SPOTS = 60; // lugares distintos de la mesa en una misma ronda (hoy hay 49)
const TYPES = new Set(['n', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen', 'column']);
const COLOR_NAMES = { red: 'rojo', black: 'negro', green: 'verde' };
const ORDINAL = { 1: '1ª', 2: '2ª', 3: '3ª' };

/** Número ganador de una ronda: HMAC_SHA256(clave = sal, mensaje = hash) → primeros 52 bits → 0 a 36. */
function rouletteResult(hash, salt) {
  return core.rouletteNumberFromHmac(roundHmac(hash, salt));
}

/** Nombre corto de un lugar de la mesa: "17", "rojo", "2ª docena"... */
function spotName(s) {
  switch (s.type) {
    case 'n':
      return `pleno ${s.value}`;
    case 'dozen':
      return `${ORDINAL[s.value]} docena`;
    case 'column':
      return `${ORDINAL[s.value]} columna`;
    case 'low':
      return '1 a 18';
    case 'high':
      return '19 a 36';
    case 'odd':
      return 'impar';
    case 'even':
      return 'par';
    default:
      return COLOR_NAMES[s.type] || s.type;
  }
}

/** Resumen de una lista de apuestas: los lugares más cargados primero ("rojo, pleno 17 y 3 más"). */
function spotsLabel(spots, max = 3) {
  const list = [...spots].sort((a, b) => b.amount - a.amount).map(spotName);
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')} y ${list.length - max} más`;
}

const spotKey = (s) => (s.value === null || s.value === undefined ? s.type : `${s.type}:${s.value}`);

/** Junta las fichas que caen en el mismo lugar de la mesa. */
function mergeSpots(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const s of list) {
      const key = spotKey(s);
      const prev = merged.get(key);
      if (prev) prev.amount += s.amount;
      else merged.set(key, { type: s.type, value: s.value, amount: s.amount });
    }
  }
  return [...merged.values()];
}

const parseSpots = (text) => {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/**
 * 🎰 Ruleta europea en vivo (0 a 36): todos apuestan en la misma mesa durante la cuenta regresiva
 * y una sola bolita decide para todos. Cada jugador tiene una apuesta por ronda que junta todas sus fichas;
 * puede confirmar fichas varias veces mientras las apuestas estén abiertas.
 */
class RouletteEngine extends RoundEngine {
  constructor(deps) {
    super(deps, {
      game: 'roulette',
      name: 'Ruleta',
      table: 'roulette',
      spinMs: SPIN_MS,
      resultMs: RESULT_MS,
      privateEvent: 'myRoulette',
      pausedMsg: 'La Ruleta está en pausa por el momento',
    });
    // this.bets: userId → apuesta de la ronda actual { id, spots: [{type, value, amount}], amount, ... }
  }

  resultFrom(hmacHex) {
    return core.rouletteNumberFromHmac(hmacHex);
  }

  colorOf(result) {
    return core.rouletteColor(result);
  }

  describe(result) {
    return `salió el ${result} ${COLOR_NAMES[core.rouletteColor(result)]}`;
  }

  payoutFor(row, result) {
    return core.roulettePayout(parseSpots(row.bets), result);
  }

  // ───────────────────────── Apuestas ─────────────────────────

  /** Valida las fichas que manda el jugador: [{type, value, amount}]. */
  _parse(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new AppError('Poné al menos una ficha en la mesa');
    if (raw.length > MAX_SPOTS * 4) throw new AppError('Demasiadas fichas de una sola vez');
    const list = [];
    for (const b of raw) {
      const type = String(b && b.type);
      if (!TYPES.has(type)) throw new AppError('Apuesta inválida');
      let value = null;
      if (type === 'n') {
        value = Number(b.value);
        if (!Number.isInteger(value) || value < 0 || value > 36) throw new AppError('Número inválido');
      } else if (type === 'dozen' || type === 'column') {
        value = Number(b.value);
        if (![1, 2, 3].includes(value)) throw new AppError('Apuesta inválida');
      }
      list.push({ type, value, amount: this._positiveAmount(b.amount, 'Monto de ficha inválido') });
    }
    return mergeSpots(list);
  }

  placeBet(userId, data = {}) {
    this._checkBetting();
    const add = this._parse(data.bets);
    const batch = add.reduce((s, b) => s + b.amount, 0);
    const minBet = this.settings.get('min_bet');
    const maxBet = this.settings.get('max_bet');
    if (!Number.isSafeInteger(batch)) throw new AppError('Monto inválido');
    if (batch < minBet) throw new AppError(`La apuesta mínima es ${fmtGs(minBet)}`);
    const user = this._checkUser(userId);

    const r = this.round;
    const prev = this.bets.get(userId);
    const total = (prev ? prev.amount : 0) + batch;
    if (total > maxBet) {
      throw new AppError(
        prev ? `La apuesta máxima por ronda es ${fmtGs(maxBet)} (ya tenés ${fmtGs(prev.amount)} en la mesa)` : `La apuesta máxima por ronda es ${fmtGs(maxBet)}`,
      );
    }
    const spots = mergeSpots(prev ? prev.spots : [], add);
    if (spots.length > MAX_SPOTS) throw new AppError('Demasiadas apuestas distintas en una misma ronda');
    const maxProfit = this.settings.get('max_profit');
    if (core.rouletteMaxPayout(spots) - total > maxProfit) {
      throw new AppError(`Con esas fichas podrías ganar más de ${fmtGs(maxProfit)} (la ganancia máxima por ronda). Bajá lo que pusiste en los plenos.`);
    }
    const now = Date.now();
    const id = this.db.tx(() => {
      let betId;
      if (prev) {
        betId = prev.id;
        const res = this.db.run(
          "UPDATE roulette_bets SET bets = ?, amount = amount + ? WHERE id = ? AND status = 'active'",
          JSON.stringify(spots),
          batch,
          betId,
        );
        if (res.changes !== 1) throw new AppError('Las apuestas están cerradas, esperá la próxima ronda', 409, 'NOT_BETTING');
      } else {
        const res = this.db.run(
          "INSERT INTO roulette_bets (round_id, user_id, bets, amount, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
          r.id,
          userId,
          JSON.stringify(spots),
          batch,
          now,
        );
        betId = Number(res.lastInsertRowid);
      }
      this.wallet.change(userId, -batch, 'bet', { refId: betId, note: `Ruleta #${r.id} · ${spotsLabel(add)}` });
      this.db.run('UPDATE users SET total_bet = total_bet + ?, bets_count = bets_count + ? WHERE id = ?', batch, prev ? 0 : 1, userId);
      return betId;
    });
    const bet = prev || { id, roundId: r.id, userId, username: user.username, spots: [], amount: 0, status: 'active', payout: 0, createdAt: now };
    bet.spots = spots;
    bet.amount = total;
    this.bets.set(userId, bet);
    this.emit('bet', this.publicBet(bet));
    return this.userBets(userId);
  }

  // ───────────────────────── Vistas ─────────────────────────

  publicBet(b) {
    return { id: b.id, uid: b.userId, user: b.username, amount: b.amount, bets: b.spots.map((s) => ({ ...s })), status: b.status, payout: b.payout };
  }

  userBets(userId) {
    const b = this.bets.get(userId);
    const live = b && b.status !== 'refunded';
    return { roundId: this.round ? this.round.id : null, bets: live ? b.spots.map((s) => ({ ...s })) : [], amount: live ? b.amount : 0 };
  }

  /** Mis apuestas en la Ruleta (rondas terminadas). */
  userHistory(userId, limit = 30) {
    return this.db
      .all(
        `SELECT b.id, b.round_id, b.bets, b.amount, b.payout, b.status, b.created_at, r.result
         FROM roulette_bets b JOIN roulette_rounds r ON r.id = b.round_id
         WHERE b.user_id = ? AND b.status IN ('won', 'lost', 'refunded')
         ORDER BY b.id DESC LIMIT ?`,
        userId,
        limit,
      )
      .map((b) => ({
        id: b.id,
        game: 'roulette',
        roundId: b.round_id,
        bets: parseSpots(b.bets),
        amount: b.amount,
        payout: b.payout,
        status: b.status,
        multiplier: b.payout > 0 ? Math.floor((b.payout * 100) / b.amount) : 0,
        result: b.status === 'refunded' ? null : b.result,
        createdAt: b.created_at,
      }));
  }

  /**
   * Para el panel de admin: lo apostado en cada lugar de la mesa y cuánto ganaría (+) o pagaría (−)
   * la casa según el número que salga. Nunca muestra el resultado antes del giro.
   */
  adminState() {
    const maxProfit = this.settings.get('max_profit');
    const live = [...this.bets.values()].filter((b) => b.status !== 'refunded');
    const total = live.reduce((s, b) => s + b.amount, 0);
    const spots = {};
    for (const b of live) for (const s of b.spots) spots[spotKey(s)] = (spots[spotKey(s)] || 0) + s.amount;
    const houseIf = [];
    for (let n = 0; n < core.ROULETTE_NUMBERS; n++) {
      let pay = 0;
      for (const b of live) pay += Math.min(core.roulettePayout(b.spots, n), b.amount + maxProfit);
      houseIf.push(total - pay);
    }
    let worst = 0;
    let best = 0;
    houseIf.forEach((v, n) => {
      if (v < houseIf[worst]) worst = n;
      if (v > houseIf[best]) best = n;
    });
    return {
      ...this._adminBase(),
      total,
      players: live.length,
      spots,
      houseIf,
      worst: { n: worst, house: houseIf[worst] },
      best: { n: best, house: houseIf[best] },
    };
  }
}

module.exports = { RouletteEngine, rouletteResult, spotName, spotsLabel, mergeSpots, SPIN_MS, RESULT_MS, COLOR_NAMES };
