'use strict';
// Si se corta la luz o se cierra el servidor en medio de una ronda, nadie pierde su apuesta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, connectSocket, openDb } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(srv) {
  const admin = new Client(srv.url);
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);
  await admin.post('/api/admin/settings', { betting_seconds: 3, speed: 2 });
  return admin;
}

async function betInLongRound(srv, username, amount) {
  const c = new Client(srv.url);
  let r = await c.post('/api/auth/login', { username, password: 'secret1' });
  if (r.status !== 200) r = await c.post('/api/auth/register', { username, password: 'secret1', adult: true });
  assert.equal(r.status, 200);
  const s = connectSocket(srv.url, c.cookie);
  await s.ready;
  const db = openDb(srv.dataDir);
  let round;
  for (let i = 0; i < 80; i++) {
    const b = await s.waitFor('betting');
    const cp = db.prepare('SELECT crash_point FROM rounds WHERE id = ?').get(b.roundId).crash_point;
    if (cp >= 250) {
      round = b;
      break;
    }
  }
  db.close();
  assert.ok(round, 'no apareció una ronda larga');
  const bet = await s.emit('bet', { slot: 0, amount });
  assert.ok(bet.ok, bet.error);
  await s.waitFor('start', (x) => x.roundId === round.roundId);
  await sleep(600);
  return { s, roundId: round.roundId, userId: r.data.user.id };
}

test('corte abrupto (se cae la PC) y apagado normal: la ronda se anula y se devuelve todo', async () => {
  let srv = await startServer();
  const dataDir = srv.dataDir;
  let admin = await setup(srv);
  const reg = await new Client(srv.url).post('/api/auth/register', { username: 'luz', password: 'secret1', adult: true });
  await admin.post(`/api/admin/users/${reg.data.user.id}/balance`, { op: 'add', amount: 50_000 });

  // 1) Corte abrupto (SIGKILL): se recupera al volver a arrancar
  let play = await betInLongRound(srv, 'luz', 10_000);
  await srv.stop('SIGKILL');
  play.s.close();
  let db = openDb(dataDir);
  assert.equal(db.prepare('SELECT status FROM rounds WHERE id = ?').get(play.roundId).status, 'running');
  db.close();

  srv = await startServer({ dataDir });
  db = openDb(dataDir);
  let round = db.prepare('SELECT status, cancel_mode, total_refund FROM rounds WHERE id = ?').get(play.roundId);
  assert.equal(round.status, 'cancelled');
  assert.equal(round.cancel_mode, 'server');
  assert.equal(round.total_refund, 10_000);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(play.userId).balance, 50_000);
  db.close();

  // 2) Apagado normal (Ctrl+C) con una ronda en vuelo
  admin = await setup(srv);
  play = await betInLongRound(srv, 'luz', 7_000);
  await srv.stop('SIGINT');
  play.s.close();
  db = openDb(dataDir);
  round = db.prepare('SELECT status, cancel_mode FROM rounds WHERE id = ?').get(play.roundId);
  assert.equal(round.status, 'cancelled');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(play.userId).balance, 50_000);
  const active = db.prepare("SELECT COUNT(*) AS c FROM bets WHERE status = 'active'").get().c;
  assert.equal(active, 0);
  db.close();
});

test('🎡 Double: si se corta apostando se devuelve la apuesta; si se corta girando, se paga', async () => {
  let srv = await startServer();
  const dataDir = srv.dataDir;
  const sockets = [];
  try {
    const admin = new Client(srv.url);
    assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);
    await admin.post('/api/admin/settings', { double_betting_seconds: 5, game_double: false });
    await admin.post('/api/admin/settings', { game_double: true });
    const reg = await new Client(srv.url).post('/api/auth/register', { username: 'giro', password: 'secret1', adult: true });
    const userId = reg.data.user.id;
    await admin.post(`/api/admin/users/${userId}/balance`, { op: 'add', amount: 100_000 });

    const connect = async () => {
      const c = new Client(srv.url);
      assert.equal((await c.post('/api/auth/login', { username: 'giro', password: 'secret1' })).status, 200);
      const s = connectSocket(srv.url, c.cookie);
      sockets.push(s);
      const init = await s.ready;
      return { s, init };
    };
    const balance = (db) => db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;

    // 1) Corte abrupto mientras se apuesta: la apuesta vuelve y la ronda queda para reutilizarse
    let { s } = await connect();
    const first = await s.waitFor('double:betting', () => true, 30000);
    assert.ok((await s.emit('double:bet', { color: 'red', amount: 10_000 })).ok);
    await srv.stop('SIGKILL');
    s.close();
    srv = await startServer({ dataDir });
    let db = openDb(dataDir);
    assert.equal(balance(db), 100_000);
    assert.equal(db.prepare('SELECT status FROM double_bets WHERE round_id = ?').get(first.roundId).status, 'refunded');
    db.close();

    // 2) Corte abrupto en pleno giro: el resultado ya se vio, así que la ronda se paga al volver
    let init;
    ({ s, init } = await connect());
    assert.equal(init.double.roundId, first.roundId, 'se reutiliza la ronda cuyo resultado nunca se mostró');
    assert.equal(init.double.phase, 'BETTING');
    assert.ok((await s.emit('double:bet', { color: 'red', amount: 10_000 })).ok);
    assert.ok((await s.emit('double:bet', { color: 'black', amount: 10_000 })).ok);
    const spin = await s.waitFor('double:spin', (x) => x.roundId === first.roundId, 30000);
    await srv.stop('SIGKILL');
    s.close();
    db = openDb(dataDir);
    assert.equal(db.prepare('SELECT status FROM double_rounds WHERE id = ?').get(first.roundId).status, 'spinning');
    db.close();
    srv = await startServer({ dataDir });
    db = openDb(dataDir);
    const ended = db.prepare('SELECT status, result FROM double_rounds WHERE id = ?').get(first.roundId);
    assert.equal(ended.status, 'ended');
    assert.equal(ended.result, spin.result);
    const expected = spin.color === 'white' ? 80_000 : 100_000;
    assert.equal(balance(db), expected);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM double_bets WHERE status = 'active'").get().c, 0);
    db.close();

    // 3) Apagado normal (Ctrl+C) mientras se apuesta
    ({ s } = await connect());
    await s.waitFor('double:betting', () => true, 30000);
    assert.ok((await s.emit('double:bet', { color: 'white', amount: 1_000 })).ok);
    await srv.stop('SIGINT');
    db = openDb(dataDir);
    assert.equal(balance(db), expected);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM double_bets WHERE status = 'active'").get().c, 0);
    db.close();
  } finally {
    for (const x of sockets) x.close();
    await srv.stop('SIGKILL');
  }
});
