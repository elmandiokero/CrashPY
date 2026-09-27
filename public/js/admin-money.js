// Depósitos y retiros: colas de pendientes con aprobación/rechazo e historial.
import { h, toast, fmtGs, fmtDate, parseAmount, copyText } from './shared.js';
import {
  state,
  call,
  post,
  icon,
  scope,
  viewHead,
  refreshBtn,
  dataTable,
  pager,
  searchBox,
  segmented,
  userLink,
  reqChip,
  ago,
  emptyState,
  errorState,
  loadingState,
  moneyInput,
  adorn,
  field,
  modalForm,
  quickPicks,
  plural,
  copyBtn,
  imageModal,
  debounce,
} from './admin-core.js';

const receiptUrl = (id) => `/api/admin/deposits/${encodeURIComponent(id)}/receipt`;

function kv(label, value, { mono = false, copy = false, cls = '' } = {}) {
  const empty = value === null || value === undefined || value === '';
  return h(
    'div',
    { class: `kv ${cls}`.trim() },
    h('span', { class: 'kv-k' }, label),
    h('span', { class: `kv-v${mono ? ' mono' : ''}${empty ? ' faint' : ''}` }, empty ? '—' : value),
    copy && !empty ? copyBtn(String(value), `Copiar ${label.toLowerCase()}`) : null,
  );
}

function requestSummary(r, kindText) {
  return h(
    'div',
    { class: 'appr-sum' },
    h('span', { class: 'appr-sum-user' }, r.username, ` ${kindText}`),
    h('strong', null, fmtGs(r.amount)),
    h('span', { class: 'muted' }, `#${r.id} · ${fmtDate(r.created_at)}`),
  );
}

// ───────────────────────── Acciones (se usan también desde la ficha del jugador) ─────────────────────────

export function approveDeposit(d, onDone) {
  const amount = moneyInput(d.amount, { 'aria-label': 'Monto a acreditar' });
  amount.id = `appr-${d.id}`;
  const note = h('input', { class: 'input', maxlength: 200, placeholder: 'Opcional' });
  const warn = h('div', { class: 'hint hint-warn' });
  const preview = h('div', { class: 'appr-preview' });
  const update = () => {
    const a = parseAmount(amount.value);
    warn.textContent = Number.isFinite(a) && a !== d.amount ? `Ojo: vas a acreditar un monto distinto al informado (${fmtGs(d.amount)}).` : '';
    if (Number.isFinite(d.user_balance) && Number.isFinite(a)) {
      preview.replaceChildren(h('span', { class: 'muted' }, `Saldo de ${d.username}: `), fmtGs(d.user_balance), h('span', { class: 'bal-arrow' }, '→'), h('b', { class: 'green' }, fmtGs(d.user_balance + a)));
    } else preview.replaceChildren();
  };
  amount.addEventListener('input', update);
  update();
  modalForm({
    title: `✅ Aprobar depósito #${d.id}`,
    content: h(
      'div',
      null,
      requestSummary(d, 'informó'),
      d.reference ? kv('Referencia', d.reference, { mono: true, copy: true }) : null,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: amount.id }, 'Monto a acreditar'), adorn(amount, 'Gs.'), warn),
      field('Nota interna (opcional)', note),
      preview,
      h('p', { class: 'hint' }, 'Aprobá solo si ya viste la plata en tu cuenta. El saldo se acredita al instante y el jugador recibe un aviso.'),
    ),
    submitText: 'Aprobar y acreditar',
    onSubmit: async () => {
      const a = parseAmount(amount.value);
      if (!Number.isSafeInteger(a) || a <= 0) throw new Error('Ingresá un monto válido para acreditar');
      const r = await post(`/api/admin/deposits/${d.id}/approve`, { amount: a, note: note.value.trim() });
      toast(`Se acreditaron ${fmtGs(r.credited)} a ${d.username}`, 'success', '💰 Depósito aprobado');
      onDone?.(d.id, 'approved');
    },
  });
}

