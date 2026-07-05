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

  // --- Magna Carta: rolled parchment with a wax seal -----------------------
  const scrollGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.52, 14);
  scrollGeo.rotateZ(Math.PI / 2);
  const scrollEndGeo = new THREE.CylinderGeometry(0.125, 0.125, 0.13, 14);
  scrollEndGeo.rotateZ(Math.PI / 2);
  const parchmentMat = createToonMaterial({
    color: 0xead9a8,
    rim: { color: 0xe8f0ff, strength: 0.5, threshold: 0.55 }
  });
  const parchmentDarkMat = createToonMaterial({ color: 0xcbb886 });
  const sealMat = createToonMaterial({
    color: 0xb03030,
    emissive: 0x300808,
    emissiveIntensity: 1.0
  });
  const sealGeo = new THREE.SphereGeometry(0.055, 10, 8);

  assets = {
    pineConeGeo, pineConeMat,
    eggGeo, eggMat,
    frogBodyGeo, frogMat, frogSkinMat, frogSacMat, frogWartMat,
    frogEyeGeo, frogEyeMat, frogPupilGeo, frogPupilMat, frogLidGeo,
    frogHaunchGeo, frogShinGeo, frogFootGeo, frogArmGeo, frogHandGeo,
    frogSacGeo, frogWartGeo, frogNostrilGeo,
    scrollGeo, scrollEndGeo, parchmentMat, parchmentDarkMat, sealMat, sealGeo
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
/*  Magna Carta (+25)                                                  */
/* ------------------------------------------------------------------ */

export class MagnaCarta extends Collectible {
  constructor(scene, position) {
    super(scene, position, 25, 1.0);
    const a = getAssets();

    const roll = new THREE.Mesh(a.scrollGeo, a.parchmentMat);
    roll.castShadow = true;
    this.group.add(roll);
    for (const side of [-1, 1]) {
      const end = new THREE.Mesh(a.scrollEndGeo, a.parchmentDarkMat);
      end.position.x = side * 0.22;
      this.group.add(end);
    }
    const seal = new THREE.Mesh(a.sealGeo, a.sealMat);
    seal.position.set(0, -0.06, 0.09);
    seal.scale.set(1, 1, 0.6);
    this.group.add(seal);

    // Silver sparkles instead of the eggs' gold.
    this.aura = createAuraPoints(30, { radiusBase: 0.45, radiusVar: 0.35, heightBase: -0.1, heightVar: 0.55 });
    this.aura.material.uniforms.uColor.value.set(0xe4edff);
    this.aura.material.uniforms.uSize.value = 26;
    this.group.add(this.aura);

    this.baseY = position.y + 0.95;
    this.group.position.y = this.baseY;
    this.phase = Math.random() * Math.PI * 2;
    this.burstColor = 0xdfe8f5;
  }

  update(dt, time) {
    if (this.state === 'collecting') {
      this.updateCollect(dt);
      return;
    }
    this.group.rotation.y += dt * 0.7;
    this.group.rotation.z = Math.sin(time * 1.4 + this.phase) * 0.12;
    this.group.position.y = this.baseY + Math.sin(time * 1.7 + this.phase) * 0.13;
  }

  dispose() {
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

/* ------------------------------------------------------------------ */
/*  Magnus Carter — the menace in the golf cart                        */
/* ------------------------------------------------------------------ */

/**
 * A small elf tearing around the forest in a golf cart, entirely without
 * a licence. He wanders between random waypoints, swerves (roughly)
 * around trees and rocks, and running the player over is Game's problem
 * to adjudicate — this class just drives.
 */
export class MagnusCarter {
  constructor(scene, world, position) {
    this.scene = scene;
    this.world = world;
    this.position = position.clone();
    this.heading = Math.random() * Math.PI * 2;
    this.hazardRadius = 1.7;
    this.speed = 6.4;
    this.target = null;
    this._n = new THREE.Vector3();
    this._disposables = [];

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };

    const bodyMat = track(createToonMaterial({
      color: 0xf2f0e8,
      rim: { color: 0xcfe0ff, strength: 0.35, threshold: 0.6 }
    }));
    const trimMat = track(createToonMaterial({ color: 0x2a4d38 }));
    const wheelMat = track(createToonMaterial({ color: 0x1c1c20 }));
    const hubMat = track(createToonMaterial({ color: 0xb8b8c0 }));
    const elfSkinMat = track(createToonMaterial({ color: 0xf0c090 }));
    const elfSuitMat = track(createToonMaterial({ color: 0x3f8f3f }));
    const elfHatMat = track(createToonMaterial({ color: 0xc03038 }));
    const lightMat = track(createToonMaterial({
      color: 0xfff2b0,
      emissive: 0xffdf80,
      emissiveIntensity: 1.6
    }));

    const group = new THREE.Group();
    group.position.copy(position);
    this.group = group;

    // --- the cart -----------------------------------------------------------
    const chassisGeo = track(new THREE.BoxGeometry(1.15, 0.32, 1.85));
    const chassis = new THREE.Mesh(chassisGeo, bodyMat);
    chassis.position.y = 0.48;
    chassis.castShadow = true;
    group.add(chassis);

    const dashGeo = track(new THREE.BoxGeometry(1.05, 0.4, 0.3));
    const dash = new THREE.Mesh(dashGeo, bodyMat);
    dash.position.set(0, 0.82, 0.62);
    dash.castShadow = true;
    group.add(dash);

    const seatGeo = track(new THREE.BoxGeometry(0.95, 0.3, 0.45));
    const seat = new THREE.Mesh(seatGeo, trimMat);
    seat.position.set(0, 0.75, -0.45);
    group.add(seat);

    const roofGeo = track(new THREE.BoxGeometry(1.1, 0.09, 1.55));
    const roof = new THREE.Mesh(roofGeo, bodyMat);
    roof.position.set(0, 1.62, -0.05);
    roof.castShadow = true;
    group.add(roof);

    const pillarGeo = track(new THREE.CylinderGeometry(0.035, 0.035, 0.85, 6));
    for (const px of [-0.5, 0.5]) {
      for (const pz of [0.6, -0.72]) {
        const pillar = new THREE.Mesh(pillarGeo, hubMat);
        pillar.position.set(px, 1.18, pz);
        group.add(pillar);
      }
    }

    // Headlights so you can see doom approaching through the twilight.
    const lampGeo = track(new THREE.SphereGeometry(0.07, 8, 6));
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(lampGeo, lightMat);
      lamp.position.set(side * 0.4, 0.62, 0.95);
      group.add(lamp);
    }
    this.headlight = new THREE.PointLight(0xffe6a0, 4, 9, 2);
    this.headlight.position.set(0, 0.8, 1.6);
    group.add(this.headlight);

    // --- wheels (spun in update) ---------------------------------------------
    const wheelGeo = track(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 12));
    wheelGeo.rotateZ(Math.PI / 2);
    this.wheels = [];
    for (const wx of [-0.55, 0.55]) {
      for (const wz of [0.62, -0.62]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(wx, 0.24, wz);
        wheel.castShadow = true;
        group.add(wheel);
        this.wheels.push(wheel);
      }
    }

    // --- Magnus himself --------------------------------------------------------
    const elf = new THREE.Group();
    elf.position.set(0, 0.9, -0.28);
    group.add(elf);
    this.elf = elf;

    const elfBodyGeo = track(new THREE.ConeGeometry(0.19, 0.42, 10));
    const elfBody = new THREE.Mesh(elfBodyGeo, elfSuitMat);
    elfBody.position.y = 0.21;
    elfBody.castShadow = true;
    elf.add(elfBody);

    const elfHeadGeo = track(new THREE.SphereGeometry(0.14, 12, 10));
    const elfHead = new THREE.Mesh(elfHeadGeo, elfSkinMat);
    elfHead.position.y = 0.52;
    elfHead.castShadow = true;
    elf.add(elfHead);

    const elfEarGeo = track(new THREE.ConeGeometry(0.035, 0.12, 6));
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(elfEarGeo, elfSkinMat);
      ear.position.set(side * 0.15, 0.55, 0);
      ear.rotation.z = side * (Math.PI / 2 + 0.3);
      elf.add(ear);
    }

    const elfHatGeo = track(new THREE.ConeGeometry(0.11, 0.28, 10));
    const hat = new THREE.Mesh(elfHatGeo, elfHatMat);
    hat.position.set(0, 0.72, -0.02);
    hat.rotation.x = -0.25;
    elf.add(hat);

    const elfArmGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 6));
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(elfArmGeo, elfSuitMat);
      arm.position.set(side * 0.14, 0.32, 0.14);
      arm.rotation.x = -1.1;
      arm.rotation.z = side * -0.25;
      elf.add(arm);
    }

    const wheelRimGeo = track(new THREE.TorusGeometry(0.09, 0.018, 6, 12));
    const steering = new THREE.Mesh(wheelRimGeo, wheelMat);
    steering.position.set(0, 0.95, 0.42);
    steering.rotation.x = -0.9;
    group.add(steering);

    scene.add(group);
    this.pickTarget();
  }

  pickTarget() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = this.world.randomGroundPoint(12, 88);
      // Stay clear of the Escher stairs — even Magnus respects geometry.
      if (this.world.stairCenter) {
        const dx = p.x - this.world.stairCenter.x;
        const dz = p.z - this.world.stairCenter.z;
        if (dx * dx + dz * dz < 20 * 20) continue;
      }
      this.target = p;
      return;
    }
    this.target = new THREE.Vector3(0, 0, 0);
  }

  update(dt, time) {
    const dx = this.target.x - this.position.x;
    const dz = this.target.z - this.position.z;
    if (dx * dx + dz * dz < 16) this.pickTarget();

    let desired = Math.atan2(dx, dz);

    // Crude look-ahead: if a trunk or rock sits in the lane, swerve.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    for (const c of this.world.colliders) {
      const ox = c.x - this.position.x;
      const oz = c.z - this.position.z;
      const distSq = ox * ox + oz * oz;
      if (distSq > 42) continue;
      const ahead = ox * fx + oz * fz;
      if (ahead < 0.5) continue;
      const side = ox * fz - oz * fx;
      if (Math.abs(side) < c.radius + 1.5) {
        desired = this.heading + (side > 0 ? -1.0 : 1.0);
        break;
      }
    }

    this.heading = dampAngle(this.heading, desired, 1.9, dt);
    this.position.x += Math.sin(this.heading) * this.speed * dt;
    this.position.z += Math.cos(this.heading) * this.speed * dt;

    // Never drive off the edge of the world; that would be irresponsible.
    const r = Math.hypot(this.position.x, this.position.z);
    const maxR = this.world.playableRadius - 5;
    if (r > maxR) {
      const s = maxR / r;
      this.position.x *= s;
      this.position.z *= s;
      this.pickTarget();
    }

    this.position.y = this.world.getHeight(this.position.x, this.position.z);
    this.group.position.copy(this.position);

    // Face travel, lean with the terrain (small-angle approximation).
    const n = this.world.getNormal(this.position.x, this.position.z, this._n);
    this.group.rotation.y = this.heading;
    this.group.rotation.x = clamp(n.x * Math.sin(this.heading) + n.z * Math.cos(this.heading), -0.35, 0.35);
    this.group.rotation.z = clamp(-(n.x * Math.cos(this.heading) - n.z * Math.sin(this.heading)), -0.35, 0.35);

    // Wheels roll, elf jiggles with reckless glee.
    const wheelSpin = (this.speed / 0.24) * dt;
    for (const wheel of this.wheels) wheel.rotation.x += wheelSpin;
    this.elf.rotation.z = Math.sin(time * 7.3) * 0.07;
    this.elf.position.y = 0.9 + Math.abs(Math.sin(time * 9.1)) * 0.03;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const r of this._disposables) r.dispose();
    this._disposables.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Red October — the submarine in the lake                            */
