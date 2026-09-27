// 🚀 Crash: el cohete sube y hay que retirar antes de que explote.
import { $, h, api, fmtGs, fmtNum, fmtMult, fmtSigned, parseAmount, parseMult, fmtDate, fmtTime, multClass, multiplierAt, msForMultiplier, toast, openModal, copyText, sha256Hex, crashFromHash } from '../shared.js';
import { CrashGraph } from '../graph.js';
import { store, vibrate, setText, setClass, avatar, compact, stepFor } from './common.js';

export function createCrash(shell) {
  const { socket, sound } = shell;
  const S = () => shell.state.settings;

  const cs = {
    phase: 'CONNECTING',
    paused: false,
    roundId: null,
    growth: 0.00006,
    startLocal: 0,
    bettingEndsLocal: 0,
    bettingMs: 7000,
    nextLocal: 0,
    crash: null,
    crashElapsed: 0,
    launchUntil: 0,
    bets: new Map(),
    betsDirty: true,
    history: [],
  };

  const view = $('.game-view[data-view="crash"]');
  const els = {
    historyList: $('#historyList'),
    stage: $('#stage'),
    stageStatus: $('#stageStatus'),
    stageMult: $('#stageMult'),
    stageSub: $('#stageSub'),
    countdown: $('#countdown'),
    countdownBar: $('#countdownBar'),
    roundLabel: $('#roundLabel'),
    roundPlayers: $('#roundPlayers'),
    roundTotal: $('#roundTotal'),
    stageFlash: $('#stageFlash'),
    winLayer: $('#winLayer'),
    betPanels: $('#betPanels'),
    addPanel: $('#btnAddPanel'),
    betsCount: $('#betsCount'),
    betsPlayers: $('#betsPlayers'),
    betsTotal: $('#betsTotal'),
    betsList: $('#betsList'),
  };

  const graph = new CrashGraph($('#graph'));
  const active = () => shell.current === 'crash' && !document.hidden;

  // ═══════════════ Paneles de apuesta ═══════════════

  class BetPanel {
    constructor(slot) {
      this.slot = slot;
      const node = $('#tplBetPanel').content.firstElementChild.cloneNode(true);
      node.dataset.slot = String(slot);
      this.el = node;
      this.input = $('.amount-input', node);
      this.btn = $('.bp-action', node);
      this.title = $('.bp-action-title', node);
      this.sub = $('.bp-action-sub', node);
      this.quick = $('.quick-row', node);
      this.autoBetEl = $('.auto-bet', node);
      this.autoCashOnEl = $('.auto-cash-on', node);
      this.autoCashInput = $('.auto-cash-input', node);
      this.autoCashField = $('.auto-cash-field', node);
      this.noteEl = $('.bp-note', node);

      const saved = store.get(`cpy_panel${slot}`, {});
      this.amount = saved.amount || (slot === 0 ? 5000 : 10000);
      this.autoCashOn = !!saved.autoCashOn;
      this.autoCash = saved.autoCash || 200;
      this.autoBet = false;
      this.status = 'idle';
      this.bet = null;
      this.celebrated = null;
      this.noteTimer = null;

      this.input.value = fmtNum(this.amount);
      this.autoCashOnEl.checked = this.autoCashOn;
      this.autoCashInput.value = (this.autoCash / 100).toFixed(2);
      this.autoCashField.classList.toggle('off', !this.autoCashOn);

      this.input.addEventListener('input', () => {
        const v = parseAmount(this.input.value);
        this.input.value = Number.isFinite(v) ? fmtNum(v) : '';
        if (Number.isFinite(v)) this.amount = v;
        this.render();
      });
      this.input.addEventListener('blur', () => this.setAmount(this.amount));
      $('[data-act="minus"]', node).addEventListener('click', () => this.setAmount(this.amount - stepFor(this.amount - 1)));
      $('[data-act="plus"]', node).addEventListener('click', () => this.setAmount(this.amount + stepFor(this.amount)));
      this.btn.addEventListener('click', () => this.onAction());
      this.autoCashOnEl.addEventListener('change', () => {
        this.autoCashOn = this.autoCashOnEl.checked;
        this.autoCashField.classList.toggle('off', !this.autoCashOn);
        this.save();
      });
      this.autoCashInput.addEventListener('blur', () => {
        let v = parseMult(this.autoCashInput.value);
        if (!Number.isFinite(v) || v < 101) v = 101;
        v = Math.min(v, 100000000);
        this.autoCash = v;
        this.autoCashInput.value = (v / 100).toFixed(2);
        this.save();
      });
      this.autoCashInput.addEventListener('focus', () => {
        if (!this.autoCashOn) {
          this.autoCashOn = true;
          this.autoCashOnEl.checked = true;
          this.autoCashField.classList.remove('off');
        }
      });
      this.autoBetEl.addEventListener('change', () => {
        if (!shell.state.user) {
          this.autoBetEl.checked = false;
          shell.openAuth('login');
          return;
        }
        this.autoBet = this.autoBetEl.checked;
        if (this.autoBet) {
          toast(`Auto apuesta activada: ${fmtGs(this.amount)} en cada ronda`, 'info');
          if (this.status === 'idle') this.onAction();
        }
        updateBadge();
      });
      node.querySelector('.bp-remove').addEventListener('click', () => setSecondPanel(false));
      this.buildQuick();
      this.render();
    }

    buildQuick() {
      const list = String(S().quick_amounts || '')
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((v) => v > 0)
        .slice(0, 4);
      this.quick.replaceChildren(...list.map((v) => h('button', { type: 'button', onclick: () => this.setAmount(v), title: fmtGs(v) }, compact(v))));
      this.quick.style.gridTemplateColumns = `repeat(${Math.max(1, list.length)}, minmax(0, 1fr))`;
    }

    setAmount(v) {
      const { min_bet: min, max_bet: max } = S();
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, Math.round(v)));
      this.amount = v;
      this.input.value = fmtNum(v);
      this.save();
      this.render();
    }

    save() {
      store.set(`cpy_panel${this.slot}`, { amount: this.amount, autoCashOn: this.autoCashOn, autoCash: this.autoCash });
    }

    note(text, ms = 0) {
      clearTimeout(this.noteTimer);
      this.noteEl.textContent = text || '';
      if (ms) this.noteTimer = setTimeout(() => (this.noteEl.textContent = ''), ms);
    }

    onAction() {
      if (!shell.requireUser()) return;
      sound._ensure();
      switch (this.status) {
        case 'idle':
          if (cs.phase === 'BETTING') this.place();
          else {
            this.status = 'queued';
            this.render();
          }
          break;
        case 'queued':
          this.status = 'idle';
          if (this.autoBet) {
            this.autoBet = false;
            this.autoBetEl.checked = false;
          }
          this.render();
          break;
        case 'placed':
          this.cancel();
          break;
        case 'active':
          this.cashout();
          break;
        default:
          break;
      }
      updateBadge();
    }

    place() {
      const { min_bet: min, max_bet: max } = S();
      const amount = this.amount;
      const fail = (msg) => {
        toast(msg, 'error');
        if (this.autoBet) {
          this.autoBet = false;
          this.autoBetEl.checked = false;
        }
        this.status = 'idle';
        this.render();
        updateBadge();
      };
      if (amount < min) return fail(`La apuesta mínima es ${fmtGs(min)}`);
      if (amount > max) return fail(`La apuesta máxima es ${fmtGs(max)}`);
      if (amount > shell.balance) return fail('No te alcanza el saldo 😕 Cargá saldo para seguir jugando');
      if (!socket.connected) return fail('Sin conexión, esperá un momento');
      this.status = 'sending';
      this.render();
      const payload = { slot: this.slot, amount, auto: this.autoCashOn ? (this.autoCash / 100).toFixed(2) : null };
      socket.timeout(8000).emit('bet', payload, (err, res) => {
        if (err) {
          if (this.status === 'sending') {
            this.status = 'idle';
            toast('El servidor no respondió, probá de nuevo', 'error');
            this.render();
          }
          return;
        }
        if (res.ok) {
          this.bet = res.bet;
          if (this.status === 'sending' || this.status === 'idle') this.status = cs.phase === 'RUNNING' ? 'active' : 'placed';
          shell.setBalance(res.balance);
          if (active()) sound.bet();
          vibrate(20);
          this.note('');
        } else if (res.code === 'NOT_BETTING') {
          this.status = 'queued';
          toast('Llegaste justo tarde: tu apuesta va para la próxima ronda', 'info');
        } else if (res.code === 'DUPLICATE') {
          this.status = cs.phase === 'RUNNING' ? 'active' : 'placed';
        } else {
          fail(res.error || 'No se pudo apostar');
          return;
        }
        this.render();
        updateBadge();
      });
    }

    cancel() {
      if (!socket.connected) return toast('Sin conexión', 'error');
      this.status = 'sending';
      this.render();
      socket.timeout(8000).emit('cancelBet', { slot: this.slot }, (err, res) => {
        if (err || !res.ok) {
          if (res && res.code === 'NOT_BETTING') {
            this.status = 'active';
            toast('La ronda ya despegó, no se puede cancelar', 'info');
          } else {
            this.status = this.bet ? 'placed' : 'idle';
            toast((res && res.error) || 'No se pudo cancelar', 'error');
          }
        } else {
          this.bet = null;
          this.status = 'idle';
          shell.setBalance(res.balance);
          sound.cancel();
        }
        if (this.autoBet) {
          this.autoBet = false;
          this.autoBetEl.checked = false;
        }
        this.render();
        updateBadge();
      });
    }

    cashout() {
      if (!socket.connected) return toast('Sin conexión', 'error');
      this.status = 'cashing';
      this.render();
      socket.timeout(8000).emit('cashout', { slot: this.slot }, (err, res) => {
        if (err) {
          if (this.status === 'cashing') this.status = cs.phase === 'RUNNING' ? 'active' : 'idle';
          toast('El servidor no respondió', 'error');
          this.render();
          return;
        }
        if (res.ok) {
          shell.setBalance(res.balance);
          this.onServerBet(res.bet);
        } else {
          // Si el retiro automático ya cobró en el mismo instante, no mostramos error
          if (this.status === 'won') return;
          if (this.status === 'cashing') this.status = cs.phase === 'RUNNING' && this.bet && this.bet.status === 'active' ? 'active' : 'idle';
          toast(res.error || 'No se pudo retirar', 'error');
          this.render();
        }
      });
    }

    /** Sincroniza con el estado real de la apuesta que manda el servidor. */
    onServerBet(b) {
      if (!b) return;
      if (b.roundId && cs.roundId && b.roundId !== cs.roundId) return;
      switch (b.status) {
        case 'active':
          this.bet = b;
          if (this.status !== 'cashing') this.status = cs.phase === 'RUNNING' ? 'active' : 'placed';
          break;
        case 'won':
          this.bet = b;
          this.celebrate(b);
          break;
        case 'lost':
          this.bet = null;
          if (this.status !== 'queued') this.status = 'idle';
          break;
        case 'refunded':
          this.bet = null;
          if (this.status !== 'queued') this.status = 'idle';
          this.note('↩ Apuesta devuelta a tu saldo', 5000);
          break;
        case 'cancelled':
          this.bet = null;
          if (this.status !== 'queued') this.status = 'idle';
          break;
        default:
          break;
      }
      this.render();
      updateBadge();
    }

    celebrate(b) {
      if (this.celebrated === b.id) return;
      this.celebrated = b.id;
      this.status = 'won';
      const big = b.cashout >= 1000 || b.payout - b.amount >= 500000;
      if (shell.current === 'crash') {
        showWinPop(b.payout, b.cashout, big);
        sound.cashout(big);
        vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
        if (big) graph.confetti();
      } else {
        toast(`Retiraste a ${fmtMult(b.cashout)} y ganaste ${fmtGs(b.payout - b.amount)}`, 'win', '🚀 Crash');
      }
      this.note(`✅ Retiraste a ${fmtMult(b.cashout)} · ganaste ${fmtGs(b.payout - b.amount)}`, 6000);
      this.render();
      setTimeout(() => {
        if (this.status === 'won') {
          this.status = 'idle';
          this.render();
        }
      }, 1800);
    }

    onBetting() {
      if (['won', 'active', 'cashing', 'placed'].includes(this.status)) {
        this.status = 'idle';
        this.bet = null;
      }
      if (this.status === 'queued' || (this.autoBet && this.status === 'idle')) this.place();
      this.render();
    }

    onStart() {
      if (this.status === 'placed') this.status = 'active';
      this.render();
    }

    onCrash(d) {
      if ((this.status === 'active' || this.status === 'cashing') && this.bet) {
        if (!d.cancelled && shell.current === 'crash') {
          this.note(`💥 Perdiste ${fmtGs(this.bet.amount)}`, 5000);
          els.stage.classList.remove('lost-flash');
          void els.stage.offsetWidth;
          els.stage.classList.add('lost-flash');
          sound.lose();
          vibrate(120);
        }
        this.status = 'idle';
        this.bet = null;
      }
      this.render();
    }

    reset() {
      this.status = 'idle';
      this.bet = null;
      this.autoBet = false;
      this.autoBetEl.checked = false;
      this.render();
    }

    render() {
      const s = this.status;
      const locked = s !== 'idle';
      setClass(this.el, `bet-panel st-${s}${locked ? ' locked' : ''}`);
      this.el.hidden = this.hidden;
      let cls = 'bp-action';
      let title = 'APOSTAR';
      let sub = fmtGs(this.amount);
      switch (s) {
        case 'idle':
          if (!shell.state.user) sub = 'Ingresá para jugar';
          break;
        case 'queued':
          cls += ' red';
          title = 'CANCELAR';
          sub = 'Esperando próxima ronda';
          break;
        case 'sending':
          title = 'ENVIANDO…';
          break;
        case 'placed':
          cls += ' red';
          title = 'CANCELAR';
          sub = fmtGs(this.bet ? this.bet.amount : this.amount);
          break;
        case 'active':
        case 'cashing':
          cls += ' orange';
          title = s === 'cashing' ? 'RETIRANDO…' : 'RETIRAR';
          sub = this.sub._t || fmtGs(this.bet ? this.bet.amount : this.amount);
          break;
        case 'won':
          cls += ' gold';
          title = '¡GANASTE!';
          sub = fmtGs(this.bet ? this.bet.payout : 0);
          break;
        default:
          break;
      }
      setClass(this.btn, cls);
      setText(this.title, title);
      setText(this.sub, sub);
      this.btn.disabled = s === 'sending' || s === 'cashing' || s === 'won';
      if (s === 'placed' && !this.noteEl.textContent) this.noteEl.textContent = '✓ Apuesta lista, esperando el despegue';
      if (s !== 'placed' && this.noteEl.textContent === '✓ Apuesta lista, esperando el despegue') this.noteEl.textContent = '';
    }

    /** Actualiza en cada cuadro el monto que se cobraría al retirar. */
    frame(v) {
      if (this.status === 'active' && v.phase === 'RUNNING' && this.bet) {
        let m = multiplierAt(v.elapsed, cs.growth);
        if (this.bet.auto && m >= this.bet.auto) m = this.bet.auto;
        setText(this.sub, fmtGs(Math.floor((this.bet.amount * m) / 100)));
      }
    }
  }

  const panels = [new BetPanel(0), new BetPanel(1)];
  panels.forEach((p) => els.betPanels.append(p.el));

  function setSecondPanel(show) {
    const p = panels[1];
    if (!show && p.status !== 'idle' && p.status !== 'queued') {
      toast('Tenés una apuesta en curso en ese panel', 'info');
      return;
    }
    if (!show && p.status === 'queued') p.status = 'idle';
    p.hidden = !show;
    if (!show) p.reset();
    p.render();
    els.betPanels.classList.toggle('two', show);
    els.addPanel.hidden = show;
    store.set('cpy_two', show);
  }
  setSecondPanel(store.get('cpy_two', window.innerWidth >= 1100));
  els.addPanel.addEventListener('click', () => setSecondPanel(true));

  /** Puntito en el menú de juegos si tenés una apuesta en el Crash mientras mirás otro juego. */
  function updateBadge() {
    shell.setNavBadge('crash', panels.some((p) => p.autoBet || ['placed', 'active', 'cashing', 'queued', 'sending'].includes(p.status)));
  }

  function showWinPop(payout, cashout, big) {
    const node = h(
      'div',
      { class: `win-pop${big ? ' big' : ''}` },
      h('span', { class: 'wp-amount' }, `+${fmtGs(payout)}`),
      h('span', { class: 'wp-label' }, `¡Retiraste a ${fmtMult(cashout)}! 🔥`),
    );
    els.winLayer.append(node);
    setTimeout(() => node.remove(), 2500);
  }

  // ═══════════════ Eventos del servidor ═══════════════

  function applyGame(g) {
    const now = performance.now();
    cs.phase = g.phase;
    cs.paused = g.paused;
    cs.roundId = g.roundId;
    cs.growth = g.growth;
    cs.bettingMs = g.bettingMs || cs.bettingMs;
    cs.history = g.history || [];
    cs.bets = new Map((g.bets || []).map((b) => [b.id, b]));
    cs.betsDirty = true;
    if (g.phase === 'BETTING') cs.bettingEndsLocal = now + (g.bettingLeft || 0);
    if (g.phase === 'RUNNING') cs.startLocal = now - (g.elapsed || 0);
    if (g.phase === 'CRASHED' && g.last) {
      cs.crash = g.last;
      cs.crashElapsed = msForMultiplier(Math.max(100, g.last.crash || 100), g.growth);
      cs.nextLocal = now + (g.last.nextIn || 0);
    }
    if (g.phase !== 'RUNNING') graph.clearRound();
    renderHistory();
    els.roundLabel.textContent = `Ronda #${g.roundId || '—'}`;
  }

  socket.on('betting', (d) => {
    cs.phase = 'BETTING';
    cs.paused = false;
    cs.roundId = d.roundId;
    cs.growth = d.growth;
    cs.bettingMs = d.ms;
    cs.bettingEndsLocal = performance.now() + d.ms;
    cs.crash = null;
    cs.bets.clear();
    cs.betsDirty = true;
    graph.clearRound();
    els.roundLabel.textContent = `Ronda #${d.roundId}`;
    panels.forEach((p) => p.onBetting());
    updateBadge();
  });

  socket.on('start', (d) => {
    cs.phase = 'RUNNING';
    cs.roundId = d.roundId;
    cs.growth = d.growth;
    cs.startLocal = performance.now();
    cs.launchUntil = performance.now() + 1000;
    panels.forEach((p) => p.onStart());
    if (active()) sound.launch();
  });

  socket.on('tick', (d) => {
    if (cs.phase !== 'RUNNING') return;
    const candidate = performance.now() - d.e;
    // Nos quedamos con la estimación más temprana (la de menor latencia)
    if (candidate < cs.startLocal) cs.startLocal = candidate;
  });

  socket.on('crash', (d) => {
    cs.phase = 'CRASHED';
    cs.crash = d;
    cs.crashElapsed = msForMultiplier(Math.max(100, d.crash || 100), cs.growth);
    cs.nextLocal = performance.now() + (d.nextIn || 4000);
    for (const b of cs.bets.values()) if (b.status === 'active') b.status = d.cancelled ? 'refunded' : 'lost';
    cs.betsDirty = true;
    cs.history.unshift({ id: d.roundId, crash: d.crash, cancelled: !!d.cancelled });
    if (cs.history.length > 50) cs.history.length = 50;
    renderHistory(true);
    graph.explode();
    if (active()) {
      els.stageFlash.classList.remove('go');
      void els.stageFlash.offsetWidth;
      els.stageFlash.classList.add('go');
      sound.crash();
    } else sound.engineStop();
    panels.forEach((p) => p.onCrash(d));
    updateBadge();
    if (shell.current === 'crash') setTimeout(() => shell.refreshMine(), 600);
  });

  socket.on('paused', (d) => {
    cs.paused = d.paused;
    if (d.paused && d.phase === 'PAUSED') {
      cs.phase = 'PAUSED';
      graph.clearRound();
    }
    if (d.paused && d.phase !== 'PAUSED' && shell.current === 'crash') toast('⏸ El juego se va a pausar al terminar esta ronda', 'info');
  });

  socket.on('bet', (b) => {
    cs.bets.set(b.id, b);
    cs.betsDirty = true;
  });

  socket.on('cashout', (d) => {
    const b = cs.bets.get(d.id);
    if (b) Object.assign(b, { status: 'won', cashout: d.cashout, payout: d.payout });
    cs.betsDirty = true;
    const own = !!(shell.state.user && d.uid === shell.state.user.id);
    const label = own ? `+${fmtGs(d.payout - d.amount)}` : `${d.user} ${fmtMult(d.cashout)}`;
    graph.addMarker(msForMultiplier(d.cashout, cs.growth), d.cashout, label, own);
  });

  socket.on('betCancel', (d) => {
    cs.bets.delete(d.id);
    cs.betsDirty = true;
  });

  socket.on('betRefund', (d) => {
    const b = cs.bets.get(d.id);
    if (b) b.status = 'refunded';
    cs.betsDirty = true;
  });

  socket.on('myBet', (b) => {
    const p = panels[b.slot];
    if (p) p.onServerBet(b);
  });

  // ═══════════════ Animación ═══════════════

  let lastTickSecond = -1;
  let engineUpdateAt = 0;
  let lastBetsRender = 0;

  function computeView(now) {
    const v = { phase: cs.phase, growth: cs.growth };
    if (cs.phase === 'RUNNING') v.elapsed = Math.max(0, now - cs.startLocal);
    if (cs.phase === 'CRASHED' && cs.crash) {
      v.crashElapsed = cs.crashElapsed;
      v.crashM = cs.crash.crash;
      v.cancelled = !!cs.crash.cancelled;
    }
    if (cs.phase === 'BETTING') {
      v.left = Math.max(0, cs.bettingEndsLocal - now);
      v.bettingFrac = cs.bettingMs ? v.left / cs.bettingMs : 0;
    }
    return v;
  }

  function tierClass(m) {
    if (m < 200) return 't1';
    if (m < 500) return 't2';
    if (m < 1000) return 't3';
    return 't4';
  }

  function updateOverlay(v, now) {
    const st = els.stageStatus;
    const mult = els.stageMult;
    const sub = els.stageSub;
    let showCountdown = false;
    switch (v.phase) {
      case 'RUNNING': {
        const m = multiplierAt(v.elapsed, cs.growth);
        setText(mult, fmtMult(m));
        setClass(mult, `stage-mult ${tierClass(m)}`);
        if (now < cs.launchUntil) {
          setText(st, '¡JAHA! 🚀');
          setClass(st, 'stage-status launch');
        } else {
          setText(st, '');
          setClass(st, 'stage-status');
        }
        setText(sub, cs.paused ? '⏸ Pausa al terminar esta ronda' : '');
        if (now > engineUpdateAt) {
          engineUpdateAt = now + 120;
          sound.engineUpdate(m / 100);
        }
        break;
      }
      case 'BETTING': {
        const secs = v.left / 1000;
        setText(st, 'PRÓXIMA RONDA EN');
        setClass(st, 'stage-status');
        setText(mult, `${secs.toFixed(1)}s`);
        setClass(mult, 'stage-mult waiting');
        setText(sub, shell.state.user ? '¡Hacé tu apuesta! 🎯' : 'Ingresá para apostar 🎯');
        showCountdown = true;
        els.countdownBar.style.transform = `scaleX(${Math.max(0, Math.min(1, v.bettingFrac))})`;
        const sec = Math.ceil(secs);
        if (sec <= 3 && sec > 0 && sec !== lastTickSecond) {
          lastTickSecond = sec;
          sound.tick();
        }
        break;
      }
      case 'CRASHED': {
        const c = cs.crash || {};
        setText(st, c.cancelled ? 'RONDA ANULADA' : '¡EXPLOTÓ!');
        setClass(st, 'stage-status crashed');
        setText(mult, fmtMult(c.crash));
        setClass(mult, `stage-mult ${c.cancelled ? 'cancelled' : 'crashed'}`);
        let text;
        if (c.cancelled) {
          text = c.mode === 'pay' ? `El admin detuvo la ronda: se pagó a todos a ${fmtMult(c.crash)}` : 'La ronda se anuló: se devolvieron las apuestas';
        } else {
          const left = Math.max(0, Math.ceil((cs.nextLocal - now) / 1000));
          text = cs.paused ? '⏸ El juego se pausa ahora' : `Próxima ronda en ${left}s`;
        }
        setText(sub, text);
        break;
      }
      case 'PAUSED':
        setText(st, 'JUEGO EN PAUSA');
        setClass(st, 'stage-status');
        setText(mult, '⏸');
        setClass(mult, 'stage-mult waiting');
        setText(sub, 'Volvemos enseguida 🙏');
        break;
      default:
        setText(st, '');
        setText(mult, '···');
        setClass(mult, 'stage-mult waiting');
        setText(sub, 'Conectando…');
    }
    if (els.countdown.hidden === showCountdown) els.countdown.hidden = !showCountdown;
    if (v.phase !== 'BETTING') lastTickSecond = -1;
  }

  // Barra espaciadora = retirar (panel 1) cuando hay apuesta en vuelo
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || shell.current !== 'crash') return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(tag) || document.body.classList.contains('modal-open')) return;
    const p = panels.find((x) => x.status === 'active');
    if (p) {
      e.preventDefault();
      p.cashout();
    }
  });

  // ═══════════════ Historial y lista de apuestas ═══════════════

  function renderHistory(animateFirst = false) {
    const items = cs.history.slice(0, 30).map((r, i) =>
      h(
        'button',
        {
          type: 'button',
          class: `hist-pill ${r.cancelled ? 'cancelled' : multClass(r.crash)}${animateFirst && i === 0 ? ' new' : ''}`,
          title: `Ronda #${r.id}${r.cancelled ? ' (anulada)' : ''}`,
          onclick: () => openRound(r.id),
        },
        fmtMult(r.crash),
      ),
    );
    els.historyList.replaceChildren(...items);
    els.historyList.scrollLeft = 0;
  }

  function renderBets() {
    cs.betsDirty = false;
    const list = [...cs.bets.values()].filter((b) => b.status !== 'cancelled');
    list.sort((a, b) => b.amount - a.amount || a.id - b.id);
    const total = list.reduce((sum, b) => sum + (b.status === 'refunded' ? 0 : b.amount), 0);
    const players = new Set(list.filter((b) => !b.bot).map((b) => b.uid)).size;
    const botsN = new Set(list.filter((b) => b.bot).map((b) => b.uid)).size;
    els.betsCount.textContent = String(list.length);
    els.betsPlayers.textContent = `${players} jugador${players === 1 ? '' : 'es'}${botsN ? ` · 🤖 ${botsN} bot${botsN === 1 ? '' : 's'}` : ''}`;
    els.betsTotal.textContent = fmtGs(total);
    els.roundPlayers.textContent = botsN ? `👥 ${players} · 🤖 ${botsN}` : `👥 ${players}`;
    els.roundTotal.textContent = fmtGs(total);
    const me = shell.state.user ? shell.state.user.id : null;
    const rows = list.slice(0, 150).map((b) => {
      const lost = b.status === 'lost' || (cs.phase === 'CRASHED' && b.status === 'active');
      const cls = b.status === 'won' ? 'won' : lost ? 'lost' : b.status === 'refunded' ? 'refunded' : '';
      return h(
        'div',
        { class: `bet-row ${cls}${b.uid === me ? ' me' : ''}${b.bot ? ' bot' : ''}` },
        h('div', { class: 'bet-user' }, b.bot ? h('span', { class: 'avatar bot-avatar', title: 'Bot (plata ficticia)' }, '🤖') : avatar(b.user), h('span', null, b.bot ? b.user.replace(/^🤖\s*/, '') : b.user), b.bot ? h('span', { class: 'bot-badge' }, 'BOT') : null),
        h('div', { class: 'bet-amount' }, fmtNum(b.amount)),
        h('div', { class: `bet-mult ${b.cashout ? multClass(b.cashout) : 'muted'}` }, b.cashout ? fmtMult(b.cashout) : b.status === 'refunded' ? '↩' : '—'),
        h('div', { class: 'bet-win' }, b.payout ? fmtNum(b.payout) : lost ? '💥' : '—'),
      );
    });
    if (!rows.length) rows.push(h('div', { class: 'empty' }, cs.phase === 'BETTING' ? '¡Sé el primero en apostar! 🚀' : 'Sin apuestas en esta ronda'));
    els.betsList.replaceChildren(...rows);
  }

  async function loadMine(container) {
    if (!shell.state.user) {
      container.replaceChildren(
        h('div', { class: 'empty' }, 'Ingresá para ver tus apuestas', h('br'), h('br'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => shell.openAuth('login') }, 'Ingresar')),
      );
      return;
    }
    try {
      const { items } = await api('/api/me/bets');
      if (!items.length) {
        container.replaceChildren(h('div', { class: 'empty' }, 'Todavía no apostaste. ¡Probá suerte! 🍀'));
        return;
      }
      container.replaceChildren(
        ...items.map((b) => {
          let result;
          let badge;
          if (b.status === 'won') {
            result = h('span', { class: 'green' }, fmtSigned(b.payout - b.amount));
            badge = h('span', { class: `mr-badge ${multClass(b.cashout)}` }, fmtMult(b.cashout));
          } else if (b.status === 'lost') {
            result = h('span', { class: 'red' }, fmtSigned(-b.amount));
            badge = h('span', { class: 'mr-badge red' }, '💥');
          } else if (b.status === 'refunded') {
            result = h('span', { class: 'muted' }, 'Devuelta');
            badge = h('span', { class: 'mr-badge' }, '↩');
          } else {
            result = h('span', { class: 'gold' }, 'En juego');
            badge = h('span', { class: 'mr-badge' }, '🚀');
          }
          return h(
            'div',
            { class: 'mine-row', onclick: () => b.crash != null && openRound(b.round_id), style: { cursor: 'pointer' } },
            badge,
            h(
              'div',
              { class: 'mr-main' },
              h('div', { class: 'mr-top' }, `Apostaste ${fmtGs(b.amount)}`),
              h('div', { class: 'mr-sub' }, `Ronda #${b.round_id} · ${fmtTime(b.created_at)}${b.crash != null ? ` · explotó en ${fmtMult(b.crash)}` : ''}`),
            ),
            h('div', { class: 'mr-result' }, result),
          );
        }),
      );
    } catch (err) {
      container.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }

  // ═══════════════ Rondas y verificación ═══════════════

  function openHistory() {
    const grid = h(
      'div',
      { class: 'history-grid' },
      ...cs.history.map((r) =>
        h('button', { type: 'button', class: `hist-pill ${r.cancelled ? 'cancelled' : multClass(r.crash)}`, onclick: () => openRound(r.id) }, fmtMult(r.crash), h('small', null, `#${r.id}`)),
      ),
    );
    openModal({
      title: '🕒 Últimas rondas del Crash',
      content: h('div', null, grid, h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Tocá una ronda para ver su hash y verificarla.')),
    });
  }
  $('#btnHistory').addEventListener('click', openHistory);

  async function openRound(id) {
    const body = h('div', null, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
    openModal({ title: `🚀 Crash · ronda #${id}`, content: body, wide: true });
    try {
      const data = await api(`/api/rounds/${id}`);
      const r = data.round;
      if (!r.hash) {
        body.replaceChildren(h('div', { class: 'empty' }, 'Esta ronda todavía está en juego. El hash se revela cuando explota 🔒'));
        return;
      }
      const chain = data.chain;
      const shown = r.status === 'crashed' ? r.crash_point : r.ended_multiplier;
      const prevHash = data.previous ? data.previous.hash : r.chain_index === 1 ? chain.terminal_hash : null;
      const cancelledText = {
        refund: 'El administrador detuvo la ronda y se devolvieron las apuestas.',
        pay: 'El administrador detuvo la ronda y se pagó a todos al multiplicador de ese momento.',
        server: 'La ronda se anuló por un reinicio del servidor y se devolvieron las apuestas.',
      };
      const verifyOut = h('div');
      const verifyBtn = h('button', { class: 'btn btn-blue btn-block', type: 'button' }, '✔ Verificar en este dispositivo');
      verifyBtn.addEventListener('click', () => {
        const computed = crashFromHash(r.hash, chain.salt, chain.house_edge_bps);
        const link = prevHash ? sha256Hex(r.hash) === prevHash : null;
        const ok = computed === r.crash_point && link !== false;
        verifyOut.replaceChildren(
          h(
            'div',
            { class: `verify-box ${ok ? 'ok' : 'bad'}` },
            h('div', null, `${computed === r.crash_point ? '✅' : '❌'} El hash da un punto de explosión de ${fmtMult(computed)}${r.status === 'crashed' ? ' (coincide con la ronda)' : ''}`),
            link === null
              ? h('div', null, 'ℹ️ No tenemos el hash anterior para comprobar la cadena.')
              : h('div', null, `${link ? '✅' : '❌'} SHA-256 de este hash = hash de la ronda anterior${r.chain_index === 1 ? ' (hash terminal publicado)' : ''}`),
          ),
        );
      });
      const betsRows = data.bets.map((b) =>
        h(
          'tr',
          null,
          h('td', null, b.user),
          h('td', { class: 'num' }, fmtGs(b.amount)),
          h('td', { class: `num ${b.cashout ? multClass(b.cashout) : 'muted'}` }, b.cashout ? fmtMult(b.cashout) : b.status === 'refunded' ? 'devuelta' : '—'),
          h(
            'td',
            { class: `num ${b.status === 'won' ? 'green' : b.status === 'lost' ? 'red' : 'muted'}` },
            b.status === 'won' ? fmtSigned(b.payout - b.amount) : b.status === 'lost' ? fmtSigned(-b.amount) : '0',
          ),
        ),
      );
      const fairLink = `/fair?hash=${encodeURIComponent(r.hash)}&salt=${encodeURIComponent(chain.salt)}&edge=${chain.house_edge_bps}`;
      body.replaceChildren(
        h(
          'div',
          null,
          h(
            'div',
            { class: 'round-hero' },
            h('div', { class: `rh-mult ${r.status === 'cancelled' ? 'muted' : multClass(shown)}` }, fmtMult(shown)),
            h('small', null, `${fmtDate(r.ended_at)} · ${r.players} jugador${r.players === 1 ? '' : 'es'} · apostado ${fmtGs(r.total_bet)}`),
          ),
          r.status === 'cancelled'
            ? h('div', { class: 'verify-box' }, `⚠️ Ronda anulada. ${cancelledText[r.cancel_mode] || ''} Según el hash iba a explotar en ${fmtMult(r.crash_point)}.`)
            : null,
          h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Hash'),
            h('dd', { class: 'mono' }, r.hash, ' ', h('button', { class: 'copy-btn', type: 'button', onclick: () => copyText(r.hash) }, '📋')),
            h('dt', null, r.chain_index === 1 ? 'Hash terminal' : 'Hash anterior'),
            h('dd', { class: 'mono' }, prevHash || '—'),
            h('dt', null, 'Sal (salt)'),
            h('dd', { class: 'mono' }, chain.salt),
            h('dt', null, 'Ventaja casa'),
            h('dd', null, `${(chain.house_edge_bps / 100).toFixed(2)}% (RTP ${(100 - chain.house_edge_bps / 100).toFixed(2)}%)`),
            h('dt', null, 'Cadena'),
            h('dd', null, `#${chain.id} · ronda ${fmtNum(r.chain_index)} de ${fmtNum(chain.length)}`),
          ),
          verifyBtn,
          verifyOut,
          h('p', { style: { textAlign: 'center', margin: '10px 0' } }, h('a', { href: fairLink }, '¿Cómo funciona? Verificación completa →')),
          data.bets.length
            ? h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'table' },
                  h('thead', null, h('tr', null, h('th', null, 'Jugador'), h('th', { class: 'num' }, 'Apuesta'), h('th', { class: 'num' }, 'Retiro'), h('th', { class: 'num' }, 'Resultado'))),
                  h('tbody', null, ...betsRows),
                ),
              )
            : h('div', { class: 'empty' }, 'Nadie apostó en esta ronda'),
        ),
      );
    } catch (err) {
      body.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }

  function rules() {
    const s = S();
    const li = (...c) => h('li', null, ...c);
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('Elegí cuánto apostar y tocá ', h('b', null, 'APOSTAR'), ' antes de que despegue el cohete 🚀.'),
        li('El multiplicador sube desde 1.00x. Lo que cobrás = apuesta × multiplicador.'),
        li('Tocá ', h('b', null, 'RETIRAR'), ' cuando quieras. Si el cohete explota antes 💥, perdés la apuesta.'),
        li(h('b', null, 'Auto retiro:'), ' el sistema retira por vos al llegar al multiplicador que elegiste (funciona aunque se te corte internet).'),
        li(h('b', null, 'Auto apuesta:'), ' repite tu apuesta en cada ronda.'),
        li('Podés tener 2 apuestas por ronda con el botón “Agregar segunda apuesta”.'),
      ),
      h(
        'ul',
        null,
        li(`Al llegar a la ganancia máxima (${fmtGs(s.max_profit)}) se retira sola.`),
        li('Una ronda puede explotar en 1.00x, sin tiempo para retirar.'),
        li('Si el servidor se reinicia o el administrador detiene una ronda, la ronda se anula: nadie pierde su apuesta.'),
        li('Cada ronda sale de una cadena de hashes publicada de antemano: tocá cualquier ronda del historial para verificarla.'),
      ),
    );
  }

  // ═══════════════ Interfaz para el resto de la app ═══════════════

  return {
    id: 'crash',
    view,
    mount() {},
    show() {
      cs.betsDirty = true;
      if (cs.phase === 'RUNNING') sound.engineStart && active() && sound.engineStart();
    },
    hide() {
      sound.engineStop();
    },
    onInit(d) {
      applyGame(d.game);
      d.mine.forEach((b, slot) => {
        const p = panels[slot];
        if (b) p.onServerBet(b);
        else if (['placed', 'active', 'cashing', 'sending', 'won'].includes(p.status)) {
          p.status = 'idle';
          p.bet = null;
          p.render();
        }
      });
      if (!d.user) panels.forEach((p) => p.reset());
      updateBadge();
    },
    onUser(user) {
      if (!user) panels.forEach((p) => p.reset());
      panels.forEach((p) => p.render());
      updateBadge();
    },
    onSettings(s) {
      panels.forEach((p) => {
        p.buildQuick();
        if (p.amount < s.min_bet || p.amount > s.max_bet) p.setAmount(p.amount);
      });
    },
    onDisconnect() {
      sound.engineStop();
    },
    frame(now) {
      const v = computeView(now);
      graph.frame(v);
      updateOverlay(v, now);
      for (const p of panels) p.frame(v);
      if (cs.betsDirty && now - lastBetsRender > 180) {
        lastBetsRender = now;
        renderBets();
      }
    },
    /** La lista "En vivo" del Crash se actualiza aunque se esté viendo otra pestaña. */
    liveCount: () => [...cs.bets.values()].filter((b) => b.status !== 'cancelled').length,
    loadMine,
    openRound,
    openHistory,
    rules,
    fairness: () => {
      window.location.href = '/fair';
    },
  };
}
