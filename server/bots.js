'use strict';
const EventEmitter = require('events');
const core = require('../public/js/games-core.js');
const { msForMultiplier } = require('./fair');

/**
 * 🤖 Bots que animan la sala.
 *
 * - Siempre se muestran como bots: el nombre empieza con 🤖 y en el chat llevan la etiqueta BOT.
 * - Juegan con plata ficticia y con las mismas probabilidades que cualquier jugador
 *   (usan la misma matemática de los juegos), pero NO influyen en ningún resultado real.
 * - No tocan la base de datos de apuestas, el libro contable ni las estadísticas de la casa:
 *   sus resultados se guardan aparte (tabla bot_stats) para verlos en Admin → Bots.
 */

const NAMES = [
  'Tito', 'Mari', 'Nene', 'Rodri', 'Cami', 'Sole', 'Diego', 'Vale', 'Lucho', 'Fer', 'Pato', 'Rocío', 'Juanca', 'Pili',
  'Tati', 'Oscar', 'Nati', 'Beto', 'Gonza', 'Majo', 'Chino', 'Lore', 'Hugo', 'Mirta', 'Rami', 'Cinthia', 'Pablo', 'Nadia',
  'Kike', 'Dahiana', 'Gustavo', 'Fátima', 'Rolo', 'Lili', 'Willy', 'Sofi', 'Nico', 'Ana', 'Toti', 'Laura', 'Pepe', 'Belén',
];

// Frases del chat: charla liviana sobre el juego. Nunca hablan de depositar, retirar ni de que "paga seguro".
const CHAT = {
  hello: ['Buenas a todos 👋', "Mba'éichapa gente 🇵🇾", 'Hola hola 🙌', 'Buenas noches 🌙', 'Qué tal la noche? 🧉', 'Presente 🙋', 'Buenas desde Luque 👋', 'Llegué 😎'],
  generic: [
    'Suerte a todos 🍀',
    'Tranqui, de a poco 😎',
    'Tereré y crash, la mejor combinación 🧉🚀',
    'Qué calor hoy 🥵',
    'El Plinko me tiene re entretenido 🔴',
    'Minas con 3 y retiro rápido, esa es la mía 💣',
    'Penales como la Albirroja ⚽🇵🇾',
    'Arriba Cerro 🔵🔴',
    'Olimpia de mi vida ⚪⚫',
    'Hoy el Double está picante 🎡',
    'Jugá con cabeza siempre 🧠',
    'Alguien más con la ruleta? 🎰',
    'Me encanta el sonido del cohete 🚀',
    'Poné un límite y disfrutá 😉',
    'Qué lindo está el chat hoy 😄',
    'Voy por un chipa y vuelvo 🥯',
  ],
  crashLow: ['Nooo 1.00x 😭', 'Ni despegó 😅', 'Explotó al toque 🤯', 'Esa fue rapidísima 💥', 'Ni tiempo para respirar 😂'],
  crashHigh: ['¡Qué vuelo! 🚀🔥', 'Ese cohete se fue a la luna 🌕', '¿Quién aguantó hasta {m}? 😱', 'Uff {m}, qué ronda 🔥', 'Me bajé antes 🤦'],
  myCashout: ['¡Retiré a {m}! 🚀', 'Me bajé en {m} 😎', '{m} y afuera ✌️', 'Justo a tiempo, {m} 😅'],
  white: ['¡¡BLANCO!! ⚪🔥', 'Salió el blanco, quién tenía? 😮', 'Blanco 30x 🤯', 'Nooo, justo saqué del blanco 😭'],
  streak: ['Van {n} {c} seguidos 😮', '{n} {c} al hilo, ahora cambia 🙏', 'Qué racha de {c} 👀'],
  soloWin: {
    mines: ['💣 Saqué {m} en Minas 💎', 'Diamantes y afuera: {m} 💎'],
    penalty: ['⚽ ¡Golazo! {m} en los penales', 'La Albirroja no perdona: {m} ⚽🇵🇾'],
    plinko: ['🔴 La bolita cayó en {m} 😱', 'Plinko {m} 🔥'],
  },
  pleno: ['🎰 ¡Pleno al {n}! 🔥', '¡Salió mi {n}! 😱', 'Le pegué al {n} 🎯', 'Sabía que salía el {n} 🎰'],
  zero: ['Cero... 😅', 'El verde otra vez 🟢', 'Nadie tenía el 0? 👀', 'Salió el cero, qué bronca 😂'],
  cheer: ['¡Grande {u}! 🔥', 'Vamos {u} 👏', 'Qué crack {u} 🙌'],
};

