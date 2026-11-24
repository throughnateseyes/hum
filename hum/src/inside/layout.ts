/**
 * Where words stand in a shot. A block of one to three words is tried in every place the recipe allows
 * (behind the farthest things, between two layers, along a side wall, on the ground), at several sizes
 * and spots, against what is really in front of each point at the time it is sung; the best one that can
 * still be read wins. Being partly behind something counts for it (that is what puts the word in the
 * place), being hidden counts against it, and no letter may be lost.
 */
import type { ClipScene } from '../depth/types';
import { hides, mapAt, nearnessAt, project, unproject, type Crop, type Lens } from './place';
import type { PutId } from './recipes';
import { advance, chooseWidth, type Stretch } from './words';

export interface SungWord {
  text: string;
  t: number;
  end: number;
}

/** words that stand together, from when the first is sung until the next block takes over */
export interface Chunk {
  words: SungWord[];
  from: number;
  to: number;
}

const LONGEST = 1.9;

/** the words sung in a shot, as blocks of one to four that are read together */
export function chunksOf(words: SungWord[], start: number, end: number, portrait: boolean, beat: number): Chunk[] {
  const most = portrait ? 16 : 15;
  const out: Chunk[] = [];
  let cur: SungWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ words: cur, from: cur[0].t, to: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    if (w.end <= start + 0.03 || w.t >= end - 0.06) continue;
    const letters = cur.reduce((s, x) => s + x.text.length, 0);
    const prev = cur[cur.length - 1];
    if (cur.length && (letters + w.text.length > most || cur.length >= 4 || w.t - cur[0].t > LONGEST || (prev && w.t - prev.end > Math.max(0.5, beat)))) flush();
    cur.push(w);
  }
  flush();
  out.forEach((c, i) => {
    const next = out[i + 1];
    c.from = Math.max(start, c.from);
    c.to = Math.min(end, next ? next.from : Math.max(c.to + 0.9, c.from + 1.2));
    // a block holds until the next one when the gap is short, and otherwise lets go soon after it is sung
    if (next && next.from - c.words[c.words.length - 1].end > 1.6) c.to = Math.min(next.from, c.words[c.words.length - 1].end + 1.1);
  });
  return out;
}

export interface Line {
  words: { text: string; index: number; x: number }[];
  stretch: Stretch;
  /** width / cap height of the whole line */
  ratio: number;
}

export interface Block {
  lines: Line[];
  /** height of the block when it is 1 wide, and each line's cap height and baseline (from the bottom) */
  height: number;
  caps: number[];
  bases: number[];
}

/** the words set as a block of `n` lines all the same width; `tall` is the cap height to aim for, block width 1 */
const blocks = new Map<string, Block>();
function setBlock(words: string[], n: number, tall: number): Block {
  const key = `${n}|${tall.toFixed(3)}|${words.join(' ')}`;
  const had = blocks.get(key);
  if (had) return had;
  const made = makeBlock(words, n, tall);
  blocks.set(key, made);
  if (blocks.size > 200) blocks.delete(blocks.keys().next().value as string);
  return made;
}

function makeBlock(words: string[], n: number, tall: number): Block {
  // split into n runs of about the same length
  const total = words.reduce((s, w) => s + w.length + 1, 0);
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  words.forEach((w, i) => {
    row.push(i);
    used += w.length + 1;
    const left = words.length - i - 1;
    if (rows.length < n - 1 && (used >= (total / n) * (rows.length + 1) - 1 || left === n - 1 - rows.length) && left >= n - 1 - rows.length) {
      rows.push(row);
      row = [];
    }
  });
  if (row.length) rows.push(row);
  const lines = rows.map((r) => {
    const text = r.map((i) => words[i]).join(' ');
    const { stretch, ratio } = chooseWidth(text, 1 / tall);
    let x = 0;
    const full = advance(text, stretch);
    const set = r.map((i, k) => {
      const at = (x / full) * 1;
      x = advance(r.slice(0, k + 1).map((j) => words[j]).join(' ') + ' ', stretch);
      return { text: words[i], index: i, x: at };
    });
    return { words: set, stretch, ratio };
  });
  const caps = lines.map((l) => 1 / l.ratio);
  const gap = Math.min(...caps) * 0.2;
  const height = caps.reduce((a, b) => a + b, 0) + gap * (caps.length - 1);
  const bases: number[] = [];
  let y = height;
  caps.forEach((c) => {
    y -= c;
    bases.push(y);
    y -= gap;
  });
  return { lines, height, caps, bases };
}