/* ------------------------------------------------------------------ */

/**
 * A dark-red submarine that periodically breaches somewhere in the lake,
 * bobs on the surface for a while, then slips back under. Reaching her
 * while surfaced is worth a suspiciously specific number of points —
 * that's Game's business; this class just lurks.
 */
export class Submarine {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.state = 'submerged'; // submerged -> rising -> surfaced -> sinking
    this.timer = 4;
    this.justSurfaced = false;
    this.surfacedY = world.waterLevel - 0.45;
    this.submergedY = world.waterLevel - 6.0;
    this._disposables = [];

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };

    const hullMat = track(createToonMaterial({
      color: 0x6b2020,
      rim: { color: 0xd88a8a, strength: 0.4, threshold: 0.6 }
    }));
    const darkMat = track(createToonMaterial({ color: 0x30181a }));
    const beaconMat = track(createToonMaterial({
      color: 0xff4040,
      emissive: 0xff2020,
      emissiveIntensity: 1.4,
      pulse: { speed: 4.5, phase: 0 }
    }));

    const group = new THREE.Group();
    this.group = group;

    const hullGeo = track(new THREE.CapsuleGeometry(0.95, 5.2, 6, 14));
    hullGeo.rotateZ(Math.PI / 2);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.castShadow = true;
    group.add(hull);

    const sailGeo = track(new THREE.BoxGeometry(0.6, 1.35, 1.9));
    const sail = new THREE.Mesh(sailGeo, hullMat);
    sail.position.set(0.3, 1.1, 0);
    sail.castShadow = true;
    group.add(sail);

    const finGeo = track(new THREE.BoxGeometry(0.12, 1.5, 0.7));
    const fin = new THREE.Mesh(finGeo, hullMat);
    fin.position.set(-3.2, 0.4, 0);
    group.add(fin);

    const scopeGeo = track(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8));
    const scope = new THREE.Mesh(scopeGeo, darkMat);
    scope.position.set(0.45, 2.2, 0);
    group.add(scope);
    const scopeHeadGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8));
    scopeHeadGeo.rotateX(Math.PI / 2);
    const scopeHead = new THREE.Mesh(scopeHeadGeo, darkMat);
    scopeHead.position.set(0.45, 2.68, 0.1);
    group.add(scopeHead);

    const beaconGeo = track(new THREE.SphereGeometry(0.09, 8, 6));
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(0.15, 1.9, 0);
    group.add(beacon);

    this._placeInLake();
    group.position.y = this.submergedY;
    scene.add(group);
  }

  _placeInLake() {
    const w = this.world;
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * w.lakeRadius * 0.45;
    this.group.position.x = w.lakeCenterX + Math.cos(angle) * r;
    this.group.position.z = w.lakeCenterZ + Math.sin(angle) * r;
    this.group.rotation.y = Math.random() * Math.PI * 2;
  }

  get position() {
    return this.group.position;
  }

  isSurfaced() {
    return this.state === 'surfaced';
  }

  consumeJustSurfaced() {
    const flag = this.justSurfaced;
    this.justSurfaced = false;
    return flag;
  }

  update(dt, time) {
    this.timer -= dt;
    const RISE_TIME = 3;
    if (this.state === 'submerged') {
      if (this.timer <= 0) {
        this._placeInLake();
        this.state = 'rising';
        this.timer = RISE_TIME;
      }
    } else if (this.state === 'rising') {
      const t = clamp(1 - this.timer / RISE_TIME, 0, 1);
      const ease = t * t * (3 - 2 * t);
      this.group.position.y = this.submergedY + (this.surfacedY - this.submergedY) * ease;
      if (this.timer <= 0) {
        this.state = 'surfaced';
        this.timer = 10;
        this.justSurfaced = true;
      }
    } else if (this.state === 'surfaced') {
      this.group.position.y = this.surfacedY + Math.sin(time * 1.1) * 0.08;
      this.group.rotation.z = Math.sin(time * 0.85) * 0.02;
      if (this.timer <= 0) {
        this.state = 'sinking';
        this.timer = RISE_TIME;
      }
    } else if (this.state === 'sinking') {
      const t = clamp(1 - this.timer / RISE_TIME, 0, 1);
      const ease = t * t * (3 - 2 * t);
      this.group.position.y = this.surfacedY + (this.submergedY - this.surfacedY) * ease;
      if (this.timer <= 0) {
        this.state = 'submerged';
        this.timer = 6 + Math.random() * 6;
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const r of this._disposables) r.dispose();
    this._disposables.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Hovercraft                                                         */
/* ------------------------------------------------------------------ */

/**
 * A one-badger hovercraft. Parked, it idles and bobs where it was left;
 * ridden, Player.updateVehicle() owns the physics and calls
 * syncWithRider() so the craft tracks the rider's position and facing.
 * It's the only way across the lake, since nobody here can swim.
 */
export class Hovercraft {
  constructor(scene, world, position) {
    this.scene = scene;
    this.world = world;
    this.kind = 'hovercraft';
    this.position = position.clone();
    this.rider = null;
    this._disposables = [];

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };

    const skirtMat = track(createToonMaterial({
      color: 0x2e3138,
      rim: { color: 0x9db4e8, strength: 0.3, threshold: 0.64 }
    }));
    const deckMat = track(createToonMaterial({
      color: 0xd8862a,
      rim: { color: 0xffcf9a, strength: 0.4, threshold: 0.6 }
    }));
    const trimMat = track(createToonMaterial({ color: 0xf2ede0 }));
    const beaconMat = track(createToonMaterial({
      color: 0x8ae0ff,
      emissive: 0x50c8ff,
      emissiveIntensity: 1.3,
      pulse: { speed: 3.2, phase: 0 }
    }));

    const group = new THREE.Group();
    this.group = group;

    const skirtGeo = track(new THREE.TorusGeometry(0.72, 0.27, 10, 22));
    skirtGeo.rotateX(Math.PI / 2);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = 0.26;
    skirt.castShadow = true;
    group.add(skirt);

    const deckGeo = track(new THREE.CylinderGeometry(0.74, 0.8, 0.24, 20));
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 0.46;
    deck.castShadow = true;
    group.add(deck);

    const screenGeo = track(new THREE.BoxGeometry(0.62, 0.34, 0.05));
    const screen = new THREE.Mesh(screenGeo, trimMat);
    screen.position.set(0, 0.75, 0.6);
    screen.rotation.x = -0.35;
    group.add(screen);

    // Rear fan: guard ring + spinning blades.
    const fan = new THREE.Group();
    fan.position.set(0, 0.85, -0.72);
    group.add(fan);
    this.fanBlades = new THREE.Group();
    fan.add(this.fanBlades);
    const ringGeo = track(new THREE.TorusGeometry(0.34, 0.05, 8, 18));
    const ring = new THREE.Mesh(ringGeo, skirtMat);
    fan.add(ring);
    const bladeGeo = track(new THREE.BoxGeometry(0.08, 0.6, 0.03));
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(bladeGeo, trimMat);
      blade.rotation.z = (i / 3) * Math.PI * 2;
      this.fanBlades.add(blade);
    }

    // A pulsing blue beacon so the craft is findable across the map.
    const poleGeo = track(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6));
    const pole = new THREE.Mesh(poleGeo, skirtMat);
    pole.position.set(0, 1.35, -0.72);
    group.add(pole);
    const beaconGeo = track(new THREE.SphereGeometry(0.08, 8, 6));
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(0, 1.62, -0.72);
    group.add(beacon);

    group.position.copy(position);
    scene.add(group);
  }

  /** While parked: settle on the local surface and idle-bob. */
  update(dt, time) {
    if (this.rider) return;
    const floor = Math.max(
      this.world.getHeight(this.position.x, this.position.z),
      this.world.isNearLake(this.position.x, this.position.z) ? this.world.waterLevel : -Infinity
    );
    this.group.position.set(
      this.position.x,
      floor + 0.06 + Math.sin(time * 1.8) * 0.03,
      this.position.z
    );
    this.fanBlades.rotation.z += dt * 2;
  }

  /** While ridden: track the rider (whose feet stand on the deck). */
  syncWithRider(riderPosition, yaw, speedT, dt) {
    this.position.copy(riderPosition);
    this.group.position.set(riderPosition.x, riderPosition.y - 0.55, riderPosition.z);
    this.group.rotation.y = yaw;
    this.fanBlades.rotation.z += dt * (6 + speedT * 34);
  }

  parkAt(position) {
    this.position.copy(position);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const r of this._disposables) r.dispose();
    this._disposables.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Hot air balloon                                                    */
