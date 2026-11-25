/**
 * Drawings laid over the picture: the ones the person placed by hand (src/arrange), and the small ones
 * beside the words.
 *
 * A small drawing beside the words: when a lyric that has one is sung, it draws itself next to the line,
 * and goes when the line goes.
 *
 * When each one shows is worked out for the whole song from the lyrics and the drawings (cues), in song
 * time, so seeking and exporting agree. Where it sits is worked out from the box the lyric layer has laid
 * the line in: the largest free stretch of the safe area beside, above or below it, never touching the
 * words' own room and never outside the margins. With no room worth using there is no drawing.
 */
import * as THREE from 'three';
import { arranging, noteThing, trialOf, type Thing } from '../arrange/things';
import { clampTo, cornerAt, DRAWING_SIZE, shapeOfFrame, spotFor, type Hidden, type Spot } from '../arrange/types';
import { audioEngine } from '../audio/engine';
import type { Palette } from '../core/types';
import type { KeepOut } from '../render/legibility';
import { safeInsets } from '../render/lyricSpace';
import { showingAt, showings, type Showing } from '../render/lyricTiming';
import { belongsTo, ratioOf, secondsOf, shapeOf, type Box } from '../scenes/draw/layout';
import { Sprite } from '../scenes/draw/sprite';
import { getScene } from '../scenes';
import type { StudioState } from '../state/store';
import { inkOn, inksOn } from './inks';
import { kindOf } from './kinds';
import { drawPartAt } from './parts';
import { hash } from './pen';
import { drawingNow, drawingsHere } from './session';
import { lineKey, type DrawingAsset, type DrawPart } from './types';

/** the same drawing doesn't come back sooner than this (s) */
const REST = 8;
/** a line shorter than this on screen has no time for a drawing (s) */
const LEAST = 1.1;
/** the room kept round the words, and the smallest and largest drawing, as shares of the frame's short side */
const AWAY = 0.04;
const SMALLEST = 0.15;
const LARGEST = 0.36;
const FADE = 0.16;
const GROW_FPS = 24;
const SMOOTH_WOBBLE = 8;

export interface Cue {
  d: DrawingAsset;
  /** which showing (lyricTiming.showings) it belongs to */
  showing: number;
  t0: number;
  end: number;
}

/** when each drawing comes up: one to a line, on the word that calls for it */
export function cuesFor(shows: Showing[], list: DrawingAsset[], parts: DrawPart[], hidden: Hidden[] = []): Cue[] {
  const last = new Map<string, number>();
  const out: Cue[] = [];
  shows.forEach((s, i) => {
    if (s.end - s.t < LEAST || drawPartAt(parts, (s.t + s.end) / 2)?.off) return;
    if (hidden.some((h) => Math.min(h.to, s.end) - Math.max(h.from, s.t) > (h.to - h.from) * 0.5)) return;
    let best: Cue | null = null;
    let bestScore = 0;
    for (const d of list) {
      if (!belongsTo(d, s)) continue;
      const word = s.words.find((w) => d.words.includes(lineKey(w.text)));
      const since = s.t - (last.get(d.id) ?? -1e9);
      if (since < REST) continue;
      // a word of its own beats the line as a whole; one not seen for longer beats one just gone
      const score = (word ? 2 : 1) + Math.min(1, since / 60) * 0.5;
      if (score <= bestScore) continue;
      // a word too near the end of its line starts early enough to be seen
      const t0 = Math.max(s.t, Math.min(word ? word.t : s.t + 0.1, s.end - LEAST));
      best = { d, showing: i, t0, end: s.end };
      bestScore = score;
    }
    if (best) {
      out.push(best);
      last.set(best.d.id, s.t);
    }
  });
  return out;
}

/**
 * Where a drawing of this shape goes beside words in `words` (pixels, y down): in the free strip round them
 * that shows it largest, close to the line rather than lost in the middle of the strip.
 */
