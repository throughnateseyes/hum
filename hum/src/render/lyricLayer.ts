import * as THREE from 'three';
import type { AudioFrame, LyricLine, Palette, TrackAnalysis } from '../core/types';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { indexAt } from '../audio/lyrics';
import { useStudio, type LyricStyle } from '../state/store';
import { getScene } from '../scenes';
import { buildCutout, drawCutout, type CutoutLayout } from './cutout';
import { buildAuto, drawAuto, dropMoment, styleFor, treatmentFor, FAMILY_FONTS, type AutoLayout, type Box, type Inks } from './lyricAuto';
import { FrameProbe, Guard, NEAR_BLACK, NEAR_WHITE, accentOr, applyShadow, badShare, coveredL, css, drawBacking, hexRGB, inksFor, judge, lumOf, regionStats, type Backing, type RGB, type Rect, type RegionStats } from './legibility';
import { ladderFor, profileFor, type LyricProfile, type Zone } from './lyricProfiles';
import { chooseForLine, lyricPlanNow, seeded, setLyricNow, type LyricChoice, type LyricMoment } from '../state/lyricPlan';

/**
 * Timed lyrics drawn over the finished frame, so they are in recordings and stills too.
 * Text is laid out on a 2D canvas (only redrawn when something visible changes) and composited
 * with one blended quad.
 *
 *   subtitle: the current line low in the frame; sung words brighten as they're sung
 *   big:      one huge line in the middle; words land one by one, the current word in the accent
 *   cutout:   the same big line as a ransom note: every word (or letter) cut from a different
 *             clipping, slapped down as it's sung (see cutout.ts)
 *   auto:     a lyric video. Each part of the song gets its own medium from the lyric plan
 *             (state/lyricPlan.ts): subtitles in verses, big words or cutouts on choruses and drops,
 *             a word or two in builds, the look's own lyric components where it has them, plus one-off
 *             moments (a giant word on the drop, a cutout burst). Type family and motion stay the
 *             same for the whole song (lyricAuto.ts); placement goes where the picture is calm.
 *
 * Every style is guarded (legibility.ts): the frame under the text is sampled every few frames and
 * the ink and backing (shadow, soft plate, band, paper strip) are eased to whatever clears the
 * contrast target there. Big, cutout and auto lyrics stand down on looks that show the words
 * themselves (scenes with `showsLyrics`) unless the user picks "Show anyway".
 */

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FADE_IN = 0.14;
const FADE_OUT = 0.3;
/** show the next line slightly early so the eye arrives with the voice */
const LEAD = 0.08;

type Drawn = 'subtitle' | 'big' | 'cutout' | 'sparse' | 'own';

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

