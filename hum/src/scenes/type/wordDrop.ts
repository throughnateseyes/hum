/**
 * Word Drop — a love note falling out of a pocket. Every sung word drops into the frame as a
 * little rounded colour tag, falls, bounces, tumbles and comes to rest, so the lyric builds up as
 * a pile of words on warm paper. Kicks thump the floor and the pile hops, snares spin the newest
 * tags, a build takes the weight out of everything until the pile floats, and the drop slams it
 * all back down under a burst of big chorus words. A new part of the song opens the floor and
 * starts clean. Without lyrics it drops the song's own words (title, artist, part names, genre).
 *
 * Canvas 2D with a small rigid-body solver written for it (rotated boxes, sequential impulses
 * with warm starting, friction, sleeping), run in fixed 120 Hz steps from a clamped dt.
 *
 * Palette roles: bg = the paper (and a darker shade of it for the floor strip, shadows and dust),
 * fg = the near-black tag and the ink on pale tags, accent / accent2 / muted = tag colours, plus
 * two mixes (accent2 + fg, accent + muted) for more tags. The type on a tag is a pale tint of the
 * paper, or fg where the tag itself is pale.
 */
import { defineCanvasScene } from '../../core/sceneHelpers';
import { num, str } from '../../core/uniforms';
import type { FrameContext, Lyrics, ParamDef } from '../../core/types';
import { useStudio } from '../../state/store';
import { sectionIndex, songInfo } from '../three/songInfo';

