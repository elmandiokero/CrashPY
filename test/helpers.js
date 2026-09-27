'use strict';
// Utilidades para las pruebas: levanta un servidor real en un puerto libre con una base temporal.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer({ dataDir, env = {} } = {}) {
  const port = await freePort();
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'crashpy-test-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'admin123',
      CHAIN_LENGTH: '5000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no arrancó:\n' + output)), 20000);
    const check = setInterval(() => {
      if (output.includes('está en línea')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`El servidor terminó (código ${code}):\n${output}`));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    dataDir: dir,
    child,
    output: () => output,
    async stop(signal = 'SIGINT') {
      if (child.exitCode !== null) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill(signal);
      await done;
    },
  };
}

/** Cliente HTTP con "frasco" de cookies. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* sin JSON */
    }
    return { status: res.status, ok: res.ok, data };
  }

  get(p) {
    return this.req('GET', p);
  }

  post(p, body = {}) {
    return this.req('POST', p, body);
  }
}

/** Conecta un socket con la cookie de sesión y junta los eventos recibidos. */
function connectSocket(base, cookie) {
  const { io } = require('socket.io-client');
  const socket = io(base, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false, forceNew: true });
  const events = [];
  socket.onAny((name, data) => events.push({ name, data, at: Date.now() }));
  const ready = new Promise((resolve, reject) => {
    socket.once('init', resolve);
    socket.once('connect_error', reject);
  });
  const emit = (name, data) => socket.timeout(8000).emitWithAck(name, data);
  const waitFor = (name, pred = () => true, timeout = 90000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(name, handler);
        reject(new Error(`Timeout esperando "${name}"`));
      }, timeout);
      const handler = (data) => {
        if (!pred(data)) return;
        clearTimeout(timer);
        socket.off(name, handler);
        resolve(data);
      };
      socket.on(name, handler);
    });
  return { socket, events, ready, emit, waitFor, close: () => socket.close() };
}

/** Abre la base en solo lectura para inspeccionar (por ejemplo el punto de explosión de la ronda en curso). */
function openDb(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(dataDir, 'crashpy.db'), { readOnly: true });
}

module.exports = { startServer, Client, connectSocket, openDb, freePort, ROOT };
