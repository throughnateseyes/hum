/**
 * The first set of motifs for shots (prototype; the contract is in src/shot/kit.ts).
 *
 *   guides    frame  two thin lines through the focus point, and a ring that closes in on it as the
 *                    shot speeds up into its cut
 *   arcs      frame  rings broken into arcs round the focus point; each snare knocks them round a notch
 *   burst     world  small shapes thrown out from the focus point on arrival, tumbling, then left
 *                    hanging in the space the shot flies through
 *   bars      world  a flat bar slides in on every kick, near the plane in focus, then drifts past the lens
 *   blocks    world  large slabs standing at every depth, some of them windows onto a live look
 *   word      frame  the shot's word, rising letter by letter, with a small line under it
 *   cardType  frame  the whole phrase set as a block of type, one word to a line
 *   ruler     frame  a tick for every beat of the run of shots, the hit's tick standing taller
 */
import * as THREE from 'three';
import { SHAPE, ShapeCloud, inkOf, type MotifContext, type MotifFactory, type MotifFrame, type ShapeId } from '../kit';
import { clamp01, easeInCubic, easeInExpo, easeOutBack, easeOutCubic, easeOutExpo, smooth } from '../time';
import { MONO_FONT, typeLine, type TypeLine } from './type';

const TAU = Math.PI * 2;
const unit = new THREE.PlaneGeometry(1, 1);

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** a ring, or a stretch of one: radius and width are fractions of the quad's half size */
const ARC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uR, uW, uA0, uSweep, uAlpha;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float aa = fwidth(r);
  float ring = smoothstep(uW * 0.5 + aa, uW * 0.5 - aa, abs(r - uR));
  float d = mod(atan(p.y, p.x) - uA0, 6.2831853) * r;
  float ends = smoothstep(0.0, aa * 1.5, d) * smoothstep(uSweep * r + aa, uSweep * r - aa, d);
  float a = ring * mix(ends, 1.0, step(6.2, uSweep)) * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

interface Arc {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  r: number;
  sweep: number;
  a0: number;
  turn: number;
  delay: number;
}

const arcQuad = new THREE.PlaneGeometry(2, 2);
function makeArc(group: THREE.Object3D, size: number, color: THREE.Color, r: number, w: number, sweep: number, a0: number, turn: number, delay: number): Arc {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: ARC_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uColor: { value: color }, uR: { value: r }, uW: { value: w }, uA0: { value: a0 }, uSweep: { value: sweep }, uAlpha: { value: 1 } },
  });
  const mesh = new THREE.Mesh(arcQuad, mat);
  mesh.scale.setScalar(size);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  group.add(mesh);
  return { mesh, u: mat.uniforms, r, sweep, a0, turn, delay };
}

function flatPlane(group: THREE.Object3D, color: THREE.Color, opacity: number, order: number): THREE.Mesh {
  const mesh = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  group.add(mesh);
  return mesh;
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
  });
}

/** 0 until the shot is on its way out (only a shot that settles clears its graphics), then up to 1 */
const leaving = (ctx: MotifContext, t: number) => (ctx.leave === 'settle' ? smooth(ctx.end - ctx.beat * 2.2, ctx.end - ctx.beat * 0.5, t) : 0);

/* ───────── guides ───────── */

