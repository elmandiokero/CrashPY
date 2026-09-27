// Utilidades compartidas entre el juego, el panel de admin y la página de verificación.

// ───────────────────────── Formatos ─────────────────────────

const numberFormat = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });

export const fmtNum = (n) => numberFormat.format(Math.round(Number(n) || 0));
export const fmtGs = (n) => 'Gs. ' + fmtNum(n);
export const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtGs(Math.abs(n));
export const fmtMult = (m100) => (m100 == null ? '—' : (m100 / 100).toFixed(2) + 'x');

/** "10.000" / "Gs 10.000" / 10000 → 10000 (NaN si no hay dígitos). */
export function parseAmount(value) {
  if (typeof value === 'number') return Math.round(value);
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits.slice(0, 15), 10) : NaN;
}

/** "2,5" / "2.50x" → 250 (centésimas). NaN si no es válido. */
export function parseMult(value) {
  const n = parseFloat(String(value ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + fmtTime(ts);
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function timeAgo(ts) {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'recién';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}

/** Clase de color según el multiplicador (como en los crash clásicos). */
export function multClass(m100) {
  if (m100 == null) return 'mc-none';
  if (m100 < 200) return 'mc-low';
  if (m100 < 1000) return 'mc-mid';
  return 'mc-high';
}

/** Color estable a partir de un texto (para avatares de usuarios). */
export function colorFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 60%)`;
}

// ───────────────────────── Juego ─────────────────────────

export function multiplierAt(ms, growth) {
  return Math.floor(100 * Math.exp(growth * Math.max(0, ms)));
}

export function msForMultiplier(m100, growth) {
  return Math.log(m100 / 100) / growth;
}

// ───────────────────────── DOM ─────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Crea elementos de forma segura (el texto siempre va como textContent, nunca como HTML).
 *   h('div', { class: 'x', onclick: fn }, 'texto', h('span', null, 'hijo'))
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ───────────────────────── API ─────────────────────────

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Sin conexión con el servidor');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta sin JSON */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

// ───────────────────────── Notificaciones ─────────────────────────

let toastRoot = null;

export function toast(text, kind = 'info', title = '') {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️', win: '🤑' };
  const node = h(
    'div',
    { class: `toast toast-${kind}` },
    h('span', { class: 'toast-icon' }, icons[kind] || icons.info),
    h('div', { class: 'toast-body' }, title ? h('strong', null, title) : null, h('span', null, text)),
  );
  node.addEventListener('click', () => dismiss());
  toastRoot.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  const timer = setTimeout(dismiss, kind === 'error' ? 5000 : 3800);
  function dismiss() {
    clearTimeout(timer);
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }
  while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
}

// ───────────────────────── Modales ─────────────────────────

/** Abre un modal. Devuelve { close, root, body }. */
export function openModal({ title, content, wide = false, onClose } = {}) {
  const body = h('div', { class: 'modal-body' });
  if (content) body.append(content);
  const closeBtn = h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Cerrar' }, '✕');
  const modal = h('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', null, title || ''), closeBtn),
    body,
  );
  const root = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => root.remove(), 200);
    document.body.classList.toggle('modal-open', document.querySelectorAll('.modal-backdrop.show').length > 0);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => root.classList.add('show'));
  return { close, root, body, modal };
}

/** Confirmación simple. Devuelve una promesa con true/false. */
export function confirmDialog(message, { title = 'Confirmar', okText = 'Aceptar', cancelText = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button' }, okText);
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, cancelText);
    const m = openModal({
      title,
      content: h('div', null, h('p', { class: 'confirm-text' }, message), h('div', { class: 'modal-actions' }, cancel, ok)),
      onClose: () => resolve(result),
    });
    ok.addEventListener('click', () => {
      result = true;
      m.close();
    });
    cancel.addEventListener('click', () => m.close());
    setTimeout(() => ok.focus(), 50);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copiado al portapapeles', 'success');
}

// ───────────────────────── Provably fair (SHA-256 en JavaScript puro) ─────────────────────────
// Implementación propia para que la verificación funcione incluso sin HTTPS (crypto.subtle
// solo existe en contextos seguros).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);
const encoder = new TextEncoder();

function sha256Bytes(bytes) {
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = len * 8;
  view.setUint32(total - 4, bits >>> 0);
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v >>> 0));
  return out;
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hmacBytes(key, message) {
  let k = key.length > 64 ? sha256Bytes(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256Bytes(inner), 64);
  return sha256Bytes(outer);
}

/** SHA-256 del texto (UTF-8) en hexadecimal. */
export const sha256Hex = (text) => toHex(sha256Bytes(encoder.encode(String(text))));

/** HMAC-SHA256(clave, mensaje) en hexadecimal. */
export const hmacSha256Hex = (key, message) => toHex(hmacBytes(encoder.encode(String(key)), encoder.encode(String(message))));

/** Punto de explosión (centésimas) a partir del hash de la ronda — misma fórmula que el servidor. */
export function crashFromHash(gameHash, salt, houseEdgeBps) {
  const hmac = hmacSha256Hex(salt, gameHash);
  const r = parseInt(hmac.slice(0, 13), 16);
  const x = r / 4503599627370496;
  const crash = Math.floor((10000 - houseEdgeBps) / 100 / (1 - x));
  return Math.max(100, crash);
}