export function besideWords(words: Box, ratio: number, W: number, H: number, seed: number): Box | null {
  const s = safeInsets(W, H);
  const least = Math.min(W, H);
  const away = least * AWAY;
  const safe: Box = { x: s.l, y: s.t, w: W - s.l - s.r, h: H - s.t - s.b };
  const x1 = safe.x + safe.w;
  const y1 = safe.y + safe.h;
  const strips: { side: 'above' | 'below' | 'left' | 'right'; box: Box }[] = [
    { side: 'above', box: { x: safe.x, y: safe.y, w: safe.w, h: words.y - away - safe.y } },
    { side: 'below', box: { x: safe.x, y: words.y + words.h + away, w: safe.w, h: y1 - words.y - words.h - away } },
    { side: 'left', box: { x: safe.x, y: safe.y, w: words.x - away - safe.x, h: safe.h } },
    { side: 'right', box: { x: words.x + words.w + away, y: safe.y, w: x1 - words.x - words.w - away, h: safe.h } },
  ];
  // the wobble and the halo reach a little past the drawing, and it sits a touch askew
  const give = 1.12;
  const large = least * LARGEST * (shapeOf(W, H) === 'tall' ? 1.2 : 1);
  let best: { side: string; box: Box; score: number } | null = null;
  for (const { side, box } of strips) {
    if (box.w <= 0 || box.h <= 0) continue;
    const w = Math.min(box.w / give, (box.h / give) * ratio, large * Math.sqrt(ratio), large * 1.25);
    const h = w / ratio;
    if (Math.max(w, h) < least * SMALLEST) continue;
    const upDown = side === 'above' || side === 'below';
    // a little off the line's middle, the same way every time
    const lean = (hash(seed, 41) - 0.5) * 0.5;
    const mid = upDown ? words.x + words.w * (0.5 + lean) : words.y + words.h * (0.5 + lean);
    const room = (a: number, z: number, at: number, size: number) => Math.min(z - size, Math.max(a, at - size / 2));
    const at = upDown
      ? { x: room(box.x, box.x + box.w, mid, w * give) + (w * (give - 1)) / 2, y: side === 'above' ? box.y + box.h - h * (1 + (give - 1) / 2) : box.y + (h * (give - 1)) / 2 }
      : { x: side === 'left' ? box.x + box.w - w * (1 + (give - 1) / 2) : box.x + (w * (give - 1)) / 2, y: room(box.y, box.y + box.h, mid, h * give) + (h * (give - 1)) / 2 };
    const score = Math.sqrt(w * h) + (side === 'above' ? least * 0.02 : 0);
    if (!best || score > best.score) best = { side, box: { ...at, w, h }, score };
  }
  return best?.box ?? null;
}

interface Up {
  id: string;
  d: DrawingAsset;
  t0: number;
  end: number;
  box: Box;
  /** how it lies, askew */
  turn: number;
  drawn: boolean;
}

/** the box of a drawing this shape, its middle on the spot (pixels) */
export function boxOn(spot: Spot, ratio: number, W: number, H: number, inside = false): Box {
  const long = clampTo(DRAWING_SIZE, spot.size) * Math.min(W, H);
  const w = ratio >= 1 ? long : long * ratio;
  const h = w / ratio;
  return { ...cornerAt(spot, { w, h }, W, H, inside), w, h };
}

export class DrawOverlay {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
  private geo = new THREE.PlaneGeometry(1, 1);
  private sprites = new Map<string, Sprite>();
  private memo: { lines: unknown; list: DrawingAsset[]; parts: DrawPart[]; hidden: Hidden[]; shows: Showing[]; cues: Map<number, Cue> } | null = null;
  private placed: { key: string; box: Box | null } = { key: '', box: null };
  private up: Up[] = [];
  private frame = { t: 0, W: 1, H: 1, palette: null as Palette | null, fps: SMOOTH_WOBBLE };

  /**
   * Before anything draws: which drawings are up at song time t, and where? Gives back the words' keep-out
   * grown to take in one beside them, so pop-ups and windows stay off it too.
   */
  prepare(s: StudioState, t: number, W: number, H: number, keep: KeepOut): KeepOut {
    this.up = [];
    this.frame = { t, W, H, palette: s.palette, fps: s.hand.fps < 60 ? s.hand.fps : SMOOTH_WOBBLE };
    this.byHand(s, t, W, H);
    return this.beside(s, t, W, H, keep);
  }

  /** the ones the person placed */
  private byHand(s: StudioState, t: number, W: number, H: number) {
    if (!s.placed.drawings.length || !s.planOn || audioEngine.kind !== 'file') return;
    const list = drawingsHere(s);
    const shape = shapeOfFrame(W, H);
    for (const p of s.placed.drawings) {
      if (t < p.from || t >= p.to) continue;
      const d = drawingNow(p.drawing, list);
      const at = spotFor(p.spots, shape);
      if (!d || !at) continue;
      const key = `placed:${p.id}`;
      const held = trialOf(key);
      const spot = held ?? at.spot;
      const ratio = ratioOf(d);
      const box = boxOn(spot, ratio, W, H, !held && at.of !== shape);
      this.up.push({ id: p.id, d, t0: p.from, end: p.to, box, turn: 0, drawn: p.enter === 'draw' });
      noteThing({ key, kind: 'placed', name: d.name, box: rectOf(box, W, H), spot, from: p.from, to: p.to, hand: true, ratio, ref: p.drawing });
    }
  }

