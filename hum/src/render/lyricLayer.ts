import * as THREE from 'three';
import type { AudioFrame, LyricLine, Palette, TrackAnalysis } from '../core/types';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { useStudio, type LyricStyle } from '../state/store';
import { getScene } from '../scenes';
import { buildCutout, cutoutMoving, drawCutout, type CutoutLayout } from './cutout';
import { FAMILY_FONTS, dropMoment, drawLine, layoutLine, moving, treatmentFor, voiceFor, type Box, type Inks, type Role, type Treatment, type TypeLayout } from './lyricAuto';
import { hostFor, type HostLine } from './lyricHosts';
import { COVER, FrameProbe, Guard, NEAR_BLACK, NEAR_WHITE, NO_KEEP_OUT, accentOr, applyShadow, badShare, coverNow, coveredL, coveredShare, css, drawBacking, drawHalo, hexRGB, inksFor, judge, lumOf, regionStats, type Backing, type KeepOut, type RGB, type Rect, type RegionStats } from './legibility';
import { ladderFor, profileFor, type LyricProfile, type Zone } from './lyricProfiles';
import { chooseForLine, lyricPlanNow, seeded, setLyricNow, type LyricChoice, type LyricMoment } from '../state/lyricPlan';
import { FACES, LYRIC_FAMILIES, ensureLyricFont, lyricFontVersion } from './lyricFonts';

/**
 * Timed lyrics drawn over the finished frame, so they are in recordings and stills too.
 * Text is laid out on a 2D canvas (redrawn only while something moves) and composited with one
 * blended quad. The type itself (voices, layout, reveals) is in lyricAuto.ts.
 *
 *   subtitle: a quiet caption low in the frame; each word brightens with a wipe as it's sung
 *   big:      a display line hung from a margin or a third; words rise out of a mask as they're sung
 *   cutout:   a paste-up collage, one printed scrap per word (cutout.ts). Rare: a one-off on a drop,
 *             or when picked in the chip
 *   auto:     a lyric video. Each part of the song gets its own medium from the lyric plan
 *             (state/lyricPlan.ts): captions in verses, display lines in choruses and drops, an aside
 *             in a margin in builds, the look's own lyric components where it has them, plus one-off
 *             moments (a giant word on the drop, a collage). Type family and motion stay the same for
 *             the whole song; placement goes where the picture is calm.
 *   world:    on scenes that host the line (lyricHosts.ts: a neon sign in Night Windows, words
 *             floating on Still Water) the display lines become part of the picture.
 *
 * Placement: lyrics only ever sit in the middle or the lower third of the frame, in every style,
 * every frame shape and every video plan (spots(); nothing starts above SAFE_TOP). Tall frames keep
 * clear of the bottom band where Reels and TikTok put their own captions.
 *
 * Timing (showings()): every line stays up long enough to read (READ_BASE + READ_PER_WORD a word),
 * and its last word stays up a moment after it's sung. Lines that come too fast to read on their
 * own are shown together; when a line still has to make way, it fades out over the next one
 * instead of blinking out. Every word is drawn before its line leaves.
 *
 * Every style is guarded (legibility.ts): the frame under the text is sampled every few frames (after
 * scene windows and pop-ups are drawn, so it's what the words really sit on) and the ink and backing
 * (shadow, soft scrim, halo, full-width scrim, paper strip) are eased to whatever clears the contrast
 * target there. Words over a pop-up window (or a very busy picture) always get the halo, a fuzzy
 * palette-coloured glow round the words, so the overlap reads as meant.
 *
 * Pop-ups and windows keep clear of the words: prepare() lays the line out before they draw and
 * keepOut() hands them its box (and where the next line will likely land), so they open elsewhere
 * and glide out of the way when a line arrives under them (popups.ts, sceneWindows.ts).
 *
 * Lines a scene hosts get no scrim: the layer reads the picture
 * under them and the host answers in its own terms (lyricHosts.ts). Display,
 * collage and auto lyrics stand down on looks that show the words themselves (scenes with
 * `showsLyrics`) unless the user picks "Show anyway".
 */

const FONT = LYRIC_FAMILIES.grotesk;
/** nothing is placed above this share of the frame height: the top stays clear */
const SAFE_TOP = 0.34;
/** a line that has to make way fades out over the next one for this long (s) */
const HANDOVER = 0.35;
/** read time: base + per word (s), and never less than READ_MIN */
const READ_BASE = 0.6;
const READ_PER_WORD = 0.28;
const READ_MIN = 1.4;
/** a line's last word stays up at least this long after it starts (s) */
const TAIL = 0.75;
/** lines merged into one showing never go over this many words (or three lines) */
const MAX_SHOWN_WORDS = 14;
const FADE_IN = 0.14;
const FADE_OUT = 0.3;
/** show the next line slightly early so the eye arrives with the voice */
const LEAD = 0.08;

type Drawn = 'subtitle' | 'big' | 'cutout' | 'sparse' | 'own' | 'world';

interface Word {
  text: string;
  t: number;
  end: number;
}

/** word timings: real ones when the lyrics have them, otherwise spread across the line by length */
function wordsOf(line: LyricLine): Word[] {
  if (line.words?.length) return line.words;
  const parts = line.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, w) => a + w.length + 1, 0);
  const span = Math.max(0.4, (line.end - line.t) * 0.82);
  let acc = 0;
  return parts.map((text) => {
    const t = line.t + (acc / total) * span;
    acc += text.length + 1;
    return { text, t, end: line.t + (acc / total) * span };
  });
}

