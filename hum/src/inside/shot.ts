/**
 * One inside shot: the clip as a place, with the words being sung standing in it. It decides once what
 * the shot is made of (its moment's recipe, the arrangement number, what the clip has: sky, ground,
 * layers, a way ahead), then draws any song time from that alone, so seeking and frame-by-frame renders
 * give the same picture.
 */
import * as THREE from 'three';
import type { ClipScene } from '../depth/types';
import type { MomentId } from '../moments';
import { clamp01, dice, since, smooth } from '../shot/time';
import { chunksOf, place, standing, type Chunk, type Put, type SungWord } from './layout';
import type { InsidePalette } from './palettes';
import type { Finish, InsidePass, Paint } from './pass';
import { cropOf, goesAhead, lens, mapAt, nearnessAt, project, unproject, type Crop, type Lens } from './place';
import { insideFor, type ExtraId, type InsideRecipe, type PaintId, type PutId } from './recipes';
import { FLAT_FRAG, FLAT_VERT, MAX_LETTERS, RAYS_FRAG, RIBBON_FRAG, RIBBON_VERT, WORD_FRAG, WORD_VERT, FULLSCREEN_VERT } from './shaders';
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
  /** which second of the clip is on screen at song time t */
  clipAt: (t: number) => number;
  focus: { x: number; y: number };
  zoom: number;
  flip: boolean;
  /** the director's choices over the recipe's */
  paint?: PaintId;
  put?: PutId;
  extras?: ExtraId[];
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
const unit = new THREE.PlaneGeometry(1, 1);
const post = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
const blend = { transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide } as const;

export class InsideShot {
  readonly place = new THREE.Scene();
  private readonly recipe: InsideRecipe;
  private readonly paintKind: PaintId;
  private readonly extras: Set<ExtraId>;
  private readonly rnd: () => number;
  private readonly crop: Crop;
  private readonly clip0: number;
  private readonly standing: Standing[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly posts: { m: THREE.Mesh; side: number; i: number }[] = [];
  private readonly streaks: THREE.Mesh[] = [];
  private readonly ribbons: { m: THREE.Mesh; mat: THREE.ShaderMaterial; i: number; w: number }[] = [];
  private readonly lines: THREE.Mesh[] = [];
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
    const paints = this.recipe.paint.filter((p) => this.can(p));
    this.paintKind = s.paint && this.can(s.paint) ? s.paint : (paints[(s.layout >> 3) % Math.max(1, paints.length)] ?? 'none');
    this.extras = new Set(s.extras ?? this.recipe.with);
    this.crop = cropOf(s.clipAspect, s.aspect, s.focus, s.zoom, s.flip);
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

  /** stand everything in the place (on the first frame drawn: it needs the clip's depth) */
  private build() {
    this.built = true;
    const s = this.spec;
    const portrait = s.aspect < 0.9;
    // sung words come in blocks; words that aren't sung stand for the whole shot
    const chunks: Chunk[] = s.sung ? chunksOf(s.words, s.start, s.end, portrait, s.beat) : s.words.length ? [{ words: s.words, from: s.start, to: s.end }] : [];
    let last: PutId | undefined;
    chunks.forEach((chunk, i) => {
      const mid = chunk.from + (chunk.to - chunk.from) * 0.35;
      const times = [mid, chunk.from + 0.02, chunk.to - 0.02];
      const put = place(
        chunk.words.map((w) => w.text),
        s.put ? [s.put, ...this.recipe.put.filter((p) => p !== s.put)] : this.recipe.put,
        { scene: s.scene, lens: this.lensAt(mid), around: times.slice(1).map((t) => this.lensAt(t)), times: times.map((t) => s.clipAt(t)), crop: this.crop, aspect: s.aspect, dice: s.layout + i * 7, last, margin: portrait ? 0.05 : 0.04 },
      );
      if (!put) return;
      last = put.kind;
      this.standing.push(this.stand(chunk, put));
    });
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
    const every = this.recipe.step;
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
      field0: was.field,
      light0: was.light,
      field1: now.field,
      light1: now.light,
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
      grade: this.paintKind === 'figure' ? 0.75 : Math.max(painted ? 0.08 : 0, this.recipe.grade) * (0.4 + 0.6 * inK) ,
      lineK: painted ? Math.min(0.9, snare * 0.9) : 0,
      cuts: s.cuts,
    };

    this.placeWords(t, amount, now, p);
    this.placeExtras(t, beats, l, now);

    const bump = kick * 0.035 + (s.arrive === 'hit' ? 0.16 * Math.exp(-tau / 0.26) : 0);
    const ramp = s.leave === 'ramp' ? clamp01(1 - (s.end - t) / (s.beat * 2)) : 0;
    const finish: Finish = {
      zoom: Math.max(1, o.grow) + bump + 0.1 * ramp ** 3,
      smear: Math.min(0.2, (s.arrive === 'hit' ? 0.2 * Math.exp(-tau / 0.09) : 0) + 0.16 * ramp ** 4 + Math.max(0, o.speed - 2) * 0.02),
      flash: black ? 1 : o.flash * 0.85,
      flashColor: black ? '#08090b' : p.paper,
    };
    this.pass.render({ scene: s.scene, t: s.clipAt(t), footage: o.footage, clipAspect: s.clipAspect, crop: this.crop, lens: l, paint, finish, place: this.place, target: o.target });
  }

