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

    // --- animation state -----------------------------------------------
    this.walkCycle = 0;
    this.squash = 0;       // 0..1 landing squash amount, springs back to 0
    this.airTilt = 0;
    this.hairGroup = null;   // badgerette's mane / william's cape
    this.arms = null;        // stick-limbed heroes only
    this.googlyEyes = null;  // rattling pupils (Hughes, Edith)
    this.rockMesh = null;    // Rhombus: the body that waddle-rocks
    this.isGlitchy = false;  // Error #42's intermittent reality problem
    this.tail = null;
    this.headGroup = null;

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
    else if (this.character === 'perpbird') this.root = this.buildPerpBird();
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
    sheet.position.y = 0.45;
    // Drawings cast no shadows; that would be presumptuous.
    body.add(sheet);
    this.rockMesh = sheet; // borrow Rhombus' waddle-rock

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
      vel.y = T.jumpSpeed;
      this.grounded = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      jumpedThisFrame = true;
      this.squash = -0.25; // stretch on takeoff
      if (this.onJump) this.onJump(pos);
    }

    // ---- gravity -----------------------------------------------------------
    if (!this.grounded || jumpedThisFrame) {
      let g = T.gravity;
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
    const groundH = this.world.getGroundHeight(pos.x, pos.z, pos.y, terrainH);
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
    const wl = this.world.waterLevel;
    const inLake = wl !== undefined && this.world.isNearLake(pos.x, pos.z);
    if (inLake && pos.y < wl - 0.4) {
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
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (pos.y > c.top) continue;
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
