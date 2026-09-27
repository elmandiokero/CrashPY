'use strict';
const { startOfDay } = require('./util');

const DAY = 86_400_000;

function roundsAgg(db, since) {
  return db.get(
    `SELECT COUNT(*) AS rounds,
            COALESCE(SUM(total_bet), 0) AS bet,
            COALESCE(SUM(total_payout), 0) AS payout,
            COALESCE(SUM(players), 0) AS plays
     FROM rounds WHERE status IN ('crashed', 'cancelled') AND ended_at >= ?`,
    since,
  );
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
  const r = roundsAgg(db, since);
  return { ...r, profit: r.bet - r.payout, ...money(db, since) };
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
  return {
    today: period(db, today),
    week: period(db, today - 6 * DAY),
    all: period(db, 0),
    users,
    pending: pending(db),
    adjustments,
  };
}

/** Ganancia de la casa por hora (últimas 24 h) y por día (últimos 14 días). */
function charts(db) {
  const hourly = db
    .all(
      `SELECT CAST(ended_at / 3600000 AS INTEGER) AS h,
              COALESCE(SUM(total_bet), 0) AS bet,
              COALESCE(SUM(total_payout), 0) AS payout,
              COUNT(*) AS rounds
       FROM rounds WHERE status IN ('crashed', 'cancelled') AND ended_at >= ?
       GROUP BY h ORDER BY h`,
      Date.now() - DAY,
    )
    .map((r) => ({ t: r.h * 3600000, bet: r.bet, payout: r.payout, profit: r.bet - r.payout, rounds: r.rounds }));
  const daily = db
    .all(
      `SELECT strftime('%Y-%m-%d', ended_at / 1000, 'unixepoch', 'localtime') AS d,
              COALESCE(SUM(total_bet), 0) AS bet,
              COALESCE(SUM(total_payout), 0) AS payout,
              COUNT(*) AS rounds
       FROM rounds WHERE status IN ('crashed', 'cancelled') AND ended_at >= ?
       GROUP BY d ORDER BY d`,
      startOfDay() - 13 * DAY,
    )
    .map((r) => ({ day: r.d, bet: r.bet, payout: r.payout, profit: r.bet - r.payout, rounds: r.rounds }));
  return { hourly, daily };
}

module.exports = { overview, charts, pending };
