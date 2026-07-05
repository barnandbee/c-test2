/**
 * Input.js — Keyboard + mouse state with pointer-lock camera control and a
 * drag fallback, plus edge-triggered jump for buffering.
 *
 * Also drives an on-screen virtual joystick + jump button for touch
 * devices: a touch starting in the left half of the screen drives movement
 * (floating joystick, appears wherever the finger lands), a touch in the
 * right half orbits the camera exactly like a mouse drag, and a dedicated
 * button handles jump. All three feed the same axisX/axisY/jumpHeld/
 * consumeMouseDelta API the rest of the game already reads, so Player.js
 * and CameraRig.js need no touch-specific code.
 */

import { clamp } from './utils/MathUtils.js';

const JOYSTICK_MAX_RADIUS = 46; // px of knob travel before clamping

export class Input {
  constructor(domElement) {
    this.domElement = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this.dragging = false;
    this.lastCameraInputTime = -Infinity;
    this.jumpQueued = false;

    // --- touch state ------------------------------------------------------
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this._touchJumpHeld = false;
    this._joystickTouchId = null;
    this._joystickOriginX = 0;
    this._joystickOriginY = 0;
    this._joystickX = 0; // -1..1
    this._joystickY = 0; // -1..1, forward is +1
    this._lookTouchId = null;
    this._lookLastX = 0;
    this._lookLastY = 0;

    this.onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);

