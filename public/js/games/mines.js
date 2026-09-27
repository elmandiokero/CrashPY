// 💣 Minas: una grilla de 5×5 con diamantes y minas. Cada diamante sube el multiplicador;
// retirás cuando quieras, pero si destapás una mina perdés la apuesta.
import { h, fmtGs, fmtMult, toast } from '../shared.js';
import { core, store, AmountControl, actionButton, winPop, confetti, pausedNotice, loadPlays, setText, vibrate, resultOverlay, panelHead, isBigWin } from './common.js';

const TILES = 25;
const QUICK_MINES = [1, 3, 5, 10, 24];

// Dibujos (constantes nuestras, sin datos del usuario)
const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <defs>
    <linearGradient id="mnGemBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b9fff0"/><stop offset="1" stop-color="#14c79a"/>
    </linearGradient>
    <radialGradient id="mnBombBody" cx="0.35" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#6b7394"/><stop offset="0.45" stop-color="#2a2f45"/><stop offset="1" stop-color="#0d0f19"/>
    </radialGradient>
    <radialGradient id="mnBurst" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff6c2"/><stop offset="0.45" stop-color="#ffc53d"/><stop offset="1" stop-color="#ff3b4e"/>
    </radialGradient>
  </defs>
  <symbol id="mn-gem" viewBox="0 0 64 64">
    <polygon points="16,9 48,9 60,25 32,58 4,25" fill="url(#mnGemBody)"/>
    <polygon points="16,9 48,9 41,25 23,25" fill="#dcfff7"/>
    <polygon points="16,9 23,25 4,25" fill="#f2fffc"/>
    <polygon points="48,9 60,25 41,25" fill="#86f6da"/>
    <polygon points="4,25 23,25 32,58" fill="#2fd9ab"/>
    <polygon points="23,25 41,25 32,58" fill="#55efc6"/>
    <polygon points="41,25 60,25 32,58" fill="#0fa77f"/>
    <polygon points="21,12 27,12 23,20" fill="#ffffff" opacity="0.85"/>
  </symbol>
  <symbol id="mn-bomb" viewBox="0 0 64 64">
    <path d="M44 14 q6 -8 12 -4" stroke="#c9a46b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="57" cy="9" r="4" fill="#ffc53d"/><circle cx="57" cy="9" r="2" fill="#fff6c2"/>
    <rect x="37" y="13" width="11" height="9" rx="2" transform="rotate(35 42 17)" fill="#3a4060"/>
    <circle cx="30" cy="37" r="21" fill="url(#mnBombBody)"/>
    <ellipse cx="22" cy="28" rx="6" ry="4" fill="#ffffff" opacity="0.28" transform="rotate(-30 22 28)"/>
  </symbol>
  <symbol id="mn-burst" viewBox="0 0 64 64">
    <polygon points="32,1 38,20 57,9 45,26 63,32 45,38 57,55 38,44 32,63 26,44 7,55 19,38 1,32 19,26 7,9 26,20" fill="url(#mnBurst)"/>
  </symbol>
