// Bots: jugadores de la sala marcados con 🤖 que animan con plata ficticia. Sus números van aparte.
import { h, toast, fmtGs, fmtNum, fmtSigned, parseAmount } from './shared.js';
import {
  call,
  post,
  icon,
  scope,
  card,
  viewHead,
  refreshBtn,
  segmented,
  moneyInput,
  adorn,
  field,
  notifyError,
  emptyState,
  errorState,
  loadingState,
  signClass,
  plural,
  GAME_META,
  GAME_ORDER,
} from './admin-core.js';

const PERIODS = [
  ['today', 'Hoy'],
  ['week', '7 días'],
  ['all', 'Total'],
];
let period = 'today';

function explainCard() {
  const li = (...c) => h('li', null, ...c);
  return card(
    'Cómo funcionan',
    { icon: 'book', cls: 'bots-how' },
    h(
      'ul',
      { class: 'bots-list' },
      li(h('b', null, 'Siempre se ven como bots: '), 'su nombre empieza con 🤖 y en el chat llevan la etiqueta BOT. Nadie los confunde con un jugador real.'),
      li(h('b', null, 'Plata ficticia: '), 'no tienen saldo real, no depositan ni retiran y no tocan la caja ni el libro contable.'),
      li(h('b', null, 'Mismas probabilidades que todos: '), 'juegan Crash, Double, Minas, Penales, Plinko y Ruleta con la misma matemática, y no cambian ningún resultado real.'),
      li(h('b', null, 'Fuera de las estadísticas: '), 'el inicio, los gráficos, el Top y las jugadas del panel muestran solo lo real. Lo de los bots está únicamente acá abajo.'),
      li(h('b', null, 'Chat tranquilo: '), 'comentan el juego de vez en cuando; nunca hablan de depósitos o retiros ni empujan a nadie a apostar.'),
    ),
  );
}

function settingsCard(getReport, reload) {
  const enabled = h('input', { type: 'checkbox' });
  const chat = h('input', { type: 'checkbox' });
  const count = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off' });
  const minus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Menos bots' }, icon('minus', 15));
  const plus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Más bots' }, icon('plus', 15));
  const maxBet = moneyInput(0);
  const save = h('button', { type: 'button', class: 'btn btn-primary' }, icon('check', 16), 'Guardar');
  const online = h('div', { class: 'bots-online' });
  const status = h('span', { class: 'chip' });
  let original = null;

  const values = () => ({
    bots_enabled: enabled.checked,
    bots_chat: chat.checked,
    bots_count: Math.max(1, Math.min(40, parseInt(count.value, 10) || 1)),
    bots_max_bet: parseAmount(maxBet.value) || 0,
  });
  const dirty = () => original && JSON.stringify(values()) !== JSON.stringify(original);
  const refresh = () => {
    save.disabled = !dirty();
  };
  for (const el of [enabled, chat]) el.addEventListener('change', refresh);
  for (const el of [count, maxBet]) el.addEventListener('input', refresh);
  minus.addEventListener('click', () => {
    count.value = String(Math.max(1, (parseInt(count.value, 10) || 1) - 1));
    refresh();
  });
  plus.addEventListener('click', () => {
    count.value = String(Math.min(40, (parseInt(count.value, 10) || 0) + 1));
    refresh();
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await post('/api/admin/settings', values());
      toast(values().bots_enabled ? `Hay ${values().bots_count} bots en la sala 🤖` : 'Los bots salieron de la sala', 'success', '🤖 Bots');
      await reload();
    } catch (err) {
      notifyError(err);
      refresh();
    }
  });

  const render = () => {
    const r = getReport();
    if (!r) return;
    original = { bots_enabled: r.enabled, bots_chat: r.chat, bots_count: r.count, bots_max_bet: r.maxBet };
    enabled.checked = r.enabled;
    chat.checked = r.chat;
    count.value = String(r.count);
    maxBet.value = fmtNum(r.maxBet);
    status.className = `chip ${r.enabled ? 'chip-green' : ''}`;
    status.textContent = r.enabled ? `${plural(r.online.length, 'bot', 'bots')} en la sala` : 'Apagados';
    online.replaceChildren(...(r.online.length ? r.online.map((n) => h('span', { class: 'chip chip-purple' }, n)) : [h('span', { class: 'faint' }, 'No hay bots en la sala.')]));
    refresh();
  };

  const el = card(
    'Bots en la sala',
    { icon: 'bot', cls: 'bots-cfg', actions: status },
    h(
      'div',
      { class: 'bots-form' },
      h('label', { class: 'switch switch-row' }, enabled, h('span', { class: 'track' }), h('span', { class: 'switch-text' }, 'Bots activos')),
      h('label', { class: 'switch switch-row' }, chat, h('span', { class: 'track' }), h('span', { class: 'switch-text' }, 'Comentan en el chat')),
      field('Cantidad de bots (1 a 40)', h('div', { class: 'bots-count' }, minus, count, plus)),
      field('Apuesta máxima de un bot', adorn(maxBet, 'Gs.'), 'Plata ficticia. Igual respeta la apuesta mínima y máxima del casino.'),
      h('div', { class: 'bots-save' }, save),
    ),
    h('div', { class: 'bots-sub' }, 'En la sala ahora'),
    online,
  );
  return { el, render };
}

