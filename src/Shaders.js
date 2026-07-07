/**
 * Shaders.js — All custom GLSL for the game.
 *
 * Strategy: lit surfaces build on THREE.MeshToonMaterial so they keep full
 * shadow-map, instancing and vertex-color support, then get surgically
 * patched via onBeforeCompile with shared #ifdef-gated chunks:
 *
 *   USE_RIM    — crisp fresnel rim light (the cel-shaded "pop")
 *   USE_SWAY   — wind vertex animation driven by an `aSway` attribute
 *   USE_PULSE  — emissive glow pulse (pine cones)
 *
 * Every patched material also swaps three's stock fog for an EXPONENTIAL
 * HEIGHT FOG: density decays with world-space altitude, so valleys drown in
 * twilight haze while hilltops stay clear.
 *
 * Unlit effects (sky dome, particle systems) are raw ShaderMaterials.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/*  Shared uniforms — one object, referenced by every patched shader   */
/* ------------------------------------------------------------------ */

export const SharedUniforms = {
  uTime: { value: 0 },
  uFogBase: { value: 1.0 },          // world Y where fog is thickest
  uFogHeightFalloff: { value: 0.10 } // how fast fog thins with altitude
};

export function updateSharedTime(dt) {
  SharedUniforms.uTime.value += dt;
}

/* ------------------------------------------------------------------ */
/*  GLSL chunks                                                        */
/* ------------------------------------------------------------------ */

const VERTEX_PARS = /* glsl */ `
uniform float uTime;
varying vec3 vHFWorldPos;
#ifdef USE_SWAY
  attribute float aSway;
  uniform float uSwayStrength;
  uniform float uSwaySpeed;
#endif
`;

const VERTEX_SWAY = /* glsl */ `
#include <begin_vertex>
#ifdef USE_SWAY
  {
    vec3 swayRef = vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
    #ifdef USE_INSTANCING
      swayRef += vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
    #endif
    float swayPhase = swayRef.x * 0.37 + swayRef.z * 0.51;
    vec3 swayOffset = vec3(
      sin( uTime * uSwaySpeed + swayPhase ),
      0.35 * sin( uTime * uSwaySpeed * 1.31 + swayPhase * 1.7 ),
      cos( uTime * uSwaySpeed * 0.83 + swayPhase + 1.9 )
    );
    transformed += swayOffset * ( uSwayStrength * aSway );
  }
#endif
`;

const VERTEX_WORLDPOS = /* glsl */ `
#include <worldpos_vertex>
{
  vec4 hfPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    hfPos = instanceMatrix * hfPos;
  #endif
  vHFWorldPos = ( modelMatrix * hfPos ).xyz;
}
`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uTime;
uniform float uFogBase;
uniform float uFogHeightFalloff;
varying vec3 vHFWorldPos;
#ifdef USE_RIM
  uniform vec3 uRimColor;
  uniform float uRimStrength;
  uniform float uRimThreshold;
#endif
#ifdef USE_PULSE
  uniform float uPulseSpeed;
  uniform float uPulsePhase;
#endif
`;

const FRAGMENT_PULSE = /* glsl */ `
#include <emissivemap_fragment>
#ifdef USE_PULSE
  {
    // World-position term dephases the pulse so cones don't blink in sync.
    float pulseWave = sin( uTime * uPulseSpeed + uPulsePhase + vHFWorldPos.x * 0.9 + vHFWorldPos.z * 0.7 );
    totalEmissiveRadiance *= 0.45 + 0.85 * ( 0.5 + 0.5 * pulseWave );
  }