export function rejectDeposit(d, onDone) {
  const reason = h('input', { class: 'input', maxlength: 200, placeholder: 'No se encontró la transferencia' });
  modalForm({
    title: `Rechazar depósito #${d.id}`,
    content: h(
      'div',
      null,
      requestSummary(d, 'informó'),
      field('Motivo (lo ve el jugador)', reason),
      quickPicks(['No se encontró la transferencia', 'El monto no coincide', 'Comprobante ilegible o inválido', 'Depósito duplicado'], reason),
      h('p', { class: 'hint' }, 'No se acredita nada. Si lo dejás vacío se usa «No se encontró la transferencia».'),
    ),
    submitText: 'Rechazar depósito',
    submitClass: 'btn-danger',
    onSubmit: async () => {
      await post(`/api/admin/deposits/${d.id}/reject`, { note: reason.value.trim() });
      toast(`Rechazaste el depósito #${d.id} de ${d.username}`, 'info', 'Depósito rechazado');
      onDone?.(d.id, 'rejected');
    },
  });
}

function bankFields(w) {
  return h(
    'div',
    { class: 'kvs' },
    kv('Banco / billetera', w.bank, { copy: true }),
    kv('Tipo de cuenta', w.account_type, { copy: true }),
    kv('Cuenta / alias', w.account, { mono: true, copy: true, cls: 'kv-strong' }),
    kv('Titular', w.holder, { copy: true, cls: 'kv-strong' }),
    kv('CI / RUC', w.holder_doc, { mono: true, copy: true }),
  );
}

function bankText(w) {
  return [
    `Monto: ${fmtGs(w.amount)}`,
    `Banco: ${w.bank || '—'}`,
    w.account_type ? `Tipo de cuenta: ${w.account_type}` : null,
    `Cuenta / alias: ${w.account || '—'}`,
    `Titular: ${w.holder || '—'}`,
    `CI / RUC: ${w.holder_doc || '—'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function payWithdrawal(w, onDone) {
  const note = h('input', { class: 'input', maxlength: 200, placeholder: 'Ej: transferencia nro. 123456' });
  modalForm({
    title: `💸 Pagar retiro #${w.id}`,
    content: h(
      'div',
      null,
      h('div', { class: 'pay-head' }, h('span', { class: 'muted' }, `${w.username} pidió retirar · #${w.id} · ${fmtDate(w.created_at)}`)),
      h('div', { class: 'pay-amount' }, h('span', null, 'Transferí exactamente'), h('strong', null, fmtGs(w.amount)), copyBtn(String(w.amount), 'Copiar monto')),
      bankFields(w),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block copy-all', onclick: () => copyText(bankText(w)) }, icon('copy', 15), 'Copiar todos los datos'),
      field('Nota o nro. de transferencia (opcional)', note),
      h('p', { class: 'hint' }, 'Marcalo como pagado solo después de hacer la transferencia. El jugador recibe un aviso.'),
    ),
    submitText: 'Ya transferí · marcar pagado',
    onSubmit: async () => {
      await post(`/api/admin/withdrawals/${w.id}/pay`, { note: note.value.trim() });
      toast(`Retiro #${w.id} de ${w.username} marcado como pagado`, 'success', '💸 Retiro pagado');
      onDone?.(w.id, 'paid');
    },
  });
}

export function rejectWithdrawal(w, onDone) {
  const reason = h('input', { class: 'input', maxlength: 200, placeholder: 'Datos bancarios incorrectos' });
  modalForm({
    title: `Rechazar retiro #${w.id}`,
    content: h(
      'div',
      null,
      requestSummary(w, 'pidió retirar'),
      h('div', { class: 'refund-note' }, '↩️ ', h('span', null, 'Se devuelven ', h('b', null, fmtGs(w.amount)), ` al saldo de ${w.username}.`)),
      field('Motivo (lo ve el jugador)', reason),
      quickPicks(['Datos bancarios incorrectos', 'El titular no coincide con la cuenta', 'La cuenta no acepta transferencias', 'Actividad sospechosa'], reason),
    ),
    submitText: 'Rechazar y devolver saldo',
    submitClass: 'btn-danger',
    onSubmit: async () => {
      await post(`/api/admin/withdrawals/${w.id}/reject`, { note: reason.value.trim() });
      toast(`Se devolvieron ${fmtGs(w.amount)} al saldo de ${w.username}`, 'info', 'Retiro rechazado');
      onDone?.(w.id, 'rejected');
    },
  });
}

