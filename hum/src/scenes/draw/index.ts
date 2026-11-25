/**
 * Sketchbook: the drawings made for this song (src/draw), drawing themselves in time with it.
 *
 *   one      one large drawing per part, drawn across a bar or so, with the sung words held beside it
 *   page     a page that fills: several drawings, one after another, until the page is full
 *   pinned   a board of cards that moves on from drawing to drawing on the bar, each drawn as it arrives
 *
 * The words are part of the picture (`showsLyrics`), so the lyrics never sit on a drawing. Everything is
 * worked out from the song time, so seeking and exporting always give the same frame; only a small lift on
 * the kick follows the live sound, and it is off with Bounce at 0.
 */
import * as THREE from 'three';
import { isHandId, type HandId } from '../../draw/format';
import { inkOn, inksOn, mixHex, luminance } from '../../draw/inks';
import { kindOf } from '../../draw/kinds';
import { hash } from '../../draw/pen';
import { drawingNow, drawingsHere } from '../../draw/session';
import type { DrawingAsset } from '../../draw/types';
import { createFullscreenQuad } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { bool, num, str } from '../../core/uniforms';
import { ensureLyricFont, lyricFontVersion } from '../../render/lyricFonts';
import { LEAD, showingAt, showings, type Showing } from '../../render/lyricTiming';
import { partWordsAt } from '../../state/direction';
import { songCredit } from '../../state/songName';
import { useStudio } from '../../state/store';
import { deal, fitIn, inset, pageOf, PAGE_MAX, ratioOf, safeBox, secondsOf, shapeOf, spanAt, splitOf, steady, sungIn, type Box, type Placed, type Span, type Split } from './layout';
import { Sprite } from './sprite';
import { FACE_FOR, setLine, setFace, type SetLine, type TimedWord, type TypeFace } from './type';

const params: ParamDef[] = [
  {
    id: 'layout',
    label: 'Layout',
    type: 'select',
    default: 'one',
    options: [
      { value: 'one', label: 'One drawing' },
      { value: 'page', label: 'A page' },
      { value: 'pinned', label: 'Pinned up' },
    ],
  },
  {
    id: 'hand',
    label: 'Drawn with',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'As drawn' },
      { value: 'pen', label: 'Pen' },
      { value: 'brush', label: 'Brush' },
      { value: 'marker', label: 'Marker' },
      { value: 'pencil', label: 'Pencil' },
    ],
  },
  {
    id: 'colour',
    label: 'Colour patches',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'As drawn' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Ink only' },
    ],
  },
  { id: 'words', label: 'Words', type: 'bool', default: true, hint: 'The sung words, or the part’s own words, set beside the drawings' },
  { id: 'names', label: 'Names under drawings', type: 'bool', default: false },
  { id: 'arrange', label: 'Arrangement', type: 'number', min: 0, max: 20, step: 1, default: 0, hint: 'The same look laid out another way' },
  { id: 'weight', label: 'Line weight', type: 'number', min: 0.6, max: 1.8, step: 0.05, default: 1 },
  { id: 'bounce', label: 'Bounce', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'A small lift on each kick' },
];