#endif
`;

const FRAGMENT_RIM = /* glsl */ `
#ifdef USE_RIM
{
  vec3 rimViewDir = normalize( vViewPosition );
  float rimNdotV = 1.0 - saturate( dot( normal, rimViewDir ) );
  float rim = smoothstep( uRimThreshold - 0.035, uRimThreshold + 0.035, rimNdotV );
  outgoingLight += uRimColor * ( rim * uRimStrength );
}
#endif
#include <opaque_fragment>
`;

// Exponential height fog: classic exp2 distance term, attenuated by an
// exponential falloff on the fragment's altitude above uFogBase.
const FRAGMENT_HEIGHT_FOG = /* glsl */ `
#ifdef USE_FOG
{
  float hfDist = length( vHFWorldPos - cameraPosition );
  float hfHeight = max( vHFWorldPos.y - uFogBase, 0.0 );
  float hfAtten = exp( -hfHeight * uFogHeightFalloff );
  #ifdef FOG_EXP2
    float hfFactor = 1.0 - exp( -fogDensity * fogDensity * hfDist * hfDist );
  #else
    float hfFactor = smoothstep( fogNear, fogFar, hfDist );
  #endif
  hfFactor *= mix( 0.18, 1.0, hfAtten );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( hfFactor, 0.0, 1.0 ) );
}
#endif
`;

/* ------------------------------------------------------------------ */
/*  Material patcher                                                   */
/* ------------------------------------------------------------------ */

/**
 * Injects the shared chunks into any built-in material. Which features are
 * active is decided purely by material.defines, so three's program cache
 * (which keys on defines) compiles exactly one program per variant.
 */
function patchMaterial(material, extraUniforms = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = SharedUniforms.uTime;
    shader.uniforms.uFogBase = SharedUniforms.uFogBase;
    shader.uniforms.uFogHeightFalloff = SharedUniforms.uFogHeightFalloff;
    for (const key of Object.keys(extraUniforms)) {
      shader.uniforms[key] = extraUniforms[key];
    }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERTEX_PARS)
      .replace('#include <begin_vertex>', VERTEX_SWAY)
      .replace('#include <worldpos_vertex>', VERTEX_WORLDPOS);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_PARS)
      .replace('#include <emissivemap_fragment>', FRAGMENT_PULSE)
      .replace('#include <opaque_fragment>', FRAGMENT_RIM)
      .replace('#include <fog_fragment>', FRAGMENT_HEIGHT_FOG);
  };
  material.customProgramCacheKey = () =>
    'mystic|' + material.type + '|' + Object.keys(material.defines || {}).sort().join(',');
  return material;
}

/* ------------------------------------------------------------------ */
/*  Toon gradient map — the "three tones"                              */
/* ------------------------------------------------------------------ */

let gradientMapCache = null;

export function getThreeToneGradientMap() {
  if (gradientMapCache) return gradientMapCache;
  // Three discrete luminance steps: deep shadow / mid tone / full light.
  const data = new Uint8Array([96, 176, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  gradientMapCache = tex;
  return tex;
}

/* ------------------------------------------------------------------ */
/*  Lit material factories                                             */
/* ------------------------------------------------------------------ */

/**
 * Three-toned cel material with optional crisp rim light, wind sway and
 * emissive pulse. Fully compatible with shadows, instancing, vertex colors.
 *
 * opts: {
 *   color, vertexColors, map, emissive, emissiveIntensity,
 *   rim:   { color, strength, threshold },
 *   sway:  { strength, speed },
 *   pulse: { speed, phase },
 * }
 */
export function createToonMaterial(opts = {}) {
  const material = new THREE.MeshToonMaterial({
    color: opts.color !== undefined ? opts.color : 0xffffff,
    gradientMap: getThreeToneGradientMap(),
    vertexColors: Boolean(opts.vertexColors),
    map: opts.map || null,
    emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
    emissiveMap: opts.emissiveMap || null,
    emissiveIntensity: opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1,
    fog: true
  });

  material.defines = material.defines || {};
  const extraUniforms = {};

  if (opts.rim) {
    material.defines.USE_RIM = '';
    extraUniforms.uRimColor = { value: new THREE.Color(opts.rim.color !== undefined ? opts.rim.color : 0xbfd7ff) };
    extraUniforms.uRimStrength = { value: opts.rim.strength !== undefined ? opts.rim.strength : 0.65 };
    extraUniforms.uRimThreshold = { value: opts.rim.threshold !== undefined ? opts.rim.threshold : 0.62 };
  }
  if (opts.sway) {
    material.defines.USE_SWAY = '';
    extraUniforms.uSwayStrength = { value: opts.sway.strength !== undefined ? opts.sway.strength : 0.12 };
    extraUniforms.uSwaySpeed = { value: opts.sway.speed !== undefined ? opts.sway.speed : 1.4 };
  }
  if (opts.pulse) {
    material.defines.USE_PULSE = '';
    extraUniforms.uPulseSpeed = { value: opts.pulse.speed !== undefined ? opts.pulse.speed : 3.0 };
    extraUniforms.uPulsePhase = { value: opts.pulse.phase !== undefined ? opts.pulse.phase : 0.0 };
  }

  return patchMaterial(material, extraUniforms);
}

/** Standard PBR material (gold eggs) that still receives the height fog. */
export function createFoggedStandardMaterial(params = {}) {
  const material = new THREE.MeshStandardMaterial(params);
  material.defines = material.defines || {};
  return patchMaterial(material, {});
}

/* ------------------------------------------------------------------ */
/*  Sky dome                                                           */
/* ------------------------------------------------------------------ */

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'TwilightSky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: SharedUniforms.uTime,
      uHorizonColor: { value: new THREE.Color(0xff9560) },
      uMidColor: { value: new THREE.Color(0x84518c) },
      uZenithColor: { value: new THREE.Color(0x1f1a48) },
      uSunDirection: { value: new THREE.Vector3(-0.55, 0.18, -0.75).normalize() },
      uSunColor: { value: new THREE.Color(0xffcf8a) }
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize( position );
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uHorizonColor;
      uniform vec3 uMidColor;
      uniform vec3 uZenithColor;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      varying vec3 vDir;

      float hash21( vec2 p ) {
        p = fract( p * vec2( 234.34, 435.345 ) );
        p += dot( p, p + 34.23 );
        return fract( p.x * p.y );
      }

      void main() {
        vec3 dir = normalize( vDir );
        float h = clamp( dir.y, -0.15, 1.0 );

        // Twilight gradient: warm horizon -> dusky magenta -> deep indigo.
        vec3 col = mix( uHorizonColor, uMidColor, smoothstep( -0.05, 0.28, h ) );
        col = mix( col, uZenithColor, smoothstep( 0.18, 0.75, h ) );

        // Low sun glow bleeding through the trees.
        float sunAmount = max( dot( dir, uSunDirection ), 0.0 );
        col += uSunColor * pow( sunAmount, 42.0 ) * 1.4;
        col += uSunColor * pow( sunAmount, 6.0 ) * 0.25;

        // Sparse twinkling stars fading in toward the zenith.
        vec2 grid = dir.xz / max( dir.y, 0.08 ) * 28.0;
        vec2 cell = floor( grid );
        float star = hash21( cell );
        float starMask = step( 0.985, star );
        vec2 local = fract( grid ) - 0.5;
        float starDot = smoothstep( 0.12, 0.0, length( local ) );
        float twinkle = 0.6 + 0.4 * sin( uTime * 2.2 + star * 31.4 );
        col += vec3( 0.85, 0.88, 1.0 ) * starMask * starDot * twinkle
             * smoothstep( 0.25, 0.65, h );

        gl_FragColor = vec4( col, 1.0 );
      }
    `
  });
}

