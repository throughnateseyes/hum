/**
 * A drawing standing in the place an inside shot shows: on its ground, between two of its layers, behind
 * everything, or on a side wall. It is a cut-out in the video's own colours, so it reads as part of the
 * painted world and not as a sticker: what is nearer hides it, it takes the light of the picture where it
 * stands, it casts a shadow where it stands on something, it stays where it is as the camera moves, and it
 * only changes on the beat.
 *
 * Where it stands is tried against what is really there, the way the words are (layout.ts), and it never
 * takes the words' room. Where nothing holds it there is no drawing: one that has to be laid over the
 * picture is worse than none.
 */
import * as THREE from 'three';
import type { ClipScene } from '../depth/types';
import type { DrawingAsset } from '../draw/types';
import { kindOf } from '../draw/kinds';
import { VARIANTS } from '../draw/pen';
import { EYE } from '../depth/types';
import { clampTo, shapeOfFrame, spotFor, STANDING_SIZE, type Spot, type Spots } from '../arrange/types';
import { clamp01, since } from '../shot/time';
import { keepFor, standing, type FrameBox } from './layout';
import { hides, mapAt, nearnessAt, project, unproject, type Crop, type Lens } from './place';
import type { InsidePalette } from './palettes';
import { DRAWN_FRAG, SHADOW_FRAG, WORD_VERT } from './shaders';
import { DRAWN_PUTS, type DrawnEnter, type DrawnPut, type DrawnSize, type HandPut } from './drawnIds';

/** a drawing a shot was given */
export interface Drawn {
  asset: DrawingAsset;
  put: HandPut;
  size: DrawnSize;
  enter: DrawnEnter;
  /** where the person put it */
  spots?: Spots;
  /** the shot opens its part: it arrives here (later shots of the part find it there) */
  arrives: boolean;
}

/** where it stands: its bottom-left corner, what its width runs along and what its height does */
export interface Seat {
  put: HandPut;
  o: [number, number, number];
  across: [number, number, number];
  up: [number, number, number];
  w: number;
  size: DrawnSize;
  score: number;
  /** how much of it shows */
  shown: number;
}

/** one being tried */
type Try = Omit<Seat, 'score' | 'shown' | 'size'>;

export interface SeatWhere {
  scene: ClipScene | null;
  lens: Lens;
  around: Lens[];
  times: number[];
  crop: Crop;
  aspect: number;
  margin: number;
  dice: number;
  /** room the words take, at any time of the shot */
  words: FrameBox[];
}

/** its height as a share of the frame's, before the place has its say */
const TALL: Record<DrawnSize, number> = { small: 0.27, medium: 0.4, large: 0.58 };
/** shorter than this it is a speck, and says nothing */
const LEAST_TALL = 0.23;
const BY_SIZE: DrawnSize[] = ['large', 'medium', 'small'];
/** tried in this order when the place asked for has no room */
const ELSE: Record<DrawnPut, DrawnPut[]> = {
  ground: ['ground', 'between', 'far'],
  between: ['between', 'far', 'ground'],
  far: ['far', 'between'],
  wall: ['wall', 'between', 'ground'],
};
const GRID = 9;

const roll = (n: number) => {
  const x = Math.sin(n * 91.3 + 17.1) * 43758.5453;
  return x - Math.floor(x);
};

/** where the drawing's silhouette is, roughly: the corners of its box are usually bare */
const weight = (a: number, b: number) => (Math.hypot((a - 0.5) * 2, (b - 0.5) * 2) < 1.08 ? 1 : 0.25);

