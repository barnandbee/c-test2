/**
 * Particles.js — GPU-driven particle systems.
 *
 * All motion is computed in vertex shaders (see Shaders.js); the CPU only
 * writes attributes at spawn time. Pickup bursts come from a fixed pool so
 * gameplay never allocates GPU resources mid-frame.
 */

import * as THREE from 'three';
import {
  SharedUniforms,
  createBurstMaterial,
  createAuraMaterial,
  createPoisonMaterial
} from './Shaders.js';

const BURST_POOL_SIZE = 10;
const BURST_MAX_PARTICLES = 48;

class Burst {
  constructor(scene) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(BURST_MAX_PARTICLES * 3), 3)
    );
    this.geometry.setAttribute(
      'aVelocity',
      new THREE.BufferAttribute(new Float32Array(BURST_MAX_PARTICLES * 3), 3)
    );
    this.geometry.setAttribute(
      'aScale',
      new THREE.BufferAttribute(new Float32Array(BURST_MAX_PARTICLES), 1)
    );
    this.geometry.setAttribute(
      'aLife',
      new THREE.BufferAttribute(new Float32Array(BURST_MAX_PARTICLES), 1)
    );
    this.material = createBurstMaterial();
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.endTime = -Infinity;
    scene.add(this.points);
  }

  get busy() {
    return SharedUniforms.uTime.value < this.endTime;
  }

  fire(position, color, opts) {
    const count = Math.min(opts.count, BURST_MAX_PARTICLES);
    const speed = opts.speed;
    const upBias = opts.upBias;
    const life = opts.life;

    const vel = this.geometry.attributes.aVelocity;
    const scale = this.geometry.attributes.aScale;
    const lifeAttr = this.geometry.attributes.aLife;

    let maxLife = 0;
    for (let i = 0; i < count; i++) {
      // Random direction on the sphere, biased upward for a fountain feel.
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const mag = speed * (0.45 + Math.random() * 0.55);
      vel.setXYZ(
        i,
        Math.cos(theta) * s * mag,
        (u * 0.5 + upBias) * mag,
        Math.sin(theta) * s * mag
      );
      scale.setX(i, 0.6 + Math.random() * 0.8);
      const l = life * (0.6 + Math.random() * 0.4);
      lifeAttr.setX(i, l);
      if (l > maxLife) maxLife = l;
    }
    vel.needsUpdate = true;
    scale.needsUpdate = true;
    lifeAttr.needsUpdate = true;

    this.geometry.setDrawRange(0, count);
    this.points.position.copy(position);
    this.material.uniforms.uBirth.value = SharedUniforms.uTime.value;
    this.material.uniforms.uGravity.value = opts.gravity;
    this.material.uniforms.uSize.value = opts.size;
    this.material.uniforms.uColor.value.set(color);
    this.points.visible = true;
    this.endTime = SharedUniforms.uTime.value + maxLife;
  }

  update() {
    if (this.points.visible && !this.busy) this.points.visible = false;
  }

  dispose(scene) {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class ParticleFX {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    for (let i = 0; i < BURST_POOL_SIZE; i++) this.pool.push(new Burst(scene));
  }

  /**
   * Fire a one-shot burst. opts: count, speed, gravity, size, upBias, life.
   */
  spawnBurst(position, color, opts = {}) {
    const settings = {
      count: opts.count !== undefined ? opts.count : 26,
      speed: opts.speed !== undefined ? opts.speed : 4.2,
      gravity: opts.gravity !== undefined ? opts.gravity : 7.5,
      size: opts.size !== undefined ? opts.size : 42,
      upBias: opts.upBias !== undefined ? opts.upBias : 0.7,
      life: opts.life !== undefined ? opts.life : 0.8
    };
    // Prefer a free burst; otherwise steal the one closest to finishing.
    let chosen = null;
    for (const burst of this.pool) {
      if (!burst.busy) {
        chosen = burst;
        break;
      }
    }
    if (!chosen) {
      chosen = this.pool[0];
      for (const burst of this.pool) {
        if (burst.endTime < chosen.endTime) chosen = burst;
      }
    }
    chosen.fire(position, color, settings);
  }

  update() {
    for (const burst of this.pool) burst.update();
  }

  dispose() {
    for (const burst of this.pool) burst.dispose(this.scene);
    this.pool.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Persistent point-cloud builders (aura / poison)                    */
/* ------------------------------------------------------------------ */

/** Rotating golden particle ring for the eggs. */
export function createAuraPoints(count = 34) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const angle = new Float32Array(count);
  const radius = new Float32Array(count);
  const speed = new Float32Array(count);
  const height = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    radius[i] = 0.5 + Math.random() * 0.4;
    speed[i] = (0.8 + Math.random() * 1.4) * (Math.random() < 0.5 ? 1 : -1);
    height[i] = 0.1 + Math.random() * 0.7;
    phase[i] = Math.random() * Math.PI * 2;
  }
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

  const material = createAuraMaterial();
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

/** Drifting translucent poison motes around a frog. */
export function createPoisonPoints(radius = 2.0, height = 1.7, count = 60) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const angle = new Float32Array(count);
  const radiusT = new Float32Array(count);
  const rise = new Float32Array(count);
  const phase = new Float32Array(count);
  const scale = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    radiusT[i] = 0.25 + Math.random() * 0.75;
    rise[i] = 0.25 + Math.random() * 0.45;
    phase[i] = Math.random();
    scale[i] = 0.6 + Math.random() * 0.9;
  }
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geometry.setAttribute('aRadiusT', new THREE.BufferAttribute(radiusT, 1));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rise, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));

  const material = createPoisonMaterial(radius, height);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}
