/**
 * World.js — The Mystic Forest.
 *
 *  - Analytic layered-simplex height field. The SAME functions drive both
 *    the terrain mesh displacement and the collision queries, so the
 *    character controller never disagrees with the visuals.
 *  - Instanced, wind-swayed stylized foliage (trunks / canopies / grass)
 *    and scattered rocks, all sharing a handful of geometries.
 *  - Twilight sky dome, hemisphere + warm directional light with a
 *    high-resolution shadow map that follows the player with texel
 *    snapping (no shadow shimmer while running).
 *  - Exponential height fog hooked through the shared shader chunks.
 */

import * as THREE from 'three';
import { SimplexNoise2D, SeededRandom } from './utils/Noise.js';
import { smoothstep, lerp, clamp } from './utils/MathUtils.js';
import { createToonMaterial, createSkyMaterial, SharedUniforms } from './Shaders.js';

const TERRAIN_SIZE = 260;
const TERRAIN_SEGMENTS = 200;
const PLAYABLE_RADIUS = 104;
const SHADOW_EXTENT = 30;
const SHADOW_MAP_SIZE = 2048;

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer used once to bake the PBR env map
   */
  constructor(scene, renderer, seed = 20260703) {
    this.scene = scene;
    this.playableRadius = PLAYABLE_RADIUS;
    this.colliders = [];        // { x, z, radius, top } cylinders for the player
    this.cameraColliders = [];  // { x, y, z, radius } spheres for the spring arm
    this._disposables = [];

    this.noise = new SimplexNoise2D(seed);
    this.cliffNoise = new SimplexNoise2D(seed * 7 + 1);
    this.detailNoise = new SimplexNoise2D(seed * 13 + 5);
    this.rng = new SeededRandom(seed);

    this._spawnRawHeight = this._rawHeight(0, 0);
    this.sunDirection = new THREE.Vector3(-0.52, 0.4, -0.72).normalize();

    // Scratch objects for allocation-free queries.
    this._n = new THREE.Vector3();
    this._shadowBasisX = new THREE.Vector3();
    this._shadowBasisY = new THREE.Vector3();
    this._shadowBasisZ = new THREE.Vector3();
    this._shadowScratch = new THREE.Vector3();
    this._shadowMatrix = new THREE.Matrix4();

    this._buildAtmosphere(renderer);
    this._buildTerrain();
    this._buildForest();
    this._buildRocks();
    this._buildGrass();
  }

  /* ================================================================ */
  /*  Height field                                                    */
  /* ================================================================ */

  _rawHeight(x, z) {
    // Rolling hills — broad, soft fBm.
    const hills = this.noise.fbm(x * 0.013, z * 0.013, 4) * 9.0;

    // Cliff plateaus — a low-frequency field squeezed through a steep
    // smoothstep so it snaps between "valley floor" and "mesa top",
    // producing near-vertical walls and climbable ledges on the rim.
    const plateauField = this.cliffNoise.noise(x * 0.0075 + 37.2, z * 0.0075 - 11.8);
    const plateau = smoothstep(0.08, 0.42, plateauField) * 8.5;

    // Fine surface detail so flats never read as billiard tables.
    const detail = this.detailNoise.noise(x * 0.11, z * 0.11) * 0.4;

    return hills + plateau + detail;
  }

  /** Public height query — includes the spawn flat and the rim mountains. */
  getHeight(x, z) {
    const r = Math.hypot(x, z);
    let h = lerp(this._spawnRawHeight, this._rawHeight(x, z), smoothstep(5, 17, r));
    // Enclosing ridge that walls off the edge of the map.
    h += smoothstep(PLAYABLE_RADIUS - 6, TERRAIN_SIZE * 0.5, r) * 22;
    return h;
  }

  /** Central-difference surface normal. */
  getNormal(x, z, out) {
    const e = 0.35;
    const hL = this.getHeight(x - e, z);
    const hR = this.getHeight(x + e, z);
    const hD = this.getHeight(x, z - e);
    const hU = this.getHeight(x, z + e);
    out.set(hL - hR, 2 * e, hD - hU);
    return out.normalize();
  }

  /**
   * Find a stable, reasonably flat spot in an annulus — used to scatter
   * collectibles and enemies without burying them in cliffs or trees.
   */
  randomGroundPoint(minR, maxR, maxSlopeNormalY = 0.78) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(minR, Math.min(maxR, PLAYABLE_RADIUS - 4));
      x = Math.cos(angle) * r;
      z = Math.sin(angle) * r;
      if (this.getNormal(x, z, this._n).y < maxSlopeNormalY) continue;
      let blocked = false;
      for (const c of this.colliders) {
        const dx = x - c.x;
        const dz = z - c.z;
        const clear = c.radius + 1.2;
        if (dx * dx + dz * dz < clear * clear) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
    }
    return new THREE.Vector3(x, this.getHeight(x, z), z);
  }

  /* ================================================================ */
  /*  Atmosphere: sky, fog, lights, PBR environment                   */
  /* ================================================================ */

  _buildAtmosphere(renderer) {
    // Exponential fog — the height component is injected per-material in
    // Shaders.js; scene.fog supplies the shared color + density uniforms.
    this.scene.fog = new THREE.FogExp2(0x86597a, 0.0115);
    SharedUniforms.uFogBase.value = 1.5;
    SharedUniforms.uFogHeightFalloff.value = 0.085;

    const skyGeo = new THREE.SphereGeometry(430, 32, 20);
    const skyMat = createSkyMaterial();
    skyMat.uniforms.uSunDirection.value.copy(this.sunDirection).setY(0.16).normalize();
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this._disposables.push(skyGeo, skyMat);

    // Twilight ambience: violet sky bounce over dark mossy ground.
    this.hemiLight = new THREE.HemisphereLight(0x8672cc, 0x44523e, 0.95);
    this.scene.add(this.hemiLight);

    // Low warm sun with a high-resolution follow shadow.
    const sun = new THREE.DirectionalLight(0xffc08a, 2.05);
    sun.position.copy(this.sunDirection).multiplyScalar(70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.camera.left = -SHADOW_EXTENT;
    sun.shadow.camera.right = SHADOW_EXTENT;
    sun.shadow.camera.top = SHADOW_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_EXTENT;
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 170;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.9;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // World-space size of one shadow texel — used for stabilization.
    this._shadowTexelSize = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;

    // Bake a tiny gradient environment so the gold-PBR eggs have something
    // to reflect (a metal with no environment renders black).
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSkyGeo = new THREE.SphereGeometry(50, 16, 12);
    const envSkyMat = createSkyMaterial();
    envScene.add(new THREE.Mesh(envSkyGeo, envSkyMat));
    const glowGeo = new THREE.PlaneGeometry(30, 12);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc27a, side: THREE.DoubleSide });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(-18, 6, -26);
    glow.lookAt(0, 0, 0);
    envScene.add(glow);
    this.environmentRT = pmrem.fromScene(envScene, 0.05);
    this.scene.environment = this.environmentRT.texture;
    envSkyGeo.dispose();
    envSkyMat.dispose();
    glowGeo.dispose();
    glowMat.dispose();
    pmrem.dispose();
  }

  /**
   * Re-center the shadow frustum on the player each frame, snapped to the
   * shadow-map texel grid in light space so edges don't crawl.
   */
  update(dt, focus) {
    const m = this._shadowMatrix;
    m.lookAt(this.sunDirection, this._shadowScratch.set(0, 0, 0), THREE.Object3D.DEFAULT_UP);
    const bx = this._shadowBasisX.setFromMatrixColumn(m, 0);
    const by = this._shadowBasisY.setFromMatrixColumn(m, 1);
    const bz = this._shadowBasisZ.setFromMatrixColumn(m, 2);

    const texel = this._shadowTexelSize;
    const px = Math.round(focus.dot(bx) / texel) * texel;
    const py = Math.round(focus.dot(by) / texel) * texel;
    const pz = focus.dot(bz);

    const snapped = this._shadowScratch
      .set(0, 0, 0)
      .addScaledVector(bx, px)
      .addScaledVector(by, py)
      .addScaledVector(bz, pz);

    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDirection, 70);
    this.sun.target.updateMatrixWorld();

    // Sky dome trails the camera so its bounds are never exited.
    this.sky.position.set(focus.x, 0, focus.z);
  }

  /* ================================================================ */
  /*  Terrain                                                         */
  /* ================================================================ */

  _buildTerrain() {
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const normal = this._n;

    const grassA = new THREE.Color(0x3f7d43); // mossy green
    const grassB = new THREE.Color(0x5d9a54); // sunlit green
    const grassCool = new THREE.Color(0x3a6b6a); // twilight teal on high ground
    const dirt = new THREE.Color(0x6f5a40);
    const rock = new THREE.Color(0x6d6469);
    const rockHi = new THREE.Color(0x8b8390);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.getHeight(x, z);
      pos.setY(i, h);

      this.getNormal(x, z, normal);
      const slope = normal.y;

      // Grass palette varies with a soft noise field + altitude coolness.
      const variation = this.detailNoise.fbm(x * 0.05, z * 0.05, 2) * 0.5 + 0.5;
      c.copy(grassA).lerp(grassB, variation);
      c.lerp(grassCool, smoothstep(6, 15, h) * 0.65);

      // Dirt trails where a wandering noise band crosses gentle ground.
      const trail = Math.abs(this.cliffNoise.noise(x * 0.02 + 91, z * 0.02 - 44));
      c.lerp(dirt, (1 - smoothstep(0.06, 0.16, trail)) * 0.7 * smoothstep(0.85, 0.95, slope));

      // Steep faces become bare rock, lighter toward the top of cliffs.
      const rockAmount = 1 - smoothstep(0.6, 0.82, slope);
      c.lerp(rock, rockAmount);
      c.lerp(rockHi, rockAmount * smoothstep(8, 16, h) * 0.6);

      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = createToonMaterial({ vertexColors: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this._disposables.push(geo, mat);
  }

  /* ================================================================ */
  /*  Forest                                                          */
  /* ================================================================ */

  _makeTrunkGeometry() {
    const geo = new THREE.CylinderGeometry(0.24, 0.55, 5.4, 9, 6);
    geo.translate(0, 2.7, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const t = y / 5.4;
      // Gentle organic lean plus bark lumpiness.
      const bend = Math.sin(t * 2.4) * 0.28 * t;
      const lump = this.detailNoise.noise(x * 3 + y * 1.4, z * 3 - y * 0.9) * 0.06;
      pos.setX(i, x + bend + x * lump * 3);
      pos.setZ(i, z + z * lump * 3);
    }
    geo.computeVertexNormals();
    return geo;
  }

  _makeCanopyGeometry() {
    const geo = new THREE.IcosahedronGeometry(1.2, 1);
    const pos = geo.attributes.position;
    const sway = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const bump = 1 + this.detailNoise.noise(x * 1.6 + 5, z * 1.6 - y * 1.1) * 0.22;
      pos.setXYZ(i, x * bump, y * bump * 0.92, z * bump);
      // Outer leaves sway most; the core barely moves.
      sway[i] = 0.35 + 0.65 * clamp((Math.hypot(x, y, z) - 0.6) / 0.7, 0, 1);
    }
    geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    geo.computeVertexNormals();
    return geo;
  }

  _buildForest() {
    const TREE_COUNT = 56;
    const placements = [];
    const normal = this._n;

    for (let attempt = 0; attempt < TREE_COUNT * 14 && placements.length < TREE_COUNT; attempt++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(15, PLAYABLE_RADIUS - 3);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      if (this.getNormal(x, z, normal).y < 0.74) continue;
      let tooClose = false;
      for (const p of placements) {
        const dx = x - p.x;
        const dz = z - p.z;
        if (dx * dx + dz * dz < 5.5 * 5.5) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      placements.push({ x, z, h: this.getHeight(x, z), scale: this.rng.range(0.85, 1.55) });
    }

    const trunkGeo = this._makeTrunkGeometry();
    const canopyGeo = this._makeCanopyGeometry();
    const trunkMat = createToonMaterial({
      color: 0x5c4534,
      rim: { color: 0x8a76c9, strength: 0.3, threshold: 0.68 }
    });
    const canopyMat = createToonMaterial({
      vertexColors: false,
      color: 0xffffff, // tinted per-instance
      rim: { color: 0xb9a4ff, strength: 0.45, threshold: 0.62 },
      sway: { strength: 0.14, speed: 1.5 }
    });
    this._disposables.push(trunkGeo, canopyGeo, trunkMat, canopyMat);

    const canopyPalette = [0x35714f, 0x2e6b5e, 0x477f43, 0x54925f, 0x3c7a6a, 0x62975a];
    const blobsPerTree = 4;

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, placements.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, placements.length * blobsPerTree);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    canopies.castShadow = true;

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const vec = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();

    let canopyIndex = 0;
    placements.forEach((p, i) => {
      const s = p.scale;
      euler.set(this.rng.range(-0.06, 0.06), this.rng.range(0, Math.PI * 2), this.rng.range(-0.06, 0.06));
      quat.setFromEuler(euler);
      const trunkHeight = 5.4 * s * this.rng.range(0.92, 1.12);
      scl.set(s, trunkHeight / 5.4, s);
      vec.set(p.x, p.h - 0.2, p.z);
      matrix.compose(vec, quat, scl);
      trunks.setMatrixAt(i, matrix);

      for (let b = 0; b < blobsPerTree; b++) {
        const spread = 1.25 * s;
        vec.set(
          p.x + this.rng.range(-spread, spread),
          p.h - 0.2 + trunkHeight * this.rng.range(0.86, 1.02),
          p.z + this.rng.range(-spread, spread)
        );
        euler.set(this.rng.range(0, Math.PI), this.rng.range(0, Math.PI), 0);
        quat.setFromEuler(euler);
        const bs = s * this.rng.range(1.0, 1.9);
        scl.set(bs, bs * this.rng.range(0.85, 1.0), bs);
        matrix.compose(vec, quat, scl);
        canopies.setMatrixAt(canopyIndex, matrix);
        color.set(canopyPalette[Math.floor(this.rng.next() * canopyPalette.length)]);
        color.offsetHSL(0, 0, this.rng.range(-0.03, 0.03));
        canopies.setColorAt(canopyIndex, color);
        canopyIndex++;
      }

      this.colliders.push({ x: p.x, z: p.z, radius: 0.7 * s, top: p.h + 3.2 });
    });

    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;

    this.scene.add(trunks);
    this.scene.add(canopies);
    this.trunks = trunks;
    this.canopies = canopies;
  }

  /* ================================================================ */
  /*  Rocks                                                           */
  /* ================================================================ */

  _buildRocks() {
    const ROCK_COUNT = 40;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const bump = 1 + this.detailNoise.noise(x * 2.2 - 7, z * 2.2 + y * 1.3) * 0.25;
      pos.setXYZ(i, x * bump, y * bump, z * bump);
    }
    geo.computeVertexNormals();

    const mat = createToonMaterial({
      color: 0xffffff,
      rim: { color: 0x9d8fd4, strength: 0.4, threshold: 0.66 }
    });
    this._disposables.push(geo, mat);

    const rocks = new THREE.InstancedMesh(geo, mat, ROCK_COUNT);
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const vec = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const normal = this._n;

    for (let i = 0; i < ROCK_COUNT; i++) {
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(12, PLAYABLE_RADIUS - 2);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
        if (this.getNormal(x, z, normal).y > 0.7) break;
      }
      const h = this.getHeight(x, z);
      const s = this.rng.range(0.5, 2.4);
      euler.set(this.rng.range(0, Math.PI), this.rng.range(0, Math.PI * 2), this.rng.range(0, Math.PI));
      quat.setFromEuler(euler);
      scl.set(s, s * this.rng.range(0.6, 0.85), s);
      vec.set(x, h + s * 0.12, z);
      matrix.compose(vec, quat, scl);
      rocks.setMatrixAt(i, matrix);
      color.set(0x76707c).offsetHSL(this.rng.range(-0.02, 0.02), 0, this.rng.range(-0.06, 0.06));
      rocks.setColorAt(i, color);

      this.colliders.push({ x, z, radius: s * 0.85, top: h + s * 1.1 });
      if (s > 1.3) {
        this.cameraColliders.push({ x, y: h + s * 0.4, z, radius: s * 0.95 });
      }
    }

    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    this.scene.add(rocks);
    this.rocks = rocks;
  }

  /* ================================================================ */
  /*  Grass                                                           */
  /* ================================================================ */

  _buildGrass() {
    const GRASS_COUNT = 900;
    const geo = new THREE.ConeGeometry(0.055, 0.55, 5, 1, false);
    geo.translate(0, 0.24, 0);
    const pos = geo.attributes.position;
    const sway = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      sway[i] = clamp(pos.getY(i) / 0.5, 0, 1);
    }
    geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));

    const mat = createToonMaterial({
      color: 0xffffff,
      sway: { strength: 0.09, speed: 2.2 }
    });
    this._disposables.push(geo, mat);

    const grass = new THREE.InstancedMesh(geo, mat, GRASS_COUNT);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const vec = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const normal = this._n;

    for (let i = 0; i < GRASS_COUNT; i++) {
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(3, PLAYABLE_RADIUS - 2);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
        if (this.getNormal(x, z, normal).y > 0.82) break;
      }
      const h = this.getHeight(x, z);
      euler.set(this.rng.range(-0.25, 0.25), this.rng.range(0, Math.PI * 2), this.rng.range(-0.25, 0.25));
      quat.setFromEuler(euler);
      const s = this.rng.range(0.7, 1.45);
      scl.set(s, s * this.rng.range(0.85, 1.3), s);
      vec.set(x, h - 0.03, z);
      matrix.compose(vec, quat, scl);
      grass.setMatrixAt(i, matrix);
      color.set(0x4e8a4c).offsetHSL(this.rng.range(-0.04, 0.06), 0, this.rng.range(-0.08, 0.06));
      grass.setColorAt(i, color);
    }

    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    this.scene.add(grass);
    this.grass = grass;
  }

  /* ================================================================ */
  /*  Lifecycle                                                       */
  /* ================================================================ */

  dispose() {
    for (const obj of [this.terrain, this.trunks, this.canopies, this.rocks, this.grass, this.sky]) {
      if (obj && obj.parent) obj.parent.remove(obj);
      if (obj && obj.isInstancedMesh) obj.dispose();
    }
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.sun);
    this.scene.remove(this.sun.target);
    if (this.sun.shadow.map) this.sun.shadow.map.dispose();
    if (this.environmentRT) {
      this.scene.environment = null;
      this.environmentRT.dispose();
    }
    for (const resource of this._disposables) resource.dispose();
    this._disposables.length = 0;
    this.colliders.length = 0;
    this.cameraColliders.length = 0;
  }
}
