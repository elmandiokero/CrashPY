import { $, $$, h, api, fmtMult, fmtNum, fmtDate, multClass, sha256Hex, hmacSha256Hex, crashFromHash, copyText } from './shared.js';
import { core, playVisual, recompute, GAME_BY_ID, DOUBLE_COLORS, ROULETTE_COLOR_NAMES } from './games/common.js';

let fair = null;
let dfair = null;
let rfair = null;

// ───────────────────────── Pestañas ─────────────────────────

function showTab(tab) {
  $$('#fairTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.fair-pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
}

$('#fairTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  showTab(b.dataset.tab);
  const url = new URL(location.href);
  url.search = b.dataset.tab === 'crash' ? '' : `?game=${b.dataset.tab}`;
  history.replaceState(null, '', url);
});

const copyBtn = (text) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => copyText(text) }, '📋 Copiar');

function renderChain(info) {
  const c = info.current;
  const pct = c.length ? (c.used / c.length) * 100 : 0;
  $('#chainInfo').replaceChildren(
    h(
      'dl',
      { class: 'chain-grid' },
      h('dt', null, 'Hash terminal'),
      h('dd', null, h('div', { class: 'mono' }, c.terminalHash), copyBtn(c.terminalHash)),
      h('dt', null, 'Sal (salt)'),
      h('dd', null, h('span', { class: 'mono' }, c.salt), ' ', copyBtn(c.salt)),
      h('dt', null, 'Ventaja de la casa'),
      h('dd', null, `${(c.houseEdgeBps / 100).toFixed(2)}% · RTP ${(100 - c.houseEdgeBps / 100).toFixed(2)}%`),
      h('dt', null, 'Rondas jugadas'),
      h('dd', null, `${fmtNum(c.used)} de ${fmtNum(c.length)}`, h('div', { class: 'progress' }, h('div', { style: { width: `${Math.max(0.5, pct)}%` } }))),
      h('dt', null, 'Publicada'),
      h('dd', null, fmtDate(c.createdAt)),
    ),
  );
  if (info.previous && info.previous.length) {
    $('#prevCard').hidden = false;
    $('#prevChains').replaceChildren(
      ...info.previous.map((p) =>
        h(
          'div',
          { class: 'status-line' },
          h('b', null, `Cadena #${p.id}`),
          ` · ventaja ${(p.house_edge_bps / 100).toFixed(2)}% · ${fmtNum(p.used)} rondas · ${fmtDate(p.created_at)} → ${fmtDate(p.ended_at)}`,
          h('div', { class: 'mono', style: { marginTop: '6px' } }, `Semilla: ${p.seed}`),
          h('div', { class: 'mono' }, `Terminal: ${p.terminal_hash}`),
          h('div', { class: 'mono' }, `Sal: ${p.salt}`),
        ),
      ),
    );
  }
}