export const guides: MotifFactory = (ctx) => {
  const group = new THREE.Group();
  const ink = inkOf(ctx.palette, 'ink');
  const lines = [false, true].map((upright) => ({ upright, mesh: flatPlane(group, ink, 0.7, 2) }));
  const ring = makeArc(group, Math.max(ctx.halfW, ctx.halfH) * 1.1, ink, 0.6, 0.005, TAU, 0, 0, 0);
  const { start, end, beat, halfW, halfH } = ctx;
  const rampStart = end - ctx.rampBeats * beat;
  return {
    space: 'frame',
    object: group,
    update(f: MotifFrame) {
      const drawn = easeOutCubic(clamp01((f.t - start) / (beat * 3)));
      for (const l of lines) {
        const len = (l.upright ? halfH : halfW) * 3 * drawn;
        l.mesh.visible = len > 0.001;
        l.mesh.position.set(f.focusX, f.focusY, 0);
        if (l.upright) l.mesh.scale.set(0.007, len, 1);
        else l.mesh.scale.set(len, 0.007, 1);
      }
      // the ring draws on through the wait, then closes in on the focus as the footage speeds up
      const wait = clamp01((f.t - start) / Math.max(0.01, rampStart - start));
      const ramp = ctx.leave === 'ramp' ? clamp01((f.t - rampStart) / (ctx.rampBeats * beat)) : 0;
      ring.mesh.position.set(f.focusX, f.focusY, 0);
      ring.u.uSweep.value = TAU * easeOutCubic(wait) + (wait >= 1 ? 0.1 : 0);
      ring.u.uA0.value = Math.PI / 2 - f.t * 0.25;
      ring.u.uR.value = 0.5 - 0.48 * easeInCubic(ramp);
      ring.u.uW.value = 0.005 + 0.014 * ramp;
    },
    dispose: () => disposeGroup(group),
  };
};

/* ───────── arcs ───────── */

export const arcs: MotifFactory = (ctx) => {
  const group = new THREE.Group();
  const p = ctx.palette;
  const size = Math.min(ctx.halfW * 1.25, ctx.halfH * 1.1);
  const radii = [0.15, 0.24, 0.35, 0.49, 0.65, 0.83];
  const widths = [0.034, 0.005, 0.05, 0.004, 0.02, 0.007];
  const sweeps = [4.2, 5.5, 2.1, 5.9, 1.4, 3.3];
  const turns = [0.5, -0.3, 0.22, -0.15, 0.35, -0.1];
  const cols: (number | 'ink' | 'paper')[] = [0, 'ink', 3, 'ink', 'paper', 1];
  const list = radii.map((r, i) => makeArc(group, size, inkOf(p, cols[i]), r, widths[i], sweeps[i], ctx.rnd() * TAU, turns[i], i * 0.06));
  const snares = ctx.snares.filter((s) => s >= ctx.start && s < ctx.end);
  return {
    space: 'frame',
    object: group,
    update(f: MotifFrame) {
      const out = leaving(ctx, f.t);
      // each snare knocks the arcs round by a notch
      let notch = 0;
      for (const s of snares) {
        if (s > f.t) break;
        notch += easeOutExpo(clamp01((f.t - s) / (ctx.beat * 0.5)));
      }
      for (const a of list) {
        const age = f.t - ctx.start - ctx.freeze - a.delay * ctx.beat;
        a.mesh.visible = age > 0 && out < 1;
        if (!a.mesh.visible) continue;
        a.mesh.position.set(f.focusX, f.focusY, 0);
        a.u.uR.value = a.r * easeOutBack(clamp01(age / (ctx.beat * 0.9)), 1.3);
        a.u.uSweep.value = a.sweep * easeOutCubic(clamp01(age / (ctx.beat * 1.4))) * (1 - out);
        a.u.uA0.value = a.a0 + a.turn * age + Math.sign(a.turn) * notch * 0.35;
      }
    },
    dispose: () => disposeGroup(group),
  };
};

/* ───────── burst ───────── */

