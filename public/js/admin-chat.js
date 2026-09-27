// Chat: moderación en vivo, anuncios y controles.
import { h, toast, confirmDialog, fmtTime, fmtDate } from './shared.js';
import { state, call, post, icon, scope, card, viewHead, refreshBtn, avatar, userLink, emptyState, errorState, loadingState, notifyError } from './admin-core.js';
import { setUserFlags } from './admin-users.js';

const NEAR_BOTTOM = 90;

function deleteMsg(m, el) {
  el.classList.add('is-deleting');
  post(`/api/admin/chat/${m.id}/delete`).catch((err) => {
    el.classList.remove('is-deleting');
    notifyError(err);
  });
}

function msgEl(m) {
  const time = h('time', { class: 'cmsg-time', title: fmtDate(m.ts) }, fmtTime(m.ts));
  let el;
  const del = h('button', { type: 'button', class: 'cmsg-act', title: 'Borrar mensaje', 'aria-label': 'Borrar mensaje', onclick: () => deleteMsg(m, el) }, icon('trash', 15));
  if (m.kind === 'system' || m.kind === 'win') {
    el = h(
      'div',
      { class: `cmsg cmsg-${m.kind}` },
      h('div', { class: 'cmsg-sys' }, h('span', { class: 'cmsg-text' }, m.text), time),
      h('div', { class: 'cmsg-actions' }, del),
    );
  } else if (m.kind === 'announce') {
    el = h(
      'div',
      { class: 'cmsg cmsg-announce' },
      h('div', { class: 'cmsg-body' }, h('div', { class: 'cmsg-ann-head' }, h('span', null, '📢 Anuncio'), m.user ? h('span', { class: 'muted' }, `· ${m.user}`) : null, time), h('div', { class: 'cmsg-text' }, m.text)),
      h('div', { class: 'cmsg-actions' }, del),
    );
  } else {
    const isAdmin = m.role === 'admin';
    const mute =
      !isAdmin && m.uid
        ? h(
            'button',
            {
              type: 'button',
              class: 'cmsg-act',
              title: `Silenciar a ${m.user}`,
              'aria-label': `Silenciar a ${m.user}`,
              onclick: () => setUserFlags(m.uid, m.user, { muted: true }),
            },
            icon('mute', 15),
          )
        : null;
    el = h(
      'div',
      { class: `cmsg cmsg-user${isAdmin ? ' is-admin' : ''}` },
      avatar(m.user),
      h(
        'div',
        { class: 'cmsg-body' },
        h('div', { class: 'cmsg-meta' }, userLink(m.uid, m.user, { withAvatar: false }), isAdmin ? h('span', { class: 'chip chip-gold' }, 'ADMIN') : null, time),
        h('div', { class: 'cmsg-text' }, m.text),
      ),
      h('div', { class: 'cmsg-actions' }, mute, del),
    );
  }
  el.dataset.id = m.id;
  return el;
}

