'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { sha256, randomHex } = require('./util');

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = 'cpy_sid';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

class Auth {
  constructor(db, { sessionDays = 30 } = {}) {
    this.db = db;
    this.sessionMs = sessionDays * 24 * 60 * 60 * 1000;
    const timer = setInterval(() => this.db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600_000);
    timer.unref();
  }

  createSession(userId, ip, userAgent) {
    const token = randomHex(32);
    const now = Date.now();
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token),
      userId,
      now,
      now + this.sessionMs,
      ip || null,
      String(userAgent || '').slice(0, 200),
    );
    return token;
  }

  userFromToken(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const user = this.db.get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      sha256(token),
      Date.now(),
    );
    if (!user || user.banned) return null;
    return user;
  }

  userFromCookieHeader(header) {
    return this.userFromToken(parseCookies(header)[COOKIE_NAME]);
  }

  tokenFromRequest(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME];
  }

  destroyToken(token) {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  destroyUserSessions(userId, exceptToken) {
    if (exceptToken) {
      this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, sha256(exceptToken));
    } else {
      this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    }
  }

  setCookie(req, res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: this.sessionMs,
      path: '/',
    });
  }

  clearCookie(req, res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
  }

  /** Middleware Express: agrega req.user si hay una sesión válida. */
  middleware() {
    return (req, res, next) => {
      req.user = this.userFromCookieHeader(req.headers.cookie);
      next();
    };
  }
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Iniciá sesión para continuar', code: 'AUTH' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Iniciá sesión como administrador', code: 'AUTH' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acceso solo para administradores', code: 'FORBIDDEN' });
  next();
}

/** Datos del usuario que es seguro enviar al navegador. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    balance: u.balance,
    muted: !!u.muted,
    phone: u.phone || '',
    created_at: u.created_at,
  };
}

module.exports = { Auth, hashPassword, verifyPassword, parseCookies, requireUser, requireAdmin, publicUser, COOKIE_NAME };
