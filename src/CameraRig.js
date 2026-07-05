/**
 * CameraRig.js — Cinematic third-person spring-arm camera.
 *
 *  - Orbit with mouse (pointer lock or drag), scroll to zoom.
 *  - Collision-aware: the arm sweeps the terrain height field and large
 *    rock colliders and shortens before clipping — snapping in fast,
 *    relaxing back out slowly.
 *  - Exponentially damped position/look targets for a floaty, filmic feel.
 *  - Gently auto-frames behind the player after a few seconds of no
 *    manual camera input while running.
 */

import * as THREE from 'three';
import { clamp, damp, dampAngle } from './utils/MathUtils.js';

const MIN_PITCH = -1.05;
const MAX_PITCH = 0.55;
const MIN_DIST = 3.2;
const MAX_DIST = 11.5;
const TERRAIN_CLEARANCE = 0.4;
const SWEEP_STEPS = 14;

export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;

    this.yaw = Math.PI; // start looking down -z over the badger's shoulder
    this.pitch = 0.28;
    this.targetDistance = 7.2;
    this.currentDistance = 7.2;

    this.focus = new THREE.Vector3();        // smoothed look-at point
    this.desiredPosition = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._samplePoint = new THREE.Vector3();
    this._toCamera = new THREE.Vector3();

    this.autoFollowDelay = 2.5;
  }

  snapTo(playerPosition) {
    this.focus.set(playerPosition.x, playerPosition.y + 1.6, playerPosition.z);
    this.updateCameraTransform(1);
    this.currentDistance = this.targetDistance;
    this.camera.position.copy(this.desiredPosition);
    this.camera.lookAt(this.focus);
  }

  /**
   * @param {number} dt
   * @param {import('./Player.js').Player} player
   * @param {import('./Input.js').Input|null} input  null = cinematic drift
   */
  update(dt, player, input) {
    // ---- manual orbit ---------------------------------------------------
    if (input) {
      const { dx, dy } = input.consumeMouseDelta();
      this.yaw -= dx * 0.0026;
      this.pitch = clamp(this.pitch + dy * 0.002, MIN_PITCH, MAX_PITCH);

      const wheel = input.consumeWheel();
      if (wheel !== 0) {
        this.targetDistance = clamp(this.targetDistance + wheel * 0.004, MIN_DIST, MAX_DIST);
      }

      // ---- lazy auto-follow while running -------------------------------
      const now = performance.now() / 1000;
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      if (speed > 2 && now - input.lastCameraInputTime > this.autoFollowDelay) {
        const behindYaw = player.facingYaw + Math.PI;
        this.yaw = dampAngle(this.yaw, behindYaw, 0.9, dt);
      }
    } else {
      // Game-over drift: a slow orbital pan around the fallen hero.
      this.yaw += dt * 0.25;
      this.pitch = damp(this.pitch, 0.42, 1.5, dt);
    }

    // ---- smoothed focus point -------------------------------------------
    const p = player.position;
    this.focus.x = damp(this.focus.x, p.x, 14, dt);
    this.focus.y = damp(this.focus.y, p.y + 1.6, 8, dt);
    this.focus.z = damp(this.focus.z, p.z, 14, dt);

    this.updateCameraTransform(dt);
  }

  updateCameraTransform(dt) {
    // Spherical offset from yaw/pitch.
    const cp = Math.cos(this.pitch);
    this._offset.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp
    );

    // ---- collision sweep: shorten the arm before it clips ----------------
    let allowedDistance = this.targetDistance;
    for (let i = 1; i <= SWEEP_STEPS; i++) {
      const d = (this.targetDistance * i) / SWEEP_STEPS;
      this._samplePoint.copy(this.focus).addScaledVector(this._offset, d);

      let ground = this.world.getHeight(this._samplePoint.x, this._samplePoint.z);
      if (
        this.world.waterLevel !== undefined &&
        ground < this.world.waterLevel &&
        this.world.isNearLake(this._samplePoint.x, this._samplePoint.z)
      ) {
        ground = this.world.waterLevel; // the camera stays out of the lake
      }
      let blocked = this._samplePoint.y < ground + TERRAIN_CLEARANCE;

      if (!blocked) {
        for (const c of this.world.cameraColliders) {
          const dx = this._samplePoint.x - c.x;
          const dy = this._samplePoint.y - c.y;
          const dz = this._samplePoint.z - c.z;
          const rr = (c.radius + 0.25) * (c.radius + 0.25);
          if (dx * dx + dy * dy + dz * dz < rr) {
            blocked = true;
            break;
          }
        }
      }

      if (blocked) {
        allowedDistance = Math.max(((i - 1) / SWEEP_STEPS) * this.targetDistance, MIN_DIST * 0.35);
        break;
      }
    }

    // Snap in quickly to avoid clipping; ease back out for smoothness.
    const lambda = allowedDistance < this.currentDistance ? 30 : 4;
    this.currentDistance = damp(this.currentDistance, allowedDistance, lambda, dt);

    this.desiredPosition.copy(this.focus).addScaledVector(this._offset, this.currentDistance);

    // Final guard: never let the camera itself dip under terrain or water.
    let camGround = this.world.getHeight(this.desiredPosition.x, this.desiredPosition.z);
    if (
      this.world.waterLevel !== undefined &&
      camGround < this.world.waterLevel &&
      this.world.isNearLake(this.desiredPosition.x, this.desiredPosition.z)
    ) {
      camGround = this.world.waterLevel;
    }
    if (this.desiredPosition.y < camGround + TERRAIN_CLEARANCE) {
      this.desiredPosition.y = camGround + TERRAIN_CLEARANCE;
    }

    this.camera.position.x = damp(this.camera.position.x, this.desiredPosition.x, 22, dt);
    this.camera.position.y = damp(this.camera.position.y, this.desiredPosition.y, 22, dt);
    this.camera.position.z = damp(this.camera.position.z, this.desiredPosition.z, 22, dt);
    this.camera.lookAt(this.focus);
  }
}
