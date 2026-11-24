/**
 * Reads one stretch of a clip: fed its samples in order (a depth map and a picture every tenth of a
 * second), it puts every map on the clip's one scale, follows the background, and, when it has seen
 * them all, works out where the horizon and the vanishing point are in each and how far the camera
 * moved. Pure: no canvas, no network, the same every run.
 *
 * The horizon comes from the ground's depth (fitGround). When the camera moves ahead, the marks on the
 * ground stream out from the vanishing point, and that pins both the point and the speed far better
 * than depth can: depth tells near from far well but is a little off about where nothing is left, and
 * what it is off by (`lift`) is measured here and taken out of the maps.
 */
import { findLines, fitGround, headLine, horizonOf, vanishing, type Ground, type Line } from './geometry';
import { groundSpeeds, NO_SLIDE, slid, texture, Tracker, unslid, type Marks, type View3 } from './track';
import { EYE, type Slide } from './types';

export interface Scale {
  /** the raw nearness that is 1 in the clip's maps */
  max: number;
  /** how fast raw nearness falls off up the ground, per frame height; 0 when no ground is believable */
  slope: number;
}

export interface SampleIn {
  t: number;
  /** nearness as the model gives it; null when only the picture was taken (the first must have one) */
  map: Float32Array | null;
  luma: Float32Array;
  /** the map is already on the clip's scale (times the scale's max): it was read before */
  placed?: boolean;
  /** a frame a moment later, to measure speed by */
  soon?: { t: number; luma: Float32Array };
}

export interface StretchOut {
  /** per sample, frame heights, the horizon's tilt in radians */
  views: View3[];
  slides: Slide[];
  ahead: number[];
  sure: { horizon: number; slide: number; ahead: number };
  camera: 'still' | 'handheld' | 'pan' | 'ahead';
  /** nearness the maps have too much of (see lowered) */
  lift: number;
  /** nearness per frame height of ground, on the clip's scale; 0 when there is none */
  slope: number;
  speeds: number[];
}

/** where a nearness goes once `lift` too much is taken out of it: straight down for anything near, easing to 0 for the far */
export const lowered = (n: number, lift: number) => (lift <= 0 ? n : n > lift * 2 ? n - lift : (n * n) / (4 * lift));

/** the nearness that `lowered` took to n */
export const raised = (n: number, lift: number) => (lift <= 0 ? n : n > lift ? n + lift : 2 * Math.sqrt(lift * n));

interface Kept {
  t: number;
  /** a map was read here */
  mapped: boolean;
  ground: Ground | null;
  y: number;
  roll: number;
  slide: Slide;
  slideSure: number;
  marks: Marks;
  soon: { t: number; marks: Marks } | null;
  pts: Int32Array;
  lines: Line[] | null;
  /** a quarter-size copy of the map, on the clip's scale */
  mini: Float32Array;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1];
};

/** how the picture's parts changed size in the model's eyes between two maps: the typical ratio of a to b where the picture held still */
export function ratioOf(a: Float32Array, b: Float32Array, la: Float32Array | null, lb: Float32Array | null, floor: number): number | null {
  const r: number[] = [];
  for (let i = 3; i < a.length; i += 7) {
    if (a[i] < floor || b[i] < floor) continue;
    if (la && lb && Math.abs(la[i] - lb[i]) > 10) continue;
    r.push(Math.log(a[i] / b[i]));
  }
  if (r.length < 200) return null;
  r.sort((p, q) => p - q);
  // the middle half's mean: steadier than the middle one, and things that really moved don't count
  let s = 0;
  const lo = r.length >> 2;
  const hi = lo * 3;
  for (let i = lo; i < hi; i++) s += r[i];
  return Math.exp(s / (hi - lo));
}

/** a weighted running mean over time */
function smoothed(t: number[], v: number[], w: number[], sigma: number): number[] {
  return t.map((t0) => {
    let s = 0;
    let k = 0;
    for (let j = 0; j < t.length; j++) {
      const d = (t[j] - t0) / sigma;
      if (d * d > 12) continue;
      const g = w[j] * Math.exp(-0.5 * d * d);
      s += g * v[j];
      k += g;
    }
    return k > 1e-9 ? s / k : NaN;
  });
}

