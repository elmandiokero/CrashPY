// Ronda en vivo: modelo local del juego, animación del multiplicador, botón 💥, pausa y rondas recientes.
// Importante: el panel NUNCA conoce ni intenta deducir el punto de explosión de la ronda en curso.
// El multiplicador se calcula igual que en el juego (tiempo transcurrido) y se resincroniza con el servidor.
import { h, toast, confirmDialog, openModal, fmtGs, fmtNum, fmtMult, fmtTime, fmtDate, multClass, multiplierAt, msForMultiplier } from './shared.js';
import {
  bus,
  state,
  post,
  call,
  icon,
  scope,
  card,
  dataTable,
  pager,
  viewHead,
  userLink,
  betChip,
  emptyState,
  errorState,
  loadingState,
  syncList,
  setText,
  signedMoney,
  refreshBtn,
  notifyError,
  plural,
} from './admin-core.js';

// ───────────────────────── Modelo local de la ronda ─────────────────────────

export const game = {
  phase: null,
  paused: false,
  roundId: null,
  growth: 0.00006,
  startAt: 0, // performance.now() estimado del despegue
  bettingEnd: 0, // performance.now() estimado del cierre de apuestas
  bettingMs: 7000,
  last: null, // datos de la última explosión { roundId, crash, cancelled, mode }
  nextAt: 0, // performance.now() estimado de la próxima ronda (0 = desconocido)
  bets: new Map(),
  refunded: new Map(),
};

const frameSubs = new Set();
export const onFrame = (fn) => {
  frameSubs.add(fn);
  return () => frameSubs.delete(fn);
};

function loop(now) {
  if (!document.hidden) {
    for (const fn of frameSubs) {
      try {
        fn(now);
      } catch (err) {
        console.error(err);
      }
    }
  }
  requestAnimationFrame(loop);
}

const emitState = () => bus.emit('game:state', game);
const emitBets = () => bus.emit('game:bets', game);

function applyState(g, fromAdmin) {
  if (!g) return;
  const now = performance.now();
  const roundChanged = g.roundId !== game.roundId;
  const phaseChanged = g.phase !== game.phase;
  const pausedChanged = !!g.paused !== game.paused;
  game.paused = !!g.paused;
  game.roundId = g.roundId;
  if (g.growth) game.growth = g.growth;
  if (g.bettingMs) game.bettingMs = g.bettingMs;
  if (g.phase === 'RUNNING' && Number.isFinite(g.elapsed)) {
    const start = now - g.elapsed;
    if (roundChanged || phaseChanged || start < game.startAt) game.startAt = start;
  } else if (g.phase === 'BETTING' && Number.isFinite(g.bettingLeft)) {
    const end = now + g.bettingLeft;
    if (roundChanged || phaseChanged || end < game.bettingEnd) game.bettingEnd = end;
  } else if (g.phase === 'CRASHED' && g.last) {
    if (phaseChanged || roundChanged || !game.last) game.last = g.last;
    // El estado público trae el tiempo que falta para la próxima ronda; el del admin no, así que no se inventa.
    if (!fromAdmin && Number.isFinite(g.last.nextIn)) game.nextAt = now + g.last.nextIn;
    else if (phaseChanged || roundChanged) game.nextAt = 0;
  }
  if (g.phase !== 'CRASHED' && phaseChanged) game.last = null;
  game.phase = g.phase;
  if (roundChanged) game.refunded.clear();
  if (Array.isArray(g.bets)) {
    const next = new Map();
    for (const b of g.bets) {
      // El estado público incluye las apuestas devueltas; las guardamos aparte como hace el servidor.
      if (b.status === 'refunded') game.refunded.set(b.id, { ...game.bets.get(b.id), ...b });
      else next.set(b.id, fromAdmin ? b : { ...game.bets.get(b.id), ...b });
    }
    for (const id of game.refunded.keys()) next.delete(id);
    game.bets = next;
  }
  if (roundChanged || phaseChanged || pausedChanged) emitState();
  emitBets();
}

