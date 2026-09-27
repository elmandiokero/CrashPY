// Pantalla provisoria (se reemplaza por el juego completo).
import { h } from '../shared.js';
import { loadPlays } from './common.js';

export function createDouble(shell) {
  return {
    id: 'double',
    mount(root) {
      root.append(h('div', { class: 'gv-stage', style: { padding: '60px 20px', textAlign: 'center' } }, 'Double: en construcción 🛠️'));
    },
    loadMine: (container) => loadPlays(shell, container, 'double'),
    rules: () => h('p', null, 'Double'),
  };
}