const PAPER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uBg, uInk;
uniform vec2 uRes;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 p = vUv * uRes / min(uRes.x, uRes.y);
  // a sheet: slow tone, a fine tooth, a few fibres
  float tone = vn(p * 2.3) * 0.6 + vn(p * 6.1 + 4.0) * 0.4 - 0.5;
  float tooth = vn(p * 420.0) - 0.5;
  float fibre = smoothstep(0.86, 1.0, vn(vec2(p.x * 190.0 + vn(p * 9.0) * 20.0, p.y * 24.0)));
  vec3 c = mix(uBg, uInk, clamp(0.012 + tone * 0.022 + tooth * 0.022 + fibre * 0.016, 0.0, 0.06));
  gl_FragColor = vec4(c, 1.0);
}
`;
const PAPER_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** steps per second a drawing grows at, and how often it wobbles at the smooth setting */
const GROW_FPS = 24;
const SMOOTH_WOBBLE = 8;
/** how long a line stays up after it is sung, while nothing follows it (s) */
const HOLD = 2.6;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (u: number) => u * u * (3 - 2 * u);

/** everything the picture depends on at one moment */
interface Now {
  t: number;
  W: number;
  H: number;
  bar: number;
  list: DrawingAsset[];
  shows: Showing[];
  span: Span;
  dealt: DrawingAsset[];
  paper: string;
  boilFps: number;
  f: FrameContext;
  lift: number;
}

export const sketchbook: SceneDef = {
  id: 'sketchbook',
  name: 'Sketchbook',
  description: 'The drawings made for this song, drawing themselves by hand in time with it, with the sung words set beside them. One large drawing for each part, a page that fills up, or a board of pinned cards that moves on with the bar.',
  category: 'form',
  style: 'print',
  tags: ['hand-drawn', 'personal', 'tender', 'nostalgic', 'indie', 'folk', 'acoustic', 'playful', 'graphic', 'lyrics', 'story'],
  usesDrawings: true,
  showsLyrics: true,
  light: true,
  // already drawn by hand: the hand-drawn finish would trace its lines a second time
  prefersClean: true,
  handInks: 4,
  params,
  create() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
    const paperMat = new THREE.ShaderMaterial({ vertexShader: PAPER_VERT, fragmentShader: PAPER, uniforms: { uBg: { value: new THREE.Color() }, uInk: { value: new THREE.Color() }, uRes: { value: new THREE.Vector2(1, 1) } }, depthTest: false, depthWrite: false });
    const quad = createFullscreenQuad(paperMat);
    const sprites: Sprite[] = [];
    let used = 0;
    const next = (): Sprite => {
      let s = sprites[used];
      if (!s) {
        s = new Sprite(geo);
        sprites.push(s);
        scene.add(s.mesh);
      }
      s.mesh.renderOrder = used;
      used++;
      return s;
    };

    /* ───────── one drawing on a sprite ───────── */

    const handOf = (d: DrawingAsset, f: FrameContext): HandId => {
      const h = str(f.params, 'hand', 'auto');
      return isHandId(h) ? h : d.style.hand;
    };
    const colourOf = (d: DrawingAsset, f: FrameContext): boolean => {
      const c = str(f.params, 'colour', 'auto');
      return c === 'auto' ? d.style.colour : c === 'on';
    };

    /** how much of it is drawn, in steps, so it grows like frames on paper and never repaints for nothing */
    const grown = (p: Placed, t: number) => clamp01((Math.floor((t - p.t0) * GROW_FPS) / GROW_FPS) / Math.max(0.2, p.dur));
    const boilOf = (d: DrawingAsset, n: Now) => (d.kind === 'pen' ? Math.floor((n.t + hash(d.seed, 5) * 2) * n.boilFps) : 0);

    const paintDrawing = (g: CanvasRenderingContext2D, d: DrawingAsset, n: Now, box: Box, progress: number, paper: string, tooth: number) => {
      const kind = kindOf(d.kind);
      if (!kind || progress <= 0) return;
      const px = Math.max(box.w, box.h);
      // a small drawing keeps a line that reads: its strokes get a little heavier
      const fat = num(n.f.params, 'weight', 1) * (px < 420 ? 1 + (420 - px) / 700 : 1);
      kind.paint(g, d.data, { seed: d.seed, hand: handOf(d, n.f), boil: boilOf(d, n), progress, box, inks: inksOn(paper, n.f.palette), colour: colourOf(d, n.f), paper, fat, tooth });
    };
    const inkKey = (n: Now, paper: string) => `${paper}${n.f.palette.fg}${n.f.palette.accent}${n.f.palette.accent2}${n.f.palette.muted}`;
    const drawKey = (d: DrawingAsset, n: Now, progress: number, paper: string) =>
      `${d.id}|${handOf(d, n.f)}|${colourOf(d, n.f)}|${progress <= 0 ? 'none' : `${progress.toFixed(4)}|${boilOf(d, n)}`}|${num(n.f.params, 'weight', 1)}|${inkKey(n, paper)}`;

    /** put a placed drawing on the frame, its name under it when asked for */
    const show = (p: Placed, n: Now, o: { grow?: number; name?: number } = {}) => {
      const progress = grown(p, n.t);
      if (progress <= 0) return;
      // room round the box: the pen overshoots
      const pad = Math.max(p.box.w, p.box.h) * 0.06;
      const w = Math.round(p.box.w + pad * 2);
      const h = Math.round(p.box.h + pad * 2);
      const s = next();
      const name = o.name && progress >= 0.72 ? o.name : 0;
      s.paint(`${drawKey(p.d, n, progress, n.paper)}|${w}x${h}|${name.toFixed(1)}|${name ? lyricFontVersion() : ''}`, w, h, (g, scale) => {
        paintDrawing(g, p.d, n, { x: pad, y: pad, w: p.box.w, h: p.box.h - name * 1.7 }, progress, n.paper, scale);
        if (name) caption(g, p.d.name, pad + p.box.w / 2, pad + p.box.h - name * 0.35, name, inkOn(n.paper, n.f.palette), p.box.w + pad);
      });
      const k = (o.grow ?? 1) * (1 + n.lift);
      s.put(p.box.x + p.box.w / 2, p.box.y + p.box.h / 2, w * k, h * k, p.turn);
    };

    const caption = (g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, ink: string, room: number) => {
      const face = FACE_FOR.pencil;
      setFace(g, face, size);
      const w = g.measureText(text).width;
      if (w > room) setFace(g, face, (size * room) / w);
      g.textAlign = 'center';
      g.fillStyle = ink;
      g.fillText(text, x, y);
      g.textAlign = 'left';
    };

    /* ───────── words ───────── */

    /** who shows the sung words: this picture, the lyric layer over it, or nobody */
    const wordsBy = (n: Now): 'here' | 'layer' | 'none' => {
      const st = useStudio.getState();
      if (!bool(n.f.params, 'words', true)) return st.lyricsOnBoards === 'show' || st.lyricStyle === 'subtitle' ? (n.shows.length && st.lyricStyle !== 'off' ? 'layer' : 'none') : 'none';
      if (ownWords(n)) return 'here';
      if (!n.shows.length) return n.f.text.trim() ? 'here' : 'none';
      if (st.lyricStyle === 'off') return 'none';
      return st.lyricsOnBoards === 'show' || st.lyricStyle === 'subtitle' ? 'layer' : 'here';
    };
    const ownWords = (n: Now) => {
      const st = useStudio.getState();
      return !!partWordsAt(st, n.t) || !!st.text.trim();
    };

    /** the words up at time t: what is being sung, or the part's own */
    const wordsNow = (n: Now): TimedWord[] => {
      const typed = n.shows.length && !ownWords(n) ? '' : n.f.text.trim();
      if (typed) {
        const parts = typed.split(/\s+/).slice(0, 16);
        const step = Math.min(0.28, (n.span.end - n.span.start) / (parts.length * 3));
        return parts.map((text, i) => ({ text, t: n.span.start + 0.15 + i * step }));
      }
      // a line is held until the next one, or for a breath: the page never empties between lines
      const i = showingAt(n.shows, n.t + LEAD);
      const up = i >= 0 ? n.shows[i] : null;
      if (!up || n.t > up.end + HOLD) return [];
      return up.words.map((w) => ({ text: w.text, t: w.t }));
    };

    /** one word that carries the line: the drawing's own when it is sung, else its longest */
    const held = (words: TimedWord[], d: DrawingAsset | undefined): TimedWord[] => {
      if (words.length < 2) return words;
      const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
      const own = d && words.find((w) => d.words.includes(bare(w.text)));
      const w = own ?? words.reduce((m, x) => (bare(x.text).length >= bare(m.text).length ? x : m));
      return [{ text: w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), t: w.t }];
    };

    const showWords = (set: SetLine | null, face: TypeFace, n: Now) => {
      if (!set) return;
      // the words come on as they are sung; a word is there or not there
      const on = set.words.filter((w) => n.t >= w.t - 0.02).length;
      if (!on) return;
      const pad = set.size * 0.2;
      const w = Math.ceil(set.box.w + pad * 2);
      const h = Math.ceil(set.box.h + pad * 2);
      const ink = inkOn(n.paper, n.f.palette);
      const s = next();
      s.paint(`type|${set.words.map((x) => x.text).join(' ')}|${on}|${set.size.toFixed(1)}|${w}x${h}|${ink}|${face.family}${face.weight}${face.italic ? 'i' : ''}|${lyricFontVersion()}`, w, h, (g) => {
        setFace(g, face, set.size);
        g.fillStyle = ink;
        for (const x of set.words.slice(0, on)) g.fillText(x.text, x.x - set.box.x + pad, x.y - set.box.y + pad);
      });
      s.put(set.box.x - pad + w / 2, set.box.y - pad + h / 2, w, h);
    };

    /* ───────── the three layouts ───────── */

    /** room for the pictures when the lyric layer writes over this look: its subtitles sit low */
    const clearOfLayer = (b: Box, n: Now): Box => (wordsBy(n) === 'layer' ? { ...b, h: b.h - n.H * 0.17 } : b);
    const least = (n: Now) => Math.min(n.W, n.H);

    function one(n: Now) {
      const d = n.dealt[0];
      if (!d) return;
      const face = FACE_FOR[handOf(d, n.f)];
      const by = wordsBy(n);
      const v = n.span.order + Math.round(num(n.f.params, 'arrange', 0));
      const len = n.span.end - n.span.start;
      // the drawing takes about a bar, or as long as it needs, and is done well before the part is
      const dur = Math.min(Math.max(n.bar, secondsOf(d)), len * 0.62, 4.2);
      const turn = (hash(d.seed, 21, n.span.order) - 0.5) * 0.06;
      const push = 1 + 0.035 * smooth(clamp01((n.t - n.span.start) / Math.max(1, len))) - 0.0175;
      if (by !== 'here') {
        const room = inset(clearOfLayer(safeBox(n.W, n.H), n), 0.05);
        show({ d, box: fitIn(room, ratioOf(d)), turn, t0: n.span.start, dur }, n, { grow: push });
        return;
      }
      const wide = shapeOf(n.W, n.H) === 'wide';
      const split: Split = splitOf(n.W, n.H, v, wide ? 0.56 : 0.68, ratioOf(d));
      const room = inset(split.art, 0.045);
      show({ d, box: fitIn(room, ratioOf(d)), turn, t0: n.span.start, dur }, n, { grow: push });
      const words = wordsNow(n);
      const single = v % 3 === 2 && words.length <= 9;
      const say = single ? held(words, d) : words;
      // the more room the drawing leaves, the larger the words
      const spare = clamp01((wide ? split.words.w / n.W : split.words.h / n.H) / 0.4);
      showWords(setLine(say, split.words, face, least(n) * (single ? 0.27 : 0.11 + 0.06 * spare), single ? 1 : wide ? 5 : 4, split.align, split.valign), face, n);
    }

    function page(n: Now) {
      const len = n.span.end - n.span.start;
      const count = Math.max(1, Math.min(PAGE_MAX, n.dealt.length, Math.max(2, Math.round(len / 1.9))));
      const set = n.dealt.slice(0, count);
      const face = FACE_FOR[handOf(set[0], n.f)];
      const by = wordsBy(n);
      const seed = steady(n.span.order, count, Math.round(num(n.f.params, 'arrange', 0)));
      const wide = shapeOf(n.W, n.H) === 'wide';
      const split = by === 'here' ? splitOf(n.W, n.H, wide ? n.span.order % 2 : 0, wide ? 0.7 : 0.79) : null;
      const region = split ? split.art : clearOfLayer(safeBox(n.W, n.H), n);
      const name = bool(n.f.params, 'names', false) ? Math.max(11, least(n) * 0.026) : 0;
      const placed = pageOf(set, region, seed, name);
      // one after another across the first two thirds, each beginning on a beat
      const beat = n.bar / 4;
      const gap = Math.max(beat, Math.round((len * 0.64) / placed.length / beat) * beat);
      placed.forEach((p, i) => {
        const t0 = n.span.start + i * Math.min(gap, (len * 0.8) / placed.length);
        show({ d: p.d, box: p.box, turn: p.turn, t0, dur: Math.min(secondsOf(p.d), Math.max(0.7, gap * 1.15)) }, n, { name });
      });
      if (split) showWords(setLine(wordsNow(n), split.words, face, least(n) * (wide ? 0.09 : 0.08), wide ? 5 : 2, split.align, wide ? 'middle' : split.valign), face, n);
    }

    function pinned(n: Now) {
      const wide = shapeOf(n.W, n.H) === 'wide';
      const by = wordsBy(n);
      const all = n.dealt;
      const face = FACE_FOR[handOf(all[0], n.f)];
      const split = by === 'here' ? splitOf(n.W, n.H, wide ? (n.span.order % 2) : 0, wide ? 0.62 : 0.74) : null;
      const region = split ? split.art : clearOfLayer(safeBox(n.W, n.H), n);
      // the board moves on every bar or two, landing on the bar
      const step = Math.max(n.bar, Math.ceil(2 / n.bar) * n.bar);
      const len = n.span.end - n.span.start;
      const last = Math.max(0, Math.floor((len - 0.35) / step));
      const at = Math.min(last, Math.max(0, Math.floor((n.t - n.span.start) / step)));
      const into = n.t - n.span.start - at * step;
      const move = at === 0 ? 0 : 1 - (1 - clamp01(into / 0.55)) ** 3;
      const pos = at === 0 ? 0 : at - 1 + move;
      const side = Math.min(region.w, region.h) * 0.94;
      const card = { w: side * (wide ? 1 : 0.92), h: side * (wide ? 0.92 : 1) };
      const gap = (wide ? card.h : card.w) * 1.1;
      const mid = { x: region.x + region.w / 2, y: region.y + region.h / 2 };
      const light = luminance(n.paper) > 0.25;
      const white = light ? mixHex(n.paper, '#ffffff', 0.62) : mixHex(n.paper, '#ffffff', 0.075);
      const inks = inksOn(n.paper, n.f.palette);
      // three papers, so the board isn't one stack of the same card
      const sheets = [white, mixHex(white, inks.b, 0.16), mixHex(white, inkOn(n.paper, n.f.palette), 0.055)];
      // what is sung while a card is up is on it; otherwise the next one round
      const order: DrawingAsset[] = [];
      const sung = sungIn(n.list, n.shows, n.span.start, n.span.end);
      for (let k = 0; k <= last; k++) {
        const from = n.span.start + k * step;
        const here = sungIn(n.list, n.shows, from - step * 0.4 + 0.5, from + step * 0.6 + 0.3).filter((d) => d !== order[k - 1]);
        const lately = order.slice(-Math.min(all.length - 1, 3));
        const rest = all.filter((d) => !lately.includes(d));
        const unsung = rest.filter((d) => !sung.includes(d) && !order.includes(d));
        order.push(here.find((d) => !lately.includes(d)) ?? here[0] ?? unsung[0] ?? rest.find((d) => !order.includes(d)) ?? rest[k % Math.max(1, rest.length)] ?? all[0]);
      }
      for (let k = Math.max(0, Math.floor(pos) - 1); k <= Math.min(last, Math.ceil(pos) + 1); k++) {
        const d = order[k];
        const off = (k - pos) * gap;
        const sway = (hash(d.seed, 31, k) - 0.5) * side * 0.06;
        const turn = (hash(d.seed, 33, k) - 0.5) * 0.085;
        const x = wide ? mid.x + sway : mid.x + off;
        const y = wide ? mid.y + off : mid.y + sway;
        const t0 = n.span.start + k * step + (k ? 0.12 : 0);
        // the card takes after its drawing
        const r = Math.min(1.25, Math.max(0.8, ratioOf(d)));
        const size = r >= 1 ? { w: card.w, h: card.h / Math.sqrt(r) } : { w: card.w * Math.sqrt(r), h: card.h };
        pin(d, n, { x, y, ...size }, turn, t0, Math.min(secondsOf(d), step * 0.72), sheets[Math.floor(hash(d.seed, 39, n.span.order) * 3)], k);
      }
      if (split) showWords(setLine(wordsNow(n), split.words, face, least(n) * (wide ? 0.1 : 0.09), wide ? 5 : 3, split.align, split.valign), face, n);
    }

    /** one card on the board: a sheet with its shadow, a strip of tape, and the drawing on it */
    const pin = (d: DrawingAsset, n: Now, c: Box, turn: number, t0: number, dur: number, sheet: string, k: number) => {
      const progress = grown({ d, box: c, turn, t0, dur }, n.t);
      const pad = Math.max(c.w, c.h) * 0.09;
      const w = Math.round(c.w + pad * 2);
      const h = Math.round(c.h + pad * 2);
      const s = next();
      const name = bool(n.f.params, 'names', false) ? Math.max(11, least(n) * 0.026) : 0;
      s.paint(`card|${k}|${drawKey(d, n, progress, sheet)}|${w}x${h}|${sheet}|${name}|${name ? lyricFontVersion() : ''}`, w, h, (g, scale) => {
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.2)';
        g.shadowBlur = pad * 0.34 * scale;
        g.shadowOffsetY = pad * 0.12 * scale;
        g.fillStyle = sheet;
        g.fillRect(pad, pad, c.w, c.h);
        g.restore();
        const box = inset({ x: pad, y: pad, w: c.w, h: c.h - name * 1.6 }, 0.1);
        paintDrawing(g, d, n, box, progress, sheet, scale);
        if (name && progress > 0.72) caption(g, d.name, pad + c.w / 2, pad + c.h - name, name, inkOn(sheet, n.f.palette), c.w * 0.9);
        // tape
        g.save();
        g.translate(pad + c.w * (0.5 + (hash(d.seed, 35, k) - 0.5) * 0.3), pad);
        g.rotate((hash(d.seed, 37, k) - 0.5) * 0.3);
        g.globalAlpha = 0.86;
        g.fillStyle = inksOn(n.paper, n.f.palette).b;
        g.fillRect(-c.w * 0.075, -c.w * 0.02, c.w * 0.15, c.w * 0.04);
        g.restore();
      });
      const z = 1 + n.lift;
      s.put(c.x, c.y, w * z, h * z, turn);
    };

    /* ───────── a frame ───────── */

    /** no drawings (deleted, or not allowed here): the page carries the words, or the song's name */
    const blank = (n: Now) => {
      const st = useStudio.getState();
      const sung = wordsBy(n) === 'here' ? wordsNow(n) : [];
      const { title } = songCredit(st);
      const words = sung.length || wordsBy(n) === 'layer' || !bool(n.f.params, 'words', true) ? sung : title.split(/\s+/).filter(Boolean).slice(0, 8).map((text, i) => ({ text, t: n.span.start + i * 0.2 }));
      const face = FACE_FOR.pen;
      showWords(setLine(words, safeBox(n.W, n.H), face, Math.min(n.W, n.H) * 0.16, 4, 'center', 'middle'), face, n);
    };

    const nowOf = (f: FrameContext): Now => {
      const st = useStudio.getState();
      const t = Math.max(0, f.audio.time);
      const a = f.analysis;
      const bpm = a && a.bpm > 30 ? a.bpm : 110;
      // a "bar" of about two seconds, whatever the tempo is counted in
      let bar = 240 / bpm;
      while (bar < 1.25) bar *= 2;
      while (bar > 3.4) bar /= 2;
      const secs = a?.sections ?? [];
      const looks = st.planOn && st.plan?.looks.length === secs.length ? st.plan.looks : null;
      // pen drawings; a line figure joins them only where the person asked for it
      const all = drawingsHere(st);
      const list = all.filter((d) => d.kind === 'pen');
      const shows = st.lyrics?.synced && st.lyrics.lines.length ? showings(st.lyrics.lines) : [];
      const layout = str(f.params, 'layout', 'one');
      const span = spanAt(t, secs, (i, j) => !!looks && looks[i] === looks[j], bar, layout !== 'one');
      const dealt = deal(list, span, shows, st.drawParts, (id) => drawingNow(id, all));
      const fps = st.hand.fps;
      // the long layouts begin with what is sung first; a page also keeps the order it is sung in
      if (layout === 'page' && !sungIn(list, shows, span.start, span.end).length) dealt.sort((x, y) => hash(x.seed, span.order) - hash(y.seed, span.order));
      return { t, W: f.width, H: f.height, bar, list, shows, span, dealt, paper: f.palette.bg, boilFps: fps < 60 ? fps : SMOOTH_WOBBLE, f, lift: num(f.params, 'bounce', 0.35) * f.audio.kick * 0.022 };
    };

    return {
      async prepare() {
        // a render waits for the lettering, so its first frame is set in the right face
        if (typeof document === 'undefined' || !document.fonts) return;
        await Promise.all(Object.values(FACE_FOR).map((x) => document.fonts.load(`${x.italic ? 'italic ' : ''}${x.weight} 48px ${x.family}`).catch(() => []))).catch(() => undefined);
      },
      render(f, target) {
        for (const x of Object.values(FACE_FOR)) ensureLyricFont(x.family);
        used = 0;
        const n = nowOf(f);
        if (n.dealt.length) {
          const layout = str(f.params, 'layout', 'one');
          if (layout === 'page') page(n);
          else if (layout === 'pinned') pinned(n);
          else one(n);
        } else blank(n);
        for (let i = used; i < sprites.length; i++) sprites[i].hide();
        paperMat.uniforms.uBg.value.set(n.paper);
        paperMat.uniforms.uInk.value.set(inkOn(n.paper, f.palette));
        paperMat.uniforms.uRes.value.set(f.width, f.height);
        quad.render(f.renderer, target);
        camera.right = f.width;
        camera.bottom = f.height;
        camera.updateProjectionMatrix();
        const auto = f.renderer.autoClear;
        f.renderer.autoClear = false;
        f.renderer.setRenderTarget(target);
        f.renderer.render(scene, camera);
        f.renderer.autoClear = auto;
      },
      dispose() {
        for (const s of sprites) s.dispose();
        geo.dispose();
        quad.dispose();
        paperMat.dispose();
      },
    };
  },
};

export const scenes: SceneDef[] = [sketchbook];