/** a block standing in the place: its bottom-left corner, and what one block width runs along and up */
export interface Put {
  kind: PutId;
  block: Block;
  o: [number, number, number];
  /** the world vector across the block's whole width, and the one up the same length */
  across: [number, number, number];
  up: [number, number, number];
  score: number;
  /** how far ahead its middle is, when it was placed */
  w: number;
}

export interface Where {
  scene: ClipScene | null;
  lens: Lens;
  /** the same a little earlier and later in the block's time (it has to stay readable as the place moves) */
  around: Lens[];
  times: number[];
  crop: Crop;
  aspect: number;
  /** a whole number to settle ties, so two blocks in a row don't land the same */
  dice: number;
  /** where the last block stood */
  last?: PutId;
  /** the frame's edge kept clear, as a share of its width and height */
  margin: number;
}

const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 31.7) * 43758.5453;
  return x - Math.floor(x);
};

const COLS = 26;
const ROWS = 5;

/**
 * How much of a block shows (its least readable line counts), the worst stretch about a letter wide, how
 * much of it is in the frame, and how big it is there
 */
function reading(o: Where, p: Omit<Put, 'score'>, lens: Lens, t: number): { shown: number; worst: number; inside: number; size: number; least: number; slim: number } {
  const map = o.scene ? mapAt(o.scene, t) : null;
  let inside = 0;
  let all = 0;
  let x0 = 9;
  let x1 = -9;
  let y0 = 9;
  let y1 = -9;
  let shown = 1;
  let worst = 1;
  let least = 1;
  let slim = 9;
  const col = new Float32Array(COLS);
  p.block.lines.forEach((_, li) => {
    const base = p.block.bases[li];
    const cap = p.block.caps[li];
    col.fill(0);
    // the smallest its letters get (the far end of a word that runs away)
    for (const a of [0, 1]) {
      const at = (b: number) => project(lens, p.o[0] + p.across[0] * a + p.up[0] * b, p.o[1] + p.across[1] * a + p.up[1] * b, p.o[2] + p.across[2] * a + p.up[2] * b);
      const lo = at(base);
      const hi = at(base + cap);
      const tall = Math.hypot((hi.x - lo.x) * o.aspect, hi.y - lo.y);
      least = Math.min(least, tall);
      // and how squeezed they are there
      const n = Math.max(1, p.block.lines[li].words.reduce((s, w) => s + w.text.length + 1, -1));
      const step = (a ? -1 : 1) / n;
      const in1 = project(lens, p.o[0] + p.across[0] * (a + step) + p.up[0] * base, p.o[1] + p.across[1] * (a + step) + p.up[1] * base, p.o[2] + p.across[2] * (a + step) + p.up[2] * base);
      slim = Math.min(slim, Math.hypot((in1.x - lo.x) * o.aspect, in1.y - lo.y) / Math.max(1e-4, tall));
    }
    let seen = 0;
    for (let i = 0; i < COLS; i++)
      for (let j = 0; j < ROWS; j++) {
        const a = i / (COLS - 1);
        const b = base + (cap * j) / (ROWS - 1);
        const q = project(lens, p.o[0] + p.across[0] * a + p.up[0] * b, p.o[1] + p.across[1] * a + p.up[1] * b, p.o[2] + p.across[2] * a + p.up[2] * b);
        all++;
        if (q.w < 0.4) continue;
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
        if (q.x < o.margin || q.x > 1 - o.margin || q.y < o.margin * 1.2 || q.y > 1 - o.margin * 1.2) continue;
        inside++;
        let part = 1;
        if (o.scene && map && hides(o.scene, nearnessAt(o.scene, map, o.crop, q.x, q.y), q.w)) {
          // something thin (a cable, a pole) takes less than the small map says: both sides of it are clear
          const thin = [-1, 1].every((k) => !hides(o.scene!, nearnessAt(o.scene!, map, o.crop, q.x + (k * 0.014) / o.aspect, q.y), q.w));
          if (!thin) continue;
          part = 0.55;
        }
        seen += part;
        col[i] += part / ROWS;
      }
    shown = Math.min(shown, seen / (COLS * ROWS));
    // the window is one of its letters
    const letters = Math.max(1, p.block.lines[li].words.reduce((s, w) => s + w.text.length + 1, -1));
    const span = Math.max(2, Math.min(8, Math.round((COLS / letters) * 0.9)));
    for (let i = 0; i + span <= COLS; i++) {
      let s = 0;
      for (let k = 0; k < span; k++) s += col[i + k];
      worst = Math.min(worst, s / span);
    }
  });
  return { shown, worst, inside: inside / all, size: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), least, slim };
}