/** how long a line of n words needs on screen to be read */
export const readTime = (n: number) => Math.max(READ_MIN, READ_BASE + READ_PER_WORD * n);

/** what is on screen at once: one lyric line, or a few quick ones together, with display times */
export interface Showing {
  /** first and last lyric line (indices into the lines) */
  first: number;
  last: number;
  /** on screen from t to end (end includes the read time; the fade-out comes after) */
  t: number;
  end: number;
  text: string;
  words: Word[];
  timed: boolean;
}

const shownCache = new WeakMap<LyricLine[], Showing[]>();

/**
 * Turn timed lines into what's shown: each line stays up for its read time and a moment after its
 * last word; lines that start before the one before could be read join it (up to three lines /
 * MAX_SHOWN_WORDS), so nothing flashes by. If a showing still has to leave early for the next one,
 * its late words are pulled in so every word is drawn before it goes.
 */
export function showings(lines: LyricLine[]): Showing[] {
  const hit = shownCache.get(lines);
  if (hit) return hit;
  const out: Showing[] = [];
  let k = 0;
  while (k < lines.length) {
    const first = k;
    let words = wordsOf(lines[k]).map((w) => ({ ...w }));
    let timed = !!lines[k].words?.length;
    let last = k;
    while (last + 1 < lines.length && last - first < 2 && words.length) {
      const nx = lines[last + 1];
      const upFor = nx.t - lines[first].t;
      const tailFor = nx.t - words[words.length - 1].t;
      if (upFor >= readTime(words.length) && tailFor >= TAIL) break;
      const nw = wordsOf(nx);
      if (words.length + nw.length > MAX_SHOWN_WORDS) break;
      words = words.concat(nw.map((w) => ({ ...w })));
      timed = timed && !!nx.words?.length;
      last++;
    }
    k = last + 1;
    if (!words.length) continue;
    const t = lines[first].t;
    const next = lines[last + 1]?.t ?? Infinity;
    const lastW = words[words.length - 1];
    const want = Math.max(lines[last].end, lastW.end + 0.25, lastW.t + TAIL, t + readTime(words.length));
    const end = Math.min(want, next);
    // every word is drawn before the showing goes: if it must leave early, pull its late words in
    const latest = end - 0.35;
    const w0 = Math.min(words[0].t, latest);
    if (lastW.t > latest && latest > t) {
      const f = (latest - w0) / Math.max(1e-3, lastW.t - w0);
      for (const w of words) {
        if (w.t > w0) w.t = w0 + (w.t - w0) * f;
        w.end = Math.min(end, Math.max(w.t + 0.05, w0 + (w.end - w0) * f));
      }
    }
    out.push({ first, last, t, end, text: words.map((w) => w.text).join(' '), words, timed });
  }
  shownCache.set(lines, out);
  return out;
}