export function initGame(sock) {
  sock.on('init', (snap) => {
    if (snap && snap.game) applyState(snap.game, false);
  });
  sock.on('betting', (d) => {
    game.phase = 'BETTING';
    game.roundId = d.roundId;
    if (d.growth) game.growth = d.growth;
    game.bettingMs = d.ms || game.bettingMs;
    game.bettingEnd = performance.now() + (d.ms || 0);
    game.last = null;
    game.bets.clear();
    game.refunded.clear();
    emitState();
    emitBets();
  });
  sock.on('start', (d) => {
    game.phase = 'RUNNING';
    game.roundId = d.roundId;
    if (d.growth) game.growth = d.growth;
    game.startAt = performance.now();
    game.last = null;
    emitState();
  });
  sock.on('tick', (d) => {
    if (game.phase !== 'RUNNING' || !d || !Number.isFinite(d.e)) return;
    // Nos quedamos con la estimación de menor latencia (el despegue más temprano posible).
    const start = performance.now() - d.e;
    if (start < game.startAt) game.startAt = start;
  });
  sock.on('crash', (d) => {
    game.phase = 'CRASHED';
    game.roundId = d.roundId;
    game.last = d;
    game.nextAt = performance.now() + (d.nextIn || 0);
    if (!d.cancelled) for (const b of game.bets.values()) if (b.status === 'active') b.status = 'lost';
    emitState();
    emitBets();
  });
  sock.on('bet', (b) => {
    game.bets.set(b.id, { ...game.bets.get(b.id), ...b });
    emitBets();
  });
  sock.on('cashout', (c) => {
    const b = game.bets.get(c.id);
    if (b) Object.assign(b, { status: 'won', cashout: c.cashout, payout: c.payout });
    else game.bets.set(c.id, { id: c.id, uid: c.uid, user: c.user, slot: c.slot, amount: c.amount, status: 'won', cashout: c.cashout, payout: c.payout });
    emitBets();
  });
  sock.on('betCancel', (c) => {
    game.bets.delete(c.id);
    emitBets();
  });
  sock.on('betRefund', (c) => {
    const b = game.bets.get(c.id);
    if (b) {
      b.status = 'refunded';
      game.refunded.set(b.id, b);
      game.bets.delete(b.id);
    }
    emitBets();
  });
  sock.on('paused', (p) => {
    game.paused = !!p.paused;
    if (p.phase) game.phase = p.phase;
    emitState();
  });
  bus.on('stats', (s) => applyState(s.game, true));
  requestAnimationFrame(loop);
}

/** Totales de la ronda calculados con las apuestas conocidas (mismo criterio que el servidor). */
export function totals() {
  let bet = 0;
  let payout = 0;
  let active = 0;
  let activeCount = 0;
  const players = new Set();
  for (const b of game.bets.values()) {
    if (b.status === 'cancelled' || b.status === 'refunded') continue;
    bet += b.amount;
    payout += b.payout || 0;
    if (b.status === 'active') {
      active += b.amount;
      activeCount++;
    }
    players.add(b.uid);
  }
  let refunded = 0;
  for (const b of game.refunded.values()) refunded += b.amount;
  return { bet, payout, active, activeCount, players: players.size, count: game.bets.size, refunded };
}

const secs = (ms) => (Math.max(0, ms) / 1000).toFixed(1).replace('.', ',') + ' s';

