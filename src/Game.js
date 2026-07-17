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
  PickleStick,
  PlatinumGuava,
  disposeEntityAssets
} from './Entities.js';
import { PuttingGame } from './PuttingGame.js';
import { VeggieTacToe } from './VeggieTacToe.js';
import { SoundFX } from './Audio.js';
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
const STORAGE_TURNIP = 'mystic-badger.turnipUnlocked';
const STORAGE_SWEATSHIRT = 'mystic-badger.sweatshirtUnlocked';
const STORAGE_JAM = 'mystic-badger.jamUnlocked';
const STORAGE_DODECA = 'mystic-badger.dodecaUnlocked';
const STORAGE_POLARPEAR = 'mystic-badger.polarpearUnlocked';
const STORAGE_NIGHTEYE = 'mystic-badger.nightEyeUnlocked';
const STORAGE_PINEPENGUIN = 'mystic-badger.pinepenguinUnlocked';
const STORAGE_BILLY = 'mystic-badger.billyUnlocked';
const STORAGE_PICKLE = 'mystic-badger.pickleStickUnlocked';
const STORAGE_FRIDGE_CLICKS = 'mystic-badger.fridgeClicks';
const STORAGE_GLASSBADGER = 'mystic-badger.glassBadgerUnlocked';
const STORAGE_MCDONOVAN = 'mystic-badger.mcdonovanUnlocked';
const STORAGE_PRUNELLA = 'mystic-badger.prunellaUnlocked';
const STORAGE_GARY = 'mystic-badger.garyUnlocked';
const STORAGE_SUMMIT_VISITS = 'mystic-badger.summitVisits';
const STORAGE_CANDY = 'mystic-badger.candyUnlocked';
const STORAGE_HELTER_VISITS = 'mystic-badger.helterVisits';
const STORAGE_TOTAL_SCORE = 'mystic-badger.totalScore';
const STORAGE_CHAR_USAGE = 'mystic-badger.charUsage';
const STORAGE_SCORED100 = 'mystic-badger.scored100';
const STORAGE_SCORED200 = 'mystic-badger.scored200';
const STORAGE_SCORED300 = 'mystic-badger.scored300';
const STORAGE_MUTED = 'mystic-badger.muted';
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
const JAM_TOTAL_SCORE = 1000;      // all-time cumulative points to unlock Jam
const NIGHTEYE_TOTAL_SCORE = 10000; // all-time cumulative points to unlock Night Eye
const GLASSBADGER_TOTAL_SCORE = 20000; // all-time cumulative points to unlock Glass Badger
const DODECA_SCORE = 300;          // score this as Rhombus to unlock Dodecahedron
const POLARPEAR_HEALTH = 10;       // reach the summit at or below this to arm Polar Pear
const GARY_SUMMIT_VISITS = 100;    // all-time summit arrivals to unlock Gary Mountain
const CANDY_HELTER_VISITS = 100;   // all-time helter-skelter visits to unlock Candy Florence
const CANDY_LAUNCH_SPEED = 30;     // Candy Florence's sky-high fling off the helter skelter
// Score milestones: a run (or the all-time high score) at or above each
// threshold earns the matching trophy. Kept in one place so past runs can
// retroactively credit any milestone added here later.
const SCORE_MILESTONES = [
  [50, 'score50'], [100, 'score100'], [200, 'score200'], [300, 'score300'],
  [400, 'score400'], [500, 'score500'], [600, 'score600']
];
const SANDWICH_POINTS = 55.5;
const PICKLE_VALUE = 8.8;          // Pickle Stick collectible value
const GUAVA_VALUE = 50;            // Platinum Guava value
const FRIDGE_CLICKS_REQUIRED = 10; // clicks before the pickle appears
const PICKLE_UNLOCK_SCORE = 100;   // score needed when grabbing the pickle
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

    // --- procedural sound (Web Audio, no asset files) ------------------------
    this.audio = new SoundFX();
    this.audio.muted = readStorage(STORAGE_MUTED) === '1';
    this.audio.armOnGesture(); // unlock on the first click / key / touch
    this._vehicleSound = null;   // last vehicle kind announced to the audio bed
    this._announcedUnlocks = 0;  // runUnlockNames length already slide-whistled
    this._moveKind = null;       // 'roll' | 'hover' | 'foot' movement-sound mode
    this._lastStep = 0;          // walk-cycle half-phase index, for footstep timing
    this.ui.bindMute(this.audio.muted, () => {
      const muted = this.audio.toggleMuted();
      writeStorage(STORAGE_MUTED, muted ? '1' : '0');
      return muted;
    });
    // Flipping between character choices makes a soft pip — and, since it's
    // a user gesture, also unlocks/starts the ambient music over the menu.
    this.ui.bindCharacterToggle(() => {
      this.audio.resume();
      this.audio.play('select');
    });

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
    this.turnipUnlocked = readStorage(STORAGE_TURNIP) === '1';
    this.sweatshirtUnlocked = readStorage(STORAGE_SWEATSHIRT) === '1';
    this.jamUnlocked = readStorage(STORAGE_JAM) === '1';
    this.dodecaUnlocked = readStorage(STORAGE_DODECA) === '1';
    this.polarpearUnlocked = readStorage(STORAGE_POLARPEAR) === '1';
    this.nightEyeUnlocked = readStorage(STORAGE_NIGHTEYE) === '1';
    this.pinepenguinUnlocked = readStorage(STORAGE_PINEPENGUIN) === '1';
    this.billyUnlocked = readStorage(STORAGE_BILLY) === '1';
    this.pickleStickUnlocked = readStorage(STORAGE_PICKLE) === '1';
    this.fridgeClicks = parseInt(readStorage(STORAGE_FRIDGE_CLICKS, '0'), 10) || 0;
    this.glassBadgerUnlocked = readStorage(STORAGE_GLASSBADGER) === '1';
    this.mcdonovanUnlocked = readStorage(STORAGE_MCDONOVAN) === '1';
    this.prunellaUnlocked = readStorage(STORAGE_PRUNELLA) === '1';
    this.garyUnlocked = readStorage(STORAGE_GARY) === '1';
    this.candyUnlocked = readStorage(STORAGE_CANDY) === '1';
    // All-time count of mountain-summit arrivals (across every run).
    this.summitVisits = parseInt(readStorage(STORAGE_SUMMIT_VISITS, '0'), 10) || 0;
    // All-time count of helter-skelter visits (across every run).
    this.helterVisits = parseInt(readStorage(STORAGE_HELTER_VISITS, '0'), 10) || 0;
    this.totalScore = parseFloat(readStorage(STORAGE_TOTAL_SCORE, '0')) || 0;
    // Per-character run tally, for the "favourite hero" stat.
    this.charUsage = {};
    try { this.charUsage = JSON.parse(readStorage(STORAGE_CHAR_USAGE, '{}')) || {}; } catch (e) { this.charUsage = {}; }
    // Which characters have scored 100 / 200 / 300, for the C-series trophies.
    const loadSet = (key) => new Set((readStorage(key, '') || '').split(',').filter(Boolean));
    this.scored100 = loadSet(STORAGE_SCORED100);
    this.scored200 = loadSet(STORAGE_SCORED200);
    this.scored300 = loadSet(STORAGE_SCORED300);
    this.achievements = new Set(
      (readStorage(STORAGE_ACHIEVEMENTS, '') || '').split(',').filter(Boolean)
    );
    // Retroactively credit every score milestone the stored high score
    // already clears — so newly added score trophies count past runs too.
    this.creditHighScoreMilestones();
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
      this.audio.play('jump'); // every jump gets a springy bounce
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
    this.stationsVisited = new Set(); // Mystic Line stops used this run
    this.sandwichClaimed = false;
    this.reachedSummitLowHP = false; // Polar Pear: summited on 10 HP this run
    this._onSummit = false;          // edge flag for counting summit arrivals
    this._onHelter = false;          // edge flag for counting helter-skelter visits
    this._pickleSummonedThisRun = false;   // fridge-summoned pickle placed?
    this._guavaDropAt = Math.random() * 30; // seconds-remaining the guava falls
    this._guavaDropped = false;
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
    this.eggsCollected = 0;
    this.frogHits = 0;
    this.picklesCollected = 0;      // Pickle Sticks grabbed this run ("In a Pickle")
    this.magnaCartasCollected = 0;  // Magna Cartas grabbed this run ("Hastings")
    // Spawned counts this run, for the "clear them all" trophies.
    this.spawnedStars = 0;
    this.spawnedClouds = 0;
    this.spawnedCherries = 0;
    this.spawnedEggs = 0;
    // Yo-Yo: how many times the score has crossed 100, and which side.
    this._yoyoCrossings = 0;
    this._over100 = false;
    // Julie: the vehicle kinds dismounted from this run.
    this.vehiclesDismounted = new Set();
    this.minigame = null;
    this.veggieGame = null;
    this.veggiePlayed = false;
    this._veggiePrompted = false;
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
    // On-screen concede for Veggie Tac Toe (mobile has no Escape key).
    this.ui.bindVeggieQuit(() => { if (this.veggieGame) this.veggieGame.abandon(); });

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
    this.spawnedEggs = GOLDEN_EGG_COUNT;
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
    this.spawnedClouds = MARSHMALLOW_COUNT;

    // Atomic glacé cherries crown a handful of random trees.
    const tops = [...this.world.treeTops];
    let cherries = 0;
    for (let i = 0; i < CHERRY_COUNT && tops.length > 0; i++) {
      const pick = Math.floor(Math.random() * tops.length);
      const top = tops.splice(pick, 1)[0];
      this.collectibles.push(new AtomicCherry(this.scene, top.clone()));
      cherries++;
    }
    this.spawnedCherries = cherries;

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
    this.spawnedStars = STAR_COUNT;
    this.launchpad = new Launchpad(this.scene, this.world);

    // Once Pickle Stick is a playable hero, its item can turn up in the
    // wild too — worth +8.8, though there's little point now.
    if (this.pickleStickUnlocked) {
      for (let i = 0; i < 3; i++) {
        this.collectibles.push(new PickleStick(this.scene, this.world.randomGroundPoint(10, 90)));
      }
    }

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
      // Sparkle up — a grander shimmer for the big golden pickups.
      this.audio.play('collect', item.value >= 10 ? 1 : 0);
      const scoreBefore = this.points;
      this.points += item.value;
      this.ui.setPoints(this.points);

      // Pickle Stick: grab the fridge-summoned pickle on 100+ to unlock it.
      if (item.value === PICKLE_VALUE) {
        this.picklesCollected += 1;
        if (!this.pickleStickUnlocked) {
          if (scoreBefore >= PICKLE_UNLOCK_SCORE) {
            this.pickleStickUnlocked = true;
            writeStorage(STORAGE_PICKLE, '1');
            this.runUnlockNames.push('Pickle Stick');
            this.ui.showTimeToast('★ PICKLE STICK UNLOCKED! BOING!');
          } else {
            this.ui.showTimeToast('OH, PICKLE STICKS! (COME BACK AT 100+)');
          }
        } else {
          this.ui.showTimeToast('OH, PICKLE STICKS! +8.8');
        }
      }

      // Platinum Guava: a rare, hefty windfall — and its own trophy.
      if (item.value === GUAVA_VALUE) {
        this.ui.showTimeToast('💎 PLATINUM GUAVA! +50');
        this.audio.play('trophy');
        this.awardAchievement('guava');
      }

      // The Magna Carta announces itself — and crowns a king, once.
      if (item.value === MAGNA_CARTA_VALUE) {
        this.magnaCartasCollected += 1;
        this.ui.showTimeToast('YOU GOT THE MAGNA CARTA, BABY!');
        this.audio.play('bugle');
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

      // Margaret keeps count of her cherries (+3) and clouds (+5); eggs
      // (the golden pine cone, +10) get their own tally too.
      if (item.value === 3) this.cherriesCollected += 1;
      if (item.value === 5) this.cloudsCollected += 1;
      if (item.value === 10) this.eggsCollected += 1;

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

  /** Once the fridge has been poked ten times, perch a Pickle Stick atop a
   *  random tree — one per run, until Pickle Stick is unlocked. */
  managePickle() {
    if (this.pickleStickUnlocked || this._pickleSummonedThisRun) return;
    if (this.fridgeClicks < FRIDGE_CLICKS_REQUIRED) return;
    const tops = this.world.treeTops;
    if (!tops || tops.length === 0) return;
    const top = tops[Math.floor(Math.random() * tops.length)].clone();
    top.y += 0.5;
    this.collectibles.push(new PickleStick(this.scene, top));
    this._pickleSummonedThisRun = true;
    this.ui.showTimeToast('OH, PICKLE STICKS! — ONE IS UP A TREE');
  }

  /** The Platinum Guava: falls from the sky onto a random patch of grass,
   *  once per run, at a random moment inside the final 30 seconds. */
  dropGuava() {
    const spot = this.world.randomGroundPoint(12, 96, 0.82);
    this.collectibles.push(new PlatinumGuava(this.scene, spot));
    this._guavaDropped = true;
    this.audio.play('collect', 1);
    this.ui.showTimeToast('💎 A PLATINUM GUAVA FELL FROM THE SKY!');
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
      this.audio.play('ribbit');
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
      this.audio.play('carthorn'); // beep beep!
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
    this.audio.play('ticks'); // clock ticks as time is banked
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
    if (name === 'turnip') return this.turnipUnlocked;
    if (name === 'sweatshirt') return this.sweatshirtUnlocked;
    if (name === 'jam') return this.jamUnlocked;
    if (name === 'dodeca') return this.dodecaUnlocked;
    if (name === 'polarpear') return this.polarpearUnlocked;
    if (name === 'nighteye') return this.nightEyeUnlocked;
    if (name === 'pinepenguin') return this.pinepenguinUnlocked;
    if (name === 'billy') return this.billyUnlocked;
    if (name === 'pickle') return this.pickleStickUnlocked;
    if (name === 'glassbadger') return this.glassBadgerUnlocked;
    if (name === 'mcdonovan') return this.mcdonovanUnlocked;
    if (name === 'prunella') return this.prunellaUnlocked;
    if (name === 'gary') return this.garyUnlocked;
    if (name === 'candy') return this.candyUnlocked;
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
      julie: this.julieUnlocked,
      turnip: this.turnipUnlocked,
      sweatshirt: this.sweatshirtUnlocked,
      jam: this.jamUnlocked,
      dodeca: this.dodecaUnlocked,
      polarpear: this.polarpearUnlocked,
      nighteye: this.nightEyeUnlocked,
      pinepenguin: this.pinepenguinUnlocked,
      billy: this.billyUnlocked,
      pickle: this.pickleStickUnlocked,
      glassbadger: this.glassBadgerUnlocked,
      mcdonovan: this.mcdonovanUnlocked,
      prunella: this.prunellaUnlocked,
      gary: this.garyUnlocked,
      candy: this.candyUnlocked
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
  /**
   * Silently mark every score milestone the all-time high score already
   * clears. Runs at load so retroactive credit doesn't spam toasts, and so
   * milestones added in a later update still count the player's past best.
   */
  creditHighScoreMilestones() {
    let changed = false;
    for (const [need, id] of SCORE_MILESTONES) {
      if (this.highScore >= need && !this.achievements.has(id)) {
        this.achievements.add(id);
        changed = true;
      }
    }
    if (changed) writeStorage(STORAGE_ACHIEVEMENTS, [...this.achievements].join(','));
  }

  awardAchievement(id) {
    if (this.achievements.has(id)) return;
    this.achievements.add(id);
    writeStorage(STORAGE_ACHIEVEMENTS, [...this.achievements].join(','));
    const def = TROPHIES.find((t) => t.id === id);
    if (def) this.ui.showTimeToast(`🏆 ${def.title.toUpperCase()}`);
    this.audio.play('trophy');
  }

  /**
   * Continuously-checkable trophies — score milestones, decimal scores,
   * unlock counts and Marblella's lake-bed dive. Cheap; called each
   * active frame and again at the bell.
   */
  checkAchievements() {
    const p = this.points;
    for (const [need, id] of SCORE_MILESTONES) {
      if (p >= need) this.awardAchievement(id);
    }
    if (!Number.isInteger(p)) this.awardAchievement('decimal');

    // C-series: score 100 / 200 / 300 with 10 / 20 / 30 different characters
    // (tracked across all runs). Marks the current hero as it crosses a bar.
    if (p >= 100) this._markCharScore(this.scored100, STORAGE_SCORED100, 'c100', 10);
    if (p >= 200) this._markCharScore(this.scored200, STORAGE_SCORED200, 'c200', 20);
    if (p >= 300) this._markCharScore(this.scored300, STORAGE_SCORED300, 'c300', 30);

    // Snooker: land on exactly 147 having collected one of every item type.
    if (p === 147 && ERROR42_SET.every((v) => this.itemTypesCollected.has(v))) {
      this.awardAchievement('snooker');
    }

    const unlocked = this.unlockedCharacterCount();
    if (unlocked >= 1) this.awardAchievement('unlock1');
    if (unlocked >= 5) this.awardAchievement('unlock5');
    if (unlocked >= 10) this.awardAchievement('unlock10');

    // Play-count trophies: distinct heroes ever taken into a run.
    const played = Object.keys(this.charUsage).length;
    if (played >= 5) this.awardAchievement('play5');
    if (played >= 10) this.awardAchievement('play10');
    if (played >= 20) this.awardAchievement('play20');

    // President Fir Tree, home in the Mystic Forest.
    if (
      this.characterName === 'fir' &&
      this.world.isInDell(this.player.position.x, this.player.position.z, this.player.position.y)
    ) {
      this.awardAchievement('firforest');
    }

    // Haunted Sweatshirt: a spectral reward for amassing 30 achievements
    // in total — earned trophies plus every hero unlocked so far.
    if (!this.sweatshirtUnlocked && this.achievements.size + unlocked >= 30) {
      this.sweatshirtUnlocked = true;
      writeStorage(STORAGE_SWEATSHIRT, '1');
      this.runUnlockNames.push('Haunted Sweatshirt');
      this.ui.showTimeToast('★ HAUNTED SWEATSHIRT UNLOCKED!');
    }

    // Deep Diver: Marblella at the bottom of the lake.
    if (
      this.characterName === 'marblella' &&
      this.world.isNearLake(this.player.position.x, this.player.position.z) &&
      this.player.position.y < this.world.waterLevel - 3
    ) {
      this.awardAchievement('lakebed');
    }

    // Clear-them-all sweeps (only meaningful once any of that species
    // has actually spawned this run).
    const allStars = this.spawnedStars > 0 && this.starsCollected >= this.spawnedStars;
    const allClouds = this.spawnedClouds > 0 && this.cloudsCollected >= this.spawnedClouds;
    const allCherries = this.spawnedCherries > 0 && this.cherriesCollected >= this.spawnedCherries;
    const allEggs = this.spawnedEggs > 0 && this.eggsCollected >= this.spawnedEggs;
    if (allStars) this.awardAchievement('allstars');
    if (allClouds) this.awardAchievement('allclouds');
    if (allCherries) this.awardAchievement('allcherries');
    if (allEggs) this.awardAchievement('alleggs');
    if (allStars && allClouds && allCherries) this.awardAchievement('allsky');

    // Billy Rocketfingers: clear every star AND ride to all three stations
    // in the same run.
    if (!this.billyUnlocked && allStars && this.stationsVisited.size >= 3) {
      this.billyUnlocked = true;
      writeStorage(STORAGE_BILLY, '1');
      this.runUnlockNames.push('Billy Rocketfingers');
      this.ui.showTimeToast('★ BILLY ROCKETFINGERS UNLOCKED! 🎸');
    }

    // In a Pickle: as Pickle Stick, grab three pickles and score 303+.
    if (this.characterName === 'pickle' && this.picklesCollected >= 3 && p >= 303) {
      this.awardAchievement('inapickle');
    }

    // Bird of a Feather: as Perpendicular Bird, sweep the cherries past 250.
    if (this.characterName === 'perpbird' && allCherries && p > 250) {
      this.awardAchievement('birdfeather');
    }

    // Wood I Lie To You: bring Margaret or President Fir Tree to WOODOO's
    // timber yard on 50 health or less.
    if (
      (this.characterName === 'margaret' || this.characterName === 'fir') &&
      this.health <= 50 &&
      Math.hypot(
        this.player.position.x - this.world.woodoosX,
        this.player.position.z - this.world.woodoosZ
      ) <= this.world.woodoosRadius + 3
    ) {
      this.awardAchievement('woodlie');
    }

    // Hastings Is A Place On Earth: William, both Magna Cartas, exactly 106.6.
    if (
      this.characterName === 'william' &&
      this.magnaCartasCollected >= 2 &&
      Math.abs(p - 106.6) < 1e-6
    ) {
      this.awardAchievement('hastings');
    }

    // I've Got Blisters On My Fingers: reach the helter skelter on 300+.
    if (
      p >= 300 &&
      Math.hypot(
        this.player.position.x - this.world.helterX,
        this.player.position.z - this.world.helterZ
      ) <= this.world.helterRadius + 4
    ) {
      this.awardAchievement('blisters');
    }

    // Yo-Yo: the score bouncing across 100 — up, down, up, down, up.
    const over = p > 100;
    if (over !== this._over100) {
      this._over100 = over;
      this._yoyoCrossings += 1;
      if (this._yoyoCrossings >= 5) this.awardAchievement('yoyo');
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
      totalScore: this.totalScore,
      favourite: this.favouriteCharacter(),
      trophies,
      characters
    };
  }

  /** Human-readable name for a character key (badger + every unlockable). */
  characterDisplayName(key) {
    if (key === 'badger') return 'Badger';
    const c = CHARACTER_UNLOCKS.find((u) => u.key === key);
    return c ? c.name : key;
  }

  /** The most-played hero: { name, plays } — or null if nothing logged yet. */
  favouriteCharacter() {
    let bestKey = null;
    let bestN = 0;
    for (const [k, n] of Object.entries(this.charUsage)) {
      if (n > bestN) { bestN = n; bestKey = k; }
    }
    return bestKey ? { name: this.characterDisplayName(bestKey), plays: bestN } : null;
  }

  /** Tally one run against the character currently in play. */
  recordCharacterUse() {
    const k = this.characterName;
    this.charUsage[k] = (this.charUsage[k] || 0) + 1;
    writeStorage(STORAGE_CHAR_USAGE, JSON.stringify(this.charUsage));
  }

  /**
   * Note that the current hero has crossed a score bar, persist it, and
   * award the trophy once `need` distinct characters have cleared that bar.
   */
  _markCharScore(set, storageKey, achId, need) {
    if (this.achievements.has(achId)) return;
    if (!set.has(this.characterName)) {
      set.add(this.characterName);
      writeStorage(storageKey, [...set].join(','));
    }
    if (set.size >= need) this.awardAchievement(achId);
  }

  /** Leave the welcome menu and start the clock. */
  beginRun() {
    if (!this.inMenu) return;
    this.audio.resume(); // the "Enter the Forest" click unlocks audio
    const chosen = this.ui.getSelectedCharacter() || this.characterName;
    if (chosen !== this.characterName && this.isCharacterAllowed(chosen)) {
      this.setCharacter(chosen);
    }
    this.recordCharacterUse(); // tally this run against the chosen hero
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
    if (!triple && !double) return;

    // On the vegetable patch, on a multiple of 7: challenge Turnip Scart.
    if (double && this.canStartVeggie()) {
      this.startVeggie();
      return;
    }

    if (!this.hovercraft) return;

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
        const isMayo = this.characterName === 'mayo';
        const isJam = this.characterName === 'jam';
        if (isMayo || isJam) {
          if (!this.sandwichClaimed) {
            this.sandwichClaimed = true;
            this.points += SANDWICH_POINTS;
            this.ui.setPoints(this.points);
            this.audio.play('squelch'); // spread onto the sandwich
            this.particles.spawnBurst(
              this._playerCenter.set(sandwich.x, sandwich.y + 0.6, sandwich.z),
              isJam ? 0x9b2d5e : 0xf2eed8,
              { count: 36, speed: 4.2, size: 46, upBias: 0.7, life: 0.9 }
            );
            // Mayo's dressing summons the Perpendicular Bird; Jam just… works.
            if (isMayo && !this.perpbirdUnlocked) {
              this.perpbirdUnlocked = true;
              writeStorage(STORAGE_PERPBIRD, '1');
              this.runUnlockNames.push('Perpendicular Bird');
              this.ui.showTimeToast('★ PERPENDICULAR BIRD UNLOCKED! +55.5');
            } else if (isJam) {
              this.ui.showTimeToast("IT'S FUNKY, BUT IT WORKS! +55.5");
            } else {
              this.ui.showTimeToast('MUCH BETTER! +55.5');
            }
          } else {
            this.ui.showTimeToast('ALREADY PERFECTLY DRESSED');
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
        this.audio.play('ticks'); // clock ticks as time is banked
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
      // Ten pokes at the fridge and the message turns — a Pickle Stick is
      // then summoned to the top of a random tree (see managePickle()).
      if (!this.pickleStickUnlocked) {
        this.fridgeClicks += 1;
        writeStorage(STORAGE_FRIDGE_CLICKS, String(this.fridgeClicks));
      }
      if (this.pickleStickUnlocked || this.fridgeClicks >= FRIDGE_CLICKS_REQUIRED) {
        this.ui.showTimeToast('OH, PICKLE STICKS!');
      } else {
        this.ui.showTimeToast(`NOTHING INSIDE BUT ONE PROUD PICKLE (${this.fridgeClicks}/${FRIDGE_CLICKS_REQUIRED})`);
      }
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
    this.awardAchievement('train'); // rode the Mystic Line
    this.stationsVisited.add(dest);
    if (this.stationsVisited.size >= 3) this.awardAchievement('allstations');
    this.audio.play('train');
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
      // The rain-slicked Docklands: exactly a private eye's kind of town.
      if (!this.mcdonovanUnlocked) {
        this.mcdonovanUnlocked = true;
        writeStorage(STORAGE_MCDONOVAN, '1');
        this.runUnlockNames.push('McDonovan');
        this.ui.showTimeToast('★ McDONOVAN UNLOCKED — “THE CASE IS AFOOT.”');
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
   * 'Veggie Tac Toe' eligibility: standing on the vegetable patch with a
   * whole-number score that's a positive multiple of 7, and no other
   * minigame already running.
   */
  canStartVeggie() {
    if (this.minigame || this.veggieGame || this.veggiePlayed || !this.world.vegPatchPos) return false;
    if (!Number.isInteger(this.points) || this.points <= 0 || this.points % 7 !== 0) return false;
    const dx = this.player.position.x - this.world.vegPatchX;
    const dz = this.player.position.z - this.world.vegPatchZ;
    return dx * dx + dz * dz < (this.world.vegPatchRadius + 1.5) ** 2;
  }

  startVeggie() {
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.suppressPointerLock = true; // keep the cursor visible for clicks
    this.player.root.visible = false; // clear the board for the bird's-eye view
    this.veggiePlayed = true;          // once per run
    // Cell selection is by tap; the on-screen joystick/look zones would
    // otherwise swallow those taps, so hide them for the duration.
    const tc = document.getElementById('touch-controls');
    if (tc) tc.classList.add('hidden');
    // Sit Turnip Scart at the board's edge as the opponent (and stop his
    // wandering for the duration, so he doesn't graze across the cells).
    if (this.goat) {
      const c = this.world.vegPatchPos;
      this.goat.position.set(c.x, this.world.getHeight(c.x, c.z + 2.9), c.z + 2.9);
      this.goat.group.position.copy(this.goat.position);
      this.goat.group.rotation.y = Math.PI; // face the board
      this.goat.state = 'graze';
      this.goat.stateTimer = 999;
    }
    this.veggieGame = new VeggieTacToe(
      this.scene,
      this.world,
      this.camera,
      this.renderer.domElement,
      this.ui,
      (result) => this.endVeggie(result)
    );
  }

  endVeggie(result) {
    if (!this.veggieGame) return;
    this.veggieGame.dispose();
    this.veggieGame = null;
    this.input.suppressPointerLock = false;
    this.player.root.visible = true;
    const tc = document.getElementById('touch-controls');
    if (tc) tc.classList.remove('hidden'); // restore the touch controls
    if (result === 'win') {
      this.audio.play('win');
      // Beating Turnip Scart while playing AS Turnip Scart — a civil war.
      if (this.characterName === 'turnip') this.awardAchievement('turnipwin');
      if (!this.turnipUnlocked) {
        this.turnipUnlocked = true;
        writeStorage(STORAGE_TURNIP, '1');
        this.runUnlockNames.push('Turnip Scart');
        this.ui.showTimeToast('★ TURNIP SCART UNLOCKED! BAAA!');
      } else {
        this.ui.showTimeToast('WELL PLAYED — SCART TIPS HIS HORNS');
      }
      this.particles.spawnBurst(
        this._playerCenter.set(this.world.vegPatchX, this.world.vegPatchPos.y + 1, this.world.vegPatchZ),
        0x8ab86a,
        { count: 40, speed: 5, size: 46, upBias: 0.8, life: 0.9 }
      );
    } else if (result === 'lose') {
      this.ui.showTimeToast('OUTFOXED BY A GOAT');
    } else {
      this.ui.showTimeToast('A DRAW — COME BACK ON ANOTHER SEVEN');
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
    this.audio.play('sonar'); // striking the submarine
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
    this.audio.stopAll(); // silence any engine / movement bed at the bell
    this._vehicleSound = null;
    this._moveKind = null;
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
    // Prunella Registered Voter: a run with an equal (and non-zero) tally of
    // marshmallow clouds and golden pine cones — a perfectly balanced ballot.
    if (
      !this.prunellaUnlocked &&
      this.cloudsCollected > 0 &&
      this.cloudsCollected === this.eggsCollected
    ) {
      this.prunellaUnlocked = true;
      writeStorage(STORAGE_PRUNELLA, '1');
      newlyUnlockedNames.push('Prunella Registered Voter');
    }
    // Dodecahedron the Beret: a 300+ finish while playing as Rhombus.
    if (!this.dodecaUnlocked && this.characterName === 'rhombus' && this.points >= DODECA_SCORE) {
      this.dodecaUnlocked = true;
      writeStorage(STORAGE_DODECA, '1');
      newlyUnlockedNames.push('Dodecahedron the Beret');
    }
    // Polar Pear: touched the summit flag on 10 HP and lived to the bell.
    if (!this.polarpearUnlocked && reason === 'time' && this.reachedSummitLowHP) {
      this.polarpearUnlocked = true;
      writeStorage(STORAGE_POLARPEAR, '1');
      newlyUnlockedNames.push('Polar Pear');
    }

    // All-time points bank: Jam joins the roster once the lifetime total
    // (this run included) reaches 1000; Night Eye at 10000.
    this.totalScore += this.points;
    writeStorage(STORAGE_TOTAL_SCORE, this.totalScore);
    if (!this.jamUnlocked && this.totalScore >= JAM_TOTAL_SCORE) {
      this.jamUnlocked = true;
      writeStorage(STORAGE_JAM, '1');
      newlyUnlockedNames.push('Jam');
    }
    if (!this.nightEyeUnlocked && this.totalScore >= NIGHTEYE_TOTAL_SCORE) {
      this.nightEyeUnlocked = true;
      writeStorage(STORAGE_NIGHTEYE, '1');
      newlyUnlockedNames.push('Night Eye');
    }
    if (!this.glassBadgerUnlocked && this.totalScore >= GLASSBADGER_TOTAL_SCORE) {
      this.glassBadgerUnlocked = true;
      writeStorage(STORAGE_GLASSBADGER, '1');
      newlyUnlockedNames.push('Glass Badger');
    }

    // Final-score trophies + any unlock-count milestones from this run's
    // end-of-bell unlocks (score/decimal/50…500, unlock 1/5/10).
    this.checkAchievements();

    // Slide-whistle any heroes judged and unlocked here at the bell (the
    // mid-run ones already sang out when they were earned).
    if (newlyUnlockedNames.length > this.runUnlockNames.length) {
      this.audio.play('unlock');
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
    this.audio.resume(); // the restart click is a fresh user gesture
    this.audio.stopAll();
    this._vehicleSound = null;
    this._moveKind = null;
    this._announcedUnlocks = 0;

    // Apply the character chosen on the game-over screen (if any).
    const chosen = this.ui.getSelectedCharacter() || this.characterName;
    if (chosen !== this.characterName && this.isCharacterAllowed(chosen)) {
      this.setCharacter(chosen);
    }
    this.recordCharacterUse(); // tally this run against the chosen hero

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
    this.stationsVisited.clear();
    this.sandwichClaimed = false;
    this.reachedSummitLowHP = false;
    this._onSummit = false;
    this._onHelter = false;
    this._pickleSummonedThisRun = false;
    this._guavaDropAt = Math.random() * 30;
    this._guavaDropped = false;
    this.alarmRung = false;
    this.appliancesTouched.clear();
    this.closeTravel();
    this.tubeCaveClaimed = false;
    this.tubeLakeClaimed = false;
    this.dellJumps = 0;
    this._inDell = false;
    this.cherriesCollected = 0;
    this.cloudsCollected = 0;
    this.eggsCollected = 0;
    this.frogHits = 0;
    this.picklesCollected = 0;
    this.magnaCartasCollected = 0;
    this._yoyoCrossings = 0;
    this._over100 = false;
    this.vehiclesDismounted.clear();
    this.renderer.domElement.classList.remove('mystic');
    this.world.resetRug();
    this.world.resetTrapdoor();
    this.world.resetTubeSigns();
    if (this.minigame) {
      this.minigame.dispose();
      this.minigame = null;
    }
    if (this.veggieGame) {
      this.veggieGame.dispose();
      this.veggieGame = null;
      this.input.suppressPointerLock = false;
      this.player.root.visible = true;
      const tc = document.getElementById('touch-controls');
      if (tc) tc.classList.remove('hidden');
    }
    this.veggiePlayed = false;
    this._veggiePrompted = false;
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
      this.audio.setMoveIntensity(0); // no roll/hover hum during the putt
      this.player.animate(dt, false);
    } else if (this.veggieGame) {
      // 'Veggie Tac Toe': clock FROZEN, a fixed bird's-eye camera over the
      // patch. Cells are HTML overlay buttons (tap/click); number keys 1-9
      // work too; Escape concedes. Taps are swallowed so they don't read
      // as gestures. The camera is set BEFORE the update so the overlay
      // buttons project onto the board correctly from the first frame.
      const c = this.world.vegPatchPos;
      this.camera.position.set(c.x, c.y + 11, c.z + 0.01);
      this.camera.lookAt(c.x, c.y, c.z);
      this.camera.updateMatrixWorld();
      this.input.consumeDoubleTap();
      this.input.consumeTripleTap();
      if (this.input.keys.has('Escape')) {
        this.veggieGame.abandon();
      } else {
        for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']) {
          if (this.input.keys.has(code)) {
            this.veggieGame.handleKey(code);
            this.input.keys.delete(code); // one placement per press
          }
        }
        this.veggieGame.update(dt);
      }
      this.audio.setMoveIntensity(0); // no roll/hover hum during the game
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
      this.managePickle();
      // Platinum Guava falls once, at a random moment in the last 30 seconds.
      if (!this._guavaDropped && this.timeLeft <= this._guavaDropAt && this.timeLeft > 0) {
        this.dropGuava();
      }
      this.checkAchievements();

      // The mountain summit flag: the 'Peak Bear' trophy for taking Polar
      // Pear up, and the arming of Polar Pear's own unlock (summited on 10
      // HP, then survive to the bell — judged at gameOver).
      if (this.world.mountainRadius) {
        const mdx = this.player.position.x - this.world.mountainX;
        const mdz = this.player.position.z - this.world.mountainZ;
        const summitY = this.world.getHeight(this.world.mountainX, this.world.mountainZ);
        const onSummit =
          mdx * mdx + mdz * mdz < 4 * 4 &&
          Math.abs(this.player.position.y - summitY) < 3;
        if (onSummit) {
          if (this.characterName === 'polarpear') this.awardAchievement('polarsummit');
          if (!this.reachedSummitLowHP && this.health <= POLARPEAR_HEALTH) {
            this.reachedSummitLowHP = true;
            this.ui.showTimeToast('☠ SUMMIT ON A KNIFE-EDGE — NOW SURVIVE!');
          }
          // Pineapple Penguin: summit the flag with a score over 333.
          if (!this.pinepenguinUnlocked && this.points > 333) {
            this.pinepenguinUnlocked = true;
            writeStorage(STORAGE_PINEPENGUIN, '1');
            this.runUnlockNames.push('Pineapple Penguin');
            this.ui.showTimeToast('★ PINEAPPLE PENGUIN UNLOCKED!');
          }
        }
        // Count each fresh arrival at the summit (leaving and returning
        // counts again). At 100 lifetime arrivals, Gary Mountain wakes.
        if (onSummit && !this._onSummit) {
          this.summitVisits += 1;
          writeStorage(STORAGE_SUMMIT_VISITS, String(this.summitVisits));
          if (!this.garyUnlocked && this.summitVisits >= GARY_SUMMIT_VISITS) {
            this.garyUnlocked = true;
            writeStorage(STORAGE_GARY, '1');
            this.runUnlockNames.push('Gary Mountain');
            this.ui.showTimeToast('★ GARY MOUNTAIN UNLOCKED! 🏔️');
          }
        }
        this._onSummit = onSummit;
      }

      // The helter skelter: tally all-time visits (unlocking Candy Florence
      // at 100), and give Candy her sky-high fling whenever she stands beside
      // it — the slide flings her up like a rocket.
      if (this.world.helterRadius) {
        const hdx = this.player.position.x - this.world.helterX;
        const hdz = this.player.position.z - this.world.helterZ;
        const zone = this.world.helterRadius + 3;
        const nearHelter = hdx * hdx + hdz * hdz < zone * zone;
        if (nearHelter && !this._onHelter) {
          this.helterVisits += 1;
          writeStorage(STORAGE_HELTER_VISITS, String(this.helterVisits));
          if (!this.candyUnlocked && this.helterVisits >= CANDY_HELTER_VISITS) {
            this.candyUnlocked = true;
            writeStorage(STORAGE_CANDY, '1');
            this.runUnlockNames.push('Candy Florence');
            this.ui.showTimeToast('★ CANDY FLORENCE UNLOCKED! ☁️');
          }
        }
        this._onHelter = nearHelter;
        // Candy Florence: the helter skelter launches her skyward each time
        // she comes back down to earth beside it.
        if (nearHelter && this.characterName === 'candy' && this.player.grounded) {
          this.player.velocity.y = CANDY_LAUNCH_SPEED;
          this.player.grounded = false;
          this.audio.play('jump');
        }
      }

      // Engine beds follow whatever the player is currently riding.
      const vk = this.player.vehicle ? this.player.vehicle.kind : null;
      if (vk !== this._vehicleSound) {
        this._vehicleSound = vk;
        this.audio.setVehicle(vk);
      }
      // Any fresh mid-run character unlock earns a slide-whistle.
      if (this.runUnlockNames.length > this._announcedUnlocks) {
        this._announcedUnlocks = this.runUnlockNames.length;
        this.audio.play('unlock');
      }

      // Movement sound: footsteps for walkers, a continuous rolling bed for
      // Marblella, and an airy hover bed for the feetless heroes.
      const pl = this.player;
      const moveKind = pl.marbleMesh
        ? 'roll'
        : pl.isBouncy
          ? 'foot' // hops land like footfalls
          : (pl.legs && pl.legs.length === 0 ? 'hover' : 'foot');
      if (moveKind !== this._moveKind) {
        this._moveKind = moveKind;
        this.audio.setMoveBed(moveKind === 'foot' ? null : moveKind);
        this._lastStep = Math.floor(pl.walkCycle / Math.PI);
      }
      const horiz = Math.hypot(pl.velocity.x, pl.velocity.z);
      const speed01 = clamp(horiz / 7, 0, 1);
      const moving = pl.grounded && !pl.vehicle && horiz > 1.2;
      if (moveKind === 'foot') {
        // A footfall at each half-cycle of the leg swing while grounded.
        const step = Math.floor(pl.walkCycle / Math.PI);
        if (moving && step !== this._lastStep) this.audio.footstep(speed01);
        this._lastStep = step;
      } else {
        // Roll/hover intensity tracks speed; the sweatshirt keeps a faint
        // ethereal presence even at rest. Silent while riding a vehicle.
        const floor = pl.isFloaty ? 0.3 : 0;
        this.audio.setMoveIntensity(pl.vehicle ? 0 : Math.max(floor, moving ? speed01 : 0));
      }

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

      // Veggie Tac Toe: a multiple of 7 on the patch invites a game.
      if (this.canStartVeggie()) {
        if (!this._veggiePrompted) {
          this.ui.showTimeToast('VEGGIE TAC TOE! DOUBLE-TAP TO CHALLENGE TURNIP SCART');
          this._veggiePrompted = true;
        }
      } else if (this._veggiePrompted) {
        const dx = this.player.position.x - this.world.vegPatchX;
        const dz = this.player.position.z - this.world.vegPatchZ;
        const off = dx * dx + dz * dz > (this.world.vegPatchRadius + 6) ** 2;
        if (off || !Number.isInteger(this.points) || this.points % 7 !== 0) {
          this._veggiePrompted = false;
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
    // Turnip Scart holds still while he's playing you at Veggie Tac Toe.
    if (this.goat && !this.veggieGame) this.goat.update(dt, time);
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
    if (this.minigame) { this.minigame.dispose(); this.minigame = null; }
    if (this.veggieGame) { this.veggieGame.dispose(); this.veggieGame = null; }
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
