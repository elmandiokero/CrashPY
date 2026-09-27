// Pantalla provisoria (se reemplaza por el juego completo).
import { h } from '../shared.js';
import { loadPlays } from './common.js';

export function createRoulette(shell) {
  return {
    id: 'roulette',
    mount(root) {
      root.append(h('div', { class: 'gv-stage', style: { padding: '60px 20px', textAlign: 'center' } }, 'Ruleta: en construcción 🛠️'));
    },
    loadMine: (container) => loadPlays(shell, container, 'roulette'),
    rules: () => h('p', null, 'Ruleta'),
  };
}
