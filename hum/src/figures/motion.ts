/**
 * Line figures: how they move.
 *
 * Everything is worked out from the song time, the beat and the song's analysis (drum hits, loudness
 * curves, sections, drops), never from the frame before, so a seek, a scrub and a frame-by-frame render
 * all show the same picture. A drum hit is a closed-form knock that swells and settles; loudness is the
 * analysed curve, smoothed; a spin is a count of beats or hits, or the area under a curve.
 *
 *   new Drive(analysis, audio)      this frame's drivers
 *   drive.value(by, lagBeats)       0..1 (a hit may dip slightly under 0 as it settles)
 *   drive.turns(by)                 how many bars' worth a spin has run
 *   pose(built, drive)              one matrix per solid
 */
import type { AudioFrame, TrackAnalysis } from '../core/types';
import type { BuiltFigure } from './geometry';
import { axisIndex, type Axis, type Driver, type FigureMotion, type V3 } from './format';

/** 3×4, row by row */
export type Mat = Float64Array;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** what one hit does, `s` seconds after it: up in about 60 ms, a soft overshoot back under rest, still by 0.8 s */
const knock = (s: number) => (s <= 0 ? 0 : s > 1.2 ? 0 : 1.18 * (1 - Math.exp(-s * 34)) * Math.exp(-s * 5.4) * Math.cos(s * 4.6));

function lastBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** the analysis, made ready once: running totals so any stretch's average is two reads */
interface Ready {
  kick: number[];
  snare: number[];
  hat: number[];
  energy: Float64Array;
  low: Float64Array;
  step: number;
  drops: { t: number; s: number }[];
}
const readyCache = new WeakMap<TrackAnalysis, Ready>();
function ready(a: TrackAnalysis): Ready {
  let r = readyCache.get(a);
  if (r) return r;
  const total = (c: Float32Array) => {
    const out = new Float64Array(c.length + 1);
    for (let i = 0; i < c.length; i++) out[i + 1] = out[i] + (Number.isFinite(c[i]) ? c[i] : 0);
    return out;
  };
  const thin = (xs: number[] | undefined, gap: number) => {
    const out: number[] = [];
    for (const t of [...(xs ?? [])].sort((p, q) => p - q)) if (!out.length || t - out[out.length - 1] >= gap) out.push(t);
    return out;
  };
  r = {
    kick: thin(a.layers?.kick, 0.12),
    snare: thin(a.layers?.snare, 0.1),
    hat: thin(a.layers?.hat, 0.08),
    energy: total(a.energyCurve),
    low: total(a.lowCurve),
    step: a.duration / Math.max(1, a.energyCurve.length),
    drops: a.drops.map((t, i) => ({ t, s: a.dropInfo?.[i]?.strength ?? 1 })).sort((p, q) => p.t - q.t),
  };
  readyCache.set(a, r);
  return r;
}
/** running total at time t, between the samples */
function areaAt(c: Float64Array, step: number, t: number): number {
  const x = Math.max(0, Math.min(c.length - 1, t / step));
  const i = Math.floor(x);
  return c[i] + (i + 1 < c.length ? (c[i + 1] - c[i]) * (x - i) : 0);
}
const mean = (c: Float64Array, step: number, t0: number, t1: number) => {
  const a = Math.max(0, t0);
  const b = Math.max(a + step * 0.5, t1);
  return (areaAt(c, step, b) - areaAt(c, step, a)) / ((b - a) / step);
};

export class Drive {
  readonly t: number;
  /** seconds a beat */
  readonly beat: number;
  /** beats since the song began, locked to the beat that is sounding */
  readonly beats: number;
  private a: Ready | null;
  private sections: TrackAnalysis['sections'] | null;
  private audio: AudioFrame;
  /** set by fixed(): every driver at one value */
  private held: number | null = null;
  private heldTurns = 0;

  constructor(analysis: TrackAnalysis | null, audio: AudioFrame) {
    this.audio = audio;
    this.t = audio.time;
    const bpm = audio.bpm > 0 ? audio.bpm : analysis && analysis.bpm > 0 ? analysis.bpm : 120;
    this.beat = 60 / bpm;
    this.beats = audio.time / this.beat;
    // the live beat clock says where in the beat we are; the count comes from song time
    const phase = audio.beatPhase;
    const near = Math.round(this.beats - phase) + phase;
    if (Number.isFinite(near) && audio.playing) this.beats = near;
    this.a = analysis ? ready(analysis) : null;
    this.sections = analysis?.sections ?? null;
  }

