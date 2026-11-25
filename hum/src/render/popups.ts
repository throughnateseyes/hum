import * as THREE from 'three';
import type { FrameContext, TrackAnalysis } from '../core/types';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { noteThing, trialOf } from '../arrange/things';
import { clampTo, cornerAt, popSetFor, POP_SIZE, shapeOfFrame, spotFor, type PopSet, type Spot, type WindowShape } from '../arrange/types';
import { audioEngine } from '../audio/engine';
import { beatOffset } from '../audio/frameDsp';
import { lum, makeInk, mix, rgba, setFont, MONO } from '../scenes/board/kit';
import type { BF, Ink, Module, Rect, SF } from '../scenes/board/kit';
import { harmonograph, minimap, odometer, pong, radar, runner, terminal, typewriter, weather, wordCloud } from '../scenes/board/mod-fun';
import { ticker, topWords, upNext } from '../scenes/board/mod-words';
import { tetris } from '../scenes/board/mod-gen';
import { chroma, radial, scope, spectrogram, stepSeq } from '../scenes/board/mod-signal';
import { popLevelAt, sectionIndexAt } from '../state/plan';
import { originalOf } from '../state/planCache';
import { popDealsVersion, popSeedAt } from '../state/popSeed';
import { useStudio } from '../state/store';
import { noteLineWindow } from './lyricTiming';
import { NO_KEEP_OUT, type KeepOut, type Rect as NRect } from './legibility';
import { glide, newGlide, overlap, toPx, toRect, type Glide, type PxBox } from './keepClear';

/**
 * Pop-ups: little framed board windows (one instrument each, with a title bar) that pop in over
 * whatever is playing — on part changes, drops and some bars — and snap shut a few bars later.
 * Drawn on a 2D canvas and composited into the frame, so they are in renders too. How busy it gets
 * comes from popLevelAt() (the video plan, the person's own level per part, or the Always mode).
 *
 * The same every time. Each part of the song deals its pop-ups up front from its seed (popSeed.ts)
 * and the song's own beat grid, drops and drum hits: when each window opens and closes, which
 * instrument it is, where it sits and how its title bar looks. Every frame then draws the windows
 * that are open at that moment of the song, so a part looks the same on every play, after a seek
 * (forwards or back), after a reload and in a render. Nothing here rolls Math.random.
 *
 * A part's windows belong to it: they all close where the part ends, so splitting, combining or
 * reshuffling one part never moves another part's pop-ups.
 *
 * They keep clear of the sung line (keepClear.ts): a window opens where its deal put it and, if the
 * words are there, steps out of their way (straight away when it first shows, gliding while it's up).
 */

interface Kind {
  title: string;
  make: () => Module;
  /** size in units of min(width, height) × 0.36 */
  w: number;
  h: number;
  needs?: 'words' | 'map';
}

/** a words module that shows the sung line: it tells the lyric layer each time it draws with synced lyrics */
function sungLine(mod: ReturnType<typeof typewriter>): ReturnType<typeof typewriter> {
  const draw = mod.draw.bind(mod);
  return {
    ...mod,
    draw(ctx, r, bf) {
      const l = useStudio.getState().lyrics;
      if (l?.synced && l.lines.length) noteLineWindow();
      draw(ctx, r, bf);
    },
  };
}

const KINDS: Kind[] = [
  { title: 'SONG.LOG', make: terminal, w: 1.3, h: 0.85 },
  { title: 'RADAR', make: radar, w: 0.95, h: 0.95 },
  { title: 'TEMPO', make: odometer, w: 1.05, h: 0.78 },
  { title: 'PONG.EXE', make: pong, w: 1.15, h: 0.78 },
  { title: 'RUNNER', make: runner, w: 1.35, h: 0.62 },
  { title: 'XY.SCOPE', make: harmonograph, w: 0.9, h: 0.9 },
  { title: 'FORECAST', make: weather, w: 1.35, h: 0.78 },
  { title: 'SONG MAP', make: minimap, w: 1.45, h: 0.52, needs: 'map' },
  { title: 'WORDS', make: wordCloud, w: 1.15, h: 0.85, needs: 'words' },
  // the two windows that show the sung line say so while they draw, and the lyric overlay stands down:
  // the words are in one place at a time
  { title: 'TYPEWRITER', make: () => sungLine(typewriter()), w: 1.4, h: 0.62, needs: 'words' },
  { title: 'NOW SINGING', make: upNext, w: 1.3, h: 0.62, needs: 'words' },
  { title: 'NEWS.WIRE', make: () => ticker('WIRE'), w: 1.6, h: 0.34, needs: 'words' },
  { title: 'HI-SCORES', make: () => topWords('MOST SUNG'), w: 1, h: 0.85, needs: 'words' },
  { title: 'TETRIS', make: tetris, w: 0.72, h: 1.05 },
  { title: 'SPECTROGRAM', make: spectrogram, w: 1.25, h: 0.62 },
  { title: 'BEAT', make: radial, w: 0.95, h: 0.95 },
  { title: 'SCOPE', make: scope, w: 1.05, h: 0.6 },
  { title: 'SEQUENCER', make: stepSeq, w: 1.45, h: 0.5 },
  { title: 'PITCH', make: chroma, w: 1, h: 0.62 },
];

