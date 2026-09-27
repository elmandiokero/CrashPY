'use strict';
// Matemática de Minas, Penales, Plinko, Ruleta y Double (sin servidor).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const core = require('../public/js/games-core.js');

const hmacBytes = (key, message) => crypto.createHmac('sha256', key).update(message).digest();
const floatsOf = (serverSeed, clientSeed, nonce, count) => core.seedFloats(hmacBytes, serverSeed, clientSeed, nonce, count);

function binomial(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

test('los números aleatorios salen de las semillas: determinísticos, entre 0 y 1 y distintos por nonce', () => {
  const a = floatsOf('servidor', 'cliente', 7, 24);
  const b = floatsOf('servidor', 'cliente', 7, 24);
  assert.deepEqual(a, b);
  assert.equal(a.length, 24);
  for (const f of a) assert.ok(f >= 0 && f < 1);
  assert.notDeepEqual(floatsOf('servidor', 'cliente', 8, 24), a);
  assert.notDeepEqual(floatsOf('servidor', 'otro', 7, 24), a);
  // Los primeros 8 números vienen del primer HMAC; del 9 en adelante, de la "ronda" siguiente
  const first = hmacBytes('servidor', 'cliente:7:0');
  assert.equal(a[0], first[0] / 256 + first[1] / 65536 + first[2] / 16777216 + first[3] / 4294967296);
  const second = hmacBytes('servidor', 'cliente:7:1');
  assert.equal(a[8], second[0] / 256 + second[1] / 65536 + second[2] / 16777216 + second[3] / 4294967296);
});

test('el verificador del navegador genera exactamente los mismos números que el servidor', async () => {
  const shared = await import('../public/js/shared.js');
  for (let i = 0; i < 300; i++) {
    const server = crypto.randomBytes(32).toString('hex');
    const client = crypto.randomBytes(6).toString('hex');
    const nonce = i * 37;
    assert.deepEqual(core.seedFloats(shared.hmacSha256Bytes, server, client, nonce, 24), floatsOf(server, client, nonce, 24));
  }
});

test('💣 Minas: posiciones válidas y multiplicadores con 97% de retorno', () => {
  for (let i = 0; i < 2000; i++) {
    const mines = (i % 24) + 1;
    const pos = core.minesPositions(floatsOf('s' + i, 'c', i, 24), mines);
    assert.equal(pos.length, mines);
    assert.equal(new Set(pos).size, mines);
    for (const p of pos) assert.ok(Number.isInteger(p) && p >= 0 && p < 25);
    assert.deepEqual(pos, [...pos].sort((x, y) => x - y));
  }
  // Retirando después de k casillas seguras el retorno esperado es 97% (un poco menos por el redondeo)
  for (let mines = 1; mines <= 24; mines++) {
    let p = 1;
    let prev = 0;
    for (let k = 1; k <= 25 - mines; k++) {
      p *= (25 - mines - (k - 1)) / (25 - (k - 1));
      const m = core.minesMultiplier(mines, k);
      const ret = (p * m) / 100;
      assert.ok(ret <= 0.9700001 && ret >= 0.96, `minas=${mines} k=${k} retorno=${ret}`);
      assert.ok(m > prev, 'el multiplicador siempre sube');
      prev = m;
    }
  }
  assert.equal(core.minesMultiplier(3, 1), 110);
  assert.equal(core.minesMultiplier(1, 1), 101);
  assert.equal(core.minesMultiplier(24, 1), 2425);
  // Distribución: cada casilla tiene la misma chance de tener una mina
  const count = new Array(25).fill(0);
  const n = 25_000;
  for (let i = 0; i < n; i++) for (const p of core.minesPositions(floatsOf('dist', 'c', i, 24), 5)) count[p]++;
  for (const c of count) assert.ok(Math.abs(c / n - 0.2) < 0.012, `frecuencia ${c / n}`);
});

test('⚽ Penales: 3 zonas, 5 penales y multiplicadores con 97% de retorno', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(core.penaltyMultiplier), [0, 145, 218, 327, 491, 736]);
  for (let g = 1; g <= core.PENALTY_KICKS; g++) {
    const ret = (Math.pow(2 / 3, g) * core.penaltyMultiplier(g)) / 100;
    assert.ok(ret <= 0.9700001 && ret >= 0.965, `goles=${g} retorno=${ret}`);
  }
  const zones = [0, 0, 0];
  for (let i = 0; i < 30_000; i++) {
    const k = core.penaltyKeepers(floatsOf('arquero', 'c', i, 5));
    assert.equal(k.length, 5);
    for (const z of k) zones[z]++;
  }
  for (const z of zones) assert.ok(Math.abs(z / 150_000 - 1 / 3) < 0.01);
});

