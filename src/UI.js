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
    this.menuAchievementsBtn = document.getElementById('menu-achievements-btn');
    this.achievementsPanel = document.getElementById('achievements-panel');
    this.achClose = document.getElementById('ach-close');
    this.achProgress = document.getElementById('ach-progress');
    this.achCharProgress = document.getElementById('ach-char-progress');
    this.achTotal = document.getElementById('ach-total');
    this.achFav = document.getElementById('ach-fav');
    this.achTrophies = document.getElementById('ach-trophies');
    this.achChars = document.getElementById('ach-chars');
    this.menuSaveBtn = document.getElementById('menu-save-btn');
    this.gameOverSaveBtn = document.getElementById('gameover-save-btn');
    this.savePanel = document.getElementById('save-panel');
    this.saveClose = document.getElementById('save-close');
    this.saveCode = document.getElementById('save-code');
    this.saveSummary = document.getElementById('save-summary');
    this.saveCopyBtn = document.getElementById('save-copy');
    this.saveDownloadBtn = document.getElementById('save-download');
    this.saveRestoreInput = document.getElementById('save-restore-input');
    this.saveRestoreBtn = document.getElementById('save-restore');
    this.saveUploadBtn = document.getElementById('save-upload');
    this.saveFileInput = document.getElementById('save-file');
    this.saveStatus = document.getElementById('save-status');
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
    this.menuAboutBtn = document.getElementById('menu-about-btn');
    this.aboutLogoBtn = document.getElementById('about-logo-btn');
    this.aboutLogoNote = document.getElementById('about-logo-note');
    this.aboutPanel = document.getElementById('about-panel');
    this.aboutClose = document.getElementById('about-close');
    if (this.aboutPanel) {
      const openAbout = () => this.aboutPanel.classList.remove('hidden');
      if (this.aboutBtn) this.aboutBtn.addEventListener('click', openAbout);
      if (this.menuAboutBtn) this.menuAboutBtn.addEventListener('click', openAbout);
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

  /** A line under the logo — what the tap did, if anything. */
  setAboutLogoNote(text) {
    if (this.aboutLogoNote) this.aboutLogoNote.textContent = text;
  }

  /** Someone has tapped the studio logo on the About page. */
  bindLogoTap(cb) {
    if (this.aboutLogoBtn) this.aboutLogoBtn.addEventListener('click', cb);
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

    // A run that unlocked somebody is exactly the run worth backing up, so
    // the save button glows until it has been opened. No modal, no nagging.
    if (this.gameOverSaveBtn) {
      const earned = (opts.newlyUnlockedNames || []).length > 0;
      this.gameOverSaveBtn.classList.toggle('save-nudge', earned);
    }

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
      const available = char === 'badger' || char === 'random' || Boolean(unlocked[char]);
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
    if (this.menuAchievementsBtn) this.menuAchievementsBtn.addEventListener('click', onOpen);
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
    // The roster is half the game, so it gets its own line rather than being
    // inferred from scrolling the list.
    if (this.achCharProgress) {
      const owned = view.characters.filter((c) => c.unlocked).length;
      this.achCharProgress.textContent =
        `${owned} / ${view.characters.length} characters unlocked`;
    }

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

  /* ---------------- save & restore ---------------- */

  /**
   * @param {Object} handlers
   * @param {Function} handlers.onOpen   called to fetch and show the code
   * @param {Function} handlers.onClose
   * @param {Function} handlers.onRestore called with the pasted text
   * @param {Function} handlers.onDownload
   */
  bindSave({ onOpen, onClose, onRestore, onDownload }) {
    if (this.menuSaveBtn) this.menuSaveBtn.addEventListener('click', onOpen);
    if (this.gameOverSaveBtn) this.gameOverSaveBtn.addEventListener('click', onOpen);
    if (this.saveClose) this.saveClose.addEventListener('click', onClose);
    if (this.savePanel) {
      this.savePanel.addEventListener('click', (e) => {
        if (e.target === this.savePanel) onClose();
      });
    }
    if (this.saveCopyBtn) this.saveCopyBtn.addEventListener('click', () => this._copyCode());
    if (this.saveDownloadBtn) this.saveDownloadBtn.addEventListener('click', onDownload);
    if (this.saveRestoreBtn) {
      this.saveRestoreBtn.addEventListener('click', () => {
        onRestore((this.saveRestoreInput && this.saveRestoreInput.value) || '');
      });
    }
    // The file picker is only a second way of getting text into the same box,
    // so it lands there and takes the identical path through onRestore.
    if (this.saveUploadBtn && this.saveFileInput) {
      this.saveUploadBtn.addEventListener('click', () => this.saveFileInput.click());
      this.saveFileInput.addEventListener('change', () => {
        const file = this.saveFileInput.files && this.saveFileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || '');
          if (this.saveRestoreInput) this.saveRestoreInput.value = text.trim();
          onRestore(text);
        };
        reader.onerror = () => this.setSaveStatus("couldn't read that file", false);
        reader.readAsText(file);
        this.saveFileInput.value = ''; // so the same file can be picked twice
      });
    }
  }

  showSave(code, summary) {
    if (!this.savePanel) return;
    if (this.saveCode) this.saveCode.value = code;
    if (this.saveSummary && summary) {
      this.saveSummary.textContent =
        `${summary.characters} characters · ${summary.trophies} trophies · ` +
        `best ${formatScore(summary.highScore)} · ${formatScore(summary.totalScore)} all-time`;
    }
    this.setSaveStatus('');
    if (this.saveRestoreInput) this.saveRestoreInput.value = '';
    if (this.gameOverSaveBtn) this.gameOverSaveBtn.classList.remove('save-nudge');
    this.savePanel.classList.remove('hidden');
  }

  hideSave() {
    if (this.savePanel) this.savePanel.classList.add('hidden');
  }

  setSaveStatus(text, good = true) {
    if (!this.saveStatus) return;
    this.saveStatus.textContent = text;
    this.saveStatus.classList.toggle('save-ok', Boolean(text) && good);
    this.saveStatus.classList.toggle('save-bad', Boolean(text) && !good);
  }

  /** Clipboard first, with a select-all fallback for browsers that refuse. */
  _copyCode() {
    const text = this.saveCode ? this.saveCode.value : '';
    if (!text) return;
    const fallback = () => {
      if (!this.saveCode) return;
      this.saveCode.focus();
      this.saveCode.select();
      this.setSaveStatus('selected — press ⌘C or Ctrl+C to copy');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this.setSaveStatus('copied — keep it somewhere safe'))
        .catch(fallback);
    } else {
      fallback();
    }
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
  /** Wire the glow (bloom) toggle; onToggle returns the new enabled state. */
  bindBloom(initialOn, onToggle) {
    const btn = document.getElementById('bloom-btn');
    if (!btn) return;
    const paint = (on) => btn.classList.toggle('off', !on);
    paint(initialOn);
    btn.addEventListener('click', () => paint(onToggle()));
  }

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
