import * as THREE from 'three';
import { createFullscreenQuad } from '../../core/sceneHelpers';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { DropTimer } from '../nature/volume';
import { makeMaterial, stepDt, syncMaterial } from '../three/common';
import { isCoarse } from './common';

/**
 * Chalk: snowflakes drawn on a blackboard, stroke by stroke, the way you'd draw one by hand: a dot,
 * six spokes reaching out together, branches budding off as the line passes, little chevrons and
 * dots at the tips. Every flake is a different design (branched, fern, chevron, plate, double-line
 * star, dotted), each arm a little off from the others because a hand drew it.
 *
 *   - the quiet draws one big flake slowly; as the song grows the flakes get smaller, faster and
 *     more of them at once, until the board fills with a flurry
 *   - the drawing speeds up just after each beat, so the lines arrive in phrases with the music
 *   - kicks tap snow dots onto the board, warm or tense passages reach for the coloured chalk
 *   - a new section sends the eraser across part of the board (leaving that ghostly smear real
 *     boards keep); the drop wipes the lot in a few fast swipes and a burst of flakes follows
 *
 * The strokes live on a 2D canvas (one colour channel per chalk: R = fg, G = accent, B = accent2);
 * a shader lays them on a slate made of the palette with old chalk dust in it.
 *
 * Palette roles: bg = the board, muted = old chalk dust on it, fg = white chalk, accent and accent2
 * = coloured chalk (accent2 also the kick dots).
 */