async function walkToTerminal(hash, terminal, maxSteps, onProgress) {
  let h2 = hash;
  const chunk = 4000;
  for (let i = 1; i <= maxSteps; i++) {
    h2 = sha256Hex(h2);
    if (h2 === terminal) return i;
    if (i % chunk === 0) {
      onProgress(i);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return 0;
}

function verify() {
  const out = $('#verifyOut');
  const hash = $('#vHash').value.trim().toLowerCase();
  const salt = $('#vSalt').value.trim();
  const edgePct = parseFloat($('#vEdge').value.replace(',', '.'));
  const count = Math.min(500, Math.max(1, parseInt($('#vCount').value, 10) || 20));
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'El hash tiene que tener 64 caracteres hexadecimales (0-9, a-f).'));
    return;
  }
  if (!salt) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'Ingresá la sal (salt) de la cadena.'));
    return;
  }
  if (!Number.isFinite(edgePct) || edgePct < 0 || edgePct > 20) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'Ventaja inválida.'));
    return;
  }
  const edgeBps = Math.round(edgePct * 100);
  const crash = crashFromHash(hash, salt, edgeBps);
  const rows = [];
  let current = hash;
  for (let i = 0; i < count; i++) {
    const c = crashFromHash(current, salt, edgeBps);
    rows.push(
      h(
        'tr',
        null,
        h('td', null, i === 0 ? 'Esta ronda' : `−${i}`),
        h('td', { class: 'mono' }, current),
        h('td', { class: `num ${multClass(c)}` }, h('b', null, fmtMult(c))),
      ),
    );
    current = sha256Hex(current);
  }
  const chainStatus = h('div', { class: 'status-line' }, '');
  const walkBtn = h('button', { class: 'btn btn-ghost btn-block', type: 'button' }, '🔗 Comprobar que pertenece a la cadena publicada');
  out.replaceChildren(h('div', null,
    h('div', { class: 'result-hero' }, h('small', null, 'Punto de explosión'), h('div', { class: `big ${multClass(crash)}` }, fmtMult(crash))),
    h('p', { class: 'muted' }, 'Rondas anteriores (cada hash es el SHA-256 del de arriba). Compará con el historial del juego:'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table prev-table' },
        h('thead', null, h('tr', null, h('th', null, 'Ronda'), h('th', null, 'Hash'), h('th', { class: 'num' }, 'Crash'))),
        h('tbody', null, ...rows),
      ),
    ),
    fair ? walkBtn : null,
    fair ? chainStatus : null,
  ));
  chainStatus.hidden = true;
  walkBtn.addEventListener('click', async () => {
    walkBtn.disabled = true;
    chainStatus.hidden = false;
    chainStatus.className = 'status-line';
    const terminals = [{ id: fair.current.chainId, terminal: fair.current.terminalHash, max: fair.current.used + 5 }].concat(
      (fair.previous || []).map((p) => ({ id: p.id, terminal: p.terminal_hash, max: p.used + 5 })),
    );
    for (const t of terminals) {
      chainStatus.textContent = `Calculando hashes hasta el terminal de la cadena #${t.id}…`;
      const steps = await walkToTerminal(hash, t.terminal, t.max, (i) => {
        chainStatus.textContent = `Cadena #${t.id}: ${fmtNum(i)} de hasta ${fmtNum(t.max)} hashes…`;
      });
      if (steps) {
        chainStatus.className = 'status-line ok';
        chainStatus.textContent = `✅ Pertenece a la cadena #${t.id}: aplicando SHA-256 ${fmtNum(steps)} veces se llega al hash terminal publicado. Es la ronda ${fmtNum(steps)} de esa cadena.`;
        walkBtn.disabled = false;
        return;
      }
    }
    chainStatus.className = 'status-line bad';
    chainStatus.textContent = '❌ No se llegó a ningún hash terminal publicado. Revisá que el hash esté bien copiado.';
    walkBtn.disabled = false;
  });
}

$('#verifyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  verify();
});

// ───────────────────────── 🎡 Double ─────────────────────────

const doubleTile = (hash, salt) => core.doubleTileFromHmac(hmacSha256Hex(salt, hash));
const tileBadge = (n) => {
  const c = core.doubleColor(n);
  return h('span', { class: `dtile ${c}`, title: DOUBLE_COLORS[c] }, c === 'white' ? '★' : String(n));
};

