/**
 * Weather.js — the sky's mood for a run.
 *
 * Rolled once when a run starts and then left alone: the forest is usually
 * lovely, but occasionally it rains, storms or snows. Each kind grades the
 * whole scene — fog colour and density, the hemisphere bounce, the sun, the
 * sky tint — and hangs a precipitation column over the player.
 *
 * The precipitation is a single Points object with every particle's motion
 * derived analytically in the vertex shader (see createPrecipMaterial), so
 * it's one draw call and no per-frame CPU regardless of particle count.
 *
 * Storms additionally throw lightning: a brief scene-wide flash on the lights
 * and sky, with thunder following at the speed of sound-ish.
 */

import * as THREE from 'three';
import { createPrecipMaterial } from './Shaders.js';

/**
 * The forecast. Weights are probabilities and must leave the remainder to
 * 'clear' — the lovely default the game has always had.
 */
export const WEATHER_ODDS = [
  { kind: 'rain', chance: 0.10 },
  { kind: 'storm', chance: 0.05 },
  { kind: 'snow', chance: 0.05 }
];

/**
 * Per-kind grading. `clear` holds the game's original values, so switching
 * back to it restores the look exactly rather than approximately.
 */
const PRESETS = {
  clear: {
    label: null,
    fogColor: 0x86597a, fogDensity: 0.0115,
    hemiIntensity: 0.95, sunIntensity: 2.05,
    skyTint: 0x000000, skyTintAmount: 0,
    particles: 0
  },
  rain: {
    label: '🌧️ RAIN',
    fogColor: 0x6a5f75, fogDensity: 0.020,
    hemiIntensity: 0.72, sunIntensity: 1.20,
    skyTint: 0x4a4458, skyTintAmount: 0.42,
    particles: 2400,
    precip: { fall: 30, drift: 0.35, slant: 0.16, size: 26, streak: 1,
              opacity: 0.42, color: 0xb8c8dc }
  },
  storm: {
    label: '⛈️ STORM',
    fogColor: 0x453f52, fogDensity: 0.030,
    hemiIntensity: 0.50, sunIntensity: 0.75,
    skyTint: 0x2a2634, skyTintAmount: 0.66,
    particles: 3600,
    precip: { fall: 40, drift: 0.5, slant: 0.34, size: 30, streak: 1,
              opacity: 0.5, color: 0xaab8cc }
  },
  snow: {
    label: '❄️ SNOW',
    fogColor: 0x9aa2bb, fogDensity: 0.017,
    hemiIntensity: 1.05, sunIntensity: 1.45,
    skyTint: 0x8fa0c0, skyTintAmount: 0.34,
    particles: 1700,
    precip: { fall: 3.6, drift: 2.2, slant: 0.05, size: 13, streak: 0,
              opacity: 0.8, color: 0xf2f6ff }
  }
};

export class Weather {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./World.js').World} world
   * @param {import('./Audio.js').Audio} audio
   */
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.kind = 'clear';
    this.points = null;
    this.material = null;
    this._flash = 0;        // current lightning brightness, 0..1
    this._nextBolt = 0;     // seconds until the next one
    this._thunderIn = -1;   // seconds until the thunder for the last bolt

