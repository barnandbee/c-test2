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
    this.restartVsBtn = document.getElementById('restart-vs-btn');
    this.hint = document.getElementById('hint');
    this.puttPanel = document.getElementById('putt-panel');
    this.puttStrokes = document.getElementById('putt-strokes');
    this.puttFill = document.getElementById('putt-fill');
    this.travelPanel = document.getElementById('travel-panel');
    this.veggiePanel = document.getElementById('veggie-panel');
    this.veggieStatus = document.getElementById('veggie-status');
    this.achievementsBtn = document.getElementById('achievements-btn');
    this.achievementsPanel = document.getElementById('achievements-panel');
    this.achClose = document.getElementById('ach-close');
    this.achProgress = document.getElementById('ach-progress');
    this.achTotal = document.getElementById('ach-total');
    this.achFav = document.getElementById('ach-fav');
    this.achTrophies = document.getElementById('ach-trophies');
    this.achChars = document.getElementById('ach-chars');
    this.menu = document.getElementById('menu');
    this.menuRoster = document.getElementById('menu-roster');
    this.menuBestRow = document.getElementById('menu-best-row');
    this.menuBestValue = document.getElementById('menu-best');
    this.startBtn = document.getElementById('start-btn');
    this.startVsBtn = document.getElementById('start-vs-btn');
    this.vsDiffRow = document.getElementById('vs-difficulty-row');
    this.vsEasyBtn = document.getElementById('vs-easy-btn');
    this.vsHardBtn = document.getElementById('vs-hard-btn');
    this.restartDiffRow = document.getElementById('restart-difficulty-row');
    this.restartEasyBtn = document.getElementById('restart-easy-btn');
    this.restartHardBtn = document.getElementById('restart-hard-btn');
    this.vsPanel = document.getElementById('vs-panel');
    this.vsName = document.getElementById('vs-name');
    this.vsScore = document.getElementById('vs-score');
    this.vsResult = document.getElementById('vs-result');

    // The about / how-to-play modal is self-contained: wire it here.
    this.aboutBtn = document.getElementById('about-btn');
    this.aboutPanel = document.getElementById('about-panel');
    this.aboutClose = document.getElementById('about-close');
    if (this.aboutBtn && this.aboutPanel) {
      this.aboutBtn.addEventListener('click', () => this.aboutPanel.classList.remove('hidden'));
      if (this.aboutClose) {
        this.aboutClose.addEventListener('click', () => this.aboutPanel.classList.add('hidden'));
      }
      // Clicking the dimmed backdrop closes it too.
      this.aboutPanel.addEventListener('click', (e) => {
        if (e.target === this.aboutPanel) this.aboutPanel.classList.add('hidden');
      });
    }

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
    this._onCharacterToggle = null; // set via bindCharacterToggle
    this._onCardClick = (e) => {
      const card = e.currentTarget;
      const changed = this._selectedCharacter !== card.dataset.char;
      this._selectedCharacter = card.dataset.char;
      for (const c of this.charCards) c.classList.toggle('selected', c === card);
      if (this._onCharacterToggle) this._onCharacterToggle(changed);
    };
    for (const card of this.charCards) card.addEventListener('click', this._onCardClick);
  }

  /** Wire a callback fired when a character card is clicked (menu + game
   *  over). Receives whether the pick actually changed. */
  bindCharacterToggle(cb) {
    this._onCharacterToggle = cb;
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

    // Versus verdict: who out-foraged whom.
    if (this.vsResult) {
      const vs = opts.versus;
      this.vsResult.classList.toggle('hidden', !vs);
      if (vs) {
        const you = opts.score;
        const cpu = vs.cpuScore;
        this.vsResult.textContent =
          you > cpu
            ? `🏆 You beat ${vs.cpuName} ${formatScore(you)} – ${formatScore(cpu)}!`
            : you < cpu
              ? `🤖 ${vs.cpuName} wins ${formatScore(cpu)} – ${formatScore(you)}.`
              : `🤝 Dead heat — ${formatScore(you)} apiece.`;
      }
    }

    const newly = opts.newlyUnlockedNames || [];
    this.unlockNote.classList.toggle('hidden', newly.length === 0);
    if (newly.length > 0) {
      this.unlockNote.textContent = `★ ${newly.join(' & ')} unlocked!`;
    }

    this.setRoster(opts.unlocked, opts.currentCharacter);
    if (this.restartDiffRow) this.restartDiffRow.classList.add('hidden');
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
    this.puttPanel.classList.remove('hidden', 'minimised');
    // Wire the minimise/maximise toggle once.
    if (!this._puttMinWired) {
      this._puttMinWired = true;
      const btn = document.getElementById('putt-min');
      if (btn) btn.addEventListener('click', () => this.puttPanel.classList.toggle('minimised'));
    }
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

  /* ---------------- Veggie Tac Toe ---------------- */

  showVeggie() {
    if (!this.veggiePanel) return;
    this.veggiePanel.classList.remove('hidden', 'minimised');
    // Wire the minimise/maximise toggle once.
    if (!this._veggieMinWired) {
      this._veggieMinWired = true;
      const btn = document.getElementById('veggie-min');
      if (btn) btn.addEventListener('click', () => this.veggiePanel.classList.toggle('minimised'));
    }
  }

  hideVeggie() {
    if (this.veggiePanel) this.veggiePanel.classList.add('hidden');
  }

  setVeggieStatus(text) {
    if (this.veggieStatus) this.veggieStatus.textContent = text;
  }

  /** Wire the Veggie Tac Toe Quit button (mobile has no Escape key). */
  bindVeggieQuit(cb) {
    const btn = document.getElementById('veggie-quit');
    if (btn) btn.addEventListener('click', cb);
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

  /* ---------------- achievements viewer ---------------- */

  bindAchievements(onOpen, onClose) {
    if (this.achievementsBtn) this.achievementsBtn.addEventListener('click', onOpen);
    if (this.achClose) this.achClose.addEventListener('click', onClose);
    // Tapping the dimmed backdrop (but not the card) also closes.
    if (this.achievementsPanel) {
      this.achievementsPanel.addEventListener('click', (e) => {
        if (e.target === this.achievementsPanel) onClose();
      });
    }
  }

  /** view: { earnedCount, total, trophies:[{medal,title,desc,earned}],
   *          characters:[{name,how,unlocked}] } */
  showAchievements(view) {
    if (!this.achievementsPanel) return;
    this.achProgress.textContent = `${view.earnedCount} / ${view.total} trophies earned`;

    // Lifetime stats: all-time points banked and the most-played hero.
    if (this.achTotal) this.achTotal.textContent = formatScore(Math.round(view.totalScore || 0));
    if (this.achFav) {
      this.achFav.textContent = view.favourite
        ? `${view.favourite.name} (${view.favourite.plays})`
        : '—';
    }

    // Locked rows keep their name but hide the how-to, so nothing spoils
    // the way to earn it.
    const HIDDEN = '???';

    this.achTrophies.innerHTML = '';
    for (const t of view.trophies) {
      this.achTrophies.appendChild(
        this._achItem(t.earned ? t.medal : '🔒', t.title, t.earned ? t.desc : HIDDEN, t.earned)
      );
    }

    this.achChars.innerHTML = '';
    for (const c of view.characters) {
      this.achChars.appendChild(
        this._achItem(c.unlocked ? '✅' : '🔒', c.name, c.unlocked ? c.how : HIDDEN, c.unlocked)
      );
    }

    this.achievementsPanel.classList.remove('hidden');
  }

  hideAchievements() {
    if (this.achievementsPanel) this.achievementsPanel.classList.add('hidden');
  }

  /** Build one achievement/character row. */
  _achItem(medal, title, desc, earned) {
    const item = document.createElement('div');
    item.className = `ach-item ${earned ? 'earned' : 'locked'}`;
    const m = document.createElement('span');
    m.className = 'ach-medal';
    m.textContent = medal;
    const text = document.createElement('div');
    text.className = 'ach-text';
    const tt = document.createElement('div');
    tt.className = 'ach-title';
    tt.textContent = title;
    const dd = document.createElement('div');
    dd.className = 'ach-desc';
    dd.textContent = desc;
    text.append(tt, dd);
    item.append(m, text);
    return item;
  }

  /* ---------------- sound toggle ---------------- */

  /**
   * Wire the mute button. `initialMuted` sets the starting glyph; `onToggle`
   * flips the audio engine and returns the new muted state so we can sync
   * the icon.
   */
  bindMute(initialMuted, onToggle) {
    const btn = document.getElementById('mute-btn');
    const icon = document.getElementById('mute-icon');
    if (!btn || !icon) return;
    const paint = (muted) => {
      icon.textContent = muted ? '🔇' : '🔊';
      btn.classList.toggle('muted', muted);
    };
    paint(initialMuted);
    btn.addEventListener('click', () => paint(onToggle()));
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

  /**
   * The versus doors open onto a difficulty choice: 'Against' reveals the
   * Simple Seeds / Nefarious Nuts row, and the pick starts the run.
   * `callback` receives 'easy' or 'hard'.
   */
  bindStartVersus(callback) {
    if (this.startVsBtn && this.vsDiffRow) {
      this.startVsBtn.addEventListener('click', () => {
        this.vsDiffRow.classList.toggle('hidden');
      });
    }
    if (this.vsEasyBtn) this.vsEasyBtn.addEventListener('click', () => callback('easy'));
    if (this.vsHardBtn) this.vsHardBtn.addEventListener('click', () => callback('hard'));
  }

  /** Show/hide the versus HUD chip and set the rival's name. */
  setVersus(active, name = '') {
    if (!this.vsPanel) return;
    this.vsPanel.classList.toggle('hidden', !active);
    if (active) {
      this.vsName.textContent = name;
      this.vsScore.textContent = '0';
    }
  }

  setCpuScore(value) {
    if (this.vsScore) this.vsScore.textContent = formatScore(value);
  }

  hideGameOver() {
    this.gameOver.classList.remove('visible');
    this.hideAchievements();
  }

  /** The character picked on the game-over screen (null = untouched). */
  getSelectedCharacter() {
    return this._selectedCharacter;
  }

  bindRestart(callback) {
    this.restartBtn.addEventListener('click', callback);
  }

  /** Same difficulty choice, at the game-over card. */
  bindRestartVersus(callback) {
    if (this.restartVsBtn && this.restartDiffRow) {
      this.restartVsBtn.addEventListener('click', () => {
        this.restartDiffRow.classList.toggle('hidden');
      });
    }
    if (this.restartEasyBtn) this.restartEasyBtn.addEventListener('click', () => callback('easy'));
    if (this.restartHardBtn) this.restartHardBtn.addEventListener('click', () => callback('hard'));
  }

  dispose() {
    window.clearTimeout(this._flashTimeout);
    window.clearTimeout(this._popTimeout);
    window.clearTimeout(this._toastTimeout);
    window.clearTimeout(this._hintTimeout);
    for (const card of this.charCards) card.removeEventListener('click', this._onCardClick);
  }
}
