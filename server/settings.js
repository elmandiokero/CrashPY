'use strict';
const { AppError, cleanText } = require('./util');

/**
 * Configuración editable desde el panel de admin.
 * public: true → se envía a los jugadores.
 */
const SCHEMA = {
  site_name: { type: 'str', max: 30, def: 'CrashPY', public: true, label: 'Nombre del sitio' },
  banner: { type: 'str', max: 200, def: '', public: true, label: 'Anuncio superior' },
  min_bet: { type: 'int', min: 100, max: 1e9, def: 1000, public: true, label: 'Apuesta mínima' },
  max_bet: { type: 'int', min: 100, max: 1e10, def: 1000000, public: true, label: 'Apuesta máxima' },
  max_profit: { type: 'int', min: 1000, max: 1e12, def: 20000000, public: true, label: 'Ganancia máxima por apuesta' },
  quick_amounts: { type: 'str', max: 80, def: '2000,5000,10000,50000', public: true, label: 'Montos rápidos' },
  betting_seconds: { type: 'int', min: 3, max: 30, def: 7, public: true, label: 'Segundos para apostar' },
  speed: { type: 'float', min: 0.5, max: 2, def: 1, public: false, label: 'Velocidad del cohete' },
  min_deposit: { type: 'int', min: 0, max: 1e10, def: 10000, public: true, label: 'Depósito mínimo' },
  min_withdraw: { type: 'int', min: 0, max: 1e10, def: 20000, public: true, label: 'Retiro mínimo' },
  max_withdraw: { type: 'int', min: 0, max: 1e12, def: 0, public: true, label: 'Retiro máximo (0 = sin límite)' },
  bank_name: { type: 'str', max: 60, def: '', public: false, label: 'Banco' },
  bank_holder: { type: 'str', max: 80, def: '', public: false, label: 'Titular' },
  bank_doc: { type: 'str', max: 30, def: '', public: false, label: 'CI / RUC' },
  bank_account: { type: 'str', max: 60, def: '', public: false, label: 'Número de cuenta' },
  bank_alias: { type: 'str', max: 80, def: '', public: false, label: 'Alias (SIPAP)' },
  bank_notes: { type: 'str', max: 300, def: '', public: false, label: 'Instrucciones extra' },
  support_whatsapp: { type: 'str', max: 30, def: '', public: true, label: 'WhatsApp de soporte' },
  chat_enabled: { type: 'bool', def: true, public: true, label: 'Chat habilitado' },
  bigwin_multiplier: { type: 'float', min: 1.01, max: 1e6, def: 10, public: false, label: 'Anunciar retiros desde (x)' },
  bigwin_amount: { type: 'int', min: 0, max: 1e12, def: 200000, public: false, label: 'Anunciar ganancias desde (Gs.)' },
  signup_bonus: { type: 'int', min: 0, max: 1e9, def: 0, public: false, label: 'Bono de bienvenida' },
  game_mines: { type: 'bool', def: true, public: true, label: '💣 Minas habilitado' },
  game_penalty: { type: 'bool', def: true, public: true, label: '⚽ Penales habilitado' },
  game_double: { type: 'bool', def: true, public: true, label: '🎡 Double habilitado' },
  game_plinko: { type: 'bool', def: true, public: true, label: '🔴 Plinko habilitado' },
  game_roulette: { type: 'bool', def: true, public: true, label: '🎰 Ruleta habilitada' },
  double_betting_seconds: { type: 'int', min: 5, max: 30, def: 15, public: true, label: 'Double: segundos para apostar' },
  bots_enabled: { type: 'bool', def: false, public: false, label: '🤖 Bots activos' },
  bots_count: { type: 'int', min: 1, max: 40, def: 12, public: false, label: 'Cantidad de bots' },
  bots_chat: { type: 'bool', def: true, public: false, label: 'Los bots comentan en el chat' },
  bots_max_bet: { type: 'int', min: 100, max: 1e9, def: 50000, public: false, label: 'Apuesta máxima de los bots' },
};

class Settings {
  constructor(db, bus) {
    this.db = db;
    this.bus = bus;
    this.values = {};
    const rows = db.all('SELECT key, value FROM settings');
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    for (const [key, def] of Object.entries(SCHEMA)) {
      let value = def.def;
      if (stored[key] !== undefined) {
        try {
          value = JSON.parse(stored[key]);
        } catch {
          /* valor corrupto → default */
        }
      }
      this.values[key] = value;
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  publicAll() {
    const out = {};
    for (const [key, def] of Object.entries(SCHEMA)) if (def.public) out[key] = this.values[key];
    return out;
  }

  bankInfo() {
    const v = this.values;
    return {
      bank_name: v.bank_name,
      bank_holder: v.bank_holder,
      bank_doc: v.bank_doc,
      bank_account: v.bank_account,
      bank_alias: v.bank_alias,
      bank_notes: v.bank_notes,
      support_whatsapp: v.support_whatsapp,
      min_deposit: v.min_deposit,
      min_withdraw: v.min_withdraw,
      max_withdraw: v.max_withdraw,
    };
  }

  schema() {
    return Object.fromEntries(
      Object.entries(SCHEMA).map(([k, d]) => [k, { type: d.type, min: d.min, max: d.max, label: d.label }]),
    );
  }

  /** Valida y guarda un conjunto de cambios. Devuelve las claves modificadas. */
  update(patch) {
    if (!patch || typeof patch !== 'object') throw new AppError('Datos inválidos');
    const next = {};
    for (const [key, raw] of Object.entries(patch)) {
      const def = SCHEMA[key];
      if (!def) continue;
      let value;
      if (def.type === 'str') {
        value = cleanText(raw, def.max);
      } else if (def.type === 'bool') {
        value = raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on';
      } else {
        let n = raw;
        if (typeof raw !== 'number') {
          const text = String(raw ?? '').trim();
          // Enteros: "10.000" → 10000 · Decimales: "1,5" → 1.5
          n = def.type === 'int' ? parseInt(text.replace(/[^\d-]/g, ''), 10) : parseFloat(text.replace(',', '.'));
        }
        if (!Number.isFinite(n)) throw new AppError(`Valor inválido para "${def.label}"`);
        value = def.type === 'int' ? Math.round(n) : Math.round(n * 100) / 100;
        if (value < def.min || value > def.max) {
          throw new AppError(`"${def.label}" debe estar entre ${def.min} y ${def.max}`);
        }
      }
      next[key] = value;
    }
    const merged = { ...this.values, ...next };
    if (merged.min_bet > merged.max_bet) throw new AppError('La apuesta mínima no puede ser mayor que la máxima');
    if (merged.quick_amounts && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(merged.quick_amounts)) {
      throw new AppError('Montos rápidos: escribí números separados por coma, ej: 2000,5000,10000');
    }
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(this.values[k]));
    this.db.tx(() => {
      for (const key of changed) {
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(next[key]),
        );
      }
    });
    Object.assign(this.values, next);
    if (changed.length) this.bus.emit('settings', this.publicAll());
    return changed;
  }
}

module.exports = { Settings, SETTINGS_SCHEMA: SCHEMA };
