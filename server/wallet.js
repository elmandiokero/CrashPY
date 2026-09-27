'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AppError, fmtGs, parseAmount, cleanText } = require('./util');

const MAX_PENDING_DEPOSITS = 3;
const MAX_PENDING_WITHDRAWALS = 2;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Billetera: saldos, libro contable, depósitos y retiros por transferencia.
 * Regla de oro: el saldo SOLO cambia a través de change(), que deja registro en `ledger`.
 */
class Wallet {
  constructor({ db, bus, settings, dataDir }) {
    this.db = db;
    this.bus = bus;
    this.settings = settings;
    this.receiptsDir = path.join(dataDir, 'receipts');
    fs.mkdirSync(this.receiptsDir, { recursive: true });
  }

  /** Suma (o resta) saldo de forma atómica. Lanza "Saldo insuficiente" si quedaría negativo. */
  change(userId, delta, type, { refId = null, note = null, adminId = null } = {}) {
    if (!Number.isSafeInteger(delta)) throw new Error(`Monto inválido: ${delta}`);
    return this.db.tx(() => {
      const res = this.db.run(
        'UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? >= 0',
        delta,
        userId,
        delta,
      );
      if (res.changes !== 1) throw new AppError('Saldo insuficiente', 400, 'NO_FUNDS');
      const { balance } = this.db.get('SELECT balance FROM users WHERE id = ?', userId);
      this.db.run(
        'INSERT INTO ledger (user_id, type, amount, balance_after, ref_id, note, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        userId,
        type,
        delta,
        balance,
        refId,
        note,
        adminId,
        Date.now(),
      );
      this.db.onCommit(() => this.bus.emit('balance', userId, balance));
      return balance;
    });
  }

  balanceOf(userId) {
    const row = this.db.get('SELECT balance FROM users WHERE id = ?', userId);
    return row ? row.balance : 0;
  }

  // ───────────────────────── Depósitos ─────────────────────────

  getDeposit(id) {
    return this.db.get(
      `SELECT d.*, u.username, u.balance AS user_balance FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      id,
    );
  }

  createDeposit(user, body = {}) {
    const amount = parseAmount(body.amount);
    const min = this.settings.get('min_deposit');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Ingresá un monto válido');
    if (amount < min) throw new AppError(`El depósito mínimo es ${fmtGs(min)}`);
    if (amount > 1e11) throw new AppError('Monto demasiado grande');
    const reference = cleanText(body.reference, 60);
    if (!reference && !body.receipt) {
      throw new AppError('Ingresá el número de comprobante o subí una foto del comprobante');
    }
    const pending = this.db.get(
      "SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND status = 'pending'",
      user.id,
    ).c;
    if (pending >= MAX_PENDING_DEPOSITS) {
      throw new AppError(`Ya tenés ${pending} depósitos pendientes. Esperá a que el admin los revise.`);
    }
    const receipt = body.receipt ? this._saveReceipt(body.receipt) : null;
    const res = this.db.run(
      `INSERT INTO deposits (user_id, amount, reference, sender_name, sender_bank, receipt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      user.id,
      amount,
      reference || null,
      cleanText(body.senderName, 80) || null,
      cleanText(body.senderBank, 60) || null,
      receipt,
      Date.now(),
    );
    const deposit = this.getDeposit(Number(res.lastInsertRowid));
    this.bus.emit('deposit:new', deposit);
    this.bus.emit('activity', {
      kind: 'deposit',
      text: `💰 ${user.username} informó un depósito de ${fmtGs(amount)}`,
      userId: user.id,
    });
    return deposit;
  }

  _saveReceipt(dataUrl) {
    const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
    if (!match) throw new AppError('El comprobante tiene que ser una imagen (JPG, PNG o WEBP)');
    const buf = Buffer.from(match[1], 'base64');
    if (buf.length > MAX_RECEIPT_BYTES) throw new AppError('La imagen es muy pesada (máximo 5 MB)');
    let ext = null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
    else if (buf.subarray(0, 8).equals(PNG_MAGIC)) ext = 'png';
    else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ext = 'webp';
    if (!ext) throw new AppError('Formato de imagen no soportado');
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(this.receiptsDir, name), buf);
    return name;
  }

