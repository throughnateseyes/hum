/**
 * Dot Assembly — a crowd of flat, same-sized coloured discs that packs itself, edge to edge like
 * marbles in a tray, into big chunky shapes in the middle of the frame. Spare dots queue in rows
 * along the frame edges; every dot that travels draws a thin line of its own colour along the
 * curved path it took, and the lines linger, so the frame keeps a drawing of recent traffic.
 *
 * The feeling is a party getting itself organised: playful, celebratory, order assembling out of
 * a crowd. The shapes are hearts, rings, arches and lollipops (and a
 * title whose words are very short), or the live spectrum as fat bars.
 *
 *   quiet   most dots wait on the border, a ghost outline of the shape, one or two travellers
 *   verse   every kick launches a handful that dock on the next beat; the shape fills in steps
 *   build   the shape drains; dots peel off and race round the frame edge, faster and faster
 *   drop    every dot dives out of the orbit into a new shape at once, along fresh trails
 *   chorus  the shape is full and the traffic never stops
 *   break   they wander home
 *
 * Everything is simulated on the CPU (under a thousand agents) and drawn as two instanced meshes:
 * quads with an analytic circle, and screen-space ribbons that evaluate each flight's cubic bezier
 * in the vertex shader. Flat opaque inks, no glow.
 *
 * Palette roles: bg = the table. Six inks: accent, fg, accent2, muted, plus accent+fg and
 * fg+accent2 mixed (on the home palette: red, yellow, sky blue, lilac, orange, green). An ink too
 * close to the background is pulled toward fg so no dot disappears on another palette.
 */
import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num, str } from '../../core/uniforms';
import type { FrameContext, ParamDef } from '../../core/types';
import { approach, beatsPerSecond, stepDt } from './common';
import { dropEdge, FONT_SANS, sectionIndex, songInfo } from './songInfo';

const MAX_DOTS = 1000;
const MAX_SLOTS = 1600;
const MAX_GROUPS = 48;
const STROKES = 3072;
const SEG = 16;

const HOME = 0;
const FLY = 1;
const DOCK = 2;
const ORBIT = 3;

const EASE_IO = 0; // launch: leaves gently, docks gently
const EASE_IN = 1; // slam: arrives at full speed
const EASE_SOFT = 2; // wander
const EASE_OUT = 3; // swap, reshuffle

// inks in hue order (red, orange, yellow, green, blue, lilac on the home palette) and how much of the crowd wears each
const HUE_ORDER = [0, 4, 1, 5, 2, 3];
const HUE_SHARE = [0.2, 0.22, 0.17, 0.08, 0.17, 0.16];

// orbit: the four side midpoints of the frame and the direction of travel through each
const MQX = [1, 0, -1, 0];
const MQY = [0, 1, 0, -1];
const TQX = [0, -1, 0, 1];
const TQY = [1, 0, -1, 0];

