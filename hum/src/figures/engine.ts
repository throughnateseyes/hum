/**
 * Line figures: the renderer.
 *
 * The figures are real solids in a real perspective, but nothing on screen is a GL edge. Each frame:
 *
 *   1. every solid is posed and projected here, on the CPU;
 *   2. the filled solids go into an offscreen buffer (which solid, how shaded, how deep);
 *   3. the lines (outlines, creases, marks, guides) are drawn as round-ended strokes of one pixel
 *      width with their own anti-aliasing. Every pixel of a stroke checks the buffer: on its own solid
 *      it shows, behind another it doesn't. Strokes are kept with MAX blending, so joints never darken;
 *   4. both are put together in the palette's colours.
 *
 * So parts that move past or through each other always sort right, the camera can go anywhere, and a
 * line is the same width at any export size. The one-line-one-crease drawing, and outlining a solid as
 * the hull of its rounded rings, come from hairline (see geometry.ts for its MIT notice).
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createFullscreenQuad } from '../core/sceneHelpers';
import type { ResolvedPalette } from '../core/types';
import type { BuiltFigure, BuiltSolid } from './geometry';
import type { V3 } from './format';
import { identity, multiply, pose, type Drive, type Mat } from './motion';

/* ───────────────────────── camera ───────────────────────── */

export interface Camera {
  /** degrees; 45 and 30 is the isometric default */
  az: number;
  el: number;
  target: V3;
  dist: number;
  /** focal length in half frame heights (6 is a long lens, 2 a wide one) */
  lens: number;
  /** shift of the picture in the frame, -1..1 */
  ox: number;
  oy: number;
}

interface Basis {
  right: V3;
  up: V3;
  fwd: V3;
  eye: V3;
}
export function basisOf(c: Camera): Basis {
  const a = (c.az * Math.PI) / 180;
  const e = (c.el * Math.PI) / 180;
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const se = Math.sin(e);
  const ce = Math.cos(e);
  const fwd: V3 = [-ce * sa, -ce * ca, -se];
  return {
    right: [ca, -sa, 0],
    up: [-se * sa, -se * ca, ce],
    fwd,
    eye: [c.target[0] - fwd[0] * c.dist, c.target[1] - fwd[1] * c.dist, c.target[2] - fwd[2] * c.dist],
  };
}

/** a box in the frame, -1..1 both ways */
export interface FrameBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Point a camera so that `pts` fill `box`: the picture is centred on the box and as large as fits for
 * every angle in `azs`. `wide` are points that must only stay inside `outer` (the pose at its furthest).
 */
export function fitCamera(cam: Camera, aspect: number, pts: V3[], box: FrameBox, azs: number[], wide: V3[] = [], outer: FrameBox = box): Camera {
  const c = { ...cam, ox: (box.x0 + box.x1) / 2, oy: (box.y0 + box.y1) / 2 };
  const cx = c.ox;
  const cy = c.oy;
  const measure = (list: V3[], az: number) => {
    const b = basisOf({ ...c, az });
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    for (const p of list) {
      const r: V3 = [p[0] - b.eye[0], p[1] - b.eye[1], p[2] - b.eye[2]];
      const d = Math.max(1, r[0] * b.fwd[0] + r[1] * b.fwd[1] + r[2] * b.fwd[2]);
      const x = ((r[0] * b.right[0] + r[1] * b.right[1] + r[2] * b.right[2]) * c.lens) / d / aspect;
      const y = ((r[0] * b.up[0] + r[1] * b.up[1] + r[2] * b.up[2]) * c.lens) / d;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1 };
  };
  for (let i = 0; i < 4; i++) {
    let need = 0;
    const mid = measure(pts, cam.az);
    // centre on the resting figure seen from the middle angle
    const ax = (mid.x0 + mid.x1) / 2;
    const ay = (mid.y0 + mid.y1) / 2;
    for (const az of azs) {
      const m = measure(pts, az);
      need = Math.max(need, Math.max(Math.abs(m.x0 - ax), Math.abs(m.x1 - ax)) / ((box.x1 - box.x0) / 2), Math.max(Math.abs(m.y0 - ay), Math.abs(m.y1 - ay)) / ((box.y1 - box.y0) / 2));
      if (wide.length) {
        const w = measure(wide, az);
        need = Math.max(need, (w.x1 - ax) / (outer.x1 - cx), (ax - w.x0) / (cx - outer.x0), (w.y1 - ay) / (outer.y1 - cy), (ay - w.y0) / (cy - outer.y0));
      }
    }
    // move the target so the middle of the picture is the middle of the figure
    const b = basisOf(c);
    const k = c.dist / c.lens;
    for (let q = 0; q < 3; q++) c.target = c.target.map((v, j) => (j === q ? v + b.right[q] * ax * aspect * k + b.up[q] * ay * k : v)) as V3;
    c.dist = Math.max(20, c.dist * need);
  }
  return c;
}

/* ───────────────────────── what to draw ───────────────────────── */

export interface Placed {
  figure: BuiltFigure;
  /** where its own origin stands in the world, and its size there */
  at: V3;
  scale: number;
  drive: Drive;
  /** 0 not there … 1 fully built */
  build: number;
  /** 0 gone … 1 full strength (distance) */
  strength: number;
  /** its bright part is lit (only one figure in the picture should be) */
  lit: boolean;
}

