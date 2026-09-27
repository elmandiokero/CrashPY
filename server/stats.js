'use strict';
const { startOfDay } = require('./util');

const DAY = 86_400_000;
const GAMES = ['crash', 'double', 'mines', 'penalty', 'plinko', 'roulette'];

/**
 * Todas las jugadas terminadas de todos los juegos, con la misma forma:
 *   t = cuándo terminó · bet = apostado · payout = pagado · rounds = rondas (Crash/Double) · n = participaciones
 */
const ALL_PLAYS = `
  SELECT 'crash' AS game, ended_at AS t, total_bet AS bet, total_payout AS payout, 1 AS rounds, players AS n
    FROM rounds WHERE status IN ('crashed', 'cancelled') AND ended_at >= ?
  UNION ALL
  SELECT 'double', ended_at, total_bet, total_payout, 1, players
    FROM double_rounds WHERE status = 'ended' AND ended_at >= ?
  UNION ALL
  SELECT game, ended_at, amount, payout, 0, 1
    FROM plays WHERE status IN ('won', 'lost') AND ended_at >= ?`;

function gamesAgg(db, since) {
  const rows = db.all(
    `SELECT game, COALESCE(SUM(bet), 0) AS bet, COALESCE(SUM(payout), 0) AS payout,
            COALESCE(SUM(rounds), 0) AS rounds, COALESCE(SUM(n), 0) AS plays
     FROM (${ALL_PLAYS}) GROUP BY game`,
    since,
    since,
    since,
  );
  const games = {};
  for (const g of GAMES) games[g] = { bet: 0, payout: 0, profit: 0, rounds: 0, plays: 0 };
  const total = { bet: 0, payout: 0, rounds: 0, plays: 0 };
  for (const r of rows) {
    games[r.game] = { bet: r.bet, payout: r.payout, profit: r.bet - r.payout, rounds: r.rounds, plays: r.plays };
    total.bet += r.bet;
    total.payout += r.payout;
    total.rounds += r.rounds;
    total.plays += r.plays;
  }
  return { ...total, games };
}

function money(db, since) {
  const dep = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(credited), 0) AS total FROM deposits WHERE status = 'approved' AND processed_at >= ?",
    since,
  );
  const wd = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'paid' AND processed_at >= ?",
    since,
  );
  return { deposits: dep, withdrawals: wd };
}

function period(db, since) {
  const g = gamesAgg(db, since);
  return { ...g, profit: g.bet - g.payout, ...money(db, since) };
}

function pending(db) {
  return {
    deposits: db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM deposits WHERE status = 'pending'"),
    withdrawals: db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'pending'"),
  };
}

/** Resumen general para el panel de admin. */
function overview(db) {
  const today = startOfDay();
  const users = db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(balance), 0) AS balances,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today,
            COALESCE(SUM(banned), 0) AS banned
     FROM users`,
    today,
  );
  const adjustments = db.get("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type IN ('admin', 'bonus')").total;
  // Plata apostada en partidas de Minas o Penales que todavía no terminaron
  const openPlays = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM plays WHERE status = 'active'");
  return {
    today: period(db, today),
    week: period(db, today - 6 * DAY),
    all: period(db, 0),
    users,
    pending: pending(db),
    adjustments,
    openPlays,
  };
}

/** Ganancia de la casa por hora (últimas 24 h) y por día (últimos 14 días), sumando todos los juegos. */
function charts(db) {
  const since = Date.now() - DAY;
  const hourly = db
    .all(
      `SELECT CAST(t / 3600000 AS INTEGER) AS h, COALESCE(SUM(bet), 0) AS bet, COALESCE(SUM(payout), 0) AS payout, COUNT(*) AS n
       FROM (${ALL_PLAYS}) GROUP BY h ORDER BY h`,
      since,
      since,
      since,
    )
    .map((r) => ({ t: r.h * 3600000, bet: r.bet, payout: r.payout, profit: r.bet - r.payout, rounds: r.n }));
  const from = startOfDay() - 13 * DAY;
  const daily = db
    .all(
      `SELECT strftime('%Y-%m-%d', t / 1000, 'unixepoch', 'localtime') AS d,
              COALESCE(SUM(bet), 0) AS bet, COALESCE(SUM(payout), 0) AS payout, COUNT(*) AS n
       FROM (${ALL_PLAYS}) GROUP BY d ORDER BY d`,
      from,
      from,
      from,
    )
    .map((r) => ({ day: r.d, bet: r.bet, payout: r.payout, profit: r.bet - r.payout, rounds: r.n }));
  return { hourly, daily };
}

module.exports = { overview, charts, pending, GAMES };