const params: ParamDef[] = [
  { id: 'size', label: 'Tag size', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1, hint: 'Scales with the short side of the frame; loud words come out bigger' },
  { id: 'cap', label: 'Most tags', group: 'Shape', type: 'number', min: 16, max: 110, step: 1, default: 64, hint: 'Past this the oldest tags sink away' },
  {
    id: 'font',
    label: 'Lettering',
    group: 'Shape',
    type: 'select',
    options: [
      { value: 'sans', label: 'Round sans' },
      { value: 'hand', label: 'Handwritten' },
      { value: 'serif', label: 'Italic serif' },
    ],
    default: 'sans',
  },
  { id: 'gravity', label: 'Gravity', group: 'Motion', type: 'number', min: 0.3, max: 2, step: 0.01, default: 1 },
  { id: 'bounce', label: 'Bounce', group: 'Motion', type: 'number', min: 0, max: 0.7, step: 0.01, default: 0.3 },
  { id: 'hop', label: 'Kick hop', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6, hint: 'How hard a kick thumps the floor' },
  { id: 'spin', label: 'Snare spin', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Snares flick the newest tags' },
  { id: 'lift', label: 'Build lift', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'How weightless the pile gets in a build' },
  { id: 'rain', label: 'Chorus rain', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Loud parts drop each word more than once' },
  {
    id: 'words',
    label: 'Words',
    group: 'Lyrics',
    type: 'select',
    options: [
      { value: 'auto', label: 'Lyrics (song facts without them)' },
      { value: 'facts', label: 'Song facts only' },
    ],
    default: 'auto',
  },
];

interface Face {
  family: string;
  weight: string;
  italic: boolean;
  /** type size relative to the tag, baseline below the tag centre, stroke that rounds the corners (all in em of the tag) */
  scale: number;
  base: number;
  round: number;
}
const FACES: Record<string, Face> = {
  sans: { family: "'Inter Variable', Inter, 'Helvetica Neue', Arial, sans-serif", weight: '600', italic: false, scale: 1, base: 0.34, round: 0.04 },
  hand: { family: "'Caveat Variable', 'Bradley Hand', cursive", weight: '700', italic: false, scale: 1.34, base: 0.3, round: 0 },
  serif: { family: "'Playfair Display Variable', Georgia, serif", weight: '700', italic: true, scale: 1.04, base: 0.32, round: 0 },
};

/* ───────────────────────── rigid bodies ───────────────────────── */

const STEP = 1 / 120;
const ITERATIONS = 8;

interface Body {
  id: number;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  w: number;
  /** half size */
  hx: number;
  hy: number;
  /** inverse mass and inverse inertia (0 = fixed) */
  im: number;
  ii: number;
  /** cos / sin of the angle and the half size of the bounding box, refreshed every step */
  c: number;
  s: number;
  ex: number;
  ey: number;
  asleep: boolean;
  still: number;
  touch: number;
  gone: boolean;
}

interface Tag extends Body {
  text: string;
  font: string;
  base: number;
  round: number;
  col: number;
  path: Path2D;
  /** the tag painted once (colour, type), redrawn only when the palette changes */
  img: HTMLCanvasElement | null;
  imgKey: string;
  born: number;
  /** tags from before the last sweep never touch the ones after it */
  gen: number;
  /** 0 in play · 1 falling through the open floor · 2 sinking away (touches nothing) */
  state: number;
  fade: number;
  glint: number;
  phase: number;
  /** how eagerly this tag floats in a build */
  buoy: number;
}

interface Con {
  x: number;
  y: number;
  sep: number;
  id: number;
  pn: number;
  pt: number;
  mn: number;
  mt: number;
  bias: number;
}
interface Arb {
  a: Body;
  b: Body;
  n: number;
  nx: number;
  ny: number;
  c0: Con;
  c1: Con;
  mu: number;
  stamp: number;
  ima: number;
  iia: number;
  imb: number;
  iib: number;
}

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
}
interface Pending {
  at: number;
  text: string;
  scale: number;
  /** <0 = anywhere */
  x: number;
  soft: boolean;
}
interface SungWord {
  t: number;
  text: string;
  line: number;
}

interface St {
  W: number;
  H: number;
  u: number;
  seed: number;
  t: number;
  acc: number;
  nextId: number;
  tags: Tag[];
  arbs: Map<number, Arb>;
  stamp: number;
  floor: Body;
  wallL: Body;
  wallR: Body;
  floorY: number;
  floorOff: number;
  floorV: number;
  e: number;
  lift: number;
  slam: number;
  flash: number;
  shake: number;
  shakeV: number;
  noLift: number;
  prevDrop: number;
  sec: number;
  gen: number;
  sweepT: number;
  sweepDir: number;
  lyr: Lyrics | null;
  words: SungWord[];
  wi: number;
  lastT: number;
  sweptWi: number;
  factsKey: string;
  facts: string[];
  /** how many of the facts, from the start, are the title (dropped in bigger tags) */
  titleN: number;
  fi: number;
  fill: number;
  colX: number;
  colLeft: number;
  colLine: number;
  ci: number;
  kicks: number;
  snares: number;
  hitWordAt: number;
  queue: Pending[];
  puffs: Puff[];
  palKey: string;
  cols: string[];
  inks: string[];
  dust: string;
}

function rnd(st: St) {
  st.seed = (st.seed + 0x6d2b79f5) | 0;
  let t = Math.imul(st.seed ^ (st.seed >>> 15), 1 | st.seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function makeBody(id: number, x: number, y: number, hx: number, hy: number, mass: number): Body {
  const im = mass > 0 ? 1 / mass : 0;
  const inertia = (mass * (4 * hx * hx + 4 * hy * hy)) / 12;
  return { id, x, y, a: 0, vx: 0, vy: 0, w: 0, hx, hy, im, ii: inertia > 0 ? 1 / inertia : 0, c: 1, s: 0, ex: hx, ey: hy, asleep: false, still: 0, touch: 0, gone: false };
}

function refresh(b: Body) {
  b.c = Math.cos(b.a);
  b.s = Math.sin(b.a);
  b.ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hy;
  b.ey = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hy;
}

function wake(b: Body) {
  b.asleep = false;
  b.still = 0;
}

/** scratch for the narrow phase: up to two contact points */
const M = { nx: 0, ny: 0, x0: 0, y0: 0, s0: 0, i0: 0, x1: 0, y1: 0, s1: 0, i1: 0 };

/**
 * Box against box: separating axes, then the incident edge clipped to the reference face.
 * Returns the number of contact points written to M (normal points from A to B).
 */
function collide(A: Body, B: Body): number {
  const dpx = B.x - A.x;
  const dpy = B.y - A.y;
  const dAx = A.c * dpx + A.s * dpy;
  const dAy = -A.s * dpx + A.c * dpy;
  const dBx = B.c * dpx + B.s * dpy;
  const dBy = -B.s * dpx + B.c * dpy;
  const cc = Math.abs(A.c * B.c + A.s * B.s);
  const cs = Math.abs(A.s * B.c - A.c * B.s);
  const fAx = Math.abs(dAx) - A.hx - (cc * B.hx + cs * B.hy);
  const fAy = Math.abs(dAy) - A.hy - (cs * B.hx + cc * B.hy);
  if (fAx > 0 || fAy > 0) return 0;
  const fBx = Math.abs(dBx) - B.hx - (cc * A.hx + cs * A.hy);
  const fBy = Math.abs(dBy) - B.hy - (cs * A.hx + cc * A.hy);
  if (fBx > 0 || fBy > 0) return 0;

  let axis = 0;
  let sep = fAx;
  let sg = dAx > 0 ? 1 : -1;
  let nx = A.c * sg;
  let ny = A.s * sg;
  if (fAy > 0.95 * sep + 0.01 * A.hy) {
    axis = 1;
    sep = fAy;
    sg = dAy > 0 ? 1 : -1;
    nx = -A.s * sg;
    ny = A.c * sg;
  }
  if (fBx > 0.95 * sep + 0.01 * B.hx) {
    axis = 2;
    sep = fBx;
    sg = dBx > 0 ? 1 : -1;
    nx = B.c * sg;
    ny = B.s * sg;
  }
  if (fBy > 0.95 * sep + 0.01 * B.hy) {
    axis = 3;
    sep = fBy;
    sg = dBy > 0 ? 1 : -1;
    nx = -B.s * sg;
    ny = B.c * sg;
  }

  // the reference box owns the face, the other box brings the edge that gets clipped
  const R = axis < 2 ? A : B;
  const I = axis < 2 ? B : A;
  const fnx = axis < 2 ? nx : -nx;
  const fny = axis < 2 ? ny : -ny;
  const alongX = axis === 0 || axis === 2;
  const front = R.x * fnx + R.y * fny + (alongX ? R.hx : R.hy);
  const snx = alongX ? -R.s : R.c;
  const sny = alongX ? R.c : R.s;
  const side = R.x * snx + R.y * sny;
  const half = alongX ? R.hy : R.hx;

  const lx = -(I.c * fnx + I.s * fny);
  const ly = -(-I.s * fnx + I.c * fny);
  let ax: number;
  let ay: number;
  let bx: number;
  let by: number;
  let edge: number;
  if (Math.abs(lx) > Math.abs(ly)) {
    if (lx > 0) {
      ax = I.hx;
      ay = -I.hy;
      bx = I.hx;
      by = I.hy;
      edge = 0;
    } else {
      ax = -I.hx;
      ay = I.hy;
      bx = -I.hx;
      by = -I.hy;
      edge = 1;
    }
  } else if (ly > 0) {
    ax = I.hx;
    ay = I.hy;
    bx = -I.hx;
    by = I.hy;
    edge = 2;
  } else {
    ax = -I.hx;
    ay = -I.hy;
    bx = I.hx;
    by = -I.hy;
    edge = 3;
  }
  let p0x = I.x + I.c * ax - I.s * ay;
  let p0y = I.y + I.s * ax + I.c * ay;
  let p1x = I.x + I.c * bx - I.s * by;
  let p1y = I.y + I.s * bx + I.c * by;

  // clip to the two sides of the reference face (each end keeps its slot, so ids stay put)
  for (let k = 0; k < 2; k++) {
    const sgn = k === 0 ? -1 : 1;
    const off = half + sgn * side;
    const d0 = sgn * (snx * p0x + sny * p0y) - off;
    const d1 = sgn * (snx * p1x + sny * p1y) - off;
    if (d0 > 0 && d1 > 0) return 0;
    if (d0 > 0 || d1 > 0) {
      const t = d0 / (d0 - d1);
      const qx = p0x + (p1x - p0x) * t;
      const qy = p0y + (p1y - p0y) * t;
      if (d0 > 0) {
        p0x = qx;
        p0y = qy;
      } else {
        p1x = qx;
        p1y = qy;
      }
    }
  }

  M.nx = nx;
  M.ny = ny;
  let n = 0;
  const s0 = fnx * p0x + fny * p0y - front;
  const s1 = fnx * p1x + fny * p1y - front;
  const idBase = axis * 8 + edge * 2;
  if (s0 <= 0) {
    M.x0 = p0x - s0 * fnx;
    M.y0 = p0y - s0 * fny;
    M.s0 = s0;
    M.i0 = idBase;
    n = 1;
  }
  if (s1 <= 0) {
    if (n === 0) {
      M.x0 = p1x - s1 * fnx;
      M.y0 = p1y - s1 * fny;
      M.s0 = s1;
      M.i0 = idBase + 1;
    } else {
      M.x1 = p1x - s1 * fnx;
      M.y1 = p1y - s1 * fny;
      M.s1 = s1;
      M.i1 = idBase + 1;
    }
    n++;
  }
  return n;
}

const newCon = (): Con => ({ x: 0, y: 0, sep: 0, id: -1, pn: 0, pt: 0, mn: 0, mt: 0, bias: 0 });

/** narrow phase for one pair: creates, refreshes or drops its arbiter (impulses carry over by contact id) */
function touchPair(st: St, A: Body, B: Body, mu: number) {
  const key = A.id * 2097152 + B.id;
  const n = collide(A, B);
  let arb = st.arbs.get(key);
  if (n === 0) {
    if (arb) st.arbs.delete(key);
    return;
  }
  if (!arb) {
    arb = { a: A, b: B, n: 0, nx: 0, ny: 0, c0: newCon(), c1: newCon(), mu, stamp: 0, ima: 0, iia: 0, imb: 0, iib: 0 };
    st.arbs.set(key, arb);
    // a hard landing kicks up a little paper dust
    const vn = (B.vx - A.vx) * M.nx + (B.vy - A.vy) * M.ny;
    if (vn < -0.55 * st.u && st.puffs.length < 40) {
      const k = Math.min(1, -vn / (1.6 * st.u));
      for (let i = 0; i < 3; i++) {
        const dir = rnd(st) < 0.5 ? -1 : 1;
        st.puffs.push({ x: M.x0, y: M.y0, vx: dir * (0.05 + rnd(st) * 0.16) * st.u * (0.5 + k), vy: -(0.02 + rnd(st) * 0.07) * st.u, r: (0.004 + rnd(st) * 0.007) * st.u * (0.7 + k), life: 1 });
      }
    }
  }
  const c0 = arb.c0;
  const c1 = arb.c1;
  const o0 = arb.n > 0 ? c0.id : -1;
  const o1 = arb.n > 1 ? c1.id : -1;
  const pn0 = c0.pn;
  const pt0 = c0.pt;
  const pn1 = c1.pn;
  const pt1 = c1.pt;
  c0.x = M.x0;
  c0.y = M.y0;
  c0.sep = M.s0;
  c0.id = M.i0;
  c0.pn = M.i0 === o0 ? pn0 : M.i0 === o1 ? pn1 : 0;
  c0.pt = M.i0 === o0 ? pt0 : M.i0 === o1 ? pt1 : 0;
  if (n > 1) {
    c1.x = M.x1;
    c1.y = M.y1;
    c1.sep = M.s1;
    c1.id = M.i1;
    c1.pn = M.i1 === o1 ? pn1 : M.i1 === o0 ? pn0 : 0;
    c1.pt = M.i1 === o1 ? pt1 : M.i1 === o0 ? pt0 : 0;
  }
  arb.n = n;
  arb.nx = M.nx;
  arb.ny = M.ny;
  arb.mu = mu;
  arb.stamp = st.stamp;
  A.touch++;
  B.touch++;
  // something moving wakes whatever it lands on
  if (A.asleep !== B.asleep) {
    const mover = A.asleep ? B : A;
    const lim = 0.05 * st.u;
    if (mover.im > 0 && mover.vx * mover.vx + mover.vy * mover.vy > lim * lim) wake(A.asleep ? A : B);
  }
}

function prepCon(arb: Arb, c: Con, invDt: number, slop: number, maxBias: number, rest: number, restMin: number) {
  const A = arb.a;
  const B = arb.b;
  const nx = arb.nx;
  const ny = arb.ny;
  const r1x = c.x - A.x;
  const r1y = c.y - A.y;
  const r2x = c.x - B.x;
  const r2y = c.y - B.y;
  const rn1 = r1x * nx + r1y * ny;
  const rn2 = r2x * nx + r2y * ny;
  const d1 = r1x * r1x + r1y * r1y;
  const d2 = r2x * r2x + r2y * r2y;
  const kn = arb.ima + arb.imb + arb.iia * (d1 - rn1 * rn1) + arb.iib * (d2 - rn2 * rn2);
  c.mn = kn > 0 ? 1 / kn : 0;
  const tx = ny;
  const ty = -nx;
  const rt1 = r1x * tx + r1y * ty;
  const rt2 = r2x * tx + r2y * ty;
  const kt = arb.ima + arb.imb + arb.iia * (d1 - rt1 * rt1) + arb.iib * (d2 - rt2 * rt2);
  c.mt = kt > 0 ? 1 / kt : 0;
  let bias = Math.min(maxBias, -0.2 * invDt * Math.min(0, c.sep + slop));
  // bounce: aim to leave at a share of the speed it arrived with
  const vn = (B.vx - B.w * r2y - A.vx + A.w * r1y) * nx + (B.vy + B.w * r2x - A.vy - A.w * r1x) * ny;
  if (vn < -restMin && -vn * rest > bias) bias = -vn * rest;
  c.bias = bias;
  // warm start with what held last step
  const px = c.pn * nx + c.pt * tx;
  const py = c.pn * ny + c.pt * ty;
  A.vx -= arb.ima * px;
  A.vy -= arb.ima * py;
  A.w -= arb.iia * (r1x * py - r1y * px);
  B.vx += arb.imb * px;
  B.vy += arb.imb * py;
  B.w += arb.iib * (r2x * py - r2y * px);
}

function solveCon(arb: Arb, c: Con) {
  const A = arb.a;
  const B = arb.b;
  const nx = arb.nx;
  const ny = arb.ny;
  const r1x = c.x - A.x;
  const r1y = c.y - A.y;
  const r2x = c.x - B.x;
  const r2y = c.y - B.y;
  let dvx = B.vx - B.w * r2y - A.vx + A.w * r1y;
  let dvy = B.vy + B.w * r2x - A.vy - A.w * r1x;
  let dp = c.mn * (-(dvx * nx + dvy * ny) + c.bias);
  const pn0 = c.pn;
  c.pn = Math.max(pn0 + dp, 0);
  dp = c.pn - pn0;
  let px = dp * nx;
  let py = dp * ny;
  A.vx -= arb.ima * px;
  A.vy -= arb.ima * py;
  A.w -= arb.iia * (r1x * py - r1y * px);
  B.vx += arb.imb * px;
  B.vy += arb.imb * py;
  B.w += arb.iib * (r2x * py - r2y * px);

  const tx = ny;
  const ty = -nx;
  dvx = B.vx - B.w * r2y - A.vx + A.w * r1y;
  dvy = B.vy + B.w * r2x - A.vy - A.w * r1x;
  dp = c.mt * -(dvx * tx + dvy * ty);
  const maxPt = arb.mu * c.pn;
  const pt0 = c.pt;
  c.pt = Math.max(-maxPt, Math.min(maxPt, pt0 + dp));
  dp = c.pt - pt0;
  px = dp * tx;
  py = dp * ty;
  A.vx -= arb.ima * px;
  A.vy -= arb.ima * py;
  A.w -= arb.iia * (r1x * py - r1y * px);
  B.vx += arb.imb * px;
  B.vy += arb.imb * py;
  B.w += arb.iib * (r2x * py - r2y * px);
}

interface Env {
  g: number;
  /** 0..~1.4: how much of the weight a build has taken away */
  lift: number;
  /** 0..1: quiet air, tags flutter down like paper */
  quiet: number;
  rest: number;
  tremble: number;
  /** pull toward upright while in the air (rad/s²) */
  right: number;
}

function physStep(st: St, h: number, env: Env) {
  const tags = st.tags;
  const n = tags.length;
  const u = st.u;
  st.stamp++;
  for (let i = 0; i < n; i++) {
    const b = tags[i];
    b.touch = 0;
    if (!b.asleep) refresh(b);
  }
  const floor = st.floor;
  floor.y = st.floorY + st.floorOff + floor.hy;

  // pairs
  for (let i = 0; i < n; i++) {
    const A = tags[i];
    if (A.state === 2) continue;
    if (!A.asleep) {
      if (A.state === 0 && A.y + A.ey > floor.y - floor.hy) touchPair(st, floor, A, 0.62);
      if (A.x - A.ex < 0) touchPair(st, st.wallL, A, 0.25);
      if (A.x + A.ex > st.W) touchPair(st, st.wallR, A, 0.25);
    }
    for (let j = i + 1; j < n; j++) {
      const B = tags[j];
      if (B.state === 2 || B.gen !== A.gen || (A.asleep && B.asleep)) continue;
      if (Math.abs(B.x - A.x) > A.ex + B.ex || Math.abs(B.y - A.y) > A.ey + B.ey) continue;
      touchPair(st, A, B, 0.5);
    }
  }
  // forget pairs that drifted apart (pairs of sleepers are not tested and keep their impulses)
  for (const [key, arb] of st.arbs) {
    if (arb.stamp === st.stamp) continue;
    const idleA = arb.a.im === 0 || arb.a.asleep;
    const idleB = arb.b.im === 0 || arb.b.asleep;
    if (arb.a.gone || arb.b.gone || !(idleA && idleB)) st.arbs.delete(key);
  }

  // forces
  const liftTop = st.H * 0.1;
  const liftSpan = st.H * 0.55;
  for (let i = 0; i < n; i++) {
    const b = tags[i];
    if (b.asleep) continue;
    if (b.state === 2) {
      b.vy += env.g * h;
      continue;
    }
    let ay = env.g;
    if (env.lift > 0 && b.state === 0) {
      // weight comes off near the floor and returns higher up, so the pile hangs in the middle of the frame
      const k = Math.max(0, Math.min(1, (b.y - liftTop) / liftSpan));
      ay -= env.g * env.lift * b.buoy * k;
      const drag = 1 - Math.min(0.5, h * 1.6 * Math.min(1, env.lift));
      b.vx *= drag;
      b.vy *= drag;
      b.vx += (rnd(st) - 0.5) * env.tremble * u * h * 9;
      b.vy += (rnd(st) - 0.5) * env.tremble * u * h * 9;
      b.w += (rnd(st) - 0.5) * env.tremble * h * 60;
    }
    if (env.quiet > 0 && b.state === 0) {
      // nothing under it and the room is quiet: flutter down like a slip of paper
      const air = b.vy > 0 ? env.quiet : 0;
      const sw = Math.sin(st.t * 2.7 + b.phase);
      b.vx += air * sw * 0.55 * u * h;
      b.w += air * Math.cos(st.t * 2.7 + b.phase) * 0.9 * h;
      const drag = 1 - h * 1.5 * air;
      b.vx *= drag;
      b.vy *= drag;
    }
    // a tag in the air leans back toward reading the right way up, like a card with a heavy edge
    if (b.touch === 0 && b.state === 0) b.w -= Math.sin(b.a) * env.right * h;
    b.vy += ay * h;
    b.vx *= 1 - h * 0.15;
    b.vy *= 1 - h * 0.15;
    b.w *= 1 - h * 0.7;
  }

  // contacts
  const invDt = 1 / h;
  const slop = 0.0012 * u;
  const maxBias = 0.55 * u;
  const restMin = 0.3 * u;
  for (const arb of st.arbs.values()) {
    if (arb.stamp !== st.stamp) continue;
    const A = arb.a;
    const B = arb.b;
    arb.ima = A.asleep ? 0 : A.im;
    arb.iia = A.asleep ? 0 : A.ii;
    arb.imb = B.asleep ? 0 : B.im;
    arb.iib = B.asleep ? 0 : B.ii;
    prepCon(arb, arb.c0, invDt, slop, maxBias, env.rest, restMin);
    if (arb.n > 1) prepCon(arb, arb.c1, invDt, slop, maxBias, env.rest, restMin);
  }
  for (let it = 0; it < ITERATIONS; it++) {
    for (const arb of st.arbs.values()) {
      if (arb.stamp !== st.stamp) continue;
      solveCon(arb, arb.c0);
      if (arb.n > 1) solveCon(arb, arb.c1);
    }
  }

  // move, and let whatever has stopped go to sleep
  const vMax = 4.2 * u;
  const stillV = 0.02 * u;
  const canSleep = env.lift <= 0.02;
  for (let i = 0; i < n; i++) {
    const b = tags[i];
    if (b.asleep) continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > vMax) {
      b.vx *= vMax / sp;
      b.vy *= vMax / sp;
    }
    if (b.w > 16) b.w = 16;
    else if (b.w < -16) b.w = -16;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.a += b.w * h;
    if (b.state !== 0) continue;
    if (canSleep && b.touch > 0 && sp < stillV && Math.abs(b.w) < 0.35) {
      b.still += h;
      if (b.still > 0.45) {
        b.asleep = true;
        b.vx = 0;
        b.vy = 0;
        b.w = 0;
        refresh(b);
      }
    } else b.still = 0;
  }
}

/* ───────────────────────── colour ───────────────────────── */

function rgbOf(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(a: string, b: string, t: number) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  const ch = (i: number) => Math.round(A[i] * (1 - t) + B[i] * t);
  return `#${((1 << 24) | (ch(0) << 16) | (ch(1) << 8) | ch(2)).toString(16).slice(1)}`;
}
function lum(hex: string) {
  const c = rgbOf(hex);
  return (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255;
}

/** tag colours and the ink that reads on each, from the five palette colours */
function inks(st: St, f: FrameContext) {
  const p = f.palette;
  const key = p.bg + p.fg + p.accent + p.accent2 + p.muted;
  if (key === st.palKey) return;
  st.palKey = key;
  const lb = lum(p.bg);
  const paperLight = lb > lum(p.fg);
  const raw = [p.accent, p.accent2, p.muted, p.fg, mix(p.accent2, p.fg, 0.5), mix(p.accent, p.muted, 0.5)];
  // a tag too close to the paper would vanish: pull it toward the ink
  st.cols = raw.map((c) => (Math.abs(lum(c) - lb) < 0.16 ? mix(c, p.fg, 0.5) : c));
  const pale = paperLight ? mix(p.bg, '#ffffff', 0.72) : p.fg;
  const dark = paperLight ? p.fg : p.bg;
  st.inks = st.cols.map((c) => (lum(c) > 0.7 ? dark : pale));
  st.dust = mix(p.bg, p.fg, paperLight ? 0.2 : 0.3);
}

/* ───────────────────────── words ───────────────────────── */

const clean = (s: string) => s.replace(/^[\s"“”‘([{¿¡]+|[\s"“”)\]},.;:]+$/g, '').toLowerCase();
const split = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean);