/** Qué mostrar en el marcador según la fase. */
export function readout(now = performance.now()) {
  switch (game.phase) {
    case 'RUNNING': {
      const m = multiplierAt(now - game.startAt, game.growth);
      return { cls: 'running', kicker: 'En vuelo', big: fmtMult(m), sub: '', chip: ['En vuelo', 'chip-green chip-live'] };
    }
    case 'BETTING': {
      const left = game.bettingEnd - now;
      return {
        cls: 'betting',
        kicker: 'Despega en',
        big: secs(left),
        sub: 'Apuestas abiertas',
        chip: ['Apuestas abiertas', 'chip-blue'],
        progress: game.bettingMs ? Math.max(0, Math.min(1, left / game.bettingMs)) : 0,
      };
    }
    case 'CRASHED': {
      const l = game.last;
      const next = game.nextAt ? game.nextAt - now : null;
      const nextText = game.paused ? 'El juego se pausa ahora' : next !== null && next > 0 ? `Próxima ronda en ${secs(next)}` : 'Preparando la próxima ronda…';
      if (l && l.cancelled) {
        const how =
          l.mode === 'pay' ? `Se pagó a todos a ${fmtMult(l.crash)}` : l.mode === 'refund' ? 'Se devolvieron las apuestas' : 'Anulada por el servidor · apuestas devueltas';
        return { cls: 'cancelled', kicker: 'Ronda anulada', big: fmtMult(l.crash), sub: `${how} · ${nextText}`, chip: ['Anulada', 'chip-gold'] };
      }
      return { cls: 'crashed', kicker: 'Explotó en', big: l ? fmtMult(l.crash) : '💥', sub: nextText, chip: ['Explotó', 'chip-red'] };
    }
    case 'PAUSED':
      return { cls: 'paused', kicker: 'Juego pausado', big: 'Pausa', sub: 'Nadie puede apostar hasta que reanudes', chip: ['Pausado', 'chip-gold'] };
    default:
      return { cls: 'idle', kicker: 'Conectando…', big: '—', sub: '', chip: ['Conectando', ''] };
  }
}

// ───────────────────────── 💥 Explotar ahora ─────────────────────────

export function openStopModal() {
  if (game.phase !== 'RUNNING') {
    toast('Solo se puede explotar una ronda que está en vuelo', 'error');
    return;
  }
  const roundId = game.roundId;
  const multEl = h('div', { class: 'stop-mult' }, '—');
  const liveInfo = h('div', { class: 'stop-live' });
  const status = h('div', { class: 'form-error', role: 'alert' });
  const refundSub = h('span', null, 'La ronda se anula y cada jugador recupera lo que apostó.');
  const paySub = h('span', null, 'Cada apuesta que sigue en juego cobra al multiplicador del momento.');
  const optRefund = h(
    'button',
    { type: 'button', class: 'stop-opt stop-opt-refund' },
    h('span', { class: 'stop-opt-ic' }, '↩️'),
    h('span', { class: 'stop-opt-text' }, h('strong', null, 'Devolver apuestas'), refundSub),
  );
  const optPay = h(
    'button',
    { type: 'button', class: 'stop-opt stop-opt-pay' },
    h('span', { class: 'stop-opt-ic' }, '💸'),
    h('span', { class: 'stop-opt-text' }, h('strong', null, 'Pagar a todos al multiplicador actual'), paySub),
  );
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Cancelar');
  let off = () => {};
  const m = openModal({
    title: `💥 Explotar la ronda #${roundId}`,
    content: h(
      'div',
      { class: 'stop' },
      h('div', { class: 'stop-now' }, h('span', { class: 'stop-now-label' }, 'Multiplicador actual'), multEl, liveInfo),
      h('p', { class: 'stop-q' }, 'Elegí qué pasa con las apuestas que siguen en juego:'),
      h('div', { class: 'stop-opts' }, optRefund, optPay),
      h(
        'p',
        { class: 'stop-note' },
        'La ronda queda marcada como «anulada» en el historial público y su hash se revela igual, así cualquiera la puede verificar. Nadie pierde plata por una parada manual.',
      ),
      status,
      cancel,
    ),
    onClose: () => off(),
  });
  let busy = false;
  let lastText = '';
  off = onFrame((now) => {
    const running = game.phase === 'RUNNING' && game.roundId === roundId;
    if (running) {
      const mult = multiplierAt(now - game.startAt, game.growth);
      setText(multEl, fmtMult(mult));
      const t = totals();
      const text = t.activeCount
        ? `${plural(t.activeCount, 'apuesta', 'apuestas')} en juego · ${fmtGs(t.active)}`
        : 'No quedan apuestas en juego';
      if (text !== lastText) {
        lastText = text;
        liveInfo.textContent = text;
      }
      setText(paySub, t.activeCount ? `Cada apuesta en juego cobra a ${fmtMult(mult)} · ≈ ${fmtGs(Math.floor((t.active * mult) / 100))} en total.` : 'Cada apuesta que sigue en juego cobra al multiplicador del momento.');
      setText(refundSub, t.activeCount ? `La ronda se anula y se devuelven ${fmtGs(t.active)} a los jugadores.` : 'La ronda se anula y cada jugador recupera lo que apostó.');
    } else if (!busy) {
      optRefund.disabled = true;
      optPay.disabled = true;
      multEl.classList.add('is-over');
      setText(status, 'La ronda ya terminó, no hace falta explotarla.');
    }
  });
  cancel.addEventListener('click', () => m.close());
  const run = async (mode) => {
    if (busy) return;
    busy = true;
    optRefund.disabled = true;
    optPay.disabled = true;
    (mode === 'pay' ? optPay : optRefund).classList.add('is-busy');
    try {
      const r = await post('/api/admin/game/stop', { mode });
      m.close();
      const n = r.affected || 0;
      const what = mode === 'pay' ? (n === 1 ? 'apuesta pagada' : 'apuestas pagadas') : n === 1 ? 'apuesta devuelta' : 'apuestas devueltas';
      toast(`Ronda #${roundId} anulada en ${fmtMult(r.multiplier)} · ${fmtNum(n)} ${what}`, 'success', '💥 Ronda explotada');
    } catch (err) {
      busy = false;
      status.textContent = err.message;
      notifyError(err);
      (mode === 'pay' ? optPay : optRefund).classList.remove('is-busy');
      optRefund.disabled = optPay.disabled = game.phase !== 'RUNNING';
    }
  };
  optRefund.addEventListener('click', () => run('refund'));
  optPay.addEventListener('click', () => run('pay'));
}

