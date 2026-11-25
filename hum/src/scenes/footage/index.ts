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
 * The pictures (the deck) are the person's clips and photos together, in the order they were added
 * (drop them on the page, or Library → Footage and Photos). A photo is a still: the shot gives it
 * motion (a slow push and drift along the speed curve, the punch on a hit). With no media at all, the
 * built-in placeholder photo. A treatment breaks the picture itself down under the style (Mosh, Sort,
 * Cells, Readout, Collage, Trace; src/shot/treatments). Motion says what a video clip does in time
 * (Play, Stutter, Echo, Reverse, Slices; src/shot/motion.ts); a photo ignores it.
 *
 * Per part (store.partShot over the plan's own shots, one entry per part of the flattened plan) a part can have its own style,
 * arrangement, treatment, motion, pictures (ids of clips and photos: the first is the picture; Split's
 * second panel, Collage's fragments and Trace's tiles take the rest) and framing (focusX, focusY,
 * zoom), each laid over the look's own setting. With no video plan, store.soloShot does the same for
 * every part the look cuts itself.
 *
 * Players: every picture of this look at one size on one renderer shares one player per clip (the
 * outgoing and incoming look of a transition between two footage parts would otherwise each open the
 * clips again, and the cut would land on nothing while they load). The newer picture steers a shared
 * player. A render has its own renderer, so its own players. Live, a clip follows its speed curve by
 * playback rate; in a frame-by-frame render, prepare() puts it on the exact frame first.
 */
import { curvesFor } from '../../director/feeling';
import * as THREE from 'three';
import type { ClipAsset, FrameContext, ParamDef, ParamValues, PartShot, PhotoAsset, PrepareContext, SceneDef, SceneInit, SceneInstance, TrackAnalysis } from '../../core/types';
import { audioEngine } from '../../audio/engine';
import { bool, num, str } from '../../core/uniforms';
import { Footage } from '../../shot/footage';
import { MOTION_HINT, MOTION_IDS, MOTION_NAMES } from '../../shot/motion';
import { paletteFromPixels } from '../../shot/palette';
import { shotOfPart } from '../../shot/partShots';
import { MAX_OPEN, MAX_STILLS, addedAt, footageRun, planParts, runPartOf, sigOf, withOwn, type Run, type RunPart } from '../../shot/run';
import { footageNeed, partSequence, planFootage, type PartOptions, type Sequence } from '../../shot/sequence';
import { SLOW, slowMotion } from '../../shot/slowmo';
import { ShotStage, warmShots, type StageClip } from '../../shot/stage';
import { anchorsOf, grabStill, type Anchor } from '../../shot/stills';
import { drawnWith, offIn } from '../../shot/graphics';
import { graphicInks, inksKey } from '../../state/inks';
import { songCredit } from '../../state/songName';
import { MAX_LETTERS } from '../../shot/type';
import { INSIDE_PALETTES, insidePalette } from '../../inside/palettes';
import { wordsIn } from '../../inside/lines';
import { formIn } from '../../state/forms';
import { drawnIn } from '../../inside/cast';
import { drawnKey } from '../../inside/drawnIds';
import { readingHeld, readingOf } from '../../inside/readings';
import { STYLE_IDS, STYLE_NAMES } from '../../shot/styles';
import { TREATMENT_IDS, TREATMENT_NAMES, type TreatmentId } from '../../shot/treatments';
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
    id: 'treatment',
    label: 'Treatment',
    type: 'select',
    default: 'none',
    hint: 'How the picture itself is broken down: melted (Mosh), sorted into streaks (Sort), rebuilt in characters (Cells), read like a scan (Readout), cut up with your other pictures (Collage) or pinned up with them as a tracking board, lines traced between them (Trace). Auto picks one for each part.',
    options: [{ value: 'auto', label: 'Auto' }, ...TREATMENT_IDS.map((id) => ({ value: id, label: TREATMENT_NAMES[id] }))],
  },
  {
    id: 'motion',
    label: 'Motion',
    type: 'select',
    default: 'play',
    hint: MOTION_HINT,
    options: MOTION_IDS.map((id) => ({ value: id, label: MOTION_NAMES[id] })),
  },
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
    id: 'paint',
    label: 'Inside colours',
    type: 'select',
    default: 'auto',
    hint: 'The colours the Inside style paints your clips in. Auto uses the video’s.',
    options: [{ value: 'auto', label: 'Auto' }, ...INSIDE_PALETTES.map((p) => ({ value: p.id, label: p.name }))],
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

