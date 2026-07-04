/**
 * Input.js — Keyboard + mouse state with pointer-lock camera control and a
 * drag fallback, plus edge-triggered jump for buffering.
 */

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
    this.onBlur = () => this.keys.clear();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** -1..1 strafe axis (A/D or arrows). */
  get axisX() {
    let x = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    return x;
  }

  /** -1..1 forward axis (W/S or arrows). Forward is +1. */
  get axisY() {
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    return y;
  }

  get jumpHeld() {
    return this.keys.has('Space');
  }

  /** Edge-triggered jump — returns true once per press. */
  consumeJump() {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  /** Mouse deltas accumulated since the last call. */
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
  }
}