test('🔴 Plinko: todas las tablas devuelven entre 96,5% y 97,1% (cálculo exacto)', () => {
  for (const rows of core.PLINKO_ROWS) {
    for (const risk of core.PLINKO_RISKS) {
      const table = core.PLINKO[rows][risk];
      assert.equal(table.length, rows + 1, `${rows}/${risk}`);
      assert.deepEqual(table, [...table].reverse(), 'la tabla es simétrica');
      let ret = 0;
      for (let k = 0; k <= rows; k++) ret += (binomial(rows, k) / 2 ** rows) * (table[k] / 100);
      assert.ok(ret >= 0.965 && ret <= 0.971, `${rows} filas, riesgo ${risk}: ${(ret * 100).toFixed(2)}%`);
    }
  }
  const r = core.plinkoResult(floatsOf('bolita', 'c', 1, 16), 16, 'high');
  assert.equal(r.path.length, 16);
  assert.equal(r.bucket, r.path.reduce((a, b) => a + b, 0));
  assert.equal(r.multiplier, core.PLINKO[16].high[r.bucket]);
});

test('🎰 Ruleta europea: cada tipo de apuesta paga lo justo (retorno 97,3%)', () => {
  const bets = [{ type: 'n', value: 17 }, { type: 'n', value: 0 }, { type: 'red' }, { type: 'black' }, { type: 'odd' }, { type: 'even' }, { type: 'low' }, { type: 'high' }];
  for (const v of [1, 2, 3]) bets.push({ type: 'dozen', value: v }, { type: 'column', value: v });
  for (const b of bets) {
    let total = 0;
    for (let n = 0; n <= 36; n++) total += core.roulettePayout([{ ...b, amount: 37_000 }], n);
    assert.equal(total / 37, 36_000, `${b.type} ${b.value ?? ''}`);
  }
  assert.equal(core.ROULETTE_WHEEL.length, 37);
  assert.deepEqual([...core.ROULETTE_WHEEL].sort((a, b) => a - b), [...Array(37).keys()]);
  assert.equal(core.rouletteColor(0), 'green');
  assert.equal(core.rouletteColor(32), 'red');
  assert.equal(core.rouletteColor(15), 'black');
  assert.equal(core.ROULETTE_RED.length, 18);
  // Con 1 ficha en cada número siempre cobrás 36
  const all = Array.from({ length: 37 }, (_, n) => ({ type: 'n', value: n, amount: 1000 }));
  for (let n = 0; n <= 36; n++) assert.equal(core.roulettePayout(all, n), 36_000);
  assert.equal(core.rouletteMaxPayout(all), 36_000);
  assert.equal(core.rouletteMaxPayout([{ type: 'red', amount: 1000 }, { type: 'n', value: 3, amount: 1000 }]), 38_000);
  assert.equal(core.rouletteMaxPayout([{ type: 'red', amount: 1000 }, { type: 'black', amount: 1000 }]), 2_000);
});

test('🎰 Ruleta en vivo: el número sale del hash de la ronda y todos tienen la misma chance', () => {
  const seen = new Array(37).fill(0);
  let h = 'ruleta';
  for (let i = 0; i < 74_000; i++) {
    h = crypto.createHash('sha256').update(h).digest('hex');
    const n = core.rouletteNumberFromHmac(crypto.createHmac('sha256', 'sal').update(h).digest('hex'));
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 36);
    seen[n]++;
  }
  for (const c of seen) assert.ok(Math.abs(c / 74_000 - 1 / 37) < 0.005);
  // Mismo cálculo que el del Double y el Crash: primeros 52 bits del HMAC
  assert.equal(core.rouletteNumberFromHmac('0000000000000' + 'f'.repeat(51)), 0);
  assert.equal(core.rouletteNumberFromHmac('fffffffffffff' + '0'.repeat(51)), 36);
});

test('🎡 Double: 15 rojas, 15 negras y 1 blanca, retorno 96,8% en cada color', () => {
  const count = { red: 0, black: 0, white: 0 };
  for (let n = 0; n < core.DOUBLE_TILES; n++) count[core.doubleColor(n)]++;
  assert.deepEqual(count, { red: 15, black: 15, white: 1 });
  for (const c of ['red', 'black', 'white']) {
    const ret = ((count[c] / 31) * core.DOUBLE_PAYS[c]) / 100;
    assert.ok(Math.abs(ret - 30 / 31) < 1e-9, `${c}: ${ret}`);
  }
  const seen = new Array(31).fill(0);
  let h = 'double';
  for (let i = 0; i < 62_000; i++) {
    h = crypto.createHash('sha256').update(h).digest('hex');
    const t = core.doubleTileFromHmac(crypto.createHmac('sha256', 'sal').update(h).digest('hex'));
    assert.ok(Number.isInteger(t) && t >= 0 && t < 31);
    seen[t]++;
  }
  for (const s of seen) assert.ok(Math.abs(s / 62_000 - 1 / 31) < 0.006);
});