/** Cadena de un juego en vivo (Double o Ruleta): prefix = 'd' o 'r' (ids #dChainInfo, #rChainInfo...). */
function renderLiveChain(info, prefix, pays) {
  const c = info.current;
  const pct = c.length ? (c.used / c.length) * 100 : 0;
  $(`#${prefix}ChainInfo`).replaceChildren(
    h(
      'dl',
      { class: 'chain-grid' },
      h('dt', null, 'Hash terminal'),
      h('dd', null, h('div', { class: 'mono' }, c.terminalHash), copyBtn(c.terminalHash)),
      h('dt', null, 'Sal (salt)'),
      h('dd', null, h('span', { class: 'mono' }, c.salt), ' ', copyBtn(c.salt)),
      h('dt', null, 'Pagos'),
      h('dd', null, pays),
      h('dt', null, 'Rondas jugadas'),
      h('dd', null, `${fmtNum(c.used)} de ${fmtNum(c.length)}`, h('div', { class: 'progress' }, h('div', { style: { width: `${Math.max(0.5, pct)}%` } }))),
      h('dt', null, 'Publicada'),
      h('dd', null, fmtDate(c.createdAt)),
    ),
  );
  if (info.previous && info.previous.length) {
    $(`#${prefix}PrevCard`).hidden = false;
    $(`#${prefix}PrevChains`).replaceChildren(
      ...info.previous.map((p) =>
        h(
          'div',
          { class: 'status-line' },
          h('b', null, `Cadena #${p.id}`),
          ` · ${fmtNum(p.used)} rondas · ${fmtDate(p.created_at)} → ${fmtDate(p.ended_at)}`,
          h('div', { class: 'mono', style: { marginTop: '6px' } }, `Semilla: ${p.seed}`),
          h('div', { class: 'mono' }, `Terminal: ${p.terminal_hash}`),
          h('div', { class: 'mono' }, `Sal: ${p.salt}`),
        ),
      ),
    );
  }
}

function verifyDouble() {
  const out = $('#dVerifyOut');
  const hash = $('#dHash').value.trim().toLowerCase();
  const salt = $('#dSalt').value.trim();
  const count = Math.min(500, Math.max(1, parseInt($('#dCount').value, 10) || 20));
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'El hash tiene que tener 64 caracteres hexadecimales (0-9, a-f).'));
    return;
  }
  if (!salt) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'Ingresá la sal (salt) de la cadena del Double.'));
    return;
  }
  const n = doubleTile(hash, salt);
  const color = core.doubleColor(n);
  const rows = [];
  let current = hash;
  for (let i = 0; i < count; i++) {
    const t = doubleTile(current, salt);
    rows.push(h('tr', null, h('td', null, i === 0 ? 'Esta ronda' : `−${i}`), h('td', { class: 'mono' }, current), h('td', { class: 'num' }, tileBadge(t))));
    current = sha256Hex(current);
  }
  const chainStatus = h('div', { class: 'status-line', hidden: true });
  const walkBtn = h('button', { class: 'btn btn-ghost btn-block', type: 'button' }, '🔗 Comprobar que pertenece a la cadena publicada');
  walkBtn.addEventListener('click', () => walkChains(hash, dfair, walkBtn, chainStatus));
  out.replaceChildren(
    h(
      'div',
      null,
      h('div', { class: 'result-hero' }, h('small', null, 'Casilla ganadora'), h('div', { class: `big dbig ${color}` }, color === 'white' ? '★ 0' : String(n)), h('small', null, `${DOUBLE_COLORS[color]} · paga ${color === 'white' ? '30x' : '2x'}`)),
      h('p', { class: 'muted' }, 'Rondas anteriores (cada hash es el SHA-256 del de arriba). Compará con el historial del juego:'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table prev-table' }, h('thead', null, h('tr', null, h('th', null, 'Ronda'), h('th', null, 'Hash'), h('th', { class: 'num' }, 'Casilla'))), h('tbody', null, ...rows))),
      dfair ? walkBtn : null,
      chainStatus,
    ),
  );
}

async function walkChains(hash, info, btn, status) {
  btn.disabled = true;
  status.hidden = false;
  status.className = 'status-line';
  const terminals = [{ id: info.current.chainId, terminal: info.current.terminalHash, max: info.current.used + 5 }].concat(
    (info.previous || []).map((p) => ({ id: p.id, terminal: p.terminal_hash, max: p.used + 5 })),
  );
  for (const t of terminals) {
    status.textContent = `Calculando hashes hasta el terminal de la cadena #${t.id}…`;
    const steps = await walkToTerminal(hash, t.terminal, t.max, (i) => {
      status.textContent = `Cadena #${t.id}: ${fmtNum(i)} de hasta ${fmtNum(t.max)} hashes…`;
    });
    if (steps) {
      status.className = 'status-line ok';
      status.textContent = `✅ Pertenece a la cadena #${t.id}: aplicando SHA-256 ${fmtNum(steps)} veces se llega al hash terminal publicado. Es la ronda ${fmtNum(steps)} de esa cadena.`;
      btn.disabled = false;
      return;
    }
  }
  status.className = 'status-line bad';
  status.textContent = '❌ No se llegó a ningún hash terminal publicado. Revisá que el hash esté bien copiado.';
  btn.disabled = false;
}

