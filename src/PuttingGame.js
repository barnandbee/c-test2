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

    ui.showPutt();
    ui.setPuttStrokes(1, MAX_STROKES);
    ui.setPuttPower(0);
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
      if (input.jumpHeld) {
        this.state = 'charging';
        this.power = 0;
      }
    } else if (this.state === 'charging') {
      // Ping-pong the meter so overcooking a putt is always possible.
      this.power += dt * 0.85;
      const t = 1 - Math.abs((this.power % 2) - 1);
      this.ui.setPuttPower(t);
      if (!input.jumpHeld) {
        const strength = 3.5 + t * 13;
        this.ballVel.set(-Math.sin(cameraYaw) * strength, 0, -Math.cos(cameraYaw) * strength);
        this.strokes += 1;
        this.state = 'rolling';
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

  /** Early exit (double-tap): counts as walking off the course. */
  abandon() {
    this.onFinish(false, this.strokes);
  }

  dispose() {
    this.scene.remove(this.ball);
    this.ballGeo.dispose();
    this.ballMat.dispose();
    this.ui.hidePutt();
  }
}
