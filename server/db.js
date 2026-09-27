'use strict';
const fs = require('fs');
const path = require('path');

// node:sqlite imprime un "ExperimentalWarning" al cargarse; lo silenciamos para no asustar a nadie.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0] && args[0].type;
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(String(msg))) return;
  return originalEmitWarning.call(process, warning, ...args);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('\n❌ Tu versión de Node.js no trae SQLite integrado.');
  console.error('   Instalá Node.js 22.13 o superior (recomendado: la versión LTS) desde https://nodejs.org\n');
  process.exit(1);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pass_hash TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  banned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  total_bet INTEGER NOT NULL DEFAULT 0,
  total_won INTEGER NOT NULL DEFAULT 0,
  total_deposit INTEGER NOT NULL DEFAULT 0,
  total_withdraw INTEGER NOT NULL DEFAULT 0,
  bets_count INTEGER NOT NULL DEFAULT 0,
  best_cashout INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  created_ip TEXT,
  last_seen INTEGER,
  last_ip TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Libro contable: TODO cambio de saldo queda registrado acá
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_id INTEGER,
  note TEXT,
  admin_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);

-- Cadenas de hashes (provably fair)
CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed TEXT NOT NULL,
  terminal_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  house_edge_bps INTEGER NOT NULL,
  length INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  chain_index INTEGER NOT NULL,
  hash TEXT NOT NULL,
  crash_point INTEGER NOT NULL,
  ended_multiplier INTEGER,
  status TEXT NOT NULL,
  cancel_mode TEXT,
  growth REAL NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  total_bet INTEGER NOT NULL DEFAULT 0,
  total_payout INTEGER NOT NULL DEFAULT 0,
  total_refund INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chain_id, chain_index)
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);
CREATE INDEX IF NOT EXISTS idx_rounds_ended ON rounds(ended_at);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  auto_cashout INTEGER,
  cashout INTEGER,
  payout INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id);
CREATE INDEX IF NOT EXISTS idx_bets_created ON bets(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_slot ON bets(round_id, user_id, slot)
  WHERE status NOT IN ('cancelled', 'refunded');

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  credited INTEGER,
  reference TEXT,
  sender_name TEXT,
  sender_bank TEXT,
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  admin_id INTEGER,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, id);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  bank TEXT NOT NULL,
  account_type TEXT,
  account TEXT NOT NULL,
  holder TEXT NOT NULL,
  holder_doc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  admin_id INTEGER,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  role TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  text TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_name TEXT,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);

-- Semillas provably fair de cada jugador (Minas, Penales, Plinko)
CREATE TABLE IF NOT EXISTS seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  server_seed TEXT NOT NULL,
  server_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  revealed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seeds_user ON seeds(user_id, active);

-- Jugadas individuales (Minas, Penales, Plinko)
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  amount INTEGER NOT NULL,
  params TEXT,
  state TEXT,
  result TEXT,
  multiplier INTEGER NOT NULL DEFAULT 0,
  payout INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  seed_id INTEGER NOT NULL REFERENCES seeds(id),
  nonce INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id, id);
CREATE INDEX IF NOT EXISTS idx_plays_game ON plays(game, ended_at);
CREATE INDEX IF NOT EXISTS idx_plays_active ON plays(user_id, game, status);

-- Double (ruleta de colores multijugador)
CREATE TABLE IF NOT EXISTS double_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  chain_index INTEGER NOT NULL,
  hash TEXT NOT NULL,
  result INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  spun_at INTEGER,
  ended_at INTEGER,
  total_bet INTEGER NOT NULL DEFAULT 0,
  total_payout INTEGER NOT NULL DEFAULT 0,
  total_refund INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chain_id, chain_index)
);
CREATE INDEX IF NOT EXISTS idx_double_rounds_status ON double_rounds(status);
CREATE INDEX IF NOT EXISTS idx_double_rounds_ended ON double_rounds(ended_at);

CREATE TABLE IF NOT EXISTS double_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES double_rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  color TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_double_bets_round ON double_bets(round_id);
CREATE INDEX IF NOT EXISTS idx_double_bets_user ON double_bets(user_id, id);

-- Ruleta en vivo (una bolita para todos; cada jugador tiene una apuesta por ronda con todas sus fichas)
CREATE TABLE IF NOT EXISTS roulette_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  chain_index INTEGER NOT NULL,
  hash TEXT NOT NULL,
  result INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  spun_at INTEGER,
  ended_at INTEGER,
  total_bet INTEGER NOT NULL DEFAULT 0,
  total_payout INTEGER NOT NULL DEFAULT 0,
  total_refund INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chain_id, chain_index)
);
CREATE INDEX IF NOT EXISTS idx_roulette_rounds_status ON roulette_rounds(status);
CREATE INDEX IF NOT EXISTS idx_roulette_rounds_ended ON roulette_rounds(ended_at);

CREATE TABLE IF NOT EXISTS roulette_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES roulette_rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  bets TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roulette_bets_round ON roulette_bets(round_id);
CREATE INDEX IF NOT EXISTS idx_roulette_bets_user ON roulette_bets(user_id, id);

-- Resultados de los bots (plata ficticia): separados de todo lo real
CREATE TABLE IF NOT EXISTS bot_stats (
  day TEXT NOT NULL,
  game TEXT NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  bet INTEGER NOT NULL DEFAULT 0,
  payout INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, game)
);
`;

/** Cambios de estructura para bases creadas con versiones anteriores. */
function migrate(raw) {
  const cols = raw.prepare('PRAGMA table_info(chains)').all().map((c) => c.name);
  if (!cols.includes('game')) raw.exec("ALTER TABLE chains ADD COLUMN game TEXT NOT NULL DEFAULT 'crash'");
  raw.exec('CREATE INDEX IF NOT EXISTS idx_chains_game ON chains(game, active)');
}

/**
 * Envoltorio mínimo sobre node:sqlite (sin dependencias nativas que compilar).
 * Todas las operaciones son síncronas, así que cada transacción es atómica
 * respecto al resto del servidor (Node ejecuta un solo hilo de JavaScript).
 */
class Database {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec(SCHEMA);
    migrate(this.raw);
    this.statements = new Map();
    this.depth = 0;
    this.commitCallbacks = [];
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  /** Ejecuta fn dentro de una transacción (anidable). Si fn lanza un error se revierte todo. */
  tx(fn) {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    let result;
    try {
      result = fn();
      this.raw.exec('COMMIT');
    } catch (err) {
      this.depth = 0;
      this.commitCallbacks = [];
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignorar */
      }
      throw err;
    }
    this.depth = 0;
    const callbacks = this.commitCallbacks;
    this.commitCallbacks = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('Error en callback post-commit:', err);
      }
    }
    return result;
  }

  /** Ejecuta cb cuando la transacción actual se confirme (o ya mismo si no hay transacción). */
  onCommit(cb) {
    if (this.depth > 0) this.commitCallbacks.push(cb);
    else cb();
  }

  close() {
    try {
      this.raw.close();
    } catch {
      /* ignorar */
    }
  }
}

module.exports = { Database };
