// Configuración (formulario generado desde el esquema del servidor), respaldos y provably fair.
import { h, toast, confirmDialog, fmtGs, fmtNum, fmtDate, parseAmount } from './shared.js';
import {
  call,
  post,
  icon,
  scope,
  card,
  viewHead,
  refreshBtn,
  dataTable,
  emptyState,
  errorState,
  loadingState,
  moneyInput,
  adorn,
  field,
  notifyError,
  copyBtn,
  fmtPct,
  plural,
} from './admin-core.js';

// ───────────────────────── Esquema de la configuración ─────────────────────────

const GROUPS = [
  { title: 'Apuestas (todos los juegos)', icon: 'wallet', keys: ['min_bet', 'max_bet', 'max_profit', 'quick_amounts'] },
  {
    title: 'Juegos',
    icon: 'gamepad',
    keys: ['game_mines', 'game_penalty', 'game_double', 'game_plinko', 'game_roulette', 'betting_seconds', 'speed', 'double_betting_seconds', 'roulette_betting_seconds'],
  },
  {
    title: 'Depósitos y retiros',
    icon: 'wallet',
    keys: ['min_deposit', 'min_withdraw', 'max_withdraw', 'bank_name', 'bank_holder', 'bank_doc', 'bank_account', 'bank_alias', 'bank_notes', 'support_whatsapp'],
  },
  { title: 'Comunidad', icon: 'chat', keys: ['site_name', 'banner', 'chat_enabled', 'bigwin_multiplier', 'bigwin_amount', 'signup_bonus'] },
  { title: 'Bots 🤖', icon: 'bot', keys: ['bots_enabled', 'bots_count', 'bots_chat', 'bots_max_bet'] },
];

const MONEY = new Set(['min_bet', 'max_bet', 'max_profit', 'min_deposit', 'min_withdraw', 'max_withdraw', 'bigwin_amount', 'signup_bonus', 'bots_max_bet']);
const TEXTAREA = new Set(['bank_notes', 'banner']);
const SUFFIX = { betting_seconds: 'seg.', double_betting_seconds: 'seg.', roulette_betting_seconds: 'seg.', speed: 'x', bigwin_multiplier: 'x' };
const PLACEHOLDER = {
  quick_amounts: '2000,5000,10000,50000',
  bank_name: 'Ej: Banco Itaú',
  bank_holder: 'Nombre y apellido del titular',
  bank_doc: 'Ej: 1.234.567',
  bank_account: 'Ej: 123456789',
  bank_alias: 'Ej: 0981123456 o tu alias',
  support_whatsapp: 'Ej: 595981123456',
  banner: 'Ej: 🔥 Bono del 20% en tu primer depósito',
};