/** index of the last showing that has started by time t (-1 before the first) */
function showingAt(shows: Showing[], t: number): number {
  let lo = 0;
  let hi = shows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (shows[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const STOP = new Set('a an and are as at be but by for from had has have he her his i if in into is it its me my no not of on or our she so that the their them then there they this to too up us was we were what when where who will with you your oh ooh yeah la na da'.split(' '));
/** the words that carry a line: held long, not filler */
function keyWords(words: Word[], n: number): Word[] {
  const scored = words
    .map((w, i) => {
      const bare = w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
      return { w, i, s: (STOP.has(bare) ? -2 : 0) + Math.min(1.5, (w.end - w.t) * 1.6) + Math.min(1, bare.length / 7) };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .sort((a, b) => a.i - b.i);
  return scored.map((x) => x.w);
}

/** a place a medium can sit: a normalized box, which edge the text hangs from, how it's anchored */
interface Spot {
  r: Rect;
  align: 'left' | 'center' | 'right';
  anchor: 'bottom' | 'center';
}

/**
 * Where each medium can sit, as shares of the frame. Type hangs from the margins and the thirds
 * rather than sitting centred in a box: display lines on the left or right margin, the lower-third
 * left, asides in a corner, captions low and centred. Nothing starts above SAFE_TOP, whatever zone a
 * look or a plan asks for (a look's calm "top" falls through to its next zone). Tall frames (9:16)
 * keep everything above the bottom ~24%, where Reels and TikTok put their captions and buttons, and
 * inside a 7% side margin.
 */
function spots(portrait: boolean): Record<Exclude<Drawn, 'own' | 'world'>, Partial<Record<Zone, Spot>>> {
  if (portrait) {
    return {
      subtitle: { bottom: { r: { x0: 0.08, y0: 0.6, x1: 0.92, y1: 0.755 }, align: 'center', anchor: 'bottom' } },
      big: {
        left: { r: { x0: 0.07, y0: 0.4, x1: 0.93, y1: 0.73 }, align: 'left', anchor: 'bottom' },
        bottom: { r: { x0: 0.07, y0: 0.44, x1: 0.93, y1: 0.75 }, align: 'left', anchor: 'bottom' },
        right: { r: { x0: 0.07, y0: 0.4, x1: 0.93, y1: 0.73 }, align: 'right', anchor: 'bottom' },
        middle: { r: { x0: 0.08, y0: 0.38, x1: 0.92, y1: 0.66 }, align: 'center', anchor: 'center' },
      },
      cutout: {
        middle: { r: { x0: 0.06, y0: 0.4, x1: 0.94, y1: 0.7 }, align: 'center', anchor: 'bottom' },
        bottom: { r: { x0: 0.06, y0: 0.44, x1: 0.94, y1: 0.75 }, align: 'left', anchor: 'bottom' },
      },
      sparse: {
        left: { r: { x0: 0.07, y0: 0.56, x1: 0.72, y1: 0.74 }, align: 'left', anchor: 'bottom' },
        right: { r: { x0: 0.28, y0: 0.56, x1: 0.93, y1: 0.74 }, align: 'right', anchor: 'bottom' },
        bottom: { r: { x0: 0.16, y0: 0.6, x1: 0.84, y1: 0.745 }, align: 'center', anchor: 'bottom' },
        middle: { r: { x0: 0.18, y0: 0.44, x1: 0.82, y1: 0.6 }, align: 'center', anchor: 'center' },
      },
    };
  }
  return {
    subtitle: { bottom: { r: { x0: 0.12, y0: 0.72, x1: 0.88, y1: 0.9 }, align: 'center', anchor: 'bottom' } },
    big: {
      left: { r: { x0: 0.075, y0: 0.4, x1: 0.62, y1: 0.8 }, align: 'left', anchor: 'bottom' },
      bottom: { r: { x0: 0.075, y0: 0.5, x1: 0.78, y1: 0.86 }, align: 'left', anchor: 'bottom' },
      right: { r: { x0: 0.38, y0: 0.4, x1: 0.925, y1: 0.8 }, align: 'right', anchor: 'bottom' },
      middle: { r: { x0: 0.14, y0: 0.38, x1: 0.86, y1: 0.72 }, align: 'center', anchor: 'center' },
    },
    cutout: {
      middle: { r: { x0: 0.08, y0: 0.4, x1: 0.92, y1: 0.78 }, align: 'center', anchor: 'bottom' },
      bottom: { r: { x0: 0.075, y0: 0.5, x1: 0.8, y1: 0.88 }, align: 'left', anchor: 'bottom' },
    },
    sparse: {
      left: { r: { x0: 0.075, y0: 0.6, x1: 0.44, y1: 0.86 }, align: 'left', anchor: 'bottom' },
      right: { r: { x0: 0.56, y0: 0.6, x1: 0.925, y1: 0.86 }, align: 'right', anchor: 'bottom' },
      bottom: { r: { x0: 0.25, y0: 0.72, x1: 0.75, y1: 0.88 }, align: 'center', anchor: 'bottom' },
      middle: { r: { x0: 0.28, y0: 0.44, x1: 0.72, y1: 0.62 }, align: 'center', anchor: 'center' },
    },
  };
}
/** the giant moment hangs from the left or right margin, with more room */
const giantSpot = (portrait: boolean, right: boolean): Spot =>
  portrait
    ? { r: { x0: 0.07, y0: 0.38, x1: 0.93, y1: 0.74 }, align: right ? 'right' : 'left', anchor: 'bottom' }
    : { r: { x0: 0.07, y0: 0.36, x1: 0.93, y1: 0.84 }, align: right ? 'right' : 'left', anchor: 'bottom' };

/** clamp a box below SAFE_TOP (a guard: every box above already is) */
const safe = (r: Rect): Rect => (r.y0 >= SAFE_TOP ? r : { ...r, y0: SAFE_TOP, y1: Math.max(r.y1, SAFE_TOP + 0.2) });

interface LineState {
  key: string;
  /** which lines are on screen (a new group means a new showing, not just a re-layout) */
  group?: string;
  i: number;
  medium: Drawn;
  moment: LyricMoment | null;
  choice: LyricChoice | null;
  zone: Zone;
  type?: TypeLayout;
  cut?: CutoutLayout;
  host?: HostLine;
  hostName?: string;
  /** normalized box around the text, probed for legibility */
  rect: Rect;
  ladder: Backing[];
  target: number;
  inks: 'look' | 'light' | 'dark';
  /** stats of the picture under the text (last probe) */
  stats: RegionStats | null;
  why: string;
}

const px = (r0: Rect, W: number, H: number): Box => {
  const r = safe(r0);
  return { x0: r.x0 * W, y0: r.y0 * H, x1: r.x1 * W, y1: r.y1 * H };
};

function rectOf(boxes: { x: number; y: number; w: number; h: number }[], W: number, H: number, pad = 0.01): Rect | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x0: Math.max(0, x0 / W - pad), y0: Math.max(0, y0 / H - pad), x1: Math.min(1, x1 / W + pad), y1: Math.min(1, y1 / H + pad) };
}

/** a line this much covered by pop-up windows sits ON them: it gets the halo */
const OVER_WINDOW = 0.05;
/** a picture this busy under the line (mean neighbour difference) gets the halo instead of a soft scrim */
const BUSY_EDGE = 0.085;

export interface LyricOpts {
  lines: LyricLine[];
  t: number;
  style: LyricStyle;
  palette: Palette;
  width: number;
  height: number;
  audio: AudioFrame;
  dt?: number;
}

/** what both prepare() and render() work out about a frame */
interface FrameFacts {
  t: number;
  shows: Showing[];
  i: number;
  cur: { i: number; line: Showing } | null;
  W: number;
  H: number;
  look: LyricProfile;
  carries: boolean;
}

const LABEL: Record<string, string> = { intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };

export class LyricLayer {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex = new THREE.CanvasTexture(this.canvas);
  private mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
  private quad = createFullscreenQuad(this.mat);
  private lastKey = '';
  private empty = true;
  private line: LineState | null = null;
  private guard = new Guard();
  private probed = -1;
  /** a hosted line's own light-touch guard: how much help the picture under it asks for, eased */
  private hostNeed = 0;
  private hostNeedTo = 0;
  private clock = 0;
  private devClock = 0;
  /** fades the line out when a shot cuts to a look that shows the words itself */
  private standDown = 0;
  /** look + scene the guard last saw, to notice cuts */
  private lookKey = '';
  /** the accent passes the same per-pixel contrast test as the ink (else the giant word uses the ink) */
  private accentOK = false;
  /** the line that just made way, fading out over the new one (a copy of its last frame) */
  private ghost = document.createElement('canvas');
  private ghostOn = false;
  private ghostFrom = 0;
  private ghostA = 0;
  /** how opaque the line on screen was when last drawn */
  private lastAlpha = 0;
  /** pop-up windows on screen this frame (normalized boxes, where they're heading) */
  private occluders: Rect[] = [];
  /** where the words are, for the windows (see keepOut) */
  private keep: KeepOut = NO_KEEP_OUT;
  private lastRect: Rect | null = null;

  /** the picture under the lyrics, shrunk and read back every few frames */
  readonly probe = new FrameProbe();

  constructor() {
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
  }

  /**
   * Look at the frame the lyrics will go over: called by the stage after the picture, scene windows
   * and pop-ups are drawn and before the lyrics, with the texture they were drawn into...
   */
  sample(r: THREE.WebGLRenderer, tex: THREE.Texture, blit: (t: THREE.Texture, target: THREE.WebGLRenderTarget | null) => void) {
    this.probe.sample(r, tex, blit);
  }

  /** ...or, when they were drawn straight to the screen, from the screen (w×h drawing buffer) */
  sampleScreen(r: THREE.WebGLRenderer, w: number, h: number) {
    this.probe.sampleScreen(r, w, h);
  }

  /** the pop-up windows on screen this frame (normalized boxes), so a line over one gets the halo */
  setOccluders(rects: Rect[]) {
    this.occluders = rects;
  }

  /** where the words are (and the next line will likely be), for windows to keep clear of; see prepare() */
  keepOut(): KeepOut {
    return this.keep;
  }

  private facts(o: LyricOpts): FrameFacts {
    const t = o.t + LEAD;
    const st = useStudio.getState();
    const shows = showings(o.lines);
    const i = showingAt(shows, t);
    const cur = i >= 0 && t < shows[i].end + FADE_OUT ? { i, line: shows[i] } : null;
    const scale = Math.min(1, 1600 / Math.max(o.width, 1));
    const W = Math.max(2, Math.round(o.width * scale));
    const H = Math.max(2, Math.round(o.height * scale));
    const scene = getScene(st.sceneId);
    const show = st.lyricsOnBoards === 'show';
    const look = profileFor(st.presetId, scene?.category, !!scene?.showsLyrics);
    return { t, shows, i, cur, W, H, look, carries: look.own === 'carries' && !show };
  }

  /**
   * Lay out the line due now (once per showing) before anything else draws this frame, and note its
   * box: pop-ups and scene windows read keepOut() to open elsewhere and glide out of its way.
   */
  prepare(o: LyricOpts) {
    if (o.style === 'off' || !o.lines.length) {
      this.keep = NO_KEEP_OUT;
      return;
    }
    const f = this.facts(o);
    if (f.cur) this.ensureLine(f, o);
    const L = this.line;
    const now = f.cur && L && L.medium !== 'own' && this.standDown < 0.5 ? L.rect : null;
    if (now) this.lastRect = now;
    // the next showing, once it's close: lines in a part mostly come back to the same place
    const nx = f.shows[f.cur ? f.cur.i + 1 : f.i + 1];
    const next = nx && nx.t - f.t < 2 && this.lastRect ? this.lastRect : null;
    this.keep = { now, next };
  }

  /** the line for this showing, laid out (a new showing hands the old one over as a fading ghost) */
  private ensureLine(f: FrameFacts, o: LyricOpts) {
    const { W, H, t } = f;
    const line = f.cur!.line;
    const st = useStudio.getState();
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      // the GL texture was allocated at the old size and won't take a bigger upload: start a new one
      this.tex.dispose();
      this.lastKey = '';
      this.ghostOn = false;
    }
    const words = line.words;
    const group = `${line.first}-${line.last}|${line.text}`;
    // a cut to or from a scene that hosts the line lays it out again (as part of the new picture)
    const hostKey = hostFor(st.sceneId) ? st.sceneId : '-';
    const key = `${o.style}|${group}|${W}x${H}|${st.lyricFont}|${hostKey}|${lyricFontVersion()}`;
    if (this.line?.key !== key) {
      // the next line arrived while this one was still up: fade it out over the new one
      const prev = this.line;
      if (prev && (prev.group !== group || prev.medium === 'world' || hostKey !== '-') && !this.empty && this.lastAlpha > 0.2 && this.ghost.width === W && this.ghost.height === H) {
        const gg = this.ghost.getContext('2d')!;
        gg.clearRect(0, 0, W, H);
        gg.drawImage(this.canvas, 0, 0);
        this.ghostOn = true;
        this.ghostFrom = t;
        this.ghostA = 1;
      } else if (!prev || prev.group !== group) this.ghostOn = false;
      if (this.ghost.width !== W || this.ghost.height !== H) {
        this.ghost.width = W;
        this.ghost.height = H;
      }
      this.line = this.plan(key, line.first, o.lines, words, line.timed, o.style, f.look, f.carries, W, H, o.palette, st.analysis, st.sceneId);
      this.line.group = group;
      this.standDown = 0;
    }
  }

  /** draw the lyrics for time t over whatever is on the screen */
  render(r: THREE.WebGLRenderer, o: LyricOpts, target: THREE.WebGLRenderTarget | null = null) {
    if (o.style === 'off' || !o.lines.length) return;
    // the dev harness steps song time faster than real time: it passes its step and runs on its own clock
    const now = o.dt !== undefined ? (this.devClock += o.dt) : performance.now() / 1000;
    const dt = o.dt ?? Math.min(0.1, Math.max(0, now - (this.clock || now)));
    this.clock = now;
    const st = useStudio.getState();
    const f = this.facts(o);
    const { t, cur, W, H, carries } = f;

    if (!cur) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.empty = true;
        this.lastKey = '';
      }
      this.line = null;
      this.ghostOn = false;
      if (o.style === 'auto') this.report(null, st.analysis);
      return;
    }
    this.ensureLine(f, o);
    const line = cur.line;
    const words = line.words;
    const key = this.line!.key;
    const L = this.line!;
    const guarded = L.medium !== 'own' && L.medium !== 'cutout' && L.medium !== 'world';

    // a cut to a look that shows the words itself mid-line: fade out rather than fight it
    // (Auto hands every medium to the look; the fixed Subtitles style keeps its subtitles).
    const hideNow = (carries && L.medium !== 'own' && (o.style === 'auto' || L.medium !== 'subtitle'));
    this.standDown += ((hideNow ? 1 : 0) - this.standDown) * Math.min(1, dt * 8);

    // a cut under the line: the picture changed at once, so the guard may follow at once
    const lookNow = `${st.presetId}|${st.sceneId}`;
    if (lookNow !== this.lookKey) {
      this.lookKey = lookNow;
      this.guard.jolt(now);
    }
    // legibility: re-judge the box whenever a new probe arrives, ease toward it every frame
    if (guarded && this.probe.version > 0 && this.probe.version !== this.probed) {
      this.probed = this.probe.version;
      L.stats = regionStats(this.probe, L.rect);
      const v = judge(this.probe, L.rect, { inks: this.inkList(L.inks, o.palette, L.stats), target: L.target, ladder: this.ladderNow(L, L.stats), pal: o.palette });
      // while the line is still fading in nobody can see a jump, so take the new verdict outright
      // (shots often cut on the very line start, so the first probe may still show the last look)
      if (t - line.t < FADE_IN + 0.12) this.guard.reset(v);
      else this.guard.propose(v, now);
      this.accentOK = this.accentReads(L, o.palette);
    }
    this.guard.step(dt, now);
    // a hosted line skips the scrims but still reads the picture under it: the host answers in its
    // own world's terms (a darker wall behind a neon sign, a soft dark in the water)
    if (L.host) {
      if (this.probe.version > 0 && this.probe.version !== this.probed) {
        this.probed = this.probe.version;
        L.stats = regionStats(this.probe, L.rect);
        this.hostNeedTo = Math.max(0, Math.min(1, L.host.need(L.stats)));
        if (t - line.t < FADE_IN + 0.12) this.hostNeed = this.hostNeedTo;
      }
      this.hostNeed += (this.hostNeedTo - this.hostNeed) * Math.min(1, dt * 3);
    }
    if (o.style === 'auto') this.report(L, st.analysis);

    const fadeOut = Math.max(0, (t - line.end) / FADE_OUT);
    const alpha = Math.min(1, (t - line.t) / FADE_IN, 1 - fadeOut) * (1 - this.standDown);
    // the line that made way: fades and lifts a touch while the new one comes in
    if (this.ghostOn && (t < this.ghostFrom - 0.05 || t - this.ghostFrom > HANDOVER)) this.ghostOn = false;
    const gk = this.ghostOn ? 1 - (t - this.ghostFrom) / HANDOVER : 0;
    const ghostA = this.ghostOn ? Math.max(0, this.ghostA * gk * gk) : 0;
    const sung = words.filter((w) => w.t <= t).length;
    const an = st.analysis;
    const drop = dropMoment(an, o.t, o.audio);
    const live = L.type ? moving(L.type, t, drop) : L.cut ? cutoutMoving(L.cut, t) : L.host ? L.host.moving(t) : false;
    // redraw at 60 fps only while something moves (or fades); a still line keeps its last drawing
    const tick = live || ghostA > 0.01 || fadeOut > 0 ? Math.floor(t * 60) : -1;
    const drawKey = `${key}|${tick}|${sung}|${Math.round(alpha * 40)}|${this.guard.key()}|${this.accentOK}|${o.palette.fg}${o.palette.accent}${o.palette.bg}`;
    if (drawKey !== this.lastKey) {
      this.lastKey = drawKey;
      const g = this.ctx;
      g.clearRect(0, 0, W, H);
      if (ghostA > 0.01) {
        g.globalAlpha = ghostA;
        g.drawImage(this.ghost, 0, -H * 0.012 * (1 - gk));
        g.globalAlpha = 1;
      }
      this.lastAlpha = L.medium === 'own' ? 0 : alpha;
      if (alpha > 0.01 && L.medium !== 'own') {
        g.save();
        // quick soft exit: the line lifts a little as it fades
        if (fadeOut > 0) g.translate(0, -fadeOut * H * 0.012);
        if (L.cut) drawCutout(g, L.cut, L.moment === 'burst' ? t + 0.04 : t, Math.max(0, alpha));
        else if (L.host) L.host.draw(g, t, Math.max(0, alpha), o.audio, this.hostNeed);
        else if (L.type) {
          const rows = L.type.role === 'caption' ? L.type.rows : rowsUp(L.type, t);
          drawBacking(g, rows, this.guard, L.type.size, W, alpha, L.i + 1);
          if (this.guard.mix.halo > 0.02) drawHalo(g, haloSpans(L.type, t), this.guard, L.type.size, W, alpha);
          drawLine(g, L.type, t, Math.max(0, alpha), this.inks(o.palette, L), o.audio, drop);
        }
        g.restore();
      }
      this.tex.needsUpdate = true;
      this.empty = false;
    }
    const ac = r.autoClear;
    r.autoClear = false;
    this.quad.render(r, target);
    r.autoClear = ac;
  }

  private inkList(pref: LineState['inks'], pal: Palette, st: RegionStats | null): RGB[] {
    if (pref === 'light') return [NEAR_WHITE, NEAR_BLACK];
    if (pref === 'dark') return [NEAR_BLACK, NEAR_WHITE];
    return inksFor(pal, st ?? undefined);
  }

  /**
   * The backings the guard may use for this line right now: words that sit on a pop-up window always
   * get the halo (a designed overlap, never letters lost behind a window), and a very busy picture
   * gets the halo where the look would use a soft scrim.
   */
  private ladderNow(L: LineState, st: RegionStats): Backing[] {
    if (coveredShare(L.rect, this.occluders) > OVER_WINDOW) return ['halo', ...L.ladder.filter((b) => b === 'band' || b === 'paper')];
    if (st.edge >= BUSY_EDGE) {
      if (L.ladder.includes('soft')) return L.ladder.map((b) => (b === 'soft' ? 'halo' : b));
      const k = L.ladder.findIndex((b) => b === 'band' || b === 'paper');
      return k < 0 ? [...L.ladder, 'halo'] : [...L.ladder.slice(0, k), 'halo', ...L.ladder.slice(k)];
    }
    return L.ladder;
  }

  /** does the accent read over the box, with the backing the guard is heading for? */
  private accentReads(L: LineState, pal: Palette): boolean {
    if (this.probe.version <= 0) return false;
    const gd = this.guard;
    const cover = Math.max(0.1, COVER[gd.backing]);
    const st = L.stats ?? regionStats(this.probe, L.rect);
    return badShare(this.probe, L.rect, lumOf(hexRGB(pal.accent)), gd.plate, cover, L.target, st.edge) <= 0.08;
  }

  private inks(pal: Palette, L: LineState): Inks {
    const gd = this.guard;
    const bgL = L.stats ? coveredL(L.stats, gd) : 0.5;
    return {
      ink: css(gd.ink),
      accent: this.accentOK ? css(accentOr(hexRGB(pal.accent), gd.ink, bgL)) : css(gd.ink),
      accent2: css(accentOr(hexRGB(pal.accent2), gd.plate, bgL, 1.5)),
      shadow: (g, size) => applyShadow(g, gd, size, 1),
    };
  }

  /** decide how line `li` is shown: medium, place, type; lay it out once */
  private plan(key: string, li: number, lines: LyricLine[], words: Word[], timed: boolean, style: LyricStyle, look: LyricProfile, carries: boolean, W: number, H: number, pal: Palette, an: TrackAnalysis | null, sceneId: string): LineState {
    const g = this.ctx;
    let medium: Drawn;
    let moment: LyricMoment | null = null;
    let choice: LyricChoice | null = null;
    let why = '';
    if (style === 'auto' && an) {
      const s = useStudio.getState();
      const plan = lyricPlanNow({ analysis: an, lyrics: s.lyrics, plan: s.plan, planOn: s.planOn });
      choice = plan ? chooseForLine(plan, an, lines, li, look, !carries) : null;
      medium = choice?.medium ?? 'subtitle';
      moment = choice?.moment ?? null;
      why = choice?.why ?? '';
      // moments bring their own medium: the giant word is display type, the burst is a collage
      if (moment === 'giant' && medium !== 'own') medium = 'big';
      if (moment === 'burst' && medium !== 'own') medium = 'cutout';
    } else {
      medium = style === 'auto' ? 'big' : style === 'big' ? 'big' : style === 'cutout' ? 'cutout' : 'subtitle';
      if (medium !== 'subtitle' && carries) medium = 'own';
    }
    void timed;
    const R = seeded(choice?.seed ?? li * 7919 + 1);
    const portrait = H > W * 1.2;
    const unit = Math.min(W, H);
    const base: LineState = { key, i: li, medium, moment, choice, zone: 'middle', rect: { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.6 }, ladder: ladderFor(look), target: 3, inks: look.ink, stats: null, why };
    if (medium === 'own') return base;

    // the font picked in the lyrics panel wins; on Auto, the song's family (Claude's plan or the local one)
    const picked = useStudio.getState().lyricFont;
    const fam = picked !== 'auto' ? picked : style === 'auto' ? choice?.family : undefined;
    const tr: Treatment = choice?.motion ?? treatmentFor(an).id;

    const host = hostFor(sceneId);
    // words inside the world: a scene that can host the line takes it (on Auto, all but dense
    // caption lines, which need to stay plain to be read; on Big words, every line)
    const wps = words.length / Math.max(0.5, (words[words.length - 1]?.end ?? 0) - (words[0]?.t ?? 0));
    const hostTakes = style === 'big' ? medium !== 'cutout' : style === 'auto' && medium !== 'cutout' && !(medium === 'subtitle' && wps > 2.6);
    if (host && hostTakes) {
      for (const f of [FACES.hand, FACES.archivo, FACES.instrument, FACES.fraunces, FACES.tight, fam ? FAMILY_FONTS[fam] : FONT]) ensureLyricFont(f);
      const hl = host.build(g, words, { W, H, pal, family: fam, treatment: tr, big: moment === 'giant', seed: choice?.seed ?? li * 7919 + 1 });
      return { ...base, medium: 'world', host: hl, hostName: host.name, rect: hl.rect, why: `the look hosts the words: ${host.name}` };
    }

    const SP = spots(portrait);
    // placement: auto picks the calmest allowed zone for the medium (fixed styles keep their place)
    const pickZone = (m: Exclude<Drawn, 'own' | 'world'>, fixed: Zone): Zone => {
      const boxes = SP[m];
      if (style !== 'auto') return fixed;
      const cand = [...look.zones.filter((z) => boxes[z]), ...(Object.keys(boxes) as Zone[]).filter((z) => !look.zones.includes(z))];
      if (!cand.length) return fixed;
      if (this.probe.version <= 0) return cand[0];
      let best = cand[0];
      let bestScore = Infinity;
      cand.forEach((z, k) => {
        const v = judge(this.probe, boxes[z]!.r, { inks: this.inkList(look.ink, pal, null), target: m === 'subtitle' ? 4.5 : 3, ladder: ladderFor(look), pal });
        // a place a pop-up window already covers is a poor one: the words would sit on it
        const score = v.level + v.bad * 3 + k * 0.35 + R() * 0.3 + coveredShare(boxes[z]!.r, this.occluders) * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = z;
        }
      });
      return best;
    };
    const fixedZone = (m: Drawn): Zone => (m === 'subtitle' ? 'bottom' : m === 'cutout' ? 'middle' : 'left');
    let zone = pickZone(medium as Exclude<Drawn, 'own' | 'world'>, fixedZone(medium));
    // the picture is too busy for display type even with a backing: hand the line to a caption
    if (style === 'auto' && !moment && (medium === 'big' || medium === 'sparse') && this.probe.version > 0 && look.plate !== 'band') {
      const v = judge(this.probe, SP[medium][zone]!.r, { inks: this.inkList(look.ink, pal, null), target: 3, ladder: ladderFor(look), pal });
      if ((v.level >= 3 && v.bad > 0.15) || v.bad > 0.35) {
        medium = 'subtitle';
        why = 'the picture is too busy there for display type';
        zone = 'bottom';
      }
    }
    const L: LineState = { ...base, medium, zone, why };
    const m = medium as Exclude<Drawn, 'own' | 'world'>;
    const spot = SP[m][zone] ?? SP[m].left ?? SP[m].middle ?? SP.subtitle.bottom!;
    const box = px(spot.r, W, H);

    if (medium === 'cutout') {
      for (const f of [FACES.fraunces, FACES.instrument, FACES.tight, FACES.archivo]) ensureLyricFont(f);
      const burst = moment === 'burst';
      L.cut = buildCutout(g, words, li, W, H, pal, burst ? { box: px(giantSpot(portrait, false).r, W, H), scale: 1.25, burst: true, align: 'left' } : { box, align: spot.align === 'left' ? 'left' : 'center' });
      L.rect = rectOf(L.cut.words.map((w) => ({ x: w.x, y: w.y - (w.p.h * L.cut!.scale) / 2, w: w.p.w * L.cut!.scale, h: w.p.h * L.cut!.scale })), W, H) ?? L.rect;
    } else {
      const variant = R();
      const role: Role = moment === 'giant' ? 'giant' : medium === 'subtitle' ? 'caption' : medium === 'sparse' ? 'aside' : 'display';
      // fixed Subtitles stay in the clean face unless a font was picked
      const voice = voiceFor(role, fam, tr, variant);
      const kicker = role === 'giant' ? voiceFor('kicker', fam, tr, variant) : undefined;
      ensureLyricFont(voice.family);
      if (kicker) ensureLyricFont(kicker.family);
      const keyIdx = keyWords(words, 1).map((k) => words.indexOf(k));
      if (role === 'giant') {
        const gs = giantSpot(portrait, zone === 'right');
        L.type = layoutLine(g, words, { role, voice, kicker, treatment: tr, box: px(gs.r, W, H), align: gs.align, anchor: 'bottom', maxRows: 1, unit, key: keyIdx });
        L.ladder = ['none', 'shadow', 'soft'];
        L.zone = zone === 'right' ? 'right' : 'left';
      } else {
        L.type = layoutLine(g, words, {
          role,
          voice,
          treatment: tr,
          box,
          align: spot.align,
          anchor: spot.anchor,
          maxRows: role === 'caption' ? 2 : role === 'aside' ? 3 : 3,
          unit,
          key: words.length >= 4 ? keyIdx : [],
        });
        L.target = role === 'caption' ? 4.5 : role === 'aside' ? 4 : 3;
      }
      L.rect = rectOf(L.type.rows, W, H, 0.015) ?? L.rect;
    }
    // a new line starts invisible, so the guard can jump straight to what this box needs
    if (L.medium !== 'cutout' && this.probe.version > 0) {
      L.stats = regionStats(this.probe, L.rect);
      this.guard.reset(judge(this.probe, L.rect, { inks: this.inkList(L.inks, pal, L.stats), target: L.target, ladder: this.ladderNow(L, L.stats), pal }));
      this.probed = this.probe.version;
      this.accentOK = this.accentReads(L, pal);
    }
    return L;
  }

  /**
   * How readable the line on screen is right now (for checks and the audit): the share of its box
   * where the ink, over the backing actually showing, misses the contrast target. null: nothing drawn.
   */
  legibilityNow(): { medium: Drawn; zone: Zone; moment: LyricMoment | null; backing: Backing; bad: number; why: string } | null {
    const L = this.line;
    if (!L || L.medium === 'own' || this.standDown > 0.5 || this.probe.version <= 0) return null;
    if (L.medium === 'cutout') return { medium: L.medium, zone: L.zone, moment: L.moment, backing: 'paper', bad: 0, why: L.why };
    if (L.medium === 'world') return { medium: L.medium, zone: L.zone, moment: L.moment, backing: 'none', bad: 0, why: L.why };
    const gd = this.guard;
    const cover = coverNow(gd);
    const st = regionStats(this.probe, L.rect);
    const bad = badShare(this.probe, L.rect, lumOf(gd.ink), gd.plate, cover, L.target, st.edge);
    return { medium: L.medium, zone: L.zone, moment: L.moment, backing: gd.backing, bad, why: L.why };
  }

  /** tell the lyrics chip what Auto is doing */
  private report(L: LineState | null, an: TrackAnalysis | null) {
    const s = useStudio.getState();
    const plan = an ? lyricPlanNow({ analysis: an, lyrics: s.lyrics, plan: s.plan, planOn: s.planOn }) : null;
    const si = L?.choice?.section ?? -1;
    setLyricNow({
      medium: L ? (L.medium === 'world' ? 'big' : L.medium) : null,
      moment: L?.moment ?? null,
      family: plan?.family ?? null,
      section: si >= 0 && an ? (LABEL[an.sections[si]?.label] ?? '') : '',
      why: L?.why ?? '',
      backing: L && L.medium !== 'own' && L.medium !== 'cutout' && L.medium !== 'world' ? this.guard.backing : 'none',
      source: plan?.source ?? null,
    });
  }

  dispose() {
    this.tex.dispose();
    this.mat.dispose();
    this.quad.dispose();
    this.probe.dispose();
  }
}

