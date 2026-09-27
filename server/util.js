'use strict';
const crypto = require('crypto');

/** Error "esperado" cuyo mensaje se puede mostrar al usuario. */
class AppError extends Error {
  constructor(message, status = 400, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function randomPassword(length = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

const gsFormatter = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
const fmtGs = (n) => 'Gs. ' + gsFormatter.format(Math.round(Number(n) || 0));
const fmtMult = (m100) => (m100 / 100).toFixed(2) + 'x';

/** Convierte "10.000", "Gs. 10.000", 10000 → 10000 (guaraníes enteros). Devuelve NaN si no es válido. */
function parseAmount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const digits = value.replace(/[^\d]/g, '');
  if (!digits || digits.length > 15) return NaN;
  return parseInt(digits, 10);
}

/** Convierte 2, "2.5", "2,50", "2.50x" → centésimas (250). null si está vacío, NaN si es inválido. */
function parseMultiplier(value) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = parseFloat(value.replace(',', '.').replace(/[^\d.]/g, ''));
  else return NaN;
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** Limpia texto libre ingresado por el usuario. */
function cleanText(value, max = 100) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * IP real del cliente. Solo confiamos en los encabezados de proxy cuando la conexión
 * viene de la propia PC (cloudflared corre en localhost).
 */
function clientIp(headers, remoteAddress) {
  const remote = String(remoteAddress || '');
  if (LOOPBACK.has(remote)) {
    const cf = headers['cf-connecting-ip'];
    if (cf) return String(cf).trim().slice(0, 64);
    const xff = headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
  }
  return remote.replace(/^::ffff:/, '');
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Limitador simple en memoria: hit(key, limit, windowMs) → true si todavía está permitido. */
class RateLimiter {
  constructor() {
    this.entries = new Map();
    const timer = setInterval(() => this.cleanup(), 60_000);
    timer.unref();
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0, windowMs };
      this.entries.set(key, entry);
    }
    entry.count++;
    return entry.count <= limit;
  }

  reset(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.start > entry.windowMs) this.entries.delete(key);
    }
  }
}

module.exports = {
  AppError,
  sha256,
  randomHex,
  randomPassword,
  fmtGs,
  fmtMult,
  parseAmount,
  parseMultiplier,
  cleanText,
  clientIp,
  startOfDay,
  RateLimiter,
};