  /** a drive with every driver at `v` (for the pose the figure can reach) */
  static fixed(v: number, turns: number): Drive {
    const d = new Drive(null, { time: 0, bpm: 120, beatPhase: 0, playing: false } as AudioFrame);
    d.held = v;
    d.heldTurns = turns;
    return d;
  }

  private hits(list: number[], t: number): number {
    let v = 0;
    for (let i = lastBefore(list, t), n = 0; i >= 0 && n < 6; i--, n++) {
      const s = t - list[i];
      if (s > 1.2) break;
      const k = knock(s);
      v = n === 0 ? k : Math.max(v, k);
    }
    return Math.max(-0.14, Math.min(1, v));
  }
  private hasHits(list: number[]): boolean {
    return list.length > 3;
  }

  value(by: Driver, lagBeats = 0): number {
    if (this.held !== null) return this.held;
    const t = this.t - lagBeats * this.beat;
    const a = this.a;
    const L = this.audio;
    switch (by) {
      case 'kick':
        return a && this.hasHits(a.kick) ? this.hits(a.kick, t) : a ? 0 : L.kick;
      case 'snare':
        return a && this.hasHits(a.snare) ? this.hits(a.snare, t) : a ? 0 : L.snare;
      case 'hat':
        return a && this.hasHits(a.hat) ? this.hits(a.hat, t) * 0.9 : a ? 0 : L.hat;
      case 'beat': {
        const b = this.beats - lagBeats;
        const s = (b - Math.floor(b)) * this.beat;
        // quiet parts still breathe with the beat, a little
        const level = a ? clamp01(0.25 + mean(a.energy, a.step, t - 1.2, t + 0.4) * 1.1) : 0.8;
        return Math.max(-0.14, knock(s) + (b >= 1 ? knock(s + this.beat) : 0)) * level;
      }
      case 'energy':
        return a ? smooth(mean(a.energy, a.step, t - 1.1, t + 0.5)) : L.energy;
      case 'bass': {
        if (!a) return L.bass;
        const slow = clamp01(mean(a.low, a.step, t - 0.35, t + 0.1));
        const hit = this.hasHits(a.kick) ? Math.max(0, this.hits(a.kick, t)) : 0;
        return clamp01(slow * 0.75 + hit * 0.25 * slow);
      }
      case 'build': {
        if (!a) return L.build;
        let v = 0;
        for (const s of this.sections ?? []) {
          if (s.label !== 'build') continue;
          if (t >= s.start && t < s.end) v = Math.max(v, smooth((t - s.start) / Math.max(1, s.end - s.start)));
          else if (t >= s.end && t < s.end + 0.35) v = Math.max(v, 1 - smooth((t - s.end) / 0.35));
        }
        for (const d of a.drops) {
          const to = d.t - t;
          const span = this.beat * 8;
          if (to > 0 && to < span) v = Math.max(v, smooth(1 - to / span) * d.s);
          else if (to <= 0 && to > -0.35) v = Math.max(v, (1 - smooth(-to / 0.35)) * d.s);
        }
        return v;
      }
      case 'drop': {
        if (!a) return L.drop;
        let v = 0;
        for (const d of a.drops) {
          const s = t - d.t;
          if (s >= 0 && s < this.beat * 40) v = Math.max(v, d.s * (1 - Math.exp(-s * 16)) * Math.exp(-s / (this.beat * 9)));
        }
        return v;
      }
    }
  }

  /** how far a figure's parts are thrown apart just now: right open on a drop, closing over a bar or so,
      and a small knock on each kick of a loud part */
  apart(): number {
    if (this.held !== null) return 0;
    const a = this.a;
    let v = Math.max(0, this.value('kick')) * 0.055 * smooth(this.value('energy') * 1.5 - 0.25);
    if (a)
      for (const d of a.drops) {
        const s = this.t - d.t;
        if (s >= 0 && s < this.beat * 12) v = Math.max(v, 0.3 * d.s * (1 - Math.exp(-s * 26)) * Math.exp(-s / (this.beat * 1.7)));
      }
    return v;
  }

  /** bars' worth of turning a spin has done by now */
  turns(by: Driver, lagBeats = 0): number {
    if (this.held !== null) return this.heldTurns;
    const t = this.t - lagBeats * this.beat;
    const a = this.a;
    const steps = (list: number[], per: number) => {
      // every hit turns it on by `per` of a bar, eased over a third of a second
      const i = lastBefore(list, t);
      let v = 0;
      for (let n = i; n > i - 4 && n >= 0; n--) v += smooth((t - list[n]) / 0.34);
      return (Math.max(0, i - 3) + v) * per;
    };
    if (a) {
      if (by === 'kick' && this.hasHits(a.kick)) return steps(a.kick, 0.25);
      if (by === 'snare' && this.hasHits(a.snare)) return steps(a.snare, 0.25);
      if (by === 'hat' && this.hasHits(a.hat)) return steps(a.hat, 0.0625);
      if (by === 'energy' || by === 'build' || by === 'drop') return ((areaAt(a.energy, a.step, t) * a.step) / (this.beat * 4)) * 1.4;
      if (by === 'bass') return ((areaAt(a.low, a.step, t) * a.step) / (this.beat * 4)) * 1.4;
    }
    // the beat: steady, leaning into each beat
    const b = this.beats - lagBeats;
    return (b + 0.07 * Math.sin(b * Math.PI * 2)) / 4;
  }