function measure(o: SeatWhere, s: Try, lens: Lens, t: number) {
  const map = o.scene ? mapAt(o.scene, t) : null;
  let all = 0;
  let inside = 0;
  let shown = 0;
  let onWords = 0;
  let foot = 0;
  let against = 0;
  let foots = 0;
  const hid = [0, 0, 0];
  const all3 = [0, 0, 0];
  let x0 = 9;
  let x1 = -9;
  let y0 = 9;
  let y1 = -9;
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const a = (i + 0.5) / GRID;
      const b = (j + 0.5) / GRID;
      const k = weight(a, b);
      all += k;
      const q = project(lens, s.o[0] + s.across[0] * a + s.up[0] * b, s.o[1] + s.across[1] * a + s.up[1] * b, s.o[2] + s.across[2] * a + s.up[2] * b);
      if (q.w < 0.4) continue;
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y);
      y1 = Math.max(y1, q.y);
      if (q.x < o.margin * 0.6 || q.x > 1 - o.margin * 0.6 || q.y < o.margin * 0.4 || q.y > 1 - o.margin * 0.6) continue;
      inside += k;
      if (o.words.some((w) => q.x > w.x0 - 0.02 && q.x < w.x1 + 0.02 && q.y > w.y0 - 0.02 && q.y < w.y1 + 0.02)) onWords += k;
      const open = !(o.scene && map && hides(o.scene, nearnessAt(o.scene, map, o.crop, q.x, q.y), q.w));
      if (open) {
        shown += k;
        // it stands right in front of somebody: near enough to be read as laid over them
        if (j >= 3 && o.scene && map && o.scene.zScale / Math.max(0.001, nearnessAt(o.scene, map, o.crop, q.x, q.y)) < q.w * 1.7) against += k;
      }
      if (j < 2) {
        foots++;
        const third = Math.min(2, Math.floor(a * 3));
        all3[third]++;
        if (open) foot++;
        else hid[third]++;
      }
    }
  return { inside: inside / all, shown: shown / all, against: against / all, onWords: onWords / all, foot: foots ? foot / foots : 0, held: hid.filter((n, k) => all3[k] && n / all3[k] > 0.4).length >= 2, box: { x0, y0, x1, y1 } };
}

/** the distance at which flat ground lands on frame height fy */
function groundAt(l: Lens, fx: number, fy: number): number {
  let lo = 0.5;
  let hi = 3000;
  for (let k = 0; k < 44; k++) {
    const m = Math.sqrt(lo * hi);
    const x = unproject(l, fx, fy, m).x;
    if (project(l, x, 0, -m - l.ahead).y < fy) lo = m;
    else hi = m;
  }
  return Math.sqrt(lo * hi);
}

function facing(o: Pick<SeatWhere, 'lens' | 'aspect'>, put: HandPut, w: number, fx: number, fy: number, W: number, H: number): Try {
  const a = unproject(o.lens, fx - W / 2, fy, w);
  const b = unproject(o.lens, fx + W / 2, fy, w);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  // frame heights are the same length in the place either way
  const tall = (len * (H / (W * o.aspect)));
  return { put, o: [a.x, a.y, a.z], across: [ux * len, uy * len, 0], up: [-uy * tall, ux * tall, 0], w };
}

function candidates(o: SeatWhere, put: DrawnPut, ratio: number, size: DrawnSize): Try[] {
  const out: Try[] = [];
  const { scene, lens } = o;
  if (!scene) return out;
  const portrait = o.aspect < 0.9;
  const st = standing(scene);
  // in a tall frame a height is worth less width
  // and a thin thing needs more height to be as much of a thing
  const want = Math.min(0.72, TALL[size] * (portrait ? 0.78 : 1) * Math.max(1, (0.62 / ratio) ** 0.35));
  const widest = portrait ? 0.84 : 0.6;
  for (const k of [1, 0.88, 0.78, 1.14]) {
    let H = want * k;
    let W = (H * ratio) / o.aspect;
    if (W > widest) {
      H *= widest / W;
      W = widest;
    }
    // (a wide thing is as big as it is wide)
    if (H < LEAST_TALL * (portrait ? 0.75 : 1) && W < 0.3) continue;
    if (put === 'ground') {
      if (scene.ground < 0.06 || scene.sure.horizon < 0.3 || lens.vp.y < 0.18) return out;
      const top = lens.vp.y;
      for (const fy of [0.1, 0.16, 0.22, 0.3, 0.38, 0.46]) {
        if (fy > top - 0.045 || fy + H > 0.97) continue;
        for (const fx of [0.5, 0.36, 0.64, 0.26, 0.74, 0.18, 0.82]) {
          const w = groundAt(lens, fx, fy);
          if (w > 300) continue;
          out.push(facing(o, put, w, fx, fy, W, H));
        }
      }
    } else if (put === 'wall') {
      const vp = lens.vp;
      if (vp.x < -0.2 || vp.x > 1.2 || scene.sure.horizon < 0.3) return out;
      for (const side of [1, -1])
        for (const X of [2.4, 4, 7, 12])
          for (const edge of [0.9, 0.78, 0.66]) {
            const fx = side > 0 ? edge : 1 - edge;
            if ((fx - vp.x) * side < 0.12) continue;
            let lo = 0.5;
            let hi = 4000;
            for (let n = 0; n < 40; n++) {
              const m = Math.sqrt(lo * hi);
              if ((project(lens, side * X, EYE, -m - lens.ahead).x - fx) * side > 0) lo = m;
              else hi = m;
            }
            const zn = Math.sqrt(lo * hi);
            const one = project(lens, side * X, EYE + 1, -zn - lens.ahead).y - project(lens, side * X, EYE, -zn - lens.ahead).y;
            if (one <= 1e-5) continue;
            const tall = H / one;
            const len = tall * ratio;
            for (const y of [0.2, EYE * 0.6, EYE]) {
              if (side > 0) out.push({ put, o: [X, y, -zn - len - lens.ahead], across: [0, 0, len], up: [0, tall, 0], w: zn + len / 2 });
              else out.push({ put, o: [-X, y, -zn - lens.ahead], across: [0, 0, -len], up: [0, tall, 0], w: zn + len / 2 });
            }
          }
    } else {
      const zs = put === 'far' ? [st.far] : st.between;
      const big = put === 'far' ? 1.25 : 1;
      const h = Math.min(0.8, H * big);
      const wd = (h * ratio) / o.aspect;
      for (const w of zs) for (const fx of [0.5, 0.36, 0.64, 0.27, 0.73]) for (const fy of [0.1, 0.2, 0.3, 0.42, 0.54, 0.66]) if (fy + h < 0.96 && wd < 0.9) out.push(facing(o, put, w, fx, fy, wd, h));
    }
  }
  return out;
}