/**
 * Where the halo goes: one box per row, from its first word that's up to its newest, the newest
 * easing in as it's sung (captions keep the whole line up, so their halo does too).
 */
function haloSpans(L: TypeLayout, t: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const r of L.rows) {
    const ws = L.words.filter((w) => w.y > r.y && w.y < r.y + r.h * 1.4 && w.x >= r.x - 1 && w.x <= r.x + r.w + 1);
    if (!ws.length) continue;
    if (L.role === 'caption') {
      out.push(r);
      continue;
    }
    const up = ws.filter((w) => w.t <= t);
    if (!up.length) continue;
    const last = up[up.length - 1];
    const k = Math.min(1, (t - last.t) / 0.22);
    const p = 1 - (1 - k) * (1 - k);
    const x0 = up.length > 1 ? up[0].x : last.x + last.w * 0.5 * (1 - p);
    const from = up.length > 1 ? up[up.length - 2].x + up[up.length - 2].w : last.x + last.w * 0.5;
    const x1 = from + (last.x + last.w - from) * p;
    out.push({ x: x0, y: r.y, w: x1 - x0, h: r.h });
  }
  return out;
}

/** row boxes of a laid-out line that have a word up (scrims grow with the line) */
function rowsUp(L: TypeLayout, t: number): TypeLayout['rows'] {
  return L.rows.filter((r) => L.words.some((w) => w.t <= t && w.y > r.y && w.y < r.y + r.h * 1.4 && w.x >= r.x - 1 && w.x <= r.x + r.w + 1));
}
