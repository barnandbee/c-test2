/**
 * Game.js — Orchestration: renderer, scene graph, game loop, gameplay rules
 * (health / points / 3-minute clock / damage / game over), persistence
 * (local high score, character unlock) and full lifecycle management.
 */

import * as THREE from 'three';
import { World } from './World.js';
import { Player } from './Player.js';
import { CameraRig } from './CameraRig.js';
import { Input } from './Input.js';
import { UI } from './UI.js';
import { ParticleFX } from './Particles.js';
import {
  PineCone,
  GoldenEgg,
  MarshmallowCloud,
  AtomicCherry,
  MagnaCarta,
  ToxicFrog,
  ClockTower,
  MagnusCarter,
  Submarine,
  Hovercraft,
  HotAirBalloon,
  Star,
  Launchpad,
  Rocket,
  disposeEntityAssets
} from './Entities.js';
import { SharedUniforms, updateSharedTime } from './Shaders.js';
import { clamp } from './utils/MathUtils.js';

const PINE_CONE_COUNT = 26;
const GOLDEN_EGG_COUNT = 6;
const MARSHMALLOW_COUNT = 12;
const CHERRY_COUNT = 10;
const FROG_COUNT = 8;
const DAMAGE_PER_HIT = 10;
const CART_HEALTH_DAMAGE = 20;
const CART_POINTS_DAMAGE = 20;
const INVULN_TIME = 1.1;
const GAME_DURATION = 180;          // three twilight minutes
const TOWER_TIME_BONUS = 10;        // seconds granted per visit
const UNLOCK_SCORE = 30;            // badgerette unlocks above this
const BOFFINGTON_TOWER_VISITS = 6;  // +60 banked seconds in one run
const RED_OCTOBER_POINTS = 63.14159;
const BOARDING_RANGE = 2.8;
const BALLOON_SCORE = 100;          // the balloon drifts in at this score
const MAGNA_CARTA_VALUE = 25;
const STAR_COUNT = 9;
const STAR_VALUE = 20;
const ROCKET_MIN_SCORE = 88;        // rocket present only while
const ROCKET_MAX_SCORE = 112;       //   88 < score < 112
const GINSBERG_STARS = 5;

const STORAGE_HIGH_SCORE = 'mystic-badger.highScore';
const STORAGE_UNLOCKED = 'mystic-badger.badgeretteUnlocked';
const STORAGE_HUGHES = 'mystic-badger.hughesUnlocked';
const STORAGE_BOFFINGTON = 'mystic-badger.boffingtonUnlocked';
const STORAGE_WILLIAM = 'mystic-badger.williamUnlocked';
const STORAGE_EDITH = 'mystic-badger.edithUnlocked';
const STORAGE_RHOMBUS = 'mystic-badger.rhombusUnlocked';
const STORAGE_GINSBERG = 'mystic-badger.ginsbergUnlocked';
const STORAGE_MAGNUS = 'mystic-badger.magnusUnlocked';
const STORAGE_BODDINGTON = 'mystic-badger.boddingtonUnlocked';
const STORAGE_ERROR42 = 'mystic-badger.error42Unlocked';
const STORAGE_MAYO = 'mystic-badger.mayoUnlocked';
const STORAGE_PERPBIRD = 'mystic-badger.perpbirdUnlocked';
const STORAGE_CHARACTER = 'mystic-badger.character';
const MAYO_SCORE = 300;
const SANDWICH_POINTS = 55.5;
const SANDWICH_RANGE = 2.6;
// One of each collectible species, identified by point value:
// cone, cherry, cloud, egg, star, Magna Carta.
const ERROR42_SET = [1, 3, 5, 10, 20, 25];
const MAGNUS_HITS_REQUIRED = 4;
const MAGNUS_MIN_SCORE = 50;