/**
 * The standings worth trying for a drawing of this shape, best first (none: the place has none): where and
 * as big as it was asked for, then smaller there, then elsewhere. A few of each, apart from one another, so
 * words that can't live with one may with the next.
 */
export function seats(put: DrawnPut, ratio: number, size: DrawnSize, o: SeatWhere): Seat[] {
  if (!o.scene || !mapAt(o.scene, o.times[0])) return [];
  const out: Seat[] = [];
  for (const kind of ELSE[put].filter((p) => DRAWN_PUTS.includes(p)))
    for (const s of BY_SIZE.slice(BY_SIZE.indexOf(size))) {
      out.push(...seatsAt(kind, ratio, s, o));
      if (out.length > 6) return out;
    }
  return out;
}

/** where the middle of a seat is across the frame, about */
const middle = (b: FrameBox) => (b.x0 + b.x1) / 2;

/** the best of one kind and size: the best there is, and the best well to its side */
export function seatsAt(kind: DrawnPut, ratio: number, size: DrawnSize, o: SeatWhere): Seat[] {
  if (!o.scene || !mapAt(o.scene, o.times[0])) return [];
  const found: { seat: Seat; at: number }[] = [];
  {
    candidates(o, kind, ratio, size).forEach((c, i) => {
      const r = measure(o, c, o.lens, o.times[0]);
      if (r.inside < 0.97 || r.shown < 0.64 || r.onWords > 0.06) return;
      // what stands on the ground is seen to stand on it, and not through somebody
      if (kind === 'ground' && (r.foot < 0.75 || r.shown < 0.72)) return;
      // on a wall it is seen side on: never so side on that it is a sliver
      if (kind === 'wall' && (r.shown < 0.7 || (r.box.x1 - r.box.x0) * o.aspect < (r.box.y1 - r.box.y0) * ratio * 0.42 || r.box.x1 - r.box.x0 < 0.1)) return;
      // what faces the camera is held by something: its foot, along most of its width, is behind what is nearer, or it
      // stands on the ground at its own distance. Nothing hangs in mid-air
      const landed = !!o.scene && o.scene.ground > 0.06 && o.scene.sure.horizon > 0.3 && Math.abs(c.o[1]) < Math.hypot(...c.up) * 0.07;
      const held = kind === 'ground' || kind === 'wall' || r.held || landed;
      if (!held) return;
      let shown = r.shown;
      let inside = r.inside;
      let onWords = r.onWords;
      o.around.forEach((l, k) => {
        const s = measure(o, c, l, o.times[k + 1]);
        shown = Math.min(shown, s.shown + 0.06);
        inside = Math.min(inside, s.inside);
        onWords = Math.max(onWords, s.onWords);
      });
      if (shown < 0.52 || inside < (kind === 'wall' || kind === 'ground' ? 0.6 : 0.85) || onWords > 0.12) return;
      const { box } = r;
      const cx = (box.x0 + box.x1) / 2;
      const area = Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
      const behind = 1 - r.shown;
      // something crossing in front of it is what puts it in the place; off the middle sits better
      const score = r.shown * 0.5 + (behind > 0.05 && behind < 0.4 ? 0.5 : 0) + Math.min(0.4, area) * 1.1 + (Math.abs(Math.abs(cx - 0.5) - 0.17) < 0.08 ? 0.14 : 0) - r.onWords * 2 - (kind === 'wall' ? 0 : r.against * 0.8) + (shown - r.shown) * 0.5 + (inside - 1) * 0.6 + roll(o.dice * 13 + i) * 0.1;
      found.push({ seat: { ...c, size, score, shown: r.shown }, at: middle(box) });
    });
  }
  found.sort((a, b) => b.seat.score - a.seat.score);
  const best = found[0];
  if (!best) return [];
  const aside = found.find((f) => Math.abs(f.at - best.at) > 0.2);
  return aside ? [best.seat, aside.seat] : [best.seat];
}