export const chatView = {
  sc: null,
  seq: 0,
  mount(el) {
    const sc = scope();
    this.sc = sc;
    const list = h('div', { class: 'chat-list', role: 'log', 'aria-label': 'Mensajes del chat' });
    const empty = emptyState('El chat está vacío', '💬');
    const jump = h('button', { type: 'button', class: 'chat-jump', hidden: true }, icon('arrowDown', 15), 'Mensajes nuevos');
    const scroller = h('div', { class: 'chat-scroll' }, loadingState());
    const count = h('span', { class: 'acard-sub' });

    const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM;
    let stick = true; // seguir el final del chat hasta que el admin suba a leer
    const toBottom = () => {
      stick = true;
      scroller.scrollTop = scroller.scrollHeight;
      jump.hidden = true;
    };
    // Si el contenido crece (fuentes/emojis que cargan tarde, mensajes nuevos) seguimos abajo.
    const ro = new ResizeObserver(() => {
      if (stick) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(list);
    sc.add(() => ro.disconnect());
    const updateCount = () => {
      const n = list.children.length;
      count.textContent = n ? `${n} ${n === 1 ? 'mensaje' : 'mensajes'}` : '';
      empty.hidden = n > 0;
    };
    scroller.addEventListener('scroll', () => {
      stick = nearBottom();
      if (stick) jump.hidden = true;
    });
    jump.addEventListener('click', toBottom);

    const load = async () => {
      const seq = ++this.seq;
      try {
        const res = await call('/api/admin/chat');
        if (seq !== this.seq) return;
        list.replaceChildren(...(res.items || []).map(msgEl));
        scroller.replaceChildren(list, empty);
        updateCount();
        requestAnimationFrame(toBottom);
      } catch (err) {
        if (seq === this.seq) scroller.replaceChildren(errorState(err, load));
      }
    };

    sc.on('chat', (m) => {
      if (!list.isConnected || list.querySelector(`[data-id="${Number(m.id)}"]`)) return;
      const node = msgEl(m);
      node.classList.add('is-new');
      list.append(node);
      while (list.children.length > 200) list.firstChild.remove();
      updateCount();
      if (stick) requestAnimationFrame(toBottom);
      else jump.hidden = false;
    });
    sc.on('chatDelete', (d) => {
      const node = list.querySelector(`[data-id="${Number(d && d.id)}"]`);
      if (node) {
        node.classList.add('is-leaving');
        setTimeout(() => {
          node.remove();
          updateCount();
        }, 220);
      }
    });
    sc.on('chatClear', () => {
      list.replaceChildren();
      updateCount();
    });

    // Escribir como admin (usa la conexión del juego, así el mensaje sale con la etiqueta ADMIN)
    const input = h('input', { class: 'input', maxlength: 200, placeholder: 'Escribí como admin…', autocomplete: 'off', enterkeyhint: 'send' });
    const send = h('button', { type: 'submit', class: 'btn btn-blue', title: 'Enviar', 'aria-label': 'Enviar' }, icon('send', 17));
    const compose = h('form', { class: 'chat-compose', novalidate: true }, input, send);
    compose.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const sock = state.gameSock;
      if (!sock || !sock.connected) {
        toast('Sin conexión en tiempo real, probá en unos segundos', 'error');
        return;
      }
      send.disabled = true;
      sock.timeout(6000).emit('chat', { text }, (err, res) => {
        send.disabled = false;
        if (err) return toast('El servidor no respondió, probá de nuevo', 'error');
        if (!res || !res.ok) return toast((res && res.error) || 'No se pudo enviar', 'error');
        input.value = '';
      });
    });

    // Anuncio destacado
    const ann = h('textarea', { class: 'input', maxlength: 300, rows: 3, placeholder: 'Ej: ¡Esta noche hay bono del 20% en depósitos! 🎉' });
    const annCount = h('span', { class: 'hint' }, '0/300');
    ann.addEventListener('input', () => {
      annCount.textContent = `${ann.value.length}/300`;
    });
    const annBtn = h('button', { type: 'submit', class: 'btn btn-gold btn-block' }, icon('megaphone', 17), 'Publicar anuncio');
    const annForm = h('form', { class: 'ann-form', novalidate: true }, ann, h('div', { class: 'ann-foot' }, h('span', { class: 'hint' }, 'Se muestra destacado a todos los jugadores.'), annCount), annBtn);
    annForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ann.value.trim();
      if (!text) {
        toast('Escribí el anuncio', 'error');
        return;
      }
      annBtn.disabled = true;
      try {
        await post('/api/admin/chat/announce', { text });
        ann.value = '';
        annCount.textContent = '0/300';
        toast('Anuncio publicado en el chat', 'success', '📢 Listo');
      } catch (err) {
        notifyError(err);
      } finally {
        annBtn.disabled = false;
      }
    });

    // Controles
    const sw = h('input', { type: 'checkbox' });
    sw.checked = state.settings.chat_enabled !== false;
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      try {
        await post('/api/admin/settings', { chat_enabled: sw.checked });
        state.settings.chat_enabled = sw.checked;
        toast(sw.checked ? 'El chat está habilitado para todos' : 'Chat desactivado: solo los admins pueden escribir', 'success');
      } catch (err) {
        sw.checked = !sw.checked;
        notifyError(err);
      } finally {
        sw.disabled = false;
      }
    });
    sc.on('settings', (s) => {
      if (s && 'chat_enabled' in s) sw.checked = !!s.chat_enabled;
    });
    const clear = h('button', { type: 'button', class: 'btn btn-ghost btn-block btn-danger-ghost' }, icon('trash', 16), 'Limpiar todo el chat');
    clear.addEventListener('click', async () => {
      const ok = await confirmDialog('Se borran todos los mensajes para todos los jugadores. No se puede deshacer.', {
        title: '🧹 Limpiar el chat',
        okText: 'Limpiar chat',
        danger: true,
      });
      if (!ok) return;
      try {
        await post('/api/admin/chat/clear');
        toast('Chat limpiado', 'success');
      } catch (err) {
        notifyError(err);
      }
    });

    el.append(
      viewHead('Chat', 'Moderá el chat del juego en tiempo real.', refreshBtn(load)),
      h(
        'div',
        { class: 'chat-layout' },
        card('Mensajes en vivo', { cls: 'chat-card', icon: 'chat', actions: count }, h('div', { class: 'chat-frame' }, scroller, jump), compose),
        h(
          'div',
          { class: 'chat-side' },
          card('Anuncio', { icon: 'megaphone' }, annForm),
          card(
            'Controles',
            { icon: 'sliders' },
            h('label', { class: 'switch switch-row' }, sw, h('span', { class: 'track' }), h('span', null, 'Chat habilitado para los jugadores')),
            h('p', { class: 'hint' }, 'Tocá el nombre de un jugador para ver su ficha. 🔇 lo silencia y 🗑 borra el mensaje.'),
            clear,
          ),
          card(
            'Tipos de mensaje',
            { icon: 'book' },
            h(
              'div',
              { class: 'chat-legend' },
              h('span', { class: 'lg lg-user' }, 'Jugador'),
              h('span', { class: 'lg lg-admin' }, 'Admin'),
              h('span', { class: 'lg lg-win' }, '🔥 Ganancia grande'),
              h('span', { class: 'lg lg-system' }, 'Sistema'),
              h('span', { class: 'lg lg-announce' }, '📢 Anuncio'),
            ),
          ),
        ),
      ),
    );
    load();
  },
  unmount() {
    this.seq++;
    this.sc?.dispose();
    this.sc = null;
  },
};