/** the instruments there are, for choosing one by hand */
export const popKinds = (): { title: string; needs?: 'words' | 'map' }[] => KINDS.map(({ title, needs }) => ({ title, ...(needs ? { needs } : {}) }));

/** an instrument's own size in a W×H frame */
function kindSize(kind: Kind, W: number, H: number): { w: number; h: number } {
  const U = Math.min(W, H) * 0.36;
  return { w: Math.round(Math.min(W * 0.5, kind.w * U)), h: Math.round(Math.min(H * 0.42, kind.h * U + U * 0.1)) };
}

/* ───────── shared with sceneWindows.ts: parts, dice and the song's grid ───────── */

/** a pop-up of a part as it would be dealt, for the person to change (arrange/edit.ts) */
export interface DealtPop {
  id: string;
  title?: string;
  look?: string;
  style: number;
  from: number;
  to: number;
  spot: Spot;
  shape?: WindowShape;
  snap?: true;
  trail?: true;
}

/** windows that are up at once, cut to the most that may show: a newer one takes the oldest's place */
export function cutTo<T extends { born: number; until: number }>(wins: T[], most: number): T[] {
  if (most <= 0) return [];
  const out: T[] = [];
  for (const w of [...wins].sort((a, b) => a.born - b.born)) {
    const open = out.filter((o) => o.until > w.born);
    if (open.length >= most) open[0].until = w.born;
    out.push({ ...w });
  }
  return out.filter((w) => w.until - w.born > 0.25);
}

/** a window's name, kept when a part's deal is first changed by hand */
export const dealtId = (start: number, layer: 'p' | 'w', id: number) => `${layer}${Math.round(start * 1000)}-${id}`;

/** the pop-ups set by hand for a part, when there are any to go by */
export function handSet(part: PopPart): PopSet | null {
  const s = useStudio.getState();
  if (!s.placed.pops.length || !s.planOn || audioEngine.kind !== 'file') return null;
  const set = popSetFor(s.placed, part.start, part.end);
  // with pop-ups off for the video, only the ones put somewhere by hand stay
  if (!set || s.popups !== 'off') return set;
  let kept = keptOnly.get(set);
  if (!kept) keptOnly.set(set, (kept = { ...set, wins: set.wins.filter((w) => Object.values(w.spots).some((x) => !x.dealt)) }));
  return kept;
}
const keptOnly = new WeakMap<PopSet, PopSet>();

/** a stretch of song whose pop-ups are dealt together */
export interface PopPart {
  index: number;
  start: number;
  end: number;
  seed: number;
  /** starts one of the song's real sections (not just a shot inside one), so it opens with a burst */
  opens: boolean;
}

/** without a song map (the mic, a song still being analysed) the song is dealt in stretches this long */
const FREE_PART = 30;

/** the part playing at song time `t` (its bounds and its seed) */
export function popPartAt(a: TrackAnalysis | null | undefined, t: number): PopPart {
  const secs = a?.sections ?? [];
  if (!secs.length) {
    const index = Math.max(0, Math.floor(t / FREE_PART));
    return { index, start: index * FREE_PART, end: (index + 1) * FREE_PART, seed: popSeedAt(index * FREE_PART), opens: index > 0 };
  }
  const index = sectionIndexAt(secs, t);
  const sec = secs[index];
  const end = secs[index + 1]?.start ?? Math.max(sec.end, a!.duration);
  // every shot is its own part now: the song's real sections (originalOf) say where a new section opens
  const opens = sec.start > 1 && originalOf(a!).sections.some((o) => Math.abs(o.start - sec.start) < 0.05);
  return { index, start: sec.start, end, seed: popSeedAt(sec.start), opens };
}

/** the part before `p` (its windows may still be closing as `p` starts), or null at the top */
export function prevPopPart(a: TrackAnalysis | null | undefined, p: PopPart): PopPart | null {
  return p.start > 0.001 ? popPartAt(a, p.start - 0.001) : null;
}