// ───────────────────────── Tarjetas de pendientes ─────────────────────────

function cardShell(r, kindLabel, ...children) {
  return h(
    'article',
    { class: 'req-card', dataset: { id: r.id } },
    h(
      'div',
      { class: 'req-top' },
      userLink(r.user_id, r.username),
      h('span', { class: 'req-meta' }, h('span', { class: 'req-new' }, 'NUEVO'), `${kindLabel} #${r.id} · `, ago(r.created_at)),
    ),
    children,
  );
}

function depositCard(d, done) {
  return cardShell(
    d,
    'Depósito',
    h('div', { class: 'req-amount' }, h('span', null, fmtGs(d.amount)), copyBtn(String(d.amount), 'Copiar monto')),
    h(
      'div',
      { class: 'kvs' },
      kv('Referencia', d.reference, { mono: true, copy: true, cls: 'kv-strong' }),
      kv('Titular que transfirió', d.sender_name),
      kv('Banco', d.sender_bank),
      kv('Fecha', fmtDate(d.created_at)),
      kv('Saldo actual del jugador', Number.isFinite(d.user_balance) ? fmtGs(d.user_balance) : null),
    ),
    d.receipt
      ? h(
          'button',
          { type: 'button', class: 'receipt', title: 'Ver comprobante', onclick: () => imageModal(receiptUrl(d.id), `Comprobante del depósito #${d.id}`) },
          h('img', { src: receiptUrl(d.id), alt: 'Comprobante', loading: 'lazy' }),
          h('span', { class: 'receipt-label' }, icon('image', 15), 'Ver comprobante'),
        )
      : h('div', { class: 'receipt receipt-none' }, icon('image', 16), 'Sin foto del comprobante'),
    h(
      'div',
      { class: 'req-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => approveDeposit(d, done) }, icon('check', 18), 'Aprobar'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-reject', onclick: () => rejectDeposit(d, done) }, icon('x', 18), 'Rechazar'),
    ),
  );
}

function withdrawCard(w, done) {
  return cardShell(
    w,
    'Retiro',
    h('div', { class: 'req-amount' }, h('span', null, fmtGs(w.amount)), copyBtn(String(w.amount), 'Copiar monto')),
    bankFields(w),
    h('div', { class: 'kvs kvs-soft' }, kv('Saldo actual del jugador', Number.isFinite(w.user_balance) ? fmtGs(w.user_balance) : null), kv('Pedido', fmtDate(w.created_at))),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block copy-all', onclick: () => copyText(bankText(w)) }, icon('copy', 15), 'Copiar todos los datos'),
    h(
      'div',
      { class: 'req-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => payWithdrawal(w, done) }, icon('check', 18), 'Marcar pagado'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-reject', onclick: () => rejectWithdrawal(w, done) }, icon('x', 18), 'Rechazar'),
    ),
  );
}

// ───────────────────────── Historial ─────────────────────────

function mainCell(r) {
  return h('div', { class: 'req-main' }, h('b', { class: 'mono' }, `#${r.id}`), userLink(r.user_id, r.username), reqChip(r.status));
}

function depositCols(done) {
  return [
    { label: 'Depósito', main: true, render: mainCell },
    { label: 'Monto', cls: 'num', render: (d) => fmtGs(d.amount) },
    { label: 'Acreditado', cls: 'num', render: (d) => (d.credited != null ? h('b', { class: 'green' }, fmtGs(d.credited)) : null) },
    { label: 'Referencia', cls: 'wrap-cell', render: (d) => (d.reference ? h('span', { class: 'mono' }, d.reference) : null) },
    {
      label: 'Comprobante',
      render: (d) =>
        d.receipt
          ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => imageModal(receiptUrl(d.id), `Comprobante del depósito #${d.id}`) }, icon('image', 15), 'Ver')
          : null,
    },
    { label: 'Admin', render: (d) => d.admin_name },
    { label: 'Nota', cls: 'wrap-cell', render: (d) => d.admin_note },
    { label: 'Informado', cls: 'num', render: (d) => fmtDate(d.created_at) },
    { label: 'Procesado', cls: 'num', render: (d) => (d.processed_at ? fmtDate(d.processed_at) : null) },
    {
      label: 'Acciones',
      render: (d) =>
        d.status === 'pending'
          ? h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => approveDeposit(d, done) }, 'Aprobar'),
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => rejectDeposit(d, done) }, 'Rechazar'),
            )
          : null,
    },
  ];
}

