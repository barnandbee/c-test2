/**
 * main.js — Entry point. Boots the game once the DOM is ready.
 */

import { Game } from './Game.js';

function boot() {
  const container = document.getElementById('app');
  const game = new Game(container);
  game.start();
  // Debug handle for the console / automated smoke tests.
  window.__game = game;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