/** Botón grande 💥 (habilitado solo con la ronda en vuelo). */
export function stopButton({ compact = false } = {}) {
  const hint = h('span', { class: 'stop-btn-hint' });
  const btn = h(
    'button',
    { type: 'button', class: `btn btn-danger stop-btn${compact ? ' stop-btn-compact' : ''}` },
    h('span', { class: 'stop-btn-main' }, '💥 EXPLOTAR AHORA'),
    compact ? null : hint,
  );
  btn.addEventListener('click', openStopModal);
  const update = () => {
    const on = game.phase === 'RUNNING';
    btn.disabled = !on;
    btn.classList.toggle('is-armed', on);
    hint.textContent = on ? 'Corta la ronda en vuelo sin que nadie pierda plata' : 'Disponible cuando el cohete está en vuelo';
  };
  update();
  const off = bus.on('game:state', update);
  return { el: btn, dispose: off };
}

// ───────────────────────── Pausa ─────────────────────────

export function pauseState() {
  if (!game.paused) return 'running';
  return game.phase === 'PAUSED' ? 'paused' : 'pausing';
}

export async function togglePause() {
  try {
    if (!game.paused) {
      const msg =
        game.phase === 'BETTING'
          ? 'Se devuelven las apuestas de esta ronda y nadie va a poder apostar hasta que reanudes.'
          : game.phase === 'RUNNING'
            ? 'La ronda en vuelo termina normalmente y después el juego queda en pausa.'
            : 'El juego queda en pausa y nadie va a poder apostar hasta que reanudes.';
      const ok = await confirmDialog(msg, { title: '⏸ Pausar el juego', okText: 'Pausar', danger: true });
      if (!ok) return;
      const r = await post('/api/admin/game/pause');
      toast(r.phase === 'PAUSED' ? 'Juego pausado' : 'El juego se pausará al terminar esta ronda', 'info', '⏸ Pausa');
    } else {
      const wasStopped = game.phase === 'PAUSED';
      await post('/api/admin/game/resume');
      toast(wasStopped ? 'El juego vuelve a arrancar' : 'Se canceló la pausa', 'success', '▶ Reanudado');
    }
  } catch (err) {
    notifyError(err);
  }
}

