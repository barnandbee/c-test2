/**
 * UI.js — HTML/CSS HUD overlay: health bar, score, countdown timer, time
 * toast, damage flash and the game-over card (with local high score and
 * the unlockable character selection). Pure DOM manipulation; all styling
 * lives in styles.css.
 */

/** Scores may carry π-flavored decimals (thanks, Red October). */
function formatScore(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100000) / 100000);
}

export class UI {
  constructor() {
    this.healthFill = document.getElementById('health-fill');
    this.healthLabel = document.getElementById('health-label');
    this.pointsValue = document.getElementById('points-value');
    this.timerValue = document.getElementById('timer-value');
    this.timerPanel = document.getElementById('timer-panel');
    this.timeToast = document.getElementById('time-toast');
    this.damageFlash = document.getElementById('damage-flash');
    this.gameOver = document.getElementById('game-over');
    this.gameOverTitle = document.getElementById('game-over-title');
    this.gameOverSubtitle = document.getElementById('game-over-subtitle');
    this.finalScore = document.getElementById('final-score');
    this.highScoreValue = document.getElementById('high-score');
    this.newHighBadge = document.getElementById('new-high-badge');
    this.characterSelect = document.getElementById('character-select');
    this.unlockNote = document.getElementById('unlock-note');
    this.restartBtn = document.getElementById('restart-btn');
    this.hint = document.getElementById('hint');
    this.puttPanel = document.getElementById('putt-panel');
    this.puttStrokes = document.getElementById('putt-strokes');
    this.puttFill = document.getElementById('putt-fill');
    this.travelPanel = document.getElementById('travel-panel');
    this.menu = document.getElementById('menu');
    this.menuRoster = document.getElementById('menu-roster');
    this.menuBestRow = document.getElementById('menu-best-row');
    this.menuBestValue = document.getElementById('menu-best');
    this.startBtn = document.getElementById('start-btn');

    this._flashTimeout = 0;
    this._popTimeout = 0;
    this._toastTimeout = 0;
    this._selectedCharacter = null;
    this._lastTimerText = '';
    this._hintTimeout = window.setTimeout(() => {
      this.hint.classList.add('faded');
    }, 9000);

    // Character cards toggle a .selected highlight and remember the pick.
    this.charCards = Array.from(document.querySelectorAll('.char-card'));
    this._onCardClick = (e) => {
      const card = e.currentTarget;
      this._selectedCharacter = card.dataset.char;
      for (const c of this.charCards) c.classList.toggle('selected', c === card);
    };
    for (const card of this.charCards) card.addEventListener('click', this._onCardClick);
  }

  setHealth(value) {
    const pct = Math.max(0, Math.min(100, value));
    this.healthFill.style.width = pct + '%';
    this.healthLabel.textContent = String(Math.round(pct));
    this.healthFill.classList.toggle('low', pct <= 30);
  }

  setPoints(value) {
    this.pointsValue.textContent = formatScore(value);
    this.pointsValue.classList.remove('pop');
    // Force a reflow so re-adding the class restarts the CSS animation.
    void this.pointsValue.offsetWidth;
    this.pointsValue.classList.add('pop');
    window.clearTimeout(this._popTimeout);
    this._popTimeout = window.setTimeout(() => this.pointsValue.classList.remove('pop'), 400);
  }

  /** Set the score display without the pop animation (resets). */
  setPointsSilent(value) {
    this.pointsValue.classList.remove('pop');
    this.pointsValue.textContent = formatScore(value);
  }

  /** Countdown display, m:ss, turning urgent under 30 seconds. */
  setTimer(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    // The DOM write is skipped unless the visible text actually changed.
    if (text !== this._lastTimerText) {
      this.timerValue.textContent = text;
      this._lastTimerText = text;
    }
    this.timerPanel.classList.toggle('low', seconds <= 30);
  }

  /** Floating "+10 SECONDS" style announcement. */
  showTimeToast(text) {
    this.timeToast.textContent = text;
    this.timeToast.classList.remove('active');
    void this.timeToast.offsetWidth;
    this.timeToast.classList.add('active');
    window.clearTimeout(this._toastTimeout);
    this._toastTimeout = window.setTimeout(() => this.timeToast.classList.remove('active'), 1600);
  }

