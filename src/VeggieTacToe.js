/**
 * VeggieTacToe.js — 'Veggie Tac Toe', tic-tac-toe on the vegetable patch
 * against Turnip Scart. Played from a bird's-eye view: a 3x3 board is laid
 * over the patch, the player places cabbages, Scart places turnips. Beat
 * him and he joins the roster.
 *
 * The Game freezes the run clock while this plays, drives a top-down
 * camera, and routes number-key input here; cell selection also works by
 * clicking/tapping (raycast against the board plane).
 */

import * as THREE from 'three';
import { createToonMaterial } from './Shaders.js';

const CELL = 1.15;          // spacing between cell centres
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

export class VeggieTacToe {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./World.js').World} world
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement
   * @param {import('./UI.js').UI} ui
   * @param {(result: 'win'|'lose'|'draw') => void} onFinish
   */
  constructor(scene, world, camera, domElement, ui, onFinish) {
    this.scene = scene;
    this.world = world;
    this.camera = camera;
    this.domElement = domElement;
    this.ui = ui;
    this.onFinish = onFinish;

    this.cells = new Array(9).fill(0); // 0 empty, 1 player (cabbage), 2 Scart (turnip)
    this.turn = 'player';
    this.state = 'play'; // play -> done
    this.result = null;
    this._aiTimer = 0;
    this._doneTimer = 0;
    this._geos = [];
    this._mats = [];

    const geo = (g) => { this._geos.push(g); return g; };
    const mat = (m) => { this._mats.push(m); return m; };

    const c = world.vegPatchPos;
    this.center = new THREE.Vector3(c.x, world.getHeight(c.x, c.z), c.z);
    this.group = new THREE.Group();
    this.group.position.copy(this.center);
    scene.add(this.group);

    // --- the board: a raised soil slab with pale grid lines -------------
    const boardMat = mat(createToonMaterial({ color: 0x3a2a1c }));
    const board = new THREE.Mesh(geo(new THREE.BoxGeometry(CELL * 3.3, 0.12, CELL * 3.3)), boardMat);
    board.position.y = 0.24;
    board.receiveShadow = true;
    this.group.add(board);
    this.boardTopY = this.center.y + 0.3;

    const lineMat = mat(createToonMaterial({ color: 0xe8dcc0, emissive: 0x3a3020, emissiveIntensity: 0.4 }));
    for (const off of [-CELL / 2, CELL / 2]) {
      const v = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, 0.04, CELL * 3)), lineMat);
      v.position.set(off, 0.31, 0);
      this.group.add(v);
      const h = new THREE.Mesh(geo(new THREE.BoxGeometry(CELL * 3, 0.04, 0.06)), lineMat);
      h.position.set(0, 0.31, off);
      this.group.add(h);
    }

    // Reusable piece materials.
    this._cabbageMat = mat(createToonMaterial({ color: 0x8ab86a, rim: { color: 0xd8f0c0, strength: 0.4, threshold: 0.6 } }));
    this._leafMat = mat(createToonMaterial({ color: 0x4e8a3c }));
    this._turnipMat = mat(createToonMaterial({ color: 0xe6ddec, rim: { color: 0xffffff, strength: 0.4, threshold: 0.6 } }));
    this._turnipTopMat = mat(createToonMaterial({ color: 0x9c5aa0 }));
    this._pieces = new Array(9).fill(null);
    this._scratchV = new THREE.Vector3();

    // Input is a 3x3 grid of transparent HTML buttons laid over the board's
    // on-screen projection. Native buttons never miss a tap/click on any
    // device — far more reliable than raycasting through overlay layers.
    this._overlay = document.createElement('div');
    this._overlay.className = 'veggie-grid';
    this._buttons = [];
    for (let i = 0; i < 9; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'veggie-cell';
      b.addEventListener('click', () => {
        if (this.state === 'play' && this.turn === 'player' && this.cells[i] === 0) {
          this._place(i, 1);
        }
      });
      this._overlay.appendChild(b);
      this._buttons.push(b);
    }
    document.body.appendChild(this._overlay);

    ui.showVeggie();
    ui.setVeggieStatus('YOUR TURN — PLANT A CABBAGE');
  }

  /** Local (x,z) of a cell centre, col/row 0..2. */
  _cellPos(i) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    return { x: (col - 1) * CELL, z: (row - 1) * CELL };
  }

  /** Project every cell centre to the screen and place its button there. */
  _layoutButtons() {
    if (!this._buttons) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pts = [];
    for (let i = 0; i < 9; i++) {
      const p = this._cellPos(i);
      this._scratchV.set(this.center.x + p.x, this.boardTopY, this.center.z + p.z);
      this._scratchV.project(this.camera);
      pts.push({ x: (this._scratchV.x * 0.5 + 0.5) * w, y: (-this._scratchV.y * 0.5 + 0.5) * h });
    }
    // Button size ≈ the on-screen spacing between adjacent cells.
    const size = Math.max(28, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * 0.96);
    for (let i = 0; i < 9; i++) {
      const b = this._buttons[i];
      b.style.left = `${pts[i].x - size / 2}px`;
      b.style.top = `${pts[i].y - size / 2}px`;
      b.style.width = `${size}px`;
      b.style.height = `${size}px`;
      const taken = this.cells[i] !== 0 || this.turn !== 'player' || this.state !== 'play';
      b.style.pointerEvents = taken ? 'none' : 'auto';
    }
  }

  /** Number keys 1-9 map to the board like a numpad-ish grid (1 = top-left). */
  handleKey(code) {
    if (this.state !== 'play' || this.turn !== 'player') return;
    const map = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8 };
    const i = map[code];
    if (i !== undefined && this.cells[i] === 0) this._place(i, 1);
  }

  _place(i, who) {
    this.cells[i] = who;
    const p = this._cellPos(i);
    const piece = who === 1 ? this._makeCabbage() : this._makeTurnip();
    piece.position.set(p.x, 0.34, p.z);
    piece.scale.setScalar(0.01);
    piece.userData.grow = 0;
    this.group.add(piece);
    this._pieces[i] = piece;

    const winner = this._winner();
    if (winner || this.cells.every((v) => v !== 0)) {
      this._finish(winner);
      return;
    }
    if (who === 1) {
      this.turn = 'scart';
      this._aiTimer = 0.7;
      this.ui.setVeggieStatus('TURNIP SCART IS THINKING…');
    } else {
      this.turn = 'player';
      this.ui.setVeggieStatus('YOUR TURN — PLANT A CABBAGE');
    }
  }

  _finish(winner) {
    this.state = 'done';
    this._doneTimer = 1.6;
    if (winner === 1) {
      this.result = 'win';
      this.ui.setVeggieStatus('YOU WIN! 🥬');
    } else if (winner === 2) {
      this.result = 'lose';
      this.ui.setVeggieStatus('TURNIP SCART WINS. BAAA.');
    } else {
      this.result = 'draw';
      this.ui.setVeggieStatus("A DRAW — SCART CHEWS ON.");
    }
    if (winner) this._highlight(this._winLine);
  }

  _winner() {
    for (const line of WIN_LINES) {
      const [a, b, cc] = line;
      if (this.cells[a] && this.cells[a] === this.cells[b] && this.cells[a] === this.cells[cc]) {
        this._winLine = line;
        return this.cells[a];
      }
    }
    return 0;
  }

  _highlight(line) {
    for (const i of line) {
      const piece = this._pieces[i];
      if (piece) piece.userData.win = true;
    }
  }

  /** Turnip Scart's move: win if he can, block if he must, else wander. */
  _aiMove() {
    const pick = (who) => {
      for (const line of WIN_LINES) {
        const vals = line.map((i) => this.cells[i]);
        const empty = line.filter((i) => this.cells[i] === 0);
        if (empty.length === 1 && vals.filter((v) => v === who).length === 2) return empty[0];
      }
      return -1;
    };
    let move = pick(2);              // take the win
    if (move < 0) move = pick(1);    // else block the player
    if (move < 0) {
      // Otherwise a careless graze: a random empty cell (beatable on purpose).
      const empties = this.cells.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
      move = empties[Math.floor(Math.random() * empties.length)];
    }
    if (move >= 0) this._place(move, 2);
  }

  update(dt) {
    // Keep the tap-target buttons aligned with the board on screen.
    this._layoutButtons();

    // Grow-in animation for newly placed pieces + a gentle winner bob.
    for (const piece of this._pieces) {
      if (!piece) continue;
      if (piece.userData.grow < 1) {
        piece.userData.grow = Math.min(1, piece.userData.grow + dt * 4);
        const g = piece.userData.grow;
        piece.scale.setScalar(g * (1 + (1 - g) * 0.3)); // slight overshoot
      }
      if (piece.userData.win) {
        piece.rotation.y += dt * 3;
        piece.position.y = 0.34 + Math.abs(Math.sin(performance.now() / 200)) * 0.12;
      }
    }

    if (this.state === 'play' && this.turn === 'scart') {
      this._aiTimer -= dt;
      if (this._aiTimer <= 0) this._aiMove();
    } else if (this.state === 'done') {
      this._doneTimer -= dt;
      if (this._doneTimer <= 0) this.onFinish(this.result);
    }
  }

  abandon() {
    this.onFinish('draw');
  }

  _makeCabbage() {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(this._sphere(0.26), this._cabbageMat);
    ball.scale.y = 0.8;
    ball.castShadow = true;
    g.add(ball);
    for (let l = 0; l < 5; l++) {
      const a = (l / 5) * Math.PI * 2;
      const leaf = new THREE.Mesh(this._cone(0.14, 0.28), this._leafMat);
      leaf.position.set(Math.cos(a) * 0.2, -0.05, Math.sin(a) * 0.2);
      leaf.rotation.set(Math.PI / 2.3, 0, a);
      g.add(leaf);
    }
    return g;
  }

  _makeTurnip() {
    const g = new THREE.Group();
    const bulb = new THREE.Mesh(this._sphere(0.22), this._turnipMat);
    bulb.scale.y = 1.1;
    bulb.castShadow = true;
    g.add(bulb);
    const cap = new THREE.Mesh(this._halfSphere(0.22), this._turnipTopMat);
    cap.position.y = 0.12;
    g.add(cap);
    const sprout = new THREE.Mesh(this._cone(0.06, 0.2), this._turnipTopMat);
    sprout.position.y = 0.28;
    g.add(sprout);
    return g;
  }

  _sphere(r) { const g = new THREE.SphereGeometry(r, 12, 10); this._geos.push(g); return g; }
  _halfSphere(r) { const g = new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2); this._geos.push(g); return g; }
  _cone(r, h) { const g = new THREE.ConeGeometry(r, h, 6); this._geos.push(g); return g; }

  dispose() {
    if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
    this._buttons = null;
    this.scene.remove(this.group);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    this.ui.hideVeggie();
  }
}
