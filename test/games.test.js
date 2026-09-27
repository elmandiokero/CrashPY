'use strict';
// Pruebas de punta a punta de Minas, Penales, Plinko, Double y Ruleta con un servidor real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const core = require('../public/js/games-core.js');
const { startServer, Client, connectSocket, openDb } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmacBytes = (key, message) => crypto.createHmac('sha256', key).update(message).digest();

let srv;
let admin;
let db;
const players = [];

const balanceOf = (id) => db.prepare('SELECT balance FROM users WHERE id = ?').get(id).balance;
const playRow = (id) => {
  const r = db.prepare('SELECT * FROM plays WHERE id = ?').get(id);
  return { ...r, result: JSON.parse(r.result), params: JSON.parse(r.params) };
};

async function newPlayer(name, credit = 1_000_000) {
  const c = new Client(srv.url);
  const r = await c.post('/api/auth/register', { username: name, password: 'secret1', adult: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.user.id;
  if (credit) {
    const a = await admin.post(`/api/admin/users/${id}/balance`, { op: 'add', amount: credit, note: 'carga de prueba' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
  }
  const s = connectSocket(srv.url, c.cookie);
  const init = await s.ready;
  const p = { c, s, id, init, name };
  players.push(p);
  return p;
}

/** Espera un evento del socket, o lo toma de los que ya llegaron. */
function seenOrWait(p, name, pred = () => true, timeout = 30000) {
  const seen = p.s.events.find((e) => e.name === name && pred(e.data));
  return seen ? Promise.resolve(seen.data) : p.s.waitFor(name, pred, timeout);
}

/** Cambia las semillas y comprueba cada jugada terminada con la semilla del servidor ya revelada. */
async function rotateAndVerify(p, check) {
  const rot = await p.c.post('/api/seeds/rotate', {});
  assert.equal(rot.status, 200, JSON.stringify(rot.data));
  const prev = rot.data.previous[0];
  assert.equal(crypto.createHash('sha256').update(prev.serverSeed).digest('hex'), prev.serverHash);
  const hist = await p.c.get('/api/plays?limit=100');
  let verified = 0;
  for (const play of hist.data.items) {
    const d = await p.c.get('/api/plays/' + play.id);
    assert.equal(d.status, 200);
    if (d.data.seed.serverHash !== prev.serverHash) continue;
    assert.equal(d.data.seed.serverSeed, prev.serverSeed);
    const floats = core.seedFloats(hmacBytes, prev.serverSeed, prev.clientSeed, play.nonce, 24);
    check(play, floats);
    verified++;
  }
  return verified;
}

test.before(async () => {
  srv = await startServer();
  admin = new Client(srv.url);
  const r = await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(r.status, 200);
  // Double y Ruleta rápidos para las pruebas: al apagarlos y prenderlos arranca enseguida una ronda con 5 segundos
  let s = await admin.post('/api/admin/settings', {
    double_betting_seconds: 5,
    roulette_betting_seconds: 5,
    game_double: false,
    game_roulette: false,
    bigwin_multiplier: 1000,
  });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  s = await admin.post('/api/admin/settings', { game_double: true, game_roulette: true });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  db = openDb(srv.dataDir);
});

test.after(async () => {
  for (const p of players) p.s.close();
  if (db) db.close();
  if (srv) await srv.stop();
});

test('💣 Minas: destapar, retirar, explotar y verificar con la semilla revelada', async () => {
  const p = await newPlayer('minero');
  let r = await p.s.emit('mines:start', { amount: 10_000, mines: 3 });
  assert.ok(r.ok, r.error);
  assert.equal(r.balance, 990_000);
  const play = r.play;
  assert.equal(play.status, 'active');
  assert.equal(play.mines, undefined, 'las minas no se revelan mientras se juega');
  assert.equal(play.next, core.minesMultiplier(3, 1));

  // No se puede empezar otra, ni cambiar las semillas, ni ver el detalle mientras está en curso
  assert.equal((await p.s.emit('mines:start', { amount: 10_000, mines: 3 })).code, 'ACTIVE');
  assert.equal((await p.c.post('/api/seeds/rotate', {})).status, 409);
  assert.equal((await p.c.get('/api/plays/' + play.id)).status, 404);
  assert.equal((await p.s.emit('mines:cashout', {})).ok, false, 'hay que destapar al menos una');

  // Reconectar: la partida sigue ahí (sin revelar las minas)
  const s2 = connectSocket(srv.url, p.c.cookie);
  const init2 = await s2.ready;
  assert.equal(init2.plays.mines.id, play.id);
  assert.equal(init2.plays.mines.mines, undefined);
  s2.close();

  const mines = playRow(play.id).result.mines;
  const safe = [...Array(25).keys()].filter((t) => !mines.includes(t));
  r = await p.s.emit('mines:reveal', { tile: safe[0] });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.play.revealed, [safe[0]]);
  assert.equal((await p.s.emit('mines:reveal', { tile: safe[0] })).code, 'REVEALED');
  assert.equal((await p.s.emit('mines:reveal', { tile: 25 })).ok, false);
  r = await p.s.emit('mines:reveal', { id: play.id, tile: safe[1] });
  assert.equal(r.play.current, core.minesMultiplier(3, 2));
  r = await p.s.emit('mines:cashout', {});
  assert.ok(r.ok, r.error);
  const payout = Math.floor((10_000 * core.minesMultiplier(3, 2)) / 100);
  assert.equal(r.play.status, 'won');
  assert.equal(r.play.payout, payout);
  assert.deepEqual(r.play.mines, mines, 'al terminar se muestran las minas');
  assert.equal(r.balance, 990_000 + payout);
  assert.equal((await p.s.emit('mines:cashout', { id: play.id })).code, 'ENDED');

  // Explotar
  r = await p.s.emit('mines:start', { amount: 5_000, mines: 24 });
  const mines2 = playRow(r.play.id).result.mines;
  const bomb = mines2[0];
  r = await p.s.emit('mines:reveal', { tile: bomb });
  assert.equal(r.play.status, 'lost');
  assert.equal(r.play.hit, bomb);
  assert.equal(r.play.payout, 0);
  assert.equal(balanceOf(p.id), 990_000 + payout - 5_000);

  // Destapar todas las seguras termina la partida sola (1 mina → 24 casillas)
  r = await p.s.emit('mines:start', { amount: 1_000, mines: 1 });
  const lone = playRow(r.play.id).result.mines[0];
  for (let t = 0; t < 25; t++) {
    if (t === lone) continue;
    r = await p.s.emit('mines:reveal', { tile: t });
    assert.ok(r.ok, r.error);
  }
  assert.equal(r.play.status, 'won');
  assert.equal(r.play.multiplier, core.minesMultiplier(1, 24));

  // Validaciones
  assert.equal((await p.s.emit('mines:start', { amount: 10_000, mines: 0 })).ok, false);
  assert.equal((await p.s.emit('mines:start', { amount: 10_000, mines: 25 })).ok, false);
  assert.equal((await p.s.emit('mines:start', { amount: 10, mines: 3 })).ok, false);

  const n = await rotateAndVerify(p, (play, floats) => {
    assert.deepEqual(core.minesPositions(floats, play.params.mines), play.mines);
  });
  assert.equal(n, 3);
});

test('⚽ Penales: goles, atajada, retiro y verificación', async () => {
  const p = await newPlayer('goleador');
  let r = await p.s.emit('penalty:start', { amount: 20_000 });
  assert.ok(r.ok, r.error);
  assert.equal(r.play.keepers, undefined, 'el arquero no se revela antes de patear');
  assert.equal(r.play.next, 145);
  const keepers = playRow(r.play.id).result.keepers;
  const miss = (k) => (k + 1) % 3;
  r = await p.s.emit('penalty:kick', { zone: miss(keepers[0]) });
  assert.ok(r.play.kicks[0].goal);
  assert.equal(r.play.current, 145);
  r = await p.s.emit('penalty:kick', { zone: miss(keepers[1]) });
  assert.equal(r.play.current, 218);
  assert.equal((await p.s.emit('penalty:kick', { zone: 3 })).ok, false);
  r = await p.s.emit('penalty:cashout', {});
  assert.equal(r.play.status, 'won');
  assert.equal(r.play.payout, 43_600);
  assert.deepEqual(r.play.keepers, keepers);
  assert.equal(r.balance, 1_000_000 - 20_000 + 43_600);

  // Atajada
  r = await p.s.emit('penalty:start', { amount: 5_000 });
  const k2 = playRow(r.play.id).result.keepers;
  r = await p.s.emit('penalty:kick', { zone: k2[0] });
  assert.equal(r.play.status, 'lost');
  assert.equal(r.play.kicks[0].goal, false);
  assert.equal((await p.s.emit('penalty:kick', { id: r.play.id, zone: 0 })).code, 'ENDED');

  // Los 5 goles terminan la tanda sola con el premio máximo
  r = await p.s.emit('penalty:start', { amount: 1_000 });
  const k3 = playRow(r.play.id).result.keepers;
  for (let i = 0; i < 5; i++) r = await p.s.emit('penalty:kick', { zone: miss(k3[i]) });
  assert.equal(r.play.status, 'won');
  assert.equal(r.play.payout, 7_360);

  const n = await rotateAndVerify(p, (play, floats) => {
    assert.deepEqual(core.penaltyKeepers(floats), play.keepers);
  });
  assert.equal(n, 3);
});

test('🔴 Plinko: la bolita cae donde dicen las semillas y paga según la tabla', async () => {
  const p = await newPlayer('plinkero');
  assert.equal((await p.s.emit('plinko:drop', { amount: 1_000, rows: 7, risk: 'low' })).ok, false);
  assert.equal((await p.s.emit('plinko:drop', { amount: 1_000, rows: 8, risk: 'extreme' })).ok, false);
  let expected = 1_000_000;
  for (let i = 0; i < 30; i++) {
    const rows = core.PLINKO_ROWS[i % 5];
    const risk = core.PLINKO_RISKS[i % 3];
    const r = await p.s.emit('plinko:drop', { amount: 2_000, rows, risk });
    assert.ok(r.ok, r.error);
    assert.equal(r.play.path.length, rows);
    assert.equal(r.play.bucket, r.play.path.reduce((a, b) => a + b, 0));
    assert.equal(r.play.multiplier, core.PLINKO[rows][risk][r.play.bucket]);
    assert.equal(r.play.payout, Math.floor((2_000 * r.play.multiplier) / 100));
    expected += r.play.payout - 2_000;
    assert.equal(r.balance, expected);
  }
  const n = await rotateAndVerify(p, (play, floats) => {
    const res = core.plinkoResult(floats, play.params.rows, play.params.risk);
    assert.deepEqual(res.path, play.path);
    assert.equal(res.multiplier, play.multiplier);
  });
  assert.equal(n, 30);
});

test('🎰 Ruleta en vivo: todos en la misma ronda, pago al caer la bolita y verificación con el hash', async () => {
  const a = await newPlayer('ruletero');
  const b = await newPlayer('ruletera');
  const round = await a.s.waitFor('roulette:betting', () => true, 30000);
  const bad = [
    [],
    [{ type: 'n', value: 37, amount: 1_000 }],
    [{ type: 'dozen', value: 4, amount: 1_000 }],
    [{ type: 'split', value: 1, amount: 1_000 }],
    [{ type: 'red', amount: -5 }],
    [{ type: 'red', amount: 500 }], // menos que la apuesta mínima
    [{ type: 'red', amount: 600_000 }, { type: 'black', amount: 600_000 }], // más que la máxima por ronda
  ];
  for (const bets of bad) assert.equal((await a.s.emit('roulette:bet', { bets })).ok, false, JSON.stringify(bets).slice(0, 80));
  // Un pleno paga 36x: con la ganancia máxima de 20.000.000 no se pueden poner 600.000 a un número
  const big = await a.s.emit('roulette:bet', { bets: [{ type: 'n', value: 7, amount: 600_000 }] });
  assert.equal(big.ok, false);
  assert.match(big.error, /ganancia máxima/);
  assert.equal(balanceOf(a.id), 1_000_000, 'las fichas rechazadas no se cobran');

  // Una ficha en cada número (siempre cobra 36) y después otra tanda: las fichas del mismo lugar se suman
  const all = Array.from({ length: 37 }, (_, n) => ({ type: 'n', value: n, amount: 1_000 }));
  let r = await a.s.emit('roulette:bet', { bets: all });
  assert.ok(r.ok, r.error);
  assert.equal(r.mine.amount, 37_000);
  assert.equal(r.balance, 963_000);
  r = await a.s.emit('roulette:bet', { bets: [{ type: 'red', amount: 2_000 }, { type: 'red', amount: 3_000 }, { type: 'dozen', value: 2, amount: 1_000 }] });
  assert.ok(r.ok, r.error);
  assert.equal(r.mine.roundId, round.roundId);
  assert.equal(r.mine.amount, 43_000);
  assert.equal(r.mine.bets.length, 39);
  assert.deepEqual(r.mine.bets.find((x) => x.type === 'red'), { type: 'red', value: null, amount: 5_000 });
  assert.equal(r.balance, 957_000);

  // El otro jugador ve las fichas en vivo (una sola apuesta por jugador, con el total)
  const seen = await seenOrWait(b, 'roulette:bet', (x) => x.uid === a.id && x.amount === 43_000);
  assert.equal(seen.user, 'ruletero');
  assert.equal(seen.bets.length, 39);
  assert.ok((await b.s.emit('roulette:bet', { bets: [{ type: 'black', amount: 4_000 }] })).ok);

  const spin = await seenOrWait(a, 'roulette:spin', (x) => x.roundId === round.roundId);
  assert.equal(spin.color, core.rouletteColor(spin.result));
  assert.equal((await a.s.emit('roulette:bet', { bets: [{ type: 'red', amount: 1_000 }] })).code, 'NOT_BETTING');
  assert.equal(balanceOf(a.id), 957_000, 'durante el giro todavía no se pagó nada');
  const result = await seenOrWait(a, 'roulette:result', (x) => x.roundId === round.roundId);
  const n = result.result;
  assert.equal(n, spin.result);
  const aSpots = [...all, { type: 'red', value: null, amount: 5_000 }, { type: 'dozen', value: 2, amount: 1_000 }];
  const aPay = core.roulettePayout(aSpots, n);
  assert.ok(aPay >= 36_000);
  assert.equal(balanceOf(a.id), 957_000 + aPay);
  assert.equal(balanceOf(b.id), 996_000 + core.roulettePayout([{ type: 'black', amount: 4_000 }], n));
  const mine = await seenOrWait(a, 'myRoulette', (x) => x.roundId === round.roundId, 5000);
  assert.equal(mine.bet, 43_000);
  assert.equal(mine.payout, aPay);

  // Verificación: HMAC(sal, hash) → número, y el hash enlaza con la ronda anterior
  const detail = await a.c.get('/api/roulette/rounds/' + round.roundId);
  assert.equal(detail.status, 200);
  const hmac = crypto.createHmac('sha256', detail.data.chain.salt).update(detail.data.round.hash).digest('hex');
  assert.equal(core.rouletteNumberFromHmac(hmac), n);
  if (detail.data.previous) {
    assert.equal(crypto.createHash('sha256').update(detail.data.round.hash).digest('hex'), detail.data.previous.hash);
  }
  assert.equal(detail.data.bets.length, 2);
  assert.ok(detail.data.bets.every((x) => Array.isArray(x.bets)));
  const fair = await a.c.get('/api/fair?game=roulette');
  assert.equal(fair.data.current.houseEdgeBps, 270);
  const hist = await a.c.get('/api/plays?game=roulette');
  assert.equal(hist.data.items[0].roundId, round.roundId);
  assert.equal(hist.data.items[0].amount, 43_000);
  assert.equal(hist.data.items[0].result, n);
  const rounds = await a.c.get('/api/roulette/rounds?played=1');
  assert.equal(rounds.data.items[0].id, round.roundId);

  // Panel de admin: la ronda, la jugada y el estado en vivo (sin mostrar el resultado de la ronda siguiente)
  const adm = await admin.get('/api/admin/roulette');
  assert.equal(adm.status, 200);
  assert.ok(adm.data.items.some((x) => x.id === round.roundId && x.players === 2));
  assert.equal(adm.data.roulette.houseIf.length, 37);
  const list = await admin.get('/api/admin/plays?game=roulette');
  assert.ok(list.data.items.some((x) => x.round_id === round.roundId && x.detail.includes(`salió el ${n}`)));
});

test('🎰 Ruleta: al pausarla desde el panel se devuelven las fichas', async () => {
  const p = await newPlayer('ruletapausa');
  const round = await p.s.waitFor('roulette:betting', () => true, 30000);
  assert.ok((await p.s.emit('roulette:bet', { bets: [{ type: 'even', amount: 5_000 }] })).ok);
  assert.ok((await p.s.emit('roulette:bet', { bets: [{ type: 'n', value: 17, amount: 2_000 }] })).ok);
  assert.equal(balanceOf(p.id), 993_000);
  await admin.post('/api/admin/settings', { game_roulette: false });
  const back = await seenOrWait(p, 'myRoulette', (x) => x.refunded, 5000);
  assert.equal(back.bet, 7_000, 'un solo aviso con todo lo devuelto');
  assert.equal(balanceOf(p.id), 1_000_000);
  assert.equal((await p.s.emit('roulette:bet', { bets: [{ type: 'even', amount: 1_000 }] })).code, 'NOT_BETTING');
  assert.equal(db.prepare('SELECT status FROM roulette_bets WHERE round_id = ? AND user_id = ?').get(round.roundId, p.id).status, 'refunded');
  await admin.post('/api/admin/settings', { game_roulette: true });
  const again = await p.s.waitFor('roulette:betting', () => true, 20000);
  assert.equal(again.roundId, round.roundId, 'se reutiliza la misma ronda (su resultado nunca se mostró)');
});

test('juegos desactivados desde el panel y tope de ganancia por jugada', async () => {
  const p = await newPlayer('tope', 3_000_000);
  let s = await admin.post('/api/admin/settings', { game_plinko: false });
  assert.equal(s.status, 200);
  const r = await p.s.emit('plinko:drop', { amount: 1_000, rows: 8, risk: 'low' });
  assert.equal(r.code, 'DISABLED');
  s = await admin.post('/api/admin/settings', { game_plinko: true, max_profit: 5_000 });
  assert.equal(s.status, 200);
  // Minas con 24 minas paga 24.25x: con 10.000 serían 242.500, pero el tope es 10.000 + 5.000
  const start = await p.s.emit('mines:start', { amount: 10_000, mines: 24 });
  const mines = playRow(start.play.id).result.mines;
  const safe = [...Array(25).keys()].find((t) => !mines.includes(t));
  const win = await p.s.emit('mines:reveal', { tile: safe });
  assert.equal(win.play.status, 'won', 'al llegar al tope se cobra solo');
  assert.equal(win.play.payout, 15_000);
  await admin.post('/api/admin/settings', { max_profit: 20_000_000 });
});

test('🎡 Double: apuestas por color, pago al terminar el giro y la casilla sale del hash', async () => {
  const a = await newPlayer('rojito');
  const b = await newPlayer('negrito');
  const w = await newPlayer('blanquito');
  const bet = await a.s.waitFor('double:betting', () => true, 20000);
  let r = await a.s.emit('double:bet', { color: 'red', amount: 3_000 });
  assert.ok(r.ok, r.error);
  r = await a.s.emit('double:bet', { color: 'red', amount: 2_000 });
  assert.deepEqual(r.mine.bets, { red: 5_000, black: 0, white: 0 });
  assert.ok((await b.s.emit('double:bet', { color: 'black', amount: 4_000 })).ok);
  assert.ok((await w.s.emit('double:bet', { color: 'white', amount: 1_000 })).ok);
  assert.equal((await w.s.emit('double:bet', { color: 'green', amount: 1_000 })).ok, false);
  // Blanco paga 30x: con la ganancia máxima de 20.000.000 se puede apostar hasta 689.655
  const big = await w.s.emit('double:bet', { color: 'white', amount: 700_000 });
  assert.equal(big.ok, false);
  assert.match(big.error, /689\.655/);

  const spin = await a.s.waitFor('double:spin', (x) => x.roundId === bet.roundId, 20000);
  assert.equal((await a.s.emit('double:bet', { color: 'red', amount: 1_000 })).code, 'NOT_BETTING');
  // Durante el giro todavía no se pagó nada
  assert.equal(balanceOf(a.id), 995_000);
  const result = await a.s.waitFor('double:result', (x) => x.roundId === bet.roundId, 20000);
  assert.ok(Date.now() - spin.ms >= 0);
  const color = core.doubleColor(result.result);
  assert.equal(result.color, color);
  const expect = { red: 1_000_000 - 5_000, black: 1_000_000 - 4_000, white: 1_000_000 - 1_000 };
  const pays = { red: 10_000, black: 8_000, white: 30_000 };
  expect[color] += pays[color];
  assert.equal(balanceOf(a.id), expect.red);
  assert.equal(balanceOf(b.id), expect.black);
  assert.equal(balanceOf(w.id), expect.white);
  const mine = await a.s.waitFor('myDouble', (x) => x.roundId === bet.roundId, 5000).catch(() => null);
  const myEvents = a.s.events.filter((e) => e.name === 'myDouble' && e.data.roundId === bet.roundId);
  assert.ok(mine || myEvents.length, 'llega el resultado privado');

  // Verificación: HMAC(sal, hash) → casilla, y el hash enlaza con la ronda anterior
  const detail = await a.c.get('/api/double/rounds/' + bet.roundId);
  assert.equal(detail.status, 200);
  const hmac = crypto.createHmac('sha256', detail.data.chain.salt).update(detail.data.round.hash).digest('hex');
  assert.equal(core.doubleTileFromHmac(hmac), detail.data.round.result);
  if (detail.data.previous) {
    assert.equal(crypto.createHash('sha256').update(detail.data.round.hash).digest('hex'), detail.data.previous.hash);
  }
  assert.equal(detail.data.bets.length, 3);
  const hist = await a.c.get('/api/plays?game=double');
  assert.equal(hist.data.items[0].roundId, bet.roundId);
  assert.equal(hist.data.items[0].amount, 5_000);
});

test('🎡 Double: al pausarlo desde el panel se devuelven las apuestas', async () => {
  const p = await newPlayer('pausado');
  const bet = await p.s.waitFor('double:betting', () => true, 20000);
  assert.ok((await p.s.emit('double:bet', { color: 'black', amount: 7_000 })).ok);
  assert.equal(balanceOf(p.id), 993_000);
  await admin.post('/api/admin/settings', { game_double: false });
  await sleep(200);
  assert.equal(balanceOf(p.id), 1_000_000);
  assert.equal((await p.s.emit('double:bet', { color: 'black', amount: 1_000 })).ok, false);
  const refunded = db.prepare("SELECT status FROM double_bets WHERE round_id = ? AND user_id = ?").get(bet.roundId, p.id);
  assert.equal(refunded.status, 'refunded');
  await admin.post('/api/admin/settings', { game_double: true });
  const again = await p.s.waitFor('double:betting', () => true, 20000);
  assert.equal(again.roundId, bet.roundId, 'se reutiliza la misma ronda (su resultado nunca se mostró)');
});

test('jugadas en vivo, estadísticas del panel y el libro contable cuadra', async () => {
  const p = players[0];
  // Las jugadas se envían en tandas (como mucho 30 por tanda), así que jugamos una de cada una tranquilos
  const q = await newPlayer('feed');
  await q.s.emit('plinko:drop', { amount: 1_000, rows: 8, risk: 'low' });
  const pen = await q.s.emit('penalty:start', { amount: 1_000 });
  await q.s.emit('penalty:kick', { id: pen.play.id, zone: playRow(pen.play.id).result.keepers[0] });
  const mn = await q.s.emit('mines:start', { amount: 1_000, mines: 5 });
  await q.s.emit('mines:reveal', { id: mn.play.id, tile: playRow(mn.play.id).result.mines[0] });
  await sleep(900);
  const feed = p.s.events.filter((e) => e.name === 'feed').flatMap((e) => e.data);
  const games = new Set(feed.map((f) => f.game));
  for (const g of ['mines', 'penalty', 'plinko', 'roulette', 'double']) assert.ok(games.has(g), `falta ${g} en el feed`);
  assert.ok(feed.some((f) => f.user === 'feed' && f.game === 'mines' && f.payout === 0));

  const ov = await admin.get('/api/admin/overview');
  assert.equal(ov.status, 200);
  const today = ov.data.stats.today;
  for (const g of ['mines', 'penalty', 'plinko', 'roulette', 'double']) assert.ok(today.games[g].bet > 0, g);
  assert.equal(today.profit, today.bet - today.payout);
  assert.ok(ov.data.double.phase);

  const list = await admin.get('/api/admin/plays?game=mines');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.length >= 5);
  assert.ok(list.data.items.every((x) => x.game === 'mines' && x.detail));
  const user = await admin.get(`/api/admin/users/${players[0].id}`);
  assert.ok(user.data.games.length > 0);

  const top = await p.c.get('/api/top');
  assert.ok(top.data.wins.length > 0);

  // Cada juego tiene su dirección propia (la misma página)
  for (const path of ['/crash', '/minas', '/penales', '/double', '/plinko', '/ruleta']) {
    const res = await fetch(srv.url + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /id="gameNav"/, path);
  }

  // Libro contable: el saldo de cada jugador es exactamente la suma de sus movimientos
  const rows = db
    .prepare('SELECT u.id, u.balance, (SELECT COALESCE(SUM(amount), 0) FROM ledger l WHERE l.user_id = u.id) AS total FROM users u')
    .all();
  for (const r of rows) assert.equal(r.balance, r.total, `usuario ${r.id}`);
  // Y cada jugada terminada tiene su apuesta y su pago registrados
  const names = { mines: 'Minas', penalty: 'Penales', plinko: 'Plinko' };
  const plays = db.prepare("SELECT id, game, amount, payout FROM plays WHERE status IN ('won', 'lost')").all();
  for (const pl of plays) {
    const note = `${names[pl.game]} #${pl.id}`;
    const bet = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE type = 'bet' AND ref_id = ? AND note = ?").get(pl.id, note).s;
    assert.equal(bet, -pl.amount, `apuesta de la jugada ${pl.id}`);
    const win = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE type = 'win' AND ref_id = ? AND note LIKE ?").get(pl.id, note + ' · %').s;
    assert.equal(win, pl.payout, `pago de la jugada ${pl.id}`);
  }
  // En la Ruleta cada tanda de fichas es un movimiento, y el pago es uno solo por jugador y ronda
  const spins = db.prepare("SELECT id, round_id, amount, payout, status FROM roulette_bets WHERE status IN ('won', 'lost', 'refunded')").all();
  assert.ok(spins.length > 0);
  for (const b of spins) {
    const like = `Ruleta #${b.round_id}%`;
    const bet = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE type = 'bet' AND ref_id = ? AND note LIKE ?").get(b.id, like).s;
    assert.equal(bet, -b.amount, `fichas de la apuesta ${b.id}`);
    const back = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE type IN ('win', 'refund') AND ref_id = ? AND note LIKE ?").get(b.id, like).s;
    assert.equal(back, b.status === 'refunded' ? b.amount : b.payout, `pago de la apuesta ${b.id}`);
  }
});
