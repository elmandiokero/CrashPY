'use strict';
// Pruebas de punta a punta con un servidor real: apuestas, retiros, controles del admin y plata.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, Client, connectSocket, openDb } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// PNG de 1×1 píxel para probar la subida de comprobantes
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let srv;
let admin;
let db;
const players = [];

const crashOf = (roundId) => db.prepare('SELECT crash_point FROM rounds WHERE id = ?').get(roundId).crash_point;
const balanceOf = (id) => db.prepare('SELECT balance FROM users WHERE id = ?').get(id).balance;
const roundRow = (id) => db.prepare('SELECT * FROM rounds WHERE id = ?').get(id);

async function newPlayer(name, credit = 100_000) {
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

/** Espera la próxima fase de apuestas cuyo punto de explosión cumpla la condición. */
async function nextBetting(sock, pred = () => true) {
  for (let i = 0; i < 80; i++) {
    const b = await sock.waitFor('betting');
    if (pred(crashOf(b.roundId))) return b;
  }
  throw new Error('No apareció una ronda con esas características');
}

test.before(async () => {
  srv = await startServer();
  admin = new Client(srv.url);
  const r = await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(r.status, 200);
  const s = await admin.post('/api/admin/settings', { betting_seconds: 3, speed: 2 });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  db = openDb(srv.dataDir);
});

test.after(async () => {
  for (const p of players) p.s.close();
  if (db) db.close();
  if (srv) await srv.stop();
});

test('registro, login y datos de sesión', async () => {
  const c = new Client(srv.url);
  let r = await c.post('/api/auth/register', { username: 'ab', password: 'secret1', adult: true });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { username: 'mayor', password: 'secret1', adult: false });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { username: 'pepe', password: 'secret1', adult: true });
  assert.equal(r.status, 200);
  r = await c.post('/api/auth/register', { username: 'PEPE', password: 'secret1', adult: true });
  assert.equal(r.status, 409, 'los usuarios no distinguen mayúsculas');
  const c2 = new Client(srv.url);
  r = await c2.post('/api/auth/login', { username: 'pepe', password: 'mala' });
  assert.equal(r.status, 401);
  r = await c2.post('/api/auth/login', { username: 'pepe', password: 'secret1' });
  assert.equal(r.status, 200);
  r = await c2.get('/api/me');
  assert.equal(r.data.user.username, 'pepe');
  assert.equal(r.data.user.pass_hash, undefined);
  r = await c2.post('/api/auth/logout');
  r = await c2.get('/api/me');
  assert.equal(r.status, 401);
});

