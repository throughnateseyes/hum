/**
 * Ribbon Type — a gig poster in motion. Fat flat-coloured ribbons snake through the frame in
 * straight runs and rounded turns over one bold ground colour, with heavy grotesque type running
 * along each of them: "TITLE × ARTIST", the line being sung, the section, tempo and time. The
 * ribbons lie on tilted planes at different depths under a shallow lens, so near ones are huge and
 * soft, far ones small and soft, and one runs through the focal plane, crisp, carrying the lyric.
 *
 * The type travels with the tempo and every kick shoves it forward; bass makes the ribbons breathe
 * and wobble; a snare sends a bulge down one ribbon that repaints it in the next colour; hats tick
 * the thin mono tickers along. Energy decides how many ribbons are on stage. A build crowds the
 * frame, pushes the camera in and opens the lens; the drop is a hard cut to a new poster (new
 * layout, new camera, a new ground colour) with every ribbon whipping in at once.
 *
 * Palette roles: bg = the ground, fg = the type ink (and the thin ink-coloured tickers),
 * accent / accent2 / muted = the three ribbon colours. On a drop the ground trades places with
 * one of the ribbon colours and bg becomes a ribbon colour until the song calms down again.
 */
import * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { bool, num } from '../../core/uniforms';
import { approach, beatsPerSecond, Spring, stepDt } from '../three/common';
import { currentLyric, dropEdge, fmtClock, FONT_MONO, FONT_SANS, sectionIndex, songInfo } from '../three/songInfo';

const MAXR = 8; // ribbons in the pool
const MAXN = 460; // cross-sections per ribbon
const FOV = 30;
const CAM_D = 1 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)); // the focal plane (z = 0) is 2 units tall
const INK = 4; // colour index of the fg ink (0 bg, 1 accent, 2 accent2, 3 muted)
const TAU = Math.PI * 2;