export const burst: MotifFactory = (ctx) => {
  const n = 110;
  const cloud = new ShapeCloud(n, { shadowColor: ctx.palette.ink, order: 3 });
  const { halfW, halfH, rnd } = ctx;
  const shapes: ShapeId[] = [SHAPE.rect, SHAPE.disc, SHAPE.triangle, SHAPE.ring];
  const bits = Array.from({ length: n }, (_, i) => {
    const pick = rnd();
    return {
      // where it ends up, somewhere in the space the shot will fly through
      to: new THREE.Vector3((rnd() * 2 - 1) * halfW * 1.3, (rnd() * 2 - 1) * halfH * 1.15, -(ctx.depth + 2) + rnd() * (ctx.depth + 4.5)),
      axis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
      phase: rnd() * TAU,
      spin: (rnd() < 0.5 ? -1 : 1) * (2 + rnd() * 5),
      size: 0.06 + rnd() * rnd() * 0.34,
      delay: rnd() * 0.12,
      shape: shapes[Math.floor(rnd() * shapes.length)],
      color: inkOf(ctx.palette, pick < 0.14 ? 'ink' : pick < 0.3 ? 'paper' : i),
    };
  });
  const q = new THREE.Quaternion();
  return {
    space: 'world',
    object: cloud.object,
    update(f: MotifFrame) {
      const out = leaving(ctx, f.t);
      cloud.begin();
      for (const b of bits) {
        const age = f.t - ctx.start - ctx.freeze * 0.5 - b.delay;
        if (age <= 0) continue;
        const k = 1 - Math.exp(-age / 0.32);
        // thrown from the focus point, a little behind the plane in focus
        const z = -1 - f.travel + (b.to.z + 1 + f.travel) * k;
        if (!ShapeCloud.ahead(z, f.travel)) continue;
        q.setFromAxisAngle(b.axis, b.phase + b.spin * (1.2 * (1 - Math.exp(-age / 0.5)) + 0.1 * age));
        const s = b.size * easeOutBack(clamp01(age / 0.22)) * (1 - out);
        cloud.add(b.shape, f.focusX + (b.to.x - f.focusX) * k, f.focusY + (b.to.y - f.focusY) * k, z, s, s, b.color, 1, q);
      }
      cloud.commit(f.travel);
    },
    dispose: () => cloud.dispose(),
  };
};

/* ───────── bars ───────── */

export const bars: MotifFactory = (ctx) => {
  const { halfW, halfH, rnd, beat } = ctx;
  const kicks = ctx.kicks.filter((k) => k >= ctx.start && k < ctx.end - beat * 0.5).slice(0, 30);
  const cloud = new ShapeCloud(Math.max(1, kicks.length), { shadowColor: ctx.palette.ink, order: 1 });
  // lanes that leave the middle of the picture and the word's corner clear
  const lanes = [0.82, 0.66, 0.5, 0.34, -0.12, -0.26];
  const list = kicks.map((at, j) => {
    const lane = lanes[Math.floor(rnd() * lanes.length)];
    const thin = rnd() < 0.3;
    return {
      at,
      y: lane * halfH,
      h: halfH * (thin ? 0.01 : [0.035, 0.06, 0.11][Math.floor(rnd() * 3)]),
      w: halfW * (thin ? 0.9 + rnd() * 0.9 : 0.5 + rnd() * 0.9),
      rest: halfW * (rnd() * 1.2 - 0.6),
      from: j % 2 ? 1 : -1,
      life: (2 + Math.floor(rnd() * 3)) * beat,
      // it lands near the plane in focus at its kick, wherever the shot has got to by then
      z: -ctx.travel(at) - 0.9 + rnd() * 1.6,
      color: inkOf(ctx.palette, thin ? 'ink' : j % 4 === 3 ? 'paper' : j * 2 + 1),
      alpha: thin ? 0.9 : 0.94,
    };
  });
  return {
    space: 'world',
    object: cloud.object,
    update(f: MotifFrame) {
      const out = leaving(ctx, f.t);
      cloud.begin();
      for (const b of list) {
        const age = f.t - b.at;
        const leave = (age - b.life) / (beat * 0.8);
        if (age < 0 || leave >= 1 || !ShapeCloud.ahead(b.z, f.travel)) continue;
        const far = halfW * 2.6;
        const x = b.rest + b.from * far * (1 - easeOutExpo(clamp01(age / (beat * 0.9)))) - b.from * far * easeInExpo(clamp01(leave));
        cloud.add(SHAPE.rect, x, b.y, b.z, b.w, b.h, b.color, b.alpha * (1 - out));
      }
      cloud.commit(f.travel);
    },
    dispose: () => cloud.dispose(),
  };
};

/* ───────── blocks ───────── */

