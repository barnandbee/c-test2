/**
 * PuttingGame.js — 'Puttmost Respect', the mini golf putting challenge.
 *
 * A self-contained mode that borrows the world's golf green: a ball is
 * teed up a few meters from the hole, the player aims with the camera,
 * holds the jump button to charge the meter and releases to putt. Three
 * strokes to sink it. The Game freezes the run clock while this plays
 * and routes input here instead of to the character.
 */

import * as THREE from 'three';
import { createToonMaterial } from './Shaders.js';
import { clamp } from './utils/MathUtils.js';

const MAX_STROKES = 3;
const CAPTURE_RADIUS = 0.24;
const STOP_SPEED = 0.25;

export class PuttingGame {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./World.js').World} world
   * @param {import('./UI.js').UI} ui
   * @param {(success: boolean, strokes: number) => void} onFinish
   */
  constructor(scene, world, ui, onFinish) {
    this.scene = scene;
    this.world = world;
    this.ui = ui;
    this.onFinish = onFinish;

    this.hole = new THREE.Vector3(world.greenCenterX, world.greenLevel, world.greenCenterZ);
    this.state = 'aim'; // aim -> charging -> rolling -> done
    this.strokes = 0;
    this.power = 0;
    this.success = false;
    this._doneTimer = 0;
    this._n = new THREE.Vector3();

    // Tee up on the green, a respectable putt from the pin.
    const teeAngle = Math.random() * Math.PI * 2;
    this.ballGeo = new THREE.SphereGeometry(0.11, 14, 12);
    this.ballMat = createToonMaterial({
      color: 0xf6f4ec,
      rim: { color: 0xffffff, strength: 0.5, threshold: 0.5 }
    });
    this.ball = new THREE.Mesh(this.ballGeo, this.ballMat);
    this.ball.castShadow = true;
    this.ballVel = new THREE.Vector3();
    this.ball.position.set(
      this.hole.x + Math.cos(teeAngle) * 4.2,
      0,
      this.hole.z + Math.sin(teeAngle) * 4.2
    );
    this._settleBall();
    scene.add(this.ball);

    this._buildAimAids();

    ui.showPutt();
    ui.setPuttStrokes(1, MAX_STROKES);
    ui.setPuttPower(0);
  }

