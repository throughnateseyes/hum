/**
 * Lines drawn along what the clip really has: the cables, kerbs, window grids and stripes the reader found
 * and followed (depth/edges.ts), its ground, and the outline of who is close by. They sit at the distance
 * of what they run along, so people pass in front of them, and they move with it.
 *
 * What they do is an act (recipes.ts names them per moment): they draw themselves on, a wave runs through
 * them from far to near, the hi-hats pick out a group of them, dashes travel along them, they shoot past
 * their ends across the frame, they lift off what they lie on, a path is knitted through them, or the
 * frame is scanned. Everything comes from the shot's number and the song's time, so any moment can be
 * drawn on its own and two shots of one clip don't do the same thing.
 */
import * as THREE from 'three';
import { linesOver, segAt, type Lines } from '../depth/edges';
import type { ClipScene } from '../depth/types';
import { clamp01, dice, smooth } from '../shot/time';
import { outline, type Path } from './contour';
import type { FrameBox } from './layout';
import { at, mapAt, project, unproject, type Crop, type Lens } from './place';
import type { ActId } from './recipes';
import { STROKE_FRAG, STROKE_VERT } from './shaders';

const MOST = 1600;
/** how far towards the camera from what it runs along a line is drawn, so its own surface doesn't hide it */
const TOWARDS = 0.86;
/** fewer lines than this and the clip has no geometry to speak of */
export const LEAST_LINES = 14;

export interface SceneLinesSpec {
  scene: ClipScene;
  crop: Crop;
  aspect: number;
  layout: number;
  start: number;
  end: number;
  beat: number;
  energy: number;
  acts: ActId[];
  kicks: number[];
  snares: number[];
  hats: number[];
  clipAt: (t: number) => number;
}

/** a point in the frame (0..1) and how near it is */
interface P {
  x: number;
  y: number;
  n: number;
}

interface Meta {
  i: number;
  /** its ends swapped, so the first is the far one */
  turned: boolean;
  /** 0 the farthest .. 1 the nearest */
  d: number;
  r: number;
  r2: number;
  group: number;
  near: number;
}

/** the surface between two neighbours that run the same way */
interface Panel {
  a: number;
  b: number;
  /** b's ends are the other way round */
  flip: boolean;
  x: number;
  d: number;
  r: number;
}

interface Look {
  alpha: number;
  width?: number;
  colour?: number;
  /** how far off what it lies on, towards the camera */
  lift?: number;
  /** on past both its ends, frame heights */
  past?: number;
}

const outCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const outQuint = (x: number) => 1 - (1 - clamp01(x)) ** 5;
const inCubic = (x: number) => clamp01(x) ** 3;
const roll = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
};

export class SceneLines {
  readonly mesh: THREE.Mesh;
  private readonly lines: Lines;
  private readonly meta: Meta[] = [];
  private readonly groups: Meta[][] = [];
  private readonly panels: Panel[] = [];
  private readonly chain: { i: number; flip: boolean }[] = [];
  private readonly pos = new Float32Array(MOST * 12);
  private readonly col = new Float32Array(MOST * 16);
  private readonly geo = new THREE.BufferGeometry();
  private readonly acts: ActId[];
  private n = 0;
  // the frame being drawn
  private l!: Lens;
  private clip = 0;
  private colours: THREE.Color[] = [];
  private boxes: FrameBox[] = [];
  private fade = 1;
  private segs: ({ a: P; b: P } | null)[] = [];
  private traced: { i: number; paths: Path[] } | null = null;