/* ------------------------------------------------------------------ */

/**
 * A striped hot air balloon that drifts in once a run's score reaches
 * the magic number. The jump button is the burner: hold to rise. The
 * envelope is a vertex-striped teardrop; the flame flares with throttle.
 */
export class HotAirBalloon {
  constructor(scene, world, position) {
    this.scene = scene;
    this.world = world;
    this.kind = 'balloon';
    this.position = position.clone();
    this.rider = null;
    this._parkedY = null;
    this._disposables = [];

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };

    const envelopeMat = track(createToonMaterial({
      vertexColors: true,
      rim: { color: 0xffd9b0, strength: 0.4, threshold: 0.6 }
    }));
    const basketMat = track(createToonMaterial({
      color: 0x8a6a42,
      rim: { color: 0xd8b88a, strength: 0.3, threshold: 0.65 }
    }));
    const ropeMat = track(createToonMaterial({ color: 0x4a3a26 }));
    const flameMat = track(createToonMaterial({
      color: 0xffb640,
      emissive: 0xff8c20,
      emissiveIntensity: 2.2
    }));

    const group = new THREE.Group();
    this.group = group;

    // --- envelope: gored stripes, teardrop-pinched toward the neck ---------
    const envGeo = track(new THREE.SphereGeometry(1.6, 24, 18));
    {
      const pos = envGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      const gore = [new THREE.Color(0xd84a3a), new THREE.Color(0xf2e6c8), new THREE.Color(0x7a3fa8)];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const sector = Math.floor(((Math.atan2(z, x) / (Math.PI * 2)) + 0.5) * 12);
        c.copy(gore[sector % 3 === 2 ? 2 : sector % 2]);
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
        if (y < 0) {
          const pinch = 1 + (y / 1.6) * 0.5;
          pos.setX(i, x * pinch);
          pos.setZ(i, z * pinch);
        }
      }
      envGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      envGeo.computeVertexNormals();
    }
    const envelope = new THREE.Mesh(envGeo, envelopeMat);
    envelope.position.y = 3.4;
    envelope.scale.set(1, 1.12, 1);
    envelope.castShadow = true;
    group.add(envelope);

    // --- basket the rider stands in ----------------------------------------
    const basketGeo = track(new THREE.CylinderGeometry(0.62, 0.55, 0.55, 10));
    const basket = new THREE.Mesh(basketGeo, basketMat);
    basket.position.y = 0.28;
    basket.castShadow = true;
    group.add(basket);
    const rimGeo = track(new THREE.TorusGeometry(0.62, 0.05, 6, 14));
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, ropeMat);
    rim.position.y = 0.56;
    group.add(rim);

    // --- burner flame (throttle-reactive) -----------------------------------
    const flameGeo = track(new THREE.ConeGeometry(0.12, 0.42, 8));
    this.flame = new THREE.Mesh(flameGeo, flameMat);
    this.flame.position.y = 1.35;
    this.flame.scale.setScalar(0.6);
    group.add(this.flame);

    // --- ropes from basket rim up to the envelope skirt ----------------------
    const ropeGeo = track(new THREE.CylinderGeometry(0.018, 0.018, 1, 5));
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const from = new THREE.Vector3(Math.cos(a) * 0.55, 0.56, Math.sin(a) * 0.55);
      const to = new THREE.Vector3(Math.cos(a) * 0.85, 2.3, Math.sin(a) * 0.85);
      const dir = to.clone().sub(from);
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.scale.y = dir.length();
      rope.position.copy(from).addScaledVector(dir, 0.5);
      rope.quaternion.setFromUnitVectors(up, dir.normalize());
      group.add(rope);
    }

    group.position.copy(position);
    scene.add(group);
    this._throttle = 0;
  }

  /** Parked: settle to a gentle rest height and bob. */
  update(dt, time) {
    if (this.rider) return;
    const floor = Math.max(
      this.world.getHeight(this.position.x, this.position.z),
      this.world.isNearLake(this.position.x, this.position.z) ? this.world.waterLevel : -Infinity
    );
    const restY = floor + 0.12;
    if (this._parkedY === null) this._parkedY = this.position.y;
    this._parkedY = damp(this._parkedY, restY, 1.6, dt);
    this.group.position.set(
      this.position.x,
      this._parkedY + Math.sin(time * 1.1) * 0.06,
      this.position.z
    );
    this.flame.scale.setScalar(0.5 + 0.15 * Math.sin(time * 7.3));
  }

  /** Ridden: rider's feet are the basket floor; flame follows the burner. */
  syncWithRider(riderPosition, yaw, burner, dt) {
    this.position.copy(riderPosition);
    this._parkedY = null;
    this.group.position.set(riderPosition.x, riderPosition.y - 0.06, riderPosition.z);
    this.group.rotation.y = yaw;
    this._throttle = damp(this._throttle, burner, 8, dt);
    const flicker = 1 + Math.sin(performance.now() / 40) * 0.15;
    this.flame.scale.setScalar((0.45 + this._throttle * 1.0) * flicker);
  }

  parkAt(position) {
    this.position.copy(position);
    this._parkedY = position.y;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const r of this._disposables) r.dispose();
    this._disposables.length = 0;
  }
}
