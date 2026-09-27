'use strict';
const EventEmitter = require('events');
const { crashPointFromHash, multiplierAt, msForMultiplier } = require('./fair');
const { AppError, fmtGs, fmtMult, parseAmount, parseMultiplier } = require('./util');

const TICK_MS = 50; // cada cuánto se revisan los retiros automáticos
const BROADCAST_MS = 200; // cada cuánto se sincroniza el reloj con los clientes
const POST_CRASH_MS = 4000; // pausa después de la explosión
const BASE_GROWTH = 0.00006; // 2x a los ~11,5 s · 10x a los ~38 s
const HISTORY_SIZE = 50;
const MAX_AUTO_CASHOUT = 100_000_000; // 1.000.000,00x

/**
 * Motor del juego. Ciclo: BETTING (apuestas) → RUNNING (vuelo) → CRASHED (explotó) → BETTING ...
 * El punto de explosión de cada ronda sale de la cadena de hashes (ver fair.js) y nunca
 * se envía a los jugadores antes de que la ronda termine.
 */
class GameEngine extends EventEmitter {
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
    this.bets = new Map(); // betId → apuesta de la ronda actual
    this.byUser = new Map(); // userId → [panel 0, panel 1]
    this.history = [];
    this.lastCrash = null;
    this.paused = false;
    this.crashMs = Infinity;
    this.lastBroadcast = 0;
    this.phaseTimer = null;
    this.crashTimer = null;
    this.ticker = null;
  }

  // ───────────────────────── Ciclo de vida ─────────────────────────

  start() {
    this._recover();
    this.history = this.db
      .all(
        "SELECT id, crash_point, ended_multiplier, status FROM rounds WHERE status IN ('crashed', 'cancelled') ORDER BY id DESC LIMIT ?",
        HISTORY_SIZE,
      )
      .map((r) => ({
        id: r.id,
        crash: r.status === 'crashed' ? r.crash_point : r.ended_multiplier,
        cancelled: r.status === 'cancelled',
      }));
    this._startBetting();
  }

  /** Si el servidor se cortó en medio de una ronda, se anula y se devuelven las apuestas. */
  _recover() {
    const now = Date.now();
    for (const row of this.db.all("SELECT * FROM rounds WHERE status = 'running'")) {
      this.db.tx(() => {
        for (const b of this.db.all("SELECT * FROM bets WHERE round_id = ? AND status = 'active'", row.id)) {
          this._refundRow(b, `Ronda #${row.id} anulada (reinicio del servidor)`);
        }
        const round = this._roundFromRow(row);
        round.endedAt = now;
        this._finalizeRound(round, 'cancelled', null, 'server');
      });
      this.log(`♻️  Ronda #${row.id} anulada por reinicio: apuestas devueltas`);
    }
    const pending = this.db.all("SELECT * FROM rounds WHERE status = 'betting' ORDER BY id DESC");
    pending.forEach((row, i) => {
      this.db.tx(() => {
        for (const b of this.db.all("SELECT * FROM bets WHERE round_id = ? AND status = 'active'", row.id)) {
          this._refundRow(b, `Apuesta devuelta (reinicio del servidor)`);
        }
        // Solo debería existir una; si hubiera más, las viejas se anulan sin revelar nada nuevo.
        if (i > 0) {
          const round = this._roundFromRow(row);
          round.endedAt = now;
          this._finalizeRound(round, 'cancelled', null, 'server');
        }
      });
    });
    if (pending.length) this.round = this._roundFromRow(pending[0]);
  }

  _roundFromRow(row) {
    return {
      id: row.id,
      chainId: row.chain_id,
      chainIndex: row.chain_index,
      hash: row.hash,
      crashPoint: row.crash_point,
      growth: row.growth,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      bettingEndsAt: 0,
    };
  }

  _clearTimers() {
    clearTimeout(this.phaseTimer);
    clearTimeout(this.crashTimer);
    clearInterval(this.ticker);
    this.phaseTimer = null;
    this.crashTimer = null;
    this.ticker = null;
  }

  /** Ejecuta un paso del ciclo sin que un error inesperado detenga el juego. */
  _safe(fn) {
    try {
      fn();
    } catch (err) {
      this.log('❌ Error en el motor del juego:', err);
      this._clearTimers();
      try {
        this._voidCurrentRound('server', 'Ronda anulada por un error del servidor');
      } catch (err2) {
        this.log('❌ No se pudo anular la ronda:', err2);
      }
      this.phaseTimer = setTimeout(() => this._safe(() => this._startBetting()), 5000);
    }
  }

  _startBetting() {
    this._clearTimers();
    this.bets.clear();
    this.byUser.clear();
    this.lastCrash = null;
    if (this.paused) {
      this.phase = 'PAUSED';
      this.emit('paused', { paused: true, phase: this.phase });
      return;
    }
    if (!this.round || this.round.status !== 'betting') this.round = this._createRound();
    const ms = this.settings.get('betting_seconds') * 1000;
    this.round.bettingEndsAt = Date.now() + ms;
    this.phase = 'BETTING';
    this.emit('betting', { roundId: this.round.id, ms, growth: this.round.growth });
    this.phaseTimer = setTimeout(() => this._safe(() => this._startRunning()), ms);
  }

  _createRound() {
    const growth = BASE_GROWTH * this.settings.get('speed');
    return this.db.tx(() => {
      const next = this.chains.next();
      const crashPoint = crashPointFromHash(next.hash, next.salt, next.edgeBps);
      const now = Date.now();
      const res = this.db.run(
        "INSERT INTO rounds (chain_id, chain_index, hash, crash_point, status, growth, created_at) VALUES (?, ?, ?, ?, 'betting', ?, ?)",
        next.chainId,
        next.index,
        next.hash,
        crashPoint,
        growth,
        now,
      );
      return {
        id: Number(res.lastInsertRowid),
        chainId: next.chainId,
        chainIndex: next.index,
        hash: next.hash,
        crashPoint,
        growth,
        status: 'betting',
        startedAt: null,
        endedAt: null,
        bettingEndsAt: 0,
      };
    });
  }

  _startRunning() {
    this._clearTimers();
    const r = this.round;
    r.status = 'running';
    r.startedAt = Date.now();
    this.db.run("UPDATE rounds SET status = 'running', started_at = ? WHERE id = ?", r.startedAt, r.id);
    this.phase = 'RUNNING';
    this.crashMs = msForMultiplier(r.crashPoint, r.growth);
    this.lastBroadcast = r.startedAt;
    this.emit('start', { roundId: r.id, growth: r.growth });
    if (r.crashPoint <= 100) {
      this._crash(); // explota en 1.00x
      return;
    }
    this.ticker = setInterval(() => this._safe(() => this._tick()), TICK_MS);
    this.crashTimer = setTimeout(() => this._safe(() => this._crash()), Math.ceil(this.crashMs));
  }

  _tick() {
    if (this.phase !== 'RUNNING') return;
    const now = Date.now();
    const elapsed = now - this.round.startedAt;
    if (elapsed >= this.crashMs) {
      this._crash();
      return;
    }
    const m = multiplierAt(elapsed, this.round.growth);
    for (const bet of this.bets.values()) {
      if (bet.status === 'active' && bet.target <= m) this._settleSafe(bet, bet.target);
    }
    if (now - this.lastBroadcast >= BROADCAST_MS) {
      this.lastBroadcast = now;
      this.emit('tick', { e: elapsed });
    }
  }

  _crash() {
    if (this.phase !== 'RUNNING') return;
    this._clearTimers();
    const r = this.round;
    // Retiros automáticos justo en el punto de explosión: el empate favorece al jugador.
    for (const bet of this.bets.values()) {
      if (bet.status === 'active' && bet.target <= r.crashPoint) this._settleSafe(bet, bet.target);
    }
    r.status = 'crashed';
    r.endedAt = Date.now();
    this.phase = 'CRASHED';
    this.db.tx(() => {
      this.db.run("UPDATE bets SET status = 'lost' WHERE round_id = ? AND status = 'active'", r.id);
      this._finalizeRound(r, 'crashed', r.crashPoint, null);
    });
    const losers = [];
    for (const bet of this.bets.values()) {
      if (bet.status === 'active') {
        bet.status = 'lost';
        losers.push(bet);
      }
    }
    this._pushHistory({ id: r.id, crash: r.crashPoint, cancelled: false });
    this.lastCrash = { roundId: r.id, crash: r.crashPoint, hash: r.hash, cancelled: false, nextIn: POST_CRASH_MS };
    this.emit('crash', this.lastCrash);
    for (const bet of losers) {
      this.bus.emit('myBet', bet.userId, this.privateBet(bet));
      this.bus.emit('feed', { game: 'crash', user: bet.username, amount: bet.amount, multiplier: 0, payout: 0, ts: r.endedAt });
    }
    this.phaseTimer = setTimeout(() => this._safe(() => this._startBetting()), POST_CRASH_MS);
  }

  _finalizeRound(r, status, endedMultiplier, cancelMode) {
    const t = this.db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN amount END), 0) AS bet,
         COALESCE(SUM(payout), 0) AS payout,
         COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount END), 0) AS refund,
         COUNT(DISTINCT CASE WHEN status IN ('won', 'lost') THEN user_id END) AS players
       FROM bets WHERE round_id = ?`,
      r.id,
    );
    this.db.run(
      `UPDATE rounds SET status = ?, ended_at = ?, ended_multiplier = ?, cancel_mode = ?,
         total_bet = ?, total_payout = ?, total_refund = ?, players = ? WHERE id = ?`,
      status,
      r.endedAt,
      endedMultiplier,
      cancelMode,
      t.bet,
      t.payout,
      t.refund,
      t.players,
      r.id,
    );
  }

  _pushHistory(entry) {
    this.history.unshift(entry);
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
  }

  // ───────────────────────── Apuestas ─────────────────────────

  placeBet(userId, data = {}) {
    if (this.phase !== 'BETTING') {
      throw new AppError('Las apuestas están cerradas, esperá la próxima ronda', 409, 'NOT_BETTING');
    }
    const slot = Number(data.slot);
    if (slot !== 0 && slot !== 1) throw new AppError('Panel de apuesta inválido');
    const amount = parseAmount(data.amount);
    const minBet = this.settings.get('min_bet');
    const maxBet = this.settings.get('max_bet');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Monto inválido');
    if (amount < minBet) throw new AppError(`La apuesta mínima es ${fmtGs(minBet)}`);
    if (amount > maxBet) throw new AppError(`La apuesta máxima es ${fmtGs(maxBet)}`);
    let auto = parseMultiplier(data.auto);
    if (auto !== null) {
      if (!Number.isFinite(auto) || auto < 101) throw new AppError('El retiro automático tiene que ser 1.01x o más');
      auto = Math.min(auto, MAX_AUTO_CASHOUT);
    }
    const user = this.db.get('SELECT id, username, banned FROM users WHERE id = ?', userId);
    if (!user || user.banned) throw new AppError('Tu cuenta no está habilitada para jugar', 403, 'BANNED');
    const mine = this.byUser.get(userId) || [null, null];
    if (mine[slot]) throw new AppError('Ya tenés una apuesta en este panel', 409, 'DUPLICATE');

    const r = this.round;
    // Tope de ganancia por apuesta: al llegar se retira automáticamente.
    const cap = Math.max(101, Math.floor(((amount + this.settings.get('max_profit')) * 100) / amount));
    const now = Date.now();
    const bet = this.db.tx(() => {
      const res = this.db.run(
        "INSERT INTO bets (round_id, user_id, slot, amount, auto_cashout, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        r.id,
        userId,
        slot,
        amount,
        auto,
        now,
      );
      const id = Number(res.lastInsertRowid);
      this.wallet.change(userId, -amount, 'bet', { refId: id, note: `Apuesta ronda #${r.id}` });
      this.db.run('UPDATE users SET total_bet = total_bet + ?, bets_count = bets_count + 1 WHERE id = ?', amount, userId);
      return {
        id,
        roundId: r.id,
        userId,
        username: user.username,
        slot,
        amount,
        auto,
        cap,
        target: Math.min(auto ?? Infinity, cap),
        status: 'active',
        cashout: null,
        payout: 0,
        createdAt: now,
      };
    });
    this.bets.set(bet.id, bet);
    mine[slot] = bet;
    this.byUser.set(userId, mine);
    this.emit('bet', this.publicBet(bet));
    this.bus.emit('myBet', userId, this.privateBet(bet));
    return bet;
  }

  cancelBet(userId, slot) {
    if (this.phase !== 'BETTING') throw new AppError('La ronda ya empezó, no se puede cancelar', 409, 'NOT_BETTING');
    const mine = this.byUser.get(userId);
    const bet = mine && mine[slot];
    if (!bet || bet.status !== 'active') throw new AppError('No tenés una apuesta en este panel', 404, 'NO_BET');
    this.db.tx(() => {
      this.db.run("UPDATE bets SET status = 'cancelled' WHERE id = ? AND status = 'active'", bet.id);
      this.wallet.change(userId, bet.amount, 'bet_cancel', { refId: bet.id, note: `Apuesta cancelada ronda #${bet.roundId}` });
      this.db.run('UPDATE users SET total_bet = total_bet - ?, bets_count = bets_count - 1 WHERE id = ?', bet.amount, userId);
    });
    bet.status = 'cancelled';
    this.bets.delete(bet.id);
    mine[slot] = null;
    this.emit('betCancel', { id: bet.id, uid: userId, slot });
    this.bus.emit('myBet', userId, this.privateBet(bet));
    return bet;
  }

  /** Retiro manual: se paga al multiplicador que marca el servidor en ese instante. */
  cashout(userId, slot) {
    if (this.phase !== 'RUNNING') {
      const msg = this.phase === 'CRASHED' ? '¡Muy tarde! Ya explotó 💥' : 'La ronda todavía no despegó';
      throw new AppError(msg, 409, 'NOT_RUNNING');
    }
    const mine = this.byUser.get(userId);
    const bet = mine && mine[slot];
    if (!bet || bet.status !== 'active') throw new AppError('No tenés una apuesta activa en este panel', 404, 'NO_BET');
    const elapsed = Date.now() - this.round.startedAt;
    if (elapsed >= this.crashMs) {
      this._crash();
      throw new AppError('¡Muy tarde! Ya explotó 💥', 409, 'TOO_LATE');
    }
    let m = multiplierAt(elapsed, this.round.growth);
    if (bet.target <= m) m = bet.target; // el retiro automático ya correspondía
    this._settle(bet, m);
    return bet;
  }

  _settleSafe(bet, m) {
    try {
      this._settle(bet, m);
    } catch (err) {
      this.log(`❌ No se pudo pagar la apuesta #${bet.id}:`, err);
    }
  }

  _settle(bet, m) {
    const r = this.round;
    const payout = Math.floor((bet.amount * m) / 100);
    this.db.tx(() => {
      const res = this.db.run(
        "UPDATE bets SET status = 'won', cashout = ?, payout = ? WHERE id = ? AND status = 'active'",
        m,
        payout,
        bet.id,
      );
      if (res.changes !== 1) throw new AppError('La apuesta ya no está activa', 409, 'NOT_ACTIVE');
      this.wallet.change(bet.userId, payout, 'win', { refId: bet.id, note: `Ronda #${r.id} · retiro a ${fmtMult(m)}` });
      this.db.run(
        'UPDATE users SET total_won = total_won + ?, best_cashout = MAX(best_cashout, ?) WHERE id = ?',
        payout,
        m,
        bet.userId,
      );
    });
    bet.status = 'won';
    bet.cashout = m;
    bet.payout = payout;
    this.emit('cashout', {
      id: bet.id,
      uid: bet.userId,
      user: bet.username,
      slot: bet.slot,
      amount: bet.amount,
      cashout: m,
      payout,
    });
    this.bus.emit('myBet', bet.userId, this.privateBet(bet));
    this.bus.emit('feed', { game: 'crash', user: bet.username, amount: bet.amount, multiplier: m, payout, ts: Date.now() });
    const bigMult = Math.round(this.settings.get('bigwin_multiplier') * 100);
    const bigAmount = this.settings.get('bigwin_amount');
    if (m >= bigMult || (bigAmount > 0 && payout - bet.amount >= bigAmount)) {
      this.bus.emit('bigwin', { game: 'crash', user: bet.username, userId: bet.userId, amount: bet.amount, cashout: m, payout, roundId: r.id });
    }
    return payout;
  }

  _refund(bet, note) {
    this.db.tx(() => {
      const res = this.db.run("UPDATE bets SET status = 'refunded' WHERE id = ? AND status = 'active'", bet.id);
      if (res.changes !== 1) return;
      this.wallet.change(bet.userId, bet.amount, 'refund', { refId: bet.id, note });
      this.db.run('UPDATE users SET total_bet = total_bet - ?, bets_count = bets_count - 1 WHERE id = ?', bet.amount, bet.userId);
    });
    bet.status = 'refunded';
    this.emit('betRefund', { id: bet.id, uid: bet.userId, slot: bet.slot });
    this.bus.emit('myBet', bet.userId, this.privateBet(bet));
  }

  _refundRow(row, note) {
    const res = this.db.run("UPDATE bets SET status = 'refunded' WHERE id = ? AND status = 'active'", row.id);
    if (res.changes !== 1) return;
    this.wallet.change(row.user_id, row.amount, 'refund', { refId: row.id, note });
    this.db.run('UPDATE users SET total_bet = total_bet - ?, bets_count = bets_count - 1 WHERE id = ?', row.amount, row.user_id);
  }

  // ───────────────────────── Controles del administrador ─────────────────────────

  /**
   * Botón "💥 Explotar ahora". Corta la ronda en vuelo de forma SEGURA para los jugadores:
   *   mode = 'refund' → se anula la ronda y se devuelve lo apostado a quien no retiró.
   *   mode = 'pay'    → se paga a todos al multiplicador actual.
   * Nadie pierde plata por una intervención manual, y el hash de la ronda se sigue revelando
   * (queda marcada como "anulada" en el historial, así cualquiera puede comprobarlo).
   */
  adminStop(mode) {
    if (mode !== 'refund' && mode !== 'pay') throw new AppError('Modo inválido');
    if (this.phase !== 'RUNNING') throw new AppError('Solo se puede explotar una ronda que está en vuelo', 409);
    const r = this.round;
    const now = Date.now();
    const elapsed = now - r.startedAt;
    if (elapsed >= this.crashMs) {
      this._crash();
      throw new AppError('La ronda ya había explotado sola', 409);
    }
    this._clearTimers();
    const m = multiplierAt(elapsed, r.growth);
    for (const bet of this.bets.values()) {
      if (bet.status === 'active' && bet.target <= m) this._settleSafe(bet, bet.target);
    }
    let affected = 0;
    for (const bet of this.bets.values()) {
      if (bet.status !== 'active') continue;
      affected++;
      if (mode === 'pay') this._settleSafe(bet, m);
      else this._refund(bet, `Ronda #${r.id} anulada por el administrador`);
    }
    r.status = 'cancelled';
    r.endedAt = now;
    this.phase = 'CRASHED';
    this.db.tx(() => this._finalizeRound(r, 'cancelled', m, mode));
    this._pushHistory({ id: r.id, crash: m, cancelled: true });
    this.lastCrash = {
      roundId: r.id,
      crash: m,
      hash: r.hash,
      realCrash: r.crashPoint,
      cancelled: true,
      mode,
      nextIn: POST_CRASH_MS,
    };
    this.emit('crash', this.lastCrash);
    this.phaseTimer = setTimeout(() => this._safe(() => this._startBetting()), POST_CRASH_MS);
    return { multiplier: m, affected, realCrash: r.crashPoint };
  }

  /** Pausa el juego. Si se está apostando se devuelven las apuestas; si está en vuelo, termina la ronda y frena. */
  pause() {
    this.paused = true;
    if (this.phase === 'BETTING') {
      this._clearTimers();
      for (const bet of this.bets.values()) if (bet.status === 'active') this._refund(bet, 'Juego pausado: apuesta devuelta');
      this.bets.clear();
      this.byUser.clear();
      this.phase = 'PAUSED';
    }
    this.emit('paused', { paused: true, phase: this.phase });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.emit('paused', { paused: false, phase: this.phase });
    if (this.phase === 'PAUSED') this._startBetting();
  }

  /** Anula la ronda actual devolviendo apuestas (apagado del servidor o error). */
  _voidCurrentRound(mode, note) {
    const r = this.round;
    if (!r) return;
    if (this.phase === 'RUNNING' || r.status === 'running') {
      const now = Date.now();
      const m = r.startedAt ? Math.min(multiplierAt(now - r.startedAt, r.growth), r.crashPoint) : 100;
      for (const bet of this.bets.values()) {
        if (bet.status === 'active' && bet.target <= m) this._settleSafe(bet, bet.target);
      }
      for (const bet of this.bets.values()) if (bet.status === 'active') this._refund(bet, note);
      r.status = 'cancelled';
      r.endedAt = now;
      this.db.tx(() => this._finalizeRound(r, 'cancelled', m, mode));
      this._pushHistory({ id: r.id, crash: m, cancelled: true });
      this.lastCrash = { roundId: r.id, crash: m, hash: r.hash, realCrash: r.crashPoint, cancelled: true, mode, nextIn: 5000 };
      this.phase = 'CRASHED';
      this.emit('crash', this.lastCrash);
    } else if (this.phase === 'BETTING') {
      for (const bet of this.bets.values()) if (bet.status === 'active') this._refund(bet, note);
      this.bets.clear();
      this.byUser.clear();
    }
  }

  shutdown() {
    this._clearTimers();
    try {
      this._voidCurrentRound('server', 'Ronda anulada: el servidor se apagó');
    } catch (err) {
      this.log('Error al cerrar la ronda:', err);
    }
    this.phase = 'STOPPED';
  }

  // ───────────────────────── Vistas ─────────────────────────

  publicBet(b) {
    return { id: b.id, uid: b.userId, user: b.username, slot: b.slot, amount: b.amount, status: b.status, cashout: b.cashout, payout: b.payout };
  }

  privateBet(b) {
    return { id: b.id, roundId: b.roundId, slot: b.slot, amount: b.amount, auto: b.auto, status: b.status, cashout: b.cashout, payout: b.payout };
  }

  publicBets() {
    const out = [];
    for (const b of this.bets.values()) if (b.status !== 'cancelled') out.push(this.publicBet(b));
    return out;
  }

  userBets(userId) {
    const mine = this.byUser.get(userId) || [null, null];
    return mine.map((b) => (b ? this.privateBet(b) : null));
  }

  publicState() {
    const r = this.round;
    const now = Date.now();
    const state = {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      growth: r ? r.growth : BASE_GROWTH,
      bettingMs: this.settings.get('betting_seconds') * 1000,
      history: this.history,
      bets: this.publicBets(),
    };
    if (this.phase === 'BETTING') state.bettingLeft = Math.max(0, r.bettingEndsAt - now);
    if (this.phase === 'RUNNING') state.elapsed = now - r.startedAt;
    if (this.phase === 'CRASHED' && this.lastCrash) {
      state.last = { ...this.lastCrash, nextIn: Math.max(0, (r.endedAt || now) + this.lastCrash.nextIn - now) };
    }
    return state;
  }

  /** Estado detallado para el panel de admin (incluye retiros automáticos; nunca el punto de explosión). */
  adminState() {
    const r = this.round;
    const now = Date.now();
    let totalBet = 0;
    let totalPayout = 0;
    let activeAmount = 0;
    const players = new Set();
    const bets = [];
    for (const b of this.bets.values()) {
      if (b.status === 'cancelled' || b.status === 'refunded') continue;
      totalBet += b.amount;
      totalPayout += b.payout;
      if (b.status === 'active') activeAmount += b.amount;
      players.add(b.userId);
      bets.push({ ...this.publicBet(b), auto: b.auto, cap: b.cap });
    }
    bets.sort((a, b) => b.amount - a.amount);
    return {
      phase: this.phase,
      paused: this.paused,
      roundId: r ? r.id : null,
      growth: r ? r.growth : BASE_GROWTH,
      elapsed: this.phase === 'RUNNING' ? now - r.startedAt : null,
      bettingLeft: this.phase === 'BETTING' ? Math.max(0, r.bettingEndsAt - now) : null,
      last:
        this.phase === 'CRASHED' && this.lastCrash
          ? { ...this.lastCrash, nextIn: Math.max(0, (r.endedAt || now) + this.lastCrash.nextIn - now) }
          : null,
      totals: { bet: totalBet, payout: totalPayout, active: activeAmount, players: players.size, count: bets.length },
      bets,
    };
  }
}

module.exports = { GameEngine, BASE_GROWTH, POST_CRASH_MS };
