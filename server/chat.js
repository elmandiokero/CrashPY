'use strict';
const { AppError, cleanText } = require('./util');

const HISTORY = 60;
const MIN_INTERVAL_MS = 1500;

function toMessage(row) {
  return {
    id: row.id,
    uid: row.user_id,
    user: row.username,
    role: row.role,
    kind: row.kind,
    text: row.text,
    ts: row.created_at,
  };
}

class Chat {
  constructor({ db, bus, settings }) {
    this.db = db;
    this.bus = bus;
    this.settings = settings;
    this.lastByUser = new Map();
    this.recent = db
      .all('SELECT * FROM chat WHERE deleted = 0 ORDER BY id DESC LIMIT ?', HISTORY)
      .reverse()
      .map(toMessage);
  }

  _insert({ uid = null, user = null, role = null, kind, text }) {
    const ts = Date.now();
    const res = this.db.run(
      'INSERT INTO chat (user_id, username, role, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      uid,
      user,
      role,
      kind,
      text,
      ts,
    );
    const msg = { id: Number(res.lastInsertRowid), uid, user, role, kind, text, ts };
    this.recent.push(msg);
    if (this.recent.length > HISTORY) this.recent.shift();
    this.bus.emit('chat', msg);
    return msg;
  }

  post(user, raw) {
    const isAdmin = user.role === 'admin';
    if (!this.settings.get('chat_enabled') && !isAdmin) throw new AppError('El chat está desactivado por el momento');
    if (user.muted) throw new AppError('Estás silenciado en el chat 🔇', 403, 'MUTED');
    const text = cleanText(raw, 200);
    if (!text) throw new AppError('Escribí un mensaje');
    const now = Date.now();
    if (!isAdmin && now - (this.lastByUser.get(user.id) || 0) < MIN_INTERVAL_MS) {
      throw new AppError('Más despacio 🙂', 429, 'RATE');
    }
    this.lastByUser.set(user.id, now);
    return this._insert({ uid: user.id, user: user.username, role: user.role, kind: 'user', text });
  }

  /** Mensaje del sistema (ganancias grandes, avisos automáticos). */
  system(text, kind = 'system') {
    return this._insert({ kind, text: String(text).slice(0, 300) });
  }

  /** Mensaje de un bot (siempre con la etiqueta BOT y el 🤖 en el nombre). */
  bot(name, raw) {
    const text = cleanText(raw, 200);
    if (!text) return null;
    return this._insert({ user: name, role: 'bot', kind: 'user', text });
  }

  /** Anuncio destacado del administrador. */
  announce(admin, raw) {
    const text = cleanText(raw, 300);
    if (!text) throw new AppError('Escribí el anuncio');
    return this._insert({ uid: admin.id, user: admin.username, role: 'admin', kind: 'announce', text });
  }

  remove(id) {
    const res = this.db.run('UPDATE chat SET deleted = 1 WHERE id = ? AND deleted = 0', id);
    if (!res.changes) throw new AppError('Mensaje no encontrado', 404);
    this.recent = this.recent.filter((m) => m.id !== id);
    this.bus.emit('chatDelete', id);
  }

  clear() {
    this.db.run('UPDATE chat SET deleted = 1 WHERE deleted = 0');
    this.recent = [];
    this.bus.emit('chatClear');
  }
}

module.exports = { Chat };
