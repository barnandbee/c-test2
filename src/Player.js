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
    this.isFloaty = false;   // Haunted Sweatshirt's ethereal hover
    this.isBouncy = false;   // Pickle Stick hops to get around
    this.hoverHeight = 0;    // Candy Florence rests this far above the ground
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
    else if (this.character === 'mayo') this.root = this.buildMayo();
    else if (this.character === 'jam') this.root = this.buildJam();
    else if (this.character === 'dodeca') this.root = this.buildDodeca();
    else if (this.character === 'polarpear') this.root = this.buildPolarPear();
    else if (this.character === 'nighteye') this.root = this.buildNightEye();
    else if (this.character === 'pinepenguin') this.root = this.buildPinePenguin();
    else if (this.character === 'billy') this.root = this.buildBilly();
    else if (this.character === 'pickle') this.root = this.buildPickle();
    else if (this.character === 'glassbadger') this.root = this.buildGlassBadger();
    else if (this.character === 'mcdonovan') this.root = this.buildMcDonovan();
    else if (this.character === 'prunella') this.root = this.buildPrunella();
    else if (this.character === 'gary') this.root = this.buildGaryMountain();
    else if (this.character === 'candy') this.root = this.buildCandyFlorence();
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
      const targetX = wish.x * T.maxSpeed;
      const targetZ = wish.z * T.maxSpeed;
      const rate = hasInput ? T.groundAccel : T.groundFriction;
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
        const cap = Math.max(T.maxSpeed, preSpeed);
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
    const groundH = this.world.getGroundHeight(pos.x, pos.z, pos.y, terrainH) + this.hoverHeight;
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
    const wl = this.world.waterLevel;
    const inLake = wl !== undefined && this.world.isNearLake(pos.x, pos.z);
    const sinks = this.character === 'marblella';
    if (inLake && pos.y < wl - 0.4 && !sinks) {
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

    // Floor is turf or lake water, whichever is higher (lake only).
    const terrainH = this.world.getHeight(pos.x, pos.z);
    const overLake = this.world.waterLevel !== undefined && this.world.isNearLake(pos.x, pos.z);
    const wetFloor = overLake ? this.world.waterLevel : -Infinity;
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

    if (!overLake || terrainH > this.world.waterLevel + 0.05) {
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
