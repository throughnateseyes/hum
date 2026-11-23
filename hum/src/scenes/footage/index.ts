/**
 * Footage: the person's own video clips as the picture, cut, coloured and sped up to the song.
 *
 * Two ways it plays:
 *
 *   in a video plan   every shot the planner cut is a part of its own (state/flatPlan.ts), so a footage
 *                     part is one shot: one clip and one style arrangement from its start to its end
 *                     (a long part is still cut inside, see src/shot/run.ts). Across the song, every
 *                     cut moves to the next clip and a clip used again carries on where it stopped; a
 *                     part that opens a section on a drop lands with a flash and a few frozen frames;
 *                     a part speeds up into its cut when the next part hits. The run is worked out for
 *                     the whole song at once (footageRun) from the parts and the looks' settings.
 *   on its own        (no plan) each part of the song becomes a short run of shots the scene cuts
 *                     itself (src/shot/sequence.ts, partSequence).
 *
 * The graphics on top are drawn in one of a few styles (src/shot/styles: Caption, Poster, Window,
 * Slab, Grid, Split), placed on the frame's grid; "Auto" picks one per part, and the Arrangement number
 * lays the same style out another way. Colour sets how far the clips are printed in the paper, ink and
 * accent taken from them (src/shot/palette.ts).
 *
 * Clips come from the store (drop videos on the page, or Library → Footage). With none, the look runs
 * on the photos instead, as stills.
 *
 * Players: every picture of this look at one size on one renderer shares one player per clip (the
 * outgoing and incoming look of a transition between two footage parts would otherwise each open the
 * clips again, and the cut would land on nothing while they load). The newer picture steers a shared
 * player. A render has its own renderer, so its own players. Live, a clip follows its speed curve by
 * playback rate; in a frame-by-frame render, prepare() puts it on the exact frame first.
 */
import * as THREE from 'three';
import type { ClipAsset, FrameContext, ParamDef, ParamValues, PhotoAsset, PrepareContext, SceneDef, SceneInit, SceneInstance, TrackAnalysis } from '../../core/types';
import { bool, num, str } from '../../core/uniforms';
import { PRESETS } from '../../presets';
import { Footage } from '../../shot/footage';
import type { Colour } from '../../shot/kit';
import { paletteFromPixels } from '../../shot/palette';
import { footageRun, type Run, type RunPart } from '../../shot/run';
import { footageNeed, partSequence, type PartOptions, type Sequence } from '../../shot/sequence';
import { ShotStage, warmShots, type StageClip } from '../../shot/stage';
import { STYLE_IDS, STYLE_NAMES } from '../../shot/styles';
import { originalOf, parentsOf } from '../../state/planCache';
import { useStudio } from '../../state/store';