export function pauseButton() {
  const btn = h('button', { type: 'button', class: 'btn' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await togglePause();
    btn.disabled = false;
  });
  const update = () => {
    const s = pauseState();
    if (s === 'running') {
      btn.className = 'btn btn-ghost pause-btn pause-idle';
      btn.replaceChildren(icon('pause', 17), 'Pausar juego');
    } else if (s === 'paused') {
      btn.className = 'btn btn-primary pause-btn';
      btn.replaceChildren(icon('play', 17), 'Reanudar juego');
    } else {
      btn.className = 'btn btn-primary pause-btn';
      btn.replaceChildren(icon('play', 17), 'Cancelar pausa');
    }
  };
  update();
  const off = bus.on('game:state', update);
  return { el: btn, dispose: off };
}

// ───────────────────────── Marcador (grande y mini) ─────────────────────────

function guideSteps(mMax) {
  const cands = [1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000];
  const inRange = cands.filter((v) => v < mMax * 0.97);
  const step = Math.max(1, Math.ceil(inRange.length / 4));
  return inRange.filter((_, i) => (inRange.length - 1 - i) % step === 0);
}

function drawCurve(canvas, now) {
  const w = canvas.clientWidth;
  const hh = canvas.clientHeight;
  if (!w || !hh) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(w * dpr);
  const H = Math.round(hh * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);

  let elapsed = null;
  let tone = 'run';
  if (game.phase === 'RUNNING') elapsed = Math.max(0, now - game.startAt);
  else if (game.phase === 'CRASHED' && game.last && game.last.crash > 100) {
    // Ronda terminada: el punto ya es público, se congela la curva donde terminó.
    elapsed = msForMultiplier(game.last.crash, game.growth);
    tone = game.last.cancelled ? 'cancel' : 'crash';
  }
  const g = game.growth || 0.00006;
  const padL = 10;
  const padR = 22;
  const padT = 26;
  const padB = 14;
  const plotW = w - padL - padR;
  const plotH = hh - padT - padB;
  const tMax = Math.max(elapsed ?? 0, 12000) * 1.06;
  const mNow = elapsed !== null ? Math.exp(g * elapsed) : 1;
  const mMax = Math.max(mNow * 1.18, 2);
  const X = (t) => padL + (t / tMax) * plotW;
  const Y = (mm) => padT + plotH - ((mm - 1) / (mMax - 1)) * plotH;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(141,149,189,0.6)';
  ctx.font = '600 11px Rubik, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (const gm of elapsed === null ? [] : guideSteps(mMax)) {
    const y = Math.round(Y(gm)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - 6, y);
    ctx.stroke();
    ctx.fillText(`${gm}x`, w - 8, y - 3);
  }
  const base = Math.round(padT + plotH) + 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(padL, base);
  ctx.lineTo(w - 6, base);
  ctx.stroke();
  if (elapsed === null) return;

  const rgb = tone === 'run' ? '43,217,107' : tone === 'crash' ? '255,59,78' : '255,197,61';
  const N = 90;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (elapsed * i) / N;
    pts.push([X(t), Y(Math.exp(g * t))]);
  }
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, `rgba(${rgb},0.30)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], padT + plotH);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[N][0], padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = `rgb(${rgb})`;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = `rgba(${rgb},0.65)`;
  ctx.shadowBlur = 14;
  ctx.stroke();
  ctx.shadowBlur = 0;
  const [tx, ty] = pts[N];
  ctx.beginPath();
  ctx.arc(tx, ty, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.font = '22px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tone === 'run' ? '🚀' : tone === 'crash' ? '💥' : '🛑', Math.min(tx, w - 14), Math.max(14, ty - 16));
}

/** Marcador de la ronda. mini = versión compacta para el inicio. */
export function roundHero({ mini = false } = {}) {
  const chip = h('span', { class: 'chip' });
  const round = h('span', { class: 'hero-round' });
  const pausedChip = h('span', { class: 'chip chip-gold', hidden: true }, '⏸ Pausa pedida');
  const kicker = h('div', { class: 'hero-kicker' });
  const big = h('div', { class: 'hero-mult' });
  const sub = h('div', { class: 'hero-sub' });
  const bar = h('div', { class: 'hero-progress-bar' });
  const progress = h('div', { class: 'hero-progress', hidden: true }, bar);
  const canvas = mini ? null : h('canvas', { class: 'hero-canvas', 'aria-hidden': 'true' });
  const el = h(
    'div',
    { class: `hero${mini ? ' hero-mini' : ''}` },
    canvas,
    h('div', { class: 'hero-top' }, chip, round, pausedChip),
    h('div', { class: 'hero-center' }, kicker, big, sub),
    progress,
  );
  let lastCls = '';
  let lastChip = '';
  const offFrame = onFrame((now) => {
    const r = readout(now);
    if (r.cls !== lastCls) {
      el.classList.remove(`is-${lastCls}`);
      el.classList.add(`is-${r.cls}`);
      lastCls = r.cls;
    }
    const chipKey = r.chip.join('|');
    if (chipKey !== lastChip) {
      lastChip = chipKey;
      chip.className = `chip ${r.chip[1]}`;
      chip.textContent = r.chip[0];
    }
    setText(round, game.roundId ? `Ronda #${game.roundId}` : '');
    pausedChip.hidden = !(game.paused && game.phase !== 'PAUSED');
    setText(kicker, r.kicker);
    setText(big, r.big);
    setText(sub, r.sub);
    progress.hidden = r.cls !== 'betting';
    if (r.cls === 'betting') bar.style.transform = `scaleX(${r.progress.toFixed(4)})`;
    if (canvas) drawCurve(canvas, now);
  });
  return { el, dispose: offFrame };
}