  /** the same moment heard `beats` later (a wave across a field of figures) */
  behind(beats: number): Drive {
    const d: Drive = Object.create(this);
    const base = this as Drive;
    d.value = (by, lag = 0) => base.value(by, lag + beats);
    d.turns = (by, lag = 0) => base.turns(by, lag + beats);
    d.apart = () => Object.assign(Object.create(base), { t: base.t - beats * base.beat }).apart();
    return d;
  }
}

/* ───────── matrices ───────── */

export const identity = (): Mat => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
export function multiply(a: Mat, b: Mat): Mat {
  const o = new Float64Array(12);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return o;
}
export const apply = (m: Mat, p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const move = (x: number, y: number, z: number): Mat => new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
function rotate(axis: Axis, rad: number, c: V3): Mat {
  const k = axisIndex(axis);
  const i = (k + 1) % 3;
  const j = (k + 2) % 3;
  const m = identity();
  m[i * 4 + i] = Math.cos(rad);
  m[i * 4 + j] = -Math.sin(rad);
  m[j * 4 + i] = Math.sin(rad);
  m[j * 4 + j] = Math.cos(rad);
  for (let r = 0; r < 3; r++) m[r * 4 + 3] = c[r] - (m[r * 4] * c[0] + m[r * 4 + 1] * c[1] + m[r * 4 + 2] * c[2]);
  return m;
}
const scaleAbout = (s: number, c: V3): Mat => new Float64Array([s, 0, 0, c[0] * (1 - s), 0, s, 0, c[1] * (1 - s), 0, 0, s, c[2] * (1 - s)]);

/* ───────── pose ───────── */

interface Node {
  lo: V3;
  hi: V3;
}

/** what a motion's items are and where they sit (worked out once per figure) */
interface Plan {
  nodes: Map<string, Node>;
  /** solid index → its chain of ids, itself first */
  chains: string[][];
  order: { m: FigureMotion; rank: number[]; dirs: V3[]; mid: V3 }[];
}
const plans = new WeakMap<BuiltFigure, Plan>();
function planOf(b: BuiltFigure): Plan {
  let p = plans.get(b);
  if (p) return p;
  const groups = new Map(b.fig.groups.map((g) => [g.id, g]));
  const chains = b.fig.solids.map((s) => {
    const chain = [s.id];
    for (let g = s.group, n = 0; g && n < 6; g = groups.get(g)?.parent, n++) chain.push(g);
    return chain;
  });
  const nodes = new Map<string, Node>();
  chains.forEach((chain, i) => {
    for (const id of chain) {
      const n = nodes.get(id) ?? { lo: [1e9, 1e9, 1e9] as V3, hi: [-1e9, -1e9, -1e9] as V3 };
      for (let k = 0; k < 3; k++) {
        n.lo[k] = Math.min(n.lo[k], b.solids[i].lo[k]);
        n.hi[k] = Math.max(n.hi[k], b.solids[i].hi[k]);
      }
      nodes.set(id, n);
    }
  });
  const midOf = (id: string): V3 => {
    const n = nodes.get(id)!;
    return [(n.lo[0] + n.hi[0]) / 2, (n.lo[1] + n.hi[1]) / 2, (n.lo[2] + n.hi[2]) / 2];
  };
  const order = b.fig.motions.map((m) => {
    const of = m.of.filter((id) => nodes.has(id));
    const mids = of.map(midOf);
    const mid: V3 = [0, 1, 2].map((k) => mids.reduce((s, p) => s + p[k], 0) / Math.max(1, mids.length)) as V3;
    let rank = of.map((_, i) => i);
    let dirs: V3[] = of.map(() => [0, 0, 0]);
    if (m.do === 'ripple' && mids.length) {
      // out from the first part named, by distance
      const d = mids.map((p) => Math.hypot(p[0] - mids[0][0], p[1] - mids[0][1], p[2] - mids[0][2]));
      const far = Math.max(1e-6, ...d);
      rank = d.map((x) => (x / far) * Math.max(1, of.length - 1));
    } else if (m.do === 'spread') {
      if (m.axis === 'out') {
        const far = Math.max(1e-6, ...mids.map((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1])));
        dirs = mids.map((p) => [(p[0] - mid[0]) / far, (p[1] - mid[1]) / far, 0]);
      } else {
        const k = axisIndex(m.axis);
        const far = Math.max(1e-6, ...mids.map((p) => Math.abs(p[k] - mid[k])));
        dirs = mids.map((p) => {
          const v: V3 = [0, 0, 0];
          v[k] = (p[k] - mid[k]) / far;
          return v;
        });
      }
    }
    return { m: { ...m, of }, rank, dirs, mid };
  });
  p = { nodes, chains, order };
  plans.set(b, p);
  return p;
}