/** dice dealt from a seed (mulberry32): the same seed always rolls the same numbers */
export function dealer(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** a small integer hash → 0..1 (repeatable, unlike Math.random) */
export function hash01(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** the song's beat grid: seconds per beat and where beat 0 sits (the same grid the beat counter uses) */
export function songGrid(a: TrackAnalysis | null | undefined, liveBpm: number): { spb: number; off: number } {
  const bpm = audioEngine.bpmOverride || a?.bpm || (liveBpm > 30 ? liveBpm : 110);
  return { spb: 60 / bpm, off: a ? beatOffset(a, bpm) : 0 };
}

/** index of the last time in sorted `xs` at or before `t` (-1 when none) */
export function lastAt(xs: readonly number[], t: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0 || xs[0] > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** the bar lines (every 4 beats on the grid) in [start, end), with their bar numbers */
export function barsIn(start: number, end: number, spb: number, off: number): { t: number; n: number }[] {
  const bar = spb * 4;
  const out: { t: number; n: number }[] = [];
  for (let n = Math.max(0, Math.ceil((start - off) / bar - 1e-6)); off + n * bar < end; n++) out.push({ t: off + n * bar, n });
  return out;
}

/** the song map's drops inside a part, a second apart at least */
export function dropsIn(a: TrackAnalysis | null | undefined, start: number, end: number): number[] {
  const out: number[] = [];
  for (const d of a?.drops ?? []) if (d >= start && d < end && (!out.length || d - out[out.length - 1] >= 1)) out.push(d);
  return out;
}

/**
 * Deals are made at a reference size for the frame's shape (its short side 1080), then scaled to the
 * frame, so the live stage and a render of another resolution, same shape, deal exactly alike.
 */
export function refSize(W: number, H: number): { RW: number; RH: number; k: number } {
  const short = Math.max(1, Math.min(W, H));
  return { RW: Math.round((1080 * W) / short), RH: Math.round((1080 * H) / short), k: short / 1080 };
}

/** keeping clear of the words: re-plan from where the deal put the window whenever a new line arrives */
export function keepGlide(pos: { x: number; y: number }, home: { x: number; y: number }, g: Glide, w: number, h: number, words: PxBox | null, W: number, H: number, m: number, others: PxBox[], dt: number, snap: boolean) {
  if (words) {
    const key = `${Math.round(words.x)},${Math.round(words.y)},${Math.round(words.w)},${Math.round(words.h)}`;
    // starting from home each time keeps where a window goes a matter of the line on screen now, not
    // of every line it lived through, so a seek lands it where playing through would have
    if (key !== g.keepKey) {
      g.gx = home.x;
      g.gy = home.y;
    }
  }
  glide(pos, g, w, h, words, W, H, m, others, snap ? 0 : dt);
  if (snap) {
    // first seen (or just seeked to): already where it's going, no slide in from elsewhere
    pos.x = g.gx;
    pos.y = g.gy;
    g.vx = g.vy = 0;
    g.fit = g.fitTo;
  }
}

/* ───────── the pop-ups ───────── */

/** one dealt window: everything about it that's decided up front */
interface Dealt {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  born: number;
  /** when it starts closing (a part's windows are all closed by its end) */
  until: number;
  /** title bar: 0 striped, 1 accent, 2 ink */
  style: number;
  /** what it is called when it is arranged by hand, and whether it stays exactly where it was put */
  uid: string;
  exact: boolean;
}

interface Deal {
  key: string;
  part: PopPart;
  wins: Dealt[];
  /** the person's own: they all show, whatever is on screen */
  hand: boolean;
}

/** a dealt window on screen: its instrument, its drawn chrome and where it is gliding */
interface Win {
  d: Dealt;
  /** where its deal put it, in this frame's pixels */
  home: { x: number; y: number };
  kind: Kind;
  mod: Module;
  x: number;
  y: number;
  w: number;
  h: number;
  born: number;
  /** when it started closing this frame (-1 while open) */
  closing: number;
  style: number;
  cache: HTMLCanvasElement | null;
  cacheKey: string;
  bumpX: number;
  bumpY: number;
  /** keeping clear of the lyrics: where it's gliding to, and a little shrink when there's no room */
  g: Glide;
}

/** on a dark palette the windows land as light paper sheets, so they pop off the picture */
export function paperInk(ink: Ink): Ink {
  if (ink.light) return ink;
  const bg = mix(ink.fg, [250, 247, 238], 0.55);
  const fg = mix(ink.bg, [0, 0, 0], 0.4);
  const deepen = (c: typeof bg) => (lum(c) > 0.5 ? mix(c, fg, 0.42) : c);
  return { ...ink, bg, fg, ac: deepen(ink.ac), ac2: deepen(ink.ac2), mu: mix(bg, fg, 0.28), line: mix(bg, fg, 0.3), paper: bg, light: true, key: `${ink.key}|paper` };
}

const IN_STEP = 0.045;
const IN_SCALES = [0.35, 1.14, 0.95, 1];
const OUT_TIME = 0.16;
const MAX_OPEN = [0, 2, 3, 4];
/** the most of the frame a part's open windows may cover between them */
const MOST_COVER = [0, 0.12, 0.18, 0.24];
const BAR_CHANCE = [0, 0.1, 0.22, 0.42];
/** deals kept (the part playing, the one before and a few recent), so moving around doesn't re-deal */
const KEEP_DEALS = 6;

/** a level for every moment of the song, or one level for all of it */
export type PopLevel = number | ((t: number) => number);

export class PopupLayer {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex = new THREE.CanvasTexture(this.canvas);
  private mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
  private quad = createFullscreenQuad(this.mat);
  private deals = new Map<string, Deal>();
  /** windows on screen, by deal key and window id */
  private live = new Map<string, Win>();
  /** this frame's windows, oldest first */
  private wins: Win[] = [];
  private empty = true;
  private sceneKey = '';
  /** song time last frame, to tell playing on from a seek */
  private lastSong = -1;
  private lastTime = -1;

  constructor() {
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
  }

  /**
   * `level` is how busy each part is (popLevelAt() by default; the stage passes the instruments' share);
   * `keep` is where the lyrics are (lyricLayer.keepOut()), for the windows to keep clear of;
   * `show` is the most windows drawn right now (fewer over a busy board look), which leaves the deal alone.
   */
  render(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, target: THREE.WebGLRenderTarget | null = null, level: PopLevel = popLevelAt, keep: KeepOut = NO_KEEP_OUT, show = 4) {
    const a = base.audio;
    const song = a.time;
    const scale = Math.min(1, 1920 / Math.max(base.width, base.height, 1));
    const W = Math.max(2, Math.round(base.width * scale));
    const H = Math.max(2, Math.round(base.height * scale));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      // the GL texture was allocated at the old size: without a new one every window lands squashed and off its place
      this.tex.dispose();
    }
    this.size = { W, H };

    // the windows open at this moment of the song: this part's, and the last part's still closing
    const an = base.analysis;
    const grid = songGrid(an, a.bpm);
    const levelAt = typeof level === 'number' ? () => level : level;
    const ref = refSize(W, H);
    const part = popPartAt(an, song);
    const prev = prevPopPart(an, part);
    const want: { key: string; d: Dealt; hand: boolean }[] = [];
    this.now = { part, show };
    for (const p of prev && song - part.start < OUT_TIME ? [prev, part] : [part]) {
      const deal = this.dealFor(p, levelAt(p.start + 0.001), base, ref.RW, ref.RH, grid);
      if (p === part) this.now.deal = deal;
      for (const d of deal.wins) if (d.born <= song && song < d.until + OUT_TIME) want.push({ key: `${deal.key}#${d.id}`, d, hand: deal.hand });
    }
    // most windows drawn: the newest open ones (the deal doesn't change, only how many show). One that is
    // closing only does if it was up: with nothing showing it must not flash by as it goes
    let room = Math.max(0, show);
    for (let k = want.length - 1; k >= 0; k--) {
      const { d, hand, key } = want[k];
      if (d.until <= song) {
        if (!this.live.has(key) || (!hand && show <= 0)) want.splice(k, 1);
      } else if (hand) continue;
      else if (room > 0) room--;
      else want.splice(k, 1);
    }

    const seeked = this.lastSong < 0 || song < this.lastSong - 1e-3 || song - this.lastSong > 0.5;
    this.lastSong = song;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, base.time - this.lastTime));
    this.lastTime = base.time;
    const next = new Map<string, Win>();
    const wins: Win[] = [];
    const fresh = new Set<Win>();
    for (const { key, d: d0 } of want) {
      // the one in the hand is where the hand has it
      const held = trialOf(`pop:${d0.uid}`);
      const d = held ? { ...d0, ...boxAt(d0.kind, held, ref.RW, ref.RH, false), exact: true } : d0;
      const x = Math.round(d.x * ref.k);
      const y = Math.round(d.y * ref.k);
      const ww = Math.round(d.w * ref.k);
      const wh = Math.round(d.h * ref.k);
      let w = this.live.get(key);
      if (!w) fresh.add((w = { d, home: { x, y }, kind: d.kind, mod: d.kind.make(), x, y, w: ww, h: wh, born: d.born, closing: -1, style: d.style, cache: null, cacheKey: '', bumpX: 0, bumpY: 0, g: newGlide(x, y) }));
      else if (w.d !== d) {
        // moved, resized or changed by hand: it is at once what it was made
        if (w.kind !== d.kind) {
          w.kind = d.kind;
          w.mod = d.kind.make();
        }
        if (w.home.x !== x || w.home.y !== y || w.w !== ww || w.h !== wh || w.d.exact !== d.exact) {
          Object.assign(w, { home: { x, y }, x, y, w: ww, h: wh, g: newGlide(x, y) });
          fresh.add(w);
        }
        Object.assign(w, { d, born: d.born, style: d.style });
      }
      w.closing = song >= d.until ? d.until : -1;
      next.set(key, w);
      wins.push(w);
    }
    this.live = next;
    this.wins = wins;

    // open windows step out of the sung line's way
    const m = Math.min(W, H) * 0.04;
    const words = toPx(keep.now, W, H, Math.min(W, H) * 0.02);
    for (const w of wins) {
      if (w.closing >= 0 || w.d.exact) continue;
      const others = wins.filter((o) => o !== w && o.closing < 0).map((o) => this.goalBox(o));
      keepGlide(w, w.home, w.g, w.w, w.h, words, W, H, m, others, dt, seeked || fresh.has(w));
    }
    for (const w of wins) {
      if (w.closing >= 0) continue;
      const b = this.goalBox(w);
      const own = kindSize(w.kind, ref.RW, ref.RH);
      noteThing({ key: `pop:${w.d.uid}`, kind: 'pop', name: w.kind.title, box: toRect(b, W, H), spot: { x: (w.d.x + w.d.w / 2) / ref.RW, y: (w.d.y + w.d.h / 2) / ref.RH, size: w.d.w / own.w }, from: w.d.born, to: w.d.until, hand: w.d.exact, ratio: w.w / w.h, ref: w.d.uid });
    }

    if (!wins.length) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, W, H);
        this.empty = true;
      }
      return;
    }
    this.draw(base, W, H, grid.spb);
    this.tex.needsUpdate = true;
    this.empty = false;
    const ac = r.autoClear;
    r.autoClear = false;
    this.quad.render(r, target);
    r.autoClear = ac;
  }

  private size = { W: 2, H: 2 };
  private now: { part: PopPart; show: number; deal?: Deal } | null = null;

  /** the pop-ups of the part playing as they come up now, to be changed by hand (null: nothing has drawn yet) */
  dealt(): { part: PopPart; pops: DealtPop[] } | null {
    if (!this.now?.deal) return null;
    const { part, show, deal } = this.now;
    const { RW, RH } = refSize(this.size.W, this.size.H);
    const wins = cutTo(deal.wins, deal.hand ? 99 : show);
    return { part, pops: wins.map((d) => ({ id: d.uid, title: d.kind.title, style: d.style, from: d.born, to: d.until, spot: { x: (d.x + d.w / 2) / RW, y: (d.y + d.h / 2) / RH, size: clampTo(POP_SIZE, d.w / kindSize(d.kind, RW, RH).w), dealt: true } })) };
  }

  /** where a window is heading, at the size it's heading for (px) */
  private goalBox(w: Win): PxBox {
    const f = w.g.fitTo;
    return { x: w.g.gx + (w.w * (1 - f)) / 2, y: w.g.gy + (w.h * (1 - f)) / 2, w: w.w * f, h: w.h * f };
  }

  /** the open windows (normalized, where they're heading), so lyrics over one get the halo */
  occupied(): NRect[] {
    const { W, H } = this.size;
    return this.wins.filter((w) => w.closing < 0).map((w) => toRect(this.goalBox(w), W, H));
  }

  /** dev: the windows on screen this frame (normalized boxes), to check they repeat */
  debugList(): { title: string; born: number; until: number; deal: string; x: number; y: number; w: number; h: number; style: number }[] {
    const { W, H } = this.size;
    const { RW, RH } = refSize(W, H);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    // `deal`: the dealt box (exact across sizes of one shape); x, y: where it is now (after keeping clear of the words)
    return this.wins.map((w) => ({ title: w.kind.title, born: r3(w.born), until: r3(w.d.until), deal: `${w.d.x / RW},${w.d.y / RH},${w.d.w / RW},${w.d.h / RH}`, x: r3(w.x / W), y: r3(w.y / H), w: r3(w.w / W), h: r3(w.h / H), style: w.style }));
  }

  /** the part's deal at the reference size W×H (kept while nothing it was dealt from changes) */
  private dealFor(part: PopPart, level: number, base: Omit<FrameContext, 'params'>, W: number, H: number, grid: { spb: number; off: number }): Deal {
    const s = useStudio.getState();
    const set = handSet(part);
    if (set) return this.handDeal(part, set, W, H);
    const hasWords = !!(s.lyrics?.synced && s.lyrics.lines.length) || !!base.text.trim();
    const hasMap = !!base.analysis?.sections.length;
    const lv = Math.max(0, Math.min(3, Math.round(level)));
    const key = `${part.seed}|${part.start.toFixed(3)}|${part.end.toFixed(3)}|${lv}|${W}x${H}|${grid.spb.toFixed(5)}|${grid.off.toFixed(4)}|${+hasWords}${+hasMap}|${popDealsVersion()}`;
    let deal = this.deals.get(key);
    if (deal) {
      // most recently used last
      this.deals.delete(key);
      this.deals.set(key, deal);
      return deal;
    }
    deal = { key, part, hand: false, wins: dealPopups(part, lv, base.analysis, W, H, grid, hasWords, hasMap) };
    this.deals.set(key, deal);
    while (this.deals.size > KEEP_DEALS) this.deals.delete(this.deals.keys().next().value!);
    return deal;
  }

  /** the person's own pop-ups for a part, at the reference size */
  private handDeal(part: PopPart, set: PopSet, W: number, H: number): Deal {
    const key = `hand|${part.start.toFixed(3)}`;
    const memo = `${W}x${H}|${part.end.toFixed(3)}`;
    const had = this.hands.get(key);
    if (had && had.set === set && had.memo === memo) return had.deal;
    const shape = shapeOfFrame(W, H);
    const wins = set.wins.flatMap((w): Dealt[] => {
      const kind = KINDS.find((k) => k.title === w.title);
      const at = spotFor(w.spots, shape);
      const born = Math.max(part.start, w.from);
      const until = Math.min(part.end, w.to);
      if (!kind || !at || until - born < 0.05) return [];
      // the number it bumps by and is known by stays its own, wherever it is in the list
      return [{ id: idOf(w.id), kind, ...boxAt(kind, at.spot, W, H, at.of !== shape), born, until, style: w.style, uid: w.id, exact: at.exact }];
    });
    wins.sort((a, b) => a.born - b.born);
    const deal: Deal = { key, part, wins, hand: true };
    if (this.hands.size > 40) this.hands.clear();
    this.hands.set(key, { set, memo, deal });
    return deal;
  }
  private hands = new Map<string, { set: PopSet; memo: string; deal: Deal }>();

  private draw(base: Omit<FrameContext, 'params'>, W: number, H: number, spb: number) {
    const g = this.ctx;
    const t = base.time;
    const a = base.audio;
    const ink = paperInk(makeInk(base.palette, 0.95));
    const s = Math.min(W, H) / 1080;
    const hl = Math.max(1, Math.round(s * 1.2));
    const sf: SF = { s, hl, lw: 1, ink, labels: true, w: W, h: H };
    const frame = { ...base, width: W, height: H, aspect: W / H, params: {} } as FrameContext;
    const bf: BF = { ...sf, f: frame, a, live: a.playing, idle: false, t, dt: Math.min(0.1, Math.max(0, base.dt)), speed: 1 };
    const sk = `${ink.key}|${W}x${H}`;
    if (sk !== this.sceneKey) {
      this.sceneKey = sk;
      for (const w of this.wins) w.cacheKey = '';
    }
    // kicks bump the windows: from the song map's kicks (so it's the same every time), else as heard
    const kicks = base.analysis?.layers?.kick;
    const ki = kicks ? lastAt(kicks, a.time) : -1;
    const since = ki >= 0 ? a.time - kicks![ki] : 99;
    const amp = since < spb ? Math.exp(-since * 30) : 0;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    for (const w of this.wins) {
      if (kicks) {
        w.bumpX = (hash01(ki * 131 + w.d.id * 7 + 1) - 0.5) * 5 * s * amp;
        w.bumpY = (hash01(ki * 131 + w.d.id * 7 + 2) - 0.5) * 5 * s * amp;
      } else if (a.kickHit) {
        w.bumpX = (hash01(base.frame * 31 + w.d.id * 7 + 1) - 0.5) * 5 * s;
        w.bumpY = (hash01(base.frame * 31 + w.d.id * 7 + 2) - 0.5) * 5 * s;
      } else {
        w.bumpX *= 0.6;
        w.bumpY *= 0.6;
      }
      this.drawWin(g, w, bf, ink, a.time);
    }
  }

  private chrome(w: Win, sf: SF, ink: Ink): { cr: Rect; tb: number } {
    const { s } = sf;
    const tb = Math.round(Math.max(14, 24 * s));
    const pad = Math.round(Math.max(7, 21 * s));
    const key = `${w.w}x${w.h}|${sf.ink.key}|${w.style}`;
    const cr: Rect = { x: pad, y: tb + pad, w: w.w - pad * 2, h: w.h - tb - pad * 2 };
    if (w.cacheKey === key && w.cache) return { cr, tb };
    w.cacheKey = key;
    const shadow = Math.round(Math.max(3, 7 * s));
    const c = w.cache ?? document.createElement('canvas');
    w.cache = c;
    c.width = w.w + shadow;
    c.height = w.h + shadow;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const bw = Math.max(1.5, Math.round(2 * s));
    // hard offset shadow, body, frame
    g.fillStyle = rgba(ink.fg);
    g.fillRect(shadow, shadow, w.w, w.h);
    g.fillStyle = rgba(ink.bg);
    g.fillRect(0, 0, w.w, w.h);
    g.fillStyle = rgba(ink.fg);
    g.fillRect(0, tb - bw, w.w, bw);
    // title bar
    const title = w.kind.title;
    setFont(g, Math.max(8, tb * 0.48), 700, MONO, 0.1);
    g.textBaseline = 'middle';
    const tw = g.measureText(title).width;
    if (w.style === 0) {
      g.fillStyle = rgba(ink.fg, 0.85);
      const n = 5;
      const gap = (tb - bw) / (n + 1);
      for (let k = 1; k <= n; k++) g.fillRect(bw * 2, Math.round(k * gap), w.w - bw * 4, Math.max(1, Math.round(s)));
      g.fillStyle = rgba(ink.bg);
      g.fillRect(w.w / 2 - tw / 2 - tb * 0.4, 0, tw + tb * 0.8, tb - bw);
      g.fillStyle = rgba(ink.fg);
      g.textAlign = 'center';
      g.fillText(title, w.w / 2, (tb - bw) / 2 + 1);
    } else {
      g.fillStyle = rgba(w.style === 1 ? ink.ac : ink.fg);
      g.fillRect(0, 0, w.w, tb - bw);
      g.fillStyle = rgba(ink.bg);
      g.textAlign = 'left';
      g.fillText(`■ ${title}`, tb * 0.4, (tb - bw) / 2 + 1);
    }
    // close box on the right
    const bx = w.w - tb * 0.85;
    const by = tb * 0.2;
    const bs = tb * 0.5;
    g.fillStyle = rgba(ink.bg);
    g.fillRect(bx - 2, by - 2, bs + 4, bs + 4);
    g.strokeStyle = rgba(ink.fg);
    g.lineWidth = Math.max(1, s * 1.2);
    g.strokeRect(bx + 0.5, by + 0.5, bs, bs);
    g.beginPath();
    g.moveTo(bx + bs * 0.25, by + bs * 0.25);
    g.lineTo(bx + bs * 0.75, by + bs * 0.75);
    g.moveTo(bx + bs * 0.75, by + bs * 0.25);
    g.lineTo(bx + bs * 0.25, by + bs * 0.75);
    g.stroke();
    g.strokeStyle = rgba(ink.fg);
    g.lineWidth = bw;
    g.strokeRect(bw / 2, bw / 2, w.w - bw, w.h - bw);
    if (w.mod.drawStatic) {
      g.save();
      w.mod.drawStatic(g, cr, sf);
      g.restore();
    }
    return { cr, tb };
  }

  /** `song`: the song's time, which the opening and closing animations run on */
  private drawWin(g: CanvasRenderingContext2D, w: Win, bf: BF, ink: Ink, song: number) {
    const age = song - w.born;
    let sx = 1;
    let sy = 1;
    if (w.closing >= 0) {
      // snap shut: squash to a line, then pinch to a dot
      const k = (song - w.closing) / OUT_TIME;
      if (k < 0.6) sy = Math.max(0.02, 1 - k / 0.6);
      else {
        sy = 0.02;
        sx = Math.max(0, 1 - (k - 0.6) / 0.4);
      }
    } else {
      const step = Math.floor(age / IN_STEP);
      const v = IN_SCALES[Math.min(IN_SCALES.length - 1, step)];
      sx = sy = v;
    }
    sx *= w.g.fit;
    sy *= w.g.fit;
    if (sx <= 0.001) return;
    const { cr } = this.chrome(w, bf, ink);
    const cx = w.x + w.w / 2 + w.bumpX;
    const cy = w.y + w.h / 2 + w.bumpY;
    g.save();
    g.translate(cx, cy);
    g.scale(sx, sy);
    g.translate(-w.w / 2, -w.h / 2);
    g.drawImage(w.cache!, 0, 0);
    if (w.closing < 0 && age < IN_STEP) {
      // first frame: a solid flash of accent, like a window being stamped on
      g.fillStyle = rgba(ink.ac);
      g.fillRect(0, 0, w.w, w.h);
    } else if (sy > 0.2) {
      g.beginPath();
      g.rect(cr.x, cr.y, cr.w, cr.h);
      g.clip();
      try {
        w.mod.draw(g, cr, bf);
      } catch (e) {
        // a broken instrument just stops drawing its insides (the window still opens and closes on time)
        console.warn('[hum] pop-up failed', e);
        w.mod = { draw: () => {} } as unknown as Module;
      }
    }
    g.restore();
  }

  dispose() {
    this.live.clear();
    this.deals.clear();
    this.tex.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}