test('retiros automáticos, manuales y apuestas perdidas en una misma ronda', async () => {
  const a = await newPlayer('ana');
  const b = await newPlayer('beto');
  const c = await newPlayer('caro');
  const d = await newPlayer('dani');
  const round = await nextBetting(a.s, (cp) => cp >= 250 && cp < 2000);
  const crash = crashOf(round.roundId);

  let r = await a.s.emit('bet', { slot: 0, amount: 10000, auto: '1.40' });
  assert.ok(r.ok, r.error);
  assert.equal(r.balance, 90_000);
  r = await b.s.emit('bet', { slot: 0, amount: '5.000' });
  assert.ok(r.ok, r.error);
  r = await c.s.emit('bet', { slot: 0, amount: 7000, auto: ((crash + 100) / 100).toFixed(2) });
  assert.ok(r.ok, r.error);
  r = await d.s.emit('bet', { slot: 0, amount: 3000, auto: '1.10' });
  assert.ok(r.ok, r.error);
  r = await d.s.emit('bet', { slot: 1, amount: 4000, auto: '1.20' });
  assert.ok(r.ok, r.error, 'se permiten dos apuestas por ronda');
  r = await d.s.emit('bet', { slot: 1, amount: 4000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DUPLICATE');

  await a.s.waitFor('start', (x) => x.roundId === round.roundId);
  // El punto de explosión no se revela antes de tiempo
  const live = await a.c.get(`/api/rounds/${round.roundId}`);
  assert.equal(live.data.round.hash, undefined);
  assert.equal(live.data.round.crash_point, undefined);
  const mine = await a.c.get('/api/me/bets');
  assert.equal(mine.data.items[0].crash, null);

  await sleep(1500);
  const manual = await b.s.emit('cashout', { slot: 0 });
  assert.ok(manual.ok, manual.error);
  assert.ok(manual.bet.cashout > 100 && manual.bet.cashout < crash);
  assert.equal(manual.bet.payout, Math.floor((5000 * manual.bet.cashout) / 100));

  const end = await a.s.waitFor('crash', (x) => x.roundId === round.roundId);
  assert.equal(end.crash, crash);
  assert.equal(end.cancelled, false);
  await sleep(200);

  assert.equal(balanceOf(a.id), 100_000 - 10_000 + 14_000, 'retiro automático exacto a 1.40x');
  assert.equal(balanceOf(b.id), 100_000 - 5000 + manual.bet.payout);
  assert.equal(balanceOf(c.id), 100_000 - 7000, 'el retiro automático por encima del crash pierde');
  assert.equal(balanceOf(d.id), 100_000 - 7000 + 3300 + 4800);

  const row = roundRow(round.roundId);
  assert.equal(row.status, 'crashed');
  assert.equal(row.total_bet, 29_000);
  assert.equal(row.total_payout, 14_000 + manual.bet.payout + 3300 + 4800);
  assert.equal(row.players, 4);

  // Retirar después de la explosión no se puede
  const late = await c.s.emit('cashout', { slot: 0 });
  assert.equal(late.ok, false);
});

test('cancelar durante las apuestas devuelve la plata; validaciones de monto', async () => {
  const p = await newPlayer('eli', 20_000);
  await nextBetting(p.s);
  let r = await p.s.emit('bet', { slot: 0, amount: 500 });
  assert.equal(r.ok, false, 'por debajo del mínimo');
  r = await p.s.emit('bet', { slot: 0, amount: 5_000_000 });
  assert.equal(r.ok, false, 'por encima del máximo');
  r = await p.s.emit('bet', { slot: 0, amount: 50_000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_FUNDS');
  r = await p.s.emit('bet', { slot: 0, amount: 15_000, auto: '1.00' });
  assert.equal(r.ok, false, 'el retiro automático mínimo es 1.01x');
  r = await p.s.emit('bet', { slot: 0, amount: 15_000 });
  assert.ok(r.ok, r.error);
  assert.equal(r.balance, 5000);
  r = await p.s.emit('cancelBet', { slot: 0 });
  assert.ok(r.ok, r.error);
  assert.equal(r.balance, 20_000);
  r = await p.s.emit('bet', { slot: 0, amount: 1000 });
  assert.ok(r.ok, 'después de cancelar se puede volver a apostar en el mismo panel');
  await p.s.waitFor('start');
  r = await p.s.emit('bet', { slot: 1, amount: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_BETTING');
  r = await p.s.emit('cancelBet', { slot: 0 });
  assert.equal(r.ok, false, 'no se cancela con la ronda en vuelo');
});

test('💥 explotar ahora (devolver apuestas) no le saca plata a nadie', async () => {
  const p = await newPlayer('fer');
  const round = await nextBetting(p.s, (cp) => cp >= 300);
  await p.s.emit('bet', { slot: 0, amount: 10_000 });
  await p.s.emit('bet', { slot: 1, amount: 5000 });
  assert.equal((await admin.post('/api/admin/game/stop', { mode: 'refund' })).status, 409, 'no se puede antes del despegue');
  await p.s.waitFor('start', (x) => x.roundId === round.roundId);
  await sleep(1000);
  const res = await admin.post('/api/admin/game/stop', { mode: 'refund' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.affected, 2);
  const end = await p.s.waitFor('crash', (x) => x.roundId === round.roundId);
  assert.equal(end.cancelled, true);
  assert.equal(end.mode, 'refund');
  assert.equal(end.realCrash, crashOf(round.roundId), 'se revela el crash real del hash');
  await sleep(200);
  assert.equal(balanceOf(p.id), 100_000);
  const row = roundRow(round.roundId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_mode, 'refund');
  assert.equal(row.total_refund, 15_000);
  const audit = await admin.get('/api/admin/audit');
  assert.ok(audit.data.items.some((a) => a.action === 'game_stop'));
});

test('💥 explotar ahora (pagar a todos) paga al multiplicador del momento', async () => {
  const p = await newPlayer('gabi');
  const round = await nextBetting(p.s, (cp) => cp >= 300);
  await p.s.emit('bet', { slot: 0, amount: 10_000 });
  await p.s.waitFor('start', (x) => x.roundId === round.roundId);
  await sleep(1200);
  const res = await admin.post('/api/admin/game/stop', { mode: 'pay' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const m = res.data.multiplier;
  assert.ok(m > 100 && m < crashOf(round.roundId));
  await p.s.waitFor('crash', (x) => x.roundId === round.roundId);
  await sleep(200);
  assert.equal(balanceOf(p.id), 100_000 - 10_000 + Math.floor((10_000 * m) / 100));
});

test('pausar durante las apuestas devuelve lo apostado y reanudar sigue la misma ronda', async () => {
  const p = await newPlayer('hugo');
  const round = await nextBetting(p.s);
  await p.s.emit('bet', { slot: 0, amount: 8000 });
  const paused = p.s.waitFor('paused', (x) => x.paused && x.phase === 'PAUSED');
  const r = await admin.post('/api/admin/game/pause');
  assert.equal(r.status, 200);
  assert.equal(r.data.phase, 'PAUSED');
  await paused;
  await sleep(200);
  assert.equal(balanceOf(p.id), 100_000);
  let bet = await p.s.emit('bet', { slot: 0, amount: 1000 });
  assert.equal(bet.ok, false, 'no se apuesta con el juego pausado');
  const again = p.s.waitFor('betting');
  await admin.post('/api/admin/game/resume');
  const b2 = await again;
  assert.equal(b2.roundId, round.roundId, 'la ronda no consumió un hash nuevo');
  bet = await p.s.emit('bet', { slot: 0, amount: 1000 });
  assert.ok(bet.ok, bet.error);
});

test('depósitos, retiros y ajustes de saldo del admin', async () => {
  const p = await newPlayer('ines', 0);
  let r = await p.c.post('/api/wallet/deposit', { amount: '5.000', reference: 'X' });
  assert.equal(r.status, 400, 'por debajo del depósito mínimo');
  r = await p.c.post('/api/wallet/deposit', { amount: '50.000', reference: 'TRX-001' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const depId = r.data.deposit.id;
  r = await p.c.post('/api/wallet/deposit', { amount: 30000, reference: 'TRX-002', receipt: PNG_1PX });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const dep2 = r.data.deposit.id;
  r = await p.c.post('/api/wallet/deposit', { amount: 30000, receipt: 'data:image/png;base64,AAAA' });
  assert.equal(r.status, 400, 'se valida que el comprobante sea una imagen real');

  // Comprobante: solo lo ve el admin
  const img = await fetch(`${srv.url}/api/admin/deposits/${dep2}/receipt`, { headers: { cookie: admin.cookie } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);
  assert.equal((await p.c.get(`/api/admin/deposits/${dep2}/receipt`)).status, 403);

  r = await admin.get('/api/admin/deposits?status=pending');
  assert.ok(r.data.items.some((d) => d.id === depId));
  r = await admin.post(`/api/admin/deposits/${depId}/approve`, { amount: '45.000' });
  assert.equal(r.status, 200);
  assert.equal(balanceOf(p.id), 45_000, 'se acredita el monto corregido');
  r = await admin.post(`/api/admin/deposits/${depId}/approve`, {});
  assert.equal(r.status, 409, 'no se aprueba dos veces');
  r = await admin.post(`/api/admin/deposits/${dep2}/reject`, { note: 'no llegó' });
  assert.equal(r.status, 200);
  assert.equal(balanceOf(p.id), 45_000);

  const bank = { bank: 'Banco Itaú', accountType: 'Caja de ahorro', account: '123', holder: 'Inés Pérez', holderDoc: '1234567' };
  r = await p.c.post('/api/wallet/withdraw', { ...bank, amount: 10_000 });
  assert.equal(r.status, 400, 'por debajo del retiro mínimo');
  r = await p.c.post('/api/wallet/withdraw', { ...bank, amount: 90_000 });
  assert.equal(r.status, 400, 'más que el saldo');
  r = await p.c.post('/api/wallet/withdraw', { ...bank, amount: 20_000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.balance, 25_000, 'el retiro se descuenta al pedirlo');
  const w1 = r.data.withdrawal.id;
  r = await admin.post(`/api/admin/withdrawals/${w1}/reject`, { note: 'cuenta inválida' });
  assert.equal(r.status, 200);
  assert.equal(balanceOf(p.id), 45_000, 'al rechazar se devuelve');
  r = await p.c.post('/api/wallet/withdraw', { ...bank, amount: 30_000 });
  const w2 = r.data.withdrawal.id;
  r = await admin.post(`/api/admin/withdrawals/${w2}/pay`, { note: 'transferido' });
  assert.equal(r.status, 200);
  assert.equal(balanceOf(p.id), 15_000);
  r = await admin.post(`/api/admin/withdrawals/${w2}/reject`, {});
  assert.equal(r.status, 409, 'un retiro pagado no se puede rechazar');

  r = await admin.post(`/api/admin/users/${p.id}/balance`, { op: 'set', amount: '100.000', note: 'corrección' });
  assert.equal(r.status, 200);
  assert.equal(balanceOf(p.id), 100_000);
  r = await admin.post(`/api/admin/users/${p.id}/balance`, { op: 'sub', amount: 150_000 });
  assert.equal(r.status, 400, 'el saldo nunca queda negativo');
  r = await admin.post(`/api/admin/users/${p.id}/balance`, { op: 'sub', amount: 1_000, note: 'x' });
  assert.equal(balanceOf(p.id), 99_000);

  const detail = await admin.get(`/api/admin/users/${p.id}`);
  assert.equal(detail.data.user.total_deposit, 45_000);
  assert.equal(detail.data.user.total_withdraw, 30_000);
  const types = detail.data.ledger.map((l) => l.type);
  for (const t of ['deposit', 'withdraw', 'withdraw_refund', 'admin']) assert.ok(types.includes(t), t);
});

test('permisos: los jugadores no entran al panel de admin', async () => {
  const p = await newPlayer('juli', 0);
  assert.equal((await p.c.get('/api/admin/overview')).status, 403);
  assert.equal((await p.c.post(`/api/admin/users/${p.id}/balance`, { op: 'add', amount: 1e6 })).status, 403);
  assert.equal((await new Client(srv.url).get('/api/admin/overview')).status, 401);
  assert.equal((await new Client(srv.url).get('/api/me')).status, 401);
  const r = await admin.get('/api/admin/overview');
  assert.equal(r.status, 200);
  assert.ok(r.data.stats.all.rounds > 0);
  // Una cuenta suspendida no puede entrar
  await admin.post(`/api/admin/users/${p.id}/flags`, { banned: true });
  assert.equal((await p.c.get('/api/me')).status, 401);
  const again = await new Client(srv.url).post('/api/auth/login', { username: 'juli', password: 'secret1' });
  assert.equal(again.status, 403);
});

test('chat: mensajes, límite de velocidad y silenciados', async () => {
  const p = await newPlayer('kari', 0);
  const got = p.s.waitFor('chat', (m) => m.uid === p.id);
  let r = await p.s.emit('chat', { text: '  hola <b>che</b> 🇵🇾  ' });
  assert.ok(r.ok, r.error);
  const msg = await got;
  assert.equal(msg.text, 'hola <b>che</b> 🇵🇾', 'el texto se guarda tal cual (el navegador lo muestra como texto)');
  r = await p.s.emit('chat', { text: 'spam' });
  assert.equal(r.ok, false, 'límite de 1 mensaje cada 1,5 s');
  await admin.post(`/api/admin/users/${p.id}/flags`, { muted: true });
  await sleep(1600);
  r = await p.s.emit('chat', { text: 'hola?' });
  assert.equal(r.ok, false);
  r = await admin.post(`/api/admin/chat/${msg.id}/delete`);
  assert.equal(r.status, 200);
});

test('todas las rondas terminadas son verificables y los saldos cuadran con el libro contable', async () => {
  const rounds = db.prepare("SELECT r.*, c.salt, c.house_edge_bps, c.terminal_hash FROM rounds r JOIN chains c ON c.id = r.chain_id WHERE r.status IN ('crashed','cancelled') ORDER BY r.id").all();
  assert.ok(rounds.length >= 5);
  const { crashPointFromHash } = require('../server/fair');
  const byIndex = new Map(rounds.map((r) => [`${r.chain_id}:${r.chain_index}`, r]));
  for (const r of rounds) {
    assert.equal(crashPointFromHash(r.hash, r.salt, r.house_edge_bps), r.crash_point, `ronda ${r.id}`);
    const prev = r.chain_index === 1 ? { hash: r.terminal_hash } : byIndex.get(`${r.chain_id}:${r.chain_index - 1}`);
    if (prev) assert.equal(sha256(r.hash), prev.hash, `enlace ronda ${r.id}`);
  }
  // Invariante contable: saldo = suma del libro, y cada saldo parcial es correcto
  const users = db.prepare('SELECT id, balance FROM users').all();
  for (const u of users) {
    const rows = db.prepare('SELECT amount, balance_after FROM ledger WHERE user_id = ? ORDER BY id').all(u.id);
    let running = 0;
    for (const row of rows) {
      running += row.amount;
      assert.equal(row.balance_after, running, `usuario ${u.id}`);
    }
    assert.equal(running, u.balance, `usuario ${u.id}`);
  }
  // Nunca quedan apuestas "activas" en rondas terminadas
  const orphan = db.prepare("SELECT COUNT(*) AS c FROM bets b JOIN rounds r ON r.id = b.round_id WHERE b.status = 'active' AND r.status IN ('crashed','cancelled')").get().c;
  assert.equal(orphan, 0);
});
