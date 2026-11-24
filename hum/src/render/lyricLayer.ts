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
import { takeInside } from '../inside/reading';
import { LEAD, showingAt, showings, takeLineWindow, type Showing, type Word } from './lyricTiming';
import { PlaceMemo, frameHigh, slotCost, slots, turnedBox, turnedRect, type Slot, type SlotId } from './lyricPlace';
import { kitFontVersion, kitFor, songFacts, typeKit, underFinish, type KitLine, type TypeKit } from './typeKits';
import type { FinishId } from '../core/direction';
import { insideSafe, notePlate, safeInsets, spaceLog } from './lyricSpace';
import { buildKnockout, drawKnockout, fieldFor, kickStep, knockoutBoxes, knockoutCaps, knockoutMoving, withLead, type KnockoutLayout } from './knockout';

/**
 * Timed lyrics drawn over the finished frame, so they are in recordings and stills too.
 * Text is laid out on a 2D canvas (redrawn only while something moves) and composited with one
 * blended quad. The type itself (voices, layout, reveals) is in lyricAuto.ts.
 *
 *   subtitle: a quiet caption low in the frame; each word brightens with a wipe as it's sung
 *   big:      a display line hung from a margin or a third; words rise out of a mask as they're sung
 *   cutout:   a paste-up collage, one printed scrap per word (cutout.ts). Rare: a one-off on a drop,
 *             or when picked in the chip or for a part
 *   knockout: one word at a time, huge, filling the frame, each landing on its sung time and knocking
 *             the last one out (knockout.ts). Picked per part. It fills the frame, so it's the one
 *             medium allowed above SAFE_TOP, and it never fades: it hands over word to word itself
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

export { readTime, showings, type Showing } from './lyricTiming';

const FONT = LYRIC_FAMILIES.grotesk;
/** nothing is placed above this share of the frame height: the top stays clear */
const SAFE_TOP = 0.34;
/** a line that has to make way fades out over the next one for this long (s) */
const HANDOVER = 0.35;
const FADE_IN = 0.14;
const FADE_OUT = 0.3;
/** knockout: a gap this short (s) before the next line is held through, the last word up until the next knocks it out */
const KO_BRIDGE = 1.5;

type Drawn = 'subtitle' | 'big' | 'cutout' | 'sparse' | 'knockout' | 'own' | 'none' | 'world';
/** nothing of ours is drawn: the look shows the words, or the part has none */
const quiet = (m: Drawn) => m === 'own' || m === 'none';
/** the mediums placed in spots (knockout lays itself out over the frame) */
type Placed2 = Exclude<Drawn, 'own' | 'none' | 'world' | 'knockout'>;

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
function spots(portrait: boolean): Record<Placed2, Partial<Record<Zone, Spot>>> {
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

const SLOT_NAME: Record<SlotId, string> = { lowL: 'lower left', lowR: 'lower right', sideL: 'up the left side', sideR: 'up the right side', top: 'across the top' };

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
  ko?: KnockoutLayout;
  /** knockout: its last word is up until then (song time), through a short gap before the next line */
  holdTo?: number;
  /** normalized box around the text, probed for legibility */
  rect: Rect;
  /** with everything the kit draws round it (its plate, frame and small lines): what windows keep clear of */
  room?: Rect;
  ladder: Backing[];
  target: number;
  inks: 'look' | 'light' | 'dark';
  /** stats of the picture under the text (last probe) */
  stats: RegionStats | null;
  why: string;
  /** the type kit the line is set in (typeKits/) */
  kit: TypeKit;
  /** the showing this line belongs to: when it started, which one of how many (for kit secondary lines) */
  start: number;
  nth: number;
  of: number;
  /** words placed in the picture (Subtitle, Sparse): set vertically up a side column */
  turn?: { cx: number; cy: number };
}

const px =(r0: Rect, W: number, H: number): Box => {
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
  /** the finish on the part playing: picks the type kit (typeKits/) when the lettering matches it */
  finish?: FinishId;
}