  /** the one beside the words */
  private beside(s: StudioState, t: number, W: number, H: number, keep: KeepOut): KeepOut {
    const list = s.drawOverlay ? drawingsHere(s) : [];
    if (!list.length || !keep.now || !s.lyrics?.synced || getScene(s.sceneId)?.usesDrawings || getScene(s.sceneId)?.usesFigures) return keep;
    const lines = s.lyrics.lines;
    const { hidden } = s.placed;
    let m = this.memo;
    if (!m || m.lines !== lines || m.list !== list || m.parts !== s.drawParts || m.hidden !== hidden) {
      const shows = showings(lines);
      m = this.memo = { lines, list, parts: s.drawParts, hidden, shows, cues: new Map(cuesFor(shows, list, s.drawParts, hidden).map((c) => [c.showing, c])) };
    }
    const i = showingAt(m.shows, t);
    const cue = m.cues.get(i);
    if (!cue || t < cue.t0 || t >= cue.end) return keep;
    const r = keep.now;
    const words: Box = { x: r.x0 * W, y: r.y0 * H, w: (r.x1 - r.x0) * W, h: (r.y1 - r.y0) * H };
    const key = `${cue.d.id}|${cue.showing}|${W}x${H}|${[words.x, words.y, words.w, words.h].map((v) => Math.round(v / 4)).join(',')}`;
    const ratio = ratioOf(cue.d);
    if (this.placed.key !== key) this.placed = { key, box: besideWords(words, ratio, W, H, cue.d.seed + cue.showing) };
    let box = this.placed.box;
    if (!box) return keep;
    const name = `beside:${cue.showing}`;
    const held = trialOf(name);
    if (held) box = boxOn(held, ratio, W, H);
    this.up.push({ id: 'beside', d: cue.d, t0: cue.t0, end: cue.end, box, turn: (hash(cue.d.seed, 43, cue.showing) - 0.5) * 0.09, drawn: true });
    if (arranging()) {
      const spot = { x: (box.x + box.w / 2) / W, y: (box.y + box.h / 2) / H, size: Math.max(box.w, box.h) / Math.min(W, H) };
      noteThing({ key: name, kind: 'beside', name: cue.d.name, box: rectOf(box, W, H), spot, from: cue.t0, to: cue.end, hand: !!held, ratio, ref: cue.d.id });
    }
    if (held) return keep;
    return {
      ...keep,
      now: { x0: Math.min(r.x0, box.x / W), y0: Math.min(r.y0, box.y / H), x1: Math.max(r.x1, (box.x + box.w) / W), y1: Math.max(r.y1, (box.y + box.h) / H) },
    };
  }

  /** draw them over what is there (just before the words) */
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    const { W, H, palette } = this.frame;
    for (const [id, sp] of this.sprites)
      if (!this.up.some((u) => u.id === id)) {
        this.scene.remove(sp.mesh);
        sp.dispose();
        this.sprites.delete(id);
      }
    if (!this.up.length || !palette) return;
    let any = false;
    this.up.forEach((u, k) => {
      if (this.paint(u, k, palette)) any = true;
    });
    if (!any) return;
    this.camera.right = W;
    this.camera.bottom = H;
    this.camera.updateProjectionMatrix();
    const auto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(target);
    r.render(this.scene, this.camera);
    r.autoClear = auto;
  }

  private paint(u: Up, order: number, palette: Palette): boolean {
    const { t, fps } = this.frame;
    const { d, box } = u;
    const kind = kindOf(d.kind);
    if (!kind) return false;
    let sprite = this.sprites.get(u.id);
    if (!sprite) {
      sprite = new Sprite(this.geo);
      this.sprites.set(u.id, sprite);
      this.scene.add(sprite.mesh);
    }
    sprite.mesh.renderOrder = order;
    const dur = Math.min(secondsOf(d), Math.max(0.5, (u.end - u.t0) * 0.55));
    const progress = u.drawn ? Math.min(1, Math.floor((t - u.t0) * GROW_FPS) / GROW_FPS / dur) : 1;
    if (progress <= 0) {
      sprite.hide();
      return false;
    }
    // only the pen's line wobbles: a figure is repainted while it is built, then left
    const boil = d.kind === 'pen' ? Math.floor((t + hash(d.seed, 5) * 2) * fps) : 0;
    const pad = Math.max(box.w, box.h) * 0.08;
    const w = Math.round(box.w + pad * 2);
    const h = Math.round(box.h + pad * 2);
    const ink = inkOn(palette.bg, palette);
    const inks = { ...inksOn(palette.bg, palette), ink };
    sprite.paint(`${d.id}|${w}x${h}|${progress.toFixed(4)}|${boil}|${palette.bg}${ink}${inks.a}${inks.b}${inks.c}`, w, h, (g, scale) => {
      kind.paint(g, d.data, {
        seed: d.seed,
        hand: d.style.hand,
        boil,
        progress,
        box: { x: pad, y: pad, w: box.w, h: box.h },
        inks,
        colour: d.style.colour,
        paper: palette.bg,
        fat: 1.25,
        tooth: scale,
        // a clear edge in the paper colour: the line reads over any picture
        halo: { colour: palette.bg, width: 13 },
      });
    });
    const alpha = Math.min(1, Math.max(0, (u.end - t) / FADE));
    sprite.put(box.x + box.w / 2, box.y + box.h / 2, w, h, u.turn, alpha);
    return true;
  }

  dispose() {
    for (const s of this.sprites.values()) s.dispose();
    this.sprites.clear();
    this.geo.dispose();
  }
}

const rectOf = (b: Box, W: number, H: number): Thing['box'] => ({ x0: b.x / W, y0: b.y / H, x1: (b.x + b.w) / W, y1: (b.y + b.h) / H });