/** Pastilla chica para la barra superior (visible en todas las secciones). */
export function livePill() {
  const dot = h('span', { class: 'lp-dot' });
  const text = h('span', { class: 'lp-text' });
  const el = h('a', { class: 'live-pill', href: '#/en-vivo', title: 'Ver la ronda en vivo' }, dot, text);
  let lastCls = '';
  const off = onFrame((now) => {
    const r = readout(now);
    let t;
    if (r.cls === 'running') t = r.big;
    else if (r.cls === 'betting') t = `Apuestas · ${Math.ceil(Math.max(0, game.bettingEnd - now) / 1000)} s`;
    else if (r.cls === 'crashed') t = `💥 ${r.big}`;
    else if (r.cls === 'cancelled') t = `Anulada ${r.big}`;
    else if (r.cls === 'paused') t = 'Pausado';
    else t = '…';
    setText(text, t);
    if (r.cls !== lastCls) {
      el.className = `live-pill lp-${r.cls}`;
      lastCls = r.cls;
    }
  });
  return { el, dispose: off };
}

// ───────────────────────── Tabla de apuestas en vivo ─────────────────────────

function betRow(b) {
  const c = {
    user: h('td', { class: 'rt-main' }, userLink(b.uid, b.user)),
    amount: h('td', { class: 'num', 'data-label': 'Monto' }),
    auto: h('td', { class: 'num', 'data-label': 'Retiro auto' }),
    cap: h('td', { class: 'num hide-sm', 'data-label': 'Tope' }),
    status: h('td', { 'data-label': 'Estado' }),
    cashout: h('td', { class: 'num', 'data-label': 'Retiró en' }),
    payout: h('td', { class: 'num', 'data-label': 'Pago' }),
  };
  const tr = h('tr', null, Object.values(c));
  tr._c = c;
  return tr;
}

/**
 * Tope de ganancia: los topes altísimos se muestran sin decimales ("1001x").
 * Sin separador de miles a propósito: "1.001x" se confundiría con 1,001x.
 */
