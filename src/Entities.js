/**
 * Entities.js — Collectibles, hazards and landmarks.
 *
 *  - PineCone   (+1)  hovering, spinning, emissive glow pulse.
 *  - GoldenEgg  (+10) gold PBR + rotating particle aura.
 *  - ToxicFrog        hopping hazard wrapped in a poison particle cloud,
 *                     with a croaking throat sac, articulated limbs,
 *                     warts, eyelids and a dorsal stripe.
 *  - ClockTower       glowing landmark; entering it grants +10 seconds on
 *                     the game clock, then it teleports elsewhere. Its
 *                     clock hands literally show the time remaining.
 *
 * Geometry and materials are shared, lazily-built module singletons —
 * entities themselves only own their Object3D instances, so spawning and
 * collecting is allocation-light and disposal is leak-free.
 */

import * as THREE from 'three';
import { createToonMaterial, createFoggedStandardMaterial } from './Shaders.js';
import { createAuraPoints, createPoisonPoints } from './Particles.js';
import { clamp, damp, dampAngle } from './utils/MathUtils.js';

/* ------------------------------------------------------------------ */
/*  Shared assets                                                      */
/* ------------------------------------------------------------------ */

let assets = null;

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

function getAssets() {
  if (assets) return assets;

  // --- pine cone: lathe profile with sinusoidal "scale" banding ----------
  const conePoints = [];
  const profile = [
    [0.001, -0.3], [0.16, -0.28], [0.24, -0.16], [0.27, 0.0],
    [0.22, 0.14], [0.13, 0.26], [0.001, 0.34]
  ];
  for (const [x, y] of profile) conePoints.push(new THREE.Vector2(x, y));
  const pineConeGeo = new THREE.LatheGeometry(conePoints, 18);
  {
    const pos = pineConeGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r > 0.01) {
        const band = 1 + 0.13 * Math.sin(y * 34) * Math.max(0, Math.cos(y * 2.2));
        pos.setX(i, (x / r) * r * band);
        pos.setZ(i, (z / r) * r * band);
      }
    }
    pineConeGeo.computeVertexNormals();
  }
  const pineConeMat = createToonMaterial({
    color: 0x7c4f2c,
    emissive: 0xff8c3a,
    emissiveIntensity: 0.55,
    rim: { color: 0xffcf9a, strength: 0.35, threshold: 0.6 },
    pulse: { speed: 2.6, phase: 0 }
  });

  // --- golden egg: sphere reshaped into an ovoid --------------------------
  const eggGeo = new THREE.SphereGeometry(0.34, 26, 20);
  {
    const pos = eggGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const taper = y > 0 ? 1 - (y / 0.34) * 0.32 : 1;
      pos.setX(i, pos.getX(i) * taper);
      pos.setZ(i, pos.getZ(i) * taper);
      pos.setY(i, y * 1.32);
    }
    eggGeo.computeVertexNormals();
  }
  const eggMat = createFoggedStandardMaterial({
    color: 0xffc23e,
    metalness: 1.0,
    roughness: 0.22,
    envMapIntensity: 1.5,
    emissive: 0x2a1902,
    emissiveIntensity: 1.0
  });

  // --- toxic frog ----------------------------------------------------------
  const frogBodyGeo = new THREE.SphereGeometry(0.34, 26, 20);
  paintVertexColors(frogBodyGeo, (n, p, c) => {
    const belly = 1 - THREE.MathUtils.smoothstep(n.y, -0.7, 0.0);
    const mottle = Math.sin(p.x * 31.7 + p.z * 47.3) * 0.5 + 0.5;
    c.set(0x4f9c2a).offsetHSL(0, 0, (mottle - 0.5) * 0.08);
    // Darker dorsal stripe running nose-to-rump along the spine.
    const dorsal =
      THREE.MathUtils.smoothstep(n.y, 0.35, 0.7) *
      (1 - THREE.MathUtils.smoothstep(Math.abs(n.x), 0.12, 0.3));
    c.offsetHSL(0.015, 0.05, -dorsal * 0.1);
    c.lerp(new THREE.Color(0xc9d97a), belly * 0.85);
  });
  const frogMat = createToonMaterial({
    vertexColors: true,
    rim: { color: 0xa4ff6e, strength: 0.6, threshold: 0.58 }
  });
  // Plain skin material for limbs/eyelids (no vertex colors baked there).
  const frogSkinMat = createToonMaterial({
    color: 0x479325,
    rim: { color: 0xa4ff6e, strength: 0.45, threshold: 0.62 }
  });
  const frogSacMat = createToonMaterial({
    color: 0xd9e691,
    rim: { color: 0xd6ff9e, strength: 0.4, threshold: 0.6 }
  });
  const frogWartMat = createToonMaterial({ color: 0x2f6b17 });
  const frogEyeGeo = new THREE.SphereGeometry(0.1, 14, 12);
  const frogEyeMat = createToonMaterial({ color: 0xd8e04a });
  const frogPupilGeo = new THREE.SphereGeometry(0.048, 10, 8);
  const frogPupilMat = createToonMaterial({ color: 0x101014 });
  // Upper half-sphere cap: a heavy-lidded eyelid in body green.
  const frogLidGeo = new THREE.SphereGeometry(0.108, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.45);
  const frogHaunchGeo = new THREE.SphereGeometry(0.15, 14, 10);
  const frogShinGeo = new THREE.CylinderGeometry(0.04, 0.055, 0.24, 8);
  const frogFootGeo = new THREE.ConeGeometry(0.09, 0.24, 5);
  const frogArmGeo = new THREE.CylinderGeometry(0.032, 0.045, 0.17, 8);
  const frogHandGeo = new THREE.SphereGeometry(0.05, 10, 8);
  const frogSacGeo = new THREE.SphereGeometry(0.15, 16, 12);
  const frogWartGeo = new THREE.SphereGeometry(0.035, 8, 6);
  const frogNostrilGeo = new THREE.SphereGeometry(0.018, 6, 5);

  assets = {
    pineConeGeo, pineConeMat,
    eggGeo, eggMat,
    frogBodyGeo, frogMat, frogSkinMat, frogSacMat, frogWartMat,
    frogEyeGeo, frogEyeMat, frogPupilGeo, frogPupilMat, frogLidGeo,
    frogHaunchGeo, frogShinGeo, frogFootGeo, frogArmGeo, frogHandGeo,
    frogSacGeo, frogWartGeo, frogNostrilGeo
  };
  return assets;
}

