import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import { Flock, FLOCK_GLSL } from '../../core/flock';
import type { ParamDef } from '../../core/types';
import { approach, BACKDROP_VERT, isLightPalette, makeBackdrop, makeMaterial, setAdaptiveBlending, stepDt, syncMaterial } from '../three/common';

/*
 * Shoal: inside a school of small silver fish at night, a diver's light on them. The feeling is
 * belonging: thousands of bodies moving as one mind, a crowd that breathes together, and in the loud
 * parts the rush of a bait ball.
 *
 * How the picture is made
 * - The fish are a Flock (core/flock.ts) of 2000 bodies in a box sized from the camera frustum, so the
 *   frame is full at any aspect. Alignment is high and wander low, so they really school. The box wraps
 *   at its sides (outside the frame) instead of turning the fish back, so the school can ride the shared
 *   current forever. The camera sits at the near face of the box: fish pass right by the lens.
 * - Each fish is one instanced quad, turned along its heading and rolled to show its flank to the
 *   camera. Its outline (slim body, forked tail), eye, lateral line and shading are drawn in the
 *   fragment shader. The tail beats from the swim phase; a bright band travels down the flank with the
 *   beat (the flash of a silver side turning to the light), tinted by thin-film iridescence.
 * - Near fish are big and soft (their edges widen with distance from a focal plane), far fish small,
 *   dim and fogged into the exact water colour behind them, so the school melts into the dark.
 * - Bodies are sorted back to front on the CPU each frame (a counting sort by depth) and drawn in one
 *   alpha-blended call; marine snow drifts on the shared current over everything.
 * - The water is a backdrop quad: blue-black depth, a glow from the surface, light shafts slanting from
 *   the shared light angle, a vignette. The same function fogs the fish.
 *
 * The music
 * - feel.intensity: how many fish are in view, how fast they cruise and how lit the water is.
 * - bass: swerves the current the whole school rides (on the shared wind direction and phase).
 * - kick: a flash turn. The fish around a point scatter and a ripple of silver bellies runs out from it.
 * - snare: the school darts sideways as one. hat: glints off single scales.
 * - feel.tension: the school winds into a rotating bait ball, tighter and faster toward the drop.
 * - drop: the ball bursts outward past the lens, then the school re-forms looser and faster while
 *   feel.release fades.
 *
 * Palette roles: bg = deep water, fg = silver (bellies, lateral line, eye ring), accent = the cyan of
 * the iridescence, accent2 = the rare warm flash, muted = mid-water blue (the backs, the shafts, the fog).
 */

const N = 2000;
const FOV = 52;
const CAM_Z = 2.0;
/** fish live between z = -DEPTH and z = +DEPTH; the camera sits just in front */
const DEPTH = 1.65;
const BINS = 256;