    this.onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (!this.pointerLocked) {
        this.domElement.requestPointerLock();
        this.dragging = true;
      }
    };
    this.onMouseUp = () => {
      this.dragging = false;
    };
    this.onMouseMove = (e) => {
      if (this.pointerLocked || this.dragging) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
        this.lastCameraInputTime = performance.now() / 1000;
      }
    };
    this.onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
    };
    this.onWheel = (e) => {
      this.wheelDelta += e.deltaY;
      e.preventDefault();
    };
    this.onBlur = () => {
      this.keys.clear();
      this._touchJumpHeld = false;
    };

    // Multi-tap (any pointer type; pointerdown covers mouse AND touch).
    // Two quick taps queue a double (vehicles, secrets); a third within
    // the window also queues a triple (the rocket demands ceremony).
    this._lastTapTime = -Infinity;
    this._tapCount = 0;
    this.doubleTapQueued = false;
    this.tripleTapQueued = false;
    this.onPointerDown = () => {
      const now = performance.now();
      this._tapCount = now - this._lastTapTime < 500 ? this._tapCount + 1 : 1;
      this._lastTapTime = now;
      if (this._tapCount === 2) this.doubleTapQueued = true;
      if (this._tapCount >= 3) {
        this.tripleTapQueued = true;
        this._tapCount = 0;
      }
    };
    window.addEventListener('pointerdown', this.onPointerDown);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });

    this.setupTouchControls();
  }

  /* ================================================================ */
  /*  Touch controls                                                  */
  /* ================================================================ */

  setupTouchControls() {
    this.touchControlsEl = document.getElementById('touch-controls');
    this.moveZoneEl = document.getElementById('touch-move-zone');
    this.lookZoneEl = document.getElementById('touch-look-zone');
    this.joystickBaseEl = document.getElementById('touch-joystick-base');
    this.joystickKnobEl = document.getElementById('touch-joystick-knob');
    this.jumpBtnEl = document.getElementById('touch-jump-btn');
    if (!this.moveZoneEl || !this.lookZoneEl || !this.jumpBtnEl) return;

    this.onMoveTouchStart = (e) => {
      if (this._joystickTouchId !== null) return;
      const t = e.changedTouches[0];
      this._joystickTouchId = t.identifier;
      this._joystickOriginX = t.clientX;
      this._joystickOriginY = t.clientY;
      this._joystickX = 0;
      this._joystickY = 0;
      if (this.joystickBaseEl) {
        this.joystickBaseEl.style.left = `${t.clientX}px`;
        this.joystickBaseEl.style.top = `${t.clientY}px`;
        this.joystickBaseEl.classList.add('active');
      }
      if (this.joystickKnobEl) this.joystickKnobEl.style.transform = 'translate(0px, 0px)';
      e.preventDefault();
    };

    this.onMoveTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._joystickTouchId) continue;
        let dx = t.clientX - this._joystickOriginX;
        let dy = t.clientY - this._joystickOriginY;
        const len = Math.hypot(dx, dy);
        if (len > JOYSTICK_MAX_RADIUS) {
          const s = JOYSTICK_MAX_RADIUS / len;
          dx *= s;
          dy *= s;
        }
        this._joystickX = dx / JOYSTICK_MAX_RADIUS;
        this._joystickY = -dy / JOYSTICK_MAX_RADIUS; // screen-up drag = forward
        if (this.joystickKnobEl) this.joystickKnobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      e.preventDefault();
    };

    this.onMoveTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._joystickTouchId) continue;
        this._joystickTouchId = null;
        this._joystickX = 0;
        this._joystickY = 0;
        if (this.joystickBaseEl) this.joystickBaseEl.classList.remove('active');
        if (this.joystickKnobEl) this.joystickKnobEl.style.transform = 'translate(0px, 0px)';
      }
      e.preventDefault();
    };

    this.onLookTouchStart = (e) => {
      if (this._lookTouchId !== null) return;
      const t = e.changedTouches[0];
      this._lookTouchId = t.identifier;
      this._lookLastX = t.clientX;
      this._lookLastY = t.clientY;
      e.preventDefault();
    };

    this.onLookTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._lookTouchId) continue;
        this.mouseDX += (t.clientX - this._lookLastX) * 1.6;
        this.mouseDY += (t.clientY - this._lookLastY) * 1.6;
        this._lookLastX = t.clientX;
        this._lookLastY = t.clientY;
        this.lastCameraInputTime = performance.now() / 1000;
      }
      e.preventDefault();
    };

    this.onLookTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._lookTouchId) this._lookTouchId = null;
      }
      e.preventDefault();
    };

    this.onJumpTouchStart = (e) => {
      this._touchJumpHeld = true;
      this.jumpQueued = true;
      e.preventDefault();
    };
    this.onJumpTouchEnd = (e) => {
      this._touchJumpHeld = false;
      e.preventDefault();
    };

    this.moveZoneEl.addEventListener('touchstart', this.onMoveTouchStart, { passive: false });
    this.moveZoneEl.addEventListener('touchmove', this.onMoveTouchMove, { passive: false });
    this.moveZoneEl.addEventListener('touchend', this.onMoveTouchEnd, { passive: false });
    this.moveZoneEl.addEventListener('touchcancel', this.onMoveTouchEnd, { passive: false });

    this.lookZoneEl.addEventListener('touchstart', this.onLookTouchStart, { passive: false });
    this.lookZoneEl.addEventListener('touchmove', this.onLookTouchMove, { passive: false });
    this.lookZoneEl.addEventListener('touchend', this.onLookTouchEnd, { passive: false });
    this.lookZoneEl.addEventListener('touchcancel', this.onLookTouchEnd, { passive: false });

    this.jumpBtnEl.addEventListener('touchstart', this.onJumpTouchStart, { passive: false });
    this.jumpBtnEl.addEventListener('touchend', this.onJumpTouchEnd, { passive: false });
    this.jumpBtnEl.addEventListener('touchcancel', this.onJumpTouchEnd, { passive: false });

    // Prefer the up-front feature check, but also react to an actual touch
    // in case detection was wrong (e.g. some hybrid laptops).
    if (this.isTouch) this.showTouchControls();
    else {
      this._onFirstTouch = () => this.showTouchControls();
      window.addEventListener('touchstart', this._onFirstTouch, { passive: true, once: true });
    }
  }

  showTouchControls() {
    this.isTouch = true;
    if (this.touchControlsEl) this.touchControlsEl.classList.add('visible');
    const hint = document.getElementById('hint');
    if (hint) hint.classList.add('touch-hint');
  }

  /* ================================================================ */
  /*  Public API — unchanged shape, now touch-aware                   */
  /* ================================================================ */

  /** -1..1 strafe axis (A/D, arrows, or the touch joystick). */
  get axisX() {
    let x = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    x += this._joystickX;
    return clamp(x, -1, 1);
  }

  /** -1..1 forward axis (W/S, arrows, or the touch joystick). Forward is +1. */
  get axisY() {
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    y += this._joystickY;
    return clamp(y, -1, 1);
  }

  get jumpHeld() {
    return this.keys.has('Space') || this._touchJumpHeld;
  }

  /** Edge-triggered jump — returns true once per press. */
  consumeJump() {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  /** Edge-triggered double-tap/double-click — returns true once per pair. */
  consumeDoubleTap() {
    const queued = this.doubleTapQueued;
    this.doubleTapQueued = false;
    return queued;
  }

  /** Edge-triggered triple-tap — returns true once per trio. */
  consumeTripleTap() {
    const queued = this.tripleTapQueued;
    this.tripleTapQueued = false;
    return queued;
  }

  /** Mouse/touch-look deltas accumulated since the last call. */
  consumeMouseDelta() {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  consumeWheel() {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.domElement.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerdown', this.onPointerDown);

    if (this._onFirstTouch) window.removeEventListener('touchstart', this._onFirstTouch);

    if (this.moveZoneEl) {
      this.moveZoneEl.removeEventListener('touchstart', this.onMoveTouchStart);
      this.moveZoneEl.removeEventListener('touchmove', this.onMoveTouchMove);
      this.moveZoneEl.removeEventListener('touchend', this.onMoveTouchEnd);
      this.moveZoneEl.removeEventListener('touchcancel', this.onMoveTouchEnd);
    }
    if (this.lookZoneEl) {
      this.lookZoneEl.removeEventListener('touchstart', this.onLookTouchStart);
      this.lookZoneEl.removeEventListener('touchmove', this.onLookTouchMove);
      this.lookZoneEl.removeEventListener('touchend', this.onLookTouchEnd);
      this.lookZoneEl.removeEventListener('touchcancel', this.onLookTouchEnd);
    }
    if (this.jumpBtnEl) {
      this.jumpBtnEl.removeEventListener('touchstart', this.onJumpTouchStart);
      this.jumpBtnEl.removeEventListener('touchend', this.onJumpTouchEnd);
      this.jumpBtnEl.removeEventListener('touchcancel', this.onJumpTouchEnd);
    }
  }
}
