// Pantalla provisoria (se reemplaza por el juego completo).
import { h } from '../shared.js';
import { loadPlays } from './common.js';

export function createPenalty(shell) {
  return {
    id: 'penalty',
    mount(root) {
      root.append(h('div', { class: 'gv-stage', style: { padding: '60px 20px', textAlign: 'center' } }, 'Penales: en construcción 🛠️'));
    },
    loadMine: (container) => loadPlays(shell, container, 'penalty'),
    rules: () => h('p', null, 'Penales'),
  };
}