/** Full teardown of the shared geometry/material cache (game shutdown). */
export function disposeEntityAssets() {
  if (!assets) return;
  for (const key of Object.keys(assets)) assets[key].dispose();
  assets = null;
}

/* ------------------------------------------------------------------ */
/*  Collectible base                                                   */
/* ------------------------------------------------------------------ */

class Collectible {
  constructor(scene, position, value, pickupRadius) {
    this.scene = scene;
    this.value = value;
    this.pickupRadius = pickupRadius;
    this.state = 'idle'; // idle -> collecting -> done
    this.collectTimer = 0;
    this.baseY = position.y;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    scene.add(this.group);
  }

  startCollect() {
    if (this.state !== 'idle') return false;
    this.state = 'collecting';
    this.collectTimer = 0;
    return true;
  }

  /** Elegant pickup: quick pop-up + spin while scaling to zero. */
  updateCollect(dt) {
    this.collectTimer += dt;
    const t = clamp(this.collectTimer / 0.32, 0, 1);
    const scale = (1 - t) * (1 + 0.35 * Math.sin(t * Math.PI));
    this.group.scale.setScalar(Math.max(scale, 0.0001));
    this.group.position.y = this.baseY + t * 0.9;
    this.group.rotation.y += dt * 14;
    if (t >= 1) this.state = 'done';
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

/* ------------------------------------------------------------------ */
/*  Pine cone (+1)                                                     */
/* ------------------------------------------------------------------ */

export class PineCone extends Collectible {
  constructor(scene, position) {
    super(scene, position, 1, 0.85);
    const a = getAssets();
    this.mesh = new THREE.Mesh(a.pineConeGeo, a.pineConeMat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.baseY = position.y + 0.85;
    this.group.position.y = this.baseY;
    this.phase = Math.random() * Math.PI * 2;
    this.burstColor = 0xffa04e;
  }

  update(dt, time) {
    if (this.state === 'collecting') {
      this.updateCollect(dt);
      return;
    }
    this.group.rotation.y += dt * 1.6;
    this.group.position.y = this.baseY + Math.sin(time * 2.0 + this.phase) * 0.16;
  }
}

/* ------------------------------------------------------------------ */
/*  Golden egg (+10)                                                   */
/* ------------------------------------------------------------------ */

export class GoldenEgg extends Collectible {
  constructor(scene, position) {
    super(scene, position, 10, 1.0);
    const a = getAssets();
    this.mesh = new THREE.Mesh(a.eggGeo, a.eggMat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.aura = createAuraPoints();
    this.group.add(this.aura);
    this.baseY = position.y + 0.9;
    this.group.position.y = this.baseY;
    this.phase = Math.random() * Math.PI * 2;
    this.burstColor = 0xffd44f;
  }

  update(dt, time) {
    if (this.state === 'collecting') {
      this.updateCollect(dt);
      return;
    }
    this.group.rotation.y += dt * 0.9;
    this.mesh.rotation.z = Math.sin(time * 1.3 + this.phase) * 0.14;
    this.group.position.y = this.baseY + Math.sin(time * 1.6 + this.phase) * 0.12;
  }

  dispose() {
    // The aura's geometry/material are per-egg — free them explicitly.
    this.aura.geometry.dispose();
    this.aura.material.dispose();
    super.dispose();
  }
}

/* ------------------------------------------------------------------ */
/*  Toxic frog                                                         */
/* ------------------------------------------------------------------ */

export class ToxicFrog {
  constructor(scene, world, position) {
    this.scene = scene;
    this.world = world;
    this.home = position.clone();
    this.position = position.clone();
    this.heading = Math.random() * Math.PI * 2;
    this.hazardRadius = 2.0;
    this.wanderRadius = 5.5;

    this.state = 'idle'; // idle -> hop -> land -> idle
    this.stateTimer = 0.5 + Math.random() * 1.6;
    this.vy = 0;
    this.hSpeed = 0;
    this.squash = 0;
    this.phase = Math.random() * Math.PI * 2;

    const a = getAssets();
    this.group = new THREE.Group();
    this.group.position.copy(position);

    this.body = new THREE.Mesh(a.frogBodyGeo, a.frogMat);
    this.body.scale.set(1.15, 0.78, 1.05);
    this.body.position.y = 0.26;
    this.body.castShadow = true;
    this.group.add(this.body);

    // Croaking throat sac under the chin — inflates rhythmically.
    this.sac = new THREE.Mesh(a.frogSacGeo, a.frogSacMat);
    this.sac.position.set(0, 0.13, 0.3);
    this.group.add(this.sac);

    // Nostrils on the snout tip.
    for (const side of [-1, 1]) {
      const nostril = new THREE.Mesh(a.frogNostrilGeo, a.frogPupilMat);
      nostril.position.set(side * 0.055, 0.34, 0.38);
      this.group.add(nostril);
    }

    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(a.frogEyeGeo, a.frogEyeMat);
      eye.position.set(side * 0.17, 0.5, 0.22);
      this.group.add(eye);
      const pupil = new THREE.Mesh(a.frogPupilGeo, a.frogPupilMat);
      pupil.position.set(side * 0.17, 0.52, 0.3);
      this.group.add(pupil);
      // Heavy-lidded cap gives the classic sleepy toad glare.
      const lid = new THREE.Mesh(a.frogLidGeo, a.frogSkinMat);
      lid.position.set(side * 0.17, 0.505, 0.215);
      lid.rotation.x = -0.35;
      this.group.add(lid);

      // Rear leg: haunch + folded shin + webbed foot splayed forward.
      const haunch = new THREE.Mesh(a.frogHaunchGeo, a.frogMat);
      haunch.position.set(side * 0.3, 0.16, -0.18);
      haunch.scale.set(0.95, 0.85, 1.25);
      haunch.castShadow = true;
      this.group.add(haunch);

      const shin = new THREE.Mesh(a.frogShinGeo, a.frogSkinMat);
      shin.position.set(side * 0.35, 0.1, -0.02);
      shin.rotation.x = 1.15;
      shin.rotation.z = side * 0.18;
      this.group.add(shin);

      const foot = new THREE.Mesh(a.frogFootGeo, a.frogSkinMat);
      foot.position.set(side * 0.34, 0.04, 0.14);
      foot.rotation.x = Math.PI / 2;
      foot.scale.set(1.35, 1.0, 0.4);
      this.group.add(foot);

      // Front leg: slim arm + webbed hand planted ahead.
      const arm = new THREE.Mesh(a.frogArmGeo, a.frogSkinMat);
      arm.position.set(side * 0.18, 0.13, 0.24);
      arm.rotation.x = 0.35;
      arm.rotation.z = side * 0.25;
      this.group.add(arm);

      const hand = new THREE.Mesh(a.frogHandGeo, a.frogSkinMat);
      hand.position.set(side * 0.21, 0.04, 0.3);
      hand.scale.set(1.35, 0.5, 1.4);
      this.group.add(hand);
    }

    // Warts scattered across the back.
    for (let i = 0; i < 7; i++) {
      const theta = (i / 7) * Math.PI * 2 + this.phase;
      const up = 0.35 + ((i * 37) % 10) / 10 * 0.55;
      const dir = new THREE.Vector3(Math.cos(theta) * (1 - up * 0.7), up, Math.sin(theta) * (1 - up * 0.7)).normalize();
      const wart = new THREE.Mesh(a.frogWartGeo, a.frogWartMat);
      wart.position.set(dir.x * 0.34 * 1.15, 0.26 + dir.y * 0.34 * 0.78, dir.z * 0.34 * 1.05);
      wart.scale.setScalar(0.7 + ((i * 53) % 10) / 10 * 0.7);
      this.group.add(wart);
    }

    this.cloud = createPoisonPoints(this.hazardRadius + 0.15, 1.7);
    this.group.add(this.cloud);

    scene.add(this.group);
  }

  update(dt, time) {
    this.stateTimer -= dt;

    // Croak: the throat sac balloons in slow rhythmic pulses.
    const croak = Math.pow(Math.max(Math.sin(time * 2.2 + this.phase), 0), 3);
    const sacScale = 1 + croak * 0.75;
    this.sac.scale.set(sacScale, sacScale * 0.9, sacScale);

    if (this.state === 'idle') {
      // Breathing while crouched.
      this.squash = damp(this.squash, 0, 8, dt);
      this.body.scale.y = 0.78 + Math.sin(time * 3.1) * 0.03;
      if (this.stateTimer <= 0) {
        // Pick a heading: wander freely, but steer home if we strayed.
        const dxh = this.home.x - this.position.x;
        const dzh = this.home.z - this.position.z;
        if (Math.hypot(dxh, dzh) > this.wanderRadius) {
          this.heading = Math.atan2(dxh, dzh) + (Math.random() - 0.5) * 0.8;
        } else {
          this.heading = Math.random() * Math.PI * 2;
        }
        this.state = 'hop';
        this.vy = 5.2;
        this.hSpeed = 2.6;
        this.squash = -0.3;
      }
    } else if (this.state === 'hop') {
      this.vy -= 22 * dt;
      this.position.x += Math.sin(this.heading) * this.hSpeed * dt;
      this.position.z += Math.cos(this.heading) * this.hSpeed * dt;
      this.position.y += this.vy * dt;
      const ground = this.world.getHeight(this.position.x, this.position.z);
      if (this.vy < 0 && this.position.y <= ground) {
        this.position.y = ground;
        this.state = 'land';
        this.stateTimer = 0.22;
        this.squash = 0.35;
      }
      this.body.scale.y = 0.78 * (1 + 0.25 * clamp(this.vy / 6, -1, 1));
    } else if (this.state === 'land') {
      this.squash = damp(this.squash, 0, 12, dt);
      this.body.scale.y = 0.78 * (1 - this.squash);
      if (this.stateTimer <= 0) {
        this.state = 'idle';
        this.stateTimer = 0.7 + Math.random() * 1.8;
      }
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = dampAngle(this.group.rotation.y, this.heading, 10, dt);
  }

  dispose() {
    this.cloud.geometry.dispose();
    this.cloud.material.dispose();
    this.scene.remove(this.group);
  }
}

/* ------------------------------------------------------------------ */
/*  Clock tower                                                        */
/* ------------------------------------------------------------------ */

/** Hand-drawn clock face (numbers left as tick marks — it's a fairy tower). */
function makeClockFaceTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');

  g.fillStyle = '#f7ecd0';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = '#54406a';
  g.lineWidth = 14;
  g.beginPath();
  g.arc(128, 128, 116, 0, Math.PI * 2);
  g.stroke();

  g.strokeStyle = '#3c3050';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const major = i % 3 === 0;
    g.lineWidth = major ? 9 : 4;
    const r0 = major ? 82 : 92;
    g.beginPath();
    g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
    g.lineTo(128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104);
    g.stroke();
  }

  // Static hour hand painted in (the 3D minute hand shows time remaining).
  g.strokeStyle = '#3c3050';
  g.lineWidth = 10;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(128, 128);
  g.lineTo(128 + Math.cos(-Math.PI / 3) * 52, 128 + Math.sin(-Math.PI / 3) * 52);
  g.stroke();

  g.fillStyle = '#54406a';
  g.beginPath();
  g.arc(128, 128, 12, 0, Math.PI * 2);
  g.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ClockTower {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./World.js').World} world
   * @param {THREE.Vector3} position ground point to stand on
   */
  constructor(scene, world, position) {
    this.scene = scene;
    this.world = world;
    this.position = position.clone();
    this.triggerRadius = 2.45;
    this.cooldown = 0;
    this._disposables = [];

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };

    const stoneMat = track(createToonMaterial({
      color: 0x9a93ab,
      rim: { color: 0xb9a4ff, strength: 0.4, threshold: 0.62 }
    }));
    const stoneDarkMat = track(createToonMaterial({
      color: 0x7b7490,
      rim: { color: 0xb9a4ff, strength: 0.4, threshold: 0.62 }
    }));
    const roofMat = track(createToonMaterial({
      color: 0x4a3f72,
      rim: { color: 0xc9b8ff, strength: 0.55, threshold: 0.55 }
    }));
    const goldMat = track(createToonMaterial({
      color: 0xf5c542,
      emissive: 0x4a3300,
      emissiveIntensity: 1.0,
      rim: { color: 0xfff3c0, strength: 0.7, threshold: 0.5 }
    }));
    const doorMat = track(createToonMaterial({
      color: 0x2b2118,
      emissive: 0xff9440,
      emissiveIntensity: 0.12
    }));

    this.faceTexture = track(makeClockFaceTexture());
    const faceMat = track(createToonMaterial({
      map: this.faceTexture,
      emissiveMap: this.faceTexture,
      emissive: 0xfff0c0,
      emissiveIntensity: 0.55,
      pulse: { speed: 1.6, phase: 0 }
    }));
    const handMat = track(createToonMaterial({
      color: 0x2c2440,
      emissive: 0x1a1430,
      emissiveIntensity: 0.5
    }));

    const group = new THREE.Group();
    group.position.copy(position);
    group.position.y -= 0.25; // settle the foundation into the turf
    this.group = group;

    const baseGeo = track(new THREE.CylinderGeometry(1.15, 1.55, 6.4, 12));
    const base = new THREE.Mesh(baseGeo, stoneMat);
    base.position.y = 3.2;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const belfryGeo = track(new THREE.CylinderGeometry(1.45, 1.45, 1.5, 12));
    const belfry = new THREE.Mesh(belfryGeo, stoneDarkMat);
    belfry.position.y = 7.0;
    belfry.castShadow = true;
    group.add(belfry);

    const roofGeo = track(new THREE.ConeGeometry(1.78, 2.5, 12));
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 9.0;
    roof.castShadow = true;
    group.add(roof);

    const finialGeo = track(new THREE.SphereGeometry(0.14, 10, 8));
    const finial = new THREE.Mesh(finialGeo, goldMat);
    finial.position.y = 10.35;
    group.add(finial);

    // Four glowing faces around the belfry; each carries a 3D minute hand
    // whose sweep displays the actual game time remaining.
    const faceGeo = track(new THREE.CircleGeometry(0.82, 28));
    const handGeo = track(new THREE.BoxGeometry(0.06, 0.62, 0.025));
    handGeo.translate(0, 0.26, 0);
    this.hands = [];
    for (let i = 0; i < 4; i++) {
      const faceGroup = new THREE.Group();
      faceGroup.rotation.y = (i * Math.PI) / 2;
      belfry.add(faceGroup);

      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(0, 0.05, 1.48);
      faceGroup.add(face);

      const hand = new THREE.Mesh(handGeo, handMat);
      hand.position.set(0, 0.05, 1.52);
      faceGroup.add(hand);
      this.hands.push(hand);
    }

    // Arched doorway with an inviting ember glow.
    const doorGeo = track(new THREE.BoxGeometry(0.85, 1.35, 0.3));
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(0, 0.85, 1.38);
    group.add(door);
    const archGeo = track(new THREE.SphereGeometry(0.43, 12, 8));
    const arch = new THREE.Mesh(archGeo, doorMat);
    arch.position.set(0, 1.5, 1.38);
    arch.scale.set(1, 0.9, 0.35);
    group.add(arch);

    this.doorLight = new THREE.PointLight(0xffb670, 5, 11, 2);
    this.doorLight.position.set(0, 1.8, 2.0);
    group.add(this.doorLight);

    // A grand golden aura so the tower reads as "worth visiting" from afar.
    this.aura = createAuraPoints(48, { radiusBase: 1.9, radiusVar: 0.8, heightBase: 0.3, heightVar: 2.6 });
    this.aura.material.uniforms.uSize.value = 40;
    group.add(this.aura);

    scene.add(group);

    // Solid to the player and to the camera arm; refs kept so teleporting
    // just mutates them in place.
    this.collider = { x: position.x, z: position.z, radius: 1.5, top: position.y + 9 };
    world.colliders.push(this.collider);
    this.cameraCollider = { x: position.x, y: position.y + 3.5, z: position.z, radius: 2.1 };
    world.cameraColliders.push(this.cameraCollider);
  }

  /** Sweep the minute hands: f=1 full time, f=0 none. */
  setTimeFraction(f) {
    const angle = -(1 - clamp(f, 0, 1)) * Math.PI * 2;
    for (const hand of this.hands) hand.rotation.z = angle;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  /** True when the player is at the walls and the tower is armed. */
  tryEnter(playerPosition) {
    if (this.cooldown > 0) return false;
    const dx = playerPosition.x - this.position.x;
    const dz = playerPosition.z - this.position.z;
    const dy = playerPosition.y - this.position.y;
    return dx * dx + dz * dz < this.triggerRadius * this.triggerRadius && Math.abs(dy) < 5;
  }

  /** Vanish to a new ground point; colliders follow. */
  teleport(newPosition) {
    this.position.copy(newPosition);
    this.group.position.copy(newPosition);
    this.group.position.y -= 0.25;
    this.collider.x = newPosition.x;
    this.collider.z = newPosition.z;
    this.collider.top = newPosition.y + 9;
    this.cameraCollider.x = newPosition.x;
    this.cameraCollider.y = newPosition.y + 3.5;
    this.cameraCollider.z = newPosition.z;
    this.cooldown = 1.5;
  }

  dispose() {
    this.scene.remove(this.group);
    const ci = this.world.colliders.indexOf(this.collider);
    if (ci !== -1) this.world.colliders.splice(ci, 1);
    const cci = this.world.cameraColliders.indexOf(this.cameraCollider);
    if (cci !== -1) this.world.cameraColliders.splice(cci, 1);
    this.aura.geometry.dispose();
    this.aura.material.dispose();
    for (const r of this._disposables) r.dispose();
    this._disposables.length = 0;
  }
}