function withdrawCols(done) {
  return [
    { label: 'Retiro', main: true, render: mainCell },
    { label: 'Monto', cls: 'num', render: (w) => h('b', null, fmtGs(w.amount)) },
    { label: 'Banco', render: (w) => w.bank },
    { label: 'Cuenta / alias', cls: 'wrap-cell', render: (w) => h('span', { class: 'mono' }, w.account) },
    { label: 'Titular', cls: 'wrap-cell', render: (w) => w.holder },
    { label: 'CI / RUC', render: (w) => (w.holder_doc ? h('span', { class: 'mono' }, w.holder_doc) : null) },
    { label: 'Admin', render: (w) => w.admin_name },
    { label: 'Nota', cls: 'wrap-cell', render: (w) => w.admin_note },
    { label: 'Pedido', cls: 'num', render: (w) => fmtDate(w.created_at) },
    { label: 'Procesado', cls: 'num', render: (w) => (w.processed_at ? fmtDate(w.processed_at) : null) },
    {
      label: 'Acciones',
      render: (w) =>
        w.status === 'pending'
          ? h(
              'div',
              { class: 'row-actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => payWithdrawal(w, done) }, 'Pagado'),
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => rejectWithdrawal(w, done) }, 'Rechazar'),
            )
          : null,
    },
  ];
}

// ───────────────────────── Vistas ─────────────────────────

const KINDS = {
  deposit: {
    title: 'Depósitos',
    subtitle: 'Revisá las transferencias que informan los jugadores y acreditá el saldo.',
    endpoint: '/api/admin/deposits',
    tabs: [
      ['pending', 'Pendientes'],
      ['approved', 'Aprobados'],
      ['rejected', 'Rechazados'],
      ['all', 'Todos'],
    ],
    pendingKey: 'deposits',
    newEvent: 'deposit:new',
    updEvent: 'deposit:update',
    card: depositCard,
    cols: depositCols,
    noun: ['depósito', 'depósitos'],
    allClear: '¡Todo al día! No hay depósitos por revisar.',
    emoji: '💰',
  },
  withdraw: {
    title: 'Retiros',
    subtitle: 'Transferí a la cuenta del jugador y marcá el retiro como pagado.',
    endpoint: '/api/admin/withdrawals',
    tabs: [
      ['pending', 'Pendientes'],
      ['paid', 'Pagados'],
      ['rejected', 'Rechazados'],
      ['all', 'Todos'],
    ],
    pendingKey: 'withdrawals',
    newEvent: 'withdraw:new',
    updEvent: 'withdraw:update',
    card: withdrawCard,
    cols: withdrawCols,
    noun: ['retiro', 'retiros'],
    allClear: '¡Todo al día! No hay retiros por pagar.',
    emoji: '🏦',
  },
};