/** the run's key for a part: its settings and its own pictures */
const partKey = (r: RunPart) => `${sigOf(r)}${r.media?.length ? `#${r.media.join('.')}` : ''}${r.from === undefined ? '' : `@${r.from}`}${r.hit ? `!${r.hit.clip}:${r.hit.on}:${r.hit.ramp}` : ''}${r.moment ? `~${r.moment}` : ''}${r.say ? `"${r.say}` : ''}${r.drawn ? `&${r.drawn.id}.${drawnKey(r.drawn)}` : ''}${r.pin ? `^${r.pin.part}.${r.pin.shot}` : ''}`;

/**
 * Where a part is centred and how far it is pushed in: its own framing (`own`: partShot[i] in a video
 * plan, soloShot for the look on its own), else the look's focus point
 */
function framingOf(own: PartShot | null, p: ParamValues): { x: number; y: number; zoom: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: clamp(own?.focusX ?? num(p, 'focusX', 0.5), 0, 1),
    y: clamp(own?.focusY ?? num(p, 'focusY', 0.55), 0, 1),
    zoom: clamp(own?.zoom ?? 1, 1, 3),
  };
}

/** the footage shot that ends where part i starts (a moshed cut carries on from it), if there is one */
function beforeOf(flat: Flat, i: number): { start: number; end: number; layout: number; treatment: TreatmentId } | undefined {
  const prev = flat.run.seqs[i - 1];
  const now = flat.run.seqs[i];
  if (!prev || !now || Math.abs(prev.end - now.start) > 0.05) return undefined;
  const last = prev.shots[prev.shots.length - 1];
  return { start: last.start, end: last.end, layout: last.layout, treatment: last.treatment ?? 'none' };
}

/** the song's title as a line of type holds it: whole words up to MAX_LETTERS, '' when the person keeps it off */
export function songTitle(): string {
  const s = useStudio.getState();
  if (s.songName?.hidden) return '';
  const { title } = songCredit(s);
  if (title.length <= MAX_LETTERS) return title;
  const cut = title.slice(0, MAX_LETTERS + 1);
  return cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s&,(\-–—]+$/, '') : title.slice(0, MAX_LETTERS);
}

/** the colours of the video's inside shots: the look's own pick, the plan's, or one that goes with the song */
function paintNow(p: ParamValues, a: TrackAnalysis) {
  const own = str(p, 'paint', 'auto');
  const plan = useStudio.getState().plan?.paint;
  return insidePalette(own !== 'auto' ? own : plan, Math.round(a.duration * 10));
}

/** what decides which words an inside shot has: the shots are made again when it changes */
let lastWords: unknown[] = [];
let wordsRound = 0;
function wordsKey(): number {
  const s = useStudio.getState();
  const now = [s.lyrics, s.lyricStyle, s.partWords, s.plan?.lyricPlan];
  if (now.some((x, i) => x !== lastWords[i])) {
    lastWords = now;
    wordsRound++;
  }
  return wordsRound;
}

/** the song's title as words for the type, when no lyrics are being shown (the lyric layer owns those) */
/** `always`: in a song with lyrics too (the Inside shot a video opens on) */
export function titleWords(always = false): string[] {
  if (!always && useStudio.getState().lyrics?.lines.length) return [];
  const s = useStudio.getState();
  return (s.songName?.hidden ? '' : songCredit(s).title)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s_\-–—]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'’!?&]/gu, '').toUpperCase())
    .filter((w) => w.length > 0 && w.length <= 14)
    .slice(0, 4);
}