/** localStorage can throw (private browsing, disabled storage) — shrug it off. */
function readStorage(key, fallback = null) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (err) {
    /* persistence is a nicety, never a crash */
  }
}

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

    // --- persistence ---------------------------------------------------------
    this.highScore = parseFloat(readStorage(STORAGE_HIGH_SCORE, '0')) || 0;
    this.badgeretteUnlocked = readStorage(STORAGE_UNLOCKED) === '1';
    this.hughesUnlocked = readStorage(STORAGE_HUGHES) === '1';
    this.boffingtonUnlocked = readStorage(STORAGE_BOFFINGTON) === '1';
    this.williamUnlocked = readStorage(STORAGE_WILLIAM) === '1';
    this.edithUnlocked = readStorage(STORAGE_EDITH) === '1';
    this.rhombusUnlocked = readStorage(STORAGE_RHOMBUS) === '1';
    this.ginsbergUnlocked = readStorage(STORAGE_GINSBERG) === '1';
    this.magnusUnlocked = readStorage(STORAGE_MAGNUS) === '1';
    this.boddingtonUnlocked = readStorage(STORAGE_BODDINGTON) === '1';
    this.error42Unlocked = readStorage(STORAGE_ERROR42) === '1';
    this.mayoUnlocked = readStorage(STORAGE_MAYO) === '1';
    this.perpbirdUnlocked = readStorage(STORAGE_PERPBIRD) === '1';
    const storedCharacter = readStorage(STORAGE_CHARACTER, 'badger');
    this.characterName = this.isCharacterAllowed(storedCharacter) ? storedCharacter : 'badger';

    const spawn = new THREE.Vector3(0, this.world.getHeight(0, 0), 0);
    this.player = new Player(this.world, spawn, this.characterName);
    this.scene.add(this.player.root);

    this.cameraRig = new CameraRig(this.camera, this.world);
    this.cameraRig.snapTo(this.player.position);

    // Dust puff on hard landings (kept as a bound handler so a character
    // swap can re-wire the fresh Player instance).
    this._onPlayerLand = (impactSpeed, position) => {
      this.particles.spawnBurst(position, 0x9b8a72, {
        count: Math.round(clamp(impactSpeed, 6, 20)),
        speed: 2.2,
        gravity: 3.5,
        size: 30,
        upBias: 0.35,
        life: 0.55
      });
    };
    this.player.onLand = this._onPlayerLand;

    // Splash-and-bounce feedback when the non-swimmer tries the lake.
    this._lastSplashToast = -Infinity;
    this._onPlayerSplash = () => {
      const center = this.player.getColliderCenter(this._playerCenter);
      this.particles.spawnBurst(center, 0xbfe4ef, {
        count: 26,
        speed: 3.4,
        size: 40,
        upBias: 0.8,
        life: 0.6
      });
      const now = performance.now();
      if (now - this._lastSplashToast > 2500) {
        this.ui.showTimeToast("CAN'T SWIM!");
        this._lastSplashToast = now;
      }
    };
    this.player.onSplash = this._onPlayerSplash;

    // --- gameplay state ------------------------------------------------------
    this.health = 100;
    this.points = 0;
    this.timeLeft = GAME_DURATION;
    this.invulnTimer = 0;
    this.isGameOver = false;
    this.towerVisits = 0;
    this.runUnlockNames = [];
    this.redOctoberClaimed = false;
    this.flewBalloon = false;
    this.starsCollected = 0;
    this.cartHits = 0;
    this.itemTypesCollected = new Set();
    this.sandwichClaimed = false;
    this.collectibles = [];
    this.frogs = [];
    this.clockTower = null;
    this.cart = null;
    this.submarine = null;
    this.hovercraft = null;
    this.balloon = null;
    this.launchpad = null;
    this.rocket = null;
    this.spawnEntities();

    this.ui.setHealth(this.health);
    this.ui.setPointsSilent(0);
    this.ui.setTimer(this.timeLeft);
    this.ui.bindRestart(() => this.restart());

    // --- welcome menu -------------------------------------------------------
    // The run doesn't begin until ENTER THE FOREST; meanwhile the camera
    // drifts cinematically around the hero.
    this.inMenu = true;
    this.ui.setRoster(this.getUnlockedMap(), this.characterName);
    this.ui.setMenuBest(this.highScore);
    this.ui.showMenu();
    this.ui.bindStart(() => this.beginRun());

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
    // Marshmallow clouds drift far above the canopy — balloon country.
    // They keep clear of the Escher stairs so the summit can't poach them.
    for (let i = 0; i < MARSHMALLOW_COUNT; i++) {
      let p = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        p = this.world.randomGroundPoint(15, 95);
        const s = this.world.stairCenter;
        if (!s || Math.hypot(p.x - s.x, p.z - s.z) > 24) break;
      }
      p.y += 19 + Math.random() * 9;
      this.collectibles.push(new MarshmallowCloud(this.scene, p));
    }

    // Atomic glacé cherries crown a handful of random trees.
    const tops = [...this.world.treeTops];
    for (let i = 0; i < CHERRY_COUNT && tops.length > 0; i++) {
      const pick = Math.floor(Math.random() * tops.length);
      const top = tops.splice(pick, 1)[0];
      this.collectibles.push(new AtomicCherry(this.scene, top.clone()));
    }

    // Magna Cartas are rare: one crowns the Escher stairs (earn the climb),
    // one hides out in the far wilds.
    if (this.world.stairTopPoint) {
      this.collectibles.push(new MagnaCarta(this.scene, this.world.stairTopPoint.clone()));
    }
    this.collectibles.push(new MagnaCarta(this.scene, this.world.randomGroundPoint(45, 95)));

    // The clock tower starts a stroll away — visible, but a detour.
    const towerSpot = this.world.randomGroundPoint(26, 60, 0.8);
    this.clockTower = new ClockTower(this.scene, this.world, towerSpot);

    // And somewhere out there, an elf guns a golf cart.
    this.cart = new MagnusCarter(this.scene, this.world, this.world.randomGroundPoint(30, 70));

    // Red October lurks in the lake; the hovercraft is the only way out
    // to meet her, parked at some random spot on dry land.
    this.submarine = new Submarine(this.scene, this.world);
    this.hovercraft = new Hovercraft(this.scene, this.world, this.world.randomGroundPoint(18, 60));

    // Space: golden stars far above everything, and a launchpad buried
    // beside the cherry blossom tree, waiting to be discovered.
    for (let i = 0; i < STAR_COUNT; i++) {
      const p = this.world.randomGroundPoint(15, 85);
      p.y = 80 + Math.random() * 30;
      this.collectibles.push(new Star(this.scene, p));
    }
    this.launchpad = new Launchpad(this.scene, this.world);
  }

  clearEntities() {
    for (const c of this.collectibles) c.dispose();
    for (const f of this.frogs) f.dispose();
    this.collectibles.length = 0;
    this.frogs.length = 0;
    if (this.clockTower) {
      this.clockTower.dispose();
      this.clockTower = null;
    }
    if (this.cart) {
      this.cart.dispose();
      this.cart = null;
    }
    if (this.submarine) {
      this.submarine.dispose();
      this.submarine = null;
    }
    if (this.hovercraft) {
      this.player.vehicle = null;
      this.hovercraft.dispose();
      this.hovercraft = null;
    }
    if (this.balloon) {
      this.balloon.dispose();
      this.balloon = null;
    }
    if (this.launchpad) {
      this.launchpad.dispose();
      this.launchpad = null;
    }
    if (this.rocket) {
      this.rocket.dispose();
      this.rocket = null;
    }
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

      // The Magna Carta announces itself — and crowns a king, once.
      if (item.value === MAGNA_CARTA_VALUE) {
        this.ui.showTimeToast('YOU GOT THE MAGNA CARTA, BABY!');
        if (!this.williamUnlocked) {
          this.williamUnlocked = true;
          writeStorage(STORAGE_WILLIAM, '1');
          this.runUnlockNames.push('William the Conqueror');
        }
      }

      // Stars: five in one run summons the poet.
      if (item.value === STAR_VALUE) {
        this.starsCollected += 1;
        if (this.starsCollected >= GINSBERG_STARS && !this.ginsbergUnlocked) {
          this.ginsbergUnlocked = true;
          writeStorage(STORAGE_GINSBERG, '1');
          this.runUnlockNames.push('Alien Ginsberg');
          this.ui.showTimeToast('★ ALIEN GINSBERG UNLOCKED!');
        }
      }

      // The full set — one of every species in a single run — corrupts
      // the character loader in the best possible way.
      this.itemTypesCollected.add(item.value);
      if (
        !this.error42Unlocked &&
        ERROR42_SET.every((v) => this.itemTypesCollected.has(v))
      ) {
        this.error42Unlocked = true;
        writeStorage(STORAGE_ERROR42, '1');
        this.runUnlockNames.push('Error #42');
        this.ui.showTimeToast('★ ERROR #42 UNLOCKED?!');
      }

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
        this.gameOver('health');
      }
      break;
    }

    // Magnus Carter's golf cart: worse than any frog — and it costs points.
    if (this.isGameOver || this.invulnTimer > 0 || !this.cart) return;
    const cart = this.cart;
    const cdx = center.x - cart.position.x;
    const cdz = center.z - cart.position.z;
    const cdy = center.y - cart.position.y;
    const creach = cart.hazardRadius + 0.4;
    if (cdx * cdx + cdz * cdz < creach * creach && Math.abs(cdy) < 2.4) {
      this.cartHits += 1;
      // Magnus run over by his own cart, twice: a paradox so rude it
      // summons his nemesis twin into existence.
      if (
        this.characterName === 'magnus' &&
        this.cartHits >= 2 &&
        !this.boddingtonUnlocked
      ) {
        this.boddingtonUnlocked = true;
        writeStorage(STORAGE_BODDINGTON, '1');
        this.runUnlockNames.push('Mr Flynn Boddington');
        this.ui.showTimeToast('★ MR FLYNN BODDINGTON UNLOCKED!');
      }
      this.health -= CART_HEALTH_DAMAGE;
      this.points = Math.max(0, this.points - CART_POINTS_DAMAGE);
      this.invulnTimer = INVULN_TIME;
      this.ui.setHealth(this.health);
      this.ui.setPoints(this.points);
      this.ui.flashDamage();
      this.player.applyKnockback(cart.position.x, cart.position.z, 13);
      this.particles.spawnBurst(center, 0xffe6a0, {
        count: 30,
        speed: 4.5,
        size: 42,
        upBias: 0.6,
        life: 0.7
      });
      if (this.health <= 0) this.gameOver('health');
    }
  }

  /** The temporal bargain: touch the tower, gain seconds, lose the tower. */
  handleClockTower() {
    const tower = this.clockTower;
    if (!tower || !tower.tryEnter(this.player.position)) return;

    this.timeLeft += TOWER_TIME_BONUS;
    this.towerVisits += 1;
    this.ui.setTimer(this.timeLeft);

    // Banking a full extra minute in one run impresses Mr Boffington.
    if (this.towerVisits >= BOFFINGTON_TOWER_VISITS && !this.boffingtonUnlocked) {
      this.boffingtonUnlocked = true;
      writeStorage(STORAGE_BOFFINGTON, '1');
      this.runUnlockNames.push('Mr Finn Boffington');
      this.ui.showTimeToast('★ MR FINN BOFFINGTON UNLOCKED!');
    } else {
      this.ui.showTimeToast(`+${TOWER_TIME_BONUS} SECONDS`);
    }

    // A cool blue "time magic" burst, distinct from the golden pickups.
    const burstAt = this._playerCenter.set(tower.position.x, tower.position.y + 1.6, tower.position.z);
    this.particles.spawnBurst(burstAt, 0x9ecbff, {
      count: 44,
      speed: 5.0,
      size: 48,
      upBias: 0.8,
      life: 0.9
    });

    // Vanish to somewhere genuinely elsewhere — retry until it's far away.
    let destination = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      destination = this.world.randomGroundPoint(25, 95, 0.78);
      const dx = destination.x - this.player.position.x;
      const dz = destination.z - this.player.position.z;
      if (dx * dx + dz * dz > 45 * 45) break;
    }
    tower.teleport(destination);
    this.particles.spawnBurst(
      this._playerCenter.set(destination.x, destination.y + 1.6, destination.z),
      0x9ecbff,
      { count: 30, speed: 4.0, size: 44, upBias: 0.8, life: 0.8 }
    );
  }

  isCharacterAllowed(name) {
    if (name === 'badgerette') return this.badgeretteUnlocked;
    if (name === 'hughes') return this.hughesUnlocked;
    if (name === 'boffington') return this.boffingtonUnlocked;
    if (name === 'william') return this.williamUnlocked;
    if (name === 'edith') return this.edithUnlocked;
    if (name === 'rhombus') return this.rhombusUnlocked;
    if (name === 'ginsberg') return this.ginsbergUnlocked;
    if (name === 'magnus') return this.magnusUnlocked;
    if (name === 'boddington') return this.boddingtonUnlocked;
    if (name === 'error42') return this.error42Unlocked;
    if (name === 'mayo') return this.mayoUnlocked;
    if (name === 'perpbird') return this.perpbirdUnlocked;
    return name === 'badger';
  }

  getUnlockedMap() {
    return {
      badgerette: this.badgeretteUnlocked,
      hughes: this.hughesUnlocked,
      boffington: this.boffingtonUnlocked,
      william: this.williamUnlocked,
      edith: this.edithUnlocked,
      rhombus: this.rhombusUnlocked,
      ginsberg: this.ginsbergUnlocked,
      magnus: this.magnusUnlocked,
      boddington: this.boddingtonUnlocked,
      error42: this.error42Unlocked,
      mayo: this.mayoUnlocked,
      perpbird: this.perpbirdUnlocked
    };
  }

  /** Leave the welcome menu and start the clock. */
  beginRun() {
    if (!this.inMenu) return;
    const chosen = this.ui.getSelectedCharacter() || this.characterName;
    if (chosen !== this.characterName && this.isCharacterAllowed(chosen)) {
      this.setCharacter(chosen);
    }
    this.inMenu = false;
    this.clock.getDelta(); // flush menu time so the countdown starts clean
    this.ui.hideMenu();
  }

  /**
   * Tap gestures. Double-tap boards/leaves the hovercraft or balloon and
   * uncovers the launchpad; the ROCKET demands ceremony — triple-tap in,
   * triple-tap out — so nobody falls out of orbit by accident.
   */
  handleDoubleTap() {
    const triple = this.input.consumeTripleTap();
    const double = this.input.consumeDoubleTap();
    if ((!triple && !double) || !this.hovercraft) return;

    if (this.player.vehicle) {
      const isRocket = this.player.vehicle.kind === 'rocket';
      if (isRocket ? !triple : !double) {
        // Teach the gesture instead of silently ignoring it.
        if (isRocket && double) this.ui.showTimeToast('TRIPLE-TAP TO EXIT THE ROCKET');
        return;
      }
      // Only allow dismounting where there's something to stand on —
      // otherwise the vehicle would be stranded mid-lake forever. (Only
      // real lake water counts; dry valleys are fine to hop out into.)
      const px = this.player.position.x;
      const pz = this.player.position.z;
      const overDeepWater =
        this.world.isNearLake(px, pz) &&
        this.world.getHeight(px, pz) <= this.world.waterLevel - 0.1;
      if (!overDeepWater) {
        const vehicle = this.player.vehicle;
        this.player.vehicle = null;
        vehicle.rider = null;
        vehicle.parkAt(this.player.position);
        this.ui.showTimeToast('HOPPED OUT');
      }
      return;
    }

    // Rocket boarding: triple-tap only.
    if (triple && this.rocket) {
      const dx = this.player.position.x - this.rocket.position.x;
      const dz = this.player.position.z - this.rocket.position.z;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE) {
        this.player.vehicle = this.rocket;
        this.rocket.rider = this.player;
        // Ignition: a proper kick off the pad.
        this.player.velocity.y = 16;
        this.ui.showTimeToast('TO THE STARS! HOLD JUMP TO THRUST');
        this.particles.spawnBurst(
          this._playerCenter.copy(this.player.position),
          0xffb640,
          { count: 44, speed: 5.5, size: 50, upBias: 0.2, life: 0.9 }
        );
        return;
      }
    }

    if (!double) return;

    // Board whichever double-tap vehicle is in reach.
    for (const vehicle of [this.hovercraft, this.balloon]) {
      if (!vehicle) continue;
      const dx = this.player.position.x - vehicle.position.x;
      const dz = this.player.position.z - vehicle.position.z;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE) {
        this.player.vehicle = vehicle;
        vehicle.rider = this.player;
        this.ui.showTimeToast(
          vehicle.kind === 'balloon'
            ? 'BALLOON! HOLD JUMP TO RISE'
            : 'HOVERCRAFT! DOUBLE-TAP TO HOP OUT'
        );
        return;
      }
    }

    // The sandwich in the cave. Most heroes find it wanting; one of
    // them IS what it wants.
    const sandwich = this.world.sandwichPos;
    if (sandwich) {
      const dx = this.player.position.x - sandwich.x;
      const dz = this.player.position.z - sandwich.z;
      const dy = this.player.position.y - sandwich.y;
      if (dx * dx + dz * dz < SANDWICH_RANGE * SANDWICH_RANGE && Math.abs(dy) < 3) {
        if (this.characterName === 'mayo') {
          if (!this.sandwichClaimed) {
            this.sandwichClaimed = true;
            this.points += SANDWICH_POINTS;
            this.ui.setPoints(this.points);
            this.particles.spawnBurst(
              this._playerCenter.set(sandwich.x, sandwich.y + 0.6, sandwich.z),
              0xf2eed8,
              { count: 36, speed: 4.2, size: 46, upBias: 0.7, life: 0.9 }
            );
            if (!this.perpbirdUnlocked) {
              this.perpbirdUnlocked = true;
              writeStorage(STORAGE_PERPBIRD, '1');
              this.runUnlockNames.push('Perpendicular Bird');
              this.ui.showTimeToast('★ PERPENDICULAR BIRD UNLOCKED! +55.5');
            } else {
              this.ui.showTimeToast('MUCH BETTER! +55.5');
            }
          } else {
            this.ui.showTimeToast('ALREADY PERFECTLY MOIST');
          }
        } else {
          this.ui.showTimeToast("IT'S A BLT, BUT IT'S A BIT TOO DRY…");
        }
        return;
      }
    }

    // A double-tap near the parked rocket: teach the gesture.
    if (this.rocket) {
      const dx = this.player.position.x - this.rocket.position.x;
      const dz = this.player.position.z - this.rocket.position.z;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE) {
        this.ui.showTimeToast('TRIPLE-TAP TO BOARD THE ROCKET');
        return;
      }
    }

    // No vehicle in reach — perhaps the cherry blossom tree's secret?
    const tree = this.world.blossomTree;
    if (tree && this.launchpad && this.launchpad.state === 'hidden') {
      const dx = this.player.position.x - tree.x;
      const dz = this.player.position.z - tree.z;
      if (dx * dx + dz * dz < 4.5 * 4.5) {
        this.launchpad.reveal();
        this.ui.showTimeToast('A LAUNCHPAD EMERGES!');
        this.particles.spawnBurst(
          this._playerCenter.set(this.launchpad.position.x, this.launchpad.position.y + 1, this.launchpad.position.z),
          0x9b8a72,
          { count: 40, speed: 4.5, size: 46, upBias: 0.7, life: 0.9 }
        );
      }
    }
  }

  /**
   * The rocket is fickle: it lands on the (revealed) pad only while the
   * score sits strictly between 88 and 112, and departs the moment the
   * score wanders out — unless someone is riding it.
   */
  manageRocket() {
    if (!this.launchpad || !this.launchpad.isReady()) return;
    const inWindow = this.points > ROCKET_MIN_SCORE && this.points < ROCKET_MAX_SCORE;

    if (inWindow && !this.rocket) {
      const spot = new THREE.Vector3(
        this.launchpad.position.x,
        this.launchpad.padTop,
        this.launchpad.position.z
      );
      this.rocket = new Rocket(this.scene, this.world, spot);
      this.ui.showTimeToast('A ROCKET HAS LANDED! TRIPLE-TAP TO BOARD');
      this.particles.spawnBurst(
        this._playerCenter.set(spot.x, spot.y + 2, spot.z),
        0xd8ecf2,
        { count: 36, speed: 4.5, size: 46, upBias: 0.5, life: 0.8 }
      );
    } else if (!inWindow && this.rocket && this.player.vehicle !== this.rocket) {
      // Departs without you.
      this.particles.spawnBurst(
        this._playerCenter.set(this.rocket.position.x, this.rocket.position.y + 2.5, this.rocket.position.z),
        0xffb640,
        { count: 40, speed: 6, size: 48, upBias: 1.0, life: 0.9 }
      );
      this.rocket.dispose();
      this.rocket = null;
      this.ui.showTimeToast('THE ROCKET DEPARTS…');
    }
  }

  /** At 100 points, a balloon drifts in — landing within sight if possible. */
  maybeSpawnBalloon() {
    if (this.balloon || this.points < BALLOON_SCORE) return;
    let spot = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const x = this.player.position.x + Math.cos(a) * 18;
      const z = this.player.position.z + Math.sin(a) * 18;
      if (Math.hypot(x, z) > this.world.playableRadius - 6) continue;
      if (this.world.isNearLake(x, z)) continue;
      if (this.world.getNormal(x, z, this._scratchNormal || (this._scratchNormal = new THREE.Vector3())).y < 0.8) continue;
      spot = new THREE.Vector3(x, this.world.getHeight(x, z), z);
      break;
    }
    if (!spot) spot = this.world.randomGroundPoint(15, 50);
    this.balloon = new HotAirBalloon(this.scene, this.world, spot);
    this.ui.showTimeToast('A HOT AIR BALLOON DRIFTS IN!');
    this.particles.spawnBurst(
      this._playerCenter.set(spot.x, spot.y + 2.5, spot.z),
      0xf2e6c8,
      { count: 32, speed: 4.0, size: 44, upBias: 0.6, life: 0.8 }
    );
  }

  /** Reaching the surfaced Red October pays out π-adjacent riches. */
  handleRedOctober() {
    if (this.redOctoberClaimed || !this.submarine || !this.submarine.isSurfaced()) return;
    const sub = this.submarine.position;
    const dx = this.player.position.x - sub.x;
    const dz = this.player.position.z - sub.z;
    if (dx * dx + dz * dz > 5 * 5) return;

    this.redOctoberClaimed = true;
    this.points += RED_OCTOBER_POINTS;
    this.ui.setPoints(this.points);
    this.ui.showTimeToast('RED OCTOBER! +63.14159');
    this.particles.spawnBurst(
      this._playerCenter.set(sub.x, this.world.waterLevel + 1.5, sub.z),
      0xff6a5a,
      { count: 46, speed: 5.5, size: 50, upBias: 0.75, life: 1.0 }
    );
  }

  gameOver(reason) {
    this.isGameOver = true;
    if (document.pointerLockElement) document.exitPointerLock();

    // Persist the high score and any character unlocks.
    const isNewHigh = this.points > this.highScore;
    if (isNewHigh) {
      this.highScore = this.points;
      writeStorage(STORAGE_HIGH_SCORE, this.highScore);
    }

    // Boffington may already be in runUnlockNames (earned mid-run at the
    // sixth tower); the other two are judged here at the bell.
    const newlyUnlockedNames = [...this.runUnlockNames];
    if (!this.badgeretteUnlocked && this.points > UNLOCK_SCORE) {
      this.badgeretteUnlocked = true;
      writeStorage(STORAGE_UNLOCKED, '1');
      newlyUnlockedNames.push('Badgerette');
    }
    // Hughes: go the full three minutes without taking a single hit.
    if (!this.hughesUnlocked && reason === 'time' && this.health >= 100) {
      this.hughesUnlocked = true;
      writeStorage(STORAGE_HUGHES, '1');
      newlyUnlockedNames.push('‘Crisp Packet’ Hughes');
    }
    // Edith: took the balloon up during this run.
    if (!this.edithUnlocked && this.flewBalloon) {
      this.edithUnlocked = true;
      writeStorage(STORAGE_EDITH, '1');
      newlyUnlockedNames.push('Edith McCombe');
    }
    // Rhombus the Hat: land the final score on a right angle — exactly
    // 90, 180, 270 or 360. (Fractional Red October scores can't qualify.)
    if (!this.rhombusUnlocked && [90, 180, 270, 360].includes(this.points)) {
      this.rhombusUnlocked = true;
      writeStorage(STORAGE_RHOMBUS, '1');
      newlyUnlockedNames.push('Rhombus the Hat');
    }
    // Mayonnaise: a jar this size only respects a 300+ finish.
    if (!this.mayoUnlocked && this.points >= MAYO_SCORE) {
      this.mayoUnlocked = true;
      writeStorage(STORAGE_MAYO, '1');
      newlyUnlockedNames.push('Mayonnaise');
    }
    // Magnus Carter: take four cart hits, survive the full three minutes
    // anyway, and still finish with 50+. He respects that kind of grit.
    if (
      !this.magnusUnlocked &&
      reason === 'time' &&
      this.cartHits >= MAGNUS_HITS_REQUIRED &&
      this.points >= MAGNUS_MIN_SCORE
    ) {
      this.magnusUnlocked = true;
      writeStorage(STORAGE_MAGNUS, '1');
      newlyUnlockedNames.push('Magnus Carter');
    }

    this.ui.showGameOver({
      score: this.points,
      highScore: this.highScore,
      isNewHigh,
      reason,
      unlocked: this.getUnlockedMap(),
      newlyUnlockedNames,
      currentCharacter: this.characterName
    });
  }

  restart() {
    // Apply the character chosen on the game-over screen (if any).
    const chosen = this.ui.getSelectedCharacter() || this.characterName;
    if (chosen !== this.characterName && this.isCharacterAllowed(chosen)) {
      this.setCharacter(chosen);
    }

    this.clearEntities();
    this.spawnEntities();
    this.player.reset();
    this.cameraRig.snapTo(this.player.position);
    this.health = 100;
    this.points = 0;
    this.timeLeft = GAME_DURATION;
    this.invulnTimer = 0;
    this.isGameOver = false;
    this.towerVisits = 0;
    this.runUnlockNames = [];
    this.redOctoberClaimed = false;
    this.flewBalloon = false;
    this.starsCollected = 0;
    this.cartHits = 0;
    this.itemTypesCollected.clear();
    this.sandwichClaimed = false;
    this.ui.setHealth(this.health);
    this.ui.setPointsSilent(0);
    this.ui.setTimer(this.timeLeft);
    this.ui.hideGameOver();
  }

  /** Swap heroes: rebuild the Player wholesale and re-wire its events. */
  setCharacter(name) {
    this.characterName = name;
    writeStorage(STORAGE_CHARACTER, name);
    const spawn = this.player.spawnPoint;
    this.player.dispose();
    this.player = new Player(this.world, spawn, name);
    this.player.onLand = this._onPlayerLand;
    this.scene.add(this.player.root);
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

    if (this.inMenu) {
      // Welcome menu: the forest breathes, the camera drifts, no clock.
      this.player.animate(dt, false);
      this.cameraRig.update(dt, this.player, null);
    } else if (!this.isGameOver) {
      // The countdown IS the game: run dry and the twilight takes you.
      this.timeLeft -= dt;
      this.ui.setTimer(this.timeLeft);
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.gameOver('time');
      }

      this.invulnTimer = Math.max(0, this.invulnTimer - dt);
      this.handleDoubleTap();
      this.player.update(dt, this.input, this.cameraRig.yaw);
      this.handlePickups();
      this.handleHazards();
      this.handleClockTower();
      this.handleRedOctober();
      this.maybeSpawnBalloon();
      this.manageRocket();

      // "Getting in and flying" means genuinely leaving the ground.
      if (
        !this.flewBalloon &&
        this.balloon &&
        this.player.vehicle === this.balloon &&
        this.player.position.y -
          this.world.getHeight(this.player.position.x, this.player.position.z) > 3
      ) {
        this.flewBalloon = true;
      }

      this.cameraRig.update(dt, this.player, this.input);
    } else {
      this.cameraRig.update(dt, this.player, null);
    }

    for (const item of this.collectibles) item.update(dt, time);
    for (const frog of this.frogs) frog.update(dt, time);
    if (this.cart) this.cart.update(dt, time);
    if (this.submarine) {
      this.submarine.update(dt, time);
      if (this.submarine.consumeJustSurfaced()) {
        // Breach spray where she surfaces.
        this.particles.spawnBurst(
          this._playerCenter.set(
            this.submarine.position.x,
            this.world.waterLevel + 0.6,
            this.submarine.position.z
          ),
          0xd8ecf2,
          { count: 40, speed: 4.6, size: 46, upBias: 0.85, life: 0.9 }
        );
      }
    }
    if (this.hovercraft) this.hovercraft.update(dt, time);
    if (this.balloon) this.balloon.update(dt, time);
    if (this.launchpad) this.launchpad.update(dt);
    if (this.rocket) this.rocket.update(dt, time);
    if (this.clockTower) {
      this.clockTower.update(dt);
      this.clockTower.setTimeFraction((this.timeLeft % GAME_DURATION) / GAME_DURATION || (this.timeLeft > 0 ? 1 : 0));
    }
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
