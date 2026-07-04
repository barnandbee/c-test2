/**
 * Entities.js — Collectibles and hazards.
 *
 *  - PineCone  (+1)  hovering, spinning, emissive glow pulse.
 *  - GoldenEgg (+10) gold PBR + rotating particle aura.
 *  - ToxicFrog       hopping hazard wrapped in a poison particle cloud.
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
  const frogBodyGeo = new THREE.SphereGeometry(0.34, 22, 16);
  paintVertexColors(frogBodyGeo, (n, p, c) => {
    const belly = 1 - THREE.MathUtils.smoothstep(n.y, -0.7, 0.0);
    const mottle = Math.sin(p.x * 31.7 + p.z * 47.3) * 0.5 + 0.5;
    c.set(0x4f9c2a).offsetHSL(0, 0, (mottle - 0.5) * 0.08);
    c.lerp(new THREE.Color(0xc9d97a), belly * 0.85);
  });
  const frogMat = createToonMaterial({
    vertexColors: true,
    rim: { color: 0xa4ff6e, strength: 0.6, threshold: 0.58 }
  });
  const frogEyeGeo = new THREE.SphereGeometry(0.1, 12, 10);
  const frogEyeMat = createToonMaterial({ color: 0xd8e04a });
  const frogPupilGeo = new THREE.SphereGeometry(0.048, 10, 8);
  const frogPupilMat = createToonMaterial({ color: 0x101014 });
  const frogLegGeo = new THREE.SphereGeometry(0.15, 12, 10);

  assets = {
    pineConeGeo, pineConeMat,
    eggGeo, eggMat,
    frogBodyGeo, frogMat, frogEyeGeo, frogEyeMat, frogPupilGeo, frogPupilMat, frogLegGeo
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

    const a = getAssets();
    this.group = new THREE.Group();
    this.group.position.copy(position);

    this.body = new THREE.Mesh(a.frogBodyGeo, a.frogMat);
    this.body.scale.set(1.15, 0.75, 1.05);
    this.body.position.y = 0.26;
    this.body.castShadow = true;
    this.group.add(this.body);

    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(a.frogEyeGeo, a.frogEyeMat);
      eye.position.set(side * 0.17, 0.5, 0.22);
      this.group.add(eye);
      const pupil = new THREE.Mesh(a.frogPupilGeo, a.frogPupilMat);
      pupil.position.set(side * 0.17, 0.52, 0.3);
      this.group.add(pupil);

      const haunch = new THREE.Mesh(a.frogLegGeo, a.frogMat);
      haunch.position.set(side * 0.3, 0.16, -0.18);
      haunch.scale.set(0.9, 0.8, 1.2);
      haunch.castShadow = true;
      this.group.add(haunch);

      const foot = new THREE.Mesh(a.frogLegGeo, a.frogMat);
      foot.position.set(side * 0.24, 0.07, 0.24);
      foot.scale.set(0.55, 0.4, 0.8);
      this.group.add(foot);
    }

    this.cloud = createPoisonPoints(this.hazardRadius + 0.15, 1.7);
    this.group.add(this.cloud);

    scene.add(this.group);
  }

  update(dt, time) {
    this.stateTimer -= dt;

    if (this.state === 'idle') {
      // Breathing while crouched.
      this.squash = damp(this.squash, 0, 8, dt);
      this.body.scale.y = 0.75 + Math.sin(time * 3.1) * 0.03;
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
      this.body.scale.y = 0.75 * (1 + 0.25 * clamp(this.vy / 6, -1, 1));
    } else if (this.state === 'land') {
      this.squash = damp(this.squash, 0, 12, dt);
      this.body.scale.y = 0.75 * (1 - this.squash);
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