/** greedy wrap into lines that fit maxW */
function wrap(ctx: CanvasRenderingContext2D, words: Word[], maxW: number, maxLines: number): Word[][] {
  const rows: Word[][] = [[]];
  const space = ctx.measureText(' ').width;
  let w = 0;
  for (const word of words) {
    const ww = ctx.measureText(word.text).width;
    const row = rows[rows.length - 1];
    if (row.length && w + space + ww > maxW && rows.length < maxLines) {
      rows.push([word]);
      w = ww;
    } else {
      row.push(word);
      w += (row.length > 1 ? space : 0) + ww;
    }
  }
  return rows;
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

/** where each medium can sit (normalized boxes) */
const ZONE_BOX: Record<Drawn, Partial<Record<Zone, Rect>>> = {
  subtitle: { bottom: { x0: 0.1, y0: 0.8, x1: 0.9, y1: 0.94 }, top: { x0: 0.1, y0: 0.06, x1: 0.9, y1: 0.2 } },
  big: {
    middle: { x0: 0.08, y0: 0.2, x1: 0.92, y1: 0.8 },
    top: { x0: 0.08, y0: 0.07, x1: 0.92, y1: 0.46 },
    bottom: { x0: 0.08, y0: 0.54, x1: 0.92, y1: 0.93 },
    left: { x0: 0.06, y0: 0.16, x1: 0.56, y1: 0.84 },
    right: { x0: 0.44, y0: 0.16, x1: 0.94, y1: 0.84 },
  },
  cutout: {
    middle: { x0: 0.07, y0: 0.16, x1: 0.93, y1: 0.84 },
    top: { x0: 0.07, y0: 0.06, x1: 0.93, y1: 0.48 },
    bottom: { x0: 0.07, y0: 0.52, x1: 0.93, y1: 0.94 },
  },
  sparse: {
    left: { x0: 0.06, y0: 0.08, x1: 0.52, y1: 0.4 },
    right: { x0: 0.48, y0: 0.6, x1: 0.94, y1: 0.92 },
    top: { x0: 0.18, y0: 0.07, x1: 0.82, y1: 0.3 },
    bottom: { x0: 0.18, y0: 0.7, x1: 0.82, y1: 0.93 },
    middle: { x0: 0.22, y0: 0.38, x1: 0.78, y1: 0.62 },
  },
  own: {},
};

interface SubLayout {
  size: number;
  font: string;
  rows: { words: Word[]; widths: number[]; x: number; y: number }[];
  space: number;
  boxes: { x: number; y: number; w: number; h: number }[];
}

interface LineState {
  key: string;
  i: number;
  medium: Drawn;
  moment: LyricMoment | null;
  choice: LyricChoice | null;
  zone: Zone;
  sub?: SubLayout;
  auto?: AutoLayout;
  cut?: CutoutLayout;
  /** normalized box around the text, probed for legibility */
  rect: Rect;
  ladder: Backing[];
  target: number;
  inks: 'look' | 'light' | 'dark';
  /** stats of the picture under the text (last probe) */
  stats: RegionStats | null;
  why: string;
}

const px = (r: Rect, W: number, H: number): Box => ({ x0: r.x0 * W, y0: r.y0 * H, x1: r.x1 * W, y1: r.y1 * H });

function rectOf(boxes: { x: number; y: number; w: number; h: number }[], W: number, H: number, pad = 0.01): Rect | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x0: Math.max(0, x0 / W - pad), y0: Math.max(0, y0 / H - pad), x1: Math.min(1, x1 / W + pad), y1: Math.min(1, y1 / H + pad) };
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
  private clock = 0;
  /** fades the line out when a shot cuts to a look that shows the words itself */
  private standDown = 0;
  /** look + scene the guard last saw, to notice cuts */
  private lookKey = '';
  /** the accent passes the same per-pixel contrast test as the ink (else the current word uses the ink) */
  private accentOK = false;
  /** smoothed music energy for the auto style */
  private energy = 0;

  /** the picture under the lyrics, shrunk and read back every few frames */
  readonly probe = new FrameProbe();

  constructor() {
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
  }

  /** look at the frame the lyrics will go over (called by the stage before pop-ups and lyrics) */
  sample(r: THREE.WebGLRenderer, tex: THREE.Texture, blit: (t: THREE.Texture, target: THREE.WebGLRenderTarget | null) => void) {
    this.probe.sample(r, tex, blit);
  }

  /** draw the lyrics for time t over whatever is on the screen */
  render(r: THREE.WebGLRenderer, o: { lines: LyricLine[]; t: number; style: LyricStyle; palette: Palette; width: number; height: number; audio: AudioFrame }, target: THREE.WebGLRenderTarget | null = null) {
    if (o.style === 'off' || !o.lines.length) return;
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - (this.clock || now)));
    this.clock = now;
    const t = o.t + LEAD;
    const st = useStudio.getState();
    const i = indexAt(o.lines, t);
    const cur = i >= 0 && t < o.lines[i].end + FADE_OUT ? { i, line: o.lines[i] } : null;
    const scale = Math.min(1, 1600 / Math.max(o.width, 1));
    const W = Math.max(2, Math.round(o.width * scale));
    const H = Math.max(2, Math.round(o.height * scale));
    const scene = getScene(st.sceneId);
    const show = st.lyricsOnBoards === 'show';
    const look = profileFor(st.presetId, scene?.category, !!scene?.showsLyrics);
    const carries = look.own === 'carries' && !show;

    if (!cur) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.empty = true;
        this.lastKey = '';
      }
      this.line = null;
      if (o.style === 'auto') this.report(null, st.analysis);
      return;
    }
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      // the GL texture was allocated at the old size and won't take a bigger upload: start a new one
      this.tex.dispose();
      this.lastKey = '';
    }
    const line = cur.line;
    const words = wordsOf(line);
    const key = `${o.style}|${cur.i}|${line.text}|${W}x${H}`;
    if (this.line?.key !== key) {
      this.line = this.plan(key, cur.i, o.lines, words, !!line.words?.length, o.style, look, carries, W, H, o.palette, st.analysis);
      this.standDown = 0;
    }
    const L = this.line;

    // a cut to a look that shows the words itself mid-line: fade out rather than fight it
    // (Auto hands every medium to the look; the fixed Subtitles style keeps its subtitles)
    const hideNow = carries && L.medium !== 'own' && (o.style === 'auto' || L.medium !== 'subtitle');
    this.standDown += ((hideNow ? 1 : 0) - this.standDown) * Math.min(1, dt * 8);

    // a cut under the line: the picture changed at once, so the guard may follow at once
    const lookNow = `${st.presetId}|${st.sceneId}`;
    if (lookNow !== this.lookKey) {
      this.lookKey = lookNow;
      this.guard.jolt(now);
    }
    // legibility: re-judge the box whenever a new probe arrives, ease toward it every frame
    if (L.medium !== 'own' && L.medium !== 'cutout' && this.probe.version > 0 && this.probe.version !== this.probed) {
      this.probed = this.probe.version;
      L.stats = regionStats(this.probe, L.rect);
      const v = judge(this.probe, L.rect, { inks: this.inkList(L.inks, o.palette, L.stats), target: L.target, ladder: L.ladder, pal: o.palette });
      // while the line is still fading in nobody can see a jump, so take the new verdict outright
      // (shots often cut on the very line start, so the first probe may still show the last look)
      if (t - line.t < FADE_IN + 0.12) this.guard.reset(v);
      else this.guard.propose(v, now);
      this.accentOK = this.accentReads(L, o.palette);
    }
    this.guard.step(dt, now);
    if (o.style === 'auto') this.report(L, st.analysis);

    const alpha = Math.min(1, (t - line.t) / FADE_IN, 1 - (t - line.end) / FADE_OUT) * (1 - this.standDown);
    const sung = words.filter((w) => w.t <= t).length;
    const moving = L.medium === 'big' || L.medium === 'sparse' || L.medium === 'cutout';
    const pop = moving ? Math.round(Math.max(0, 1 - (t - (words[sung - 1]?.t ?? -9)) / 0.18) * 8) : 0;
    const an = st.analysis;
    const drop = L.auto ? dropMoment(an, o.t, o.audio) : false;
    this.energy += ((L.auto ? o.audio.energy : 0) - this.energy) * 0.12;
    const tick = L.auto ? `${drop}|${Math.floor(t * 30)}` : '';
    const drawKey = `${key}|${tick}|${sung}|${pop}|${Math.round(alpha * 20)}|${this.guard.key()}|${this.accentOK}|${o.palette.fg}${o.palette.accent}${o.palette.bg}`;
    if (drawKey !== this.lastKey) {
      this.lastKey = drawKey;
      const g = this.ctx;
      g.clearRect(0, 0, W, H);
      if (alpha > 0.01 && L.medium !== 'own') {
        if (L.cut) drawCutout(g, L.cut, L.moment === 'burst' ? L.cut.words.length : sung, pop / 8, Math.max(0, alpha));
        else if (L.auto) {
          drawBacking(g, L.auto.rows.slice(0, Math.max(1, rowsSung(L.auto, t))), this.guard, L.auto.size, W, alpha, L.i + 1);
          drawAuto(g, L.auto, t, Math.max(0, alpha), this.inks(o.palette, L), o.audio, Math.min(1, this.energy * 1.4), drop);
        } else if (L.sub) this.drawSub(L, sung, pop / 8, Math.max(0, alpha), W, o.palette);
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

  /** does the accent read over the box, with the backing the guard is heading for? */
  private accentReads(L: LineState, pal: Palette): boolean {
    if (this.probe.version <= 0) return false;
    const gd = this.guard;
    const cover = { none: 0.1, shadow: 0.42, soft: 0.62, band: 0.86, paper: 1 }[gd.backing];
    const st = L.stats ?? regionStats(this.probe, L.rect);
    return badShare(this.probe, L.rect, lumOf(hexRGB(pal.accent)), gd.plate, cover, L.target, st.edge) <= 0.08;
  }

  private inks(pal: Palette, L: LineState): Inks {
    const gd = this.guard;
    const bgL = L.stats ? coveredL(L.stats, gd) : 0.5;
    const alpha = 1;
    return {
      ink: css(gd.ink),
      accent: this.accentOK ? css(accentOr(hexRGB(pal.accent), gd.ink, bgL)) : css(gd.ink),
      accent2: css(accentOr(hexRGB(pal.accent2), gd.plate, bgL, 1.5)),
      shadow: (g, size) => applyShadow(g, gd, size, alpha),
    };
  }

  /** decide how line `li` is shown: medium, place, type; lay it out once */
  private plan(key: string, li: number, lines: LyricLine[], words: Word[], timed: boolean, style: LyricStyle, look: LyricProfile, carries: boolean, W: number, H: number, pal: Palette, an: TrackAnalysis | null): LineState {
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
      // moments bring their own medium: the giant word is big type, the burst is clippings
      if (moment === 'giant' && medium !== 'own') medium = 'big';
      if (moment === 'burst' && medium !== 'own') medium = 'cutout';
    } else {
      medium = style === 'auto' ? 'big' : style === 'big' ? 'big' : style === 'cutout' ? 'cutout' : 'subtitle';
      if (medium !== 'subtitle' && carries) medium = 'own';
    }
    const R = seeded(choice?.seed ?? li * 7919 + 1);
    const base: LineState = { key, i: li, medium, moment, choice, zone: 'middle', rect: { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.6 }, ladder: ladderFor(look), target: 3, inks: look.ink, stats: null, why };
    if (medium === 'own') return base;

    // placement: auto picks the calmest allowed zone for the medium (fixed styles keep their place)
    const pickZone = (m: Drawn, fixed: Zone): Zone => {
      const boxes = ZONE_BOX[m];
      if (style !== 'auto') return fixed;
      const cand = [...look.zones.filter((z) => boxes[z]), ...(Object.keys(boxes) as Zone[]).filter((z) => !look.zones.includes(z))];
      if (!cand.length) return fixed;
      if (this.probe.version <= 0) return cand[0];
      let best = cand[0];
      let bestScore = Infinity;
      cand.forEach((z, k) => {
        const v = judge(this.probe, boxes[z]!, { inks: this.inkList(look.ink, pal, null), target: m === 'subtitle' ? 4.5 : 3, ladder: ladderFor(look), pal });
        const score = v.level + v.bad * 3 + k * 0.35 + R() * 0.3;
        if (score < bestScore) {
          bestScore = score;
          best = z;
        }
      });
      return best;
    };
    let zone = pickZone(medium, medium === 'subtitle' ? 'bottom' : 'middle');
    // the picture is too busy for big type even with a plate: hand the line to paper or subtitles
    if (style === 'auto' && !moment && (medium === 'big' || medium === 'sparse') && this.probe.version > 0 && look.plate !== 'band') {
      const v = judge(this.probe, ZONE_BOX[medium][zone]!, { inks: this.inkList(look.ink, pal, null), target: 3, ladder: ladderFor(look), pal });
      if (v.level >= 3 || v.bad > 0.2) {
        medium = look.suits.cutout >= 0.3 ? 'cutout' : 'subtitle';
        why = 'the picture is too busy there for big type';
        zone = pickZone(medium, medium === 'subtitle' ? 'bottom' : 'middle');
      }
    }
    const L: LineState = { ...base, medium, zone, why };
    const box = px(ZONE_BOX[medium][zone] ?? ZONE_BOX[medium].middle ?? ZONE_BOX.subtitle.bottom!, W, H);
    const fam = style === 'auto' ? choice?.family : undefined;

    if (medium === 'cutout') {
      L.cut = buildCutout(
        g,
        words.map((w) => w.text),
        li,
        W,
        H,
        pal,
        moment === 'burst' ? { box: px({ x0: 0.04, y0: 0.08, x1: 0.96, y1: 0.92 }, W, H), scale: 1.35, burst: true } : { box },
      );
      L.rect = rectOf(L.cut.words.map((w) => ({ x: w.x, y: w.y - (w.cut.h * L.cut!.scale) / 2, w: w.cut.w * L.cut!.scale, h: w.cut.h * L.cut!.scale })), W, H) ?? L.rect;
    } else if (medium === 'subtitle' || (medium === 'big' && style !== 'auto')) {
      L.sub = this.layoutSub(words, medium === 'big', zone, box, W, H, fam);
      L.rect = rectOf(L.sub.boxes, W, H) ?? L.rect;
      L.target = medium === 'big' ? 3 : 4.5;
    } else {
      const tr = choice?.motion ?? treatmentFor(an).id;
      const style2 = styleFor(tr, fam, R());
      if (moment === 'giant') {
        const [w] = keyWords(words, 1);
        L.auto = buildAuto(g, [w ?? words[0]], timed, an, W, H, tr === 'tender' || tr === 'dreamy' ? tr : 'punchy', {
          style: { ...style2, weight: Math.max(style2.weight, 700) },
          box: px({ x0: 0.04, y0: 0.24, x1: 0.96, y1: 0.76 }, W, H),
          scale: 3.4,
          maxRows: 1,
        });
        L.ladder = ['none', 'shadow', 'band'];
        L.zone = 'middle';
      } else if (medium === 'sparse') {
        const n = words.length > 5 ? 2 : 1;
        L.auto = buildAuto(g, keyWords(words, n), timed, an, W, H, tr, { style: style2, box, align: zone === 'left' ? 'left' : zone === 'right' ? 'right' : 'center', scale: 0.85, maxRows: 2 });
        L.target = 3.5;
      } else {
        L.auto = buildAuto(g, words, timed, an, W, H, tr, { style: style2, box, align: zone === 'left' ? 'left' : zone === 'right' ? 'right' : 'center', scale: zone === 'middle' ? 1 : 0.9 });
      }
      L.rect = rectOf(L.auto.rows, W, H, 0.015) ?? L.rect;
    }
    // a new line starts invisible, so the guard can jump straight to what this box needs
    if (L.medium !== 'cutout' && this.probe.version > 0) {
      L.stats = regionStats(this.probe, L.rect);
      this.guard.reset(judge(this.probe, L.rect, { inks: this.inkList(L.inks, pal, L.stats), target: L.target, ladder: L.ladder, pal }));
      this.probed = this.probe.version;
      this.accentOK = this.accentReads(L, pal);
    }
    return L;
  }

  private layoutSub(words: Word[], big: boolean, zone: Zone, box: Box, W: number, H: number, family?: string): SubLayout {
    const g = this.ctx;
    const size = Math.round(big ? Math.min(H * 0.11, W * 0.075) : Math.max(13, Math.min(H * 0.045, W * 0.032)));
    const fam = family && FAMILY_FONTS[family] ? FAMILY_FONTS[family] : FONT;
    const weight = big ? 800 : family === 'serif' || family === 'typewriter' || family === 'mono' ? 500 : 600;
    const font = `${weight} ${size}px ${fam}`;
    g.font = font;
    const rows = wrap(g, words, (box.x1 - box.x0) * (big ? 1 : 1), big ? 3 : 2);
    const lh = size * (big ? 1.04 : 1.22);
    const space = g.measureText(' ').width;
    const blockH = lh * rows.length;
    const top = big ? box.y0 + (box.y1 - box.y0 - blockH) / 2 + size * 0.82 : zone === 'top' ? box.y0 + size * 0.9 : box.y1 - blockH + size * 0.6;
    const out: SubLayout = { size, font, rows: [], space, boxes: [] };
    rows.forEach((row, ri) => {
      const widths = row.map((w) => g.measureText(w.text).width);
      const rowW = widths.reduce((a, b) => a + b, 0) + space * (row.length - 1);
      const x = (W - rowW) / 2;
      const y = top + ri * lh;
      out.rows.push({ words: row, widths, x, y });
      out.boxes.push({ x, y: y - size * 0.82, w: rowW, h: size * 1.08 });
    });
    return out;
  }

  private drawSub(L: LineState, sung: number, pop: number, alpha: number, W: number, pal: Palette) {
    const g = this.ctx;
    const S = L.sub!;
    const big = L.medium === 'big';
    drawBacking(g, S.boxes, this.guard, S.size, W, alpha, L.i + 1);
    g.font = S.font;
    g.textBaseline = 'alphabetic';
    applyShadow(g, this.guard, S.size, alpha);
    const ink = css(this.guard.ink);
    const accent = this.accentOK ? css(accentOr(hexRGB(pal.accent), this.guard.ink, L.stats ? coveredL(L.stats, this.guard) : 0.5)) : ink;
    let idx = 0;
    for (const row of S.rows) {
      let x = row.x;
      row.words.forEach((w, wi) => {
        const isSung = idx < sung;
        const isCurrent = idx === sung - 1;
        let a: number;
        let color = ink;
        if (big) {
          a = isSung ? 1 : 0.16;
          if (isCurrent) color = accent;
        } else a = isSung ? 1 : 0.58;
        g.globalAlpha = a * alpha;
        g.fillStyle = color;
        if (big && isCurrent && pop > 0) {
          const s = 1 + 0.07 * pop;
          g.save();
          g.translate(x + row.widths[wi] / 2, row.y - S.size * 0.35);
          g.scale(s, s);
          g.fillText(w.text, -row.widths[wi] / 2, S.size * 0.35);
          g.restore();
        } else g.fillText(w.text, x, row.y);
        x += row.widths[wi] + S.space;
        idx++;
      });
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  }

  /**
   * How readable the line on screen is right now (for checks and the audit): the share of its box
   * where the ink, over the backing actually showing, misses the contrast target. null: nothing drawn.
   */
  legibilityNow(): { medium: Drawn; zone: Zone; moment: LyricMoment | null; backing: Backing; bad: number; why: string } | null {
    const L = this.line;
    if (!L || L.medium === 'own' || this.standDown > 0.5 || this.probe.version <= 0) return null;
    if (L.medium === 'cutout') return { medium: L.medium, zone: L.zone, moment: L.moment, backing: 'paper', bad: 0, why: L.why };
    const gd = this.guard;
    const cover = Math.max(gd.mix.soft * 0.62, gd.mix.band * 0.86, gd.mix.paper, gd.mix.shadow * 0.42);
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
      medium: L ? L.medium : null,
      moment: L?.moment ?? null,
      family: plan?.family ?? null,
      section: si >= 0 && an ? (LABEL[an.sections[si]?.label] ?? '') : '',
      why: L?.why ?? '',
      backing: L && L.medium !== 'own' && L.medium !== 'cutout' ? this.guard.backing : 'none',
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

/** rows of an auto layout that have at least one word sung (plates grow with the line) */
function rowsSung(L: AutoLayout, t: number): number {
  let n = 0;
  let lastY = -1;
  for (const w of L.words) {
    if (w.y !== lastY) {
      lastY = w.y;
      if (w.t <= t) n++;
      else break;
    }
  }
  return n;
}