  receiptPath(fileName) {
    if (!fileName || !/^[\w-]+\.(jpg|png|webp)$/.test(fileName)) return null;
    const full = path.join(this.receiptsDir, fileName);
    return fs.existsSync(full) ? full : null;
  }

  approveDeposit(id, admin, { amount, note } = {}) {
    return this.db.tx(() => {
      const d = this.db.get('SELECT * FROM deposits WHERE id = ?', id);
      if (!d) throw new AppError('Depósito no encontrado', 404);
      if (d.status !== 'pending') throw new AppError('Este depósito ya fue procesado', 409);
      const credit = amount === undefined || amount === null || amount === '' ? d.amount : parseAmount(amount);
      if (!Number.isSafeInteger(credit) || credit <= 0) throw new AppError('Monto a acreditar inválido');
      this.db.run(
        "UPDATE deposits SET status = 'approved', credited = ?, admin_note = ?, admin_id = ?, processed_at = ? WHERE id = ?",
        credit,
        cleanText(note, 200) || null,
        admin.id,
        Date.now(),
        id,
      );
      this.change(d.user_id, credit, 'deposit', { refId: id, note: `Depósito #${id}`, adminId: admin.id });
      this.db.run('UPDATE users SET total_deposit = total_deposit + ? WHERE id = ?', credit, d.user_id);
      this.db.onCommit(() => {
        this.bus.emit('notify', d.user_id, { kind: 'success', title: '¡Depósito aprobado!', text: `Se acreditaron ${fmtGs(credit)} a tu saldo.` });
        this.bus.emit('deposit:update', this.getDeposit(id));
      });
      return { credited: credit };
    });
  }

  rejectDeposit(id, admin, note) {
    return this.db.tx(() => {
      const d = this.db.get('SELECT * FROM deposits WHERE id = ?', id);
      if (!d) throw new AppError('Depósito no encontrado', 404);
      if (d.status !== 'pending') throw new AppError('Este depósito ya fue procesado', 409);
      const reason = cleanText(note, 200) || 'No se encontró la transferencia';
      this.db.run(
        "UPDATE deposits SET status = 'rejected', admin_note = ?, admin_id = ?, processed_at = ? WHERE id = ?",
        reason,
        admin.id,
        Date.now(),
        id,
      );
      this.db.onCommit(() => {
        this.bus.emit('notify', d.user_id, { kind: 'error', title: 'Depósito rechazado', text: `${fmtGs(d.amount)} · Motivo: ${reason}` });
        this.bus.emit('deposit:update', this.getDeposit(id));
      });
    });
  }

  // ───────────────────────── Retiros ─────────────────────────

  getWithdrawal(id) {
    return this.db.get(
      `SELECT w.*, u.username, u.balance AS user_balance FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?`,
      id,
    );
  }

