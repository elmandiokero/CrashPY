import { $, h, api, fmtMult, fmtNum, fmtDate, multClass, sha256Hex, crashFromHash, copyText } from './shared.js';

let fair = null;

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

async function init() {
  const params = new URLSearchParams(location.search);
  try {
    fair = await api('/api/fair');
    renderChain(fair);
    $('#vSalt').value = fair.current.salt;
    $('#vEdge').value = String(fair.current.houseEdgeBps / 100);
  } catch (err) {
    $('#chainInfo').replaceChildren(h('div', { class: 'empty' }, err.message));
  }
  if (params.get('salt')) $('#vSalt').value = params.get('salt');
  if (params.get('edge')) $('#vEdge').value = String(Number(params.get('edge')) / 100);
  if (params.get('hash')) {
    $('#vHash').value = params.get('hash');
    verify();
    $('#verifyForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

init();
