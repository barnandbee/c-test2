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
import { createToonMaterial, createSkyMaterial, createWaterMaterial, SharedUniforms } from './Shaders.js';
import { createAuraPoints } from './Particles.js';

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
    this.platforms = [];        // { minX, maxX, minZ, maxZ, top } standable AABB tops
    this.treeTops = [];         // crown points of every tree (cherry perches)
    this._disposables = [];

    this.noise = new SimplexNoise2D(seed);
    this.cliffNoise = new SimplexNoise2D(seed * 7 + 1);
    this.detailNoise = new SimplexNoise2D(seed * 13 + 5);
    this.rng = new SeededRandom(seed);

    this._spawnRawHeight = this._rawHeight(0, 0);
    this.sunDirection = new THREE.Vector3(-0.52, 0.4, -0.72).normalize();

    // --- the golf corner: a mown green and its bunker --------------------
    // Defined before geometry is built, because getHeight() flattens the
    // green and scoops the bunker.
    const golfAngle = 5.2;
    this.greenCenterX = Math.cos(golfAngle) * 48;
    this.greenCenterZ = Math.sin(golfAngle) * 48;
    this.greenRadius = 6.5;
    this.greenLevel = this._rawHeight(this.greenCenterX, this.greenCenterZ);
    // Bunker guarding the approach, just off the green's edge.
    this.bunkerCenterX = this.greenCenterX + Math.cos(golfAngle + 2.2) * 8.2;
    this.bunkerCenterZ = this.greenCenterZ + Math.sin(golfAngle + 2.2) * 8.2;
    this.bunkerRadius = 2.6;

    // --- the lake: a carved basin on the west side ----------------------
    // Defined before any geometry is built, because getHeight() carves it.
    const lakeAngle = 2.75;
    this.lakeCenterX = Math.cos(lakeAngle) * 66;
    this.lakeCenterZ = Math.sin(lakeAngle) * 66;
    this.lakeRadius = 17;
    // Water sits a little below the average rim height.
    let rimSum = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      rimSum += this.getHeight(
        this.lakeCenterX + Math.cos(a) * this.lakeRadius * 1.15,
        this.lakeCenterZ + Math.sin(a) * this.lakeRadius * 1.15
      );
    }
    this.waterLevel = rimSum / 8 - 1.1;

    // --- the cave: a sunken grotto dug into the south side ---------------
    // Decided before geometry exists because getHeight() digs its ramp:
    // a short tunnel descending below grade, roofed by the rock hood that
    // _buildCave() raises over it. A tiny deterministic search keeps the
    // dig on gentle ground, well clear of the lake and the golf corner.
    this.caveDepth = 1.7;
    let caveBest = null;
    for (const [da, r] of [[0, 50], [0.35, 46], [-0.35, 54], [0.6, 52], [-0.6, 47], [0.2, 58], [0, 44]]) {
      const a = 4.05 + da;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const e = 0.8;
      const grad = Math.hypot(
        this.getHeight(x + e, z) - this.getHeight(x - e, z),
        this.getHeight(x, z + e) - this.getHeight(x, z - e)
      ) / (2 * e);
      if (!caveBest || grad < caveBest.grad) caveBest = { x, z, grad };
      if (caveBest.grad < 0.28) break;
    }
    this.caveX = caveBest.x;
    this.caveZ = caveBest.z;
    // The tunnel digs outward (away from the map's heart); the mouth
    // faces inward, toward the action.
    const caveR = Math.hypot(caveBest.x, caveBest.z);
    this.caveDirX = caveBest.x / caveR;
    this.caveDirZ = caveBest.z / caveR;
    this.caveLevel = this.getHeight(this.caveX, this.caveZ); // grade, pre-dig
    this.caveRadius = 5.0; // setting this arms the carve in getHeight()

    // --- the cottage: a homely pad on the north-east side -----------------
    // Sited before geometry exists because getHeight() levels its yard.
    // Same tiny search as the cave: a handful of candidates, gentlest wins.
    let cottageBest = null;
    for (const [da, r] of [[0, 46], [0.3, 50], [-0.3, 44], [0.5, 54], [-0.5, 48], [0.15, 40]]) {
      const a = 1.55 + da;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const e = 0.8;
      const grad = Math.hypot(
        this.getHeight(x + e, z) - this.getHeight(x - e, z),
        this.getHeight(x, z + e) - this.getHeight(x, z - e)
      ) / (2 * e);
      if (!cottageBest || grad < cottageBest.grad) cottageBest = { x, z, grad };
      if (cottageBest.grad < 0.25) break;
    }
    this.cottageX = cottageBest.x;
    this.cottageZ = cottageBest.z;
    // The front door faces the map's heart.
    const cotR = Math.hypot(cottageBest.x, cottageBest.z);
    this.cottageDoorX = -cottageBest.x / cotR;
    this.cottageDoorZ = -cottageBest.z / cotR;
    this.cottageLevel = this.getHeight(this.cottageX, this.cottageZ); // pre-level grade
    this.cottageRadius = 7.0; // setting this arms the yard-leveling in getHeight()

    // Scratch objects for allocation-free queries.
    this._n = new THREE.Vector3();
    this._shadowBasisX = new THREE.Vector3();
    this._shadowBasisY = new THREE.Vector3();
    this._shadowBasisZ = new THREE.Vector3();
    this._shadowScratch = new THREE.Vector3();
    this._shadowMatrix = new THREE.Matrix4();

    this._buildAtmosphere(renderer);
    this._buildTerrain();
    this._buildLake();
    this._buildForest();
    this._buildBlossomTree();
    this._buildRocks();
    this._buildGrass();
    this._buildEscherStairs();
    this._buildCave();
    this._buildGolfFlag();
    this._buildCottage();
    this._buildCoral();
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

  /** Public height query — includes the spawn flat, rim mountains and lake. */
  getHeight(x, z) {
    const r = Math.hypot(x, z);
    let h = lerp(this._spawnRawHeight, this._rawHeight(x, z), smoothstep(5, 17, r));
    // Enclosing ridge that walls off the edge of the map.
    h += smoothstep(PLAYABLE_RADIUS - 6, TERRAIN_SIZE * 0.5, r) * 22;
    // Carve the lake basin.
    if (this.lakeRadius) {
      const ld = Math.hypot(x - this.lakeCenterX, z - this.lakeCenterZ);
      if (ld < this.lakeRadius) {
        h -= (1 - smoothstep(this.lakeRadius * 0.45, this.lakeRadius, ld)) * 7;
      }
    }
    // Mow the golf green dead flat, and scoop the bunker.
    if (this.greenRadius) {
      const gd = Math.hypot(x - this.greenCenterX, z - this.greenCenterZ);
      if (gd < this.greenRadius) {
        h = lerp(this.greenLevel, h, smoothstep(this.greenRadius * 0.5, this.greenRadius, gd));
      }
      const bd = Math.hypot(x - this.bunkerCenterX, z - this.bunkerCenterZ);
      if (bd < this.bunkerRadius) {
        h -= (1 - smoothstep(this.bunkerRadius * 0.3, this.bunkerRadius, bd)) * 0.55;
      }
    }
    // Dig the cave: a short tunnel ramping below grade.
    if (this.caveRadius) {
      h -= this._caveDig(x, z) * this.caveDepth;
    }
    // Level the cottage's yard so the little house sits square.
    if (this.cottageRadius) {
      const cd = Math.hypot(x - this.cottageX, z - this.cottageZ);
      if (cd < this.cottageRadius) {
        h = lerp(this.cottageLevel, h, smoothstep(this.cottageRadius * 0.45, this.cottageRadius, cd));
      }
    }
    return h;
  }

  /**
   * The cave dig's carve profile, 0 → 1 (1 = full tunnel depth). A ramp
   * descends from grade at the mouth to a flat-bottomed chamber; the
   * same profile drives getHeight(), the terrain's earth tint and the
   * spawn rejects, so collision and visuals can never disagree.
   */
  _caveDig(x, z) {
    const rx = x - this.caveX;
    const rz = z - this.caveZ;
    const u = rx * this.caveDirX + rz * this.caveDirZ; // mouth → back wall
    const v = -rx * this.caveDirZ + rz * this.caveDirX; // lateral
    if (u < -7.5 || u > 4.8 || v < -4.5 || v > 4.5) return 0;
    const along = smoothstep(-7.0, -1.2, u) * (1 - smoothstep(2.6, 4.6, u));
    const across = 1 - smoothstep(1.8, 4.0, Math.abs(v));
    return along * across;
  }

  /** True only inside the lake's carved footprint — water rules (drowning,
   *  hover-float, camera clamp) must never fire in ordinary low valleys. */
  isNearLake(x, z) {
    const dx = x - this.lakeCenterX;
    const dz = z - this.lakeCenterZ;
    return dx * dx + dz * dz < this.lakeRadius * this.lakeRadius;
  }

  /**
   * Walkable surface height: the terrain, or any platform top whose
   * footprint contains (x,z) — but only when `refY` is within step-up
   * reach of it, so walking (or jumping) beneath a platform never
   * teleports the player onto it from far below.
   */
  getGroundHeight(x, z, refY, terrainH) {
    let h = terrainH !== undefined ? terrainH : this.getHeight(x, z);
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      if (p.top <= h) continue;
      if (refY >= p.top - 0.5) h = p.top;
    }
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
      if (this.isNearLake(x, z) && this.getHeight(x, z) < this.waterLevel + 0.25) continue;
      // Nothing spawns on the green — golf etiquette.
      if (Math.hypot(x - this.greenCenterX, z - this.greenCenterZ) < this.greenRadius + 1.5) continue;
      // …and nothing spawns in the cave dig or its doorway.
      if (Math.hypot(x - this.caveX, z - this.caveZ) < this.caveRadius + 2.5) continue;
      // …or in the cottage's yard.
      if (Math.hypot(x - this.cottageX, z - this.cottageZ) < this.cottageRadius + 1.5) continue;
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

    // Dollhouse rule: the cottage roof lifts away while someone is inside,
    // so the third-person camera can see the room.
    if (this.cottageRoof) {
      const dx = focus.x - this.cottageX;
      const dz = focus.z - this.cottageZ;
      // Local frame: +Z is the door direction.
      const lx = dx * this.cottageDoorZ - dz * this.cottageDoorX;
      const lz = dx * this.cottageDoorX + dz * this.cottageDoorZ;
      const inside =
        Math.abs(lx) < 3.5 &&
        lz > -3.0 &&
        lz < 3.4 &&
        focus.y < this.cottageLevel + 3;
      this.cottageRoof.visible = !inside;
    }

    // Chimney smoke: puffs rise, wander a little, swell and thin out.
    if (this._smokePuffs) {
      this._smokeTime += dt;
      for (const p of this._smokePuffs) {
        const t = (this._smokeTime * 0.22 + p.phase) % 1;
        p.mesh.position.set(
          1.9 + Math.sin((this._smokeTime + p.phase * 9) * 1.3) * 0.16 * t,
          4.55 + t * 2.6,
          -1.2 + Math.cos((this._smokeTime + p.phase * 7) * 1.1) * 0.14 * t
        );
        p.mesh.scale.setScalar(0.5 + t * 1.7);
        p.mat.opacity = 0.5 * (1 - t) * smoothstep(0, 0.12, t);
      }
    }
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

      // The golf green: bright mown grass with alternating stripes; the
      // bunker: pale raked sand.
      const greenDist = Math.hypot(x - this.greenCenterX, z - this.greenCenterZ);
      if (greenDist < this.greenRadius) {
        const mow = 1 - smoothstep(this.greenRadius * 0.8, this.greenRadius, greenDist);
        const stripe = Math.floor((x - z) / 1.6) % 2 === 0 ? 0.06 : -0.02;
        c.lerp(new THREE.Color(0x4fae4a).offsetHSL(0, 0.05, stripe), mow);
      }
      const bunkerDist = Math.hypot(x - this.bunkerCenterX, z - this.bunkerCenterZ);
      if (bunkerDist < this.bunkerRadius) {
        const sandy = 1 - smoothstep(this.bunkerRadius * 0.55, this.bunkerRadius, bunkerDist);
        c.lerp(new THREE.Color(0xe8d8a0), sandy);
      }

      // The cave dig: grass gives way to bare trodden earth.
      const dig = this._caveDig(x, z);
      if (dig > 0) {
        c.lerp(new THREE.Color(0x4c3d31), dig * 0.85);
      }

      // Lake bed: sandy shore banding into a dark teal depth (lake only —
      // ordinary low valleys elsewhere keep their grass).
      const lakeDx = x - this.lakeCenterX;
      const lakeDz = z - this.lakeCenterZ;
      const inLakeZone = lakeDx * lakeDx + lakeDz * lakeDz < (this.lakeRadius * 1.08) ** 2;
      const sandBlend = inLakeZone
        ? 1 - smoothstep(this.waterLevel - 0.7, this.waterLevel + 0.6, h)
        : 0;
      if (sandBlend > 0) {
        c.lerp(new THREE.Color(0x9a8a5e), sandBlend * 0.85);
        const deepBlend = 1 - smoothstep(this.waterLevel - 4.5, this.waterLevel - 1.2, h);
        c.lerp(new THREE.Color(0x27423f), deepBlend);
      }

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
  /*  Lake & signage                                                  */
  /* ================================================================ */

  _buildLake() {
    const waterGeo = new THREE.CircleGeometry(this.lakeRadius * 0.99, 48);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = createWaterMaterial();
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.position.set(this.lakeCenterX, this.waterLevel, this.lakeCenterZ);
    this.scene.add(this.water);
    this._disposables.push(waterGeo, waterMat);

    // --- 'Watch out for Red October!' sign on the shore facing spawn ------
    const toSpawn = new THREE.Vector2(-this.lakeCenterX, -this.lakeCenterZ).normalize();
    const sx = this.lakeCenterX + toSpawn.x * (this.lakeRadius + 2.0);
    const sz = this.lakeCenterZ + toSpawn.y * (this.lakeRadius + 2.0);
    const sy = this.getHeight(sx, sz);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const g = canvas.getContext('2d');
    g.fillStyle = '#8a6a42';
    g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#4a3520';
    g.lineWidth = 14;
    g.strokeRect(10, 10, 492, 236);
    g.textAlign = 'center';
    g.fillStyle = '#2c2014';
    g.font = 'bold 52px Georgia, serif';
    g.fillText('WATCH OUT FOR', 256, 100);
    g.fillStyle = '#a01818';
    g.font = 'bold 64px Georgia, serif';
    g.fillText('RED OCTOBER!', 256, 190);
    const signTex = new THREE.CanvasTexture(canvas);
    signTex.colorSpace = THREE.SRGBColorSpace;

    const woodMat = createToonMaterial({ color: 0x6e5232 });
    const faceMat = createToonMaterial({
      map: signTex,
      emissiveMap: signTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.22
    });
    const postGeo = new THREE.CylinderGeometry(0.07, 0.09, 1.7, 8);
    const boardGeo = new THREE.BoxGeometry(1.9, 0.95, 0.08);
    const faceGeo = new THREE.PlaneGeometry(1.8, 0.88);
    this._disposables.push(signTex, woodMat, faceMat, postGeo, boardGeo, faceGeo);

    const sign = new THREE.Group();
    sign.position.set(sx, sy, sz);
    sign.rotation.y = Math.atan2(toSpawn.x, toSpawn.y);
    const post = new THREE.Mesh(postGeo, woodMat);
    post.position.y = 0.85;
    post.castShadow = true;
    sign.add(post);
    const board = new THREE.Mesh(boardGeo, woodMat);
    board.position.y = 1.55;
    board.castShadow = true;
    sign.add(board);
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.set(0, 1.55, 0.05);
    sign.add(face);
    this.scene.add(sign);
    this.lakeSign = sign;

    this.colliders.push({ x: sx, z: sz, radius: 0.25, top: sy + 2 });
  }

  /* ================================================================ */
  /*  Forest                                                          */
  /* ================================================================ */

  _makeTrunkGeometry() {
    const geo = new THREE.CylinderGeometry(0.22, 0.5, 5.4, 12, 8);
    geo.translate(0, 2.7, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      const y = pos.getY(i);
      let z = pos.getZ(i);
      const t = y / 5.4;

      // Buttressed root flare: lobes swell out near the ground line, so
      // trunks read as grown-in rather than planted dowels.
      const r = Math.hypot(x, z);
      if (r > 1e-5 && y < 0.9) {
        const angle = Math.atan2(z, x);
        const f = (0.9 - y) / 0.9;
        const lobes = 0.55 + 0.4 * Math.sin(angle * 3 + 1.7) + 0.25 * Math.sin(angle * 5 - 0.6);
        const flare = 1 + f * f * lobes;
        x *= flare;
        z *= flare;
      }

      // Gentle organic lean plus bark lumpiness.
      const bend = Math.sin(t * 2.4) * 0.28 * t;
      const lump = this.detailNoise.noise(x * 3 + y * 1.4, z * 3 - y * 0.9) * 0.06;
      pos.setX(i, x + bend + x * lump * 3);
      pos.setZ(i, z + z * lump * 3);
    }
    geo.computeVertexNormals();
    return geo;
  }

  /** Short tapered limb, pivot at its base, poking out into the canopy. */
  _makeBranchGeometry() {
    const geo = new THREE.CylinderGeometry(0.05, 0.13, 1.7, 7, 3);
    geo.translate(0, 0.85, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = y / 1.7;
      // Slight upward sweep so limbs curve toward the light.
      pos.setZ(i, pos.getZ(i) + Math.sin(t * 1.8) * 0.16 * t);
    }
    geo.computeVertexNormals();
    return geo;
  }

  _makeCanopyGeometry() {
    const geo = new THREE.IcosahedronGeometry(1.2, 2);
    const pos = geo.attributes.position;
    const sway = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      // Two octaves of displacement: broad lobes + fine leaf-cluster chop.
      const lobes = this.detailNoise.noise(x * 1.6 + 5, z * 1.6 - y * 1.1) * 0.24;
      const chop = this.detailNoise.noise(x * 4.2 - 13, z * 4.2 + y * 3.1) * 0.09;
      const bump = 1 + lobes + chop;
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
      if (this.isNearLake(x, z) && this.getHeight(x, z) < this.waterLevel + 0.3) continue;
      if (Math.hypot(x - this.greenCenterX, z - this.greenCenterZ) < this.greenRadius + 2) continue;
      // Trees near the cave mouth would wall off the camera's sightline.
      if (Math.hypot(x - this.caveX, z - this.caveZ) < 9) continue;
      if (Math.hypot(x - this.cottageX, z - this.cottageZ) < this.cottageRadius + 2) continue;
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
    const branchGeo = this._makeBranchGeometry();
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
    this._disposables.push(trunkGeo, branchGeo, canopyGeo, trunkMat, canopyMat);

    const canopyPalette = [0x35714f, 0x2e6b5e, 0x477f43, 0x54925f, 0x3c7a6a, 0x62975a];
    const blobsPerTree = 5;
    const branchesPerTree = 3;

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, placements.length);
    const branches = new THREE.InstancedMesh(branchGeo, trunkMat, placements.length * branchesPerTree);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, placements.length * blobsPerTree);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    branches.castShadow = true;
    canopies.castShadow = true;

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const vec = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();

    let canopyIndex = 0;
    let branchIndex = 0;
    placements.forEach((p, i) => {
      const s = p.scale;
      euler.set(this.rng.range(-0.06, 0.06), this.rng.range(0, Math.PI * 2), this.rng.range(-0.06, 0.06));
      quat.setFromEuler(euler);
      const trunkHeight = 5.4 * s * this.rng.range(0.92, 1.12);
      scl.set(s, trunkHeight / 5.4, s);
      vec.set(p.x, p.h - 0.2, p.z);
      matrix.compose(vec, quat, scl);
      trunks.setMatrixAt(i, matrix);

      // Limbs fan out of the upper trunk into the canopy mass.
      for (let b = 0; b < branchesPerTree; b++) {
        const azimuth = this.rng.range(0, Math.PI * 2);
        const tilt = this.rng.range(0.9, 1.35); // radians from vertical
        const heightFrac = this.rng.range(0.55, 0.8);
        euler.set(tilt, azimuth, 0, 'YXZ');
        quat.setFromEuler(euler);
        vec.set(
          p.x + Math.sin(azimuth) * 0.3 * s,
          p.h - 0.2 + trunkHeight * heightFrac,
          p.z + Math.cos(azimuth) * 0.3 * s
        );
        const bs = s * this.rng.range(0.7, 1.1);
        scl.set(bs, bs, bs);
        matrix.compose(vec, quat, scl);
        branches.setMatrixAt(branchIndex, matrix);
        branchIndex++;
      }

      for (let b = 0; b < blobsPerTree; b++) {
        const spread = 1.35 * s;
        vec.set(
          p.x + this.rng.range(-spread, spread),
          p.h - 0.2 + trunkHeight * this.rng.range(0.84, 1.04),
          p.z + this.rng.range(-spread, spread)
        );
        euler.set(this.rng.range(0, Math.PI), this.rng.range(0, Math.PI), 0);
        quat.setFromEuler(euler);
        const bs = s * this.rng.range(0.95, 1.8);
        scl.set(bs, bs * this.rng.range(0.85, 1.0), bs);
        matrix.compose(vec, quat, scl);
        canopies.setMatrixAt(canopyIndex, matrix);
        color.set(canopyPalette[Math.floor(this.rng.next() * canopyPalette.length)]);
        color.offsetHSL(0, 0, this.rng.range(-0.03, 0.03));
        canopies.setColorAt(canopyIndex, color);
        canopyIndex++;
      }

      this.colliders.push({ x: p.x, z: p.z, radius: 0.75 * s, top: p.h + 3.2 });
      // Crown point, just proud of the canopy — where a cherry might sit.
      this.treeTops.push(new THREE.Vector3(p.x, p.h - 0.2 + trunkHeight + 1.9 * s, p.z));
    });

    trunks.instanceMatrix.needsUpdate = true;
    branches.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;

    this.scene.add(trunks);
    this.scene.add(branches);
    this.scene.add(canopies);
    this.trunks = trunks;
    this.branches = branches;
    this.canopies = canopies;
  }

  /* ================================================================ */
  /*  The cherry blossom tree                                         */
  /* ================================================================ */

  /**
   * One grand cherry blossom tree — a pink-crowned landmark. Double-tap
   * beside it and the ground gives up its secret (Game handles that; the
   * world just grows the tree and remembers where it stands).
   */
  _buildBlossomTree() {
    const spot = this.randomGroundPoint(30, 55, 0.8);
    this.blossomTree = spot.clone();

    // Twice the stature of a common tree, and impossible to mistake: the
    // canopy is luminous pink (self-lit, so shade and fog can't mute it),
    // wrapped in a slowly orbiting halo of petal sparkles, with its own
    // soft rose light spilling onto the grass below.
    const scale = 2.0;
    const trunkGeo = this._makeTrunkGeometry();
    const canopyGeo = this._makeCanopyGeometry();
    const barkMat = createToonMaterial({
      color: 0x6e4a4a,
      rim: { color: 0xff9ecb, strength: 0.45, threshold: 0.6 }
    });
    const petalMats = [0xff8fc2, 0xffc2dd, 0xf573b0].map((color) =>
      createToonMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.28,
        rim: { color: 0xfff0f8, strength: 0.6, threshold: 0.5 },
        sway: { strength: 0.18, speed: 1.3 }
      })
    );
    this._disposables.push(trunkGeo, canopyGeo, barkMat, ...petalMats);

    const tree = new THREE.Group();
    tree.position.set(spot.x, spot.y - 0.2, spot.z);
    this.blossomMeshes = tree;

    const trunk = new THREE.Mesh(trunkGeo, barkMat);
    trunk.scale.set(scale, scale, scale);
    trunk.castShadow = true;
    tree.add(trunk);

    const trunkHeight = 5.4 * scale;
    for (let b = 0; b < 8; b++) {
      const blob = new THREE.Mesh(canopyGeo, petalMats[b % petalMats.length]);
      const spread = 1.7 * scale;
      blob.position.set(
        this.rng.range(-spread, spread),
        trunkHeight * this.rng.range(0.82, 1.05),
        this.rng.range(-spread, spread)
      );
      const bs = scale * this.rng.range(1.0, 1.6);
      blob.scale.set(bs, bs * 0.9, bs);
      blob.rotation.y = this.rng.range(0, Math.PI);
      blob.castShadow = true;
      tree.add(blob);
    }

    // Orbiting petal-sparkle halo around the crown.
    this.blossomAura = createAuraPoints(60, {
      radiusBase: 3.6 * scale * 0.5,
      radiusVar: 2.0,
      heightBase: trunkHeight * 0.78,
      heightVar: trunkHeight * 0.4
    });
    this.blossomAura.material.uniforms.uColor.value.set(0xffb8d9);
    this.blossomAura.material.uniforms.uSize.value = 34;
    tree.add(this.blossomAura);

    // A rose glow pooling beneath the tree at twilight.
    const blossomLight = new THREE.PointLight(0xff9ecb, 5, 26, 1.8);
    blossomLight.position.y = trunkHeight * 0.9;
    tree.add(blossomLight);

    this.scene.add(tree);
    this.colliders.push({ x: spot.x, z: spot.z, radius: 1.4, top: spot.y + 6 });
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
        if (
          this.getNormal(x, z, normal).y > 0.7 &&
          !(this.isNearLake(x, z) && this.getHeight(x, z) < this.waterLevel + 0.2) &&
          Math.hypot(x - this.greenCenterX, z - this.greenCenterZ) > this.greenRadius + 1.5 &&
          Math.hypot(x - this.caveX, z - this.caveZ) > 7 &&
          Math.hypot(x - this.cottageX, z - this.cottageZ) > this.cottageRadius
        ) break;
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
        if (
          this.getNormal(x, z, normal).y > 0.82 &&
          !(this.isNearLake(x, z) && this.getHeight(x, z) < this.waterLevel + 0.15) &&
          Math.hypot(x - this.greenCenterX, z - this.greenCenterZ) > this.greenRadius + 0.5 &&
          this._caveDig(x, z) === 0 &&
          Math.hypot(x - this.cottageX, z - this.cottageZ) > 4.5
        ) break;
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
  /*  The Escher stairs                                               */
  /* ================================================================ */

  /**
   * A floating stone folly on the east side of the map: three switchback
   * flights of hovering steps climbing to a lofty platform, with mirrored
   * flights hanging impossibly upside-down beneath — pure M.C. Escher.
   * Every step registers a standable platform, so the badger can hop all
   * the way up and leap off the top.
   */
  _buildEscherStairs() {
    const anchorAngle = 0.35;
    const anchorR = 72;
    const bx = Math.cos(anchorAngle) * anchorR;
    const bz = Math.sin(anchorAngle) * anchorR;
    const h0 = this.getHeight(bx, bz) + 0.5;
    this._stairMeshes = [];

    const STEP_RISE = 0.4;
    const STEP_PITCH = 1.05; // spacing along the direction of travel
    const PER_FLIGHT = 8;

    const stoneMat = createToonMaterial({
      color: 0xb4aec6,
      rim: { color: 0xd9c9ff, strength: 0.5, threshold: 0.58 }
    });
    const stepGeo = new THREE.BoxGeometry(STEP_PITCH, 0.38, 1.7);
    const landingGeo = new THREE.BoxGeometry(2.6, 0.42, 3.9);
    const topGeo = new THREE.BoxGeometry(3.2, 0.46, 3.2);
    const columnGeo = new THREE.CylinderGeometry(0.42, 0.55, 1, 10);
    this._disposables.push(stoneMat, stepGeo, landingGeo, topGeo, columnGeo);

    const registerPlatform = (cx, cz, halfX, halfZ, top) => {
      this.platforms.push({
        minX: cx - halfX,
        maxX: cx + halfX,
        minZ: cz - halfZ,
        maxZ: cz + halfZ,
        top
      });
    };

    // Three switchback flights: out along +x, back along -x, out again.
    const flightRows = [0, 2.2, 4.4]; // local z of each flight
    const flightDirs = [1, -1, 1];
    const flightStartX = [0, PER_FLIGHT * STEP_PITCH, 0];

    const stepTransforms = [];
    let level = 0;
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < PER_FLIGHT; i++) {
        level += STEP_RISE;
        const lx = flightStartX[f] + flightDirs[f] * (i + 0.5) * STEP_PITCH;
        const lz = flightRows[f];
        const top = h0 + level;
        stepTransforms.push({ x: bx + lx, y: top - 0.19, z: bz + lz, inverted: false });
        registerPlatform(bx + lx, bz + lz, STEP_PITCH / 2, 0.85, top);
      }
      level += STEP_RISE; // the landing sits one rise above the flight
      const endX = flightStartX[f] + flightDirs[f] * (PER_FLIGHT * STEP_PITCH + 1.0);
      const landZ = flightRows[f] + (f < 2 ? 1.1 : 0);
      const top = h0 + level;
      if (f < 2) {
        // Corner landing bridging this flight to the next row back.
        const landing = new THREE.Mesh(landingGeo, stoneMat);
        landing.position.set(bx + endX, top - 0.21, bz + landZ);
        landing.castShadow = true;
        landing.receiveShadow = true;
        this.scene.add(landing);
        this._stairMeshes.push(landing);
        registerPlatform(bx + endX, bz + landZ, 1.3, 1.95, top);
        this._addStairColumn(columnGeo, stoneMat, bx + endX, bz + landZ, top - 0.4);
      } else {
        // Summit platform: the reward perch, with the long leap back down.
        const summit = new THREE.Mesh(topGeo, stoneMat);
        summit.position.set(bx + endX, top - 0.23, bz + landZ);
        summit.castShadow = true;
        summit.receiveShadow = true;
        this.scene.add(summit);
        this._stairMeshes.push(summit);
        registerPlatform(bx + endX, bz + landZ, 1.6, 1.6, top);
        this._addStairColumn(columnGeo, stoneMat, bx + endX, bz + landZ, top - 0.46);
        this.stairTopPoint = new THREE.Vector3(bx + endX, top, bz + landZ);
      }
    }

    // The impossible garnish: a mirrored flight hanging upside-down under
    // the middle row, ascending nowhere.
    for (let i = 0; i < PER_FLIGHT; i++) {
      const lx = PER_FLIGHT * STEP_PITCH - (i + 0.5) * STEP_PITCH;
      stepTransforms.push({
        x: bx + lx,
        y: h0 + (PER_FLIGHT + i) * STEP_RISE - 2.4,
        z: bz + 2.2,
        inverted: true
      });
    }

    const stairs = new THREE.InstancedMesh(stepGeo, stoneMat, stepTransforms.length);
    stairs.castShadow = true;
    stairs.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const flipped = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    const vec = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    stepTransforms.forEach((s, i) => {
      vec.set(s.x, s.y, s.z);
      matrix.compose(vec, s.inverted ? flipped : quat.identity(), one);
      stairs.setMatrixAt(i, matrix);
    });
    stairs.instanceMatrix.needsUpdate = true;
    this.scene.add(stairs);
    this.stairs = stairs;

    // Keep the roaming hazards clear of the folly.
    this.stairCenter = new THREE.Vector3(bx + 4.5, h0, bz + 2.2);
  }

  /** A stone pillar from the terrain up to a platform's underside. */
  _addStairColumn(columnGeo, stoneMat, x, z, topY) {
    const groundY = this.getHeight(x, z);
    const height = Math.max(topY - groundY, 1);
    const column = new THREE.Mesh(columnGeo, stoneMat);
    column.scale.y = height;
    column.position.set(x, groundY + height / 2, z);
    column.castShadow = true;
    this.scene.add(column);
    this._stairMeshes.push(column);
    this.colliders.push({ x, z, radius: 0.6, top: topY });
  }

  /* ================================================================ */
  /*  The golf flag                                                   */
  /* ================================================================ */

  /** Hole, pole and a red pennant that ripples in the wind shader. */
  _buildGolfFlag() {
    const holeGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 12);
    const holeMat = createToonMaterial({ color: 0x14120f });
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.3, 8);
    const poleMat = createToonMaterial({
      color: 0xf2f0e8,
      rim: { color: 0xffffff, strength: 0.4, threshold: 0.6 }
    });
    const flagMat = createToonMaterial({
      color: 0xd8362a,
      rim: { color: 0xff9a8a, strength: 0.4, threshold: 0.58 },
      sway: { strength: 0.1, speed: 3.2 }
    });
    flagMat.side = THREE.DoubleSide;

    // Triangular pennant with an aSway attribute so the tip flutters.
    const flagGeo = new THREE.BufferGeometry();
    const verts = new Float32Array([
      0, 0, 0,
      0, -0.34, 0,
      0.62, -0.17, 0
    ]);
    flagGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    flagGeo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array([0, 0, 1]), 1));
    flagGeo.computeVertexNormals();

    this._disposables.push(holeGeo, holeMat, poleGeo, poleMat, flagGeo, flagMat);

    const group = new THREE.Group();
    const y = this.greenLevel;
    group.position.set(this.greenCenterX, y, this.greenCenterZ);
    this.golfFlag = group;

    const hole = new THREE.Mesh(holeGeo, holeMat);
    hole.position.y = 0.01;
    group.add(hole);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.15;
    pole.castShadow = true;
    group.add(pole);
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(0.03, 2.22, 0);
    flag.rotation.y = this.rng.range(0, Math.PI * 2);
    group.add(flag);

    this.scene.add(group);
    this.colliders.push({ x: this.greenCenterX, z: this.greenCenterZ, radius: 0.12, top: y + 2.3 });
  }

  /* ================================================================ */
  /*  The cave (and its sandwich)                                     */
  /* ================================================================ */

  /**
   * A sunken grotto: the terrain itself digs a short tunnel below grade
   * (see the constructor and _caveDig), and this raises a low rock hood
   * over the chamber with a wide-open mouth, so a trailing third-person
   * camera can look straight down the ramp at the pedestal. Inside, under
   * a faint warm glow: a BLT. The game rules around it live in Game; the
   * world just provides the architecture and remembers where it is.
   */
  _buildCave() {
    const spot = new THREE.Vector3(this.caveX, this.caveLevel, this.caveZ);
    this.cavePos = spot.clone();
    const dirX = this.caveDirX; // mouth → back wall
    const dirZ = this.caveDirZ;

    const rockMat = createToonMaterial({
      color: 0x4a4550,
      rim: { color: 0x9d8fd4, strength: 0.35, threshold: 0.66 }
    });
    rockMat.side = THREE.DoubleSide;
    const pedestalMat = createToonMaterial({ color: 0x5f5964 });
    this._disposables.push(rockMat, pedestalMat);

    const cave = new THREE.Group();
    cave.position.copy(spot);
    this.caveMeshes = cave;

    // The hood: a squashed spherical shell with 120° of missing wall —
    // the mouth — whose rim dips below grade to meet the dug floor. Low
    // and open enough that the sandwich is visible from outside.
    const GAP = 2.1; // radians of open mouth
    const domeGeo = new THREE.SphereGeometry(5.0, 28, 16, GAP / 2, Math.PI * 2 - GAP, 0, Math.PI * 0.68);
    {
      // Roughen it so it reads as rock, not a geodesic observatory.
      const pos = domeGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const lump = 1 + this.detailNoise.noise(x * 0.7 + 31, z * 0.7 - y * 0.5) * 0.12;
        pos.setXYZ(i, x * lump, y * lump, z * lump);
      }
      domeGeo.computeVertexNormals();
    }
    this._disposables.push(domeGeo);
    const dome = new THREE.Mesh(domeGeo, rockMat);
    dome.scale.y = 0.62; // a low tunnel hood, not an observatory dome
    dome.castShadow = true;
    dome.receiveShadow = true;
    cave.add(dome);

    // Face the mouth back toward the map's heart (opposite the dig
    // direction). The geometry's gap is centered on local -X, so yaw
    // maps -X onto the mouth direction.
    const mouthX = -dirX;
    const mouthZ = -dirZ;
    cave.rotation.y = Math.atan2(mouthZ, -mouthX);

    // Pedestal + sandwich on the chamber floor, past the tunnel's midpoint.
    const inwardX = dirX * 1.2;
    const inwardZ = dirZ * 1.2;
    const floorY = this.getHeight(spot.x + inwardX, spot.z + inwardZ);
    const pedestalGeo = new THREE.CylinderGeometry(0.45, 0.55, 0.6, 10);
    this._disposables.push(pedestalGeo);
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.set(inwardX, floorY - spot.y + 0.3, inwardZ);
    pedestal.receiveShadow = true;
    cave.add(pedestal);

    const sandwich = this._buildSandwich();
    sandwich.position.set(inwardX, floorY - spot.y + 0.62, inwardZ);
    cave.add(sandwich);
    this.sandwichPos = new THREE.Vector3(
      spot.x + inwardX,
      floorY + 0.7,
      spot.z + inwardZ
    );

    // A warm shrine-glow so the BLT is discovered, not stumbled over.
    const glow = new THREE.PointLight(0xffc9a0, 3.0, 9, 2);
    glow.position.set(inwardX, floorY - spot.y + 1.7, inwardZ);
    cave.add(glow);

    this.scene.add(cave);

    // Solid walls: a collider ring with a gap where the mouth is.
    const mouthAngle = Math.atan2(mouthZ, mouthX);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      let delta = Math.abs(a - mouthAngle);
      if (delta > Math.PI) delta = Math.PI * 2 - delta;
      if (delta < 1.05) continue; // the doorway
      this.colliders.push({
        x: spot.x + Math.cos(a) * 4.3,
        z: spot.z + Math.sin(a) * 4.3,
        radius: 1.35,
        top: spot.y + 4
      });
    }
  }

  /** A modest BLT: bread, lettuce, tomato, bacon, bread. Too dry. */
  _buildSandwich() {
    const breadMat = createToonMaterial({ color: 0xe8c87a, rim: { color: 0xfff0d0, strength: 0.4, threshold: 0.6 } });
    const crustMat = createToonMaterial({ color: 0xb08948 });
    const lettuceMat = createToonMaterial({ color: 0x6fbf4a });
    const tomatoMat = createToonMaterial({ color: 0xd84838 });
    const baconMat = createToonMaterial({ color: 0x9c4434 });
    const breadGeo = new THREE.BoxGeometry(0.44, 0.09, 0.44);
    const lettuceGeo = new THREE.BoxGeometry(0.5, 0.03, 0.5);
    const tomatoGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.035, 12);
    const baconGeo = new THREE.BoxGeometry(0.46, 0.025, 0.14);
    this._disposables.push(breadMat, crustMat, lettuceMat, tomatoMat, baconMat, breadGeo, lettuceGeo, tomatoGeo, baconGeo);

    const s = new THREE.Group();
    const bottom = new THREE.Mesh(breadGeo, breadMat);
    bottom.position.y = 0.045;
    s.add(bottom);
    const lettuce = new THREE.Mesh(lettuceGeo, lettuceMat);
    lettuce.position.y = 0.1;
    lettuce.rotation.y = 0.1;
    s.add(lettuce);
    for (const [dx, dz] of [[-0.09, 0.05], [0.1, -0.06]]) {
      const tomato = new THREE.Mesh(tomatoGeo, tomatoMat);
      tomato.position.set(dx, 0.13, dz);
      s.add(tomato);
    }
    for (const [dz, rot] of [[-0.08, 0.12], [0.09, -0.15]]) {
      const bacon = new THREE.Mesh(baconGeo, baconMat);
      bacon.position.set(0, 0.165, dz);
      bacon.rotation.y = rot;
      s.add(bacon);
    }
    const top = new THREE.Mesh(breadGeo, crustMat);
    top.position.y = 0.225;
    top.rotation.y = 0.08;
    s.add(top);
    for (const mesh of s.children) mesh.castShadow = true;
    return s;
  }

  /* ================================================================ */
  /*  The cottage (and its appliances)                                */
  /* ================================================================ */

  /**
   * A little stone-and-timber cottage on a leveled yard, front door
   * facing the map's heart. Inside: an alarm clock on a table, a stove,
   * a fridge, and a Persian rug hiding a trap door that will not budge.
   * The roof lifts away (dollhouse-style) while someone is inside so
   * the camera can see the room. Interaction rules live in Game; the
   * world provides the architecture and remembers where everything is.
   */
  _buildCottage() {
    const spot = new THREE.Vector3(this.cottageX, this.cottageLevel, this.cottageZ);
    this.cottagePos = spot.clone();
    const yaw = Math.atan2(this.cottageDoorX, this.cottageDoorZ); // local +Z → door

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };
    const plasterMat = track(createToonMaterial({
      color: 0xd8cbb2,
      rim: { color: 0xffe9c8, strength: 0.3, threshold: 0.68 }
    }));
    plasterMat.side = THREE.DoubleSide; // walls read from indoors; gables are flat
    const timberMat = track(createToonMaterial({ color: 0x5c4330 }));
    const roofMat = track(createToonMaterial({
      color: 0x8a4a3c,
      rim: { color: 0xd88a6a, strength: 0.35, threshold: 0.64 }
    }));
    roofMat.side = THREE.DoubleSide;
    const floorMat = track(createToonMaterial({ color: 0x8a6a48 }));
    const darkWoodMat = track(createToonMaterial({ color: 0x4a3524 }));
    const applianceMat = track(createToonMaterial({ color: 0x3c4048 }));
    const fridgeMat = track(createToonMaterial({
      color: 0xe8e4da,
      rim: { color: 0xffffff, strength: 0.4, threshold: 0.6 }
    }));
    const brassMat = track(createToonMaterial({
      color: 0xd8a838,
      emissive: 0x604010,
      emissiveIntensity: 0.5,
      pulse: { speed: 3.0, phase: 0 }
    }));
    const paneMat = track(createToonMaterial({
      color: 0xffd98a,
      emissive: 0xff9c30,
      emissiveIntensity: 0.7
    }));
    const creamMat = track(createToonMaterial({ color: 0xf4efe0 }));
    const redMat = track(createToonMaterial({ color: 0xb03030 }));

    const cottage = new THREE.Group();
    cottage.position.copy(spot);
    cottage.rotation.y = yaw;
    this.cottageMeshes = cottage;

    const addBox = (w, h, d, mat, x, y, z, group = cottage) => {
      const geo = track(new THREE.BoxGeometry(w, h, d));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    // --- shell: floor, three-and-two-halves walls, glowing windows -------
    addBox(6.4, 0.1, 5.4, floorMat, 0, 0, 0);
    addBox(6.4, 2.5, 0.2, plasterMat, 0, 1.3, -2.6);               // back
    addBox(0.2, 2.5, 5.0, plasterMat, -3.1, 1.3, 0);               // left
    addBox(0.2, 2.5, 5.0, plasterMat, 3.1, 1.3, 0);                // right
    addBox(2.1, 2.5, 0.2, plasterMat, -2.15, 1.3, 2.6);            // front L
    addBox(2.1, 2.5, 0.2, plasterMat, 2.15, 1.3, 2.6);             // front R
    addBox(2.2, 0.45, 0.2, timberMat, 0, 2.325, 2.6);              // lintel
    addBox(0.3, 0.9, 1.1, paneMat, -3.1, 1.55, 0.6);               // windows
    addBox(0.3, 0.9, 1.1, paneMat, 3.1, 1.55, 0.6);
    // The door itself, swung wide in welcome.
    const doorPivot = new THREE.Group();
    doorPivot.position.set(-1.1, 1.15, 2.66);
    doorPivot.rotation.y = -2.1;
    cottage.add(doorPivot);
    addBox(1.0, 2.0, 0.08, darkWoodMat, 0.5, 0, 0, doorPivot);

    // --- roof: two slopes, two gables, a chimney — all in one group so
    // it can lift away while someone is inside.
    const roof = new THREE.Group();
    cottage.add(roof);
    this.cottageRoof = roof;
    const slope = Math.atan2(1.65, 3.5);
    for (const side of [-1, 1]) {
      const slab = addBox(3.95, 0.16, 6.3, roofMat, side * 1.75, 3.33, 0, roof);
      // Each slab's inner (ridge-ward) end tilts UP toward the apex.
      slab.rotation.z = -side * slope;
    }
    const gableShape = new THREE.Shape([
      new THREE.Vector2(-3.2, 2.5),
      new THREE.Vector2(3.2, 2.5),
      new THREE.Vector2(0, 4.15)
    ]);
    const gableGeo = track(new THREE.ShapeGeometry(gableShape));
    for (const z of [-2.5, 2.5]) {
      const gable = new THREE.Mesh(gableGeo, plasterMat);
      gable.position.z = z;
      gable.castShadow = true;
      roof.add(gable);
    }
    addBox(0.55, 1.6, 0.55, plasterMat, 1.9, 3.6, -1.2, roof);
    addBox(0.7, 0.12, 0.7, darkWoodMat, 1.9, 4.46, -1.2, roof);

    // Chimney smoke: a loop of puffs drifting up and dissolving. Each
    // puff owns its material so opacity can fade independently.
    const puffGeo = track(new THREE.SphereGeometry(0.16, 10, 8));
    this._smokePuffs = [];
    this._smokeTime = 0;
    for (let i = 0; i < 4; i++) {
      const puffMat = track(createToonMaterial({ color: 0xd8d2cc }));
      puffMat.transparent = true;
      puffMat.opacity = 0;
      puffMat.depthWrite = false;
      const puff = new THREE.Mesh(puffGeo, puffMat);
      roof.add(puff);
      this._smokePuffs.push({ mesh: puff, mat: puffMat, phase: i / 4 });
    }

    // --- furnishings -------------------------------------------------------
    // Bedside table + the two-bell alarm clock (the +20s prize).
    const table = new THREE.Group();
    table.position.set(-2.35, 0, -1.9);
    cottage.add(table);
    addBox(0.95, 0.07, 0.7, darkWoodMat, 0, 0.92, 0, table);
    for (const [lx, lz] of [[-0.4, -0.26], [0.4, -0.26], [-0.4, 0.26], [0.4, 0.26]]) {
      addBox(0.07, 0.9, 0.07, darkWoodMat, lx, 0.47, lz, table);
    }
    const clockGroup = new THREE.Group();
    clockGroup.position.set(-2.35, 1.14, -1.9);
    cottage.add(clockGroup);
    const clockBodyGeo = track(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 18));
    clockBodyGeo.rotateX(Math.PI / 2);
    const clockBody = new THREE.Mesh(clockBodyGeo, redMat);
    clockBody.position.y = 0.2;
    clockBody.castShadow = true;
    clockGroup.add(clockBody);
    const clockFaceGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18));
    clockFaceGeo.rotateX(Math.PI / 2);
    const clockFace = new THREE.Mesh(clockFaceGeo, creamMat);
    clockFace.position.set(0, 0.2, 0.075);
    clockGroup.add(clockFace);
    addBox(0.02, 0.1, 0.015, applianceMat, 0, 0.23, 0.085, clockGroup);  // minute hand
    addBox(0.07, 0.02, 0.015, applianceMat, 0.025, 0.2, 0.085, clockGroup); // hour hand
    const bellGeo = track(new THREE.SphereGeometry(0.07, 12, 8));
    for (const side of [-1, 1]) {
      const bell = new THREE.Mesh(bellGeo, brassMat);
      bell.position.set(side * 0.1, 0.38, 0);
      clockGroup.add(bell);
    }
    const clockLegGeo = track(new THREE.CylinderGeometry(0.014, 0.02, 0.1, 6));
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(clockLegGeo, applianceMat);
      leg.position.set(side * 0.12, 0.05, 0.03);
      clockGroup.add(leg);
    }

    // Stove against the back wall.
    addBox(1.05, 1.0, 0.85, applianceMat, 1.1, 0.55, -2.05);
    addBox(1.05, 0.06, 0.85, darkWoodMat, 1.1, 1.08, -2.05);
    const hobGeo = track(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 14));
    const hobMat = track(createToonMaterial({ color: 0x16161a }));
    for (const [hx, hz] of [[-0.24, -0.2], [0.24, -0.2], [-0.24, 0.2], [0.24, 0.2]]) {
      const hob = new THREE.Mesh(hobGeo, hobMat);
      hob.position.set(1.1 + hx, 1.125, -2.05 + hz);
      cottage.add(hob);
    }
    addBox(0.8, 0.5, 0.05, darkWoodMat, 1.1, 0.5, -1.6);   // oven door
    addBox(0.55, 0.05, 0.05, brassMat, 1.1, 0.68, -1.56);  // its handle

    // Fridge along the right wall, humming quietly.
    addBox(0.85, 1.7, 0.8, fridgeMat, 2.5, 0.9, -0.7);
    addBox(0.05, 0.55, 0.06, applianceMat, 2.06, 1.15, -0.45); // handle

    // The Persian rug — and, beneath it, the trap door.
    const trapdoor = addBox(1.15, 0.04, 1.15, darkWoodMat, 0.2, 0.05, 0.5);
    addBox(0.02, 0.045, 1.15, applianceMat, 0.02, 0.052, 0.5); // plank grooves
    addBox(0.02, 0.045, 1.15, applianceMat, 0.4, 0.052, 0.5);
    const ringGeo = track(new THREE.TorusGeometry(0.09, 0.014, 8, 16));
    ringGeo.rotateX(Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, applianceMat);
    ring.position.set(0.55, 0.075, 0.5);
    cottage.add(ring);
    this._trapdoorMesh = trapdoor;

    const rug = new THREE.Mesh(
      track(new THREE.BoxGeometry(1.9, 0.04, 1.35)),
      track(createToonMaterial({ map: track(this._makeRugTexture()) }))
    );
    rug.position.set(0.2, 0.09, 0.5);
    rug.receiveShadow = true;
    cottage.add(rug);
    this._rugMesh = rug;
    this._rugHome = rug.position.clone();
    this._rugSlid = false;

    // Warm hearth-light so the room reads at twilight.
    const lamp = new THREE.PointLight(0xffd9a8, 2.4, 10, 2);
    lamp.position.set(0, 2.1, 0);
    cottage.add(lamp);

    this.scene.add(cottage);

    // --- interaction points (world space) ---------------------------------
    const toWorld = (lx, ly, lz) =>
      new THREE.Vector3(lx, ly, lz).applyQuaternion(cottage.quaternion).add(spot);
    this.cottage = {
      clock: toWorld(-2.35, 1.2, -1.9),
      stove: toWorld(1.1, 0.9, -2.05),
      fridge: toWorld(2.5, 0.9, -0.7),
      trapdoor: toWorld(0.2, 0.4, 0.5)
    };

    // --- colliders: walls (sparing the doorway) and the big furniture -----
    const pushWall = (lx, lz) => {
      const p = toWorld(lx, 0, lz);
      this.colliders.push({ x: p.x, z: p.z, radius: 0.35, top: spot.y + 2.6 });
    };
    for (let x = -2.8; x <= 2.81; x += 0.7) pushWall(x, -2.6);   // back
    for (let z = -2.4; z <= 2.41; z += 0.685) {                   // sides
      pushWall(-3.1, z);
      pushWall(3.1, z);
    }
    for (const s of [-1, 1]) {                                    // front, minus door
      pushWall(s * 1.5, 2.6);
      pushWall(s * 2.2, 2.6);
      pushWall(s * 2.9, 2.6);
    }
    const stoveP = toWorld(1.1, 0, -2.05);
    this.colliders.push({ x: stoveP.x, z: stoveP.z, radius: 0.55, top: spot.y + 1.2 });
    const fridgeP = toWorld(2.5, 0, -0.7);
    this.colliders.push({ x: fridgeP.x, z: fridgeP.z, radius: 0.5, top: spot.y + 1.8 });
    const tableP = toWorld(-2.35, 0, -1.9);
    this.colliders.push({ x: tableP.x, z: tableP.z, radius: 0.42, top: spot.y + 1.1 });
  }

  /** The rug slides aside (first pull), revealing the trap door. */
  slideRug() {
    if (!this._rugMesh || this._rugSlid) return;
    this._rugSlid = true;
    this._rugMesh.position.set(this._rugHome.x + 1.15, this._rugHome.y, this._rugHome.z + 0.75);
    this._rugMesh.rotation.y = 0.38;
  }

  /** Housekeeping between runs: the rug goes back where it was. */
  resetRug() {
    if (!this._rugMesh) return;
    this._rugSlid = false;
    this._rugMesh.position.copy(this._rugHome);
    this._rugMesh.rotation.y = 0;
  }

  /** A small hand-drawn Persian rug: crimson field, navy border, medallion. */
  _makeRugTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 192;
    const g = canvas.getContext('2d');
    g.fillStyle = '#8e2434';
    g.fillRect(0, 0, 256, 192);
    g.strokeStyle = '#2c3a6e';
    g.lineWidth = 14;
    g.strokeRect(10, 10, 236, 172);
    g.strokeStyle = '#e8d8a8';
    g.lineWidth = 3;
    g.strokeRect(22, 22, 212, 148);
    // Central medallion.
    g.save();
    g.translate(128, 96);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#2c3a6e';
    g.fillRect(-34, -34, 68, 68);
    g.fillStyle = '#e8d8a8';
    g.fillRect(-20, -20, 40, 40);
    g.fillStyle = '#8e2434';
    g.fillRect(-9, -9, 18, 18);
    g.restore();
    // Corner motifs.
    g.fillStyle = '#e8d8a8';
    for (const [cx, cy] of [[40, 40], [216, 40], [40, 152], [216, 152]]) {
      g.beginPath();
      g.arc(cx, cy, 8, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ================================================================ */
  /*  Coral                                                           */
  /* ================================================================ */

  /** A fan of coral on the lake bed — scenery for whoever can sink. */
  _buildCoral() {
    const a = 0.9;
    const cx = this.lakeCenterX + Math.cos(a) * this.lakeRadius * 0.4;
    const cz = this.lakeCenterZ + Math.sin(a) * this.lakeRadius * 0.4;
    const cy = this.getHeight(cx, cz);
    this.coralPos = new THREE.Vector3(cx, cy, cz);

    const track = (r) => {
      this._disposables.push(r);
      return r;
    };
    const coralMat = track(createToonMaterial({
      color: 0xff7a59,
      emissive: 0x8a2a10,
      emissiveIntensity: 0.7,
      rim: { color: 0xffc0a8, strength: 0.55, threshold: 0.55 }
    }));
    const brainMat = track(createToonMaterial({
      color: 0xe8637a,
      emissive: 0x40101c,
      emissiveIntensity: 0.4,
      rim: { color: 0xffb0c0, strength: 0.5, threshold: 0.58 }
    }));

    const coral = new THREE.Group();
    coral.position.set(cx, cy, cz);
    coral.scale.setScalar(1.6); // it's dark down there — let it read
    this.coralMeshes = coral;

    // Fan of tapering fingers.
    const fingerGeo = track(new THREE.CylinderGeometry(0.05, 0.16, 1, 8));
    fingerGeo.translate(0, 0.5, 0);
    for (let i = 0; i < 7; i++) {
      const finger = new THREE.Mesh(fingerGeo, coralMat);
      const spin = (i / 7) * Math.PI * 2 + 0.4;
      finger.rotation.y = spin;
      finger.rotation.x = 0.3 + (i % 3) * 0.16;
      finger.scale.setScalar(0.8 + ((i * 37) % 5) * 0.16);
      finger.position.set(Math.cos(spin) * 0.18, 0.05, Math.sin(spin) * 0.18);
      coral.add(finger);
    }
    // A brain-coral boulder alongside.
    const brainGeo = track(new THREE.SphereGeometry(0.5, 16, 12));
    {
      const pos = brainGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const lump = 1 + this.detailNoise.noise(x * 4.1 + 7, z * 4.1 - y * 2.2) * 0.1;
        pos.setXYZ(i, x * lump, y * lump, z * lump);
      }
      brainGeo.computeVertexNormals();
    }
    const brain = new THREE.Mesh(brainGeo, brainMat);
    brain.position.set(0.85, 0.28, -0.3);
    brain.scale.y = 0.75;
    coral.add(brain);

    this.scene.add(coral);
  }

  /* ================================================================ */
  /*  Lifecycle                                                       */
  /* ================================================================ */

  dispose() {
    for (const obj of [this.terrain, this.trunks, this.branches, this.canopies, this.rocks, this.grass, this.sky, this.stairs, this.water]) {
      if (obj && obj.parent) obj.parent.remove(obj);
      if (obj && obj.isInstancedMesh) obj.dispose();
    }
    if (this.lakeSign) this.scene.remove(this.lakeSign);
    if (this.blossomMeshes) this.scene.remove(this.blossomMeshes);
    if (this.caveMeshes) this.scene.remove(this.caveMeshes);
    if (this.cottageMeshes) this.scene.remove(this.cottageMeshes);
    if (this.coralMeshes) this.scene.remove(this.coralMeshes);
    if (this.golfFlag) this.scene.remove(this.golfFlag);
    if (this.blossomAura) {
      this.blossomAura.geometry.dispose();
      this.blossomAura.material.dispose();
    }
    if (this._stairMeshes) {
      for (const mesh of this._stairMeshes) this.scene.remove(mesh);
      this._stairMeshes.length = 0;
    }
    this.platforms.length = 0;
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