export interface Posed {
  mats: Mat[];
  /** solids that a slow motion has carried up off their place: they drop dashed guides back to it */
  lifted: { solid: number; by: number }[];
}

/** where every solid is, `amount` 0..1.5 scaling all motion; `apart` 0..0.4 pulls every part away from the
    middle of the figure, as far as it already is from it (an exploded view) */
export function pose(b: BuiltFigure, d: Drive, amount: number, apart = 0): Posed {
  const plan = planOf(b);
  const local = new Map<string, Mat>();
  const raised = new Map<string, number>();
  const add = (id: string, m: Mat) => local.set(id, local.has(id) ? multiply(m, local.get(id)!) : m);
  for (const { m, rank, dirs } of plan.order) {
    const slow = m.by === 'energy' || m.by === 'build' || m.by === 'drop' || m.by === 'bass';
    m.of.forEach((id, i) => {
      const node = plan.nodes.get(id)!;
      const lag = m.do === 'ripple' ? rank[i] * (m.lag || 0.25) : i * m.lag;
      if (m.do === 'spin') {
        const c = m.pivot ?? ([0, 1, 2].map((k) => (node.lo[k] + node.hi[k]) / 2) as V3);
        add(id, rotate(m.axis === 'out' ? 'z' : m.axis, d.turns(m.by, lag) * m.amt * Math.PI * 2, c));
        return;
      }
      const raw = d.value(m.by, lag) * amount;
      // a settling hit may swing a hinge back past rest, but never sinks a part into what it stands on
      const v = m.do === 'hinge' || m.do === 'breathe' ? raw : Math.max(0, raw);
      const a = m.amt * v;
      switch (m.do) {
        case 'lift':
        case 'ripple':
          add(id, move(0, 0, a));
          if (slow && a > 0) raised.set(id, (raised.get(id) ?? 0) + a);
          break;
        case 'slide': {
          const p: V3 = [0, 0, 0];
          p[axisIndex(m.axis === 'out' ? 'z' : m.axis)] = a;
          add(id, move(p[0], p[1], p[2]));
          break;
        }
        case 'stack': {
          const z = a * (m.of.length > 1 ? rank[i] / (m.of.length - 1) : 1);
          add(id, move(0, 0, z));
          if (slow && z > 0) raised.set(id, (raised.get(id) ?? 0) + z);
          break;
        }
        case 'spread':
          add(id, move(dirs[i][0] * a, dirs[i][1] * a, dirs[i][2] * a));
          break;
        case 'hinge':
          add(id, rotate(m.axis === 'out' ? 'z' : m.axis, (a * Math.PI) / 180, m.pivot!));
          break;
        case 'breathe':
          add(id, scaleAbout(1 + a, [(node.lo[0] + node.hi[0]) / 2, (node.lo[1] + node.hi[1]) / 2, node.lo[2]]));
          break;
      }
    });
  }
  const lifted: Posed['lifted'] = [];
  const mats = plan.chains.map((chain) => {
    let m: Mat | null = null;
    for (const id of chain) {
      const l = local.get(id);
      if (l) m = m ? multiply(l, m) : l;
    }
    return m ?? identity();
  });
  if (apart > 0.001)
    b.solids.forEach((s, i) => {
      mats[i] = multiply(move((s.mid[0] - b.mid[0]) * apart, (s.mid[1] - b.mid[1]) * apart, (s.mid[2] - b.lo[2]) * apart), mats[i]);
    });
  for (const [id, by] of raised) {
    // the widest part of what rose drops the guides
    let best = -1;
    plan.chains.forEach((chain, i) => {
      if (chain.includes(id) && b.solids[i].feet.length && (best < 0 || b.solids[i].area > b.solids[best].area)) best = i;
    });
    if (best >= 0 && by > 1.2) lifted.push({ solid: best, by });
  }
  return { mats, lifted };
}