/** what both prepare() and render() work out about a frame */
interface FrameFacts {
  t: number;
  shows: Showing[];
  i: number;
  cur: { i: number; line: Showing } | null;
  /** cur is the showing before a short gap (see KO_BRIDGE) */
  bridging: boolean;
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
  /** a pop-up showing the sung line was open last frame (see lyricTiming.noteLineWindow) */
  private lineWindow = false;
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
  /** where in-picture lines sit, remembered per block of lines (lyricPlace.ts) */
  private places = new PlaceMemo();
  /** where the words are, for the windows (see keepOut) */
  private keep: KeepOut = NO_KEEP_OUT;
  private lastRect: Rect | null = null;
  /** knockout: what the picture looked like when each showing was laid out (so a handed-over word matches) */
  private koSeen = new WeakMap<LyricLine[], Map<number, { pic: RegionStats | null; needsField: boolean }>>();

  /** the picture under the lyrics, shrunk and read back every few frames */
  readonly probe = new FrameProbe();

  /** the 2D canvas the words are drawn on (the dev measuring tool reads it) */
  get devCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

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
    let cur = i >= 0 && t < shows[i].end + FADE_OUT ? { i, line: shows[i] } : null;
    // a short gap before the next showing: a knockout word holds through it until the next one knocks
    // it out (only knockout lines use the bridge; see holdTo)
    const bridging = !cur && i >= 0 && i + 1 < shows.length && shows[i + 1].t - shows[i].end < KO_BRIDGE;
    if (bridging) cur = { i, line: shows[i] };
    const scale = Math.min(1, 1600 / Math.max(o.width, 1));
    const W = Math.max(2, Math.round(o.width * scale));
    const H = Math.max(2, Math.round(o.height * scale));
    const scene = getScene(st.sceneId);
    const show = st.lyricsOnBoards === 'show';
    const look = profileFor(st.presetId, scene?.category, !!scene?.showsLyrics);
    return { t, shows, i, cur, bridging, W, H, look, carries: look.own === 'carries' && !show };
  }

  /** in a bridged gap, only a knockout line still holding its last word is up */
  private bridged(f: FrameFacts): boolean {
    const L = this.line;
    return !f.bridging || (!!L?.ko && L.holdTo !== undefined && f.t - LEAD < L.holdTo);
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
    const now = f.cur && this.bridged(f) && L && !quiet(L.medium) && this.standDown < 0.5 ? (L.room ?? L.rect) : null;
    if (now) this.lastRect = now;
    // the next showing, once it's close: lines in a part mostly come back to the same place
    const nx = f.shows[f.cur ? f.cur.i + 1 : f.i + 1];
    const next = nx && nx.t - f.t < 2 && this.lastRect ? this.lastRect : null;
    this.keep = { now, next };
  }

  /** the type kit for this frame: the Lettering setting, or the finish's own (typeKits/) */
  private kitNow(o: LyricOpts): TypeKit {
    return typeKit(kitFor(useStudio.getState().typeKit, o.finish ?? 'clean'));
  }

  /**
   * Does this frame's lettering go in before the finish (so the finish works on the words too)?
   * The stage asks, to draw the lyrics before or after present() (stage.ts).
   */
  underFinish(o: LyricOpts): boolean {
    if (o.style === 'off' || !o.lines.length) return false;
    const f = o.finish ?? 'clean';
    return underFinish(kitFor(useStudio.getState().typeKit, f), f);
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
    // the type kit: a change of finish (or of the Lettering setting) sets the line again in the new kit
    const kit = this.kitNow(o);
    const key = `${o.style}|${group}|${W}x${H}|${st.lyricFont}|${hostKey}|${lyricFontVersion()}|${kit.id}|${kitFontVersion()}`;
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
      this.line = this.plan(key, line.first, o.lines, words, line.timed, o.style, f.look, f.carries, W, H, o.palette, st.analysis, st.sceneId, line.end, kit, f.cur!.i);
      this.line.group = group;
      this.line.start = line.t;
      this.line.nth = f.cur!.i + 1;
      this.line.of = f.shows.length;
      // knockout hands over word to word itself (the last word is knocked out by the next): no ghost
      if (this.line.medium === 'knockout') this.ghostOn = false;
      // a new line while a "now singing" pop-up is open starts hidden (it's in the pop-up)
      this.standDown = this.lineWindow ? 1 : 0;
      if (this.lineWindow) this.ghostOn = false;
    }
  }

  /** draw the lyrics for time t over whatever is on the screen */
  render(r: THREE.WebGLRenderer, o: LyricOpts, target: THREE.WebGLRenderTarget | null = null) {
    // an inside footage shot stands the words in the picture itself (src/inside)
    const inPicture = takeInside();
    if (o.style === 'off' || !o.lines.length) return;
    // the dev harness steps song time faster than real time: it passes its step and runs on its own clock
    const now = o.dt !== undefined ? (this.devClock += o.dt) : performance.now() / 1000;
    const dt = o.dt ?? Math.min(0.1, Math.max(0, now - (this.clock || now)));
    this.clock = now;
    const st = useStudio.getState();
    this.lineWindow = takeLineWindow();
    const f = this.facts(o);
    const { t, cur, W, H, carries } = f;
    if (cur) this.ensureLine(f, o);

    if (!cur || !this.bridged(f) || inPicture) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.empty = true;
        this.lastKey = '';
      }
      // in a bridged gap the laid-out line is kept, so it isn't laid out again every frame
      if (!cur) this.line = null;
      this.ghostOn = false;
      if (o.style === 'auto') this.report(null, st.analysis);
      return;
    }
    const line = cur.line;
    const words = line.words;
    const key = this.line!.key;
    const L = this.line!;
    const guarded = !quiet(L.medium) && L.medium !== 'cutout' && L.medium !== 'world';

    // a cut to a look that shows the words itself mid-line: fade out rather than fight it
    // (Auto hands every medium to the look; the fixed Subtitles style keeps its subtitles).
    // A "now singing" pop-up shows the sung line too: the words are in one place at a time, so the
    // overlay stands down while one is open (lyricTiming.noteLineWindow, from mod-words.ts).
    const hideNow = (carries && !quiet(L.medium) && (o.style === 'auto' || L.medium !== 'subtitle')) || (this.lineWindow && !quiet(L.medium));
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

    // knockout never fades: its words arrive and leave on their own (it only stands down for a lyric look)
    const ko = L.ko;
    const fadeOut = ko ? 0 : Math.max(0, (t - line.end) / FADE_OUT);
    const alpha = ko ? 1 - this.standDown : Math.min(1, (t - line.t) / FADE_IN, 1 - fadeOut) * (1 - this.standDown);
    // knockout words land on their sung time exactly (the layer's clock runs LEAD early for the others)
    const tSung = t - LEAD;
    // the line that made way: fades and lifts a touch while the new one comes in
    if (this.ghostOn && (t < this.ghostFrom - 0.05 || t - this.ghostFrom > HANDOVER)) this.ghostOn = false;
    const gk = this.ghostOn ? 1 - (t - this.ghostFrom) / HANDOVER : 0;
    const ghostA = this.ghostOn ? Math.max(0, this.ghostA * gk * gk) : 0;
    const sung = words.filter((w) => w.t <= t).length;
    const an = st.analysis;
    const drop = dropMoment(an, o.t, o.audio);
    const live = ko ? knockoutMoving(ko, tSung) : L.type ? (L.kit.moving ? L.kit.moving(L.type, t) : moving(L.type, t, drop)) : L.cut ? cutoutMoving(L.cut, t) : L.host ? L.host.moving(t) : false;
    // redraw at 60 fps only while something moves (or fades); a still line keeps its last drawing
    const tick = live || ghostA > 0.01 || fadeOut > 0 ? Math.floor(t * 60) : -1;
    const drawKey = `${key}|${tick}|${sung}|${Math.round(alpha * 40)}|${ko ? kickStep(o.audio.kick) : ''}|${this.guard.key()}|${this.accentOK}|${o.palette.fg}${o.palette.accent}${o.palette.bg}`;
    if (drawKey !== this.lastKey) {
      this.lastKey = drawKey;
      const g = this.ctx;
      g.clearRect(0, 0, W, H);
      if (ghostA > 0.01) {
        g.globalAlpha = ghostA;
        g.drawImage(this.ghost, 0, -H * 0.012 * (1 - gk));
        g.globalAlpha = 1;
      }
      this.lastAlpha = quiet(L.medium) ? 0 : alpha;
      if (alpha > 0.01 && !quiet(L.medium)) {
        g.save();
        // quick soft exit: the line lifts a little as it fades
        if (fadeOut > 0) g.translate(0, -fadeOut * H * 0.012);
        if (ko) {
          // a scrim only when the guard asks for one (no field to cut the words from on this look)
          const boxes = knockoutBoxes(ko, tSung);
          if (boxes.length) drawBacking(g, boxes, this.guard, ko.shadowSize, W, alpha, L.i + 1);
          const c = this.inks(o.palette, L);
          const base = { ink: c.ink, accent: c.accent, shadow: c.shadow };
          // under a kit, its face set huge and inked its way (a glow on tape, a flat print shadow on film)
          const kc = L.kit.knockInks ? L.kit.knockInks(base, lumOf(this.guard.ink) > 0.5, o.palette) : base;
          drawKnockout(g, ko, tSung, alpha, kc, o.audio.kick, W, H);
        } else if (L.cut) {
          drawCutout(g, L.cut, L.moment === 'burst' ? t + 0.04 : t, Math.max(0, alpha));
          // the scraps are plates too (their boxes, unrotated, for the measuring tool)
          if (spaceLog.on) for (const w of L.cut.words) notePlate(g, { x0: w.x, y0: w.y - (w.p.h * L.cut.scale) / 2, x1: w.x + w.p.w * L.cut.scale, y1: w.y + (w.p.h * L.cut.scale) / 2 }, w.p.size * L.cut.scale * 0.7, 'cutout scrap');
        }
        else if (L.host) L.host.draw(g, t, Math.max(0, alpha), o.audio, this.hostNeed);
        else if (L.type) {
          // set vertically up a side column: drawn turned a quarter about the column's centre
          if (L.turn) {
            g.translate(L.turn.cx, L.turn.cy);
            g.rotate(-Math.PI / 2);
            g.translate(-L.turn.cx, -L.turn.cy);
          }
          const medium = L.medium === 'subtitle' || L.medium === 'sparse' ? L.medium : 'big';
          const plate = !!L.kit.ownPlate?.(L.type.role, medium);
          if (!plate) {
            const rows = L.type.role === 'caption' ? L.type.rows : rowsUp(L.type, t);
            drawBacking(g, rows, this.guard, L.type.size, W, alpha, L.i + 1);
            if (this.guard.mix.halo > 0.02) drawHalo(g, haloSpans(L.type, t), this.guard, L.type.size, W, alpha);
          }
          if (L.kit.draw) {
            L.kit.draw({ g, L: L.type, t, alpha: Math.max(0, alpha), inks: this.inks(o.palette, L), light: lumOf(this.guard.ink) > 0.5, pal: o.palette, audio: o.audio, drop, W, H, medium, facts: songFacts(an, o.t, L.nth, L.of), seed: L.choice?.seed ?? L.i * 7919 + 1, start: L.start });
          } else drawLine(g, L.type, t, Math.max(0, alpha), this.inks(o.palette, L), o.audio, drop);
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
    // knockout answers a busy picture with its field, not a halo
    if (L.medium === 'knockout') return L.ladder;
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
  private plan(key: string, li: number, lines: LyricLine[], words: Word[], timed: boolean, style: LyricStyle, look: LyricProfile, carries: boolean, W: number, H: number, pal: Palette, an: TrackAnalysis | null, sceneId: string, end: number, kit: TypeKit, showIdx: number): LineState {
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
      if (moment === 'giant' && !quiet(medium)) medium = 'big';
      if (moment === 'burst' && !quiet(medium)) medium = 'cutout';
    } else {
      medium = style === 'auto' ? 'big' : style === 'big' ? 'big' : style === 'cutout' ? 'cutout' : 'subtitle';
      if (medium !== 'subtitle' && carries) medium = 'own';
    }
    void timed;
    const R = seeded(choice?.seed ?? li * 7919 + 1);
    const portrait = H > W * 1.2;
    const unit = Math.min(W, H);
    const base: LineState = { key, i: li, medium, moment, choice, zone: 'middle', rect: { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.6 }, ladder: ladderFor(look), target: 3, inks: look.ink, stats: null, why, kit, start: 0, nth: 0, of: 0 };
    if (quiet(medium)) return base;

    // the font picked in the lyrics panel wins; on Auto, the song's family (Claude's plan or the local one)
    const picked = useStudio.getState().lyricFont;
    const fam = picked !== 'auto' ? picked : style === 'auto' ? choice?.family : undefined;
    const tr: Treatment = choice?.motion ?? treatmentFor(an).id;

    const host = hostFor(sceneId);
    // words inside the world: a scene that can host the line takes it (on Auto, all but dense
    // caption lines, which need to stay plain to be read; on Big words, every line)
    const wps = words.length / Math.max(0.5, (words[words.length - 1]?.end ?? 0) - (words[0]?.t ?? 0));
    const hostTakes = style === 'big' ? medium !== 'cutout' : style === 'auto' && medium !== 'cutout' && medium !== 'knockout' && !(medium === 'subtitle' && wps > 2.6);
    if (host && hostTakes) {
      for (const f of [FACES.hand, FACES.archivo, FACES.instrument, FACES.fraunces, FACES.tight, fam ? FAMILY_FONTS[fam] : FONT]) ensureLyricFont(f);
      const hl = host.build(g, words, { W, H, pal, family: fam, treatment: tr, big: moment === 'giant', seed: choice?.seed ?? li * 7919 + 1 });
      return { ...base, medium: 'world', host: hl, hostName: host.name, rect: hl.rect, why: `the look hosts the words: ${host.name}` };
    }

    if (medium === 'knockout' && an) return this.planKnockout(base, words, lines, li, look, carries, W, H, pal, an, kit.knockFace ?? fam, tr, end);
    if (medium === 'knockout') medium = 'big';

    const SP = spots(portrait);
    // placement: auto picks the calmest allowed zone for the medium (fixed styles keep their place)
    const pickZone = (m: Placed2, fixed: Zone): Zone => {
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
    let zone = pickZone(medium as Placed2, fixedZone(medium));
    // the picture is too busy for display type even with a backing: hand the line to a caption
    // (a kit that gives display lines their own plate, like Print's ink bands, reads anywhere)
    if (style === 'auto' && !moment && (medium === 'big' || medium === 'sparse') && this.probe.version > 0 && look.plate !== 'band' && !kit.ownPlate?.('display', medium)) {
      const v = judge(this.probe, SP[medium][zone]!.r, { inks: this.inkList(look.ink, pal, null), target: 3, ladder: ladderFor(look), pal });
      if ((v.level >= 3 && v.bad > 0.15) || v.bad > 0.35) {
        medium = 'subtitle';
        why = 'the picture is too busy there for display type';
        zone = 'bottom';
      }
    }
    const L: LineState = { ...base, medium, zone, why };
    const m = medium as Placed2;
    let spot = SP[m][zone] ?? SP[m].left ?? SP[m].middle ?? SP.subtitle.bottom!;
    // words placed in the picture (lyricPlace.ts): the calmest open place, held for a few lines
    let slot: Slot | null = null;
    if (style === 'auto' && !moment && choice?.place === 'picture' && medium === choice.medium && (medium === 'sparse' || medium === 'subtitle')) {
      this.places.reset(`${portrait}|${lines.length}|${lines[0]?.t ?? 0}`);
      const hi = this.probe.version > 0 ? frameHigh(this.probe) : 1;
      const ink = this.inkList(look.ink, pal, null);
      slot = this.places.pick(showIdx, choice.section, slots(portrait), (s) =>
        this.probe.version > 0 ? slotCost(s, judge(this.probe, s.r, { inks: ink, target: medium === 'subtitle' ? 4.5 : 4, ladder: ladderFor(look), pal }), this.probe, hi, this.occluders, words.length) : s.turned ? 1 : 0,
      );
      if (!slot.turned) spot = { r: slot.r, align: slot.align, anchor: slot.anchor };
      L.zone = slot.id === 'lowR' || slot.id === 'sideR' ? 'right' : slot.id === 'top' ? 'middle' : 'left';
      L.why = `${why}${why ? '; ' : ''}placed in the picture (${SLOT_NAME[slot.id]})`;
    }
    const box = px(spot.r, W, H);

    if (medium === 'cutout') {
      for (const f of [FACES.fraunces, FACES.instrument, FACES.tight, FACES.archivo]) ensureLyricFont(f);
      const burst = moment === 'burst';
      // the scraps stay inside the safe area: a collage that won't fit is set again a size down
      const cbox = insideSafe(burst ? px(giantSpot(portrait, false).r, W, H) : box, W, H);
      const cutIn = (scale: number) => buildCutout(g, words, li, W, H, pal, burst ? { box: cbox, scale, burst: true, align: 'left' } : { box: cbox, scale, align: spot.align === 'left' ? 'left' : 'center' });
      const spills = (c: CutoutLayout) => c.words.some((w) => w.x < cbox.x0 - 1 || w.x + w.p.w * c.scale > cbox.x1 + 1 || w.y - (w.p.h * c.scale) / 2 < cbox.y0 - 1 || w.y + (w.p.h * c.scale) / 2 > cbox.y1 + 1);
      let scale = burst ? 1.25 : 1;
      L.cut = cutIn(scale);
      for (let k = 0; k < 6 && spills(L.cut); k++) L.cut = cutIn((scale *= 0.85));
      L.rect = rectOf(L.cut.words.map((w) => ({ x: w.x, y: w.y - (w.p.h * L.cut!.scale) / 2, w: w.p.w * L.cut!.scale, h: w.p.h * L.cut!.scale })), W, H) ?? L.rect;
    } else {
      const variant = R();
      const role: Role = moment === 'giant' ? 'giant' : medium === 'subtitle' ? 'caption' : medium === 'sparse' ? 'aside' : 'display';
      // fixed Subtitles stay in the clean face unless a font was picked
      // a type kit sets the line in its own faces (the song's family and motion still decide the rest)
      const own = (r: Role | 'kicker', v: ReturnType<typeof voiceFor>) => (kit.voice ? kit.voice(r, v) : v);
      const voice = own(role, voiceFor(role, fam, tr, variant));
      const kicker = role === 'giant' ? own('kicker', voiceFor('kicker', fam, tr, variant)) : undefined;
      ensureLyricFont(voice.family);
      if (kicker) ensureLyricFont(kicker.family);
      const keyIdx = keyWords(words, 1).map((k) => words.indexOf(k));
      const kitMedium = medium === 'subtitle' || medium === 'sparse' ? medium : 'big';
      if (role === 'giant') {
        const gs = giantSpot(portrait, zone === 'right');
        L.type = fitType((b) => layoutLine(g, words, { role, voice, kicker, treatment: tr, box: b, align: gs.align, anchor: 'bottom', maxRows: 1, unit, key: keyIdx }), px(gs.r, W, H), kit, kitMedium, W, H);
        L.ladder = ['none', 'shadow', 'soft'];
        L.zone = zone === 'right' ? 'right' : 'left';
      } else if (slot?.turned) {
        // up a side column: laid out flat in the column's turned box, drawn turned a quarter
        const tb = turnedBox(px(slot.r, W, H));
        L.type = fitType((b) => layoutLine(g, words, { role, voice, treatment: tr, box: b, align: slot.align, anchor: slot.anchor, maxRows: 2, unit, key: words.length >= 4 ? keyIdx : [] }), tb.box, kit, kitMedium, W, H, { cx: tb.cx, cy: tb.cy });
        L.turn = { cx: tb.cx, cy: tb.cy };
        L.target = role === 'caption' ? 4.5 : 4;
        // a full-width band or paper sheet can't turn with the words: the halo stands in for them
        const flat: Backing[] = [...L.ladder.filter((b) => b !== 'band' && b !== 'paper'), 'halo'];
        L.ladder = flat.filter((b, k) => flat.indexOf(b) === k);
      } else {
        L.type = fitType(
          (b) =>
            layoutLine(g, words, {
              role,
              voice,
              treatment: tr,
              box: b,
              align: spot.align,
              anchor: spot.anchor,
              maxRows: role === 'caption' ? 2 : role === 'aside' ? 3 : 3,
              unit,
              key: words.length >= 4 ? keyIdx : [],
            }),
          box,
          kit,
          kitMedium,
          W,
          H,
        );
        L.target = role === 'caption' ? 4.5 : role === 'aside' ? 4 : 3;
      }
      L.rect = (L.turn ? turnedRect(L.type.rows, L.turn.cx, L.turn.cy, W, H, 0.015) : rectOf(L.type.rows, W, H, 0.015)) ?? L.rect;
      L.room = withReach(L.rect, kit.reach(L.type, kitMedium, W, H), W, H, !!L.turn);
      if (!L.turn && kit.spans?.(L.type.role, kitMedium)) L.room = { ...L.room, x0: 0, x1: 1 };
      // a kit medium with its own plate (the LED sign, the ink band, the paper panel) is its own
      // backing: the guard has nothing to add under it
      if (kit.ownPlate?.(role, kitMedium)) L.ladder = ['none'];
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
   * Lay a knockout showing out: the words as huge cards in the song's family, capitals or as written
   * for the whole part, sized by how long each is held, the loudness there and the part's energy.
   * When the showing before was knockout in the same part and runs right up to this one, it hands
   * over its last card, so this showing's first word knocks it out (all from the plan, so scrubbing
   * gives the same picture).
   */
  private planKnockout(base: LineState, words: Word[], lines: LyricLine[], li: number, look: LyricProfile, carries: boolean, W: number, H: number, pal: Palette, an: TrackAnalysis, fam: string | undefined, tr: Treatment, end: number): LineState {
    const g = this.ctx;
    const choice = base.choice;
    const maxE = Math.max(0.01, ...an.sections.map((s) => s.energy));
    const curve = an.energyCurve;
    const loud = (t: number) => (curve?.length ? curve[Math.max(0, Math.min(curve.length - 1, Math.floor((t / Math.max(1, an.duration)) * curve.length)))] : 0.6);
    const portrait = H > W * 1.2;
    const bandR: Rect = portrait ? { x0: 0.05, y0: 0.2, x1: 0.95, y1: 0.76 } : { x0: 0.05, y0: 0.12, x1: 0.95, y1: 0.9 };
    // what the picture under the band asks for: ink that clears it with a shadow at most, or the field
    const sampled = this.probe.version > 0;
    const pic = sampled ? regionStats(this.probe, bandR) : null;
    const ladder: Backing[] = ['none', 'shadow'];
    const v = sampled ? judge(this.probe, bandR, { inks: this.inkList(look.ink, pal, pic), target: 3, ladder, pal }) : null;
    const field = fieldFor(pal, pic);
    const needsField = !!v && v.bad > 0.12;
    ensureLyricFont(fam ? FAMILY_FONTS[fam] : FONT);
    const section = choice?.section ?? 0;
    const opts = (e: number, seed: number) => ({
      W,
      H,
      family: fam,
      caps: knockoutCaps(fam, tr, choice?.partSeed ?? 1),
      energy: an.sections[section] ? an.sections[section].energy / maxE : 0.7,
      loud,
      seed,
      end: e,
      pal,
      pic,
      needsField,
    });
    // the showings either side: knockout in the same part, close enough to hand over word to word?
    const shows = showings(lines);
    const k = shows.findIndex((s) => s.first === li);
    const s = useStudio.getState();
    const plan = lyricPlanNow({ analysis: an, lyrics: s.lyrics, plan: s.plan, planOn: s.planOn });
    const koAt = (j: number) => {
      const sh = shows[j];
      if (!sh || !plan) return null;
      const c = chooseForLine(plan, an, lines, sh.first, look, !carries);
      return c.medium === 'knockout' && c.section === section ? c : null;
    };
    // held through a short gap until the next showing's first word knocks it out
    const handsOn = (j: number) => j >= 0 && j + 1 < shows.length && shows[j + 1].t - shows[j].end < KO_BRIDGE && !!koAt(j + 1);
    const endOf = (j: number) => (handsOn(j) ? shows[j + 1].t : shows[j]?.end ?? end);
    const myEnd = k >= 0 ? endOf(k) : end;
    let ko = buildKnockout(g, words, opts(myEnd, choice?.seed ?? li + 1));
    const pc = k > 0 && handsOn(k - 1) ? koAt(k - 1) : null;
    // the word handed over is drawn as it was on screen: laid out from what that showing saw
    const seen = this.koSeen.get(lines) ?? new Map<number, { pic: RegionStats | null; needsField: boolean }>();
    this.koSeen.set(lines, seen);
    if (pc) ko = withLead(ko, buildKnockout(g, shows[k - 1].words, { ...opts(endOf(k - 1), pc.seed), ...(seen.get(shows[k - 1].first) ?? {}) }));
    seen.set(li, { pic, needsField });
    // with no field to cut the words from on this picture, ink may need a soft scrim
    return { ...base, medium: 'knockout', ko, holdTo: myEnd + 0.1, rect: ko.rect, zone: 'middle', target: 3, ladder: field ? ladder : ['none', 'shadow', 'soft', 'band'] };
  }

  /**
   * How readable the line on screen is right now (for checks and the audit): the share of its box
   * where the ink, over the backing actually showing, misses the contrast target. null: nothing drawn.
   */
  legibilityNow(): { medium: Drawn; zone: Zone; moment: LyricMoment | null; backing: Backing; bad: number; why: string } | null {
    const L = this.line;
    if (!L || quiet(L.medium) || this.standDown > 0.5 || this.probe.version <= 0) return null;
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
      backing: L && !quiet(L.medium) && L.medium !== 'cutout' && L.medium !== 'world' ? this.guard.backing : 'none',
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
  for (const [ri, r] of L.rows.entries()) {
    const ws = L.words.filter((w) => w.row === ri);
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
  return L.rows.filter((_, ri) => L.words.some((w) => w.t <= t && w.row === ri));
}

/** a line's box with what its kit draws round it; `turned`: it is set up a side column, a quarter anticlockwise */
function withReach(r: Rect, rc: { l: number; t: number; r: number; b: number }, W: number, H: number, turned: boolean): Rect {
  const o = turned ? { l: rc.t, t: rc.r, r: rc.b, b: rc.l } : rc;
  return { x0: Math.max(0, r.x0 - o.l / W), y0: Math.max(0, r.y0 - o.t / H), x1: Math.min(1, r.x1 + o.r / W), y1: Math.min(1, r.y1 + o.b / H) };
}

/**
 * Lay a line out in `box`, then pull the box in until the ink, and everything the kit draws round it
 * (its plates, frames and secondary lines: TypeKit.reach), sits inside the safe area (lyricSpace.ts).
 * The type gets smaller or takes another row as the box shrinks; the padding never does. A line set
 * up a side column (`turn`) is checked where it lands, turned a quarter.
 */
function fitType(make: (b: Box) => TypeLayout, box0: Box, kit: TypeKit, medium: KitLine['medium'], W: number, H: number, turn?: { cx: number; cy: number }): TypeLayout {
  const s = safeInsets(W, H);
  let box = turn ? box0 : insideSafe(box0, W, H);
  let L = make(box);
  for (let k = 0; k < 5 && L.rows.length; k++) {
    const ink = {
      x0: Math.min(...L.rows.map((r) => r.x)),
      y0: Math.min(...L.rows.map((r) => r.y)),
      x1: Math.max(...L.rows.map((r) => r.x + r.w)),
      y1: Math.max(...L.rows.map((r) => r.y + r.h)),
    };
    const rc = kit.reach(L, medium, W, H);
    let e = { x0: ink.x0 - rc.l, y0: ink.y0 - rc.t, x1: ink.x1 + rc.r, y1: ink.y1 + rc.b };
    // turned a quarter (anticlockwise) about the column's centre: flat x runs up the screen
    if (turn) e = { x0: turn.cx + (e.y0 - turn.cy), x1: turn.cx + (e.y1 - turn.cy), y0: turn.cy - (e.x1 - turn.cx), y1: turn.cy - (e.x0 - turn.cx) };
    const over = { l: s.l - e.x0, t: s.t - e.y0, r: e.x1 - (W - s.r), b: e.y1 - (H - s.b) };
    if (over.l <= 0.5 && over.t <= 0.5 && over.r <= 0.5 && over.b <= 0.5) break;
    // only the sides that spill move in (by the spill and a pixel)
    const o = { l: over.l > 0.5 ? over.l + 1 : 0, t: over.t > 0.5 ? over.t + 1 : 0, r: over.r > 0.5 ? over.r + 1 : 0, b: over.b > 0.5 ? over.b + 1 : 0 };
    // turned, each side of the screen is a side of the flat box: screen left is its top, bottom its left
    const next = turn ? { x0: box.x0 + o.b, x1: box.x1 - o.t, y0: box.y0 + o.l, y1: box.y1 - o.r } : { x0: box.x0 + o.l, x1: box.x1 - o.r, y0: box.y0 + o.t, y1: box.y1 - o.b };
    if (next.x1 - next.x0 < 8 || next.y1 - next.y0 < 8) break;
    box = next;
    L = make(box);
  }
  return L;
}