/** a photo as a picture of the deck: a still with its own palette, brightness bands and anchors, kept by photo id */
const stills = new Map<string, { photo: PhotoAsset; clip: StageClip }>();
export function stillClip(p: PhotoAsset): StageClip {
  const had = stills.get(p.id);
  if (had?.photo === p) return had.clip;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(p.image, 0, 0, 64, 64);
  const clip: StageClip = {
    footage: null,
    texture: p.texture,
    aspect: p.width / Math.max(1, p.height),
    duration: 1e6,
    palette: paletteFromPixels(g.getImageData(0, 0, 64, 64).data),
    anchors: anchorsOf(p.image, p.width, p.height),
    name: p.name,
    reading: readingOf(p),
  };
  stills.set(p.id, { photo: p, clip });
  // photos taken out of the store let go of their entry
  if (stills.size > 64) for (const k of [...stills.keys()].slice(0, stills.size - 64)) stills.delete(k);
  return clip;
}

/**
 * A clip's still for the treatments that lay several pictures out (Collage, Trace): its library
 * thumbnail at once, then a full-size frame of it with its anchors once that is grabbed. Kept by clip id.
 */
interface ClipStill {
  thumb: THREE.Texture | null;
  full: THREE.Texture | null;
  anchors: Anchor[] | undefined;
  /** settles once the full-size frame is in (or could not be had) */
  ready: Promise<void>;
}
const clipStills = new Map<string, ClipStill>();
function clipStill(c: ClipAsset): ClipStill {
  const had = clipStills.get(c.id);
  if (had) return had;
  const entry: ClipStill = { thumb: null, full: null, anchors: undefined, ready: Promise.resolve() };
  clipStills.set(c.id, entry);
  if (c.thumb) {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      entry.thumb = t;
      entry.anchors ??= anchorsOf(img, img.naturalWidth, img.naturalHeight);
    };
    img.src = c.thumb;
  }
  entry.ready = grabStill(c.url).then(
    (got) => {
      entry.full = got.texture;
      entry.anchors = got.anchors;
    },
    () => undefined,
  );
  return entry;
}


/** a part's own choices: the director's, with the person's over them (src/shot/partShots.ts) */
const partShotAt = (i: number): PartShot | null => shotOfPart(i);

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

function lease(renderer: THREE.WebGLRenderer, key: string, url: string, file: Blob): Player {
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
    made.footage.load(url, file).then(
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

function flatRun(a: TrackAnalysis, deck: StageClip[], deckIds: string[], words: string[]): Flat | null {
  const fp = planParts(a, deckIds);
  if (!fp) return null;
  const durations = deck.map((c) => Math.round(c.duration * 100) / 100);
  const s = useStudio.getState();
  const feel = curvesFor(s.plan, a, s.lyrics);
  const key = `${feel?.id ?? 0}|${fp.parts.map((p) => (p ? partKey(p) : '-')).join(',')}|${durations.join(',')}|${deckIds.join(',')}|${words.join(' ')}`;
  const had = runs.get(a);
  if (had?.key === key) return had.flat;
  const orig = originalOf(a);
  const run = footageRun({ analysis: a, sections: orig.sections, parents: parentsOf(a), parts: fp.parts, clips: durations, words, feel });
  const flat = { run, key, parts: fp.parts, sigs: fp.sigs };
  runs.set(a, { key, flat });
  return flat;
}

/* ───────── depth, read ahead of the inside shots that need it ───────── */

/** the seconds of its clip each inside shot of a run shows, in order */
export function insideRanges(seq: Sequence): { clip: number; range: [number, number] }[] {
  return seq.shots.flatMap((shot) => {
    if (shot.style !== 'inside') return [];
    const from = shot.clipFrom ?? 0;
    return [{ clip: shot.footageIndex, range: [Math.max(0, from - 0.1), from + footageNeed(seq, shot) * (shot.clipRate ?? 1) + 0.3] as [number, number] }];
  });
}

let reading: Flat | null = null;
/** read what the video's inside shots need, the ones coming up first; stops when the video changes */
function readAhead(flat: Flat, deck: StageClip[], t: number) {
  if (reading === flat) return;
  reading = flat;
  const seqs = flat.run.seqs.filter((s): s is Sequence => !!s);
  const order = [...seqs.filter((s) => s.end > t), ...seqs.filter((s) => s.end <= t)];
  void (async () => {
    for (const seq of order)
      for (const { clip, range } of insideRanges(seq)) {
        if (reading !== flat) return;
        // (a video being made reads its own first, when nobody is watching this one)
        // (and so does a render)
        while ((useStudio.getState().planning && !audioEngine.playing) || readingHeld()) await new Promise((r) => setTimeout(r, 500));
        await deck[clip % deck.length]?.reading?.need([range]);
      }
  })();
}

/* ───────── dev: what each footage part shows, for scripted checks ───────── */

interface Shown {
  part: number;
  clip: number;
  from: number;
  style: string;
  treatment: string;
  motion: string;
  arrive: string;
  leave: string;
  shots: number;
  alt: number | null;
  /** the frame's push-in and focus the part was drawn with */
  zoom?: number;
  focus?: [number, number];
  /** (builds only) the last shot's clip and the second of it the part ends on, where the clip's player
   *  stood when the part was built, the build's cost (ms) and which picture built it */
  lastClip?: number;
  to?: number;
  playerAt?: number | null;
  ms?: number;
  who?: number;
}
const shown: Shown[] = [];
/** how many pictures the newest look's deck holds (for the dev readout) */
let deckSize = 0;
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
      const n = Math.max(1, deckSize);
      return { part: i, clip: shot.footageIndex % n, from: shot.clipFrom ?? 0, style: shot.style, treatment: shot.treatment ?? 'none', motion: shot.motion ?? 'play', arrive: shot.arrive, leave: shot.leave, shots: seq.shots.length, alt: shot.alt === undefined ? null : shot.alt % n };
    },
    /** every part this page's stage built, in order (cleared by the caller) */
    shown,
  };
}