const HINTS = {
  min_bet: 'Monto mínimo por apuesta (en la Ruleta, por cada tanda de fichas que se confirma).',
  max_bet: 'Monto máximo por apuesta (en el Double, por color y por ronda; en la Ruleta, el total de fichas de un jugador en la ronda).',
  max_profit: 'Ganancia máxima por apuesta o jugada. En el Crash y en Minas/Penales se cobra sola al llegar; en Plinko el premio se limita a este monto; en el Double y la Ruleta limita cuánto se puede apostar al blanco o a los plenos. Protege a la casa de pagos gigantes.',
  quick_amounts: 'Botones de monto rápido en los juegos, separados por coma.',
  betting_seconds: 'Crash: tiempo para apostar antes de cada despegue (de 3 a 30 segundos).',
  speed: 'Crash: 1 = normal (2x a los 11,5 s). 2 = el doble de rápido, 0,5 = la mitad. Se aplica desde la próxima ronda.',
  game_mines: 'Si lo apagás nadie puede empezar partidas nuevas; las que están en curso se pueden terminar.',
  game_penalty: 'Si lo apagás nadie puede empezar tandas nuevas; las que están en curso se pueden terminar.',
  game_double: 'Si lo apagás mientras se apuesta, se devuelven las apuestas de esa ronda.',
  game_plinko: 'Si lo apagás nadie puede soltar bolitas hasta que lo vuelvas a prender.',
  game_roulette: 'Si la apagás mientras se apuesta, se devuelven las fichas de esa ronda. Si está girando, la ronda termina normal.',
  double_betting_seconds: 'Double: tiempo para apostar antes de cada giro (de 5 a 30 segundos). Se aplica desde la próxima ronda.',
  roulette_betting_seconds: 'Ruleta en vivo: tiempo para poner fichas antes de cada giro (de 5 a 60 segundos). Se aplica desde la próxima ronda.',
  bots_enabled: 'Jugadores de la sala marcados con 🤖 que juegan con plata ficticia. No tocan la caja ni las estadísticas reales (ver Admin → Bots).',
  bots_count: 'Cuántos bots hay en la sala (de 1 a 40).',
  bots_chat: 'Comentan el juego de vez en cuando, siempre con la etiqueta BOT.',
  bots_max_bet: 'Apuesta máxima de un bot (plata ficticia).',
  min_deposit: 'Depósito mínimo que puede informar un jugador. 0 = sin mínimo.',
  min_withdraw: 'Retiro mínimo que puede pedir un jugador.',
  max_withdraw: 'Tope por pedido de retiro. 0 = sin límite.',
  bank_name: 'Estos datos los ve el jugador para transferirte.',
  bank_holder: 'Nombre del titular de la cuenta.',
  bank_doc: 'Cédula o RUC del titular.',
  bank_account: 'Número de cuenta (caja de ahorro o cuenta corriente).',
  bank_alias: 'Alias SIPAP para transferencias al toque.',
  bank_notes: 'Instrucciones extra para el jugador al depositar.',
  support_whatsapp: 'Número con código de país, sin espacios ni «+».',
  site_name: 'Nombre que aparece en el juego.',
  banner: 'Aviso que se muestra arriba en el juego. Vacío = sin aviso.',
  chat_enabled: 'Si lo apagás, solo los admins pueden escribir.',
  bigwin_multiplier: 'Los retiros desde este multiplicador se anuncian en el chat.',
  bigwin_amount: 'Las ganancias desde este monto se anuncian en el chat. 0 = no anunciar por monto.',
  signup_bonus: 'Saldo de regalo al registrarse. 0 = sin bono.',
};

const normText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const fmtDecimal = (v) => String(v ?? '').replace('.', ',');

function fmtLimit(key, def, v) {
  if (MONEY.has(key)) return fmtGs(v);
  if (def.type === 'float') return fmtDecimal(v);
  return fmtNum(v);
}