$('#dVerifyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  verifyDouble();
});

// ───────────────────────── 🎰 Ruleta ─────────────────────────

const rouletteNumber = (hash, salt) => core.rouletteNumberFromHmac(hmacSha256Hex(salt, hash));
const numberBadge = (n) => h('span', { class: `rnum ${core.rouletteColor(n)}`, title: ROULETTE_COLOR_NAMES[core.rouletteColor(n)] }, String(n));

function verifyRoulette() {
  const out = $('#rVerifyOut');
  const hash = $('#rHash').value.trim().toLowerCase();
  const salt = $('#rSalt').value.trim();
  const count = Math.min(500, Math.max(1, parseInt($('#rCount').value, 10) || 20));
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'El hash tiene que tener 64 caracteres hexadecimales (0-9, a-f).'));
    return;
  }
  if (!salt) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'Ingresá la sal (salt) de la cadena de la Ruleta.'));
    return;
  }
  const n = rouletteNumber(hash, salt);
  const color = core.rouletteColor(n);
  const rows = [];
  let current = hash;
  for (let i = 0; i < count; i++) {
    const t = rouletteNumber(current, salt);
    rows.push(h('tr', null, h('td', null, i === 0 ? 'Esta ronda' : `−${i}`), h('td', { class: 'mono' }, current), h('td', { class: 'num' }, numberBadge(t))));
    current = sha256Hex(current);
  }
  const chainStatus = h('div', { class: 'status-line', hidden: true });
  const walkBtn = h('button', { class: 'btn btn-ghost btn-block', type: 'button' }, '🔗 Comprobar que pertenece a la cadena publicada');
  walkBtn.addEventListener('click', () => walkChains(hash, rfair, walkBtn, chainStatus));
  const facts = [
    n === 0 ? 'cero' : n % 2 ? 'impar' : 'par',
    n === 0 ? null : n <= 18 ? '1 a 18' : '19 a 36',
    n === 0 ? null : `${Math.ceil(n / 12)}ª docena`,
    n === 0 ? null : `${((n - 1) % 3) + 1}ª columna`,
  ].filter(Boolean);
  out.replaceChildren(
    h(
      'div',
      null,
      h(
        'div',
        { class: 'result-hero' },
        h('small', null, 'Número ganador'),
        h('div', { class: `big rbig ${color}` }, String(n)),
        h('small', null, `${ROULETTE_COLOR_NAMES[color]} · ${facts.join(' · ')}`),
      ),
      h('p', { class: 'muted' }, 'Rondas anteriores (cada hash es el SHA-256 del de arriba). Compará con el historial del juego:'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table prev-table' }, h('thead', null, h('tr', null, h('th', null, 'Ronda'), h('th', null, 'Hash'), h('th', { class: 'num' }, 'Número'))), h('tbody', null, ...rows))),
      rfair ? walkBtn : null,
      chainStatus,
    ),
  );
}

$('#rVerifyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  verifyRoulette();
});

// ───────────────────────── 🎲 Juegos con semillas ─────────────────────────

const RISKS = { low: 'bajo', medium: 'medio', high: 'alto' };

function syncSeedOptions() {
  const g = $('#sGame').value;
  $('#sOptsMines').hidden = g !== 'mines';
  $('#sOptsPlinko').hidden = g !== 'plinko';
}
$('#sGame').addEventListener('change', syncSeedOptions);

/** Arma una jugada "de muestra" con el resultado recalculado, para dibujarla igual que en el juego. */
function sampleFor(game, params, r) {
  switch (game) {
    case 'mines':
      return { game, params, mines: r.mines, revealed: [], hit: null };
    case 'penalty':
      return { game, params, kicks: [], keepers: r.keepers };
    case 'plinko':
      return { game, params, path: r.path, bucket: r.bucket };
    default:
      return null;
  }
}