/* ───────── the look ───────── */

// Smooth slow motion, as the Video tab has it
slowMotion.on = useStudio.getState().smoothSlow;
useStudio.subscribe((s) => {
  slowMotion.on = s.smoothSlow;
});

let born = 0;
/** whether each part opens on a clip running slowly, worked out once */
const slowOpenings = new WeakMap<Sequence, boolean>();

class FootageLook implements SceneInstance {
  private readonly renderer: THREE.WebGLRenderer;
  private width: number;
  private height: number;
  private stage: ShotStage;
  private readonly who = ++born;
  /** the players this picture holds, by pool key */
  private readonly held = new Map<string, Player>();
  private deck: StageClip[] = [];
  /** the clip or photo id of each picture in the deck */
  private deckIds: string[] = [];
  private echo: (StageClip | null)[] = [];
  private deckKey = '';
  /** what the stage was last built for */
  private builtKey = '';
  /** the run being played (a video plan), and the part this picture shows */
  private flat: Flat | null = null;
  private part = -1;
  /** song time prepare() last put the clips on (a render), or null */
  private preparedFor: number | null = null;
  /** the shots whose depth a render has waited for */
  private depthFor = '';
  private gone = false;
  private readonly focus = { x: 0.5, y: 0.55 };
  private zoom = 1;

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

  /**
   * The pictures to cut between: the person's clips (once their players are ready) and photos, in the
   * order they were added; with neither, the built-in placeholder photo.
   */
  private syncDeck(clips: ClipAsset[], photos: PhotoAsset[]) {
    // the deck's order is the order of deckIdsOf (src/shot/run.ts), with the clips still opening left out
    const wanted = clips.slice(0, MAX_OPEN);
    // with one clip, Split shows two moments of it: a second player on it
    const keys = new Map<string, ClipAsset>();
    for (const c of wanted) keys.set(this.poolKey(c.id, false), c);
    if (wanted.length === 1) keys.set(this.poolKey(wanted[0].id, true), wanted[0]);
    let changed = false;
    for (const [k, c] of keys) {
      if (this.held.has(k)) continue;
      this.held.set(k, lease(this.renderer, k, c.url, c.file));
      changed = true;
    }
    for (const k of [...this.held.keys()]) {
      if (keys.has(k)) continue;
      release(this.renderer, k);
      this.held.delete(k);
      changed = true;
    }
    if (changed) prune(this.renderer, new Set(clips.map((c) => c.id)), `${this.width}x${this.height}`);
    const asClip = (c: ClipAsset, p: Player): StageClip => ({ footage: p.footage, texture: p.footage.texture, aspect: p.footage.aspect, duration: p.footage.duration, palette: c.palette, name: c.name, reading: readingOf(c) });
    const ready = wanted.filter((c) => this.held.get(this.poolKey(c.id, false))?.ready);
    const allReady = ready.length === wanted.length;
    const echoReady = wanted.length === 1 && !!this.held.get(this.poolKey(wanted[0].id, true))?.ready;
    // the person's own photos (the placeholder only stands in when there is nothing else)
    const own = photos.filter((p) => !p.builtin).slice(0, MAX_STILLS);
    type Item = { id: string; clip?: ClipAsset; photo?: PhotoAsset };
    let items: Item[] = [...ready.map((c) => ({ id: c.id, clip: c })), ...own.map((p) => ({ id: p.id, photo: p }))];
    items.sort((x, y) => addedAt(x.id) - addedAt(y.id));
    if (!items.length) items = photos.slice(0, 1).map((p) => ({ id: p.id, photo: p }));
    const key = `${items.map((x) => x.id).join(',')}${echoReady ? '+e' : ''}`;
    if (key === this.deckKey) return;
    // a clip that is still opening doesn't change the deck until the others are ready too (or it fails)
    if (!allReady && this.deckKey && ready.length) return;
    this.deckKey = key;
    this.deck = items.map((x) => {
      if (!x.clip) return stillClip(x.photo!);
      const st = clipStill(x.clip);
      return { ...asClip(x.clip, this.held.get(this.poolKey(x.id, false))!), still: st.full ?? st.thumb, anchors: st.anchors };
    });
    this.deckIds = items.map((x) => x.id);
    // with one clip, Split shows two moments of it; a still has no other moment: Split pushes in on it instead
    this.echo = items.map((x) => (x.clip && echoReady && x.clip.id === wanted[0].id ? asClip(x.clip, this.held.get(this.poolKey(x.id, true))!) : null));
    deckSize = this.deck.length;
    this.builtKey = '';
  }

