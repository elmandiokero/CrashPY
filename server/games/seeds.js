'use strict';
const crypto = require('crypto');
const { AppError, sha256 } = require('../util');

const CLIENT_SEED_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Semillas provably fair de cada jugador (juegos individuales).
 * La semilla del servidor queda secreta mientras está en uso; al cambiarla se revela
 * y el jugador puede comprobar todas las jugadas que hizo con ella.
 */
class Seeds {
  constructor(db) {
    this.db = db;
  }

  _create(userId, clientSeed) {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const res = this.db.run(
      'INSERT INTO seeds (user_id, server_seed, server_hash, client_seed, nonce, active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
      userId,
      serverSeed,
      sha256(serverSeed),
      clientSeed || crypto.randomBytes(6).toString('hex'),
      Date.now(),
    );
    return this.db.get('SELECT * FROM seeds WHERE id = ?', Number(res.lastInsertRowid));
  }

  active(userId) {
    return this.db.get('SELECT * FROM seeds WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1', userId) || this._create(userId);
  }

  /** Reserva el próximo nonce del par de semillas activo. Llamar dentro de una transacción. */
  next(userId) {
    const s = this.active(userId);
    this.db.run('UPDATE seeds SET nonce = nonce + 1 WHERE id = ?', s.id);
    return { id: s.id, serverSeed: s.server_seed, clientSeed: s.client_seed, nonce: s.nonce };
  }

  publicInfo(userId) {
    const s = this.active(userId);
    const previous = this.db
      .all(
        `SELECT id, server_seed, server_hash, client_seed, nonce, created_at, revealed_at
         FROM seeds WHERE user_id = ? AND active = 0 ORDER BY id DESC LIMIT 15`,
        userId,
      )
      .map((p) => ({
        id: p.id,
        serverSeed: p.server_seed,
        serverHash: p.server_hash,
        clientSeed: p.client_seed,
        nonce: p.nonce,
        createdAt: p.created_at,
        revealedAt: p.revealed_at,
      }));
    return { current: { id: s.id, serverHash: s.server_hash, clientSeed: s.client_seed, nonce: s.nonce }, previous };
  }

  /** Cambia el par de semillas: revela la semilla vieja del servidor y crea una nueva. */
  rotate(userId, clientSeed) {
    const seed = clientSeed === undefined || clientSeed === null || clientSeed === '' ? null : String(clientSeed).trim();
    if (seed !== null && !CLIENT_SEED_RE.test(seed)) {
      throw new AppError('La semilla del cliente puede tener hasta 32 letras, números, guiones o guiones bajos');
    }
    const active = this.db.get("SELECT game FROM plays WHERE user_id = ? AND status = 'active' LIMIT 1", userId);
    if (active) {
      const name = active.game === 'mines' ? 'Minas' : 'Penales';
      throw new AppError(`Terminá tu partida de ${name} antes de cambiar las semillas`, 409, 'ACTIVE');
    }
    return this.db.tx(() => {
      this.db.run('UPDATE seeds SET active = 0, revealed_at = ? WHERE user_id = ? AND active = 1', Date.now(), userId);
      this._create(userId, seed);
      return this.publicInfo(userId);
    });
  }

  /** Datos para verificar una jugada; la semilla del servidor solo si ya fue revelada. */
  forVerify(seedId) {
    const s = this.db.get('SELECT * FROM seeds WHERE id = ?', seedId);
    if (!s) return null;
    return {
      serverHash: s.server_hash,
      clientSeed: s.client_seed,
      serverSeed: s.active ? null : s.server_seed,
      revealed: !s.active,
    };
  }
}

module.exports = { Seeds };
