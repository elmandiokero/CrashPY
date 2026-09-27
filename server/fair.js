'use strict';
/**
 * PROVABLY FAIR (juego comprobable)
 * ---------------------------------
 * 1. Se genera una semilla secreta y se le aplica SHA-256 una y otra vez, formando una cadena:
 *      h[0] = semilla,  h[k] = SHA256(h[k-1])   (el hash se aplica al texto hexadecimal)
 * 2. Se publica el ÚLTIMO eslabón h[N] (hash terminal) ANTES de jugar cualquier ronda.
 * 3. Las rondas usan la cadena al revés: ronda 1 → h[N-1], ronda 2 → h[N-2], ...
 *    Así nadie (ni la casa) puede cambiar resultados futuros: cada hash revelado,
 *    al aplicarle SHA-256, tiene que dar el hash de la ronda anterior.
 * 4. El punto de explosión sale del hash de la ronda con una fórmula pública:
 *      hmac = HMAC_SHA256(clave = sal, mensaje = hash)
 *      r    = primeros 52 bits de hmac  (13 caracteres hex)
 *      X    = r / 2^52                  (número uniforme entre 0 y 1)
 *      crash = floor( (100 - ventaja%) / (1 - X) ) / 100    (mínimo 1.00x)
 */
const crypto = require('crypto');

const CHECKPOINT_EVERY = 1000;
const TWO_POW_52 = 4503599627370496;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Punto de explosión en centésimas (250 = 2.50x). */
function crashPointFromHash(gameHash, salt, houseEdgeBps) {
  const hmac = crypto.createHmac('sha256', salt).update(gameHash).digest('hex');
  const r = parseInt(hmac.slice(0, 13), 16);
  const x = r / TWO_POW_52;
  const crash = Math.floor((10000 - houseEdgeBps) / 100 / (1 - x));
  return Math.max(100, crash);
}

/** Multiplicador (centésimas) después de `ms` milisegundos de vuelo. */
function multiplierAt(ms, growth) {
  return Math.floor(100 * Math.exp(growth * Math.max(0, ms)));
}

/** Milisegundos necesarios para llegar a un multiplicador (centésimas). */
function msForMultiplier(m100, growth) {
  return Math.log(m100 / 100) / growth;
}

class ChainManager {
  constructor(db, { game = 'crash', length, defaultEdgeBps, log = console.log }) {
    this.db = db;
    this.game = game;
    this.label = game === 'crash' ? '' : ` (${game})`;
    this.length = length;
    this.defaultEdgeBps = defaultEdgeBps;
    this.log = log;
    this.active = null;
    this.checkpoints = null;
    this.pendingRotation = null;
  }

  init() {
    const row = this.db.get('SELECT * FROM chains WHERE active = 1 AND game = ? ORDER BY id DESC LIMIT 1', this.game);
    if (row) this._load(row);
    else this._create(this.defaultEdgeBps);
  }

  _build(seed, length) {
    const checkpoints = new Array(Math.floor(length / CHECKPOINT_EVERY) + 1);
    let h = seed;
    for (let i = 0; i <= length; i++) {
      if (i % CHECKPOINT_EVERY === 0) checkpoints[i / CHECKPOINT_EVERY] = h;
      if (i < length) h = sha256(h);
    }
    return { checkpoints, terminal: h };
  }

  _load(row) {
    const t0 = Date.now();
    const { checkpoints, terminal } = this._build(row.seed, row.length);
    if (terminal !== row.terminal_hash) {
      throw new Error(`La cadena de hashes #${row.id} está corrupta (el hash terminal no coincide).`);
    }
    this.active = row;
    this.checkpoints = checkpoints;
    this.log(`🔐 Cadena provably fair${this.label} #${row.id} lista (${row.used.toLocaleString('es-PY')} de ${row.length.toLocaleString('es-PY')} rondas usadas, ${Date.now() - t0} ms)`);
  }

  _create(edgeBps) {
    const t0 = Date.now();
    const seed = crypto.randomBytes(32).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const { checkpoints, terminal } = this._build(seed, this.length);
    const now = Date.now();
    this.db.tx(() => {
      this.db.run('UPDATE chains SET active = 0, ended_at = ? WHERE active = 1 AND game = ?', now, this.game);
      const res = this.db.run(
        'INSERT INTO chains (game, seed, terminal_hash, salt, house_edge_bps, length, used, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)',
        this.game,
        seed,
        terminal,
        salt,
        edgeBps,
        this.length,
        now,
      );
      this.active = this.db.get('SELECT * FROM chains WHERE id = ?', Number(res.lastInsertRowid));
    });
    this.checkpoints = checkpoints;
    this.log(`🔐 Nueva cadena provably fair${this.label} #${this.active.id} generada (${this.length.toLocaleString('es-PY')} rondas, ventaja ${(edgeBps / 100).toFixed(2)}%, ${Date.now() - t0} ms)`);
    this.log(`   Hash terminal publicado: ${terminal}`);
  }

  /** Hash de la ronda número `index` (1 = primera) de la cadena activa. */
  hashAt(index) {
    const pos = this.active.length - index;
    const cp = Math.floor(pos / CHECKPOINT_EVERY);
    let h = this.checkpoints[cp];
    for (let i = cp * CHECKPOINT_EVERY; i < pos; i++) h = sha256(h);
    return h;
  }

  /** Reserva el próximo hash. Llamar dentro de una transacción. */
  next() {
    if (this.pendingRotation !== null || this.active.used >= this.active.length) {
      const edge = this.pendingRotation ?? this.active.house_edge_bps;
      this.pendingRotation = null;
      this._create(edge);
    }
    const index = this.active.used + 1;
    this.db.run('UPDATE chains SET used = ? WHERE id = ?', index, this.active.id);
    this.active.used = index;
    return {
      chainId: this.active.id,
      index,
      hash: this.hashAt(index),
      salt: this.active.salt,
      edgeBps: this.active.house_edge_bps,
    };
  }

  /**
   * Pide generar una cadena nueva (por ejemplo para cambiar la ventaja de la casa).
   * Se aplica recién en la próxima ronda, así la semilla vieja se revela cuando ya
   * no queda ninguna ronda pendiente de esa cadena.
   */
  requestRotation(edgeBps) {
    this.pendingRotation = edgeBps;
  }

  summary() {
    const a = this.active;
    return {
      chainId: a.id,
      terminalHash: a.terminal_hash,
      salt: a.salt,
      houseEdgeBps: a.house_edge_bps,
      length: a.length,
      used: a.used,
      createdAt: a.created_at,
      pendingRotation: this.pendingRotation,
    };
  }

  /** Información pública: cadena actual + cadenas terminadas con su semilla revelada. */
  publicInfo() {
    const previous = this.db.all(
      `SELECT id, seed, terminal_hash, salt, house_edge_bps, length, used, created_at, ended_at
       FROM chains WHERE active = 0 AND game = ? ORDER BY id DESC LIMIT 20`,
      this.game,
    );
    return { current: this.summary(), previous };
  }
}

module.exports = { ChainManager, crashPointFromHash, multiplierAt, msForMultiplier, sha256 };
