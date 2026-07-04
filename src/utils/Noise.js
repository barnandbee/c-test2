/**
 * Noise.js — Deterministic 2D simplex noise + fractal helpers.
 *
 * The terrain collision system samples the SAME analytic functions used to
 * displace the terrain mesh, so the noise must be seedable and allocation-free
 * per sample.
 */

class SeededRandom {
  constructor(seed = 1337) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Mulberry32 — fast, decent-quality 32-bit PRNG. Returns [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.next() * (max - min);
  }
}

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 1, 0, -1, 0,
  0, 1, 0, -1, 0, 1, 0, -1,
]);

const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

class SimplexNoise2D {
  constructor(seed = 1337) {
    const rng = new SeededRandom(seed);
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);

    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle driven by the seeded PRNG.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Classic 2D simplex noise. Returns roughly [-1, 1]. */
  noise(xin, yin) {
    const { perm, permMod12 } = this;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[gi0] * x0 + GRAD2[gi0 + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[gi1] * x1 + GRAD2[gi1 + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[gi2] * x2 + GRAD2[gi2 + 1] * y2);
    }

    // Scale to fit [-1, 1].
    return 70.14805770653952 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion. Returns roughly [-1, 1]. */
  fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amplitude = 1.0;
    let frequency = 1.0;
    let sum = 0.0;
    let norm = 0.0;
    for (let o = 0; o < octaves; o++) {
      sum += amplitude * this.noise(x * frequency, y * frequency);
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — sharp crests, good for cliff bands. [0, 1]. */
  ridged(x, y, octaves = 3, lacunarity = 2.1, gain = 0.5) {
    let amplitude = 0.5;
    let frequency = 1.0;
    let sum = 0.0;
    let norm = 0.0;
    for (let o = 0; o < octaves; o++) {
      sum += amplitude * (1.0 - Math.abs(this.noise(x * frequency, y * frequency)));
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }
}

export { SimplexNoise2D, SeededRandom };