  flashDamage() {
    this.damageFlash.classList.remove('active');
    void this.damageFlash.offsetWidth;
    this.damageFlash.classList.add('active');
    window.clearTimeout(this._flashTimeout);
    this._flashTimeout = window.setTimeout(() => this.damageFlash.classList.remove('active'), 500);
  }

  /**
   * opts: { score, highScore, isNewHigh, reason: 'time'|'health',
   *         unlocked: { badgerette, hughes }, newlyUnlockedNames: string[],
   *         currentCharacter }
   */
  showGameOver(opts) {
    if (opts.reason === 'time') {
      this.gameOverTitle.textContent = "Time's Up!";
      this.gameOverSubtitle.textContent = 'The twilight bell has tolled…';
    } else {
      this.gameOverTitle.textContent = 'The Forest Claims You';
      this.gameOverSubtitle.textContent = 'The twilight grows quiet…';
    }

    this.finalScore.textContent = formatScore(opts.score);
    this.highScoreValue.textContent = formatScore(opts.highScore);
    this.newHighBadge.classList.toggle('hidden', !opts.isNewHigh);

    const newly = opts.newlyUnlockedNames || [];
    this.unlockNote.classList.toggle('hidden', newly.length === 0);
    if (newly.length > 0) {
      this.unlockNote.textContent = `★ ${newly.join(' & ')} unlocked!`;
    }

    this.setRoster(opts.unlocked, opts.currentCharacter);
    this.gameOver.classList.add('visible');
  }

  /**
   * Sync every character card on the page (menu + game-over) with the
   * unlock state: rosters appear once anything beyond the badger is
   * earned, and locked heroes' cards stay hidden.
   */
  setRoster(unlocked, currentCharacter) {
    const anyUnlocked = Object.values(unlocked).some(Boolean);
    this.characterSelect.classList.toggle('hidden', !anyUnlocked);
    if (this.menuRoster) this.menuRoster.classList.toggle('hidden', !anyUnlocked);

    this._selectedCharacter = currentCharacter;
    for (const card of this.charCards) {
      const char = card.dataset.char;
      const available = char === 'badger' || Boolean(unlocked[char]);
      card.classList.toggle('hidden', !available);
      card.classList.toggle('selected', char === currentCharacter);
    }
  }

  /* ---------------- 'Puttmost Respect' ---------------- */

  showPutt() {
    this.puttPanel.classList.remove('hidden');
  }

  hidePutt() {
    this.puttPanel.classList.add('hidden');
  }

  setPuttStrokes(current, max) {
    this.puttStrokes.textContent = `STROKE ${current} / ${max}`;
  }

  setPuttPower(t) {
    this.puttFill.style.width = `${Math.round(t * 100)}%`;
  }

  /* ---------------- Mystic Line travel picker ---------------- */

  showTravel() {
    this.travelPanel.classList.remove('hidden');
  }

  hideTravel() {
    this.travelPanel.classList.add('hidden');
  }

  /** onSelect('cave'|'lake'|'copse'); onClose() for the ✕. */
  bindTravel(onSelect, onClose) {
    for (const btn of this.travelPanel.querySelectorAll('.travel-option')) {
      btn.addEventListener('click', () => onSelect(btn.dataset.dest));
    }
    this.travelPanel
      .querySelector('#travel-close')
      .addEventListener('click', onClose);
  }

  /* ---------------- welcome menu ---------------- */

  showMenu() {
    if (this.menu) this.menu.classList.remove('dismissed');
  }

  hideMenu() {
    if (this.menu) this.menu.classList.add('dismissed');
  }

  setMenuBest(score) {
    if (!this.menuBestRow) return;
    this.menuBestRow.classList.toggle('hidden', !score);
    if (score) this.menuBestValue.textContent = formatScore(score);
  }

  bindStart(callback) {
    if (this.startBtn) this.startBtn.addEventListener('click', callback);
  }

  hideGameOver() {
    this.gameOver.classList.remove('visible');
  }

  /** The character picked on the game-over screen (null = untouched). */
  getSelectedCharacter() {
    return this._selectedCharacter;
  }

  bindRestart(callback) {
    this.restartBtn.addEventListener('click', callback);
  }

  dispose() {
    window.clearTimeout(this._flashTimeout);
    window.clearTimeout(this._popTimeout);
    window.clearTimeout(this._toastTimeout);
    window.clearTimeout(this._hintTimeout);
    for (const card of this.charCards) card.removeEventListener('click', this._onCardClick);
  }
}
