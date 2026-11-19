/**
 * Gradient Cubes — a toy box tipped out over a flat warm ground. The frame is packed with chunky
 * matte cubes, each caught at its own angle, and every face is an airbrushed gradient of two or
 * three colours melting into each other. No outlines and no gloss: soft shading only, so it stays
 * graphic. The feeling is candy joy.
 *
 * How it follows a song
 *   quiet   a few large cubes turn slowly and weightlessly, with a lot of ground between them
 *   verse   more cubes arrive; every kick sends a quarter-turn travelling across the field
 *   build   the cubes stand to attention one by one into a tight tidy wall that shrinks and trembles
 *   drop    the wall bursts outward, the cubes tumble freely, then fall back into the packed field
 *   chorus  the full field, hard snaps with overshoot, brighter colour
 *
 * Hits: kick = a quarter-turn wave with overshoot · snare = a random third flip back the other way
 * and their gradients change · bass = the cubes swell · hats = a tiny shiver.
 *
 * Palette roles: bg = the ground. fg, accent, accent2 and muted = the four face colours. Twelve more
 * are derived from them (tints toward white, deep shades, pair mixes, mixes with the ground) and
 * cubes pick colour families from that table, so any palette gives a full toy box.
 *
 * Each cube turns on a quaternion spring (no Euler angles anywhere). The cubes are drawn back to
 * front without a depth test: every cube is convex and back-face culled, so overlaps stay clean
 * like cut paper even when they tumble through each other.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { Spring, approach, beatsPerSecond, makeMaterial, stepDt, syncMaterial } from './common';
import { dropEdge } from './songInfo';

const MAX = 240; // most cubes ever drawn
const FOV = 16; // long lens: nearly orthographic, a little taper on each cube
const CAM_D = 1 / Math.tan((FOV * Math.PI) / 360); // the frame is 2 units tall at z = 0
const SIZE = 0.74; // cube edge as a share of its grid cell
const PULL = 0.8; // tidy wall: cell pitch as a share of the loose pitch (cubes nearly touch)
const NCOL = 16;
const NSCH = 14;

const params: ParamDef[] = [
  { id: 'density', label: 'Cubes across', group: 'Shape', type: 'number', min: 0.6, max: 1.6, step: 0.01, default: 1, hint: 'More, smaller cubes' },
  { id: 'tilt', label: 'Tumble', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How far the cubes are tipped away from facing front' },
  { id: 'spin', label: 'Idle turn', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, hint: 'Slow weightless turning, strongest in quiet parts' },
  { id: 'flow', label: 'Gradient drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How fast the colours drift and how far vocals push them' },
  { id: 'wave', label: 'Kick wave', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How long a kick takes to cross the frame (0 = all cubes at once)' },
  { id: 'snap', label: 'Kick snap', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Soft and slow → hard quarter-turns with overshoot' },
  { id: 'swell', label: 'Bass swell', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'burst', label: 'Drop burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'variety', label: 'Colour mix', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, hint: 'Tidy colour families → every face its own colours' },
  { id: 'soft', label: 'Softness', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Crisper shapes → fully airbrushed' },
];

const VERT = /* glsl */ `
attribute float aFace;   // which side of the cube: +x -x +y -y +z -z
attribute vec4 aLook;    // gradient seed A, seed B, A→B morph, hit glow
uniform vec3 uCols[${NCOL}];
uniform vec3 uSch[${NSCH}];
uniform float uFlow, uPush;
varying vec3 vC0;
varying vec3 vC1;
varying vec3 vC2;
varying vec4 vSweep;     // direction xy, offset, softness
varying vec4 vSpotA;     // centre xy, radius, amount
varying vec4 vSpotB;
varying vec3 vN;
varying vec3 vFN;
varying float vGlow;

float gcH(float seed, float face, float n) { return hash11(seed * 13.71 + face * 31.37 + n * 7.93 + 0.5); }

// One face's gradient: a base colour, a soft sweep of a second colour and two airbrushed spots.
// It only depends on the seed and the face, so it is worked out per vertex and is constant
// across the face; the fragment shader just paints it.
void gcFace(float seed, float face, out vec3 c0, out vec3 c1, out vec3 c2, out vec4 sweep, out vec4 spotA, out vec4 spotB) {
  vec3 sch = uSch[int(min(floor(hash11(seed * 7.31 + 1.7) * ${NSCH}.0), ${NSCH - 1}.0))];
  float r = gcH(seed, face, 0.0);
  vec3 idx = r < 0.34 ? sch.xyz : (r < 0.67 ? sch.yzx : sch.zxy);
  if (gcH(seed, face, 1.0) < u_variety * 0.7) idx.z = floor(gcH(seed, face, 2.0) * ${NCOL - 0.01});
  if (gcH(seed, face, 3.0) < u_variety * 0.4) idx.y = floor(gcH(seed, face, 4.0) * ${NCOL - 0.01});
  c0 = uCols[int(idx.x)];
  c1 = uCols[int(idx.y)];
  c2 = uCols[int(idx.z)];

  float ph = gcH(seed, face, 5.0) * TAU;
  vec2 pd = vec2(cos(ph), sin(ph)) * uPush;            // the way the mids shove this face's colours
  float ang = gcH(seed, face, 6.0) * TAU + sin(uFlow * (0.35 + 0.4 * gcH(seed, face, 7.0)) + ph) * 0.7;
  vec2 dir = vec2(cos(ang), sin(ang));
  float off = (gcH(seed, face, 8.0) - 0.5) * 0.5 + sin(uFlow * 0.43 + ph * 1.7) * 0.12 - dot(dir, pd);
  sweep = vec4(dir, off, mix(0.16, 0.44, gcH(seed, face, 9.0)));

  // a wide spot of the third colour somewhere on the face
  vec2 ca = vec2(gcH(seed, face, 10.0), gcH(seed, face, 11.0)) * 0.8 + 0.1;
  ca += 0.14 * vec2(sin(uFlow * 0.52 + ph * 2.3), cos(uFlow * 0.37 + ph * 1.3)) + pd;
  spotA = vec4(ca, mix(0.36, 0.62, gcH(seed, face, 12.0)), 1.0);
  // on about half the faces, the sweep colour glows in again from another edge or corner
  float cang = gcH(seed, face, 13.0) * TAU + sin(uFlow * 0.29 + ph * 3.1) * 0.5;
  vec2 cb = 0.5 + vec2(cos(cang), sin(cang)) * 0.66 - pd * 0.6;
  spotB = vec4(cb, mix(0.4, 0.7, gcH(seed, face, 15.0)), step(0.5, gcH(seed, face, 16.0)) * 0.9);
}

void main() {
  vUv = uv;
  vec3 c0; vec3 c1; vec3 c2; vec4 sw; vec4 sa; vec4 sb;
  gcFace(aLook.x, aFace, c0, c1, c2, sw, sa, sb);
  if (aLook.z > 0.001) {
    // a snare (or the drop) is changing this cube's gradients: melt from the old set into the new
    vec3 d0; vec3 d1; vec3 d2; vec4 tw; vec4 ta; vec4 tb;
    gcFace(aLook.y, aFace, d0, d1, d2, tw, ta, tb);
    float m = smoothstep(0.0, 1.0, aLook.z);
    c0 = mix(c0, d0, m); c1 = mix(c1, d1, m); c2 = mix(c2, d2, m);
    sw = mix(sw, tw, m); sa = mix(sa, ta, m); sb = mix(sb, tb, m);
  }
  vC0 = c0; vC1 = c1; vC2 = c2;
  vSweep = sw; vSpotA = sa; vSpotB = sb;
  vGlow = aLook.w;

  mat3 rot = mat3(instanceMatrix);
  vN = rot * normal;
  vec3 fn = aFace < 0.5 ? vec3(1.0, 0.0, 0.0) : aFace < 1.5 ? vec3(-1.0, 0.0, 0.0)
          : aFace < 2.5 ? vec3(0.0, 1.0, 0.0) : aFace < 3.5 ? vec3(0.0, -1.0, 0.0)
          : aFace < 4.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 0.0, -1.0);
  vFN = rot * fn;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uBright, uBurst;
varying vec3 vC0;
varying vec3 vC1;
varying vec3 vC2;
varying vec4 vSweep;
varying vec4 vSpotA;
varying vec4 vSpotB;
varying vec3 vN;
varying vec3 vFN;
varying float vGlow;

void main() {
  // the airbrushed face: base → sweep → two spots, all wide and smooth
  float s = vSweep.w * mix(0.4, 1.3, u_soft);
  float sw = smoothstep(-s, s, dot(vUv - 0.5, vSweep.xy) + vSweep.z);
  vec3 col = mix(vC0, vC1, sw);
  float e = mix(2.2, 0.9, u_soft);
  vec2 d = (vUv - vSpotA.xy) / vSpotA.z;
  col = mix(col, vC2, exp(-pow(dot(d, d), e) * 1.6) * vSpotA.w);
  d = (vUv - vSpotB.xy) / vSpotB.z;
  col = mix(col, vC1, exp(-pow(dot(d, d), e) * 1.6) * vSpotB.w);

  // matte shading: one soft key light from the upper left, never dark, no highlight
  vec3 n = normalize(vN);
  vec3 fn = normalize(vFN);
  vec3 L = normalize(vec3(-0.42, 0.62, 0.66));
  float lit = mix(0.68, 1.04, smoothstep(-0.4, 0.95, dot(fn, L)));
  lit += dot(vUv - 0.5, vec2(-0.05, 0.07));                 // light falls off gently across a face
  // the rounded edge catches a little light or shade, depending on which way it turns
  lit += (dot(n, L) - dot(fn, L)) * 0.3;
  col *= lit;

  col = mix(col, min(col * 1.1 + 0.02, vec3(1.0)), vGlow);   // a hit lifts the cube for a moment
  col *= uBright * (1.0 + 0.1 * uBurst);
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.5 / 255.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// colour families (base, sweep, spot) as indices into the derived table built in fillTable()
const SCHEMES: [number, number, number][] = [
  [0, 8, 4], // fg into deep accent2 (pink into navy)
  [1, 6, 11], // accent into pale accent2 (orange into lilac)
  [2, 7, 6], // accent2 into sand (cobalt into sand)
  [3, 9, 7], // muted into deep muted (lime into forest)
  [11, 1, 4], // fg+accent into accent (hot pink into red)
  [0, 5, 1], // fg into pale accent
  [15, 6, 10], // deep violet into lilac
  [12, 13, 14], // deep accent into pale teal and tan
  [7, 1, 3], // sand, accent, muted
  [4, 13, 0], // pale fg into pale teal
  [0, 2, 6], // fg into accent2 and lilac
  [1, 0, 5], // accent into fg and peach
  [14, 12, 7], // tan into deep accent and sand
  [0, 11, 4], // fg into hot mix and pale fg
];

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Wave {
  age: number;
  dur: number;
  ox: number;
  oy: number;
  maxD: number;
  /** every fourth kick turns the cubes in the plane instead of rolling them */
  flat: boolean;
}

export const gradientCubes = defineThreeScene({
  id: 'gradient-cubes',
  name: 'Gradient Cubes',
  description:
    'A frame packed with chunky matte cubes over a flat warm ground, every face an airbrushed gradient of two or three colours. Kicks send a quarter-turn travelling across the field, snares flip a third of them back and change their colours, bass makes them swell. Quiet parts leave a few large cubes turning slowly; builds line them up into a tight trembling wall that bursts apart on the drop.',
  category: 'form',
  style: 'form',
  tags: ['playful', 'happy', 'pop', 'bouncy', 'upbeat', 'tactile', 'graphic', 'warm', 'energetic', 'uplifting', 'euphoric'],
  params,
  modulations: [
    { source: 'mid', param: 'flow', amount: 0.3 },
    { source: 'energy', param: 'snap', amount: 0.2 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(FOV, init.width / Math.max(1, init.height), 0.1, 60);
    camera.position.set(0, 0, CAM_D);
    camera.lookAt(0, 0, 0);

    // softly rounded unit cube; aFace tells the shader which of the six sides a vertex is on
    const geo = new RoundedBoxGeometry(1, 1, 1, 1, 0.065);
    const vcount = geo.getAttribute('position').count;
    const faces = new Float32Array(vcount);
    for (let i = 0; i < vcount; i++) faces[i] = Math.floor((i * 6) / vcount);
    geo.setAttribute('aFace', new THREE.BufferAttribute(faces, 1));
    const look = new Float32Array(MAX * 4);
    const lookAttr = new THREE.InstancedBufferAttribute(look, 4);
    lookAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aLook', lookAttr);

    const cols = Array.from({ length: NCOL }, () => new THREE.Color());
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      depthTest: false,
      depthWrite: false,
      extra: {
        uCols: { value: cols },
        uSch: { value: SCHEMES.map((s) => new THREE.Vector3(s[0], s[1], s[2])) },
        uFlow: { value: 0 },
        uPush: { value: 0 },
        uBright: { value: 1 },
        uBurst: { value: 0 },
      },
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);

    /* ── per-cube state ── */
    const gx = new Float32Array(MAX); // tidy grid position
    const gy = new Float32Array(MAX);
    const jx = new Float32Array(MAX); // how far it sits off the grid when loose (−0.5..0.5 of a cell)
    const jy = new Float32Array(MAX);
    const rank = new Float32Array(MAX); // when it appears as the song fills up (a checkerboard comes first)
    const turnOrder = new Float32Array(MAX); // when it stands to attention in a build
    const stack = new Float32Array(MAX); // who overlaps whom
    const phi = new Float32Array(MAX); // resting in-plane angle
    const tipDir = new Float32Array(MAX);
    const tip = new Float32Array(MAX);
    const spinRate = new Float32Array(MAX);
    const tipRate = new Float32Array(MAX);
    const fph = new Float32Array(MAX); // float phase
    const pos = new Float32Array(MAX * 3);
    const vel = new Float32Array(MAX * 3);
    const angVel = new Float32Array(MAX * 3);
    const scl = new Float32Array(MAX);
    const sclVel = new Float32Array(MAX);
    const free = new Float32Array(MAX); // 1 = thrown by the drop, flying on its own momentum
    const freeRate = new Float32Array(MAX);
    const tidy = new Float32Array(MAX);
    const shown = new Uint8Array(MAX);
    const glow = new Float32Array(MAX);
    const lastAx = new Int8Array(MAX).fill(-1); // local axis and direction of its last kick turn
    const lastSign = new Int8Array(MAX);
    const seedA = new Float32Array(MAX);
    const seedB = new Float32Array(MAX);
    const morph = new Float32Array(MAX);
    const key = new Float32Array(MAX);
    const order = new Uint16Array(MAX);
    const quat = Array.from({ length: MAX }, () => new THREE.Quaternion());
    const turns = Array.from({ length: MAX }, () => new THREE.Quaternion()); // quarter turns so far (always one of the cube's 24 poses)

    let n = 0;
    let cell = 0.4;
    let zfit = 1;
    let builtAspect = 0;
    let builtDensity = 0;
    let first = true;

    const rnd = mulberry(90210); // live events (which cubes a snare picks, shivers); layout has its own
    const sgn = () => rnd() * 2 - 1;

    function layout(aspect: number, density: number) {
      // about 5 cubes across the short side of a 9:16 frame, 8 across a 16:9 one
      let c = (2 * Math.sqrt(aspect) * 0.163) / density;
      let nc = 0;
      let nr = 0;
      for (;;) {
        nc = Math.ceil((2 * aspect) / c) + 2;
        nr = Math.ceil(2 / c) + 2;
        if (nc * nr <= MAX) break;
        c *= 1.04;
      }
      cell = c;
      n = nc * nr;
      zfit = Math.min(1, (2 * aspect * 0.93) / (nc * c * PULL), (2 * 0.93) / (nr * c * PULL));
      const r = mulberry(1977 + nc * 131 + nr * 17);
      let i = 0;
      for (let row = 0; row < nr; row++)
        for (let col = 0; col < nc; col++, i++) {
          gx[i] = (col - (nc - 1) / 2) * c;
          gy[i] = (row - (nr - 1) / 2) * c;
          jx[i] = r() - 0.5;
          jy[i] = r() - 0.5;
          // who is in the picture first: a wide, even scatter (five cubes in every 4×4 cells), then
          // the rest of the checkerboard, then everything in between
          const even = ((col + row) & 1) === 0;
          const wide = even && ((col & 1) === 0 || ((col + row) & 2) === 0);
          rank[i] = (wide ? 0 : even ? 0.4 : 0.52) + r() * (wide ? 0.36 : even ? 0.1 : 0.48);
          turnOrder[i] = r();
          stack[i] = r();
          phi[i] = (r() - 0.5) * Math.PI * 0.5;
          tipDir[i] = r() * Math.PI * 2;
          const t = r();
          tip[i] = 0.08 + t * t * 0.5;
          spinRate[i] = (0.12 + r() * 0.3) * (r() < 0.5 ? -1 : 1);
          tipRate[i] = (0.1 + r() * 0.25) * (r() < 0.5 ? -1 : 1);
          fph[i] = r() * Math.PI * 2;
          freeRate[i] = 1 / (0.7 + r() * 0.75);
          seedA[i] = seedB[i] = 1 + r() * 997;
          morph[i] = 0;
        }
      mesh.count = n;
    }

    /* ── scene state ── */
    const waves: Wave[] = [];
    let waveCount = 0;
    const swell = new Spring(110, 13);
    const zoom = new Spring(46, 9.5, 1);
    const isDrop = dropEdge();
    let pack = 0; // 0 = quiet scatter of a few big cubes, 1 = the full packed field
    let build = 0;
    let push = 0.3;
    let burst = 0;
    let spinClock = 0;
    let flowClock = 0;
    let floatClock = 0;

    const WHITE = new THREE.Color(1, 1, 1);
    const tc = new THREE.Color();
    const qA = new THREE.Quaternion();
    const qB = new THREE.Quaternion();
    const qT = new THREE.Quaternion();
    const qE = new THREE.Quaternion();
    const ID = new THREE.Quaternion();
    const AX = new THREE.Vector3();
    const V = new THREE.Vector3();
    const S = new THREE.Vector3();
    const M = new THREE.Matrix4();
    const Z = new THREE.Vector3(0, 0, 1);
    const H = Math.SQRT1_2;

    /** a deep shade that keeps its hue: squaring a colour darkens it and saturates it at once */
    const deep = (out: THREE.Color, c: THREE.Color, k: number) => out.setRGB(c.r * c.r * k, c.g * c.g * k, c.b * c.b * k);

    /** the 16 colours every face draws from, derived from the palette's four face colours */
    function fillTable(pal: { bg: THREE.Color; fg: THREE.Color; accent: THREE.Color; accent2: THREE.Color; muted: THREE.Color }) {
      cols[0].copy(pal.fg);
      cols[1].copy(pal.accent);
      cols[2].copy(pal.accent2);
      cols[3].copy(pal.muted);
      cols[4].copy(pal.fg).lerp(WHITE, 0.5); // pale fg
      cols[5].copy(pal.accent).lerp(WHITE, 0.5); // pale accent (peach)
      cols[6].copy(pal.accent2).lerp(WHITE, 0.55).lerp(pal.fg, 0.25); // pale accent2 (lilac)
      cols[7].copy(pal.accent).lerp(pal.muted, 0.5).lerp(WHITE, 0.55).lerp(pal.bg, 0.12); // sand
      tc.copy(pal.fg).multiplyScalar(0.3);
      deep(cols[8], pal.accent2, 0.6).lerp(tc, 0.25); // deep accent2 (navy)
      deep(cols[9], pal.muted, 0.6); // deep muted (forest)
      cols[10].copy(pal.fg).lerp(pal.accent2, 0.5); // violet
      cols[11].copy(pal.fg).lerp(pal.accent, 0.5); // hot mix
      deep(cols[12], pal.accent, 0.42).lerp(pal.bg, 0.4); // deep accent sunk into the ground (dark brown)
      cols[13].copy(pal.accent2).lerp(pal.muted, 0.5).lerp(WHITE, 0.45); // pale accent2+muted (pale teal)
      cols[14].copy(pal.bg).lerp(cols[7], 0.55); // ground lifted toward sand (tan)
      deep(cols[15], cols[10], 0.6); // deep violet
    }

    /** quarter-turn cube i about whichever of its own axes lies closest to the world axis (ax, ay, az) */
    function turn(i: number, ax: number, ay: number, az: number) {
      // qT holds this cube's current target pose
      qE.copy(qT).invert();
      V.set(ax, ay, az).applyQuaternion(qE);
      const mx = Math.abs(V.x);
      const my = Math.abs(V.y);
      const mz = Math.abs(V.z);
      const k = mx >= my && mx >= mz ? 0 : my >= mz ? 1 : 2;
      const s = (k === 0 ? V.x : k === 1 ? V.y : V.z) < 0 ? -1 : 1;
      quarter(i, k, s);
      lastAx[i] = k;
      lastSign[i] = s;
    }
    function quarter(i: number, k: number, s: number) {
      qE.set(k === 0 ? H * s : 0, k === 1 ? H * s : 0, k === 2 ? H * s : 0, H);
      turns[i].multiply(qE).normalize();
    }
    function newGradient(i: number) {
      if (morph[i] > 0) seedA[i] = seedB[i];
      seedB[i] = 1 + rnd() * 997;
      morph[i] = 0.0001;
    }

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        syncMaterial(mat, frame, params);
        bg.copy(frame.palette.c.bg);
        fillTable(frame.palette.c);

        const density = num(p, 'density', 1);
        if (Math.abs(frame.aspect - builtAspect) > 1e-3 || Math.abs(density / (builtDensity || 1) - 1) > 0.04) {
          layout(frame.aspect, density);
          builtAspect = frame.aspect;
          builtDensity = density;
        }
        const tiltP = num(p, 'tilt', 0.6);
        const snapP = num(p, 'snap', 0.65);
        const flowP = num(p, 'flow', 0.5);
        const burstP = num(p, 'burst', 0.7);
        const swellP = num(p, 'swell', 0.5);
        const bps = beatsPerSecond(frame);

        /* ── the song's arc ── */
        const packT = smooth(0.28, 0.86, a.energy);
        pack = first ? packT : approach(pack, packT, 0.9, dt);
        const wind = Math.max(a.build, frame.feel.tension);
        build = first ? wind : approach(build, wind, 5, dt);
        const dropped = isDrop(frame);
        burst = Math.max(a.drop, 0) > burst ? approach(burst, a.drop, 30, dt) : approach(burst, a.drop, 2.5, dt);
        const quiet = 1 - pack;
        spinClock += dt * (0.2 + 0.8 * quiet) * (0.25 + num(p, 'spin', 0.4) * 1.9);
        flowClock += dt * (0.3 + flowP * 1.6) * (0.7 + pack * 0.6);
        floatClock += dt * (0.35 + 0.3 * quiet);
        push = approach(push, a.mid, 5, dt);
        swell.step(Math.min(1, a.bass * 0.75 + a.sub * 0.5), dt);
        // quiet = closer in on fewer, larger cubes; a build shrinks the wall into the middle of the frame
        const wall = smooth(0.12, 1, build);
        const zoomT = (1 + 0.3 * quiet) * (1 + (zfit - 1) * wall);
        if (first) zoom.value = zoomT;
        zoom.step(zoomT, dt);
        const zm = Math.max(0.2, zoom.value);
        const grow = 1 + 0.22 * smooth(0.7, 0.2, pack);
        // quiet: the wide scatter · verse: the full checkerboard · chorus: every cube
        const visLevel = Math.max(0.38 + 0.13 * smooth(0, 0.3, pack) + 0.49 * smooth(0.45, 1, pack), smooth(0, 0.4, build), burst > 0.3 ? 1 : 0);

        const u = mat.uniforms;
        u.uFlow.value = flowClock;
        u.uPush.value = (push - 0.3) * (0.3 + flowP * 1.1);
        u.uBright.value = 0.9 + 0.14 * pack;
        u.uBurst.value = burst;

        /* ── hits ── */
        if (a.kickHit) {
          const A = frame.aspect / zm;
          const Y = 1 / zm;
          // each kick starts somewhere else: an edge, a corner, now and then the centre
          const o = [
            [-A, 0], [A, 0], [0, -Y], [0, Y], [0, 0], [-A, -Y], [A, Y], [-A, Y], [A, -Y],
          ][Math.floor(rnd() * 9)];
          const w = waves.length < 6 ? ({} as Wave) : waves.shift()!;
          w.age = 0;
          w.dur = ((0.04 + 0.86 * num(p, 'wave', 0.5)) * (0.75 + 0.25 * quiet)) / Math.max(0.5, bps);
          w.ox = o[0];
          w.oy = o[1];
          w.maxD = Math.hypot(A + Math.abs(o[0]), Y + Math.abs(o[1]));
          w.flat = waveCount++ % 4 === 3;
          waves.push(w);
        }
        for (const w of waves) w.age += dt;
        while (waves.length && waves[0].age > waves[0].dur * 2.5 + 0.1) waves.shift();
        // in a build the cubes are holding formation: fewer break rank on each snare
        const snareShare = a.snareHit ? (1 / 3) * (1 - 0.75 * wall) : 0;
        const shiver = a.hatHit ? (0.5 + a.hat) * (0.7 + 0.6 * pack) : 0;
        const tremble = build * build * 4.5;

        // spring feel: weightless when quiet, hard snaps with overshoot when the song is full
        const kRot = 26 + pack * (90 + snapP * 300);
        const zeta = 0.9 - pack * (0.2 + snapP * 0.34);
        const dRot = 2 * zeta * Math.sqrt(kRot);
        const steps = dt > 1 / 45 ? 2 : 1;
        const h = dt / steps;
        const base = cell * SIZE;
        // loose homes: well off the grid while there is room, closer to it once the field is packed
        const jit = cell * (0.34 + 0.24 * (1 - smooth(0.45, 1, pack)));

        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          /* resting pose: one face toward us, tipped a little, turning slowly like a tile in water … */
          const td = tipDir[i] + spinClock * tipRate[i];
          AX.set(Math.cos(td), Math.sin(td), 0);
          qA.setFromAxisAngle(AX, tip[i] * tiltP * 1.6);
          qB.setFromAxisAngle(Z, phi[i] + spinClock * spinRate[i]);
          qA.multiply(qB);
          /* … unless a build has called it to attention: then it faces front */
          const wantTidy = build > 0.06 + turnOrder[i] * 0.7 ? 1 : 0;
          tidy[i] = first ? wantTidy : approach(tidy[i], wantTidy, 9, dt);
          if (tidy[i] > 0.001) qA.slerp(ID, tidy[i]);
          qT.copy(qA).multiply(turns[i]);

          /* kicks arrive as a wave; the cube rolls a quarter turn away from where it started */
          const px0 = gx[i] + jx[i] * jit;
          const py0 = gy[i] + jy[i] * jit;
          for (const w of waves) {
            const dx = px0 - w.ox;
            const dy = py0 - w.oy;
            const dist = Math.hypot(dx, dy);
            const at = (dist / w.maxD) * w.dur;
            if (w.age >= at && w.age - dt < at) {
              if (w.flat || dist < 1e-4) turn(i, 0, 0, waveCount & 1 ? 1 : -1);
              else turn(i, -dy / dist, dx / dist, 0);
              glow[i] = 1;
              sclVel[i] += 1.1 * base;
              qT.copy(qA).multiply(turns[i]);
            }
          }
          /* snares: a random third flip back the other way and change their gradients */
          if (snareShare > 0 && rnd() < snareShare) {
            if (lastAx[i] < 0) {
              lastAx[i] = Math.floor(rnd() * 3);
              lastSign[i] = rnd() < 0.5 ? 1 : -1;
            }
            quarter(i, lastAx[i], -lastSign[i]);
            newGradient(i);
            glow[i] = Math.max(glow[i], 0.6);
            qT.copy(qA).multiply(turns[i]);
          }
          if (shiver > 0) {
            angVel[i3] += sgn() * shiver;
            angVel[i3 + 1] += sgn() * shiver;
            angVel[i3 + 2] += sgn() * shiver * 1.4;
          }
          if (tremble > 0.01 && tidy[i] > 0.5) {
            const t = tremble * Math.sqrt(dt * 60);
            angVel[i3] += sgn() * t * 0.5;
            angVel[i3 + 1] += sgn() * t * 0.5;
            angVel[i3 + 2] += sgn() * t;
          }

          /* where it wants to be */
          const ty = tidy[i];
          const fl = cell * (0.03 + 0.22 * quiet) * (1 - ty);
          const tx = px0 + (gx[i] * PULL - px0) * ty + Math.sin(floatClock * 0.9 + fph[i]) * fl;
          const tyy = py0 + (gy[i] * PULL - py0) * ty + Math.cos(floatClock * 0.7 + fph[i] * 1.7) * fl;

          /* is it part of the picture yet? (a checkerboard of cubes comes first, the rest fill in) */
          if (rank[i] < visLevel) shown[i] = 1;
          else if (rank[i] > visLevel + 0.04) shown[i] = 0;
          const sT = shown[i] ? base * (1 + (grow - 1) * (1 - ty)) * (1 + swell.value * swellP * 0.24 * (1 - 0.6 * ty)) : 0;

          if (dropped) {
            /* the drop: thrown outward and toward the lens with real spin, every gradient changes */
            const d = Math.hypot(px0, py0) + 0.2;
            const sp = (0.9 + rnd() * 2.1) * burstP;
            vel[i3] += (px0 / d + sgn() * 0.35) * sp;
            vel[i3 + 1] += (py0 / d + sgn() * 0.35) * sp;
            vel[i3 + 2] += (rnd() * 3.2 - 0.6) * burstP;
            const sw = (6 + rnd() * 11) * burstP;
            V.set(sgn(), sgn(), sgn()).normalize();
            angVel[i3] += V.x * sw;
            angVel[i3 + 1] += V.y * sw;
            angVel[i3 + 2] += V.z * sw;
            free[i] = burstP > 0.02 ? 1 : 0;
            newGradient(i);
            glow[i] = 0.5;
          }

          if (first) {
            pos[i3] = tx;
            pos[i3 + 1] = tyy;
            pos[i3 + 2] = 0;
            scl[i] = sT;
            quat[i].copy(qT);
          }

          /* springs */
          const hold = (1 - free[i]) * (1 - free[i]);
          const kR = kRot * hold;
          const dR = 0.5 + (dRot - 0.5) * hold;
          const kP = 64 * hold;
          const dP = 1.1 + (11 - 1.1) * hold;
          const q = quat[i];
          for (let s = 0; s < steps; s++) {
            // rotation: pull along the shortest arc from the current pose to the target
            qE.copy(q).invert().premultiply(qT);
            if (qE.w < 0) qE.set(-qE.x, -qE.y, -qE.z, -qE.w);
            const sl = Math.hypot(qE.x, qE.y, qE.z);
            const g = sl > 1e-6 ? (2 * Math.atan2(sl, qE.w)) / sl : 2;
            angVel[i3] += (kR * qE.x * g - dR * angVel[i3]) * h;
            angVel[i3 + 1] += (kR * qE.y * g - dR * angVel[i3 + 1]) * h;
            angVel[i3 + 2] += (kR * qE.z * g - dR * angVel[i3 + 2]) * h;
            const wx = angVel[i3] * h * 0.5;
            const wy = angVel[i3 + 1] * h * 0.5;
            const wz = angVel[i3 + 2] * h * 0.5;
            const { x, y, z, w } = q;
            q.set(x + wx * w + wy * z - wz * y, y + wy * w + wz * x - wx * z, z + wz * w + wx * y - wy * x, w - wx * x - wy * y - wz * z).normalize();
            // position
            vel[i3] += (kP * (tx - pos[i3]) - dP * vel[i3]) * h;
            vel[i3 + 1] += (kP * (tyy - pos[i3 + 1]) - dP * vel[i3 + 1]) * h;
            vel[i3 + 2] += (kP * -pos[i3 + 2] - dP * vel[i3 + 2]) * h;
            pos[i3] += vel[i3] * h;
            pos[i3 + 1] += vel[i3 + 1] * h;
            pos[i3 + 2] += vel[i3 + 2] * h;
            // size
            sclVel[i] += (170 * (sT - scl[i]) - 15 * sclVel[i]) * h;
            scl[i] += sclVel[i] * h;
          }
          if (pos[i3 + 2] > CAM_D * 0.55) pos[i3 + 2] = CAM_D * 0.55;
          if (free[i] > 0) free[i] = Math.max(0, free[i] - dt * freeRate[i]);
          glow[i] *= Math.exp(-dt * 5);
          if (morph[i] > 0) {
            morph[i] += dt * 3.2;
            if (morph[i] >= 1) {
              seedA[i] = seedB[i];
              morph[i] = 0;
            }
          }
          key[i] = stack[i] * 0.02 + pos[i3 + 2];
          order[i] = i;
        }

        /* draw back to front */
        const ord = order.subarray(0, n);
        ord.sort((x, y) => key[x] - key[y]);
        const im = mesh.instanceMatrix.array;
        for (let j = 0; j < n; j++) {
          const i = ord[j];
          const i3 = i * 3;
          const s = Math.max(scl[i], 0) * zm;
          V.set(pos[i3] * zm, pos[i3 + 1] * zm, pos[i3 + 2] * zm);
          M.compose(V, quat[i], S.set(s, s, s));
          M.toArray(im, j * 16);
          look[j * 4] = seedA[i];
          look[j * 4 + 1] = seedB[i];
          look[j * 4 + 2] = morph[i];
          look[j * 4 + 3] = glow[i];
        }
        mesh.instanceMatrix.needsUpdate = true;
        lookAttr.needsUpdate = true;
        first = false;
      },
    };
  },
});
