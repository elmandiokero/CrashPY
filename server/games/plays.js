'use strict';
const crypto = require('crypto');
const core = require('../../public/js/games-core.js');
const { AppError, fmtGs, fmtMult, parseAmount } = require('../util');

const hmacBytes = (key, message) => crypto.createHmac('sha256', key).update(message).digest();

const GAME_NAMES = { mines: 'Minas', penalty: 'Penales', plinko: 'Plinko' };

const parseJSON = (s, def) => {
  try {
    return s ? JSON.parse(s) : def;
  } catch {
    return def;
  }
};

/**
 * Juegos individuales: cada jugada se decide con las semillas del jugador (provably fair).
 * Minas y Penales tienen varias jugadas dentro de la misma partida; Plinko es instantáneo.
 */
class PlayEngine {
  constructor({ db, wallet, settings, bus, seeds }) {
    this.db = db;
    this.wallet = wallet;
    this.settings = settings;
    this.bus = bus;
    this.seeds = seeds;
  }

  floats(seed, count) {
    return core.seedFloats(hmacBytes, seed.serverSeed, seed.clientSeed, seed.nonce, count);
  }

  // ───────────────────────── Ayudantes ─────────────────────────

  _checkGame(game) {
    if (!this.settings.get('game_' + game)) {
      throw new AppError(`${GAME_NAMES[game]} está desactivado por el momento`, 403, 'DISABLED');
    }
  }

  _amount(raw, { min = this.settings.get('min_bet'), max = this.settings.get('max_bet') } = {}) {
    const amount = parseAmount(raw);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Monto inválido');
    if (amount < min) throw new AppError(`La apuesta mínima es ${fmtGs(min)}`);
    if (amount > max) throw new AppError(`La apuesta máxima es ${fmtGs(max)}`);
    return amount;
  }

  _checkUser(userId) {
    const u = this.db.get('SELECT id, banned FROM users WHERE id = ?', userId);
    if (!u || u.banned) throw new AppError('Tu cuenta no está habilitada para jugar', 403, 'BANNED');
  }

  _load(id) {
    const row = this.db.get('SELECT p.*, u.username FROM plays p JOIN users u ON u.id = p.user_id WHERE p.id = ?', id);
    if (!row) return null;
    row.params = parseJSON(row.params, {});
    row.state = parseJSON(row.state, {});
    row.result = parseJSON(row.result, {});
    return row;
  }

  _activeFor(userId, game) {
    const row = this.db.get("SELECT id FROM plays WHERE user_id = ? AND game = ? AND status = 'active' ORDER BY id DESC LIMIT 1", userId, game);
    return row ? this._load(row.id) : null;
  }

  _requireActive(userId, id, game) {
    const play = id ? this._load(Number(id)) : this._activeFor(userId, game);
    if (!play || play.user_id !== userId || play.game !== game) throw new AppError('No tenés una partida en curso', 404, 'NO_PLAY');
    if (play.status !== 'active') throw new AppError('Esa partida ya terminó', 409, 'ENDED');
    return play;
  }