/** a window's number from its name (for the dice it bumps by) */
export function idOf(uid: string): number {
  let h = 7;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(h, 31) + uid.charCodeAt(i)) | 0;
  return (h >>> 0) % 1_000_003;
}

/** an instrument's box at the reference size, where a spot puts it */
function boxAt(kind: Kind, spot: Spot, W: number, H: number, inside: boolean): { x: number; y: number; w: number; h: number } {
  const own = kindSize(kind, W, H);
  const k = Math.min(clampTo(POP_SIZE, spot.size), (W * 0.96) / own.w, (H * 0.96) / own.h);
  const w = Math.round(own.w * k);
  const h = Math.round(own.h * k);
  return { ...cornerAt(spot, { w, h }, W, H, inside), w, h };
}

/**
 * Deal a part's pop-ups: windows open on the part's first beats, on its drops and on some bar lines
 * (more on phrase starts), staggered a beat apart, each staying 2 to 4 bars. A full screen retires its
 * oldest window so the newest still lands on the beat. Two sets of dice from the part's seed: one
 * for which bar lines get a window, one for the windows themselves, so a change in one doesn't
 * reshuffle the other.
 */
function dealPopups(part: PopPart, level: number, a: TrackAnalysis | null | undefined, W: number, H: number, grid: { spb: number; off: number }, hasWords: boolean, hasMap: boolean): Dealt[] {
  if (level <= 0) return [];
  const { spb, off } = grid;
  const when = dealer(part.seed ^ 0x9e3779b9);
  const pick = dealer(part.seed ^ 0x85ebca6b);
  const times: number[] = [];
  // a new section of the song (not the very top, which opens on its bars instead)
  if (part.opens) for (let k = 0; k < level; k++) times.push(part.start + k * spb);
  for (const d of dropsIn(a, part.start, part.end)) for (let k = 0; k < Math.min(3, level + 1); k++) times.push(d + k * spb * 0.5);
  for (const b of barsIn(part.start, part.end, spb, off)) {
    const chance = BAR_CHANCE[level] + (b.n % 4 === 0 ? 0.15 * level : 0);
    if (when() < chance) times.push(b.t);
  }
  times.sort((x, y) => x - y);

  const out: Dealt[] = [];
  const m = Math.min(W, H) * 0.04;
  for (const at of times) {
    // too close to the part's end to be worth opening
    if (at < part.start || at > part.end - 0.25) continue;
    const open = out.filter((o) => o.until > at);
    if (open.length >= MAX_OPEN[level]) {
      // full: retire the oldest so the newest still lands on the beat
      open[0].until = at;
      open.shift();
    }
    const openKinds = new Set(open.map((o) => o.kind));
    const pool = KINDS.filter((k) => !openKinds.has(k) && (k.needs !== 'words' || hasWords) && (k.needs !== 'map' || hasMap));
    if (!pool.length) continue;
    // lyric windows come up more often when there are words
    const weighted = pool.flatMap((k) => (k.needs === 'words' ? [k, k] : [k]));
    const kind = weighted[Math.floor(pick() * weighted.length)];
    let { w, h } = kindSize(kind, W, H);
    // together the windows leave the picture and the words their room: the oldest makes way, then this one is smaller
    const most = MOST_COVER[level] * W * H;
    const taken = () => open.reduce((n, o) => n + o.w * o.h, 0);
    while (open.length && taken() + w * h > most) {
      open[0].until = at;
      open.shift();
    }
    const k0 = Math.min(1, Math.max(0.72, Math.sqrt(most / (w * h))));
    w = Math.round(w * k0);
    h = Math.round(h * k0);
    let best: { x: number; y: number; cost: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const x = m + pick() * Math.max(1, W - w - 2 * m);
      const y = m + pick() * Math.max(1, H - h - 2 * m);
      let cost = 0;
      for (const o of open) cost += overlap({ x, y, w, h }, o);
      // keep the middle of the picture mostly clear (the words are dodged when the window shows)
      const cx = (x + w / 2) / W - 0.5;
      const cy = (y + h / 2) / H - 0.5;
      cost += Math.max(0, 0.22 - Math.hypot(cx, cy)) * w * h * 3;
      if (!best || cost < best.cost) best = { x, y, cost };
    }
    const bars = 2 + Math.floor(pick() * 3);
    const style = Math.floor(pick() * 3);
    out.push({ id: out.length, uid: dealtId(part.start, 'p', out.length), exact: false, kind, x: Math.round(best!.x), y: Math.round(best!.y), w, h, born: at, until: Math.min(part.end, at + Math.min(11, Math.max(3, bars * 4 * spb))), style });
  }
  return out;
}
