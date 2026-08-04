/**
 * Player.js — The badger hero (and her royal alter ego, the Badgerette).
 *
 * Two responsibilities, deliberately kept in one module because they share
 * state (pose follows physics):
 *
 *  1. HERO MESH — a compound, organically-proportioned body built from
 *     smooth-normal primitives, cel-shaded with the three-tone toon material
 *     and rim light from Shaders.js. The black-and-white face masking is
 *     painted per-vertex into a `color` attribute (no textures needed).
 *     Detail pass: two-segment legs with claws, shoulder/haunch musculature,
 *     a neck ruff, brow and cheek tufts, and a fluffy displaced tail.
 *     The 'badgerette' variant adds flowing ginger hair (tube-swept locks
 *     that trail and sway with movement) and a jeweled golden tiara.
 *
 *  2. KINEMATIC CHARACTER CONTROLLER — gravity, acceleration/deceleration,
 *     momentum conservation, friction, coyote time, jump buffering,
 *     variable jump height, slope sliding, ground snapping (no jitter on
 *     slopes) and cylinder-collider push-out.
 */

import * as THREE from 'three';
import { createToonMaterial } from './Shaders.js';
import { createAuraPoints } from './Particles.js';
import { clamp, damp, dampAngle, moveToward } from './utils/MathUtils.js';

/* ------------------------------------------------------------------ */
/*  Tuning                                                             */
/* ------------------------------------------------------------------ */

const TUNING = {
  maxSpeed: 8.0,        // m/s on flat ground
  groundAccel: 42.0,    // m/s^2 toward the wish direction
  groundFriction: 30.0, // m/s^2 deceleration with no input
  airAccel: 13.0,       // limited steering while airborne
  gravity: 30.0,
  fallGravityScale: 1.35,   // heavier on the way down — snappier arcs
  shortHopGravityScale: 2.4, // applied when jump is released early
  jumpSpeed: 12.0,
  maxFallSpeed: 42.0,
  coyoteTime: 0.12,
  jumpBufferTime: 0.16,
  groundSnapDistance: 0.5,  // stick-to-ground range when walking downhill
  steepSlopeNormalY: 0.6,   // below this the surface is a slide, not a floor
  slideAccel: 16.0,
  radius: 0.55,             // horizontal collision radius
  height: 1.35              // approximate body height (feet to head)
};

/* ------------------------------------------------------------------ */
/*  Mesh helpers                                                       */
/* ------------------------------------------------------------------ */

/** Bake a per-vertex color attribute from a function of the unit normal
 *  direction of each vertex (relative to the geometry's local origin). */