/* ───────── by hand ───────── */

/** how far ahead what is laid in front of everything stands (nothing hides it, so only its looks matter) */
const IN_FRONT = 4;

/** the spot a drawing was given in this shape of frame, or the one it would have laid in front (null: the shot finds it one) */
export function spotOf(d: Pick<Drawn, 'put' | 'size' | 'spots'>, ratio: number, aspect: number): Spot | null {
  const shape = shapeOfFrame(aspect, 1);
  const at = spotFor(d.spots, shape);
  if (!at) return d.put === 'front' ? { x: 0.74, y: 0.6, size: TALL[d.size] * Math.min(1, aspect) } : null;
  if (at.of === shape) return at.spot;
  // placed in another shape of frame: as big beside the frame's short side, and inside its margins
  const of = { wide: 16 / 9, square: 1, tall: 9 / 16 }[at.of];
  const k = keepFor(aspect);
  let H = at.spot.size * (Math.min(1, aspect) / Math.min(1, of));
  H *= Math.min(1, (1 - k.side * 2) / ((H * ratio) / aspect), (1 - k.head - k.foot) / H);
  const W = (H * ratio) / aspect;
  return { x: clampTo([k.side + W / 2, 1 - k.side - W / 2], at.spot.x), y: clampTo([k.head + H / 2, 1 - k.foot - H / 2], at.spot.y), size: H };
}

/** where a drawing stands when its spot was chosen for it: exactly there, whatever is in the way */
export function handSeat(put: HandPut, spot: Spot, ratio: number, size: DrawnSize, o: SeatWhere): Seat {
  const { lens, scene } = o;
  const H = clampTo(STANDING_SIZE, spot.size);
  const W = (H * ratio) / o.aspect;
  const fx = spot.x;
  let fy = 1 - spot.y - H / 2;
  const seat = (t: Try): Seat => ({ ...t, size, score: 1, shown: t.put === 'front' ? 1 : measure(o, t, lens, o.times[0]).shown });
  if (!scene || put === 'front') return seat(facing(o, 'front', IN_FRONT, fx, fy, W, H));
  if (put === 'ground' && lens.vp.y > 0.1) {
    // its foot is on the ground, so it can go no higher than where the ground ends
    fy = Math.min(fy, lens.vp.y - 0.03);
    return seat(facing(o, put, Math.min(400, groundAt(lens, fx, fy)), fx, fy, W, H));
  }
  if (put === 'wall') {
    const on = onWall(o, fx, 1 - spot.y, H, ratio);
    if (on) return seat(on);
  }
  const st = standing(scene);
  if (put === 'far') return seat(facing(o, 'far', st.far, fx, fy, W, H));
  // behind the nearest there is to stand behind with it still seen, else wherever it is seen most
  const all = (st.between.length ? st.between : [st.far]).map((w) => seat(facing(o, 'between', w, fx, fy, W, H)));
  return all.find((s) => s.shown > 0.45 && s.shown < 0.97) ?? all.sort((a, b) => b.shown - a.shown)[0];
}