  /** Crea la jugada: descuenta la apuesta y fija el resultado con las semillas. */
  _create(userId, game, amount, params, makeResult, state) {
    return this.db.tx(() => {
      const seed = this.seeds.next(userId);
      const result = makeResult(seed);
      const res = this.db.run(
        `INSERT INTO plays (user_id, game, amount, params, state, result, multiplier, payout, status, seed_id, nonce, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?)`,
        userId,
        game,
        amount,
        JSON.stringify(params),
        JSON.stringify(state || {}),
        JSON.stringify(result),
        seed.id,
        seed.nonce,
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      this.wallet.change(userId, -amount, 'bet', { refId: id, note: `${GAME_NAMES[game]} #${id}` });
      this.db.run('UPDATE users SET total_bet = total_bet + ?, bets_count = bets_count + 1 WHERE id = ?', amount, userId);
      return this._load(id);
    });
  }

  /** Cierra la jugada y paga (con el tope de ganancia máxima por jugada). */
  _finish(play, { multiplier, payout, state }) {
    const cap = play.amount + this.settings.get('max_profit');
    let total = payout !== undefined ? payout : Math.floor((play.amount * multiplier) / 100);
    if (total > cap) total = cap;
    const effective = total > 0 ? Math.floor((total * 100) / play.amount) : 0;
    const status = total > 0 ? 'won' : 'lost';
    this.db.tx(() => {
      const res = this.db.run(
        "UPDATE plays SET status = ?, multiplier = ?, payout = ?, state = ?, ended_at = ? WHERE id = ? AND status = 'active'",
        status,
        effective,
        total,
        JSON.stringify(state !== undefined ? state : play.state),
        Date.now(),
        play.id,
      );
      if (res.changes !== 1) throw new AppError('Esa partida ya terminó', 409, 'ENDED');
      if (total > 0) {
        this.wallet.change(play.user_id, total, 'win', {
          refId: play.id,
          note: `${GAME_NAMES[play.game]} #${play.id} · ${fmtMult(effective)}`,
        });
        this.db.run(
          'UPDATE users SET total_won = total_won + ?, best_cashout = MAX(best_cashout, ?) WHERE id = ?',
          total,
          effective,
          play.user_id,
        );
      }
    });
    const done = this._load(play.id);
    // Plinko cierra la jugada dentro de otra transacción: avisamos recién cuando se confirma.
    this.db.onCommit(() => this._announce(done));
    return done;
  }

  /** Jugadas en vivo y, si corresponde, anuncio de ganancia grande en el chat. */
  _announce(done) {
    this.bus.emit('feed', {
      game: done.game,
      user: done.username,
      amount: done.amount,
      multiplier: done.multiplier,
      payout: done.payout,
      ts: done.ended_at,
    });
    const bigMult = Math.round(this.settings.get('bigwin_multiplier') * 100);
    const bigAmount = this.settings.get('bigwin_amount');
    if (done.payout > done.amount && (done.multiplier >= bigMult || (bigAmount > 0 && done.payout - done.amount >= bigAmount))) {
      this.bus.emit('bigwin', {
        game: done.game,
        user: done.username,
        userId: done.user_id,
        amount: done.amount,
        cashout: done.multiplier,
        payout: done.payout,
        roundId: done.id,
      });
    }
  }

  _capReached(play, multiplier) {
    return Math.floor((play.amount * multiplier) / 100) >= play.amount + this.settings.get('max_profit');
  }

  /** Lo que ve el jugador. Nunca incluye datos secretos de una partida en curso. */
  publicPlay(p) {
    if (!p) return null;
    const out = {
      id: p.id,
      game: p.game,
      amount: p.amount,
      params: p.params,
      status: p.status,
      multiplier: p.multiplier,
      payout: p.payout,
      nonce: p.nonce,
      createdAt: p.created_at,
      endedAt: p.ended_at,
    };
    if (p.game === 'mines') {
      out.revealed = p.state.revealed || [];
      out.hit = p.state.hit ?? null;
      if (p.status === 'active') {
        out.current = out.revealed.length ? core.minesMultiplier(p.params.mines, out.revealed.length) : 0;
        out.next = core.minesMultiplier(p.params.mines, out.revealed.length + 1);
      } else {
        out.mines = p.result.mines;
      }
    } else if (p.game === 'penalty') {
      out.kicks = p.state.kicks || [];
      const goals = out.kicks.filter((k) => k.goal).length;
      if (p.status === 'active') {
        out.current = core.penaltyMultiplier(goals);
        out.next = core.penaltyMultiplier(goals + 1);
      } else {
        out.keepers = p.result.keepers;
      }
    } else if (p.game === 'plinko') {
      out.path = p.result.path;
      out.bucket = p.result.bucket;
    }
    return out;
  }

  activePlays(userId) {
    return {
      mines: this.publicPlay(this._activeFor(userId, 'mines')),
      penalty: this.publicPlay(this._activeFor(userId, 'penalty')),
    };
  }

  // ───────────────────────── 💣 Minas ─────────────────────────

  minesStart(userId, data = {}) {
    this._checkGame('mines');
    this._checkUser(userId);
    const mines = Number(data.mines);
    if (!Number.isInteger(mines) || mines < 1 || mines > 24) throw new AppError('Elegí entre 1 y 24 minas');
    const amount = this._amount(data.amount);
    if (this._activeFor(userId, 'mines')) throw new AppError('Ya tenés una partida de Minas en curso', 409, 'ACTIVE');
    const play = this._create(userId, 'mines', amount, { mines }, (seed) => ({ mines: core.minesPositions(this.floats(seed, 24), mines) }), {
      revealed: [],
    });
    return this.publicPlay(play);
  }

  minesReveal(userId, data = {}) {
    const play = this._requireActive(userId, data.id, 'mines');
    const tile = Number(data.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= core.MINES_TILES) throw new AppError('Casilla inválida');
    const revealed = play.state.revealed || [];
    if (revealed.includes(tile)) throw new AppError('Esa casilla ya está destapada', 409, 'REVEALED');
    const mines = play.params.mines;
    if (play.result.mines.includes(tile)) {
      return this.publicPlay(this._finish(play, { multiplier: 0, state: { revealed: [...revealed, tile], hit: tile } }));
    }
    const next = [...revealed, tile];
    const multiplier = core.minesMultiplier(mines, next.length);
    if (next.length === core.MINES_TILES - mines || this._capReached(play, multiplier)) {
      return this.publicPlay(this._finish(play, { multiplier, state: { revealed: next } }));
    }
    const res = this.db.run(
      "UPDATE plays SET state = ?, multiplier = ? WHERE id = ? AND status = 'active'",
      JSON.stringify({ revealed: next }),
      multiplier,
      play.id,
    );
    if (res.changes !== 1) throw new AppError('Esa partida ya terminó', 409, 'ENDED');
    return this.publicPlay(this._load(play.id));
  }

  minesCashout(userId, data = {}) {
    const play = this._requireActive(userId, data.id, 'mines');
    const revealed = play.state.revealed || [];
    if (!revealed.length) throw new AppError('Destapá al menos una casilla para retirar');
    return this.publicPlay(this._finish(play, { multiplier: core.minesMultiplier(play.params.mines, revealed.length) }));
  }

  // ───────────────────────── ⚽ Penales ─────────────────────────

  penaltyStart(userId, data = {}) {
    this._checkGame('penalty');
    this._checkUser(userId);
    const amount = this._amount(data.amount);
    if (this._activeFor(userId, 'penalty')) throw new AppError('Ya tenés una tanda de penales en curso', 409, 'ACTIVE');
    const play = this._create(userId, 'penalty', amount, {}, (seed) => ({ keepers: core.penaltyKeepers(this.floats(seed, core.PENALTY_KICKS)) }), {
      kicks: [],
    });
    return this.publicPlay(play);
  }

  penaltyKick(userId, data = {}) {
    const play = this._requireActive(userId, data.id, 'penalty');
    const zone = Number(data.zone);
    if (!Number.isInteger(zone) || zone < 0 || zone >= core.PENALTY_ZONES) throw new AppError('Elegí dónde patear');
    const kicks = play.state.kicks || [];
    const keeper = play.result.keepers[kicks.length];
    const goal = zone !== keeper;
    const next = [...kicks, { zone, keeper, goal }];
    if (!goal) return this.publicPlay(this._finish(play, { multiplier: 0, state: { kicks: next } }));
    const goals = next.length;
    const multiplier = core.penaltyMultiplier(goals);
    if (goals === core.PENALTY_KICKS || this._capReached(play, multiplier)) {
      return this.publicPlay(this._finish(play, { multiplier, state: { kicks: next } }));
    }
    const res = this.db.run(
      "UPDATE plays SET state = ?, multiplier = ? WHERE id = ? AND status = 'active'",
      JSON.stringify({ kicks: next }),
      multiplier,
      play.id,
    );
    if (res.changes !== 1) throw new AppError('Esa tanda ya terminó', 409, 'ENDED');
    return this.publicPlay(this._load(play.id));
  }

  penaltyCashout(userId, data = {}) {
    const play = this._requireActive(userId, data.id, 'penalty');
    const goals = (play.state.kicks || []).filter((k) => k.goal).length;
    if (!goals) throw new AppError('Convertí al menos un gol para retirar');
    return this.publicPlay(this._finish(play, { multiplier: core.penaltyMultiplier(goals) }));
  }

  // ───────────────────────── 🔴 Plinko ─────────────────────────

  plinkoDrop(userId, data = {}) {
    this._checkGame('plinko');
    this._checkUser(userId);
    const rows = Number(data.rows);
    const risk = String(data.risk || '');
    if (!core.PLINKO_ROWS.includes(rows)) throw new AppError('Cantidad de filas inválida');
    if (!core.PLINKO_RISKS.includes(risk)) throw new AppError('Nivel de riesgo inválido');
    const amount = this._amount(data.amount);
    return this.db.tx(() => {
      const play = this._create(userId, 'plinko', amount, { rows, risk }, (seed) => {
        const r = core.plinkoResult(this.floats(seed, rows), rows, risk);
        return { path: r.path, bucket: r.bucket, multiplier: r.multiplier };
      });
      return this.publicPlay(this._finish(play, { multiplier: play.result.multiplier }));
    });
  }

  // ───────────────────────── Consultas ─────────────────────────

  history(userId, game, limit = 30) {
    const rows = game
      ? this.db.all("SELECT id FROM plays WHERE user_id = ? AND game = ? AND status != 'active' ORDER BY id DESC LIMIT ?", userId, game, limit)
      : this.db.all("SELECT id FROM plays WHERE user_id = ? AND status != 'active' ORDER BY id DESC LIMIT ?", userId, limit);
    return rows.map((r) => this.publicPlay(this._load(r.id)));
  }

  /** Detalle de una jugada terminada con los datos para verificarla. */
  details(id) {
    const p = this._load(Number(id));
    if (!p || p.status === 'active') return null;
    return { play: this.publicPlay(p), user: p.username, seed: this.seeds.forVerify(p.seed_id) };
  }
}

module.exports = { PlayEngine, GAME_NAMES };