const params: ParamDef[] = [
  { id: 'amount', label: 'Flakes', group: 'Shape', type: 'number', min: 0.2, max: 2, step: 0.01, default: 1, hint: 'How many flakes at once at full song' },
  { id: 'size', label: 'Flake size', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
  { id: 'speed', label: 'Drawing speed', group: 'Motion', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1 },
  { id: 'colour', label: 'Coloured chalk', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How often the coloured chalk comes out' },
  { id: 'erase', label: 'Eraser', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Sections and drops wipe the board' },
  { id: 'dust', label: 'Board dust', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
];

/** the header already declares vUv */
const BOARD_VERT = /* glsl */ `
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BOARD_FRAG = /* glsl */ `
uniform sampler2D tChalk;
uniform float uDust, uFlashK;
void main() {
  vec2 uv = vUv;
  vec3 ch = texture2D(tChalk, uv).rgb;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  // the slate: the board colour with clouds of old chalk and the horizontal ghosts of past wipes
  float cloud = fbm(p * 1.7 + 3.1, 4);
  float wipe = fbm(vec2(p.x * 0.9, p.y * 6.0) + 7.0, 3);
  vec3 board = uBg;
  board = mix(board, uMuted, clamp(0.35 * uDust * smoothstep(-0.1, 0.7, cloud), 0.0, 0.6));
  board = mix(board, uFg, 0.045 * uDust * smoothstep(0.0, 0.8, wipe));
  float vig = 1.0 - 0.32 * pow(length((uv - 0.5) * vec2(1.0, 1.15)) * 1.25, 2.4);
  board *= vig;
  board += (hash21(gl_FragCoord.xy) - 0.5) * 0.03;
  // chalk catches on the tooth of the board: a fine grain at screen resolution
  float tooth = 0.7 + 0.55 * hash21(floor(gl_FragCoord.xy * 0.8) + 0.5);
  vec3 a = clamp(ch * tooth * 1.2, 0.0, 1.0);
  vec3 col = board;
  col = mix(col, uFg, a.r * 0.96);
  col = mix(col, uAccent, a.g * 0.95);
  col = mix(col, uAccent2, a.b * 0.95);
  col += uFg * uFlashK * 0.06;
  gl_FragColor = vec4(col, 1.0);
}
`;

type Pt = [number, number];
/** one line of an arm, in arm units (the arm reaches x = 1); `mirror` draws it on both sides of the spoke */
interface Prim {
  pts: Pt[];
  w: number;
  mirror: boolean;
}
interface ArmDot {
  at: Pt;
  r: number;
  mirror: boolean;
}
/** one stroke on the canvas: px points, arc length in arm units */
interface Stroke {
  pts: Pt[];
  cum: number[];
  r0: number;
  len: number;
  w: number;
  alpha: number;
  drawn: number;
}
interface Dot {
  x: number;
  y: number;
  r: number;
  r0: number;
  done: boolean;
}
interface Flake {
  x: number;
  y: number;
  R: number;
  ch: number;
  strokes: Stroke[];
  dots: Dot[];
  g: number;
  gEnd: number;
  speed: number;
  alive: boolean;
}
interface Wipe {
  path: Pt[];
  cum: number[];
  len: number;
  done: number;
  speed: number;
  w: number;
}

type Rnd = () => number;
const line = (x0: number, y0: number, x1: number, y1: number, w = 1, mirror = true): Prim => ({ pts: [[x0, y0], [x1, y1]], w, mirror });
const rot60 = (r: number, a: number): Pt => [r * Math.cos(a), r * Math.sin(a)];

/** a design for one arm; the flake repeats it six times */
function designArm(rnd: Rnd): { prims: Prim[]; dots: ArmDot[] } {
  const prims: Prim[] = [];
  const dots: ArmDot[] = [];
  const kind = Math.floor(rnd() * 6);
  const ang = (Math.PI / 180) * (42 + rnd() * 20);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const branch = (x: number, l: number, w = 0.8) => prims.push(line(x, 0, x + ca * l, sa * l, w));
  const spine = (x0: number, x1: number, w = 1) => prims.push(line(x0, 0, x1, 0, w, false));
  const chevron = (x: number, s: number, w = 0.8) => prims.push({ pts: [[x, 0], [x - s, s * 1.05]], w, mirror: true });
  const hexRing = (r: number, w = 0.8) => prims.push({ pts: [[r, 0], rot60(r, Math.PI / 3)], w, mirror: false });
  const tipDot = (x: number, r = 0.035) => dots.push({ at: [x, 0], r, mirror: false });

  if (kind === 0) {
    // branched: two or three pairs of branches, a chevron or dot at the tip
    spine(0.06, 1);
    const n = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const x = 0.3 + (i / Math.max(1, n - 1)) * 0.38 + (rnd() - 0.5) * 0.05;
      branch(x, (0.32 - i * 0.07) * (0.85 + rnd() * 0.3));
    }
    if (rnd() < 0.5) chevron(1, 0.09);
    else tipDot(1.05);
  } else if (kind === 1) {
    // fern: a feathered spoke, branches every little way, shortening out
    spine(0.04, 1, 0.9);
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const x = 0.22 + (i / n) * 0.72;
      branch(x, 0.2 * (1 - (i / n) * 0.65), 0.65);
    }
  } else if (kind === 2) {
    // chevrons stacked up the spoke, pointing out
    spine(0.05, 1);
    const n = 3 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const x = 0.38 + (i / Math.max(1, n - 1)) * 0.6;
      chevron(x, 0.14 * (1 - i * 0.12), 0.85);
    }
  } else if (kind === 3) {
    // a plate: a hexagon or two, the spokes running on to diamond tips
    const rp = 0.3 + rnd() * 0.12;
    hexRing(rp, 0.95);
    if (rnd() < 0.6) hexRing(rp * 0.55, 0.7);
    spine(0.05, 0.82);
    prims.push({ pts: [[0.8, 0], [0.9, 0.065], [1.0, 0]], w: 0.85, mirror: true });
    if (rnd() < 0.6) branch(rp + 0.1, 0.13, 0.7);
  } else if (kind === 4) {
    // a double-line star: two lines meeting at the tip, a branch pair through the middle
    prims.push({ pts: [[0.1, 0.045], [1, 0]], w: 0.85, mirror: true });
    if (rnd() < 0.6) spine(0.1, 0.62, 0.6);
    branch(0.55, 0.16 + rnd() * 0.08, 0.75);
    tipDot(1.06, 0.03);
  } else {
    // dotted: a spoke, a pair of branches ending in dots, dots between the arms
    spine(0.06, 0.88);
    tipDot(0.98, 0.04);
    const x = 0.42 + rnd() * 0.12;
    const l = 0.22 + rnd() * 0.08;
    branch(x, l);
    dots.push({ at: [x + ca * l + 0.03, sa * l + 0.03], r: 0.028, mirror: true });
    dots.push({ at: rot60(0.36 + rnd() * 0.1, Math.PI / 6), r: 0.03, mirror: false });
  }
  // the middle: a small hexagon, sometimes
  if (rnd() < 0.45) hexRing(0.1 + rnd() * 0.04, 0.8);
  return { prims, dots };
}

/** a chalk pattern for one channel: grain with holes in it */
function chalkPattern(g: CanvasRenderingContext2D, channel: 0 | 1 | 2): CanvasPattern {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d')!;
  const img = x.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const r = Math.random();
    const v = r < 0.72 ? 150 + 105 * Math.random() : Math.random() * 70;
    img.data[i * 4 + channel] = v;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return g.createPattern(c, 'repeat')!;
}

/** sample a point at arc length s (arm units) along a stroke */
function at(s: Stroke, d: number): Pt {
  const { pts, cum } = s;
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= d) {
      const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
  }
  return pts[pts.length - 1];
}

/** lay out a flake's strokes on the canvas: six arms (and their mirrors), each wobbling a little differently */
function buildFlake(x: number, y: number, R: number, wPx: number, ch: number, rnd: Rnd): Flake {
  const { prims, dots } = designArm(rnd);
  const strokes: Stroke[] = [];
  const fdots: Dot[] = [];
  const rot0 = rnd() * Math.PI;
  let gEnd = 0;
  for (let k = 0; k < 6; k++) {
    const th = rot0 + (k * Math.PI) / 3 + (rnd() - 0.5) * 0.05;
    const sc = R * (0.95 + rnd() * 0.1);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const place = (p: Pt): Pt => [x + (p[0] * ct - p[1] * st) * sc, y + (p[0] * st + p[1] * ct) * sc];
    for (const pr of prims) {
      for (const m of pr.mirror ? [1, -1] : [1]) {
        // resample with a hand's wobble
        const raw = pr.pts.map(([a, b]) => [a, b * m] as Pt);
        const pts: Pt[] = [];
        const cum: number[] = [];
        let acc = 0;
        const ph = rnd() * 6.28;
        const amp = 0.006 + rnd() * 0.006;
        for (let i = 0; i < raw.length - 1; i++) {
          const [ax, ay] = raw[i];
          const [bx, by] = raw[i + 1];
          const L = Math.hypot(bx - ax, by - ay);
          const n = Math.max(2, Math.ceil(L / 0.04));
          const nx = -(by - ay) / Math.max(L, 1e-6);
          const ny = (bx - ax) / Math.max(L, 1e-6);
          for (let j = i === 0 ? 0 : 1; j <= n; j++) {
            const t = j / n;
            const wob = Math.sin(ph + (acc + t * L) * 9) * amp * Math.sin(Math.PI * t);
            pts.push(place([ax + (bx - ax) * t + nx * wob, ay + (by - ay) * t + ny * wob]));
            cum.push(acc + t * L);
          }
          acc += L;
        }
        const r0 = Math.hypot(raw[0][0], raw[0][1]);
        strokes.push({ pts, cum, r0, len: acc, w: wPx * pr.w * (0.9 + rnd() * 0.2), alpha: 0.75 + rnd() * 0.25, drawn: 0 });
        gEnd = Math.max(gEnd, r0 + acc);
      }
    }
    for (const d of dots) {
      for (const m of d.mirror ? [1, -1] : [1]) {
        const p = place([d.at[0], d.at[1] * m]);
        const r0 = Math.hypot(d.at[0], d.at[1]);
        fdots.push({ x: p[0], y: p[1], r: Math.max(wPx * 0.7, d.r * R), r0, done: false });
        gEnd = Math.max(gEnd, r0 + 0.05);
      }
    }
  }
  // the first touch: a dot in the middle
  fdots.push({ x, y, r: wPx * 0.9, r0: 0, done: false });
  return { x, y, R, ch, strokes, dots: fdots, g: 0, gEnd: gEnd + 0.02, speed: 1, alive: true };
}

export const chalk: SceneDef = {
  id: 'snow-chalk',
  name: 'Chalk Flakes',
  description:
    'Snowflakes drawn in chalk on a blackboard, stroke by stroke: a dot, six spokes reaching out together, branches budding off as the line passes, chevrons and dots at the tips, every flake a different design and every arm a little off because a hand drew it. The quiet draws one big flake slowly; as the song grows the flakes get smaller, faster and more of them at once. The drawing quickens just after each beat, kicks tap snow dots on, warm passages reach for coloured chalk, a new section sends the eraser across part of the board and the drop wipes it clean before a flurry of new flakes.',
  category: 'field',
  style: 'print',
  tags: ['playful', 'tender', 'nostalgic', 'calm', 'whimsical', 'winter', 'snow', 'hand-drawn', 'chalk', 'school', 'acoustic', 'indie', 'folk', 'piano', 'lofi', 'christmas', 'cosy'],
  params,
  handInks: 2,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;
    const coarse = isCoarse();
    let cw = 0;
    let chh = 0;
    /** the canvas's short side: flakes, lines and the eraser are sized by it */
    let sh = 1;
    let canvas = document.createElement('canvas');
    let g = canvas.getContext('2d')!;
    let tex = new THREE.CanvasTexture(canvas);
    let pats: CanvasPattern[] = [];
    let flakes: Flake[] = [];
    let wipes: Wipe[] = [];
    /** where flakes have been drawn (and not wiped) */
    let placed: { x: number; y: number; R: number; t: number }[] = [];

    const mat = makeMaterial({
      params,
      shared,
      vertex: BOARD_VERT,
      fragment: BOARD_FRAG,
      extra: { tChalk: { value: tex }, uDust: { value: 1 }, uFlashK: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = createFullscreenQuad(mat);

    const setup = (w: number, h: number) => {
      tex.dispose();
      canvas = document.createElement('canvas');
      canvas.width = cw = w;
      canvas.height = chh = h;
      sh = Math.min(w, h);
      g = canvas.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      pats = [chalkPattern(g, 0), chalkPattern(g, 1), chalkPattern(g, 2)];
      tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      mat.uniforms.tChalk.value = tex;
      flakes = [];
      wipes = [];
      placed = [];
    };

    let sd = 1 + Math.floor(Math.random() * 1e6);
    const rnd = () => {
      sd = (sd * 16807) % 2147483647;
      return sd / 2147483647;
    };

    const drop = new DropTimer();
    let lastSection = -2;
    let sinceSpawn = 9;
    let sinceWipe = 0;
    let burst = 0;
    let burstAt = 0;
    let flash = 0;
    let dirty = true;
    let sinceUpload = 0;
    let quietIdle = 0;

    /** find a place for a flake of radius R (px), away from the others and, if big, from the lyric band */
    const place = (R: number): Pt => {
      let best: Pt = [cw / 2, chh / 2];
      let bestS = -1e9;
      for (let i = 0; i < 28; i++) {
        const x = R * 0.6 + rnd() * (cw - R * 1.2);
        const y = R * 0.6 + rnd() * (chh - R * 1.2);
        let s = 0;
        for (const p of placed) {
          const d = Math.hypot(p.x - x, p.y - y) - (p.R + R) * 0.9;
          s += Math.min(0, d) * 2.5;
        }
        for (const f of flakes) {
          const d = Math.hypot(f.x - x, f.y - y) - (f.R + R) * 1.05;
          s += Math.min(0, d) * 6;
        }
        // big flakes stay off the middle-to-lower band where the words sit
        const ny = y / chh;
        const nx = x / cw;
        if (R > sh * 0.1) s -= R * 1.5 * Math.max(0, 1 - Math.abs(ny - 0.62) / 0.2) * Math.max(0, 1 - Math.abs(nx - 0.5) / 0.38);
        s += rnd() * R * 0.2;
        if (s > bestS) {
          bestS = s;
          best = [x, y];
        }
      }
      return best;
    };

    const spawn = (R: number, ch: number) => {
      const [x, y] = place(R);
      const wPx = sh * 0.0042 * Math.min(1, 0.6 + R / (sh * 0.25));
      const f = buildFlake(x, y, R, wPx, ch, rnd);
      flakes.push(f);
      placed.push({ x, y, R, t: 0 });
    };

    /** the eraser: back-and-forth swipes over a box (px) */
    const wipe = (x0: number, y0: number, x1: number, y1: number, seconds: number) => {
      const w = sh * (0.1 + rnd() * 0.03);
      const path: Pt[] = [];
      const horizontal = x1 - x0 > (y1 - y0) * 1.2;
      const n = Math.max(2, Math.ceil((horizontal ? y1 - y0 : x1 - x0) / (w * 0.7)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const j = (rnd() - 0.5) * w * 0.3;
        if (horizontal) {
          const yy = y0 + (y1 - y0) * t;
          path.push(i % 2 ? [x1 + j, yy + j] : [x0 + j, yy - j]);
        } else {
          const xx = x0 + (x1 - x0) * t;
          path.push(i % 2 ? [xx + j, y1 + j] : [xx - j, y0 + j]);
        }
      }
      const cum = [0];
      for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
      wipes.push({ path, cum, len: cum[cum.length - 1], done: 0, speed: cum[cum.length - 1] / seconds, w });
      // what sits under the eraser is gone (flakes in progress stop being drawn)
      const inside = (x: number, y: number) => x > x0 - w * 0.3 && x < x1 + w * 0.3 && y > y0 - w * 0.3 && y < y1 + w * 0.3;
      placed = placed.filter((p) => !inside(p.x, p.y));
      for (const f of flakes) if (inside(f.x, f.y)) f.alive = false;
      sinceWipe = 0;
    };

    /** the board as it was when the current wipe began: each frame restores it and draws the wipe so far as one stroke */
    let snap: HTMLCanvasElement | null = null;
    const stepWipes = (dt: number) => {
      const wp = wipes[0];
      if (!wp) return;
      if (!snap || snap.width !== cw || snap.height !== chh) {
        snap = document.createElement('canvas');
        snap.width = cw;
        snap.height = chh;
      }
      const sg = snap.getContext('2d')!;
      if (wp.done === 0) {
        sg.globalCompositeOperation = 'copy';
        sg.drawImage(canvas, 0, 0);
      }
      wp.done = Math.min(wp.len, wp.done + wp.speed * dt);
      g.globalCompositeOperation = 'copy';
      g.globalAlpha = 1;
      g.drawImage(snap, 0, 0);
      // the felt takes most of the chalk off, not all of it
      g.globalCompositeOperation = 'source-over';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(wp.path[0][0], wp.path[0][1]);
      let i = 1;
      for (; i < wp.path.length && wp.cum[i] <= wp.done; i++) g.lineTo(wp.path[i][0], wp.path[i][1]);
      if (i < wp.path.length) {
        const t = (wp.done - wp.cum[i - 1]) / Math.max(1e-6, wp.cum[i] - wp.cum[i - 1]);
        g.lineTo(wp.path[i - 1][0] + (wp.path[i][0] - wp.path[i - 1][0]) * t, wp.path[i - 1][1] + (wp.path[i][1] - wp.path[i - 1][1]) * t);
      }
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = wp.w;
      g.stroke();
      if (wp.done >= wp.len) {
        // and leaves a faint smear of dust along its path
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = 'rgba(8,0,0,1)';
        g.stroke();
        wipes.shift();
        if (wipes[0]) wipes[0].done = 0;
      }
      dirty = true;
    };

    const drawFlake = (f: Flake) => {
      g.globalCompositeOperation = 'lighten';
      g.strokeStyle = pats[f.ch];
      g.fillStyle = pats[f.ch];
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const s of f.strokes) {
        const want = Math.min(s.len, Math.max(0, f.g - s.r0));
        if (want <= s.drawn) continue;
        const from = s.drawn;
        s.drawn = want;
        g.globalAlpha = s.alpha;
        g.lineWidth = s.w * (0.9 + 0.2 * Math.random());
        g.beginPath();
        const p0 = at(s, from);
        g.moveTo(p0[0], p0[1]);
        for (let i = 0; i < s.cum.length; i++) if (s.cum[i] > from && s.cum[i] < want) g.lineTo(s.pts[i][0], s.pts[i][1]);
        const p1 = at(s, want);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
        dirty = true;
      }
      for (const d of f.dots) {
        if (d.done || f.g < d.r0) continue;
        d.done = true;
        g.globalAlpha = 0.9;
        g.beginPath();
        g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.fill();
        dirty = true;
      }
      g.globalAlpha = 1;
    };

    /** a kick taps a few snow dots onto the board */
    const tapDots = (n: number, ch: number) => {
      g.globalCompositeOperation = 'lighten';
      g.fillStyle = pats[ch];
      g.globalAlpha = 0.9;
      for (let i = 0; i < n; i++) {
        let x = rnd() * cw;
        let y = rnd() * chh;
        const f = flakes[Math.floor(rnd() * flakes.length)];
        if (f && rnd() < 0.7) {
          const a = rnd() * Math.PI * 2;
          const r = f.R * (1.15 + rnd() * 0.5);
          x = f.x + Math.cos(a) * r;
          y = f.y + Math.sin(a) * r;
        }
        g.beginPath();
        g.arc(x, y, sh * (0.0025 + rnd() * 0.003), 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      dirty = true;
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const p = frame.params;
        const f = frame.feel;
        const a = frame.audio;
        drop.step(frame);
        const I = f.intensity;
        const T = f.tension;
        const rung = quality.current();
        // the canvas: the frame with its short side capped (smaller on phones and low quality rungs)
        const k = Math.min(1, (coarse ? 640 : 900) / Math.max(1, Math.min(frame.width, frame.height))) * Math.max(0.6, rung.sceneScale);
        const hTarget = Math.max(1, Math.round(frame.height * k));
        const wTarget = Math.max(1, Math.round(frame.width * k));
        if (Math.abs(hTarget - chh) > chh * 0.15 || Math.abs(wTarget / Math.max(1, hTarget) - cw / Math.max(1, chh)) > 0.02) setup(wTarget, hTarget);

        sinceSpawn += dt;
        sinceWipe += dt;
        for (const pl of placed) pl.t += dt;
        flash = Math.max(0, flash - dt * 2.5);

        // the eraser: the drop wipes the board, a new section wipes part of it, a full board wipes its oldest corner
        const eraseK = num(p, 'erase', 1);
        const secChanged = f.sectionIndex !== lastSection && lastSection !== -2;
        lastSection = f.sectionIndex;
        if (eraseK > 0.01) {
          if (drop.since < 0.05 && sinceWipe > 2 && placed.length > 0) {
            wipe(-chh * 0.05, -chh * 0.05, cw + chh * 0.05, chh * 1.05, 0.5);
            burst = 5 + Math.round(3 * num(p, 'amount', 1));
            burstAt = 0.55;
            flash = 1;
          } else if (secChanged && sinceWipe > 6 && placed.length > 1) {
            const side = rnd();
            if (side < 0.33) wipe(-chh * 0.05, -chh * 0.05, cw * 0.55, chh * 1.05, 1.1);
            else if (side < 0.66) wipe(cw * 0.45, -chh * 0.05, cw + chh * 0.05, chh * 1.05, 1.1);
            else wipe(-chh * 0.05, -chh * 0.05, cw + chh * 0.05, chh * 0.5, 1.1);
          } else if (placed.length > 4 && sinceWipe > 10) {
            const area = placed.reduce((s, q) => s + Math.PI * q.R * q.R, 0);
            if (area > cw * chh * 0.75 * eraseK + cw * chh * 0.25) {
              const old = placed.reduce((o, q) => (q.t > o.t ? q : o), placed[0]);
              wipe(old.x - old.R * 1.2, old.y - old.R * 1.2, old.x + old.R * 1.2, old.y + old.R * 1.2, 0.7);
            }
          }
        }
        stepWipes(dt);

        // what to draw: the quiet is one big flake; a full song is many small ones at once
        const amount = num(p, 'amount', 1);
        const sizeK = num(p, 'size', 1);
        const want = Math.max(1, Math.round(1 + (I * 3.2 + T * 0.8) * amount));
        const live = flakes.filter((x) => x.alive && x.g < x.gEnd).length;
        const colourK = num(p, 'colour', 0.5);
        const pickCh = () => (rnd() < colourK * (0.12 + 0.45 * Math.max(f.warmth - 0.4, 0) + 0.35 * T) ? (rnd() < 0.65 ? 1 : 2) : 0);
        const sizeFor = () => sh * sizeK * (0.27 - 0.19 * Math.min(1, I * 1.1 + T * 0.2)) * (0.7 + 0.6 * rnd());
        const playing = a.playing || a.level > 0.02;
        if (burst > 0) {
          burstAt -= dt;
          if (burstAt <= 0 && wipes.length === 0) {
            spawn(burst === 1 ? sh * 0.22 * sizeK : sh * (0.05 + rnd() * 0.07) * sizeK, pickCh());
            burst--;
            burstAt = 0.08;
          }
        } else if (live < want && wipes.length === 0) {
          const onBeat = a.beat || (!playing && sinceSpawn > 2.5) || sinceSpawn > 3.5;
          if (onBeat && sinceSpawn > (live === 0 ? 0.2 : 0.45)) {
            spawn(sizeFor(), pickCh());
            sinceSpawn = 0;
          }
        }
        quietIdle = playing ? 0 : quietIdle + dt;

        // drawing: quicker just after each beat, so the lines arrive in phrases
        const speedK = num(p, 'speed', 1);
        const phrase = 0.45 + 1.3 * Math.exp(-a.beatPhase * 4);
        const base = (0.09 + 0.42 * I + 0.25 * T + 0.6 * drop.env) * speedK * (playing ? phrase : 0.8);
        for (const fl of flakes) {
          if (!fl.alive || fl.g >= fl.gEnd || wipes.length > 0) continue;
          const small = Math.sqrt((sh * 0.15) / Math.max(fl.R, 1));
          fl.g = Math.min(fl.gEnd, fl.g + dt * base * small);
          drawFlake(fl);
        }
        flakes = flakes.filter((x) => x.alive && x.g < x.gEnd);

        if (a.kickHit && wipes.length === 0 && flakes.length + placed.length > 0) tapDots(1 + Math.floor(rnd() * 2 + I * 3), colourK > 0.15 && rnd() < 0.5 ? 2 : 0);

        // upload the canvas at most ~30 times a second (chalk doesn't need more, and phones thank us)
        sinceUpload += dt;
        if (dirty && (sinceUpload > 0.03 || wipes.length > 0)) {
          tex.needsUpdate = true;
          dirty = false;
          sinceUpload = 0;
        }
        syncMaterial(mat, frame, params);
        mat.uniforms.uDust.value = num(p, 'dust', 1);
        mat.uniforms.uFlashK.value = flash;
        quad.render(renderer, target);
      },
      dispose() {
        tex.dispose();
        mat.dispose();
        quad.dispose();
      },
    };
  },
};