export const blocks: MotifFactory = (ctx) => {
  const { halfW, halfH, rnd, beat } = ctx;
  const n = 6;
  const cloud = new ShapeCloud(n, { shadowColor: ctx.palette.ink, fill: ctx.fill, width: ctx.width, height: ctx.height, order: 1 });
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const list = Array.from({ length: n }, (_, i) => {
    const tall = rnd() < 0.5;
    const w = halfW * (tall ? 0.28 + rnd() * 0.3 : 0.6 + rnd() * 0.7);
    const side = i % 2 ? 1 : -1;
    return {
      // spread through the whole depth of the shot, the last one close to where the lens ends up
      z: -(ctx.depth + 1.5) + ((i + rnd() * 0.6) / n) * (ctx.depth + 3.8),
      x: side * halfW * (0.25 + rnd() * 0.75),
      y: halfH * (rnd() * 1.5 - 0.6),
      w,
      h: tall ? w * (1.8 + rnd() * 1.4) : w * (0.35 + rnd() * 0.4),
      tilt: (rnd() - 0.5) * 0.7,
      // every other slab is a window onto the live look, when there is one
      window: !!ctx.fill && i % 2 === 0,
      color: inkOf(ctx.palette, i % 5 === 4 ? 'paper' : i),
    };
  });
  return {
    space: 'world',
    object: cloud.object,
    update(f: MotifFrame) {
      const out = leaving(ctx, f.t);
      cloud.begin();
      for (const b of list) {
        if (!ShapeCloud.ahead(b.z, f.travel)) continue;
        // a slab stands up as the shot comes within reach of it
        const near = b.z + f.travel + 7.5;
        const up01 = easeOutBack(clamp01(near / 1.6), 1.2);
        const since0 = f.t - ctx.start - ctx.freeze;
        const grow = Math.min(up01, easeOutCubic(clamp01(since0 / (beat * 1.5)))) * (1 - out);
        if (grow <= 0.001) continue;
        q.setFromAxisAngle(up, b.tilt + Math.sin(f.t * 0.4 + b.z) * 0.08);
        cloud.add(SHAPE.rect, b.x, b.y, b.z, b.w, b.h * grow, b.color, 0.95, q, 0, b.window);
      }
      cloud.commit(f.travel);
    },
    dispose: () => cloud.dispose(),
  };
};

/* ───────── word ───────── */

/** letters rise onto their line from `from`, and leave off the top when the shot settles */
function revealLetters(line: TypeLine, ctx: MotifContext, t: number, from: number, stagger: number) {
  for (let i = 0; i < line.count; i++) {
    const rise = easeOutExpo(clamp01((t - from - i * stagger * ctx.beat) / (ctx.beat * 0.8)));
    const gone = ctx.leave === 'settle' ? easeInCubic(clamp01((t - (ctx.end - ctx.beat * 2) - i * 0.04 * ctx.beat) / (ctx.beat * 0.6))) : 0;
    line.reveal[i] = rise + gone;
  }
}

export const word: MotifFactory = (ctx) => {
  const group = new THREE.Group();
  if (!ctx.word) return { space: 'frame', object: group, update() {}, dispose() {} };
  const { halfW, halfH } = ctx;
  const line = typeLine(ctx.word, inkOf(ctx.palette, 'ink'));
  // as tall as it can be without running off the frame
  let h = halfH * 0.42;
  let w = h * line.ratio;
  const maxW = halfW * 1.84;
  if (w > maxW) {
    w = maxW;
    h = w / line.ratio;
  }
  const left = -halfW * 0.92;
  const base = -halfH * 0.6;
  line.mesh.scale.set(w, h, 1);
  line.mesh.position.set(left + w / 2, base + h / 2, 0.4);
  group.add(line.mesh);
  const cap = ctx.caption ? typeLine(ctx.caption.toUpperCase(), inkOf(ctx.palette, 'ink'), MONO_FONT, 44) : null;
  if (cap) {
    const ch = Math.min(halfH * 0.035, (halfW * 1.7) / cap.ratio);
    cap.mesh.scale.set(ch * cap.ratio, ch, 1);
    cap.mesh.position.set(left + (ch * cap.ratio) / 2 + h * 0.03, base - ch * 0.9, 0.4);
    cap.reveal.fill(1);
    group.add(cap.mesh);
  }
  return {
    space: 'frame',
    object: group,
    update(f: MotifFrame) {
      const from = ctx.start + ctx.freeze;
      line.mesh.visible = f.t >= ctx.start;
      revealLetters(line, ctx, f.t, from, 0.05);
      if (cap) cap.setAlpha(smooth(from + ctx.beat * 0.6, from + ctx.beat * 1.4, f.t) * (1 - leaving(ctx, f.t)));
    },
    dispose() {
      line.dispose();
      cap?.dispose();
    },
  };
};

