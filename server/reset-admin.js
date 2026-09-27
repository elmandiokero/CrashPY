'use strict';
/**
 * Recuperar el acceso de administrador:
 *   npm run reset-admin -- NUEVA_CONTRASEÑA            (usa el usuario ADMIN_USER o "admin")
 *   npm run reset-admin -- NUEVA_CONTRASEÑA usuario    (usuario específico, lo hace admin)
 * Ejecutalo con el servidor apagado.
 */
const path = require('path');
const config = require('./config');
const { Database } = require('./db');
const { hashPassword } = require('./auth');

async function main() {
  const [password, usernameArg] = process.argv.slice(2);
  if (!password || password.length < 6) {
    console.log('Uso: npm run reset-admin -- NUEVA_CONTRASEÑA [usuario]');
    console.log('La contraseña debe tener al menos 6 caracteres.');
    process.exit(1);
  }
  const username = usernameArg || config.ADMIN_USER || 'admin';
  const db = new Database(path.join(config.DATA_DIR, 'crashpy.db'));
  const passHash = await hashPassword(password);
  const user = db.get('SELECT id FROM users WHERE username = ?', username);
  if (user) {
    db.run("UPDATE users SET pass_hash = ?, role = 'admin', banned = 0 WHERE id = ?", passHash, user.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  } else {
    db.run("INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, 'admin', ?)", username, passHash, Date.now());
  }
  db.close();
  console.log(`✅ Listo. Administrador "${username}" con la contraseña nueva.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