function describe(game, params, r, short = false) {
  switch (game) {
    case 'mines':
      return short
        ? `💣 en ${r.mines.map((m) => m + 1).join(', ')}`
        : `Minas en las casillas ${r.mines.map((m) => m + 1).join(', ')} (contando de 1 a 25, de izquierda a derecha y de arriba abajo)`;
    case 'penalty':
      return `El arquero se tira: ${r.keepers.map((k) => ['izquierda', 'centro', 'derecha'][k]).join(' · ')}`;
    case 'plinko':
      return `La bolita cae en la casilla ${r.bucket + 1} de ${params.rows + 1} → ${fmtMult(r.multiplier)} (riesgo ${RISKS[params.risk]})`;
    default:
      return '';
  }
}

function verifySeeds(expected) {
  const out = $('#sVerifyOut');
  const game = $('#sGame').value;
  const server = $('#sServer').value.trim();
  const client = $('#sClient').value.trim();
  const nonce = parseInt($('#sNonce').value, 10);
  if (!/^[0-9a-f]{64}$/i.test(server)) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'La semilla del servidor tiene 64 caracteres hexadecimales. Se revela cuando cambiás tus semillas en el juego.'));
    return;
  }
  if (!client) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'Ingresá tu semilla (cliente).'));
    return;
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    out.replaceChildren(h('div', { class: 'status-line bad' }, 'El nonce es un número entero desde 0.'));
    return;
  }
  const params = {};
  if (game === 'mines') {
    params.mines = parseInt($('#sMines').value, 10);
    if (!(params.mines >= 1 && params.mines <= 24)) {
      out.replaceChildren(h('div', { class: 'status-line bad' }, 'La cantidad de minas va de 1 a 24.'));
      return;
    }
  }
  if (game === 'plinko') {
    params.rows = parseInt($('#sRows').value, 10);
    params.risk = $('#sRisk').value;
  }
  const r = recompute(game, params, server, client, nonce);
  const g = GAME_BY_ID[game];
  const nodes = [
    h('div', { class: 'result-hero' }, h('small', null, `${g.icon} ${g.name} · nonce ${nonce}`), h('p', { class: 'seed-result' }, describe(game, params, r))),
    playVisual(sampleFor(game, params, r)),
    h('dl', { class: 'chain-grid' }, h('dt', null, 'SHA-256 de la semilla del servidor'), h('dd', null, h('div', { class: 'mono' }, sha256Hex(server)))),
  ];
  if (expected) {
    const ok = expected.hash === sha256Hex(server) && expected.check(r);
    nodes.push(
      h(
        'div',
        { class: `status-line ${ok ? 'ok' : 'bad'}` },
        ok ? `✅ Coincide con la jugada #${expected.id}: el hash de la semilla es el que se mostró antes de jugar y el resultado es el mismo.` : `❌ No coincide con la jugada #${expected.id}.`,
      ),
    );
  } else {
    nodes.push(h('p', { class: 'hint' }, 'Compará el SHA-256 de arriba con el hash que viste en el juego antes de jugar, y el resultado con tu jugada.'));
  }
  // Tabla rápida: el mismo juego para los nonces siguientes
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const rr = recompute(game, params, server, client, nonce + i);
    rows.push(h('tr', null, h('td', null, String(nonce + i)), h('td', null, describe(game, params, rr, true))));
  }
  nodes.push(
    h('p', { class: 'muted', style: { marginTop: '14px' } }, `Con este par de semillas, ${g.name} daría en los nonces siguientes:`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table prev-table' }, h('thead', null, h('tr', null, h('th', null, 'Nonce'), h('th', null, 'Resultado'))), h('tbody', null, ...rows))),
  );
  out.replaceChildren(h('div', null, ...nodes));
}

$('#sVerifyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  verifySeeds(null);
});