const params: ParamDef[] = [
  {
    id: 'style',
    label: 'Style',
    type: 'select',
    default: 'auto',
    hint: 'How the graphics sit on your clips. Auto picks one for each part of the song.',
    options: [{ value: 'auto', label: 'Auto' }, ...STYLE_IDS.map((id) => ({ value: id, label: STYLE_NAMES[id] }))],
  },
  { id: 'seed', label: 'Arrangement', type: 'number', min: 1, max: 999, step: 1, default: 1, hint: 'The same style laid out another way. Every number is a different arrangement.' },
  {
    id: 'colour',
    label: 'Colour',
    type: 'select',
    default: 'tinted',
    hint: 'How far your clips take on the colours of the graphics.',
    options: [
      { value: 'clean', label: 'Clean' },
      { value: 'tinted', label: 'Tinted' },
      { value: 'flat', label: 'Flat' },
    ],
  },
  {
    id: 'pace',
    label: 'Beats per shot',
    type: 'select',
    default: '8',
    hint: 'How long a shot runs before the next cut. In a video, a part is cut inside only when it is longer than one and a half shots.',
    options: [
      { value: '4', label: '4' },
      { value: '8', label: '8' },
      { value: '16', label: '16' },
    ],
  },
  { id: 'words', label: 'Title in type', type: 'bool', default: true },
  { id: 'focusX', label: 'Focus across', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'focusY', label: 'Focus up', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
];

const DEFAULTS: ParamValues = Object.fromEntries(params.map((p) => [p.id, p.default]));

/** looks saved before the styles carried the old settings: read them the nearest new way */
function colourOf(p: ParamValues): Colour {
  const c = str(p, 'colour', '');
  if (c === 'clean' || c === 'tinted' || c === 'flat') return c;
  const old = str(p, 'treat', '');
  return old === 'clean' ? 'clean' : old ? 'flat' : 'tinted';
}

/** the settings that decide a part's shots, from a look's params */
function runPartOf(p: ParamValues): RunPart {
  return { style: str(p, 'style', 'auto'), seed: Math.max(1, Math.round(num(p, 'seed', 1))), colour: colourOf(p), shotBeats: Number(str(p, 'pace', '8')) || 8 };
}
const sigOf = (r: RunPart) => `${r.style}|${r.seed}|${r.colour}|${r.shotBeats}`;

/** how many clips one picture opens players for */
const MAX_OPEN = 6;

/** the song's title, without the artist */
function songTitle(): string {
  const name = useStudio.getState().track?.name ?? '';
  return (name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name).replace(/\.[a-z0-9]{2,4}$/i, '').trim();
}

/** the song's title as words for the type, when no lyrics are being shown (the lyric layer owns those) */
function titleWords(): string[] {
  if (useStudio.getState().lyrics?.lines.length) return [];
  return songTitle()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s_\-–—]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'’!?&]/gu, '').toUpperCase())
    .filter((w) => w.length > 0 && w.length <= 14)
    .slice(0, 4);
}

const stills = new WeakMap<PhotoAsset, StageClip>();
function stillClip(p: PhotoAsset): StageClip {
  const had = stills.get(p);
  if (had) return had;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(p.image, 0, 0, 64, 64);
  const clip = { footage: null, texture: p.texture, aspect: p.width / Math.max(1, p.height), duration: 1e6, palette: paletteFromPixels(g.getImageData(0, 0, 64, 64).data) };
  stills.set(p, clip);
  return clip;
}

/* ───────── players, shared by the pictures on one renderer ───────── */

interface Player {
  footage: Footage;
  ready: boolean;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
}
const players = new WeakMap<THREE.WebGLRenderer, Map<string, Player>>();

/** every pool, so a clip taken out of the store closes its players even when no footage look is on */
const pools = new Set<Map<string, Player>>();
useStudio.subscribe((s, prev) => {
  if (s.clips === prev.clips) return;
  const ids = new Set(s.clips.map((c) => c.id));
  for (const pool of pools)
    for (const [key, p] of pool) {
      if (p.users > 0 || ids.has(key.split('|')[0])) continue;
      p.footage.close();
      pool.delete(key);
    }
});

function lease(renderer: THREE.WebGLRenderer, key: string, url: string): Player {
  let pool = players.get(renderer);
  if (!pool) {
    players.set(renderer, (pool = new Map()));
    pools.add(pool);
  }
  let p = pool.get(key);
  if (!p) {
    const made: Player = { footage: new Footage(), ready: false, users: 0 };
    p = made;
    pool.set(key, made);
    made.footage.load(url).then(
      () => {
        made.ready = true;
      },
      () => {
        if (pool.get(key) === made) pool.delete(key);
      },
    );
  }
  if (p.timer) clearTimeout(p.timer);
  p.timer = undefined;
  p.users++;
  return p;
}

/**
 * Give a player back. It stays open while its clip is in the store: the video cuts away to other looks
 * and back to footage all the time, and a player opened again would land the cut on nothing while it
 * loads. A player nobody holds closes once its clip is removed (or a few seconds after a size change
 * leaves it behind).
 */
