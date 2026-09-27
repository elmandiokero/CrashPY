'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\n❌ CrashPY necesita Node.js 22.13 o superior (tenés ${process.versions.node}).`);
  console.error('   Descargá la versión LTS desde https://nodejs.org e instalala.\n');
  process.exit(1);
}

const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');
const { Database } = require('./db');
const { Settings } = require('./settings');
const { Auth, hashPassword } = require('./auth');
const { ChainManager } = require('./fair');
const { Wallet } = require('./wallet');
const { Chat } = require('./chat');
const { GameEngine } = require('./game');
const { Seeds } = require('./games/seeds');
const { PlayEngine } = require('./games/plays');
const { DoubleEngine } = require('./games/double');
const { RouletteEngine } = require('./games/roulette');
const { BotManager } = require('./bots');
const { Backups } = require('./backup');
const { AppError, RateLimiter, randomPassword } = require('./util');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const setupSockets = require('./sockets');

// ───────────────────────── Servicios ─────────────────────────

const bus = new EventEmitter();
bus.setMaxListeners(100);
const db = new Database(path.join(config.DATA_DIR, 'crashpy.db'));
const settings = new Settings(db, bus);
const chains = new ChainManager(db, { length: config.CHAIN_LENGTH, defaultEdgeBps: config.HOUSE_EDGE_BPS });
chains.init();
const wallet = new Wallet({ db, bus, settings, dataDir: config.DATA_DIR });
const auth = new Auth(db, { sessionDays: config.SESSION_DAYS });
const chat = new Chat({ db, bus, settings });
const engine = new GameEngine({ db, chains, settings, wallet, bus });
const backups = new Backups(db, config.DATA_DIR);
engine.on('betting', () => setImmediate(() => backups.maybeAuto()));
// Minas, Penales y Plinko: cada jugada sale de las semillas del jugador
const seeds = new Seeds(db);
const plays = new PlayEngine({ db, wallet, settings, bus, seeds });
// Double y Ruleta: en vivo, cada uno con su propia cadena de hashes.
// Ventaja del Double: 3,23% (31 casillas; rojo y negro pagan 2x, blanco 30x). Se guarda solo como dato.
const doubleChains = new ChainManager(db, { game: 'double', length: config.CHAIN_LENGTH, defaultEdgeBps: 323 });
doubleChains.init();
const double = new DoubleEngine({ db, chains: doubleChains, settings, wallet, bus });
// Ventaja de la Ruleta europea: 2,70% (un solo cero). También se guarda solo como dato.
const rouletteChains = new ChainManager(db, { game: 'roulette', length: config.CHAIN_LENGTH, defaultEdgeBps: 270 });
rouletteChains.init();
const roulette = new RouletteEngine({ db, chains: rouletteChains, settings, wallet, bus });
// Bots marcados con 🤖 que animan la sala con plata ficticia (no tocan nada real)
const bots = new BotManager({ db, engine, double, roulette, chat, settings, bus });
const limiter = new RateLimiter();
const ctx = {
  db,
  bus,
  settings,
  chains,
  wallet,
  auth,
  chat,
  engine,
  seeds,
  plays,
  double,
  doubleChains,
  roulette,
  rouletteChains,
  bots,
  backups,
  limiter,
  config,
  presence: null,
};

async function ensureAdmin() {
  const count = db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").c;
  if (count > 0) return;
  const username = /^[a-zA-Z0-9_.]{3,16}$/.test(config.ADMIN_USER) ? config.ADMIN_USER : 'admin';
  const password = config.ADMIN_PASS || randomPassword(10);
  const passHash = await hashPassword(password);
  const existing = db.get('SELECT id FROM users WHERE username = ?', username);
  if (existing) {
    db.run("UPDATE users SET role = 'admin', pass_hash = ? WHERE id = ?", passHash, existing.id);
  } else {
    db.run("INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, 'admin', ?)", username, passHash, Date.now());
  }
  const file = path.join(config.DATA_DIR, 'ADMIN-INICIAL.txt');
  fs.writeFileSync(
    file,
    `Administrador de CrashPY\n\nUsuario: ${username}\nContraseña: ${password}\n\nEntrá a /admin y cambiá la contraseña. Después borrá este archivo.\n`,
  );
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  👑 Se creó el usuario ADMINISTRADOR                  ║');
  console.log(`║     Usuario:    ${username.padEnd(37)}║`);
  console.log(`║     Contraseña: ${password.padEnd(37)}║`);
  console.log('║  (también quedó guardado en data/ADMIN-INICIAL.txt)   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

// ───────────────────────── HTTP ─────────────────────────

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // cloudflared corre en la misma PC

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
});

app.use('/api/wallet/deposit', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(auth.middleware());
app.use('/api/admin', adminRoutes(ctx));
app.use('/api', publicRoutes(ctx));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Cada juego tiene su propia dirección (/minas, /double, ...), pero todos usan la misma página
const GAME_PAGES = ['/crash', '/minas', '/penales', '/double', '/plinko', '/ruleta'];
app.get(GAME_PAGES, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(config.ROOT, 'public', 'index.html'));
});

app.use(
  express.static(path.join(config.ROOT, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (/\.(png|jpg|svg|webp|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos' });
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 100_000,
});
setupSockets(io, ctx);

// ───────────────────────── Arranque ─────────────────────────

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function main() {
  await ensureAdmin();
  engine.start();
  double.start();
  roulette.start();
  bots.start();
  server.listen(config.PORT, config.HOST, () => {
    console.log(`\n🚀 CrashPY está en línea`);
    console.log(`   En esta PC:       http://localhost:${config.PORT}`);
    for (const ip of lanAddresses()) console.log(`   En tu WiFi (cel): http://${ip}:${config.PORT}`);
    console.log(`   Panel de admin:   http://localhost:${config.PORT}/admin`);
    if (config.PUBLIC_URL) {
      console.log(`\n   🌐 Desde internet: ${config.PUBLIC_URL}   (admin: ${config.PUBLIC_URL}/admin)`);
      console.log('      Necesita el túnel de Cloudflare funcionando (servicio o TUNEL-CLOUDFLARE.bat)');
    } else {
      console.log(`\n   Para jugar desde internet abrí el túnel de Cloudflare (TUNEL-CLOUDFLARE.bat)`);
    }
    console.log('   Para apagar el servidor: Ctrl + C\n');
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ El puerto ${config.PORT} ya está en uso. ¿Ya tenés CrashPY abierto en otra ventana?\n`);
  } else {
    console.error('Error del servidor:', err);
  }
  process.exit(1);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n⏹️  Apagando (${signal})... las apuestas de la ronda en curso se devuelven.`);
  engine.shutdown();
  double.shutdown();
  roulette.shutdown();
  bots.shutdown();
  io.close();
  server.close();
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (err) => console.error('Excepción no controlada:', err));
process.on('unhandledRejection', (err) => console.error('Promesa rechazada sin controlar:', err));

main().catch((err) => {
  console.error('No se pudo iniciar CrashPY:', err);
  process.exit(1);
});
