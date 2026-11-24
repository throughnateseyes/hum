/**
 * Line figures: the objects drawn for the song, as fine line solids in real 3D.
 *
 * Three takes (the Layout setting):
 *
 *   One     a figure held big, with room for words; it is built at each part of the song and the next
 *           figure takes over every few bars
 *   Field   a floor of figures stretching off in every direction, the camera sliding over it, hits
 *           running through it as a wave
 *   Past    the camera travels past the figures in a row, stopping at each
 *
 * Every frame is worked out from the song time alone (see src/figures/motion.ts). With no figures made
 * yet it shows one built-in figure; planners don't offer it until there are some (usesFigures).
 */
import type * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef, SceneInstance, TrackAnalysis } from '../../core/types';
import { num } from '../../core/uniforms';
import { basisOf, FigureRenderer, fitCamera, reachOf, type Camera, type FrameBox, type Placed } from '../../figures/engine';
import { validateFigure, type Figure, type V3 } from '../../figures/format';
import { buildFigure, type BuiltFigure } from '../../figures/geometry';
import { Drive } from '../../figures/motion';
import { SAMPLE_FIGURE } from '../../figures/sample';
import { figuresAt } from '../../draw/session';

const params: ParamDef[] = [
  {
    id: 'layout',
    label: 'Layout',
    type: 'select',
    default: 'one',
    hint: 'One figure held big, a floor of them, or a slow trip past each in turn.',
    options: [
      { value: 'one', label: 'One' },
      { value: 'field', label: 'Field' },
      { value: 'past', label: 'Past' },
    ],
  },
  { id: 'which', label: 'Figure', type: 'number', min: 0, max: 24, step: 1, default: 0, hint: '0 takes turns through all of them; a number keeps to that one.' },
  {
    id: 'hold',
    label: 'Bars each',
    type: 'select',
    default: '8',
    hint: 'How long a figure stays before the next one.',
    options: [
      { value: '4', label: '4' },
      { value: '8', label: '8' },
      { value: '16', label: '16' },
    ],
  },
  {
    id: 'room',
    label: 'Room for words',
    type: 'select',
    default: 'below',
    options: [
      { value: 'none', label: 'None' },
      { value: 'below', label: 'Below' },
      { value: 'above', label: 'Above' },
      { value: 'side', label: 'Side' },
    ],
  },
  { id: 'weight', label: 'Line weight', group: 'Style', type: 'number', min: 1, max: 6, step: 0.1, default: 2.5 },
  { id: 'shade', label: 'Shading', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.22, hint: '0 keeps every face plain paper.' },
  { id: 'floor', label: 'Floor', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'motion', label: 'Movement', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far the parts move with the music.' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'seed', label: 'Arrangement', type: 'number', min: 1, max: 999, step: 1, default: 1 },
];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const hash = (a: number, b: number, c: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

let sample: Figure | null = null;
/** the figures to draw at song time t: the person's, or the built-in one */
function figures(which: number, coarse: boolean, t: number): BuiltFigure[] {
  const mine = figuresAt(t);
  if (!mine.length) {
    sample ??= validateFigure(SAMPLE_FIGURE)!.figure;
    return [buildFigure(sample, coarse)];
  }
  const all = mine.map((f) => buildFigure(f, coarse));
  return which > 0 ? [all[(which - 1) % all.length]] : all;
}

/** the part of the song playing: when it opened, how long it is, and whether it lands on a drop */
function cueOf(a: TrackAnalysis | null, t: number): { index: number; start: number; end: number; drop: boolean } {
  const secs = a?.sections;
  if (!a || !secs?.length) return { index: 0, start: 0, end: 1e9, drop: false };
  let i = secs.length - 1;
  while (i > 0 && t < secs[i].start) i--;
  return { index: i, start: secs[i].start, end: secs[i].end, drop: a.drops.some((d) => Math.abs(d - secs[i].start) < 0.08) };
}

/** what fits a figure to the frame, kept per figure, frame and layout */
const fits = new Map<string, Camera>();
const fitIds = new WeakMap<BuiltFigure, number>();
let fitNo = 0;
export function figureFit(f: BuiltFigure, aspect: number, box: FrameBox, lens: number, el: number, amount: number, swing: number): Camera {
  let id = fitIds.get(f);
  if (!id) fitIds.set(f, (id = ++fitNo));
  const key = `${id}|${aspect.toFixed(3)}|${box.x0},${box.x1},${box.y0},${box.y1}|${lens}|${el}|${amount.toFixed(2)}|${swing.toFixed(1)}`;
  let c = fits.get(key);
  if (!c) {
    const rest = reachOf(f, [Drive.fixed(0, 0)], amount);
    const far = reachOf(f, [Drive.fixed(1, 0.12), Drive.fixed(1, 0.37), Drive.fixed(0.5, 0.62)], amount);
    const outer = { x0: Math.max(-0.97, box.x0 - 0.1), x1: Math.min(0.97, box.x1 + 0.1), y0: Math.max(-0.96, box.y0 - 0.07), y1: Math.min(0.96, box.y1 + 0.07) };
    c = fitCamera({ az: 45, el, target: f.mid, dist: 600, lens, ox: 0, oy: 0 }, aspect, rest, box, [45 - swing, 45, 45 + swing], far, outer);
    if (fits.size > 200) fits.clear();
    fits.set(key, c);
  }
  return c;
}

/** every figure in the row is about as large as the next */
const sizeOf = (f: BuiltFigure) => 96 / Math.max(f.hi[0] - f.lo[0], f.hi[1] - f.lo[1], (f.hi[2] - f.lo[2]) * 1.15);

const LENS = 6.2;

class FigureScene implements SceneInstance {
  private engine = new FigureRenderer();

  render(ctx: FrameContext, target: THREE.WebGLRenderTarget) {
    const p = ctx.params;
    const t = ctx.audio.time;
    const drive = new Drive(ctx.analysis, ctx.audio);
    const layout = String(p.layout ?? 'one');
    const list = figures(Math.round(num(p, 'which', 0)), layout === 'field', t);
    const seed = Math.round(num(p, 'seed', 1));
    const motion = num(p, 'motion', 1);
    const base = { weight: num(p, 'weight', 2.5), shade: num(p, 'shade', 0.22), motion, floor: num(p, 'floor', 0.6) };
    const set = layout === 'field' ? this.field(ctx, drive, list, seed, t) : layout === 'past' ? this.past(ctx, drive, list, seed, t) : this.one(ctx, drive, list, seed, t);
    this.engine.draw(ctx.renderer, target, ctx.width, ctx.height, set.cam, set.placed, { ...base, ...set.ink, weight: base.weight * set.thin * (1 + 0.28 * motion * Math.max(0, drive.value('snare')) * drive.value('energy')) }, ctx.palette);
  }

  /** where in the song's own blocks of `hold` bars we are, restarted at each part of the song */
  private block(ctx: FrameContext, drive: Drive, t: number) {
    const bar = drive.beat * 4;
    const hold = (Number(ctx.params.hold) || 8) * bar;
    const cue = cueOf(ctx.analysis, t);
    const into = Math.max(0, t - cue.start);
    // a part too short for two goes keeps one figure
    const len = cue.end - cue.start;
    const n = Math.max(1, Math.round(Math.min(len, 1e6) / hold));
    const k = Math.min(n - 1, Math.floor(into / hold));
    const start = cue.start + k * hold;
    const end = k >= n - 1 ? cue.end : start + hold;
    return { cue, k, start, end, bar, since: t - start, left: end - t };
  }

  /** the build-in: slow in a quiet part, at once on a drop */
  private built(b: ReturnType<FigureScene['block']>, energy: number): number {
    // a drop lands on the finished figure: its parts and the camera do the hitting
    if (b.cue.drop && b.k === 0) return 1;
    const full = b.end - b.start;
    const want = b.bar * (2.1 - 1.2 * energy);
    const dur = Math.max(0.25, Math.min(want, full * 0.4));
    // the first lines are already there on the cut: the frame is never empty
    return clamp01(0.16 + (0.84 * b.since) / dur);
  }

  private one(ctx: FrameContext, drive: Drive, list: BuiltFigure[], seed: number, t: number) {
    const b = this.block(ctx, drive, t);
    const energy = drive.value('energy');
    const f = list[(b.cue.index + b.k + seed - 1) % list.length];
    const drift = num(ctx.params, 'drift', 0.5);
    const room = String(ctx.params.room ?? 'below');
    const a = ctx.aspect;
    const tall = a < 0.9;
    const box: FrameBox = tall
      ? room === 'below'
        ? { x0: -0.84, x1: 0.84, y0: -0.3, y1: 0.74 }
        : room === 'above'
          ? { x0: -0.84, x1: 0.84, y0: -0.66, y1: 0.36 }
          : { x0: -0.84, x1: 0.84, y0: -0.6, y1: 0.7 }
      : room === 'below'
        ? { x0: -0.8, x1: 0.8, y0: -0.56, y1: 0.86 }
        : room === 'above'
          ? { x0: -0.8, x1: 0.8, y0: -0.86, y1: 0.56 }
          : room === 'side' && a > 1.2
            ? { x0: -0.08, x1: 0.9, y0: -0.82, y1: 0.84 }
            : { x0: -0.84, x1: 0.84, y0: -0.82, y1: 0.84 };
    const swing = 15 * drift;
    const cam: Camera = { ...figureFit(f, a, box, LENS, 30, num(ctx.params, 'motion', 1), swing) };
    // a slow turn over eight bars, a lean with the wind-up, a settle after the drop
    const bars = drive.beats / 4;
    const side = hash(b.cue.index, b.k, seed) < 0.5 ? -1 : 1;
    const creep = clamp01(b.since / Math.max(1, b.end - b.start));
    cam.az = 45 + swing * side * (0.65 * Math.sin((bars / 8) * Math.PI * 2 + b.k) + 0.35 * (creep * 2 - 1));
    cam.el = 30 + drift * (2.6 * Math.sin((bars / 13) * Math.PI * 2 + 1) - 3 * drive.value('build'));
    cam.dist *= 1.03 - 0.05 * drift * drive.value('build') + 0.05 * drift * (1 - creep) - 0.02 * Math.max(0, drive.value('kick')) * drift;
    // thrown apart on a drop, it needs the room
    cam.dist *= 1 + 0.85 * drive.apart() * num(ctx.params, 'motion', 1);
    const placed: Placed[] = [{ figure: f, at: [0, 0, 0], scale: 1, drive, build: this.built(b, energy), strength: 1, lit: true }];
    const span = Math.max(f.hi[0] - f.lo[0], f.hi[1] - f.lo[1], 40);
    return { cam, placed, thin: 1, ink: { grid: span / 9, reach: span * 1.35, floorZ: f.lo[2], floorAt: [f.mid[0], f.mid[1]] as [number, number] } };
  }

  private field(ctx: FrameContext, drive: Drive, list: BuiltFigure[], seed: number, t: number) {
    const b = this.block(ctx, drive, t);
    const drift = num(ctx.params, 'drift', 0.5);
    const a = ctx.aspect;
    const PITCH = 128;
    const energy = drive.value('energy');
    // the camera slides over the floor, a cell every two to four bars
    const bars = drive.beats / 4;
    const run = bars * (0.16 + 0.22 * drift) + seed * 3.17;
    const at: V3 = [run * PITCH, -run * 0.36 * PITCH, 16];
    const build = drive.value('build');
    const cam: Camera = {
      az: 45 + drift * 9 * Math.sin((bars / 16) * Math.PI * 2),
      el: 36 - drift * 3 * Math.sin((bars / 11) * Math.PI * 2) - 3 * build * drift,
      target: at,
      dist: (a < 0.9 ? 1080 : 820) * (1 - 0.1 * build * drift) * (1 + 0.04 * Math.exp(-b.since / b.bar)),
      lens: 5.6,
      ox: 0,
      oy: 0,
    };
    // one figure is lit at a time: a new one on every other beat, near the middle
    const turn = Math.floor(drive.beats / 2);
    const litI = Math.round(at[0] / PITCH + (hash(turn, 1, seed) - 0.5) * 2.4);
    const litJ = Math.round(at[1] / PITCH + (hash(turn, 2, seed) - 0.5) * 2.4);
    const placed: Placed[] = [];
    const eye = basisOf(cam);
    const ci = Math.round(at[0] / PITCH);
    const cj = Math.round(at[1] / PITCH);
    const R = a < 0.9 ? 5 : 4;
    for (let i = ci - R; i <= ci + R; i++)
      for (let j = cj - R; j <= cj + R; j++) {
        // neighbours never repeat: each row steps on through the list
        const n = list.length;
        const f = list[(((i + j * 2 + Math.floor(hash(j, 0, seed) * n)) % n) + n) % n];
        const size = Math.max(f.hi[0] - f.lo[0], f.hi[1] - f.lo[1], (f.hi[2] - f.lo[2]) * 0.8);
        const k = 88 / size;
        const x = i * PITCH;
        const y = j * PITCH;
        const dist = Math.hypot(x - at[0], y - at[1]) / PITCH;
        if (dist > R + 0.3) continue;
        const strength = 1 - smooth((dist - 1.6) / (R - 1.4)) * 0.97;
        if (strength < 0.04) continue;
        // off the frame altogether (its floor spot, a figure's reach away from every edge)
        const v: V3 = [x - eye.eye[0], y - eye.eye[1], 34 - eye.eye[2]];
        const d = Math.max(1, v[0] * eye.fwd[0] + v[1] * eye.fwd[1] + v[2] * eye.fwd[2]);
        const px = ((v[0] * eye.right[0] + v[1] * eye.right[1] + v[2] * eye.right[2]) * cam.lens) / d;
        const py = ((v[0] * eye.up[0] + v[1] * eye.up[1] + v[2] * eye.up[2]) * cam.lens) / d;
        const pr = (92 * cam.lens) / d;
        if (Math.abs(px) > a + pr || Math.abs(py) > 1 + pr) continue;
        // the floor is drawn in when a part of the song opens, then stays
        const cell = b.k > 0 ? 1 : this.built({ ...b, since: Math.max(0, b.since - dist * drive.beat * 0.4) }, energy);
        placed.push({ figure: f, at: [x - f.mid[0] * k, y - f.mid[1] * k, -f.lo[2] * k], scale: k, drive: drive.behind(dist * 0.25), build: cell, strength, lit: i === litI && j === litJ });
      }
    // farther figures first in the list never matters (depth sorts them); cap the work
    placed.sort((p, q) => q.strength - p.strength);
    const kept: Placed[] = [];
    let solids = 0;
    for (const x of placed) {
      solids += x.figure.solids.length;
      if (solids > 800) break;
      kept.push(x);
    }
    return { cam, placed: kept, thin: 0.8, ink: { grid: PITCH / 8, reach: PITCH * (R + 1), floorZ: 0, floorAt: [at[0], at[1]] as [number, number] } };
  }

  private past(ctx: FrameContext, drive: Drive, list: BuiltFigure[], seed: number, t: number) {
    void t;
    const drift = num(ctx.params, 'drift', 0.5);
    const a = ctx.aspect;
    const tall = a < 0.9;
    // the row runs down-right on a wide frame, and straight away and up on a tall one
    const STEP = 118;
    const way: V3 = tall ? [0.94, 0.34, 0] : [0.86, -0.5, 0];
    // a figure each half block, counted from the song's start so a seek lands on the same one
    const hold = ((Number(ctx.params.hold) || 8) / 2) * 4;
    const x = drive.beats / hold;
    const k = Math.floor(x);
    const f = x - k;
    // travel over the last bar and a half, drifting a little while it waits
    const go = Math.min(0.5, 6 / hold);
    const pos = k + 0.1 * f + 0.9 * easeInOut((f - (1 - go)) / go);
    const kick = Math.max(0, drive.value('kick'));
    // how high the middle of what we look at is, as we go from one to the next
    const n = list.length;
    const high = (i: number) => {
      const g = list[(((i + seed - 1) % n) + n) % n];
      return ((g.hi[2] - g.lo[2]) / 2) * sizeOf(g);
    };
    const go1 = smooth(pos - k);
    const cam: Camera = {
      az: 45 + drift * (8 * Math.sin((drive.beats / 32) * Math.PI * 2) + 10 * (smooth((f - (1 - go)) / go) - 0.5) * Math.sin(k * 2.3)),
      el: 27 + drift * 3 * Math.sin((drive.beats / 44) * Math.PI * 2),
      target: [pos * STEP * way[0], pos * STEP * way[1], high(k) * (1 - go1) + high(k + 1) * go1],
      dist: (tall ? 540 : 385) * (1 + 0.08 * Math.sin(Math.PI * smooth((f - (1 - go)) / go)) - 0.012 * kick * drift - 0.05 * drift * drive.value('build')),
      lens: tall ? 4.1 : 4.6,
      ox: 0,
      oy: String(ctx.params.room ?? 'below') === 'below' ? (tall ? 0.18 : 0.1) : 0,
    };
    const placed: Placed[] = [];
    for (let i = k - 2; i <= k + 3; i++) {
      const fig = list[(((i + seed - 1) % n) + n) % n];
      const s = sizeOf(fig);
      const far = Math.abs(i - pos);
      const strength = 1 - 0.72 * smooth((far - 0.35) / 1.5);
      // each is built as the camera comes to it, and stays built behind it
      const build = i <= k ? (i === k && k === 0 ? clamp01(0.16 + x * 1.4) : 1) : clamp01(0.1 + 0.9 * (1 - (i - pos)) * 1.35);
      placed.push({ figure: fig, at: [i * STEP * way[0] - fig.mid[0] * s, i * STEP * way[1] - fig.mid[1] * s, -fig.lo[2] * s], scale: s, drive: drive.behind(far * 0.2), build, strength: strength * smooth((2.6 - far) / 0.8), lit: i === Math.round(pos) });
    }
    return { cam, placed, thin: 1, ink: { grid: 13, reach: 260, floorZ: 0, floorAt: [cam.target[0], cam.target[1]] as [number, number] } };
  }

  dispose() {
    this.engine.dispose();
  }
}

export const figuresScene: SceneDef = {
  id: 'figures',
  name: 'Line figures',
  description: 'The objects drawn for this song as fine line figures in 3D: built line by line, their parts moving on the beat, the camera drifting round them.',
  category: 'form',
  style: 'form',
  tags: ['minimal', 'graphic', 'editorial', 'calm', 'technical', 'precise', 'clean', 'personal', 'drawn'],
  params,
  usesFigures: true,
  // already fine lines: the hand-drawn finish would trace each one twice
  prefersClean: true,  light: true,
  handInks: 3,
  create: () => new FigureScene(),
};

export const scenes: SceneDef[] = [figuresScene];