/** Crea el control de un ajuste. Devuelve { el, get, set, validate, dirty }. */
function buildSetting(key, def, value) {
  let input;
  let control;
  let get;
  let set;
  const errEl = h('div', { class: 'field-error' });
  if (def.type === 'bool') {
    input = h('input', { type: 'checkbox' });
    get = () => input.checked;
    set = (v) => {
      input.checked = !!v;
    };
    control = h('label', { class: 'switch switch-row' }, input, h('span', { class: 'track' }), h('span', { class: 'switch-text' }, def.label));
  } else if (def.type === 'int' && MONEY.has(key)) {
    input = moneyInput(value);
    get = () => parseAmount(input.value);
    set = (v) => {
      input.value = fmtNum(v);
    };
    control = adorn(input, 'Gs.');
  } else if (def.type === 'int') {
    input = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off' });
    get = () => {
      const t = input.value.replace(/[^\d-]/g, '');
      return t ? parseInt(t, 10) : NaN;
    };
    set = (v) => {
      input.value = String(v);
    };
    control = SUFFIX[key] ? adorn(input, null, SUFFIX[key]) : input;
  } else if (def.type === 'float') {
    input = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    get = () => {
      const t = input.value.trim().replace(',', '.');
      return t ? Number(t) : NaN;
    };
    set = (v) => {
      input.value = fmtDecimal(v);
    };
    control = SUFFIX[key] ? adorn(input, null, SUFFIX[key]) : input;
  } else {
    input = TEXTAREA.has(key)
      ? h('textarea', { class: 'input', rows: 3, maxlength: def.max || null, placeholder: PLACEHOLDER[key] || null })
      : h('input', { class: 'input', type: 'text', maxlength: def.max || null, placeholder: PLACEHOLDER[key] || null, autocomplete: 'off' });
    get = () => input.value;
    set = (v) => {
      input.value = v ?? '';
    };
    control = input;
  }
  set(value);
  input.id = `cfg-${key}`;

  const validate = () => {
    let msg = '';
    if (def.type === 'int' || def.type === 'float') {
      const n = get();
      if (!Number.isFinite(n)) msg = 'Ingresá un número válido';
      else if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        msg = `Tiene que estar entre ${fmtLimit(key, def, def.min)} y ${fmtLimit(key, def, def.max)}`;
      }
    }
    errEl.textContent = msg;
    wrap.classList.toggle('has-error', !!msg);
    return !msg;
  };
  let original = value;
  const dirty = () => {
    const v = get();
    if (def.type === 'str') return normText(v) !== normText(original);
    if (def.type === 'bool') return v !== !!original;
    return !(Number.isFinite(v) && v === original);
  };
  const hint = HINTS[key];
  const wrap =
    def.type === 'bool'
      ? h('div', { class: 'field cfg-field cfg-wide' }, control, hint ? h('div', { class: 'hint' }, hint) : null, errEl)
      : h(
          'div',
          { class: `field cfg-field${TEXTAREA.has(key) ? ' cfg-wide' : ''}` },
          h('label', { for: input.id }, def.label),
          control,
          hint ? h('div', { class: 'hint' }, hint) : null,
          errEl,
        );
  return {
    key,
    el: wrap,
    input,
    get,
    validate,
    dirty,
    value: () => (def.type === 'str' ? normText(get()) : get()),
    reset(v) {
      original = v;
      set(v);
      errEl.textContent = '';
      wrap.classList.remove('has-error');
      wrap.classList.remove('is-dirty');
    },
  };
}

// ───────────────────────── Respaldos ─────────────────────────

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('es-PY', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es-PY', { maximumFractionDigits: 1 })} MB`;
}

function backupsCard() {
  const list = h('div', { class: 'bk-list' }, loadingState());
  const meta = h('span', { class: 'acard-sub' });
  const create = h('button', { type: 'button', class: 'btn btn-blue' }, icon('plus', 16), 'Crear respaldo ahora');
  let showAll = false;
  let items = [];

  const row = (b, i) =>
    h(
      'div',
      { class: `bk-row${i === 0 ? ' is-latest' : ''}` },
      h('span', { class: 'bk-ic', 'aria-hidden': 'true' }, '💾'),
      h(
        'div',
        { class: 'bk-main' },
        h(
          'div',
          { class: 'bk-date' },
          h('b', null, fmtDate(b.mtime)),
          i === 0 ? h('span', { class: 'chip chip-green' }, 'Último') : null,
          h('span', { class: 'chip' }, /-manual/.test(b.file) ? 'Manual' : 'Automático'),
        ),
        h('div', { class: 'bk-file mono' }, b.file, h('span', { class: 'bk-size' }, ` · ${fmtSize(b.size)}`)),
      ),
      h('a', { class: 'btn btn-ghost btn-sm bk-dl', href: `/api/admin/backups/${encodeURIComponent(b.file)}`, download: b.file }, icon('arrowDown', 15), 'Descargar'),
    );

  const render = () => {
    if (!items.length) {
      list.replaceChildren(emptyState('Todavía no hay respaldos. Creá el primero ahora.', '💾'));
      return;
    }
    const shown = showAll ? items : items.slice(0, 5);
    const more =
      items.length > 5
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-sm btn-block',
              onclick: () => {
                showAll = !showAll;
                render();
              },
            },
            showAll ? 'Ver menos' : `Ver los ${items.length} respaldos`,
          )
        : null;
    list.replaceChildren(...shown.map(row), more || '');
  };

  const load = async () => {
    try {
      const r = await call('/api/admin/backups');
      items = r.items || [];
      if (r.everyHours) meta.textContent = `automático cada ${fmtDecimal(r.everyHours)} h`;
      render();
    } catch (err) {
      list.replaceChildren(errorState(err, load));
    }
  };

  create.addEventListener('click', async () => {
    create.disabled = true;
    create.classList.add('is-busy');
    try {
      const r = await post('/api/admin/backups');
      items = r.items || items;
      render();
      toast(`Se guardó ${r.file}`, 'success', '💾 Respaldo creado');
    } catch (err) {
      notifyError(err);
    } finally {
      create.disabled = false;
      create.classList.remove('is-busy');
    }
  });
  load();

  return card(
    '💾 Respaldos',
    { cls: 'cfg-backups', actions: meta },
    h(
      'p',
      { class: 'bk-hint' },
      'Guardá una copia en otro lugar (pendrive / Google Drive). Con este archivo se recupera todo: saldos, apuestas y movimientos.',
    ),
    h('div', { class: 'bk-actions' }, create),
    list,
  );
}