function release(renderer: THREE.WebGLRenderer, key: string) {
  const pool = players.get(renderer);
  const p = pool?.get(key);
  if (!pool || !p) return;
  p.users = Math.max(0, p.users - 1);
  // a renderer no footage look has used for half a minute (a finished render, most often) lets go of all of them
  if ([...pool.values()].some((x) => x.users > 0)) return;
  for (const x of pool.values()) {
    if (x.timer) clearTimeout(x.timer);
    x.timer = setTimeout(() => {
      if (x.users > 0) return;
      x.footage.close();
      for (const [k, y] of pool) if (y === x) pool.delete(k);
    }, IDLE_MS);
  }
}

const IDLE_MS = 30000;

/** close the players nobody holds whose clip is gone, or that were opened for another size */
function prune(renderer: THREE.WebGLRenderer, clipIds: Set<string>, size: string) {
  const pool = players.get(renderer);
  if (!pool) return;
  for (const [key, p] of pool) {
    if (p.users > 0 || p.timer) continue;
    const [id, , sz] = key.split('|');
    if (clipIds.has(id) && sz === size) continue;
    p.timer = setTimeout(() => {
      if (p.users > 0 || pool.get(key) !== p) return;
      p.footage.close();
      pool.delete(key);
    }, clipIds.has(id) ? 5000 : 0);
  }
}

/* ───────── the run across a video plan, worked out once per song and settings ───────── */

interface Flat {
  run: Run;
  key: string;
  /** each part's settings (null: not footage), and the look-level signature of each */
  parts: (RunPart | null)[];
  sigs: (string | null)[];
}
const runs = new WeakMap<TrackAnalysis, { key: string; flat: Flat }>();

/** a per-part choice of style or arrangement the Part panel may keep (store.partShot), laid over the look's */
type PartShot = { style?: string; seed?: number } | null;

/**
 * The parts' settings when a video plan with one look per part plays this song cut (null otherwise):
 * for each part, its look's settings (the preset with the person's tweaks) when the look is footage.
 */
function flatParts(a: TrackAnalysis): { parts: (RunPart | null)[]; sigs: (string | null)[] } | null {
  const s = useStudio.getState();
  const plan = s.plan;
  if (!s.planOn || !plan?.flat || plan.looks.length !== a.sections.length) return null;
  const per = (s as unknown as { partShot?: PartShot[] | null }).partShot ?? null;
  const all = [...s.customPresets, ...PRESETS];
  const sigs: (string | null)[] = [];
  const parts = plan.looks.map((id, i) => {
    const p = id ? all.find((x) => x.id === id) : undefined;
    if (!p || p.sceneId !== 'footage') {
      sigs.push(null);
      return null;
    }
    const look = runPartOf({ ...DEFAULTS, ...(p.sceneParams ?? {}), ...(s.tweaks[p.id]?.sceneParams ?? {}) });
    sigs.push(sigOf(look));
    const own = per?.[i];
    return own ? { ...look, ...(own.style ? { style: own.style } : {}), ...(own.seed ? { seed: Math.max(1, Math.round(own.seed)) } : {}) } : look;
  });
  return { parts, sigs };
}

function flatRun(a: TrackAnalysis, deck: StageClip[], words: string[]): Flat | null {
  const fp = flatParts(a);
  if (!fp) return null;
  const durations = deck.map((c) => Math.round(c.duration * 100) / 100);
  const key = `${fp.parts.map((p) => (p ? sigOf(p) : '-')).join(',')}|${durations.join(',')}|${words.join(' ')}`;
  const had = runs.get(a);
  if (had?.key === key) return had.flat;
  const orig = originalOf(a);
  const run = footageRun({ analysis: a, sections: orig.sections, parents: parentsOf(a), parts: fp.parts, clips: durations, words });
  const flat = { run, key, parts: fp.parts, sigs: fp.sigs };
  runs.set(a, { key, flat });
  return flat;
}

/* ───────── dev: what each footage part shows, for scripted checks ───────── */