/** the distances a word can stand at to have something in front of it and something behind, far to near */
export function standing(scene: ClipScene | null): { far: number; between: number[] } {
  if (!scene) return { far: 400, between: [] };
  const z = (n: number) => scene.zScale / Math.max(0.0012, n);
  // behind everything that isn't sky; with no sky, behind all but the farthest layer
  const far = scene.sky > 0.06 ? z(0.0022) : z(Math.max(0.0012, (scene.splits[0] ?? 0.02) * 0.9));
  return { far, between: scene.splits.filter((s) => s > 0.006).map((s) => z(s)) };
}

function candidates(words: string[], kind: PutId, o: Where): Omit<Put, 'score'>[] {
  const out: Omit<Put, 'score'>[] = [];
  const portrait = o.aspect < 0.9;
  const { scene, lens } = o;
  const st = standing(scene);
  const lineChoices = [1, 2, 3].filter((n) => n <= words.length && !(portrait && n < Math.min(2, words.length)));
  if (kind === 'far' || kind === 'between') {
    const zs = kind === 'far' ? [st.far] : st.between;
    for (const w of zs)
      for (const n of lineChoices)
        for (const W of portrait ? [0.88, 0.76, 0.64, 0.54] : [0.88, 0.74, 0.6, 0.46]) {
          const block = setBlock(words, n, portrait ? 0.3 : 0.34 / n ** 0.4);
          const h = W * block.height * o.aspect;
          if (h > 0.82) continue;
          for (const cx of [0.5, 0.36, 0.64])
            for (const cy of [0.5, 0.62, 0.72, 0.4, 0.3]) {
              const a = unproject(lens, cx - W / 2, cy - h / 2, w);
              const b = unproject(lens, cx + W / 2, cy - h / 2, w);
              const len = Math.hypot(b.x - a.x, b.y - a.y);
              const ux = (b.x - a.x) / len;
              const uy = (b.y - a.y) / len;
              out.push({ kind, block, o: [a.x, a.y, a.z], across: [ux * len, uy * len, 0], up: [-uy * len, ux * len, 0], w });
            }
        }
    return out;
  }
  const vp = lens.vp;
  if (kind === 'wall') {
    if (vp.x < -0.2 || vp.x > 1.2 || (scene && scene.sure.horizon < 0.3)) return out;
    for (const side of [1, -1]) {
      const edge = side > 0 ? 1 - o.margin * 1.2 : o.margin * 1.2;
      const room = (edge - vp.x) * side;
      if (room < 0.3) continue;
      for (const X of [2.4, 4, 7, 12])
        for (const n of [1, 2].filter((k) => k <= words.length)) {
          const block = setBlock(words, n, 0.16);
          // the near end at the frame's edge, the far end a share of the way back to the vanishing point
          for (const back of [0.3, 0.4, 0.22]) {
            const zAt = (fx: number) => {
              // the distance at which a point `X` to the side lands on fx
              let lo = 0.5;
              let hi = 4000;
              for (let k = 0; k < 40; k++) {
                const m = Math.sqrt(lo * hi);
                const q = project(lens, side * X, 1.5, -m - lens.ahead);
                if ((q.x - fx) * side > 0) lo = m;
                else hi = m;
              }
              return Math.sqrt(lo * hi);
            };
            const zn = zAt(edge);
            let zf = zAt(vp.x + side * room * back);
            // the near end may stand at most this tall
            const unit = project(lens, side * X, 2.5, -zn - lens.ahead).y - project(lens, side * X, 1.5, -zn - lens.ahead).y;
            const tall = (zf - zn) * block.height * unit;
            const most = Math.min(0.78, 0.98 - Math.min(0.7, vp.y));
            if (tall > most) zf = zn + most / (block.height * unit);
            const len = zf - zn;
            if (len < 0.5) continue;
            for (const y0 of [0.25, 0.9, 1.8]) {
              const y = 0.2 + y0 * Math.max(0.4, zn / 12);
              if (side > 0) out.push({ kind, block, o: [X, y, -zf - lens.ahead], across: [0, 0, len], up: [0, len, 0], w: (zn + zf) / 2 });
              else out.push({ kind, block, o: [-X, y, -zn - lens.ahead], across: [0, 0, -len], up: [0, len, 0], w: (zn + zf) / 2 });
            }
          }
        }
    }
    return out;
  }
  // the ground: the block lies flat, its lines running away, stretched the way road lettering is
  if (!scene || scene.ground < 0.07 || scene.sure.horizon < 0.35 || vp.y < 0.2) return out;
  for (const n of lineChoices)
    for (const stretch of [2.2, 3.2, 1.5])
      for (const near of [0.07, 0.14, 0.22]) {
        const block = setBlock(words, n, 0.3);
        if (near > vp.y - 0.08) continue;
        // the distance whose ground lands on `near`
        let lo = 0.5;
        let hi = 2000;
        for (let k = 0; k < 40; k++) {
          const m = Math.sqrt(lo * hi);
          if (project(lens, 0, 0, -m - lens.ahead).y < near) lo = m;
          else hi = m;
        }
        const zn = Math.sqrt(lo * hi);
        for (const W of [0.86, 0.66, 0.5])
          for (const cx of [0.5, vp.x, 0.4, 0.6]) {
            const a = unproject(lens, cx - W / 2, near, zn);
            const b = unproject(lens, cx + W / 2, near, zn);
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            out.push({ kind, block, o: [a.x, 0.02, -zn - lens.ahead], across: [len, 0, 0], up: [0, 0, -len * stretch], w: zn * 1.4 });
          }
      }
  return out;
}