const params: ParamDef[] = [
  { id: 'width', label: 'Ribbon width', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
  { id: 'count', label: 'Ribbons', group: 'Shape', type: 'number', min: 0.3, max: 1.5, step: 0.01, default: 1, hint: 'How crowded the stage is. The song still adds and removes ribbons with its energy' },
  { id: 'type', label: 'Type size', group: 'Shape', type: 'number', min: 0.5, max: 1.2, step: 0.01, default: 0.86, hint: 'Height of the letters against the ribbon' },
  { id: 'blur', label: 'Depth blur', group: 'Shape', type: 'number', min: 0, max: 2.5, step: 0.01, default: 1, hint: 'How soft the ribbons in front of and behind the focal plane get' },
  { id: 'speed', label: 'Type speed', group: 'Motion', type: 'number', min: 0, max: 3, step: 0.01, default: 1, hint: 'Ribbon widths per beat, before the song speeds it up' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'wave', label: 'Bass wobble', group: 'Reactivity', type: 'number', min: 0, max: 2.5, step: 0.01, default: 1 },
  { id: 'kick', label: 'Kick shove', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far a kick pushes the type along' },
  { id: 'snare', label: 'Snare repaint', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Share of snares that send a colour change down a ribbon' },
  { id: 'ground', label: 'New ground on drops', group: 'Color', type: 'bool', default: true, hint: 'A drop swaps the ground with one of the ribbon colours until the song calms down' },
];

/* ───────────────────────── shaders ───────────────────────── */

const VERT = /* glsl */ `
attribute vec4 aData; // arc length, signed distance from the centre line, in-plane normal
attribute float aQ; // distance from the centre of the turn (1 on straights)
uniform float uWaveAmp, uWaveK, uWavePhase;
varying float vSq;
varying float vQ;
varying float vAcross;
varying float vDepth;
void main() {
  float s = aData.x;
  float wv = sin(s * uWaveK - uWavePhase) * 0.7 + sin(s * uWaveK * 0.41 + uWavePhase * 0.63 + 1.7) * 0.3;
  vec3 p = position;
  p.xy += aData.zw * wv * uWaveAmp;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // arc length is constant along a turn's spokes, which is not linear across a wedge: carry it
  // weighted by the radius and divide per pixel, or the type shears into a sawtooth in every corner
  vSq = s * aQ;
  vQ = aQ;
  vAcross = aData.y;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

// The mesh is wider than the ribbon; the edge is drawn here so it can go soft with defocus. The
// type texture holds slightly blurred coverage, read like a distance field: thresholded hard when
// in focus (crisp at any size), and averaged over a disc of taps when out of focus.
const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec3 uColA, uColB, uInkA, uInkB;
uniform float uHalfW, uTexLen, uTypeScale, uOffset, uSqueeze;
uniform float uHead, uTail, uFront, uBulge, uBulgeW;
uniform float uFocus, uAperture, uMaxBlur;
varying float vSq;
varying float vQ;
varying float vAcross;
varying float vDepth;

float rtTap(vec2 uv, float lod) {
  return textureLod(uTex, uv, lod).r * step(abs(uv.y - 0.5), 0.5);
}

void main() {
  float vS = vSq / vQ;
  float b = min(uAperture * abs(vDepth - uFocus), uMaxBlur);
  float aaA = fwidth(vAcross) * 0.7;
  float aaS = fwidth(vS) * 0.7;
  vec2 uv = vec2((vS + uOffset) / uTexLen, 0.5 + vAcross / (2.0 * uHalfW * uTypeScale * uSqueeze));
  vec2 fp = fwidth(uv) * uTexSize;

  float dS = vS - uFront;
  float hw = uHalfW * (1.0 + uBulge * exp(-(dS * dS) / (uBulgeW * uBulgeW)));
  float alpha = smoothstep(-(b + aaA), b + aaA, hw - abs(vAcross));
  alpha *= smoothstep(-(b + aaS), b + aaS, min(uHead - vS, vS - uTail));
  if (alpha < 0.004) discard;

  vec2 bUv = vec2(b / uTexLen, b / (2.0 * uHalfW * uTypeScale));
  float bTex = max(bUv.x * uTexSize.x, bUv.y * uTexSize.y);
  float fpx = max(fp.x, fp.y);
  float lod = log2(max(max(fpx, bTex * 0.8), 1.0));
  float c = rtTap(uv, lod);
  if (bTex > 1.0) {
    c *= 0.16;
    c += 0.12 * (rtTap(uv + bUv * vec2(0.0, 0.38), lod) + rtTap(uv + bUv * vec2(-0.329, -0.19), lod) + rtTap(uv + bUv * vec2(0.329, -0.19), lod));
    c += 0.096 * (rtTap(uv + bUv * vec2(0.47, 0.647), lod) + rtTap(uv + bUv * vec2(-0.47, 0.647), lod) + rtTap(uv + bUv * vec2(-0.761, -0.247), lod)
      + rtTap(uv + bUv * vec2(0.0, -0.8), lod) + rtTap(uv + bUv * vec2(0.761, -0.247), lod));
  }
  float wEdge = clamp(0.15 * max(fpx, bTex * 2.0), 0.035, 0.5);
  float ink = clamp((c - 0.5) / (2.0 * wEdge) + 0.5, 0.0, 1.0);

  // the snare's repaint: everything the front has passed wears the new colour
  float f = smoothstep(-(b + aaS), b + aaS, uFront - vS);
  vec3 col = mix(mix(uColA, uColB, f), mix(uInkA, uInkB, f), ink);
  gl_FragColor = vec4(col, alpha);
}
`;

/* ───────────────────────── layout ───────────────────────── */

type Pt = [number, number];
type Role = 'lyric' | 'title' | 'artist' | 'mood' | 'facts';
type Kind = 'step' | 'cee' | 'ell' | 'band' | 'zed' | 'hairU' | 'hairS' | 'hairN' | 'ring';

interface Ring {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  dir: number;
}
interface Shape {
  pts: Pt[];
  ring: Ring | null;
  /** middle of the run the eye should land on (in-plane) */
  anchor: Pt;
}
interface Spec extends Shape {
  /** centre-line corner radius */
  R: number;
  halfW: number;
  z: number;
  tiltX: number;
  tiltY: number;
  rotZ: number;
  role: Role;
  color: number;
  /** signed type speed multiplier */
  speed: number;
  /** half extents of the frame at this ribbon's depth */
  hx: number;
  hy: number;
}

// where each pool slot sits in depth, and what it may be. Slot 0 runs through the focal plane.
const SLOTS: { z: [number, number]; thin: boolean; role: Role; kinds: Kind[] }[] = [
  { z: [0, 0], thin: false, role: 'lyric', kinds: ['step', 'cee', 'ell', 'band', 'zed', 'step'] },
  { z: [0.95, 1.35], thin: false, role: 'artist', kinds: ['ring', 'hairU', 'band', 'ell', 'hairN', 'ring'] },
  { z: [-1.9, -1.0], thin: false, role: 'title', kinds: ['hairS', 'cee', 'zed', 'hairN', 'step', 'ring', 'band'] },
  { z: [-0.45, -0.12], thin: true, role: 'facts', kinds: ['band', 'ell', 'step', 'hairU'] },
  { z: [-3.0, -2.2], thin: false, role: 'lyric', kinds: ['band', 'cee', 'hairS', 'step', 'zed'] },
  { z: [0.4, 0.75], thin: false, role: 'mood', kinds: ['ell', 'band', 'hairU', 'ring', 'hairN'] },
  { z: [-0.95, -0.55], thin: true, role: 'mood', kinds: ['band', 'cee', 'hairS', 'ell'] },
  { z: [1.4, 1.75], thin: false, role: 'title', kinds: ['ring', 'band', 'ell'] },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** one ribbon gesture in template space: u runs across (half extent hu), v up (half extent hv) */
function makeShape(kind: Kind, hu: number, hv: number, w: number, R: number, r: (a: number, b: number) => number, focus: boolean): Shape {
  const X = hu * 1.9 + 4 * w; // well outside the frame
  const Y = hv * 1.9 + 4 * w;
  switch (kind) {
    case 'step': {
      const v0 = r(0.25, 0.72) * hv;
      const v1 = -r(0.25, 0.72) * hv;
      const u1 = r(-0.5, 0.5) * hu;
      return { pts: [[-X, v0], [u1, v0], [u1, v1], [X, v1]], ring: null, anchor: u1 > 0 ? [(u1 - hu) / 2, v0] : [(u1 + hu) / 2, v1] };
    }
    case 'cee': {
      const v0 = r(0.2, 0.7) * hv;
      const v1 = -r(0.3, 0.8) * hv;
      const u1 = r(0.2, 0.78) * hu;
      return { pts: [[-X, v0], [u1, v0], [u1, v1], [-X, v1]], ring: null, anchor: [(u1 - hu) / 2, v0] };
    }
    case 'ell': {
      const v0 = r(-0.1, 0.7) * hv;
      const u1 = r(-0.1, 0.75) * hu;
      return { pts: [[-X, v0], [u1, v0], [u1, -Y]], ring: null, anchor: [(u1 - hu) / 2, v0] };
    }
    case 'zed': {
      const v0 = r(0.3, 0.75) * hv;
      const v1 = -r(0.3, 0.75) * hv;
      const dv = v0 - v1;
      const back = r(0, 1) < 0.6;
      const u1 = back ? r(0.15, 0.75) * hu : r(-0.75, -0.1) * hu;
      const u2 = back ? u1 - dv : u1 + dv;
      return { pts: [[-X, v0], [u1, v0], [u2, v1], [X, v1]], ring: null, anchor: u1 + hu > hu - u2 ? [(u1 - hu) / 2, v0] : [(u2 + hu) / 2, v1] };
    }
    case 'band': {
      const pick = Math.floor(r(0, 5));
      const ang = focus ? r(-0.14, 0.14) : [r(-0.08, 0.08), r(0.28, 0.55), -r(0.28, 0.55), Math.PI / 4, -Math.PI / 4][pick];
      const p: Pt = [r(-0.4, 0.4) * hu, r(-0.6, 0.6) * hv];
      const L = X + Y;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      return { pts: [[p[0] - dx * L, p[1] - dy * L], [p[0] + dx * L, p[1] + dy * L]], ring: null, anchor: p };
    }
    case 'hairU':
    case 'hairS':
    case 'hairN': {
      const sg = r(0, 1) < 0.5 ? -1 : 1;
      const g = 2 * R * sg;
      const u0 = r(-0.7, 0.7) * hu;
      const v1 = -r(0.15, 0.75) * hv;
      const anchor: Pt = [u0, (hv + v1) / 2];
      if (kind === 'hairU') return { pts: [[u0, Y], [u0, v1], [u0 + g, v1], [u0 + g, Y]], ring: null, anchor };
      const v2 = Math.max(v1 + 2.4 * R, r(0.05, 0.7) * hv);
      if (kind === 'hairS') return { pts: [[u0, Y], [u0, v1], [u0 + g, v1], [u0 + g, v2], [u0 + 2 * g, v2], [u0 + 2 * g, -Y]], ring: null, anchor };
      return { pts: [[u0, Y], [u0, v1], [u0 + g, v1], [u0 + g, v2], [u0 + g + sg * (v2 + Y), -Y]], ring: null, anchor };
    }
    case 'ring': {
      const rad = r(0.55, 1.0) * Math.sqrt(hu * hv) * 0.85;
      const cu = r(-0.75, 0.75) * hu;
      const cv = hv * r(0.75, 1.15);
      return { pts: [], ring: { cx: cu, cy: cv, r: rad, a0: 0, dir: r(0, 1) < 0.5 ? -1 : 1 }, anchor: [cu, cv - rad] };
    }
  }
}

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};

/** a whole poster: eight ribbons, front to back by slot, all from one seed */
function composeSpecs(seed: number, aspect: number, w: number, groundIdx: number): Spec[] {
  const rnd = mulberry32(seed);
  const r = (a: number, b: number) => a + (b - a) * rnd();
  const pool = [0, 1, 2, 3].filter((i) => i !== groundIdx);
  const colour0 = Math.floor(r(0, 3));
  const specs: Spec[] = [];
  const seen: Pt[] = []; // anchors, as they land on screen
  for (let i = 0; i < MAXR; i++) {
    const slot = SLOTS[i];
    const z = r(slot.z[0], slot.z[1]);
    const k = (CAM_D - z) / CAM_D;
    const q = 1 / k;
    const hx = aspect * k;
    const hy = k;
    const halfW = slot.thin ? 0.17 * w : 0.5 * w * r(0.92, 1.1);
    const R = w * r(0.72, 1.0);
    let best: Shape | null = null;
    let bestScore = -1;
    const tries = i === 0 ? 1 : z > 0.2 ? 10 : 6;
    for (let c = 0; c < tries; c++) {
      const kind = slot.kinds[Math.floor(r(0, slot.kinds.length)) % slot.kinds.length];
      const tr = i > 0 && r(0, 1) < (aspect < 0.9 ? 0.7 : 0.45);
      const fu = i > 0 && r(0, 1) < 0.5 ? -1 : 1;
      const fv = r(0, 1) < 0.5 ? -1 : 1;
      const sh = makeShape(kind, tr ? hy : hx, tr ? hx : hy, w, R, r, i === 0);
      const map = (p: Pt): Pt => (tr ? [p[1] * fv, p[0] * fu] : [p[0] * fu, p[1] * fv]);
      sh.pts = sh.pts.map(map);
      sh.anchor = map(sh.anchor);
      if (sh.ring) {
        const c2 = map([sh.ring.cx, sh.ring.cy]);
        sh.ring.cx = c2[0];
        sh.ring.cy = c2[1];
        sh.ring.a0 = Math.atan2(c2[1], c2[0]); // the seam sits at the point farthest from the frame
      }
      if (i === 0) {
        best = sh;
        break;
      }
      // keep ribbons that pass in front of the lyric off its main run, and spread the rest out
      let dFocus = 9;
      for (let t = -2; t <= 2; t++) {
        const A: Pt = [seen[0][0] + t * aspect * 0.36, seen[0][1]]; // along the lyric's main run
        if (Math.abs(A[0]) > aspect) continue;
        if (sh.ring) dFocus = Math.min(dFocus, Math.abs(Math.hypot(A[0] - sh.ring.cx * q, A[1] - sh.ring.cy * q) - sh.ring.r * q));
        else for (let j = 0; j + 1 < sh.pts.length; j++) dFocus = Math.min(dFocus, segDist(A, [sh.pts[j][0] * q, sh.pts[j][1] * q], [sh.pts[j + 1][0] * q, sh.pts[j + 1][1] * q]));
      }
      let spread = 9;
      for (const s of seen) spread = Math.min(spread, Math.hypot(sh.anchor[0] * q - s[0], sh.anchor[1] * q - s[1]));
      const inFrame = Math.abs(sh.anchor[0]) < hx * 0.95 && Math.abs(sh.anchor[1]) < hy * 0.95 ? 1 : 0;
      const score = (z > 0.2 ? Math.min(dFocus, 1.9 * w * q) * 3 : Math.min(dFocus, 1.2 * w) * 0.6) + Math.min(spread, 1.2) * 0.7 + inFrame * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = sh;
      }
    }
    const sh = best!;
    seen.push([sh.anchor[0] * q, sh.anchor[1] * q]);
    const calm = i === 0 ? 0.55 : 1 - 0.45 * Math.max(0, z / 1.75);
    specs.push({
      ...sh,
      R,
      halfW,
      z,
      tiltX: r(-0.38, 0.38) * calm,
      tiltY: r(-0.42, 0.42) * calm,
      rotZ: r(-0.05, 0.05) * (i === 0 ? 0.4 : 1),
      role: slot.role,
      color: slot.thin ? INK : pool[(colour0 + i) % 3],
      speed: i === 0 ? 1 : (r(0, 1) < 0.5 ? -1 : 1) * r(0.65, 1.5),
      hx,
      hy,
    });
  }
  return specs;
}

/* ───────────────────────── type ───────────────────────── */

const SEPS = ['×', '*', '+'];
const clean = (s: string) =>
  s
    .replace(/[“”"()[\]{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
const clip = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).trim();
};

const St = { Hidden: 0, In: 1, On: 2, Out: 3 } as const;
type StT = (typeof St)[keyof typeof St];

interface Ribbon {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  pos: Float32Array;
  data: Float32Array;
  qw: Float32Array;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  thin: boolean;
  spec: Spec | null;
  next: Spec | null;
  state: StT;
  t: number;
  dur: number;
  delay: number;
  whip: boolean;
  head: number;
  tail: number;
  /** arc-length range that can be on screen */
  vis0: number;
  vis1: number;
  length: number;
  textKey: string;
  /** width / height of the phrase(s) painted into the texture */
  texAspect: number;
  squeeze: number;
  offset: number;
  /** hat steps still to play out (tickers) */
  step: number;
  colA: number;
  colB: number;
  front: number;
  frontSpeed: number;
  wiping: boolean;
  bulge: number;
}

export const ribbonType: SceneDef = {
  id: 'ribbon-type',
  name: 'Ribbon Type',
  description:
    'A gig poster in motion: fat flat-coloured ribbons snake across one bold ground colour with heavy type running along them, some huge and soft in front of the lens, one crisp and carrying the line being sung. Kicks shove the type along, snares send a colour change down a ribbon, bass makes them wobble; builds crowd the frame and a drop cuts to a whole new poster.',
  category: 'form',
  style: 'type',
  tags: ['typographic', 'graphic', 'pop', 'playful', 'upbeat', 'energetic', 'happy', 'bouncy', 'lyrics', 'uplifting', 'house', 'indie'],
  light: true,
  showsLyrics: true,
  params,
  modulations: [
    { source: 'sub', param: 'wave', amount: 0.2 },
    { source: 'build', param: 'blur', amount: 0.15 },
  ],
  create() {
    const scene = new THREE.Scene();
    const ground = new THREE.Color();
    scene.background = ground;
    const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 60);
    camera.position.set(0, 0, CAM_D);

    // one strip index list shared by every ribbon
    const idx = new Uint16Array((MAXN - 1) * 6);
    for (let i = 0; i < MAXN - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    const indexAttr = new THREE.BufferAttribute(idx, 1);

    const ribbons: Ribbon[] = [];
    for (let i = 0; i < MAXR; i++) {
      const thin = SLOTS[i].thin;
      const canvas = document.createElement('canvas');
      canvas.width = i === 0 ? 4096 : 2048;
      canvas.height = i === 0 ? 160 : thin ? 72 : 112;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      const pos = new Float32Array(MAXN * 2 * 3);
      const data = new Float32Array(MAXN * 2 * 4);
      const qw = new Float32Array(MAXN * 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aData', new THREE.BufferAttribute(data, 4));
      geo.setAttribute('aQ', new THREE.BufferAttribute(qw, 1));
      geo.setIndex(indexAttr);
      geo.setDrawRange(0, 0);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTex: { value: tex },
          uTexSize: { value: new THREE.Vector2(canvas.width, canvas.height) },
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
          uInkA: { value: new THREE.Color() },
          uInkB: { value: new THREE.Color() },
          uHalfW: { value: 0.1 },
          uTexLen: { value: 1 },
          uTypeScale: { value: 1 },
          uOffset: { value: 0 },
          uSqueeze: { value: 1 },
          uHead: { value: 1e4 },
          uTail: { value: -1e4 },
          uFront: { value: 1e4 },
          uBulge: { value: 0 },
          uBulgeW: { value: 0.3 },
          uFocus: { value: CAM_D },
          uAperture: { value: 0 },
          uMaxBlur: { value: 0.2 },
          uWaveAmp: { value: 0 },
          uWaveK: { value: 4 },
          uWavePhase: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      ribbons.push({
        mesh, geo, mat, pos, data, qw, canvas, ctx, tex, thin,
        spec: null, next: null, state: St.Hidden, t: 0, dur: 1, delay: 0, whip: false, head: 1e4, tail: -1e4,
        vis0: 0, vis1: 1, length: 1, textKey: '', texAspect: 8, squeeze: 1, offset: i * 0.37, step: 0,
        colA: 1, colB: 1, front: 1e4, frontSpeed: 0, wiping: false, bulge: 0,
      });
    }

    /* ── geometry: straight runs and rounded turns, written into the ribbon's buffers ── */
    const buildGeometry = (rb: Ribbon, spec: Spec, ext: number) => {
      const { pos, data, qw } = rb;
      let n = 0;
      let s = 0;
      let v0 = Infinity;
      let v1 = -Infinity;
      const put = (cx: number, cy: number, dx: number, dy: number, sAt: number, eL: number, eR: number, qL: number, qR: number) => {
        if (n >= MAXN) return;
        const nx = -dy;
        const ny = dx;
        const o = n * 6;
        const q = n * 8;
        pos[o] = cx + nx * eL;
        pos[o + 1] = cy + ny * eL;
        pos[o + 2] = 0;
        pos[o + 3] = cx - nx * eR;
        pos[o + 4] = cy - ny * eR;
        pos[o + 5] = 0;
        data[q] = sAt;
        data[q + 1] = eL;
        data[q + 2] = nx;
        data[q + 3] = ny;
        data[q + 4] = sAt;
        data[q + 5] = -eR;
        data[q + 6] = nx;
        data[q + 7] = ny;
        qw[n * 2] = qL;
        qw[n * 2 + 1] = qR;
        if (Math.abs(cx) < spec.hx * 1.3 && Math.abs(cy) < spec.hy * 1.3) {
          v0 = Math.min(v0, sAt);
          v1 = Math.max(v1, sAt);
        }
        n++;
      };
      // on the inside of a turn the mesh must not reach past the centre of the arc
      const arc = (cx: number, cy: number, rad: number, a0: number, sweep: number) => {
        const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.1));
        const dir = Math.sign(sweep);
        const inner = Math.min(ext, rad - 1e-3);
        for (let j = 0; j <= steps; j++) {
          const ang = a0 + (sweep * j) / steps;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          const qIn = (rad - inner) / rad;
          const qOut = (rad + ext) / rad;
          put(cx + c * rad, cy + sn * rad, -sn * dir, c * dir, s + (rad * Math.abs(sweep) * j) / steps, dir > 0 ? inner : ext, dir > 0 ? ext : inner, dir > 0 ? qIn : qOut, dir > 0 ? qOut : qIn);
        }
        s += rad * Math.abs(sweep);
      };
      const line = (ax: number, ay: number, bx: number, by: number) => {
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-5) return;
        const dx = (bx - ax) / len;
        const dy = (by - ay) / len;
        const steps = Math.max(1, Math.ceil(len / 0.11));
        for (let j = 0; j <= steps; j++) put(ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps, dx, dy, s + (len * j) / steps, ext, ext, 1, 1);
        s += len;
      };
      if (spec.ring) {
        const g = spec.ring;
        arc(g.cx, g.cy, g.r, g.a0, g.dir * TAU);
      } else {
        const P = spec.pts;
        let cur: Pt = P[0];
        for (let i = 1; i < P.length - 1; i++) {
          const lenIn = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
          const lenOut = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
          const d1: Pt = [(P[i][0] - P[i - 1][0]) / lenIn, (P[i][1] - P[i - 1][1]) / lenIn];
          const d2: Pt = [(P[i + 1][0] - P[i][0]) / lenOut, (P[i + 1][1] - P[i][1]) / lenOut];
          const cross = d1[0] * d2[1] - d1[1] * d2[0];
          const theta = Math.atan2(Math.abs(cross), d1[0] * d2[0] + d1[1] * d2[1]);
          if (theta < 0.02) continue;
          const tanHalf = Math.tan(theta / 2);
          // a fillet may use half of a run it shares with the next turn, all of a run that leaves the frame
          const t = Math.min(spec.R * tanHalf, i === 1 ? lenIn * 0.9 : lenIn / 2, i === P.length - 2 ? lenOut * 0.9 : lenOut / 2);
          const rad = t / tanHalf;
          const dir = Math.sign(cross);
          const ax = P[i][0] - d1[0] * t;
          const ay = P[i][1] - d1[1] * t;
          line(cur[0], cur[1], ax, ay);
          const cx = ax - d1[1] * rad * dir;
          const cy = ay + d1[0] * rad * dir;
          arc(cx, cy, rad, Math.atan2(ay - cy, ax - cx), theta * dir);
          cur = [P[i][0] + d2[0] * t, P[i][1] + d2[1] * t];
        }
        const last = P[P.length - 1];
        line(cur[0], cur[1], last[0], last[1]);
      }
      rb.geo.attributes.position.needsUpdate = true;
      rb.geo.attributes.aData.needsUpdate = true;
      rb.geo.attributes.aQ.needsUpdate = true;
      rb.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
      rb.length = s;
      rb.vis0 = isFinite(v0) ? v0 : 0;
      rb.vis1 = isFinite(v1) ? v1 : s;
    };

    /* ── type: one phrase (or a few copies of it) painted across the whole strip ── */
    const paint = (rb: Ribbon, tokens: string[]) => {
      const { canvas, ctx } = rb;
      const W = canvas.width;
      const H = canvas.height;
      const px = H * (rb.thin ? 0.72 : 0.85);
      const cap = px * (rb.thin ? 0.698 : 0.727);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.font = rb.thin ? `500 ${px}px ${FONT_MONO}` : `580 ${px}px ${FONT_SANS}`;
      const gap = px * (rb.thin ? 0.5 : 0.36);
      const sepW = px * 0.62;
      const widths = tokens.map((t) => (SEPS.includes(t) ? sepW : ctx.measureText(t).width));
      const total = widths.reduce((a, b) => a + b + gap, 0);
      const reps = Math.max(1, Math.floor(W / total));
      const sx = W / (total * reps);
      // a little blur turns the glyph edge into a short ramp the shader can re-sharpen at any size
      ctx.filter = `blur(${(H / 130).toFixed(2)}px)`;
      ctx.setTransform(sx, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = px * (rb.thin ? 0.09 : 0.112);
      ctx.lineCap = 'butt';
      ctx.textBaseline = 'alphabetic';
      const base = H / 2 + cap / 2;
      let x = gap / 2;
      for (let rep = 0; rep < reps; rep++) {
        tokens.forEach((tok, i) => {
          if (SEPS.includes(tok)) {
            // drawn, not set: a geometric cross, plus and six-point star, all centred on the caps
            const cx = x + sepW / 2;
            const cy = H / 2;
            const ra = px * 0.25;
            const angs = tok === '+' ? [0, Math.PI / 2] : tok === '×' ? [Math.PI / 4, -Math.PI / 4] : [Math.PI / 2, Math.PI / 6, -Math.PI / 6];
            ctx.beginPath();
            for (const an of angs) {
              ctx.moveTo(cx - Math.cos(an) * ra, cy - Math.sin(an) * ra);
              ctx.lineTo(cx + Math.cos(an) * ra, cy + Math.sin(an) * ra);
            }
            ctx.stroke();
          } else ctx.fillText(tok, x, base);
          x += widths[i] + gap;
        });
      }
      ctx.filter = 'none';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      rb.tex.needsUpdate = true;
      rb.texAspect = (total * reps) / H;
    };

    /* ── state ── */
    let specs: Spec[] = [];
    let started = false;
    let layoutKey = '';
    let builtW = 0.27;
    let builtWidthParam = 1;
    let groundIdx = 0;
    let lastSec = -2;
    let lastPhrase = -1;
    let sinceCut = 10;
    let count = 2;
    let addWait = 0;
    let energy = 0;
    let bassEnv = 0;
    let nudge = 0;
    let whip = 0;
    let wavePhase = 0;
    let focus = CAM_D;
    let focusSnap = true;
    let groundSnap = true;
    let snareAcc = 0;
    let snareTurn = 0;
    let fontsReady = false;
    let fontCheck = 0;
    let heldLyric = '';
    let heldUntil = -1;
    let tComp = 0;
    const cam = { px: 0, py: 0, lx: 0, ly: 0, roll: 0, vx: 0, vy: 0 };
    const camT = { px: 0, py: 0, lx: 0, ly: 0, roll: 0, vx: 0, vy: 0 };
    let rollSign = 1;
    const zoomKick = new Spring(140, 15, 0);
    const isDrop = dropEdge();
    const tmpV = new THREE.Vector3();
    const tmpC = new THREE.Color();

    const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

    const applySpec = (rb: Ribbon, spec: Spec) => {
      rb.spec = spec;
      rb.next = null;
      buildGeometry(rb, spec, spec.halfW * 1.5 + builtW * 0.55);
      rb.mesh.position.set(0, 0, spec.z);
      rb.mesh.rotation.set(spec.tiltX, spec.tiltY, spec.rotZ);
      rb.mesh.renderOrder = Math.round(spec.z * 100);
      rb.colA = rb.colB = spec.color;
      rb.wiping = false;
      rb.front = 1e4;
      rb.bulge = 0;
      rb.step = 0;
    };

    const bringIn = (rb: Ribbon, dur: number, delay: number, fast: boolean) => {
      rb.state = St.In;
      rb.t = 0;
      rb.dur = dur;
      rb.delay = delay;
      rb.whip = fast;
      rb.head = -1e4;
      rb.tail = -1e4;
    };

    const compose = (frame: FrameContext, mode: 'snap' | 'soft' | 'cut', seed: number) => {
      const rnd = mulberry32(seed ^ 0x51ed27);
      const r = (a: number, b: number) => a + (b - a) * rnd();
      specs = composeSpecs(seed, frame.aspect, builtW, groundIdx);
      // a new camera for the new poster: a little off axis, a little rolled, drifting somewhere
      const e = energy;
      camT.px = r(-0.6, 0.6);
      camT.py = r(-0.32, 0.32);
      camT.lx = camT.px * 0.2 + r(-0.05, 0.05) * frame.aspect;
      camT.ly = camT.py * 0.2 + r(-0.05, 0.05);
      rollSign = r(0, 1) < 0.5 ? -1 : 1;
      camT.roll = rollSign * r(0.2, 1) * (0.012 + 0.085 * e) * (mode === 'cut' ? 1.5 : 1);
      camT.vx = r(-1, 1) * 0.05;
      camT.vy = r(-1, 1) * 0.028;
      tComp = 0;
      if (mode !== 'soft') {
        Object.assign(cam, camT);
        focusSnap = true;
      }
      const slow = 1.25 - 0.8 * e;
      ribbons.forEach((rb, i) => {
        if (mode === 'snap') {
          applySpec(rb, specs[i]);
          rb.state = i < count ? St.On : St.Hidden;
          rb.head = 1e4;
          rb.tail = -1e4;
        } else if (mode === 'cut') {
          applySpec(rb, specs[i]);
          if (i >= count) rb.state = St.Hidden;
          else if (i % 2 === 0) {
            // the lyric and the far ribbons are simply there on the cut; the near ones whip in over them
            rb.state = St.On;
            rb.head = 1e4;
            rb.tail = -1e4;
          } else bringIn(rb, r(0.2, 0.34), i * 0.012, true);
        } else if (rb.state === St.Hidden) {
          applySpec(rb, specs[i]);
        } else {
          // run out of the frame, then come back as the new ribbon
          rb.next = specs[i];
          if (rb.state !== St.Out) {
            rb.state = St.Out;
            rb.t = 0;
            // two shifts, so the stage is never empty: the near ribbons and tickers go first
            rb.dur = 0.5 * slow;
            rb.delay = (i % 2 === 0 ? 0.85 : 0) * slow + i * 0.05 * slow;
          }
        }
      });
    };

    const startWipe = (rb: Ribbon, to: number, dur: number, bulge: number) => {
      rb.colA = rb.colB;
      rb.colB = to;
      const m = builtW * 2.5;
      rb.front = rb.vis0 - m;
      rb.frontSpeed = (rb.vis1 - rb.vis0 + m * 2) / Math.max(dur, 0.05);
      rb.wiping = true;
      rb.bulge = bulge;
    };

    /** move the ground to another palette colour; ribbons wearing that colour take the old ground's */
    const setGround = (to: number, hard: boolean) => {
      if (to === groundIdx) return;
      const from = groundIdx;
      groundIdx = to;
      if (hard) groundSnap = true;
      for (const rb of ribbons) {
        if (rb.colB !== to) continue;
        if (hard || rb.state === St.Hidden) rb.colA = rb.colB = from;
        else startWipe(rb, from, 0.9, 0);
      }
    };

    const tokensFor = (frame: FrameContext, lyric: string): Record<Role, string[]> => {
      const info = songInfo();
      const title = clip(clean(info.title), 34) || 'UNTITLED';
      const artistRaw = clean(info.artist);
      const artist = /^UNKNOWN ARTIST$/.test(artistRaw) ? '' : clip(artistRaw, 28);
      const titleT = artist ? [title, '×', artist, '*'] : [title, '×'];
      const artistT = artist ? [artist, '+', title, '×'] : [title, '+'];
      const an = frame.analysis;
      const words: string[] = [];
      for (const wd of [an?.character?.genre, an?.character?.mood, ...(an?.tags ?? [])]) {
        const c = clean(wd ?? '');
        if (c && !words.includes(c) && words.length < 4) words.push(c);
      }
      const moodT: string[] = [];
      words.forEach((wd, i) => moodT.push(wd, SEPS[(i + 1) % 3]));
      const a = frame.audio;
      const sec = sectionIndex(frame);
      const facts: string[] = [];
      const label = sec >= 0 ? an?.sections[sec]?.label : undefined;
      if (label) facts.push(label.toUpperCase(), '*');
      if (a.bpm > 0) facts.push(`${Math.round(a.bpm)} BPM`, '+');
      facts.push(fmtClock(a.time), '×');
      const typed = clip(clean(frame.text || ''), 60);
      const line = lyric || typed;
      const lyricT = line ? (line.length <= 20 ? [line, '×', line, '*'] : [line, '×']) : titleT;
      return { lyric: lyricT, title: titleT, artist: artistT, mood: moodT.length ? moodT : artistT, facts };
    };

    function update(frame: FrameContext) {
      const dt = stepDt(frame);
      const a = frame.audio;
      const p = frame.params;
      const pal = frame.palette.c;
      const cols = [pal.bg, pal.accent, pal.accent2, pal.muted, pal.fg];
      const speedP = num(p, 'speed', 1);
      const kickP = num(p, 'kick', 1);
      const snareP = num(p, 'snare', 1);
      const waveP = num(p, 'wave', 1);
      const driftP = num(p, 'drift', 0.5);
      const blurP = num(p, 'blur', 1);
      const widthP = num(p, 'width', 1);
      const typeP = num(p, 'type', 0.86);
      const an = frame.analysis;
      const sec = sectionIndex(frame);

      /* slow state: the section's intensity, eased; with an analysis we know where it is heading */
      const secE = sec >= 0 && an ? an.sections[sec].energy : 1;
      const eNow = Math.min(a.energy, secE + 0.15);
      energy = started ? approach(energy, eNow, 1.6, dt) : eNow;
      bassEnv = approach(bassEnv, Math.max(a.sub, a.bass * 0.8), 12, dt);
      sinceCut += dt;
      tComp += dt;
      const build = Math.max(a.build, frame.feel.tension);

      /* how many ribbons the song wants on stage */
      const want = (1.3 + 6.2 * Math.pow(energy, 1.2) + 1.0 * build) * num(p, 'count', 1);
      if (!started || Math.abs(want - count) > 0.68) count = Math.min(MAXR, Math.max(1, Math.round(want)));

      /* when to redraw the poster */
      const bps = a.bpm > 0 ? a.bpm / 60 : 2;
      const tSong = a.time > 0 ? a.time : frame.time;
      // a new poster every 8 bars, every 4 when the song is running hot
      const phrase = Math.floor((tSong * bps) / 16);
      const turn = phrase !== lastPhrase && (energy > 0.62 || phrase % 2 === 0 || Math.abs(phrase - lastPhrase) > 1);
      // a tall frame's ribbons are narrower still, so a few words of the line are in the frame at once
      const base = Math.max(0.05, 0.103 * Math.sqrt(4 * frame.aspect) * (frame.aspect < 0.9 ? 0.72 : 1));
      const key = `${frame.aspect.toFixed(3)}`;
      const seedBase = hashStr(songInfo().title) ^ Math.imul(phrase + 3, 0x9e3779b1) ^ Math.imul(sec + 5, 0x85ebca6b);
      const dropped = isDrop(frame);
      if (!started || key !== layoutKey || Math.abs(widthP - builtWidthParam) > 0.14) {
        layoutKey = key;
        builtWidthParam = widthP;
        builtW = base * widthP;
        compose(frame, 'snap', seedBase);
        started = true;
        lastSec = sec;
        lastPhrase = phrase;
        groundSnap = true;
      } else if (dropped) {
        // THE DROP: a hard cut to a new poster on a new ground
        if (bool(p, 'ground', true)) {
          const pickG = Math.round(tSong * bps);
          setGround(groundIdx === 0 ? 1 + (pickG % 3) : 1 + ((groundIdx + (pickG % 2)) % 3), true);
        }
        count = Math.min(MAXR, Math.max(count, Math.round(7 * num(p, 'count', 1))));
        compose(frame, 'cut', seedBase ^ Math.imul(Math.round(tSong) + 11, 0xc2b2ae35));
        whip = 1;
        sinceCut = 0;
        lastSec = sec;
        lastPhrase = phrase;
      } else if (sec !== lastSec || turn) {
        lastSec = sec;
        if (sinceCut > 1.2) compose(frame, 'soft', seedBase);
      }
      lastPhrase = phrase;
      // the ground comes home once the song has calmed down
      if (groundIdx !== 0 && (energy < 0.5 || !bool(p, 'ground', true)) && sinceCut > 1.5) setGround(0, false);

      /* the words */
      const lyr = currentLyric(a.time);
      if (lyr) {
        heldLyric = clip(clean(lyr.text), 64);
        heldUntil = frame.time + 2.2;
      } else if (frame.time > heldUntil) heldLyric = '';
      if (fontCheck-- <= 0) {
        fontCheck = 30;
        try {
          fontsReady = document.fonts.check(`16px "Inter Variable"`) && document.fonts.check(`16px "IBM Plex Mono"`);
        } catch {
          fontsReady = true;
        }
      }
      const tokens = tokensFor(frame, heldLyric);

      /* hits */
      whip = approach(whip, 0, 2.6, dt);
      nudge = approach(nudge, 0, 9, dt);
      if (a.kickHit) {
        nudge = 1;
        zoomKick.vel += 2.2 * kickP;
      }
      zoomKick.step(0, dt);
      const stage = ribbons.filter((rb) => rb.state === St.On || rb.state === St.In);
      if (a.snareHit && stage.length) {
        snareAcc += snareP;
        if (snareAcc >= 1) {
          snareAcc -= 1;
          // the next ribbon in turn swallows the hit: a bulge runs down it and leaves it repainted
          const rb = stage[snareTurn++ % stage.length];
          // into whichever colour is least on show right now
          let to = INK;
          let fewest = 99;
          if (rb.colB !== INK)
            for (let j = 0; j < 3; j++) {
              const c = (rb.colB + 1 + j + (snareTurn % 2)) % 4;
              if (c === groundIdx || c === rb.colB) continue;
              const used = stage.reduce((nUsed, o) => nUsed + (o.colB === c ? 1 : 0), 0) + (ribbons[0].colB === c ? 1 : 0);
              if (used < fewest) {
                fewest = used;
                to = c;
              }
            }
          startWipe(rb, to, 0.42, 0.28);
        }
      }
      if (a.hatHit) for (const rb of ribbons) if (rb.thin) rb.step = Math.min(rb.step + 1, 3);

      /* camera: eased toward this poster's framing, drifting, pushed in by builds and kicks */
      const cr = 1 - Math.exp(-1.3 * dt);
      cam.px += (camT.px - cam.px) * cr;
      cam.py += (camT.py - cam.py) * cr;
      cam.lx += (camT.lx - cam.lx) * cr;
      cam.ly += (camT.ly - cam.ly) * cr;
      cam.roll += (camT.roll - cam.roll) * cr;
      const dr = Math.min(tComp, 20) * driftP * 2 * (0.5 + energy);
      const push = 0.012 * Math.min(tComp, 16) * driftP + 0.11 * Math.pow(build, 1.5) + 0.02 * zoomKick.value - 0.05 * whip;
      const roll = cam.roll + rollSign * 0.07 * build * build + Math.sin(frame.time * 0.21) * 0.008 * driftP;
      camera.position.set(cam.px + camT.vx * dr, cam.py + camT.vy * dr, CAM_D * (1 - push));
      camera.up.set(Math.sin(roll), Math.cos(roll), 0);
      camera.lookAt(cam.lx + camT.vx * dr * 0.6, cam.ly + camT.vy * dr * 0.6, 0);
      camera.updateMatrixWorld();

      /* lifecycle: ribbons run in from one end and out of the other */
      addWait -= dt;
      const slow = 1.25 - 0.8 * energy;
      const m = builtW * 1.6;
      ribbons.forEach((rb, i) => {
        if (!rb.spec) return;
        if (rb.state === St.Hidden && i < count && addWait <= 0) {
          bringIn(rb, 0.85 * slow, 0, false);
          addWait = 0.5 / Math.max(bps, 0.5);
        } else if ((rb.state === St.On || rb.state === St.In) && i >= count) {
          rb.state = St.Out;
          rb.t = 0;
          rb.dur = 0.7 * slow;
          rb.delay = 0;
        }
        if (rb.state === St.In) {
          if (rb.delay > 0) rb.delay -= dt;
          else {
            rb.t = Math.min(1, rb.t + dt / rb.dur);
            const e = rb.whip ? 1 - Math.pow(1 - rb.t, 3) : rb.t < 0.5 ? 4 * rb.t ** 3 : 1 - Math.pow(-2 * rb.t + 2, 3) / 2;
            const m0 = rb.whip ? 0 : m;
            rb.head = rb.vis0 - m0 + (rb.vis1 - rb.vis0 + m0 + m) * e;
            if (rb.t >= 1) {
              rb.state = St.On;
              rb.head = 1e4;
            }
          }
        } else if (rb.state === St.Out) {
          if (rb.delay > 0) rb.delay -= dt;
          else {
            rb.t = Math.min(1, rb.t + dt / rb.dur);
            const e = rb.t * rb.t * (3 - 2 * rb.t);
            rb.tail = rb.vis0 - m + (rb.vis1 - rb.vis0 + 2 * m) * e;
            if (rb.t >= 1) {
              rb.state = St.Hidden;
              rb.tail = -1e4;
              if (rb.next) {
                applySpec(rb, rb.next);
                if (i < count) bringIn(rb, 0.7 * slow, 0, false);
              }
            }
          }
        }
        rb.mesh.visible = rb.state !== St.Hidden && !(rb.state === St.In && rb.delay > 0);
      });

      /* lens: focus sits on the lyric ribbon's main run and breathes a little when it is quiet */
      const lead = ribbons[0];
      let fTarget = CAM_D;
      if (lead.spec) {
        lead.mesh.updateMatrixWorld();
        tmpV.set(lead.spec.anchor[0], lead.spec.anchor[1], 0).applyMatrix4(lead.mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
        fTarget = -tmpV.z;
      }
      fTarget += Math.sin(frame.time * 0.33) * 0.16 * (1 - energy) * Math.min(1, blurP);
      focus = focusSnap ? fTarget : approach(focus, fTarget, 3, dt);
      focusSnap = false;
      // scaled with the ribbon width, so a tall frame (thinner ribbons) is no blurrier than a wide one
      const aperture = 0.024 * (builtW / 0.275) * blurP * (1.2 - 0.35 * energy + 0.55 * build);

      /* ground */
      if (groundSnap) ground.copy(cols[groundIdx]);
      else ground.lerp(cols[groundIdx], 1 - Math.exp(-3.5 * dt));
      groundSnap = false;

      /* motion shared by every ribbon */
      wavePhase = (wavePhase + dt * (1.1 + 2.6 * energy) * (a.playing ? 1 : 0.35)) % (TAU * 100);
      const beat = beatsPerSecond(frame);
      const run = beat * builtW * 0.42 * speedP * (0.35 + 1.3 * energy) * (1 + 1.2 * build + 5 * whip * whip);
      const shove = nudge * builtW * 4.2 * kickP;
      const waveAmp = builtW * waveP * (0.012 + 0.11 * Math.pow(bassEnv, 1.5));
      const widthNow = widthP / builtWidthParam;

      const inkOf = (i: number, out: THREE.Color) => {
        const c = cols[i];
        const first = i === INK ? cols[groundIdx] : pal.fg;
        const d1 = Math.abs(lum(first) - lum(c));
        const d2 = Math.abs(lum(pal.bg) - lum(c));
        out.copy(d1 >= d2 * 0.8 ? first : pal.bg);
      };

      for (const rb of ribbons) {
        const spec = rb.spec;
        if (!spec || rb.state === St.Hidden) continue;
        const u = rb.mat.uniforms;

        // words: repaint when this ribbon's phrase changes; the new line pops up out of the centre line
        const tk = tokens[spec.role];
        const tkKey = `${tk.join('|')}#${fontsReady ? 1 : 0}`;
        if (tkKey !== rb.textKey) {
          if (rb.textKey && spec.role === 'lyric') rb.squeeze = 0.08;
          rb.textKey = tkKey;
          paint(rb, tk);
        }
        rb.squeeze = approach(rb.squeeze, 1, 16, dt);

        const halfW = spec.halfW * widthNow;
        let texLen = 2 * halfW * typeP * rb.texAspect;
        if (spec.ring) texLen = rb.length / Math.max(1, Math.round(rb.length / texLen)); // whole phrases around a loop

        // travel: fat ribbons glide and get shoved by kicks, thin tickers step on hats
        if (rb.thin) {
          const stepNow = Math.min(rb.step, rb.step * 22 * dt + 0.0001);
          rb.step -= stepNow;
          rb.offset += spec.speed * (run * 0.35 * dt + stepNow * halfW * 3.2);
        } else rb.offset += spec.speed * (run + shove) * dt;
        rb.offset = ((rb.offset % texLen) + texLen) % texLen;

        if (rb.wiping) {
          rb.front += rb.frontSpeed * dt;
          if (rb.front > rb.vis1 + builtW * 2.5) {
            rb.wiping = false;
            rb.colA = rb.colB;
            rb.front = 1e4;
            rb.bulge = 0;
          }
        }

        (u.uColA.value as THREE.Color).copy(cols[rb.colA]);
        (u.uColB.value as THREE.Color).copy(cols[rb.colB]);
        inkOf(rb.colA, tmpC);
        (u.uInkA.value as THREE.Color).copy(tmpC);
        inkOf(rb.colB, tmpC);
        (u.uInkB.value as THREE.Color).copy(tmpC);
        u.uHalfW.value = halfW * (1 + (rb.thin ? 0.12 * a.hat : 0.08 * a.kick * kickP + 0.03 * bassEnv + 0.04 * a.snare * a.build));
        u.uTexLen.value = texLen;
        u.uTypeScale.value = typeP;
        u.uOffset.value = rb.offset;
        u.uSqueeze.value = rb.squeeze;
        u.uHead.value = rb.head;
        u.uTail.value = rb.tail;
        u.uFront.value = rb.front;
        u.uBulge.value = rb.bulge;
        u.uBulgeW.value = builtW * 1.3;
        u.uFocus.value = focus;
        u.uAperture.value = aperture;
        u.uMaxBlur.value = builtW * 0.55;
        u.uWaveAmp.value = waveAmp * (rb.thin ? 0.5 : 1);
        u.uWaveK.value = TAU / (builtW * 7);
        u.uWavePhase.value = wavePhase * (spec.speed < 0 ? -1 : 1) + spec.z * 3;
      }
    }

    return {
      render(frame, target) {
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          camera.updateProjectionMatrix();
        }
        update(frame);
        frame.renderer.setRenderTarget(target);
        frame.renderer.render(scene, camera);
      },
      dispose() {
        for (const rb of ribbons) {
          rb.geo.dispose();
          rb.mat.dispose();
          rb.tex.dispose();
          rb.canvas.width = rb.canvas.height = 1;
        }
      },
    };
  },
};