  /**
   * The aiming aids: a bright ground arrow showing direction (and, by its
   * length, power), and a little putter that addresses the ball and takes
   * a backswing as the meter charges. Everything hangs off aimGroup, whose
   * local -Z is the shot direction, so a single rotation.y = cameraYaw
   * points the whole rig where the ball will go.
   */
  _buildAimAids() {
    this._aimGeos = [];
    this._aimMats = [];
    const geo = (g) => { this._aimGeos.push(g); return g; };
    const mat = (m) => { this._aimMats.push(m); return m; };

    this.aimGroup = new THREE.Group();
    this.scene.add(this.aimGroup);

    // --- ground arrow (in its own group so we can scale its length) ------
    this.arrowGroup = new THREE.Group();
    this.arrowGroup.position.y = -0.055; // just above the green
    this.aimGroup.add(this.arrowGroup);
    const arrowMat = mat(createToonMaterial({
      color: 0xffe14d,
      emissive: 0x7a6410,
      emissiveIntensity: 0.7
    }));
    const shaft = new THREE.Mesh(geo(new THREE.BoxGeometry(0.09, 0.02, 1.0)), arrowMat);
    shaft.position.z = -0.75; // starts ~0.25 ahead of the ball, runs forward (-Z)
    this.arrowGroup.add(shaft);
    const headGeo = geo(new THREE.ConeGeometry(0.17, 0.34, 4));
    const head = new THREE.Mesh(headGeo, arrowMat);
    head.rotation.x = -Math.PI / 2; // point the cone along -Z
    head.rotation.y = Math.PI / 4;
    head.position.z = -1.42;
    this.arrowGroup.add(head);

    // --- putter ----------------------------------------------------------
    this.clubGroup = new THREE.Group();
    this.clubGroup.position.set(0.22, 0, 0.12); // addresses the ball from the side
    this.aimGroup.add(this.clubGroup);
    const shaftMat = mat(createToonMaterial({ color: 0xd8d8de, rim: { color: 0xffffff, strength: 0.5, threshold: 0.5 } }));
    const headMat = mat(createToonMaterial({ color: 0x2a2a30 }));
    const gripMat = mat(createToonMaterial({ color: 0x3a2a22 }));
    const clubShaft = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.018, 0.022, 1.0, 8)), shaftMat);
    clubShaft.position.set(0, 0.5, 0.16);
    clubShaft.rotation.x = 0.32;
    this.clubGroup.add(clubShaft);
    const grip = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 8)), gripMat);
    grip.position.set(0, 0.92, 0.28);
    grip.rotation.x = 0.32;
    this.clubGroup.add(grip);
    const clubHead = new THREE.Mesh(geo(new THREE.BoxGeometry(0.2, 0.09, 0.12)), headMat);
    clubHead.position.set(0, 0.03, 0.02);
    this.clubGroup.add(clubHead);
  }

  /** Point/scale the aids for the current aim + charge, or hide them. */
  _updateAimAids(cameraYaw, visible, powerT) {
    if (!this.aimGroup) return;
    this.aimGroup.visible = visible;
    if (!visible) return;
    this.aimGroup.position.copy(this.ball.position);
    this.aimGroup.rotation.y = cameraYaw;
    // Arrow grows with power (or sits at a resting length while just aiming).
    const len = 0.75 + powerT * 1.15;
    this.arrowGroup.scale.z = len;
    // Putter takes a backswing as the meter fills.
    this.clubGroup.rotation.x = -powerT * 0.7;
  }

  _settleBall() {
    this.ball.position.y =
      this.world.getHeight(this.ball.position.x, this.ball.position.z) + 0.11;
  }

  /** The camera focuses here while the challenge runs. */
  get focusPoint() {
    return this.ball.position;
  }

  update(dt, input, cameraYaw) {
    input.consumeJump(); // the button is a putter now, never a jump

    if (this.state === 'aim') {
      this._updateAimAids(cameraYaw, true, 0);
      if (input.jumpHeld) {
        this.state = 'charging';
        this.power = 0;
      }
    } else if (this.state === 'charging') {
      // Ping-pong the meter so overcooking a putt is always possible.
      this.power += dt * 0.85;
      const t = 1 - Math.abs((this.power % 2) - 1);
      this.ui.setPuttPower(t);
      this._updateAimAids(cameraYaw, true, t);
      if (!input.jumpHeld) {
        const strength = 3.5 + t * 13;
        this.ballVel.set(-Math.sin(cameraYaw) * strength, 0, -Math.cos(cameraYaw) * strength);
        this.strokes += 1;
        this.state = 'rolling';
        this._updateAimAids(cameraYaw, false, 0);
        this.ui.setPuttPower(0);
        this.ui.setPuttStrokes(Math.min(this.strokes + 1, MAX_STROKES), MAX_STROKES);
      }
    } else if (this.state === 'rolling') {
      const pos = this.ball.position;
      pos.x += this.ballVel.x * dt;
      pos.z += this.ballVel.z * dt;
      this._settleBall();

      // Terrain break: downhill pull, none on the dead-flat green.
      const n = this.world.getNormal(pos.x, pos.z, this._n);
      this.ballVel.x += n.x * 7 * dt;
      this.ballVel.z += n.z * 7 * dt;

      // Rolling resistance: mown green is quick, the rough is not.
      const onGreen =
        Math.hypot(pos.x - this.hole.x, pos.z - this.hole.z) < this.world.greenRadius;
      const friction = onGreen ? 1.35 : 4.2;
      const drag = Math.max(0, 1 - friction * dt);
      this.ballVel.x *= drag;
      this.ballVel.z *= drag;

      // Spin for flavor.
      this.ball.rotation.x += this.ballVel.length() * dt * 4;

      const distToHole = Math.hypot(pos.x - this.hole.x, pos.z - this.hole.z);
      const speed = this.ballVel.length();

      if (distToHole < CAPTURE_RADIUS && speed < 4) {
        this.success = true;
        this.state = 'done';
        this._doneTimer = 1.0;
        this.ballVel.set(0, 0, 0);
        return;
      }

      // Lost ball: drag it back toward the pin's zip code.
      if (distToHole > 30) {
        this.ballVel.set(0, 0, 0);
      }

      if (speed < STOP_SPEED) {
        this.ballVel.set(0, 0, 0);
        if (this.strokes >= MAX_STROKES) {
          this.success = false;
          this.state = 'done';
          this._doneTimer = 1.0;
        } else {
          this.state = 'aim';
        }
      }
    } else if (this.state === 'done') {
      // Sunk balls drop out of sight; missed ones just sit there, ashamed.
      if (this.success) {
        this.ball.position.y -= dt * 0.8;
        this.ball.scale.multiplyScalar(Math.max(0, 1 - dt * 2));
      }
      this._doneTimer -= dt;
      if (this._doneTimer <= 0) {
        this.onFinish(this.success, this.strokes);
      }
    }
  }

  /** Early exit (Escape): counts as walking off the course. */
  abandon() {
    this.onFinish(false, this.strokes);
  }

  dispose() {
    this.scene.remove(this.ball);
    this.ballGeo.dispose();
    this.ballMat.dispose();
    if (this.aimGroup) this.scene.remove(this.aimGroup);
    for (const g of this._aimGeos || []) g.dispose();
    for (const m of this._aimMats || []) m.dispose();
    this.ui.hidePutt();
  }
}