  /** the deck's clips' stills arrive after the deck is made (the thumbnail, then the full frame): pick them up */
  private syncThumbs(clips: ClipAsset[]) {
    this.deck.forEach((d, i) => {
      if (!d.footage) return;
      const c = clips.find((x) => x.id === this.deckIds[i]);
      if (!c) return;
      const st = clipStill(c);
      d.still = st.full ?? st.thumb;
      d.anchors = st.anchors;
    });
  }

  /** a render waits for the full-size stills of the deck's clips, so it cuts the same frames every time */
  private async stillsReady(clips: ClipAsset[]) {
    const ids = new Set(this.deckIds);
    await Promise.all(clips.filter((c) => ids.has(c.id)).map((c) => clipStill(c).ready));
    this.syncThumbs(clips);
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
    const clips = useStudio.getState().clips;
    this.syncDeck(clips, photos);
    if (!this.deck.length) return false;
    this.syncThumbs(clips);
    const words = bool(p, 'words', true) ? titleWords() : [];
    const title = songTitle().toUpperCase();
    const flat = flatRun(a, this.deck, this.deckIds, words);
    const own = runPartOf(p);
    // a look playing on its own (no video plan) takes the Look tab's choices for every part it cuts
    const solo = flat ? null : useStudio.getState().soloShot;
    const mine = withOwn(own, solo, this.deckIds);
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
    const paint = paintNow(p, a).id;
    const say = `${wordsKey()}|${inksKey(t)}`;
    const off = offIn(flat ? shotOfPart(index) : solo, useStudio.getState().graphicsOff);
    const key = flat ? `f|${flat.key}|${off.join(' ')}|${index}|${title}|${this.deckKey}|${size}|${paint}|${say}` : `${a.duration}|${a.sections.length}|${off.join(' ')}|${index}|${partKey(mine)}|${words.join(' ')}|${title}|${this.deckKey}|${size}|${paint}|${say}`;
    // the first footage look on this renderer compiles every shader the shots use, once
    warmShots(this.renderer, a, this.deck[0]);
    if (key !== this.builtKey) {
      if (!flat) {
        const o: PartOptions = { ...mine, words, card: words.length > 0, pictures: this.deck.length };
        seq = partSequence(a, index, o);
      }
      // a part of a video plan that isn't footage (this look is on its way out or in): its neighbour's shots
      if (!seq) return this.builtKey !== '';
      this.builtKey = key;
      seq = drawnWith(seq, off);
      const { partStart } = seq;
      const t0 = performance.now();
      this.stage.build({ seq, analysis: a, clips: this.deck, echo: (i) => this.echo[i] ?? null, title, lookId: '', tellStore: false, live: true, before: flat ? beforeOf(flat, index) : undefined, inks: (pal, at) => graphicInks(at, pal), inside: { palette: paintNow(p, a), words: (shot) => wordsIn(shot, bool(p, 'words', true) ? titleWords(true) : [], Math.abs(shot.start - partStart) < 0.05), drawn: drawnIn, form: (shot, clip) => formIn(shot, a, this.deckIds[this.deck.indexOf(clip)] ?? null) } });
      for (const { clip, range } of this.stage.insideNeeds()) void clip.reading?.need([range]);
      if (import.meta.env.DEV) {
        const sh = seq.shots[0];
        const last = seq.shots[seq.shots.length - 1];
        const c = sh.footageIndex % this.deck.length;
        shown.push({
          part: index,
          clip: c,
          from: sh.clipFrom ?? 0,
          style: sh.style,
          treatment: sh.treatment ?? 'none',
          motion: sh.motion ?? 'play',
          arrive: sh.arrive,
          leave: sh.leave,
          shots: seq.shots.length,
          alt: sh.alt === undefined ? null : sh.alt % this.deck.length,
          lastClip: last.footageIndex % this.deck.length,
          to: (last.clipFrom ?? 0) + footageNeed(seq, last) * (last.clipRate ?? 1),
          playerAt: this.deck[c]?.footage?.video.currentTime ?? null,
          ms: performance.now() - t0,
          who: this.who,
          zoom: framingOf(flat ? partShotAt(index) : solo, p).zoom,
          focus: [framingOf(flat ? partShotAt(index) : solo, p).x, framingOf(flat ? partShotAt(index) : solo, p).y],
        });
        if (shown.length > 400) shown.splice(0, shown.length - 400);
      }
    }
    // the part's own framing (or the look's on its own), when it has one; else the look's focus point
    const fr = framingOf(flat ? partShotAt(index) : solo, p);
    this.focus.x = fr.x;
    this.focus.y = fr.y;
    this.zoom = fr.zoom;
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
      this.stage.cue(f, first.clipFrom ?? 0, this.opensSlowly(next));
      return f;
    }
    return null;
  }

  /** does a part open on a clip running slowly? (its player then waits with the frame after it ready too) */
  private opensSlowly(seq: Sequence): boolean {
    let slow = slowOpenings.get(seq);
    if (slow === undefined) {
      const first = seq.shots[0];
      const curve = planFootage(
        seq,
        this.deck.map((c) => c.duration),
      )[0];
      slow = first.kind === 'footage' && (first.motion ?? 'play') === 'play' && !curve.freeze && curve.rate(first.start) < SLOW;
      slowOpenings.set(seq, slow);
    }
    return slow;
  }

  render(ctx: FrameContext, target: THREE.WebGLRenderTarget) {
    const t = ctx.audio.time;
    if (!this.sync(ctx.analysis, ctx.params, ctx.photos, t)) return;
    // a render has already put the clips on this exact frame; live, they follow their speed curves
    if (this.preparedFor === null || Math.abs(this.preparedFor - t) > 1e-3) {
      this.stage.follow(t, ctx.audio.playing);
      if (this.flat) readAhead(this.flat, this.deck, t);
      const busy = this.stage.steering(t);
      const cued = this.cueNext(t);
      if (cued) busy.add(cued);
      // the clips off screen stop where they are, so the next shot on them carries on from there
      for (const p of this.held.values()) if (!busy.has(p.footage)) p.footage.rest(this.who);
    }
    this.stage.draw(t, this.focus, target, this.zoom);
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
    // the clips are asked for frame by frame from here on
    for (const p of this.held.values()) if (p.ready) p.footage.byFrame();
    if (!this.sync(frame.analysis, frame.params, frame.photos, songTime)) return;
    await this.stillsReady(useStudio.getState().clips);
    // the depth was read before the render began; what it could not know of (auto-pilot cutting here) is read now
    if (this.depthFor !== this.builtKey) {
      this.depthFor = this.builtKey;
      await frame.hold(this.stage.readInside());
    }
    if (this.gone) return;
    await this.stage.settle(songTime);
  }

  shown() {
    return this.deck.length ? this.stage.shown() : null;
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
    this.gone = true;
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
