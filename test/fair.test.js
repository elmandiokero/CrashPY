'use strict';
// Pruebas del sistema provably fair (sin servidor).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crashPointFromHash, multiplierAt, msForMultiplier, ChainManager } = require('../server/fair');
const { Database } = require('../server/db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('el punto de explosión nunca es menor a 1.00x y es determinístico', () => {
  let h = 'semilla-de-prueba';
  for (let i = 0; i < 5000; i++) {
    h = sha256(h);
    const a = crashPointFromHash(h, 'sal', 300);
    const b = crashPointFromHash(h, 'sal', 300);
    assert.equal(a, b);
    assert.ok(Number.isInteger(a) && a >= 100);
  }
});

test('la distribución respeta la ventaja de la casa (RTP ≈ 97%)', () => {
  const n = 200_000;
  let h = 'distribucion';
  let ge2 = 0;
  let ge10 = 0;
  let instant = 0;
  for (let i = 0; i < n; i++) {
    h = sha256(h);
    const c = crashPointFromHash(h, 'sal-publica', 300);
    if (c >= 200) ge2++;
    if (c >= 1000) ge10++;
    if (c === 100) instant++;
  }
  // P(crash ≥ x) = 0.97 / x
  assert.ok(Math.abs(ge2 / n - 0.485) < 0.006, `P(≥2x)=${ge2 / n}`);
  assert.ok(Math.abs(ge10 / n - 0.097) < 0.004, `P(≥10x)=${ge10 / n}`);
  assert.ok(Math.abs(instant / n - 0.0396) < 0.003, `P(1.00x)=${instant / n}`);
  // Retorno esperado apostando siempre a 2x ≈ 0.97
  assert.ok(Math.abs((ge2 / n) * 2 - 0.97) < 0.012);
});

test('el verificador del navegador calcula exactamente lo mismo que el servidor', async () => {
  const shared = await import('../public/js/shared.js');
  let h = 'paridad';
  for (let i = 0; i < 3000; i++) {
    h = sha256(h);
    const salt = crypto.randomBytes(16).toString('hex');
    assert.equal(shared.sha256Hex(h), sha256(h));
    for (const edge of [0, 100, 250, 300, 500]) {
      assert.equal(shared.crashFromHash(h, salt, edge), crashPointFromHash(h, salt, edge));
    }
  }
});

test('multiplicador y tiempo son consistentes', () => {
  const g = 0.00006;
  assert.equal(multiplierAt(0, g), 100);
  for (const m of [101, 150, 200, 1000, 12345]) {
    const t = msForMultiplier(m, g);
    assert.ok(multiplierAt(t + 1, g) >= m, `m=${m}`);
    assert.ok(multiplierAt(t - 5, g) < m, `m=${m}`);
  }
  assert.ok(Math.abs(msForMultiplier(200, g) - 11552) < 2);
});

test('la cadena de hashes está enlazada y termina en el hash publicado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashpy-fair-'));
  const db = new Database(path.join(dir, 'test.db'));
  const chains = new ChainManager(db, { length: 3000, defaultEdgeBps: 300, log: () => {} });
  chains.init();
  const terminal = chains.active.terminal_hash;
  let prev = terminal;
  for (let i = 1; i <= 120; i++) {
    const next = db.tx(() => chains.next());
    assert.equal(next.index, i);
    assert.equal(sha256(next.hash), prev, `ronda ${i}`);
    prev = next.hash;
  }
  // La última ronda de la cadena usa la semilla
  assert.equal(chains.hashAt(3000), chains.active.seed);
  // Al rotar, la cadena vieja queda inactiva con su semilla visible y la nueva empieza de cero
  chains.requestRotation(250);
  const first = db.tx(() => chains.next());
  assert.equal(first.index, 1);
  assert.equal(first.edgeBps, 250);
  assert.equal(sha256(first.hash), chains.active.terminal_hash);
  const info = chains.publicInfo();
  assert.equal(info.previous.length, 1);
  assert.equal(info.previous[0].terminal_hash, terminal);
  // Con la semilla revelada cualquiera reconstruye toda la cadena vieja
  let h = info.previous[0].seed;
  for (let i = 0; i < 3000; i++) h = sha256(h);
  assert.equal(h, terminal);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
