/**
 * UI.js — HTML/CSS HUD overlay: health bar, score, damage flash and the
 * game-over card. Pure DOM manipulation; all styling lives in styles.css.
 */

export class UI {
  constructor() {
    this.healthFill = document.getElementById('health-fill');
    this.healthLabel = document.getElementById('health-label');
    this.pointsValue = document.getElementById('points-value');
    this.damageFlash = document.getElementById('damage-flash');
    this.gameOver = document.getElementById('game-over');
    this.finalScore = document.getElementById('final-score');
    this.restartBtn = document.getElementById('restart-btn');
    this.hint = document.getElementById('hint');

    this._flashTimeout = 0;
    this._popTimeout = 0;
    this._hintTimeout = window.setTimeout(() => {
      this.hint.classList.add('faded');
    }, 9000);
  }

  setHealth(value) {
    const pct = Math.max(0, Math.min(100, value));
    this.healthFill.style.width = pct + '%';
    this.healthLabel.textContent = String(Math.round(pct));
    this.healthFill.classList.toggle('low', pct <= 30);
  }

  setPoints(value) {
    this.pointsValue.textContent = String(value);
    this.pointsValue.classList.remove('pop');
    // Force a reflow so re-adding the class restarts the CSS animation.
    void this.pointsValue.offsetWidth;
    this.pointsValue.classList.add('pop');
    window.clearTimeout(this._popTimeout);
    this._popTimeout = window.setTimeout(() => this.pointsValue.classList.remove('pop'), 400);
  }

  flashDamage() {
    this.damageFlash.classList.remove('active');
    void this.damageFlash.offsetWidth;
    this.damageFlash.classList.add('active');
    window.clearTimeout(this._flashTimeout);
    this._flashTimeout = window.setTimeout(() => this.damageFlash.classList.remove('active'), 500);
  }

  showGameOver(score) {
    this.finalScore.textContent = String(score);
    this.gameOver.classList.add('visible');
  }

  hideGameOver() {
    this.gameOver.classList.remove('visible');
  }

  bindRestart(callback) {
    this.restartBtn.addEventListener('click', callback);
  }

  dispose() {
    window.clearTimeout(this._flashTimeout);
    window.clearTimeout(this._popTimeout);
    window.clearTimeout(this._hintTimeout);
  }
}
