/**
 * One inside shot: the clip as a place, with the words being sung standing in it. It decides once what
 * the shot is made of (its moment's recipe, the arrangement number, what the clip has: sky, ground,
 * layers, a way ahead), then draws any song time from that alone, so seeking and frame-by-frame renders
 * give the same picture.
 */
import * as THREE from 'three';
import type { ClipScene } from '../depth/types';
import type { MomentId } from '../moments';
import { arranging, noteThing, noteWords, standingKey, trialOf } from '../arrange/things';
import type { Spot } from '../arrange/types';
import { kindOf } from '../draw/kinds';
import { clamp01, dice, since, smooth } from '../shot/time';
import { DrawnInPlace, handSeat, seats, seatsAt, spotOf, type Drawn, type Seat, type SeatWhere } from './drawn';
import { DRAWN_PUTS, DRAWN_SIZES, type DrawnPut, type DrawnSize, type HandPut, type Room } from './drawnIds';
import type { FormId, FormWish } from './formIds';
import { Forms } from './forms';
import { spotAt } from './spot';
import { noteSeat } from './seated';
import { chunksOf, keepFor, place, standing, type Keep, type Chunk, type FrameBox, type Put, type SungWord } from './layout';
import type { InsidePalette } from './palettes';
import type { Finish, InsidePass, Paint } from './pass';
import { notePush } from './reading';
import { cropOf, goesAhead, lens, mapAt, nearnessAt, project, pushCentre, unproject, type Crop, type Lens } from './place';
import { insideFor, type ActId, type ExtraId, type InsideRecipe, type PaintId, type PutId } from './recipes';
import { FLAT_FRAG, FLAT_VERT, MAX_LETTERS, RAYS_FRAG, RIBBON_FRAG, RIBBON_VERT, WORD_FRAG, WORD_VERT, FULLSCREEN_VERT } from './shaders';
import { SceneLines, strokeMaterial } from './sceneLines';
import { advance, setWord } from './words';

export interface InsideSpec {
  scene: ClipScene | null;
  clipAspect: number;
  aspect: number;
  start: number;
  end: number;
  beat: number;
  kicks: number[];
  snares: number[];
  hats?: number[];
  /** where bars count from */
  partStart: number;
  energy: number;
  moment?: MomentId;
  layout: number;
  arrive: 'hit' | 'cold';
  leave: 'ramp' | 'settle' | 'cut';
  palette: InsidePalette;
  /** two brightness levels that split the clip in three */
  cuts: [number, number];
  /** words sung in the shot, or the ones to set when nothing is sung */
  words: SungWord[];
  /** the words are being sung (they appear on time), rather than set for the whole shot */
  sung: boolean;
  /** nothing is sung here, and the line before is over: no subtitle either */
  hush?: boolean;
  /** which second of the clip is on screen at song time t */
  clipAt: (t: number) => number;
  focus: { x: number; y: number };
  zoom: number;
  flip: boolean;
  /** how far the shot's camera has pushed in at song time t (1: not at all) */
  growAt?: (t: number) => number;
  /** the director's choices over the recipe's */
  paint?: PaintId;
  put?: PutId;
  extras?: ExtraId[];
  acts?: ActId[];
  /** a drawing that stands in this shot */
  drawn?: Drawn | null;
  /** a form that stands in this shot, or is pulled out of it (forms.ts) */
  form?: FormWish | null;
}

interface WordMesh {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  from: number;
  letters: number;
}
interface Standing {
  chunk: Chunk;
  put: Put;
  words: WordMesh[];
  group: THREE.Group;
  /** how much of what is behind it is the far field, 0..1 */
  far: number;
}

const outCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const outQuint = (x: number) => 1 - (1 - clamp01(x)) ** 5;
const backOut = (x: number) => {
  const k = clamp01(x) - 1;
  return 1 + 2.4 * k * k * k + 1.4 * k * k;
};
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
/** the light of a field, kept far enough from the word that stands on it */
const lights = new Map<string, string>();
function lightFor(s: { field: string; light: string; word: string }): string {
  const key = s.field + s.light + s.word;
  const had = lights.get(key);
  if (had) return had;
  const f = new THREE.Color(s.field);
  const c = new THREE.Color(s.light);
  const w = lum(s.word);
  let out = s.light;
  for (let k = 0; k < 8 && Math.abs(lum(out) - w) < Math.min(0.34, Math.abs(lum(s.field) - w)); k++) out = `#${c.lerp(f, 0.22).getHexString()}`;
  lights.set(key, out);
  return out;
}
/** 1 for a colour whose word is darker than it: everything it paints stays light behind the word */
const airyOf = (s: { field: string; word: string }) => (lum(s.field) - lum(s.word) > 0.18 ? 1 : 0);
/** whether words that make room for a drawing (`round`) still read well: plainly, or about as they did without it (`alone`) */
function stillRead(round: Put[], alone: Put[]): boolean {
  return round.length === alone.length && round.every((p, i) => p.score > Math.min(1, alone[i].score * 0.68));
}
/** how wide a drawing is for its height */
export function ratioOf(d: Pick<Drawn, 'asset'>): number {
  const size = kindOf(d.asset.kind)?.size(d.asset.data) ?? { w: 1, h: 1 };
  return Math.min(2.6, Math.max(0.35, size.w / size.h));
}
const unit = new THREE.PlaneGeometry(1, 1);
const post = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
const blend = { transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide } as const;