function paintVertexColors(geometry, paint) {
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    p.fromBufferAttribute(positions, i);
    const n = p.clone().normalize();
    paint(n, p, c);
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Cheap deterministic value noise for fur mottling. */
function furNoise(x, y, z) {
  return Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 0.5 + 0.5;
}

/* ------------------------------------------------------------------ */
/*  Player                                                             */
/* ------------------------------------------------------------------ */

export class Player {
  /**
   * @param {import('./World.js').World} world  height field + colliders
   * @param {THREE.Vector3} spawnPoint          feet position at spawn
   * @param {'badger'|'badgerette'|'hughes'|'boffington'} character hero to build
   */
  constructor(world, spawnPoint, character = 'badger') {
    this.world = world;
    this.spawnPoint = spawnPoint.clone();
    this.character = character;

    // --- physics state -------------------------------------------------
    this.position = spawnPoint.clone(); // FEET position
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.facingYaw = 0;
    // Per-character jump feel (Billy Rocketfingers leaps higher and floatier
    // to reach the cherries atop the trees). 1 = default.
    this.jumpScale = 1;
    this.gravityScale = 1;

    // --- animation state -----------------------------------------------
    this.walkCycle = 0;
    this.squash = 0;       // 0..1 landing squash amount, springs back to 0
    this.airTilt = 0;
    this.hairGroup = null;   // badgerette's mane / william's cape
    this.arms = null;        // stick-limbed heroes only
    this.googlyEyes = null;  // rattling pupils (Hughes, Edith)
    this.rockMesh = null;    // Rhombus: the body that waddle-rocks
    this.isGlitchy = false;  // Error #42's intermittent reality problem
    this.nucleusRings = null; // The Nucleus' orbiting electrons
    this.isFloaty = false;   // Haunted Sweatshirt's ethereal hover
    this.isBouncy = false;   // Pickle Stick hops to get around
    this.hoverHeight = 0;    // Candy Florence rests this far above the ground
    this.moveScale = 1;      // per-instance top-speed multiplier (CPU rival tuning)
    this.walksOnWater = false; // Spirit of the Forest Badger treads the lakes
    this.waterSink = 0;      // Top Hat Snappy rides this far below the surface
    this.accelScale = 1;     // ground-accel multiplier (Snappy slides in slowly)
    this.frictionScale = 1;  // ground-friction multiplier (Snappy glides on release)
    this.tail = null;
    this.headGroup = null;
    this.marbleMesh = null;  // Marblella: the sphere that actually rolls

    // --- vehicle & water state -------------------------------------------
    this.vehicle = null; // a Hovercraft while riding, else null
    this._lastDryPos = spawnPoint.clone();

    // --- events (wired by Game) ------------------------------------------
    this.onLand = null;   // (impactSpeed: number, position: Vector3) => void
    this.onJump = null;   // (position: Vector3) => void
    this.onSplash = null; // () => void — bounced off deep water

    // --- reusable scratch objects (no per-frame allocation) --------------
    this._wishDir = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
    this._scratch2 = new THREE.Vector3();

    this._disposables = [];
    if (this.character === 'hughes') this.root = this.buildCrispPacket();
    else if (this.character === 'boffington') this.root = this.buildBoffington('finn');
    else if (this.character === 'boddington') this.root = this.buildBoffington('flynn');
    else if (this.character === 'edith') this.root = this.buildEdith();
    else if (this.character === 'rhombus') this.root = this.buildRhombus();
    else if (this.character === 'ginsberg') this.root = this.buildGinsberg();
    else if (this.character === 'magnus') this.root = this.buildMagnus();
    else if (this.character === 'error42') this.root = this.buildError42();
    else if (this.character === 'error43') this.root = this.buildError43();
    else if (this.character === 'nucleus') this.root = this.buildNucleus();
    else if (this.character === 'tudor') this.root = this.buildTudorLizard();
    else if (this.character === 'mayo') this.root = this.buildMayo();
    else if (this.character === 'jam') this.root = this.buildJam();
    else if (this.character === 'dodeca') this.root = this.buildDodeca();
    else if (this.character === 'polarpear') this.root = this.buildPolarPear();
    else if (this.character === 'nighteye') this.root = this.buildNightEye();
    else if (this.character === 'pinepenguin') this.root = this.buildPinePenguin();
    else if (this.character === 'billy') this.root = this.buildBilly();
    else if (this.character === 'pickle') this.root = this.buildPickle();
    else if (this.character === 'glassbadger') this.root = this.buildGlassBadger();
    else if (this.character === 'vapour') this.root = this.buildVapourBadger();
    else if (this.character === 'spirit') this.root = this.buildSpiritBadger();
    else if (this.character === 'chimpy') this.root = this.buildChimpy();
    else if (this.character === 'owl') this.root = this.buildPastryOwl();
    else if (this.character === 'snappy') this.root = this.buildTopHatSnappy();
    else if (this.character === 'bacon') this.root = this.buildBacon();
    else if (this.character === 'robofarmer') this.root = this.buildRoboFarmer();
    else if (this.character === 'frosch') this.root = this.buildSirFrosch();
    else if (this.character === 'mcdonovan') this.root = this.buildMcDonovan();
    else if (this.character === 'prunella') this.root = this.buildPrunella();
    else if (this.character === 'gary') this.root = this.buildGaryMountain();
    else if (this.character === 'candy') this.root = this.buildCandyFlorence();
    else if (this.character === 'cactusballoon') this.root = this.buildCactusBalloon();
    else if (this.character === 'nelly') this.root = this.buildNegativeNelly();
    else if (this.character === 'trifedora') this.root = this.buildTriangleFedora();
    else if (this.character === 'parsley') this.root = this.buildParsleyORiley();
    else if (this.character === 'perpbird') this.root = this.buildPerpBird();
    else if (this.character === 'marblella') this.root = this.buildMarblella();
    else if (this.character === 'fir') this.root = this.buildFir();
    else if (this.character === 'margaret') this.root = this.buildMargaret();
    else if (this.character === 'julie') this.root = this.buildJulie();
    else if (this.character === 'turnip') this.root = this.buildTurnip();
    else if (this.character === 'sweatshirt') this.root = this.buildSweatshirt();
    else this.root = this.buildBadger(); // badger, badgerette, william
    this.root.position.copy(this.position);
  }

  /* ================================================================ */
  /*  Mesh construction                                               */
  /* ================================================================ */

  buildBadger() {
    const root = new THREE.Group();
    root.name = this.character;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const rim = { color: 0xcfe0ff, strength: 0.22, threshold: 0.74 };

    const furMat = track(createToonMaterial({ vertexColors: true, rim }));
    const darkMat = track(createToonMaterial({ color: 0x26262c, rim: { color: 0x9db4e8, strength: 0.25, threshold: 0.68 } }));
    const creamMat = track(createToonMaterial({ color: 0xf2ecdd, rim }));
    const noseMat = track(createToonMaterial({ color: 0x141417, rim: { color: 0x8899cc, strength: 0.5, threshold: 0.52 } }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const clawMat = track(createToonMaterial({ color: 0xd9d2bf }));

    // Everything above the legs hangs off bodyGroup so bob/squash/tilt are
    // applied in one place.
    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- torso: silver saddle, pale flank band, near-black belly ---------
    const torsoGeo = track(new THREE.SphereGeometry(0.62, 36, 26));
    paintVertexColors(torsoGeo, (n, p, c) => {
      const mottle = (furNoise(p.x * 4, p.y * 4, p.z * 4) - 0.5) * 0.07;
      const saddle = new THREE.Color(0x8a90a0).offsetHSL(0, 0, mottle);
      const flank = new THREE.Color(0xb9bcc4);
      const belly = new THREE.Color(0x2e2f38);

      c.copy(saddle);
      // Slightly darker dorsal streak along the spine.
      const dorsal = THREE.MathUtils.smoothstep(n.y, 0.45, 0.8) * (1 - THREE.MathUtils.smoothstep(Math.abs(n.x), 0.2, 0.45));
      c.offsetHSL(0, 0, -dorsal * 0.06);
      // Pale band along the low flanks (classic badger grizzle).
      const flankBand =
        THREE.MathUtils.smoothstep(n.y, -0.35, -0.05) *
        (1 - THREE.MathUtils.smoothstep(n.y, 0.1, 0.4));
      c.lerp(flank, flankBand * 0.55);
      // Dark belly swallowing the underside.
      c.lerp(belly, 1 - THREE.MathUtils.smoothstep(n.y, -0.7, -0.15));
    });
    const torso = new THREE.Mesh(torsoGeo, furMat);
    torso.scale.set(1.0, 0.8, 1.32);
    torso.castShadow = true;
    body.add(torso);

    // --- musculature: haunches at the rear, shoulders up front -----------
    const haunchGeo = track(new THREE.SphereGeometry(0.3, 22, 16));
    paintVertexColors(haunchGeo, (n, p, c) => {
      c.set(0x788091).offsetHSL(0, 0, (furNoise(p.x * 5, p.y * 5, p.z * 5) - 0.5) * 0.06);
    });
    for (const side of [-1, 1]) {
      const haunch = new THREE.Mesh(haunchGeo, furMat);
      haunch.position.set(side * 0.27, -0.17, -0.44);
      haunch.scale.set(0.85, 0.9, 1.0);
      haunch.castShadow = true;
      body.add(haunch);

      const shoulder = new THREE.Mesh(haunchGeo, furMat);
      shoulder.position.set(side * 0.25, -0.12, 0.38);
      shoulder.scale.set(0.7, 0.75, 0.8);
      shoulder.castShadow = true;
      body.add(shoulder);
    }

    // --- neck ruff: a fluffy collar where head meets torso ----------------
    const ruffGeo = track(new THREE.SphereGeometry(0.42, 24, 16));
    paintVertexColors(ruffGeo, (n, p, c) => {
      const shag = (furNoise(p.x * 9, p.y * 9, p.z * 9) - 0.5) * 0.1;
      c.set(0x9aa0ac).offsetHSL(0, 0, shag);
      c.lerp(new THREE.Color(0x3a3b44), 1 - THREE.MathUtils.smoothstep(n.y, -0.7, -0.1));
    });
    const ruff = new THREE.Mesh(ruffGeo, furMat);
    ruff.position.set(0, 0.16, 0.5);
    ruff.scale.set(1.05, 0.8, 0.6);
    ruff.castShadow = true;
    body.add(ruff);

    // --- head with vertex-painted badger mask ---------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.34, 0.72);
    headGroup.rotation.x = -0.08;
    body.add(headGroup);
    this.headGroup = headGroup;

    const headGeo = track(new THREE.SphereGeometry(0.42, 40, 30));
    paintVertexColors(headGeo, (n, p, c) => {
      const cream = new THREE.Color(0xf4efe2);
      const black = new THREE.Color(0x17171b);
      const grey = new THREE.Color(0x84888f);

      // Two black stripes sweeping from the snout, through the eyes, back
      // over the crown — the classic badger mask.
      const stripeBand =
        THREE.MathUtils.smoothstep(Math.abs(n.x), 0.13, 0.2) *
        (1 - THREE.MathUtils.smoothstep(Math.abs(n.x), 0.42, 0.52));
      const frontHalf = THREE.MathUtils.smoothstep(n.z, -0.35, -0.1);
      const aboveJaw = THREE.MathUtils.smoothstep(n.y, -0.5, -0.28);
      const stripe = stripeBand * frontHalf * aboveJaw;

      // Rear of the skull blends toward body grey.
      const rear = THREE.MathUtils.smoothstep(-n.z, 0.45, 0.8);

      c.copy(cream).lerp(black, stripe).lerp(grey, rear * 0.85);
    });
    const head = new THREE.Mesh(headGeo, furMat);
    head.scale.set(0.92, 0.88, 1.12);
    head.castShadow = true;
    headGroup.add(head);

    // --- snout, nose, chin tuft ------------------------------------------
    const snoutGeo = track(new THREE.ConeGeometry(0.18, 0.42, 20, 1, false));
    const snout = new THREE.Mesh(snoutGeo, creamMat);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.08, 0.42);
    snout.castShadow = true;
    headGroup.add(snout);

    const noseGeo = track(new THREE.SphereGeometry(0.075, 14, 10));
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.set(0, -0.075, 0.62);
    headGroup.add(nose);

    const chinGeo = track(new THREE.SphereGeometry(0.09, 12, 8));
    const chin = new THREE.Mesh(chinGeo, darkMat);
    chin.position.set(0, -0.24, 0.36);
    chin.scale.set(1.1, 0.7, 1.2);
    headGroup.add(chin);

    // --- brows, cheeks, eyes with glints ----------------------------------
    const browGeo = track(new THREE.SphereGeometry(0.075, 12, 8));
    const cheekGeo = track(new THREE.SphereGeometry(0.12, 14, 10));
    const eyeGeo = track(new THREE.SphereGeometry(0.06, 12, 10));
    const glintGeo = track(new THREE.SphereGeometry(0.018, 8, 6));
    for (const side of [-1, 1]) {
      const brow = new THREE.Mesh(browGeo, creamMat);
      brow.position.set(side * 0.155, 0.17, 0.32);
      brow.scale.set(1.15, 0.55, 0.9);
      headGroup.add(brow);

      const cheek = new THREE.Mesh(cheekGeo, creamMat);
      cheek.position.set(side * 0.24, -0.13, 0.26);
      cheek.scale.set(0.95, 0.8, 1.0);
      cheek.castShadow = true;
      headGroup.add(cheek);

      const eye = new THREE.Mesh(eyeGeo, noseMat);
      eye.position.set(side * 0.15, 0.06, 0.36);
      headGroup.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.16, 0.085, 0.405);
      headGroup.add(glint);
    }

    // --- ears -------------------------------------------------------------
    const earGeo = track(new THREE.SphereGeometry(0.1, 12, 10));
    const earInnerGeo = track(new THREE.SphereGeometry(0.055, 10, 8));
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(earGeo, darkMat);
      ear.position.set(side * 0.26, 0.3, -0.02);
      ear.scale.set(1, 1.05, 0.6);
      ear.castShadow = true;
      headGroup.add(ear);
      const inner = new THREE.Mesh(earInnerGeo, creamMat);
      inner.position.set(side * 0.26, 0.3, 0.03);
      inner.scale.set(1, 1.05, 0.45);
      headGroup.add(inner);
    }

    // --- fluffy tail: displaced icosahedron, grey fading to a pale tip -----
    const tailGeo = track(new THREE.IcosahedronGeometry(0.18, 1));
    {
      const pos = tailGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const fluff = 1 + (furNoise(pos.getX(i) * 14, pos.getY(i) * 14, pos.getZ(i) * 14) - 0.5) * 0.45;
        pos.setXYZ(i, pos.getX(i) * fluff, pos.getY(i) * fluff, pos.getZ(i) * fluff);
      }
      tailGeo.computeVertexNormals();
    }
    paintVertexColors(tailGeo, (n, p, c) => {
      c.set(0x82868d).lerp(new THREE.Color(0xe9e4d6), THREE.MathUtils.smoothstep(-n.z, 0.1, 0.9));
    });
    const tail = new THREE.Mesh(tailGeo, furMat);
    tail.position.set(0, 0.02, -0.92);
    tail.scale.set(0.9, 0.9, 1.6);
    tail.castShadow = true;
    body.add(tail);
    this.tail = tail;

    // --- legs: hip pivots swinging a thigh + shin + clawed paw -------------
    const thighGeo = track(new THREE.CylinderGeometry(0.105, 0.125, 0.28, 12));
    const shinGeo = track(new THREE.CylinderGeometry(0.075, 0.095, 0.24, 10));
    const pawGeo = track(new THREE.SphereGeometry(0.13, 14, 10));
    const clawGeo = track(new THREE.ConeGeometry(0.022, 0.07, 6));
    this.legs = [];
    const legSlots = [
      { x: -0.3, z: 0.42, phase: 0 },
      { x: 0.3, z: 0.42, phase: Math.PI },
      { x: -0.32, z: -0.48, phase: Math.PI },
      { x: 0.32, z: -0.48, phase: 0 }
    ];
    for (const slot of legSlots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.3, slot.z);

      const thigh = new THREE.Mesh(thighGeo, darkMat);
      thigh.position.y = -0.12;
      thigh.castShadow = true;
      pivot.add(thigh);

      const shin = new THREE.Mesh(shinGeo, darkMat);
      shin.position.set(0, -0.3, 0.02);
      shin.rotation.x = 0.12;
      shin.castShadow = true;
      pivot.add(shin);

      const paw = new THREE.Mesh(pawGeo, darkMat);
      paw.position.set(0, -0.42, 0.05);
      paw.scale.set(1, 0.62, 1.25);
      paw.castShadow = true;
      pivot.add(paw);

      // Three digging claws splayed at the front of each paw.
      for (const cx of [-0.05, 0, 0.05]) {
        const claw = new THREE.Mesh(clawGeo, clawMat);
        claw.position.set(cx, -0.47, 0.19);
        claw.rotation.x = Math.PI / 2 - 0.25;
        claw.rotation.z = -cx * 3;
        pivot.add(claw);
      }

      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    // --- the Badgerette: flowing ginger hair + jeweled tiara ---------------
    if (this.character === 'badgerette') {
      this._buildBadgeretteExtras(headGroup, track);
    }
    // --- William the Conqueror: golden crown + royal cape ------------------
    if (this.character === 'william') {
      this._buildWilliamExtras(headGroup, body, track);
    }

    return root;
  }

  /** Norman regalia: a jeweled crown and a red cape that streams behind
   *  (it borrows the hairGroup sway rig, so it billows when running). */
  _buildWilliamExtras(headGroup, body, track) {
    const goldMat = track(createToonMaterial({
      color: 0xf5c542,
      emissive: 0x4a3300,
      emissiveIntensity: 1.0,
      rim: { color: 0xfff3c0, strength: 0.8, threshold: 0.45 }
    }));
    const gemMat = track(createToonMaterial({
      color: 0xc03040,
      emissive: 0x800818,
      emissiveIntensity: 0.9
    }));
    const capeMat = track(createToonMaterial({
      color: 0xa02030,
      rim: { color: 0xff9a8a, strength: 0.35, threshold: 0.62 }
    }));
    capeMat.side = THREE.DoubleSide;

    // Crown: a golden band with four points and a ruby, worn at a
    // conquering tilt between the ears.
    const crown = new THREE.Group();
    crown.position.set(0, 0.34, 0.06);
    crown.rotation.x = 0.22;
    crown.rotation.z = -0.08;
    headGroup.add(crown);

    const bandGeo = track(new THREE.CylinderGeometry(0.155, 0.17, 0.11, 12, 1, true));
    const band = new THREE.Mesh(bandGeo, goldMat);
    crown.add(band);
    const pointGeo = track(new THREE.ConeGeometry(0.035, 0.1, 6));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const point = new THREE.Mesh(pointGeo, goldMat);
      point.position.set(Math.cos(a) * 0.14, 0.1, Math.sin(a) * 0.14);
      crown.add(point);
    }
    const gemGeo = track(new THREE.SphereGeometry(0.032, 8, 6));
    const gem = new THREE.Mesh(gemGeo, gemMat);
    gem.position.set(0, 0.0, 0.165);
    crown.add(gem);

    // Cape: a gently curved sheet hanging from the shoulders. Assigning
    // it to hairGroup reuses the mane animation — idle sway, lift at speed.
    const capeGroup = new THREE.Group();
    capeGroup.position.set(0, 0.34, 0.28);
    body.add(capeGroup);
    this.hairGroup = capeGroup;

    const capeGeo = track(new THREE.PlaneGeometry(0.72, 1.05, 6, 8));
    {
      const pos = capeGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i); // 0.525 top .. -0.525 bottom
        const drop = (0.525 - y) / 1.05; // 0 at shoulders, 1 at hem
        // Drape back over the rump and flare slightly at the hem.
        pos.setZ(i, -drop * drop * 0.85);
        pos.setX(i, x * (1 + drop * 0.35));
      }
      capeGeo.computeVertexNormals();
    }
    const cape = new THREE.Mesh(capeGeo, capeMat);
    cape.position.set(0, -0.45, -0.1);
    cape.rotation.x = 0.35;
    cape.castShadow = true;
    capeGroup.add(cape);

    // Gold clasps at the shoulders.
    const claspGeo = track(new THREE.SphereGeometry(0.045, 8, 6));
    for (const side of [-1, 1]) {
      const clasp = new THREE.Mesh(claspGeo, goldMat);
      clasp.position.set(side * 0.3, 0.02, 0.05);
      capeGroup.add(clasp);
    }
  }

  /**
   * Edith McCombe — a kitchen sink on bird legs. White basin, chrome
   * gooseneck faucet, hot & cold taps, googly eyes, and scaly reverse-
   * kneed legs ending in three-toed feet.
   */
  buildEdith() {
    const root = new THREE.Group();
    root.name = 'edith';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const porcelainMat = track(createToonMaterial({
      color: 0xf2f4f6,
      rim: { color: 0xdfe8ff, strength: 0.4, threshold: 0.6 }
    }));
    const basinInnerMat = track(createToonMaterial({ color: 0xc4cad2 }));
    const chromeMat = track(createToonMaterial({
      color: 0xb8c0cc,
      emissive: 0x202830,
      emissiveIntensity: 1.0,
      rim: { color: 0xffffff, strength: 0.6, threshold: 0.5 }
    }));
    const hotMat = track(createToonMaterial({ color: 0xc03038 }));
    const coldMat = track(createToonMaterial({ color: 0x3070c0 }));
    const legMat = track(createToonMaterial({
      color: 0xd8a020,
      rim: { color: 0xffd980, strength: 0.3, threshold: 0.66 }
    }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const mouthMat = track(createToonMaterial({ color: 0x4a2430 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the basin -----------------------------------------------------------
    const basinGeo = track(new THREE.BoxGeometry(0.74, 0.44, 0.56, 4, 3, 4));
    const basin = new THREE.Mesh(basinGeo, porcelainMat);
    basin.position.y = 0.3;
    basin.castShadow = true;
    body.add(basin);

    const innerGeo = track(new THREE.BoxGeometry(0.6, 0.05, 0.42));
    const inner = new THREE.Mesh(innerGeo, basinInnerMat);
    inner.position.y = 0.53;
    body.add(inner);

    // Backsplash panel carrying the taps.
    const splashGeo = track(new THREE.BoxGeometry(0.74, 0.26, 0.07));
    const splash = new THREE.Mesh(splashGeo, porcelainMat);
    splash.position.set(0, 0.63, -0.25);
    splash.castShadow = true;
    body.add(splash);

    // --- gooseneck faucet ------------------------------------------------------
    const stemGeo = track(new THREE.CylinderGeometry(0.04, 0.045, 0.34, 8));
    const stem = new THREE.Mesh(stemGeo, chromeMat);
    stem.position.set(0, 0.9, -0.24);
    stem.castShadow = true;
    body.add(stem);
    const neckGeo = track(new THREE.TorusGeometry(0.13, 0.035, 8, 12, Math.PI));
    const neck = new THREE.Mesh(neckGeo, chromeMat);
    neck.position.set(0, 1.07, -0.11);
    neck.rotation.y = Math.PI / 2;
    neck.rotation.z = Math.PI / 2;
    body.add(neck);
    const spoutGeo = track(new THREE.CylinderGeometry(0.028, 0.035, 0.12, 8));
    const spout = new THREE.Mesh(spoutGeo, chromeMat);
    spout.position.set(0, 1.0, 0.02);
    body.add(spout);

    // Hot & cold tap handles.
    const tapGeo = track(new THREE.SphereGeometry(0.055, 10, 8));
    const hot = new THREE.Mesh(tapGeo, hotMat);
    hot.position.set(-0.22, 0.78, -0.24);
    body.add(hot);
    const cold = new THREE.Mesh(tapGeo, coldMat);
    cold.position.set(0.22, 0.78, -0.24);
    body.add(cold);

    // --- face on the basin front, with rattling googly pupils -----------------
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.085, 12, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.04, 10, 8));
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.16, 0.38, 0.27);
      white.scale.set(1, 1.1, 0.45);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.16, 0.38, 0.31);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.16, baseY: 0.38, seed: side * 2.3 });
    }
    const mouthGeo = track(new THREE.TorusGeometry(0.075, 0.014, 6, 12, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.2, 0.285);
    mouth.rotation.z = Math.PI;
    body.add(mouth);

    // --- bird legs: reverse knee, three toes forward, one back ----------------
    const thighGeo = track(new THREE.CylinderGeometry(0.032, 0.028, 0.26, 7));
    thighGeo.translate(0, -0.13, 0);
    const shinGeo = track(new THREE.CylinderGeometry(0.024, 0.026, 0.26, 7));
    const toeGeo = track(new THREE.ConeGeometry(0.02, 0.13, 5));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.18, 0.05, 0);
      const thigh = new THREE.Mesh(thighGeo, legMat);
      thigh.rotation.x = 0.35; // knee juts backward, bird-style
      thigh.castShadow = true;
      pivot.add(thigh);
      const shin = new THREE.Mesh(shinGeo, legMat);
      shin.position.set(0, -0.38, -0.05);
      shin.rotation.x = -0.28;
      shin.castShadow = true;
      pivot.add(shin);
      for (const toe of [-0.5, 0, 0.5]) {
        const t = new THREE.Mesh(toeGeo, legMat);
        t.position.set(Math.sin(toe) * 0.05, -0.51, 0.06);
        t.rotation.x = Math.PI / 2 - 0.15;
        t.rotation.z = -toe * 0.8;
        pivot.add(t);
      }
      const backToe = new THREE.Mesh(toeGeo, legMat);
      backToe.position.set(0, -0.51, -0.09);
      backToe.rotation.x = -(Math.PI / 2 - 0.2);
      pivot.add(backToe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /** Long swept-tube ginger locks and a golden tiara with a pink gem. */
  _buildBadgeretteExtras(headGroup, track) {
    const hairMat = track(createToonMaterial({
      color: 0xc96a22,
      rim: { color: 0xffb36e, strength: 0.45, threshold: 0.6 }
    }));
    const hairDarkMat = track(createToonMaterial({
      color: 0xa8521a,
      rim: { color: 0xff9e4d, strength: 0.35, threshold: 0.64 }
    }));
    const tiaraMat = track(createToonMaterial({
      color: 0xf5c542,
      emissive: 0x4a3300,
      emissiveIntensity: 1.0,
      rim: { color: 0xfff3c0, strength: 0.8, threshold: 0.45 }
    }));
    const gemMat = track(createToonMaterial({
      color: 0xff6fb0,
      emissive: 0xff2f8f,
      emissiveIntensity: 0.7
    }));

    // Hair hangs from a crown pivot so the whole mane sways/trails as one.
    const hairGroup = new THREE.Group();
    hairGroup.position.set(0, 0.24, -0.08);
    headGroup.add(hairGroup);
    this.hairGroup = hairGroup;

    const strandSpecs = [];
    const BACK_STRANDS = 5;
    for (let i = 0; i < BACK_STRANDS; i++) {
      const t = (i - (BACK_STRANDS - 1) / 2) / ((BACK_STRANDS - 1) / 2); // -1..1
      strandSpecs.push({
        points: [
          new THREE.Vector3(t * 0.1, 0.14, 0.06),
          new THREE.Vector3(t * 0.2, 0.02, -0.3),
          new THREE.Vector3(t * 0.3, -0.34, -0.5 + Math.abs(t) * 0.06),
          new THREE.Vector3(t * 0.26 + Math.sin(i * 2.3) * 0.06, -0.78, -0.58)
        ],
        radius: 0.058 - Math.abs(t) * 0.012,
        dark: i % 2 === 1
      });
    }
    // Two shorter locks framing the face.
    for (const side of [-1, 1]) {
      strandSpecs.push({
        points: [
          new THREE.Vector3(side * 0.2, 0.12, 0.16),
          new THREE.Vector3(side * 0.34, -0.06, 0.2),
          new THREE.Vector3(side * 0.38, -0.32, 0.12),
          new THREE.Vector3(side * 0.34, -0.5, 0.02)
        ],
        radius: 0.042,
        dark: false
      });
    }

    for (const spec of strandSpecs) {
      const curve = new THREE.CatmullRomCurve3(spec.points);
      const tubeGeo = track(new THREE.TubeGeometry(curve, 16, spec.radius, 6, false));
      const strand = new THREE.Mesh(tubeGeo, spec.dark ? hairDarkMat : hairMat);
      strand.castShadow = true;
      hairGroup.add(strand);
      // Rounded tip so locks end softly instead of with an open tube.
      const tipGeo = track(new THREE.SphereGeometry(spec.radius * 1.05, 8, 6));
      const tip = new THREE.Mesh(tipGeo, spec.dark ? hairDarkMat : hairMat);
      tip.position.copy(spec.points[spec.points.length - 1]);
      hairGroup.add(tip);
    }

    // Tiara: golden arc across the crown, three spires, one pink gem.
    const tiaraGroup = new THREE.Group();
    tiaraGroup.position.set(0, 0.32, 0.12);
    tiaraGroup.rotation.x = 0.32;
    headGroup.add(tiaraGroup);

    const bandGeo = track(new THREE.TorusGeometry(0.17, 0.022, 8, 24, Math.PI));
    const band = new THREE.Mesh(bandGeo, tiaraMat);
    band.rotation.x = -Math.PI / 2 + 0.25;
    tiaraGroup.add(band);

    const spikeGeo = track(new THREE.ConeGeometry(0.02, 0.085, 8));
    const spikeSlots = [
      { x: -0.1, y: 0.045, s: 0.75 },
      { x: 0, y: 0.075, s: 1.0 },
      { x: 0.1, y: 0.045, s: 0.75 }
    ];
    for (const slot of spikeSlots) {
      const spike = new THREE.Mesh(spikeGeo, tiaraMat);
      spike.position.set(slot.x, slot.y, 0.05);
      spike.scale.setScalar(slot.s);
      tiaraGroup.add(spike);
    }

    const gemGeo = track(new THREE.SphereGeometry(0.028, 10, 8));
    const gem = new THREE.Mesh(gemGeo, gemMat);
    gem.position.set(0, 0.05, 0.085);
    tiaraGroup.add(gem);
  }

  /**
   * 'Crisp Packet' Hughes — an anthropomorphic foil crisp packet.
   * Crimped seams top and bottom, a puffed crinkly middle, a vertex-painted
   * label oval, stick arms and legs, a torus-arc smile and googly eyes
   * whose pupils rattle around when he moves or lands.
   */
  buildCrispPacket() {
    const root = new THREE.Group();
    root.name = 'hughes';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Foil catches the twilight: strong rim + a whisper of emissive sheen.
    const foilMat = track(createToonMaterial({
      vertexColors: true,
      emissive: 0x1a0d08,
      emissiveIntensity: 1.0,
      rim: { color: 0xfff0d8, strength: 0.5, threshold: 0.55 }
    }));
    const stickMat = track(createToonMaterial({
      color: 0x2a2a30,
      rim: { color: 0x9db4e8, strength: 0.25, threshold: 0.68 }
    }));
    const shoeMat = track(createToonMaterial({ color: 0xd8362a }));
    const eyeWhiteMat = track(createToonMaterial({
      color: 0xffffff,
      rim: { color: 0xffffff, strength: 0.3, threshold: 0.6 }
    }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const mouthMat = track(createToonMaterial({ color: 0x3a1410 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the packet: box, painted, then crimped + puffed + crinkled --------
    const packetGeo = track(new THREE.BoxGeometry(0.72, 1.0, 0.26, 10, 14, 4));
    {
      const pos = packetGeo.attributes.position;
      const nor = packetGeo.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      const red = new THREE.Color(0xd8362a);
      const cream = new THREE.Color(0xf5e9c8);
      const gold = new THREE.Color(0xe8a020);
      const silver = new THREE.Color(0xc4c6ce);

      // Paint first, using the pristine box coordinates.
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const crinkleTint = (furNoise(x * 11, y * 11, pos.getZ(i) * 11) - 0.5) * 0.09;

        if (Math.abs(y) > 0.42) {
          // Crimped foil seams.
          c.copy(silver).offsetHSL(0, 0, crinkleTint);
        } else {
          c.copy(red).offsetHSL(0, 0, crinkleTint);
          // Front label: cream oval with a gold ring, brand mysteriously absent.
          if (nor.getZ(i) > 0.7) {
            const ellipse = Math.hypot(x / 0.26, (y + 0.04) / 0.3);
            if (ellipse < 0.82) c.copy(cream).offsetHSL(0, 0, crinkleTint * 0.5);
            else if (ellipse < 1.0) c.copy(gold).offsetHSL(0, 0, crinkleTint * 0.5);
          }
        }
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      packetGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      // Then shape: pinch the seams flat, puff the middle, crinkle the foil.
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const crimp = THREE.MathUtils.smoothstep(Math.abs(y), 0.34, 0.48);
        const puff = (1 - crimp) * (1 + 0.2 * Math.cos(y * Math.PI));
        const crinkle = 1 + (furNoise(x * 9 + 3, y * 9, z * 9) - 0.5) * 0.12;
        pos.setX(i, x * (1 + 0.12 * crimp) * (0.9 + 0.1 * puff) * crinkle);
        pos.setZ(i, z * (1 - 0.85 * crimp) * puff * crinkle);
      }
      packetGeo.computeVertexNormals();
    }
    const packet = new THREE.Mesh(packetGeo, foilMat);
    packet.position.y = 0.42;
    packet.castShadow = true;
    body.add(packet);
    this.packet = packet;

    // --- googly eyes: flattened white domes, free-rattling pupils ----------
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.105, 14, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.048, 10, 8));
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.16, 0.72, 0.16);
      white.scale.set(1, 1, 0.45);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.16, 0.72, 0.21);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.16, baseY: 0.72, seed: side * 1.7 });
    }

    // --- smile: a downturned torus arc reads as a happy little mouth -------
    const mouthGeo = track(new THREE.TorusGeometry(0.09, 0.016, 6, 14, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.52, 0.17);
    mouth.rotation.z = Math.PI; // arc opens upward = smile
    body.add(mouth);

    // --- stick arms: shoulder pivots, splayed, tiny mitten hands -----------
    const armGeo = track(new THREE.CylinderGeometry(0.024, 0.024, 0.42, 8));
    armGeo.translate(0, -0.21, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.4, 0.55, 0);
      pivot.rotation.z = -side * 0.5; // splay out from the packet sides
      const arm = new THREE.Mesh(armGeo, stickMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, stickMat);
      hand.position.set(0, -0.44, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0, splay: -side * 0.5 });
    }

    // --- stick legs: two of them, with jaunty red shoes ---------------------
    const legGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.5, 8));
    legGeo.translate(0, -0.25, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, -0.05, 0);
      const leg = new THREE.Mesh(legGeo, stickMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.52, 0.04);
      shoe.scale.set(1.15, 0.55, 1.9);
      shoe.castShadow = true;
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Mr Finn Boffington — a dapper blue block-fellow with curved dark
   * horns, a purple waistcoat over a bow tie, a beaming smile and slim
   * blue limbs. Painted per-vertex: waistcoat, V-opening, the lot.
   *
   * The 'flynn' variant builds his nemesis twin, Mr Flynn Boddington:
   * identical build, but ORANGE, in a dark petrol waistcoat, with
   * villainously slanted brows and a magnificent handlebar moustache.
   */
  buildBoffington(variant = 'finn') {
    const flynn = variant === 'flynn';
    const root = new THREE.Group();
    root.name = flynn ? 'boddington' : 'boffington';

    const palette = flynn
      ? {
          body: 0xe8862a,
          vest: 0x1f4a58,
          vestDark: 0x14343f,
          limb: 0xc06a1a,
          hand: 0xf0a050,
          rim: 0xffd9a8
        }
      : {
          body: 0x3aa0e8,
          vest: 0x7a3fa8,
          vestDark: 0x5f2f86,
          limb: 0x2f7fc0,
          hand: 0x5ab0e8,
          rim: 0xbfe4ff
        };

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const bodyMat = track(createToonMaterial({
      vertexColors: true,
      rim: { color: palette.rim, strength: 0.35, threshold: 0.62 }
    }));
    const limbMat = track(createToonMaterial({
      color: palette.limb,
      rim: { color: palette.rim, strength: 0.3, threshold: 0.64 }
    }));
    const handMat = track(createToonMaterial({ color: palette.hand }));
    const hornMat = track(createToonMaterial({
      color: 0x23232a,
      rim: { color: 0x8899cc, strength: 0.4, threshold: 0.6 }
    }));
    const shoeMat = track(createToonMaterial({ color: 0x2a2030 }));
    const tieMat = track(createToonMaterial({ color: 0x17171b }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x4a1a2c }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the block: painted, then corner-rounded ---------------------------
    const blockGeo = track(new THREE.BoxGeometry(0.62, 0.95, 0.36, 8, 12, 5));
    {
      const pos = blockGeo.attributes.position;
      const nor = blockGeo.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      const blue = new THREE.Color(palette.body);
      const vest = new THREE.Color(palette.vest);
      const vestDark = new THREE.Color(palette.vestDark);

      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const py = pos.getY(i) / 0.475; // -1..1
        const front = nor.getZ(i) > 0.5;
        const tint = (furNoise(x * 8, py * 8, pos.getZ(i) * 8) - 0.5) * 0.05;

        c.copy(blue).offsetHSL(0, 0, tint);
        if (py < 0.18) {
          // Waistcoat wraps the lower body, darker at the hem.
          c.copy(vest).lerp(vestDark, THREE.MathUtils.smoothstep(-py, 0.4, 1.0)).offsetHSL(0, 0, tint);
          // V-opening on the chest shows blue beneath, narrowing downward.
          if (front) {
            const vHalfWidth = 0.16 * THREE.MathUtils.smoothstep(py, -0.5, 0.18);
            if (Math.abs(x) < vHalfWidth) c.copy(blue).offsetHSL(0, 0, tint);
          }
        }
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      blockGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      // Soften the corners: pull each vertex toward its ellipsoid shadow.
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const u = Math.hypot(x / 0.31, y / 0.475, z / 0.18);
        if (u > 1) {
          const t = 0.3;
          pos.setXYZ(i, x * (1 - t + t / u), y * (1 - t + t / u), z * (1 - t + t / u));
        }
      }
      blockGeo.computeVertexNormals();
    }
    const block = new THREE.Mesh(blockGeo, bodyMat);
    block.position.y = 0.42;
    block.castShadow = true;
    body.add(block);

    // --- horns: torus arcs curving up and outward ---------------------------
    const hornGeo = track(new THREE.TorusGeometry(0.13, 0.038, 8, 12, 1.8));
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(hornGeo, hornMat);
      horn.position.set(side * 0.27, 0.86, 0);
      horn.rotation.y = side * 0.35;
      horn.rotation.z = side * -0.35;
      horn.castShadow = true;
      body.add(horn);
    }

    // --- face: bright eyes with glints, a big warm smile --------------------
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.09, 14, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.042, 10, 8));
    const glintGeo = track(new THREE.SphereGeometry(0.014, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.14, 0.76, 0.16);
      white.scale.set(1, 1.15, 0.5);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.135, 0.755, 0.2);
      body.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.12, 0.775, 0.225);
      body.add(glint);
    }

    const mouthGeo = track(new THREE.TorusGeometry(0.095, 0.018, 6, 14, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.6, 0.18);
    mouth.rotation.z = Math.PI;
    body.add(mouth);

    if (flynn) {
      // The nemesis kit: slanted brows and a handlebar moustache whose
      // tips curl upward with unmistakable intent.
      const browGeo = track(new THREE.BoxGeometry(0.13, 0.03, 0.02));
      for (const side of [-1, 1]) {
        const brow = new THREE.Mesh(browGeo, hornMat);
        brow.position.set(side * 0.14, 0.9, 0.21);
        brow.rotation.z = side * 0.35; // inner ends low: villain scowl
        body.add(brow);
      }
      const stacheGeo = track(new THREE.TorusGeometry(0.055, 0.016, 6, 10, 2.0));
      for (const side of [-1, 1]) {
        const stache = new THREE.Mesh(stacheGeo, hornMat);
        stache.position.set(side * 0.065, 0.655, 0.2);
        stache.rotation.z = side === -1 ? Math.PI * 0.95 : Math.PI * 1.05 - 2.0;
        body.add(stache);
      }
    }

    // --- bow tie at the top of the waistcoat's V -----------------------------
    const tieWingGeo = track(new THREE.ConeGeometry(0.045, 0.09, 4));
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(tieWingGeo, tieMat);
      wing.position.set(side * 0.055, 0.47, 0.185);
      wing.rotation.z = side * (Math.PI / 2);
      body.add(wing);
    }
    const knotGeo = track(new THREE.SphereGeometry(0.028, 8, 6));
    const knot = new THREE.Mesh(knotGeo, tieMat);
    knot.position.set(0, 0.47, 0.19);
    body.add(knot);

    // --- limbs: same stick rig as Hughes, in blue ----------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.4, 8));
    armGeo.translate(0, -0.2, 0);
    const handGeo = track(new THREE.SphereGeometry(0.052, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, 0.5, 0);
      pivot.rotation.z = -side * 0.45;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, handMat);
      hand.position.set(0, -0.42, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    const legGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.5, 8));
    legGeo.translate(0, -0.25, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.075, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, -0.05, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.52, 0.04);
      shoe.scale.set(1.15, 0.55, 1.9);
      shoe.castShadow = true;
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Rhombus the Hat — a resolutely two-dimensional rhombus wearing an
   * excellent top hat. No limbs; he waddle-rocks along on his bottom
   * vertex and is nearly invisible side-on, which he considers a feature.
   */
  buildRhombus() {
    const root = new THREE.Group();
    root.name = 'rhombus';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const bodyMat = track(createToonMaterial({
      color: 0xe8509a,
      rim: { color: 0xffb6dd, strength: 0.6, threshold: 0.5 }
    }));
    const hatMat = track(createToonMaterial({
      color: 0x1a1a1e,
      rim: { color: 0x9db4e8, strength: 0.4, threshold: 0.6 }
    }));
    const bandMat = track(createToonMaterial({ color: 0xc03038 }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x5a1030 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the rhombus: an extruded diamond, paper-thin ----------------------
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.6);
    shape.lineTo(0.38, 0);
    shape.lineTo(0, -0.6);
    shape.lineTo(-0.38, 0);
    shape.closePath();
    const rhombGeo = track(new THREE.ExtrudeGeometry(shape, {
      depth: 0.07,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 1
    }));
    rhombGeo.translate(0, 0, -0.035);
    const rhomb = new THREE.Mesh(rhombGeo, bodyMat);
    rhomb.position.y = 0.02; // bottom vertex kisses the turf
    rhomb.castShadow = true;
    body.add(rhomb);
    this.rockMesh = rhomb;

    // Face lives on the rhombus so it rocks along with him.
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.07, 12, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.032, 10, 8));
    const glintGeo = track(new THREE.SphereGeometry(0.012, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.1, 0.16, 0.05);
      white.scale.set(1, 1.2, 0.5);
      rhomb.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.1, 0.15, 0.085);
      rhomb.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.085, 0.175, 0.1);
      rhomb.add(glint);
    }
    const mouthGeo = track(new THREE.TorusGeometry(0.06, 0.013, 6, 12, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, -0.02, 0.06);
    mouth.rotation.z = Math.PI;
    rhomb.add(mouth);

    // --- THE hat: a proper top hat at a rakish tilt --------------------------
    const hat = new THREE.Group();
    hat.position.set(0.02, 0.62, 0);
    hat.rotation.z = -0.14;
    rhomb.add(hat); // on the top vertex, rocking with the body

    const brimGeo = track(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 16));
    const brim = new THREE.Mesh(brimGeo, hatMat);
    brim.castShadow = true;
    hat.add(brim);
    const crownGeo = track(new THREE.CylinderGeometry(0.1, 0.11, 0.2, 14));
    const crown = new THREE.Mesh(crownGeo, hatMat);
    crown.position.y = 0.11;
    crown.castShadow = true;
    hat.add(crown);
    const hatBandGeo = track(new THREE.CylinderGeometry(0.112, 0.115, 0.05, 14));
    const hatBand = new THREE.Mesh(hatBandGeo, bandMat);
    hatBand.position.y = 0.04;
    hat.add(hatBand);

    this.legs = []; // limbs are for the three-dimensional
    return root;
  }

  /**
   * Alien Ginsberg — a small green poet from beyond, complete with beret,
   * round spectacles perched on enormous void-black eyes, a wise little
   * beard, glowing antennae, and a notebook that never leaves his hand.
   */
  buildGinsberg() {
    const root = new THREE.Group();
    root.name = 'ginsberg';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const skinMat = track(createToonMaterial({
      color: 0x8fd8a0,
      rim: { color: 0xd0ffe0, strength: 0.4, threshold: 0.6 }
    }));
    const limbMat = track(createToonMaterial({ color: 0x5aa070 }));
    const eyeMat = track(createToonMaterial({
      color: 0x0a0a12,
      rim: { color: 0x9db4e8, strength: 0.6, threshold: 0.42 }
    }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.7 }));
    const beretMat = track(createToonMaterial({ color: 0x2a2a38 }));
    const frameMat = track(createToonMaterial({ color: 0x3a3a44 }));
    const beardMat = track(createToonMaterial({ color: 0x4a4a52 }));
    const bulbMat = track(createToonMaterial({
      color: 0xb0ffd0,
      emissive: 0x50e890,
      emissiveIntensity: 1.4,
      pulse: { speed: 2.4, phase: 0 }
    }));
    const bookMat = track(createToonMaterial({ color: 0xe8ddc0 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- slight torso, enormous head -----------------------------------------
    const torsoGeo = track(new THREE.SphereGeometry(0.26, 20, 16));
    const torso = new THREE.Mesh(torsoGeo, skinMat);
    torso.position.y = 0.25;
    torso.scale.set(0.95, 1.2, 0.8);
    torso.castShadow = true;
    body.add(torso);

    const headGeo = track(new THREE.SphereGeometry(0.34, 26, 20));
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 0.85;
    head.scale.set(1.05, 1.15, 0.95);
    head.castShadow = true;
    body.add(head);

    // --- void-black almond eyes with glints, spectacles perched on top -------
    const eyeGeo = track(new THREE.SphereGeometry(0.12, 14, 12));
    const glintGeo = track(new THREE.SphereGeometry(0.025, 8, 6));
    const frameGeo = track(new THREE.TorusGeometry(0.085, 0.012, 6, 14));
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(side * 0.14, 0.88, 0.24);
      eye.scale.set(1.05, 1.6, 0.5);
      eye.rotation.z = side * -0.25;
      body.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.11, 0.95, 0.31);
      body.add(glint);
      const frame = new THREE.Mesh(frameGeo, frameMat);
      frame.position.set(side * 0.13, 0.86, 0.3);
      body.add(frame);
    }
    const bridgeGeo = track(new THREE.CylinderGeometry(0.01, 0.01, 0.09, 5));
    const bridge = new THREE.Mesh(bridgeGeo, frameMat);
    bridge.position.set(0, 0.86, 0.31);
    bridge.rotation.z = Math.PI / 2;
    body.add(bridge);

    // --- the poet's beard ------------------------------------------------------
    const beardGeo = track(new THREE.SphereGeometry(0.11, 12, 10));
    const beard = new THREE.Mesh(beardGeo, beardMat);
    beard.position.set(0, 0.62, 0.22);
    beard.scale.set(1.1, 1.3, 0.7);
    body.add(beard);

    // --- beret at maximum tilt, antennae poking through -----------------------
    const beretGeo = track(new THREE.CylinderGeometry(0.24, 0.28, 0.08, 14));
    const beret = new THREE.Mesh(beretGeo, beretMat);
    beret.position.set(-0.08, 1.2, -0.02);
    beret.rotation.z = 0.28;
    beret.castShadow = true;
    body.add(beret);
    const nubGeo = track(new THREE.SphereGeometry(0.03, 6, 5));
    const nub = new THREE.Mesh(nubGeo, beretMat);
    nub.position.set(-0.1, 1.26, -0.02);
    body.add(nub);

    const antennaGeo = track(new THREE.CylinderGeometry(0.014, 0.018, 0.26, 6));
    const bulbGeo = track(new THREE.SphereGeometry(0.045, 8, 6));
    for (const side of [-1, 1]) {
      const antenna = new THREE.Mesh(antennaGeo, limbMat);
      antenna.position.set(side * 0.16, 1.32, 0);
      antenna.rotation.z = side * -0.35;
      body.add(antenna);
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(side * 0.21, 1.45, 0);
      body.add(bulb);
    }

    // --- stick limbs; the left hand clutches the notebook ---------------------
    const armGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.36, 8));
    armGeo.translate(0, -0.18, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.22, 0.42, 0);
      pivot.rotation.z = -side * 0.35;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, skinMat);
      hand.position.set(0, -0.38, 0);
      pivot.add(hand);
      if (side === -1) {
        const bookGeo = track(new THREE.BoxGeometry(0.13, 0.17, 0.035));
        const book = new THREE.Mesh(bookGeo, bookMat);
        book.position.set(0, -0.4, 0.06);
        book.rotation.x = -0.3;
        pivot.add(book);
      }
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    const legGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.48, 8));
    legGeo.translate(0, -0.24, 0);
    const footGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.12, -0.03, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const foot = new THREE.Mesh(footGeo, limbMat);
      foot.position.set(0, -0.5, 0.04);
      foot.scale.set(1.1, 0.55, 1.7);
      pivot.add(foot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Magnus Carter — the elf himself, finally out from behind the wheel.
   * Green tunic with a belt and buckle, pointed ears, a red cap with a
   * white pom, and the smug grin of a man with zero driving convictions.
   */
  buildMagnus() {
    const root = new THREE.Group();
    root.name = 'magnus';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const skinMat = track(createToonMaterial({
      color: 0xf0c090,
      rim: { color: 0xffe0c0, strength: 0.35, threshold: 0.62 }
    }));
    const suitMat = track(createToonMaterial({
      color: 0x3f8f3f,
      rim: { color: 0xa0e8a0, strength: 0.4, threshold: 0.6 }
    }));
    const suitDarkMat = track(createToonMaterial({ color: 0x2f6f2f }));
    const hatMat = track(createToonMaterial({
      color: 0xc03038,
      rim: { color: 0xff9a8a, strength: 0.4, threshold: 0.58 }
    }));
    const pomMat = track(createToonMaterial({ color: 0xf2f0e8 }));
    const beltMat = track(createToonMaterial({ color: 0x2a2018 }));
    const buckleMat = track(createToonMaterial({
      color: 0xf5c542,
      emissive: 0x4a3300,
      emissiveIntensity: 1.0
    }));
    const eyeMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x6a2a20 }));
    const shoeMat = track(createToonMaterial({ color: 0x4a3018 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- tunic with belt and buckle -----------------------------------------
    const tunicGeo = track(new THREE.ConeGeometry(0.3, 0.74, 12));
    const tunic = new THREE.Mesh(tunicGeo, suitMat);
    tunic.position.y = 0.37;
    tunic.castShadow = true;
    body.add(tunic);

    const beltGeo = track(new THREE.CylinderGeometry(0.235, 0.255, 0.07, 12));
    const belt = new THREE.Mesh(beltGeo, beltMat);
    belt.position.y = 0.28;
    body.add(belt);
    const buckleGeo = track(new THREE.BoxGeometry(0.07, 0.06, 0.02));
    const buckle = new THREE.Mesh(buckleGeo, buckleMat);
    buckle.position.set(0, 0.28, 0.24);
    body.add(buckle);

    // --- head, ears, face ------------------------------------------------------
    const headGeo = track(new THREE.SphereGeometry(0.21, 20, 16));
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 0.88;
    head.castShadow = true;
    body.add(head);

    const noseGeo = track(new THREE.SphereGeometry(0.035, 8, 6));
    const nose = new THREE.Mesh(noseGeo, skinMat);
    nose.position.set(0, 0.86, 0.2);
    body.add(nose);

    const eyeGeo = track(new THREE.SphereGeometry(0.032, 8, 6));
    const glintGeo = track(new THREE.SphereGeometry(0.011, 6, 5));
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(side * 0.075, 0.91, 0.18);
      body.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.065, 0.925, 0.2);
      body.add(glint);
    }

    // The grin of the untouchable.
    const mouthGeo = track(new THREE.TorusGeometry(0.05, 0.011, 6, 10, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.81, 0.185);
    mouth.rotation.z = Math.PI;
    body.add(mouth);

    const earGeo = track(new THREE.ConeGeometry(0.035, 0.14, 6));
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(earGeo, skinMat);
      ear.position.set(side * 0.22, 0.92, 0);
      ear.rotation.z = side * -(Math.PI / 2 + 0.35);
      body.add(ear);
    }

    // --- the famous red cap ------------------------------------------------------
    const bandGeo = track(new THREE.CylinderGeometry(0.215, 0.22, 0.06, 12));
    const band = new THREE.Mesh(bandGeo, pomMat);
    band.position.y = 1.02;
    body.add(band);
    const capGeo = track(new THREE.ConeGeometry(0.2, 0.4, 12));
    const cap = new THREE.Mesh(capGeo, hatMat);
    cap.position.set(-0.03, 1.2, 0);
    cap.rotation.z = 0.22;
    cap.castShadow = true;
    body.add(cap);
    const pomGeo = track(new THREE.SphereGeometry(0.05, 8, 6));
    const pom = new THREE.Mesh(pomGeo, pomMat);
    pom.position.set(-0.12, 1.38, 0);
    body.add(pom);

    // --- limbs -------------------------------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.36, 8));
    armGeo.translate(0, -0.18, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.24, 0.55, 0);
      pivot.rotation.z = -side * 0.4;
      const arm = new THREE.Mesh(armGeo, suitDarkMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, skinMat);
      hand.position.set(0, -0.38, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    const legGeo = track(new THREE.CylinderGeometry(0.035, 0.035, 0.46, 8));
    legGeo.translate(0, -0.23, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.11, -0.05, 0);
      const leg = new THREE.Mesh(legGeo, suitDarkMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.48, 0.05);
      shoe.scale.set(1.1, 0.55, 1.8);
      shoe.castShadow = true;
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Error #42 — what happens when the character loader segfaults. One of
   * everything: badger head on a half-foil, half-block torso; one googly
   * eye, one alien eye; one horn, one antenna; one badger ear, one elf
   * ear; half a moustache; ginger locks and a half-cape sharing a sway
   * rig; a crown point at a wrong angle; Edith's faucet out of the back;
   * mismatched limbs; and an intermittent positional glitch, obviously.
   */
  buildError42() {
    const root = new THREE.Group();
    root.name = 'error42';
    this.isGlitchy = true;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const torsoMat = track(createToonMaterial({
      vertexColors: true,
      rim: { color: 0x00ffcc, strength: 0.45, threshold: 0.55 }
    }));
    const furMat = track(createToonMaterial({ vertexColors: true, rim: { color: 0xcfe0ff, strength: 0.25, threshold: 0.72 } }));
    const darkMat = track(createToonMaterial({ color: 0x26262c }));
    const skinMat = track(createToonMaterial({ color: 0xf0c090 }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const alienEyeMat = track(createToonMaterial({ color: 0x0a0a12, rim: { color: 0x9db4e8, strength: 0.6, threshold: 0.42 } }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const hairMat = track(createToonMaterial({ color: 0xc96a22, rim: { color: 0xffb36e, strength: 0.45, threshold: 0.6 } }));
    const capeMat = track(createToonMaterial({ color: 0xa02030 }));
    capeMat.side = THREE.DoubleSide;
    const goldMat = track(createToonMaterial({ color: 0xf5c542, emissive: 0x4a3300, emissiveIntensity: 1.0 }));
    const chromeMat = track(createToonMaterial({ color: 0xb8c0cc, rim: { color: 0xffffff, strength: 0.6, threshold: 0.5 } }));
    const bulbMat = track(createToonMaterial({ color: 0xb0ffd0, emissive: 0x50e890, emissiveIntensity: 1.4, pulse: { speed: 5.1, phase: 0 } }));
    const stickBlueMat = track(createToonMaterial({ color: 0x2f7fc0 }));
    const birdLegMat = track(createToonMaterial({ color: 0xd8a020 }));
    const shoeMat = track(createToonMaterial({ color: 0xd8362a }));
    const mouthMat = track(createToonMaterial({ color: 0x3a1410 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- torso: foil on the left, block on the right, glitch seam ----------
    const torsoGeo = track(new THREE.BoxGeometry(0.66, 0.9, 0.32, 8, 10, 4));
    {
      const pos = torsoGeo.attributes.position;
      const nor = torsoGeo.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      const foilRed = new THREE.Color(0xd8362a);
      const foilSilver = new THREE.Color(0xc4c6ce);
      const blockBlue = new THREE.Color(0x3aa0e8);
      const vest = new THREE.Color(0x7a3fa8);
      const seam = new THREE.Color(0x00ffcc);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const py = pos.getY(i) / 0.45; // -1..1
        if (Math.abs(x) < 0.025) {
          c.copy(seam); // the corrupted byte boundary
        } else if (x < 0) {
          // Hughes half: red foil with a silver crimp band up top.
          c.copy(py > 0.72 ? foilSilver : foilRed);
          c.offsetHSL(0, 0, (furNoise(x * 9, py * 9, pos.getZ(i) * 9) - 0.5) * 0.1);
        } else {
          // Boffington half: blue with the waistcoat's lower purple.
          c.copy(py < -0.1 ? vest : blockBlue);
        }
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      torsoGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      // Crinkle only the foil half.
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        if (x < -0.03) {
          const wob = 1 + (furNoise(x * 8 + 2, pos.getY(i) * 8, pos.getZ(i) * 8) - 0.5) * 0.12;
          pos.setZ(i, pos.getZ(i) * wob);
        }
      }
      torsoGeo.computeVertexNormals();
    }
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 0.4;
    torso.castShadow = true;
    body.add(torso);

    // --- Edith's faucet, out of the back, why not --------------------------
    const stemGeo = track(new THREE.CylinderGeometry(0.03, 0.035, 0.22, 8));
    const stem = new THREE.Mesh(stemGeo, chromeMat);
    stem.position.set(0.12, 0.92, -0.14);
    body.add(stem);
    const neckGeo = track(new THREE.TorusGeometry(0.09, 0.025, 8, 12, Math.PI));
    const neck = new THREE.Mesh(neckGeo, chromeMat);
    neck.position.set(0.12, 1.03, -0.05);
    neck.rotation.y = Math.PI / 2;
    neck.rotation.z = Math.PI / 2;
    body.add(neck);

    // --- badger head, slightly too small for the body ----------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.06, 0.06);
    body.add(headGroup);
    this.headGroup = headGroup;

    const headGeo = track(new THREE.SphereGeometry(0.42, 32, 24));
    paintVertexColors(headGeo, (n, p, c) => {
      const cream = new THREE.Color(0xf4efe2);
      const black = new THREE.Color(0x17171b);
      const grey = new THREE.Color(0x84888f);
      const stripeBand =
        THREE.MathUtils.smoothstep(Math.abs(n.x), 0.13, 0.2) *
        (1 - THREE.MathUtils.smoothstep(Math.abs(n.x), 0.42, 0.52));
      const frontHalf = THREE.MathUtils.smoothstep(n.z, -0.35, -0.1);
      const aboveJaw = THREE.MathUtils.smoothstep(n.y, -0.5, -0.28);
      const rear = THREE.MathUtils.smoothstep(-n.z, 0.45, 0.8);
      c.copy(cream).lerp(black, stripeBand * frontHalf * aboveJaw).lerp(grey, rear * 0.85);
    });
    const head = new THREE.Mesh(headGeo, furMat);
    head.scale.set(0.78, 0.72, 0.9);
    head.castShadow = true;
    headGroup.add(head);

    // --- mismatched eyes: googly left, alien almond right -------------------
    const googlyWhiteGeo = track(new THREE.SphereGeometry(0.09, 12, 10));
    const googlyWhite = new THREE.Mesh(googlyWhiteGeo, eyeWhiteMat);
    googlyWhite.position.set(-0.13, 0.05, 0.27);
    googlyWhite.scale.set(1, 1, 0.45);
    headGroup.add(googlyWhite);
    const pupilGeo = track(new THREE.SphereGeometry(0.04, 10, 8));
    const pupil = new THREE.Mesh(pupilGeo, pupilMat);
    pupil.position.set(-0.13, 0.05, 0.31);
    headGroup.add(pupil);
    this.googlyEyes = [{ pupil, baseX: -0.13, baseY: 0.05, seed: 4.2 }];

    const alienEyeGeo = track(new THREE.SphereGeometry(0.1, 14, 12));
    const alienEye = new THREE.Mesh(alienEyeGeo, alienEyeMat);
    alienEye.position.set(0.14, 0.06, 0.26);
    alienEye.scale.set(1.0, 1.5, 0.5);
    alienEye.rotation.z = -0.25;
    headGroup.add(alienEye);
    const glintGeo = track(new THREE.SphereGeometry(0.02, 8, 6));
    const glint = new THREE.Mesh(glintGeo, glintMat);
    glint.position.set(0.11, 0.12, 0.31);
    headGroup.add(glint);

    // --- crooked smile + half a moustache -----------------------------------
    const mouthGeo = track(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0.01, -0.14, 0.28);
    mouth.rotation.z = Math.PI * 0.88; // smile, but corrupted
    headGroup.add(mouth);
    const stacheGeo = track(new THREE.TorusGeometry(0.05, 0.015, 6, 10, 2.0));
    const stache = new THREE.Mesh(stacheGeo, darkMat);
    stache.position.set(0.07, -0.08, 0.28);
    stache.rotation.z = Math.PI * 1.05 - 2.0;
    headGroup.add(stache);

    // --- one horn, one antenna; one badger ear, one elf ear ------------------
    const hornGeo = track(new THREE.TorusGeometry(0.11, 0.032, 8, 12, 1.8));
    const horn = new THREE.Mesh(hornGeo, darkMat);
    horn.position.set(-0.2, 0.24, 0);
    horn.rotation.y = -0.35;
    horn.rotation.z = 0.35;
    headGroup.add(horn);

    const antennaGeo = track(new THREE.CylinderGeometry(0.014, 0.018, 0.24, 6));
    const antenna = new THREE.Mesh(antennaGeo, stickBlueMat);
    antenna.position.set(0.18, 0.34, 0);
    antenna.rotation.z = -0.3;
    headGroup.add(antenna);
    const bulbGeo = track(new THREE.SphereGeometry(0.045, 8, 6));
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(0.22, 0.46, 0);
    headGroup.add(bulb);

    const earGeo = track(new THREE.SphereGeometry(0.09, 12, 10));
    const badgerEar = new THREE.Mesh(earGeo, darkMat);
    badgerEar.position.set(0.24, 0.22, -0.04);
    badgerEar.scale.set(1, 1.05, 0.6);
    headGroup.add(badgerEar);
    const elfEarGeo = track(new THREE.ConeGeometry(0.035, 0.14, 6));
    const elfEar = new THREE.Mesh(elfEarGeo, skinMat);
    elfEar.position.set(-0.3, 0.02, 0);
    elfEar.rotation.z = Math.PI / 2 + 0.35;
    headGroup.add(elfEar);

    // --- a single crown point, installed incorrectly --------------------------
    const pointGeo = track(new THREE.ConeGeometry(0.045, 0.14, 6));
    const crownPoint = new THREE.Mesh(pointGeo, goldMat);
    crownPoint.position.set(0.02, 0.3, -0.18);
    crownPoint.rotation.x = 0.7;
    headGroup.add(crownPoint);

    // --- ginger locks AND a half-cape on one shared sway pivot ----------------
    const hairGroup = new THREE.Group();
    hairGroup.position.set(0, 0.2, -0.14);
    headGroup.add(hairGroup);
    this.hairGroup = hairGroup;
    for (let i = 0; i < 2; i++) {
      const t = i === 0 ? -0.4 : 0.9;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(t * 0.12, 0.1, 0.02),
        new THREE.Vector3(t * 0.2, -0.2, -0.24),
        new THREE.Vector3(t * 0.24, -0.55, -0.4)
      ]);
      const tubeGeo = track(new THREE.TubeGeometry(curve, 12, 0.045, 6, false));
      const strand = new THREE.Mesh(tubeGeo, hairMat);
      hairGroup.add(strand);
    }
    const capeGeo = track(new THREE.PlaneGeometry(0.34, 0.7, 3, 5));
    {
      const pos = capeGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const drop = (0.35 - pos.getY(i)) / 0.7;
        pos.setZ(i, -drop * drop * 0.5);
      }
      capeGeo.computeVertexNormals();
    }
    const cape = new THREE.Mesh(capeGeo, capeMat);
    cape.position.set(-0.18, -0.62, -0.1);
    cape.rotation.x = 0.3;
    hairGroup.add(cape);

    // --- limbs: one blue stick arm, one orange; stick leg + bird leg -----------
    const armGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.4, 8));
    armGeo.translate(0, -0.2, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    const armMats = [stickBlueMat, birdLegMat];
    this.arms = [];
    [-1, 1].forEach((side, i) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.36, 0.55, 0);
      pivot.rotation.z = -side * 0.45;
      const arm = new THREE.Mesh(armGeo, armMats[i]);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, armMats[i]);
      hand.position.set(0, -0.42, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    });

    this.legs = [];
    {
      // Left: Hughes' stick leg with the jaunty red shoe.
      const legGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.5, 8));
      legGeo.translate(0, -0.25, 0);
      const pivot = new THREE.Group();
      pivot.position.set(-0.13, -0.05, 0);
      const leg = new THREE.Mesh(legGeo, darkMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoeGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.52, 0.04);
      shoe.scale.set(1.15, 0.55, 1.9);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: 0 });
    }
    {
      // Right: Edith's bird leg, toes and all.
      const thighGeo = track(new THREE.CylinderGeometry(0.03, 0.026, 0.28, 7));
      thighGeo.translate(0, -0.14, 0);
      const pivot = new THREE.Group();
      pivot.position.set(0.15, -0.05, 0);
      const thigh = new THREE.Mesh(thighGeo, birdLegMat);
      thigh.rotation.x = 0.3;
      thigh.castShadow = true;
      pivot.add(thigh);
      const shinGeo = track(new THREE.CylinderGeometry(0.022, 0.025, 0.26, 7));
      const shin = new THREE.Mesh(shinGeo, birdLegMat);
      shin.position.set(0, -0.38, -0.05);
      shin.rotation.x = -0.25;
      pivot.add(shin);
      const toeGeo = track(new THREE.ConeGeometry(0.018, 0.12, 5));
      for (const toe of [-0.5, 0, 0.5]) {
        const t = new THREE.Mesh(toeGeo, birdLegMat);
        t.position.set(Math.sin(toe) * 0.045, -0.51, 0.05);
        t.rotation.x = Math.PI / 2 - 0.15;
        t.rotation.z = -toe * 0.8;
        pivot.add(t);
      }
      body.add(pivot);
      this.legs.push({ pivot, phase: Math.PI });
    }

    return root;
  }

  /**
   * Error #43 — her sister's fault, one release later. Where Error #42
   * segfaulted across the ten heroes before her, #43 collided with the ten
   * that came after: Mayonnaise's cream jar and gold lid fused down the
   * seam with Jam's berry preserve and gingham cap; Dodecahedron's beret
   * over one temple and Turnip Scart's curved horn out of the other;
   * Margaret's button eye and puppet strings on one side, Julie's masked
   * blue eye and gold flower tag on the other; a tier of President Fir
   * Tree's conifer with his red tie and star of office; Marblella's glass
   * marble lodged in her middle; the Perpendicular Bird's flat sketch wing
   * locked at a textbook right angle; and a Haunted Sweatshirt sleeve
   * dangling where an arm ought to be. Glitches, obviously — it runs in
   * the family.
   */
  buildError43() {
    const root = new THREE.Group();
    root.name = 'error43';
    this.isGlitchy = true;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // --- the palette, one entry per donor ---------------------------------
    const seamMat = track(createToonMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.8 }));
    const torsoMat = track(createToonMaterial({
      vertexColors: true,
      rim: { color: 0x00ffcc, strength: 0.45, threshold: 0.55 }
    }));
    const creamMat = track(createToonMaterial({ color: 0xf2e6c2 }));            // Mayo
    const goldMat = track(createToonMaterial({ color: 0xf5c542, emissive: 0x4a3300, emissiveIntensity: 0.9 }));
    const berryMat = track(createToonMaterial({ color: 0x6a2a55 }));            // Jam
    const ginghamMat = track(createToonMaterial({ color: 0xc85a6a }));
    const beretMat = track(createToonMaterial({ color: 0x2f3d78 }));            // Dodeca
    const hornMat = track(createToonMaterial({ color: 0xcbb489 }));             // Turnip Scart
    const goatCreamMat = track(createToonMaterial({ color: 0xefe4cc }));
    const woodMat = track(createToonMaterial({ color: 0xd8b483 }));             // Margaret
    const buttonMat = track(createToonMaterial({ color: 0xe8d8b0 }));
    const stringMat = track(createToonMaterial({ color: 0xe8e0cc }));
    const doodleGreyMat = track(createToonMaterial({ color: 0x9aa0a8, rim: { color: 0xe8eef4, strength: 0.35, threshold: 0.66 } })); // Julie
    const doodleBlackMat = track(createToonMaterial({ color: 0x1c1c22 }));
    const blueEyeMat = track(createToonMaterial({ color: 0x4aa8e8 }));
    const firMat = track(createToonMaterial({ color: 0x2f6b46, rim: { color: 0x9fe0b0, strength: 0.35, threshold: 0.62 } })); // Fir Tree
    const tieMat = track(createToonMaterial({ color: 0xb02434 }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const paperMat = track(createToonMaterial({ color: 0xf6f2e6 }));            // Perpendicular Bird
    paperMat.side = THREE.DoubleSide;
    const inkMat = track(createToonMaterial({ color: 0x2a2620 }));
    const marbleMat = track(createToonMaterial({                                // Marblella
      color: 0xbfe4f2, emissive: 0x2f6f9a, emissiveIntensity: 0.5,
      rim: { color: 0xffffff, strength: 0.7, threshold: 0.42 }
    }));
    marbleMat.transparent = true;
    marbleMat.opacity = 0.72;
    const spectralMat = track(createToonMaterial({                              // Haunted Sweatshirt
      color: 0x6a8fd0, emissive: 0x2a4a90, emissiveIntensity: 0.7,
      rim: { color: 0xbfd8ff, strength: 0.6, threshold: 0.5 }
    }));
    spectralMat.transparent = true;
    spectralMat.opacity = 0.55;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- torso: Mayo's jar on the left, Jam's preserve on the right --------
    const torsoGeo = track(new THREE.CylinderGeometry(0.34, 0.36, 0.86, 18, 8));
    {
      const pos = torsoGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      const cream = new THREE.Color(0xf2e6c2);
      const label = new THREE.Color(0xdfd0a4);
      const berry = new THREE.Color(0x6a2a55);
      const berryDark = new THREE.Color(0x4d1c3e);
      const seam = new THREE.Color(0x00ffcc);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const py = pos.getY(i) / 0.43; // -1..1
        if (Math.abs(x) < 0.035) {
          c.copy(seam); // the corrupted byte boundary, same as her sister's
        } else if (x < 0) {
          c.copy(Math.abs(py) < 0.34 ? label : cream); // Mayo's wraparound label
        } else {
          c.copy(py < -0.2 ? berryDark : berry);       // Jam settles darker
        }
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      torsoGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 0.4;
    torso.castShadow = true;
    body.add(torso);

    // Mayo's gold lid over her left shoulder; Jam's gingham cap over the right.
    const lid = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14, 1, false, Math.PI / 2, Math.PI)), goldMat);
    lid.position.set(0, 0.86, 0);
    body.add(lid);
    const capCloth = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 14, 10, Math.PI * 1.5, Math.PI, 0, Math.PI * 0.5)), ginghamMat);
    capCloth.position.set(0, 0.84, 0);
    capCloth.scale.set(1, 0.7, 1);
    body.add(capCloth);
    const capString = new THREE.Mesh(track(new THREE.TorusGeometry(0.19, 0.016, 6, 16, Math.PI)), stringMat);
    capString.position.set(0, 0.8, 0);
    capString.rotation.set(Math.PI / 2, 0, Math.PI);
    body.add(capString);

    // --- a tier of President Fir Tree, worn as a collar, tie and all -------
    const firTier = new THREE.Mesh(track(new THREE.ConeGeometry(0.42, 0.34, 9)), firMat);
    firTier.position.y = 0.66;
    firTier.castShadow = true;
    body.add(firTier);
    const tie = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.28, 0.05)), tieMat);
    tie.position.set(0.02, 0.42, 0.35);
    tie.rotation.z = 0.1;
    body.add(tie);
    const seal = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 10)), goldMat);
    seal.position.set(0.02, 0.52, 0.37);
    seal.rotation.x = Math.PI / 2;
    body.add(seal);

    // --- Marblella's marble, lodged in her middle where a stomach goes -----
    const marble = new THREE.Mesh(track(new THREE.SphereGeometry(0.17, 16, 14)), marbleMat);
    marble.position.set(-0.04, 0.3, 0.28);
    body.add(marble);
    const twist = new THREE.Mesh(track(new THREE.TorusKnotGeometry(0.07, 0.028, 40, 6, 2, 3)), tieMat);
    twist.position.copy(marble.position);
    body.add(twist);

    // --- the seam itself, running up the front ------------------------------
    const seamStrip = new THREE.Mesh(track(new THREE.BoxGeometry(0.02, 0.88, 0.02)), seamMat);
    seamStrip.position.set(0, 0.4, 0.36);
    body.add(seamStrip);

    // --- head: wooden puppet on the left, shaggy doodle on the right -------
    const head = new THREE.Group();
    head.position.y = 1.02;
    body.add(head);
    this.headGroup = head;
    const skullL = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 14, Math.PI / 2, Math.PI)), woodMat);
    skullL.castShadow = true;
    head.add(skullL);
    const skullR = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 14, Math.PI * 1.5, Math.PI)), doodleGreyMat);
    skullR.castShadow = true;
    head.add(skullR);
    // Julie's dark patches over her half of the coat.
    for (const [px, py] of [[0.2, 0.12], [0.14, -0.1], [0.25, -0.02]]) {
      const patch = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 8, 6)), doodleBlackMat);
      patch.position.set(px, py, 0.2);
      patch.scale.set(1, 0.8, 0.35);
      head.add(patch);
    }
    // The glitch seam continues over the crown.
    const headSeam = new THREE.Mesh(track(new THREE.BoxGeometry(0.015, 0.62, 0.02)), seamMat);
    headSeam.position.set(0, 0, 0.28);
    head.add(headSeam);

    // Margaret's button eye (left) and Julie's masked blue eye (right).
    this.googlyEyes = [];
    const button = new THREE.Mesh(track(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 12)), buttonMat);
    button.position.set(-0.13, 0.06, 0.27);
    button.rotation.x = Math.PI / 2;
    head.add(button);
    for (const hx of [-0.025, 0.025]) {
      const hole = new THREE.Mesh(track(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 6)), pupilMat);
      hole.position.set(-0.13 + hx, 0.06, 0.29);
      hole.rotation.x = Math.PI / 2;
      head.add(hole);
    }
    const mask = new THREE.Mesh(track(new THREE.SphereGeometry(0.12, 10, 8)), doodleBlackMat);
    mask.position.set(0.13, 0.06, 0.22);
    mask.scale.set(1, 0.9, 0.4);
    head.add(mask);
    const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.072, 12, 10)), blueEyeMat);
    white.position.set(0.13, 0.06, 0.27);
    head.add(white);
    const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), pupilMat);
    pupil.position.set(0.13, 0.06, 0.33);
    head.add(pupil);
    this.googlyEyes.push({ pupil, baseX: 0.13, baseY: 0.06, seed: Math.random() * 6.28 });

    // Julie's black button nose, and Turnip Scart's chin beard below.
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 8, 6)), doodleBlackMat);
    nose.position.set(0.06, -0.1, 0.3);
    head.add(nose);
    const beard = new THREE.Mesh(track(new THREE.ConeGeometry(0.07, 0.2, 6)), goatCreamMat);
    beard.position.set(-0.08, -0.28, 0.18);
    beard.rotation.x = 0.3;
    head.add(beard);

    // Turnip Scart's curved horn (right) and floppy ear; Dodeca's beret (left).
    const hornPts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      hornPts.push(new THREE.Vector3(0.2 + t * 0.16, 0.26 + t * 0.26 - t * t * 0.2, -0.02 - t * 0.14));
    }
    const horn = new THREE.Mesh(
      track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hornPts), 14, 0.045, 6, false)),
      hornMat
    );
    horn.castShadow = true;
    head.add(horn);
    const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), doodleBlackMat);
    ear.position.set(0.29, 0.02, 0.02);
    ear.scale.set(0.5, 1.5, 0.7);
    ear.rotation.z = 0.4;
    head.add(ear);
    const beret = new THREE.Mesh(track(new THREE.SphereGeometry(0.26, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)), beretMat);
    beret.position.set(-0.1, 0.24, -0.02);
    beret.scale.set(1.15, 0.5, 1.1);
    beret.rotation.z = 0.3;
    beret.castShadow = true;
    head.add(beret);
    const beretStalk = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), beretMat);
    beretStalk.position.set(-0.12, 0.38, -0.02);
    head.add(beretStalk);
    // Fir Tree's star of office, askew on the crown because of course it is.
    const star = new THREE.Mesh(track(new THREE.ConeGeometry(0.07, 0.14, 5)), goldMat);
    star.position.set(0.12, 0.36, 0.04);
    star.rotation.z = -0.5;
    head.add(star);
    // Margaret's mop of string hair, spilling out of the left side.
    for (let i = 0; i < 6; i++) {
      const strand = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.008, 0.24, 5)), stringMat);
      strand.position.set(-0.24 + i * 0.03, 0.12 - i * 0.02, 0.06 - i * 0.04);
      strand.rotation.z = 0.5 + i * 0.08;
      head.add(strand);
    }

    // --- Margaret's control strings, rising to an unseen crossbar ----------
    for (const [sx, sz] of [[-0.26, 0.1], [0.26, 0.1], [-0.16, -0.2], [0.16, -0.2]]) {
      const str = new THREE.Mesh(track(new THREE.CylinderGeometry(0.006, 0.006, 1.5, 4)), stringMat);
      str.position.set(sx, 1.9, sz);
      str.rotation.z = -sx * 0.14;
      body.add(str);
    }

    // --- Julie's collar with the gold flower tag ---------------------------
    const collar = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.03, 8, 18)), tieMat);
    collar.position.y = 0.86;
    collar.rotation.x = Math.PI / 2;
    body.add(collar);
    const tag = new THREE.Mesh(track(new THREE.CylinderGeometry(0.055, 0.055, 0.018, 8)), goldMat);
    tag.position.set(0.06, 0.74, 0.2);
    tag.rotation.x = Math.PI / 2;
    body.add(tag);

    // --- arms: the Perpendicular Bird's sketch wing, and a spectral sleeve --
    this.arms = [];
    // Left: a flat drawn wing, locked perfectly horizontal, with its 90° mark.
    {
      const pivot = new THREE.Group();
      pivot.position.set(-0.38, 0.6, 0);
      const wing = new THREE.Mesh(track(new THREE.PlaneGeometry(0.46, 0.24)), paperMat);
      wing.position.set(-0.23, 0, 0);
      wing.rotation.y = 0.12;
      pivot.add(wing);
      // The right-angle marker: a little square bracket under the wing.
      for (const [bx, by, bw, bh] of [[-0.3, -0.14, 0.14, 0.014], [-0.37, -0.07, 0.014, 0.14]]) {
        const bar = new THREE.Mesh(track(new THREE.BoxGeometry(bw, bh, 0.012)), inkMat);
        bar.position.set(bx, by, 0.01);
        pivot.add(bar);
      }
      body.add(pivot);
      this.arms.push({ pivot, phase: Math.PI });
    }
    // Right: a limp, empty Haunted Sweatshirt sleeve.
    {
      const pivot = new THREE.Group();
      pivot.position.set(0.36, 0.66, 0);
      pivot.rotation.z = -0.28;
      const sleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.095, 0.075, 0.44, 10, 1, true)), spectralMat);
      sleeve.position.y = -0.22;
      pivot.add(sleeve);
      const cuff = new THREE.Mesh(track(new THREE.TorusGeometry(0.078, 0.022, 6, 12)), spectralMat);
      cuff.position.y = -0.44;
      cuff.rotation.x = Math.PI / 2;
      pivot.add(cuff);
      body.add(pivot);
      this.arms.push({ pivot, phase: 0 });
    }

    // --- legs: one puppet leg on a hoof, one spectral wisp ------------------
    this.legs = [];
    {
      // Margaret's jointed pine leg, ending in one of Scart's dark hooves.
      const pivot = new THREE.Group();
      pivot.position.set(-0.15, -0.03, 0);
      const legGeo = track(new THREE.CylinderGeometry(0.045, 0.04, 0.46, 8));
      legGeo.translate(0, -0.23, 0);
      const leg = new THREE.Mesh(legGeo, woodMat);
      leg.castShadow = true;
      pivot.add(leg);
      const knee = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 8, 6)), woodMat);
      knee.position.y = -0.23;
      pivot.add(knee);
      const hoof = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.075, 0.1, 8)), doodleBlackMat);
      hoof.position.y = -0.5;
      pivot.add(hoof);
      body.add(pivot);
      this.legs.push({ pivot, phase: 0 });
    }
    {
      // …and on the other side, nothing solid at all: a drifting hem.
      const pivot = new THREE.Group();
      pivot.position.set(0.15, -0.03, 0);
      const wisp = new THREE.Mesh(track(new THREE.ConeGeometry(0.13, 0.44, 10, 1, true)), spectralMat);
      wisp.position.y = -0.22;
      wisp.rotation.x = Math.PI;
      pivot.add(wisp);
      const hem = new THREE.Mesh(track(new THREE.TorusGeometry(0.115, 0.024, 6, 14)), spectralMat);
      hem.position.y = -0.04;
      hem.rotation.x = Math.PI / 2;
      pivot.add(hem);
      body.add(pivot);
      this.legs.push({ pivot, phase: Math.PI });
    }

    return root;
  }

  /**
   * The Nucleus Of Time Itself — an atom with opinions. A clustered core of
   * protons and neutrons wearing a suave feminine face, wrapped in three
   * tilted electron orbits whose particles race around them, lit from
   * within and dragging a soft trail of where it has just been. It floats
   * rather than walks, and every 25-30 seconds it simply gives up on being
   * here and turns up somewhere else entirely (see Game.nucleusHop).
   */
  buildNucleus() {
    const root = new THREE.Group();
    root.name = 'nucleus';
    this.isFloaty = true;
    this.hoverHeight = 0.7;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Emissive does the lifting here, since she carries no light of her own.
    const protonMat = track(createToonMaterial({
      color: 0xe8556a, emissive: 0xc23048, emissiveIntensity: 1.1,
      rim: { color: 0xffc0cc, strength: 0.7, threshold: 0.46 }
    }));
    const neutronMat = track(createToonMaterial({
      color: 0x9fb4d8, emissive: 0x4a70b0, emissiveIntensity: 0.9,
      rim: { color: 0xdfe8ff, strength: 0.65, threshold: 0.5 }
    }));
    const electronMat = track(createToonMaterial({
      color: 0x8fe8ff, emissive: 0x3fa8d8, emissiveIntensity: 1.1,
      pulse: { speed: 4.2, phase: 0 }
    }));
    const orbitMat = track(createToonMaterial({
      color: 0x6fd0ff, emissive: 0x2f9ad0, emissiveIntensity: 0.8
    }));
    orbitMat.transparent = true;
    orbitMat.opacity = 0.5;
    const skinMat = track(createToonMaterial({
      color: 0xf6dfe4, emissive: 0x6a3a48, emissiveIntensity: 0.25
    }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x1a1420 }));
    const lashMat = track(createToonMaterial({ color: 0x2a1a24 }));
    const lipMat = track(createToonMaterial({
      color: 0xd8425e, emissive: 0x6a1020, emissiveIntensity: 0.5
    }));
    const trailMat = track(createToonMaterial({
      color: 0x8fd8ff, emissive: 0x3fa8e0, emissiveIntensity: 1.0
    }));
    trailMat.transparent = true;
    trailMat.depthWrite = false;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the core: a clustered knot of protons and neutrons ----------------
    const core = new THREE.Group();
    body.add(core);
    this.headGroup = core; // the face rides the core, so let it lead the look
    const nucleonGeo = track(new THREE.SphereGeometry(0.15, 14, 12));
    const cluster = [
      [0, 0, 0, 1], [0.17, 0.08, 0.05, 0], [-0.16, 0.1, -0.04, 0],
      [0.05, -0.17, 0.08, 1], [-0.08, -0.14, -0.12, 0], [0.13, 0.02, -0.16, 1],
      [-0.14, -0.02, 0.15, 1], [0.02, 0.19, -0.09, 0]
    ];
    for (const [nx, ny, nz, isProton] of cluster) {
      const n = new THREE.Mesh(nucleonGeo, isProton ? protonMat : neutronMat);
      n.position.set(nx, ny, nz);
      n.castShadow = true;
      core.add(n);
    }

    // --- her face, set into the front of the core ---------------------------
    const face = new THREE.Group();
    face.position.set(0, 0.02, 0.2);
    core.add(face);
    // A softly lit cheek-plate so the features read against the nucleons.
    const cheek = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 16, 14)), skinMat);
    cheek.scale.set(1, 0.92, 0.5);
    face.add(cheek);
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 12, 10)), eyeWhiteMat);
      white.position.set(side * 0.075, 0.05, 0.09);
      white.scale.set(1.25, 0.85, 0.5);
      face.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.026, 8, 6)), pupilMat);
      pupil.position.set(side * 0.075, 0.05, 0.13);
      face.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.075, baseY: 0.05, seed: Math.random() * 6.28 });
      // A heavy sweep of lashes, and a fine arched brow above it.
      const lash = new THREE.Mesh(track(new THREE.BoxGeometry(0.11, 0.016, 0.02)), lashMat);
      lash.position.set(side * 0.078, 0.087, 0.12);
      lash.rotation.z = side * 0.34;
      face.add(lash);
      const brow = new THREE.Mesh(track(new THREE.BoxGeometry(0.085, 0.012, 0.015)), lashMat);
      brow.position.set(side * 0.08, 0.125, 0.11);
      brow.rotation.z = side * 0.3;
      face.add(brow);
    }
    // A knowing half-smile, painted on.
    const lips = new THREE.Mesh(track(new THREE.TorusGeometry(0.05, 0.016, 6, 14, Math.PI)), lipMat);
    lips.position.set(0.012, -0.075, 0.11);
    lips.rotation.set(0, 0, Math.PI + 0.24);
    face.add(lips);

    // --- three tilted electron orbits, each with a racing electron ---------
    this.nucleusRings = [];
    const ringGeo = track(new THREE.TorusGeometry(0.52, 0.012, 6, 40));
    const electronGeo = track(new THREE.SphereGeometry(0.055, 10, 8));
    const tilts = [
      [0, 0, 0],
      [Math.PI / 2.6, 0.5, 0.4],
      [-Math.PI / 2.4, -0.6, -0.5]
    ];
    for (let i = 0; i < tilts.length; i++) {
      const ring = new THREE.Group();
      ring.rotation.set(tilts[i][0], tilts[i][1], tilts[i][2]);
      body.add(ring);
      const hoop = new THREE.Mesh(ringGeo, orbitMat);
      ring.add(hoop);
      // The spinner carries the electron around the hoop.
      const spinner = new THREE.Group();
      ring.add(spinner);
      const electron = new THREE.Mesh(electronGeo, electronMat);
      electron.position.x = 0.52;
      spinner.add(electron);
      this.nucleusRings.push({ spinner, speed: 2.2 + i * 0.9 });
    }

    // --- her glow: emissive only, plus a sparkle halo ----------------------
    // Deliberately NO point light. Three.js forward-renders every light
    // against every lit fragment, so one more dynamic light is a screen-wide
    // cost on weaker GPUs — and she'd be carrying it around the whole run.
    // Emissive materials and the halo give the same look for free.
    const aura = createAuraPoints(22, {
      radiusBase: 0.5, radiusVar: 0.35, heightBase: -0.25, heightVar: 0.6
    });
    aura.material.uniforms.uColor.value.set(0x8ec8e8);
    aura.material.uniforms.uSize.value = 16;
    body.add(aura);
    this._disposables.push(aura.geometry, aura.material);

    // --- the trail: ghosts of where she has just been -----------------------
    // Held in a counter-rotated group so the offsets stay world-aligned even
    // as the root turns to face travel.
    const trail = new THREE.Group();
    root.add(trail);
    this._trailGroup = trail;
    this._trailMeshes = [];
    this._trailPts = [];
    const trailGeo = track(new THREE.SphereGeometry(0.2, 10, 8));
    for (let i = 0; i < 7; i++) {
      const ghost = new THREE.Mesh(trailGeo, trailMat.clone());
      this._disposables.push(ghost.material);
      ghost.material.opacity = 0;
      ghost.visible = false;
      trail.add(ghost);
      this._trailMeshes.push(ghost);
    }

    this.arms = [];
    this.legs = [];
    return root;
  }

  /**
   * Tudor Lizard — an anthropomorphic lizard done up in full Tudor court
   * dress: a great frilled ruff standing white around his neck, a slashed
   * doublet with puffed sleeves over trunk hose, a flat velvet cap with a
   * feather, and a fine chain of office. Scaly green, entirely composed.
   */
  buildTudorLizard() {
    const root = new THREE.Group();
    root.name = 'tudor';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const scaleMat = track(createToonMaterial({
      color: 0x5f9e46, rim: { color: 0xc4f0a0, strength: 0.45, threshold: 0.6 }
    }));
    const bellyMat = track(createToonMaterial({ color: 0xc8dc96 }));
    const ruffMat = track(createToonMaterial({
      color: 0xf6f2e8, rim: { color: 0xffffff, strength: 0.5, threshold: 0.58 }
    }));
    const doubletMat = track(createToonMaterial({
      color: 0x6a1230, rim: { color: 0xc06a88, strength: 0.35, threshold: 0.62 }
    }));
    const slashMat = track(createToonMaterial({ color: 0xe8d8a0 }));
    const hoseMat = track(createToonMaterial({ color: 0x2a2a4a }));
    const goldMat = track(createToonMaterial({
      color: 0xf5c542, emissive: 0x4a3300, emissiveIntensity: 0.8
    }));
    const capMat = track(createToonMaterial({ color: 0x1c1c2a }));
    const featherMat = track(createToonMaterial({ color: 0xe8e2d0 }));
    const shoeMat = track(createToonMaterial({ color: 0x3a2418 }));
    const eyeMat = track(createToonMaterial({ color: 0xf2d84a }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.5;
    root.add(body);
    this.bodyGroup = body;

    // --- the slashed doublet, with puffed sleeves to come ------------------
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.27, 0.36, 6, 14)), doubletMat);
    torso.position.y = 0.28;
    torso.castShadow = true;
    body.add(torso);
    // Vertical slashes showing the cream lining beneath.
    for (let i = 0; i < 5; i++) {
      const a = -0.5 + i * 0.25;
      const slash = new THREE.Mesh(track(new THREE.BoxGeometry(0.03, 0.3, 0.02)), slashMat);
      slash.position.set(Math.sin(a) * 0.26, 0.3, Math.cos(a) * 0.26);
      slash.rotation.y = a;
      body.add(slash);
    }
    // The peascod point at the waist, and a gold chain of office.
    const peascod = new THREE.Mesh(track(new THREE.ConeGeometry(0.16, 0.2, 10)), doubletMat);
    peascod.position.set(0, 0.08, 0.18);
    peascod.rotation.x = Math.PI;
    body.add(peascod);
    const chain = new THREE.Mesh(track(new THREE.TorusGeometry(0.19, 0.018, 6, 20)), goldMat);
    chain.position.set(0, 0.4, 0.06);
    chain.rotation.x = 1.3;
    body.add(chain);
    const pendant = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 8)), goldMat);
    pendant.position.set(0, 0.24, 0.25);
    pendant.rotation.x = Math.PI / 2;
    body.add(pendant);

    // --- the great starched ruff ------------------------------------------
    const ruff = new THREE.Group();
    ruff.position.y = 0.6;
    body.add(ruff);
    // A stack of two figure-of-eight frills, built from many small lobes.
    for (const [ring, rad, lobe, ry] of [[0, 0.3, 0.075, 0], [1, 0.27, 0.065, 0.07]]) {
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + ring * 0.14;
        const lobeMesh = new THREE.Mesh(track(new THREE.SphereGeometry(lobe, 8, 6)), ruffMat);
        lobeMesh.position.set(Math.cos(a) * rad, ry, Math.sin(a) * rad);
        lobeMesh.scale.set(1, 0.55, 1.5);
        lobeMesh.rotation.y = -a;
        ruff.add(lobeMesh);
      }
    }

    // --- the lizard himself, above the ruff --------------------------------
    const head = new THREE.Group();
    head.position.y = 0.78;
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.23, 16, 14)), scaleMat);
    skull.scale.set(1, 0.88, 1.15);
    skull.castShadow = true;
    head.add(skull);
    // A long reptilian snout with a pale underside.
    const snout = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.1, 0.2, 5, 10)), scaleMat);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.04, 0.26);
    head.add(snout);
    const jaw = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.075, 0.18, 4, 8)), bellyMat);
    jaw.rotation.x = Math.PI / 2;
    jaw.position.set(0, -0.11, 0.26);
    head.add(jaw);
    for (const side of [-1, 1]) {
      const nostril = new THREE.Mesh(track(new THREE.SphereGeometry(0.018, 6, 5)), pupilMat);
      nostril.position.set(side * 0.045, 0.01, 0.4);
      head.add(nostril);
    }
    // Hooded golden eyes with slit pupils.
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 12, 10)), eyeMat);
      eye.position.set(side * 0.16, 0.08, 0.12);
      head.add(eye);
      const brow = new THREE.Mesh(
        track(new THREE.SphereGeometry(0.082, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)),
        scaleMat
      );
      brow.position.set(side * 0.16, 0.09, 0.12);
      brow.rotation.x = -0.3;
      head.add(brow);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.032, 8, 6)), pupilMat);
      pupil.scale.set(0.35, 1, 1);
      pupil.position.set(side * 0.16, 0.08, 0.19);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.16, baseY: 0.08, seed: Math.random() * 6.28 });
    }
    // A row of small dorsal scutes over the crown.
    for (let i = 0; i < 4; i++) {
      const scute = new THREE.Mesh(track(new THREE.ConeGeometry(0.03, 0.06, 4)), scaleMat);
      scute.position.set(0, 0.2 - i * 0.02, -0.06 - i * 0.07);
      head.add(scute);
    }

    // --- a flat velvet cap, worn at an angle, with its feather -------------
    const cap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.07, 18)), capMat);
    cap.position.set(-0.03, 0.24, -0.03);
    cap.rotation.z = 0.18;
    cap.castShadow = true;
    head.add(cap);
    const capBand = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.025, 6, 18)), goldMat);
    capBand.position.set(-0.03, 0.21, -0.03);
    capBand.rotation.set(Math.PI / 2, 0, 0.18);
    head.add(capBand);
    const feather = new THREE.Mesh(track(new THREE.ConeGeometry(0.045, 0.34, 5)), featherMat);
    feather.position.set(0.2, 0.36, -0.1);
    feather.rotation.set(0.3, 0, -0.9);
    head.add(feather);

    // --- puffed sleeves and scaly hands ------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.06, 0.055, 0.3, 8));
    armGeo.translate(0, -0.15, 0);
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.46, 0);
      pivot.rotation.z = -side * 0.28;
      const puff = new THREE.Mesh(track(new THREE.SphereGeometry(0.15, 12, 10)), doubletMat);
      puff.position.y = -0.06;
      puff.scale.set(1, 0.9, 1);
      puff.castShadow = true;
      pivot.add(puff);
      const arm = new THREE.Mesh(armGeo, scaleMat);
      arm.position.y = -0.14;
      pivot.add(arm);
      const cuff = new THREE.Mesh(track(new THREE.TorusGeometry(0.06, 0.022, 6, 12)), ruffMat);
      cuff.position.y = -0.32;
      cuff.rotation.x = Math.PI / 2;
      pivot.add(cuff);
      const hand = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 10, 8)), scaleMat);
      hand.position.y = -0.4;
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- trunk hose over stockinged legs, in buckled shoes -----------------
    const legGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.34, 8));
    legGeo.translate(0, -0.17, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, 0.06, 0);
      const trunk = new THREE.Mesh(track(new THREE.SphereGeometry(0.135, 12, 10)), doubletMat);
      trunk.position.y = -0.02;
      trunk.scale.set(1, 0.85, 1);
      trunk.castShadow = true;
      pivot.add(trunk);
      const leg = new THREE.Mesh(legGeo, hoseMat);
      leg.position.y = -0.08;
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 10, 8)), shoeMat);
      shoe.position.set(0, -0.44, 0.04);
      shoe.scale.set(1, 0.65, 1.5);
      pivot.add(shoe);
      const buckle = new THREE.Mesh(track(new THREE.BoxGeometry(0.05, 0.03, 0.012)), goldMat);
      buckle.position.set(0, -0.42, 0.11);
      pivot.add(buckle);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    // --- and a proper lizard tail out the back ------------------------------
    const tailPts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      tailPts.push(new THREE.Vector3(Math.sin(t * 2.4) * 0.06, 0.16 - t * 0.12, -0.24 - t * 0.6));
    }
    const tail = new THREE.Mesh(
      track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tailPts), 16, 0.075, 7, false)),
      scaleMat
    );
    tail.castShadow = true;
    body.add(tail);
    this.tail = tail;

    return root;
  }

  /**
   * Mayonnaise — a jar of mayonnaise. Cream contents, gold lid, a
   * proper wraparound label, a friendly face, and stick limbs. The
   * only hero capable of rescuing a dry sandwich.
   */
  buildMayo() {
    const root = new THREE.Group();
    root.name = 'mayo';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Wraparound label, drawn once at build time.
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#f6f2e8';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#3a5a9c';
    g.lineWidth = 10;
    g.strokeRect(8, 8, 496, 112);
    g.fillStyle = '#3a5a9c';
    g.textAlign = 'center';
    g.font = 'bold 56px Georgia, serif';
    g.fillText('MAYONNAISE', 256, 82);
    const labelTex = track(new THREE.CanvasTexture(canvas));
    labelTex.colorSpace = THREE.SRGBColorSpace;

    const mayoMat = track(createToonMaterial({
      color: 0xf2eed8,
      rim: { color: 0xffffff, strength: 0.6, threshold: 0.5 } // glassy sheen
    }));
    const lidMat = track(createToonMaterial({
      color: 0xd8b830,
      rim: { color: 0xfff3c0, strength: 0.5, threshold: 0.55 }
    }));
    const labelMat = track(createToonMaterial({ map: labelTex }));
    const limbMat = track(createToonMaterial({ color: 0xb8b4a4 }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x6a5030 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the jar ---------------------------------------------------------
    const jarGeo = track(new THREE.CylinderGeometry(0.32, 0.34, 0.8, 18));
    const jar = new THREE.Mesh(jarGeo, mayoMat);
    jar.position.y = 0.42;
    jar.castShadow = true;
    body.add(jar);

    const lidGeo = track(new THREE.CylinderGeometry(0.36, 0.36, 0.14, 18));
    const lid = new THREE.Mesh(lidGeo, lidMat);
    lid.position.y = 0.89;
    lid.castShadow = true;
    body.add(lid);

    const labelGeo = track(new THREE.CylinderGeometry(0.335, 0.35, 0.3, 18, 1, true));
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.position.y = 0.32;
    body.add(label);

    // --- face above the label ---------------------------------------------
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.07, 12, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.032, 10, 8));
    const glintGeo = track(new THREE.SphereGeometry(0.012, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.12, 0.66, 0.28);
      white.scale.set(1, 1.15, 0.5);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.115, 0.655, 0.32);
      body.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.1, 0.675, 0.335);
      body.add(glint);
    }
    const mouthGeo = track(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.54, 0.31);
    mouth.rotation.z = Math.PI;
    body.add(mouth);

    // --- stick limbs --------------------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.38, 8));
    armGeo.translate(0, -0.19, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, 0.55, 0);
      pivot.rotation.z = -side * 0.45;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, limbMat);
      hand.position.set(0, -0.4, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    const legGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.46, 8));
    legGeo.translate(0, -0.23, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, -0.03, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, limbMat);
      shoe.position.set(0, -0.48, 0.04);
      shoe.scale.set(1.1, 0.55, 1.8);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Jam — Mayonnaise's funkier cousin: a glass jar of deep berry preserve
   * under a gingham cloth cap tied with string. Dresses the same BLT, to
   * the same effect ("it's funky, but it works!"). Stick limbs and a jar
   * face, built to the same rig as Mayo so the animation just works.
   */
  buildJam() {
    const root = new THREE.Group();
    root.name = 'jam';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Wraparound label, drawn once at build time.
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#f6efe2';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#7a1f47';
    g.lineWidth = 10;
    g.strokeRect(8, 8, 496, 112);
    g.fillStyle = '#7a1f47';
    g.textAlign = 'center';
    g.font = 'bold 64px Georgia, serif';
    g.fillText('JAM', 256, 88);
    const labelTex = track(new THREE.CanvasTexture(canvas));
    labelTex.colorSpace = THREE.SRGBColorSpace;

    // Glassy jar (top) with the jam visible as a deep berry fill (bottom).
    const glassMat = track(createToonMaterial({
      color: 0xd8b6c8,
      rim: { color: 0xffffff, strength: 0.6, threshold: 0.5 }
    }));
    const jamMat = track(createToonMaterial({
      color: 0x9b2d5e,
      emissive: 0x3a0f24,
      emissiveIntensity: 0.5,
      rim: { color: 0xffa6d0, strength: 0.5, threshold: 0.5 }
    }));
    const capMat = track(createToonMaterial({
      color: 0xcc3b46,
      rim: { color: 0xffc0b0, strength: 0.4, threshold: 0.6 }
    }));
    const stringMat = track(createToonMaterial({ color: 0xe8dcc0 }));
    const labelMat = track(createToonMaterial({ map: labelTex }));
    const limbMat = track(createToonMaterial({ color: 0xb8a4ac }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x4a1028 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the jar: berry fill below, clear glass above ----------------------
    const fillGeo = track(new THREE.CylinderGeometry(0.31, 0.34, 0.5, 18));
    const fill = new THREE.Mesh(fillGeo, jamMat);
    fill.position.y = 0.27;
    fill.castShadow = true;
    body.add(fill);
    const glassGeo = track(new THREE.CylinderGeometry(0.32, 0.315, 0.34, 18));
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.y = 0.65;
    glass.castShadow = true;
    body.add(glass);

    // --- gingham cloth cap tied with string --------------------------------
    const capGeo = track(new THREE.SphereGeometry(0.37, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2));
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.82;
    cap.scale.set(1, 0.7, 1);
    cap.castShadow = true;
    body.add(cap);
    const stringGeo = track(new THREE.TorusGeometry(0.35, 0.02, 6, 20));
    const string = new THREE.Mesh(stringGeo, stringMat);
    string.rotation.x = Math.PI / 2;
    string.position.y = 0.84;
    body.add(string);

    const labelGeo = track(new THREE.CylinderGeometry(0.315, 0.335, 0.28, 18, 1, true));
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.position.y = 0.2;
    body.add(label);

    // --- face on the clear glass above the label ---------------------------
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.07, 12, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.032, 10, 8));
    const glintGeo = track(new THREE.SphereGeometry(0.012, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.12, 0.68, 0.26);
      white.scale.set(1, 1.15, 0.5);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.115, 0.675, 0.3);
      body.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.1, 0.695, 0.315);
      body.add(glint);
    }
    const mouthGeo = track(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.56, 0.29);
    mouth.rotation.z = Math.PI;
    body.add(mouth);

    // --- stick limbs (same rig as Mayo) ------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.38, 8));
    armGeo.translate(0, -0.19, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, 0.55, 0);
      pivot.rotation.z = -side * 0.45;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, limbMat);
      hand.position.set(0, -0.4, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    const legGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.46, 8));
    legGeo.translate(0, -0.23, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, -0.03, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, limbMat);
      shoe.position.set(0, -0.48, 0.04);
      shoe.scale.set(1.1, 0.55, 1.8);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Dodecahedron the Beret — a twelve-faced solid with a jaunty French
   * beret tilted over one edge, a little stalk on top. A geometric cousin
   * to Rhombus the Hat; feetless, so it drifts on the hover bed.
   */
  buildDodeca() {
    const root = new THREE.Group();
    root.name = 'dodeca';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const bodyMat = track(createToonMaterial({
      color: 0x2f9e8f,
      rim: { color: 0xa6f0e2, strength: 0.5, threshold: 0.55 }
    }));
    const beretMat = track(createToonMaterial({
      color: 0x11223a,
      rim: { color: 0x8fb0e8, strength: 0.4, threshold: 0.6 }
    }));
    const nubMat = track(createToonMaterial({ color: 0x2a3a54 }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const mouthMat = track(createToonMaterial({ color: 0x14322c }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the dodecahedron ---------------------------------------------------
    const solidGeo = track(new THREE.DodecahedronGeometry(0.46, 0));
    const solid = new THREE.Mesh(solidGeo, bodyMat);
    solid.position.y = 0.32;
    solid.castShadow = true;
    body.add(solid);

    // Face on the front.
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.075, 12, 10));
    const pupilGeo = track(new THREE.SphereGeometry(0.034, 10, 8));
    const glintGeo = track(new THREE.SphereGeometry(0.013, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.13, 0.36, 0.4);
      white.scale.set(1, 1.15, 0.5);
      solid.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.13, 0.355, 0.44);
      solid.add(pupil);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.11, 0.375, 0.46);
      solid.add(glint);
    }
    const mouthGeo = track(new THREE.TorusGeometry(0.08, 0.015, 6, 14, Math.PI));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 0.24, 0.43);
    mouth.rotation.z = Math.PI;
    solid.add(mouth);

    // --- the beret: a flat felt disc at a rakish tilt, with a stalk --------
    const beret = new THREE.Group();
    beret.position.set(0.04, 0.66, -0.02);
    beret.rotation.z = -0.22;
    solid.add(beret);
    const discGeo = track(new THREE.SphereGeometry(0.3, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2));
    const disc = new THREE.Mesh(discGeo, beretMat);
    disc.scale.set(1, 0.42, 1);
    disc.castShadow = true;
    beret.add(disc);
    // A slight overhang lip around the rim.
    const lipGeo = track(new THREE.TorusGeometry(0.27, 0.05, 8, 20));
    const lip = new THREE.Mesh(lipGeo, beretMat);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = 0.02;
    beret.add(lip);
    // The little nub on top.
    const nub = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), nubMat);
    nub.position.y = 0.14;
    beret.add(nub);

    this.legs = []; // a solid needs no legs
    return root;
  }

  /**
   * Polar Pear — a bulky white polar bear whose head is a ripe green pear,
   * stalk, leaf and all, with a black bear nose, button eyes and little
   * round snow-white ears. Trots on four padded paws.
   */
  buildPolarPear() {
    const root = new THREE.Group();
    root.name = 'polarpear';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const furMat = track(createToonMaterial({
      color: 0xf1f4f7,
      rim: { color: 0xcfe0ff, strength: 0.4, threshold: 0.66 }
    }));
    const pawMat = track(createToonMaterial({ color: 0xdfe4ea }));
    const pearMat = track(createToonMaterial({
      color: 0xbcd24a,
      rim: { color: 0xe9f4a0, strength: 0.4, threshold: 0.6 }
    }));
    const stalkMat = track(createToonMaterial({ color: 0x6a4a2c }));
    const leafMat = track(createToonMaterial({ color: 0x5fae4a }));
    const noseMat = track(createToonMaterial({ color: 0x141417 }));
    const eyeMat = track(createToonMaterial({ color: 0x141210 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- bulky torso with a bear's shoulder hump and a stubby tail ---------
    const torsoGeo = track(new THREE.CapsuleGeometry(0.4, 0.62, 6, 14));
    torsoGeo.rotateX(Math.PI / 2); // long axis forward (+Z)
    const torso = new THREE.Mesh(torsoGeo, furMat);
    torso.scale.set(1.05, 1.0, 1.2);
    torso.castShadow = true;
    body.add(torso);
    const hump = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 12)), furMat);
    hump.position.set(0, 0.2, -0.24);
    hump.scale.set(1.05, 0.8, 1.0);
    hump.castShadow = true;
    body.add(hump);
    const tail = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), furMat);
    tail.position.set(0, 0.1, -0.66);
    body.add(tail);
    this.tail = tail;

    // --- head group: a pear on a thick furry neck --------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.26, 0.5);
    body.add(headGroup);
    this.headGroup = headGroup;

    const neck = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.26, 0.34, 12)), furMat);
    neck.position.set(0, 0.08, -0.02);
    neck.rotation.x = 0.6;
    neck.castShadow = true;
    headGroup.add(neck);

    // The pear itself, a lathed profile: bulbous below, a narrow neck above.
    const profile = [
      [0.002, 0.0], [0.14, 0.02], [0.22, 0.07], [0.255, 0.15], [0.25, 0.24],
      [0.21, 0.33], [0.145, 0.42], [0.12, 0.5], [0.14, 0.56], [0.1, 0.62], [0.02, 0.66]
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const pearGeo = track(new THREE.LatheGeometry(profile, 18));
    const pear = new THREE.Mesh(pearGeo, pearMat);
    pear.position.set(0, 0.18, 0.16);
    pear.castShadow = true;
    headGroup.add(pear);

    // Stalk + leaf on the crown of the pear.
    const stalk = new THREE.Mesh(track(new THREE.CylinderGeometry(0.02, 0.028, 0.16, 6)), stalkMat);
    stalk.position.set(0, 0.86, 0.16);
    stalk.rotation.z = 0.25;
    headGroup.add(stalk);
    const leaf = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 8, 6)), leafMat);
    leaf.position.set(0.1, 0.84, 0.16);
    leaf.scale.set(1.4, 0.3, 0.8);
    leaf.rotation.z = 0.5;
    headGroup.add(leaf);

    // Snow-white round bear ears near the top of the pear.
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 10, 8)), furMat);
      ear.position.set(side * 0.15, 0.62, 0.14);
      ear.scale.set(1, 1, 0.7);
      ear.castShadow = true;
      headGroup.add(ear);
    }

    // Face on the front of the pear: nose, eyes, glints.
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 10, 8)), noseMat);
    nose.position.set(0, 0.2, 0.42);
    nose.scale.set(1.1, 0.85, 0.8);
    headGroup.add(nose);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 10, 8)), eyeMat);
      eye.position.set(side * 0.11, 0.34, 0.36);
      headGroup.add(eye);
      const glint = new THREE.Mesh(track(new THREE.SphereGeometry(0.015, 6, 6)), glintMat);
      glint.position.set(side * 0.1, 0.36, 0.4);
      headGroup.add(glint);
    }

    // --- four padded paws --------------------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.11, 0.1, 0.44, 10));
    legGeo.translate(0, -0.22, 0);
    const pawGeo = track(new THREE.SphereGeometry(0.13, 10, 8));
    this.legs = [];
    const slots = [
      { x: -0.24, z: 0.3, phase: 0 },
      { x: 0.24, z: 0.3, phase: Math.PI },
      { x: -0.26, z: -0.32, phase: Math.PI },
      { x: 0.26, z: -0.32, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.28, slot.z);
      const leg = new THREE.Mesh(legGeo, furMat);
      leg.castShadow = true;
      pivot.add(leg);
      const paw = new THREE.Mesh(pawGeo, pawMat);
      paw.position.set(0, -0.44, 0.05);
      paw.scale.set(1, 0.7, 1.25);
      pivot.add(paw);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    return root;
  }

  /**
   * Night Eye — a futuristic special-ops soldier in matte charcoal armour:
   * a visored helmet with two glowing laser eyes that fire thin red beams,
   * a chest rig, an antenna, and armoured stick limbs.
   */
  buildNightEye() {
    const root = new THREE.Group();
    root.name = 'nighteye';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const armorMat = track(createToonMaterial({
      color: 0x2a2e36,
      rim: { color: 0x6fb4ff, strength: 0.5, threshold: 0.55 }
    }));
    const darkMat = track(createToonMaterial({ color: 0x14161b }));
    const metalMat = track(createToonMaterial({
      color: 0x767c86,
      rim: { color: 0xffffff, strength: 0.55, threshold: 0.5 }
    }));
    const visorMat = track(createToonMaterial({
      color: 0x0a0e16,
      rim: { color: 0x2a6cff, strength: 0.6, threshold: 0.48 }
    }));
    const laserMat = track(createToonMaterial({
      color: 0xff3324,
      emissive: 0xff1a10,
      emissiveIntensity: 2.0,
      pulse: { speed: 6.0, phase: 0 }
    }));
    const beamMat = track(createToonMaterial({ color: 0xff5a44, emissive: 0xff2a1a, emissiveIntensity: 1.6 }));
    beamMat.transparent = true;
    beamMat.opacity = 0.5;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- armoured torso with a chest rig -----------------------------------
    const torso = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.6, 0.32, 3, 4, 2)), armorMat);
    torso.position.y = 0.34;
    torso.castShadow = true;
    body.add(torso);
    // Chest plate + a couple of glowing status lights.
    const plate = new THREE.Mesh(track(new THREE.BoxGeometry(0.4, 0.34, 0.08)), darkMat);
    plate.position.set(0, 0.42, 0.18);
    body.add(plate);
    for (const sx of [-0.1, 0.1]) {
      const light = new THREE.Mesh(track(new THREE.SphereGeometry(0.02, 6, 6)), laserMat);
      light.position.set(sx, 0.5, 0.23);
      body.add(light);
    }
    // Shoulder pauldrons.
    for (const side of [-1, 1]) {
      const pauldron = new THREE.Mesh(track(new THREE.SphereGeometry(0.14, 12, 10)), armorMat);
      pauldron.position.set(side * 0.3, 0.56, 0);
      pauldron.scale.set(1, 0.7, 1);
      pauldron.castShadow = true;
      body.add(pauldron);
    }

    // --- helmet with a visor, laser eyes and beams -------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.72, 0);
    body.add(headGroup);
    this.headGroup = headGroup;

    const helmet = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 16, 14)), armorMat);
    helmet.scale.set(1, 1.05, 1.05);
    helmet.castShadow = true;
    headGroup.add(helmet);
    // Wraparound visor band.
    const visor = new THREE.Mesh(track(new THREE.CylinderGeometry(0.205, 0.205, 0.13, 16, 1, true, -0.9, 1.8)), visorMat);
    visor.position.set(0, 0.0, 0.02);
    headGroup.add(visor);
    // Two laser eyes that fire thin forward beams.
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), laserMat);
      eye.position.set(side * 0.08, 0.0, 0.2);
      headGroup.add(eye);
      const beamGeo = track(new THREE.CylinderGeometry(0.012, 0.03, 0.9, 8, 1, true));
      beamGeo.rotateX(Math.PI / 2); // point along +Z
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(side * 0.08, 0.0, 0.66);
      headGroup.add(beam);
    }
    // Antenna with a blinking tip.
    const antenna = new THREE.Mesh(track(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 6)), metalMat);
    antenna.position.set(0.14, 0.28, -0.06);
    antenna.rotation.z = -0.2;
    headGroup.add(antenna);
    const tip = new THREE.Mesh(track(new THREE.SphereGeometry(0.022, 8, 6)), laserMat);
    tip.position.set(0.11, 0.4, -0.06);
    headGroup.add(tip);

    // --- armoured stick arms -----------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.05, 0.045, 0.42, 8));
    armGeo.translate(0, -0.21, 0);
    const fistGeo = track(new THREE.BoxGeometry(0.1, 0.1, 0.1));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.52, 0);
      const arm = new THREE.Mesh(armGeo, armorMat);
      arm.castShadow = true;
      pivot.add(arm);
      const fist = new THREE.Mesh(fistGeo, darkMat);
      fist.position.set(0, -0.44, 0);
      pivot.add(fist);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- armoured legs with boots ------------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.5, 8));
    legGeo.translate(0, -0.25, 0);
    const bootGeo = track(new THREE.BoxGeometry(0.13, 0.09, 0.2));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, 0.04, 0);
      const leg = new THREE.Mesh(legGeo, armorMat);
      leg.castShadow = true;
      pivot.add(leg);
      const boot = new THREE.Mesh(bootGeo, darkMat);
      boot.position.set(0, -0.5, 0.04);
      pivot.add(boot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Pineapple Penguin — an upright penguin (black back, white belly, orange
   * feet and flippers) whose head is a whole pineapple: a crosshatched
   * golden fruit with a spiky green crown, a penguin's beak and eyes.
   */
  buildPinePenguin() {
    const root = new THREE.Group();
    root.name = 'pinepenguin';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Pineapple skin texture: a golden diamond crosshatch, drawn once.
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#d8a838';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#9c6f22';
    g.lineWidth = 4;
    for (let i = -128; i < 256; i += 24) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
      g.beginPath(); g.moveTo(i, 128); g.lineTo(i + 128, 0); g.stroke();
    }
    g.fillStyle = '#7a5518';
    for (let y = 0; y < 128; y += 24) for (let x = 0; x < 128; x += 24) { g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill(); }
    const skinTex = track(new THREE.CanvasTexture(canvas));
    skinTex.colorSpace = THREE.SRGBColorSpace;

    const blackMat = track(createToonMaterial({ color: 0x1b1b22, rim: { color: 0x8fa6d8, strength: 0.3, threshold: 0.68 } }));
    const bellyMat = track(createToonMaterial({ color: 0xf4f2ea, rim: { color: 0xffffff, strength: 0.3, threshold: 0.7 } }));
    const beakMat = track(createToonMaterial({ color: 0xf0902a }));
    const footMat = track(createToonMaterial({ color: 0xe07c1e }));
    const pineMat = track(createToonMaterial({ map: skinTex, rim: { color: 0xffe9a0, strength: 0.35, threshold: 0.62 } }));
    const leafMat = track(createToonMaterial({ color: 0x4e9e3e, rim: { color: 0xbfe89a, strength: 0.35, threshold: 0.62 } }));
    const eyeMat = track(createToonMaterial({ color: 0x141210 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- upright egg-shaped body, black with a white belly --------------
    const torso = new THREE.Mesh(track(new THREE.SphereGeometry(0.36, 18, 16)), blackMat);
    torso.scale.set(0.92, 1.15, 0.9);
    torso.position.y = 0.16;
    torso.castShadow = true;
    body.add(torso);
    const belly = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 14)), bellyMat);
    belly.scale.set(0.8, 1.05, 0.7);
    belly.position.set(0, 0.14, 0.14);
    body.add(belly);
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.12, 0.2, 8)), blackMat);
    tail.position.set(0, -0.12, -0.28);
    tail.rotation.x = 1.9;
    body.add(tail);

    // --- head group: a pineapple with a beak and a leafy crown ----------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.42, 0.02);
    body.add(headGroup);
    this.headGroup = headGroup;

    const pineGeo = track(new THREE.SphereGeometry(0.24, 18, 16));
    const pine = new THREE.Mesh(pineGeo, pineMat);
    pine.scale.set(1, 1.3, 1);
    pine.position.y = 0.16;
    pine.castShadow = true;
    headGroup.add(pine);

    // Spiky green crown of leaves.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const lean = i === 0 ? 0 : 0.5;
      const leaf = new THREE.Mesh(track(new THREE.ConeGeometry(0.05, 0.28, 5)), leafMat);
      leaf.position.set(Math.cos(a) * 0.09 * lean, 0.46 + (i === 0 ? 0.06 : 0), Math.sin(a) * 0.09 * lean);
      leaf.rotation.set(lean ? Math.cos(a) * 0.5 : 0, 0, lean ? -Math.sin(a) * 0.5 : 0);
      leaf.castShadow = true;
      headGroup.add(leaf);
    }

    // Beak + eyes on the pineapple's front.
    const beak = new THREE.Mesh(track(new THREE.ConeGeometry(0.06, 0.16, 8)), beakMat);
    beak.position.set(0, 0.12, 0.26);
    beak.rotation.x = Math.PI / 2;
    headGroup.add(beak);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.04, 10, 8)), eyeMat);
      eye.position.set(side * 0.1, 0.24, 0.2);
      headGroup.add(eye);
      const glint = new THREE.Mesh(track(new THREE.SphereGeometry(0.014, 6, 6)), glintMat);
      glint.position.set(side * 0.09, 0.26, 0.23);
      headGroup.add(glint);
    }

    // --- flippers as swaying arms --------------------------------------
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.33, 0.22, 0);
      pivot.rotation.z = -side * 0.2;
      const flipperGeo = track(new THREE.CapsuleGeometry(0.055, 0.34, 4, 8));
      const flipper = new THREE.Mesh(flipperGeo, blackMat);
      flipper.position.y = -0.2;
      flipper.scale.set(0.6, 1, 1.3);
      flipper.castShadow = true;
      pivot.add(flipper);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- two stubby orange webbed feet ----------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 8));
    legGeo.translate(0, -0.08, 0);
    const footGeo = track(new THREE.SphereGeometry(0.1, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.12, -0.22, 0.02);
      const leg = new THREE.Mesh(legGeo, footMat);
      leg.castShadow = true;
      pivot.add(leg);
      const foot = new THREE.Mesh(footGeo, footMat);
      foot.position.set(0, -0.14, 0.08);
      foot.scale.set(1.1, 0.4, 1.6);
      pivot.add(foot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Billy Rocketfingers — a cool astronaut: a white spacesuit under a black
   * rockstar leather jacket (raised collar, open lapels), a bubble helmet
   * with a gold visor and a pair of shades pushed over the front, a
   * life-support pack, and armoured boots.
   */
  buildBilly() {
    const root = new THREE.Group();
    root.name = 'billy';
    // Rocket-boosted boots: a much higher, floatier leap that clears the
    // treetops (and the cherries perched on them).
    this.jumpScale = 1.55;
    this.gravityScale = 0.6;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const suitMat = track(createToonMaterial({ color: 0xeef0f3, rim: { color: 0xbcd6ff, strength: 0.35, threshold: 0.66 } }));
    // Leather: a deep brown-black with a strong warm sheen edge, so it
    // clearly reads as glossy leather rather than a flat dark shell.
    const leatherMat = track(createToonMaterial({ color: 0x241b16, rim: { color: 0xd8b98a, strength: 0.85, threshold: 0.42 } }));
    const zipMat = track(createToonMaterial({ color: 0xb8bcc4, rim: { color: 0xffffff, strength: 0.6, threshold: 0.45 } }));
    const glassMat = track(createToonMaterial({ color: 0xcfe6ff, rim: { color: 0xffffff, strength: 0.55, threshold: 0.5 } }));
    glassMat.transparent = true;
    glassMat.opacity = 0.55;
    const visorMat = track(createToonMaterial({ color: 0xd8a838, emissive: 0x6a4a10, emissiveIntensity: 0.6, rim: { color: 0xfff0c0, strength: 0.5, threshold: 0.5 } }));
    const shadeMat = track(createToonMaterial({ color: 0x0a0a10, rim: { color: 0x5a6a9a, strength: 0.6, threshold: 0.5 } }));
    const metalMat = track(createToonMaterial({ color: 0x8b909a, rim: { color: 0xffffff, strength: 0.5, threshold: 0.5 } }));
    const redMat = track(createToonMaterial({ color: 0xd8362a }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- white suit torso, wrapped in a black leather jacket ------------
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.24, 0.34, 5, 12)), suitMat);
    torso.position.y = 0.34;
    torso.castShadow = true;
    body.add(torso);
    // Jacket shell: a slightly larger dark capsule, open at the front.
    const jacket = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.27, 0.3, 5, 12)), leatherMat);
    jacket.position.set(0, 0.32, -0.02);
    jacket.scale.set(1.05, 1, 1.05);
    jacket.castShadow = true;
    body.add(jacket);
    // Open V of white suit down the chest.
    const chest = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.34, 0.06)), suitMat);
    chest.position.set(0, 0.36, 0.24);
    body.add(chest);
    // A red rockstar tee triangle behind the V.
    const tee = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.18, 0.04)), redMat);
    tee.position.set(0, 0.3, 0.23);
    body.add(tee);
    // The jacket's front panels flanking the open V, each with a silver
    // zipper of teeth running up it — the clearest "leather jacket" tell.
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, 0.4, 0.05)), leatherMat);
      panel.position.set(side * 0.15, 0.35, 0.24);
      panel.rotation.z = side * 0.06;
      body.add(panel);
      const zip = new THREE.Mesh(track(new THREE.BoxGeometry(0.02, 0.36, 0.05)), zipMat);
      zip.position.set(side * 0.09, 0.35, 0.27);
      body.add(zip);
    }
    // A leather belt / hem across the waist with a metal buckle.
    const hem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.28, 0.28, 0.09, 16)), leatherMat);
    hem.position.y = 0.15;
    hem.scale.set(1.02, 1, 1.02);
    body.add(hem);
    const buckle = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 0.06, 0.04)), metalMat);
    buckle.position.set(0, 0.15, 0.28);
    body.add(buckle);
    // Big upturned collar: two broad angled leather flaps standing at the neck.
    for (const side of [-1, 1]) {
      const lapel = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.2, 0.05)), leatherMat);
      lapel.position.set(side * 0.14, 0.54, 0.14);
      lapel.rotation.z = side * 0.55;
      lapel.rotation.x = -0.45;
      lapel.castShadow = true;
      body.add(lapel);
    }
    // Studded shoulders: leather epaulettes with a row of metal studs.
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Mesh(track(new THREE.SphereGeometry(0.13, 12, 10)), leatherMat);
      shoulder.position.set(side * 0.26, 0.52, 0);
      shoulder.scale.set(1, 0.7, 1);
      shoulder.castShadow = true;
      body.add(shoulder);
      for (let s = -1; s <= 1; s++) {
        const stud = new THREE.Mesh(track(new THREE.SphereGeometry(0.018, 6, 6)), metalMat);
        stud.position.set(side * 0.26 + s * 0.06, 0.6, 0.02);
        body.add(stud);
      }
    }
    // Life-support backpack.
    const pack = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.36, 0.16)), metalMat);
    pack.position.set(0, 0.36, -0.26);
    pack.castShadow = true;
    body.add(pack);

    // --- bubble helmet with a gold visor and shades over it -------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.72, 0);
    body.add(headGroup);
    this.headGroup = headGroup;

    const helmet = new THREE.Mesh(track(new THREE.SphereGeometry(0.23, 18, 16)), glassMat);
    helmet.castShadow = true;
    headGroup.add(helmet);
    // A white neck ring under the helmet.
    const ring = new THREE.Mesh(track(new THREE.CylinderGeometry(0.19, 0.19, 0.08, 16)), suitMat);
    ring.position.y = -0.18;
    headGroup.add(ring);
    // Gold visor across the front.
    const visor = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 16, 12, -0.9, 1.8, 0.9, 1.0)), visorMat);
    visor.position.set(0, -0.01, 0.02);
    headGroup.add(visor);
    // Big wraparound shades pushed over the helmet: two bold lenses, a
    // chunky bridge and temple arms sweeping back over the sides.
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(track(new THREE.BoxGeometry(0.17, 0.13, 0.05)), shadeMat);
      lens.position.set(side * 0.12, 0.05, 0.19);
      lens.rotation.y = side * -0.32;
      lens.castShadow = true;
      headGroup.add(lens);
      // Temple arm hooking back toward the ear.
      const temple = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.03, 0.03)), shadeMat);
      temple.position.set(side * 0.2, 0.07, 0.02);
      temple.rotation.y = side * 0.7;
      headGroup.add(temple);
    }
    const bridge = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.045, 0.04)), shadeMat);
    bridge.position.set(0, 0.07, 0.23);
    headGroup.add(bridge);

    // --- jacketed arms with white gloves -------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.055, 0.05, 0.4, 8));
    armGeo.translate(0, -0.2, 0);
    const gloveGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.52, 0);
      const arm = new THREE.Mesh(armGeo, leatherMat);
      arm.castShadow = true;
      pivot.add(arm);
      // A ribbed leather cuff at the wrist.
      const cuff = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.065, 0.07, 10)), leatherMat);
      cuff.position.set(0, -0.37, 0);
      pivot.add(cuff);
      const glove = new THREE.Mesh(gloveGeo, suitMat);
      glove.position.set(0, -0.42, 0);
      pivot.add(glove);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- white suit legs with silver boots -----------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.48, 8));
    legGeo.translate(0, -0.24, 0);
    const bootGeo = track(new THREE.BoxGeometry(0.13, 0.1, 0.22));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, 0.05, 0);
      const leg = new THREE.Mesh(legGeo, suitMat);
      leg.castShadow = true;
      pivot.add(leg);
      const boot = new THREE.Mesh(bootGeo, metalMat);
      boot.position.set(0, -0.48, 0.04);
      pivot.add(boot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Pickle Stick — a warty gherkin with a big pair of googly eyes and a
   * cheeky grin. No legs: it hops on the spot to move (isBouncy), pupils
   * rattling all the while.
   */
  buildPickle() {
    const root = new THREE.Group();
    root.name = 'pickle';
    this.isBouncy = true;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const pickleMat = track(createToonMaterial({
      color: 0x5f8f2e,
      emissive: 0x1c2f0e,
      emissiveIntensity: 0.45,
      rim: { color: 0xc4ec6e, strength: 0.5, threshold: 0.54 }
    }));
    const whiteMat = track(createToonMaterial({ color: 0xffffff, rim: { color: 0xdfe8ff, strength: 0.3, threshold: 0.7 } }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const mouthMat = track(createToonMaterial({ color: 0x2a3d16 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- warty gherkin body -------------------------------------------------
    const pickleGeo = track(new THREE.CapsuleGeometry(0.26, 0.6, 6, 18));
    {
      const pos = pickleGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        if (r > 0.01) {
          const wart = 1 + Math.sin(x * 16 + y * 7) * Math.sin(z * 15 - y * 5) * 0.1;
          pos.setX(i, x * wart);
          pos.setZ(i, z * wart);
        }
      }
      pickleGeo.computeVertexNormals();
    }
    const pickle = new THREE.Mesh(pickleGeo, pickleMat);
    pickle.position.y = 0.18;
    pickle.castShadow = true;
    body.add(pickle);
    this.headGroup = pickle; // so the idle head-bob rig gives it life

    // --- big googly eyes on stalks, wired to the rattling-pupil rig ---------
    this.googlyEyes = [];
    const whiteGeo = track(new THREE.SphereGeometry(0.14, 14, 12));
    const pupilGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(whiteGeo, whiteMat);
      white.position.set(side * 0.14, 0.48, 0.2);
      pickle.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.14, 0.46, 0.31);
      pickle.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.14, baseY: 0.46, seed: Math.random() * 6.28 });
    }

    // --- a little grin ------------------------------------------------------
    const mouth = new THREE.Mesh(track(new THREE.TorusGeometry(0.08, 0.018, 6, 12, Math.PI)), mouthMat);
    mouth.position.set(0, 0.28, 0.28);
    mouth.rotation.z = Math.PI;
    pickle.add(mouth);

    this.legs = []; // it bounces, no legs required
    return root;
  }

  /**
   * Glass Badger — the badger cast in translucent glass: a frosted, faintly
   * blue body you can see the light through, with a glowing core, a frosted
   * face-stripe hint and glassy limbs.
   */
  buildGlassBadger() {
    const root = new THREE.Group();
    root.name = 'glassbadger';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const glassMat = track(createToonMaterial({
      color: 0xbfe2f2,
      emissive: 0x1c3448,
      emissiveIntensity: 0.4,
      rim: { color: 0xffffff, strength: 0.9, threshold: 0.38 }
    }));
    glassMat.transparent = true;
    glassMat.opacity = 0.42;
    glassMat.side = THREE.DoubleSide;
    glassMat.depthWrite = false;
    const frostMat = track(createToonMaterial({
      color: 0xeaf6ff,
      rim: { color: 0xffffff, strength: 0.7, threshold: 0.45 }
    }));
    frostMat.transparent = true;
    frostMat.opacity = 0.6;
    frostMat.depthWrite = false;
    const smokeMat = track(createToonMaterial({ color: 0x2b3a4a, rim: { color: 0x9fc4e8, strength: 0.6, threshold: 0.5 } }));
    smokeMat.transparent = true;
    smokeMat.opacity = 0.55;
    smokeMat.depthWrite = false;
    const eyeMat = track(createToonMaterial({ color: 0x0c1620 }));
    const coreMat = track(createToonMaterial({
      color: 0xbfe8ff,
      emissive: 0x8fd0ff,
      emissiveIntensity: 1.6,
      pulse: { speed: 2.0, phase: 0 }
    }));
    coreMat.transparent = true;
    coreMat.opacity = 0.7;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- glass torso with a glowing core ------------------------------------
    const torsoGeo = track(new THREE.CapsuleGeometry(0.34, 0.5, 6, 16));
    torsoGeo.rotateX(Math.PI / 2);
    const torso = new THREE.Mesh(torsoGeo, glassMat);
    torso.scale.set(1.0, 0.95, 1.2);
    torso.castShadow = true;
    body.add(torso);
    const core = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.16, 0)), coreMat);
    core.position.set(0, 0.02, 0);
    body.add(core);
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.1, 0.28, 8)), glassMat);
    tail.position.set(0, 0.08, -0.5);
    tail.rotation.x = -1.5;
    body.add(tail);
    this.tail = tail;

    // --- head (dips when idle via headGroup) --------------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.2, 0.44);
    body.add(headGroup);
    this.headGroup = headGroup;

    const headGeo = track(new THREE.SphereGeometry(0.27, 18, 14));
    const head = new THREE.Mesh(headGeo, glassMat);
    head.scale.set(0.95, 0.9, 1.05);
    head.castShadow = true;
    headGroup.add(head);
    // Frosted snout with the badger's two smoky face stripes over the eyes.
    const snout = new THREE.Mesh(track(new THREE.ConeGeometry(0.12, 0.3, 12)), frostMat);
    snout.position.set(0, -0.04, 0.26);
    snout.rotation.x = Math.PI / 2;
    headGroup.add(snout);
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), eyeMat);
    nose.position.set(0, -0.02, 0.42);
    headGroup.add(nose);
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.26, 0.14)), smokeMat);
      stripe.position.set(side * 0.12, 0.05, 0.2);
      stripe.rotation.x = 0.3;
      headGroup.add(stripe);
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.04, 10, 8)), eyeMat);
      eye.position.set(side * 0.12, 0.06, 0.28);
      headGroup.add(eye);
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 10, 8)), glassMat);
      ear.position.set(side * 0.16, 0.24, 0.02);
      ear.scale.set(1, 1, 0.6);
      headGroup.add(ear);
    }

    // --- four glassy legs with frosted paws ---------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.09, 0.08, 0.4, 10));
    legGeo.translate(0, -0.2, 0);
    const pawGeo = track(new THREE.SphereGeometry(0.1, 10, 8));
    this.legs = [];
    const slots = [
      { x: -0.2, z: 0.26, phase: 0 },
      { x: 0.2, z: 0.26, phase: Math.PI },
      { x: -0.22, z: -0.28, phase: Math.PI },
      { x: 0.22, z: -0.28, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.24, slot.z);
      const leg = new THREE.Mesh(legGeo, glassMat);
      leg.castShadow = true;
      pivot.add(leg);
      const paw = new THREE.Mesh(pawGeo, frostMat);
      paw.position.set(0, -0.4, 0.04);
      paw.scale.set(1, 0.6, 1.3);
      pivot.add(paw);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    return root;
  }

  /**
   * Vapour Badger — the badger silhouette rendered entirely in drifting
   * water vapour: soft, near-translucent blue-white body with a misty rim
   * glow and a cloud of billowing puffs that slowly swirl around it. No
   * solid surfaces — it's a badger-shaped cloud with two glowing eyes.
   */
  buildVapourBadger() {
    const root = new THREE.Group();
    root.name = 'vapour';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Soft, translucent vapour. Low opacity, no depth-write so the puffs
    // layer up into a haze instead of z-fighting.
    const mist = (color, opacity, rimStrength) => {
      const m = createToonMaterial({
        color,
        emissive: 0x223a4a,
        emissiveIntensity: 0.3,
        rim: { color: 0xffffff, strength: rimStrength, threshold: 0.32 }
      });
      m.transparent = true;
      m.opacity = opacity;
      m.depthWrite = false;
      m.side = THREE.DoubleSide;
      return track(m);
    };
    const vaporMat = mist(0xd6ecf7, 0.4, 0.9);
    const vaporSoftMat = mist(0xeaf6ff, 0.26, 0.7);
    const eyeMat = track(createToonMaterial({
      color: 0xcdf1ff,
      emissive: 0x8fd8ff,
      emissiveIntensity: 1.7,
      pulse: { speed: 2.2, phase: 0 }
    }));
    eyeMat.transparent = true;
    eyeMat.opacity = 0.9;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- misty torso --------------------------------------------------------
    const torsoGeo = track(new THREE.CapsuleGeometry(0.34, 0.5, 6, 16));
    torsoGeo.rotateX(Math.PI / 2);
    const torso = new THREE.Mesh(torsoGeo, vaporMat);
    torso.scale.set(1.0, 0.95, 1.2);
    body.add(torso);
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.11, 0.3, 8)), vaporSoftMat);
    tail.position.set(0, 0.08, -0.5);
    tail.rotation.x = -1.5;
    body.add(tail);
    this.tail = tail;

    // --- head ---------------------------------------------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.2, 0.44);
    body.add(headGroup);
    this.headGroup = headGroup;

    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.27, 18, 14)), vaporMat);
    head.scale.set(0.95, 0.9, 1.05);
    headGroup.add(head);
    const snout = new THREE.Mesh(track(new THREE.ConeGeometry(0.12, 0.3, 12)), vaporSoftMat);
    snout.position.set(0, -0.04, 0.26);
    snout.rotation.x = Math.PI / 2;
    headGroup.add(snout);
    // Two glowing vapour eyes.
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), eyeMat);
      eye.position.set(side * 0.12, 0.06, 0.28);
      headGroup.add(eye);
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 10, 8)), vaporSoftMat);
      ear.position.set(side * 0.16, 0.24, 0.02);
      ear.scale.set(1, 1, 0.6);
      headGroup.add(ear);
    }

    // --- four wispy legs ----------------------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.1, 0.07, 0.4, 10));
    legGeo.translate(0, -0.2, 0);
    this.legs = [];
    const slots = [
      { x: -0.2, z: 0.26, phase: 0 },
      { x: 0.2, z: 0.26, phase: Math.PI },
      { x: -0.22, z: -0.28, phase: Math.PI },
      { x: 0.22, z: -0.28, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.24, slot.z);
      const leg = new THREE.Mesh(legGeo, vaporSoftMat);
      pivot.add(leg);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    // --- billowing vapour puffs that slowly swirl around the body -----------
    this.vaporPuffs = [];
    const puffGeo = track(new THREE.SphereGeometry(1, 10, 8));
    const puffSlots = [
      [0.0, 0.5, 0.1, 0.26], [0.28, 0.34, -0.1, 0.2], [-0.28, 0.3, 0.06, 0.22],
      [0.1, 0.62, -0.2, 0.18], [-0.12, 0.16, 0.3, 0.19], [0.2, 0.12, -0.32, 0.17],
      [-0.22, 0.55, -0.16, 0.16], [0.0, 0.28, -0.48, 0.18]
    ];
    for (const [px, py, pz, r] of puffSlots) {
      const puff = new THREE.Mesh(puffGeo, vaporSoftMat);
      puff.position.set(px, py, pz);
      puff.scale.setScalar(r);
      body.add(puff);
      this.vaporPuffs.push({
        mesh: puff, baseX: px, baseY: py, baseZ: pz, baseR: r, seed: Math.random() * 6.28
      });
    }

    return root;
  }

  /**
   * Spirit of the Forest Badger — a walking woodland: the badger form
   * grown over entirely with moss, sprouting leaves, wildflowers, berries,
   * toadstools and a little branch-antler crown, with glowing amber eyes.
   * Twice a badger's pace, a triple-height leap, and light enough on its
   * feet to walk across water. Densely detailed botanical scatter.
   */
  buildSpiritBadger() {
    const root = new THREE.Group();
    root.name = 'spirit';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Powers: 2x speed, ~3x jump apex, and it treads on water.
    this.moveScale = 2;
    this.jumpScale = 1.73;   // apex ∝ jumpScale² ⇒ ~3× a normal leap
    this.gravityScale = 1;
    this.walksOnWater = true;

    const mossMat = track(createToonMaterial({ color: 0x3f6b3a, rim: { color: 0xbfe89a, strength: 0.4, threshold: 0.58 } }));
    const mossDarkMat = track(createToonMaterial({ color: 0x2c5230 }));
    const leafMats = [
      track(createToonMaterial({ color: 0x4e8a3c, rim: { color: 0xcaf0a0, strength: 0.35, threshold: 0.6 } })),
      track(createToonMaterial({ color: 0x6aa84a })),
      track(createToonMaterial({ color: 0x2f6b46 })),
      track(createToonMaterial({ color: 0x88bd54 }))
    ];
    const petalMats = [
      track(createToonMaterial({ color: 0xf2a6c8, rim: { color: 0xffe0ef, strength: 0.4, threshold: 0.55 } })),
      track(createToonMaterial({ color: 0xf2d24a })),
      track(createToonMaterial({ color: 0xf4f0e6 })),
      track(createToonMaterial({ color: 0xb488e0 })),
      track(createToonMaterial({ color: 0xf29a4a }))
    ];
    const flowerCoreMat = track(createToonMaterial({ color: 0xf2d24a, emissive: 0x6b5810, emissiveIntensity: 0.4 }));
    const berryMats = [
      track(createToonMaterial({ color: 0xc0304a, rim: { color: 0xff9aac, strength: 0.4, threshold: 0.5 } })),
      track(createToonMaterial({ color: 0x5a6cc0 }))
    ];
    const barkMat = track(createToonMaterial({ color: 0x6b5236 }));
    const capMat = track(createToonMaterial({ color: 0xd0503c, rim: { color: 0xffb0a0, strength: 0.4, threshold: 0.55 } }));
    const dotMat = track(createToonMaterial({ color: 0xf4f0e6 }));
    const stemMat = track(createToonMaterial({ color: 0xe8e0d0 }));
    const eyeMat = track(createToonMaterial({ color: 0xffcf7a, emissive: 0xffb43a, emissiveIntensity: 1.6, pulse: { speed: 1.6, phase: 0 } }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- mossy badger torso -------------------------------------------------
    const torsoGeo = track(new THREE.CapsuleGeometry(0.34, 0.5, 6, 16));
    torsoGeo.rotateX(Math.PI / 2);
    const torso = new THREE.Mesh(torsoGeo, mossMat);
    torso.scale.set(1.0, 0.95, 1.2);
    torso.castShadow = true;
    body.add(torso);
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.12, 0.32, 8)), mossDarkMat);
    tail.position.set(0, 0.08, -0.5);
    tail.rotation.x = -1.5;
    body.add(tail);
    this.tail = tail;

    // --- head ---------------------------------------------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.2, 0.44);
    body.add(headGroup);
    this.headGroup = headGroup;
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.27, 18, 14)), mossMat);
    head.scale.set(0.95, 0.9, 1.05);
    head.castShadow = true;
    headGroup.add(head);
    const snout = new THREE.Mesh(track(new THREE.ConeGeometry(0.12, 0.3, 12)), mossDarkMat);
    snout.position.set(0, -0.04, 0.26);
    snout.rotation.x = Math.PI / 2;
    headGroup.add(snout);
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), barkMat);
    nose.position.set(0, -0.02, 0.42);
    headGroup.add(nose);
    // Glowing amber eyes.
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), eyeMat);
      eye.position.set(side * 0.12, 0.06, 0.28);
      headGroup.add(eye);
      // Leafy ears.
      const ear = new THREE.Mesh(track(new THREE.ConeGeometry(0.1, 0.24, 6)), leafMats[0]);
      ear.position.set(side * 0.17, 0.24, 0.0);
      ear.rotation.set(-0.3, 0, side * 0.4);
      headGroup.add(ear);
    }
    // A little branch-antler crown.
    for (const side of [-1, 1]) {
      const antler = new THREE.Group();
      antler.position.set(side * 0.1, 0.24, 0.05);
      antler.rotation.z = side * 0.5;
      const main = new THREE.Mesh(track(new THREE.CylinderGeometry(0.018, 0.028, 0.34, 5)), barkMat);
      main.position.y = 0.17;
      antler.add(main);
      for (const t of [0.12, 0.24]) {
        const twig = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.016, 0.16, 5)), barkMat);
        twig.position.set(side * 0.05, t, 0);
        twig.rotation.z = side * -0.7;
        antler.add(twig);
      }
      headGroup.add(antler);
    }

    // --- shared decoration geometries (reused across the whole scatter) -----
    const leafGeo = track(new THREE.ConeGeometry(0.06, 0.2, 5));
    const petalGeo = track(new THREE.SphereGeometry(0.045, 8, 6));
    const berryGeo = track(new THREE.SphereGeometry(0.035, 8, 6));
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // Sprout a leaf pointing outward from a point on the body/head surface.
    const sproutLeaf = (parent, x, y, z, nx, ny, nz, scale = 1) => {
      const leaf = new THREE.Mesh(leafGeo, pick(leafMats));
      leaf.position.set(x + nx * 0.04, y + ny * 0.04, z + nz * 0.04);
      leaf.scale.setScalar(scale);
      // Orient the cone's +Y along the surface normal.
      leaf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz).normalize());
      leaf.castShadow = true;
      parent.add(leaf);
    };
    // A little flower: a ring of petals around a glowing core.
    const bloom = (parent, x, y, z, nx, ny, nz, scale = 1) => {
      const g = new THREE.Group();
      g.position.set(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz).normalize());
      g.scale.setScalar(scale);
      const petalMat = pick(petalMats);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const petal = new THREE.Mesh(petalGeo, petalMat);
        petal.position.set(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06);
        petal.scale.set(1, 0.5, 1.4);
        g.add(petal);
      }
      const core = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), flowerCoreMat);
      core.position.y = 0.02;
      g.add(core);
      parent.add(g);
    };

    // Scatter leaves + flowers + berries thickly over the torso ellipsoid.
    const torsoR = { x: 0.4, y: 0.42, z: 0.62 };
    for (let i = 0; i < 46; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi) * 0.8 + 0.35; // bias sprouts toward the top
      const nz = Math.sin(phi) * Math.sin(theta);
      const len = Math.hypot(nx, ny, nz);
      const ux = nx / len, uy = ny / len, uz = nz / len;
      const x = ux * torsoR.x;
      const y = 0.16 + uy * torsoR.y;
      const z = uz * torsoR.z;
      const roll = Math.random();
      if (roll < 0.55) sproutLeaf(body, x, y, z, ux, uy, uz, 0.7 + Math.random() * 0.6);
      else if (roll < 0.82) bloom(body, x, y, z, ux, uy, uz, 0.7 + Math.random() * 0.5);
      else {
        const berry = new THREE.Mesh(berryGeo, pick(berryMats));
        berry.position.set(x + ux * 0.04, y + uy * 0.04, z + uz * 0.04);
        body.add(berry);
      }
    }
    // A few leaves crowning the head too.
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.5 + Math.random() * 0.5;
      const nx = Math.cos(a) * (1 - up), ny = up, nz = Math.sin(a) * (1 - up);
      sproutLeaf(headGroup, nx * 0.24, 0.12 + ny * 0.2, nz * 0.24 + 0.04, nx, ny, nz, 0.6);
    }

    // Two toadstools perched on the back.
    for (const [mx, mz] of [[-0.14, -0.18], [0.16, -0.06]]) {
      const shroom = new THREE.Group();
      shroom.position.set(mx, 0.52, mz);
      const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.04, 0.16, 8)), stemMat);
      stem.position.y = 0.08;
      shroom.add(stem);
      const cap = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)), capMat);
      cap.position.y = 0.16;
      cap.scale.set(1, 0.7, 1);
      shroom.add(cap);
      for (let d = 0; d < 4; d++) {
        const dot = new THREE.Mesh(track(new THREE.SphereGeometry(0.012, 6, 5)), dotMat);
        const da = (d / 4) * Math.PI * 2;
        dot.position.set(Math.cos(da) * 0.05, 0.18, Math.sin(da) * 0.05);
        shroom.add(dot);
      }
      shroom.castShadow = true;
      body.add(shroom);
    }

    // --- four mossy legs with rooty paws ------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.09, 0.08, 0.4, 10));
    legGeo.translate(0, -0.2, 0);
    const pawGeo = track(new THREE.SphereGeometry(0.1, 10, 8));
    this.legs = [];
    const slots = [
      { x: -0.2, z: 0.26, phase: 0 },
      { x: 0.2, z: 0.26, phase: Math.PI },
      { x: -0.22, z: -0.28, phase: Math.PI },
      { x: 0.22, z: -0.28, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.24, slot.z);
      const leg = new THREE.Mesh(legGeo, mossMat);
      leg.castShadow = true;
      pivot.add(leg);
      const paw = new THREE.Mesh(pawGeo, mossDarkMat);
      paw.position.set(0, -0.4, 0.04);
      paw.scale.set(1, 0.6, 1.3);
      pivot.add(paw);
      // a sprig on each ankle
      sproutLeaf(pivot, 0, -0.16, 0.06, 0.2, 0.9, 0.3, 0.5);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    return root;
  }

  /**
   * Chimpy Henderson — a brown monkey in a black tricorne hat with a red
   * feather, gripping a ripe banana in each hand. Like Jam, he'll dress
   * the cave's BLT. A long curling tail and a pale heart-shaped face.
   */
  buildChimpy() {
    const root = new THREE.Group();
    root.name = 'chimpy';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const furMat = track(createToonMaterial({ color: 0x7a5230, rim: { color: 0xc7a274, strength: 0.35, threshold: 0.62 } }));
    const furDarkMat = track(createToonMaterial({ color: 0x5e3d22 }));
    const faceMat = track(createToonMaterial({ color: 0xe6c39a }));
    const hatMat = track(createToonMaterial({ color: 0x241f18, rim: { color: 0x6b6152, strength: 0.3, threshold: 0.66 } }));
    const featherMat = track(createToonMaterial({ color: 0xc21a3a, rim: { color: 0xff9aac, strength: 0.4, threshold: 0.55 } }));
    const bananaMat = track(createToonMaterial({ color: 0xf2d24a, rim: { color: 0xfff0b0, strength: 0.4, threshold: 0.55 } }));
    const bananaTipMat = track(createToonMaterial({ color: 0x6b5230 }));
    const eyeMat = track(createToonMaterial({ color: 0x14100c }));
    const noseMat = track(createToonMaterial({ color: 0x3a2a1e }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.55;
    root.add(body);
    this.bodyGroup = body;

    // --- torso with a paler belly ------------------------------------------
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.26, 0.34, 6, 14)), furMat);
    torso.position.y = 0.32;
    torso.castShadow = true;
    body.add(torso);
    const belly = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 12, 10)), faceMat);
    belly.position.set(0, 0.28, 0.14);
    belly.scale.set(0.8, 1.05, 0.6);
    body.add(belly);

    // --- head ---------------------------------------------------------------
    const head = new THREE.Group();
    head.position.y = 0.86;
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 14)), furMat);
    skull.castShadow = true;
    head.add(skull);
    // Pale heart-shaped face.
    const face = new THREE.Mesh(track(new THREE.SphereGeometry(0.24, 16, 14)), faceMat);
    face.position.set(0, -0.02, 0.12);
    face.scale.set(1, 1.05, 0.6);
    head.add(face);
    const muzzle = new THREE.Mesh(track(new THREE.SphereGeometry(0.13, 12, 10)), faceMat);
    muzzle.position.set(0, -0.12, 0.2);
    muzzle.scale.set(1.1, 0.7, 0.8);
    head.add(muzzle);
    // Big round ears.
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), furMat);
      ear.position.set(side * 0.3, 0.02, 0);
      ear.scale.set(0.7, 1, 0.5);
      head.add(ear);
      const inner = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 8, 7)), faceMat);
      inner.position.set(side * 0.32, 0.02, 0.03);
      inner.scale.set(0.6, 1, 0.4);
      head.add(inner);
    }
    // Eyes + nostrils + a cheeky smile.
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 10, 8)), track(createToonMaterial({ color: 0xf4f0e6 })));
      white.position.set(side * 0.1, 0.03, 0.22);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), eyeMat);
      pupil.position.set(side * 0.1, 0.03, 0.27);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.1, baseY: 0.03, seed: Math.random() * 6.28 });
      const nostril = new THREE.Mesh(track(new THREE.SphereGeometry(0.014, 6, 5)), noseMat);
      nostril.position.set(side * 0.035, -0.12, 0.32);
      head.add(nostril);
    }
    const smile = new THREE.Mesh(track(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI)), noseMat);
    smile.position.set(0, -0.16, 0.3);
    smile.rotation.x = Math.PI;
    head.add(smile);

    // --- the tricorne hat with a red feather -------------------------------
    const hat = new THREE.Group();
    hat.position.y = 0.24;
    hat.rotation.z = 0.06;
    head.add(hat);
    const crown = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)), hatMat);
    crown.scale.set(1, 0.9, 1);
    crown.castShadow = true;
    hat.add(crown);
    // Three upturned corners: flat triangular flaps set at 120°.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      const flap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 3)), hatMat);
      flap.position.set(Math.cos(a) * 0.12, 0.0, Math.sin(a) * 0.12);
      flap.rotation.y = -a;
      flap.rotation.x = 0.32; // corners cocked up
      flap.castShadow = true;
      hat.add(flap);
    }
    // The feather, tucked into the front-left corner.
    const feather = new THREE.Group();
    feather.position.set(-0.16, 0.06, 0.16);
    feather.rotation.set(-0.5, 0, 0.5);
    const quill = new THREE.Mesh(track(new THREE.CylinderGeometry(0.008, 0.012, 0.4, 5)), featherMat);
    quill.position.y = 0.2;
    feather.add(quill);
    const plume = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 8, 8)), featherMat);
    plume.position.y = 0.34;
    plume.scale.set(0.5, 1.6, 0.3);
    feather.add(plume);
    hat.add(feather);

    // --- a banana in each hand ---------------------------------------------
    const bananaGeo = track(new THREE.TorusGeometry(0.12, 0.032, 8, 14, Math.PI * 1.1));
    const makeBanana = () => {
      const g = new THREE.Group();
      const b = new THREE.Mesh(bananaGeo, bananaMat);
      g.add(b);
      for (const end of [0, Math.PI * 1.1]) {
        const tip = new THREE.Mesh(track(new THREE.SphereGeometry(0.032, 6, 5)), bananaTipMat);
        tip.position.set(Math.cos(end) * 0.12, Math.sin(end) * 0.12, 0);
        g.add(tip);
      }
      return g;
    };

    // --- arms (each raised, gripping a banana) ------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.06, 0.055, 0.34, 8));
    armGeo.translate(0, -0.17, 0);
    const handGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.28, 0.55, 0.04);
      pivot.rotation.z = side * 0.9; // arms up, brandishing
      const arm = new THREE.Mesh(armGeo, furMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, faceMat);
      hand.position.set(0, -0.36, 0);
      pivot.add(hand);
      const banana = makeBanana();
      banana.position.set(0, -0.4, 0.04);
      banana.rotation.z = -side * 0.9 + Math.PI / 2;
      pivot.add(banana);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- short legs with pale feet -----------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.32, 8));
    legGeo.translate(0, -0.16, 0);
    const footGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, 0.08, 0);
      const leg = new THREE.Mesh(legGeo, furMat);
      leg.castShadow = true;
      pivot.add(leg);
      const foot = new THREE.Mesh(footGeo, faceMat);
      foot.position.set(0, -0.32, 0.05);
      foot.scale.set(1, 0.6, 1.5);
      pivot.add(foot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    // --- a long curling tail ------------------------------------------------
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.28, -0.24),
      new THREE.Vector3(0, 0.2, -0.5),
      new THREE.Vector3(0.18, 0.34, -0.6),
      new THREE.Vector3(0.3, 0.54, -0.48),
      new THREE.Vector3(0.22, 0.66, -0.3)
    ]);
    const tailGeo = track(new THREE.TubeGeometry(tailCurve, 20, 0.035, 6, false));
    const tail = new THREE.Mesh(tailGeo, furMat);
    tail.castShadow = true;
    body.add(tail);
    this.tail = tail;

    return root;
  }

  /**
   * Pastry Owl — an owl baked from golden buttery pastry: a plump laminated
   * body, croissant-crescent wings and ear-tufts, a flaky egg-washed sheen,
   * a little pastry beak, and two dark chocolate-drop eyes on baked-in
   * rounds. Crumbly, warm and nocturnal.
   */
  buildPastryOwl() {
    const root = new THREE.Group();
    root.name = 'owl';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const pastryMat = track(createToonMaterial({ color: 0xd9a24e, rim: { color: 0xffe3ab, strength: 0.4, threshold: 0.58 } }));
    const pastryDarkMat = track(createToonMaterial({ color: 0xb87a2e }));
    const glazeMat = track(createToonMaterial({ color: 0xe8b866, emissive: 0x5a3a12, emissiveIntensity: 0.25, rim: { color: 0xfff0c8, strength: 0.5, threshold: 0.5 } }));
    const creamMat = track(createToonMaterial({ color: 0xf2e6c8 }));
    const beakMat = track(createToonMaterial({ color: 0xe0902c }));
    const eyeMat = track(createToonMaterial({ color: 0x3a2415 }));
    const footMat = track(createToonMaterial({ color: 0xc98a3a }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.58;
    root.add(body);
    this.bodyGroup = body;

    // --- laminated, egg-washed body ----------------------------------------
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.36, 0.42, 6, 16)), glazeMat);
    torso.position.y = 0.34;
    torso.scale.set(1, 1.05, 0.95);
    torso.castShadow = true;
    body.add(torso);
    // Rows of scored pastry layers across the belly.
    for (let i = 0; i < 4; i++) {
      const layer = new THREE.Mesh(track(new THREE.TorusGeometry(0.3 - i * 0.015, 0.02, 6, 20, Math.PI)), pastryDarkMat);
      layer.position.set(0, 0.2 + i * 0.14, 0.24);
      layer.rotation.x = Math.PI;
      body.add(layer);
    }

    // --- head with a flaky brow --------------------------------------------
    const head = new THREE.Group();
    head.position.y = 0.86;
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.34, 16, 14)), glazeMat);
    skull.scale.set(1.1, 0.95, 0.95);
    skull.castShadow = true;
    head.add(skull);

    // Two big baked eye-rounds with chocolate-drop pupils.
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const disc = new THREE.Mesh(track(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16)), pastryMat);
      disc.position.set(side * 0.15, 0.04, 0.28);
      disc.rotation.x = Math.PI / 2;
      head.add(disc);
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.11, 12, 10)), creamMat);
      white.position.set(side * 0.15, 0.04, 0.3);
      white.scale.set(1, 1, 0.5);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 10, 8)), eyeMat);
      pupil.position.set(side * 0.15, 0.04, 0.36);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.15, baseY: 0.04, seed: Math.random() * 6.28 });
    }
    // A little pastry beak between the eyes.
    const beak = new THREE.Mesh(track(new THREE.ConeGeometry(0.06, 0.16, 6)), beakMat);
    beak.position.set(0, -0.04, 0.34);
    beak.rotation.x = Math.PI / 2;
    head.add(beak);

    // Croissant ear-tufts: little crescents curling up off the head.
    const crescentGeo = track(new THREE.TorusGeometry(0.11, 0.05, 8, 14, Math.PI * 1.15));
    for (const side of [-1, 1]) {
      const tuft = new THREE.Mesh(crescentGeo, pastryMat);
      tuft.position.set(side * 0.22, 0.3, 0);
      tuft.rotation.set(0.2, 0, side * 0.6);
      tuft.castShadow = true;
      head.add(tuft);
    }

    // --- croissant wings (crescents) as the arms ---------------------------
    const wingGeo = track(new THREE.TorusGeometry(0.2, 0.08, 8, 16, Math.PI * 1.2));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.36, 0.42, 0);
      const wing = new THREE.Mesh(wingGeo, pastryMat);
      wing.rotation.set(0, side * 0.3, side * -1.2);
      wing.castShadow = true;
      pivot.add(wing);
      // flaky ridges on the wing
      for (let i = 0; i < 3; i++) {
        const ridge = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.012, 5, 14, Math.PI * 1.2)), pastryDarkMat);
        ridge.rotation.set(0, side * 0.3, side * -1.2);
        ridge.position.z = 0.05 - i * 0.05;
        pivot.add(ridge);
      }
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- little baked talon feet -------------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.05, 0.045, 0.2, 8));
    legGeo.translate(0, -0.1, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.14, 0.06, 0);
      const leg = new THREE.Mesh(legGeo, footMat);
      leg.castShadow = true;
      pivot.add(leg);
      // three splayed toes
      for (const toe of [-1, 0, 1]) {
        const t = new THREE.Mesh(track(new THREE.CylinderGeometry(0.02, 0.015, 0.12, 5)), footMat);
        t.position.set(toe * 0.05, -0.22, 0.05);
        t.rotation.x = 1.4;
        t.rotation.z = toe * 0.3;
        pivot.add(t);
      }
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Top Hat Snappy — the dapper crocodile from the whirlpool lake, now
   * playable: a low green gator in a clock-faced top hat, all snout and
   * scutes and tail. He glides more than he walks (low ground friction),
   * takes to the water happily (rides half-submerged), and his stubby legs
   * only manage a limited hop.
   */
  buildTopHatSnappy() {
    const root = new THREE.Group();
    root.name = 'snappy';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Powers: slides around (low friction, gentle accel), rides the water
    // half-submerged, and can only manage a modest jump.
    this.frictionScale = 0.14;
    this.accelScale = 0.55;
    this.walksOnWater = true;
    this.waterSink = 0.42;
    this.jumpScale = 0.55;
    this.legs = []; // he slides — no trotting feet

    const scaleMat = track(createToonMaterial({ color: 0x3f7d4a, rim: { color: 0xa8e0a0, strength: 0.35, threshold: 0.6 } }));
    const scaleDarkMat = track(createToonMaterial({ color: 0x356a40 }));
    const bellyMat = track(createToonMaterial({ color: 0xcfc78a }));
    const toothMat = track(createToonMaterial({ color: 0xf4f0e6 }));
    const eyeMat = track(createToonMaterial({ color: 0x141014 }));
    const hatMat = track(createToonMaterial({ color: 0x241f18, rim: { color: 0x6b6152, strength: 0.3, threshold: 0.66 } }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.42;
    root.add(body);
    this.bodyGroup = body;

    // Low, long body lying along +Z (the forward axis). Snout at +Z.
    const bodyGeo = track(new THREE.CapsuleGeometry(0.28, 0.7, 6, 12));
    bodyGeo.rotateX(Math.PI / 2);
    const trunk = new THREE.Mesh(bodyGeo, scaleMat);
    trunk.scale.set(1, 0.72, 1);
    trunk.castShadow = true;
    body.add(trunk);
    const belly = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.2, 0.6, 4, 10)), bellyMat);
    belly.rotation.x = Math.PI / 2;
    belly.position.y = -0.12;
    belly.scale.set(1, 0.5, 0.9);
    body.add(belly);

    // Jaws jutting forward (+Z): a longer upper and a shorter lower.
    const upperJaw = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.16, 0.6)), scaleDarkMat);
    upperJaw.position.set(0, 0.04, 0.66);
    upperJaw.castShadow = true;
    body.add(upperJaw);
    const lowerJaw = new THREE.Mesh(track(new THREE.BoxGeometry(0.3, 0.1, 0.54)), scaleDarkMat);
    lowerJaw.position.set(0, -0.08, 0.62);
    body.add(lowerJaw);
    const nostrilBump = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 8, 6)), scaleMat);
    nostrilBump.position.set(0, 0.12, 0.92);
    body.add(nostrilBump);
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) {
        const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.022, 0.09, 4)), toothMat);
        tooth.position.set(side * 0.13, -0.02, 0.5 + i * 0.12);
        tooth.rotation.x = Math.PI;
        body.add(tooth);
      }
    }

    // Eye bumps riding on top, just behind the snout.
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const bump = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), scaleMat);
      bump.position.set(side * 0.16, 0.22, 0.28);
      body.add(bump);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 8, 6)), eyeMat);
      pupil.position.set(side * 0.16, 0.28, 0.32);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.16, baseY: 0.28, seed: Math.random() * 6.28 });
    }

    // A ridge of scutes down the spine, and a tapering tail out the back.
    for (let i = 0; i < 6; i++) {
      const scute = new THREE.Mesh(track(new THREE.ConeGeometry(0.08, 0.14, 4)), scaleDarkMat);
      scute.position.set(0, 0.22 - i * 0.006, 0.08 - i * 0.18);
      body.add(scute);
    }
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.24, 1.0, 8)), scaleMat);
    tail.position.set(0, 0, -0.9);
    tail.rotation.x = -Math.PI / 2;
    tail.scale.set(1, 0.7, 1);
    body.add(tail);
    this.tail = tail;

    // Four stubby splayed legs (kept for grounding, not animated).
    for (const [lx, lz] of [[-0.28, 0.24], [0.28, 0.24], [-0.3, -0.28], [0.3, -0.28]]) {
      const leg = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.05, 0.22, 6)), scaleDarkMat);
      leg.position.set(lx, -0.18, lz);
      leg.rotation.z = lx < 0 ? 0.5 : -0.5;
      body.add(leg);
    }

    // --- the trademark top hat with a ticking clock face -------------------
    const hat = new THREE.Group();
    hat.position.set(0, 0.34, 0.2);
    body.add(hat);
    const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 16)), hatMat);
    brim.castShadow = true;
    hat.add(brim);
    const crown = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 16)), hatMat);
    crown.position.y = 0.2;
    crown.castShadow = true;
    hat.add(crown);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#f4efe0';
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#241f18';
    g.lineWidth = 6;
    g.stroke();
    g.fillStyle = '#241f18';
    for (let h = 0; h < 12; h++) {
      const a = (h / 12) * Math.PI * 2;
      g.beginPath();
      g.arc(64 + Math.sin(a) * 48, 64 - Math.cos(a) * 48, 4, 0, Math.PI * 2);
      g.fill();
    }
    // static hands (a jaunty ten-to-two)
    g.strokeStyle = '#241f18';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 - 26, 64 - 20); g.stroke();
    g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + 24, 64 - 24); g.stroke();
    const clockTex = track(new THREE.CanvasTexture(canvas));
    clockTex.colorSpace = THREE.SRGBColorSpace;
    const faceMat = track(createToonMaterial({ map: clockTex, emissive: 0x2a2418, emissiveIntensity: 0.3 }));
    const face = new THREE.Mesh(track(new THREE.CircleGeometry(0.17, 24)), faceMat);
    face.position.set(0, 0.2, 0.201);
    hat.add(face);

    return root;
  }

  /**
   * Bacon — a big, chubby, front-facing cartoon pig: a round pink head-body
   * with two floppy triangular ears, two large blue-irised eyes, and a wide
   * pink snout with two vertical nostrils. Built to match the reference.
   */
  buildBacon() {
    const root = new THREE.Group();
    root.name = 'bacon';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const pinkMat = track(createToonMaterial({ color: 0xe89aa6, rim: { color: 0xffd0d8, strength: 0.35, threshold: 0.6 } }));
    const pinkDeepMat = track(createToonMaterial({ color: 0xcf7e8c }));
    const snoutMat = track(createToonMaterial({ color: 0xf0aab0, rim: { color: 0xffe0e4, strength: 0.35, threshold: 0.58 } }));
    const nostrilMat = track(createToonMaterial({ color: 0x9a5560 }));
    const whiteMat = track(createToonMaterial({ color: 0xf6f2ee }));
    const irisMat = track(createToonMaterial({ color: 0x9fd2e6 }));
    const pupilMat = track(createToonMaterial({ color: 0x141018 }));
    const mouthMat = track(createToonMaterial({ color: 0x8a4a54 }));
    const hoofMat = track(createToonMaterial({ color: 0xc07a86 }));

    // A near-semicircular pupil: a filled circle with a large, far-offset
    // circle bitten out, so only a shallow crescent concave is carved and
    // most of the disc (a half-moon) remains. Concave edge on the +X side.
    const crescentGeo = (() => {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, 0.062, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0.15, 0, 0.115, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      return track(new THREE.ShapeGeometry(shape, 28));
    })();

    // A flat 2D-comic black outline: a slightly larger black back-face shell
    // behind each part reads as an inked line around its silhouette.
    const outlineMat = track(new THREE.MeshBasicMaterial({ color: 0x120a10, side: THREE.BackSide }));
    const outline = (mesh, s = 1.08) => {
      const o = new THREE.Mesh(mesh.geometry, outlineMat);
      o.scale.setScalar(s);
      mesh.add(o);
      return mesh;
    };

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.5;
    root.add(body);
    this.bodyGroup = body;

    // --- a proper plump body (like Turnip Scart's), on four little legs ----
    const torsoGeo = track(new THREE.CapsuleGeometry(0.34, 0.34, 6, 12));
    torsoGeo.rotateX(Math.PI / 2); // long axis along Z
    const torso = new THREE.Mesh(torsoGeo, pinkMat);
    torso.position.y = 0.18;
    torso.scale.set(1.05, 0.95, 1.15);
    torso.castShadow = true;
    body.add(torso);

    // --- the head sits up front on the body --------------------------------
    const head = new THREE.Group();
    head.position.set(0, 0.46, 0.24);
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.32, 20, 16)), pinkMat);
    skull.scale.set(1.05, 0.98, 0.92);
    skull.castShadow = true;
    head.add(skull);
    outline(skull, 1.05);
    outline(torso, 1.05);
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), pinkDeepMat);
      cheek.position.set(side * 0.24, -0.06, 0.18);
      cheek.scale.set(1, 0.8, 0.5);
      head.add(cheek);
    }

    // --- two floppy triangular ears up top ---------------------------------
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.ConeGeometry(0.14, 0.26, 4)), pinkMat);
      ear.position.set(side * 0.24, 0.28, -0.02);
      ear.rotation.set(0.3, Math.PI / 4, side * 0.5);
      ear.scale.set(1, 1, 0.5);
      ear.castShadow = true;
      head.add(ear);
      outline(ear, 1.1);
      const earInner = new THREE.Mesh(track(new THREE.ConeGeometry(0.08, 0.17, 4)), pinkDeepMat);
      earInner.position.set(side * 0.24, 0.26, 0.02);
      earInner.rotation.set(0.3, Math.PI / 4, side * 0.5);
      earInner.scale.set(1, 1, 0.4);
      head.add(earInner);
    }

    // --- two big eyes with blue irises and crescent pupils -----------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.12, 14, 12)), whiteMat);
      white.position.set(side * 0.15, 0.06, 0.24);
      white.scale.set(1, 1.05, 0.7);
      head.add(white);
      outline(white, 1.08);
      const iris = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 12, 10)), irisMat);
      iris.position.set(side * 0.15, 0.05, 0.32);
      head.add(iris);
      const pupil = new THREE.Mesh(crescentGeo, pupilMat);
      pupil.position.set(side * 0.15, 0.05, 0.37);
      // Both half-moon pupils tilted 25° the same way.
      pupil.rotation.z = -25 * Math.PI / 180;
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.15, baseY: 0.05, seed: Math.random() * 6.28 });
    }

    // --- a modest snout with two vertical nostrils -------------------------
    const snout = new THREE.Mesh(track(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 20)), snoutMat);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.13, 0.33);
    snout.scale.set(1.1, 1, 1);
    snout.castShadow = true;
    head.add(snout);
    outline(snout, 1.1);
    for (const side of [-1, 1]) {
      const nostril = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.016, 0.05, 4, 8)), nostrilMat);
      nostril.position.set(side * 0.045, -0.13, 0.39);
      head.add(nostril);
    }
    // A small OFF-CENTRE smile, tucked to one side under the snout.
    const smile = new THREE.Mesh(track(new THREE.TorusGeometry(0.07, 0.016, 6, 12, Math.PI * 0.9)), mouthMat);
    smile.position.set(0.09, -0.27, 0.26);
    smile.rotation.set(Math.PI, 0, -0.35);
    head.add(smile);

    // --- four stubby trotters ----------------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.09, 0.08, 0.26, 8));
    legGeo.translate(0, -0.13, 0);
    this.legs = [];
    this.arms = [];
    const slots = [
      { x: -0.2, z: 0.22, phase: 0 },
      { x: 0.2, z: 0.22, phase: Math.PI },
      { x: -0.22, z: -0.22, phase: Math.PI },
      { x: 0.22, z: -0.22, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, 0.06, slot.z);
      const leg = new THREE.Mesh(legGeo, pinkMat);
      leg.castShadow = true;
      pivot.add(leg);
      outline(leg, 1.12);
      const hoof = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 8)), hoofMat);
      hoof.position.y = -0.28;
      pivot.add(hoof);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    // --- a proper curly corkscrew tail -------------------------------------
    const tailPts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const ang = t * Math.PI * 3.2;
      const rad = 0.07 * (1 - t * 0.5);
      tailPts.push(new THREE.Vector3(Math.cos(ang) * rad, 0.22 + t * 0.18, -0.5 - Math.sin(ang) * rad));
    }
    const tail = new THREE.Mesh(track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tailPts), 24, 0.022, 6, false)), pinkMat);
    tail.castShadow = true;
    body.add(tail);
    this.tail = tail;

    return root;
  }

  /**
   * Robo-Farmer — a farmer whose face is half flesh, half machine: the left
   * side is grey metal plating with mechanical seams and a glowing red
   * cybernetic eye; the right side is human skin with a blue eye. A thick
   * head of grey hair under a tan ball cap, gritted teeth clamped on a piece
   * of hay, over a chunky green jumper. Matches the reference portrait.
   */
  buildRoboFarmer() {
    const root = new THREE.Group();
    root.name = 'robofarmer';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const skinMat = track(createToonMaterial({ color: 0xd7a074, rim: { color: 0xf0cfa8, strength: 0.3, threshold: 0.62 } }));
    const metalMat = track(createToonMaterial({ color: 0x9aa0a6, rim: { color: 0xe0e6ec, strength: 0.5, threshold: 0.5 } }));
    const metalDarkMat = track(createToonMaterial({ color: 0x5c6268 }));
    const redEyeMat = track(createToonMaterial({ color: 0xff5a4a, emissive: 0xff2a1a, emissiveIntensity: 1.8, pulse: { speed: 2.4, phase: 0 } }));
    const whiteMat = track(createToonMaterial({ color: 0xf3efe6 }));
    const blueEyeMat = track(createToonMaterial({ color: 0x3f76c4 }));
    const pupilMat = track(createToonMaterial({ color: 0x141018 }));
    const hairMat = track(createToonMaterial({ color: 0xc4c1b8, rim: { color: 0xf2f0ea, strength: 0.45, threshold: 0.52 } }));
    const capMat = track(createToonMaterial({ color: 0xb79463, rim: { color: 0xe6d2ac, strength: 0.3, threshold: 0.62 } }));
    const jumperMat = track(createToonMaterial({ color: 0x3f7a44, rim: { color: 0x9fd0a0, strength: 0.3, threshold: 0.62 } }));
    const jumperDarkMat = track(createToonMaterial({ color: 0x2f5e34 }));
    const trouserMat = track(createToonMaterial({ color: 0x5a4632 }));
    const mouthMat = track(createToonMaterial({ color: 0x3a2622 }));
    const teethMat = track(createToonMaterial({ color: 0xf2ede0 }));
    const hayMat = track(createToonMaterial({ color: 0xd8c060, rim: { color: 0xfff0b0, strength: 0.35, threshold: 0.6 } }));

    // A 2D-comic ink line: a black BackSide shell grown slightly around a
    // mesh reads as a hand-drawn outline (same trick as Bacon).
    const outlineMat = track(new THREE.MeshBasicMaterial({ color: 0x120a10, side: THREE.BackSide }));
    const outline = (mesh, s = 1.08) => {
      const o = new THREE.Mesh(mesh.geometry, outlineMat);
      o.scale.setScalar(s);
      mesh.add(o);
      return mesh;
    };

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.52;
    root.add(body);
    this.bodyGroup = body;

    // --- a chunky green knitted jumper -------------------------------------
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.29, 0.4, 6, 14)), jumperMat);
    torso.position.y = 0.3;
    torso.castShadow = true;
    outline(torso, 1.05);
    body.add(torso);
    // ribbed collar and hem
    const collar = new THREE.Mesh(track(new THREE.TorusGeometry(0.17, 0.045, 8, 20)), jumperDarkMat);
    collar.position.y = 0.56;
    collar.rotation.x = Math.PI / 2;
    body.add(collar);
    const hem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.29, 0.27, 0.08, 16)), jumperDarkMat);
    hem.position.y = 0.06;
    body.add(hem);

    // --- the split head -----------------------------------------------------
    const head = new THREE.Group();
    head.position.y = 0.86;
    body.add(head);
    this.headGroup = head;
    // Split the head down the FRONT centre line: skin on one side, metal on
    // the other. Rotating the hemispheres by 90° puts the seam on the face
    // (not front-to-back), so the metal half covers the red-eye (−X) side.
    const skullR = new THREE.Mesh(track(new THREE.SphereGeometry(0.31, 16, 14, 0, Math.PI)), skinMat);
    skullR.rotation.y = Math.PI / 2; // skin over the +X (blue-eye) half
    skullR.castShadow = true;
    outline(skullR, 1.05);
    head.add(skullR);
    const skullL = new THREE.Mesh(track(new THREE.SphereGeometry(0.31, 16, 14, Math.PI, Math.PI)), metalMat);
    skullL.rotation.y = Math.PI / 2; // metal over the −X (red-eye) half
    skullL.castShadow = true;
    outline(skullL, 1.05);
    head.add(skullL);
    const seam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 6)), metalDarkMat);
    seam.position.z = 0.02;
    head.add(seam);
    // Panel lines + bolts on the metal cheek.
    for (const [ly, lz] of [[0.08, 0.24], [-0.06, 0.22], [-0.16, 0.16]]) {
      const line = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.015, 0.01)), metalDarkMat);
      line.position.set(-0.16, ly, lz);
      line.rotation.y = -0.5;
      head.add(line);
    }
    for (const [bx, by] of [[-0.26, 0.12], [-0.26, -0.12], [-0.12, -0.2]]) {
      const bolt = new THREE.Mesh(track(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6)), metalDarkMat);
      bolt.position.set(bx, by, 0.2);
      bolt.rotation.x = Math.PI / 2;
      head.add(bolt);
    }
    // An antenna off the metal temple.
    const antenna = new THREE.Mesh(track(new THREE.CylinderGeometry(0.01, 0.014, 0.22, 5)), metalDarkMat);
    antenna.position.set(-0.24, 0.34, 0);
    antenna.rotation.z = 0.4;
    head.add(antenna);
    const antBall = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), redEyeMat);
    antBall.position.set(-0.32, 0.44, 0);
    head.add(antBall);

    // --- the eyes: glowing red cyber-eye (left), human blue eye (right) ----
    this.googlyEyes = [];
    // Robot eye — a recessed socket with a bright red lens.
    const socket = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12)), metalDarkMat);
    socket.rotation.x = Math.PI / 2;
    socket.position.set(-0.13, 0.05, 0.27);
    head.add(socket);
    const redEye = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 12, 10)), redEyeMat);
    redEye.position.set(-0.13, 0.05, 0.31);
    head.add(redEye);
    // Human eye — white, blue iris, dark pupil (this one rattles).
    const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 12, 10)), whiteMat);
    white.position.set(0.13, 0.05, 0.26);
    white.scale.set(1, 1, 0.6);
    head.add(white);
    const iris = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 10, 8)), blueEyeMat);
    iris.position.set(0.13, 0.05, 0.32);
    head.add(iris);
    const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.025, 8, 6)), pupilMat);
    pupil.position.set(0.13, 0.05, 0.36);
    head.add(pupil);
    this.googlyEyes.push({ pupil, baseX: 0.13, baseY: 0.05, seed: Math.random() * 6.28 });
    // --- stern eyebrows, angled down toward the centre (a hard frown) ------
    const browGeo = track(new THREE.BoxGeometry(0.15, 0.035, 0.03));
    const browMat = track(createToonMaterial({ color: 0x5a544a }));
    const browL = new THREE.Mesh(browGeo, metalDarkMat); // metal brow ridge
    browL.position.set(-0.13, 0.17, 0.28);
    browL.rotation.z = -0.5; // inner end dips down
    head.add(browL);
    const browR = new THREE.Mesh(browGeo, browMat); // bushy grey brow
    browR.position.set(0.13, 0.17, 0.27);
    browR.rotation.z = 0.5;
    head.add(browR);
    // Nose above a set of gritted teeth.
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 8, 6)), skinMat);
    nose.position.set(0.02, -0.06, 0.32);
    head.add(nose);
    // Gritted teeth: a dark mouth slot filled with a row of clenched teeth.
    const mouthSlot = new THREE.Mesh(track(new THREE.BoxGeometry(0.22, 0.07, 0.03)), mouthMat);
    mouthSlot.position.set(0.02, -0.19, 0.27);
    head.add(mouthSlot);
    for (let i = 0; i < 7; i++) {
      const tooth = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.06, 0.02)), teethMat);
      tooth.position.set(-0.08 + i * 0.032, -0.19, 0.285);
      head.add(tooth);
    }
    // A piece of hay clamped in the teeth, jutting out to one side.
    const hay = new THREE.Group();
    hay.position.set(0.12, -0.19, 0.29);
    hay.rotation.set(0, 0, -0.35);
    const stalk = new THREE.Mesh(track(new THREE.CylinderGeometry(0.011, 0.007, 0.34, 5)), hayMat);
    stalk.rotation.z = Math.PI / 2;
    stalk.position.x = 0.13;
    hay.add(stalk);
    for (const t of [0.02, 0.08]) {
      const frond = new THREE.Mesh(track(new THREE.CylinderGeometry(0.006, 0.004, 0.08, 4)), hayMat);
      frond.position.set(0.28, t, 0);
      frond.rotation.z = 0.6;
      hay.add(frond);
    }
    head.add(hay);

    // --- a thick head of grey hair spilling out under the tan ball cap -----
    // A dense fringe around the sides and back, plus side-tufts over the ears.
    for (let i = 0; i < 16; i++) {
      const a = -0.7 + (i / 15) * (Math.PI + 1.4);
      const tuft = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 8, 6)), hairMat);
      tuft.position.set(Math.cos(a) * 0.3, 0.08 + Math.sin(a) * 0.1, 0.06 - Math.abs(Math.cos(a)) * 0.14);
      tuft.scale.set(1, 0.85, 0.95);
      tuft.castShadow = true;
      head.add(tuft);
    }
    // Bushy side-locks and a shaggy nape at the back.
    for (const side of [-1, 1]) {
      const lock = new THREE.Mesh(track(new THREE.SphereGeometry(0.13, 10, 8)), hairMat);
      lock.position.set(side * 0.3, -0.04, 0.02);
      lock.scale.set(0.8, 1.1, 0.9);
      head.add(lock);
    }
    for (let i = 0; i < 5; i++) {
      const nape = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 8, 6)), hairMat);
      nape.position.set(-0.2 + i * 0.1, 0.02, -0.24);
      nape.scale.set(1, 1.1, 0.8);
      head.add(nape);
    }
    // A flat cap: a low, wide crown pulled forward, with a short stiff peak.
    const capDome = new THREE.Mesh(track(new THREE.SphereGeometry(0.34, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.5)), capMat);
    capDome.position.set(0, 0.12, -0.03);
    capDome.scale.set(1.08, 0.52, 1.2); // low & wide
    capDome.castShadow = true;
    outline(capDome, 1.06);
    head.add(capDome);
    // The front of the crown flops forward over the peak.
    const capFront = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)), capMat);
    capFront.position.set(0, 0.11, 0.16);
    capFront.scale.set(1.5, 0.4, 0.9);
    head.add(capFront);
    // The short, flat peak.
    const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.028, 20, 1, false, 0, Math.PI)), capMat);
    brim.position.set(0, 0.07, 0.28);
    brim.rotation.y = Math.PI / 2;
    brim.scale.set(1.3, 1, 1.1);
    brim.castShadow = true;
    head.add(brim);

    // --- arms (one skin, one metal) and legs -------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.4, 8));
    armGeo.translate(0, -0.2, 0);
    const handGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 0.52, 0);
      pivot.rotation.z = -side * 0.3;
      // Left arm robotic; right arm a green jumper sleeve with a skin hand.
      const sleeveMat = side === -1 ? metalMat : jumperMat;
      const handMat = side === -1 ? metalMat : skinMat;
      const arm = new THREE.Mesh(armGeo, sleeveMat);
      arm.castShadow = true;
      outline(arm, 1.1);
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, handMat);
      hand.position.y = -0.4;
      outline(hand, 1.12);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }
    const legGeo = track(new THREE.CylinderGeometry(0.09, 0.08, 0.4, 8));
    legGeo.translate(0, -0.2, 0);
    const bootGeo = track(new THREE.SphereGeometry(0.09, 10, 8));
    const bootMat = track(createToonMaterial({ color: 0x4a3a2a }));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.14, 0.06, 0);
      const leg = new THREE.Mesh(legGeo, trouserMat);
      leg.castShadow = true;
      outline(leg, 1.1);
      pivot.add(leg);
      const boot = new THREE.Mesh(bootGeo, bootMat);
      boot.position.set(0, -0.4, 0.05);
      boot.scale.set(1, 0.7, 1.5);
      outline(boot, 1.12);
      pivot.add(boot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Sir Frosch — a giant, distinguished toad: the toxic forest frog grown to
   * heroic proportions, with a gold monocle screwed into one bulging eye.
   * Those enormous haunches launch him nine times as high as anybody else,
   * but he is in no hurry whatsoever, and ambles at half speed.
   */
  buildSirFrosch() {
    const root = new THREE.Group();
    root.name = 'frosch';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Powers: a colossal leap, an unhurried amble.
    this.moveScale = 0.5;
    this.jumpScale = 3;      // apex ∝ jumpScale² ⇒ 9× a normal leap

    const skinMat = track(createToonMaterial({
      color: 0x4f9c2a,
      rim: { color: 0xa4ff6e, strength: 0.6, threshold: 0.58 }
    }));
    const skinDarkMat = track(createToonMaterial({ color: 0x3a7a1e }));
    const bellyMat = track(createToonMaterial({
      color: 0xc9d97a,
      rim: { color: 0xe8ffb0, strength: 0.4, threshold: 0.62 }
    }));
    const sacMat = track(createToonMaterial({
      color: 0xd9e691,
      rim: { color: 0xd6ff9e, strength: 0.4, threshold: 0.6 }
    }));
    const eyeMat = track(createToonMaterial({ color: 0xd8e04a }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));
    const wartMat = track(createToonMaterial({ color: 0x2f6b17 }));
    const brassMat = track(createToonMaterial({
      color: 0xe8c34a,
      rim: { color: 0xfff0b0, strength: 0.6, threshold: 0.52 }
    }));
    const glassMat = track(createToonMaterial({ color: 0xd8f0ff }));
    glassMat.transparent = true;
    glassMat.opacity = 0.35;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.46;
    root.add(body);
    this.bodyGroup = body;

    // --- an enormous squat torso -------------------------------------------
    const torso = new THREE.Mesh(track(new THREE.SphereGeometry(0.52, 24, 18)), skinMat);
    torso.scale.set(1.15, 0.86, 1.1);
    torso.castShadow = true;
    body.add(torso);
    // Pale belly tucked underneath.
    const belly = new THREE.Mesh(track(new THREE.SphereGeometry(0.44, 20, 14)), bellyMat);
    belly.position.set(0, -0.12, 0.1);
    belly.scale.set(1.05, 0.66, 1.0);
    body.add(belly);
    // A scatter of warts across his back.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const wart = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 8, 6)), wartMat);
      wart.position.set(Math.cos(a) * 0.34, 0.3 + Math.sin(i * 2.1) * 0.1, Math.sin(a) * 0.3 - 0.1);
      body.add(wart);
    }

    // --- the head, low and wide at the front --------------------------------
    const head = new THREE.Group();
    head.position.set(0, 0.24, 0.38);
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.36, 22, 16)), skinMat);
    skull.scale.set(1.1, 0.78, 1.0);
    skull.castShadow = true;
    head.add(skull);
    // A wide, grave mouth line.
    const mouth = new THREE.Mesh(track(new THREE.BoxGeometry(0.44, 0.03, 0.03)), skinDarkMat);
    mouth.position.set(0, -0.14, 0.3);
    head.add(mouth);
    // Nostrils on the snout.
    for (const side of [-1, 1]) {
      const nostril = new THREE.Mesh(track(new THREE.SphereGeometry(0.028, 6, 5)), pupilMat);
      nostril.position.set(side * 0.08, 0.02, 0.35);
      head.add(nostril);
    }
    // The croaking throat sac, slung under the chin.
    const sac = new THREE.Mesh(track(new THREE.SphereGeometry(0.26, 16, 12)), sacMat);
    sac.position.set(0, -0.2, 0.16);
    sac.scale.set(1.0, 0.72, 0.9);
    head.add(sac);

    // --- the bulging eyes, sat high on the skull ----------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.16, 14, 12)), eyeMat);
      eye.position.set(side * 0.2, 0.26, 0.06);
      eye.castShadow = true;
      head.add(eye);
      // A heavy lid capping each one — the classic sleepy toad glare.
      const lid = new THREE.Mesh(
        track(new THREE.SphereGeometry(0.17, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45)),
        skinMat
      );
      lid.position.set(side * 0.2, 0.27, 0.06);
      lid.rotation.x = -0.3;
      head.add(lid);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 10, 8)), pupilMat);
      pupil.scale.set(0.45, 1, 1); // a vertical slit
      pupil.position.set(side * 0.2, 0.26, 0.19);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.2, baseY: 0.26, seed: Math.random() * 6.28 });
    }

    // --- the monocle, screwed into his right eye ----------------------------
    const monocle = new THREE.Group();
    monocle.position.set(0.2, 0.26, 0.22);
    head.add(monocle);
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.19, 0.022, 8, 22)), brassMat);
    monocle.add(ring);
    const lens = new THREE.Mesh(track(new THREE.CircleGeometry(0.19, 22)), glassMat);
    monocle.add(lens);
    // The cord, swinging away toward his shoulder.
    const cordPts = [
      new THREE.Vector3(0.17, -0.09, 0),
      new THREE.Vector3(0.24, -0.3, -0.06),
      new THREE.Vector3(0.16, -0.52, -0.16)
    ];
    const cord = new THREE.Mesh(
      track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cordPts), 14, 0.012, 5, false)),
      brassMat
    );
    monocle.add(cord);

    // --- front arms ---------------------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.07, 0.055, 0.36, 8));
    armGeo.translate(0, -0.18, 0);
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.42, 0.04, 0.28);
      pivot.rotation.z = -side * 0.34;
      const arm = new THREE.Mesh(armGeo, skinMat);
      arm.castShadow = true;
      pivot.add(arm);
      // A splayed webbed hand.
      const hand = new THREE.Mesh(track(new THREE.ConeGeometry(0.11, 0.2, 5)), skinMat);
      hand.position.y = -0.4;
      hand.rotation.x = Math.PI / 2;
      hand.scale.set(1.2, 1, 0.42);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- the great launching haunches ---------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.11, 0.09, 0.34, 8));
    legGeo.translate(0, -0.17, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, -0.16, -0.16);
      // The big muscled thigh sits on the pivot so it swings with the leg.
      const haunch = new THREE.Mesh(track(new THREE.SphereGeometry(0.26, 16, 12)), skinMat);
      haunch.position.set(side * 0.06, 0.12, -0.04);
      haunch.scale.set(0.92, 0.88, 1.25);
      haunch.castShadow = true;
      pivot.add(haunch);
      const shin = new THREE.Mesh(legGeo, skinMat);
      shin.castShadow = true;
      pivot.add(shin);
      // Broad webbed foot, splayed forward for the landing.
      const foot = new THREE.Mesh(track(new THREE.ConeGeometry(0.16, 0.34, 5)), skinMat);
      foot.position.set(0, -0.36, 0.12);
      foot.rotation.x = Math.PI / 2;
      foot.scale.set(1.3, 1, 0.4);
      pivot.add(foot);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * McDonovan — a film-noir private eye who happens to be a mouse: a grey
   * mouse in a muted trench coat with a raised collar and belt, a grey
   * fedora tilted low, big round ears, a pink nose, whiskers and a long
   * rope tail. Everything desaturated, like an old black-and-white reel.
   */
  buildMcDonovan() {
    const root = new THREE.Group();
    root.name = 'mcdonovan';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const furMat = track(createToonMaterial({ color: 0x9a9a9c, rim: { color: 0xd8d8dc, strength: 0.35, threshold: 0.64 } }));
    const coatMat = track(createToonMaterial({ color: 0x8f887c, rim: { color: 0xcfc8ba, strength: 0.4, threshold: 0.6 } }));
    const coatDarkMat = track(createToonMaterial({ color: 0x5f5a50 }));
    const hatMat = track(createToonMaterial({ color: 0x6b6862, rim: { color: 0xb8b4ac, strength: 0.35, threshold: 0.62 } }));
    const noseMat = track(createToonMaterial({ color: 0xc98f96 }));
    const earInnerMat = track(createToonMaterial({ color: 0xb59aa0 }));
    const eyeMat = track(createToonMaterial({ color: 0x121014 }));
    const whiskerMat = track(createToonMaterial({ color: 0xcfcfcf }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- trench coat torso with a belt and collar ---------------------------
    const coatGeo = track(new THREE.CylinderGeometry(0.24, 0.32, 0.68, 14));
    const coat = new THREE.Mesh(coatGeo, coatMat);
    coat.position.y = 0.3;
    coat.castShadow = true;
    body.add(coat);
    const belt = new THREE.Mesh(track(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 14)), coatDarkMat);
    belt.position.y = 0.2;
    body.add(belt);
    const buckle = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.06, 0.04)), hatMat);
    buckle.position.set(0, 0.2, 0.31);
    body.add(buckle);
    // A row of coat buttons and a lapel V.
    for (let i = 0; i < 3; i++) {
      const btn = new THREE.Mesh(track(new THREE.SphereGeometry(0.02, 6, 6)), coatDarkMat);
      btn.position.set(0.05, 0.42 - i * 0.09, 0.29);
      body.add(btn);
    }
    // Raised trench collar.
    for (const side of [-1, 1]) {
      const collar = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.16, 0.06)), coatMat);
      collar.position.set(side * 0.12, 0.58, 0.12);
      collar.rotation.z = side * 0.5;
      collar.rotation.x = -0.35;
      body.add(collar);
    }

    // --- mouse head with big ears, nose and whiskers ------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.66, 0.04);
    body.add(headGroup);
    this.headGroup = headGroup;

    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 18, 14)), furMat);
    head.scale.set(1, 0.95, 1.05);
    head.castShadow = true;
    headGroup.add(head);
    // Tapered snout.
    const snout = new THREE.Mesh(track(new THREE.ConeGeometry(0.1, 0.24, 12)), furMat);
    snout.position.set(0, -0.04, 0.22);
    snout.rotation.x = Math.PI / 2;
    headGroup.add(snout);
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 10, 8)), noseMat);
    nose.position.set(0, -0.02, 0.36);
    headGroup.add(nose);
    // Big round ears.
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.13, 14, 12)), furMat);
      ear.position.set(side * 0.19, 0.2, -0.02);
      ear.scale.set(1, 1, 0.4);
      ear.castShadow = true;
      headGroup.add(ear);
      const inner = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 12, 10)), earInnerMat);
      inner.position.set(side * 0.19, 0.2, 0.02);
      inner.scale.set(1, 1, 0.3);
      headGroup.add(inner);
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), eyeMat);
      eye.position.set(side * 0.08, 0.02, 0.19);
      headGroup.add(eye);
      // Three whiskers per side.
      for (let w = -1; w <= 1; w++) {
        const whisker = new THREE.Mesh(track(new THREE.CylinderGeometry(0.004, 0.004, 0.22, 4)), whiskerMat);
        whisker.position.set(side * 0.16, -0.02 + w * 0.03, 0.28);
        whisker.rotation.z = Math.PI / 2 + side * 0.2;
        whisker.rotation.y = side * (0.2 + w * 0.12);
        headGroup.add(whisker);
      }
    }

    // --- the fedora, tilted low over the brow -------------------------------
    const hat = new THREE.Group();
    hat.position.set(0, 0.24, 0.02);
    hat.rotation.x = 0.12;
    hat.rotation.z = -0.1;
    headGroup.add(hat);
    const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.28, 0.28, 0.02, 20)), hatMat);
    brim.scale.set(1, 1, 1.15);
    brim.castShadow = true;
    hat.add(brim);
    const crown = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.19, 0.2, 16)), hatMat);
    crown.position.y = 0.1;
    crown.castShadow = true;
    hat.add(crown);
    const hatBand = new THREE.Mesh(track(new THREE.CylinderGeometry(0.192, 0.192, 0.05, 16)), coatDarkMat);
    hatBand.position.y = 0.03;
    hat.add(hatBand);

    // --- coat-sleeve arms with little grey paws -----------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.06, 0.055, 0.4, 8));
    armGeo.translate(0, -0.2, 0);
    const pawGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.28, 0.5, 0);
      const arm = new THREE.Mesh(armGeo, coatMat);
      arm.castShadow = true;
      pivot.add(arm);
      const paw = new THREE.Mesh(pawGeo, furMat);
      paw.position.set(0, -0.42, 0);
      pivot.add(paw);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- trousered legs with dark shoes -------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.07, 0.06, 0.4, 8));
    legGeo.translate(0, -0.2, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.08, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.12, -0.04, 0);
      const leg = new THREE.Mesh(legGeo, coatDarkMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, eyeMat);
      shoe.position.set(0, -0.42, 0.05);
      shoe.scale.set(1, 0.6, 1.7);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    // --- a long rope tail curling out the back ------------------------------
    const tailGeo = track(new THREE.CylinderGeometry(0.03, 0.015, 0.7, 6));
    const tail = new THREE.Mesh(tailGeo, noseMat);
    tail.position.set(0, 0.06, -0.32);
    tail.rotation.x = -1.1;
    this.tail = tail;
    body.add(tail);

    return root;
  }

  /**
   * Prunella Registered Voter — a ballot paper come to life: an upright
   * sheet printed with candidates and one big cross, a pair of stick arms
   * (the right one clutching a pencil) and stick legs in sensible shoes.
   */
  buildPrunella() {
    const root = new THREE.Group();
    root.name = 'prunella';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Print the ballot face once onto a canvas.
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 340;
    const g = canvas.getContext('2d');
    g.fillStyle = '#f6f3e8';
    g.fillRect(0, 0, 256, 340);
    g.strokeStyle = '#2a2a30';
    g.lineWidth = 6;
    g.strokeRect(8, 8, 240, 324);
    g.fillStyle = '#2a2a30';
    g.textAlign = 'center';
    g.font = 'bold 30px Georgia, serif';
    g.fillText('★ BALLOT ★', 128, 46);
    g.textAlign = 'left';
    g.font = '22px Georgia, serif';
    const rows = ['Badger', 'The Goat', 'A Pickle', 'Write-in'];
    for (let i = 0; i < rows.length; i++) {
      const y = 96 + i * 56;
      g.strokeStyle = '#2a2a30';
      g.lineWidth = 3;
      g.strokeRect(28, y - 22, 30, 30);
      g.fillStyle = '#2a2a30';
      g.fillText(rows[i], 74, y);
      // A decisive cross in the second box.
      if (i === 1) {
        g.strokeStyle = '#c02020';
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(32, y - 18); g.lineTo(54, y + 4);
        g.moveTo(54, y - 18); g.lineTo(32, y + 4);
        g.stroke();
      }
    }
    const ballotTex = track(new THREE.CanvasTexture(canvas));
    ballotTex.colorSpace = THREE.SRGBColorSpace;

    const paperMat = track(createToonMaterial({ color: 0xf2efe4, rim: { color: 0xffffff, strength: 0.3, threshold: 0.7 } }));
    const faceMat = track(createToonMaterial({ map: ballotTex, rim: { color: 0xffffff, strength: 0.25, threshold: 0.72 } }));
    const limbMat = track(createToonMaterial({ color: 0x3a3a42 }));
    const shoeMat = track(createToonMaterial({ color: 0x1a1a1e }));
    const eyeMat = track(createToonMaterial({ color: 0x141018 }));
    const pencilMat = track(createToonMaterial({ color: 0xf0b32a, rim: { color: 0xfff0c0, strength: 0.4, threshold: 0.58 } }));
    const graphiteMat = track(createToonMaterial({ color: 0x2a2a30 }));
    const eraserMat = track(createToonMaterial({ color: 0xe89ab0 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- the sheet of paper, with a slight curl at the top ------------------
    const paperGeo = track(new THREE.BoxGeometry(0.62, 0.86, 0.05, 6, 8, 1));
    {
      const pos = paperGeo.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        v.z += Math.max(0, v.y) * Math.max(0, v.y) * 0.4; // curl the top forward
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      paperGeo.computeVertexNormals();
    }
    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.position.y = 0.36;
    paper.castShadow = true;
    body.add(paper);
    const face = new THREE.Mesh(track(new THREE.PlaneGeometry(0.56, 0.8)), faceMat);
    face.position.set(0, 0.36, 0.031);
    body.add(face);

    // --- little eyes peering over the top -----------------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 12, 10)), paperMat);
      white.position.set(side * 0.13, 0.82, 0.08);
      body.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.03, 8, 6)), eyeMat);
      pupil.position.set(side * 0.13, 0.82, 0.13);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.13, baseY: 0.82, seed: Math.random() * 6.28 });
    }

    // --- stick arms; the right hand grips a pencil --------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.024, 0.024, 0.36, 8));
    armGeo.translate(0, -0.18, 0);
    const handGeo = track(new THREE.SphereGeometry(0.045, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.32, 0.5, 0.02);
      pivot.rotation.z = -side * 0.5;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, limbMat);
      hand.position.set(0, -0.38, 0);
      pivot.add(hand);
      // The right arm holds a pencil across its little fist.
      if (side === 1) {
        const pencil = new THREE.Group();
        pencil.position.set(0, -0.38, 0.02);
        pencil.rotation.set(0.5, 0, -0.7);
        const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.028, 0.028, 0.5, 6)), pencilMat);
        pencil.add(shaft);
        const tip = new THREE.Mesh(track(new THREE.ConeGeometry(0.028, 0.08, 6)), track(createToonMaterial({ color: 0xe8d8b0 })));
        tip.position.y = -0.29;
        pencil.add(tip);
        const lead = new THREE.Mesh(track(new THREE.ConeGeometry(0.012, 0.03, 6)), graphiteMat);
        lead.position.y = -0.34;
        pencil.add(lead);
        const eraser = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 6)), eraserMat);
        eraser.position.y = 0.27;
        pencil.add(eraser);
        pivot.add(pencil);
      }
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- stick legs with sensible shoes -------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.4, 8));
    legGeo.translate(0, -0.2, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.14, 0.0, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.4, 0.05);
      shoe.scale.set(1.1, 0.55, 1.7);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Gary Mountain — a craggy little fellow hewn from grey stone, with a
   * snow-capped head, a Picasso-cubist face (two mismatched eyes shoved
   * onto the same side, an angular nose jutting sideways, a crooked red
   * mouth), and — because why not — a pair of glossy red high heels.
   */
  buildGaryMountain() {
    const root = new THREE.Group();
    root.name = 'gary';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };
    const stone = (color) => {
      const m = createToonMaterial({ color, rim: { color: 0xffffff, strength: 0.22, threshold: 0.74 } });
      m.flatShading = true; // faceted, quarried look
      return track(m);
    };

    const rockMat = stone(0x8f8a83);
    const rockDarkMat = stone(0x6d6862);
    const rockLightMat = stone(0xa39d95);
    const snowMat = track(createToonMaterial({ color: 0xf3f7ff, rim: { color: 0xffffff, strength: 0.4, threshold: 0.6 } }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xf4f2ea }));
    const pupilMat = track(createToonMaterial({ color: 0x14121a }));
    const lipMat = track(createToonMaterial({ color: 0xba2b48, rim: { color: 0xff9aac, strength: 0.3, threshold: 0.6 } }));
    const heelMat = track(createToonMaterial({ color: 0xc21a3a, rim: { color: 0xff8098, strength: 0.5, threshold: 0.5 } }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.6;
    root.add(body);
    this.bodyGroup = body;

    // --- craggy stone torso: a faceted core plus a few boulder lumps --------
    const core = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.44, 0)), rockMat);
    core.scale.set(1.05, 1.25, 0.95);
    core.position.y = 0.32;
    core.castShadow = true;
    body.add(core);
    const lumps = [
      [0.34, 0.14, 0.12, 0.2, rockDarkMat],
      [-0.3, 0.5, 0.06, 0.22, rockLightMat],
      [0.16, 0.66, -0.1, 0.18, rockDarkMat],
      [-0.18, 0.1, 0.2, 0.16, rockLightMat]
    ];
    for (const [lx, ly, lz, r, mat] of lumps) {
      const lump = new THREE.Mesh(track(new THREE.IcosahedronGeometry(r, 0)), mat);
      lump.position.set(lx, ly, lz);
      lump.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      lump.castShadow = true;
      body.add(lump);
    }

    // --- head: a rocky peak crowned with snow --------------------------------
    const head = new THREE.Group();
    head.position.y = 0.98;
    body.add(head);
    this.headGroup = head;

    const skull = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.36, 0)), rockMat);
    skull.scale.set(1, 1.12, 0.98);
    skull.castShadow = true;
    head.add(skull);

    // A snow cap sitting over the crown, with a couple of drifts.
    const cap = new THREE.Mesh(track(new THREE.SphereGeometry(0.33, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55)), snowMat);
    cap.position.y = 0.14;
    cap.scale.set(1.06, 1, 1.02);
    cap.castShadow = true;
    head.add(cap);
    for (const [dx, dy, dz, s] of [[0.16, 0.02, 0.2, 0.13], [-0.2, 0.06, 0.12, 0.1], [0.05, 0.05, -0.24, 0.11]]) {
      const drift = new THREE.Mesh(track(new THREE.IcosahedronGeometry(s, 0)), snowMat);
      drift.position.set(dx, dy, dz);
      head.add(drift);
    }

    // --- Picasso face: both eyes crowded onto the left, mismatched ----------
    this.googlyEyes = [];
    // Eye one: a round eye, higher up.
    {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 14, 12)), eyeWhiteMat);
      white.position.set(-0.02, 0.12, 0.3);
      white.scale.set(1, 1, 0.55);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 10, 8)), pupilMat);
      pupil.position.set(-0.02, 0.12, 0.36);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: -0.02, baseY: 0.12, seed: Math.random() * 6.28 });
    }
    // Eye two: a square eye, lower and shoved beside the first (cubist).
    {
      const white = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.13, 0.06)), eyeWhiteMat);
      white.position.set(-0.19, -0.04, 0.28);
      white.rotation.z = 0.35;
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 0.06, 0.05)), pupilMat);
      pupil.position.set(-0.19, -0.04, 0.33);
      pupil.rotation.z = 0.35;
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: -0.19, baseY: -0.04, seed: Math.random() * 6.28 });
    }
    // An angular nose jutting sideways in profile.
    const nose = new THREE.Mesh(track(new THREE.ConeGeometry(0.09, 0.34, 4)), rockLightMat);
    nose.position.set(0.14, 0.0, 0.28);
    nose.rotation.set(Math.PI / 2, 0, -0.9);
    nose.castShadow = true;
    head.add(nose);
    // A crooked red mouth, off to one side.
    const mouth = new THREE.Mesh(track(new THREE.BoxGeometry(0.2, 0.05, 0.04)), lipMat);
    mouth.position.set(-0.06, -0.2, 0.31);
    mouth.rotation.z = -0.4;
    head.add(mouth);

    // --- stubby rock arms ----------------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.09, 0.07, 0.4, 6));
    armGeo.translate(0, -0.2, 0);
    const fistGeo = track(new THREE.IcosahedronGeometry(0.1, 0));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.42, 0.56, 0.02);
      pivot.rotation.z = -side * 0.35;
      const arm = new THREE.Mesh(armGeo, side === -1 ? rockDarkMat : rockLightMat);
      arm.castShadow = true;
      pivot.add(arm);
      const fist = new THREE.Mesh(fistGeo, rockMat);
      fist.position.set(0, -0.42, 0);
      fist.castShadow = true;
      pivot.add(fist);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- rock legs in glossy red high heels ---------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.1, 0.08, 0.44, 6));
    legGeo.translate(0, -0.22, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.18, 0.02, 0);
      const leg = new THREE.Mesh(legGeo, rockMat);
      leg.castShadow = true;
      pivot.add(leg);
      // A high heel: a slim sole, a pointed toe, and a tall stiletto.
      const shoe = new THREE.Group();
      shoe.position.set(0, -0.46, 0.03);
      const sole = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.04, 0.26)), heelMat);
      sole.position.set(0, 0, 0.04);
      sole.castShadow = true;
      shoe.add(sole);
      const toe = new THREE.Mesh(track(new THREE.ConeGeometry(0.07, 0.12, 8)), heelMat);
      toe.rotation.x = -Math.PI / 2;
      toe.position.set(0, 0, 0.22);
      shoe.add(toe);
      const arch = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.09, 0.12)), heelMat);
      arch.position.set(0, 0.05, -0.02);
      shoe.add(arch);
      const stiletto = new THREE.Mesh(track(new THREE.CylinderGeometry(0.018, 0.012, 0.2, 6)), heelMat);
      stiletto.position.set(0, -0.1, -0.09);
      shoe.add(stiletto);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Candy Florence — a stick of candy floss come alive: a slim paper cone
   * for a body, crowned with a big fluffy cloud of spun pink sugar, with
   * two dot eyes and stubby sugar-nub arms. She has no legs — she hovers
   * just off the ground like a little rocket (see hoverHeight), and the
   * helter skelter flings her sky-high.
   */
  buildCandyFlorence() {
    const root = new THREE.Group();
    root.name = 'candy';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const flossMat = track(createToonMaterial({ color: 0xf79ac8, rim: { color: 0xffd6ec, strength: 0.5, threshold: 0.5 } }));
    const flossPaleMat = track(createToonMaterial({ color: 0xffc2e0, rim: { color: 0xffffff, strength: 0.4, threshold: 0.55 } }));
    const flossDeepMat = track(createToonMaterial({ color: 0xe86fb0, rim: { color: 0xffb0da, strength: 0.4, threshold: 0.55 } }));
    const coneMat = track(createToonMaterial({ color: 0xf2ede0, rim: { color: 0xffffff, strength: 0.25, threshold: 0.72 } }));
    const stripeMat = track(createToonMaterial({ color: 0xdc6ba6 }));
    const eyeMat = track(createToonMaterial({ color: 0x14121a }));

    // She floats just off the turf with a gentle drifting bob.
    this.hoverHeight = 0.55;
    this.isFloaty = true;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.5;
    root.add(body);
    this.bodyGroup = body;

    // --- the paper cone handle, tip down ------------------------------------
    const cone = new THREE.Mesh(track(new THREE.ConeGeometry(0.16, 0.62, 12)), coneMat);
    cone.position.y = 0.0;
    cone.rotation.x = Math.PI; // point the tip downward
    cone.castShadow = true;
    body.add(cone);
    // A candy-stripe band around the cone.
    const band = new THREE.Mesh(track(new THREE.CylinderGeometry(0.135, 0.115, 0.08, 12)), stripeMat);
    band.position.y = 0.02;
    body.add(band);

    // --- the fluffy spun-sugar head -----------------------------------------
    const head = new THREE.Group();
    head.position.y = 0.5;
    body.add(head);
    this.headGroup = head;

    const puffs = [
      [0, 0.06, 0, 0.28, flossMat],
      [0.22, 0.0, 0.04, 0.2, flossPaleMat],
      [-0.21, 0.02, -0.02, 0.2, flossDeepMat],
      [0.08, 0.2, -0.08, 0.19, flossPaleMat],
      [-0.1, 0.22, 0.08, 0.18, flossMat],
      [0.02, 0.05, 0.22, 0.18, flossDeepMat],
      [0.04, -0.02, -0.22, 0.17, flossPaleMat]
    ];
    for (const [px, py, pz, r, mat] of puffs) {
      const puff = new THREE.Mesh(track(new THREE.IcosahedronGeometry(r, 1)), mat);
      puff.position.set(px, py, pz);
      puff.castShadow = true;
      head.add(puff);
    }

    // --- two dot eyes peering out of the floss ------------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 12, 10)), coneMat);
      white.position.set(side * 0.11, 0.02, 0.26);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), eyeMat);
      pupil.position.set(side * 0.11, 0.02, 0.32);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.11, baseY: 0.02, seed: Math.random() * 6.28 });
    }

    // --- stubby sugar-nub arms ----------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.035, 0.03, 0.24, 8));
    armGeo.translate(0, -0.12, 0);
    const nubGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.16, 0.24, 0.0);
      pivot.rotation.z = -side * 0.8;
      const arm = new THREE.Mesh(armGeo, flossMat);
      arm.castShadow = true;
      pivot.add(arm);
      const nub = new THREE.Mesh(nubGeo, flossPaleMat);
      nub.position.set(0, -0.26, 0);
      pivot.add(nub);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // No legs: she hovers, so movement reads as a soft rocket hover.
    this.legs = [];

    return root;
  }

  /**
   * Cactus Balloon — a plump ribbed cactus that floats like a party
   * balloon, trailing a string, in a backwards baseball cap. No legs;
   * it bobs above the turf the way Candy Florence does.
   */
  buildCactusBalloon() {
    const root = new THREE.Group();
    root.name = 'cactusballoon';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const cactusMat = track(createToonMaterial({ color: 0x4e9c56, rim: { color: 0xcfffd0, strength: 0.35, threshold: 0.6 } }));
    const cactusDarkMat = track(createToonMaterial({ color: 0x3f7f4a }));
    const capMat = track(createToonMaterial({ color: 0xd8503c, rim: { color: 0xffb0a0, strength: 0.4, threshold: 0.55 } }));
    const capBtnMat = track(createToonMaterial({ color: 0xf2e9d8 }));
    const stringMat = track(createToonMaterial({ color: 0xe8e2d0 }));
    const eyeMat = track(createToonMaterial({ color: 0x14121a }));
    const whiteMat = track(createToonMaterial({ color: 0xf4f2ea }));

    // Floats like a balloon: airborne bob plus the floaty idle sway.
    this.hoverHeight = 0.8;
    this.isFloaty = true;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.55;
    root.add(body);
    this.bodyGroup = body;

    // --- the balloon-body: a plump ribbed barrel ----------------------------
    const barrel = new THREE.Mesh(track(new THREE.SphereGeometry(0.42, 14, 12)), cactusMat);
    barrel.position.y = 0.42;
    barrel.scale.set(1, 1.25, 1);
    barrel.castShadow = true;
    body.add(barrel);
    // Ribs: slim darker bands wrapped vertically around the barrel.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI;
      const rib = new THREE.Mesh(track(new THREE.TorusGeometry(0.42, 0.022, 6, 24)), cactusDarkMat);
      rib.position.y = 0.42;
      rib.scale.set(1, 1.25, 1);
      rib.rotation.y = a;
      body.add(rib);
    }
    // A pair of nub arms.
    for (const side of [-1, 1]) {
      const nub = new THREE.Mesh(track(new THREE.SphereGeometry(0.13, 10, 8)), cactusMat);
      nub.position.set(side * 0.45, 0.55, 0.02);
      nub.scale.set(1, 1.5, 1);
      nub.castShadow = true;
      body.add(nub);
    }
    this.arms = [];

    // --- the backwards baseball cap ----------------------------------------
    const head = new THREE.Group();
    head.position.y = 0.95;
    body.add(head);
    this.headGroup = head;
    const crown = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)), capMat);
    crown.position.y = 0.02;
    crown.castShadow = true;
    head.add(crown);
    const button = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 8, 6)), capBtnMat);
    button.position.y = 0.3;
    head.add(button);
    // Backwards: the brim juts out BEHIND.
    const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.17, 0.035, 12, 1, false, 0, Math.PI)), capMat);
    brim.position.set(0, 0.03, -0.28);
    brim.rotation.y = Math.PI / 2;
    brim.scale.set(1.5, 1, 1);
    head.add(brim);

    // --- face on the barrel -------------------------------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 12, 10)), whiteMat);
      white.position.set(side * 0.15, 0.62, 0.36);
      body.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.038, 10, 8)), eyeMat);
      pupil.position.set(side * 0.15, 0.62, 0.42);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.15, baseY: 0.62, seed: Math.random() * 6.28 });
    }

    // --- the balloon string dangling below ----------------------------------
    const string = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6)), stringMat);
    string.position.y = -0.32;
    string.rotation.z = 0.12;
    body.add(string);
    const knot = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), stringMat);
    knot.position.set(0.08, -0.66, 0);
    body.add(knot);

    this.legs = []; // it floats — the string is all that hangs down

    return root;
  }

  /**
   * Negative Nelly — a small blue elephant having a genuinely bad day:
   * drooping trunk, floppy ears, sorrowful half-lidded eyes and a
   * downturned mouth. Finishing in the red summons her.
   */
  buildNegativeNelly() {
    const root = new THREE.Group();
    root.name = 'nelly';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const blueMat = track(createToonMaterial({ color: 0x5b7fc4, rim: { color: 0xbcd2ff, strength: 0.35, threshold: 0.62 } }));
    const blueDarkMat = track(createToonMaterial({ color: 0x47649e }));
    const earInnerMat = track(createToonMaterial({ color: 0x8fa8d8 }));
    const eyeMat = track(createToonMaterial({ color: 0x14121a }));
    const whiteMat = track(createToonMaterial({ color: 0xeef2fa }));
    const nailMat = track(createToonMaterial({ color: 0xd8dde8 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.5;
    root.add(body);
    this.bodyGroup = body;

    // --- round slumped torso ------------------------------------------------
    const torso = new THREE.Mesh(track(new THREE.SphereGeometry(0.42, 14, 12)), blueMat);
    torso.position.y = 0.34;
    torso.scale.set(1, 1.05, 0.95);
    torso.castShadow = true;
    body.add(torso);

    // --- big sad head -------------------------------------------------------
    const head = new THREE.Group();
    head.position.set(0, 0.92, 0.08);
    head.rotation.x = 0.14; // hung a little low
    body.add(head);
    this.headGroup = head;
    const skull = new THREE.Mesh(track(new THREE.SphereGeometry(0.32, 14, 12)), blueMat);
    skull.castShadow = true;
    head.add(skull);

    // Floppy ears, drooping at half-mast.
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 10, 8)), blueDarkMat);
      ear.position.set(side * 0.33, -0.02, -0.04);
      ear.scale.set(0.28, 1.15, 0.85);
      ear.rotation.z = side * 0.5; // drooped outward-down
      ear.castShadow = true;
      head.add(ear);
      const inner = new THREE.Mesh(track(new THREE.SphereGeometry(0.15, 8, 7)), earInnerMat);
      inner.position.set(side * 0.34, -0.03, 0.02);
      inner.scale.set(0.18, 0.95, 0.65);
      inner.rotation.z = side * 0.5;
      head.add(inner);
    }

    // The trunk: segments curving down and inward — utterly deflated.
    let tx = 0, ty = -0.08, tz = 0.3;
    for (let i = 0; i < 5; i++) {
      const r = 0.085 - i * 0.012;
      const seg = new THREE.Mesh(track(new THREE.SphereGeometry(r, 10, 8)), blueMat);
      seg.position.set(tx, ty, tz);
      seg.castShadow = true;
      head.add(seg);
      ty -= 0.1 + i * 0.008;
      tz += 0.045 - i * 0.008;
    }

    // Sorrowful eyes: whites, low pupils, and heavy slanted lids.
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 12, 10)), whiteMat);
      white.position.set(side * 0.14, 0.08, 0.27);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), eyeMat);
      pupil.position.set(side * 0.14, 0.055, 0.33); // gazing down
      head.add(pupil);
      const lid = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.45)), blueMat);
      lid.position.set(side * 0.14, 0.1, 0.27);
      lid.rotation.z = side * -0.45; // inner corners raised: classic sorrow
      head.add(lid);
    }
    // A downturned mouth.
    const mouth = new THREE.Mesh(track(new THREE.TorusGeometry(0.07, 0.016, 6, 12, Math.PI * 0.7)), eyeMat);
    mouth.position.set(0, -0.14, 0.28);
    mouth.rotation.z = Math.PI * 0.15 + Math.PI; // arc frowning downward
    head.add(mouth);

    // --- stumpy arms and legs with toenails --------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.09, 0.1, 0.3, 8));
    armGeo.translate(0, -0.15, 0);
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.42, 0.5, 0);
      pivot.rotation.z = -side * 0.25;
      const arm = new THREE.Mesh(armGeo, blueMat);
      arm.castShadow = true;
      pivot.add(arm);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }
    const legGeo = track(new THREE.CylinderGeometry(0.12, 0.13, 0.4, 8));
    legGeo.translate(0, -0.2, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.19, 0.06, 0);
      const leg = new THREE.Mesh(legGeo, blueMat);
      leg.castShadow = true;
      pivot.add(leg);
      for (let n = -1; n <= 1; n++) {
        const nail = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), nailMat);
        nail.position.set(n * 0.07, -0.38, 0.1);
        pivot.add(nail);
      }
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    // A little rope tail.
    const tail = new THREE.Mesh(track(new THREE.CylinderGeometry(0.02, 0.015, 0.3, 6)), blueDarkMat);
    tail.position.set(0, 0.25, -0.42);
    tail.rotation.x = 0.7;
    body.add(tail);

    return root;
  }

  /**
   * Triangle the Fedora — the third dapper polygon: a crisp triangular
   * prism in a proper felt fedora (pinched crown, wide brim, dark band),
   * with stick limbs. Completes the set with Rhombus and Dodecahedron.
   */
  buildTriangleFedora() {
    const root = new THREE.Group();
    root.name = 'trifedora';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const bodyMat = track(createToonMaterial({ color: 0xe8b84a, rim: { color: 0xfff0c0, strength: 0.4, threshold: 0.58 } }));
    const fedoraMat = track(createToonMaterial({ color: 0x5a4632, rim: { color: 0xcbb99a, strength: 0.3, threshold: 0.65 } }));
    const bandMat = track(createToonMaterial({ color: 0x2a2018 }));
    const limbMat = track(createToonMaterial({ color: 0x3a3a42 }));
    const shoeMat = track(createToonMaterial({ color: 0x1a1a1e }));
    const eyeMat = track(createToonMaterial({ color: 0x14121a }));
    const whiteMat = track(createToonMaterial({ color: 0xf4f2ea }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.6;
    root.add(body);
    this.bodyGroup = body;

    // --- the triangle: a 3-sided prism standing on a corner-down edge -------
    // A cylinder with 3 radial segments IS a triangular prism.
    const triGeo = track(new THREE.CylinderGeometry(0.52, 0.52, 0.22, 3, 1));
    const tri = new THREE.Mesh(triGeo, bodyMat);
    tri.position.y = 0.42;
    tri.rotation.x = Math.PI / 2; // flat face forward
    tri.rotation.z = Math.PI;     // point-down? no — point UP for the hat
    tri.castShadow = true;
    body.add(tri);

    // --- the face on the front flat --------------------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 12, 10)), whiteMat);
      white.position.set(side * 0.13, 0.5, 0.13);
      body.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.033, 10, 8)), eyeMat);
      pupil.position.set(side * 0.13, 0.5, 0.18);
      body.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.13, baseY: 0.5, seed: Math.random() * 6.28 });
    }
    const smile = new THREE.Mesh(track(new THREE.TorusGeometry(0.07, 0.015, 6, 12, Math.PI * 0.8)), eyeMat);
    smile.position.set(0, 0.36, 0.13);
    smile.rotation.z = Math.PI + Math.PI * 0.1;
    body.add(smile);

    // --- the fedora, perched on the apex ------------------------------------
    const hat = new THREE.Group();
    hat.position.y = 0.78;
    hat.rotation.z = -0.12; // a rakish tilt
    body.add(hat);
    this.headGroup = hat;
    const brim = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.36, 0.035, 16)), fedoraMat);
    brim.castShadow = true;
    hat.add(brim);
    const crown = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.22, 0.26, 12)), fedoraMat);
    crown.position.y = 0.14;
    crown.castShadow = true;
    crown.scale.set(1, 1, 0.85); // the classic pinch
    hat.add(crown);
    const band = new THREE.Mesh(track(new THREE.CylinderGeometry(0.225, 0.23, 0.07, 12)), bandMat);
    band.position.y = 0.05;
    band.scale.set(1, 1, 0.85);
    hat.add(band);

    // --- stick arms and legs ------------------------------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.026, 0.026, 0.34, 8));
    armGeo.translate(0, -0.17, 0);
    const handGeo = track(new THREE.SphereGeometry(0.045, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.4, 0.5, 0);
      pivot.rotation.z = -side * 0.5;
      const arm = new THREE.Mesh(armGeo, limbMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, limbMat);
      hand.position.set(0, -0.36, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }
    const legGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.38, 8));
    legGeo.translate(0, -0.19, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.16, 0.06, 0);
      const leg = new THREE.Mesh(legGeo, limbMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.38, 0.05);
      shoe.scale.set(1.1, 0.55, 1.7);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Parsley O'Riley — a fresh bunch of curly parsley in a sharply cut
   * navy suit: white shirt, red tie, proper lapels, and a leafy green
   * ruff of sprigs where a head ought to be. Impeccable garnish energy.
   */
  buildParsleyORiley() {
    const root = new THREE.Group();
    root.name = 'parsley';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const suitMat = track(createToonMaterial({ color: 0x2b3a5e, rim: { color: 0xaebfe8, strength: 0.3, threshold: 0.65 } }));
    const shirtMat = track(createToonMaterial({ color: 0xf2efe6 }));
    const tieMat = track(createToonMaterial({ color: 0xb8283a }));
    const leafMat = track(createToonMaterial({ color: 0x3e8a3c, rim: { color: 0xc8f0b0, strength: 0.4, threshold: 0.58 } }));
    const leafLightMat = track(createToonMaterial({ color: 0x55a850, rim: { color: 0xd8ffc0, strength: 0.4, threshold: 0.58 } }));
    const stemMat = track(createToonMaterial({ color: 0x67a05a }));
    const shoeMat = track(createToonMaterial({ color: 0x1a1a1e }));
    const eyeMat = track(createToonMaterial({ color: 0x14121a }));
    const whiteMat = track(createToonMaterial({ color: 0xf4f2ea }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.55;
    root.add(body);
    this.bodyGroup = body;

    // --- the suit: a tailored jacket torso ---------------------------------
    const jacket = new THREE.Mesh(track(new THREE.CylinderGeometry(0.24, 0.3, 0.62, 10)), suitMat);
    jacket.position.y = 0.31;
    jacket.castShadow = true;
    body.add(jacket);
    // The white shirt showing in the jacket's V.
    const shirt = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.3, 0.05)), shirtMat);
    shirt.position.set(0, 0.44, 0.24);
    body.add(shirt);
    // A red tie down the shirt front.
    const tieKnot = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.06, 0.05)), tieMat);
    tieKnot.position.set(0, 0.55, 0.27);
    body.add(tieKnot);
    const tie = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 0.26, 0.04)), tieMat);
    tie.position.set(0, 0.39, 0.27);
    tie.rotation.x = 0.06;
    body.add(tie);
    // Lapels: two thin slabs angling out from the collar.
    for (const side of [-1, 1]) {
      const lapel = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.26, 0.03)), suitMat);
      lapel.position.set(side * 0.11, 0.47, 0.26);
      lapel.rotation.z = side * 0.4;
      body.add(lapel);
    }

    // --- the parsley: a leafy ruff of curly sprigs -------------------------
    const head = new THREE.Group();
    head.position.y = 0.78;
    body.add(head);
    this.headGroup = head;
    // A short stem bundle rising from the collar.
    const stems = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.12, 0.18, 8)), stemMat);
    stems.position.y = 0.02;
    head.add(stems);
    // The bouquet: ruffled blobs clustered into a curly crown.
    const sprigs = [
      [0, 0.3, 0, 0.24, leafMat],
      [0.2, 0.24, 0.06, 0.17, leafLightMat],
      [-0.2, 0.26, -0.04, 0.18, leafMat],
      [0.1, 0.4, -0.12, 0.16, leafLightMat],
      [-0.09, 0.42, 0.1, 0.16, leafMat],
      [0.02, 0.24, 0.2, 0.16, leafLightMat],
      [-0.02, 0.28, -0.21, 0.15, leafMat],
      [0.24, 0.38, -0.02, 0.13, leafMat],
      [-0.24, 0.36, 0.05, 0.13, leafLightMat],
      [0.0, 0.52, 0.02, 0.14, leafLightMat]
    ];
    for (const [px, py, pz, r, mat] of sprigs) {
      const sprig = new THREE.Mesh(track(new THREE.IcosahedronGeometry(r, 1)), mat);
      sprig.position.set(px, py, pz);
      sprig.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      sprig.castShadow = true;
      head.add(sprig);
    }

    // --- a pair of eyes peeking out of the greenery ------------------------
    this.googlyEyes = [];
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 12, 10)), whiteMat);
      white.position.set(side * 0.12, 0.28, 0.22);
      head.add(white);
      const pupil = new THREE.Mesh(track(new THREE.SphereGeometry(0.033, 10, 8)), eyeMat);
      pupil.position.set(side * 0.12, 0.28, 0.28);
      head.add(pupil);
      this.googlyEyes.push({ pupil, baseX: side * 0.12, baseY: 0.28, seed: Math.random() * 6.28 });
    }

    // --- suit-sleeve arms with shirt-cuff hands ----------------------------
    const armGeo = track(new THREE.CylinderGeometry(0.05, 0.045, 0.36, 8));
    armGeo.translate(0, -0.18, 0);
    const handGeo = track(new THREE.SphereGeometry(0.05, 10, 8));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.27, 0.56, 0);
      pivot.rotation.z = -side * 0.35;
      const arm = new THREE.Mesh(armGeo, suitMat);
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(handGeo, shirtMat);
      hand.position.set(0, -0.38, 0);
      pivot.add(hand);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- trousered legs with polished shoes --------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.055, 0.05, 0.4, 8));
    legGeo.translate(0, -0.2, 0);
    const shoeGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.12, 0.02, 0);
      const leg = new THREE.Mesh(legGeo, suitMat);
      leg.castShadow = true;
      pivot.add(leg);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.4, 0.05);
      shoe.scale.set(1.1, 0.55, 1.8);
      pivot.add(shoe);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    return root;
  }

  /**
   * Perpendicular Bird — a pencil sketch that got up and walked off the
   * page. A flat plane bearing a hand-drawn bird in profile, facing
   * right, tiny top hat, both wings locked perfectly horizontal, and a
   * geometry-textbook right-angle marker under one wing reading 90°.
   * Casts no shadow, because drawings don't.
   */
  buildPerpBird() {
    const root = new THREE.Group();
    root.name = 'perpbird';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 512, 512);
    const PENCIL = '#4a4a52';

    // A sketchy stroke: draw twice with a slight jitter, like real pencil.
    const sketch = (draw) => {
      g.strokeStyle = PENCIL;
      g.lineWidth = 5;
      g.globalAlpha = 0.9;
      draw(0, 0);
      g.lineWidth = 2.5;
      g.globalAlpha = 0.55;
      draw(2.5, -1.5);
      g.globalAlpha = 1;
    };
    const paperFill = (draw) => {
      g.fillStyle = '#f8f6ef';
      draw();
      g.fill();
    };

    // Body (profile, facing right).
    paperFill(() => {
      g.beginPath();
      g.ellipse(240, 300, 95, 72, 0, 0, Math.PI * 2);
    });
    sketch((ox, oy) => {
      g.beginPath();
      g.ellipse(240 + ox, 300 + oy, 95, 72, 0, 0, Math.PI * 2);
      g.stroke();
    });

    // Head + beak, looking right.
    paperFill(() => {
      g.beginPath();
      g.arc(340, 205, 46, 0, Math.PI * 2);
    });
    sketch((ox, oy) => {
      g.beginPath();
      g.arc(340 + ox, 205 + oy, 46, 0, Math.PI * 2);
      g.stroke();
    });
    paperFill(() => {
      g.beginPath();
      g.moveTo(380, 195);
      g.lineTo(428, 208);
      g.lineTo(378, 222);
      g.closePath();
    });
    sketch((ox, oy) => {
      g.beginPath();
      g.moveTo(380 + ox, 195 + oy);
      g.lineTo(428 + ox, 208 + oy);
      g.lineTo(378 + ox, 222 + oy);
      g.closePath();
      g.stroke();
    });
    // Eye.
    g.fillStyle = PENCIL;
    g.beginPath();
    g.arc(350, 198, 6, 0, Math.PI * 2);
    g.fill();

    // The small top hat.
    paperFill(() => {
      g.beginPath();
      g.rect(316, 122, 46, 46);
    });
    sketch((ox, oy) => {
      g.beginPath();
      g.rect(316 + ox, 122 + oy, 46, 46);
      g.stroke();
      g.beginPath();
      g.moveTo(300 + ox, 168 + oy);
      g.lineTo(380 + ox, 168 + oy);
      g.stroke();
      g.beginPath();
      g.moveTo(318 + ox, 152 + oy);
      g.lineTo(360 + ox, 152 + oy);
      g.stroke();
    });

    // Both wings: one unbroken horizontal line of a wing each side —
    // a perfect 180° across the body.
    for (const [x0, x1] of [[42, 168], [312, 452]]) {
      paperFill(() => {
        g.beginPath();
        g.rect(x0, 282, x1 - x0, 20);
      });
      sketch((ox, oy) => {
        g.beginPath();
        g.rect(x0 + ox, 282 + oy, x1 - x0, 20);
        g.stroke();
        // feather ticks
        for (let fx = x0 + 22; fx < x1 - 8; fx += 34) {
          g.beginPath();
          g.moveTo(fx + ox, 302 + oy);
          g.lineTo(fx - 10 + ox, 316 + oy);
          g.stroke();
        }
      });
    }

    // Stick legs + feet.
    sketch((ox, oy) => {
      for (const lx of [216, 264]) {
        g.beginPath();
        g.moveTo(lx + ox, 368 + oy);
        g.lineTo(lx + ox, 438 + oy);
        g.stroke();
        g.beginPath();
        g.moveTo(lx - 14 + ox, 444 + oy);
        g.lineTo(lx + 18 + ox, 444 + oy);
        g.stroke();
      }
    });

    // The right angle, formally certified: arc + square marker + label.
    sketch((ox, oy) => {
      g.beginPath();
      g.arc(330 + ox, 302 + oy, 30, Math.PI * 0.5, Math.PI * 0.06, true);
      g.stroke();
      g.beginPath();
      g.moveTo(330 + ox, 320 + oy);
      g.lineTo(348 + ox, 320 + oy);
      g.lineTo(348 + ox, 302 + oy);
      g.stroke();
    });
    g.fillStyle = PENCIL;
    g.font = 'bold 34px "Comic Sans MS", "Segoe Print", cursive';
    g.textAlign = 'left';
    g.fillText('90°', 362, 352);

    const tex = track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;

    const sketchMat = track(createToonMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0x9a9a9a,
      emissiveIntensity: 1.0
    }));
    sketchMat.transparent = true;
    sketchMat.alphaTest = 0.15;
    sketchMat.side = THREE.DoubleSide;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    const planeGeo = track(new THREE.PlaneGeometry(1.2, 1.2));
    const sheet = new THREE.Mesh(planeGeo, sketchMat);
    sheet.scale.setScalar(1.5); // drawn at a bolder scale — she was timid
    sheet.position.y = 0.62;
    // Drawings cast no shadows; that would be presumptuous.
    body.add(sheet);
    this.rockMesh = sheet; // borrow Rhombus' waddle-rock

    this.legs = [];
    return root;
  }

  /**
   * Marblella: a glass marble with a twist of color trapped inside.
   * She rolls rather than trots — and she is the only hero dense enough
   * to walk the lake bed instead of bouncing off the water.
   */
  buildMarblella() {
    const root = new THREE.Group();
    root.name = 'marblella';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const glassMat = track(createToonMaterial({
      color: 0xd6e8ee,
      rim: { color: 0xffffff, strength: 0.85, threshold: 0.42 } // glassy edge
    }));
    glassMat.transparent = true;
    glassMat.opacity = 0.6;
    const swirlMat = track(createToonMaterial({
      color: 0x3ec8c0,
      emissive: 0x0c4844,
      emissiveIntensity: 0.5
    }));
    const swirl2Mat = track(createToonMaterial({
      color: 0xe86aa8,
      emissive: 0x50143a,
      emissiveIntensity: 0.5
    }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // The marble itself — everything inside it rolls as one.
    const marble = new THREE.Group();
    marble.position.y = 0; // center of the sphere sits at bodyGroup height
    body.add(marble);
    this.marbleMesh = marble;

    // Inner swirl first (drawn through the translucent shell): two
    // interleaved ribbons, the classic cat's-eye twist.
    const ribbonGeo = track(new THREE.TorusKnotGeometry(0.24, 0.07, 48, 8, 2, 3));
    const ribbon = new THREE.Mesh(ribbonGeo, swirlMat);
    ribbon.scale.setScalar(1.15);
    marble.add(ribbon);
    const ribbon2 = new THREE.Mesh(ribbonGeo, swirl2Mat);
    ribbon2.scale.setScalar(0.75);
    ribbon2.rotation.set(1.2, 0.5, 0.3);
    marble.add(ribbon2);

    const shellGeo = track(new THREE.SphereGeometry(0.6, 28, 20));
    const shell = new THREE.Mesh(shellGeo, glassMat);
    shell.castShadow = true;
    marble.add(shell);

    // A fixed window-light glint that does NOT roll — it stays up-left,
    // the way a marble catches the sky.
    const glintGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    const glint = new THREE.Mesh(glintGeo, glintMat);
    glint.position.set(-0.18, 0.38, 0.28);
    glint.scale.set(1, 0.6, 0.6);
    body.add(glint);

    this.legs = [];
    return root;
  }

  /**
   * President Fir Tree: three tiers of stately conifer, a red tie with
   * a gold seal pin, a star of office on the crown, and root-stub feet.
   * Elected by three jumps in a sealed grove, as the constitution
   * requires.
   */
  buildFir() {
    const root = new THREE.Group();
    root.name = 'fir';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const needleMat = track(createToonMaterial({
      color: 0x2e6b3f,
      rim: { color: 0xa8e8b0, strength: 0.45, threshold: 0.6 },
      sway: { strength: 0.05, speed: 1.8 }
    }));
    const barkMat = track(createToonMaterial({ color: 0x5c4330 }));
    const tieMat = track(createToonMaterial({ color: 0xc03038 }));
    const goldMat = track(createToonMaterial({
      color: 0xd8b830,
      emissive: 0x604010,
      emissiveIntensity: 0.6
    }));
    const eyeWhiteMat = track(createToonMaterial({ color: 0xffffff }));
    const pupilMat = track(createToonMaterial({ color: 0x101014 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // Trunk base + root-stub feet.
    const trunkGeo = track(new THREE.CylinderGeometry(0.13, 0.17, 0.5, 10));
    const trunk = new THREE.Mesh(trunkGeo, barkMat);
    trunk.position.y = -0.38;
    trunk.castShadow = true;
    body.add(trunk);
    const footGeo = track(new THREE.BoxGeometry(0.18, 0.1, 0.3));
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(footGeo, barkMat);
      foot.position.set(side * 0.13, -0.58, 0.05);
      body.add(foot);
    }

    // Three tiers of presidential foliage.
    const tierSpecs = [
      [0.58, 0.62, -0.02],
      [0.44, 0.55, 0.36],
      [0.3, 0.48, 0.68]
    ];
    for (const [r, h, ty] of tierSpecs) {
      const coneGeo = track(new THREE.ConeGeometry(r, h, 12));
      const cone = new THREE.Mesh(coneGeo, needleMat);
      cone.position.y = ty;
      cone.castShadow = true;
      body.add(cone);
    }
    // The star of office.
    const starGeo = track(new THREE.OctahedronGeometry(0.09));
    const star = new THREE.Mesh(starGeo, goldMat);
    star.position.y = 1.0;
    body.add(star);

    // The tie: knot + tail down the front, with the gold seal pin.
    const knotGeo = track(new THREE.BoxGeometry(0.11, 0.09, 0.06));
    const knot = new THREE.Mesh(knotGeo, tieMat);
    knot.position.set(0, 0.22, 0.42);
    knot.rotation.x = -0.25;
    body.add(knot);
    const tailGeo = track(new THREE.BoxGeometry(0.09, 0.34, 0.05));
    const tail = new THREE.Mesh(tailGeo, tieMat);
    tail.position.set(0, 0.0, 0.5);
    tail.rotation.x = -0.3;
    body.add(tail);
    const pinGeo = track(new THREE.SphereGeometry(0.028, 8, 6));
    const pin = new THREE.Mesh(pinGeo, goldMat);
    pin.position.set(0.03, 0.06, 0.54);
    body.add(pin);

    // Statesmanlike eyes on the middle tier.
    const eyeWhiteGeo = track(new THREE.SphereGeometry(0.06, 10, 8));
    const pupilGeo = track(new THREE.SphereGeometry(0.028, 8, 6));
    for (const side of [-1, 1]) {
      const white = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
      white.position.set(side * 0.13, 0.42, 0.3);
      white.scale.set(1, 1.15, 0.6);
      body.add(white);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(side * 0.125, 0.415, 0.34);
      body.add(pupil);
    }

    // Branch arms, for waving at constituents.
    const armGeo = track(new THREE.CylinderGeometry(0.03, 0.05, 0.42, 7));
    armGeo.translate(0, -0.21, 0);
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.42, 0.28, 0);
      pivot.rotation.z = -side * 1.0;
      const arm = new THREE.Mesh(armGeo, barkMat);
      arm.castShadow = true;
      pivot.add(arm);
      const sprigGeo = track(new THREE.ConeGeometry(0.09, 0.16, 8));
      const sprig = new THREE.Mesh(sprigGeo, needleMat);
      sprig.position.set(0, -0.44, 0);
      pivot.add(sprig);
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    this.legs = [];
    return root;
  }

  /**
   * Margaret — a classic wooden marionette: a jointed pine body with a
   * painted face, buttons for eyes, a mop of string hair, and the four
   * control strings rising to an unseen crossbar overhead. She trots
   * with the loose-limbed clatter of a puppet finding her own feet.
   */
  buildMargaret() {
    const root = new THREE.Group();
    root.name = 'margaret';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const woodMat = track(createToonMaterial({
      color: 0xc79a5e,
      rim: { color: 0xffe7bd, strength: 0.3, threshold: 0.66 }
    }));
    const jointMat = track(createToonMaterial({ color: 0x8a6338 }));
    const cheekMat = track(createToonMaterial({ color: 0xd8695a }));
    const buttonMat = track(createToonMaterial({ color: 0x2a2320 }));
    const threadMat = track(createToonMaterial({ color: 0xf2ede0 }));
    const mouthMat = track(createToonMaterial({ color: 0x6a2f28 }));
    const hairMat = track(createToonMaterial({ color: 0x9c5a2c }));
    const stringMat = track(createToonMaterial({
      color: 0xf6f0dc,
      emissive: 0x30302a,
      emissiveIntensity: 0.25
    }));

    // Everything above the legs hangs off bodyGroup for bob/squash/tilt.
    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- torso: a segmented pine block, waist joint pegged ---------------
    const chestGeo = track(new THREE.BoxGeometry(0.5, 0.42, 0.32));
    const chest = new THREE.Mesh(chestGeo, woodMat);
    chest.position.y = 0.34;
    chest.castShadow = true;
    body.add(chest);
    const pelvisGeo = track(new THREE.BoxGeometry(0.42, 0.24, 0.3));
    const pelvis = new THREE.Mesh(pelvisGeo, woodMat);
    pelvis.position.y = 0.05;
    pelvis.castShadow = true;
    body.add(pelvis);
    const waistGeo = track(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 8));
    waistGeo.rotateX(Math.PI / 2);
    const waist = new THREE.Mesh(waistGeo, jointMat);
    waist.position.y = 0.19;
    body.add(waist);

    // --- head: rounded block on a peg neck, with a painted face ----------
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.62;
    body.add(headGroup);
    this.headGroup = headGroup;
    const neckGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 8));
    const neck = new THREE.Mesh(neckGeo, jointMat);
    neck.position.y = -0.06;
    headGroup.add(neck);
    const headGeo = track(new THREE.BoxGeometry(0.4, 0.4, 0.36));
    const head = new THREE.Mesh(headGeo, woodMat);
    head.castShadow = true;
    headGroup.add(head);

    // Button eyes: dark discs with a bright cross-stitch of thread.
    const buttonGeo = track(new THREE.CylinderGeometry(0.07, 0.07, 0.025, 14));
    buttonGeo.rotateX(Math.PI / 2);
    const threadGeo = track(new THREE.BoxGeometry(0.09, 0.012, 0.01));
    for (const side of [-1, 1]) {
      const button = new THREE.Mesh(buttonGeo, buttonMat);
      button.position.set(side * 0.1, 0.04, 0.19);
      headGroup.add(button);
      const t1 = new THREE.Mesh(threadGeo, threadMat);
      t1.position.set(side * 0.1, 0.04, 0.205);
      t1.rotation.z = Math.PI / 4;
      headGroup.add(t1);
      const t2 = new THREE.Mesh(threadGeo, threadMat);
      t2.position.set(side * 0.1, 0.04, 0.205);
      t2.rotation.z = -Math.PI / 4;
      headGroup.add(t2);
    }
    // Rosy painted cheeks.
    const cheekGeo = track(new THREE.CircleGeometry(0.045, 12));
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(cheekGeo, cheekMat);
      cheek.position.set(side * 0.14, -0.07, 0.181);
      headGroup.add(cheek);
    }
    // A cheerful painted smile (a torus arc).
    const smileGeo = track(new THREE.TorusGeometry(0.07, 0.012, 6, 14, Math.PI));
    const smile = new THREE.Mesh(smileGeo, mouthMat);
    smile.position.set(0, -0.05, 0.185);
    smile.rotation.z = Math.PI;
    headGroup.add(smile);
    // A little pointed wooden nose.
    const noseGeo = track(new THREE.ConeGeometry(0.035, 0.1, 8));
    noseGeo.rotateX(Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, woodMat);
    nose.position.set(0, 0, 0.22);
    headGroup.add(nose);

    // --- string hair: a mop of yarn strands, swaying as a mane -----------
    const hair = new THREE.Group();
    hair.position.y = 0.2;
    headGroup.add(hair);
    this.hairGroup = hair;
    const strandGeo = track(new THREE.CylinderGeometry(0.012, 0.008, 0.34, 5));
    strandGeo.translate(0, -0.17, 0);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const rr = 0.12 + (i % 3) * 0.03;
      const strand = new THREE.Mesh(strandGeo, hairMat);
      strand.position.set(Math.cos(a) * rr, 0.02, Math.sin(a) * rr * 0.8);
      strand.rotation.x = Math.sin(a) * 0.3;
      strand.rotation.z = Math.cos(a) * 0.3;
      hair.add(strand);
    }

    // --- jointed arms: peg shoulders, dangling forearms ------------------
    const upperArmGeo = track(new THREE.BoxGeometry(0.09, 0.24, 0.09));
    upperArmGeo.translate(0, -0.12, 0);
    const foreArmGeo = track(new THREE.BoxGeometry(0.075, 0.22, 0.075));
    foreArmGeo.translate(0, -0.11, 0);
    const handGeo = track(new THREE.SphereGeometry(0.055, 8, 6));
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.28, 0.5, 0);
      const upper = new THREE.Mesh(upperArmGeo, woodMat);
      upper.castShadow = true;
      pivot.add(upper);
      const elbow = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 8, 6)), jointMat);
      elbow.position.y = -0.24;
      pivot.add(elbow);
      const fore = new THREE.Mesh(foreArmGeo, woodMat);
      fore.position.y = -0.24;
      pivot.add(fore);
      const hand = new THREE.Mesh(handGeo, woodMat);
      hand.position.y = -0.47;
      pivot.add(hand);
      pivot.rotation.z = -side * 0.2;
      body.add(pivot);
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0 });
    }

    // --- jointed legs: peg hips, block shins, wooden clog feet -----------
    const thighGeo = track(new THREE.BoxGeometry(0.1, 0.3, 0.1));
    thighGeo.translate(0, -0.15, 0);
    const shinGeo = track(new THREE.BoxGeometry(0.085, 0.28, 0.085));
    shinGeo.translate(0, -0.14, 0);
    const clogGeo = track(new THREE.BoxGeometry(0.12, 0.08, 0.24));
    this.legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.13, -0.05, 0);
      const thigh = new THREE.Mesh(thighGeo, woodMat);
      thigh.castShadow = true;
      pivot.add(thigh);
      const knee = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 8, 6)), jointMat);
      knee.position.y = -0.3;
      pivot.add(knee);
      const shin = new THREE.Mesh(shinGeo, woodMat);
      shin.position.y = -0.3;
      pivot.add(shin);
      const clog = new THREE.Mesh(clogGeo, jointMat);
      clog.position.set(0, -0.6, 0.05);
      pivot.add(clog);
      body.add(pivot);
      this.legs.push({ pivot, phase: side === -1 ? 0 : Math.PI });
    }

    // --- the control strings rising to an unseen crossbar overhead -------
    const strGeo = track(new THREE.CylinderGeometry(0.004, 0.004, 2.0, 4));
    strGeo.translate(0, 1.0, 0);
    for (const [sx, sy, sz] of [[-0.28, 0.5, 0], [0.28, 0.5, 0], [0, 1.0, 0], [0.13, -0.05, 0.1]]) {
      const str = new THREE.Mesh(strGeo, stringMat);
      str.position.set(sx, sy, sz);
      str.rotation.z = -sx * 0.12;
      body.add(str);
    }

    return root;
  }

  /**
   * Julie — a fluffy blue-merle doodle: a curly grey-and-white marbled
   * coat with dark patches, one black floppy ear, a black eye-mask over
   * one bright-blue eye, a shaggy grey-white beard, a black button nose
   * and a gold flower-shaped tag on her collar. A four-legged good girl.
   */
  buildJulie() {
    const root = new THREE.Group();
    root.name = 'julie';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const merle = track(createToonMaterial({
      color: 0xb7bcc4,
      rim: { color: 0xffffff, strength: 0.4, threshold: 0.6 }
    }));
    const dark = track(createToonMaterial({
      color: 0x2a2a30,
      rim: { color: 0x9db4e8, strength: 0.3, threshold: 0.66 }
    }));
    const cream = track(createToonMaterial({ color: 0xe9e4d6 }));
    const noseMat = track(createToonMaterial({ color: 0x141417, rim: { color: 0x8899cc, strength: 0.5, threshold: 0.52 } }));
    const blueEye = track(createToonMaterial({ color: 0x4aa6d8, emissive: 0x123a52, emissiveIntensity: 0.5 }));
    const glintMat = track(createToonMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    const collarMat = track(createToonMaterial({ color: 0x2f7bb0 }));
    const goldMat = track(createToonMaterial({ color: 0xd8b830, emissive: 0x604010, emissiveIntensity: 0.5 }));

    // Vertex-painted coat material (merle / dark blotch / cream belly).
    const furMat = track(createToonMaterial({
      vertexColors: true,
      rim: { color: 0xffffff, strength: 0.35, threshold: 0.62 }
    }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // A displaced, faceted icosahedron reads as a shaggy curly coat (the
    // same trick the trees and the badger's tail use) — a jagged fur
    // silhouette rather than a smooth ball. Lump noise makes the curls,
    // crinkle noise roughens the edge.
    const noise2 = this.world.detailNoise;
    const makeFluff = (a, b, cc, detail, lumpAmp = 0.24, crinkAmp = 0.08) => {
      const g = new THREE.IcosahedronGeometry(1, detail);
      const pos = g.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).normalize();
        const lump = noise2.noise(v.x * 2.7 + 13, v.z * 2.7 - v.y * 1.9);
        const crink = furNoise(v.x * 6 + 1, v.y * 6, v.z * 6) - 0.5;
        const bump = 1 + lump * lumpAmp + crink * crinkAmp;
        pos.setXYZ(i, v.x * a * bump, v.y * b * bump, v.z * cc * bump);
      }
      g.computeVertexNormals();
      return track(g);
    };
    const S = THREE.MathUtils.smoothstep;

    // --- torso: one shaggy dog-shaped mass, merle with cream belly -----
    const bodyGeo = makeFluff(0.5, 0.44, 0.68, 3);
    paintVertexColors(bodyGeo, (n, p, c) => {
      c.set(0xb7bcc4); // merle base
      // Dark blue-merle blotches from a smooth noise field.
      const blotch = noise2.noise(n.x * 2.1 + 40, n.z * 2.1 - n.y * 1.4);
      c.lerp(new THREE.Color(0x2a2a30), S(blotch, 0.3, 0.55));
      // Darker along the spine.
      c.offsetHSL(0, 0, -S(n.y, 0.4, 0.9) * 0.05);
      // Pale cream belly + chest.
      c.lerp(new THREE.Color(0xe9e4d6), S(-n.y, 0.15, 0.65) * 0.88);
      // Fine tonal crinkle.
      c.offsetHSL(0, 0, (furNoise(p.x * 8, p.y * 8, p.z * 8) - 0.5) * 0.05);
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, furMat);
    bodyMesh.castShadow = true;
    body.add(bodyMesh);

    // --- head, tilted alert -------------------------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.34, 0.68);
    headGroup.rotation.z = 0.05;
    body.add(headGroup);
    this.headGroup = headGroup;

    const headGeo = makeFluff(0.33, 0.31, 0.35, 3);
    paintVertexColors(headGeo, (n, p, c) => {
      c.set(0xb7bcc4);
      const blotch = noise2.noise(n.x * 3 + 7, n.z * 3 - n.y * 2);
      c.lerp(new THREE.Color(0x2a2a30), S(blotch, 0.34, 0.55));
      // The black eye-mask: front-right of the face, around one eye.
      const mask = S(n.x, 0.05, 0.5) * S(n.z, -0.25, 0.4) * (1 - S(n.y, 0.45, 0.8));
      c.lerp(new THREE.Color(0x1b1b21), mask);
      c.offsetHSL(0, 0, (furNoise(p.x * 8, p.y * 8, p.z * 8) - 0.5) * 0.05);
    });
    const headMesh = new THREE.Mesh(headGeo, furMat);
    headMesh.castShadow = true;
    headGroup.add(headMesh);

    // Fluffy grey-white muzzle + a shaggy beard hanging below it.
    const muzzle = new THREE.Mesh(makeFluff(0.17, 0.15, 0.2, 2, 0.18), cream);
    muzzle.position.set(0, -0.12, 0.26);
    muzzle.castShadow = true;
    headGroup.add(muzzle);
    const beard = new THREE.Mesh(makeFluff(0.15, 0.2, 0.13, 2, 0.28), cream);
    beard.position.set(0, -0.28, 0.16);
    beard.castShadow = true;
    headGroup.add(beard);
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 12, 10)), noseMat);
    nose.position.set(0, -0.06, 0.46);
    headGroup.add(nose);

    // Bright blue eyes with glints (the right one sits in the mask).
    const eyeGeo = track(new THREE.SphereGeometry(0.055, 12, 10));
    const glintGeo = track(new THREE.SphereGeometry(0.016, 8, 6));
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, blueEye);
      eye.position.set(side * 0.14, 0.05, 0.3);
      headGroup.add(eye);
      const glint = new THREE.Mesh(glintGeo, glintMat);
      glint.position.set(side * 0.12, 0.08, 0.35);
      headGroup.add(glint);
    }

    // Floppy shaggy ears: left black, right grey — displaced fur blobs.
    this.hairGroup = new THREE.Group(); // lets the ears sway via the mane path
    headGroup.add(this.hairGroup);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(makeFluff(0.12, 0.26, 0.14, 2, 0.3), side === -1 ? dark : merle);
      ear.position.set(side * 0.28, -0.04, -0.02);
      ear.rotation.z = side * 0.3;
      ear.castShadow = true;
      this.hairGroup.add(ear);
    }

    // Collar with the gold flower tag.
    const collar = new THREE.Mesh(track(new THREE.TorusGeometry(0.24, 0.04, 8, 20)), collarMat);
    collar.position.set(0, 0.08, 0.48);
    collar.rotation.x = 1.3;
    body.add(collar);
    const tag = new THREE.Group();
    tag.position.set(0, -0.12, 0.62);
    body.add(tag);
    for (let i = 0; i < 5; i++) {
      const petal = new THREE.Mesh(track(new THREE.SphereGeometry(0.04, 8, 6)), goldMat);
      const a = (i / 5) * Math.PI * 2;
      petal.position.set(Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0);
      tag.add(petal);
    }
    const tagCenter = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), goldMat);
    tag.add(tagCenter);

    // Shaggy curled plume of a tail — a displaced fur blob.
    const tail = new THREE.Mesh(makeFluff(0.15, 0.22, 0.16, 2, 0.32), merle);
    tail.position.set(0, 0.18, -0.6);
    tail.castShadow = true;
    body.add(tail);
    this.tail = tail;

    // --- four legs: a furry cuff over the paw --------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.09, 0.1, 0.34, 10));
    const pawGeo = track(new THREE.SphereGeometry(0.12, 12, 10));
    this.legs = [];
    const slots = [
      { x: -0.26, z: 0.38, phase: 0 },
      { x: 0.26, z: 0.38, phase: Math.PI },
      { x: -0.28, z: -0.42, phase: Math.PI },
      { x: 0.28, z: -0.42, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.26, slot.z);
      const leg = new THREE.Mesh(legGeo, merle);
      leg.position.y = -0.15;
      leg.castShadow = true;
      pivot.add(leg);
      // A shaggy fur cuff where the leg meets the body.
      const cuff = new THREE.Mesh(makeFluff(0.13, 0.1, 0.13, 1, 0.32), merle);
      cuff.position.y = -0.02;
      pivot.add(cuff);
      const paw = new THREE.Mesh(pawGeo, dark);
      paw.position.set(0, -0.34, 0.04);
      paw.scale.set(1, 0.7, 1.2);
      paw.castShadow = true;
      pivot.add(paw);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    return root;
  }

  /**
   * Turnip Scart — the goat from the vegetable patch, now playable: a
   * cream body with a woolly dark saddle, curved horns, floppy ears, a
   * chin beard and dark hooves. Beat him at Veggie Tac Toe to earn him.
   */
  buildTurnip() {
    const root = new THREE.Group();
    root.name = 'turnip';

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    const coat = track(createToonMaterial({
      color: 0xe8e2d2,
      rim: { color: 0xffffff, strength: 0.35, threshold: 0.64 }
    }));
    const dark = track(createToonMaterial({ color: 0x6a5c48 }));
    const hoof = track(createToonMaterial({ color: 0x2b2620 }));
    const hornMat = track(createToonMaterial({ color: 0xbfae86, rim: { color: 0xffedc0, strength: 0.4, threshold: 0.6 } }));
    const noseMat = track(createToonMaterial({ color: 0x3a2f28 }));
    const eyeMat = track(createToonMaterial({ color: 0x141210 }));

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.62;
    root.add(body);
    this.bodyGroup = body;

    // --- torso + saddle + stubby tail ----------------------------------
    const torsoGeo = track(new THREE.CapsuleGeometry(0.36, 0.56, 6, 12));
    torsoGeo.rotateX(Math.PI / 2); // long axis along Z (forward)
    const torso = new THREE.Mesh(torsoGeo, coat);
    torso.scale.set(0.95, 0.95, 1.15);
    torso.castShadow = true;
    body.add(torso);
    const saddle = new THREE.Mesh(track(new THREE.SphereGeometry(0.3, 16, 12)), dark);
    saddle.position.set(0, 0.16, -0.05);
    saddle.scale.set(0.9, 0.5, 1.35);
    body.add(saddle);
    const tail = new THREE.Mesh(track(new THREE.ConeGeometry(0.08, 0.2, 6)), coat);
    tail.position.set(0, 0.14, -0.62);
    tail.rotation.x = -1.2;
    body.add(tail);
    this.tail = tail;

    // --- head (dips when idle via headGroup) ---------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.24, 0.56);
    body.add(headGroup);
    this.headGroup = headGroup;

    const neck = new THREE.Mesh(track(new THREE.CylinderGeometry(0.13, 0.17, 0.42, 10)), coat);
    neck.position.set(0, 0.12, -0.06);
    neck.rotation.x = 0.7;
    neck.castShadow = true;
    headGroup.add(neck);
    const headGeo = track(new THREE.CapsuleGeometry(0.15, 0.22, 5, 10));
    headGeo.rotateX(Math.PI / 2);
    const head = new THREE.Mesh(headGeo, coat);
    head.position.set(0, 0.3, 0.22);
    head.scale.set(0.95, 0.85, 1.15);
    head.castShadow = true;
    headGroup.add(head);
    const nose = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 10, 8)), noseMat);
    nose.position.set(0, 0.26, 0.44);
    nose.scale.set(1, 0.8, 0.7);
    headGroup.add(nose);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(track(new THREE.ConeGeometry(0.07, 0.22, 6)), coat);
      ear.position.set(side * 0.16, 0.4, 0.18);
      ear.rotation.set(1.9, 0, side * 0.6);
      headGroup.add(ear);
      const horn = new THREE.Mesh(track(new THREE.ConeGeometry(0.05, 0.3, 7)), hornMat);
      horn.position.set(side * 0.09, 0.5, 0.14);
      horn.rotation.set(-0.5, 0, side * 0.25);
      horn.castShadow = true;
      headGroup.add(horn);
      const eye = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), eyeMat);
      eye.position.set(side * 0.11, 0.34, 0.34);
      headGroup.add(eye);
    }
    const beard = new THREE.Mesh(track(new THREE.ConeGeometry(0.06, 0.22, 6)), coat);
    beard.position.set(0, 0.12, 0.4);
    beard.rotation.x = -0.3;
    headGroup.add(beard);

    // --- four legs with dark hooves ------------------------------------
    const legGeo = track(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 8));
    legGeo.translate(0, -0.25, 0);
    const hoofGeo = track(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8));
    this.legs = [];
    const slots = [
      { x: -0.22, z: 0.32, phase: 0 },
      { x: 0.22, z: 0.32, phase: Math.PI },
      { x: -0.24, z: -0.34, phase: Math.PI },
      { x: 0.24, z: -0.34, phase: 0 }
    ];
    for (const slot of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, -0.3, slot.z);
      const leg = new THREE.Mesh(legGeo, coat);
      leg.castShadow = true;
      pivot.add(leg);
      const hf = new THREE.Mesh(hoofGeo, hoof);
      hf.position.y = -0.5;
      pivot.add(hf);
      body.add(pivot);
      this.legs.push({ pivot, phase: slot.phase });
    }

    return root;
  }

  /**
   * Haunted Sweatshirt — an ethereal, faceless blue garment that floats
   * where a body should be. A boxy translucent torso with a ribbed hem,
   * collar and cuffs; a dark empty neck void instead of a head; and two
   * limp sleeves that dangle as arms so they sway. No legs, no face — it
   * simply drifts (isFloaty), lit from within by a cold spectral glow.
   */
  buildSweatshirt() {
    const root = new THREE.Group();
    root.name = 'sweatshirt';
    this.isFloaty = true;

    const track = (resource) => {
      this._disposables.push(resource);
      return resource;
    };

    // Translucent glowing cloth — double-sided so the hollow interior reads.
    const clothMat = track(createToonMaterial({
      color: 0x5b8fd8,
      emissive: 0x2a5fb0,
      emissiveIntensity: 0.9,
      rim: { color: 0xcfe4ff, strength: 0.7, threshold: 0.4 }
    }));
    clothMat.transparent = true;
    clothMat.opacity = 0.62;
    clothMat.side = THREE.DoubleSide;
    clothMat.depthWrite = false;

    // A slightly deeper tone for the ribbed knit trim.
    const ribMat = track(createToonMaterial({
      color: 0x3f6fc0,
      emissive: 0x24509a,
      emissiveIntensity: 0.8,
      rim: { color: 0xbcd6ff, strength: 0.6, threshold: 0.45 }
    }));
    ribMat.transparent = true;
    ribMat.opacity = 0.7;
    ribMat.side = THREE.DoubleSide;
    ribMat.depthWrite = false;

    // The empty neck hole: an unlit void where a head never was.
    const voidMat = track(createToonMaterial({ color: 0x060912 }));
    voidMat.side = THREE.DoubleSide;

    const body = new THREE.Group();
    body.name = 'body';
    body.position.y = 0.72;
    root.add(body);
    this.bodyGroup = body;

    // --- torso: a soft boxy sweatshirt, gently barrelled --------------------
    const torsoGeo = track(new THREE.BoxGeometry(0.64, 0.62, 0.4, 8, 8, 6));
    {
      const pos = torsoGeo.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        // Barrel the sides out a touch and soften the corners.
        const bulge = 1 + (1 - Math.abs(v.y / 0.31)) * 0.12;
        v.x *= bulge;
        v.z *= bulge * (1 + Math.abs(v.x) * 0.15);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      torsoGeo.computeVertexNormals();
    }
    const torso = new THREE.Mesh(torsoGeo, clothMat);
    torso.castShadow = true;
    body.add(torso);

    // Ribbed waist hem.
    const hem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 20, 1, true)), ribMat);
    hem.scale.set(1, 1, 1.18);
    hem.position.y = -0.34;
    body.add(hem);

    // --- collar + hollow neck void -----------------------------------------
    const collar = new THREE.Mesh(track(new THREE.TorusGeometry(0.15, 0.05, 8, 20)), ribMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.34;
    body.add(collar);
    const neckVoid = new THREE.Mesh(track(new THREE.CylinderGeometry(0.13, 0.15, 0.22, 18, 1, true)), voidMat);
    neckVoid.position.y = 0.3;
    body.add(neckVoid);
    // A cap at the bottom of the void so you can't see clean through.
    const voidFloor = new THREE.Mesh(track(new THREE.CircleGeometry(0.14, 18)), voidMat);
    voidFloor.rotation.x = -Math.PI / 2;
    voidFloor.position.y = 0.2;
    body.add(voidFloor);

    // A faint inner glow orb suggesting the spectral presence within.
    const ghostMat = track(createToonMaterial({
      color: 0xbfe0ff,
      emissive: 0x9cc8ff,
      emissiveIntensity: 1.5,
      pulse: { speed: 2.4, phase: 0 }
    }));
    ghostMat.transparent = true;
    ghostMat.opacity = 0.5;
    const ghost = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 12, 10)), ghostMat);
    ghost.position.y = 0.05;
    body.add(ghost);

    // --- two dangling sleeves, rigged as swaying arms -----------------------
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, 0.24, 0);
      // Shoulder cloth swells then tapers into the sleeve.
      const sleeveGeo = track(new THREE.CapsuleGeometry(0.11, 0.42, 5, 10));
      const sleeve = new THREE.Mesh(sleeveGeo, clothMat);
      sleeve.position.y = -0.28;
      sleeve.scale.set(1.05, 1, 1.05);
      sleeve.rotation.z = side * 0.12;
      sleeve.castShadow = true;
      pivot.add(sleeve);
      // Ribbed cuff at the wrist opening.
      const cuff = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 12, 1, true)), ribMat);
      cuff.position.set(side * 0.06, -0.52, 0);
      pivot.add(cuff);
      body.add(pivot);
      // Sleeves hang down at rest (offset the swing so they droop).
      this.arms.push({ pivot, phase: side === -1 ? Math.PI : 0, droop: 0.35 });
    }

    // No legs — it floats.
    this.legs = [];

    return root;
  }

  /* ================================================================ */
  /*  Physics                                                         */
  /* ================================================================ */

  /**
   * @param {number} dt        clamped frame delta (s)
   * @param {import('./Input.js').Input} input
   * @param {number} cameraYaw camera azimuth — movement is camera-relative
   */
  update(dt, input, cameraYaw) {
    if (this.vehicle) {
      this.updateVehicle(dt, input, cameraYaw);
      return;
    }
    const T = TUNING;
    const pos = this.position;
    const vel = this.velocity;

    // ---- wish direction in world space (camera relative) ----------------
    const ax = input.axisX;
    const ay = input.axisY;
    const wish = this._wishDir.set(
      -Math.sin(cameraYaw) * ay + Math.cos(cameraYaw) * ax,
      0,
      -Math.cos(cameraYaw) * ay - Math.sin(cameraYaw) * ax
    );
    const hasInput = wish.lengthSq() > 1e-6;
    if (hasInput) wish.normalize();

    // ---- timers ----------------------------------------------------------
    this.coyoteTimer = this.grounded ? T.coyoteTime : Math.max(0, this.coyoteTimer - dt);
    if (input.consumeJump()) this.jumpBufferTimer = T.jumpBufferTime;
    else this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);

    // ---- horizontal dynamics --------------------------------------------
    const steep = this.grounded && this.groundNormal.y < T.steepSlopeNormalY;
    if (this.grounded && !steep) {
      // Accelerate toward the wish velocity; decelerate via friction when
      // idle. moveToward never overshoots, so there is no oscillation.
      const targetX = wish.x * T.maxSpeed * this.moveScale;
      const targetZ = wish.z * T.maxSpeed * this.moveScale;
      const rate = hasInput
        ? T.groundAccel * this.accelScale
        : T.groundFriction * this.frictionScale;
      vel.x = moveToward(vel.x, targetX, rate * dt);
      vel.z = moveToward(vel.z, targetZ, rate * dt);
    } else {
      // Airborne (or sliding): momentum is conserved — only limited
      // steering is added, and speed gained from slides is never clipped
      // back to walk speed.
      if (hasInput) {
        const preSpeed = Math.hypot(vel.x, vel.z);
        vel.x += wish.x * T.airAccel * dt;
        vel.z += wish.z * T.airAccel * dt;
        const cap = Math.max(T.maxSpeed * this.moveScale, preSpeed);
        const speed = Math.hypot(vel.x, vel.z);
        if (speed > cap) {
          const s = cap / speed;
          vel.x *= s;
          vel.z *= s;
        }
      }
      if (steep) {
        // Slide down the fall line of the slope.
        const n = this.groundNormal;
        const downX = -n.x * n.y;
        const downZ = -n.z * n.y;
        const len = Math.hypot(downX, downZ) || 1;
        vel.x += (downX / len) * T.slideAccel * dt;
        vel.z += (downZ / len) * T.slideAccel * dt;
      }
    }

    // ---- jump ------------------------------------------------------------
    let jumpedThisFrame = false;
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && !steep) {
      vel.y = T.jumpSpeed * this.jumpScale;
      this.grounded = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      jumpedThisFrame = true;
      this.squash = -0.25; // stretch on takeoff
      if (this.onJump) this.onJump(pos);
    }

    // ---- gravity -----------------------------------------------------------
    if (!this.grounded || jumpedThisFrame) {
      let g = T.gravity * this.gravityScale;
      if (vel.y < 0) g *= T.fallGravityScale;
      else if (!input.jumpHeld) g *= T.shortHopGravityScale; // short hop
      vel.y = Math.max(vel.y - g * dt, -T.maxFallSpeed);
    }

    // ---- integrate ----------------------------------------------------------
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    // ---- obstacle push-out (cylinder colliders: trunks, rocks, tower) -------
    this.resolveColliders();

    // ---- world bounds --------------------------------------------------------
    const b = this.world.playableRadius;
    const distFromCenter = Math.hypot(pos.x, pos.z);
    if (distFromCenter > b) {
      const s = b / distFromCenter;
      pos.x *= s;
      pos.z *= s;
      // Kill outward velocity so the edge doesn't feel springy.
      const nx = pos.x / b;
      const nz = pos.z / b;
      const outward = vel.x * nx + vel.z * nz;
      if (outward > 0) {
        vel.x -= outward * nx;
        vel.z -= outward * nz;
      }
    }

    // ---- ground resolution ---------------------------------------------------
    // Terrain, or a stair/platform top when one is underfoot and in reach.
    const terrainH = this.world.getHeight(pos.x, pos.z);
    // Candy Florence hovers: her resting floor sits a little above the turf.
    let groundH = this.world.getGroundHeight(pos.x, pos.z, pos.y, terrainH) + this.hoverHeight;
    // Spirit of the Forest Badger treads the water's surface: over either
    // lake the water level itself becomes the floor.
    if (this.walksOnWater) {
      const surfaceWl = this.world.waterAt(pos.x, pos.z);
      if (surfaceWl !== undefined) groundH = Math.max(groundH, surfaceWl - this.waterSink);
    }
    if (groundH > terrainH + 1e-3) {
      this.groundNormal.set(0, 1, 0); // platforms are dead level
    } else {
      this.world.getNormal(pos.x, pos.z, this.groundNormal);
    }
    const wasGrounded = this.grounded;

    if (pos.y <= groundH) {
      pos.y = groundH;
      if (!wasGrounded && vel.y < -3 && this.onLand) {
        this.onLand(-vel.y, pos);
      }
      if (!wasGrounded) this.squash = clamp(-vel.y / 26, 0.1, 0.55);
      vel.y = 0;
      this.grounded = true;
    } else if (
      wasGrounded &&
      !jumpedThisFrame &&
      vel.y <= 0.01 &&
      pos.y - groundH <= T.groundSnapDistance
    ) {
      // Walking downhill: snap to the surface instead of micro-falling every
      // frame — this is what kills slope jitter and false "airborne" states.
      pos.y = groundH;
      vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // ---- safety net -----------------------------------------------------------
    if (pos.y < -40) this.respawn();

    // ---- water: badgers (and crisp packets) cannot swim -----------------------
    // Only actual lake water counts — low valleys elsewhere are just valleys.
    // Marblella is the exception: TOO DENSE to bounce, she simply sinks
    // and trundles along the lake bed.
    const wl = this.world.waterAt(pos.x, pos.z); // main lake or whirlpool lake
    const inLake = wl !== undefined;
    const sinks = this.character === 'marblella';
    if (inLake && pos.y < wl - 0.4 && !sinks && !this.walksOnWater) {
      // Too deep — bounce back to the last dry footing with a splash.
      pos.copy(this._lastDryPos);
      vel.x *= -0.35;
      vel.z *= -0.35;
      vel.y = 4.5;
      this.grounded = false;
      if (this.onSplash) this.onSplash();
    } else if (this.grounded && (!inLake || groundH > wl + 0.05)) {
      this._lastDryPos.copy(pos);
    }
    if (sinks && inLake && pos.y < wl - 0.2) {
      // Underwater: the water drags at her, and even a dense marble
      // doesn't plummet — but she never floats.
      const drag = 1 / (1 + 2.2 * dt);
      vel.x *= drag;
      vel.z *= drag;
      if (vel.y < -7) vel.y = -7;
    }

    // ---- pose -------------------------------------------------------------------
    this.root.position.copy(pos);
    this.animate(dt, hasInput);
  }

  /**
   * Vehicle physics. Hovercraft: drifty, jump-free, skims turf and lake
   * alike. Balloon: floatier still, and the jump button is the burner —
   * hold to rise, release to sink gently.
   */
  updateVehicle(dt, input, cameraYaw) {
    const pos = this.position;
    const vel = this.velocity;
    const kind = this.vehicle.kind;
    const isBalloon = kind === 'balloon';
    const isRocket = kind === 'rocket';
    const flies = isBalloon || isRocket;

    const ax = input.axisX;
    const ay = input.axisY;
    const wish = this._wishDir.set(
      -Math.sin(cameraYaw) * ay + Math.cos(cameraYaw) * ax,
      0,
      -Math.cos(cameraYaw) * ay - Math.sin(cameraYaw) * ax
    );
    const hasInput = wish.lengthSq() > 1e-6;
    if (hasInput) wish.normalize();

    const MAX_SPEED = isRocket ? 14 : isBalloon ? 7 : 11;
    const rate = isRocket
      ? (hasInput ? 11 : 2.5)
      : isBalloon
        ? (hasInput ? 6 : 1.3)
        : hasInput ? 14 : 3.5;
    vel.x = moveToward(vel.x, wish.x * MAX_SPEED, rate * dt);
    vel.z = moveToward(vel.z, wish.z * MAX_SPEED, rate * dt);
    if (flies) {
      // Burner or main engine: hold jump to climb, release to sink.
      const upTarget = isRocket ? 13 : 3.6;
      const downTarget = isRocket ? -5.5 : -2.0;
      const vRate = isRocket ? 15 : 4.5;
      vel.y = moveToward(vel.y, input.jumpHeld ? upTarget : downTarget, vRate * dt);
      pos.y += vel.y * dt;
    } else {
      vel.y = 0;
    }
    input.consumeJump(); // the press is engine/nothing, never a jump

    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    this.resolveColliders();

    const b = this.world.playableRadius;
    const distFromCenter = Math.hypot(pos.x, pos.z);
    if (distFromCenter > b) {
      const s = b / distFromCenter;
      pos.x *= s;
      pos.z *= s;
    }

    // The Mystic Forest is closed at the top: no vehicle may descend
    // into the dell. High overflight is fine; its dome is solid rock.
    const w = this.world;
    if (w.dellRadius) {
      const ddx = pos.x - w.dellX;
      const ddz = pos.z - w.dellZ;
      const keepOut = w.dellRadius + 5.5;
      const dSq = ddx * ddx + ddz * ddz;
      if (dSq < keepOut * keepOut && pos.y < w.dellLevel + 13) {
        const d = Math.sqrt(dSq);
        // Dead center has no outward direction — invent one.
        const nx = d > 1e-4 ? ddx / d : 1;
        const nz = d > 1e-4 ? ddz / d : 0;
        pos.x = w.dellX + nx * keepOut;
        pos.z = w.dellZ + nz * keepOut;
      }
    }

    // Floor is turf or lake water, whichever is higher (either lake).
    const terrainH = this.world.getHeight(pos.x, pos.z);
    const vehicleWl = this.world.waterAt(pos.x, pos.z);
    const overLake = vehicleWl !== undefined;
    const wetFloor = overLake ? vehicleWl : -Infinity;
    const surface = Math.max(terrainH, wetFloor);

    if (flies) {
      const floorY = surface + (isRocket ? 3.4 : 1.1); // hull/basket clearance
      if (pos.y < floorY) {
        pos.y = floorY;
        if (vel.y < 0) vel.y = 0;
      }
      // Balloons stay in the weather; rockets reach the stars.
      const ceilingY = isRocket ? 130 : Math.max(terrainH + 40, 28);
      if (pos.y > ceilingY) {
        pos.y = ceilingY;
        if (vel.y > 0) vel.y = 0;
      }
    } else {
      pos.y = damp(pos.y, surface + 0.55, 7, dt);
      vel.y = 0;
    }
    this.grounded = true;

    if (!overLake || terrainH > vehicleWl + 0.05) {
      this._lastDryPos.set(pos.x, terrainH, pos.z);
    }

    this.root.position.copy(pos);
    this.animate(dt, hasInput);
    const throttle = flies
      ? (input.jumpHeld ? 1 : 0)
      : Math.hypot(vel.x, vel.z) / MAX_SPEED;
    this.vehicle.syncWithRider(pos, this.facingYaw, throttle, dt);
  }

  resolveColliders() {
    const pos = this.position;
    const R = TUNING.radius;
    const colliders = this.world.colliders;
    // Colliders are infinite below their top, which is right for trees
    // and rocks — but down at station depth the surface world (notably
    // the cottage's walls, sitting directly overhead) must not reach.
    // Nothing exists this deep except the station, so the cutoff is safe.
    const st = this.world.station;
    const underground = st && pos.y < st.floorY + 6.5;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (pos.y > c.top) continue;
      if (underground && c.top > st.floorY + 7) continue;
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const minDist = c.radius + R;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist || distSq < 1e-10) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const push = minDist - dist;
      pos.x += nx * push;
      pos.z += nz * push;
      // Remove the velocity component driving into the obstacle so the
      // player slides along it instead of grinding.
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= into * nx;
        this.velocity.z -= into * nz;
      }
    }
  }

  respawn() {
    this.position.copy(this.spawnPoint);
    this.position.y = this.world.getHeight(this.spawnPoint.x, this.spawnPoint.z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
  }

  /**
   * Drop the Nucleus' trail history. Called when she teleports, so the
   * ghosts don't smear a glowing streak clean across the map from wherever
   * she just was to wherever she just turned up.
   */
  clearTrail() {
    if (!this._trailPts) return;
    this._trailPts.length = 0;
    for (const ghost of this._trailMeshes) ghost.visible = false;
  }

  /** Applied by Game when a toxic frog connects. */
  applyKnockback(fromX, fromZ, strength = 9) {
    const dx = this.position.x - fromX;
    const dz = this.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.velocity.x = (dx / len) * strength;
    this.velocity.z = (dz / len) * strength;
    this.velocity.y = Math.max(this.velocity.y, 5.5);
    this.grounded = false;
  }

  /** Sphere center used for pickup/hazard overlap tests. */
  getColliderCenter(out) {
    return out.set(this.position.x, this.position.y + 0.7, this.position.z);
  }

  get colliderRadius() {
    return 0.75;
  }

  /* ================================================================ */
  /*  Procedural animation                                            */
  /* ================================================================ */

  animate(dt, hasInput) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const speedT = clamp(speed / TUNING.maxSpeed, 0, 1);

    // Face the direction of travel.
    if (speed > 0.6) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      this.facingYaw = dampAngle(this.facingYaw, targetYaw, 12, dt);
    }
    this.root.rotation.y = this.facingYaw;

    // Trot cycle driven by ground distance covered, so feet never slide.
    const riding = Boolean(this.vehicle);
    if (this.grounded && !riding) this.walkCycle += speed * dt * 2.4;

    for (const leg of this.legs) {
      let target;
      if (riding) {
        target = 0; // planted on the hovercraft deck
      } else if (this.grounded) {
        target = Math.sin(this.walkCycle + leg.phase) * 0.75 * speedT;
      } else {
        // Airborne: tuck front legs, trail rear legs.
        target = leg.phase === 0 ? -0.9 : 0.7;
      }
      leg.pivot.rotation.x = damp(leg.pivot.rotation.x, target, 18, dt);
    }

    // Landing squash / takeoff stretch, springing back to neutral.
    this.squash = damp(this.squash, 0, 10, dt);
    const sy = 1 - this.squash;
    const sxz = 1 + this.squash * 0.55;
    this.bodyGroup.scale.set(sxz, sy, sxz);

    // Body bob while trotting + slight pitch into jumps and falls.
    const bob = this.grounded && !riding ? Math.abs(Math.sin(this.walkCycle)) * 0.055 * speedT : 0;
    this.bodyGroup.position.y = 0.62 + bob;
    const targetTilt = this.grounded ? 0 : clamp(-this.velocity.y * 0.022, -0.3, 0.42);
    this.airTilt = damp(this.airTilt, targetTilt, 8, dt);
    this.bodyGroup.rotation.x = this.airTilt;

    // Idle life: tail sway and a sniffing nose-bob when standing still.
    const t = performance.now() / 1000;
    if (this.tail) {
      this.tail.rotation.y = Math.sin(t * 2.1) * 0.35;
      this.tail.rotation.x = Math.sin(t * 1.7) * 0.2;
    }
    if (this.headGroup) {
      if (!hasInput && this.grounded) {
        this.headGroup.rotation.x = -0.08 + Math.sin(t * 2.6) * 0.05;
        this.headGroup.rotation.y = Math.sin(t * 0.9) * 0.22;
      } else {
        this.headGroup.rotation.x = damp(this.headGroup.rotation.x, -0.08, 10, dt);
        this.headGroup.rotation.y = damp(this.headGroup.rotation.y, 0, 10, dt);
      }
    }

    // Badgerette's mane: gentle idle sway, streams back at speed, lifts in air.
    if (this.hairGroup) {
      const lift = speedT * 0.35 + (this.grounded ? 0 : 0.25);
      this.hairGroup.rotation.x = damp(this.hairGroup.rotation.x, lift, 6, dt) + Math.sin(t * 2.1) * 0.045;
      this.hairGroup.rotation.z = Math.sin(t * 1.4) * 0.06 + Math.sin(this.walkCycle) * 0.05 * speedT;
    }

    // Stick arms pump while trotting, flail skyward in the air, and grip
    // an imaginary tiller while riding.
    if (this.arms) {
      for (const arm of this.arms) {
        let target;
        if (riding) {
          target = -0.6;
        } else if (this.grounded) {
          target = Math.sin(this.walkCycle + arm.phase) * 0.65 * speedT;
        } else {
          target = -2.4; // arms up — wheeee
        }
        arm.pivot.rotation.x = damp(arm.pivot.rotation.x, target, 14, dt);
      }
    }

    // Marblella: a marble rolls — angular speed matched to ground speed
    // so she never skids. (root already faces the travel direction, so
    // rolling is a plain pitch about local X.)
    if (this.marbleMesh) {
      this.marbleMesh.rotation.x += (speed / 0.6) * dt;
    }

    // Rhombus: waddle-rock while trotting, pinwheel gently in the air.
    if (this.rockMesh) {
      if (this.grounded || riding) {
        this.rockMesh.rotation.z = damp(
          this.rockMesh.rotation.z,
          Math.sin(this.walkCycle) * 0.17 * speedT,
          16,
          dt
        );
      } else {
        this.rockMesh.rotation.z += dt * 3.2; // aerial flourish
      }
    }

    // Error #42: brief positional corruption every couple of seconds.
    if (this.isGlitchy) {
      const cycle = t % 2.3;
      if (cycle < 0.13) {
        const s = Math.sin(t * 173.3);
        this.bodyGroup.position.x = s * 0.055;
        this.bodyGroup.rotation.y = s * 0.1;
      } else {
        this.bodyGroup.position.x = 0;
        this.bodyGroup.rotation.y = 0;
      }
    }

    // The Nucleus Of Time Itself: electrons race their orbits, the core
    // turns slowly, the glow breathes, and a trail of ghosts marks where
    // she has just been.
    if (this.nucleusRings) {
      for (const ring of this.nucleusRings) ring.spinner.rotation.z += ring.speed * dt;
      this.bodyGroup.rotation.y += dt * 0.35;
      this.bodyGroup.position.y = Math.sin(t * 1.5) * 0.07;

      // The trail group is counter-rotated so its offsets stay world-aligned
      // while the root turns to face travel.
      this._trailGroup.rotation.y = -this.root.rotation.y;
      this._trailTick = (this._trailTick || 0) + dt;
      if (this._trailTick > 0.07) {
        this._trailTick = 0;
        // Recycle the oldest point rather than allocating a fresh Vector3
        // several times a second for the whole run.
        const pt = this._trailPts.length >= this._trailMeshes.length
          ? this._trailPts.pop()
          : new THREE.Vector3();
        this._trailPts.unshift(pt.copy(this.position));
      }
      for (let i = 0; i < this._trailMeshes.length; i++) {
        const ghost = this._trailMeshes[i];
        const pt = this._trailPts[i];
        if (!pt) { ghost.visible = false; continue; }
        const fade = 1 - i / this._trailMeshes.length;
        ghost.visible = true;
        // Local offset = world delta, un-rotated by the counter-rotation.
        ghost.position.set(
          pt.x - this.position.x,
          pt.y - this.position.y,
          pt.z - this.position.z
        );
        ghost.scale.setScalar(0.35 + fade * 0.6);
        ghost.material.opacity = fade * 0.4;
      }
    }

    // Haunted Sweatshirt: an ethereal idle hover and slow spectral sway,
    // the empty garment drifting as if held aloft by nothing at all. The
    // dangling sleeves swing lazily out of phase with the body.
    if (this.isFloaty) {
      this.bodyGroup.position.y += Math.sin(t * 1.8) * 0.06;
      this.bodyGroup.rotation.z = Math.sin(t * 1.3) * 0.05;
      this.bodyGroup.rotation.y += Math.sin(t * 0.7) * 0.06;
      if (this.arms) {
        for (const arm of this.arms) {
          arm.pivot.rotation.z = Math.sin(t * 1.5 + arm.phase) * 0.14;
        }
      }
    }

    // Pickle Stick hops: a springy bounce that gets bigger with speed, plus
    // a jaunty idle jiggle when standing still, and a squash at the bottom.
    if (this.isBouncy) {
      const hop = this.grounded
        ? Math.abs(Math.sin(this.walkCycle)) * (0.1 + speedT * 0.28)
        : 0;
      const idle = !hasInput && this.grounded ? Math.abs(Math.sin(t * 3.2)) * 0.05 : 0;
      this.bodyGroup.position.y = 0.62 + hop + idle;
      this.bodyGroup.rotation.z = Math.sin(this.walkCycle) * 0.12 * speedT;
      const squashT = 1 - (hop + idle) * 1.6; // flatten as it lands
      this.bodyGroup.scale.set(1 + (1 - squashT) * 0.4, squashT, 1 + (1 - squashT) * 0.4);
    }

    // Googly eyes: pupils rattle with motion and landings, droop at rest.
    if (this.googlyEyes) {
      const rattle = speedT + Math.abs(this.squash) * 2.5 + (this.grounded ? 0 : 0.5);
      for (const eye of this.googlyEyes) {
        eye.pupil.position.x =
          eye.baseX + Math.sin(t * 9.2 + eye.seed) * 0.032 * Math.min(rattle, 1.4);
        eye.pupil.position.y =
          eye.baseY - 0.02 + Math.cos(t * 8.1 + eye.seed * 2.3) * 0.03 * Math.min(rattle, 1.4);
      }
    }

    // Vapour Badger: the puffs billow and swirl, breathing in and out so
    // the whole body reads as drifting gas rather than solid mesh.
    if (this.vaporPuffs) {
      for (const puff of this.vaporPuffs) {
        puff.mesh.position.x = puff.baseX + Math.sin(t * 0.9 + puff.seed) * 0.06;
        puff.mesh.position.y = puff.baseY + Math.sin(t * 1.1 + puff.seed * 1.7) * 0.05;
        puff.mesh.position.z = puff.baseZ + Math.cos(t * 0.8 + puff.seed) * 0.06;
        puff.mesh.scale.setScalar(puff.baseR * (1 + Math.sin(t * 1.4 + puff.seed * 2.1) * 0.12));
      }
    }
  }

  /* ================================================================ */
  /*  Lifecycle                                                       */
  /* ================================================================ */

  reset() {
    this.vehicle = null;
    this.respawn();
    this._lastDryPos.copy(this.position);
    this.facingYaw = 0;
    this.walkCycle = 0;
    this.squash = 0;
    this.root.position.copy(this.position);
    this.root.rotation.y = 0;
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const resource of this._disposables) resource.dispose();
    this._disposables.length = 0;
  }
}