function resultsCard(getReport) {
  const body = h('div', null, loadingState());
  const seg = segmented(PERIODS, period, (p) => {
    period = p;
    render();
  });
  const el = card('Resultados de los bots (plata ficticia)', { icon: 'chart', cls: 'bots-results', actions: seg }, body);
  const render = () => {
    const r = getReport();
    if (!r) return;
    const p = r.periods[period];
    if (!p.total.plays) {
      body.replaceChildren(emptyState(r.enabled ? 'Todavía no jugaron en este período.' : 'Prendé los bots para verlos jugar.', '🤖'));
      return;
    }
    const row = (label, g, cls = '') =>
      h(
        'tr',
        { class: cls },
        h('td', null, label),
        h('td', { class: 'num' }, fmtNum(g.plays)),
        h('td', { class: 'num' }, fmtGs(g.bet)),
        h('td', { class: 'num' }, fmtGs(g.payout)),
        h('td', { class: `num ${signClass(g.result)}` }, fmtSigned(g.result)),
        h('td', { class: 'num' }, g.bet ? `${((g.payout / g.bet) * 100).toFixed(1).replace('.', ',')}%` : '—'),
      );
    body.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table bots-table' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, 'Juego'), h('th', { class: 'num' }, 'Jugadas'), h('th', { class: 'num' }, 'Apostado'), h('th', { class: 'num' }, 'Cobrado'), h('th', { class: 'num' }, 'Resultado'), h('th', { class: 'num' }, 'Retorno')),
          ),
          h(
            'tbody',
            null,
            ...GAME_ORDER.filter((g) => p.games[g] && p.games[g].plays).map((g) => row(`${GAME_META[g].icon} ${GAME_META[g].name}`, p.games[g])),
            row('Total', p.total, 'bots-total'),
          ),
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'Es plata ficticia: no suma ni resta en la caja. "Resultado de los bots" es lo que ganaron (+) o perdieron (−) jugando con las mismas probabilidades que un jugador real.',
      ),
      r.daily.length
        ? h(
            'div',
            { class: 'bots-daily' },
            h('div', { class: 'bots-sub' }, 'Últimos 14 días'),
            ...r.daily
              .slice()
              .reverse()
              .map((d) =>
                h(
                  'div',
                  { class: 'bots-day' },
                  h('span', null, d.day.split('-').reverse().slice(0, 2).join('/')),
                  h('span', { class: 'faint' }, plural(d.plays, 'jugada', 'jugadas')),
                  h('span', { class: `num ${signClass(d.result)}` }, fmtSigned(d.result)),
                ),
              ),
          )
        : null,
    );
  };
  return { el, render };
}

export const botsView = {
  sc: null,
  report: null,
  mount(el) {
    const sc = scope();
    this.sc = sc;
    const cfg = settingsCard(() => this.report, () => load());
    const results = resultsCard(() => this.report);
    const box = h('div', { class: 'bots-grid' }, cfg.el, results.el, explainCard());
    const load = async () => {
      try {
        this.report = await call('/api/admin/bots');
        cfg.render();
        results.render();
      } catch (err) {
        if (!this.report) box.replaceChildren(errorState(err, load));
        else notifyError(err);
      }
    };
    sc.interval(async () => {
      try {
        this.report = await call('/api/admin/bots');
        results.render();
      } catch {
        /* se reintenta en la próxima vuelta */
      }
    }, 10_000);
    el.append(viewHead('Bots 🤖', 'Jugadores de la sala, siempre marcados con 🤖, que le dan vida al casino con plata ficticia.', refreshBtn(load)), box);
    load();
  },
  unmount() {
    this.sc?.dispose();
    this.sc = null;
  },
};
