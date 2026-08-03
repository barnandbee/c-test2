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

/**
 * The in-world signs are painted onto canvases at build time, so the web
 * fonts they use must be ready first — otherwise they'd fall back to a
 * system face. Wait for the fonts (with a short timeout so a slow/blocked
 * font server can never hang the boot), then start.
 */
async function bootWhenFontsReady() {
  try {
    if (document.fonts && document.fonts.load) {
      await Promise.race([
        Promise.all([
          document.fonts.load('700 40px "Lilita One"'),
          document.fonts.load('400 40px "Lilita One"')
        ]),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    }
  } catch (e) {
    /* fall through and boot with whatever's available */
  }
  boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootWhenFontsReady, { once: true });
} else {
  bootWhenFontsReady();
}