/* ------------------------------------------------------------------ */
/*  Lake water                                                         */
/* ------------------------------------------------------------------ */

/**
 * Gently rippling translucent lake surface: vertex waves, drifting
 * shimmer flecks, edge foam and a depth gradient toward the middle.
 * Standard exp2 fog is applied manually (the lake sits at fog altitude
 * anyway, so the height term would be saturated).
 */
export function createWaterMaterial() {
  return new THREE.ShaderMaterial({
    name: 'LakeWater',
    transparent: true,
    side: THREE.DoubleSide, // readable from the lake bed looking up, too
    depthWrite: false,
    fog: true, // lets the renderer feed fogColor/fogDensity from scene.fog
    uniforms: {
      uTime: SharedUniforms.uTime,
      uShallow: { value: new THREE.Color(0x4a9ec4) },
      uDeep: { value: new THREE.Color(0x1b4a72) },
      uFoam: { value: new THREE.Color(0xd8ecec) },
      fogColor: { value: new THREE.Color(0x86597a) },
      fogDensity: { value: 0.0115 }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vFogDepth;
      varying float vWave;
      void main() {
        vUv = uv;
        vec3 p = position;
        float w1 = sin( p.x * 0.55 + uTime * 1.1 );
        float w2 = cos( p.z * 0.65 + uTime * 0.8 );
        p.y += ( w1 + w2 ) * 0.05;
        vWave = w1 * w2;
        vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
        vFogDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uFoam;
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying vec2 vUv;
      varying float vFogDepth;
      varying float vWave;
      void main() {
        float r = length( vUv - 0.5 ) * 2.0;
        vec3 col = mix( uDeep, uShallow, smoothstep( 0.35, 1.0, r ) );
        // Drifting sparkle flecks.
        float shimmer = sin( vUv.x * 62.0 + uTime * 1.4 ) * sin( vUv.y * 57.0 - uTime * 1.1 );
        col += uFoam * smoothstep( 0.93, 1.0, shimmer ) * 0.3;
        col += uFoam * 0.07 * vWave;
        // Foam collar where water meets the shore.
        col = mix( col, uFoam, smoothstep( 0.96, 1.0, r ) * 0.75 );
        float fogFactor = 1.0 - exp( -fogDensity * fogDensity * vFogDepth * vFogDepth );
        col = mix( col, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
        gl_FragColor = vec4( col, 0.6 );
      }
    `
  });
}

/* ------------------------------------------------------------------ */
/*  Particle materials                                                 */
/* ------------------------------------------------------------------ */

const SOFT_DISC = /* glsl */ `
float softDisc( vec2 pc ) {
  float d = length( pc - 0.5 );
  return smoothstep( 0.5, 0.12, d );
}
`;

/**
 * One-shot radial burst: physics fully integrated in the vertex shader from
 * a birth timestamp, so a burst costs zero CPU per frame.
 * Attributes: position (origin), aVelocity, aScale, aLife.
 */
export function createBurstMaterial() {
  return new THREE.ShaderMaterial({
    name: 'PickupBurst',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: SharedUniforms.uTime,
      uBirth: { value: 0 },
      uGravity: { value: 7.5 },
      uSize: { value: 42.0 },
      uColor: { value: new THREE.Color(0xffe08a) }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uBirth;
      uniform float uGravity;
      uniform float uSize;
      attribute vec3 aVelocity;
      attribute float aScale;
      attribute float aLife;
      varying float vFade;
      void main() {
        float t = max( uTime - uBirth, 0.0 );
        float lifeT = clamp( t / aLife, 0.0, 1.0 );
        vFade = 1.0 - lifeT;
        vec3 pos = position + aVelocity * t
                 + vec3( 0.0, -0.5 * uGravity * t * t, 0.0 );
        vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
        gl_PointSize = uSize * aScale * vFade * ( 24.0 / max( -mvPosition.z, 0.5 ) );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vFade;
      ${SOFT_DISC}
      void main() {
        float alpha = softDisc( gl_PointCoord ) * vFade;
        if ( alpha < 0.003 ) discard;
        gl_FragColor = vec4( uColor, alpha );
      }
    `
  });
}

/**
 * Orbiting golden aura around eggs. Orbit is computed analytically from
 * per-particle angle/radius/speed attributes — again zero CPU per frame.
 */
export function createAuraMaterial() {
  return new THREE.ShaderMaterial({
    name: 'GoldAura',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: SharedUniforms.uTime,
      uSize: { value: 30.0 },
      uColor: { value: new THREE.Color(0xffd44f) }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSize;
      attribute float aAngle;
      attribute float aRadius;
      attribute float aSpeed;
      attribute float aHeight;
      attribute float aPhase;
      varying float vSparkle;
      void main() {
        float angle = aAngle + uTime * aSpeed;
        vec3 pos = vec3(
          cos( angle ) * aRadius,
          aHeight + 0.14 * sin( uTime * 2.1 + aPhase ),
          sin( angle ) * aRadius
        );
        vSparkle = 0.55 + 0.45 * sin( uTime * 5.0 + aPhase * 7.0 );
        vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
        gl_PointSize = uSize * vSparkle * ( 12.0 / max( -mvPosition.z, 0.5 ) );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vSparkle;
      ${SOFT_DISC}
      void main() {
        float alpha = softDisc( gl_PointCoord ) * vSparkle * 0.9;
        if ( alpha < 0.003 ) discard;
        gl_FragColor = vec4( uColor, alpha );
      }
    `
  });
}

/**
 * Localized poison cloud: motes drift upward inside a cylinder and wrap,
 * with a sideways sinusoidal wander. Rendered with normal alpha blending so
 * the cloud reads as a sickly translucent volume rather than a glow.
 */
export function createPoisonMaterial(radius = 2.0, height = 1.6) {
  return new THREE.ShaderMaterial({
    name: 'PoisonCloud',
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: SharedUniforms.uTime,
      uSize: { value: 58.0 },
      uRadius: { value: radius },
      uHeight: { value: height },
      uColor: { value: new THREE.Color(0x6fdc3c) }
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSize;
      uniform float uRadius;
      uniform float uHeight;
      attribute float aAngle;
      attribute float aRadiusT;
      attribute float aRise;
      attribute float aPhase;
      attribute float aScale;
      varying float vAlpha;
      void main() {
        float y = mod( uTime * aRise + aPhase * uHeight, uHeight );
        float wander = aAngle + 0.5 * sin( uTime * 0.7 + aPhase * 6.28 );
        float r = uRadius * aRadiusT * ( 0.75 + 0.25 * sin( uTime * 0.9 + aPhase * 9.0 ) );
        vec3 pos = vec3( cos( wander ) * r, y, sin( wander ) * r );
        // Fade in near the ground and out near the top of the column.
        vAlpha = smoothstep( 0.0, 0.25, y / uHeight ) * ( 1.0 - smoothstep( 0.55, 1.0, y / uHeight ) );
        vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
        gl_PointSize = uSize * aScale * ( 12.0 / max( -mvPosition.z, 0.5 ) );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      ${SOFT_DISC}
      void main() {
        float alpha = softDisc( gl_PointCoord ) * vAlpha * 0.34;
        if ( alpha < 0.003 ) discard;
        gl_FragColor = vec4( uColor, alpha );
      }
    `
  });
}