// ───────────────────────── Vista de configuración ─────────────────────────

export const settingsView = {
  sc: null,
  mount(el) {
    const sc = scope();
    this.sc = sc;
    const formBox = h('div', { class: 'cfg-form' }, loadingState('Cargando configuración…'));
    const count = h('span', { class: 'save-count' });
    const err = h('div', { class: 'save-error', role: 'alert' });
    const discard = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Descartar');
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, icon('check', 17), 'Guardar cambios');
    const bar = h('div', { class: 'save-bar', hidden: true }, h('div', { class: 'save-text' }, count, err), h('div', { class: 'save-actions' }, discard, save));
    let fields = [];
    let values = {};

    const refreshDirty = () => {
      let n = 0;
      for (const f of fields) {
        const d = f.dirty();
        f.el.classList.toggle('is-dirty', d);
        if (d) n++;
      }
      bar.hidden = n === 0;
      count.textContent = n === 1 ? 'Tenés 1 cambio sin guardar' : `Tenés ${n} cambios sin guardar`;
      if (!n) err.textContent = '';
      return n;
    };

    const build = (data) => {
      values = data.values;
      const schema = data.schema;
      fields = [];
      const used = new Set();
      const groupCards = GROUPS.map((g) => {
        const items = g.keys.filter((k) => schema[k]).map((k) => {
          used.add(k);
          const f = buildSetting(k, schema[k], values[k]);
          fields.push(f);
          return f.el;
        });
        return card(g.title, { icon: g.icon, cls: 'cfg-card' }, h('div', { class: 'cfg-grid' }, items));
      });
      const rest = Object.keys(schema).filter((k) => !used.has(k));
      if (rest.length) {
        groupCards.push(
          card(
            'Otros',
            { icon: 'sliders', cls: 'cfg-card' },
            h(
              'div',
              { class: 'cfg-grid' },
              rest.map((k) => {
                const f = buildSetting(k, schema[k], values[k]);
                fields.push(f);
                return f.el;
              }),
            ),
          ),
        );
      }
      formBox.replaceChildren(...groupCards);
      for (const f of fields) {
        f.input.addEventListener('input', refreshDirty);
        f.input.addEventListener('change', () => {
          f.validate();
          refreshDirty();
        });
        f.input.addEventListener('blur', () => f.validate());
      }
      refreshDirty();
    };

    const load = async () => {
      try {
        build(await call('/api/admin/settings'));
      } catch (e) {
        formBox.replaceChildren(errorState(e, load));
      }
    };

    discard.addEventListener('click', () => {
      for (const f of fields) f.reset(values[f.key]);
      refreshDirty();
    });

    save.addEventListener('click', async () => {
      const changed = fields.filter((f) => f.dirty());
      if (!changed.length) return;
      const bad = changed.filter((f) => !f.validate());
      if (bad.length) {
        err.textContent = 'Revisá los campos marcados en rojo';
        bad[0].input.focus();
        return;
      }
      const patch = Object.fromEntries(changed.map((f) => [f.key, f.value()]));
      save.disabled = true;
      save.classList.add('is-busy');
      err.textContent = '';
      try {
        const r = await post('/api/admin/settings', patch);
        values = r.values;
        for (const f of fields) f.reset(values[f.key]);
        refreshDirty();
        const n = (r.changed || []).length;
        toast(n ? `Se guardaron ${plural(n, 'cambio', 'cambios')}` : 'No había nada para cambiar', 'success', '⚙️ Configuración');
      } catch (e) {
        err.textContent = e.message;
        notifyError(e);
      } finally {
        save.disabled = false;
        save.classList.remove('is-busy');
      }
    });

    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !bar.hidden) {
        e.preventDefault();
        save.click();
      }
    };
    document.addEventListener('keydown', onKey);
    sc.add(() => document.removeEventListener('keydown', onKey));

    el.append(
      viewHead('Configuración', 'Límites del juego, datos bancarios, comunidad y respaldos.'),
      formBox,
      backupsCard(),
      bar,
    );
    load();
  },
  unmount() {
    this.sc?.dispose();
    this.sc = null;
  },
};