/** every sung word with a time; lines without word timings are spread across the line by word length */
function sungWords(l: Lyrics): SungWord[] {
  const out: SungWord[] = [];
  l.lines.forEach((ln, li) => {
    if (ln.words?.length) {
      for (const w of ln.words) for (const part of split(w.text)) out.push({ t: w.t, text: part, line: li });
      return;
    }
    const ws = split(ln.text);
    if (!ws.length) return;
    const next = l.lines[li + 1];
    let end = ln.end > ln.t ? ln.end : ln.t + 3;
    if (next && next.t > ln.t) end = Math.min(end, next.t);
    const span = Math.max(0.2, Math.min((end - ln.t) * 0.9, ws.length * 0.7));
    const total = ws.reduce((s, x) => s + x.length + 1, 0);
    let acc = 0;
    for (const w of ws) {
      out.push({ t: ln.t + (span * acc) / total, text: w, line: li });
      acc += w.length + 1;
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

function lyricsNow(): Lyrics | null {
  try {
    return useStudio.getState().lyrics ?? null;
  } catch {
    return null;
  }
}

/** the song's own words for when nobody is singing: title, artist, then what the analyser heard */
function songFacts(st: St, f: FrameContext, loose: string[]): string[] {
  const info = songInfo();
  const an = f.analysis;
  const key = `${info.title}|${info.artist}|${f.text}|${an ? an.bpm + an.summary.length : 0}|${loose.length}`;
  if (key === st.factsKey) return st.facts;
  st.factsKey = key;
  const out: string[] = [];
  const push = (s: string | undefined) => {
    for (const w of split(s)) if (clean(w)) out.push(w);
  };
  push(f.text);
  if (info.title !== 'Untitled') push(info.title);
  st.titleN = out.length;
  if (info.artist !== 'Unknown artist') push(info.artist);
  if (loose.length) out.push(...loose);
  else if (an) {
    push(an.character?.genre);
    push(an.character?.mood);
    an.character?.instruments.forEach(push);
    an.tags.forEach(push);
    push(`${Math.round(an.bpm)} bpm`);
  }
  if (out.length < 5) push('hum a little tune hold it close let it fall');
  st.facts = out;
  st.fi = 0;
  return out;
}

/** a place to drop the next few words: of three tries, the one over the lowest part of the pile */
function pickColumn(st: St) {
  const m = Math.min(st.W * 0.3, st.u * 0.2);
  let best = st.W / 2;
  let bestTop = -Infinity;
  for (let k = 0; k < 3; k++) {
    const x = m + rnd(st) * (st.W - 2 * m);
    let top = st.floorY;
    for (const t of st.tags) if (t.state === 0 && Math.abs(t.x - x) < st.u * 0.14 && t.y - t.ey < top) top = t.y - t.ey;
    const score = top - (Math.abs(x - st.colX) < st.W * 0.18 ? st.u * 0.15 : 0);
    if (score > bestTop) {
      bestTop = score;
      best = x;
    }
  }
  return best;
}

interface DropOpts {
  x: number;
  scale: number;
  rot?: number;
  y?: number;
  vy?: number;
}

function spawn(ctx: CanvasRenderingContext2D, st: St, f: FrameContext, raw: string, o: DropOpts): Tag | null {
  const text = clean(raw);
  if (!text) return null;
  const face = FACES[str(f.params, 'font', 'sans')] ?? FACES.sans;
  // em = the tag's own unit; the type sits inside it at the face's scale
  let em = st.u * 0.047 * num(f.params, 'size', 1) * o.scale;
  const fontOf = (e: number) => `${face.italic ? 'italic ' : ''}${face.weight} ${(e * face.scale).toFixed(1)}px ${face.family}`;
  ctx.font = fontOf(em);
  let tw = ctx.measureText(text).width;
  const maxW = st.W * 0.74;
  if (tw + em > maxW) {
    const k = maxW / (tw + em);
    em *= k;
    tw *= k;
  }
  const hx = tw / 2 + em * 0.46;
  const hy = em * 0.74;
  const r = em * 0.34;
  const path = new Path2D();
  path.moveTo(-hx + r, -hy);
  path.arcTo(hx, -hy, hx, hy, r);
  path.arcTo(hx, hy, -hx, hy, r);
  path.arcTo(-hx, hy, -hx, -hy, r);
  path.arcTo(-hx, -hy, hx, -hy, r);
  path.closePath();

  const x = Math.max(hx + 2, Math.min(st.W - hx - 2, o.x));
  let y = o.y ?? hy + st.H * (0.03 + rnd(st) * 0.05);
  if (o.y === undefined) {
    // if the pile has grown into the drop zone, start above it
    for (const t of st.tags) if (t.state === 0 && Math.abs(t.x - x) < hx + t.ex && t.y - t.ey < y + hy * 2) y = Math.min(y, t.y - t.ey - hy * 2);
  }
  const mass = (hx * hy * 400) / (st.u * st.u);
  const body = makeBody(st.nextId++, x, y, hx, hy, mass);
  // never the same colour twice running
  const nCols = st.cols.length;
  let col = (st.ci + 1 + (text.length % 2) + Math.floor(rnd(st) * 2)) % nCols;
  if (col === st.ci) col = (col + 1) % nCols;
  st.ci = col;
  const tag: Tag = {
    ...body,
    a: o.rot ?? (rnd(st) - 0.5) * 0.22,
    vy: o.vy ?? 0,
    w: (rnd(st) - 0.5) * 0.9,
    text,
    font: fontOf(em),
    base: em * face.base,
    round: em * face.round,
    col,
    path,
    img: null,
    imgKey: '',
    born: st.t,
    gen: st.gen,
    state: 0,
    fade: 1,
    glint: 0,
    phase: rnd(st) * 6.283,
    buoy: 0.72 + rnd(st) * 0.56,
  };
  refresh(tag);
  st.tags.push(tag);
  return tag;
}

/** paint a tag into its own little canvas: the pill and the word, with a hairline stroke that rounds the letters */
function paint(st: St, t: Tag, ss: number) {
  const cv = t.img ?? document.createElement('canvas');
  cv.width = Math.ceil((t.hx * 2 + 4) * ss);
  cv.height = Math.ceil((t.hy * 2 + 4) * ss);
  const g = cv.getContext('2d')!;
  g.setTransform(ss, 0, 0, ss, cv.width / 2, cv.height / 2);
  g.fillStyle = st.cols[t.col % st.cols.length];
  g.fill(t.path);
  const ink = st.inks[t.col % st.inks.length];
  g.font = t.font;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.fillText(t.text, 0, t.base);
  if (t.round > 0) {
    g.lineJoin = 'round';
    g.strokeStyle = ink;
    g.lineWidth = t.round;
    g.strokeText(t.text, 0, t.base);
  }
  t.img = cv;
  t.imgKey = st.palKey;
}

/** open the floor: everything on it falls through, from one side to the other */
function sweep(st: St) {
  if (!st.tags.some((t) => t.state === 0)) return;
  st.gen++;
  st.sweepT = 0;
  st.sweepDir = -st.sweepDir;
  for (const t of st.tags) wake(t);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function init(w: number, h: number): St {
  const u = Math.min(w, h);
  const thick = 2 * u;
  const floorY = h - u * 0.03;
  const floor = makeBody(1, w / 2, floorY + thick, w * 2, thick, 0);
  const wallL = makeBody(2, -thick, -h, thick, h * 5, 0);
  const wallR = makeBody(3, w + thick, -h, thick, h * 5, 0);
  return {
    W: w,
    H: h,
    u,
    seed: 20240611,
    t: 0,
    acc: 0,
    nextId: 4,
    tags: [],
    arbs: new Map(),
    stamp: 0,
    floor,
    wallL,
    wallR,
    floorY,
    floorOff: 0,
    floorV: 0,
    e: -1,
    lift: 0,
    slam: 0,
    flash: 0,
    shake: 0,
    shakeV: 0,
    noLift: 0,
    prevDrop: 1,
    sec: -2,
    gen: 0,
    sweepT: -1,
    sweepDir: 1,
    lyr: null,
    words: [],
    wi: 0,
    lastT: -1,
    sweptWi: -1,
    factsKey: '',
    facts: [],
    titleN: 0,
    fi: 0,
    fill: 0.35,
    colX: w / 2,
    colLeft: 0,
    colLine: -1,
    ci: 0,
    kicks: 0,
    snares: 0,
    hitWordAt: -10,
    queue: [],
    puffs: [],
    palKey: '',
    cols: [],
    inks: [],
    dust: '#000000',
  };
}

export const wordDrop = defineCanvasScene<St>({
  id: 'word-drop',
  name: 'Word Drop',
  description:
    'Every sung word drops in as a little rounded colour tag, falls, bounces and comes to rest, so the lyric piles up on warm paper. Kicks thump the floor and the pile hops, snares spin the newest tags, a build floats the whole pile and the drop slams it back down under a burst of big chorus words. Each new part of the song opens the floor and starts clean; without lyrics it drops the title, artist and part names instead.',
  category: 'field',
  style: 'type',
  tags: ['lyrics', 'typographic', 'playful', 'tender', 'romantic', 'pop', 'indie', 'warm', 'bouncy', 'happy', 'tactile', 'graphic'],
  params,
  light: true,
  showsLyrics: true,
  modulations: [
    { source: 'energy', param: 'hop', amount: 0.25 },
    { source: 'build', param: 'spin', amount: 0.3 },
  ],
  setup: (_ctx, w, h) => init(w, h),
  draw(ctx, f, st) {
    const a = f.audio;
    const dt = Math.min(Math.max(f.dt, 0), 1 / 20);
    st.t += dt;
    const W = st.W;
    const H = st.H;
    const u = st.u;
    const p = f.palette;
    inks(st, f);

    const hop = num(f.params, 'hop', 0.6);
    const spin = num(f.params, 'spin', 0.5);
    const rain = num(f.params, 'rain', 0.5);
    const cap = Math.round(num(f.params, 'cap', 64));
    const bps = a.bpm > 0 ? a.bpm / 60 : 2;

    // slow state: how loud the part is (eased over a second or so)
    st.e = st.e < 0 ? a.energy : st.e + (a.energy - st.e) * (1 - Math.exp(-1.4 * dt));
    const e = st.e;
    const loud = Math.max(0.8, Math.min(1.5, 0.8 + 0.62 * a.level));

    // ── where the words come from ──
    const lyr = str(f.params, 'words', 'auto') === 'auto' ? lyricsNow() : null;
    if (lyr !== st.lyr) {
      st.lyr = lyr;
      st.words = lyr?.synced ? sungWords(lyr) : [];
      st.lastT = -1;
      st.factsKey = '';
    }
    const words = st.words;
    const sung = words.length > 0;
    const now = a.time;
    if (sung && (st.lastT < 0 || now < st.lastT - 0.05 || now - st.lastT > 1.5)) {
      // just started or jumped: pick the song up from here
      let lo = 0;
      let hi = words.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (words[m].t <= now - 0.02) lo = m + 1;
        else hi = m;
      }
      st.wi = lo;
    }
    st.lastT = now;
    const near = sung && ((st.wi > 0 && now - words[st.wi - 1].t < 2.2) || (st.wi < words.length && words[st.wi].t - now < 1.4));

    // ── a new part of the song: open the floor (a build or a drop keeps the pile, they need it) ──
    const si = sectionIndex(f);
    if (st.sec === -2) st.sec = si;
    else if (si !== st.sec) {
      st.sec = si;
      const label = f.analysis?.sections[si]?.label;
      const nearDrop = (f.analysis?.drops ?? []).some((d) => Math.abs(d - now) < 1.5) || a.drop > 0.3 || a.build > 0.35 || st.lift > 0.2;
      if (label !== 'build' && !nearDrop) sweep(st);
      if (label && !near) st.queue.push({ at: st.t + 0.3, text: label, scale: 1.2, x: -1, soft: true });
    }
    if (!f.analysis && sung && st.wi > 0 && st.wi < words.length && st.sweptWi !== st.wi && words[st.wi].t - words[st.wi - 1].t > 6 && now - words[st.wi - 1].t > 2.5) {
      // no analysis yet: a long silence between lines counts as a new part
      st.sweptWi = st.wi;
      sweep(st);
    }
    if (st.sweepT >= 0) {
      st.sweepT += dt;
      const open = smooth(0, 0.32, st.sweepT);
      const edge = st.sweepDir > 0 ? open * W : W - open * W;
      const done = st.sweepT > 0.9;
      for (const t of st.tags) {
        if (t.state !== 0 || t.gen === st.gen) continue;
        if (done || (st.sweepDir > 0 ? t.x - t.ex * 0.5 < edge : t.x + t.ex * 0.5 > edge)) {
          t.state = 1;
          wake(t);
          t.w += (rnd(st) - 0.5) * 3;
        }
      }
      if (done) st.sweepT = -1;
    }

    // ── sung words, each on its own time ──
    if (sung && a.playing) {
      let guard = 0;
      while (st.wi < words.length && words[st.wi].t <= now && guard++ < 6) {
        const w = words[st.wi++];
        if (w.line !== st.colLine) {
          st.colLine = w.line;
          st.colX = pickColumn(st);
        }
        const x = st.colX + (rnd(st) - 0.5) * u * 0.07;
        st.colX += (rnd(st) - 0.5) * u * 0.05;
        spawn(ctx, st, f, w.text, { x, scale: loud });
        // loud parts rain: the word comes down again, smaller, somewhere else
        if (rnd(st) < rain * smooth(0.55, 0.9, e) * 1.2) st.queue.push({ at: st.t + 0.5 / bps, text: w.text, scale: loud * 0.72, x: -1, soft: false });
      }
    }

    // ── nobody singing: the song's own words, at a pace set by how loud the part is ──
    const live = st.tags.reduce((s, t) => s + (t.state === 0 ? 1 : 0), 0);
    const loose = !sung && lyr && !lyr.synced ? lyr.lines.flatMap((ln) => split(ln.text)) : [];
    st.fill -= dt;
    if (!near && st.fill <= 0) {
      const facts = songFacts(st, f, loose);
      if (st.colLeft <= 0) {
        st.colX = pickColumn(st);
        st.colLeft = 2 + Math.floor(rnd(st) * 3);
      }
      st.colLeft--;
      const x = st.colX + (rnd(st) - 0.5) * u * 0.08;
      const fi = st.fi++ % facts.length;
      if (a.playing || live < 10) spawn(ctx, st, f, facts[fi], { x, scale: loud * (fi < st.titleN ? 1.4 : 1) });
      let gap = (4 - 2.5 * e) / bps;
      if (live < 4) gap = Math.min(gap, 0.62);
      if (!a.playing) gap = 2.4;
      st.fill = gap;
    }
    if (!sung && e > 0.35 && st.t - st.hitWordAt > 1.6) {
      // instrumentals name a few of their own hits
      if (a.kickHit && st.kicks % 8 === 4) {
        st.hitWordAt = st.t;
        st.queue.push({ at: st.t, text: 'kick', scale: 0.8, x: -1, soft: false });
      } else if (a.snareHit && st.snares % 8 === 3) {
        st.hitWordAt = st.t;
        st.queue.push({ at: st.t, text: 'snare', scale: 0.8, x: -1, soft: false });
      }
    }
    if (a.kickHit) st.kicks++;
    if (a.snareHit) st.snares++;

    // ── hits ──
    if (a.kickHit && hop > 0) {
      // the floor thumps and everything on it hops
      const k = Math.max(0.45, a.kick) * hop * (0.55 + 0.75 * e);
      st.floorV -= k * u;
      for (const t of st.tags) {
        if (t.state !== 0) continue;
        wake(t);
        t.vy -= 0.5 * Math.pow(k, 0.7) * u * (0.7 + 0.6 * rnd(st));
        t.vx += (rnd(st) - 0.5) * k * 0.07 * u;
        t.w += (rnd(st) - 0.5) * k * 0.7;
      }
    }
    if (a.snareHit && spin > 0) {
      // the newest few get a flick
      let left = 4;
      for (let i = st.tags.length - 1; i >= 0 && left > 0; i--) {
        const t = st.tags[i];
        if (t.state !== 0) continue;
        left--;
        wake(t);
        const k = spin * (0.5 + 0.7 * a.snare) * (left + 2) * 0.2;
        t.w += (rnd(st) < 0.5 ? -1 : 1) * k * 5.5;
        t.vy -= k * 0.22 * u;
      }
    }
    if (a.hatHit) {
      // a glint along the edge of one or two recent tags
      for (let k = 0; k < 2; k++) {
        const t = st.tags[st.tags.length - 1 - Math.floor(rnd(st) * Math.min(14, st.tags.length))];
        if (t && t.state === 0) t.glint = 1;
      }
    }

    // ── build: the weight comes off; drop: it all comes back at once ──
    st.noLift = Math.max(0, st.noLift - dt);
    const wantLift = st.noLift > 0 ? 0 : num(f.params, 'lift', 0.8) * smooth(0.12, 0.8, Math.max(a.build, f.feel.tension));
    st.lift += (wantLift - st.lift) * (1 - Math.exp(-(wantLift > st.lift ? 3 : 12) * dt));
    if (st.lift > 0.02) for (const t of st.tags) if (t.asleep) wake(t);
    const dropNow = a.drop > 0.6 && st.prevDrop <= 0.6;
    st.prevDrop = a.drop;
    if (dropNow) {
      st.slam = 1;
      st.flash = 1;
      st.noLift = 1.2;
      st.lift = 0;
      st.floorV += 1.5 * u;
      st.shakeV += 1.1 * u;
      for (const t of st.tags) {
        if (t.state === 2) continue;
        wake(t);
        t.vy = Math.max(t.vy, 0) + u * (1.5 + 0.7 * rnd(st));
        t.w += (rnd(st) - 0.5) * 5;
      }
      // the chorus line (or the title) comes down in big tags
      let burst: string[] = [];
      if (sung) {
        const from = st.wi < words.length && words[st.wi].t - now < 5 ? words[st.wi].line : -1;
        if (from >= 0) burst = words.filter((w) => w.line === from).map((w) => w.text);
      }
      if (burst.length < 3) burst = burst.concat(split(songInfo().title));
      burst = burst.slice(0, 7);
      const order = burst.map((_, i) => i).sort(() => rnd(st) - 0.5);
      burst.forEach((text, i) => {
        const x = (W * (order[i] + 0.5)) / burst.length + (rnd(st) - 0.5) * u * 0.08;
        spawn(ctx, st, f, text, { x, scale: 1.95, rot: (rnd(st) - 0.5) * 0.9, y: -H * (0.1 + 0.16 * i + 0.1 * rnd(st)), vy: 1.3 * u });
      });
    }
    st.slam = Math.max(0, st.slam - dt * 2.2);
    st.flash = Math.max(0, st.flash - dt * 3.5);

    // ── queued drops (part names, echoes) ──
    for (let i = st.queue.length - 1; i >= 0; i--) {
      const q = st.queue[i];
      if (q.at > st.t) continue;
      st.queue.splice(i, 1);
      const m = u * 0.12;
      const x = q.x >= 0 ? q.x : q.soft ? W * (0.3 + 0.4 * rnd(st)) : m + rnd(st) * (W - 2 * m);
      spawn(ctx, st, f, q.text, { x, scale: q.scale, rot: (rnd(st) - 0.5) * (q.soft ? 0.3 : 1.1) });
    }

    // ── over the cap: the oldest sink away ──
    let over = live - cap;
    for (let i = 0; i < st.tags.length && over > 0; i++) {
      const t = st.tags[i];
      if (t.state !== 0) continue;
      t.state = 2;
      t.gone = true;
      wake(t);
      t.vy = Math.max(t.vy, 0.1 * u);
      over--;
      for (const o of st.tags) wake(o);
    }

    // ── floor spring, shake ──
    st.floorV += (-st.floorOff * 520 - st.floorV * 24) * dt;
    st.floorOff += st.floorV * dt;
    st.floorOff = Math.max(-0.02 * u, Math.min(0.03 * u, st.floorOff));
    st.shakeV += (-st.shake * 700 - st.shakeV * 22) * dt;
    st.shake += st.shakeV * dt;

    // ── physics ──
    const quiet = 1 - smooth(0.2, 0.5, e);
    const env: Env = {
      g: 2.7 * num(f.params, 'gravity', 1) * (0.5 * u + 0.5 * H) * (0.6 + 0.4 * (1 - quiet)) * (1 + 2.2 * st.slam),
      lift: st.lift * 1.5,
      quiet,
      rest: Math.min(0.8, num(f.params, 'bounce', 0.3) + 0.25 * st.slam),
      tremble: st.lift * (0.35 + 0.65 * a.build),
      right: 16,
    };
    st.acc += dt;
    let steps = 0;
    while (st.acc >= STEP && steps < 6) {
      physStep(st, STEP, env);
      st.acc -= STEP;
      steps++;
    }
    if (st.acc > STEP) st.acc = 0;

    // ── tidy: gone below the frame, faded out, or broken ──
    for (let i = st.tags.length - 1; i >= 0; i--) {
      const t = st.tags[i];
      if (t.state === 2) t.fade -= dt * 2.4;
      t.glint = Math.max(0, t.glint - dt * 7);
      const lost = !isFinite(t.x + t.y + t.a) || t.y - t.ey > H + u * 0.6 || t.fade <= 0;
      if (lost) {
        t.gone = true;
        st.tags.splice(i, 1);
      }
    }

    // ── draw ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    // paper: warms a touch with the song, darkens as a build winds up, flashes pale on the drop
    const tension = smooth(0.1, 1, Math.max(a.build, f.feel.tension)) * (st.noLift > 0 ? 0 : 1);
    let paper = mix(p.bg, p.accent, 0.05 * e);
    paper = mix(paper, p.fg, 0.14 * tension);
    if (st.flash > 0) paper = mix(paper, lum(p.bg) > 0.5 ? '#ffffff' : p.fg, 0.5 * st.flash * st.flash);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);

    const oy = st.shake;
    const jit = st.lift * 0.0035 * u;
    const breathe = 0.5 + 0.5 * quiet;
    const shadow = lum(p.bg) > lum(p.fg) ? mix(p.bg, p.fg, 0.55) : mix(p.bg, '#000000', 0.7);
    const sh = u * 0.0045;
    // tags are painted once at up to twice the size, so they stay crisp when they turn
    const ss = Math.max(1, Math.min(2, 1500 / u));
    for (const t of st.tags) {
      const age = st.t - t.born;
      // pops in a little over-size, then settles
      let k = age < 0.16 ? 0.35 + 0.65 * Math.sin((age / 0.16) * 1.9) / Math.sin(1.9) : 1;
      k *= 1 + 0.05 * t.glint;
      const idle = Math.sin(st.t * 1.1 + t.phase);
      const ang = t.a + idle * 0.007 * breathe;
      const c = Math.cos(ang) * k;
      const s = Math.sin(ang) * k;
      const x = t.x + (jit > 0 ? (rnd(st) - 0.5) * jit : 0);
      const y = t.y + oy + idle * 0.0012 * u * breathe + (jit > 0 ? (rnd(st) - 0.5) * jit : 0);
      if (y - t.ey - t.hy > H || y + t.ey + t.hy < 0) continue;
      const alpha = t.fade;
      ctx.globalAlpha = 0.2 * alpha;
      ctx.setTransform(c, s, -s, c, x + sh * 0.6, y + sh);
      ctx.fillStyle = shadow;
      ctx.fill(t.path);
      ctx.globalAlpha = alpha;
      ctx.setTransform(c, s, -s, c, x, y);
      if (!t.img || t.imgKey !== st.palKey) paint(st, t, ss);
      const img = t.img!;
      ctx.drawImage(img, -img.width / (2 * ss), -img.height / (2 * ss), img.width / ss, img.height / ss);
      if (t.glint > 0.02) {
        ctx.globalAlpha = alpha * t.glint * 0.85;
        ctx.strokeStyle = st.inks[t.col % st.inks.length];
        ctx.lineWidth = u * 0.004;
        ctx.stroke(t.path);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // dust
    if (st.puffs.length) {
      ctx.fillStyle = st.dust;
      for (let i = st.puffs.length - 1; i >= 0; i--) {
        const q = st.puffs[i];
        q.life -= dt * 2.6;
        if (q.life <= 0) {
          st.puffs.splice(i, 1);
          continue;
        }
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.vx *= 1 - 3 * dt;
        q.vy *= 1 - 3 * dt;
        ctx.globalAlpha = 0.55 * q.life;
        ctx.beginPath();
        ctx.arc(q.x, q.y + oy, q.r * (1.6 - 0.6 * q.life), 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // the floor: a strip of darker paper that bumps on the kick and slides open between parts
    const fy = st.floorY + st.floorOff + oy;
    const open = st.sweepT < 0 ? 0 : smooth(0, 0.32, st.sweepT) * (1 - smooth(0.6, 0.9, st.sweepT));
    ctx.fillStyle = mix(paper, p.fg, 0.1 + 0.06 * a.kick);
    const x0 = st.sweepDir > 0 ? open * W : 0;
    ctx.fillRect(x0, fy, W * (1 - open), H - fy + 2);
  },
});