export interface Ink {
  /** line width in pixels at a 1080 short side */
  weight: number;
  /** 0..1: how much faces are tinted by the light */
  shade: number;
  /** 0..1.5: how far the motions go */
  motion: number;
  /** 0..1: the dotted floor */
  floor: number;
  /** floor dot spacing in units, and how far it reaches */
  grid: number;
  reach: number;
  floorZ: number;
  floorAt: [number, number];
}

const FILL_VERT = /* glsl */ `
attribute vec4 aInfo;
varying vec4 vInfo;
void main() { vInfo = aInfo; gl_Position = vec4(position, 1.0); }
`;
// which solid (two bytes), how shaded, how strong
const FILL_FRAG = /* glsl */ `
precision highp float;
varying vec4 vInfo;
void main() { gl_FragColor = vInfo; }
`;

const LINE_VERT = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute vec4 aC;   // width px, channel, id, strength (negative: lines on its own solid always show)
uniform vec2 uRes;
varying vec2 vP;
varying vec2 vA;
varying vec2 vB;
varying float vR;
varying float vZa;
varying float vZb;
varying vec4 vC;
void main() {
  vec2 a = (aA.xy * 0.5 + 0.5) * uRes;
  vec2 b = (aB.xy * 0.5 + 0.5) * uRes;
  vec2 d = b - a;
  float l = length(d);
  vec2 t = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float r = aC.x * 0.5;
  float pad = r + 1.0;
  vec2 p = mix(a, b, position.x) + t * (position.x * 2.0 - 1.0) * pad + n * position.y * pad;
  vP = p; vA = a; vB = b; vR = r; vZa = aA.z; vZb = aB.z; vC = aC;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;
const LINE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uFill;
uniform sampler2D uDepth;
uniform vec2 uRes;
varying vec2 vP;
varying vec2 vA;
varying vec2 vB;
varying float vR;
varying float vZa;
varying float vZb;
varying vec4 vC;
void main() {
  vec2 ab = vB - vA;
  float h = clamp(dot(vP - vA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float dist = length(vP - vA - ab * h);
  // thinner than a pixel: a pixel wide, and fainter
  float r = max(vR, 0.5);
  float cov = clamp(r + 0.5 - dist, 0.0, 1.0) * min(vR / 0.5, 1.0);
  if (cov <= 0.0) discard;
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 f = texture2D(uFill, uv);
  if (f.a > 0.0) {
    float id = floor(f.r * 255.0 + 0.5) + floor(f.g * 255.0 + 0.5) * 256.0;
    bool own = vC.w < 0.0 && abs(id - vC.z) < 0.5;
    if (!own) {
      float z = mix(vZa, vZb, h) * 0.5 + 0.5;
      if (z > texture2D(uDepth, uv).r) discard;
    }
  }
  float v = cov * abs(vC.w);
  float c = vC.y;
  gl_FragColor = vec4(c < 0.5 ? v : 0.0, c > 0.5 && c < 1.5 ? v : 0.0, c > 1.5 && c < 2.5 ? v : 0.0, c > 2.5 ? v : 0.0);
}
`;

const COMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFill;
uniform sampler2D uLines;
uniform vec2 uRes;
uniform vec3 uBg, uFg, uAccent, uMuted;
uniform float uShade, uFloor, uGrid, uReach, uFloorZ, uLens, uAspect, uPx, uLight;
uniform vec2 uShift, uFloorAt;
uniform vec3 uRight, uUp, uFwd, uEye;
void main() {
  vec4 f = texture2D(uFill, vUv);
  vec4 l = texture2D(uLines, vUv);
  vec3 col = uBg;
  if (f.a <= 0.0 && uFloor > 0.001) {
    // the floor: a dotted grid on the ground, read off the ray through this pixel
    vec2 n = (vUv * 2.0 - 1.0 - uShift) * vec2(uAspect, 1.0) / uLens;
    vec3 dir = uFwd + uRight * n.x + uUp * n.y;
    float t = (uFloorZ - uEye.z) / min(dir.z, -1e-4);
    vec2 g = uEye.xy + dir.xy * t;
    vec2 cell = floor(g / uGrid + 0.5) * uGrid;
    // the dot's own place on screen, so it is round and even whatever the angle
    vec3 c = vec3(cell, uFloorZ) - uEye;
    float d = dot(c, uFwd);
    vec2 s = vec2(dot(c, uRight) / uAspect, dot(c, uUp)) * uLens / d;
    float px = length((s + uShift - (vUv * 2.0 - 1.0)) * 0.5 * uRes);
    float gap = uGrid * uLens / d * 0.5 * uRes.y * 0.5;
    float a = clamp(uPx * 0.62 + 0.5 - px, 0.0, 1.0) * smoothstep(3.0, 9.0, gap / max(uPx, 1.0) * 1.6);
    float r = length(cell - uFloorAt) / uReach;
    a *= (1.0 - smoothstep(0.35, 1.0, r)) * step(0.0, t);
    col = mix(col, uFg, a * 0.5 * uFloor);
  }
  if (f.a > 0.0) {
    // paper on light palettes, a lifted dark on dark ones; the light only tints it
    float tone = f.b;
    vec3 plate = mix(uBg, uFg, 0.012 + 0.05 * (1.0 - uLight));
    plate = mix(plate, mix(uBg, uFg, 0.9), tone * uShade);
    col = mix(uBg, plate, clamp(f.a, 0.0, 1.0));
  }
  col = mix(col, uFg, l.g * 0.46);
  col = mix(col, uFg, l.r * 0.9);
  col = mix(col, uAccent, l.b);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** channels of the line buffer */
const EDGE = 0;
const DIM = 1;
const BRIGHT = 2;

const FLOATS = 10;
const smooth = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};
const easeOut = (x: number) => 1 - (1 - (x < 0 ? 0 : x > 1 ? 1 : x)) ** 3;

export class FigureRenderer {
  private fillRT: THREE.WebGLRenderTarget;
  private lineRT: THREE.WebGLRenderTarget;
  private fillScene = new THREE.Scene();
  private lineScene = new THREE.Scene();
  private cam = new THREE.Camera();
  private fillGeo = new THREE.BufferGeometry();
  private lineGeo = new THREE.InstancedBufferGeometry();
  private fillMat: THREE.ShaderMaterial;
  private lineMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private quad: ReturnType<typeof createFullscreenQuad>;
  private pos = new Float32Array(0);
  private info = new Float32Array(0);
  private index = new Uint32Array(0);
  private line = new Float32Array(0);
  private lineBuf!: THREE.InstancedInterleavedBuffer;
  private segs = 0;
  private signature = '';
  /** scratch: view x, y and depth of the solid being drawn */
  private sx = new Float64Array(4096);
  private sy = new Float64Array(4096);
  private sd = new Float64Array(4096);
  private order = new Int32Array(4096);
  private hull = new Int32Array(8192);
  private stats = { segs: 0, solids: 0, cpu: 0 };

  constructor() {
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.fillRT = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, depthTexture: depth, generateMipmaps: false });
    this.lineRT = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.fillMat = new THREE.ShaderMaterial({ vertexShader: FILL_VERT, fragmentShader: FILL_FRAG, side: THREE.DoubleSide, blending: THREE.NoBlending });
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uFill: { value: this.fillRT.texture }, uDepth: { value: depth }, uRes: { value: new THREE.Vector2(1, 1) } },
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const v3 = () => ({ value: new THREE.Vector3() });
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFill: { value: this.fillRT.texture },
        uLines: { value: this.lineRT.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uBg: { value: new THREE.Color() },
        uFg: { value: new THREE.Color() },
        uAccent: { value: new THREE.Color() },
        uMuted: { value: new THREE.Color() },
        uShade: { value: 0 },
        uFloor: { value: 0 },
        uGrid: { value: 10 },
        uReach: { value: 100 },
        uFloorZ: { value: 0 },
        uLens: { value: 1 },
        uAspect: { value: 1 },
        uPx: { value: 1 },
        uLight: { value: 1 },
        uShift: { value: new THREE.Vector2() },
        uFloorAt: { value: new THREE.Vector2() },
        uRight: v3(),
        uUp: v3(),
        uFwd: v3(),
        uEye: v3(),
      },
    });
    this.quad = createFullscreenQuad(this.compMat);
    const fill = new THREE.Mesh(this.fillGeo, this.fillMat);
    fill.frustumCulled = false;
    this.fillScene.add(fill);
    // one stroke: a quad from end to end
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    this.lineGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.growLines(2048);
    const lines = new THREE.Mesh(this.lineGeo, this.lineMat);
    lines.frustumCulled = false;
    this.lineScene.add(lines);
  }

  private growLines(n: number) {
    const next = new Float32Array(n * FLOATS);
    next.set(this.line.subarray(0, this.segs * FLOATS));
    this.line = next;
    this.lineGeo.dispose();
    this.lineBuf = new THREE.InstancedInterleavedBuffer(next, FLOATS, 1);
    this.lineBuf.setUsage(THREE.DynamicDrawUsage);
    this.lineGeo.setAttribute('aA', new THREE.InterleavedBufferAttribute(this.lineBuf, 3, 0));
    this.lineGeo.setAttribute('aB', new THREE.InterleavedBufferAttribute(this.lineBuf, 3, 3));
    this.lineGeo.setAttribute('aC', new THREE.InterleavedBufferAttribute(this.lineBuf, 4, 6));
  }

  private push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, ch: number, id: number, strength: number) {
    if (this.segs * FLOATS >= this.line.length) this.growLines((this.line.length / FLOATS) * 2);
    const o = this.segs * FLOATS;
    const l = this.line;
    l[o] = ax;
    l[o + 1] = ay;
    l[o + 2] = az;
    l[o + 3] = bx;
    l[o + 4] = by;
    l[o + 5] = bz;
    l[o + 6] = w;
    l[o + 7] = ch;
    l[o + 8] = id;
    l[o + 9] = strength;
    this.segs++;
  }

  /** buffers for this set of figures (the triangle list only changes when the set does) */
  private layout(list: Placed[]) {
    const sig = list.map((p) => `${p.figure.fig.name}/${p.figure.verts}/${p.figure.tris}`).join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    let verts = 0;
    let tris = 0;
    for (const p of list) {
      verts += p.figure.verts;
      tris += p.figure.tris;
    }
    this.pos = new Float32Array(Math.max(1, verts) * 3);
    this.info = new Float32Array(Math.max(1, verts) * 4);
    this.index = new Uint32Array(Math.max(1, tris));
    let v = 0;
    let t = 0;
    for (const p of list)
      for (const s of p.figure.solids) {
        for (const k of s.tris) this.index[t++] = v + k;
        v += s.verts.length / 3;
      }
    this.fillGeo.dispose();
    const pos = new THREE.BufferAttribute(this.pos, 3);
    const info = new THREE.BufferAttribute(this.info, 4);
    pos.setUsage(THREE.DynamicDrawUsage);
    info.setUsage(THREE.DynamicDrawUsage);
    this.fillGeo.setAttribute('position', pos);
    this.fillGeo.setAttribute('aInfo', info);
    this.fillGeo.setIndex(new THREE.BufferAttribute(this.index, 1));
  }

  private size(w: number, h: number) {
    if (this.fillRT.width === w && this.fillRT.height === h) return;
    this.fillRT.setSize(w, h);
    this.lineRT.setSize(w, h);
  }

  draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, width: number, height: number, cam: Camera, list: Placed[], ink: Ink, palette: ResolvedPalette) {
    const t0 = performance.now();
    this.size(width, height);
    this.layout(list);
    const aspect = width / height;
    const b = basisOf(cam);
    const weight = Math.max(0.6, (ink.weight * Math.min(width, height)) / 1080);
    this.segs = 0;
    let v = 0;
    let id = 1;
    let solids = 0;
    for (const p of list) {
      const { mats, lifted } = pose(p.figure, p.drive, ink.motion);
      const place = identity();
      place[0] = place[5] = place[10] = p.scale;
      place[3] = p.at[0];
      place[7] = p.at[1];
      place[11] = p.at[2];
      const n = p.figure.solids.length;
      const order = buildOrder(p.figure);
      for (let i = 0; i < n; i++) {
        const s = p.figure.solids[i];
        // each part's own share of the build-in: low parts first, a soft overlap
        const q = p.build >= 1 ? 1 : Math.max(0, Math.min(1, (p.build * 1.9 - order[i] * 0.9) / 1));
        this.solid(s, multiply(place, mats[i]), b, cam, aspect, width, height, v, id, i, q, p.strength, weight, p.lit);
        v += s.verts.length / 3;
        id++;
        solids++;
      }
      if (p.build >= 1) for (const l of lifted) this.guides(p.figure.solids[l.solid], multiply(place, mats[l.solid]), place, l.by, b, cam, aspect, width, height, p.strength, weight);
    }
    this.fillGeo.setDrawRange(0, this.index.length);
    if (v) {
      this.fillGeo.attributes.position.needsUpdate = true;
      this.fillGeo.attributes.aInfo.needsUpdate = true;
    }
    this.lineGeo.instanceCount = this.segs;
    this.lineBuf.clearUpdateRanges();
    this.lineBuf.addUpdateRange(0, this.segs * FLOATS);
    this.lineBuf.needsUpdate = true;
    this.stats = { segs: this.segs, solids, cpu: performance.now() - t0 };

    const clear = new THREE.Color();
    renderer.getClearColor(clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.fillRT);
    renderer.clear(true, true, false);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    if (v) renderer.render(this.fillScene, this.cam);
    renderer.setRenderTarget(this.lineRT);
    renderer.clear(true, false, false);
    (this.lineMat.uniforms.uRes.value as THREE.Vector2).set(width, height);
    if (this.segs) renderer.render(this.lineScene, this.cam);
    renderer.setClearColor(clear, alpha);
    renderer.autoClear = auto;

    const u = this.compMat.uniforms;
    (u.uRes.value as THREE.Vector2).set(width, height);
    u.uBg.value.copy(palette.c.bg);
    u.uFg.value.copy(palette.c.fg);
    u.uAccent.value.copy(palette.c.accent);
    u.uMuted.value.copy(palette.c.muted);
    const bg = palette.c.bg;
    u.uLight.value = smooth((bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722 - 0.25) / 0.4);
    u.uShade.value = ink.shade;
    u.uFloor.value = ink.floor;
    u.uGrid.value = ink.grid;
    u.uReach.value = ink.reach;
    u.uFloorZ.value = ink.floorZ;
    (u.uFloorAt.value as THREE.Vector2).set(ink.floorAt[0], ink.floorAt[1]);
    u.uLens.value = cam.lens;
    u.uAspect.value = aspect;
    u.uPx.value = weight;
    (u.uShift.value as THREE.Vector2).set(cam.ox, cam.oy);
    (u.uRight.value as THREE.Vector3).set(...b.right);
    (u.uUp.value as THREE.Vector3).set(...b.up);
    (u.uFwd.value as THREE.Vector3).set(...b.fwd);
    (u.uEye.value as THREE.Vector3).set(...b.eye);
    this.quad.render(renderer, target);
  }

  /** pose, project and draw one solid */
  private solid(s: BuiltSolid, m: Mat, b: Basis, cam: Camera, aspect: number, W: number, H: number, v0: number, id: number, idx: number, q: number, strength: number, weight: number, lit: boolean) {
    const n = s.verts.length / 3;
    if (n > this.sx.length) {
      const size = n * 2;
      this.sx = new Float64Array(size);
      this.sy = new Float64Array(size);
      this.sd = new Float64Array(size);
      this.order = new Int32Array(size);
      this.hull = new Int32Array(size * 2);
    }
    const { sx, sy, sd } = this;
    const pos = this.pos;
    const info = this.info;
    const gone = () => {
      for (let i = 0; i < n; i++) {
        pos[(v0 + i) * 3] = 2;
        pos[(v0 + i) * 3 + 1] = 2;
        pos[(v0 + i) * 3 + 2] = 2;
      }
    };
    if (q <= 0.002 || strength <= 0.004) return gone();

    // the build-in: the foot is drawn as a line, then the solid is pushed out of it
    const tube = s.kind === 'tube';
    const rise = q >= 1 || tube ? 1 : 0.015 + 0.985 * easeOut((q - 0.4) / 0.6);
    const drawn = q >= 1 ? 1 : smooth(q / 0.42);
    // until its outline has closed a part is only a line: nothing is filled in
    if (rise < 1) {
      // scale along the solid's own axis about its foot
      const k = 1 - rise;
      const [ax, ay, az] = s.axis;
      const d = ax * s.base[0] + ay * s.base[1] + az * s.base[2];
      const e = new Float64Array([1 - k * ax * ax, -k * ax * ay, -k * ax * az, k * ax * d, -k * ay * ax, 1 - k * ay * ay, -k * ay * az, k * ay * d, -k * az * ax, -k * az * ay, 1 - k * az * az, k * az * d]);
      m = multiply(m, e);
    }
    const shown = tube && q < 1 ? Math.max(1, Math.round((s.path.length - 1) * easeOut(q))) : s.path.length - 1;

    const { right: R, up: U, fwd: F, eye: E } = b;
    const fx = cam.lens / aspect;
    const fy = cam.lens;
    // standard perspective depth over a range that always holds the scene
    const near = Math.max(1, cam.dist * 0.08);
    const far = cam.dist * 4 + 600;
    const A = (far + near) / (far - near);
    const B = (-2 * far * near) / (far - near);
    let minD = 1e9;
    for (let i = 0; i < n; i++) {
      let j = i;
      if (tube && shown < s.path.length - 1) {
        // a tube grows along its path: what isn't there yet waits at its growing end
        const skin = s.path.length * s.tubeRing;
        // (the round cap at its start stays; the one at its far end isn't there yet either)
        if (i >= skin ? i >= skin + 2 * s.tubeRing + 1 : i >= (shown + 1) * s.tubeRing) j = shown * s.tubeRing + (i % s.tubeRing);
      }
      const x = s.verts[j * 3];
      const y = s.verts[j * 3 + 1];
      const z = s.verts[j * 3 + 2];
      const wx = m[0] * x + m[1] * y + m[2] * z + m[3] - E[0];
      const wy = m[4] * x + m[5] * y + m[6] * z + m[7] - E[1];
      const wz = m[8] * x + m[9] * y + m[10] * z + m[11] - E[2];
      const d = wx * F[0] + wy * F[1] + wz * F[2];
      if (d < minD) minD = d;
      sd[i] = d;
      sx[i] = ((wx * R[0] + wy * R[1] + wz * R[2]) * fx) / d + cam.ox;
      sy[i] = ((wx * U[0] + wy * U[1] + wz * U[2]) * fy) / d + cam.oy;
    }
    if (minD < near * 1.1) return gone();
    let onScreen = false;
    const tone = s.src.tone === 2 ? 0.62 : s.src.tone === 1 ? 0.26 : 0;
    const lo = (id % 256) / 255;
    const hi = Math.floor(id / 256) / 255;
    for (let i = 0; i < n; i++) {
      const p = (v0 + i) * 3;
      pos[p] = sx[i];
      pos[p + 1] = sy[i];
      // later parts win where two faces lie in the same plane
      pos[p + 2] = A + B / (sd[i] - idx * 0.0016);
      const o = (v0 + i) * 4;
      info[o] = lo;
      info[o + 1] = hi;
      info[o + 2] = Math.min(1, tone + s.shade[i] * (tone > 0.5 ? 0.45 : 0.3));
      info[o + 3] = strength;
      if (drawn < 1 && !tube) pos[p] = pos[p + 1] = pos[p + 2] = 2;
      if (!onScreen && Math.abs(sx[i]) < 1.1 && Math.abs(sy[i]) < 1.1) onScreen = true;
    }
    // (a solid larger than the frame could have every corner off it, but a figure is always framed)
    if (!onScreen) return;

    const midD = sd[0];
    const perPx = midD / (cam.lens * 0.5 * H);
    const bias = 0.16 + perPx * 2.1;
    const bright = !!s.src.bright && lit;
    const edgeW = bright ? weight * 1.22 : weight;
    const edgeCh = bright ? BRIGHT : EDGE;
    const own = -strength;
    const depthZ = (d: number) => A + B / (d - bias);

    // creases and marks soften away when they would crowd the outline
    const creaseA = (inset: number) => strength * smooth((inset / perPx / weight - 0.9) / 1.6) * (q >= 1 ? 1 : smooth((q - 0.55) / 0.4));

    if (s.kind === 'hull') {
      const h = this.hullOf(s.hullStart, s.hullCount);
      this.loop(h, drawn, edgeW, edgeCh, id, own, depthZ);
      // a ball has no crease
      for (const c of s.creases) {
        const a = creaseA(c.inset);
        if (a < 0.02) continue;
        // is this end turned to us?
        if (!this.faces(m, c.cap, s, c.start, b)) continue;
        for (let i = 0; i < c.count; i++) {
          const j = (i + 1) % c.count;
          const sa: V3 = [c.side[i * 3], c.side[i * 3 + 1], c.side[i * 3 + 2]];
          const sb: V3 = [c.side[j * 3], c.side[j * 3 + 1], c.side[j * 3 + 2]];
          if (!this.faces(m, sa, s, c.start + i, b) || !this.faces(m, sb, s, c.start + j, b)) continue;
          const p = c.start + i;
          const r = c.start + j;
          this.push(sx[p], sy[p], depthZ(sd[p]), sx[r], sy[r], depthZ(sd[r]), weight * 0.82, DIM, id, -a);
        }
      }
    } else if (s.kind === 'edges') {
      const vis = s.faces.map((f) => this.faces(m, f.n, s, f.v, b));
      const a = creaseA(1.4);
      const total = s.edges.length;
      s.edges.forEach((e, i) => {
        const f = vis[e.f];
        const g = vis[e.g];
        if (f !== g) {
          if (i / total > drawn) return;
          this.push(sx[e.a], sy[e.a], depthZ(sd[e.a]), sx[e.b], sy[e.b], depthZ(sd[e.b]), edgeW, edgeCh, id, strength);
        } else if (f && e.corner && a > 0.02) {
          this.push(sx[e.ca], sy[e.ca], depthZ(sd[e.ca]), sx[e.cb], sy[e.cb], depthZ(sd[e.cb]), weight * 0.82, DIM, id, e.ca === e.a ? a * 0.8 : a);
        }
      });
    } else this.tube(s, m, b, cam, fx, fy, shown, edgeW, edgeCh, id, strength, A, B, bias);

    // marks
    const ma = strength * (q >= 1 ? 1 : smooth((q - 0.7) / 0.3));
    if (ma > 0.02 && s.marks.length) {
      const P = (p: V3): [number, number, number] => {
        const wx = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3] - E[0];
        const wy = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7] - E[1];
        const wz = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11] - E[2];
        const d = wx * F[0] + wy * F[1] + wz * F[2];
        return [((wx * R[0] + wy * R[1] + wz * R[2]) * fx) / d + cam.ox, ((wx * U[0] + wy * U[1] + wz * U[2]) * fy) / d + cam.oy, A + B / (d - bias)];
      };
      for (const mk of s.marks) {
        const ref = mk.segs[0]?.a ?? mk.dots[0].p;
        if (!this.facesAt(m, mk.n, ref, b)) continue;
        const ch = bright ? BRIGHT : DIM;
        const str = bright ? ma * 0.85 : ma;
        for (const g of mk.segs) {
          const a = P(g.a);
          const c = P(g.b);
          this.push(a[0], a[1], a[2], c[0], c[1], c[2], weight * 0.86, ch, id, -str);
        }
        for (const g of mk.dots) {
          // an oval dot as a short stroke: as long as the oval, as thick as it is thin
          const c = P(g.p);
          const u = P([g.p[0] + g.u[0], g.p[1] + g.u[1], g.p[2] + g.u[2]]);
          const w = P([g.p[0] + g.v[0], g.p[1] + g.v[1], g.p[2] + g.v[2]]);
          const ux = (u[0] - c[0]) * W * 0.5;
          const uy = (u[1] - c[1]) * H * 0.5;
          const vx = (w[0] - c[0]) * W * 0.5;
          const vy = (w[1] - c[1]) * H * 0.5;
          const e = (ux * ux + uy * uy + vx * vx + vy * vy) / 2;
          const det = ux * vy - uy * vx;
          const root = Math.sqrt(Math.max(0, e * e - det * det));
          const major = Math.sqrt(e + root);
          const minor = Math.sqrt(Math.max(0, e - root));
          const ang = 0.5 * Math.atan2(2 * (ux * uy + vx * vy), ux * ux + vx * vx - uy * uy - vy * vy);
          const len = Math.max(0, major - minor);
          const dx = (Math.cos(ang) * len * 1.2) / W;
          const dy = (Math.sin(ang) * len * 1.2) / H;
          const wide = Math.max(minor * 2.15, weight * 0.5);
          this.push(c[0] - dx, c[1] - dy, c[2], c[0] + dx, c[1] + dy, c[2], wide, ch, id, -str);
        }
      }
    }
  }

  /** does a direction at a vertex face the eye? */
  private faces(m: Mat, n: V3, s: BuiltSolid, vert: number, b: Basis): boolean {
    return this.facesAt(m, n, [s.verts[vert * 3], s.verts[vert * 3 + 1], s.verts[vert * 3 + 2]], b);
  }
  private facesAt(m: Mat, n: V3, p: V3, b: Basis): boolean {
    const nx = m[0] * n[0] + m[1] * n[1] + m[2] * n[2];
    const ny = m[4] * n[0] + m[5] * n[1] + m[6] * n[2];
    const nz = m[8] * n[0] + m[9] * n[1] + m[10] * n[2];
    const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3] - b.eye[0];
    const y = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7] - b.eye[1];
    const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11] - b.eye[2];
    return nx * x + ny * y + nz * z < 1e-6 * Math.hypot(x, y, z);
  }

  /** the outline of a convex solid: the hull of its points on screen (indices into the scratch) */
  private hullOf(start: number, count: number): Int32Array {
    const { sx, sy, order, hull } = this;
    for (let i = 0; i < count; i++) order[i] = start + i;
    const list = order.subarray(0, count);
    list.sort((a, b) => sx[a] - sx[b] || sy[a] - sy[b]);
    const turnOf = (o: number, a: number, b: number) => (sx[a] - sx[o]) * (sy[b] - sy[o]) - (sy[a] - sy[o]) * (sx[b] - sx[o]);
    let k = 0;
    for (let i = 0; i < count; i++) {
      while (k >= 2 && turnOf(hull[k - 2], hull[k - 1], list[i]) <= 1e-12) k--;
      hull[k++] = list[i];
    }
    const t = k + 1;
    for (let i = count - 2; i >= 0; i--) {
      while (k >= t && turnOf(hull[k - 2], hull[k - 1], list[i]) <= 1e-12) k--;
      hull[k++] = list[i];
    }
    return hull.subarray(0, Math.max(0, k - 1));
  }

  /** a closed outline, drawn on from its nearest point both ways as `part` goes 0..1 */
  private loop(h: Int32Array, part: number, w: number, ch: number, id: number, strength: number, z: (d: number) => number) {
    const { sx, sy, sd } = this;
    const n = h.length;
    let start = 0;
    if (part < 1) for (let i = 1; i < n; i++) if (sy[h[i]] < sy[h[start]]) start = i;
    const half = (n / 2) * part;
    for (let i = 0; i < n; i++) {
      const a = h[(start + i) % n];
      const b = h[(start + i + 1) % n];
      if (part < 1) {
        const from = Math.min(i, n - i - 1);
        if (from > half) continue;
      }
      this.push(sx[a], sy[a], z(sd[a]), sx[b], sy[b], z(sd[b]), w, ch, id, strength);
    }
  }

  /** a tube's two sides and round ends */
  private tube(s: BuiltSolid, m: Mat, b: Basis, cam: Camera, fx: number, fy: number, shown: number, w: number, ch: number, id: number, strength: number, A: number, B: number, bias: number) {
    const scale = Math.hypot(m[0], m[4], m[8]) || 1;
    const r = s.tubeR * scale;
    const pts: V3[] = [];
    for (let i = 0; i <= shown; i++) {
      const p = s.path[i];
      pts.push([m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]]);
    }
    const n = pts.length;
    if (n < 2) return;
    const P = (p: V3): [number, number, number] => {
      const x = p[0] - b.eye[0];
      const y = p[1] - b.eye[1];
      const z = p[2] - b.eye[2];
      const d = x * b.fwd[0] + y * b.fwd[1] + z * b.fwd[2];
      // the side of a tube sits half a tube behind its own front: look past it, but not past what's in front
      return [((x * b.right[0] + y * b.right[1] + z * b.right[2]) * fx) / d + cam.ox, ((x * b.up[0] + y * b.up[1] + z * b.up[2]) * fy) / d + cam.oy, A + B / (d - bias - r * 0.55)];
    };
    const L: [number, number, number][] = [];
    const Rr: [number, number, number][] = [];
    let first: V3 | null = null;
    let last: V3 = [1, 0, 0];
    const closed = s.closed && shown === s.path.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q0 = pts[i > 0 ? i - 1 : closed ? n - 2 : 0];
      const q1 = pts[i < n - 1 ? i + 1 : closed ? 1 : n - 1];
      const t: V3 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
      const e: V3 = [p[0] - b.eye[0], p[1] - b.eye[1], p[2] - b.eye[2]];
      let o: V3 = [e[1] * t[2] - e[2] * t[1], e[2] * t[0] - e[0] * t[2], e[0] * t[1] - e[1] * t[0]];
      const l = Math.hypot(...o);
      // pointing straight at us: keep the last side
      o = l > 1e-4 * Math.hypot(...e) * Math.hypot(...t) ? [o[0] / l, o[1] / l, o[2] / l] : last;
      first ??= o;
      last = o;
      L.push(P([p[0] + o[0] * r, p[1] + o[1] * r, p[2] + o[2] * r]));
      Rr.push(P([p[0] - o[0] * r, p[1] - o[1] * r, p[2] - o[2] * r]));
    }
    for (let i = 0; i < n - 1; i++) {
      this.push(...L[i], ...L[i + 1], w, ch, id, strength);
      this.push(...Rr[i], ...Rr[i + 1], w, ch, id, strength);
    }
    if (closed) return;
    for (const end of [0, n - 1]) {
      const seated = s.src.seats?.[end === 0 ? 0 : 1] && (end === 0 || shown === s.path.length - 1);
      if (seated) {
        // it stands on a face: the near half of its foot, square to its run
        const p = pts[end];
        const q = end === 0 ? pts[1] : pts[n - 2];
        const t: V3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        const tl = Math.hypot(...t) || 1;
        const o = end === 0 ? first! : last;
        let g: V3 = [(t[1] * o[2] - t[2] * o[1]) / tl, (t[2] * o[0] - t[0] * o[2]) / tl, (t[0] * o[1] - t[1] * o[0]) / tl];
        if (g[0] * (p[0] - b.eye[0]) + g[1] * (p[1] - b.eye[1]) + g[2] * (p[2] - b.eye[2]) > 0) g = [-g[0], -g[1], -g[2]];
        let prev: [number, number, number] | null = null;
        for (let k = 0; k <= 12; k++) {
          const a = (k / 12) * Math.PI;
          const at = P([0, 1, 2].map((j) => p[j] + (o[j] * Math.cos(a) + g[j] * Math.sin(a)) * r) as V3);
          if (prev) this.push(...prev, ...at, w, ch, id, strength);
          prev = at;
        }
        continue;
      }
      const p = pts[end];
      const o = end === 0 ? first! : last;
      // half a circle in the plane facing us, round the far side of the end
      const q = end === 0 ? pts[1] : pts[n - 2];
      const e: V3 = [p[0] - b.eye[0], p[1] - b.eye[1], p[2] - b.eye[2]];
      const el = Math.hypot(...e);
      let c: V3 = [(e[1] * o[2] - e[2] * o[1]) / el, (e[2] * o[0] - e[0] * o[2]) / el, (e[0] * o[1] - e[1] * o[0]) / el];
      const out = c[0] * (p[0] - q[0]) + c[1] * (p[1] - q[1]) + c[2] * (p[2] - q[2]);
      if (out < 0) c = [-c[0], -c[1], -c[2]];
      let prev: [number, number, number] | null = null;
      for (let k = 0; k <= 12; k++) {
        const a = (k / 12) * Math.PI;
        const at = P([0, 1, 2].map((j) => p[j] + (o[j] * Math.cos(a) + c[j] * Math.sin(a)) * r) as V3);
        if (prev) this.push(...prev, ...at, w, ch, id, strength);
        prev = at;
      }
    }
  }

  /** dashed drops from a part that has been carried up, back to where it rests */
  private guides(s: BuiltSolid, m: Mat, place: Mat, by: number, b: Basis, cam: Camera, aspect: number, W: number, H: number, strength: number, weight: number) {
    const fx = cam.lens / aspect;
    const near = Math.max(1, cam.dist * 0.08);
    const far = cam.dist * 4 + 600;
    const A = (far + near) / (far - near);
    const B = (-2 * far * near) / (far - near);
    const P = (p: V3, mat: Mat): [number, number, number] => {
      const x = mat[0] * p[0] + mat[1] * p[1] + mat[2] * p[2] + mat[3] - b.eye[0];
      const y = mat[4] * p[0] + mat[5] * p[1] + mat[6] * p[2] + mat[7] - b.eye[1];
      const z = mat[8] * p[0] + mat[9] * p[1] + mat[10] * p[2] + mat[11] - b.eye[2];
      const d = x * b.fwd[0] + y * b.fwd[1] + z * b.fwd[2];
      return [((x * b.right[0] + y * b.right[1] + z * b.right[2]) * fx) / d + cam.ox, ((x * b.up[0] + y * b.up[1] + z * b.up[2]) * cam.lens) / d + cam.oy, A + B / (d - 0.5)];
    };
    const a = strength * smooth((by - 1.2) / 4) * 0.9;
    for (const f of s.feet) {
      const p = P(f, m);
      const q = P(f, place);
      const px = Math.hypot((q[0] - p[0]) * W * 0.5, (q[1] - p[1]) * H * 0.5);
      const step = weight * 4.2;
      const n = Math.floor(px / step);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = p[0] + (q[0] - p[0]) * t;
        const y = p[1] + (q[1] - p[1]) * t;
        const z = p[2] + (q[2] - p[2]) * t;
        this.push(x, y, z, x, y, z, weight * 1.05, DIM, 0, a);
      }
    }
  }

  /** what the last frame held: strokes, solids, and the milliseconds spent working them out */
  get last() {
    return this.stats;
  }

  dispose() {
    this.fillRT.depthTexture?.dispose();
    this.fillRT.dispose();
    this.lineRT.dispose();
    this.fillGeo.dispose();
    this.lineGeo.dispose();
    this.fillMat.dispose();
    this.lineMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

/** 0..1 per solid: when it starts in the build-in: the big parts first, then what stands on them, low before high */
const orders = new WeakMap<BuiltFigure, Float64Array>();
function buildOrder(f: BuiltFigure): Float64Array {
  let o = orders.get(f);
  if (o) return o;
  // (a tube's box is mostly air)
  const vol = f.solids.map((s) => Math.log(Math.max(0.5, s.kind === 'tube' ? 30 * s.tubeR * s.tubeR : (s.hi[0] - s.lo[0]) * (s.hi[1] - s.lo[1]) * (s.hi[2] - s.lo[2]))));
  const tall = Math.max(1, f.hi[2] - f.lo[2]);
  const key = f.solids.map((s, i) => -vol[i] + (2.4 * (s.lo[2] - f.lo[2])) / tall + (0.6 * (s.mid[0] - f.mid[0] + s.mid[1] - f.mid[1])) / tall);
  const sorted = key.map((_, i) => i).sort((a, b) => key[a] - key[b]);
  o = new Float64Array(f.solids.length);
  sorted.forEach((i, r) => (o![i] = f.solids.length > 1 ? r / (f.solids.length - 1) : 0));
  orders.set(f, o);
  return o;
}

/** the points a figure can reach: at rest, and at the far end of its motions */
export function reachOf(f: BuiltFigure, drives: Drive[], amount: number): V3[] {
  const out: V3[] = [];
  for (const d of drives) {
    const { mats } = pose(f, d, amount);
    f.solids.forEach((s, i) => {
      const m = mats[i];
      // the eight corners would overshoot for a tilted or round part: its real points, thinned
      const n = s.verts.length / 3;
      const step = Math.max(1, Math.floor(n / 40));
      for (let k = 0; k < n; k += step) {
        const x = s.verts[k * 3];
        const y = s.verts[k * 3 + 1];
        const z = s.verts[k * 3 + 2];
        out.push([m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]);
      }
    });
  }
  return out;
}
