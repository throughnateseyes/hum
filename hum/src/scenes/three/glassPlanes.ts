/**
 * Glass Planes — isometric zig-zag strips of translucent glass. Cloudy blue-teal panels with thin
 * glowing edges and long hairline construction lines running past them, slowly drifting.
 * Kicks push the ledges out (the strips extrude), snares streak light along the construction
 * lines, and a drop re-folds the whole structure into a new shape.
 *
 * The folded strips are built in 3D on the CPU, projected with a hand-made isometric camera, and
 * drawn as 2D geometry in clip space, so every line keeps an exact pixel width at any size.
 */
import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, isLightPalette, makeMaterial, setAdaptiveBlending, Spring, stepDt, syncMaterial } from './common';

const SEGS = 6;
const MAX_STRIPS = 5;
const MAX_PANELS = MAX_STRIPS * SEGS;
const MAX_LINES = 900;

const params: ParamDef[] = [
  { id: 'strips', label: 'Strips', group: 'Shape', type: 'number', min: 1, max: MAX_STRIPS, step: 1, default: 3 },
  { id: 'zoom', label: 'Zoom', group: 'Shape', type: 'number', min: 0.5, max: 3, step: 0.01, default: 1.7, hint: 'Above 1 the structure runs off the edges' },
  { id: 'glass', label: 'Glass fill', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'How cloudy and bright the panels are' },
  { id: 'lines', label: 'Construction lines', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Hairlines extending past the panel edges' },
  { id: 'edge', label: 'Edge width', group: 'Shape', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1.2 },
  { id: 'drift', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Slow turn and float of the whole structure' },
  { id: 'extrude', label: 'Kick extrude', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Kicks push the ledges out' },
  { id: 'streak', label: 'Snare streaks', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Snares fire light along the construction lines' },
  { id: 'refold', label: 'Drop re-fold', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Drops fold the strips into a new shape' },
];

const VERT_FILL = /* glsl */ `
attribute vec2 aUv;
attribute float aId;
attribute float aFace;
varying vec2 vPUv;
varying float vId;
varying float vFace;
void main() {
  vPUv = aUv;
  vId = aId;
  vFace = aFace;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG_FILL = /* glsl */ `
uniform float uCloudT, uGlassE, uLight, uKickE;
varying vec2 vPUv;
varying float vId;
varying float vFace;
void main() {
  vec2 q = vPUv * vec2(2.2, 1.6) + vec2(vId * 3.7, vId * 1.3);
  float c = fbm(q + vec2(uCloudT * 0.07, -uCloudT * 0.05), 4) * 0.5 + 0.5;
  float wisps = fbm(q * 2.3 - vec2(uCloudT * 0.11, 0.0), 3) * 0.5 + 0.5;
  float cloud = smoothstep(0.35, 0.95, c * 0.75 + wisps * 0.45);
  // glass catches more light toward its edges
  vec2 e = min(vPUv, 1.0 - vPUv);
  float rim = 1.0 - smoothstep(0.0, 0.18, min(e.x, e.y));
  float face = mix(0.7, 1.0, vFace);
  vec3 deep = mix(uBg, uAccent2, 0.55);
  vec3 col = mix(deep, mix(uAccent2, uFg, 0.55), cloud) * face;
  float a = (0.16 + 0.5 * cloud + 0.18 * rim) * uGlassE * (1.0 + uKickE * 0.35);
  if (uLight > 0.5) {
    gl_FragColor = vec4(mix(uAccent2, uFg, 0.25 * cloud), a * 0.55);
  } else {
    gl_FragColor = vec4(col * a, 1.0);
  }
}
`;

const VERT_LINE = /* glsl */ `
attribute float aSide;
attribute float aAlong;
attribute float aKind;
attribute float aHw;
attribute float aSeed;
varying float vSide;
varying float vAlong;
varying float vKind;
varying float vHw;
varying float vSeed;
void main() {
  vSide = aSide; vAlong = aAlong; vKind = aKind; vHw = aHw; vSeed = aSeed;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG_LINE = /* glsl */ `
uniform float uStreakT, uStreakAmt, uLight, uKickE, uPx, uSeedK;
varying float vSide;
varying float vAlong;
varying float vKind;
varying float vHw;
varying float vSeed;
void main() {
  float d = abs(vSide) * vHw;              // px from the line's centre
  float edge = step(0.5, vKind);            // 1 = panel edge, 0 = construction line
  float core = exp(-pow(d / (mix(0.5, 0.75, edge) * uPx * u_edge), 2.0));
  float halo = exp(-d / (mix(1.5, 3.0, edge) * uPx)) * mix(0.16, 0.32, edge);
  // construction lines fade toward both ends
  float ends = smoothstep(0.0, 0.25, vAlong) * smoothstep(1.0, 0.75, vAlong);
  float k = mix(ends * 0.55 * u_lines, 1.0, edge);
  // snare streak: a bright pulse runs along a random subset of construction lines
  float pick = step(fract(vSeed * 7.13 + uSeedK * 0.618), 0.45);
  float sp = (vAlong - uStreakT * 1.3 + 0.15);
  float streak = (1.0 - edge) * pick * exp(-sp * sp / 0.006) * uStreakAmt * u_streak;
  vec3 col = mix(mix(uAccent2, uFg, 0.6), uAccent, edge);
  float i = (core + halo) * k * (1.0 + uKickE * 0.6 * edge) + streak * (core * 2.5 + halo * 2.0);
  col = mix(col, uFg, clamp(streak, 0.0, 1.0) * 0.7);
  if (uLight > 0.5) {
    vec3 ink = mix(uFg, uAccent, edge * 0.6);
    gl_FragColor = vec4(ink, clamp(i, 0.0, 1.0));
  } else {
    gl_FragColor = vec4(col * i, 1.0);
  }
}
`;

type V3 = [number, number, number];

/** a spring that remembers where it's heading */
class Fold extends Spring {
  target: number;
  constructor(k: number, d: number, v0: number) {
    super(k, d, v0);
    this.target = v0;
  }
}

interface Strip {
  /** per-segment fold angle (radians in the strip's own plane) and length */
  ang: Fold[];
  len: number[];
  ledge: boolean[];
  yaw: Fold;
  origin: V3;
  width: number;
}

export const glassPlanes = defineThreeScene({
  id: 'glass-planes',
  name: 'Glass Planes',
  description:
    'Isometric zig-zag strips of cloudy blue-teal glass with thin glowing yellow-green edges and long hairline construction lines running past them, slowly drifting. Kicks push the ledges out, snares streak light along the lines, and a drop re-folds the whole structure into a new shape.',
  category: 'form',
  style: 'light',
  tags: ['architectural', 'cold', 'cinematic', 'techno', 'minimal', 'hypnotic', 'electronic', 'dark', 'ambient'],
  params,
  modulations: [{ source: 'energy', param: 'glass', amount: 0.15 }],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── fill geometry ──
    const fPos = new Float32Array(MAX_PANELS * 4 * 3);
    const fUv = new Float32Array(MAX_PANELS * 4 * 2);
    const fId = new Float32Array(MAX_PANELS * 4);
    const fFace = new Float32Array(MAX_PANELS * 4);
    const fIdx: number[] = [];
    for (let i = 0; i < MAX_PANELS; i++) {
      const o = i * 4;
      fIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      fUv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    }
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    fillGeo.setAttribute('aUv', new THREE.BufferAttribute(fUv, 2));
    fillGeo.setAttribute('aId', new THREE.BufferAttribute(fId, 1));
    fillGeo.setAttribute('aFace', new THREE.BufferAttribute(fFace, 1));
    fillGeo.setIndex(fIdx);
    const fillMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT_FILL,
      fragment: FRAG_FILL,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      extra: { uCloudT: { value: 0 }, uGlassE: { value: 1 }, uLight: { value: 0 }, uKickE: { value: 0 } },
    });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.frustumCulled = false;
    scene.add(fill);

    // ── line geometry ──
    const lPos = new Float32Array(MAX_LINES * 4 * 3);
    const lSide = new Float32Array(MAX_LINES * 4);
    const lAlong = new Float32Array(MAX_LINES * 4);
    const lKind = new Float32Array(MAX_LINES * 4);
    const lHw = new Float32Array(MAX_LINES * 4);
    const lSeed = new Float32Array(MAX_LINES * 4);
    const lIdx: number[] = [];
    for (let i = 0; i < MAX_LINES; i++) {
      const o = i * 4;
      lIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      lSide.set([-1, 1, 1, -1], o);
      lAlong.set([0, 0, 1, 1], o);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
    lineGeo.setAttribute('aSide', new THREE.BufferAttribute(lSide, 1));
    lineGeo.setAttribute('aAlong', new THREE.BufferAttribute(lAlong, 1));
    lineGeo.setAttribute('aKind', new THREE.BufferAttribute(lKind, 1));
    lineGeo.setAttribute('aHw', new THREE.BufferAttribute(lHw, 1));
    lineGeo.setAttribute('aSeed', new THREE.BufferAttribute(lSeed, 1));
    lineGeo.setIndex(lIdx);
    const lineMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT_LINE,
      fragment: FRAG_LINE,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      extra: {
        uStreakT: { value: 9 },
        uStreakAmt: { value: 0 },
        uLight: { value: 0 },
        uKickE: { value: 0 },
        uPx: { value: 1 },
        uSeedK: { value: 0 },
      },
    });
    const lines = new THREE.Mesh(lineGeo, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    scene.add(lines);

    // ── the strips ──
    const strips: Strip[] = [];
    const DOWN = -Math.PI / 2;
    const fold = (s: Strip, variant: number) => {
      // segments alternate: wall (mostly down) then ledge (out toward or away from the viewer)
      const ledgeDir = variant % 3 === 0 ? 0 : variant % 3 === 1 ? Math.PI : Math.PI * 0.12;
      for (let j = 0; j < SEGS; j++) {
        const wall = j % 2 === 0;
        s.ledge[j] = !wall;
        let target = wall ? DOWN + (Math.random() - 0.5) * 0.25 * (variant > 0 ? 1 : 0) : ledgeDir + (j % 4 === 1 ? 0 : variant === 4 ? Math.PI : 0);
        if (variant >= 5 && wall && Math.random() < 0.4) target = DOWN + (Math.random() < 0.5 ? 0.6 : -0.6);
        // keep the spring continuous: pick the target closest to the current angle mod 2π
        target += Math.round((s.ang[j].value - target) / (Math.PI * 2)) * Math.PI * 2;
        s.ang[j].target = target;
        s.len[j] = wall ? 1.6 + Math.random() * 0.9 : 0.6 + Math.random() * 0.45;
      }
      const yawT = [0, Math.PI / 2, -Math.PI / 4, Math.PI / 6][variant % 4];
      s.yaw.target = yawT + (Math.random() - 0.5) * 0.3;
      s.width = 1.3 + Math.random() * 0.6;
    };
    for (let i = 0; i < MAX_STRIPS; i++) {
      const s: Strip = {
        ang: Array.from({ length: SEGS }, (_, j) => new Fold(26, 7, j % 2 === 0 ? DOWN : 0)),
        len: new Array(SEGS).fill(1),
        ledge: new Array(SEGS).fill(false),
        yaw: new Fold(10, 5, 0),
        origin: [0, 0, 0],
        width: 1.2,
      };
      fold(s, 0);
      for (const a of s.ang) a.value = a.target;
      s.yaw.value = s.yaw.target;
      strips.push(s);
    }

    const kick = new Spring(240, 14);
    let streakT = 9;
    let streakAmt = 0;
    let seedK = 0;
    let variant = 0;
    let prevDrop = 0;
    let az = 0;
    let floatT = 0;
    let cloudT = 0;
    const fit = { cx: 0, cy: 0, s: 0.3 };

    // scratch
    const pts: V3[] = [];
    const proj = (p: V3, out: [number, number], cosA: number, sinA: number) => {
      // isometric: yaw around y, then a fixed 32° tilt
      const x = p[0] * cosA - p[2] * sinA;
      const z = p[0] * sinA + p[2] * cosA;
      const el = 0.56;
      out[0] = x;
      out[1] = p[1] * Math.cos(el) + z * Math.sin(el);
    };

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const light = isLightPalette(frame.palette);
        syncMaterial(fillMat, frame, params);
        syncMaterial(lineMat, frame, params);
        bg.copy(frame.palette.c.bg);
        setAdaptiveBlending(fillMat, light);
        setAdaptiveBlending(lineMat, light);
        const W = frame.width;
        const H = frame.height;
        const px = H / 1080;

        // ── audio ──
        if (a.drop > 0.6 && prevDrop <= 0.6 && num(p, 'refold', 1) > 0) {
          variant = (variant + 1 + Math.floor(Math.random() * 5)) % 7;
          for (const s of strips) fold(s, variant);
          streakT = 0;
          streakAmt = 1;
          seedK = Math.random() * 100;
        }
        prevDrop = a.drop;
        kick.step(a.kick, dt);
        if (a.snareHit) {
          streakT = 0;
          streakAmt = 0.6 + a.snare * 0.4;
          seedK = Math.random() * 100;
        }
        streakT += dt * 2.2;
        streakAmt = approach(streakAmt, 0, 1.5, dt);

        const drift = num(p, 'drift', 0.35);
        az += dt * drift * 0.08 * (0.6 + a.energy);
        floatT += dt * drift * (0.5 + a.energy * 0.5);
        cloudT += dt * (0.4 + a.energy * 1.2 + a.mid * 0.5);
        const yaw0 = 0.785 + Math.sin(az) * 0.35 + a.sway * 0.03;
        const extrude = num(p, 'extrude', 0.6) * Math.max(-0.2, kick.value) * 0.55;
        const nStrips = Math.round(num(p, 'strips', 3));

        // ── build strips in 3D ──
        let pi = 0;
        let li = 0;
        let minX = 1e9;
        let maxX = -1e9;
        let minY = 1e9;
        let maxY = -1e9;
        const panels: { c: V3[]; face: number; id: number }[] = [];
        const segs: { a: V3; b: V3; kind: number; ext: number; seed: number }[] = [];
        for (let si = 0; si < nStrips; si++) {
          const s = strips[si];
          for (const g of s.ang) g.step(g.target, dt);
          s.yaw.step(s.yaw.target, dt);
          const yaw = s.yaw.value;
          // width axis (E) and the "forward" axis of the fold plane, both horizontal
          const E: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
          const F: V3 = [-Math.sin(yaw), 0, Math.cos(yaw)];
          const spread = (si - (nStrips - 1) / 2) * 2.3;
          const bob = Math.sin(floatT * 0.6 + si * 1.7) * 0.12;
          let P: V3 = [spread * 0.9 - F[0] * spread * 0.4, 2.6 - si * 0.35 + bob, spread * 0.55 - F[2] * spread * 0.4];
          pts.length = 0;
          pts.push(P);
          for (let j = 0; j < SEGS; j++) {
            const ang = s.ang[j].value;
            const L = s.len[j] * (s.ledge[j] ? 1 + extrude * (j % 4 === 1 ? 1.4 : 0.8) : 1);
            const dy = Math.sin(ang) * L;
            const df = Math.cos(ang) * L;
            P = [P[0] + F[0] * df, P[1] + dy, P[2] + F[2] * df];
            pts.push(P);
          }
          const wv: V3 = [E[0] * s.width, 0, E[2] * s.width];
          for (let j = 0; j < SEGS; j++) {
            const A = pts[j];
            const B = pts[j + 1];
            const A2: V3 = [A[0] + wv[0], A[1], A[2] + wv[2]];
            const B2: V3 = [B[0] + wv[0], B[1], B[2] + wv[2]];
            panels.push({ c: [A, A2, B2, B], face: s.ledge[j] ? 1 : 0, id: si * SEGS + j });
            // glowing panel edges: the two fold-direction edges
            segs.push({ a: A, b: B, kind: 1, ext: 0, seed: pi + j * 0.13 });
            segs.push({ a: A2, b: B2, kind: 1, ext: 0, seed: pi + j * 0.29 });
            // construction lines continuing those edges far past the panel
            if ((j + si) % 2 === 0) segs.push({ a: A, b: B, kind: 0, ext: 2.6, seed: si * 11 + j * 1.7 });
            if ((j + si) % 3 === 1) segs.push({ a: A2, b: B2, kind: 0, ext: 3.2, seed: si * 7 + j * 2.3 });
          }
          for (let j = 0; j <= SEGS; j++) {
            const A = pts[j];
            const A2: V3 = [A[0] + wv[0], A[1], A[2] + wv[2]];
            // fold creases: glowing across the strip, and hairlines extended along the width axis
            segs.push({ a: A, b: A2, kind: 1, ext: 0, seed: j * 3.1 + si });
            segs.push({ a: A, b: A2, kind: 0, ext: 2.2 + ((j * 7 + si * 3) % 5) * 0.5, seed: j * 5.3 + si * 2.1 });
          }
          // a couple of long free-standing verticals per strip, like the reference's guides
          const top = pts[0];
          segs.push({ a: [top[0] + wv[0] * 0.5, top[1] + 1.5, top[2] + wv[2] * 0.5], b: [top[0] + wv[0] * 0.5, top[1] - 5, top[2] + wv[2] * 0.5], kind: 0, ext: 0.5, seed: si * 9.7 });
          pi++;
        }

        // ── project + fit ──
        const cosA = Math.cos(yaw0);
        const sinA = Math.sin(yaw0);
        const q: [number, number] = [0, 0];
        for (const pn of panels)
          for (const c of pn.c) {
            proj(c, q, cosA, sinA);
            if (q[0] < minX) minX = q[0];
            if (q[0] > maxX) maxX = q[0];
            if (q[1] < minY) minY = q[1];
            if (q[1] > maxY) maxY = q[1];
          }
        const aspect = W / H;
        const zoom = num(p, 'zoom', 1.15);
        const sTarget = (Math.min((2 * aspect) / Math.max(0.1, maxX - minX), 2 / Math.max(0.1, maxY - minY)) * zoom) * 0.92;
        fit.cx = approach(fit.cx, (minX + maxX) / 2, 1.5, dt);
        fit.cy = approach(fit.cy, (minY + maxY) / 2, 1.5, dt);
        fit.s = approach(fit.s, sTarget, 1.5, dt);
        // screen in device px from world
        const toPx = (p3: V3, out: [number, number]) => {
          proj(p3, out, cosA, sinA);
          out[0] = (out[0] - fit.cx) * fit.s * (H / 2) + W / 2;
          out[1] = (out[1] - fit.cy) * fit.s * (H / 2) + H / 2;
        };

        // fills
        let np = 0;
        for (const pn of panels) {
          if (np >= MAX_PANELS) break;
          for (let k = 0; k < 4; k++) {
            toPx(pn.c[k], q);
            const o = (np * 4 + k) * 3;
            fPos[o] = (q[0] / W) * 2 - 1;
            fPos[o + 1] = (q[1] / H) * 2 - 1;
            fPos[o + 2] = 0;
            fId[np * 4 + k] = pn.id;
            fFace[np * 4 + k] = pn.face;
          }
          np++;
        }
        fillGeo.setDrawRange(0, np * 6);
        (fillGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (fillGeo.attributes.aId as THREE.BufferAttribute).needsUpdate = true;
        (fillGeo.attributes.aFace as THREE.BufferAttribute).needsUpdate = true;

        // lines
        const lineAmt = num(p, 'lines', 0.6);
        const edgeW = num(p, 'edge', 1.2);
        const qa: [number, number] = [0, 0];
        const qb: [number, number] = [0, 0];
        for (const sg of segs) {
          if (li >= MAX_LINES) break;
          if (sg.kind === 0 && lineAmt <= 0.01) continue;
          toPx(sg.a, qa);
          toPx(sg.b, qb);
          let dx = qb[0] - qa[0];
          let dy = qb[1] - qa[1];
          const len = Math.hypot(dx, dy);
          if (len < 0.5) continue;
          dx /= len;
          dy /= len;
          const ext = sg.ext * fit.s * (H / 2) * (sg.kind === 0 ? 0.6 + lineAmt * 0.6 : 0);
          const ax = qa[0] - dx * ext;
          const ay = qa[1] - dy * ext;
          const bx = qb[0] + dx * ext;
          const by = qb[1] + dy * ext;
          const hw = (sg.kind === 1 ? 5 * edgeW : 3) * px + 1;
          const nx = -dy * hw;
          const ny = dx * hw;
          const corners = [
            [ax - nx, ay - ny],
            [ax + nx, ay + ny],
            [bx + nx, by + ny],
            [bx - nx, by - ny],
          ];
          for (let k = 0; k < 4; k++) {
            const o = (li * 4 + k) * 3;
            lPos[o] = (corners[k][0] / W) * 2 - 1;
            lPos[o + 1] = (corners[k][1] / H) * 2 - 1;
            lPos[o + 2] = 0;
            lKind[li * 4 + k] = sg.kind;
            lHw[li * 4 + k] = hw;
            lSeed[li * 4 + k] = sg.seed;
          }
          li++;
        }
        lineGeo.setDrawRange(0, li * 6);
        for (const k of ['position', 'aKind', 'aHw', 'aSeed']) (lineGeo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;

        const fu = fillMat.uniforms;
        fu.uCloudT.value = cloudT % 1000;
        fu.uGlassE.value = num(p, 'glass', 0.65) * (0.8 + a.energy * 0.4 + a.bass * 0.2);
        fu.uLight.value = light ? 1 : 0;
        fu.uKickE.value = Math.max(0, kick.value);
        const lu = lineMat.uniforms;
        lu.uStreakT.value = streakT;
        lu.uStreakAmt.value = streakAmt;
        lu.uLight.value = light ? 1 : 0;
        lu.uKickE.value = Math.max(0, kick.value);
        lu.uPx.value = px;
        lu.uSeedK.value = seedK;
      },
    };
  },
});