const params: ParamDef[] = [
  { id: 'count', label: 'School size', group: 'Shape', type: 'number', min: 0.15, max: 1, step: 0.01, default: 0.9, hint: 'How many of the 2000 fish swim at full intensity' },
  { id: 'size', label: 'Fish size', group: 'Shape', type: 'number', min: 0.6, max: 1.6, step: 0.01, default: 1 },
  { id: 'blur', label: 'Depth of field', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How soft the fish close to the lens are' },
  { id: 'speed', label: 'Cruise speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'tight', label: 'Schooling', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: 'How strictly the fish keep one heading (low = loose, restless)' },
  { id: 'flash', label: 'Kick flash turn', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Kicks scatter the fish round a point and send a ripple of silver bellies through the school' },
  { id: 'ball', label: 'Bait ball', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'Build-ups wind the school into a rotating ball that bursts on the drop' },
  { id: 'shimmer', label: 'Iridescence', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'shafts', label: 'Light shafts', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
];

/* the water: shared by the backdrop and the fish fog, so far fish melt into the exact colour behind them */
const WATER = /* glsl */ `
uniform float uLitE, uShaftAmt;
float shaftsAt(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  vec2 src = vec2(cos(uFeelLight) * 0.6 * max(uAspect, 0.8), 1.3);
  vec2 d = p - src;
  float r = length(d);
  float ang = atan(d.x, -d.y);
  float drift = uFeelWindPhase * 0.035 + uTime * 0.01;
  float s = tnoise(vec2(ang * 13.0 + drift, drift * 0.4)) * 0.6 + tnoise(vec2(ang * 41.0 - drift * 1.7, 7.0 + drift * 0.5)) * 0.4;
  s = smoothstep(0.48, 0.86, s);
  return s * exp(-r * 0.62) * smoothstep(-0.15, 0.7, uv.y);
}
vec3 waterAt(vec2 uv) {
  vec3 deep = uBg * 0.75;
  vec3 mid = mix(uBg, uMuted, 0.42);
  float up = clamp(uv.y, 0.0, 1.0);
  vec3 col = mix(deep, mid, smoothstep(-0.15, 1.2, uv.y) * uLitE);
  col += mix(uMuted, uFg, 0.3) * up * up * up * 0.16 * uLitE;
  col += mix(uMuted, uFg, 0.45) * shaftsAt(uv) * uShaftAmt;
  return col;
}
float vignette(vec2 uv) {
  vec2 q = (uv - 0.5) * vec2(min(uAspect, 1.0) * 1.0, min(1.0 / uAspect, 1.0));
  return 1.0 - 0.6 * smoothstep(0.22, 0.75, length(q) * 1.15);
}
`;

const BACK_FRAG = /* glsl */ `
${WATER}
void main() {
  vec2 uv = vUv;
  vec3 col = waterAt(uv);
  // caustic shimmer right under the surface
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float c = tfbm(p * vec2(3.0, 6.0) + vec2(uFeelWindPhase * 0.08, uTime * 0.05), 3);
  col += mix(uMuted, uFg, 0.5) * smoothstep(0.15, 0.55, c) * pow(clamp(uv.y, 0.0, 1.0), 5.0) * 0.12 * uLitE;
  col *= vignette(uv);
  col += (hash21(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.012;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const FISH_VERT = /* glsl */ `
${FLOCK_GLSL}
uniform float uLen, uShow, uKickT, uKickAmp, uFocal, uBlurAmt, uRoll, uTail;
uniform vec3 uKickO;
varying vec2 vP;
varying float vDist, vBlur, vFlash, vSeed, vPhase, vTurn, vAlpha;
varying vec2 vScr;
void main() {
  float seed = aMisc.y;
  float L = uLen * (0.75 + 0.5 * seed);
  vec3 f = normalize(aVel + vec3(1e-5, 0.0, 0.0));
  vec3 toCam = normalize(cameraPosition - aPos);
  // roll the body round its heading so its flank faces the lens, back always up
  vec3 u = cross(toCam, f);
  float ul = length(u);
  u = ul > 1e-3 ? u / ul : vec3(0.0, 1.0, 0.0);
  if (u.y < 0.0) u = -u;
  vec3 n = cross(f, u);

  float d0 = length(cameraPosition - aPos);
  float blur = (1.0 - smoothstep(0.3, uFocal, d0)) + 0.35 * smoothstep(uFocal + 0.8, uFocal + 3.0, d0);
  blur *= uBlurAmt;

  float x = position.x;            // 0 tail tip .. 1 nose
  float y = position.y * (0.13 + blur * 0.08); // across, in body lengths
  float ph = aMisc.x;
  float tailW = 1.0 - smoothstep(0.0, 0.6, x);
  float wig = sin(ph - x * 5.5) * tailW * tailW * uTail;
  // the tail swings toward / away from the lens (foreshortening) and a little in the picture plane
  float lx = x - 0.55;
  lx += (cos(ph - x * 5.5) - 1.0) * 0.06 * tailW * uTail;
  vec3 wp = aPos + (f * lx + u * (y + wig * 0.03) + n * wig * 0.14) * L;

  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vScr = gl_Position.xy / gl_Position.w * 0.5 + 0.5;

  vP = vec2(x, y);
  vDist = d0;
  vBlur = blur;
  vSeed = seed;
  vPhase = ph;
  vec2 ld = vec2(cos(uFeelLight), sin(uFeelLight));
  vTurn = dot(normalize(f.xy + 1e-4), ld);
  // a ripple of turning bellies running out from where the kick landed
  float dk = length(aPos - uKickO);
  float w = (dk - uKickT * 3.0) / 0.6;
  vFlash = exp(-w * w) * exp(-uKickT * 1.1) * uKickAmp * 1.4 + uRoll * (0.5 + 0.5 * sin(seed * 40.0 + ph * 0.25));
  vAlpha = clamp((uShow - aMisc.w) / 0.05, 0.0, 1.0);
}
`;

const FISH_FRAG = /* glsl */ `
${WATER}
uniform float uShimmer, uHatSeed, uFocal, uKickGlow;
varying vec2 vP;
varying float vDist, vBlur, vFlash, vSeed, vPhase, vTurn, vAlpha;
varying vec2 vScr;

float bodyH(float x) {
  float t = clamp((x - 0.2) / 0.8, 0.0, 1.0);
  return 0.078 * pow(t, 0.55) * pow(1.0 - t, 0.5) / 0.5 + 0.016 * (1.0 - t);
}

void main() {
  float x = vP.x;
  float y = vP.y;
  float e = 0.003 + vBlur * 0.08;

  /* outline: body + forked tail */
  float h = bodyH(x);
  float covB = (1.0 - smoothstep(-e, e, abs(y) - h)) * smoothstep(0.17 - e, 0.2 + e, x);
  float s = clamp((0.25 - x) / 0.25, 0.0, 1.0);
  float ht = 0.016 + 0.075 * s;
  float notch = 0.06 * s * s * s;
  float covT = (1.0 - smoothstep(-e, e, abs(y) - ht)) * smoothstep(-e, e, abs(y) - notch) * smoothstep(-e, 0.02 + e, x) * (1.0 - smoothstep(0.22, 0.27, x));
  float a = max(covB, covT * 0.5);
  a *= vAlpha;
  if (a < 0.004) discard;

  /* silver body */
  float yy = clamp(y / max(h, 1e-3), -1.0, 1.0);
  vec3 backCol = mix(uMuted, uBg, 0.35) * 0.8;
  vec3 col = mix(uFg * 0.78, backCol, smoothstep(-0.3, 0.5, yy));
  col += uFg * 0.14 * (1.0 - smoothstep(-0.9, -0.3, yy));
  // a darker band above the lateral line, then the bright line itself
  float body = smoothstep(0.3, 0.42, x) * (1.0 - smoothstep(0.86, 0.93, x));
  float b1 = (yy - 0.38) / 0.12;
  float b2 = (yy - 0.12) / 0.07;
  col *= 1.0 - 0.25 * exp(-b1 * b1) * body;
  float lat = exp(-b2 * b2) * body;
  col = mix(col, uFg * 1.25, lat * 0.75);
  // gill cover
  float gill = abs(length(vec2(x - 0.66, y)) - 0.15);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.002, 0.007 + e, gill)) * step(abs(yy), 0.85) * step(x, 0.78);

  /* the flank flashing as the body flexes, tinted like a thin film */
  float flex = pow(0.5 + 0.5 * sin(vPhase - x * 5.5 + 1.2 + vSeed * 6.0), 5.0);
  float face = 0.45 + 0.55 * (0.5 + 0.5 * vTurn);
  float hue = fract(vTurn * 0.35 + x * 0.55 + yy * 0.25 + vSeed * 1.7 + vPhase * 0.02);
  vec3 violet = mix(uMuted, uAccent2, 0.45) * 1.5;
  vec3 iris = mix(uAccent, violet, smoothstep(0.35, 0.7, hue));
  iris = mix(iris, uAccent2, smoothstep(0.86, 0.95, hue) * step(0.8, vSeed));
  col += iris * flex * face * uShimmer * 1.2 * (0.4 + 0.6 * smoothstep(-0.6, 0.4, yy)) * body;
  col += uFg * flex * face * 0.18 * (1.0 - smoothstep(-0.2, 0.6, yy));

  // kick: bellies turn to the light
  float fl = clamp(vFlash + uKickGlow * (0.4 + 0.6 * vSeed), 0.0, 1.0);
  col = mix(col, uFg * 1.3 + iris * 0.35 * uShimmer, fl * 0.85 * (1.0 - 0.5 * smoothstep(0.2, 1.0, yy)) * covB);

  // hats: glints off single scales
  vec2 gq = vec2(x * 55.0, y * 60.0);
  float g = hash21(floor(gq) + vSeed * 173.0 + uHatSeed * 7.31);
  float dot0 = 1.0 - smoothstep(0.05, 0.3, length(fract(gq) - 0.5));
  col += uFg * step(0.975, g) * dot0 * uHat * 1.8 * body * step(-0.6, yy) * (1.0 - vBlur);

  /* eye: dark, big, ringed in white */
  float er = length(vec2(x - 0.875, y - 0.012));
  float ring = 1.0 - smoothstep(0.026, 0.03 + e, er);
  float pupil = 1.0 - smoothstep(0.019, 0.023 + e, er);
  col = mix(col, uFg * 1.15, ring * covB);
  col = mix(col, uBg * 0.25, pupil * covB);
  col += uFg * 0.8 * (1.0 - smoothstep(0.004, 0.008 + e, length(vec2(x - 0.882, y - 0.018)))) * covB;

  /* translucent tail with fin rays */
  vec3 tailCol = mix(uFg, uMuted, 0.45) * (0.85 + 0.15 * sin(atan(y, x - 0.3) * 60.0));
  col = mix(tailCol, col, covB / max(covB + covT * 0.5, 1e-3));

  /* the diver's light falls off with distance; the water swallows the far ones */
  float lit = 1.2 / (1.0 + 0.25 * vDist * vDist);
  col *= 0.32 + 0.55 * lit;
  col *= 1.0 + 0.6 * shaftsAt(vScr) * uShaftAmt;
  vec3 wat = waterAt(vScr);
  float fog = smoothstep(uFocal * 0.7, 4.0, vDist);
  col = mix(col, wat, fog * 0.88);
  a *= 1.0 - 0.4 * fog;
  a *= smoothstep(0.12, 0.42, vDist) * (1.0 - 0.3 * smoothstep(0.3, 1.0, vBlur));
  col *= vignette(vScr);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), a);
}
`;

const SNOW_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec2 uDrift;
uniform vec3 uBox;
uniform float uPx;
varying float vA;
void main() {
  vec3 p = fract(position + vec3(uDrift, 0.0) * (0.6 + 0.8 * aSeed.x) + vec3(0.0, -uTime * 0.004 * (1.0 + aSeed.y), 0.0)) - 0.5;
  p *= uBox;
  p.z -= uBox.z * 0.5 - 1.7;
  p.x += sin(uTime * 0.3 + aSeed.z * 30.0) * 0.01;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.05);
  gl_PointSize = clamp(uPx * (2.0 + aSeed.w * 4.0) * 2.2 / d, 1.0, 40.0);
  vA = (0.25 + 0.75 * aSeed.y) * smoothstep(0.1, 0.5, d) * (1.0 - smoothstep(3.0, 5.5, d));
}
`;