/** flat along a side wall, with its middle on a frame point */
function onWall(o: SeatWhere, fx: number, fy: number, H: number, ratio: number): Try | null {
  const { lens } = o;
  const { vp } = lens;
  if (Math.abs(fx - vp.x) < 0.07) return null;
  const side = fx > vp.x ? 1 : -1;
  let best: { t: Try; score: number } | null = null;
  for (const X of [2.4, 4, 7, 12]) {
    let lo = 0.8;
    let hi = 4000;
    for (let n = 0; n < 40; n++) {
      const m = Math.sqrt(lo * hi);
      if ((project(lens, side * X, EYE, -m - lens.ahead).x - fx) * side > 0) lo = m;
      else hi = m;
    }
    const zc = Math.sqrt(lo * hi);
    const at = project(lens, side * X, EYE, -zc - lens.ahead);
    const one = project(lens, side * X, EYE + 1, -zc - lens.ahead).y - at.y;
    if (one <= 1e-5) continue;
    const tall = H / one;
    const len = Math.min(tall * ratio, zc * 1.5);
    const near = zc - len / 2;
    const y = EYE + (fy - at.y) / one - tall / 2;
    const t: Try = side > 0 ? { put: 'wall', o: [X, y, -near - len - lens.ahead], across: [0, 0, len], up: [0, tall, 0], w: zc } : { put: 'wall', o: [-X, y, -near - lens.ahead], across: [0, 0, -len], up: [0, tall, 0], w: zc };
    const r = measure(o, t, lens, o.times[0]);
    const wide = ((r.box.x1 - r.box.x0) * o.aspect) / Math.max(1e-6, (r.box.y1 - r.box.y0) * ratio);
    const score = r.shown + Math.min(0.6, wide);
    if (!best || score > best.score) best = { t, score };
  }
  return best?.t ?? null;
}

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/** the cut-out's colours: one paper, one line and the video's accents, so every drawing of it is one set */
export function cutOut(p: InsidePalette): { paper: string; ink: string; a: string; b: string; c: string } {
  const light = lum(p.paper) >= lum(p.ink);
  const paper = light ? p.paper : p.ink;
  const ink = light ? p.ink : p.paper;
  const strong = p.accents.filter((x) => x !== paper && x !== ink && Math.abs(lum(x) - lum(ink)) > 0.14);
  const a = strong[0] ?? p.steps[0].field;
  const b = strong[1] ?? p.steps[0].light;
  return { paper, ink, a, b, c: strong[2] ?? b };
}

const backOut = (x: number) => {
  const k = clamp01(x) - 1;
  return 1 + 2.2 * k * k * k + 1.2 * k * k;
};

const unit = new THREE.PlaneGeometry(1, 1);
/** room round the drawing in its own picture, for the cut-out's edge and the wobble */
const PAD = 0.07;
const LONGEST = 1100;
const LEAST = 260;
const DRAW_FPS = 24;

type MakeMaterial = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => THREE.ShaderMaterial;

/** the drawing, standing at its seat */
export class DrawnInPlace {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private readonly mat: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly shadow: THREE.ShaderMaterial | null = null;
  private readonly pool: THREE.Mesh | null = null;
  private readonly colours: ReturnType<typeof cutOut>;
  private readonly seconds: number;
  private key = '';

  constructor(
    readonly drawn: Drawn,
    public seat: Seat,
    palette: InsidePalette,
    make: MakeMaterial,
    private readonly o: { start: number; beat: number; kicks: number[]; jump: number; px: number; ratio: number },
  ) {
    this.colours = cutOut(palette);
    this.seconds = kindOf(drawn.asset.kind)?.seconds(drawn.asset.data) ?? 1;
    const tall = Math.min(LONGEST, Math.max(LEAST, Math.ceil(o.px * 1.15)));
    const wide = Math.min(LONGEST, Math.max(LEAST * 0.5, Math.ceil(tall * o.ratio)));
    this.canvas.width = Math.ceil(wide * (1 + PAD * 2));
    this.canvas.height = Math.ceil(tall * (1 + PAD * 2));
    const t = new THREE.CanvasTexture(this.canvas);
    t.premultiplyAlpha = true;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.colorSpace = THREE.NoColorSpace;
    this.texture = t;
    this.mat = make(WORD_VERT, DRAWN_FRAG, { tText: { value: t }, uAlpha: { value: 1 }, uLight: { value: 0.6 }, uHide: { value: seat.put === 'front' ? 0 : 1 } });
    this.mesh = new THREE.Mesh(unit, this.mat);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = seat.put === 'front' ? 7 : seat.put === 'far' ? 2.5 : 3.5;
    if (seat.put === 'front') this.mat.depthTest = false;
    if (seat.put === 'ground') {
      const s = (this.shadow = make(WORD_VERT, SHADOW_FRAG, { uAlpha: { value: 0 } }));
      const m = (this.pool = new THREE.Mesh(unit, s));
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      m.renderOrder = 2.2;
      this.group.add(m);
    }
    this.group.add(this.mesh);
  }

