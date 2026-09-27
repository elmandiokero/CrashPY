// Pantalla provisoria (se reemplaza por el juego completo).
import { h } from '../shared.js';
import { loadPlays } from './common.js';

export function createPlinko(shell) {
  return {
    id: 'plinko',
    mount(root) {
      root.append(h('div', { class: 'gv-stage', style: { padding: '60px 20px', textAlign: 'center' } }, 'Plinko: en construcción 🛠️'));
    },
    loadMine: (container) => loadPlays(shell, container, 'plinko'),
    rules: () => h('p', null, 'Plinko'),
  };
}