export class InsideShot {
  readonly place = new THREE.Scene();
  private readonly recipe: InsideRecipe;
  private readonly paintKind: PaintId;
  private readonly extras: Set<ExtraId>;
  /** a quiet shot with nothing sung in it */
  private readonly bare: boolean;
  private readonly rnd: () => number;
  private readonly crop: Crop;
  private readonly keep: Keep;
  /** the frame room the words that are up take, before the push */
  private readonly boxes: FrameBox[] = [];
  private readonly clip0: number;
  private readonly standing: Standing[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly posts: { m: THREE.Mesh; side: number; i: number }[] = [];
  private readonly streaks: THREE.Mesh[] = [];
  private readonly ribbons: { m: THREE.Mesh; mat: THREE.ShaderMaterial; i: number; w: number }[] = [];
  private readonly lines: THREE.Mesh[] = [];
  private drawing: DrawnInPlace | null = null;
  private form: Forms | null = null;
  /** lines along what the clip really has */
  private own: SceneLines | null = null;
  private rays: THREE.ShaderMaterial | null = null;
  /** the size of the place: how far ahead its middle is */
  private readonly span: number;
  private readonly stepOffset: number;
  private cuts2: { far: number; near: number };
  private built = false;

  constructor(
    private readonly pass: InsidePass,
    readonly spec: InsideSpec,
  ) {
    const s = spec;
    this.recipe = insideFor(s.moment, s.energy);
    this.rnd = dice(s.layout + 41);
    // with nothing sung in it, a quiet shot still has the far field and a ribbon to carry it
    const bare = !s.sung && this.recipe.paint[0] === 'none';
    this.bare = bare;
    const paints = (bare ? (['far', 'deep'] as PaintId[]) : this.recipe.paint).filter((p) => this.can(p));
    this.paintKind = s.paint && this.can(s.paint) ? s.paint : (paints[(s.layout >> 3) % Math.max(1, paints.length)] ?? 'none');
    this.extras = new Set(s.extras ?? (bare ? (['ribbons'] as ExtraId[]) : this.recipe.with));
    this.crop = cropOf(s.clipAspect, s.aspect, s.focus, s.zoom, s.flip);
    this.keep = keepFor(s.aspect);
    this.clip0 = s.clipAt(s.start);
    const st = standing(s.scene);
    this.span = Math.min(60, Math.max(8, st.between[0] ?? st.far * 0.3));
    this.stepOffset = (s.layout >> 5) % s.palette.steps.length;
    const sp = s.scene?.splits ?? [];
    this.cuts2 = { far: s.scene && s.scene.sky > 0.06 ? 0.055 : Math.sqrt(sp[0] ?? 0.02), near: Math.sqrt(sp[sp.length - 1] ?? 0.35) };
    if (this.cuts2.near <= this.cuts2.far) this.cuts2.near = this.cuts2.far + 0.2;
  }

  private can(p: PaintId): boolean {
    const c = this.spec.scene;
    if (!c) return p === 'none' || p === 'all';
    if (p === 'far') return c.sky > 0.06 || c.splits.length > 0;
    if (p === 'figure') return c.near > 0.04 && c.splits.length > 0;
    if (p === 'deep') return c.splits.length > 0;
    return true;
  }

  private lensAt(t: number): Lens {
    return lens(this.spec.scene, this.spec.clipAspect, this.spec.clipAt(t), this.clip0, this.crop);
  }

  /** how far the picture is pushed in at song time t, before any kick or cut adds to it */
  private steady(t: number, grow = this.spec.growAt?.(t) ?? 1): number {
    const s = this.spec;
    return 1 + (Math.max(1, grow) - 1) * 0.3 + (s.kicks.length && this.recipe.jump > 0.3 ? 0 : 0.05 * smooth(0, Math.max(3, s.end - s.start), t - s.start));
  }

  /** stand everything in the place (on the first frame drawn: it needs the clip's depth) */
  private build() {
    this.built = true;
    const s = this.spec;
    const chunks = this.chunks();
    const { puts, seat } = this.arrange(chunks, s.drawn ? { put: s.drawn.put, size: s.drawn.size, ratio: ratioOf(s.drawn), spot: spotOf(s.drawn, ratioOf(s.drawn), s.aspect) } : null);
    chunks.forEach((chunk, i) => this.standing.push(this.stand(chunk, puts[i])));
    if (s.drawn && seat) this.addDrawing(s.drawn, seat);
    if (s.drawn && s.scene) noteSeat(s.partStart, s.drawn.put, s.drawn.size, !!seat);
    this.addForm();
    this.addOwn();
    if (this.extras.has('rays')) this.addRays();
    if (this.extras.has('lines')) this.addLines();
    if (this.extras.has('posts')) this.addPosts();
    if (this.extras.has('ribbons')) this.addRibbons(s.moment === 'release' || s.moment === 'fury' ? 5 : 3);
    if (this.extras.has('streaks')) this.addStreaks();
  }

  private material(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}): THREE.ShaderMaterial {
    const { tNear, uRes, uZScale, tFootage, uCrop } = this.pass.place;
    const m = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { tNear, uRes, uZScale, tFootage, uCrop, ...uniforms }, ...blend, depthWrite: false, ...extra });
    this.mats.push(m);
    return m;
  }

  private stand(chunk: Chunk, put: Put): Standing {
    const group = new THREE.Group();
    group.visible = false;
    const { block } = put;
    const o = new THREE.Vector3(...put.o);
    const across = new THREE.Vector3(...put.across);
    const up = new THREE.Vector3(...put.up);
    const words: WordMesh[] = [];
    block.lines.forEach((line, li) => {
      const cap = block.caps[li];
      const full = advance(line.words.map((w) => w.text).join(' '), line.stretch);
      for (const w of line.words) {
        const set = setWord(w.text, line.stretch);
        const width = Math.min(1 - w.x, set.ratio / full);
        const bx = w.x - (set.bleed * cap * width) / (set.ratio * cap || 1);
        const sx = width * (1 + (2 * set.bleed) / set.ratio);
        const by = block.bases[li] - set.bleed * cap;
        const sy = cap * (1 + 2 * set.bleed);
        const edges = Array.from({ length: MAX_LETTERS }, (_, k) => set.edges[k] ?? 2);
        const mat = this.material(WORD_VERT, WORD_FRAG, {
          tText: { value: set.texture },
          uColor: { value: new THREE.Color() },
          uAlpha: { value: 1 },
          uShade: { value: put.kind === 'ground' ? 1 : put.kind === 'wall' ? 0 : 0 },
          uBleed: { value: set.bleed / (1 + 2 * set.bleed) },
          uBleedX: { value: set.bleed / (set.ratio + 2 * set.bleed) },
          uEdges: { value: edges },
          uShow: { value: new Array(MAX_LETTERS).fill(0) },
          uHide: { value: put.score > 0 ? 1 : 0 },
          tBed: this.pass.place.tBed,
          uAround: { value: new THREE.Color() },
        });
        const mesh = new THREE.Mesh(unit, mat);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = put.kind === 'ground' ? 2 : put.w > 200 ? 3 : 4;
        const centre = o.clone().addScaledVector(across, bx + sx / 2).addScaledVector(up, by + sy / 2);
        mesh.matrix.makeBasis(across.clone().multiplyScalar(sx), up.clone().multiplyScalar(sy), new THREE.Vector3(0, 0, 1)).setPosition(centre);
        group.add(mesh);
        const word = chunk.words[w.index];
        words.push({ mesh, mat, from: this.spec.sung ? word.t : chunk.from + w.index * this.spec.beat * 0.5, letters: Math.min(MAX_LETTERS, w.text.length) });
      }
    });
    this.place.add(group);
    return { chunk, put, words, group, far: this.farBehind(put, chunk) };
  }

  /** the frame room a block of words takes at song time t */
  private boxOf(put: Put, t: number): FrameBox {
    const l = this.lensAt(t);
    const { o, across, up, block } = put;
    const b = { x0: 9, y0: 9, x1: -9, y1: -9 };
    for (const a of [0, 1])
      for (const h of [0, block.height]) {
        const q = project(l, o[0] + across[0] * a + up[0] * h, o[1] + across[1] * a + up[1] * h, o[2] + across[2] * a + up[2] * h);
        b.x0 = Math.min(b.x0, q.x);
        b.x1 = Math.max(b.x1, q.x);
        b.y0 = Math.min(b.y0, q.y);
        b.y1 = Math.max(b.y1, q.y);
      }
    return b;
  }

  /** where a drawing may be tried: what the lens and the clip are at a few times of the shot */
  private seatWhere(): SeatWhere {
    const s = this.spec;
    const len = s.end - s.start;
    const times = [0.4, 0.02, 0.2, 0.7, 0.96].map((k) => s.start + len * k);
    return { scene: s.scene, lens: this.lensAt(times[0]), around: times.slice(1).map((t) => this.lensAt(t)), times: times.map((t) => s.clipAt(t)), crop: this.crop, aspect: s.aspect, margin: s.aspect < 0.9 ? 0.075 : 0.055, dice: s.layout + 5, words: [] };
  }

  /** where each block of words stands, round what a drawing has taken (`seat`) */
  private placeBlocks(chunks: Chunk[], seat: Seat | null): Put[] {
    const s = this.spec;
    let last: PutId | undefined;
    const out: Put[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const mid = chunk.from + (chunk.to - chunk.from) * 0.35;
      const at = (k: number) => chunk.from + (chunk.to - chunk.from) * k;
      const times = [mid, chunk.to - 0.02, chunk.from + 0.02, at(0.7), at(0.18), at(0.52), at(0.86)];
      const put = place(
        chunk.words.map((w) => w.text),
        s.put ? [s.put, ...this.recipe.put.filter((p) => p !== s.put)] : this.recipe.put,
        { scene: s.scene, lens: this.lensAt(mid), around: times.slice(1).map((t) => this.lensAt(t)), times: times.map((t) => s.clipAt(t)), crop: this.crop, aspect: s.aspect, dice: s.layout + i * 7, last, keep: this.keep, zooms: times.map((t) => this.steady(t)), ...(seat ? { taken: times.map((t) => this.seatBox(seat, t)) } : {}) },
      );
      last = put.kind;
      out.push(put);
      // these words have nowhere left to stand: no use going on
      if (seat && put.score <= 0) break;
    }
    return out;
  }

  /** the frame room a drawing takes at song time t, and a little air round it */
  private seatBox(at: Seat, t: number): FrameBox {
    const b = this.seatFrame(at, t);
    return { x0: b.x0 - 0.012, x1: b.x1 + 0.012, y0: b.y0, y1: b.y1 + 0.012 };
  }

  private seatFrame(at: Seat, t: number): FrameBox {
    const l = this.lensAt(t);
    const b = { x0: 9, y0: 9, x1: -9, y1: -9 };
    for (const u of [0, 1])
      for (const v of [0, 1]) {
        const q = project(l, at.o[0] + at.across[0] * u + at.up[0] * v, at.o[1] + at.across[1] * u + at.up[1] * v, at.o[2] + at.across[2] * u + at.up[2] * v);
        b.x0 = Math.min(b.x0, q.x);
        b.x1 = Math.max(b.x1, q.x);
        b.y0 = Math.min(b.y0, q.y);
        b.y1 = Math.max(b.y1, q.y);
      }
    return b;
  }

  /**
   * Where the words and the drawing stand. A shot with a drawing is about it, so it is seated first and the
   * words stand round it; where they can't be read that way the next seat is tried, and in the end the words
   * come first and the drawing has what they leave.
   */
  private arrange(chunks: Chunk[], d: { put: HandPut; size: DrawnSize; ratio: number; spot: Spot | null } | null): { puts: Put[]; seat: Seat | null } {
    if (!d) return { puts: this.placeBlocks(chunks, null), seat: null };
    const where = this.seatWhere();
    if (d.spot) {
      // it stays where the person put it; the words stand round it where they still read, else where they would have
      const seat = handSeat(d.put, d.spot!, d.ratio, d.size, where);
      const alone = this.placeBlocks(chunks, null);
      const round = chunks.length ? this.placeBlocks(chunks, seat) : [];
      return { puts: stillRead(round, alone) ? round : alone, seat };
    }
    // (laid in front always has a spot)
    const put = d.put as DrawnPut;
    const tries = seats(put, d.ratio, d.size, where);
    if (!chunks.length) return { puts: [], seat: tries[0] ?? null };
    const puts = this.placeBlocks(chunks, null);
    for (const seat of tries.slice(0, 5)) {
      const round = this.placeBlocks(chunks, seat);
      if (stillRead(round, puts)) return { puts: round, seat };
    }
    const words = chunks.flatMap((chunk, i) => [0.05, 0.5, 0.95].map((k) => this.boxOf(puts[i], chunk.from + (chunk.to - chunk.from) * k)));
    return { puts, seat: seats(put, d.ratio, d.size, { ...where, words })[0] ?? null };
  }

  private chunks(): Chunk[] {
    const s = this.spec;
    // sung words come in blocks; words that aren't sung stand for the whole shot
    return s.sung ? chunksOf(s.words, s.start, s.end, s.aspect < 0.9, s.beat) : s.words.length ? [{ words: s.words, from: s.start, to: s.end }] : [];
  }

  /** for the art director: the places a drawing could stand here with the words still read, and the biggest size each holds */
  room(ratio = 1): Room {
    const chunks = this.chunks();
    const where = this.seatWhere();
    const alone = this.placeBlocks(chunks, null);
    const out: Room = {};
    for (const put of DRAWN_PUTS)
      for (const size of [...DRAWN_SIZES].reverse()) {
        const fits = seatsAt(put, ratio, size, where).some((at) => stillRead(this.placeBlocks(chunks, at), alone));
        if (!fits) continue;
        out[put] = size;
        break;
      }
    return out;
  }

  private addDrawing(d: Drawn, at: Seat) {
    const s = this.spec;
    const l = this.lensAt(s.start + (s.end - s.start) * 0.4);
    const foot = project(l, at.o[0], at.o[1], at.o[2]);
    const head = project(l, at.o[0] + at.up[0], at.o[1] + at.up[1], at.o[2] + at.up[2]);
    const px = Math.hypot((head.x - foot.x) * this.pass.width, (head.y - foot.y) * this.pass.height);
    this.seat = at;
    this.drawing = new DrawnInPlace(d, at, s.palette, (v, f, u) => this.material(v, f, u), { start: s.start, beat: s.beat, kicks: s.kicks, jump: this.recipe.jump, px, ratio: ratioOf(d) });
    this.place.add(this.drawing.group);
  }

  private farBehind(put: Put, chunk: Chunk): number {
    const s = this.spec;
    const at = chunk.from + (chunk.to - chunk.from) * 0.35;
    const map = s.scene ? mapAt(s.scene, s.clipAt(at)) : null;
    if (!map) return put.kind === 'far' ? 1 : 0;
    const l = this.lensAt(at);
    let far = 0;
    for (let i = 0; i < 60; i++) {
      const a = ((i % 12) + 0.5) / 12;
      const b = ((Math.floor(i / 12) + 0.5) / 5) * put.block.height;
      const q = project(l, put.o[0] + put.across[0] * a + put.up[0] * b, put.o[1] + put.across[1] * a + put.up[1] * b, put.o[2] + put.across[2] * a + put.up[2] * b);
      if (nearnessAt(s.scene!, map, this.crop, q.x, q.y) < this.cuts2.far ** 2) far++;
    }
    return far / 60;
  }

  private flat(hex: string): THREE.ShaderMaterial {
    return this.material(FLAT_VERT, FLAT_FRAG, { uColor: { value: new THREE.Color(hex) }, uAlpha: { value: 1 } }, { depthWrite: true });
  }

  /** lines along the clip's own; with them, the made-up ones stay out */
  private addOwn() {
    const s = this.spec;
    const acts = s.acts ?? (this.bare ? (['scan', 'knit', 'draw'] as ActId[]) : this.recipe.acts);
    if (!s.scene?.edges || !acts.length) return;
    const own = new SceneLines({ scene: s.scene, crop: this.crop, aspect: s.aspect, layout: s.layout, start: s.start, end: s.end, beat: s.beat, energy: s.energy, acts, kicks: s.kicks, snares: s.snares, hats: s.hats ?? [], clipAt: s.clipAt }, this.lensAt(s.start), this.material(strokeMaterial.vertexShader, strokeMaterial.fragmentShader, {}, { depthTest: false }));
    if (!own.playing) return own.dispose();
    this.own = own;
    this.place.add(own.mesh);
    this.extras.delete('lines');
    this.extras.delete('streaks');
    if ((s.layout >> 4) & 1) this.extras.delete('ribbons');
    if ((s.layout >> 5) & 1) this.extras.delete('rays');
    if ((s.layout >> 6) & 1) this.extras.delete('posts');
  }

  /** the colours its own lines are drawn in: ones that stand out from what they lie on and aren't the words' */
  private lineColours(amount: number, now: { field: string; word: string }, p: InsidePalette): THREE.Color[] {
    const painted = amount > 0.5 && this.paintKind !== 'figure';
    const on = new THREE.Color(painted ? now.field : '#3a3a3c');
    const word = painted ? now.word : p.paper;
    const apart = (hex: string) => {
      const c = new THREE.Color(hex);
      return Math.hypot((c.r - on.r) * 0.55, c.g - on.g, (c.b - on.b) * 0.4);
    };
    const all = [...p.accents, p.paper, p.ink].filter((c) => c !== word && apart(c) > 0.15).sort((a, b) => apart(b) - apart(a));
    const first = all.find((c) => p.accents.includes(c)) ?? all[0] ?? (lum(now.field) > 0.5 ? p.ink : p.paper);
    const second = all.find((c) => c !== first) ?? first;
    return [new THREE.Color(first), new THREE.Color(second)];
  }

  /** the first of the forms the shot asks for that its picture has room for (one the person picked stands anyhow) */
  private addForm() {
    const s = this.spec;
    const wish = s.form;
    if (!wish || !s.scene || s.drawn) return;
    const at = (t: number) => spotAt(s.scene, this.lensAt(t), s.clipAt(t), this.crop, this.cuts2.near * this.cuts2.near * 0.75);
    const spot = at(s.start + (s.end - s.start) * 0.45);
    const late = at(s.end - 0.05);
    const l = this.lensAt(s.start);
    const fits = (id: FormId) => {
      if (id === 'rings') return !!spot.body && Math.abs((spot.body.x0 + spot.body.x1) / 2 - 0.5) < 0.36;
      if (id === 'frames') return spot.open > 7 && s.scene!.sure.horizon > 0.3 && l.vp.x > 0.1 && l.vp.x < 0.9 && l.vp.y > 0.1 && l.vp.y < 0.85;
      return s.scene!.ground > 0.06 && s.scene!.sure.horizon > 0.3;
    };
    for (const id of wish.ids) {
      if (!wish.asked && !fits(id)) continue;
      const form = new Forms({ form: id, level: wish.level }, { scene: s.scene, span: this.span, layout: s.layout, start: s.start, end: s.end, beat: s.beat, kicks: s.kicks, aspect: s.aspect, lens: l, spot, late, dim: 1 - clamp01((s.cuts[1] - 0.28) / 0.14), words: this.standing.length > 0, travel: this.lensAt(s.end).ahead }, (v, f, u, e) => this.material(v, f, u, e));
      if (!wish.asked && form.count < 3 && id === 'blocks') {
        form.dispose();
        continue;
      }
      // a form is the one thing in its shot: nothing made up beside it
      this.extras.clear();
      this.form = form;
      this.place.add(form.group);
      // what is said is read over it, not cut up by it (people still pass in front of both)
      for (const st of this.standing) st.group.traverse((o) => o instanceof THREE.Mesh && ((o.material as THREE.Material).depthTest = false));
      return;
    }
  }

  private addRays() {
    const p = this.spec.palette;
    const cut = this.spec.scene ? (this.spec.scene.sky > 0.06 ? 0.0035 : (this.spec.scene.splits[0] ?? 0.02)) : 1;
    this.rays = this.material(FULLSCREEN_VERT, RAYS_FRAG, { uFrom: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: this.spec.aspect }, uReach: { value: 0 }, uTurn: { value: 0 }, uSeed: { value: 1 + (this.spec.layout % 97) }, uCut: { value: cut }, uA: { value: new THREE.Color(p.paper) }, uB: { value: new THREE.Color(p.accents[0]) } }, { depthTest: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.rays);
    this.geos.push(m.geometry);
    m.frustumCulled = false;
    m.renderOrder = 0;
    this.place.add(m);
  }

  private addLines() {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(unit, this.flat(i % 5 ? this.spec.palette.paper : this.spec.palette.accents[0]));
      const a = (i / n) * Math.PI * 2 + this.rnd() * 0.25;
      const r = 2.2 + this.rnd() * 4;
      m.matrixAutoUpdate = false;
      const len = this.span * 6;
      m.matrix.makeBasis(new THREE.Vector3(Math.cos(a + Math.PI / 2) * 0.014, Math.sin(a + Math.PI / 2) * 0.014, 0), new THREE.Vector3(0, 0, -len), new THREE.Vector3(1, 0, 0)).setPosition(Math.cos(a) * r * 1.4, Math.max(0.1, 2 + Math.sin(a) * r * 0.8), -len / 2 - 1);
      m.frustumCulled = false;
      m.renderOrder = 1;
      this.lines.push(m);
      this.place.add(m);
    }
  }

  /** flat bars standing in two rows that run ahead, rising on the beat like a meter built into the place */
  private addPosts() {
    const p = this.spec.palette;
    for (const side of [0, 1])
      for (let i = 0; i < 22; i++) {
        const m = new THREE.Mesh(post, this.flat(p.accents[(i * 2 + side) % p.accents.length]));
        m.frustumCulled = false;
        m.renderOrder = 1;
        this.posts.push({ m, side, i });
        this.place.add(m);
      }
  }

  private addRibbons(count: number) {
    const p = this.spec.palette;
    const S = this.span;
    for (let i = 0; i < count; i++) {
      const seed = i + 1 + this.rnd() * 3;
      const turns = 1.6 + this.rnd() * 1.4;
      const ph = this.rnd() * 6.28;
      const rad = S * (0.16 + 0.12 * this.rnd());
      const n = 260;
      const at3 = (u: number) => {
        const a = ph + turns * u * Math.PI * 2;
        const r = rad * (0.5 + 0.5 * Math.sin(u * 5 + seed * 2) ** 2 + 0.6 * u);
        let y = S * 0.13 + 1.2 + Math.sin(a) * r * 0.75;
        const floor = 0.9;
        if (y < floor + 1) y = floor + 1 - Math.tanh(floor + 1 - y);
        return new THREE.Vector3(Math.cos(a) * r * 1.5, y, -S * 0.22 - u * S * 4.5);
      };
      const pos: number[] = [];
      const side: number[] = [];
      const along: number[] = [];
      const idx: number[] = [];
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        const a = at3(u);
        const d = at3(u + 0.002).sub(a).normalize();
        const tw = seed * 3 + u * 8;
        const w = new THREE.Vector3().crossVectors(d, new THREE.Vector3(Math.cos(tw), Math.sin(tw), 0)).normalize();
        for (const q of [-1, 1]) {
          pos.push(a.x, a.y, a.z);
          side.push(w.x * q, w.y * q, w.z * q);
          along.push(u);
        }
        if (k < n) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 3));
      g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
      g.setIndex(idx);
      this.geos.push(g);
      const mat = this.material(RIBBON_VERT, RIBBON_FRAG, { uColor: { value: new THREE.Color(p.accents[i % p.accents.length]) }, uHead: { value: 2 }, uTail: { value: 2 }, uWidth: { value: 0.1 }, uSlide: { value: 0 } }, { depthWrite: true });
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      this.place.add(m);
      this.ribbons.push({ m, mat, i, w: S * (0.004 + 0.006 * this.rnd()) });
    }
  }

  private addStreaks() {
    const p = this.spec.palette;
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(unit, this.flat(p.accents[i % p.accents.length]));
      m.frustumCulled = false;
      m.renderOrder = 6;
      m.matrixAutoUpdate = false;
      this.streaks.push(m);
      this.place.add(m);
    }
  }

  /** which colour step the shot is on at beat b, and how far through the change it is */
  private stepAt(beats: number): { now: number; was: number; k: number } {
    const every = this.recipe.step || (this.bare ? 8 : 0);
    const n = this.spec.palette.steps.length;
    const i = every ? Math.max(0, Math.floor((beats + 1e-3) / every)) : 0;
    const k = every && i > 0 ? (beats - i * every) / Math.min(every, 0.9) : 1;
    return { now: (i + this.stepOffset) % n, was: (Math.max(0, i - 1) + this.stepOffset) % n, k: clamp01(k) };
  }

  /** the last beat before a hit, when it goes black */
  blackAt(t: number): boolean {
    const s = this.spec;
    return !!this.recipe.black && s.leave === 'ramp' && s.end - s.start > s.beat * 3.5 && t > s.end - s.beat;
  }

  render(t: number, o: { footage: THREE.Texture; grow: number; flash: number; speed: number; target: THREE.WebGLRenderTarget | null }) {
    if (!this.built) this.build();
    const s = this.spec;
    const p = s.palette;
    const tau = t - s.start;
    const beats = tau / s.beat;
    const l = this.lensAt(t);
    const step = this.stepAt(beats);
    const now = p.steps[step.now];
    const was = p.steps[step.was];
    const painted = this.paintKind !== 'none';
    const kick = this.recipe.jump * Math.exp(-since(s.kicks, t) / (s.beat * 0.22));
    const snare = this.recipe.jump * Math.exp(-since(s.snares, t) / (s.beat * 0.25));
    const black = this.blackAt(t);
    const gone = s.leave === 'settle' ? smooth(s.end - s.beat * 3, s.end - s.beat * 0.4, t) : 0;

    // the colour comes in over the first fifth of a second, then sweeps from far to near at each change
    const inK = s.arrive === 'hit' ? 1 : smooth(0, 0.22, tau);
    const amount = painted ? inK * (1 - gone) : 0;
    const farOn = this.paintKind === 'far' || this.paintKind === 'deep' || this.paintKind === 'all';
    const paint: Paint = {
      airy0: airyOf(was),
      airy1: airyOf(now),
      field0: was.field,
      light0: lightFor(was),
      field1: now.field,
      light1: lightFor(now),
      figure: this.paintKind === 'figure' ? now.field : now.word,
      line: p.paper,
      ink: p.ink,
      front: step.k >= 1 ? 2 : outCubic(step.k) * 1.06,
      edge: step.k < 1 && painted ? 0.9 : 0,
      far: farOn ? amount : 0,
      mid: this.paintKind === 'deep' || this.paintKind === 'all' ? amount : 0,
      near: this.paintKind === 'all' ? amount : 0,
      farCut: this.cuts2.far,
      nearCut: this.cuts2.near,
      figureK: this.paintKind === 'figure' ? amount : 0,
      groundK: this.recipe.ground && painted ? amount * 0.85 : 0,
      grade: this.paintKind === 'figure' ? 0.75 : Math.max(painted ? 0.08 : this.standing.length ? (s.cuts[1] > 0.5 ? 0.8 : 0.55) : 0, this.bare ? 0.4 : this.recipe.grade) * (0.4 + 0.6 * inK) ,
      lineK: painted ? Math.min(0.9, snare * 0.9) : 0,
      cuts: s.cuts,
    };

    // words on the bright, unpainted picture need it held back
    if (this.paintKind === 'far' && s.cuts[1] > 0.45) {
      const st = this.standing.find((x) => t >= x.chunk.from - 0.12 && t < x.chunk.to);
      if (st && st.far < 0.6) paint.grade = Math.max(paint.grade, 0.6);
    }
    this.placeWords(t, amount, now, p);
    const steady = this.steady(t, o.grow);
    const most = this.hold(t, l, steady);
    this.placeExtras(t, beats, l, now);
    this.own?.update(t, l, this.lineColours(amount, now, p), this.boxes, (0.25 + 0.75 * inK) * (1 - gone) * (black ? 0 : 1));
    this.form?.update(t, l, { cel: amount, now, palette: p, thr: s.cuts[1], gone });
    this.placeDrawing(t, l);
    this.drawing?.update(t, 1 - amount * 0.75, gone);

    const bump = kick * 0.035 + (s.arrive === 'hit' ? 0.09 * Math.exp(-tau / 0.22) : 0);
    const ramp = s.leave === 'ramp' ? clamp01(1 - (s.end - t) / (s.beat * 2)) : 0;
    const finish: Finish = {
      // a kick or a cut pushes in no further than the words have room for
      zoom: Math.min(steady + bump + 0.1 * ramp ** 3, Math.max(steady, most)),
      smear: Math.min(0.2, (s.arrive === 'hit' ? 0.2 * Math.exp(-tau / 0.09) : 0) + 0.16 * ramp ** 4 + Math.max(0, o.speed - 2) * 0.02),
      flash: black ? 1 : o.flash * 0.85,
      flashColor: black ? '#08090b' : p.paper,
    };
    const c = pushCentre(l);
    // and what is left for whatever pushes the finished frame in about its middle
    for (const b of this.boxes) for (const [at, mid] of [[b.x0, c.x], [b.x1, c.x], [b.y0, c.y], [b.y1, c.y]]) notePush(0.478 / Math.max(1e-3, Math.abs(mid + (at - mid) * finish.zoom - 0.5)));
    this.noteArranged(t, l, finish.zoom);
    this.pass.render({ scene: s.scene, t: s.clipAt(t), footage: o.footage, clipAspect: s.clipAspect, crop: this.crop, lens: l, paint, finish, place: this.place, target: o.target });
  }

  /** the drawing in the hand is where the hand has it; one laid in front stays put in the frame */
  private placeDrawing(t: number, l: Lens) {
    const d = this.drawing;
    if (!d) return;
    const held = trialOf(standingKey(this.spec.partStart));
    const front = d.seat.put === 'front';
    if (held) this.tried = held;
    if (!held && !front) {
      // let go, and back where it was (an undo, or a press of Esc): the shot is laid out again when it was moved
      if (this.tried && this.seat) d.seat = this.seat;
      this.tried = null;
      return;
    }
    const spot = held ?? spotOf(d.drawn, ratioOf(d.drawn), this.spec.aspect);
    if (!spot) return;
    const where = this.seatWhere();
    d.seat = handSeat(d.drawn.put, spot, ratioOf(d.drawn), d.drawn.size, front ? { ...where, lens: l } : where);
  }
  private tried: Spot | null = null;
  private seat: Seat | null = null;

  /** for the Arrange view: where the drawing and the words are */
  private noteArranged(t: number, l: Lens, zoom: number) {
    if (!arranging()) return;
    const s = this.spec;
    const c = pushCentre(l);
    const shown = (b: FrameBox) => ({ x0: c.x + (b.x0 - c.x) * zoom, x1: c.x + (b.x1 - c.x) * zoom, y0: 1 - (c.y + (b.y1 - c.y) * zoom), y1: 1 - (c.y + (b.y0 - c.y) * zoom) });
    for (const b of this.boxes) noteWords(shown(b));
    const d = this.drawing;
    if (!d) return;
    const bare = (b: FrameBox) => ({ x: (b.x0 + b.x1) / 2, y: 1 - (b.y0 + b.y1) / 2, size: b.y1 - b.y0 });
    const spot = this.tried ?? spotOf(d.drawn, ratioOf(d.drawn), s.aspect) ?? bare(this.seatFrame(d.seat, s.start + (s.end - s.start) * 0.4));
    noteThing({ key: standingKey(s.partStart), kind: 'standing', name: d.drawn.asset.name, box: shown(this.seatFrame(d.seat, t)), spot, from: s.start, to: s.end, hand: !!d.drawn.spots, ratio: ratioOf(d.drawn), ref: d.drawn.asset.id, part: s.partStart, push: zoom });
  }

  /** the room the words that are up take in the frame (y from the top), as drawn */
  wordBoxes(): { x0: number; y0: number; x1: number; y1: number }[] {
    return this.boxes.map((b) => ({ x0: b.x0, x1: b.x1, y0: 1 - b.y1, y1: 1 - b.y0 }));
  }

  /**
   * The words that are up stay in the frame whatever the place does: one that the picture's own movement
   * would carry over the edge is held at it. Says how far the picture can be pushed in with them all still in.
   */
  private hold(t: number, l: Lens, steady: number): number {
    const c = pushCentre(l);
    const k = this.keep;
    // what is kept clear while the picture jumps: a little less than where they stand
    const lim = { x0: k.side * 0.5, x1: 1 - k.side * 0.5, y0: k.foot * 0.6, y1: 1 - k.head * 0.6 };
    let most = Infinity;
    this.boxes.length = 0;
    for (const st of this.standing) {
      if (!st.group.visible) continue;
      const g = st.group;
      const b = this.boxOf(st.put, t);
      // the room there is before the push
      const r = { x0: c.x + (lim.x0 - c.x) / steady, x1: c.x + (lim.x1 - c.x) / steady, y0: c.y + (lim.y0 - c.y) / steady, y1: c.y + (lim.y1 - c.y) / steady };
      g.position.set(0, 0, 0);
      g.scale.setScalar(1);
      if (st.put.kind === 'far' || st.put.kind === 'between') {
        const fit = Math.min(1, (r.x1 - r.x0) / (b.x1 - b.x0), (r.y1 - r.y0) / (b.y1 - b.y0));
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        const hw = ((b.x1 - b.x0) / 2) * fit;
        const hh = ((b.y1 - b.y0) / 2) * fit;
        const x = Math.min(r.x1 - hw, Math.max(r.x0 + hw, cx));
        const y = Math.min(r.y1 - hh, Math.max(r.y0 + hh, cy));
        if (fit < 1 || Math.abs(x - cx) > 1e-5 || Math.abs(y - cy) > 1e-5) {
          // the same move in the place, at the distance they stand
          const { o } = st.put;
          const w = -(o[2] + l.ahead);
          const from = unproject(l, cx, cy, w);
          const to = unproject(l, x, y, w);
          g.scale.set(fit, fit, 1);
          g.position.set(to.x - from.x * fit, to.y - from.y * fit, 0);
        }
        b.x0 = x - hw;
        b.x1 = x + hw;
        b.y0 = y - hh;
        b.y1 = y + hh;
      }
      this.boxes.push(b);
      for (const [edge, at, mid] of [
        [lim.x0, b.x0, c.x],
        [lim.x1, b.x1, c.x],
        [lim.y0, b.y0, c.y],
        [lim.y1, b.y1, c.y],
      ])
        // only an edge on the far side of the words from the point it pushes about
        if ((at - mid) * (edge - mid) > 0 && Math.abs(at - mid) > 1e-4) most = Math.min(most, (edge - mid) / (at - mid));
    }
    return most;
  }

  private placeWords(t: number, amount: number, now: { field: string; word: string }, p: InsidePalette) {
    const s = this.spec;
    this.standing.forEach((st, i) => {
      const next = this.standing[i + 1];
      // a block is gone before the next one's letters rise
      const to = next && next.chunk.from - st.chunk.to < 0.1 ? next.chunk.from - 0.1 : st.chunk.to;
      const on = t >= st.chunk.from - 0.12 && t < to;
      st.group.visible = on;
      if (!on) return;
      const leaving = to < s.end - 0.05 && !(next && next.chunk.from - to < 0.2) ? smooth(to - 0.22, to, t) : 0;
      for (const w of st.words) {
        // a word is up by the time it is sung: its letters rise over the tenth of a second before
        const show = w.mat.uniforms.uShow.value as number[];
        const each = Math.min(0.028, 0.16 / Math.max(1, w.letters));
        for (let k = 0; k < MAX_LETTERS; k++) show[k] = outQuint((t - (w.from - 0.1) - k * each) / 0.2);
        w.mat.uniforms.uAlpha.value = (t >= w.from - 0.11 ? 1 : 0) * (1 - leaving);
        const colour = this.wordColor(st, amount, now, p);
        (w.mat.uniforms.uColor.value as THREE.Color).set(colour);
        (w.mat.uniforms.uAround.value as THREE.Color).set(lum(colour) < 0.4 ? p.paper : p.ink);
      }
    });
  }

  /** a word's colour against what it stands in front of: the step's own on its field, else light on the picture */
  private wordColor(st: Standing, amount: number, now: { field: string; word: string }, p: InsidePalette): string {
    if (st.put.kind === 'ground' && amount >= 0.5 && this.recipe.ground && lum(now.field) > 0.5) return p.ink;
    if (st.put.kind === 'ground' || amount < 0.5) return p.paper;
    const onField = this.paintKind !== 'figure' && st.far > 0.45;
    if (onField) return now.word;
    const deep = this.paintKind === 'deep' || this.paintKind === 'all';
    if (deep && airyOf(now)) return lum(now.word) < 0.5 ? now.word : p.ink;
    if (deep && lum(now.field) > 0.6) return lum(now.word) < 0.5 ? now.word : p.ink;
    const behind = deep ? lum(now.field) * 0.55 : 0.28;
    return lum(now.word) - behind > 0.22 ? now.word : p.paper;
  }

  private placeExtras(t: number, beats: number, l: Lens, now: { field: string; light: string; word: string }) {
    const s = this.spec;
    const p = s.palette;
    const S = this.span;
    const tau = t - s.start;
    if (this.rays) {
      const u = this.rays.uniforms;
      // from the vanishing point, a little above it
      u.uFrom.value.set(Math.min(0.85, Math.max(0.15, l.vp.x)), Math.min(0.75, Math.max(0.3, l.vp.y + 0.04)));
      const soft = s.moment === 'glow';
      u.uReach.value = outCubic(beats / (soft ? 6 : 2)) * (s.leave === 'settle' ? 1 - smooth(s.end - s.beat * 3, s.end - s.beat, t) : 1);
      u.uTurn.value = tau * 0.06;
      u.uSeed.value = 1 + (s.layout % 97) + (soft ? 0 : Math.floor(beats / 4));
      // never the colour of the words that stand in them
      const clear = (hex: string) => [now.word, p.paper].every((w) => Math.abs(lum(hex) - lum(w)) > 0.22);
      const pick = [now.light, ...p.accents, now.field, p.ink].filter(clear);
      u.uA.value.set(pick[0] ?? p.ink);
      u.uB.value.set(pick[1] ?? pick[0] ?? p.ink);
    }
    for (const [i, m] of this.lines.entries()) (m.material as THREE.ShaderMaterial).uniforms.uAlpha.value = smooth(i * 0.06, i * 0.06 + 0.7, tau) * 0.8;
    const ahead = goesAhead(s.scene) ? l.ahead : 0;
    // bars are never the colour of the words beside them
    const clearOf = p.accents.filter((c) => c !== now.word && Math.abs(lum(c) - lum(p.paper)) > 0.06);
    const bars = clearOf.length ? clearOf : p.accents;
    const barOf = (id: number) => bars[((id % bars.length) + bars.length) % bars.length];
    for (const { m, side, i } of this.posts) {
      const gap = S * 0.14;
      const id = i + Math.floor(ahead / gap);
      const z = S * 1.1 + i * gap - (ahead % gap);
      const wave = backOut(beats * 1.1 - (1 - i / 22) * 1.6);
      const hop = Math.exp(-since(s.kicks, t) / (s.beat * 0.35));
      const roll = Math.abs(Math.sin(id * 12.9898 + side * 4.1) * 43758.5453) % 1;
      const roll2 = Math.abs(Math.sin(id * 78.233 + side) * 12543.1) % 1;
      const h = S * (0.04 + 0.1 * roll + 0.06 * hop * roll2) * Math.max(0, Math.min(1.1, wave));
      m.visible = h > 0.01;
      m.position.set((side ? 1 : -1) * S * 0.34, 0, -z - l.ahead);
      m.rotation.y = (side ? -1 : 1) * 0.5;
      m.scale.set(S * 0.03, Math.max(1e-3, h), 1);
      (m.material as THREE.ShaderMaterial).uniforms.uColor.value.set(barOf(id));
    }
    for (const r of this.ribbons) {
      const u = r.mat.uniforms;
      const per = 7 + r.i * 0.8;
      const q = (((beats + 16 - r.i * 1.3) % per) + per) % per / per;
      const head = 1 - outCubic(q) * 1.3;
      u.uHead.value = beats > r.i * 0.3 ? head : 2;
      u.uTail.value = head + 0.1 + 0.24 * Math.sin(Math.PI * Math.min(1, q * 1.15));
      u.uWidth.value = r.w * (1 + 0.5 * Math.exp(-since(s.kicks, t) / (s.beat * 0.3)));
      u.uSlide.value = -l.ahead * 0.3;
    }
    const every = 4;
    for (const [i, m] of this.streaks.entries()) {
      const u = (n: number) => Math.abs(Math.sin((i + 1) * n) * 43758.5453) % 1;
      const q = beats - Math.floor(beats / every) * every - u(12.9) * 0.8;
      const alive = q >= 0 && q < 1.5;
      m.visible = alive;
      if (!alive) continue;
      const a = u(78.2) * 6.283;
      const r = S * (0.2 + 0.3 * u(39.4));
      const z = S * (2.4 * (1 - outCubic(q / 2.3)) + 0.22);
      const len = S * (0.04 + 0.5 * (1 - outCubic(q / 2.3))) * (0.5 + u(5.3));
      const w = S * (0.002 + 0.004 * u(91.7));
      m.visible = z > 0.3;
      m.matrix.makeBasis(new THREE.Vector3(Math.cos(a + 1.5708) * w, Math.sin(a + 1.5708) * w, 0), new THREE.Vector3(0, 0, -len), new THREE.Vector3(1, 0, 0)).setPosition(Math.cos(a) * r * 1.3, Math.max(0.15, 1.6 + Math.sin(a) * r * 0.7), -Math.max(0.3, z) - l.ahead);
    }
  }

  /** where the words stand, for checks */
  puts() {
    if (!this.built) this.build();
    return this.standing.map((x) => ({ text: x.chunk.words.map((w) => w.text).join(' '), kind: x.put.kind, score: Math.round(x.put.score * 100) / 100, from: x.chunk.from, to: x.chunk.to }));
  }

  /** what its own lines are, for checks */
  ownLines() {
    if (!this.built) this.build();
    return this.own?.info() ?? null;
  }

  /** where the drawing stands (null: it has none, or nothing here holds it), for checks */
  seated() {
    if (!this.built) this.build();
    const at = this.drawing?.seat;
    return at ? { id: this.drawing!.drawn.asset.id, put: at.put, size: at.size, shown: Math.round(at.shown * 100) / 100, score: Math.round(at.score * 100) / 100 } : null;
  }

  dispose() {
    this.drawing?.dispose();
    this.form?.dispose();
    this.own?.dispose();
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}

// kept for callers that place things by hand
export { project, unproject };
