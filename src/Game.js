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
  Goat,
  disposeEntityAssets
} from './Entities.js';
import { PuttingGame } from './PuttingGame.js';
import { TROPHIES, CHARACTER_UNLOCKS } from './Achievements.js';
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
const STORAGE_MARBLELLA = 'mystic-badger.marblellaUnlocked';
const STORAGE_FIR = 'mystic-badger.firUnlocked';
const STORAGE_MARGARET = 'mystic-badger.margaretUnlocked';
const STORAGE_JULIE = 'mystic-badger.julieUnlocked';
const STORAGE_CHARACTER = 'mystic-badger.character';
const STORAGE_ACHIEVEMENTS = 'mystic-badger.achievements';
const FIR_JUMPS_REQUIRED = 3; // jumps inside the Mystic Forest
// Margaret's strings: 5 cherries + 4 clouds + 5 frog hits in one run,
// and a final score whose last digit is 4.
const MARGARET_CHERRIES = 5;
const MARGARET_CLOUDS = 4;
const MARGARET_FROG_HITS = 5;
const ALARM_TIME_BONUS = 20;        // the cottage alarm clock, once per run
const APPLIANCE_RANGE = 2.4;
const TUBE_CAVE_POINTS = 55.5;      // Upper Cottage Lane fare rebate
const TICKET_EXACT_CHANGE = 281;    // the machine's other operating condition
// Touch every one of these in a single run and the marble rolls in.
const MARBLELLA_APPLIANCES = ['clock', 'stove', 'fridge', 'trapdoor'];
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
    this.marblellaUnlocked = readStorage(STORAGE_MARBLELLA) === '1';
    this.firUnlocked = readStorage(STORAGE_FIR) === '1';
    this.margaretUnlocked = readStorage(STORAGE_MARGARET) === '1';
    this.julieUnlocked = readStorage(STORAGE_JULIE) === '1';
    this.achievements = new Set(
      (readStorage(STORAGE_ACHIEVEMENTS, '') || '').split(',').filter(Boolean)
    );
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

    // Jumps inside the sealed Mystic Forest are counted — three of them
    // constitute an election.
    this._onPlayerJump = (position) => {
      if (this.isGameOver || !this.world.isInDell(position.x, position.z, position.y)) return;
      this.dellJumps += 1;
      if (this.dellJumps >= FIR_JUMPS_REQUIRED && !this.firUnlocked) {
        this.firUnlocked = true;
        writeStorage(STORAGE_FIR, '1');
        this.runUnlockNames.push('President Fir Tree');
        this.ui.showTimeToast('★ PRESIDENT FIR TREE UNLOCKED!');
      }
    };
    this.player.onJump = this._onPlayerJump;

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
    this.alarmRung = false;
    this.appliancesTouched = new Set();
    this.travelOpen = false;
    this.tubeCaveClaimed = false;
    this.tubeLakeClaimed = false;
    this.dellJumps = 0;
    this._inDell = false;
    // Margaret's tally: cherries (+3), clouds (+5) and frog hits.
    this.cherriesCollected = 0;
    this.cloudsCollected = 0;
    this.frogHits = 0;
    // Julie: the vehicle kinds dismounted from this run.
    this.vehiclesDismounted = new Set();
    this.minigame = null;
    this.puttPlayed = false;
    this._puttPrompted = false;
    this._puttFocus = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), facingYaw: 0 };
    this.collectibles = [];
    this.frogs = [];
    this.clockTower = null;
    this.cart = null;
    this.submarine = null;
    this.hovercraft = null;
    this.balloon = null;
    this.launchpad = null;
    this.rocket = null;
    this.goat = null;
    this.spawnEntities();

    this.ui.setHealth(this.health);
    this.ui.setPointsSilent(0);
    this.ui.setTimer(this.timeLeft);
    this.ui.bindRestart(() => this.restart());
    this.ui.bindTravel(
      (dest) => this.travelTo(dest),
      () => this.closeTravel()
    );
    this.ui.bindAchievements(
      () => this.ui.showAchievements(this.getAchievementsView()),
      () => this.ui.hideAchievements()
    );

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

    // Turnip Scart the goat, grazing his vegetable patch.
    if (this.world.vegPatchPos) {
      this.goat = new Goat(this.scene, this.world, this.world.vegPatchPos);
    }

    // Cottage Lane's own hoard, waiting behind the square-number lock.
    if (this.world.station) {
      for (const p of this.world.station.coneSpots) {
        this.collectibles.push(new PineCone(this.scene, p.clone()));
      }
      for (const p of this.world.station.eggSpots) {
        this.collectibles.push(new GoldenEgg(this.scene, p.clone()));
      }
    }
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
    if (this.goat) {
      this.goat.dispose();
      this.goat = null;
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

      // Margaret keeps count of her cherries (+3) and clouds (+5).
      if (item.value === 3) this.cherriesCollected += 1;
      if (item.value === 5) this.cloudsCollected += 1;

      // Trophies for collecting the sky's bounty.
      if (item.value === STAR_VALUE) this.awardAchievement('star');
      if (item.value === 5) this.awardAchievement('cloud');

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
      this.frogHits += 1; // Margaret counts her bruises
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
    if (!tower) return;
    // Surface business only — walking beneath it at station depth is
    // not a visit.
    if (Math.abs(this.player.position.y - tower.position.y) > 5) return;
    if (!tower.tryEnter(this.player.position)) return;

    this.timeLeft += TOWER_TIME_BONUS;
    this.towerVisits += 1;
    this.ui.setTimer(this.timeLeft);
    if (this.towerVisits >= 3) this.awardAchievement('tower3');
    if (this.towerVisits >= 10) this.awardAchievement('tower10');

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
    if (name === 'marblella') return this.marblellaUnlocked;
    if (name === 'fir') return this.firUnlocked;
    if (name === 'margaret') return this.margaretUnlocked;
    if (name === 'julie') return this.julieUnlocked;
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
      perpbird: this.perpbirdUnlocked,
      marblella: this.marblellaUnlocked,
      fir: this.firUnlocked,
      margaret: this.margaretUnlocked,
      julie: this.julieUnlocked
    };
  }

  /**
   * Julie the doodle: dismount from all three of the rocket, the
   * hovercraft and the balloon within a single run.
   */
  registerDismount(kind) {
    if (!['rocket', 'hovercraft', 'balloon'].includes(kind)) return;
    this.vehiclesDismounted.add(kind);
    if (
      !this.julieUnlocked &&
      this.vehiclesDismounted.has('rocket') &&
      this.vehiclesDismounted.has('hovercraft') &&
      this.vehiclesDismounted.has('balloon')
    ) {
      this.julieUnlocked = true;
      writeStorage(STORAGE_JULIE, '1');
      this.runUnlockNames.push('Julie');
      this.ui.showTimeToast('★ JULIE UNLOCKED! GOOD GIRL!');
    }
  }

  /* ================================================================ */
  /*  Achievements                                                    */
  /* ================================================================ */

  /** How many heroes are unlocked (badger is a given, not a trophy). */
  unlockedCharacterCount() {
    return Object.values(this.getUnlockedMap()).filter(Boolean).length;
  }

  /** Grant a trophy once, persist it, and announce it. */
  awardAchievement(id) {
    if (this.achievements.has(id)) return;
    this.achievements.add(id);
    writeStorage(STORAGE_ACHIEVEMENTS, [...this.achievements].join(','));
    const def = TROPHIES.find((t) => t.id === id);
    if (def) this.ui.showTimeToast(`🏆 ${def.title.toUpperCase()}`);
  }

  /**
   * Continuously-checkable trophies — score milestones, decimal scores,
   * unlock counts and Marblella's lake-bed dive. Cheap; called each
   * active frame and again at the bell.
   */
  checkAchievements() {
    const p = this.points;
    if (p >= 50) this.awardAchievement('score50');
    if (p >= 100) this.awardAchievement('score100');
    if (p >= 200) this.awardAchievement('score200');
    if (p >= 300) this.awardAchievement('score300');
    if (p >= 400) this.awardAchievement('score400');
    if (p >= 500) this.awardAchievement('score500');
    if (!Number.isInteger(p)) this.awardAchievement('decimal');

    const unlocked = this.unlockedCharacterCount();
    if (unlocked >= 1) this.awardAchievement('unlock1');
    if (unlocked >= 5) this.awardAchievement('unlock5');
    if (unlocked >= 10) this.awardAchievement('unlock10');

    // Deep Diver: Marblella at the bottom of the lake.
    if (
      this.characterName === 'marblella' &&
      this.world.isNearLake(this.player.position.x, this.player.position.z) &&
      this.player.position.y < this.world.waterLevel - 3
    ) {
      this.awardAchievement('lakebed');
    }
  }

  /** The data the achievements viewer renders. */
  getAchievementsView() {
    const trophies = TROPHIES.map((t) => ({
      medal: t.medal,
      title: t.title,
      desc: t.desc,
      earned: this.achievements.has(t.id)
    }));
    const characters = CHARACTER_UNLOCKS.map((c) => ({
      name: c.name,
      how: c.how,
      unlocked: this.isCharacterAllowed(c.key)
    }));
    return {
      earnedCount: trophies.filter((t) => t.earned).length,
      total: trophies.length,
      trophies,
      characters
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

    // At the pin, hovercraft-mounted and cart-bruised: putt instead of
    // dismounting.
    if (double && this.canStartPutt()) {
      this.startPutting();
      return;
    }

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
        // Julie: dismount all three flying/skimming machines in one run.
        this.registerDismount(vehicle.kind);
      }
      return;
    }

    // Rocket boarding: triple-tap only.
    if (triple && this.rocket) {
      const dx = this.player.position.x - this.rocket.position.x;
      const dz = this.player.position.z - this.rocket.position.z;
      const dy = this.player.position.y - this.rocket.position.y;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE && Math.abs(dy) < 4) {
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

    // Board whichever double-tap vehicle is in reach. (In reach means in
    // reach vertically too — no boarding through 14m of bedrock.)
    for (const vehicle of [this.hovercraft, this.balloon]) {
      if (!vehicle) continue;
      const dx = this.player.position.x - vehicle.position.x;
      const dz = this.player.position.z - vehicle.position.z;
      if (Math.abs(this.player.position.y - vehicle.position.y) > 3.5) continue;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE) {
        // The balloon has a strict payload limit, and Marblella is a
        // solid glass sphere.
        if (vehicle.kind === 'balloon' && this.characterName === 'marblella') {
          this.ui.showTimeToast('TOO DENSE!');
          return;
        }
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

    // Inside the cottage: appliances answer to a double-tap.
    if (this.handleCottage()) return;

    // Down at Cottage Lane: the ticket machine and the way out.
    if (this.handleStation()) return;

    // At Mystic Forest Central: the platform sign is the ride home.
    const ret = this.world.copseReturnPos;
    if (ret && this.world.isInDell(this.player.position.x, this.player.position.z, this.player.position.y)) {
      const dx = this.player.position.x - ret.x;
      const dz = this.player.position.z - ret.z;
      if (dx * dx + dz * dz < 2.8 * 2.8) {
        const entry = this.world.station.entry;
        this.player.position.set(entry.x, entry.y + 0.2, entry.z);
        this.player.velocity.set(0, 0, 0);
        this.cameraRig.snapTo(this.player.position);
        this.ui.showTimeToast('THE INVISIBLE TRAIN — BACK TO COTTAGE LANE');
        return;
      }
    }

    // A double-tap near the parked rocket: teach the gesture.
    if (this.rocket) {
      const dx = this.player.position.x - this.rocket.position.x;
      const dz = this.player.position.z - this.rocket.position.z;
      const dy = this.player.position.y - this.rocket.position.y;
      if (dx * dx + dz * dz < BOARDING_RANGE * BOARDING_RANGE && Math.abs(dy) < 4) {
        this.ui.showTimeToast('TRIPLE-TAP TO BOARD THE ROCKET');
        return;
      }
    }

    // No vehicle in reach — perhaps the cherry blossom tree's secret?
    const tree = this.world.blossomTree;
    if (tree && this.launchpad && this.launchpad.state === 'hidden') {
      const dx = this.player.position.x - tree.x;
      const dz = this.player.position.z - tree.z;
      const dy = this.player.position.y - tree.y;
      if (dx * dx + dz * dz < 4.5 * 4.5 && Math.abs(dy) < 6) {
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
   * Cottage appliances: the alarm clock pays +20 seconds (once per run),
   * the stove and fridge offer domestic color, and the rug slides aside
   * to reveal a trap door that will not budge. Touch all four in one run
   * and Marblella — a marble of unusual density — rolls onto the roster.
   * Returns true when the tap was spent indoors.
   */
  handleCottage() {
    const spots = this.world.cottage;
    if (!spots) return false;
    const px = this.player.position.x;
    const py = this.player.position.y;
    const pz = this.player.position.z;
    // Nearest appliance wins — the stove and fridge stand close enough
    // together that first-match order would talk over the wrong one.
    let hit = null;
    let bestSq = APPLIANCE_RANGE * APPLIANCE_RANGE;
    for (const key of MARBLELLA_APPLIANCES) {
      const p = spots[key];
      const dx = px - p.x;
      const dz = pz - p.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestSq && Math.abs(py - p.y) < 2.5) {
        hit = key;
        bestSq = dSq;
      }
    }
    if (!hit) return false;

    if (hit === 'clock') {
      if (!this.alarmRung) {
        this.alarmRung = true;
        this.timeLeft += ALARM_TIME_BONUS;
        this.ui.setTimer(this.timeLeft);
        this.ui.showTimeToast(`RUDE AWAKENING! +${ALARM_TIME_BONUS} SECONDS`);
        this.particles.spawnBurst(
          this._playerCenter.set(spots.clock.x, spots.clock.y + 0.4, spots.clock.z),
          0x9ecbff,
          { count: 30, speed: 4.2, size: 44, upBias: 0.8, life: 0.8 }
        );
      } else {
        this.ui.showTimeToast('THE CLOCK HAS RUNG ITSELF HOARSE');
      }
    } else if (hit === 'stove') {
      this.ui.showTimeToast('THE HOB IS BARELY WARM. PORRIDGE, RECENTLY.');
    } else if (hit === 'fridge') {
      this.ui.showTimeToast('NOTHING INSIDE BUT ONE PROUD PICKLE');
    } else if (hit === 'trapdoor') {
      if (!this.world._rugSlid) {
        this.world.slideRug();
        this.ui.showTimeToast('UNDER THE RUG: A TRAP DOOR!');
      } else if (this.world._trapdoorOpen || this.isSquareScore()) {
        // The lock respects square numbers; once open, it stays open.
        this.world.openTrapdoor();
        const entry = this.world.station.entry;
        this.player.position.set(entry.x, entry.y + 0.2, entry.z);
        this.player.velocity.set(0, 0, 0);
        this.cameraRig.snapTo(this.player.position);
        this.awardAchievement('tube');
        this.ui.showTimeToast('DOWN, DOWN… MIND THE GAP!');
      } else {
        this.ui.showTimeToast('LOCKED. IT HUMS: “COME BACK PERFECTLY SQUARE.”');
      }
    }

    this.appliancesTouched.add(hit);
    if (
      !this.marblellaUnlocked &&
      MARBLELLA_APPLIANCES.every((k) => this.appliancesTouched.has(k))
    ) {
      this.marblellaUnlocked = true;
      writeStorage(STORAGE_MARBLELLA, '1');
      this.runUnlockNames.push('Marblella');
      this.ui.showTimeToast('★ MARBLELLA UNLOCKED!');
    }
    return true;
  }

  /** The trap door's lock only respects a perfectly square score. */
  isSquareScore() {
    if (!Number.isInteger(this.points) || this.points <= 0) return false;
    const r = Math.round(Math.sqrt(this.points));
    return r * r === this.points;
  }

  /**
   * Down on the 'Cottage Lane' platform: the ticket machine has an
   * opinion, and the WAY OUT stairs teleport you back up to the rug.
   * Returns true when the tap was spent underground.
   */
  handleStation() {
    const st = this.world.station;
    if (!st) return false;
    const px = this.player.position.x;
    const py = this.player.position.y;
    const pz = this.player.position.z;
    if (py > st.floorY + 6) return false; // not down here

    const near = (p, range) => {
      const dx = px - p.x;
      const dz = pz - p.z;
      return dx * dx + dz * dz < range * range && Math.abs(py - p.y) < 3;
    };

    if (near(st.exit, 2.4)) {
      const home = this.world.cottage.trapdoor;
      this.player.position.set(home.x + 0.9, this.world.cottageLevel + 0.1, home.z + 0.6);
      this.player.velocity.set(0, 0, 0);
      this.cameraRig.snapTo(this.player.position);
      this.ui.showTimeToast('WAY OUT — BACK UP THE STAIRS');
      return true;
    }
    if (near(st.ticket, 3.2)) {
      if (this.isTicketMachineOn()) {
        this.openTravel();
      } else {
        this.ui.showTimeToast('OUT OF ORDER UNTIL THE MORNING RUSH (06:00–09:00). EXACT CHANGE: 281.');
      }
      return true;
    }
    return false;
  }

  /**
   * The ticket machine keeps banker's hours: operational during the
   * morning rush (06:00–09:00 on the PLAYER'S clock), or for anyone
   * presenting exactly 281 points. Exact change only.
   */
  isTicketMachineOn() {
    const hour = new Date().getHours();
    return (hour >= 6 && hour < 9) || this.points === TICKET_EXACT_CHANGE;
  }

  openTravel() {
    this.travelOpen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showTravel();
    this.ui.showTimeToast('THE TICKET MACHINE HUMS INTO LIFE');
  }

  closeTravel() {
    this.travelOpen = false;
    this.ui.hideTravel();
  }

  /** Ride the Mystic Line: teleport, reveal the destination's roundel,
   *  and pay out each destination's fare rebate once per run. */
  travelTo(dest) {
    if (!this.travelOpen || this.isGameOver) return;
    this.closeTravel();
    const w = this.world;

    // Departure puff on the platform.
    this.particles.spawnBurst(
      this._playerCenter.copy(this.player.position).setY(this.player.position.y + 1),
      0x9ec2ff,
      { count: 30, speed: 4.5, size: 44, upBias: 0.7, life: 0.7 }
    );

    let target;
    if (dest === 'cave') {
      target = new THREE.Vector3(
        w.caveX - w.caveDirX * 5,
        0,
        w.caveZ - w.caveDirZ * 5
      );
      w.revealTubeSign('cave');
      if (!this.tubeCaveClaimed) {
        this.tubeCaveClaimed = true;
        this.points += TUBE_CAVE_POINTS;
        this.ui.setPoints(this.points);
        this.ui.showTimeToast('UPPER COTTAGE LANE! +55.5');
      } else {
        this.ui.showTimeToast('UPPER COTTAGE LANE');
      }
    } else if (dest === 'lake') {
      const len = Math.hypot(w.lakeCenterX, w.lakeCenterZ) || 1;
      const dirX = -w.lakeCenterX / len;
      const dirZ = -w.lakeCenterZ / len;
      target = new THREE.Vector3(
        w.lakeCenterX + dirX * (w.lakeRadius + 3.5),
        0,
        w.lakeCenterZ + dirZ * (w.lakeRadius + 3.5)
      );
      w.revealTubeSign('lake');
      if (!this.tubeLakeClaimed) {
        this.tubeLakeClaimed = true;
        this.points += RED_OCTOBER_POINTS;
        this.ui.setPoints(this.points);
        this.ui.showTimeToast('DOCKLANDS! +63.14159');
      } else {
        this.ui.showTimeToast('DOCKLANDS');
      }
    } else {
      target = new THREE.Vector3(w.copsePos.x + 1.4, 0, w.copsePos.z + 0.8);
      this.ui.showTimeToast('MYSTIC FOREST CENTRAL — END OF THE LINE');
    }

    target.y = w.getHeight(target.x, target.z) + 0.15;
    this.player.position.copy(target);
    this.player.velocity.set(0, 0, 0);
    this.cameraRig.snapTo(this.player.position);
    this.particles.spawnBurst(
      this._playerCenter.set(target.x, target.y + 1, target.z),
      0x9ec2ff,
      { count: 36, speed: 5, size: 46, upBias: 0.75, life: 0.8 }
    );
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

  /**
   * 'Puttmost Respect' eligibility: any hero except Magnus (he plays
   * off scratch and knows it), at least one cart hit this run, arriving
   * at the pin aboard the hovercraft. Once per run.
   */
  canStartPutt() {
    if (this.puttPlayed || this.minigame || this.characterName === 'magnus') return false;
    if (this.cartHits < 1) return false;
    if (this.player.vehicle !== this.hovercraft) return false;
    const dx = this.player.position.x - this.world.greenCenterX;
    const dz = this.player.position.z - this.world.greenCenterZ;
    return dx * dx + dz * dz < (this.world.greenRadius + 2) ** 2;
  }

  startPutting() {
    // Hop off the hovercraft; it waits by the green.
    this.player.vehicle = null;
    this.hovercraft.rider = null;
    this.hovercraft.parkAt(this.player.position);
    this.puttPlayed = true;
    this.ui.showTimeToast('PUTTMOST RESPECT!');
    this.minigame = new PuttingGame(this.scene, this.world, this.ui, (success, strokes) =>
      this.endPutting(success, strokes)
    );
  }

  endPutting(success, strokes) {
    if (!this.minigame) return;
    this.minigame.dispose();
    this.minigame = null;
    if (success) {
      const holeInOne = strokes === 1;
      if (holeInOne) this.awardAchievement('holeinone');
      const reward = holeInOne ? 33 : 18;
      this.points += reward;
      this.ui.setPoints(this.points);
      this.ui.showTimeToast(holeInOne ? 'HOLE IN ONE! +33' : `SUNK IT! +${reward}`);
      this.particles.spawnBurst(
        this._playerCenter.set(this.world.greenCenterX, this.world.greenLevel + 1, this.world.greenCenterZ),
        0x7be06b,
        { count: 40, speed: 5, size: 48, upBias: 0.8, life: 0.9 }
      );
    } else {
      this.ui.showTimeToast('PAR IS A STATE OF MIND');
    }
  }

  /**
   * Reaching the surfaced Red October pays out π-adjacent riches.
   * Marblella doesn't wait for the breach: she sinks to the lake bed and
   * claims the boat wherever it lurks — surfaced or not.
   */
  handleRedOctober() {
    if (this.redOctoberClaimed || !this.submarine) return;
    const sub = this.submarine.position;
    const diveClaim = this.characterName === 'marblella';
    if (!this.submarine.isSurfaced() && !diveClaim) return;
    const dx = this.player.position.x - sub.x;
    const dz = this.player.position.z - sub.z;
    const dy = this.player.position.y - sub.y;
    if (dx * dx + dz * dz > 5 * 5 || Math.abs(dy) > 5) return;

    this.redOctoberClaimed = true;
    this.points += RED_OCTOBER_POINTS;
    this.ui.setPoints(this.points);
    this.ui.showTimeToast('RED OCTOBER! +63.14159');
    this.particles.spawnBurst(
      this._playerCenter.set(sub.x, sub.y + 1.5, sub.z),
      0xff6a5a,
      { count: 46, speed: 5.5, size: 50, upBias: 0.75, life: 1.0 }
    );
  }

  gameOver(reason) {
    this.isGameOver = true;
    this.closeTravel();
    if (document.pointerLockElement) document.exitPointerLock();

    if (reason === 'health') this.awardAchievement('rip');

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
    // Margaret: 5 cherries, 4 clouds, 5 frog hits, and a final score
    // whose last digit is a 4 (14, 84, 134…). The puppet demands the
    // full performance.
    if (
      !this.margaretUnlocked &&
      this.cherriesCollected >= MARGARET_CHERRIES &&
      this.cloudsCollected >= MARGARET_CLOUDS &&
      this.frogHits >= MARGARET_FROG_HITS &&
      Number.isInteger(this.points) &&
      Math.abs(this.points % 10) === 4
    ) {
      this.margaretUnlocked = true;
      writeStorage(STORAGE_MARGARET, '1');
      newlyUnlockedNames.push('Margaret');
    }

    // Final-score trophies + any unlock-count milestones from this run's
    // end-of-bell unlocks (score/decimal/50…500, unlock 1/5/10).
    this.checkAchievements();

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
    this.alarmRung = false;
    this.appliancesTouched.clear();
    this.closeTravel();
    this.tubeCaveClaimed = false;
    this.tubeLakeClaimed = false;
    this.dellJumps = 0;
    this._inDell = false;
    this.cherriesCollected = 0;
    this.cloudsCollected = 0;
    this.frogHits = 0;
    this.vehiclesDismounted.clear();
    this.renderer.domElement.classList.remove('mystic');
    this.world.resetRug();
    this.world.resetTrapdoor();
    this.world.resetTubeSigns();
    if (this.minigame) {
      this.minigame.dispose();
      this.minigame = null;
    }
    this.puttPlayed = false;
    this._puttPrompted = false;
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
    this.player.onSplash = this._onPlayerSplash;
    this.player.onJump = this._onPlayerJump;
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
    } else if (this.minigame) {
      // 'Puttmost Respect': the run clock is FROZEN; input belongs to
      // the putter and the camera belongs to the ball. Taps are discarded
      // (click-dragging to aim must never read as a gesture) — conceding
      // is the Escape key's job.
      this.input.consumeDoubleTap();
      this.input.consumeTripleTap();
      // Aim by swinging the camera: A/D (or the joystick) orbits the
      // ball, and mouse/touch drag still works through the rig itself.
      this.cameraRig.yaw -= this.input.axisX * 1.8 * dt;
      if (this.input.keys.has('Escape')) {
        this.minigame.abandon();
      } else {
        this.minigame.update(dt, this.input, this.cameraRig.yaw);
      }
      if (this.minigame) {
        this._puttFocus.position.copy(this.minigame.focusPoint);
        this.cameraRig.update(dt, this._puttFocus, this.input);
      } else {
        this.cameraRig.update(dt, this.player, this.input);
      }
      this.player.animate(dt, false);
    } else if (!this.isGameOver) {
      // The countdown IS the game: run dry and the twilight takes you.
      this.timeLeft -= dt;
      this.ui.setTimer(this.timeLeft);
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.gameOver('time');
      }

      this.invulnTimer = Math.max(0, this.invulnTimer - dt);

      // The travel picker: number keys choose, wandering off dismisses.
      if (this.travelOpen) {
        if (this.input.keys.has('Digit1')) this.travelTo('cave');
        else if (this.input.keys.has('Digit2')) this.travelTo('lake');
        else if (this.input.keys.has('Digit3')) this.travelTo('copse');
        else {
          const t = this.world.station.ticket;
          const dx = this.player.position.x - t.x;
          const dz = this.player.position.z - t.z;
          if (dx * dx + dz * dz > 6 * 6) this.closeTravel();
        }
      }

      this.handleDoubleTap();
      this.player.update(dt, this.input, this.cameraRig.yaw);
      this.handlePickups();
      this.handleHazards();
      this.handleClockTower();
      this.handleRedOctober();
      this.maybeSpawnBalloon();
      this.manageRocket();
      this.checkAchievements();

      // Whisper about the putting challenge when its stars align. The
      // prompt re-arms only once the player has genuinely left the green
      // — a hovercraft drifting across the eligibility ring must not
      // machine-gun the toast.
      if (this.canStartPutt()) {
        if (!this._puttPrompted) {
          this.ui.showTimeToast('PUTTMOST RESPECT! DOUBLE-TAP TO PLAY');
          this._puttPrompted = true;
        }
      } else if (this._puttPrompted) {
        const dx = this.player.position.x - this.world.greenCenterX;
        const dz = this.player.position.z - this.world.greenCenterZ;
        if (dx * dx + dz * dz > (this.world.greenRadius + 9) ** 2) {
          this._puttPrompted = false;
        }
      }

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

    // The Mystic Forest drains the world of color — a CSS filter on the
    // canvas desaturates everything, hero included, while you're inside.
    const inDell = this.world.isInDell(
      this.player.position.x,
      this.player.position.z,
      this.player.position.y
    );
    if (inDell !== this._inDell) {
      this._inDell = inDell;
      this.renderer.domElement.classList.toggle('mystic', inDell);
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
    if (this.goat) this.goat.update(dt, time);
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