const rand = Math.random;
const chance = (p) => rand() < p;
const between = (a, b) => a + rand() * (b - a);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
const fmtMult = (m100) => (m100 / 100).toFixed(2) + 'x';
const floats = (n) => Array.from({ length: n }, () => rand());

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weighted(items) {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r < 0) return v;
  }
  return items[items.length - 1][0];
}

/** Retiro automático de un bot en el Crash: la mayoría se baja temprano, unos pocos se arriesgan. */
function crashTarget() {
  if (chance(0.35)) return pick([150, 150, 200, 200, 200, 250, 300, 500, 1000]);
  const r = rand();
  if (r < 0.42) return Math.round(between(112, 200));
  if (r < 0.75) return Math.round(between(200, 350));
  if (r < 0.92) return Math.round(between(350, 1000));
  if (r < 0.985) return Math.round(between(1000, 3000));
  return Math.round(between(3000, 10000));
}

function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const GAMES = ['crash', 'double', 'mines', 'penalty', 'plinko', 'roulette'];

// Números que la gente suele jugar en la ruleta (cumpleaños, el 7, el 17...)
const LUCKY = [7, 17, 23, 0, 11, 13, 21, 27, 32, 9, 3, 19, 36, 1, 14, 22, 5, 29, 31, 8];

/** Fichas de un bot para la ruleta: casi siempre afuera (colores, docenas), a veces algunos plenos. */
function rouletteSpots() {
  const style = weighted([
    ['color', 34],
    ['numbers', 20],
    ['mixed', 18],
    ['dozens', 14],
    ['even', 14],
  ]);
  const num = () => (chance(0.6) ? pick(LUCKY) : Math.floor(rand() * 37));
  const spots = [];
  const add = (type, value = null, scale = 1) => spots.push({ type, value, scale });
  if (style === 'color') add(pick(['red', 'black']));
  else if (style === 'numbers') {
    const k = pick([1, 2, 3, 3, 4, 5]);
    const used = new Set();
    while (used.size < k) used.add(num());
    for (const n of used) add('n', n, 0.2);
  } else if (style === 'mixed') {
    add(pick(['red', 'black']));
    add('n', num(), 0.2);
    if (chance(0.5)) add('dozen', 1 + Math.floor(rand() * 3), 0.6);
  } else if (style === 'dozens') {
    const kind = chance(0.7) ? 'dozen' : 'column';
    const first = 1 + Math.floor(rand() * 3);
    add(kind, first);
    if (chance(0.45)) add(kind, (first % 3) + 1);
  } else add(pick(['odd', 'even', 'low', 'high']));
  return spots;
}

