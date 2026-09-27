'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Respaldos de la base de datos (data/backups). Se hace uno automático cada 6 horas,
 * siempre entre rondas, y el admin puede descargar uno en el momento desde el panel.
 */
class Backups {
  constructor(db, dataDir, { keep = 30, everyMs = 6 * 3600_000, log = console.log } = {}) {
    this.db = db;
    this.dir = path.join(dataDir, 'backups');
    this.keep = keep;
    this.everyMs = everyMs;
    this.log = log;
    fs.mkdirSync(this.dir, { recursive: true });
    const latest = this.list()[0];
    this.last = latest ? latest.mtime : 0;
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^crashpy-[\w-]+\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  create(tag = '') {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const full = path.join(this.dir, `crashpy-${stamp}${tag}.db`);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    // VACUUM INTO genera una copia consistente aunque el juego esté corriendo
    this.db.raw.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);
    this.last = Date.now();
    this.prune();
    return full;
  }

  /** Llamado al empezar cada fase de apuestas: hace el respaldo automático si ya toca. */
  maybeAuto() {
    if (Date.now() - this.last < this.everyMs) return;
    try {
      const file = this.create();
      this.log(`💾 Respaldo automático guardado: data/backups/${path.basename(file)}`);
    } catch (err) {
      this.last = Date.now();
      this.log('⚠️  No se pudo crear el respaldo automático:', err.message);
    }
  }

  prune() {
    for (const f of this.list().slice(this.keep)) {
      try {
        fs.unlinkSync(path.join(this.dir, f.file));
      } catch {
        /* ignorar */
      }
    }
  }
}

module.exports = { Backups };