    // The pristine values, captured before anything is graded, so 'clear'
    // restores the original look byte for byte.
    this._base = {
      fogColor: world.scene.fog.color.clone(),
      fogDensity: world.scene.fog.density,
      hemiIntensity: world.hemiLight.intensity,
      sunIntensity: world.sun.intensity
    };
  }

  /** Roll the forecast: mostly lovely, occasionally not. */
  static roll() {
    const r = Math.random();
    let acc = 0;
    for (const { kind, chance } of WEATHER_ODDS) {
      acc += chance;
      if (r < acc) return kind;
    }
    return 'clear';
  }

  /** Apply a weather kind, building or tearing down precipitation as needed. */
  set(kind) {
    const preset = PRESETS[kind] || PRESETS.clear;
    this.kind = PRESETS[kind] ? kind : 'clear';
    this._disposePoints();

    // Grade the atmosphere.
    const fog = this.world.scene.fog;
    if (this.kind === 'clear') {
      fog.color.copy(this._base.fogColor);
      fog.density = this._base.fogDensity;
      this.world.hemiLight.intensity = this._base.hemiIntensity;
      this.world.sun.intensity = this._base.sunIntensity;
    } else {
      fog.color.setHex(preset.fogColor);
      fog.density = preset.fogDensity;
      this.world.hemiLight.intensity = preset.hemiIntensity;
      this.world.sun.intensity = preset.sunIntensity;
    }
    this._applySkyTint(preset);

    if (preset.particles > 0) this._buildPoints(preset);
    this._flash = 0;
    this._nextBolt = this.kind === 'storm' ? 2 + Math.random() * 5 : -1;
    this._thunderIn = -1;
    if (this.audio) this.audio.setWeatherBed(this.kind);
    return this.kind;
  }

  /** Overcast weather washes the sunset toward slate. */
  _applySkyTint(preset) {
    const sky = this.world.sky && this.world.sky.material;
    if (!sky || !sky.uniforms) return;
    if (!this._skyBase) {
      this._skyBase = {
        horizon: sky.uniforms.uHorizonColor.value.clone(),
        mid: sky.uniforms.uMidColor.value.clone(),
        zenith: sky.uniforms.uZenithColor.value.clone()
      };
    }
    const tint = new THREE.Color(preset.skyTint);
    const t = preset.skyTintAmount;
    sky.uniforms.uHorizonColor.value.copy(this._skyBase.horizon).lerp(tint, t);
    sky.uniforms.uMidColor.value.copy(this._skyBase.mid).lerp(tint, t);
    sky.uniforms.uZenithColor.value.copy(this._skyBase.zenith).lerp(tint, t);
  }

  _buildPoints(preset) {
    const count = preset.particles;
    const geo = new THREE.BufferGeometry();
    // Position is unused by the shader (everything comes from aSeed), but
    // three needs one to size the draw.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = Math.random();
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    // The box is always around the player, so it must never be culled out.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = createPrecipMaterial(preset.precip);
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.scene.add(this.points);
    this._geo = geo;
  }

  _disposePoints() {
    if (this.points) this.scene.remove(this.points);
    if (this._geo) this._geo.dispose();
    if (this.material) this.material.dispose();
    this.points = null;
    this.material = null;
    this._geo = null;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} focus  the player's position
   */
  update(dt, focus) {
    if (this.points) {
      this.points.position.copy(focus);
      this.material.uniforms.uOrigin.value.copy(focus);
    }
    if (this.kind === 'storm') this._updateLightning(dt);
  }

  _updateLightning(dt) {
    // Decay the current flash.
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 4.5);
      this._applyFlash();
    }
    // Thunder trails the bolt.
    if (this._thunderIn > 0) {
      this._thunderIn -= dt;
      if (this._thunderIn <= 0) {
        this._thunderIn = -1;
        if (this.audio) this.audio.play('thunder');
      }
    }
    this._nextBolt -= dt;
    if (this._nextBolt <= 0) {
      this._flash = 1;
      this._applyFlash();
      // Distant bolts rumble later, and there's always another coming.
      this._thunderIn = 0.35 + Math.random() * 1.9;
      this._nextBolt = 5 + Math.random() * 11;
    }
  }

  /** A bolt briefly lifts the whole scene, then falls back to the storm grade. */
  _applyFlash() {
    const p = PRESETS.storm;
    const f = this._flash * this._flash; // sharper attack than a linear fade
    this.world.hemiLight.intensity = p.hemiIntensity + f * 2.6;
    this.world.sun.intensity = p.sunIntensity + f * 1.8;
  }

  /** Human-readable label for the run-start toast, or null when clear. */
  get label() {
    return (PRESETS[this.kind] || PRESETS.clear).label;
  }

  dispose() {
    this._disposePoints();
  }
}