  /** `bare`: how much of the picture is left as it is (the light on it shows more then); `fade`: 1 when the shot is letting go */
  update(t: number, bare: number, fade: number) {
    const { start, beat, kicks, jump } = this.o;
    const tau = t - start;
    const { enter, arrives } = this.drawn;
    // it arrives on the shot's first beat, and is all there by its third
    const drawing = arrives && enter === 'draw';
    const rising = arrives && enter === 'rise';
    const over = Math.min(Math.max(beat * 1.5, 0.5), Math.max(0.6, this.seconds * 0.6), 2.2);
    const progress = drawing ? Math.floor(clamp01((tau + 0.04) / over) * over * DRAW_FPS) / Math.max(1, Math.floor(over * DRAW_FPS)) : 1;
    const up = rising ? backOut(tau / Math.max(0.28, beat * 0.75)) : 1;
    const beats = Math.max(0, Math.floor(tau / beat + 1e-3));
    this.paint(Math.min(1, progress), beats);

    const s = this.seat;
    const hop = jump > 0.1 ? 1 + 0.045 * jump * Math.exp(-since(kicks, t) / (beat * 0.3)) : 1;
    // it leans a hair the other way each beat, so a still drawing is alive and still keeps time
    const lean = (jump > 0.1 ? 0.012 : 0.006) * (beats % 2 ? 1 : -1);
    const across = new THREE.Vector3(...s.across);
    const high = new THREE.Vector3(...s.up).multiplyScalar(Math.max(0.001, up) * hop);
    const foot = new THREE.Vector3(...s.o).addScaledVector(across, 0.5);
    high.addScaledVector(across, lean);
    const centre = foot.clone().addScaledVector(high, 0.5);
    const k = 1 + PAD * 2;
    this.mesh.matrix.makeBasis(across.multiplyScalar(k), high.multiplyScalar(k), new THREE.Vector3(0, 0, 1)).setPosition(centre);
    const on = (rising && tau < 0 ? 0 : 1) * (1 - fade);
    this.mat.uniforms.uAlpha.value = on;
    this.mat.uniforms.uLight.value = 0.22 + 0.5 * bare;
    if (this.pool) {
      // a flat pool on the ground under its feet, a little behind them
      const len = Math.hypot(...s.across);
      this.pool.matrix.makeBasis(new THREE.Vector3(len * 1.15, 0, 0), new THREE.Vector3(0, 0, -len * 0.5), new THREE.Vector3(0, 1, 0)).setPosition(s.o[0] + s.across[0] / 2, 0.015, s.o[2] - len * 0.06);
    }
    if (this.shadow) this.shadow.uniforms.uAlpha.value = 0.5 * on * clamp01(drawing ? progress * 1.4 - 0.3 : up);
    this.group.visible = on > 0.003;
  }

  private paint(progress: number, beats: number) {
    const { asset } = this.drawn;
    const wobble = beats % VARIANTS;
    const key = `${progress.toFixed(3)}|${wobble}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const px = (W * PAD) / (1 + PAD * 2);
    const py = (H * PAD) / (1 + PAD * 2);
    const { paper, ink, a, b, c } = this.colours;
    kindOf(asset.kind)?.paint(g, asset.data, {
      seed: asset.seed,
      hand: asset.style.hand,
      boil: wobble,
      progress,
      box: { x: px, y: py, w: W - px * 2, h: H - py * 2 },
      inks: { ink, a, b, c },
      colour: asset.style.colour,
      paper,
      stand: true,
      fat: Math.min(1.9, Math.max(1.1, 620 / H)),
      // the paper inside its shapes; a wide edge round it is what a sticker has
      halo: { colour: paper, width: 3 },
    });
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 0;
  }
}