interface Shown {
  part: number;
  clip: number;
  from: number;
  style: string;
  arrive: string;
  leave: string;
  shots: number;
  alt: number | null;
  /** (builds only) the last shot's clip and the second of it the part ends on, where the clip's player
   *  stood when the part was built, the build's cost (ms) and which picture built it */
  lastClip?: number;
  to?: number;
  playerAt?: number | null;
  ms?: number;
  who?: number;
}
const shown: Shown[] = [];
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__humFootage = {
    /** what the run says the footage part at song time t shows (null: not footage, or no plan) */
    at(t: number): Shown | null {
      const s = useStudio.getState();
      const a = s.analysis;
      if (!a) return null;
      const got = runs.get(a)?.flat;
      const i = a.sections.findIndex((x) => t < x.end);
      const seq = got?.run.seqs[i];
      if (!seq) return null;
      const shot = seq.shots.find((x) => t < x.end) ?? seq.shots[seq.shots.length - 1];
      const n = Math.max(1, s.clips.length || s.photos.length || 1);
      return { part: i, clip: shot.footageIndex % Math.min(n, MAX_OPEN), from: shot.clipFrom ?? 0, style: shot.style, arrive: shot.arrive, leave: shot.leave, shots: seq.shots.length, alt: shot.alt === undefined ? null : shot.alt % Math.min(n, MAX_OPEN) };
    },
    /** every part this page's stage built, in order (cleared by the caller) */
    shown,
  };
}

/* ───────── the look ───────── */

let born = 0;

class FootageLook implements SceneInstance {
  private readonly renderer: THREE.WebGLRenderer;
  private width: number;
  private height: number;
  private stage: ShotStage;
  private readonly who = ++born;
  /** the players this picture holds, by pool key */
  private readonly held = new Map<string, Player>();
  private deck: StageClip[] = [];
  private echo: (StageClip | null)[] = [];
  private deckKey = '';
  /** what the stage was last built for */
  private builtKey = '';
  /** the run being played (a video plan), and the part this picture shows */
  private flat: Flat | null = null;
  private part = -1;
  /** song time prepare() last put the clips on (a render), or null */
  private preparedFor: number | null = null;
  private readonly focus = { x: 0.5, y: 0.55 };

  constructor(init: SceneInit) {
    this.renderer = init.renderer;
    this.width = init.width;
    this.height = init.height;
    this.stage = new ShotStage(init.renderer, init.width, init.height);
    this.stage.who = this.who;
  }

  private poolKey(id: string, echo: boolean) {
    return `${id}|${echo ? 'echo' : 'main'}|${this.width}x${this.height}`;
  }

  /** The clips to cut between: the person's videos once their players are ready, else the photos as stills */
  private syncDeck(clips: ClipAsset[], photos: PhotoAsset[]) {
    const wanted = clips.slice(0, MAX_OPEN);
    // with one clip, Split shows two moments of it: a second player on it
    const keys = new Map<string, string>();
    for (const c of wanted) keys.set(this.poolKey(c.id, false), c.url);
    if (wanted.length === 1) keys.set(this.poolKey(wanted[0].id, true), wanted[0].url);
    let changed = false;
    for (const [k, url] of keys) {
      if (this.held.has(k)) continue;
      this.held.set(k, lease(this.renderer, k, url));
      changed = true;
    }
    for (const k of [...this.held.keys()]) {
      if (keys.has(k)) continue;
      release(this.renderer, k);
      this.held.delete(k);
      changed = true;
    }
    if (changed) prune(this.renderer, new Set(clips.map((c) => c.id)), `${this.width}x${this.height}`);
    const asClip = (c: ClipAsset, p: Player): StageClip => ({ footage: p.footage, texture: p.footage.texture, aspect: p.footage.aspect, duration: p.footage.duration, palette: c.palette });
    const ready = wanted.filter((c) => this.held.get(this.poolKey(c.id, false))?.ready);
    const allReady = ready.length === wanted.length && wanted.length > 0;
    const echoReady = wanted.length === 1 && !!this.held.get(this.poolKey(wanted[0].id, true))?.ready;
    const key = ready.length ? `c:${ready.map((c) => c.id).join(',')}${echoReady ? '+e' : ''}` : `p:${photos.map((p) => p.id).join(',')}`;
    if (key === this.deckKey) return;
    // a clip that is still opening doesn't change the deck until the others are ready too (or it fails)
    if (ready.length && !allReady && this.deckKey.startsWith('c:')) return;
    this.deckKey = key;
    if (ready.length) {
      this.deck = ready.map((c) => asClip(c, this.held.get(this.poolKey(c.id, false))!));
      this.echo = this.deck.map((_, i) => (i === 0 && echoReady ? asClip(ready[0], this.held.get(this.poolKey(ready[0].id, true))!) : null));
    } else {
      this.deck = photos.slice(0, MAX_OPEN).map(stillClip);
      this.echo = this.deck.map((c) => c);
    }
    this.builtKey = '';
  }