// ───────────────────────── Provably fair ─────────────────────────

const edgePct = (bps) => fmtPct(bps / 100, 2);
const rtpPct = (bps) => fmtPct(100 - bps / 100, 2);

function hashRow(label, value) {
  return h('div', { class: 'hash-row' }, h('div', { class: 'hash-label' }, label), h('div', { class: 'hash-value' }, h('code', { class: 'mono' }, value || '—'), value ? copyBtn(value, `Copiar ${label.toLowerCase()}`) : null));
}

function currentChainCard(c) {
  const used = Math.min(c.used, c.length);
  const pct = c.length ? (used / c.length) * 100 : 0;
  return card(
    `Cadena activa #${c.chainId}`,
    { icon: 'shield', cls: 'fair-current', actions: h('span', { class: 'chip chip-green' }, 'Activa') },
    h(
      'div',
      { class: 'fair-stats' },
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Ventaja de la casa'), h('div', { class: 'fair-big gold' }, edgePct(c.houseEdgeBps))),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'RTP para los jugadores'), h('div', { class: 'fair-big green' }, rtpPct(c.houseEdgeBps))),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Rondas usadas'), h('div', { class: 'fair-big' }, fmtNum(used)), h('div', { class: 'tile-sub' }, `de ${fmtNum(c.length)}`)),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Creada'), h('div', { class: 'fair-date' }, fmtDate(c.createdAt))),
    ),
    h(
      'div',
      { class: 'fair-progress' },
      h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(c.length), 'aria-valuenow': String(used), 'aria-label': 'Rondas usadas de la cadena' }, h('div', { class: 'meter-fill', style: `width:${Math.max(0.5, pct).toFixed(2)}%` })),
      h('div', { class: 'meter-legend' }, h('span', null, `${fmtPct(pct, pct < 1 ? 2 : 1)} usada`), h('span', null, `Quedan ${fmtNum(c.length - used)} rondas`)),
    ),
    c.pendingRotation !== null && c.pendingRotation !== undefined
      ? h(
          'div',
          { class: 'notice notice-gold' },
          '⏳ ',
          h('span', null, 'Pediste una cadena nueva con ventaja ', h('b', null, edgePct(c.pendingRotation)), '. Se genera al empezar la próxima ronda y ahí se revela la semilla de esta.'),
        )
      : null,
    hashRow('Hash terminal (publicado)', c.terminalHash),
    hashRow('Sal (salt)', c.salt),
  );
}

