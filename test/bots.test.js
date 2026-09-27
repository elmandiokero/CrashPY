'use strict';
// Bots de la sala: siempre marcados con 🤖, juegan con plata ficticia y no tocan nada real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, connectSocket, openDb } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv;
let admin;
let player;

test.before(async () => {
  srv = await startServer();
  admin = new Client(srv.url);
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);
  let r = await admin.post('/api/admin/settings', {
    betting_seconds: 3,
    speed: 2,
    double_betting_seconds: 5,
    roulette_betting_seconds: 5,
    game_double: false,
    game_roulette: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await admin.post('/api/admin/settings', { game_double: true, game_roulette: true });
  assert.equal(r.status, 200);
  const c = new Client(srv.url);
  const reg = await c.post('/api/auth/register', { username: 'humano', password: 'secret1', adult: true });
  await admin.post(`/api/admin/users/${reg.data.user.id}/balance`, { op: 'add', amount: 100_000 });
  const s = connectSocket(srv.url, c.cookie);
  const init = await s.ready;
  assert.equal(init.online.bots, 0, 'arrancan apagados');
  player = { c, s, id: reg.data.user.id };
});

test.after(async () => {
  if (player) player.s.close();
  if (srv) await srv.stop();
});

test('con los bots prendidos aparecen marcados en el Crash, el Double, la Ruleta, las jugadas en vivo y el chat', async () => {
  const s = player.s;
  const adminSock = require('socket.io-client').io(srv.url + '/admin', {
    transports: ['websocket'],
    extraHeaders: { cookie: admin.cookie },
    forceNew: true,
    reconnection: false,
  });
  test.after(() => adminSock.close());
  const adminFeed = [];
  adminSock.on('feed', (b) => adminFeed.push(...b));
  const r = await admin.post('/api/admin/settings', { bots_enabled: true, bots_count: 10, bots_chat: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const online = await s.waitFor('online', (o) => o.bots === 10, 10000);
  assert.equal(online.bots, 10);

  const bet = await s.waitFor('bet', (b) => b.bot, 20000);
  assert.ok(bet.user.startsWith('🤖 '), 'el nombre del bot lleva 🤖');
  assert.match(String(bet.uid), /^bot:\d+$/);
  assert.equal(typeof bet.id, 'string');

  const dbl = await s.waitFor('double:bet', (b) => b.bot, 30000);
  assert.ok(dbl.user.startsWith('🤖 '));
  assert.ok(['red', 'black', 'white'].includes(dbl.color));

  // En la Ruleta en vivo apuestan en la misma ronda que todos, con fichas válidas
  const seenRl = player.s.events.find((e) => e.name === 'roulette:bet' && e.data.bot);
  const rl = seenRl ? seenRl.data : await s.waitFor('roulette:bet', (b) => b.bot, 40000);
  assert.ok(rl.user.startsWith('🤖 '));
  assert.ok(rl.bets.length > 0 && rl.bets.every((x) => x.amount > 0));
  assert.equal(rl.amount, rl.bets.reduce((t, x) => t + x.amount, 0));

  const feed = await s.waitFor('feed', (batch) => batch.some((f) => f.bot), 30000);
  const item = feed.find((f) => f.bot);
  assert.ok(item.user.startsWith('🤖 '));
  assert.ok(['mines', 'penalty', 'plinko'].includes(item.game));

  // Al entrar, uno de los bots saluda (puede haber llegado antes: se busca también en lo ya recibido)
  const seen = player.s.events.find((e) => e.name === 'chat' && e.data.role === 'bot');
  const msg = seen ? seen.data : await s.waitFor('chat', (m) => m.role === 'bot', 15000);
  assert.ok(msg.user.startsWith('🤖 '));
  assert.equal(msg.uid, null);

  // Alguien que entra ahora ve las apuestas de los bots de la ronda (marcadas)
  const s2 = connectSocket(srv.url, player.c.cookie);
  const snap = await s2.ready;
  for (const b of [...snap.game.bets, ...snap.double.bets, ...snap.roulette.bets].filter((x) => x.bot)) assert.ok(b.user.startsWith('🤖 '));
  s2.close();

  await sleep(1500);
  assert.equal(adminFeed.filter((f) => f.bot).length, 0, 'el panel de admin no recibe jugadas de bots');
  adminSock.close();
});

test('los bots no tocan la plata ni las estadísticas reales, y sus resultados se ven aparte', async () => {
  await sleep(4000);
  const db = openDb(srv.dataDir);
  // Nada de los bots en las tablas reales
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bets').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM double_bets').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM roulette_bets').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plays').get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE type IN ('bet', 'win', 'refund')").get().c, 0);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(player.id).balance, 100_000);
  db.close();

  const ov = await admin.get('/api/admin/overview');
  assert.equal(ov.data.stats.today.bet, 0, 'la ganancia de la casa no incluye bots');
  assert.equal(ov.data.stats.today.plays, 0);
  const top = await player.c.get('/api/top');
  assert.equal(top.data.wins.length, 0, 'el Top no incluye bots');

  const rep = await admin.get('/api/admin/bots');
  assert.equal(rep.status, 200);
  assert.equal(rep.data.enabled, true);
  assert.equal(rep.data.online.length, 10);
  assert.ok(rep.data.online.every((n) => n.startsWith('🤖 ')));
  const t = rep.data.periods.today.total;
  assert.ok(t.plays > 0, 'los bots jugaron');
  assert.equal(t.result, t.payout - t.bet);

  // Al apagarlos se van de la sala
  await admin.post('/api/admin/settings', { bots_enabled: false });
  const off = await player.s.waitFor('online', (o) => o.bots === 0, 10000);
  assert.equal(off.bots, 0);
  const rep2 = await admin.get('/api/admin/bots');
  assert.equal(rep2.data.online.length, 0);
});