const SNOW_FRAG = /* glsl */ `
uniform float uSnowGain;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.1, 0.5, d)) * vA * uSnowGain;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uMuted, uFg, 0.55), a);
}
`;

/** small seeded generator, so the snow sits the same way every time */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const shoal = defineThreeScene({
  id: 'shoal',
  name: 'Shoal',
  description:
    'Inside a school of two thousand silver fish in dark water, lit by a diver’s light: near fish pass big and soft past the lens, far ones fade into the blue. The music sets how many swim and how fast, bass swerves the current, kicks flash a ripple of turning bellies, and build-ups wind the school into a spinning bait ball that bursts past the camera on the drop.',
  category: 'form',
  style: 'world',
  tags: ['nature', 'organic', 'dark', 'cinematic', 'hypnotic', 'spacious', 'ambient', 'dreamy', 'electronic', 'euphoric', 'driving', 'cold'],
  params,
  modulations: [
    { source: 'bass', param: 'speed', amount: 0.12 },
    { source: 'air', param: 'shimmer', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, init.width / Math.max(1, init.height), 0.05, 50);
    camera.position.set(0, 0, CAM_Z);
    // FOV is kept for the short side of the frame, so a fish is the same size against the width in portrait
    const tan0 = Math.tan(((FOV / 2) * Math.PI) / 180);
    let tanH = tan0 / Math.min(1, init.width / Math.max(1, init.height));

    /* water */
    const backMat = makeMaterial({ params, shared: init.shared, vertex: BACKDROP_VERT, fragment: BACK_FRAG, extra: { uLitE: { value: 0.5 }, uShaftAmt: { value: 0.5 } } });
    scene.add(makeBackdrop(backMat));

    /* fish */
    const boundsFor = (aspect: number) => {
      // the frustum a little past the middle of the school: the far corners wrap out of sight in the fog
      const halfH = (CAM_Z + DEPTH * 0.45) * tanH + 0.3;
      const halfW = (CAM_Z + DEPTH * 0.45) * tanH * aspect + 0.3;
      return { wx: halfW, wy: halfH };
    };
    let wrap = boundsFor(init.width / Math.max(1, init.height));
    const flock = new Flock(N, 11, {
      bounds: [wrap.wx / 0.78, wrap.wy / 0.78, DEPTH / 0.8],
      speed: 0.5,
      radius: 0.55,
      separation: 1.6,
      alignment: 2.4,
      cohesion: 0.08,
      wander: 0.1,
      agility: 3,
    });
    // a body quad: x 0 (tail tip) .. 1 (nose), y -1..1 across; 16 x 2 segments so the tail can bend
    const base = new THREE.PlaneGeometry(1, 2, 16, 2);
    base.translate(0.5, 0, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const sPos = new Float32Array(N * 3);
    const sVel = new Float32Array(N * 3);
    const sMisc = new Float32Array(N * 4);
    const attrs = [
      new THREE.InstancedBufferAttribute(sPos, 3),
      new THREE.InstancedBufferAttribute(sVel, 3),
      new THREE.InstancedBufferAttribute(sMisc, 4),
    ];
    for (const at of attrs) at.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', attrs[0]);
    geo.setAttribute('aVel', attrs[1]);
    geo.setAttribute('aMisc', attrs[2]);
    geo.instanceCount = 0;
    base.dispose();

    const fishMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: FISH_VERT,
      fragment: FISH_FRAG,
      // the quad's winding flips with the fish's heading (its back is always kept up)
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      extra: {
        uLitE: { value: 0.5 },
        uShaftAmt: { value: 0.5 },
        uLen: { value: 0.17 },
        uShow: { value: 0.3 },
        uKickT: { value: 9 },
        uKickAmp: { value: 0 },
        uKickO: { value: new THREE.Vector3() },
        uFocal: { value: 1.6 },
        uBlurAmt: { value: 0.6 },
        uRoll: { value: 0 },
        uTail: { value: 1 },
        uShimmer: { value: 0.6 },
        uHatSeed: { value: 0 },
        uKickGlow: { value: 0 },
      },
    });
    const fish = new THREE.Mesh(geo, fishMat);
    fish.frustumCulled = false;
    fish.renderOrder = 0;
    scene.add(fish);

    /* marine snow */
    const SNOW = 700;
    const rnd = prng(0x5a17);
    const snowPos = new Float32Array(SNOW * 3);
    const snowSeed = new Float32Array(SNOW * 4);
    for (let i = 0; i < SNOW; i++) {
      snowPos.set([rnd(), rnd(), rnd()], i * 3);
      snowSeed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(snowSeed, 4));
    const snowMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: SNOW_VERT,
      fragment: SNOW_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      extra: { uDrift: { value: new THREE.Vector2() }, uBox: { value: new THREE.Vector3(6, 4, 5) }, uPx: { value: 1 }, uSnowGain: { value: 0.5 } },
    });
    const snow = new THREE.Points(snowGeo, snowMat);
    snow.frustumCulled = false;
    snow.renderOrder = 1;
    scene.add(snow);

    /* depth sort scratch */
    const binCount = new Int32Array(BINS + 1);
    const binOf = new Int32Array(N);
    const order = new Int32Array(N);

    let show = 0.3;
    let lit = 0.5;
    let bassE = 0;
    let swerve = 0;
    let kickT = 9;
    let kickAmp = 0;
    let kickN = 0;
    let snareN = 0;
    let snareGap = 9;
    let hatN = 0;
    let prevSince = 99;
    let shake = 0;
    let roll = 0;
    let camT = 0;
    const kickO = fishMat.uniforms.uKickO.value as THREE.Vector3;

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const f = frame.feel;
        const p = frame.params;
        syncMaterial(backMat, frame, params);
        syncMaterial(fishMat, frame, params);
        syncMaterial(snowMat, frame, params);
        setAdaptiveBlending(snowMat, isLightPalette(frame.palette));

        const ballAmt = num(p, 'ball', 0.8);
        const tight = num(p, 'tight', 0.75);
        const flashAmt = num(p, 'flash', 0.7);
        const tension = f.tension * ballAmt;
        const release = f.release;

        /* the box follows the frustum, so the frame is full at any aspect */
        tanH = tan0 / Math.min(1, frame.aspect);
        const fov = (2 * Math.atan(tanH) * 180) / Math.PI;
        if (Math.abs(camera.fov - fov) > 1e-3) {
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
        wrap = boundsFor(frame.aspect);
        const fp = flock.params;
        fp.bounds[0] = wrap.wx / 0.78;
        fp.bounds[1] = wrap.wy / 0.78;

        /* how the school swims */
        const cruise = (0.22 + 0.6 * num(p, 'speed', 0.5)) * (0.45 + 0.85 * f.intensity + 0.6 * tension + 0.8 * release);
        fp.speed = cruise;
        fp.alignment = (1.0 + 2.4 * tight) * (1 - 0.35 * release) * (1 - 0.6 * tension);
        fp.wander = 0.3 - 0.24 * tight + 0.2 * release;
        fp.agility = 2.4 + 2.5 * f.intensity + 4 * tension + 2 * release;
        fp.radius = 0.55 * Math.sqrt(num(p, 'size', 1)) * (1 - 0.45 * tension);
        fp.cohesion = 0.06 + 0.5 * tension;

        // bass swerves the current; the current itself is the shared wind, tipped onto a diagonal
        bassE = approach(bassE, a.bass, 3, dt);
        swerve += dt * (0.08 + 0.6 * bassE * a.energy);
        const windA = Math.atan2(f.windY, f.windX);
        const ang = windA - 0.38 * Math.sign(f.windX || 1) + 0.75 * Math.sin(swerve + f.windPhase * 0.05) * (0.4 + bassE);
        const flowMag = cruise * (1.4 + 1.2 * bassE) * (1 - tension);
        const fx = Math.cos(ang);
        const fy = Math.sin(ang);
        fp.flow[0] = fx * flowMag;
        fp.flow[1] = fy * flowMag;
        fp.flow[2] = 0.25 * Math.sin(swerve * 0.7) * flowMag;

        // tension: the bait ball, a ring that turns in front of the lens and tightens toward the drop
        const tz = -0.25;
        const visH = (CAM_Z - tz) * tanH;
        fp.gather = tension * 4.5;
        fp.orbit = 0.42 * Math.min(visH, visH * frame.aspect) * (1 - 0.5 * tension);
        fp.target[0] = 0;
        fp.target[1] = 0;
        fp.target[2] = tz;

        /* hits */
        kickT += dt;
        if (a.kickHit && flashAmt > 0) {
          kickN++;
          const r1 = Math.sin(kickN * 12.9898) * 43758.5453;
          const r2 = Math.sin(kickN * 78.233) * 12543.1234;
          const u1 = r1 - Math.floor(r1);
          const u2 = r2 - Math.floor(r2);
          kickO.set((u1 - 0.5) * visH * frame.aspect * 1.2, (u2 - 0.5) * visH * 1.2, -0.4 + (u1 - 0.5));
          flock.shove(kickO.x, kickO.y, kickO.z, flashAmt * (0.8 + 0.8 * a.kick) * (0.6 + cruise), 1.5);
          kickT = 0;
          kickAmp = flashAmt * (0.5 + 0.5 * Math.min(1, a.kick));
        }
        // a snare roll would stack darts into a push, so one dart per quarter second at most
        snareGap += dt;
        if (a.snareHit && snareGap > 0.25) {
          snareGap = 0;
          snareN++;
          const sgn = snareN % 2 ? 1 : -1;
          const k = 0.3 * (0.4 + cruise) * (1 - tension);
          flock.gust(-fy * k * sgn, fx * k * sgn, 0);
        }
        if (a.hatHit) hatN++;

        // the drop: the ball bursts outward, past the lens
        if (f.sinceDrop < 0.1 && prevSince >= 0.1) {
          flock.shove(0, 0, tz, 1.6 + 1.4 * ballAmt, 3.5);
          flock.gust(0, 0, 0.7);
          shake = 1;
          roll = 1;
        }
        prevSince = f.sinceDrop;
        shake = approach(shake, 0, 3, dt);
        roll = approach(roll, 0, 1.2, dt);

        flock.step(dt);

        /* how many are in view: a few in the quiet, the whole school in the chorus and the ball */
        const want = num(p, 'count', 0.9) * Math.max(0.1 + 0.9 * Math.pow(f.intensity, 1.4), 0.95 * tension, 0.8 * release);
        show = approach(show, want, 1.2, dt);
        const nVis = Math.min(N, Math.ceil((show + 0.05) * N));

        /* the camera swims with the school: find where the fish in view are bunched (a circular mean,
           since the box wraps) and slide the water so that bunch drifts back to the middle of the frame */
        const pos = flock.pos;
        let cxs = 0;
        let cxc = 0;
        let cys = 0;
        let cyc = 0;
        const kx = Math.PI / wrap.wx;
        const ky = Math.PI / wrap.wy;
        for (let i = 0; i < nVis; i++) {
          cxs += Math.sin(pos[i * 3] * kx);
          cxc += Math.cos(pos[i * 3] * kx);
          cys += Math.sin(pos[i * 3 + 1] * ky);
          cyc += Math.cos(pos[i * 3 + 1] * ky);
        }
        const inv = 1 / Math.max(1, nVis);
        const follow = Math.min(1, dt * (0.7 + 1.5 * tension));
        const shx = (Math.atan2(cxs, cxc) / kx) * Math.min(1, Math.hypot(cxs, cxc) * inv * 2.5) * follow;
        const shy = (Math.atan2(cys, cyc) / ky) * Math.min(1, Math.hypot(cys, cyc) * inv * 2.5) * follow;

        /* wrap at the sides (outside the frame) so the school can ride the current forever */
        for (let i = 0; i < N; i++) {
          const ix = i * 3;
          pos[ix] -= shx;
          pos[ix + 1] -= shy;
          if (pos[ix] > wrap.wx) pos[ix] -= wrap.wx * 2;
          else if (pos[ix] < -wrap.wx) pos[ix] += wrap.wx * 2;
          if (pos[ix + 1] > wrap.wy) pos[ix + 1] -= wrap.wy * 2;
          else if (pos[ix + 1] < -wrap.wy) pos[ix + 1] += wrap.wy * 2;
        }

        /* sort the visible ones back to front */
        const camZ = camera.position.z;
        const range = camZ + DEPTH * 1.4;
        binCount.fill(0);
        for (let i = 0; i < nVis; i++) {
          const d = camZ - pos[i * 3 + 2];
          const b = BINS - 1 - Math.min(BINS - 1, Math.max(0, Math.floor((d / range) * BINS)));
          binOf[i] = b;
          binCount[b + 1]++;
        }
        for (let b = 0; b < BINS; b++) binCount[b + 1] += binCount[b];
        for (let i = 0; i < nVis; i++) order[binCount[binOf[i]]++] = i;
        const vel = flock.vel;
        const misc = flock.misc;
        for (let k = 0; k < nVis; k++) {
          const i = order[k];
          sPos[k * 3] = pos[i * 3];
          sPos[k * 3 + 1] = pos[i * 3 + 1];
          sPos[k * 3 + 2] = pos[i * 3 + 2];
          sVel[k * 3] = vel[i * 3];
          sVel[k * 3 + 1] = vel[i * 3 + 1];
          sVel[k * 3 + 2] = vel[i * 3 + 2];
          sMisc[k * 4] = misc[i * 4];
          sMisc[k * 4 + 1] = misc[i * 4 + 1];
          sMisc[k * 4 + 2] = misc[i * 4 + 2];
          sMisc[k * 4 + 3] = i / N; // id, for fading fish in and out as the school grows
        }
        for (const at of attrs) at.needsUpdate = true;
        geo.instanceCount = nVis;

        /* uniforms */
        lit = approach(lit, (0.4 + 0.6 * f.intensity) * (1 - 0.35 * tension) + 0.25 * release, 1.5, dt);
        const shaftAmt = num(p, 'shafts', 0.55) * (1.1 - 0.35 * f.intensity + 0.5 * release);
        for (const m of [backMat, fishMat]) {
          m.uniforms.uLitE.value = lit;
          m.uniforms.uShaftAmt.value = shaftAmt;
        }
        const u = fishMat.uniforms;
        u.uLen.value = 0.17 * num(p, 'size', 1);
        u.uShow.value = show;
        u.uKickT.value = kickT;
        u.uKickAmp.value = kickAmp;
        // the whole school catches the light for a moment as it turns
        u.uKickGlow.value = kickAmp * 0.3 * Math.exp(-kickT * 7);
        u.uBlurAmt.value = num(p, 'blur', 0.6);
        u.uRoll.value = roll * 0.8;
        u.uTail.value = 0.7 + 0.5 * Math.min(1, cruise);
        u.uShimmer.value = num(p, 'shimmer', 0.6) * (0.7 + 0.3 * f.intensity + 0.4 * release);
        u.uHatSeed.value = hatN % 97;

        const su = snowMat.uniforms;
        (su.uDrift.value as THREE.Vector2).set(f.windX * f.windPhase * 0.01, f.windY * f.windPhase * 0.01);
        (su.uBox.value as THREE.Vector3).set(2 * (CAM_Z + 2.5) * tanH * frame.aspect + 0.5, 2 * (CAM_Z + 2.5) * tanH + 0.5, 5.2);
        su.uPx.value = frame.height / 720;
        su.uSnowGain.value = 0.35 + 0.25 * (1 - f.intensity);

        /* the camera hangs in the school, breathing with it */
        camT += dt * (0.6 + 0.6 * f.intensity);
        const sh = shake * shake;
        camera.position.set(
          Math.sin(camT * 0.11) * 0.12 + Math.sin(frame.time * 31) * 0.03 * sh,
          Math.cos(camT * 0.08) * 0.08 + a.sway * 0.03 + Math.cos(frame.time * 27) * 0.03 * sh,
          CAM_Z,
        );
        camera.lookAt(camera.position.x * 0.5, camera.position.y * 0.5, -2);
        camera.rotateZ(Math.sin(camT * 0.07) * 0.03 + a.sway * 0.01);
      },
    };
  },
});