/** the best standing for these words (with nowhere that can be read: in front of everything, score 0) */
export function place(words: string[], puts: PutId[], o: Where): Put {
  let best: Put | null = null;
  const order = [...puts, ...(['far', 'between'] as PutId[]).filter((p) => !puts.includes(p))];
  // strict first; then a place where a little more of the words is covered; then flat in front
  for (const ease of [0, 1]) {
    order.forEach((kind, rank) => {
      const fallback = rank >= puts.length;
      if (fallback && best) return;
      for (const [i, c] of candidates(words, kind, o).entries()) {
        const r = reading(o, c, o.lens, o.times[0]);
        if (r.inside < 0.985 || r.least < 0.05 || r.slim < (kind === 'wall' ? 0.3 : 0.2)) continue;
        if (r.shown < 0.73 - ease * 0.13 || r.worst < 0.42 - ease * 0.14) continue;
        let shown = r.shown;
        let worst = r.worst;
        let inside = r.inside;
        o.around.forEach((l, k) => {
          const s = reading(o, c, l, o.times[k + 1]);
          shown = Math.min(shown, s.shown + 0.08);
          worst = Math.min(worst, s.worst + 0.08);
          inside = Math.min(inside, s.inside);
        });
        if (inside < (kind === 'far' || kind === 'between' ? 0.9 : 0.6) || shown < 0.68 - ease * 0.14 || worst < 0.32 - ease * 0.12) continue;
        const behind = 1 - r.shown;
        const size = Math.min(0.42, r.size);
        // big, readable, with something crossing in front of it
        const score = size * 2.1 + shown * 0.5 + Math.min(0.25, worst * 0.3) + (behind > 0.03 && behind < 0.33 ? 0.35 : 0) + (inside - 1) * 1.2 - rank * 0.17 - (kind === o.last ? 0.12 : 0) - (fallback ? 0.3 : 0) + rnd(o.dice * 31 + i + rank * 977) * 0.07;
        if (!best || score > best.score) best = { ...c, score };
      }
    });
    if (best) return best;
  }
  // nothing read well enough: the words full width in front of everything
  const block = setBlock(words, Math.min(words.length, o.aspect < 0.9 ? 3 : 2), 0.26);
  const W = Math.min(0.8, 0.6 / (block.height * o.aspect));
  // far off, so the place moving past leaves it where it is; it is drawn over everything
  const w = 900;
  const y = 0.5 - (W * block.height * o.aspect) / 2;
  const a = unproject(o.lens, 0.5 - W / 2, y, w);
  const b = unproject(o.lens, 0.5 + W / 2, y, w);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { kind: 'far', block, o: [a.x, a.y, a.z], across: [len, 0, 0], up: [0, len, 0], w, score: 0 };
}