  /**
   * The part this picture shows at song time t. Normally the part playing; but in a transition between
   * two footage parts, the outgoing look keeps showing its own part after the cut and the incoming one
   * shows its part from just before it. Each knows its part by its settings (the planner's footage looks
   * differ in colour and pace; two parts with the same look don't transition at all).
   */
  private pick(a: TrackAnalysis, flat: Flat, sig: string, t: number): number {
    const secs = a.sections;
    let i = secs.findIndex((s) => t < s.end);
    if (i < 0) i = secs.length - 1;
    if (flat.sigs[i] === sig) return i;
    if (flat.sigs[i + 1] === sig && secs[i + 1].start - t < 1.5) return i + 1;
    if (i > 0 && flat.sigs[i - 1] === sig && t - secs[i - 1].end < 3) return i - 1;
    return i;
  }

  /** (Re)build the shots when the song moves to another part, or the settings or clips change */
  private sync(a: TrackAnalysis | null, p: ParamValues, photos: PhotoAsset[], t: number): boolean {
    if (!a?.sections.length) return false;
    this.syncDeck(useStudio.getState().clips, photos);
    if (!this.deck.length) return false;
    const words = bool(p, 'words', true) ? titleWords() : [];
    const title = songTitle().toUpperCase();
    const flat = flatRun(a, this.deck, words);
    const own = runPartOf(p);
    let seq: Sequence | null = null;
    let index: number;
    if (flat) {
      index = this.pick(a, flat, sigOf(own), t);
      seq = flat.run.seqs[index];
    } else {
      index = a.sections.findIndex((s) => t < s.end);
      if (index < 0) index = a.sections.length - 1;
    }
    this.flat = flat;
    this.part = index;
    const size = `${this.width}x${this.height}`;
    const key = flat ? `f|${flat.key}|${index}|${title}|${this.deckKey}|${size}` : `${a.duration}|${a.sections.length}|${index}|${sigOf(own)}|${words.join(' ')}|${title}|${this.deckKey}|${size}`;
    // the first footage look on this renderer compiles every shader the shots use, once
    warmShots(this.renderer, a, this.deck[0]);
    if (key !== this.builtKey) {
      if (!flat) {
        const o: PartOptions = { ...own, words, card: words.length > 0 };
        seq = partSequence(a, index, o);
      }
      // a part of a video plan that isn't footage (this look is on its way out or in): its neighbour's shots
      if (!seq) return this.builtKey !== '';
      this.builtKey = key;
      const t0 = performance.now();
      this.stage.build({ seq, analysis: a, clips: this.deck, echo: (i) => this.echo[i] ?? null, title, lookId: '', tellStore: false, live: true });
      if (import.meta.env.DEV && flat) {
        const sh = seq.shots[0];
        const last = seq.shots[seq.shots.length - 1];
        const c = sh.footageIndex % this.deck.length;
        shown.push({
          part: index,
          clip: c,
          from: sh.clipFrom ?? 0,
          style: sh.style,
          arrive: sh.arrive,
          leave: sh.leave,
          shots: seq.shots.length,
          alt: sh.alt === undefined ? null : sh.alt % this.deck.length,
          lastClip: last.footageIndex % this.deck.length,
          to: (last.clipFrom ?? 0) + footageNeed(seq, last) * (last.clipRate ?? 1),
          playerAt: this.deck[c]?.footage?.video.currentTime ?? null,
          ms: performance.now() - t0,
          who: this.who,
        });
        if (shown.length > 400) shown.splice(0, shown.length - 400);
      }
    }
    this.focus.x = num(p, 'focusX', 0.5);
    this.focus.y = num(p, 'focusY', 0.55);
    return true;
  }

