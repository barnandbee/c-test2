/**
 * Bloom.js — a compact, self-contained bloom pass.
 *
 * Three's own UnrealBloomPass lives in the addons, which aren't part of the
 * vendored core build, and it runs five mip levels — more than this art style
 * needs and more than a phone wants. This is a three-pass version instead:
 *
 *   1. bright-pass + downsample  (scene -> quarter-res, soft-knee threshold)
 *   2. separable Gaussian blur   (horizontal, then vertical, at quarter-res)
 *   3. composite                 (scene + bloom * strength -> canvas)
 *
 * At quarter resolution the blur touches 1/16 of the pixels, so the whole
 * thing costs roughly one extra fullscreen pass rather than six.
 *
 * The scene is rendered into a linear render target with tone mapping already
 * applied, so the composite is the only place that converts to the output
 * colour space — hence the <colorspace_fragment> include at the end of it.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Soft-knee threshold, so bright things ramp into the glow instead of
// popping in the moment they cross the line.
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tScene, vUv ).rgb;
  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float contribution = smoothstep( uThreshold, uThreshold + uKnee, lum );
  gl_FragColor = vec4( c * contribution, 1.0 );
}
`;

// Nine-tap Gaussian, run once per axis.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uDirection;   // texel-sized step along one axis
varying vec2 vUv;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621;
  w[3] = 0.054054; w[4] = 0.016216;
  vec3 sum = texture2D( tSource, vUv ).rgb * w[0];
  for ( int i = 1; i < 5; i++ ) {
    vec2 offset = uDirection * float( i );
    sum += texture2D( tSource, vUv + offset ).rgb * w[i];
    sum += texture2D( tSource, vUv - offset ).rgb * w[i];
  }
  gl_FragColor = vec4( sum, 1.0 );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 scene = texture2D( tScene, vUv ).rgb;
  vec3 bloom = texture2D( tBloom, vUv ).rgb;
  gl_FragColor = vec4( scene + bloom * uStrength, 1.0 );
  #include <colorspace_fragment>
}
`;

export class BloomPass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ strength?: number, threshold?: number, knee?: number, scale?: number }} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    // Defaults tuned against the tone-mapped image: ACES asymptotes toward
    // 1.0, so a threshold much below ~0.85 starts blooming lit grass and sky
    // and washes the contrast out, while much above ~1.0 catches nothing.
    this.strength = opts.strength !== undefined ? opts.strength : 0.65;
    this.scale = opts.scale !== undefined ? opts.scale : 0.25; // quarter-res blur

    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,   // headroom above 1.0 so highlights bloom
      depthBuffer: true,
      colorSpace: THREE.NoColorSpace // stay linear until the composite
    };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const blurOpts = Object.assign({}, rtOpts, { depthBuffer: false });
    this.blurA = new THREE.WebGLRenderTarget(1, 1, blurOpts);
    this.blurB = new THREE.WebGLRenderTarget(1, 1, blurOpts);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        uThreshold: { value: opts.threshold !== undefined ? opts.threshold : 0.9 },
        uKnee: { value: opts.knee !== undefined ? opts.knee : 0.35 }
      },
      depthTest: false,
      depthWrite: false
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tSource: { value: null }, uDirection: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tBloom: { value: this.blurB.texture },
        uStrength: { value: this.strength }
      },
      depthTest: false,
      depthWrite: false
    });

    // One fullscreen triangle-ish quad, reused by every pass.
    this._quadGeo = new THREE.PlaneGeometry(2, 2);
    this._quad = new THREE.Mesh(this._quadGeo, this.brightMat);
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(width, height, pixelRatio) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneTarget.setSize(w, h);
    const bw = Math.max(1, Math.floor(w * this.scale));
    const bh = Math.max(1, Math.floor(h * this.scale));
    this.blurA.setSize(bw, bh);
    this.blurB.setSize(bw, bh);
    this._blurW = bw;
    this._blurH = bh;
  }

  setStrength(value) {
    this.strength = value;
    this.compositeMat.uniforms.uStrength.value = value;
  }

  _drawQuad(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCamera);
  }

  /** Render the scene through the bloom chain and out to the canvas. */
  render(scene, camera) {
    const r = this.renderer;

    // 1. the scene itself, into a linear target (tone mapping applied here)
    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    // 2. bright-pass straight into the quarter-res target
    this._drawQuad(this.brightMat, this.blurA);

    // 3. separable blur: horizontal into B, vertical back into... B again via A
    this.blurMat.uniforms.tSource.value = this.blurA.texture;
    this.blurMat.uniforms.uDirection.value.set(1 / this._blurW, 0);
    this._drawQuad(this.blurMat, this.blurB);

    this.blurMat.uniforms.tSource.value = this.blurB.texture;
    this.blurMat.uniforms.uDirection.value.set(0, 1 / this._blurH);
    this._drawQuad(this.blurMat, this.blurA);

    // 4. composite to the canvas
    this.compositeMat.uniforms.tBloom.value = this.blurA.texture;
    this._drawQuad(this.compositeMat, null);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this._quadGeo.dispose();
  }
}
