/*
 * Núcleo matemático de los juegos (se usa igual en el servidor y en el navegador).
 *
 * PROVABLY FAIR con semillas (Minas, Penales, Plinko, Ruleta):
 *   - semilla del servidor (secreta; antes se muestra su SHA-256)
 *   - semilla del cliente (la podés cambiar vos)
 *   - nonce (número de jugada con ese par de semillas)
 *   Números aleatorios: HMAC_SHA256(clave = semilla servidor, mensaje = "semillaCliente:nonce:ronda")
 *   cada 4 bytes forman un número entre 0 y 1.
 *
 * Todos los multiplicadores están en centésimas (250 = 2.50x).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GamesCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RTP = 0.97;

  // ───────── Números aleatorios a partir de las semillas ─────────

  /** hmacBytes(clave, mensaje) → Uint8Array/Buffer de 32 bytes. */
  function seedFloats(hmacBytes, serverSeed, clientSeed, nonce, count) {
    const out = [];
    for (let round = 0; out.length < count; round++) {
      const b = hmacBytes(serverSeed, `${clientSeed}:${nonce}:${round}`);
      for (let i = 0; i + 4 <= 32 && out.length < count; i += 4) {
        out.push(b[i] / 256 + b[i + 1] / 65536 + b[i + 2] / 16777216 + b[i + 3] / 4294967296);
      }
    }
    return out;
  }

  const floor2 = (x) => Math.floor(x * 100 + 1e-9);

  // ───────── 💣 Minas (grilla 5×5) ─────────

  const MINES_TILES = 25;

  /** Posiciones de las minas: mezcla las 25 casillas y toma las primeras `mines`. */
  function minesPositions(floats, mines) {
    const tiles = [];
    for (let i = 0; i < MINES_TILES; i++) tiles.push(i);
    const order = [];
    for (let i = 0; i < MINES_TILES - 1; i++) order.push(tiles.splice(Math.floor(floats[i] * tiles.length), 1)[0]);
    order.push(tiles[0]);
    return order.slice(0, mines).sort((a, b) => a - b);
  }

  /** Multiplicador después de destapar `revealed` casillas seguras con `mines` minas. */
  function minesMultiplier(mines, revealed) {
    let p = 1;
    for (let i = 0; i < revealed; i++) p *= (MINES_TILES - mines - i) / (MINES_TILES - i);
    return floor2(RTP / p);
  }

  // ───────── ⚽ Penales de la Albirroja ─────────

  const PENALTY_ZONES = 3; // 0 = izquierda, 1 = centro, 2 = derecha
  const PENALTY_KICKS = 5;

  /** Hacia dónde se tira el arquero en cada uno de los 5 penales. */
  function penaltyKeepers(floats) {
    return floats.slice(0, PENALTY_KICKS).map((f) => Math.floor(f * PENALTY_ZONES));
  }

  /** Multiplicador con `goals` goles seguidos (cada gol tiene 2/3 de probabilidad). */
  function penaltyMultiplier(goals) {
    return goals <= 0 ? 0 : floor2(RTP * Math.pow(PENALTY_ZONES / (PENALTY_ZONES - 1), goals));
  }

  // ───────── 🔴 Plinko ─────────

  const PLINKO_ROWS = [8, 10, 12, 14, 16];
  const PLINKO_RISKS = ['low', 'medium', 'high'];
  // RTP entre 96,7% y 97,0% (verificado con la distribución binomial exacta)
  const PLINKO = {
    8: {
      low: [549, 206, 107, 98, 49, 98, 107, 206, 549],
      medium: [1280, 295, 128, 68, 39, 68, 128, 295, 1280],
      high: [2850, 394, 147, 29, 19, 29, 147, 394, 2850],
    },
    10: {
      low: [873, 294, 137, 107, 98, 49, 98, 107, 137, 294, 873],
      medium: [2160, 492, 196, 137, 59, 39, 59, 137, 196, 492, 2160],
      high: [7490, 985, 295, 88, 29, 19, 29, 88, 295, 985, 7490],
    },
    12: {
      low: [981, 294, 157, 137, 107, 98, 49, 98, 107, 137, 157, 294, 981],
      medium: [3240, 1080, 393, 196, 108, 58, 29, 58, 108, 196, 393, 1080, 3240],
      high: [16700, 2360, 798, 197, 68, 19, 19, 19, 68, 197, 798, 2360, 16700],
    },
    14: {
      low: [697, 392, 186, 137, 127, 107, 98, 49, 98, 107, 127, 137, 186, 392, 697],
      medium: [5700, 1470, 688, 393, 186, 98, 49, 19, 49, 98, 186, 393, 688, 1470, 5700],
      high: [41400, 5530, 1770, 494, 187, 29, 19, 19, 19, 29, 187, 494, 1770, 5530, 41400],
    },
    16: {
      low: [1570, 885, 196, 137, 137, 117, 108, 98, 49, 98, 108, 117, 137, 137, 196, 885, 1570],
      medium: [10800, 4030, 983, 491, 294, 147, 98, 49, 29, 49, 98, 147, 294, 491, 983, 4030, 10800],
      high: [98700, 12800, 2560, 888, 394, 197, 19, 19, 19, 19, 19, 197, 394, 888, 2560, 12800, 98700],
    },
  };

  /** Camino de la bolita: 0 = izquierda, 1 = derecha en cada fila. */
  function plinkoPath(floats, rows) {
    return floats.slice(0, rows).map((f) => (f < 0.5 ? 0 : 1));
  }

  function plinkoResult(floats, rows, risk) {
    const path = plinkoPath(floats, rows);
    const bucket = path.reduce((a, b) => a + b, 0);
    return { path, bucket, multiplier: PLINKO[rows][risk][bucket] };
  }

  // ───────── 🎰 Ruleta europea (0–36) ─────────

  const ROULETTE_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  // Orden real de los números en la rueda europea
  const ROULETTE_WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const ROULETTE_PAYS = { n: 3600, red: 200, black: 200, odd: 200, even: 200, low: 200, high: 200, dozen: 300, column: 300 };

  function rouletteNumber(floats) {
    return Math.floor(floats[0] * 37);
  }

  function rouletteColor(n) {
    if (n === 0) return 'green';
    return ROULETTE_RED.includes(n) ? 'red' : 'black';
  }

  function rouletteWins(bet, n) {
    const v = bet.value;
    switch (bet.type) {
      case 'n':
        return n === v;
      case 'red':
        return n !== 0 && ROULETTE_RED.includes(n);
      case 'black':
        return n !== 0 && !ROULETTE_RED.includes(n);
      case 'odd':
        return n !== 0 && n % 2 === 1;
      case 'even':
        return n !== 0 && n % 2 === 0;
      case 'low':
        return n >= 1 && n <= 18;
      case 'high':
        return n >= 19;
      case 'dozen':
        return n !== 0 && Math.ceil(n / 12) === v;
      case 'column':
        return n !== 0 && ((n - 1) % 3) + 1 === v;
      default:
        return false;
    }
  }

  /** Total a cobrar (guaraníes) para una lista de apuestas [{type, value, amount}] si sale `n`. */
  function roulettePayout(bets, n) {
    let total = 0;
    for (const b of bets) if (rouletteWins(b, n)) total += Math.floor((b.amount * ROULETTE_PAYS[b.type]) / 100);
    return total;
  }

  // ───────── 🎡 Double (31 casillas: 1 blanca, 15 rojas, 15 negras) ─────────

  const DOUBLE_TILES = 31;
  const DOUBLE_PAYS = { red: 200, black: 200, white: 3000 };

  /** Casilla del Double a partir del HMAC (hex) de la ronda — misma idea que el crash. */
  function doubleTileFromHmac(hmacHex) {
    const r = parseInt(hmacHex.slice(0, 13), 16);
    return Math.floor((r / 4503599627370496) * DOUBLE_TILES);
  }

  function doubleColor(n) {
    if (n === 0) return 'white';
    return n % 2 === 1 ? 'red' : 'black';
  }

  return {
    RTP,
    seedFloats,
    MINES_TILES,
    minesPositions,
    minesMultiplier,
    PENALTY_ZONES,
    PENALTY_KICKS,
    penaltyKeepers,
    penaltyMultiplier,
    PLINKO,
    PLINKO_ROWS,
    PLINKO_RISKS,
    plinkoPath,
    plinkoResult,
    ROULETTE_RED,
    ROULETTE_WHEEL,
    ROULETTE_PAYS,
    rouletteNumber,
    rouletteColor,
    rouletteWins,
    roulettePayout,
    DOUBLE_TILES,
    DOUBLE_PAYS,
    doubleTileFromHmac,
    doubleColor,
  };
});