/** Abre el verificador con los datos de una jugada (enlace desde el juego: /fair?game=mines&play=123). */
async function loadPlay(id) {
  try {
    const { play: p, seed } = await api(`/api/plays/${id}`);
    $('#sGame').value = p.game;
    syncSeedOptions();
    $('#sClient').value = seed.clientSeed;
    $('#sNonce').value = String(p.nonce);
    if (p.game === 'mines') $('#sMines').value = String(p.params.mines);
    if (p.game === 'plinko') {
      $('#sRows').value = String(p.params.rows);
      $('#sRisk').value = p.params.risk;
    }
    if (!seed.revealed) {
      $('#sVerifyOut').replaceChildren(
        h(
          'div',
          { class: 'status-line' },
          `🔒 La semilla del servidor de la jugada #${p.id} todavía está en uso. Cuando el jugador cambie sus semillas se revela y la podés comprobar acá. Hash publicado: `,
          h('span', { class: 'mono' }, seed.serverHash),
        ),
      );
      return;
    }
    $('#sServer').value = seed.serverSeed;
    const same = {
      mines: (r) => JSON.stringify(r.mines) === JSON.stringify(p.mines),
      penalty: (r) => JSON.stringify(r.keepers) === JSON.stringify(p.keepers),
      plinko: (r) => JSON.stringify(r.path) === JSON.stringify(p.path),
    }[p.game];
    verifySeeds({ id: p.id, hash: seed.serverHash, check: same });
  } catch (err) {
    $('#sVerifyOut').replaceChildren(h('div', { class: 'status-line bad' }, err.message));
  }
}

// ───────────────────────── Inicio ─────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const game = params.get('game') || 'crash';
  const tab = ['crash', 'double', 'roulette'].includes(game) ? game : 'seeds';
  showTab(tab);
  try {
    fair = await api('/api/fair');
    renderChain(fair);
    $('#vSalt').value = fair.current.salt;
    $('#vEdge').value = String(fair.current.houseEdgeBps / 100);
  } catch (err) {
    $('#chainInfo').replaceChildren(h('div', { class: 'empty' }, err.message));
  }
  try {
    dfair = await api('/api/fair?game=double');
    renderLiveChain(dfair, 'd', 'Rojo 2x · Negro 2x · Blanco 30x · RTP 96,77%');
    $('#dSalt').value = dfair.current.salt;
  } catch (err) {
    $('#dChainInfo').replaceChildren(h('div', { class: 'empty' }, err.message));
  }
  try {
    rfair = await api('/api/fair?game=roulette');
    renderLiveChain(rfair, 'r', 'Pleno 36x · Docena y columna 3x · Rojo, negro, par, impar, 1-18 y 19-36 2x · RTP 97,30%');
    $('#rSalt').value = rfair.current.salt;
  } catch (err) {
    $('#rChainInfo').replaceChildren(h('div', { class: 'empty' }, err.message));
  }
  if (tab === 'crash') {
    if (params.get('salt')) $('#vSalt').value = params.get('salt');
    if (params.get('edge')) $('#vEdge').value = String(Number(params.get('edge')) / 100);
    if (params.get('hash')) {
      $('#vHash').value = params.get('hash');
      verify();
      $('#verifyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else if (tab === 'double') {
    if (params.get('salt')) $('#dSalt').value = params.get('salt');
    if (params.get('hash')) {
      $('#dHash').value = params.get('hash');
      verifyDouble();
      $('#dVerifyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else if (tab === 'roulette') {
    if (params.get('salt')) $('#rSalt').value = params.get('salt');
    if (params.get('hash')) {
      $('#rHash').value = params.get('hash');
      verifyRoulette();
      $('#rVerifyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else {
    if (['mines', 'penalty', 'plinko'].includes(game)) $('#sGame').value = game;
    syncSeedOptions();
    if (params.get('server')) $('#sServer').value = params.get('server');
    if (params.get('client')) $('#sClient').value = params.get('client');
    if (params.get('play')) await loadPlay(parseInt(params.get('play'), 10));
    else if (params.get('server') && params.get('client')) verifySeeds(null);
    if (params.get('play') || params.get('server')) $('#sVerifyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

init();