  private placeWords(t: number, amount: number, now: { field: string; word: string }, p: InsidePalette) {
    const s = this.spec;
    this.standing.forEach((st, i) => {
      const next = this.standing[i + 1];
      const to = next ? Math.max(st.chunk.to, Math.min(next.chunk.from, st.chunk.to)) : st.chunk.to;
      const on = t >= st.chunk.from - 0.12 && t < to;
      st.group.visible = on;
      if (!on) return;
      const leaving = to < s.end - 0.05 && !(next && next.chunk.from - to < 0.1) ? smooth(to - 0.22, to, t) : 0;
      for (const w of st.words) {
        // a word is up by the time it is sung: its letters rise over the tenth of a second before
        const show = w.mat.uniforms.uShow.value as number[];
        const each = Math.min(0.028, 0.16 / Math.max(1, w.letters));
        for (let k = 0; k < MAX_LETTERS; k++) show[k] = outQuint((t - (w.from - 0.1) - k * each) / 0.2);
        w.mat.uniforms.uAlpha.value = (t >= w.from - 0.11 ? 1 : 0) * (1 - leaving);
        (w.mat.uniforms.uColor.value as THREE.Color).set(this.wordColor(st, amount, now, p));
      }
    });
  }

  /** a word's colour against what it stands in front of: the step's own on its field, else light on the picture */
  private wordColor(st: Standing, amount: number, now: { field: string; word: string }, p: InsidePalette): string {
    if (st.put.kind === 'ground' || amount < 0.5) return p.paper;
    const onField = this.paintKind !== 'figure' && st.far > 0.45;
    if (onField) return now.word;
    const deep = this.paintKind === 'deep' || this.paintKind === 'all';
    const behind = deep ? lum(now.field) * 0.55 : 0.28;
    return lum(now.word) - behind > 0.22 ? now.word : p.paper;
  }

  private placeExtras(t: number, beats: number, l: Lens, now: { light: string; word: string }) {
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
      u.uA.value.set(now.light);
      u.uB.value.set(now.word);
    }
    for (const [i, m] of this.lines.entries()) (m.material as THREE.ShaderMaterial).uniforms.uAlpha.value = smooth(i * 0.06, i * 0.06 + 0.7, tau) * 0.8;
    const ahead = goesAhead(s.scene) ? l.ahead : 0;
    for (const { m, side, i } of this.posts) {
      const gap = S * 0.14;
      const id = i + Math.floor(ahead / gap);
      const z = S * 0.45 + i * gap - (ahead % gap);
      const wave = backOut(beats * 1.1 - (1 - i / 22) * 1.6);
      const hop = Math.exp(-since(s.kicks, t) / (s.beat * 0.35));
      const roll = Math.abs(Math.sin(id * 12.9898 + side * 4.1) * 43758.5453) % 1;
      const roll2 = Math.abs(Math.sin(id * 78.233 + side) * 12543.1) % 1;
      const h = S * (0.05 + 0.16 * roll + 0.09 * hop * roll2) * Math.max(0, Math.min(1.1, wave));
      m.visible = h > 0.01;
      m.position.set((side ? 1 : -1) * S * 0.34, 0, -z - l.ahead);
      m.rotation.y = (side ? -1 : 1) * 0.5;
      m.scale.set(S * 0.03, Math.max(1e-3, h), 1);
      (m.material as THREE.ShaderMaterial).uniforms.uColor.value.set(p.accents[((id % p.accents.length) + p.accents.length) % p.accents.length]);
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
      const alive = q >= 0 && q < 2.6;
      m.visible = alive;
      if (!alive) continue;
      const a = u(78.2) * 6.283;
      const r = S * (0.12 + 0.3 * u(39.4));
      const z = S * (2.4 * (1 - outCubic(q / 2.3)) + 0.06) - q * 0.4;
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

  dispose() {
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}

// kept for callers that place things by hand
export { project, unproject };