  createWithdrawal(user, body = {}) {
    const amount = parseAmount(body.amount);
    const min = this.settings.get('min_withdraw');
    const max = this.settings.get('max_withdraw');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Ingresá un monto válido');
    if (amount < min) throw new AppError(`El retiro mínimo es ${fmtGs(min)}`);
    if (max > 0 && amount > max) throw new AppError(`El retiro máximo es ${fmtGs(max)}`);
    const bank = cleanText(body.bank, 60);
    const accountType = cleanText(body.accountType, 30);
    const account = cleanText(body.account, 60);
    const holder = cleanText(body.holder, 80);
    const holderDoc = cleanText(body.holderDoc, 20);
    if (!bank) throw new AppError('Elegí el banco o billetera');
    if (!account) throw new AppError('Ingresá el número de cuenta o alias');
    if (!holder) throw new AppError('Ingresá el nombre del titular');
    if (!holderDoc) throw new AppError('Ingresá la cédula (CI) o RUC del titular');
    const pending = this.db.get(
      "SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ? AND status = 'pending'",
      user.id,
    ).c;
    if (pending >= MAX_PENDING_WITHDRAWALS) {
      throw new AppError('Ya tenés retiros pendientes. Esperá a que se procesen.');
    }
    const withdrawal = this.db.tx(() => {
      const res = this.db.run(
        `INSERT INTO withdrawals (user_id, amount, bank, account_type, account, holder, holder_doc, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        user.id,
        amount,
        bank,
        accountType || null,
        account,
        holder,
        holderDoc,
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      this.change(user.id, -amount, 'withdraw', { refId: id, note: `Retiro #${id} (pendiente)` });
      return this.getWithdrawal(id);
    });
    this.bus.emit('withdraw:new', withdrawal);
    this.bus.emit('activity', {
      kind: 'withdraw',
      text: `🏦 ${user.username} pidió un retiro de ${fmtGs(amount)}`,
      userId: user.id,
    });
    return withdrawal;
  }

  payWithdrawal(id, admin, note) {
    return this.db.tx(() => {
      const w = this.db.get('SELECT * FROM withdrawals WHERE id = ?', id);
      if (!w) throw new AppError('Retiro no encontrado', 404);
      if (w.status !== 'pending') throw new AppError('Este retiro ya fue procesado', 409);
      this.db.run(
        "UPDATE withdrawals SET status = 'paid', admin_note = ?, admin_id = ?, processed_at = ? WHERE id = ?",
        cleanText(note, 200) || null,
        admin.id,
        Date.now(),
        id,
      );
      this.db.run('UPDATE users SET total_withdraw = total_withdraw + ? WHERE id = ?', w.amount, w.user_id);
      this.db.onCommit(() => {
        this.bus.emit('notify', w.user_id, { kind: 'success', title: '¡Retiro enviado! 💸', text: `Te transferimos ${fmtGs(w.amount)} a ${w.bank}.` });
        this.bus.emit('withdraw:update', this.getWithdrawal(id));
      });
    });
  }

  rejectWithdrawal(id, admin, note) {
    return this.db.tx(() => {
      const w = this.db.get('SELECT * FROM withdrawals WHERE id = ?', id);
      if (!w) throw new AppError('Retiro no encontrado', 404);
      if (w.status !== 'pending') throw new AppError('Este retiro ya fue procesado', 409);
      const reason = cleanText(note, 200) || 'Datos bancarios incorrectos';
      this.db.run(
        "UPDATE withdrawals SET status = 'rejected', admin_note = ?, admin_id = ?, processed_at = ? WHERE id = ?",
        reason,
        admin.id,
        Date.now(),
        id,
      );
      this.change(w.user_id, w.amount, 'withdraw_refund', { refId: id, note: `Retiro #${id} rechazado`, adminId: admin.id });
      this.db.onCommit(() => {
        this.bus.emit('notify', w.user_id, { kind: 'error', title: 'Retiro rechazado', text: `Se devolvieron ${fmtGs(w.amount)} a tu saldo. Motivo: ${reason}` });
        this.bus.emit('withdraw:update', this.getWithdrawal(id));
      });
    });
  }

  // ───────────────────────── Ajustes del admin ─────────────────────────

  /** op: 'add' (sumar), 'sub' (restar) o 'set' (fijar saldo exacto). */
  adminAdjust(userId, op, rawAmount, note, admin) {
    const amount = parseAmount(rawAmount);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new AppError('Monto inválido');
    return this.db.tx(() => {
      const u = this.db.get('SELECT id, balance FROM users WHERE id = ?', userId);
      if (!u) throw new AppError('Usuario no encontrado', 404);
      let delta;
      if (op === 'add') delta = amount;
      else if (op === 'sub') delta = -amount;
      else if (op === 'set') delta = amount - u.balance;
      else throw new AppError('Operación inválida');
      if (delta === 0) return { balance: u.balance, delta: 0 };
      if (u.balance + delta < 0) throw new AppError(`No se puede restar más que el saldo actual (${fmtGs(u.balance)})`);
      const reason = cleanText(note, 200) || 'Ajuste del administrador';
      const balance = this.change(userId, delta, 'admin', { note: reason, adminId: admin.id });
      this.db.onCommit(() => {
        this.bus.emit('notify', userId, {
          kind: delta > 0 ? 'success' : 'info',
          title: 'Saldo actualizado',
          text: `${delta > 0 ? '+' : '−'}${fmtGs(Math.abs(delta))} · ${reason}`,
        });
      });
      return { balance, delta };
    });
  }
}

module.exports = { Wallet };