const params: ParamDef[] = [
  {
    id: 'shapes',
    label: 'Shapes',
    group: 'Shape',
    type: 'select',
    default: 'auto',
    hint: 'What the dots assemble into',
    options: [
      { value: 'auto', label: 'Shapes, and a very short title' },
      { value: 'letters', label: 'Very short title only' },
      { value: 'glyphs', label: 'Shapes only' },
      { value: 'spectrum', label: 'Live spectrum bars' },
    ],
  },
  { id: 'size', label: 'Dot size', group: 'Shape', type: 'number', min: 0.007, max: 0.02, step: 0.0005, default: 0.012, hint: 'Dot radius as a share of the short side of the frame' },
  { id: 'crowd', label: 'Crowd', group: 'Shape', type: 'number', min: 200, max: 1000, step: 20, default: 840, hint: 'How many dots there are at most' },
  { id: 'phrase', label: 'Bars per shape', group: 'Shape', type: 'number', min: 2, max: 16, step: 1, default: 8, hint: 'A new shape every this many bars (and at every new section)' },
  { id: 'curve', label: 'Path curve', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How strongly flights gather into shared, bowed lanes on their way in' },
  { id: 'memory', label: 'Trail memory', group: 'Motion', type: 'number', min: 0.5, max: 20, step: 0.1, default: 6, hint: 'Seconds a flight line stays on the frame' },
  { id: 'weight', label: 'Line weight', group: 'Shape', type: 'number', min: 0.5, max: 6, step: 0.1, default: 1.8, hint: 'px at 1080p' },
  { id: 'traffic', label: 'Traffic', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How many dots each kick launches and how many keep trading places' },
  { id: 'pop', label: 'Pop', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Kick ripple through the shape and each colour pulsing with its own band' },
  { id: 'inks', label: 'Inks', group: 'Color', type: 'number', min: 2, max: 6, step: 1, default: 6, hint: 'Two inks is the minimalist version' },
];

const DOT_VERT = /* glsl */ `
attribute vec4 aDot; // x, y, scale, ink + hole * 0.9
uniform vec2 uHalf;
uniform float uR, uPxU;
uniform vec3 uInk[6];
varying vec2 vP;
varying float vR;
varying float vHole;
varying vec3 vCol;
void main() {
  float ink = floor(aDot.w + 1e-4);
  float hole = fract(aDot.w + 1e-4) / 0.9;
  vR = uR * aDot.z * uPxU;
  float ext = vR + 1.5;
  vP = position.xy * ext;
  vHole = hole * vR * 0.64;
  vCol = uInk[int(ink)];
  vec2 p = aDot.xy + position.xy * ext / uPxU;
  gl_Position = aDot.z < 0.01 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(p / uHalf, 0.0, 1.0);
}
`;
const DOT_FRAG = /* glsl */ `
varying vec2 vP;
varying float vR;
varying float vHole;
varying vec3 vCol;
void main() {
  float d = length(vP);
  float a = clamp(vR - d + 0.5, 0.0, 1.0);
  if (vHole > 0.5) a *= clamp(d - vHole + 0.5, 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}
`;

// position.x = 0..1 along the visible part of the stroke, position.y = side
const LINE_VERT = /* glsl */ `
attribute vec4 aA; // p0, c1
attribute vec4 aB; // c2, p3
attribute vec4 aS; // tail, head, alpha, ink
attribute vec2 aT; // comet taper: start, 1 / length (0 = no taper)
uniform vec2 uHalf;
uniform float uPxU, uW;
uniform vec3 uInk[6];
varying float vSide;
varying float vAlpha;
varying vec3 vCol;
void main() {
  float t = mix(aS.x, aS.y, position.x);
  float u = 1.0 - t;
  vec2 p0 = aA.xy, p1 = aA.zw, p2 = aB.xy, p3 = aB.zw;
  vec2 p = u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
  vec2 d = 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
  float l = length(d);
  d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
  float ext = uW + 1.0;
  p += vec2(-d.y, d.x) * position.y * ext / uPxU;
  vSide = position.y * ext;
  vAlpha = aS.z * (aT.y > 0.0 ? clamp((t - aT.x) * aT.y, 0.0, 1.0) : 1.0);
  vCol = uInk[int(aS.w + 0.5)];
  gl_Position = aS.z < 0.003 || aS.y - aS.x < 1e-4 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(p / uHalf, 0.0, 1.0);
}
`;
const LINE_FRAG = /* glsl */ `
uniform float uW, uCover;
varying float vSide;
varying float vAlpha;
varying vec3 vCol;
void main() {
  float a = clamp(uW - abs(vSide) + 0.5, 0.0, 1.0) * vAlpha * uCover;
  gl_FragColor = vec4(vCol, a);
}
`;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash2 = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** smooth 2D value noise, 0..1 */
function vnoise2(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** which ink sits at position t (0..1) of the hue order */
function inkAt(t: number) {
  let acc = 0;
  for (let k = 0; k < 6; k++) {
    acc += HUE_SHARE[k];
    if (t < acc) return HUE_ORDER[k];
  }
  return HUE_ORDER[5];
}

interface Item {
  ch?: string;
  icon?: string;
}
// chunky glyphs for when there is no title, between passes of the title, and for the drop
const ICON_SETS = [
  ['arch', 'slash', 'lollipop'],
  ['heart', 'ring', 'arrow'],
  ['disc', 'plus', 'star'],
];
const DROP_ICONS = ['heart', 'ring', 'star'];

/** draws one glyph centred on the origin, roughly filling -1..1 (canvas y points down) */
function iconPath(c: CanvasRenderingContext2D, name: string) {
  c.beginPath();
  switch (name) {
    case 'heart':
      c.moveTo(0, 0.98);
      c.bezierCurveTo(-1.55, -0.05, -0.8, -1.3, 0, -0.5);
      c.bezierCurveTo(0.8, -1.3, 1.55, -0.05, 0, 0.98);
      break;
    case 'ring':
      c.arc(0, 0, 1, 0, Math.PI * 2);
      c.moveTo(0.5, 0);
      c.arc(0, 0, 0.5, 0, Math.PI * 2, true);
      break;
    case 'arch':
      c.moveTo(-1, 1);
      c.lineTo(-1, 0);
      c.arc(0, 0, 1, Math.PI, 0);
      c.lineTo(1, 1);
      c.lineTo(0.28, 1);
      c.lineTo(0.28, 0);
      c.arc(0, 0, 0.28, 0, Math.PI, true);
      c.lineTo(-0.28, 1);
      c.closePath();
      break;
    case 'slash':
      c.save();
      c.rotate(-0.42);
      c.roundRect(-0.46, -1.08, 0.92, 2.16, 0.46);
      c.restore();
      break;
    case 'lollipop':
      c.arc(0, -0.36, 0.64, 0, Math.PI * 2);
      c.rect(-0.2, 0, 0.4, 1);
      break;
    case 'arrow':
      c.moveTo(0, -1);
      c.lineTo(1, 0.08);
      c.lineTo(0.42, 0.08);
      c.lineTo(0.42, 1);
      c.lineTo(-0.42, 1);
      c.lineTo(-0.42, 0.08);
      c.lineTo(-1, 0.08);
      c.closePath();
      break;
    case 'plus':
      c.rect(-0.36, -1, 0.72, 2);
      c.rect(-1, -0.36, 2, 0.72);
      break;
    case 'star':
      for (let k = 0; k < 10; k++) {
        const rr = k % 2 ? 0.52 : 1.08;
        const an = -Math.PI / 2 + (k * Math.PI) / 5;
        if (k) c.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
        else c.moveTo(Math.cos(an) * rr, Math.sin(an) * rr);
      }
      c.closePath();
      break;
    default:
      c.arc(0, 0, 1, 0, Math.PI * 2);
  }
}

/** the title a whole word at a time, or nothing when any of its words is longer than `most`: the dots never spell a piece of a word */
function titleWords(title: string, most: number): string[][] {
  if (!title || /^untitled$/i.test(title.trim())) return [];
  const words = title
    .toUpperCase()
    .split(/\s+/)
    .map((w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((w) => w.length);
  return words.every((w) => w.length <= most) ? words.slice(0, 16) : [];
}

export const dotAssembly = defineThreeScene({
  id: 'dot-assembly',
  name: 'Dot Assembly',
  description:
    "Hundreds of flat coloured dots queue along the frame edges and fly in along curved paths to pack, edge to edge, into big chunky shapes: hearts, rings, arches, or the spectrum as fat bars. Each kick launches a handful that dock on the next beat, snares swap dots, hats blink the queue; a build drains the shape into a race round the frame, and the drop slams every dot into a new shape at once. Every flight leaves a thin line that lingers.",
  category: 'form',
  style: 'particles',
  tags: ['playful', 'graphic', 'happy', 'upbeat', 'pop', 'bouncy', 'energetic', 'typographic', 'uplifting', 'indie', 'euphoric', 'retro'],
  params,
  modulations: [
    { source: 'energy', param: 'traffic', amount: 0.25 },
    { source: 'bass', param: 'pop', amount: 0.2 },
  ],
  build() {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const inks = Array.from({ length: 6 }, () => new THREE.Color());
    const inkBase = Array.from({ length: 6 }, () => new THREE.Color());
    const uHalf = new THREE.Vector2(1, 1);

    /* ── the discs ── */
    const dotGeo = new THREE.InstancedBufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    dotGeo.setIndex([0, 1, 2, 2, 1, 3]);
    const dotData = new Float32Array(MAX_DOTS * 4);
    const dotAttr = new THREE.InstancedBufferAttribute(dotData, 4);
    dotAttr.setUsage(THREE.DynamicDrawUsage);
    dotGeo.setAttribute('aDot', dotAttr);
    dotGeo.instanceCount = 0;
    const dotMat = new THREE.ShaderMaterial({
      uniforms: { uHalf: { value: uHalf }, uR: { value: 0.02 }, uPxU: { value: 360 }, uInk: { value: inks } },
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.frustumCulled = false;
    dotMesh.renderOrder = 2;
    scene.add(dotMesh);

    /* ── the flight lines ── */
    const lineGeo = new THREE.InstancedBufferGeometry();
    {
      const pos = new Float32Array((SEG + 1) * 2 * 3);
      const idx: number[] = [];
      for (let k = 0; k <= SEG; k++) {
        pos.set([k / SEG, -1, 0, k / SEG, 1, 0], k * 6);
        if (k < SEG) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 2, k * 2 + 1, k * 2 + 3);
      }
      lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      lineGeo.setIndex(idx);
    }
    const sA = new Float32Array(STROKES * 4);
    const sB = new Float32Array(STROKES * 4);
    const sS = new Float32Array(STROKES * 4);
    const sT = new Float32Array(STROKES * 2);
    const attrA = new THREE.InstancedBufferAttribute(sA, 4);
    const attrB = new THREE.InstancedBufferAttribute(sB, 4);
    const attrS = new THREE.InstancedBufferAttribute(sS, 4);
    const attrT = new THREE.InstancedBufferAttribute(sT, 2);
    for (const at of [attrA, attrB, attrS, attrT]) at.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('aA', attrA);
    lineGeo.setAttribute('aB', attrB);
    lineGeo.setAttribute('aS', attrS);
    lineGeo.setAttribute('aT', attrT);
    lineGeo.instanceCount = STROKES;
    const lineMat = new THREE.ShaderMaterial({
      uniforms: { uHalf: { value: uHalf }, uPxU: { value: 360 }, uW: { value: 1 }, uCover: { value: 1 }, uInk: { value: inks } },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const lineMesh = new THREE.Mesh(lineGeo, lineMat);
    lineMesh.frustumCulled = false;
    lineMesh.renderOrder = 1;
    scene.add(lineMesh);

    // stroke bookkeeping: life 1 → 0 once released, the dot that is still drawing it
    const sLife = new Float32Array(STROKES);
    const sFade = new Float32Array(STROKES);
    const sOwner = new Int16Array(STROKES).fill(-1);
    let sNext = 0;
    let sSteal = 0;
    let strokesDirty = false;

    /* ── the dots ── */
    const state = new Uint8Array(MAX_DOTS);
    const px = new Float32Array(MAX_DOTS);
    const py = new Float32Array(MAX_DOTS);
    const hx = new Float32Array(MAX_DOTS);
    const hy = new Float32Array(MAX_DOTS);
    const hnx = new Float32Array(MAX_DOTS); // inward normal of the edge the dot queues on
    const hny = new Float32Array(MAX_DOTS);
    const hs = new Float32Array(MAX_DOTS); // where along the perimeter (0..1)
    const hubX = new Float32Array(MAX_DOTS); // the point this dot's lane to the shape bends round
    const hubY = new Float32Array(MAX_DOTS);
    const col = new Uint8Array(MAX_DOTS);
    const slot = new Int16Array(MAX_DOTS).fill(-1);
    const curve = new Float32Array(MAX_DOTS * 8); // the bezier being flown
    const ft = new Float32Array(MAX_DOTS);
    const fdur = new Float32Array(MAX_DOTS);
    const fdelay = new Float32Array(MAX_DOTS);
    const fease = new Uint8Array(MAX_DOTS);
    const ffade = new Float32Array(MAX_DOTS); // how fast this flight's line fades once it has landed (1 / s)
    const flen = new Float32Array(MAX_DOTS);
    const plen = new Float32Array(MAX_DOTS);
    const stroke = new Int16Array(MAX_DOTS).fill(-1);
    const stroke2 = new Int16Array(MAX_DOTS).fill(-1); // the orbit hop before this one (its tail is still showing)
    const oq = new Uint8Array(MAX_DOTS);
    const pop = new Float32Array(MAX_DOTS);
    const hole = new Float32Array(MAX_DOTS);
    const lane = new Float32Array(MAX_DOTS);
    const spd = new Float32Array(MAX_DOTS);
    const thr = new Float32Array(MAX_DOTS);
    let n = 0;

    /* ── the shape ── */
    const slX = new Float32Array(MAX_SLOTS);
    const slY = new Float32Array(MAX_SLOTS);
    const slRank = new Float32Array(MAX_SLOTS);
    const slDist = new Float32Array(MAX_SLOTS);
    const slGroup = new Uint8Array(MAX_SLOTS);
    const slCol = new Uint8Array(MAX_SLOTS);
    const slDot = new Int16Array(MAX_SLOTS).fill(-1);
    const gates = new Float32Array(MAX_GROUPS);
    const barLvl = new Float32Array(MAX_GROUPS);
    let M = 0;
    let groups = 1;
    let isBars = false;
    const tX = new Float32Array(MAX_SLOTS);
    const tY = new Float32Array(MAX_SLOTS);
    const tRank = new Float32Array(MAX_SLOTS);
    const tGroup = new Uint8Array(MAX_SLOTS);
    const tCol = new Uint8Array(MAX_SLOTS);
    const mask = document.createElement('canvas');
    const mctx = mask.getContext('2d', { willReadFrequently: true })!;

    /* ── layout (units: the short side of the frame is 2) ── */
    let ax = 1;
    let ay = 1;
    let r = 0.023;
    let pitch = 0.048;
    let bw = 1;
    let bh = 1;
    let layAspect = -1;
    let laySize = -1;
    let layCrowd = -1;
    let sizeE = -1;
    let crowdE = -1;

    /* ── clocks and state of the whole crowd ── */
    const rnd = mulberry(20241);
    const isDrop = dropEdge();
    let beats = 0;
    let eE = -1;
    let buildE = 0;
    let gateBase = 0;
    let gate = 0;
    let dropHold = 0;
    let slamIn = -1;
    let kickAge = 9;
    let kickAmp = 0;
    let sinceKick = 9;
    let launchB = 0;
    let churnB = 0;
    let shapeId = '';
    let seqApplied = -999;
    let dropN = 0;
    let dropShape = false;
    let orbitOn = false;
    let orbitSpeed = 0;
    let cursor = 0;
    const bandE = new Float32Array(6);

    /* ───────────── strokes ───────────── */

    const releaseStroke = (id: number, fade: number) => {
      if (id < 0) return;
      sOwner[id] = -1;
      sFade[id] = fade;
    };
    const allocStroke = (i: number, comet: boolean) => {
      // the lowest free id (the scan restarts every frame), so only the live range has to be drawn
      while (sNext < STROKES && sLife[sNext] > 0) sNext++;
      let id = sNext;
      if (id >= STROKES) {
        id = sSteal;
        sSteal = (sSteal + 1) % STROKES;
      }
      const prev = sOwner[id];
      if (prev >= 0) {
        if (stroke[prev] === id) stroke[prev] = -1;
        if (stroke2[prev] === id) stroke2[prev] = -1;
      }
      const c = i * 8;
      sA.set([curve[c], curve[c + 1], curve[c + 2], curve[c + 3]], id * 4);
      sB.set([curve[c + 4], curve[c + 5], curve[c + 6], curve[c + 7]], id * 4);
      sS[id * 4] = 0;
      sS[id * 4 + 1] = 0;
      sS[id * 4 + 2] = 0;
      sS[id * 4 + 3] = col[i];
      sT[id * 2] = 0;
      sT[id * 2 + 1] = comet ? 1 : 0;
      sLife[id] = 1;
      sFade[id] = 0;
      sOwner[id] = i;
      strokesDirty = true;
      return id;
    };
    const dropStrokes = (i: number, fade: number) => {
      releaseStroke(stroke[i], fade);
      releaseStroke(stroke2[i], fade);
      stroke[i] = -1;
      stroke2[i] = -1;
    };

    /* ───────────── flights ───────────── */

    let memory = 6;
    let bowAmt = 0.6;

    /** dot i sets off from where it is along the cubic bezier (c1, c2) to (tx, ty) */
    const begin = (i: number, c1x: number, c1y: number, c2x: number, c2y: number, tx: number, ty: number, dur: number, delay: number, ease: number, fade: number) => {
      dropStrokes(i, ffade[i] || 1 / memory);
      const c = i * 8;
      curve[c] = px[i];
      curve[c + 1] = py[i];
      curve[c + 2] = c1x;
      curve[c + 3] = c1y;
      curve[c + 4] = c2x;
      curve[c + 5] = c2y;
      curve[c + 6] = tx;
      curve[c + 7] = ty;
      state[i] = FLY;
      ft[i] = 0;
      fdur[i] = Math.max(0.05, dur);
      fdelay[i] = delay;
      fease[i] = ease;
      ffade[i] = fade;
      stroke[i] = allocStroke(i, false);
    };
    /** a flight that bows sideways by `bow` of its length; (sdx, sdy) is an optional direction to leave in, weighted by sw */
    const flyBow = (i: number, tx: number, ty: number, dur: number, delay: number, ease: number, fade: number, bow: number, sdx = 0, sdy = 0, sw = 0) => {
      const x = px[i];
      const y = py[i];
      const dx = tx - x;
      const dy = ty - y;
      const L = Math.hypot(dx, dy) || 1e-4;
      const ux = dx / L;
      const uy = dy / L;
      const side = bow * L;
      const ox = ux * (1 - sw) + sdx * sw;
      const oy = uy * (1 - sw) + sdy * sw;
      const ol = Math.hypot(ox, oy) || 1;
      begin(i, x + (ox / ol) * L * 0.36 - uy * side, y + (oy / ol) * L * 0.36 + ux * side, tx - ux * L * 0.34 - uy * side * 0.5, ty - uy * L * 0.34 + ux * side * 0.5, tx, ty, dur, delay, ease, fade);
    };
    /**
     * Between the queue and the shape a dot keeps to its own lane: the path is pulled toward the
     * hub its stretch of border shares, so traffic gathers into bundles that fan out at the shape,
     * and a dot going home retraces the line it came in on.
     */
    const flyLane = (i: number, tx: number, ty: number, home: boolean, dur: number, delay: number, ease: number, fade: number) => {
      const x = px[i];
      const y = py[i];
      const k = Math.min(1, bowAmt * 1.5);
      const gx = hubX[i];
      const gy = hubY[i];
      // the end at the shape leans 42% of the way to the hub, the end at the border goes for the hub itself
      const ax1 = x + (tx - x) / 3;
      const ay1 = y + (ty - y) / 3;
      const ax2 = x + ((tx - x) * 2) / 3;
      const ay2 = y + ((ty - y) * 2) / 3;
      const h1x = home ? x + (gx - x) * 0.42 : gx;
      const h1y = home ? y + (gy - y) * 0.42 : gy;
      const h2x = home ? gx : tx + (gx - tx) * 0.42;
      const h2y = home ? gy : ty + (gy - ty) * 0.42;
      begin(i, ax1 + (h1x - ax1) * k, ay1 + (h1y - ay1) * k, ax2 + (h2x - ax2) * k, ay2 + (h2y - ay2) * k, tx, ty, dur, delay, ease, fade);
    };
    /** sideways bow for a flight starting at (x, y): coherent over a stretch of the frame, plus a little of its own */
    const bowAt = (x: number, y: number, k = 1) => ((vnoise2(x * 1.3 + 7.1, y * 1.3 + 3.3) - 0.5) * 1.5 + (rnd() - 0.5) * 0.22) * bowAmt * k;

    const freeSlot = (i: number) => {
      const s = slot[i];
      if (s >= 0 && s < MAX_SLOTS && slDot[s] === i) slDot[s] = -1;
      slot[i] = -1;
    };

    /** one quarter-lap of the orbit: a bezier from where the dot is, round the next corner, to the next side's middle */
    const startHop = (i: number, first: boolean) => {
      const d = r * 1.6 + lane[i] * (r * 5.5 + buildE * 0.22);
      const hxL = ax - d;
      const hyL = ay - d;
      const x = px[i];
      const y = py[i];
      let q: number;
      let t0x: number;
      let t0y: number;
      if (first) {
        const th = Math.atan2(y / hyL, x / hxL);
        const qf = (((th / (Math.PI / 2)) % 4) + 4) % 4;
        q = (Math.floor(qf + 0.35) + 1) % 4;
        t0x = (-y * hxL) / hyL;
        t0y = (x * hyL) / hxL;
        const l = Math.hypot(t0x, t0y);
        if (l > 1e-4) {
          t0x /= l;
          t0y /= l;
        } else {
          t0x = 0;
          t0y = 1;
        }
        dropStrokes(i, 1 / memory);
      } else {
        t0x = TQX[oq[i]];
        t0y = TQY[oq[i]];
        q = (oq[i] + 1) % 4;
        releaseStroke(stroke2[i], 6);
        stroke2[i] = stroke[i];
        plen[i] = flen[i];
      }
      const mx = MQX[q] * hxL;
      const my = MQY[q] * hyL;
      const k = 0.94 - 0.2 * buildE;
      const dx = mx - x;
      const dy = my - y;
      const l1 = k * Math.abs(dx * t0x + dy * t0y);
      const l2 = k * Math.abs(dx * TQX[q] + dy * TQY[q]);
      const c = i * 8;
      curve[c] = x;
      curve[c + 1] = y;
      curve[c + 2] = x + t0x * l1;
      curve[c + 3] = y + t0y * l1;
      curve[c + 4] = mx - TQX[q] * l2;
      curve[c + 5] = my - TQY[q] * l2;
      curve[c + 6] = mx;
      curve[c + 7] = my;
      flen[i] = Math.max(0.05, (Math.hypot(dx, dy) + l1 + l2 + Math.hypot(curve[c + 4] - curve[c + 2], curve[c + 5] - curve[c + 3])) / 2);
      oq[i] = q;
      state[i] = ORBIT;
      if (first) ft[i] = 0;
      stroke[i] = allocStroke(i, true);
    };

    /** off the shape (or out of the orbit) and back to the queue, or into the orbit while a build is on */
    const sendHome = (i: number, dur: number, wander: boolean) => {
      freeSlot(i);
      if (orbitOn) {
        startHop(i, true);
        return;
      }
      flyLane(i, hx[i], hy[i], true, dur, 0, wander ? EASE_SOFT : EASE_IO, 1 / memory);
    };

    /** the nearest waiting dot of ink c to the cursor (any ink if none of that one is waiting) */
    const pickHome = (c: number, at: number) => {
      let any = -1;
      for (let k = 0; k < n; k++) {
        const off = k & 1 ? (k + 1) >> 1 : -(k >> 1);
        const i = (((at + off) % n) + n) % n;
        if (state[i] !== HOME) continue;
        if (col[i] === c) return i;
        if (any < 0) any = i;
      }
      return any;
    };

    const wants = (s: number, slack: number) => slRank[s] < gates[slGroup[s]] + slack;

    /* ───────────── layout: sizes and the queue along the border ───────────── */

    const layout = (aspect: number, size: number, crowd: number) => {
      layAspect = aspect;
      laySize = size;
      layCrowd = crowd;
      ax = Math.max(1, aspect);
      ay = Math.max(1, 1 / aspect);
      r = size * 2;
      pitch = r * 2 * 1.04;
      const margin = Math.max(0.3, r * 10);
      bw = (ax - margin) * 2;
      bh = (ay - margin) * 2;
      // as many dots as the frame can use: the shape takes about four fifths of them
      const room = (bw * bh * 0.4) / (pitch * pitch * 0.866) / 0.8;
      n = Math.max(60, Math.min(MAX_DOTS, Math.round(Math.min(crowd, room))));

      // candidate places: rows running round the frame, kept where a noise says "queue here"
      const rng = mulberry(977);
      const cand: { x: number; y: number; nx: number; ny: number; s: number; score: number }[] = [];
      for (let j = 0; j < 5; j++) {
        const inset = r * 1.35 + j * pitch * 0.88;
        const w = ax - inset;
        const h = ay - inset;
        if (w < pitch || h < pitch) break;
        const per = 4 * (w + h);
        const cnt = Math.floor(per / pitch);
        for (let k = 0; k < cnt; k++) {
          let dd = ((k + (j % 2) * 0.5) / cnt) * per;
          const s = dd / per;
          let x: number;
          let y: number;
          let nx = 0;
          let ny = 0;
          let corner: number;
          if (dd < 2 * w) {
            x = -w + dd;
            y = h;
            ny = -1;
            corner = Math.min(dd, 2 * w - dd);
          } else if ((dd -= 2 * w) < 2 * h) {
            x = w;
            y = h - dd;
            nx = -1;
            corner = Math.min(dd, 2 * h - dd);
          } else if ((dd -= 2 * h) < 2 * w) {
            x = w - dd;
            y = -h;
            ny = 1;
            corner = Math.min(dd, 2 * w - dd);
          } else {
            dd -= 2 * w;
            x = -w;
            y = -h + dd;
            nx = 1;
            corner = Math.min(dd, 2 * h - dd);
          }
          const s1 = s * 26;
          const f = s1 - Math.floor(s1);
          const u = f * f * (3 - 2 * f);
          const wrap = (v: number) => hash2(((v % 26) + 26) % 26, 5.5);
          const queue = wrap(Math.floor(s1)) * (1 - u) + wrap(Math.floor(s1) + 1) * u;
          cand.push({ x, y, nx, ny, s, score: queue + Math.exp(-corner / 0.22) * 0.4 - j * 0.27 + rng() * 0.1 });
        }
      }
      cand.sort((p, q) => q.score - p.score);
      n = Math.min(n, cand.length);
      const homes = cand.slice(0, n).sort((p, q) => p.s - q.s);
      // inks in runs along the queue
      let run = 0;
      let ink = 0;
      for (let i = 0; i < n; i++) {
        if (run <= 0) {
          run = 3 + Math.floor(rng() * 10);
          let next = ink;
          for (let tries = 0; tries < 4 && next === ink; tries++) next = inkAt(rng());
          ink = next;
        }
        run--;
        const hm = homes[i];
        hx[i] = hm.x;
        hy[i] = hm.y;
        hnx[i] = hm.nx;
        hny[i] = hm.ny;
        hs[i] = hm.s;
        // lanes gather at eight hubs (four corners, four sides) between the border and the shape
        let bestD = 1e9;
        for (let h = 0; h < 8; h++) {
          const an = (h * Math.PI) / 4;
          const cxh = Math.round(Math.cos(an));
          const cyh = Math.round(Math.sin(an));
          const dd = Math.hypot(hm.x / ax - cxh, hm.y / ay - cyh);
          if (dd < bestD) {
            bestD = dd;
            const reach = cxh && cyh ? 0.66 : 0.6;
            hubX[i] = cxh * ax * reach + (rng() - 0.5) * 0.16;
            hubY[i] = cyh * ay * reach + (rng() - 0.5) * 0.16;
          }
        }
        ffade[i] = 0;
        col[i] = ink;
        lane[i] = rng();
        spd[i] = 0.8 + rng() * 0.45;
        thr[i] = rng();
        px[i] = hm.x;
        py[i] = hm.y;
        state[i] = HOME;
        slot[i] = -1;
        stroke[i] = -1;
        stroke2[i] = -1;
        pop[i] = 0;
        hole[i] = 0;
      }
      sLife.fill(0);
      sOwner.fill(-1);
      sS.fill(0);
      slDot.fill(-1);
      M = 0;
    };

    /* ───────────── shapes ───────────── */

    /** paints the glyphs into the mask and collects the hex-packed points inside them; returns how many */
    const raster = (items: Item[], scale: number) => {
      const S = 150; // mask px per unit
      const W = Math.max(8, Math.ceil(bw * S));
      const H = Math.max(8, Math.ceil(bh * S));
      mask.width = W;
      mask.height = H;
      mctx.clearRect(0, 0, W, H);
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.lineJoin = 'round';
      const k = items.length;
      const gap = pitch * 2.4;
      // side by side or stacked: whichever gives cells closest to a letter's proportions
      const rowA = (bw - gap * (k - 1)) / k / bh;
      const colA = bw / ((bh - gap * (k - 1)) / k);
      const inRow = Math.abs(Math.log(rowA / 0.72)) <= Math.abs(Math.log(colA / 0.72));
      const cw = (inRow ? (bw - gap * (k - 1)) / k : bw) * scale;
      const ch = (inRow ? bh : (bh - gap * (k - 1)) / k) * scale;
      const cx: number[] = [];
      const cy: number[] = [];
      for (let e = 0; e < k; e++) {
        const o = (e - (k - 1) / 2) * ((inRow ? cw : ch) + gap * scale);
        cx.push(inRow ? o : 0);
        cy.push(inRow ? 0 : -o);
        mctx.save();
        mctx.translate((cx[e] + bw / 2) * S, (bh / 2 - cy[e]) * S);
        const it = items[e];
        let drawn = false;
        if (it.ch) {
          mctx.font = `900 200px ${FONT_SANS}`;
          const m = mctx.measureText(it.ch);
          const gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
          const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
          if (gw > 2 && gh > 2) {
            // stretch the letter toward its cell (tall, condensed poster type), within reason
            let sx = (cw * S) / gw;
            let sy = (ch * S) / gh;
            if (sx > sy * 1.5) sx = sy * 1.5;
            if (sy > sx * 1.8) sy = sx * 1.8;
            mctx.scale(sx, sy);
            const x0 = -(m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
            const y0 = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
            mctx.lineWidth = (pitch * 0.5 * S) / Math.max(sx, sy);
            mctx.fillText(it.ch, x0, y0);
            mctx.strokeText(it.ch, x0, y0);
            drawn = true;
          }
        }
        if (!drawn) {
          const base = Math.min(cw, ch) / 2;
          mctx.scale(Math.min(cw / 2, base * 1.3) * S, Math.min(ch / 2, base * 1.45) * S);
          iconPath(mctx, it.icon ?? 'disc');
          mctx.fill('evenodd');
        }
        mctx.restore();
      }
      const data = mctx.getImageData(0, 0, W, H).data;
      const inside = (x: number, y: number) => {
        const u = Math.floor((x + bw / 2) * S);
        const v = Math.floor((bh / 2 - y) * S);
        return u >= 0 && v >= 0 && u < W && v < H && data[(v * W + u) * 4 + 3] > 110;
      };
      const rowH = pitch * 0.866;
      const jm = Math.floor(bh / 2 / rowH);
      const im = Math.ceil(bw / 2 / pitch) + 1;
      let cnt = 0;
      for (let j = -jm; j <= jm; j++) {
        const y = j * rowH;
        const xo = j & 1 ? pitch / 2 : 0;
        for (let i = -im; i <= im; i++) {
          const x = i * pitch + xo;
          if (!inside(x, y)) continue;
          if (cnt >= MAX_SLOTS) return cnt + 1;
          let edge = false;
          for (let e = 0; e < 6 && !edge; e++) edge = !inside(x + Math.cos((e * Math.PI) / 3) * pitch, y + Math.sin((e * Math.PI) / 3) * pitch);
          let g = 0;
          let best = 1e9;
          for (let e = 0; e < k; e++) {
            const dd = Math.abs(inRow ? x - cx[e] : y - cy[e]);
            if (dd < best) {
              best = dd;
              g = e;
            }
          }
          tX[cnt] = x;
          tY[cnt] = y;
          tRank[cnt] = edge ? 1 : 0;
          tGroup[cnt] = g;
          cnt++;
        }
      }
      return cnt;
    };

    /** the spectrum as fat bars: columns of slots that open from the middle line outward */
    const rasterBars = () => {
      const period = pitch * 5;
      const nb = Math.max(3, Math.min(MAX_GROUPS, Math.floor((bw + pitch * 2) / period)));
      const x0 = -(nb * period - pitch * 2) / 2;
      const rowH = pitch * 0.866;
      // not taller than the crowd could ever fill
      const jm = Math.max(3, Math.min(Math.floor(bh / 2 / rowH), Math.floor((n * 1.25) / (nb * 3 * 2))));
      let cnt = 0;
      for (let j = -jm; j <= jm; j++) {
        const xo = j & 1 ? pitch / 2 : 0;
        for (let b = 0; b < nb; b++)
          for (let e = 0; e < 3 && cnt < MAX_SLOTS; e++) {
            tX[cnt] = x0 + b * period + e * pitch + xo;
            tY[cnt] = j * rowH;
            tRank[cnt] = (Math.abs(j) + 0.5 * hash2(b * 3 + e, j)) / (jm + 1);
            tGroup[cnt] = b;
            cnt++;
          }
      }
      groups = nb;
      return cnt;
    };

    const buildShape = (items: Item[] | null, capFrac: number, seed: number) => {
      const rng = mulberry(seed);
      let cnt = 0;
      isBars = !items;
      if (!items) cnt = rasterBars();
      else {
        groups = items.length;
        const cap = Math.max(20, Math.floor(n * capFrac));
        let scale = 1;
        for (let pass = 0; pass < 5; pass++) {
          cnt = raster(items, scale);
          if (cnt <= cap) break;
          scale *= Math.sqrt(cap / cnt) * 0.985;
        }
        cnt = Math.min(cnt, MAX_SLOTS);
      }
      // inks sit in loose bands across the shape, with a few strays
      const phi = rng() * Math.PI;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      const off = rng() * 10;
      const ns = rng() * 40;
      // the inside fills as a front sweeping through each glyph (mostly upward), in patches
      const sweep = Math.PI / 2 + (rng() - 0.5) * 1.8;
      const wx = Math.cos(sweep);
      const wy = Math.sin(sweep);
      const lo = new Float32Array(MAX_GROUPS).fill(1e9);
      const hi = new Float32Array(MAX_GROUPS).fill(-1e9);
      for (let s = 0; s < cnt; s++) {
        const pr = tX[s] * wx + tY[s] * wy;
        lo[tGroup[s]] = Math.min(lo[tGroup[s]], pr);
        hi[tGroup[s]] = Math.max(hi[tGroup[s]], pr);
      }
      for (let s = 0; s < cnt; s++) {
        const x = tX[s];
        const y = tY[s];
        if (items) {
          // outline first, then the inside: a quiet song shows the shape as a dotted ghost
          const g = tGroup[s];
          const front = (x * wx + y * wy - lo[g]) / Math.max(1e-3, hi[g] - lo[g]);
          tRank[s] = tRank[s] > 0.5 ? rng() * 0.36 : 0.2 + 0.77 * Math.min(1, Math.max(0, front * 0.7 + vnoise2(x * 5 + ns, y * 5) * 0.3 + (rng() - 0.5) * 0.05));
          const v = (x * cs + y * sn) / (pitch * 34) + vnoise2(x * 1.9 + ns, y * 1.9 + ns) * 0.55 + off + tGroup[s] * 0.31;
          const f = v - Math.floor(v);
          tCol[s] = rng() < 0.14 ? inkAt(rng()) : inkAt(Math.abs(f * 2 - 1) * 0.999);
        } else {
          // bars: hot in the middle, cool at the tips, like a level meter printed in six inks
          tCol[s] = rng() < 0.08 ? inkAt(rng()) : inkAt(Math.min(0.999, tRank[s] * 1.05 + (rng() - 0.5) * 0.12 + 0.02));
        }
      }
      const order = Array.from({ length: cnt }, (_, i) => i).sort((p, q) => tRank[p] - tRank[q]);
      M = cnt;
      for (let s = 0; s < cnt; s++) {
        const o = order[s];
        slX[s] = tX[o];
        slY[s] = tY[o];
        slRank[s] = tRank[o];
        slGroup[s] = tGroup[o];
        slCol[s] = tCol[o];
        slDist[s] = Math.hypot(tX[o], tY[o]);
      }
    };

    /**
     * Hands the new shape's open slots to dots. 'instant' seats them (first frame, resize),
     * 'morph' flies the dots already in the old shape across to the new one, 'slam' takes every
     * dot from wherever it is.
     */
    const retarget = (mode: 'instant' | 'morph' | 'slam', bps: number) => {
      const pool: number[][] = [[], [], [], [], [], []];
      for (let i = 0; i < n; i++) {
        const engaged = slot[i] >= 0;
        slot[i] = -1;
        if (mode === 'slam' || engaged || (mode === 'instant' && state[i] === HOME)) pool[col[i]].push(i);
      }
      slDot.fill(-1);
      // deal from a shuffled hand so neighbours in the queue do not all land side by side
      for (const list of pool)
        for (let k = list.length - 1; k > 0; k--) {
          const j = Math.floor(rnd() * (k + 1));
          const tmp = list[k];
          list[k] = list[j];
          list[j] = tmp;
        }
      for (let s = 0; s < M; s++) {
        if (!wants(s, 0)) continue;
        let list = pool[slCol[s]];
        if (!list.length) {
          list = pool[0];
          for (const l of pool) if (l.length > list.length) list = l;
          if (!list.length) break;
        }
        const i = list.pop()!;
        slDot[s] = i;
        slot[i] = s;
        if (mode === 'instant') {
          state[i] = DOCK;
          px[i] = slX[s];
          py[i] = slY[s];
        } else if (mode === 'slam') {
          // peel off the orbit along its direction of travel, or straight off the border
          let sdx = hnx[i];
          let sdy = hny[i];
          let sw = 0.55;
          if (state[i] === ORBIT) {
            const hxL = ax - r * 4;
            const hyL = ay - r * 4;
            sdx = (-py[i] * hxL) / hyL;
            sdy = (px[i] * hyL) / hxL;
            const l = Math.hypot(sdx, sdy) || 1;
            sdx /= l;
            sdy /= l;
            sw = 0.8;
          } else if (state[i] !== HOME) sw = 0;
          flyBow(i, slX[s], slY[s], 0.26 + rnd() * 0.16, rnd() * 0.1, EASE_IN, 1 / Math.min(memory, 3.5), bowAt(px[i], py[i], 0.5), sdx, sdy, sw);
        } else {
          flyBow(i, slX[s], slY[s], (0.9 + rnd() * 0.5) / Math.max(1.2, bps), rnd() * 0.22, EASE_OUT, 1 / Math.min(memory, 1.6), bowAt(px[i], py[i], 1.2));
        }
      }
      if (mode === 'instant') return;
      // whoever did not get a place goes back to the queue
      for (const list of pool)
        for (const i of list) {
          if (state[i] === HOME) continue;
          if (mode === 'slam') flyBow(i, hx[i], hy[i], 0.3 + rnd() * 0.25, rnd() * 0.1, EASE_OUT, 1 / Math.min(memory, 2), bowAt(px[i], py[i], 0.6));
          else sendHome(i, 0.8 + rnd() * 0.5, false);
        }
    };

    /** where we are in the song, counted in shapes: sections and phrases of `phrase` bars */
    const seqIndex = (frame: FrameContext, bps: number, phrase: number) => {
      const per = phrase * 4;
      const secs = frame.analysis?.sections;
      const t = frame.audio.time;
      if (!secs?.length) return Math.floor(((frame.audio.playing ? t : 0) * bps) / per + 1e-3);
      const at = Math.max(0, sectionIndex(frame));
      let k = 0;
      for (let i = 0; i < at; i++) k += Math.max(1, Math.round(((secs[i].end - secs[i].start) * bps) / per));
      const mine = Math.max(1, Math.round(((secs[at].end - secs[at].start) * bps) / per));
      return k + Math.min(mine - 1, Math.max(0, Math.floor(((t - secs[at].start) * bps) / per + 1e-3)));
    };

    /** which glyphs to show for shape number k */
    const specFor = (modeSel: string, title: string, k: number, drop: boolean): { items: Item[] | null; id: string } => {
      if (modeSel === 'spectrum') return { items: null, id: 'bars' };
      const wide = ax / ay >= 1.45;
      if (drop && modeSel !== 'letters') {
        const icon = DROP_ICONS[(dropN + DROP_ICONS.length - 1) % DROP_ICONS.length];
        return { items: [{ icon }], id: `drop-${icon}-${dropN}` };
      }
      const chunks = modeSel === 'glyphs' ? [] : titleWords(title, wide ? 3 : 2);
      const L = chunks.length;
      const period = modeSel === 'letters' && L ? L : L + 1;
      const at = ((k % period) + period) % period;
      if (at < L) return { items: chunks[at].map((ch) => ({ ch })), id: `t${at}-${chunks[at].join('')}` };
      const set = ICON_SETS[((Math.floor(k / period) % ICON_SETS.length) + ICON_SETS.length) % ICON_SETS.length];
      return { items: set.slice(0, wide ? 3 : 2).map((icon) => ({ icon })), id: `i-${set.join('')}-${wide ? 3 : 2}` };
    };

    /* ───────────── the frame ───────────── */

    const setInks = (frame: FrameContext, count: number) => {
      const c = frame.palette.c;
      inkBase[0].copy(c.accent);
      inkBase[1].copy(c.fg);
      inkBase[2].copy(c.accent2);
      inkBase[3].copy(c.muted);
      inkBase[4].copy(c.accent).lerp(c.fg, 0.5);
      inkBase[5].copy(c.fg).lerp(c.accent2, 0.5);
      for (let k = 0; k < 6; k++) {
        const ink = inkBase[k];
        if (k >= 4) {
          // a mix of two inks goes grey; push it back out so it reads as a colour of its own
          const l = ink.r * 0.2126 + ink.g * 0.7152 + ink.b * 0.0722;
          ink.setRGB(Math.min(1, Math.max(0, l + (ink.r - l) * 1.25)), Math.min(1, Math.max(0, l + (ink.g - l) * 1.25)), Math.min(1, Math.max(0, l + (ink.b - l) * 1.25)));
        }
        // an ink that would vanish into the background borrows from fg
        const dist = Math.hypot(ink.r - c.bg.r, ink.g - c.bg.g, ink.b - c.bg.b);
        if (dist < 0.4) ink.lerp(c.fg, Math.min(0.75, ((0.4 - dist) / 0.4) * 0.9));
      }
      for (let k = 0; k < 6; k++) inks[k].copy(inkBase[k % count]);
    };

    const update = (frame: FrameContext) => {
      const dt = stepDt(frame);
      const a = frame.audio;
      const p = frame.params;
      const short = Math.min(frame.width, frame.height);
      const bps = beatsPerSecond(frame);
      const beatLen = Math.min(0.85, Math.max(0.3, 1 / Math.max(0.1, a.bpm > 0 ? a.bpm / 60 : 1.8)));
      const traffic = num(p, 'traffic', 0.5);
      const popAmt = num(p, 'pop', 0.6);
      memory = Math.max(0.3, num(p, 'memory', 6));
      bowAmt = num(p, 'curve', 0.6);
      bg.copy(frame.palette.c.bg);
      setInks(frame, Math.round(Math.min(6, Math.max(2, num(p, 'inks', 6)))));

      /* layout: packing follows the frame and (slowly) the size and crowd settings */
      const sizeP = Math.min(0.03, Math.max(0.004, num(p, 'size', 0.012)));
      const crowdP = num(p, 'crowd', 840);
      const first = layAspect < 0;
      sizeE = first ? sizeP : approach(sizeE, sizeP, 1.5, dt);
      crowdE = first ? crowdP : approach(crowdE, crowdP, 1.5, dt);
      const relaid = first || Math.abs(frame.aspect - layAspect) > 1e-3 || Math.abs(sizeE - laySize) / laySize > 0.04 || Math.abs(crowdE - layCrowd) > 30;
      if (relaid) layout(frame.aspect, sizeE, crowdE);
      uHalf.set(ax, ay);
      const pxu = short / 2;
      dotMat.uniforms.uPxU.value = pxu;
      dotMat.uniforms.uR.value = r * Math.min(1.3, Math.max(0.6, sizeP / laySize));
      lineMat.uniforms.uPxU.value = pxu;
      const halfW = (num(p, 'weight', 1.8) * short) / 1080 / 2;
      lineMat.uniforms.uW.value = Math.max(0.5, halfW);
      lineMat.uniforms.uCover.value = Math.min(1, halfW / 0.5) * 0.92;

      /* clocks */
      beats += dt * bps;
      eE = eE < 0 ? a.energy : approach(eE, a.energy, 1.4, dt);
      buildE = approach(buildE, Math.max(a.build, frame.feel.tension) * (a.drop > 0.5 ? 0 : 1), 8, dt);
      kickAge += dt;
      sinceKick += dt;
      dropHold = Math.max(0, dropHold - dt);
      const drop = isDrop(frame);
      if (drop) {
        dropHold = 3;
        buildE = 0;
      }
      orbitOn = buildE > 0.03 && dropHold <= 0;
      orbitSpeed = (0.55 + 5.2 * buildE * buildE) * (1 + 0.55 * a.snare) * (0.75 + 0.5 * bowAmt);

      /* how full the shape wants to be: energy opens it, a build drains it, a drop fills it at once */
      const want = 0.2 + 0.8 * Math.pow(smooth(0.1, 0.7, eE), 0.85);
      if (first || relaid || dropHold > 0) gateBase = dropHold > 0 ? 1 : want;
      else gateBase = approach(gateBase, want, want > gateBase ? 2.5 : 0.45, dt);
      gate = gateBase * (1 - smooth(0.03, 0.5, buildE));

      /* which shape */
      const modeSel = str(p, 'shapes', 'auto');
      const title = songInfo().title;
      const seq = seqIndex(frame, bps, Math.max(1, Math.round(num(p, 'phrase', 8))));
      if (drop) {
        dropN++;
        dropShape = true;
        seqApplied = seq;
      } else if (seq !== seqApplied) {
        // a section boundary a moment either side of the drop belongs to the drop
        if (dropHold <= 0) dropShape = false;
        seqApplied = seq;
      }
      const spec = specFor(modeSel, title, seq, dropShape);
      const newShape = spec.id !== shapeId || relaid;
      if (newShape) {
        shapeId = spec.id;
        let seed = 7;
        for (let k = 0; k < spec.id.length; k++) seed = (seed * 31 + spec.id.charCodeAt(k)) >>> 0;
        buildShape(spec.items, dropShape ? 0.9 : 0.8, seed);
      }

      /* gates: one for the whole shape, or one per bar from the spectrum */
      if (isBars) {
        for (let b = 0; b < groups; b++) {
          const x = (b + 0.5) / groups;
          const bin = Math.min(124, Math.floor(2 + x * 112));
          const v = Math.min(1, ((a.spectrum[bin] + a.spectrum[bin + 1] + a.spectrum[bin + 2]) / 3) * (1.25 + x * 1.2));
          barLvl[b] = approach(barLvl[b], v, v > barLvl[b] ? 16 : 5, dt);
          gates[b] = (0.07 + 0.93 * Math.pow(barLvl[b], 0.8)) * (0.25 + 0.75 * gate) * (gate > 0.02 ? 1 : 0);
        }
      } else for (let g = 0; g < MAX_GROUPS; g++) gates[g] = gate;

      if (newShape) retarget(first || relaid ? 'instant' : drop ? 'slam' : 'morph', bps);
      else if (drop) retarget('slam', bps);
      if (drop) {
        slamIn = 0.36;
        launchB = 0;
        churnB = 0;
      }
      // the crowd lands: one big ripple through the new shape
      if (slamIn > 0) {
        slamIn -= dt;
        if (slamIn <= 0) {
          kickAge = 0;
          kickAmp = 2.2;
        }
      }

      /* hits */
      if (a.kickHit) {
        sinceKick = 0;
        if (slamIn <= 0) {
          kickAge = 0;
          kickAmp = 0.6 + 0.6 * Math.min(1, a.kick);
        }
        launchB += n * (0.016 + 0.05 * traffic) * (0.6 + 0.6 * Math.min(1, a.kick));
        if (dropHold < 2.4) churnB += n * traffic * 0.034 * (0.25 + eE);
        cursor = Math.floor(rnd() * n);
      } else if (a.beat && sinceKick > 1.2 && a.playing) {
        // no kick drum in this stretch: the beat still moves a few
        launchB += n * (0.008 + 0.02 * traffic);
        cursor = Math.floor(rnd() * n);
      }
      launchB = Math.min(launchB + dt * (0.9 + eE * 5) * (0.5 + traffic) * (isBars ? 14 : 1), n * 0.2);
      churnB = Math.min(churnB + dt * (0.45 + eE * traffic * 7), n * 0.1);

      if (a.snareHit && M > 4 && !orbitOn) {
        // snare: pairs of docked dots of different inks trade places
        const pairs = 1 + Math.round(M * 0.012 * (0.4 + traffic) * (0.5 + a.snare));
        for (let k = 0; k < pairs; k++) {
          const s1 = Math.floor(rnd() * M);
          const i1 = slDot[s1];
          if (i1 < 0 || state[i1] !== DOCK) continue;
          for (let tries = 0; tries < 10; tries++) {
            const s2 = Math.floor(rnd() * M);
            const i2 = slDot[s2];
            if (i2 < 0 || i2 === i1 || state[i2] !== DOCK || col[i2] === col[i1]) continue;
            const dd = Math.hypot(slX[s2] - slX[s1], slY[s2] - slY[s1]);
            if (dd < pitch * 1.5 || dd > pitch * 9) continue;
            slDot[s1] = i2;
            slDot[s2] = i1;
            slot[i1] = s2;
            slot[i2] = s1;
            const b = 0.5 + rnd() * 0.3;
            flyBow(i1, slX[s2], slY[s2], 0.24 + rnd() * 0.08, 0, EASE_OUT, 1.1, b);
            flyBow(i2, slX[s1], slY[s1], 0.24 + rnd() * 0.08, 0, EASE_OUT, 1.1, b);
            break;
          }
        }
      }
      if (a.hatHit) {
        // hats: short runs of the queue blink (the disc opens into a ring for an instant)
        const runs = 2 + Math.round(3 * a.hat);
        for (let k = 0; k < runs; k++) {
          let i = Math.floor(rnd() * n);
          let left = 3 + Math.floor(rnd() * 5);
          for (let scan = 0; scan < 50 && left > 0; scan++, i = (i + 1) % n)
            if (state[i] === HOME) {
              hole[i] = 1;
              left--;
            }
        }
      }

      /* build: the queue peels off into the orbit, more of it as the build climbs; otherwise orbiters go home */
      const orbitShare = smooth(0.03, 0.7, buildE);
      for (let i = 0; i < n; i++) {
        if (orbitOn) {
          if (state[i] === HOME && thr[i] < orbitShare) startHop(i, true);
        } else if (state[i] === ORBIT) {
          dropStrokes(i, 2.5);
          sendHome(i, 0.7 + rnd() * 0.7, true);
        }
      }

      /* dots whose place has closed leave; a few always trade places; open places get a dot from the queue */
      const calm = 1 - smooth(0.2, 0.6, eE);
      for (let s = M - 1; s >= 0; s--) {
        const i = slDot[s];
        if (i < 0 || state[i] !== DOCK || wants(s, isBars ? 0.1 : 0.02)) continue;
        sendHome(i, (0.7 + calm * 1.3) * (0.8 + rnd() * 0.5), calm > 0.3);
      }
      if (!orbitOn && !isBars && M > 0)
        while (churnB >= 1) {
          churnB -= 1;
          // someone docked gives up their place: a dot in the wrong ink for it if one turns up
          let pick = -1;
          for (let tries = 0; tries < 10; tries++) {
            const s = Math.floor(rnd() * M);
            const i = slDot[s];
            if (i < 0 || state[i] !== DOCK) continue;
            pick = i;
            if (col[i] !== slCol[s]) break;
          }
          if (pick >= 0) sendHome(pick, (0.65 + calm * 1.4) * (0.8 + rnd() * 0.5), calm > 0.5);
        }
      if (launchB >= 1 && !orbitOn) {
        const onKick = sinceKick < 0.05;
        let sent = 0;
        for (let s = 0; s < M && launchB >= 1; s++) {
          if (slDot[s] >= 0 || !wants(s, 0)) continue;
          if (sent % 9 === 8) cursor = Math.floor(rnd() * n);
          const i = pickHome(slCol[s], cursor + sent);
          if (i < 0) break;
          launchB -= 1;
          sent++;
          slDot[s] = i;
          slot[i] = s;
          // launched on a kick, it docks on the next one
          const dur = isBars ? 0.3 + rnd() * 0.15 : onKick ? beatLen * (0.9 + rnd() * 0.08) : (0.7 + calm * 1.0) * (0.85 + rnd() * 0.4);
          flyLane(i, slX[s], slY[s], false, dur, onKick ? rnd() * 0.03 : 0, calm > 0.5 && !onKick ? EASE_SOFT : EASE_IO, 1 / memory);
        }
      }

      /* each ink listens to its own band */
      const bands = [a.bass, a.mid, a.air, a.sub, a.lowMid, a.highMid];
      let mean = 0;
      for (let k = 0; k < 6; k++) {
        bandE[k] = approach(bandE[k], bands[k], 18, dt);
        mean += bandE[k] / 6;
      }

      /* move every dot */
      const wave = (beats / 16) % 1; // a little wave runs round the queue once every four bars
      const waveAmp = r * (0.5 + 0.9 * eE);
      const tailU = 0.16 + orbitSpeed * 0.13;
      const kickSpread = 0.14; // s per unit: how fast a kick's ripple crosses the shape
      for (let i = 0; i < n; i++) {
        let scale = 1;
        const st = state[i];
        if (st === HOME) {
          let dw = Math.abs(hs[i] - wave);
          dw = Math.min(dw, 1 - dw);
          let dw2 = Math.abs(hs[i] - ((wave + 0.5) % 1));
          dw2 = Math.min(dw2, 1 - dw2);
          const lift = (Math.exp(-(dw * dw) / 0.00018) + Math.exp(-(dw2 * dw2) / 0.00018)) * waveAmp;
          px[i] = hx[i] + hnx[i] * lift;
          py[i] = hy[i] + hny[i] * lift;
        } else if (st === FLY) {
          if (fdelay[i] > 0) fdelay[i] -= dt;
          else {
            ft[i] = Math.min(1, ft[i] + dt / fdur[i]);
            const t = ft[i];
            let e: number;
            switch (fease[i]) {
              case EASE_IN:
                e = t * t * (0.4 + 0.6 * t);
                break;
              case EASE_SOFT:
                e = 0.5 - 0.5 * Math.cos(Math.PI * t);
                break;
              case EASE_OUT:
                e = 1 - (1 - t) * (1 - t) * (1 - t);
                break;
              default:
                e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            }
            const c = i * 8;
            const u = 1 - e;
            const b0 = u * u * u;
            const b1 = 3 * u * u * e;
            const b2 = 3 * u * e * e;
            const b3 = e * e * e;
            px[i] = b0 * curve[c] + b1 * curve[c + 2] + b2 * curve[c + 4] + b3 * curve[c + 6];
            py[i] = b0 * curve[c + 1] + b1 * curve[c + 3] + b2 * curve[c + 5] + b3 * curve[c + 7];
            const id = stroke[i];
            if (id >= 0) sS[id * 4 + 1] = e;
            if (t >= 1) {
              releaseStroke(id, ffade[i]);
              stroke[i] = -1;
              if (slot[i] >= 0) {
                state[i] = DOCK;
                pop[i] = fease[i] === EASE_IN ? 0.2 : 0.4;
              } else state[i] = HOME;
            }
          }
        } else if (st === DOCK) {
          const s = slot[i];
          px[i] = slX[s];
          py[i] = slY[s];
          const ph = kickAge - slDist[s] * kickSpread;
          const ripple = ph > 0 ? Math.exp(-ph * 9) * kickAmp : 0;
          scale = 1 + ripple * 0.24 * popAmt + Math.max(-0.2, Math.min(0.14, (bandE[col[i]] - mean) * 0.55 * popAmt));
        } else {
          // orbit: along this hop at the crowd's speed, a comet tail behind
          ft[i] += (dt * orbitSpeed * spd[i]) / flen[i];
          if (ft[i] >= 1) {
            const over = (ft[i] - 1) * flen[i];
            px[i] = curve[i * 8 + 6];
            py[i] = curve[i * 8 + 7];
            startHop(i, false);
            ft[i] = Math.min(0.9, over / flen[i]);
          }
          const e = ft[i];
          const c = i * 8;
          const u = 1 - e;
          const b0 = u * u * u;
          const b1 = 3 * u * u * e;
          const b2 = 3 * u * e * e;
          const b3 = e * e * e;
          px[i] = b0 * curve[c] + b1 * curve[c + 2] + b2 * curve[c + 4] + b3 * curve[c + 6];
          py[i] = b0 * curve[c + 1] + b1 * curve[c + 3] + b2 * curve[c + 5] + b3 * curve[c + 7];
          const lu = Math.min(1, tailU / flen[i]);
          const id = stroke[i];
          if (id >= 0) {
            sS[id * 4] = Math.max(0, e - lu);
            sS[id * 4 + 1] = e;
            sT[id * 2] = e - lu;
            sT[id * 2 + 1] = 1 / lu;
          }
          const id2 = stroke2[i];
          if (id2 >= 0) {
            const lu2 = Math.min(1, tailU / plen[i]);
            const back = 1 - (lu - e) * (flen[i] / plen[i]);
            if (e >= lu || back >= 1) {
              sLife[id2] = 0;
              sOwner[id2] = -1;
              stroke2[i] = -1;
            } else {
              sS[id2 * 4] = Math.max(0, back);
              sS[id2 * 4 + 1] = 1;
              sT[id2 * 2] = back;
              sT[id2 * 2 + 1] = 1 / lu2;
            }
          }
        }
        if (pop[i] > 0.001) {
          scale += pop[i];
          pop[i] *= Math.exp(-dt * 11);
        }
        if (hole[i] > 0) hole[i] = Math.max(0, hole[i] - dt * 6.5);
        const o = i * 4;
        dotData[o] = px[i];
        dotData[o + 1] = py[i];
        dotData[o + 2] = scale;
        dotData[o + 3] = col[i] + Math.min(1, hole[i] * 1.6) * 0.9;
      }
      dotGeo.instanceCount = n;
      dotAttr.needsUpdate = true;

      /* lines: released ones fade; owned ones stay at full strength */
      let live = 0;
      for (let id = 0; id < STROKES; id++) {
        let life = sLife[id];
        if (life <= 0) {
          sS[id * 4 + 2] = 0;
          continue;
        }
        live = id + 1;
        if (sOwner[id] < 0) {
          life = Math.max(0, life - sFade[id] * dt);
          sLife[id] = life;
        }
        sS[id * 4 + 2] = life * life * (3 - 2 * life);
      }
      lineGeo.instanceCount = live;
      sNext = 0;
      attrS.needsUpdate = true;
      attrT.needsUpdate = true;
      if (strokesDirty) {
        attrA.needsUpdate = true;
        attrB.needsUpdate = true;
        strokesDirty = false;
      }
    };

    return { scene, camera, update };
  },
});