</svg>`;

const ICON = {
  gem: '<svg class="mt-svg" viewBox="0 0 64 64"><use href="#mn-gem"/></svg>',
  bomb: '<svg class="mt-burst" viewBox="0 0 64 64"><use href="#mn-burst"/></svg><svg class="mt-svg" viewBox="0 0 64 64"><use href="#mn-bomb"/></svg>',
};

export function createMines(shell) {
  const { sound } = shell;
  const S = () => shell.state.settings;

  let el = null;
  let amount = null;
  let play = null; // partida en curso (o la última terminada, para mostrar el tablero)
  let busy = false;
  let minesCount = Math.min(24, Math.max(1, Number(store.get('cpy_mines_n', 3)) || 3));

  const active = () => !!(play && play.status === 'active');
  const revealedGems = () => (play ? (play.revealed || []).filter((t) => t !== play.hit).length : 0);

  // ───────────────────────── Armado de la pantalla ─────────────────────────

  function mount(root) {
    if (!document.getElementById('mn-gem')) document.body.insertAdjacentHTML('beforeend', SPRITE);

    const tiles = [];
    const grid = h('div', { class: 'mines-grid', role: 'grid', 'aria-label': 'Tablero de minas' });
    for (let i = 0; i < TILES; i++) {
      const content = h('span', { class: 'mt-content' });
      const tile = h('button', { class: 'mtile', type: 'button', 'aria-label': `Casilla ${i + 1}`, 'data-i': String(i) }, h('span', { class: 'mt-face' }), content);
      tile.addEventListener('click', () => reveal(i));
      tile._content = content;
      tiles.push(tile);
      grid.append(tile);
    }

    const ladder = h('div', { class: 'mines-ladder' });
    const infoLeft = h('span');
    const infoRight = h('span');
    const result = resultOverlay();
    const winLayer = h('div', { class: 'win-layer' });
    const paused = pausedNotice();
    const stage = h(
      'div',
      { class: 'gv-stage mines-stage' },
      h('div', { class: 'mines-info' }, infoLeft, infoRight),
      ladder,
      h('div', { class: 'mines-board' }, grid),
      result.el,
      winLayer,
      paused,
    );

    amount = new AmountControl(shell, { key: 'cpy_mines_amt', def: 5000, onChange: () => render() });

    const minesValue = h('b', { class: 'mines-count' });
    const minesMinus = h('button', { class: 'amt-btn', type: 'button', 'aria-label': 'Menos minas' }, '−');
    const minesPlus = h('button', { class: 'amt-btn', type: 'button', 'aria-label': 'Más minas' }, '+');
    const minesQuick = h(
      'div',
      { class: 'quick-row mines-quick' },
      ...QUICK_MINES.map((n) => h('button', { type: 'button', 'data-n': String(n), onclick: () => setMines(n) }, `${n} 💣`)),
    );
    minesQuick.style.gridTemplateColumns = `repeat(${QUICK_MINES.length}, minmax(0, 1fr))`;
    minesMinus.addEventListener('click', () => setMines(minesCount - 1));
    minesPlus.addEventListener('click', () => setMines(minesCount + 1));
    const minesCtl = h('div', { class: 'mines-ctl' }, h('div', { class: 'amount-row' }, minesMinus, h('div', { class: 'mines-count-wrap' }, minesValue), minesPlus), minesQuick);

    const statMult = h('b');
    const statProfit = h('b');
    const action = actionButton(() => onAction());
    const random = h('button', { class: 'btn btn-ghost btn-sm btn-block', type: 'button' }, '🎲 Elegir una casilla al azar');
    random.addEventListener('click', pickRandom);
    const note = h('div', { class: 'gv-note' });

    const panel = h(
      'div',
      { class: 'gv-panel' },
      panelHead(shell, { icon: '💣', name: 'Minas' }),
      h('div', null, h('div', { class: 'gv-label' }, 'Monto'), amount.el),
      h('div', null, h('div', { class: 'gv-label' }, 'Minas en el tablero'), minesCtl),
      h('div', { class: 'gv-stats' }, h('div', { class: 'gv-stat' }, h('small', null, 'Multiplicador'), statMult), h('div', { class: 'gv-stat' }, h('small', null, 'Ganancia'), statProfit)),
      action.el,
      random,
      note,
    );

    root.append(h('div', { class: 'gv gv-mines' }, stage, panel));
    el = { stage, grid, tiles, ladder, infoLeft, infoRight, result, winLayer, paused, minesValue, minesMinus, minesPlus, minesQuick, minesCtl, statMult, statProfit, action, random, note };
    setMines(minesCount, false);
    const init = shell.state.lastInit;
    if (init && init.plays && init.plays.mines) play = init.plays.mines;
    drawBoard();
    render();
  }

  function setMines(n, save = true) {
    if (active() || busy) return;
    minesCount = Math.max(1, Math.min(24, n));
    if (save) store.set('cpy_mines_n', minesCount);
    if (!el) return;
    el.minesValue.textContent = `${minesCount} mina${minesCount === 1 ? '' : 's'}`;
    for (const b of el.minesQuick.children) b.classList.toggle('active', Number(b.dataset.n) === minesCount);
    if (play && play.status !== 'active') {
      play = null;
      drawBoard();
    }
    render();
  }

  // ───────────────────────── Dibujo ─────────────────────────

  /** Pinta el tablero completo según la partida (sin animaciones). */
  function drawBoard(animateEnd = false) {
    if (!el) return;
    const revealed = new Set(play ? play.revealed || [] : []);
    const mines = new Set(play && play.mines ? play.mines : []);
    const ended = play && play.status !== 'active';
    el.tiles.forEach((t, i) => {
      let cls = 'mtile';
      let icon = '';
      if (i === (play && play.hit)) {
        cls += ' hit';
        icon = ICON.bomb;
      } else if (revealed.has(i)) {
        cls += ' gem';
        icon = ICON.gem;
      } else if (ended && mines.has(i)) {
        cls += ' mine dim';
        icon = ICON.bomb;
      } else if (ended) {
        cls += ' gem dim';
        icon = ICON.gem;
      }
      if (animateEnd && ended && !revealed.has(i)) {
        t.style.animationDelay = `${(i % 5) * 35 + Math.floor(i / 5) * 35}ms`;
        cls += ' late';
      } else t.style.animationDelay = '';
      t.className = cls;
      if (t._icon !== icon) {
        t._icon = icon;
        t._content.innerHTML = icon; // dibujos propios (constantes)
      }
      t.disabled = !active() || revealed.has(i);
    });
    el.grid.classList.toggle('playing', active());
    drawLadder();
  }

  function drawLadder() {
    const n = play ? play.params.mines : minesCount;
    const steps = TILES - n;
    const gems = revealedGems();
    const max = Math.min(steps, 24);
    const items = [];
    for (let k = 1; k <= max; k++) {
      const m = core.minesMultiplier(n, k);
      items.push(h('span', { class: `ml-step${k <= gems ? ' done' : ''}${k === gems + 1 && active() ? ' next' : ''}` }, h('small', null, `${k} 💎`), fmtMult(m)));
    }
    el.ladder.replaceChildren(...items);
    const done = el.ladder.querySelectorAll('.done');
    const next = el.ladder.querySelector('.next') || done[done.length - 1];
    if (next) el.ladder.scrollTo({ left: Math.max(0, next.offsetLeft - el.ladder.clientWidth / 2 + next.offsetWidth / 2), behavior: 'smooth' });
  }

  function render() {
    if (!el) return;
    const n = play && active() ? play.params.mines : minesCount;
    const gems = revealedGems();
    const current = active() && gems ? core.minesMultiplier(n, gems) : 0;
    const next = core.minesMultiplier(n, gems + 1 <= TILES - n ? gems + 1 : gems);
    el.infoLeft.replaceChildren(h('b', null, `💎 ${TILES - n - gems}`), h('span', { class: 'mi-sep' }, '·'), h('b', null, `💣 ${n}`));
    el.infoRight.replaceChildren(active() ? h('span', null, 'Próximo ', h('b', null, fmtMult(next))) : h('span', null, '1er diamante ', h('b', null, fmtMult(core.minesMultiplier(n, 1)))));
    setText(el.statMult, active() ? fmtMult(current || 100) : fmtMult(core.minesMultiplier(n, 1)));
    setText(el.statProfit, active() && gems ? fmtGs(Math.floor((play.amount * current) / 100) - play.amount) : fmtGs(0));
    amount.setDisabled(active() || busy);
    el.minesCtl.classList.toggle('locked', active() || busy);
    for (const b of [el.minesMinus, el.minesPlus, ...el.minesQuick.children]) b.disabled = active() || busy;

    if (!shell.state.user) el.action.set({ text: 'APOSTAR', detail: 'Ingresá para jugar' });
    else if (active()) {
      const payout = gems ? Math.floor((play.amount * current) / 100) : 0;
      el.action.set({
        text: busy ? 'ESPERÁ…' : 'RETIRAR',
        detail: gems ? fmtGs(payout) : 'Destapá una casilla',
        color: 'orange',
        disabled: busy || !gems,
      });
    } else el.action.set({ text: busy ? 'ENVIANDO…' : 'APOSTAR', detail: fmtGs(amount.value), disabled: busy });
    el.random.hidden = !active();
    const disabled = S().game_mines === false && !active();
    el.paused.hidden = !disabled;
    shell.setNavBadge('mines', active());
  }

  function note(text, kind = '') {
    el.note.textContent = text || '';
    el.note.className = `gv-note${kind ? ' ' + kind : ''}`;
  }


  // ───────────────────────── Acciones ─────────────────────────

  function onAction() {
    if (!shell.requireUser()) return;
    sound._ensure();
    if (active()) cashout();
    else start();
  }

  async function start() {
    if (busy) return;
    const value = amount.value;
    if (value > shell.balance) {
      toast('No te alcanza el saldo 😕 Cargá saldo para seguir jugando', 'error');
      return;
    }
    busy = true;
    el.result.hide();
    note('');
    render();
    const res = await shell.emit('mines:start', { amount: value, mines: minesCount });
    busy = false;
    if (!res.ok) {
      if (res.code === 'ACTIVE') await resync();
      toast(res.error || 'No se pudo empezar', 'error');
      render();
      return;
    }
    play = res.play;
    shell.setBalance(res.balance);
    sound.bet();
    vibrate(15);
    drawBoard();
    render();
    note('Elegí una casilla 👇');
  }

  async function reveal(i) {
    if (!active() || busy) return;
    if ((play.revealed || []).includes(i)) return;
    busy = true;
    const tile = el.tiles[i];
    tile.classList.add('pending');
    render();
    const res = await shell.emit('mines:reveal', { id: play.id, tile: i });
    busy = false;
    tile.classList.remove('pending');
    if (!res.ok) {
      if (res.code === 'ENDED' || res.code === 'NO_PLAY') await resync();
      toast(res.error || 'No se pudo destapar', 'error');
      render();
      return;
    }
    play = res.play;
    shell.setBalance(res.balance);
    if (play.status === 'lost') {
      drawBoard(true);
      el.stage.classList.remove('shake');
      void el.stage.offsetWidth;
      el.stage.classList.add('shake');
      sound.boom();
      vibrate([80, 40, 120]);
      el.result.show({ win: false, head: '💥 ¡BOOM!', detail: `Perdiste ${fmtGs(play.amount)}` });
      note(`💥 Había una mina. Suerte la próxima 🍀`, 'bad');
      shell.refreshMine();
    } else {
      const gems = revealedGems();
      sound.gem(gems);
      vibrate(12);
      drawBoard(play.status !== 'active');
      if (play.status === 'won') celebrate();
      else note(`💎 ¡Diamante! Ya vas ${fmtMult(play.current)}`, 'good');
    }
    render();
  }

  async function cashout() {
    if (!active() || busy || !revealedGems()) return;
    busy = true;
    render();
    const res = await shell.emit('mines:cashout', { id: play.id });
    busy = false;
    if (!res.ok) {
      if (res.code === 'ENDED' || res.code === 'NO_PLAY') await resync();
      toast(res.error || 'No se pudo retirar', 'error');
      render();
      return;
    }
    play = res.play;
    shell.setBalance(res.balance);
    drawBoard(true);
    celebrate();
    render();
  }

  function celebrate() {
    const big = isBigWin(play.payout, play.amount, play.multiplier);
    el.result.show({ win: true, head: fmtMult(play.multiplier), detail: `Ganaste ${fmtGs(play.payout)}`, big });
    winPop(el.winLayer, { amount: play.payout - play.amount, label: `¡Retiraste a ${fmtMult(play.multiplier)}! 💎`, big });
    if (big) confetti(el.stage);
    sound.win(big);
    vibrate(big ? [30, 40, 30, 40, 60] : [25, 30, 25]);
    const all = revealedGems() === TILES - play.params.mines;
    note(all ? '🏆 ¡Destapaste todos los diamantes!' : `✅ Cobraste ${fmtGs(play.payout)}`, 'good');
    shell.refreshMine();
  }

  function pickRandom() {
    if (!active() || busy) return;
    const revealed = new Set(play.revealed || []);
    const free = [];
    for (let i = 0; i < TILES; i++) if (!revealed.has(i)) free.push(i);
    if (!free.length) return;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    reveal(free[bytes[0] % free.length]);
  }

  /** Vuelve a pedir el estado real (por ejemplo si la partida terminó en otra pestaña). */
  async function resync() {
    const res = await shell.emit('plays:active');
    if (res.ok) play = res.plays.mines || (play && play.status === 'active' ? null : play);
    drawBoard();
  }

  // ───────────────────────── Interfaz para la app ─────────────────────────

  function rules() {
    const li = (...c) => h('li', null, ...c);
    return h(
      'div',
      null,
      h(
        'ol',
        null,
        li('Elegí cuánto apostar y cuántas minas querés esconder en el tablero de 25 casillas (de 1 a 24).'),
        li('Tocá ', h('b', null, 'APOSTAR'), ' y empezá a destapar casillas. Cada ', h('b', null, 'diamante 💎'), ' sube el multiplicador.'),
        li('Tocá ', h('b', null, 'RETIRAR'), ' cuando quieras para cobrar apuesta × multiplicador.'),
        li('Si destapás una ', h('b', null, 'mina 💣'), ', perdés la apuesta.'),
        li('Más minas = más riesgo, pero cada diamante paga mucho más.'),
      ),
      h('ul', null, li('Si destapás todos los diamantes, se cobra solo.'), li('Si cerrás la página, tu partida te espera: al volver seguís donde estabas.')),
    );
  }

  return {
    id: 'mines',
    mount,
    show() {
      render();
    },
    hide() {},
    onInit(d) {
      const serverPlay = d.plays ? d.plays.mines : null;
      if (serverPlay) play = serverPlay;
      else if (active()) play = null;
      if (el) {
        drawBoard();
        render();
      } else shell.setNavBadge('mines', !!serverPlay);
    },
    onUser(user) {
      if (!user) {
        play = null;
        busy = false;
      }
      if (el) {
        drawBoard();
        render();
      }
    },
    onSettings() {
      if (!el) return;
      amount.refresh();
      render();
    },
    loadMine: (container) => loadPlays(shell, container, 'mines'),
    rules,
  };
}