/** Cadena de un juego en vivo (Double o Ruleta): la ventaja sale de la tabla de pagos, no se cambia. */
function liveChainCard(data, { title, pays, paysSub, rtp }) {
  const c = data.current;
  const used = Math.min(c.used, c.length);
  return card(
    `${title} #${c.chainId}`,
    { cls: 'fair-current', actions: h('span', { class: 'chip chip-green' }, 'Activa') },
    h(
      'div',
      { class: 'fair-stats' },
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Pagos'), h('div', { class: 'fair-big' }, pays), h('div', { class: 'tile-sub' }, paysSub)),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'RTP para los jugadores'), h('div', { class: 'fair-big green' }, rtp)),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Rondas usadas'), h('div', { class: 'fair-big' }, fmtNum(used)), h('div', { class: 'tile-sub' }, `de ${fmtNum(c.length)}`)),
      h('div', { class: 'fair-stat' }, h('div', { class: 'tile-label' }, 'Creada'), h('div', { class: 'fair-date' }, fmtDate(c.createdAt))),
    ),
    hashRow('Hash terminal (publicado)', c.terminalHash),
    hashRow('Sal (salt)', c.salt),
  );
}

function rotateCard(c, reload) {
  const current = c.pendingRotation ?? c.houseEdgeBps;
  const input = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Ventaja de la casa en porcentaje' });
  input.value = fmtDecimal(current / 100);
  const rtp = h('div', { class: 'rotate-rtp' });
  const btn = h('button', { type: 'submit', class: 'btn btn-gold' }, icon('refresh', 16), 'Generar cadena nueva');
  const parse = () => {
    const n = Number(input.value.trim().replace(',', '.'));
    return Number.isFinite(n) && input.value.trim() !== '' ? n : NaN;
  };
  const update = () => {
    const n = parse();
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      rtp.className = 'rotate-rtp red';
      rtp.textContent = 'La ventaja tiene que estar entre 0% y 20%';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    rtp.className = 'rotate-rtp';
    rtp.replaceChildren('RTP para los jugadores: ', h('b', { class: 'green' }, fmtPct(100 - n, 2)), ' · de cada Gs. 100.000 apostados, la casa se queda en promedio con ', h('b', { class: 'gold' }, fmtGs(n * 1000)));
  };
  input.addEventListener('input', update);
  update();
  const form = h(
    'form',
    { class: 'rotate-form', novalidate: true },
    h('div', { class: 'rotate-row' }, field('Ventaja de la casa', adorn(input, null, '%')), btn),
    rtp,
    h(
      'ul',
      { class: 'rotate-notes' },
      h('li', null, 'La cadena nueva se usa desde la ', h('b', null, 'próxima ronda'), ' (la ronda en curso no cambia).'),
      h('li', null, 'La semilla de la cadena actual se revela para que cualquiera verifique todas sus rondas.'),
      h('li', null, 'RTP = 100% − ventaja. Aviator usa 3% (RTP 97%).'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = parse();
    if (!Number.isFinite(n) || n < 0 || n > 20) return;
    const ok = await confirmDialog(
      `Se genera una cadena de hashes nueva con ventaja ${fmtPct(n, 2)} (RTP ${fmtPct(100 - n, 2)}).\nEmpieza a usarse en la próxima ronda y la semilla de la cadena actual queda publicada.`,
      { title: '🔐 Generar cadena nueva', okText: 'Generar cadena' },
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      await post('/api/admin/chain/rotate', { houseEdge: n });
      toast('La cadena nueva se aplica desde la próxima ronda', 'success', '🔐 Cadena pedida');
      reload();
    } catch (err) {
      notifyError(err);
      btn.disabled = false;
    }
  });
  return card('Generar cadena nueva', { icon: 'refresh', cls: 'fair-rotate' }, form);
}

const PREV_COLS = [
  { label: 'Cadena', main: true, render: (c) => h('span', { class: 'fair-prev-main' }, h('b', null, `#${c.id}`), h('span', { class: 'chip' }, `Ventaja ${edgePct(c.house_edge_bps)}`)) },
  { label: 'Rondas usadas', cls: 'num', render: (c) => `${fmtNum(c.used)} / ${fmtNum(c.length)}` },
  { label: 'Período', render: (c) => `${fmtDate(c.created_at)} → ${c.ended_at ? fmtDate(c.ended_at) : '—'}` },
  { label: 'Semilla revelada', cls: 'wrap-cell', full: true, render: (c) => h('span', { class: 'hash-inline' }, h('code', { class: 'mono' }, c.seed), copyBtn(c.seed, 'Copiar semilla')) },
  { label: 'Hash terminal', cls: 'wrap-cell', full: true, render: (c) => h('span', { class: 'hash-inline' }, h('code', { class: 'mono' }, c.terminal_hash), copyBtn(c.terminal_hash, 'Copiar hash')) },
  { label: 'Sal', cls: 'wrap-cell', full: true, render: (c) => h('span', { class: 'hash-inline' }, h('code', { class: 'mono' }, c.salt), copyBtn(c.salt, 'Copiar sal')) },
];

export const fairView = {
  sc: null,
  seq: 0,
  mount(el) {
    const box = h('div', { class: 'fair-box' }, loadingState());
    const load = async () => {
      const seq = ++this.seq;
      try {
        const [data, dbl, rl] = await Promise.all([call('/api/fair'), call('/api/fair?game=double'), call('/api/fair?game=roulette')]);
        if (seq !== this.seq) return;
        const c = data.current;
        box.replaceChildren(
          h('div', { class: 'fair-grid' }, currentChainCard(c), rotateCard(c, load)),
          liveChainCard(dbl, { title: '🎡 Cadena del Double', pays: '2x · 2x · 30x', paysSub: '15 rojas · 15 negras · 1 blanca', rtp: '96,77%' }),
          liveChainCard(rl, { title: '🎰 Cadena de la Ruleta', pays: '36x · 3x · 2x', paysSub: 'Pleno · docena y columna · afuera (37 números, un solo 0)', rtp: '97,30%' }),
          card(
            '💣⚽🔴 Juegos con semillas',
            { icon: 'key', cls: 'fair-how' },
            h(
              'p',
              null,
              'Minas, Penales y Plinko no usan una cadena: cada jugador tiene su ',
              h('b', null, 'semilla del servidor'),
              ' (secreta, pero ve su hash antes de jugar), su ',
              h('b', null, 'semilla propia'),
              ' y un número de jugada (nonce). Cuando el jugador cambia sus semillas, la del servidor se revela y puede comprobar todas sus jugadas. Retorno: 97%.',
            ),
          ),
          card(
            '¿Cómo funciona?',
            { icon: 'book', cls: 'fair-how' },
            h(
              'p',
              null,
              'Antes de jugar se publica el ',
              h('b', null, 'hash terminal'),
              ' de una cadena de hashes. Cada ronda usa el eslabón anterior de la cadena, así nadie —ni vos— puede cambiar resultados futuros. Cuando se cambia de cadena se revela la semilla para que cualquiera compruebe todas las rondas.',
            ),
            h('a', { class: 'btn btn-ghost btn-sm', href: '/fair', target: '_blank', rel: 'noopener' }, icon('external', 15), 'Abrir la página pública de verificación'),
          ),
          card(
            'Cadenas anteriores',
            { icon: 'clock', sub: data.previous.length ? plural(data.previous.length, 'cadena', 'cadenas') : '' },
            dataTable(PREV_COLS, data.previous, { empty: 'Todavía no se cambió de cadena. Cuando generes una nueva, la semilla de esta aparece acá.', emptyEmoji: '🔐' }),
          ),
        );
      } catch (err) {
        if (seq === this.seq) box.replaceChildren(errorState(err, load));
      }
    };
    el.append(viewHead('Provably fair', 'Cadena de hashes, ventaja de la casa y verificación pública.', refreshBtn(load)), box);
    load();
  },
  unmount() {
    this.seq++;
  },
};