const fmtCap = (c) => (c >= 100000 ? `${Math.floor(c / 100)}x` : fmtMult(c));

function updateBetRow(tr, b) {
  const c = tr._c;
  setText(c.amount, fmtGs(b.amount));
  setText(c.auto, b.auto ? fmtMult(b.auto) : '—');
  setText(c.cap, b.cap ? fmtCap(b.cap) : '—');
  if (tr._status !== b.status) {
    tr._status = b.status;
    c.status.replaceChildren(betChip(b.status));
    tr.className = `bet-row bet-${b.status}`;
  }
  setText(c.cashout, b.cashout ? fmtMult(b.cashout) : '—');
  c.cashout.className = `num ${b.cashout ? multClass(b.cashout) : 'faint is-empty'}`;
  setText(c.payout, b.payout ? fmtGs(b.payout) : '—');
  c.payout.className = `num ${b.payout ? 'green' : 'faint is-empty'}`;
  c.auto.classList.toggle('is-empty', !b.auto);
}

function sortedBets() {
  const list = [...game.bets.values(), ...game.refunded.values()];
  const rank = { active: 0, won: 1, lost: 2, refunded: 3 };
  return list.sort((a, b) => b.amount - a.amount || (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id - b.id);
}

export function betsTable() {
  const tbody = h('tbody');
  const table = h(
    'div',
    { class: 'table-wrap rt-wrap' },
    h(
      'table',
      { class: 'table rt rt-3 bets-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Jugador'),
          h('th', { class: 'num' }, 'Monto'),
          h('th', { class: 'num' }, 'Retiro auto'),
          h('th', { class: 'num hide-sm' }, 'Tope'),
          h('th', null, 'Estado'),
          h('th', { class: 'num' }, 'Retiró en'),
          h('th', { class: 'num' }, 'Pago'),
        ),
      ),
      tbody,
    ),
  );
  const empty = emptyState('Todavía no hay apuestas en esta ronda', '🎯');
  const el = h('div', { class: 'bets-box' }, table, empty);
  const count = h('span', { class: 'acard-sub' });
  const render = () => {
    const list = sortedBets();
    table.hidden = !list.length;
    empty.hidden = !!list.length;
    count.textContent = list.length ? plural(list.length, 'apuesta', 'apuestas') : '';
    syncList(tbody, list, (b) => b.id, betRow, updateBetRow);
  };
  render();
  const off = bus.on('game:bets', render);
  return { el, count, dispose: off };
}

// ───────────────────────── Totales ─────────────────────────

function totalsStrip() {
  const cells = {
    bet: h('div', { class: 'mini-stat-value' }),
    payout: h('div', { class: 'mini-stat-value' }),
    active: h('div', { class: 'mini-stat-value' }),
    players: h('div', { class: 'mini-stat-value' }),
  };
  const box = (label, value, cls = '') => h('div', { class: `mini-stat ${cls}` }, h('div', { class: 'mini-stat-label' }, label), value);
  const el = h(
    'div',
    { class: 'mini-stats' },
    box('Apostado', cells.bet),
    box('Pagado', cells.payout),
    box('En juego', cells.active, 'is-live'),
    box('Jugadores', cells.players),
  );
  const render = () => {
    const t = totals();
    setText(cells.bet, fmtGs(t.bet));
    setText(cells.payout, fmtGs(t.payout));
    setText(cells.active, fmtGs(t.active));
    setText(cells.players, fmtNum(t.players));
  };
  render();
  const off = bus.on('game:bets', render);
  return { el, dispose: off };
}

export { totalsStrip };

// ───────────────────────── Rondas recientes ─────────────────────────

function crashCell(r) {
  if (r.status === 'cancelled') {
    const how = r.cancel_mode === 'pay' ? 'pagada a' : r.cancel_mode === 'refund' ? 'devuelta a' : 'servidor ·';
    return h('span', { class: 'round-cancel' }, h('span', { class: 'chip chip-gold' }, 'Anulada'), h('span', { class: 'muted' }, ` ${how} `), h('b', null, fmtMult(r.ended_multiplier)));
  }
  return h('b', { class: `mult ${multClass(r.crash_point)}` }, fmtMult(r.crash_point));
}