/* ───────── cardType ───────── */

export const cardType: MotifFactory = (ctx) => {
  const group = new THREE.Group();
  const words = ctx.word.split(/\s+/).filter(Boolean).slice(0, 4);
  if (!words.length) return { space: 'frame', object: group, update() {}, dispose() {} };
  const { halfW, halfH } = ctx;
  const paper = inkOf(ctx.palette, 'paper');
  // a block of type: every line is set to the same width, so short words stand taller
  const width = Math.min(halfW * 1.7, halfH * 1.5);
  const lines = words.map((w) => typeLine(w, paper));
  const heights = lines.map((l) => Math.min(width / l.ratio, halfH * 0.62));
  const lead = 0.86;
  const total = heights.reduce((s, h) => s + h * lead, 0);
  let y = total / 2;
  lines.forEach((l, i) => {
    const h = heights[i];
    const w = h * l.ratio;
    l.mesh.scale.set(w, h, 1);
    l.mesh.position.set(-width / 2 + w / 2, y - (h * lead) / 2, 0);
    y -= h * lead;
    group.add(l.mesh);
  });
  const rule = flatPlane(group, inkOf(ctx.palette, 0), 1, 4);
  rule.position.set(0, -total / 2 - halfH * 0.05, 0);
  return {
    space: 'frame',
    object: group,
    update(f: MotifFrame) {
      lines.forEach((l, i) => revealLetters(l, ctx, f.t, ctx.start + i * ctx.beat * 0.12, 0.02));
      rule.scale.set(width * easeOutExpo(clamp01((f.t - ctx.start) / (ctx.beat * 0.9))), halfH * 0.012, 1);
    },
    dispose() {
      for (const l of lines) l.dispose();
      disposeGroup(group);
    },
  };
};

/* ───────── ruler ───────── */

export const ruler: MotifFactory = (ctx) => {
  const group = new THREE.Group();
  const { halfW, halfH, beat, run } = ctx;
  const beats = Math.round((run.end - run.start) / beat);
  const hitBeat = Math.round((run.hit - run.start) / beat);
  const color = inkOf(ctx.palette, 'ink');
  const x0 = -halfW * 0.86;
  const x1 = halfW * 0.86;
  const y = -halfH * 0.9;
  const ticks = Array.from({ length: beats + 1 }, (_, i) => {
    const mesh = flatPlane(group, color, 0.85, 4);
    mesh.position.set(x0 + ((x1 - x0) * i) / beats, y, 0.4);
    return mesh;
  });
  const head = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false }));
  head.renderOrder = 4;
  head.frustumCulled = false;
  group.add(head);
  return {
    space: 'frame',
    object: group,
    update(f: MotifFrame) {
      const now = (f.t - run.start) / beat;
      ticks.forEach((tick, i) => {
        const passed = smooth(i - 0.15, i + 0.15, now);
        tick.scale.set(0.006, halfH * (i === hitBeat ? 0.05 : 0.014 + 0.01 * passed), 1);
        (tick.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.55 * passed;
      });
      head.position.set(x0 + (x1 - x0) * clamp01(now / beats), y + halfH * 0.045, 0.4);
      head.scale.setScalar(halfH * 0.014);
    },
    dispose: () => disposeGroup(group),
  };
};