/** fill gaps from the nearest known values, in a straight line between them */
function bridged(t: number[], v: number[], none: number): number[] {
  const known = v.map((x, i) => (Number.isFinite(x) ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return v.map(() => none);
  let k = 0;
  return v.map((x, i) => {
    if (Number.isFinite(x)) return x;
    while (k < known.length && known[k] < i) k++;
    const a = known[k - 1];
    const b = known[k];
    if (a === undefined) return v[b];
    if (b === undefined) return v[a];
    return v[a] + ((v[b] - v[a]) * (t[i] - t[a])) / Math.max(1e-6, t[b] - t[a]);
  });
}

const FINE = Float32Array.from({ length: 141 }, (_, i) => (i - 12) * 0.25);
const ROUGH = Float32Array.from({ length: 24 }, (_, i) => (i - 2) * 1.5);

export class Stretch {
  readonly kept: Kept[] = [];
  private tracker: Tracker;
  private prev: { map: Float32Array; luma: Float32Array } | null = null;
  private k = 1;
  private ground: Ground | null = null;
  private rows: number;
  private aspect: number;

  /** `base`: where the background sits in the first sample, when this stretch carries on from another */
  constructor(
    private w: number,
    private h: number,
    private focal: number,
    private scale: Scale,
    private base: Slide = NO_SLIDE,
    /** an earlier sample (its map on the clip's scale, times its max) to set this stretch's scale by */
    private like: { map: Float32Array; luma: Float32Array } | null = null,
    /** the first look said the camera moves ahead */
    ahead = false,
  ) {
    this.tracker = new Tracker(w, h, focal, ahead);
    this.rows = Math.floor(h * 0.6);
    this.aspect = w / h;
  }

  private marks(luma: Float32Array): Marks {
    const t = texture(luma, this.w, this.h);
    const d = new Int8Array(this.w * this.rows);
    for (let i = 0; i < d.length; i++) d[i] = Math.max(-127, Math.min(127, Math.round(t[i] * 4)));
    return { d, w: this.w, rows: this.rows, h: this.h };
  }

  /** The next sample. Answers with its map on the clip's scale (0..1) and how its background sits. */
  push(s: SampleIn): { map: Float32Array | null; slide: Slide; slideSure: number } {
    const { w, h, scale } = this;
    const raw = s.map;
    if (!raw) {
      const tr = this.tracker.push(s.t, s.luma, null);
      const last = this.kept[this.kept.length - 1];
      this.kept.push({ ...last, t: s.t, mapped: false, ground: null, y: NaN, roll: 0, slide: tr.slide, slideSure: tr.slideSure, marks: this.marks(s.luma), soon: s.soon ? { t: s.soon.t, marks: this.marks(s.soon.luma) } : null, lines: null });
      return { map: null, slide: this.outSlide(tr.slide), slideSure: tr.slideSure };
    }
    const g0 = fitGround([raw], w, h, this.ground);
    const steep = g0 ? Math.hypot(g0.a, g0.b) : 0;
    const byGround = g0 && g0.sure > 0.4 && scale.slope > 0 ? scale.slope / steep : null;
    let k: number;
    if (s.placed) k = 1;
    else if (this.prev) {
      const r = ratioOf(this.prev.map, raw, this.prev.luma, s.luma, scale.max * 0.06);
      k = r ?? this.k;
      // held to how steep the ground is, slowly, so it neither drifts nor flickers
      if (byGround && Math.abs(Math.log(byGround / k)) < 0.5) k *= (byGround / k) ** 0.12;
    } else {
      const r = this.like && (ratioOf(this.like.map, raw, this.like.luma, s.luma, scale.max * 0.06) ?? ratioOf(this.like.map, raw, null, null, scale.max * 0.06));
      k = byGround ?? (r && Math.abs(Math.log(r)) < 0.8 ? r : 1);
    }
    this.k = k;
    const onScale = new Float32Array(raw.length);
    const m = k / scale.max;
    for (let i = 0; i < raw.length; i++) onScale[i] = raw[i] * m;
    const aligned = Float32Array.from(raw, (v) => v * k);
    this.prev = { map: aligned, luma: s.luma };
    this.ground = g0;
    const ground = g0 && { ...g0, a: g0.a * m, b: g0.b * m, c: g0.c * m };
    const tr = this.tracker.push(s.t, s.luma, onScale);
    const hz = ground ? horizonOf(ground) : { y: NaN, roll: 0 };
    // bare ground: on the plane, with room round it, and not so far off that nothing shows
    const pts: number[] = [];
    if (ground && ground.sure > 0.2) {
      const on = new Uint8Array(w * this.rows);
      for (let y = 0; y < this.rows; y++)
        for (let x = 0; x < w; x++) {
          const X = ((x + 0.5) / w - 0.5) * this.aspect;
          const Y = (y + 0.5) / h - 0.5;
          const p = ground.a * X + ground.b * Y + ground.c;
          if (p > 0 && hz.y + X * Math.tan(hz.roll) - Y > 0.05 && Math.abs(onScale[y * w + x] - p) < 0.06 * p) on[y * w + x] = 1;
        }
      for (let y = 1; y < this.rows - 3; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) {
          run = on[y * w + x] ? run + 1 : 0;
          // eleven in a row, and the same a little above and below
          if (run >= 11 && ((x + y) & 1) === 0) {
            const i = y * w + x - 5;
            if (on[i + 3 * w] && (y < 4 || on[i - 3 * w])) pts.push(i);
          }
        }
      }
    }
    const mw = w >> 2;
    const mh = h >> 2;
    const mini = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) mini[y * mw + x] = onScale[(y * 4 + 2) * w + x * 4 + 2];
    this.kept.push({
      t: s.t,
      mapped: true,
      ground,
      y: hz.y,
      roll: hz.roll,
      slide: tr.slide,
      slideSure: tr.slideSure,
      marks: this.marks(s.luma),
      soon: s.soon ? { t: s.soon.t, marks: this.marks(s.soon.luma) } : null,
      pts: Int32Array.from(pts),
      lines: this.kept.length % 5 === 0 ? findLines(s.luma, w, h) : null,
      mini,
    });
    return { map: onScale, slide: this.outSlide(tr.slide), slideSure: tr.slideSure };
  }

  /** a slide of this stretch, carried on from the one before it */
  private outSlide(s: Slide): Slide {
    const b = this.base;
    if (b === NO_SLIDE) return s;
    const [x, y] = slid(s, b.x, b.y);
    return { x, y, scale: b.scale * s.scale, turn: b.turn + s.turn };
  }

  /** Everything the samples say together. */
  finish(): StretchOut {
    const ks = this.kept;
    const t = ks.map((k) => k.t);
    const slideSure = ks.length > 1 ? median(ks.slice(1).map((k) => k.slideSure)) : 0;
    const steady = slideSure > 0.5;
    const groundSure = median(ks.filter((k) => k.mapped).map((k) => k.ground?.sure ?? 0));

    let slope = median(ks.filter((k) => k.ground && k.ground.sure > 0.4).map((k) => Math.hypot(k.ground!.a, k.ground!.b)));
    const run = groundSure > 0.25 ? this.forward() : null;

    let views: View3[];
    let horizon = groundSure;
    let lift = 0;
    let camera: StretchOut['camera'];
    let ahead = ks.map(() => 0);
    let aheadSure = 0;
    let speeds = ks.map(() => 0);

    if (run) {
      camera = 'ahead';
      views = run.views;
      lift = Math.min(0.2, Math.max(0, run.off * slope));
      speeds = run.speeds;
      let z = 0;
      ahead = speeds.map((s, i) => {
        if (i) z += ((s + speeds[i - 1]) / 2) * (t[i] - t[i - 1]);
        return z;
      });
      aheadSure = run.sure;
    } else {
      // the horizon of one place doesn't move except as the camera turns: gather it as the first sample saw it
      const at: number[] = [];
      const y: number[] = [];
      const roll: number[] = [];
      const weight: number[] = [];
      for (const k of ks) {
        at.push(k.t);
        if (!k.ground || k.ground.sure < 0.15) {
          y.push(0);
          roll.push(0);
          weight.push(0);
          continue;
        }
        const s = steady ? k.slide : NO_SLIDE;
        const [x0, y0] = unslid(s, 0, k.y);
        const r = k.roll - s.turn;
        y.push(y0 - x0 * Math.tan(r));
        roll.push(r);
        weight.push(k.ground.sure ** 2);
      }
      let sum = weight.reduce((a, b) => a + b, 0);
      // a crowd hides the ground: look at what shows behind everyone over the whole stretch
      const behind = steady && (groundSure < 0.6 || sum < 1) ? this.plate() : null;
      const plate = behind && fitGround([behind.map], behind.w, behind.h);
      if (plate && plate.sure > 0.3 && plate.sure > groundSure) {
        const hz = horizonOf(plate);
        for (let i = 0; i < y.length; i++) {
          y[i] = hz.y;
          roll[i] = hz.roll;
          weight[i] = 1;
        }
        sum = y.length;
        slope = Math.hypot(plate.a, plate.b);
        horizon = plate.sure * 0.9;
      }
      let ySm: number[];
      let rollSm: number[];
      if (sum > 0.05) {
        // take out the odd one before averaging
        const known = y.filter((_, i) => weight[i] > 0);
        const my = median(known);
        for (let i = 0; i < y.length; i++) if (Math.abs(y[i] - my) > 0.08) weight[i] *= 0.02;
        const sig = steady ? 3 : 0.7;
        ySm = bridged(t, smoothed(at, y, weight, sig), my);
        rollSm = bridged(t, smoothed(at, roll, weight, sig), median(roll.filter((_, i) => weight[i] > 0)));
        const spread = median(known.map((v) => Math.abs(v - my)));
        horizon *= Math.min(1, Math.max(0, 1 - (spread - 0.015) / 0.06));
      } else {
        ySm = y.map(() => 0);
        rollSm = y.map(() => 0);
        horizon = 0;
        slope = 0;
      }
      if (horizon < 0.1) {
        slope = 0;
        // no ground to be seen: a crowd's heads, or else the middle of the picture
        const heads = behind && headLine(behind.map, behind.w, behind.h);
        ySm = y.map(() => heads ?? 0);
        rollSm = y.map(() => 0);
        horizon = heads === null ? 0 : 0.25;
      }
      // the vanishing point: every straight edge of the stretch, as the first sample saw it
      const lines: Line[] = [];
      for (const k of ks) {
        if (!k.lines) continue;
        const s = steady ? k.slide : NO_SLIDE;
        const c = Math.cos(-s.turn);
        const n = Math.sin(-s.turn);
        for (const l of k.lines) {
          const [x, yy] = unslid(s, l.x, l.y);
          lines.push({ ...l, x, y: yy, dx: l.dx * c - l.dy * n, dy: l.dx * n + l.dy * c, len: l.len / s.scale });
        }
        if (!steady) break;
      }
      const many = ks.filter((k) => k.lines).length || 1;
      const v = vanishing(lines, this.aspect, { y: ySm[0], roll: rollSm[0] }, horizon > 0.3 ? 0.04 : 0.12);
      const vSure = v ? v.sure * Math.min(1, 1.5 / Math.sqrt(many) + 0.5) : 0;
      let vx = 0;
      let off = 0;
      if (v && vSure > 0.25 && horizon > 0.15 && Math.abs(v.x) < 0.8 * this.aspect) {
        vx = v.x;
        const there = ySm[0] + vx * Math.tan(rollSm[0]);
        // the edges also say how high the horizon is: believed as far as they agree with each other
        off = horizon > 0.3 ? (there - v.y) * vSure * 0.6 : 0;
      }
      if (horizon > 0.3 && off > 0.008) lift = Math.min(0.2, off * slope);
      views = ks.map((k, i) => {
        const s = steady ? k.slide : NO_SLIDE;
        const [x, yy] = slid(s, vx, ySm[i] + vx * Math.tan(rollSm[i]) - off);
        return { x, y: yy, roll: rollSm[i] + s.turn };
      });
      camera = this.kind(slideSure);
      // the marks on the ground stayed where they were (or there was nothing to tell by)
      aheadSure = groundSure > 0.25 ? 0.8 * groundSure : steady ? 0.5 : 0;
    }
    return {
      views,
      slides: ks.map((k) => this.outSlide(k.slide)),
      ahead,
      sure: { horizon, slide: run ? Math.min(0.4, slideSure) : slideSure, ahead: aheadSure },
      camera,
      lift,
      slope,
      speeds,
    };
  }

  /** still, carried or turning, from how the background went */
  private kind(sure: number): 'still' | 'handheld' | 'pan' {
    const ks = this.kept;
    if (ks.length < 4 || sure < 0.3) return sure < 0.3 ? 'handheld' : 'still';
    const v: [number, number][] = [];
    for (let i = 1; i < ks.length; i++) {
      const dt = Math.max(1e-3, ks[i].t - ks[i - 1].t);
      v.push([(ks[i].slide.x - ks[i - 1].slide.x) / dt, (ks[i].slide.y - ks[i - 1].slide.y) / dt]);
    }
    const net = Math.hypot(median(v.map((p) => p[0])), median(v.map((p) => p[1])));
    const pace = v.map((p) => Math.hypot(p[0], p[1])).sort((a, b) => a - b)[Math.floor(v.length * 0.65)];
    if (net > 0.05 && net > pace * 0.6) return 'pan';
    // a tripod's picture moves less than a pixel of the small picture a second
    return pace < 0.0035 ? 'still' : 'handheld';
  }

  /** what shows between and behind things that move, over the whole stretch */
  private plate(): { map: Float32Array; w: number; h: number } | null {
    const ks = this.kept;
    if (ks.length < 3) return null;
    const mw = this.w >> 2;
    const mh = this.h >> 2;
    const mapped = ks.filter((k) => k.mapped);
    const step = Math.max(1, Math.floor(mapped.length / 24));
    const some = mapped.filter((_, i) => i % step === 0);
    if (some.length < 3) return null;
    const out = new Float32Array(mw * mh);
    const col: number[] = [];
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++) {
        col.length = 0;
        for (const k of some) {
          const [px, py] = slid(k.slide, ((x + 0.5) / mw - 0.5) * this.aspect, (y + 0.5) / mh - 0.5);
          const jx = Math.floor((px / this.aspect + 0.5) * mw);
          const jy = Math.floor((py + 0.5) * mh);
          if (jx < 0 || jy < 0 || jx >= mw || jy >= mh) continue;
          col.push(k.mini[jy * mw + jx]);
        }
        col.sort((a, b) => a - b);
        out[y * mw + x] = col.length ? col[Math.floor(col.length * 0.12)] : 0;
      }
    return { map: out, w: mw, h: mh };
  }

  /** Is the camera moving straight ahead? Then where to, and how fast, from the marks on the ground. */
  private forward(): { views: View3[]; speeds: number[]; sure: number; off: number } | null {
    const ks = this.kept;
    const n = ks.length;
    if (n < 6) return null;
    const t = ks.map((k) => k.t);
    const fe = this.focal * EYE;
    const w = ks.map((k) => (k.ground ? k.ground.sure ** 2 + 1e-6 : 0));
    const hy = bridged(t, smoothed(t, ks.map((k) => (k.ground ? k.y : 0)), w, 0.15), 0);
    const hr = bridged(t, smoothed(t, ks.map((k) => k.roll), w, 0.6), 0);
    // what never moves (a reflection on the windscreen, the light on the road) is not a mark on the ground
    const still = new Map<number, Float32Array>();
    const R = 12;
    const meanAt = (i: number) => {
      const c = Math.round(i / 3) * 3;
      let m = still.get(c);
      if (m) return m;
      m = new Float32Array(this.w * this.rows);
      let many = 0;
      for (let j = Math.max(0, c - R); j <= Math.min(n - 1, c + R); j++) {
        for (const k of [ks[j].marks, ks[j].soon?.marks]) {
          if (!k) continue;
          for (let p = 0; p < m.length; p++) m[p] += k.d[p];
          many++;
        }
      }
      for (let p = 0; p < m.length; p++) m[p] /= Math.max(1, many);
      still.set(c, m);
      return m;
    };
    const without = (k: Marks, m: Float32Array): Marks => {
      const d = new Int8Array(k.d.length);
      for (let p = 0; p < d.length; p++) d[p] = Math.max(-100, Math.min(100, k.d[p] - m[p]));
      return { ...k, d };
    };
    type Pair = { i: number; a: Marks; pts: Int32Array; to: { b: Marks; dt: number; j: number; part: number }[] };
    const cache = new Map<number, Pair>();
    const pair = (i: number): Pair => {
      let p = cache.get(i);
      if (p) return p;
      const m = meanAt(i);
      const a = without(ks[i].marks, m);
      const to: Pair['to'] = [];
      const soon = ks[i].soon;
      if (soon) to.push({ b: without(soon.marks, m), dt: soon.t - t[i], j: i, part: i + 1 < n ? (soon.t - t[i]) / Math.max(1e-3, t[i + 1] - t[i]) : 0 });
      if (i + 1 < n) to.push({ b: without(ks[i + 1].marks, m), dt: t[i + 1] - t[i], j: i + 1, part: 1 });
      const pts = ks[i].pts.filter((q) => Math.abs(a.d[q]) > 5);
      p = { i, a, pts, to: to.filter((q) => q.dt > 0.004) };
      cache.set(i, p);
      return p;
    };
    /** how far the background turned between two samples: the vanishing point went with it */
    const turned = (i: number, j: number, part: number, v: View3): View3 => {
      if (i === j && !part) return v;
      const k = Math.min(n - 1, i + 1);
      // what depth says the horizon did is steadier than the background when the camera moves
      const dy = (hy[k] - hy[i]) * part;
      return { x: v.x, y: v.y + dy, roll: v.roll + (hr[k] - hr[i]) * part };
    };
    const score = (window: number[], x: number, off: number, speeds: Float32Array, most: number): Float32Array | null => {
      const sum = new Float32Array(speeds.length);
      let k = 0;
      for (const i of window) {
        const p = pair(i);
        const v = { x, y: hy[i] + x * Math.tan(hr[i]) - off, roll: hr[i] };
        for (const q of p.to) {
          const r = groundSpeeds(p.a, q.b, p.pts, v, turned(i, q.j, q.part, v), fe, q.dt, speeds, most);
          if (!r) continue;
          for (let s = 0; s < sum.length; s++) sum[s] += r[s];
          k++;
        }
      }
      if (!k) return null;
      for (let s = 0; s < sum.length; s++) sum[s] /= k;
      return sum;
    };
    const top = (c: Float32Array) => {
      let b = 0;
      for (let s = 1; s < c.length; s++) if (c[s] > c[b]) b = s;
      return b;
    };
    const ZERO = 2;
    const around = (c: number, half: number, step: number) => {
      const a: number[] = [];
      for (let i = Math.max(0, c - half); i <= Math.min(n - 1, c + half); i += step) if (ks[i].pts.length > 150) a.push(i);
      return a;
    };
    // first, anywhere: is there a point everything on the ground streams out of?
    type Seed = { c: number; x: number; off: number; gain: number; peak: number; speed: number };
    const seeds: Seed[] = [];
    const tries: Seed[] = [];
    for (const share of [0.2, 0.5, 0.8]) {
      const c = Math.round((n - 1) * share);
      const win = around(c, 6, 3);
      if (!win.length) continue;
      let here: Seed | null = null;
      for (let x = -0.55 * this.aspect; x <= 0.55 * this.aspect; x += 0.055)
        for (const off of [0.05, 0.03, 0.01, -0.01]) {
          const r = score(win, x, off, ROUGH, 500);
          if (!r) continue;
          const b = top(r);
          if (!here || r[b] > here.peak) here = { c, x, off, gain: r[b] - r[ZERO], peak: r[b], speed: ROUGH[b] };
        }
      if (!here) continue;
      tries.push(here);
      if (here.speed >= 1.5 && here.peak > 0.3) seeds.push(here);
    }
    const good = tries.filter((q) => q.speed >= 1.5 && q.gain > 0.06 && q.peak > 0.3).length;
    if (!seeds.length || good * 2 < tries.length) return null;
    const seed = seeds.reduce((a, b) => (b.peak > a.peak ? b : a));
    // then closely, from there outwards in both directions
    const found: { c: number; x: number; off: number; peak: number; gain: number }[] = [];
    const settle = (c: number, x0: number, off0: number) => {
      const win = around(c, 6, 2);
      if (win.length < 2) return null;
      let x = x0;
      let off = off0;
      let best = -1;
      let gain = 0;
      const look = (xx: number, oo: number) => {
        const r = score(win, xx, oo, ROUGH, 900);
        if (!r) return false;
        const b = top(r);
        // a faint pull back to where it was just before: the point drifts, it never jumps
        const s = r[b] - ((xx - x0) / 0.25) ** 2 * 0.05 - ((oo - 0.015) / 0.06) ** 2 * 0.03;
        if (s <= best + 1e-5) return false;
        best = s;
        gain = r[b] - r[ZERO];
        x = xx;
        off = oo;
        return true;
      };
      look(x, off);
      for (const st of [0.04, 0.02, 0.01, 0.005]) {
        let go = true;
        for (let k = 0; go && k < 12; k++) {
          go = false;
          const [cx, co] = [x, off];
          for (const [dx, d] of [[st, 0], [-st, 0], [0, st * 0.5], [0, -st * 0.5]]) if (Math.abs(co + d) < 0.07 && look(cx + dx, co + d)) go = true;
        }
      }
      return { c, x, off, peak: best, gain };
    };
    const STEP = 5;
    for (const dir of [1, -1]) {
      let [x, off] = [seed.x, seed.off];
      for (let c = seed.c + (dir < 0 ? -STEP : 0); c >= 0 && c < n; c += dir * STEP) {
        const r = settle(c, x, off);
        if (!r) continue;
        found.push(r);
        if (r.peak > 0.35 && r.gain > 0.04) [x, off] = [r.x, r.off];
      }
    }
    found.sort((a, b) => a.c - b.c);
    if (!found.length) return null;
    const trust = (f: (typeof found)[number]) => Math.max(0, Math.min(1, (f.peak - 0.3) / 0.4)) * Math.max(0, Math.min(1, f.gain / 0.12)) + 1e-4;
    const ft = found.map((f) => t[f.c]);
    const fw = found.map(trust);
    const at = (v: number[], sigma: number) =>
      t.map((t0) => {
        let s = 0;
        let k = 0;
        for (let j = 0; j < found.length; j++) {
          const g = fw[j] * (Math.exp(-0.5 * ((ft[j] - t0) / sigma) ** 2) + 1e-5);
          s += g * v[j];
          k += g;
        }
        return s / k;
      });
    const x = at(found.map((f) => f.x), 0.6);
    const off = at(found.map((f) => f.off), 2.5);
    const views = ks.map((_, i) => ({ x: x[i], y: hy[i] + x[i] * Math.tan(hr[i]) - off[i], roll: hr[i] }));
    // the speed, sample by sample, now the point is known
    const curves = ks.map((_, i) => {
      if (ks[i].pts.length < 150) return null;
      const p = pair(i);
      const sum = new Float32Array(FINE.length);
      let k = 0;
      for (const q of p.to) {
        const r = groundSpeeds(p.a, q.b, p.pts, views[i], turned(i, q.j, q.part, views[i]), fe, q.dt, FINE, 1500);
        if (!r) continue;
        for (let s = 0; s < sum.length; s++) sum[s] += r[s];
        k++;
      }
      if (!k) return null;
      return sum.map((v) => v / k);
    });
    const speed: number[] = [];
    const conf: number[] = [];
    for (let i = 0; i < n; i++) {
      const sum = new Float32Array(FINE.length);
      let k = 0;
      for (let j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8); j++) {
        const c = curves[j];
        if (!c) continue;
        const g = Math.exp(-0.5 * ((t[j] - t[i]) / 0.3) ** 2);
        for (let s = 0; s < sum.length; s++) sum[s] += c[s] * g;
        k += g;
      }
      if (!k) {
        speed.push(0);
        conf.push(0);
        continue;
      }
      const b = top(sum);
      let sp = FINE[b];
      if (b > 0 && b < sum.length - 1) {
        const den = sum[b - 1] - 2 * sum[b] + sum[b + 1];
        if (den < 0) sp += (0.25 * 0.5 * (sum[b - 1] - sum[b + 1])) / den;
      }
      let mean = 0;
      for (const v of sum) mean += v / sum.length;
      const peak = sum[b] / k;
      speed.push(sp);
      conf.push(Math.max(0, Math.min(1, (peak - 0.3) / 0.3)) * Math.max(0, Math.min(1, (peak - mean / k) / 0.12)));
    }
    const raw = smoothed(t, speed, conf.map((c) => c * c + 1e-9), 0.4);
    const solid = conf.map((c) => (c > 0.15 ? 1 : 0));
    const speeds = bridged(t, raw.map((v, i) => (solid[i] || smoothedSure(conf, i) ? v : NaN)), 0);
    const sure = conf.reduce((a, b) => a + b, 0) / n;
    let om = 0;
    let ok = 0;
    for (let i = 0; i < off.length; i++) {
      om += off[i];
      ok++;
    }
    return { views, speeds, sure, off: om / ok };
  }
}

const smoothedSure = (c: number[], i: number) => c.slice(Math.max(0, i - 3), i + 4).some((v) => v > 0.3);