class BotManager extends EventEmitter {
  constructor({ db, engine, double, roulette, chat, settings, bus, log = console.log }) {
    super();
    this.db = db;
    this.engine = engine;
    this.double = double;
    this.roulette = roulette;
    this.chat = chat;
    this.settings = settings;
    this.bus = bus;
    this.log = log;
    // Orden al azar de los nombres (cambia en cada arranque)
    this.pool = NAMES.map((n, i) => ({ id: i + 1, uid: `bot:${i + 1}`, name: `🤖 ${n}` }))
      .map((b) => [rand(), b])
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b);
    this.roster = [];
    this.seq = 0;
    this.crash = { roundId: null, bets: new Map(), timers: [] };
    this.dbl = { roundId: null, bets: new Map(), timers: [] };
    this.rl = { roundId: null, bets: new Map(), timers: [] };
    this.soloTimer = null;
    this.chatTimer = null;
    this.lastChat = 0;
    this.pending = new Map();
    this.doubleStreak = { color: null, n: 0 };
    this.recentPhrases = []; // para no repetir la misma frase seguido
  }

  // ───────────────────────── Arranque y configuración ─────────────────────────

  start() {
    this.syncRoster();
    this.bus.on('settings', () => this._safe(() => this.syncRoster()));
    this.engine.on('betting', (d) => this._safe(() => this._crashBetting(d)));
    this.engine.on('start', (d) => this._safe(() => this._crashStart(d)));
    this.engine.on('crash', (d) => this._safe(() => this._crashEnd(d)));
    this.engine.on('paused', (d) => this._safe(() => this._crashPaused(d)));
    this.double.on('betting', (d) => this._safe(() => this._doubleBetting(d)));
    this.double.on('spin', () => this._safe(() => this._clearTimers(this.dbl)));
    this.double.on('result', (d) => this._safe(() => this._doubleResult(d)));
    this.double.on('refund', () => this._safe(() => this._doubleRefund()));
    this.roulette.on('betting', (d) => this._safe(() => this._rouletteBetting(d)));
    this.roulette.on('spin', () => this._safe(() => this._clearTimers(this.rl)));
    this.roulette.on('result', (d) => this._safe(() => this._rouletteResult(d)));
    this.roulette.on('refund', () => this._safe(() => this._rouletteRefund()));
    this.bus.on('bigwin', (w) => this._safe(() => this._cheer(w)));
    this._scheduleSolo();
    this._scheduleChat();
    this.flushTimer = setInterval(() => this._safe(() => this.flush()), 10_000);
    this.flushTimer.unref();
  }

  _safe(fn) {
    try {
      fn();
    } catch (err) {
      this.log('❌ Error en los bots:', err);
    }
  }

  get enabled() {
    return !!this.settings.get('bots_enabled') && this.roster.length > 0;
  }

  activeCount() {
    return this.settings.get('bots_enabled') ? this.roster.length : 0;
  }

  /** Ajusta la cantidad de bots en la sala según la configuración. */
  syncRoster() {
    const want = this.settings.get('bots_enabled') ? Math.max(0, Math.min(this.pool.length, this.settings.get('bots_count'))) : 0;
    if (want === this.roster.length) return;
    const joined = this.pool.slice(this.roster.length, want);
    this.roster = this.pool.slice(0, want);
    if (!want) {
      this._clearTimers(this.crash);
      this._clearTimers(this.dbl);
      this._clearTimers(this.rl);
    }
    this.emit('online', this.roster.length);
    // Uno de los que llegan saluda
    if (joined.length) setTimeout(() => this._say(pick(joined), this._phrase(CHAT.hello)), between(1500, 5000));
  }

  _clearTimers(slot) {
    for (const t of slot.timers) clearTimeout(t);
    slot.timers = [];
  }

  /** Monto de una apuesta de bot: redondo, entre la mínima y el máximo para bots, casi siempre chico. */
  _amount(scale = 1) {
    const min = this.settings.get('min_bet');
    const max = Math.max(min, Math.min(this.settings.get('max_bet'), this.settings.get('bots_max_bet')));
    const lo = Math.log(min);
    const hi = Math.log(max);
    let v = Math.exp(lo + Math.pow(rand(), 1.7) * (hi - lo)) * scale;
    const step = v < 10000 ? 1000 : v < 50000 ? 5000 : v < 200000 ? 10000 : 50000;
    v = Math.round(v / step) * step;
    return Math.max(min, Math.min(max, v));
  }

  _record(game, plays, bet, payout) {
    if (!plays) return;
    const key = `${localDay()}|${game}`;
    const p = this.pending.get(key) || { plays: 0, bet: 0, payout: 0 };
    p.plays += plays;
    p.bet += bet;
    p.payout += payout;
    this.pending.set(key, p);
  }

  /** Guarda los resultados acumulados de los bots (tabla aparte, nunca las tablas reales). */
  flush() {
    if (!this.pending.size) return;
    const items = [...this.pending];
    this.pending.clear();
    this.db.tx(() => {
      for (const [key, p] of items) {
        const [day, game] = key.split('|');
        this.db.run(
          `INSERT INTO bot_stats (day, game, plays, bet, payout) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(day, game) DO UPDATE SET plays = plays + excluded.plays, bet = bet + excluded.bet, payout = payout + excluded.payout`,
          day,
          game,
          p.plays,
          p.bet,
          p.payout,
        );
      }
    });
  }

  // ───────────────────────── 🚀 Crash ─────────────────────────

  _crashBetting({ roundId, ms }) {
    this._clearTimers(this.crash);
    this.crash.roundId = roundId;
    this.crash.bets = new Map();
    if (!this.enabled) return;
    const share = between(0.35, 0.8);
    for (const bot of this.roster) {
      if (!chance(share)) continue;
      const slots = chance(0.12) ? [0, 1] : [0];
      for (const slot of slots) {
        const at = between(250, Math.max(400, ms - 450));
        this.crash.timers.push(setTimeout(() => this._safe(() => this._crashPlace(bot, slot, roundId)), at));
      }
    }
  }

  _crashPlace(bot, slot, roundId) {
    const r = this.engine.round;
    if (!this.enabled || this.engine.phase !== 'BETTING' || !r || r.id !== roundId) return;
    const bet = {
      id: `b${++this.seq}`,
      uid: bot.uid,
      user: bot.name,
      slot,
      amount: this._amount(),
      status: 'active',
      cashout: null,
      payout: 0,
      bot: true,
      target: crashTarget(),
      who: bot,
    };
    this.crash.bets.set(bet.id, bet);
    this.emit('crash:bet', this._crashPublic(bet));
  }

  _crashStart({ roundId, growth }) {
    this._clearTimers(this.crash);
    if (roundId !== this.crash.roundId) return;
    for (const bet of this.crash.bets.values()) {
      if (bet.status !== 'active') continue;
      const ms = Math.ceil(msForMultiplier(bet.target, growth));
      this.crash.timers.push(setTimeout(() => this._safe(() => this._crashCashout(bet, roundId)), ms));
    }
  }

  /** El bot "retira" al llegar a su multiplicador. Si el cohete explota antes, el temporizador se cancela y pierde. */
  _crashCashout(bet, roundId) {
    const r = this.engine.round;
    if (bet.status !== 'active' || this.engine.phase !== 'RUNNING' || !r || r.id !== roundId) return;
    bet.status = 'won';
    bet.cashout = bet.target;
    bet.payout = Math.floor((bet.amount * bet.target) / 100);
    this.emit('crash:cashout', { id: bet.id, uid: bet.uid, user: bet.user, slot: bet.slot, amount: bet.amount, cashout: bet.cashout, payout: bet.payout, bot: true });
    if (bet.target >= 1000 && chance(0.35)) setTimeout(() => this._say(bet.who, fill(this._phrase(CHAT.myCashout), { m: fmtMult(bet.target) })), between(800, 2500));
  }

  _crashEnd(d) {
    this._clearTimers(this.crash);
    if (d.roundId !== this.crash.roundId) return;
    let plays = 0;
    let bet = 0;
    let payout = 0;
    for (const b of this.crash.bets.values()) {
      if (b.status === 'active') b.status = d.cancelled ? 'refunded' : 'lost';
      if (b.status === 'refunded') continue;
      plays++;
      bet += b.amount;
      payout += b.payout;
    }
    this._record('crash', plays, bet, payout);
    if (!d.cancelled && this.enabled) {
      if (d.crash <= 110 && chance(0.3)) setTimeout(() => this._say(pick(this.roster), this._phrase(CHAT.crashLow)), between(700, 2200));
      else if (d.crash >= 1000 && chance(0.45)) setTimeout(() => this._say(pick(this.roster), fill(this._phrase(CHAT.crashHigh), { m: fmtMult(d.crash) })), between(700, 2200));
    }
  }

  _crashPaused(d) {
    if (!d.paused || d.phase !== 'PAUSED') return;
    this._clearTimers(this.crash);
    for (const b of this.crash.bets.values()) {
      if (b.status !== 'active') continue;
      b.status = 'refunded';
      this.emit('crash:refund', { id: b.id, uid: b.uid, slot: b.slot });
    }
  }

  _crashPublic(b) {
    return { id: b.id, uid: b.uid, user: b.user, slot: b.slot, amount: b.amount, status: b.status, cashout: b.cashout, payout: b.payout, bot: true };
  }

  /** Apuestas de bots de la ronda actual del Crash (para quien recién se conecta). */
  crashBets() {
    const r = this.engine.round;
    if (!r || r.id !== this.crash.roundId) return [];
    return [...this.crash.bets.values()].filter((b) => b.status !== 'refunded').map((b) => this._crashPublic(b));
  }

  // ───────────────────────── 🎡 Double ─────────────────────────

  _doubleBetting({ roundId, ms }) {
    this._clearTimers(this.dbl);
    this.dbl.roundId = roundId;
    this.dbl.bets = new Map();
    if (!this.enabled) return;
    const share = between(0.3, 0.75);
    for (const bot of this.roster) {
      if (!chance(share)) continue;
      const color = weighted([
        ['red', 46],
        ['black', 46],
        ['white', 8],
      ]);
      const times = chance(0.2) ? 2 : 1;
      for (let k = 0; k < times; k++) {
        const at = between(400, Math.max(600, ms - 700));
        this.dbl.timers.push(setTimeout(() => this._safe(() => this._doublePlace(bot, color, roundId)), at));
      }
    }
  }

  _doublePlace(bot, color, roundId) {
    const r = this.double.round;
    if (!this.enabled || this.double.phase !== 'BETTING' || !r || r.id !== roundId) return;
    const key = `${bot.uid}:${color}`;
    let b = this.dbl.bets.get(key);
    if (!b) {
      b = { id: `b${++this.seq}`, uid: bot.uid, user: bot.name, color, amount: 0, status: 'active', payout: 0, bot: true };
      this.dbl.bets.set(key, b);
    }
    b.amount += this._amount(color === 'white' ? 0.3 : 1);
    this.emit('double:bet', { ...b });
  }

  _doubleResult({ roundId, color }) {
    if (roundId !== this.dbl.roundId) return;
    const pays = core.DOUBLE_PAYS[color];
    let plays = 0;
    let bet = 0;
    let payout = 0;
    for (const b of this.dbl.bets.values()) {
      plays++;
      bet += b.amount;
      if (b.color === color) {
        b.status = 'won';
        b.payout = Math.floor((b.amount * pays) / 100);
        payout += b.payout;
      } else b.status = 'lost';
    }
    this._record('double', plays, bet, payout);
    // Rachas y blanco → algún comentario
    if (this.doubleStreak.color === color) this.doubleStreak.n++;
    else this.doubleStreak = { color, n: 1 };
    if (!this.enabled) return;
    if (color === 'white' && chance(0.55)) setTimeout(() => this._say(pick(this.roster), this._phrase(CHAT.white)), between(900, 2500));
    else if (color !== 'white' && this.doubleStreak.n >= 4 && chance(0.3)) {
      const names = { red: 'rojos', black: 'negros' };
      setTimeout(() => this._say(pick(this.roster), fill(this._phrase(CHAT.streak), { n: this.doubleStreak.n, c: names[color] })), between(900, 2500));
    }
  }

  _doubleRefund() {
    this._clearTimers(this.dbl);
    this.dbl.bets = new Map();
  }

  doubleBets() {
    const r = this.double.round;
    if (!r || r.id !== this.dbl.roundId) return [];
    return [...this.dbl.bets.values()].map((b) => ({ ...b }));
  }

  // ───────────────────────── 🎰 Ruleta ─────────────────────────

  _rouletteBetting({ roundId, ms }) {
    this._clearTimers(this.rl);
    this.rl.roundId = roundId;
    this.rl.bets = new Map();
    if (!this.enabled) return;
    const share = between(0.25, 0.6);
    for (const bot of this.roster) {
      if (!chance(share)) continue;
      const times = weighted([
        [1, 70],
        [2, 22],
        [3, 8],
      ]);
      for (let k = 0; k < times; k++) {
        const at = between(500, Math.max(700, ms - 900));
        this.rl.timers.push(setTimeout(() => this._safe(() => this._roulettePlace(bot, roundId)), at));
      }
    }
  }

  _roulettePlace(bot, roundId) {
    const r = this.roulette.round;
    if (!this.enabled || this.roulette.phase !== 'BETTING' || !r || r.id !== roundId) return;
    const add = rouletteSpots().map((s) => ({ type: s.type, value: s.value, amount: this._amount(s.scale) }));
    const extra = add.reduce((t, s) => t + s.amount, 0);
    let b = this.rl.bets.get(bot.uid);
    if (b && b.amount + extra > this.settings.get('max_bet')) return;
    if (!b) {
      b = { id: `b${++this.seq}`, uid: bot.uid, user: bot.name, amount: 0, bets: [], status: 'active', payout: 0, bot: true };
      this.rl.bets.set(bot.uid, b);
    }
    for (const s of add) {
      const same = b.bets.find((x) => x.type === s.type && x.value === s.value);
      if (same) same.amount += s.amount;
      else b.bets.push(s);
    }
    b.amount += extra;
    this.emit('roulette:bet', this._roulettePublic(b));
  }

  _rouletteResult({ roundId, result }) {
    if (roundId !== this.rl.roundId) return;
    const maxProfit = this.settings.get('max_profit');
    let plays = 0;
    let bet = 0;
    let payout = 0;
    let pleno = null;
    for (const b of this.rl.bets.values()) {
      plays++;
      bet += b.amount;
      b.payout = Math.min(core.roulettePayout(b.bets, result), b.amount + maxProfit);
      b.status = b.payout > 0 ? 'won' : 'lost';
      payout += b.payout;
      if (!pleno && b.bets.some((s) => s.type === 'n' && s.value === result)) pleno = b;
    }
    this._record('roulette', plays, bet, payout);
    if (!this.enabled) return;
    if (pleno && chance(0.5)) {
      const bot = this.roster.find((x) => x.uid === pleno.uid);
      setTimeout(() => this._say(bot, fill(this._phrase(CHAT.pleno), { n: result })), between(1200, 3000));
    } else if (result === 0 && chance(0.35)) {
      setTimeout(() => this._say(pick(this.roster), this._phrase(CHAT.zero)), between(1200, 3000));
    }
  }

  _rouletteRefund() {
    this._clearTimers(this.rl);
    this.rl.bets = new Map();
  }

  _roulettePublic(b) {
    return { id: b.id, uid: b.uid, user: b.user, amount: b.amount, bets: b.bets.map((s) => ({ ...s })), status: b.status, payout: b.payout, bot: true };
  }

  rouletteBets() {
    const r = this.roulette.round;
    if (!r || r.id !== this.rl.roundId) return [];
    return [...this.rl.bets.values()].map((b) => this._roulettePublic(b));
  }

  // ───────────────────────── 💣 ⚽ 🔴 Juegos individuales ─────────────────────────

  _scheduleSolo() {
    clearTimeout(this.soloTimer);
    const n = this.enabled ? this.roster.length : 0;
    const delay = n ? between(2500, 7500) * Math.min(2.5, Math.max(0.25, 12 / n)) : 5000;
    this.soloTimer = setTimeout(() => {
      this._safe(() => this._soloPlay());
      this._scheduleSolo();
    }, delay);
    this.soloTimer.unref();
  }

  /** Un bot juega una partida con el mismo azar que un jugador real y aparece en "jugadas en vivo". */
  _soloPlay() {
    if (!this.enabled) return;
    const options = [
      ['plinko', 42],
      ['mines', 34],
      ['penalty', 24],
    ].filter(([g]) => this.settings.get('game_' + g) !== false);
    if (!options.length) return;
    const game = weighted(options);
    const bot = pick(this.roster);
    const amount = this._amount();
    let multiplier = 0;
    let payout = 0;
    if (game === 'plinko') {
      const rows = pick(core.PLINKO_ROWS);
      const risk = weighted([
        ['low', 3],
        ['medium', 4],
        ['high', 2],
      ]);
      multiplier = core.plinkoResult(floats(rows), rows, risk).multiplier;
    } else if (game === 'mines') {
      const mines = pick([1, 2, 3, 3, 3, 5, 5, 8, 10]);
      const want = 1 + Math.floor(rand() * Math.min(6, 25 - mines));
      const bombs = new Set(core.minesPositions(floats(24), mines));
      const tiles = shuffle([...Array(25).keys()]);
      const hit = tiles.slice(0, want).some((t) => bombs.has(t));
      multiplier = hit ? 0 : core.minesMultiplier(mines, want);
    } else {
      const want = pick([1, 1, 2, 2, 2, 3, 3, 4, 5]);
      const keepers = core.penaltyKeepers(floats(core.PENALTY_KICKS));
      let saved = false;
      for (let k = 0; k < want && !saved; k++) if (Math.floor(rand() * 3) === keepers[k]) saved = true;
      multiplier = saved ? 0 : core.penaltyMultiplier(want);
    }
    payout = Math.floor((amount * multiplier) / 100);
    const cap = amount + this.settings.get('max_profit');
    if (payout > cap) {
      payout = cap;
      multiplier = Math.floor((payout * 100) / amount);
    }
    this.bus.emit('feed', { game, user: bot.name, amount, multiplier, payout, ts: Date.now(), bot: true });
    this._record(game, 1, amount, payout);
    if (multiplier >= 1000 && chance(0.35)) setTimeout(() => this._say(bot, fill(this._phrase(CHAT.soloWin[game]), { m: fmtMult(multiplier) })), between(1200, 3000));
  }

  // ───────────────────────── 💬 Chat ─────────────────────────

  _scheduleChat() {
    clearTimeout(this.chatTimer);
    const n = this.enabled ? this.roster.length : 0;
    const delay = n ? between(30000, 75000) * Math.sqrt(12 / Math.max(3, n)) : 8000;
    this.chatTimer = setTimeout(() => {
      if (this.enabled) this._say(pick(this.roster), this._phrase(CHAT.generic));
      this._scheduleChat();
    }, delay);
    this.chatTimer.unref();
  }

  /** Una frase al azar que no se haya dicho hace poco (así el chat no se repite). */
  _phrase(list) {
    const fresh = list.filter((t) => !this.recentPhrases.includes(t));
    const text = pick(fresh.length ? fresh : list);
    this.recentPhrases.push(text);
    if (this.recentPhrases.length > 14) this.recentPhrases.shift();
    return text;
  }

  _canChat() {
    return this.enabled && !!this.settings.get('bots_chat') && !!this.settings.get('chat_enabled') && Date.now() - this.lastChat > 9000;
  }

  _say(bot, text) {
    if (!bot || !this._canChat() || !this.roster.includes(bot)) return;
    this.lastChat = Date.now();
    this._safe(() => this.chat.bot(bot.name, text));
  }

  /** De vez en cuando un bot felicita a un jugador real que ganó mucho. */
  _cheer(w) {
    if (!this.enabled || !w.user || chance(0.8)) return;
    setTimeout(() => this._say(pick(this.roster), fill(this._phrase(CHAT.cheer), { u: w.user })), between(1500, 4000));
  }

  // ───────────────────────── Informe para el admin ─────────────────────────

  report() {
    this.flush();
    const agg = (where, ...params) => {
      const rows = this.db.all(`SELECT game, SUM(plays) AS plays, SUM(bet) AS bet, SUM(payout) AS payout FROM bot_stats ${where} GROUP BY game`, ...params);
      const games = {};
      for (const g of GAMES) games[g] = { plays: 0, bet: 0, payout: 0, result: 0 };
      const total = { plays: 0, bet: 0, payout: 0, result: 0 };
      for (const r of rows) {
        games[r.game] = { plays: r.plays, bet: r.bet, payout: r.payout, result: r.payout - r.bet };
        total.plays += r.plays;
        total.bet += r.bet;
        total.payout += r.payout;
      }
      total.result = total.payout - total.bet;
      return { games, total };
    };
    const daily = this.db
      .all('SELECT day, SUM(plays) AS plays, SUM(bet) AS bet, SUM(payout) AS payout FROM bot_stats WHERE day >= ? GROUP BY day ORDER BY day', localDay(-13))
      .map((r) => ({ ...r, result: r.payout - r.bet }));
    return {
      enabled: !!this.settings.get('bots_enabled'),
      count: this.settings.get('bots_count'),
      chat: !!this.settings.get('bots_chat'),
      maxBet: this.settings.get('bots_max_bet'),
      online: this.roster.map((b) => b.name),
      periods: { today: agg('WHERE day = ?', localDay()), week: agg('WHERE day >= ?', localDay(-6)), all: agg('') },
      daily,
    };
  }

  shutdown() {
    this._safe(() => this.flush());
  }
}

module.exports = { BotManager, BOT_NAMES: NAMES };