function requestsView(kind) {
  const K = KINDS[kind];
  const st = { status: 'pending', q: '', page: 1 };
  return {
    sc: null,
    seq: 0,
    mount(el) {
      const sc = scope();
      this.sc = sc;
      const box = h('div', { class: 'req-box' }, loadingState());
      const summary = h('div', { class: 'req-summary' });
      let grid = null;
      let lastCount = -1;

      const tabOptions = () => {
        const n = state.pending[K.pendingKey].n;
        return K.tabs.map(([v, label]) => [v, label, v === 'pending' && n ? String(n) : null]);
      };
      const seg = segmented(tabOptions(), st.status, (s) => {
        st.status = s;
        st.page = 1;
        load();
      }, 'req-tabs');

      const renderSummary = () => {
        const p = state.pending[K.pendingKey];
        if (p.n !== lastCount) {
          lastCount = p.n;
          seg.setOptions(tabOptions());
        }
        summary.replaceChildren(
          p.n
            ? h('span', null, h('b', null, plural(p.n, `${K.noun[0]} pendiente`, `${K.noun[1]} pendientes`)), ' · ', h('b', { class: 'gold' }, fmtGs(p.total)), ' en total')
            : h('span', { class: 'green' }, '✓ No hay pendientes'),
        );
      };

      const removeCard = (id) => {
        if (!grid) return;
        const card = grid.querySelector(`[data-id="${Number(id)}"]`);
        if (!card) return;
        card.classList.add('is-leaving');
        setTimeout(() => {
          card.remove();
          if (grid && !grid.children.length) box.replaceChildren(emptyState(K.allClear, '✅'));
        }, 280);
      };
      const done = (id) => {
        if (st.status === 'pending') removeCard(id);
        else reloadSoon();
      };

      const load = async () => {
        const seq = ++this.seq;
        box.classList.add('is-refreshing');
        const qs = new URLSearchParams({ status: st.status, q: st.q, page: String(st.page) });
        try {
          const res = await call(`${K.endpoint}?${qs}`);
          if (seq !== this.seq) return;
          if (st.status === 'pending') {
            if (!res.items.length) {
              grid = null;
              box.replaceChildren(emptyState(st.q ? 'No hay pendientes de ese usuario' : K.allClear, st.q ? '🔎' : '✅'));
            } else {
              grid = h('div', { class: 'req-grid' }, res.items.map((r) => K.card(r, done)));
              box.replaceChildren(
                grid,
                res.pages > 1
                  ? pager(res, res.total === 1 ? `${K.noun[0]} pendiente` : `${K.noun[1]} pendientes`, (p) => {
                      st.page = p;
                      load();
                    })
                  : '',
              );
            }
          } else {
            grid = null;
            box.replaceChildren(
              h('section', { class: 'acard acard-flush' }, dataTable(K.cols(done), res.items, { empty: `No hay ${K.noun[1]} para mostrar`, emptyEmoji: K.emoji, mobileLimit: 15 })),
              pager(res, res.total === 1 ? K.noun[0] : K.noun[1], (p) => {
                st.page = p;
                load();
              }),
            );
          }
        } catch (err) {
          if (seq === this.seq) box.replaceChildren(errorState(err, load));
        } finally {
          if (seq === this.seq) box.classList.remove('is-refreshing');
        }
      };
      const reloadSoon = debounce(load, 500);

      sc.on(K.newEvent, (row) => {
        if (st.status === 'pending' && !st.q && st.page === 1) {
          if (!grid) {
            grid = h('div', { class: 'req-grid' });
            box.replaceChildren(grid);
          }
          if (grid.querySelector(`[data-id="${Number(row.id)}"]`)) return;
          const online = (state.online || []).find((o) => o.id === row.user_id);
          const cardEl = K.card({ ...row, user_balance: row.user_balance ?? (online ? online.balance : null) }, done);
          cardEl.classList.add('is-new');
          grid.prepend(cardEl);
        } else if (st.status === 'all') reloadSoon();
      });
      sc.on(K.updEvent, (row) => {
        if (st.status === 'pending') removeCard(row.id);
        else if (st.status === 'all' || st.status === row.status) reloadSoon();
      });
      sc.on('stats', renderSummary);

      el.append(
        viewHead(K.title, K.subtitle, refreshBtn(load)),
        h('div', { class: 'req-toolbar' }, seg, searchBox(st.q, 'Buscar por usuario…', (q) => {
          st.q = q;
          st.page = 1;
          load();
        })),
        summary,
        box,
      );
      renderSummary();
      load();
    },
    unmount() {
      this.seq++;
      this.sc?.dispose();
      this.sc = null;
    },
  };
}

export const depositsView = requestsView('deposit');
export const withdrawalsView = requestsView('withdraw');
