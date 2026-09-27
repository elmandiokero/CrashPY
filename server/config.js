'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Carga variables desde .env (si existe) sin dependencias externas
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn('⚠️  No se pudo leer .env:', err.message);
  }
}

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function float(name, def) {
  const v = parseFloat(String(process.env[name] || '').replace(',', '.'));
  return Number.isFinite(v) ? v : def;
}

const houseEdgePercent = Math.min(20, Math.max(0, float('HOUSE_EDGE', 3)));

module.exports = {
  ROOT,
  PORT: int('PORT', 3000),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  ADMIN_USER: (process.env.ADMIN_USER || 'admin').trim(),
  ADMIN_PASS: process.env.ADMIN_PASS || '',
  HOUSE_EDGE_BPS: Math.round(houseEdgePercent * 100),
  CHAIN_LENGTH: Math.min(10_000_000, Math.max(1000, int('CHAIN_LENGTH', 1_000_000))),
  SESSION_DAYS: int('SESSION_DAYS', 30),
};