const ROUND_COLS = [
  { label: 'Ronda', main: true, render: (r) => h('span', { class: 'round-id' }, `#${r.id}`) },
  { label: 'Explotó en', render: crashCell },
  { label: 'Jugadores', cls: 'num', render: (r) => fmtNum(r.players) },
  { label: 'Apostado', cls: 'num', render: (r) => fmtGs(r.total_bet) },
  { label: 'Pagado', cls: 'num', hideSm: true, render: (r) => fmtGs(r.total_payout) },
  { label: 'Devuelto', cls: 'num', hideSm: true, render: (r) => (r.total_refund ? fmtGs(r.total_refund) : null) },
  { label: 'Ganancia casa', cls: 'num', render: (r) => signedMoney(r.total_bet - r.total_payout) },
  { label: 'Hora', cls: 'num', render: (r) => h('span', { title: fmtDate(r.ended_at) }, fmtTime(r.ended_at)) },
];

// ───────────────────────── Vista "Ronda en vivo" ─────────────────────────

let roundsPage = 1;

export const liveView = {
  sc: null,
  mount(el) {
    const sc = scope();
    this.sc = sc;
    const hero = roundHero();
    const stop = stopButton();
    const pause = pauseButton();
    const tot = totalsStrip();
    const bets = betsTable();
    const pauseNote = h('div', { class: 'pause-note' });
    [hero, stop, pause, tot, bets].forEach((c) => sc.add(c.dispose));

    const roundsBody = h('div', null, loadingState());
    const loadRounds = async () => {
      try {
        const res = await call(`/api/admin/rounds?page=${roundsPage}`);
        roundsBody.replaceChildren(
          dataTable(ROUND_COLS, res.items, {
            empty: 'Todavía no terminó ninguna ronda',
            emptyEmoji: '🚀',
            rowClass: (r) => (r.status === 'cancelled' ? 'row-cancelled' : ''),
            compact: true,
            inlineMain: true,
            mobileLimit: 12,
          }),
          pager(res, 'rondas', (p) => {
            roundsPage = p;
            loadRounds();
          }),
        );
      } catch (err) {
        roundsBody.replaceChildren(errorState(err, loadRounds));
      }
    };
    let roundsTimer = null;
    sc.on('roundEnd', () => {
      if (roundsPage !== 1) return;
      clearTimeout(roundsTimer);
      roundsTimer = setTimeout(loadRounds, 600);
    });
    sc.add(() => clearTimeout(roundsTimer));

    const updatePauseNote = () => {
      const s = pauseState();
      pauseNote.className = `pause-note pn-${s}`;
      pauseNote.textContent = s === 'paused' ? '⏸️ Pausado' : s === 'pausing' ? '⏳ Se pausa al terminar' : '🟢 Juego activo';
    };
    updatePauseNote();
    sc.on('game:state', updatePauseNote);

    const controls = h(
      'section',
      { class: 'acard live-controls' },
      h('div', { class: 'acard-head' }, h('h2', { class: 'acard-title' }, icon('zap', 18), h('span', null, 'Controles')), pauseNote),
      stop.el,
      pause.el,
      tot.el,
    );
    el.append(
      viewHead('Ronda en vivo', 'Seguí cada ronda en tiempo real y controlá el juego.'),
      h('div', { class: 'live-top' }, h('section', { class: 'acard hero-card' }, hero.el), controls),
      card('Apuestas de la ronda', { cls: 'live-bets', icon: 'users', actions: bets.count }, bets.el),
      card('Rondas recientes', { icon: 'clock', actions: refreshBtn(loadRounds) }, roundsBody),
    );
    loadRounds();
  },
  unmount() {
    this.sc?.dispose();
    this.sc = null;
  },
};