  constructor(
    private readonly s: SceneLinesSpec,
    lens: Lens,
    material: THREE.Material,
  ) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k <= 24; k++) {
      const c = s.clipAt(s.start + ((s.end - s.start) * k) / 24);
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    this.lines = linesOver(s.scene, lo, hi);
    const rnd = dice(s.layout + 977);
    // near and far, and which lines belong together: the same way, the same side of the frame
    const all = this.lines.lines.map((_, i) => ({ i, g: this.first(i) })).filter((x): x is { i: number; g: { a: P; b: P } } => !!x.g && this.shows(x.g));
    const order = [...all].sort((p, q) => p.g.a.n + p.g.b.n - q.g.a.n - q.g.b.n);
    const byGroup = new Map<string, Meta[]>();
    for (const { i, g } of all) {
      const dx = (g.b.x - g.a.x) * s.aspect;
      const dy = g.b.y - g.a.y;
      const turn = Math.round(((Math.atan2(dy, dx) + Math.PI) % Math.PI) / (Math.PI / 5)) % 5;
      const key = `${turn}:${Math.floor(((g.a.x + g.b.x) / 2) * 3)}`;
      const dist = (p: P) => Math.hypot((p.x - lens.vp.x) * s.aspect, p.y - lens.vp.y);
      const turned = Math.abs(g.a.n - g.b.n) > 0.15 * Math.max(g.a.n, g.b.n) ? g.a.n > g.b.n : dist(g.a) > dist(g.b);
      const m: Meta = { i, turned, d: order.findIndex((o) => o.i === i) / Math.max(1, order.length - 1), r: rnd(), r2: rnd(), group: 0, near: (g.a.n + g.b.n) / 2 };
      this.meta.push(m);
      byGroup.set(key, [...(byGroup.get(key) ?? []), m]);
    }
    for (const ms of byGroup.values()) {
      if (ms.length < 2) continue;
      // across the group, so it can be played like a keyboard
      ms.sort((p, q) => this.first(p.i)!.a.x - this.first(q.i)!.a.x);
      // a long one is several
      for (let k = 0; k < ms.length; k += 7) this.groups.push(ms.slice(k, k + 7));
    }
    this.groups.forEach((g, k) => g.forEach((m) => (m.group = k)));
    this.paired(rnd);
    this.knitted(rnd);
    const ok = (a: ActId) => (a === 'floor' ? s.scene.ground > 0.1 && s.scene.sure.horizon > 0.4 && lens.vp.y > 0.22 : a === 'trace' ? s.scene.near > 0.04 && s.scene.splits.length > 0 : this.enough);
    this.acts = s.acts.filter(ok);
    if (!this.acts.length && this.enough) this.acts = ['draw'];
    const index = new Uint16Array(MOST * 6);
    for (let k = 0; k < MOST; k++) index.set([0, 1, 2, 2, 1, 3].map((v) => v + k * 4), k * 6);
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** has the clip lines of its own to draw along? */
  get enough(): boolean {
    return this.meta.length >= LEAST_LINES;
  }

  get playing(): boolean {
    return this.acts.length > 0;
  }

  /** for checks */
  info() {
    return { lines: this.meta.length, groups: this.groups.length, panels: this.panels.length, acts: this.acts, drawn: this.n };
  }

  private toFrame(x: number, y: number): { x: number; y: number } {
    const { scene, crop } = this.s;
    return { x: (x / scene.aspect + 0.5 - crop.u) / crop.w + 0.5, y: (y + 0.5 - crop.v) / crop.h + 0.5 };
  }

  private seg(i: number, clip: number): { a: P; b: P } | null {
    const g = segAt(this.lines, i, clip);
    if (!g) return null;
    const { n0, n1 } = this.lines.lines[i];
    return { a: { ...this.toFrame(g.x0, g.y0), n: n0 }, b: { ...this.toFrame(g.x1, g.y1), n: n1 } };
  }

  private first(i: number): { a: P; b: P } | null {
    const { times, lines } = this.lines;
    const k = Math.floor(lines[i].keys.findIndex((v) => !Number.isNaN(v)) / 4);
    const mid = (times[0] + times[times.length - 1]) / 2;
    return this.seg(i, mid) ?? this.seg(i, times[Math.max(0, k)]);
  }

  private shows(g: { a: P; b: P }): boolean {
    const x = (g.a.x + g.b.x) / 2;
    const y = (g.a.y + g.b.y) / 2;
    return x > -0.02 && x < 1.02 && y > -0.02 && y < 1.02;
  }

  /** the stripes, panes and slats: neighbours that run the same way, side by side, at one distance */
  private paired(rnd: () => number) {
    const { aspect } = this.s;
    const all = this.meta.map((m) => {
      const g = this.first(m.i)!;
      const x0 = g.a.x * aspect;
      const x1 = g.b.x * aspect;
      const len = Math.hypot(x1 - x0, g.b.y - g.a.y) || 1;
      return { m, g, x0, y0: g.a.y, ux: (x1 - x0) / len, uy: (g.b.y - g.a.y) / len, len, mx: (x0 + x1) / 2, my: (g.a.y + g.b.y) / 2 };
    });
    for (const p of all) {
      let best: { q: (typeof all)[number]; off: number; flip: boolean } | null = null;
      for (const q of all) {
        if (q === p) continue;
        const turn = p.ux * q.ux + p.uy * q.uy;
        if (Math.abs(turn) < 0.995) continue;
        // one side only, so each surface is found once
        const off = -(q.mx - p.mx) * p.uy + (q.my - p.my) * p.ux;
        const side = p.ux + p.uy * 0.001 > 0 ? off : -off;
        if (side < 0.007 || side > 0.075 || side > Math.min(p.len, q.len) * 0.9) continue;
        const along = Math.abs((q.mx - p.mx) * p.ux + (q.my - p.my) * p.uy);
        if (along > 0.16 * Math.min(p.len, q.len) || Math.max(p.len, q.len) > 1.4 * Math.min(p.len, q.len)) continue;
        const n = (p.m.near + 1e-3) / (q.m.near + 1e-3);
        if (n > 1.4 || n < 1 / 1.4) continue;
        if (!best || side < Math.abs(best.off)) best = { q, off: side, flip: turn < 0 };
      }
      if (best) this.panels.push({ a: p.m.i, b: best.q.m.i, flip: best.flip, x: p.mx, d: p.m.d, r: rnd() });
    }
    this.panels.sort((p, q) => p.x - q.x);
  }

  /** a walk through the lines, each on to the nearest end not used yet */
  private knitted(rnd: () => number) {
    const left = this.meta.slice(0, 70).map((m) => ({ m, g: this.first(m.i)! }));
    if (left.length < 4) return;
    let k = Math.floor(rnd() * left.length);
    let flip = rnd() < 0.5;
    while (left.length && this.chain.length < 48) {
      const [{ m, g }] = left.splice(k, 1);
      this.chain.push({ i: m.i, flip });
      const end = flip ? g.a : g.b;
      let best = Infinity;
      left.forEach((o, j) => {
        for (const f of [false, true]) {
          const p = f ? o.g.b : o.g.a;
          const d = Math.hypot((p.x - end.x) * this.s.aspect, p.y - end.y) + 0.06 * rnd();
          if (d < best) {
            best = d;
            k = j;
            flip = f;
          }
        }
      });
    }
  }

  /* ───────────────────────── drawing ───────────────────────── */

  private quad(a: P, b: P, width: number, c: THREE.Color, alpha: number, lift: number) {
    if (this.n >= MOST || alpha < 0.012) return;
    const { aspect, scene } = this.s;
    const vp = this.l.vp;
    const up = (p: P) => ({ x: vp.x + (p.x - vp.x) * (1 + lift), y: vp.y + (p.y - vp.y) * (1 + lift), w: (Math.max(0.5, scene.zScale / Math.max(0.0012, p.n)) * TOWARDS) / (1 + lift) });
    const A = lift ? up(a) : { x: a.x, y: a.y, w: Math.max(0.5, scene.zScale / Math.max(0.0012, a.n)) * TOWARDS };
    const B = lift ? up(b) : { x: b.x, y: b.y, w: Math.max(0.5, scene.zScale / Math.max(0.0012, b.n)) * TOWARDS };
    const dx = (B.x - A.x) * aspect;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-5) return;
    const ox = ((-dy / len) * width) / 1440 / aspect;
    const oy = ((dx / len) * width) / 1440;
    this.corners(A.x + ox, A.y + oy, A.w, A.x - ox, A.y - oy, A.w, B.x + ox, B.y + oy, B.w, B.x - ox, B.y - oy, B.w, c, alpha);
  }

  private corners(x0: number, y0: number, w0: number, x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, x3: number, y3: number, w3: number, c: THREE.Color, alpha: number) {
    if (this.n >= MOST) return;
    const q = this.n * 12;
    const put = (k: number, x: number, y: number, w: number) => {
      const v = unproject(this.l, x, y, w);
      this.pos[q + k * 3] = v.x;
      this.pos[q + k * 3 + 1] = v.y;
      this.pos[q + k * 3 + 2] = v.z;
      this.col.set([c.r, c.g, c.b, alpha], (this.n * 4 + k) * 4);
    };
    put(0, x0, y0, w0);
    put(1, x1, y1, w1);
    put(2, x2, y2, w2);
    put(3, x3, y3, w3);
    this.n++;
  }

  /** the surface between two lines, from u0 to u1 of the way along: filled, or hatched with lines like its edges */
  private panel(p: Panel, u0: number, u1: number, o: Look, hatched: boolean) {
    const g = this.segs[p.a];
    const h = this.segs[p.b];
    if (!g || !h || u1 - u0 < 0.004) return;
    const on = (a: P, b: P, u: number): P => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, n: a.n + (b.n - a.n) * u });
    const [ha, hb] = p.flip ? [h.b, h.a] : [h.a, h.b];
    const A = on(g.a, g.b, u0);
    const B = on(g.a, g.b, u1);
    const C = on(ha, hb, u0);
    const D = on(ha, hb, u1);
    if (hatched) {
      const gap = Math.hypot((A.x - C.x) * this.s.aspect, A.y - C.y);
      const n = Math.max(2, Math.min(7, Math.round(gap / 0.009)));
      for (let k = 0; k <= n; k++) this.stroke(on(A, C, k / n), on(B, D, k / n), { ...o, width: (o.width ?? 2) * 0.6 });
      return;
    }
    const mx = (A.x + B.x + C.x + D.x) / 4;
    const my = (A.y + B.y + C.y + D.y) / 4;
    const under = this.boxes.some((r) => mx > r.x0 - 0.02 && mx < r.x1 + 0.02 && my > r.y0 - 0.02 && my < r.y1 + 0.02);
    const alpha = o.alpha * this.fade * (under ? 0.3 : 1);
    if (alpha < 0.012) return;
    const w = (q: P) => Math.max(0.5, this.s.scene.zScale / Math.max(0.0012, q.n)) * TOWARDS;
    this.corners(A.x, A.y, w(A), C.x, C.y, w(C), B.x, B.y, w(B), D.x, D.y, w(D), this.colours[(o.colour ?? 0) % this.colours.length], alpha);
  }

  /** a stroke from a to b, quieter where words stand */
  private stroke(a: P, b: P, o: Look) {
    const alpha = o.alpha * this.fade;
    if (alpha < 0.012) return;
    const c = this.colours[(o.colour ?? 0) % this.colours.length];
    const near = (a.n + b.n) / 2;
    const width = (o.width ?? 2) * (0.75 + 0.8 * Math.sqrt(Math.min(1, near * 3)));
    const cuts = [0, 1];
    for (const r of this.boxes) {
      const t = span(a, b, r);
      if (t) cuts.push(t[0], t[1]);
    }
    cuts.sort((p, q) => p - q);
    const on = (u: number): P => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, n: a.n + (b.n - a.n) * u });
    for (let k = 0; k + 1 < cuts.length; k++) {
      if (cuts[k + 1] - cuts[k] < 1e-4) continue;
      const m = on((cuts[k] + cuts[k + 1]) / 2);
      const under = this.boxes.some((r) => m.x > r.x0 && m.x < r.x1 && m.y > r.y0 && m.y < r.y1);
      this.quad(on(cuts[k]), on(cuts[k + 1]), width, c, under ? alpha * 0.3 : alpha, o.lift ?? 0);
    }
  }

  /** the part of a line from u0 to u1 (0 its far end, 1 its near one) */
  private line(m: Meta, u0: number, u1: number, o: Look) {
    if (u1 - u0 < 0.004) return;
    const g = this.segs[m.i];
    if (!g) return;
    const [a, b] = m.turned ? [g.b, g.a] : [g.a, g.b];
    const len = Math.hypot((b.x - a.x) * this.s.aspect, b.y - a.y) || 1;
    const p = (o.past ?? 0) / len;
    const on = (u: number): P => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, n: Math.max(0.0012, a.n + (b.n - a.n) * Math.min(1.5, Math.max(-0.5, u))) });
    this.stroke(on(u0 - p), on(u1 + p), { ...o, colour: o.colour ?? (m.r2 < 0.16 ? 1 : 0) });
  }

  private node(p: P, size: number, o: Look) {
    const w = (o.width ?? 2) * size;
    const h = w / 1440;
    this.stroke({ x: p.x - h / this.s.aspect, y: p.y, n: p.n }, { x: p.x + h / this.s.aspect, y: p.y, n: p.n }, { ...o, width: w });
  }

  /** put song time t into the mesh */
  update(t: number, l: Lens, colours: THREE.Color[], boxes: FrameBox[], fade: number) {
    const s = this.s;
    this.l = l;
    this.clip = s.clipAt(t);
    this.colours = colours;
    this.boxes = boxes;
    this.fade = fade;
    this.n = 0;
    this.segs = [];
    for (const m of this.meta) {
      const g = this.seg(m.i, this.clip);
      this.segs[m.i] = g && this.shows(g) ? g : null;
    }
    const beats = (t - s.start) / s.beat;
    if (this.acts.length && fade > 0.01) {
      // an act holds for two bars; a long shot has several
      const turn = Math.floor((beats + 1e-3) / 8);
      const first = Math.floor(roll(s.layout, 3.7) * this.acts.length);
      const act = this.acts[(first + turn) % this.acts.length];
      const into = beats - turn * 8;
      this.play(act, t, beats, into);
      // a loud shot has its hits on top of whatever it is doing
      if (s.energy > 0.62 && this.enough && act !== 'lift' && act !== 'hats' && roll(s.layout, 9.1) < 0.6) this.play(roll(s.layout, 5.3) < 0.5 ? 'lift' : 'hats', t, beats, into);
    }
    this.geo.setDrawRange(0, this.n * 6);
    const p = this.geo.attributes.position as THREE.BufferAttribute;
    const c = this.geo.attributes.aColor as THREE.BufferAttribute;
    for (const [a, n] of [
      [p, 12],
      [c, 16],
    ] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * n);
      a.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  private recent(list: number[], t: number, within: number): number[] {
    const out: number[] = [];
    for (let k = list.length - 1; k >= 0 && out.length < 4; k--) {
      if (list[k] > t + 1e-3) continue;
      if (t - list[k] > within) break;
      out.push(list[k]);
    }
    return out;
  }

  private play(act: ActId, t: number, beats: number, into: number): void {
    const s = this.s;
    const w = 2.6 + s.energy * 2.2;
    const loud = s.energy > 0.55;
    const N = this.meta.length;
    const out = 1 - smooth(7.4, 8, into);
    switch (act) {
      case 'draw': {
        // one after another, far things first, over the first bar and a half
        const most = Math.round(N * (0.4 + 0.5 * s.energy));
        for (const m of this.meta) {
          if (m.r * N > most) continue;
          const q = into - m.d * 4.2 - m.r * 0.8;
          if (q <= 0) continue;
          this.line(m, 0, outCubic(q / 1.4), { alpha: (0.55 + 0.35 * s.energy) * out, width: w });
        }
        return;
      }
      case 'sweep': {
        const per = loud ? 2 : 4;
        for (let k = 0; k < 2; k++) {
          const p = beats - (Math.floor(beats / per) - k) * per;
          for (const m of this.meta) {
            const q = p - m.d * per * 0.62 - m.r * 0.18;
            if (q <= 0 || q > 2.6) continue;
            this.line(m, 0, outCubic(q / 0.45), { alpha: Math.exp(-q / 0.75), width: w * (1 + 0.9 * Math.exp(-q / 0.2)) });
          }
        }
        return;
      }
      case 'hats': {
        if (!this.groups.length) return this.play('draw', t, beats, into);
        const list = s.hats.length > 3 ? s.hats : [...s.kicks, ...s.snares].sort((a, b) => a - b);
        for (const h of this.recent(list, t, s.beat * 0.9)) {
          const q = (t - h) / s.beat;
          for (const side of [1.1, 2.3, 3.7]) {
            const g = this.groups[Math.floor(roll(s.layout + side, Math.round(h * 100)) * this.groups.length)];
            g.forEach((m, k) => {
              const p = q - k * 0.03;
              if (p > 0) this.line(m, inCubic((p - 0.3) / 0.6), outQuint(p / 0.25), { alpha: 0.95, width: w * 1.35, past: 0.05 * outQuint(p / 0.4) });
            });
          }
        }
        return;
      }
      case 'fill': {
        // the surfaces between them, lit a few at a time: every half beat when it is loud, every beat when it isn't
        if (this.panels.length < 5) return this.play('sweep', t, beats, into);
        const per = loud ? 0.5 : 1;
        const now = Math.floor(beats / per);
        const share = 0.22 + 0.25 * s.energy;
        for (let k = now; k > now - (loud ? 3 : 4) && k >= 0; k--) {
          const q = beats - k * per;
          this.panels.forEach((p, i) => {
            if (roll(p.a * 3 + 1, k + s.layout) > share) return;
            const u = q - (i / this.panels.length) * per * 0.35;
            if (u <= 0) return;
            const gone = inCubic((u - per * 0.8) / (per * 1.6));
            if (gone >= 1) return;
            const up = p.r < 0.5;
            const grown = outQuint(u / 0.45);
            this.panel(p, up ? gone : 1 - grown, up ? grown : 1 - gone, { alpha: 0.92, width: w, colour: p.r > 0.8 ? 1 : 0 }, roll(p.b, s.layout) < 0.34);
          });
        }
        return this.hold(0.3 * out, w * 0.6);
      }
      case 'run': {
        for (const m of this.meta) {
          const per = 1.2 + m.r2 * 1.4;
          const c = beats / per + m.r * 7;
          this.line(m, 0, 1, { alpha: 0.16, width: w * 0.55 });
          if (roll(m.i, Math.floor(c)) > 0.5 + 0.4 * s.energy) continue;
          const u = c - Math.floor(c);
          const p = loud ? inCubic(u) * 0.55 + u * 0.45 : outCubic(u);
          this.line(m, Math.max(0, p * 1.45 - 0.45), Math.min(1, p * 1.45), { alpha: 0.95 * smooth(0, 0.08, u), width: w * 1.3 });
        }
        return;
      }
      case 'shoot': {
        // a family of them run on past their ends, right across the frame
        const list = s.kicks.length > 1 ? s.kicks : Array.from({ length: 32 }, (_, k) => s.start + k * 2 * s.beat);
        if (!this.groups.length) return this.play('draw', t, beats, into);
        for (const h of this.recent(list, t, s.beat * 2.2)) {
          const q = (t - h) / s.beat;
          // the ones that go off towards the vanishing point and across make the picture; three groups of any kind
          const hit = [1.1, 2.3, 3.7].flatMap((side) => this.groups[Math.floor(roll(s.layout + 5 + side, Math.round(h * 100)) * this.groups.length)]);
          hit.forEach((m, k) => {
            const p = q - k * 0.015;
            if (p > 0) this.line(m, 0, 1, { alpha: 0.9 * (1 - smooth(1.1, 1.9, p)), width: w, past: 1.5 * outQuint(p / 0.6) * (1 - 0.9 * inCubic((p - 0.7) / 1.2)) });
          });
        }
        return this.hold(0.3 * out, w * 0.8);
      }
      case 'lift': {
        const list = s.kicks.length > 1 ? s.kicks : Array.from({ length: 64 }, (_, k) => s.start + k * s.beat);
        for (const h of this.recent(list, t, s.beat * 1.2).slice(0, 2)) {
          const q = (t - h) / s.beat;
          for (const m of this.meta) {
            if (roll(m.i, Math.round(h * 100)) > 0.4) continue;
            for (let k = 1; k <= 3; k++) this.line(m, 0, 1, { alpha: (0.75 / k) * (1 - outCubic(q / 1.2)), width: w, lift: 0.055 * k * outCubic(q / 0.7) });
          }
        }
        return this.hold(0.28, w * 0.8);
      }
      case 'knit': {
        const per = loud ? 0.25 : 0.5;
        const head = beats / per;
        const L = this.chain.length * 2;
        if (L < 8) return this.play('draw', t, beats, into);
        const tail = loud ? 30 : 20;
        for (let k = Math.max(0, Math.floor(head) - tail); k <= Math.floor(head); k++) {
          const ends = this.leg(k);
          if (!ends) continue;
          const u = Math.min(1, outCubic(head - k));
          const age = (head - k) / tail;
          const alpha = 0.95 * (1 - age) ** 0.7;
          const [a, b] = ends;
          this.stroke(a, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, n: a.n + (b.n - a.n) * u }, { alpha: alpha * (k % 2 ? 0.75 : 1), width: w * (k % 2 ? 0.8 : 1.2), colour: k % 2 });
          this.node(a, 3.4, { alpha, width: w, colour: 0 });
        }
        return;
      }
      case 'scan': {
        const way = Math.floor(roll(s.layout, 2.2) * 3);
        const back = Math.floor(beats / 4) % 2 === 1;
        const p = (beats % 4) / 4;
        const at = (back ? 1 - p : p) * 1.3 - 0.15;
        for (const m of this.meta) {
          const g = this.segs[m.i];
          if (!g) continue;
          const x = (g.a.x + g.b.x) / 2;
          const y = (g.a.y + g.b.y) / 2;
          const where = way === 0 ? x : way === 1 ? y : (x + y) / 2;
          const k = 1 - Math.abs(where - at) / 0.24;
          if (k > 0) this.line(m, 0, 1, { alpha: smooth(0, 0.6, k), width: w * (0.8 + k * 0.8) });
        }
        this.panels.forEach((p) => {
          const g = this.segs[p.a];
          if (!g) return;
          const x = (g.a.x + g.b.x) / 2;
          const y = (g.a.y + g.b.y) / 2;
          const k = 1 - Math.abs((way === 0 ? x : way === 1 ? y : (x + y) / 2) - at) / 0.13;
          if (k > 0 && p.r < 0.6) this.panel(p, 0, 1, { alpha: 0.8 * smooth(0, 0.5, k), width: w, colour: p.r < 0.15 ? 1 : 0 }, p.r > 0.3);
        });
        return;
      }
      case 'gather': {
        // more and more of them as it builds, and at the last they run on past their ends
        const u = clamp01((t - s.start) / Math.max(1e-3, s.end - s.start));
        const last = smooth(s.end - s.beat * 2, s.end, t);
        for (const m of this.meta) {
          const q = u * u * 1.15 + 0.06 - m.r;
          if (q <= 0) continue;
          this.line(m, 0, outCubic(q / 0.16), { alpha: 0.35 + 0.55 * u, width: w * (0.7 + 0.9 * u), past: 0.9 * last * last });
        }
        return;
      }
      case 'floor':
        return this.floor(beats, w, loud);
      case 'trace':
        return this.trace(t, beats, into, w, out);
    }
  }

  /** the lines as they lie, faint */
  private hold(alpha: number, width: number) {
    for (const m of this.meta) if (m.r < 0.5) this.line(m, 0, 1, { alpha, width });
  }

  /** one leg of the knitted path: along a line, or across to the next */
  private leg(k: number): [P, P] | null {
    const n = this.chain.length;
    const a = this.chain[Math.floor(k / 2) % n];
    const ga = this.segs[a.i];
    if (!ga) return null;
    if (k % 2 === 0) return a.flip ? [ga.b, ga.a] : [ga.a, ga.b];
    const b = this.chain[(Math.floor(k / 2) + 1) % n];
    const gb = this.segs[b.i];
    if (!gb) return null;
    return [a.flip ? ga.a : ga.b, b.flip ? gb.b : gb.a];
  }

  /** the ground squared off, with a beat running away across it */
  private floor(beats: number, w: number, loud: boolean) {
    const { scene } = this.s;
    const l = this.l;
    const cell = 1.6;
    const near = 2.2;
    const far = 34;
    const shown = outCubic(beats / 2);
    const point = (x: number, z: number): P | null => {
      const q = project(l, x, 0.015, -z - l.ahead);
      return q.w > 0.6 ? { x: q.x, y: q.y, n: scene.zScale / q.w } : null;
    };
    const off = l.ahead % cell;
    const per = loud ? 1 : 2;
    const wave = ((beats % per) / per) * (far + 6);
    const wide = 14;
    for (let k = Math.ceil(near / cell); k * cell < far; k++) {
      const z = k * cell - off;
      if (z < near) continue;
      const a = point(-wide, z);
      const b = point(wide, z);
      if (!a || !b) continue;
      const hit = Math.max(0, 1 - Math.abs(z - wave) / 2.4);
      this.stroke(a, b, { alpha: (0.22 + 0.75 * hit) * shown * (1 - smooth(far * 0.55, far, z)), width: w * (0.8 + hit), colour: hit > 0.4 ? 1 : 0 });
    }
    for (let x = -wide; x <= wide; x += cell * 2) {
      // in pieces, so each is at its own distance
      for (let z = near; z < far * 0.8; z += 4) {
        const a = point(x, z);
        const b = point(x, Math.min(far * 0.8, z + 4));
        if (a && b) this.stroke(a, b, { alpha: 0.24 * shown * (1 - smooth(far * 0.5, far * 0.8, z)), width: w * 0.8 });
      }
    }
  }

  /** the outline of who is close by, drawn from the feet up and then a light running round it */
  private trace(t: number, beats: number, into: number, w: number, out: number) {
    const { scene, crop, kicks, beat } = this.s;
    const { i, j, k } = at(scene, this.clip);
    const pick = k < 0.5 ? i : j;
    if (this.traced?.i !== pick) {
      const map = mapAt(scene, scene.times[pick]);
      const level = scene.splits[scene.splits.length - 1] ?? 0.35;
      this.traced = { i: pick, paths: map ? outline(map, scene.width, scene.height, level) : [] };
    }
    const top = outCubic(into / 2.5) * 1.15;
    const hit = t - (this.recent(kicks, t, beat * 2)[0] ?? -9);
    // it answers the kicks with outlines of itself going outwards
    const rings = [0, 1, 2].map((k) => ({ off: k ? 0.014 * k * (0.4 + 0.6 * outCubic(hit / (beat * 0.6))) : 0, alpha: k ? (0.8 / k) * Math.exp(-hit / (beat * 0.55)) : 0.9 }));
    for (const path of this.traced.paths) {
      const n = path.length;
      const head = (beats * 0.35) % 1;
      const pts = path.map((c): P => ({ x: (c[0] - crop.u) / crop.w + 0.5, y: (c[1] - crop.v) / crop.h + 0.5, n: 0.9 }));
      const away = pts.map((p, q) => {
        const a = pts[Math.max(0, q - 2)];
        const b = pts[Math.min(n - 1, q + 2)];
        const dx = (b.x - a.x) * this.s.aspect;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: -dy / len / this.s.aspect, y: dx / len };
      });
      // whichever side of it is farther off
      const mid = Math.floor(n / 2);
      const probe = (k: number) => this.byteAt(path[mid][0] + away[mid].x * 0.03 * k * crop.w, path[mid][1] + away[mid].y * 0.03 * k * crop.h);
      const side = probe(1) > probe(-1) ? -1 : 1;
      for (const ring of rings) {
        if (ring.alpha < 0.03) continue;
        const o = ring.off * side;
        for (let q = 0; q + 1 < n; q++) {
          // where the outline leaves the clip's frame there is nothing to trace
          if (path[q][1] < 0.012 || path[q][0] < 0.008 || path[q][0] > 0.992 || pts[q].y > top) continue;
          const a = pts[q];
          const b = pts[q + 1];
          const d = (((q / n - head) % 1) + 1) % 1;
          const lit = ring.off ? 0 : Math.max(0, 1 - d / 0.14);
          this.stroke({ x: a.x + away[q].x * o, y: a.y + away[q].y * o, n: a.n }, { x: b.x + away[q + 1].x * o, y: b.y + away[q + 1].y * o, n: b.n }, { alpha: ring.alpha * out, width: w * (ring.off ? 0.6 : 0.8 + 0.5 * lit), colour: lit > 0.25 ? 1 : 0 });
        }
      }
    }
  }

  private byteAt(x: number, y: number): number {
    const { scene } = this.s;
    const map = mapAt(scene, this.clip);
    if (!map) return 0;
    const px = Math.max(0, Math.min(scene.width - 1, Math.round(x * scene.width)));
    const py = Math.max(0, Math.min(scene.height - 1, Math.round(y * scene.height)));
    return map[py * scene.width + px];
  }

  dispose() {
    this.geo.dispose();
  }
}

/** where along a→b it is inside a box */
function span(a: P, b: P, r: FrameBox): [number, number] | null {
  let lo = 0;
  let hi = 1;
  for (const [p, d, min, max] of [
    [a.x, b.x - a.x, r.x0, r.x1],
    [a.y, b.y - a.y, r.y0, r.y1],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < min || p > max) return null;
      continue;
    }
    const t0 = (min - p) / d;
    const t1 = (max - p) / d;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi > lo ? [lo, hi] : null;
}

export const strokeMaterial = { vertexShader: STROKE_VERT, fragmentShader: STROKE_FRAG };