  /** have the next footage part's clip waiting on its first frame, when it is another clip; returns its player */
  private cueNext(t: number): Footage | null {
    const flat = this.flat;
    if (!flat || this.part < 0) return null;
    const now = flat.run.seqs[this.part]?.shots;
    const inUse = new Set<number>();
    for (const s of now ?? []) {
      inUse.add(s.footageIndex % this.deck.length);
      if (s.alt !== undefined && !s.altEcho) inUse.add(s.alt % this.deck.length);
    }
    for (let j = this.part + 1; j < flat.run.seqs.length; j++) {
      const next = flat.run.seqs[j];
      if (!next) continue;
      if (next.start - t > 2.5) return null;
      const first = next.shots[0];
      const c = first.footageIndex % this.deck.length;
      const f = this.deck[c]?.footage ?? null;
      if (inUse.has(c) || !f) return null;
      f.follow(first.clipFrom ?? 0, 0, false, this.who);
      return f;
    }
    return null;
  }

  render(ctx: FrameContext, target: THREE.WebGLRenderTarget) {
    const t = ctx.audio.time;
    if (!this.sync(ctx.analysis, ctx.params, ctx.photos, t)) return;
    // a render has already put the clips on this exact frame; live, they follow their speed curves
    if (this.preparedFor === null || Math.abs(this.preparedFor - t) > 1e-3) {
      this.stage.follow(t, ctx.audio.playing);
      const busy = this.stage.steering(t);
      const cued = this.cueNext(t);
      if (cued) busy.add(cued);
      // the clips off screen stop where they are, so the next shot on them carries on from there
      for (const p of this.held.values()) if (!busy.has(p.footage)) p.footage.rest(this.who);
    }
    this.stage.draw(t, this.focus, target);
  }

  async prepare(songTime: number, frame: PrepareContext) {
    this.preparedFor = songTime;
    // a render's first frames arrive before the players have opened: start them and wait
    this.syncDeck(useStudio.getState().clips, frame.photos);
    const waiting = [...this.held.values()].filter((e) => !e.ready).map((e) => e.footage.whenLoaded);
    if (waiting.length) {
      await Promise.allSettled(waiting);
      this.syncDeck(useStudio.getState().clips, frame.photos);
    }
    if (!this.sync(frame.analysis, frame.params, frame.photos, songTime)) return;
    await this.stage.settle(songTime);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    for (const k of this.held.keys()) release(this.renderer, k);
    this.held.clear();
    this.deckKey = '';
    this.width = width;
    this.height = height;
    this.stage.dispose();
    this.stage.release();
    this.stage = new ShotStage(this.renderer, width, height);
    this.stage.who = this.who;
    this.builtKey = '';
  }

  dispose() {
    this.stage.dispose();
    this.stage.release();
    for (const k of this.held.keys()) release(this.renderer, k);
    this.held.clear();
  }
}

export const footage: SceneDef = {
  id: 'footage',
  name: 'Footage',
  description: 'Your own video clips as the picture: cut on the beat, sped up into every cut, with bold shapes and type set on a grid over them.',
  category: 'photo',
  style: 'photo',
  tags: ['footage', 'video', 'photo', 'cinematic', 'personal', 'graphic', 'editorial'],
  params,
  usesClips: true,
  // the hand-drawn finish redraws the whole picture in a few inks: footage shows clean until a finish is picked
  prefersClean: true,
  create: (init) => new FootageLook(init),
};

export const scenes: SceneDef[] = [footage];
