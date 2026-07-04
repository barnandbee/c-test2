/**
 * Game.js — Orchestration: renderer, scene graph, game loop, gameplay rules
 * (health / points / damage / game over) and full lifecycle management.
 */

import * as THREE from 'three';
import { World } from './World.js';
import { Player } from './Player.js';
import { CameraRig } from './CameraRig.js';
import { Input } from './Input.js';
import { UI } from './UI.js';
import { ParticleFX } from './Particles.js';
import { PineCone, GoldenEgg, ToxicFrog, disposeEntityAssets } from './Entities.js';
import { SharedUniforms, updateSharedTime } from './Shaders.js';
import { clamp } from './utils/MathUtils.js';

const PINE_CONE_COUNT = 26;
const GOLDEN_EGG_COUNT = 6;
const FROG_COUNT = 8;
const DAMAGE_PER_HIT = 10;
const INVULN_TIME = 1.1;

export class Game {
  constructor(container) {
    this.container = container;

    // --- renderer --------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    // --- scene & camera -----------------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 700);

    // --- systems ---------------------------------------------------------------
    this.world = new World(this.scene, this.renderer);
    this.input = new Input(this.renderer.domElement);
    this.ui = new UI();
    this.particles = new ParticleFX(this.scene);

    const spawn = new THREE.Vector3(0, this.world.getHeight(0, 0), 0);
    this.player = new Player(this.world, spawn);
    this.scene.add(this.player.root);

    this.cameraRig = new CameraRig(this.camera, this.world);
    this.cameraRig.snapTo(this.player.position);

    // Dust puff on hard landings.
    this.player.onLand = (impactSpeed, position) => {
      this.particles.spawnBurst(position, 0x9b8a72, {
        count: Math.round(clamp(impactSpeed, 6, 20)),
        speed: 2.2,
        gravity: 3.5,
        size: 30,
        upBias: 0.35,
        life: 0.55
      });
    };

    // --- gameplay state ------------------------------------------------------
    this.health = 100;
    this.points = 0;
    this.invulnTimer = 0;
    this.isGameOver = false;
    this.collectibles = [];
    this.frogs = [];
    this.spawnEntities();

    this.ui.setHealth(this.health);
    this.ui.pointsValue.textContent = '0';
    this.ui.bindRestart(() => this.restart());

    // --- loop ---------------------------------------------------------------------
    this.clock = new THREE.Clock();
    this._playerCenter = new THREE.Vector3();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  /* ================================================================ */
  /*  Entity management                                               */
  /* ================================================================ */

  spawnEntities() {
    for (let i = 0; i < PINE_CONE_COUNT; i++) {
      const p = this.world.randomGroundPoint(7, 78);
      this.collectibles.push(new PineCone(this.scene, p));
    }
    // Eggs are rare and live out toward the wilds.
    for (let i = 0; i < GOLDEN_EGG_COUNT; i++) {
      const p = this.world.randomGroundPoint(30, 98, 0.72);
      this.collectibles.push(new GoldenEgg(this.scene, p));
    }
    for (let i = 0; i < FROG_COUNT; i++) {
      const p = this.world.randomGroundPoint(14, 85);
      this.frogs.push(new ToxicFrog(this.scene, this.world, p));
    }
  }

  clearEntities() {
    for (const c of this.collectibles) c.dispose();
    for (const f of this.frogs) f.dispose();
    this.collectibles.length = 0;
    this.frogs.length = 0;
  }

  /* ================================================================ */
  /*  Gameplay rules                                                  */
  /* ================================================================ */

  handlePickups() {
    const center = this.player.getColliderCenter(this._playerCenter);
    const pr = this.player.colliderRadius;

    for (const item of this.collectibles) {
      if (item.state !== 'idle') continue;
      const dx = center.x - item.group.position.x;
      const dy = center.y - item.group.position.y;
      const dz = center.z - item.group.position.z;
      const reach = pr + item.pickupRadius;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

      item.startCollect();
      this.points += item.value;
      this.ui.setPoints(this.points);
      const isEgg = item.value >= 10;
      this.particles.spawnBurst(item.group.position, item.burstColor, {
        count: isEgg ? 42 : 22,
        speed: isEgg ? 5.5 : 3.8,
        size: isEgg ? 52 : 38,
        life: isEgg ? 1.0 : 0.7
      });
    }

    // Reap finished pickups and release their GPU resources.
    for (let i = this.collectibles.length - 1; i >= 0; i--) {
      if (this.collectibles[i].state === 'done') {
        this.collectibles[i].dispose();
        this.collectibles.splice(i, 1);
      }
    }
  }

  handleHazards() {
    if (this.invulnTimer > 0) return;
    const center = this.player.getColliderCenter(this._playerCenter);

    for (const frog of this.frogs) {
      const dx = center.x - frog.position.x;
      const dz = center.z - frog.position.z;
      const dy = center.y - frog.position.y;
      const reach = frog.hazardRadius + 0.4;
      if (dx * dx + dz * dz > reach * reach || Math.abs(dy) > 2.4) continue;

      this.health -= DAMAGE_PER_HIT;
      this.invulnTimer = INVULN_TIME;
      this.ui.setHealth(this.health);
      this.ui.flashDamage();
      this.player.applyKnockback(frog.position.x, frog.position.z);
      this.particles.spawnBurst(center, 0x86e05a, {
        count: 24,
        speed: 3.2,
        size: 40,
        upBias: 0.5,
        life: 0.6
      });

      if (this.health <= 0) {
        this.gameOver();
      }
      break;
    }
  }

  gameOver() {
    this.isGameOver = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showGameOver(this.points);
  }

  restart() {
    this.clearEntities();
    this.spawnEntities();
    this.player.reset();
    this.cameraRig.snapTo(this.player.position);
    this.health = 100;
    this.points = 0;
    this.invulnTimer = 0;
    this.isGameOver = false;
    this.ui.setHealth(this.health);
    this.ui.pointsValue.textContent = '0';
    this.ui.hideGameOver();
  }

  /* ================================================================ */
  /*  Loop                                                            */
  /* ================================================================ */

  start() {
    this.renderer.setAnimationLoop(() => this.tick());
  }

  tick() {
    // Clamp the delta so tab-switches don't teleport the physics.
    const dt = clamp(this.clock.getDelta(), 0, 1 / 20);
    updateSharedTime(dt);
    const time = SharedUniforms.uTime.value;

    if (!this.isGameOver) {
      this.invulnTimer = Math.max(0, this.invulnTimer - dt);
      this.player.update(dt, this.input, this.cameraRig.yaw);
      this.handlePickups();
      this.handleHazards();
      this.cameraRig.update(dt, this.player, this.input);
    } else {
      this.cameraRig.update(dt, this.player, null);
    }

    for (const item of this.collectibles) item.update(dt, time);
    for (const frog of this.frogs) frog.update(dt, time);
    this.particles.update();
    this.world.update(dt, this.player.position);

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /* ================================================================ */
  /*  Teardown                                                        */
  /* ================================================================ */

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.clearEntities();
    disposeEntityAssets();
    this.particles.dispose();
    this.player.dispose();
    this.world.dispose();
    this.input.dispose();
    this.ui.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
