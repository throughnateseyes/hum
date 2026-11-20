/**
 * Massing: a brutalist building as a sculpture of heavy concrete blocks, photographed from low down in
 * hard light, and played like an instrument.
 *
 * The building is a set of modules (boxes, and rows of thin fins) that each know where they sit when the
 * building is at rest and where they go when it is "open": slid out into cantilevers, floors pulled
 * apart so the core shows through deep dark gaps, terraces pushed forward like drawers. One number, the
 * expansion, says how open the building is; it follows the song (closed and still in the quiet, opening
 * through the verse, straining through the build, fully open from the drop through the chorus, settling
 * back in the break). Every module follows it a little later than the row below, so any change runs up
 * the building row by row, and big changes travel like falling weight: slow to start, then a slam.
 * Each drop also switches to the other open configuration, so a second drop reshapes the building.
 *
 * On top of that: kicks push rows out a little in sequence (a cascade up the facade in the verse, a wave
 * through the whole building in the chorus), snares turn the fins like louvres one after another, the
 * windows light row by row on kicks where the take has lit windows, and the voids glow on the drop in the
 * night take. The camera holds still and straight in the quiet (lens shift, parallel verticals), tilts up
 * through the build (verticals converge) and rushes low and close on the drop, then eases back.
 *
 * Rendering: instanced boxes with one concrete shader (board-formed planks, tie holes, panel joints, rain
 * streaks), window and void openings drawn as real recesses by interior mapping (with the sun traced
 * through each opening, so reveals throw crisp shadows), a sun shadow map, a top-down height map for the
 * dark under overhangs, a sky dome with clouds, a still reflecting pool (the building drawn again,
 * mirrored, at half size) and instanced shrubs. Light comes from Feel's sun (feel.light, feel.day).
 *
 * Palette roles: bg = sky, fg = voids and the deepest shadow, accent = concrete in sunlight, accent2 =
 * concrete in shade, muted = life in the building (lit windows, plants, the glow in the voids).
 */
import * as THREE from 'three';
import { num, str } from '../../core/uniforms';
import type { FrameContext, ParamDef, SceneDef, SceneInstance } from '../../core/types';
import { quality } from '../../render/quality';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';

/* ───────────────────────── params ───────────────────────── */

const FORMS = ['tower', 'slab', 'terraces'] as const;

const params: ParamDef[] = [
  {
    id: 'form',
    label: 'Building',
    group: 'Shape',
    type: 'select',
    default: 'tower',
    options: [
      { value: 'tower', label: 'Stacked tower' },
      { value: 'slab', label: 'Inverted pyramid' },
      { value: 'terraces', label: 'Hillside terraces' },
    ],
  },
  { id: 'seed', label: 'Composition', group: 'Shape', type: 'number', min: 0, max: 20, step: 1, default: 3, hint: 'Another arrangement of the same blocks' },
  { id: 'fins', label: 'Fins', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Rows of concrete fins (brise-soleil) on the blocks' },
  { id: 'move', label: 'Movement', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far the blocks slide, stack and cantilever with the song' },
  { id: 'weight', label: 'Weight', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How hard blocks slam into place (camera jolt)' },
  { id: 'camera', label: 'Camera drama', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far the camera tilts and rushes in on the build and the drop' },
  { id: 'sun', label: 'Sun', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: '1 hard sunlight and crisp shadows, 0 overcast' },
  { id: 'night', label: 'Night', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'Night: dark sky, one harsh floodlight from below' },
  { id: 'glow', label: 'Lit windows', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.05 },
  { id: 'ember', label: 'Void glow', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'The voids glow from inside on the drop' },
  { id: 'clouds', label: 'Clouds', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'plants', label: 'Overgrowth', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.1, hint: 'Plants on terraces and roofs, vines down the walls' },
  { id: 'stain', label: 'Weathering', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Rain streaks and staining on the concrete' },
  { id: 'pool', label: 'Reflecting pool', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
];

/* ───────────────────────── building model ───────────────────────── */

/** facade styles (aFace.x) */
const BLANK = 0;
const GRID = 1;
const VOID = 2;
const SLOT = 3;
const SAW = 4;

/** a box: centre and size */
type Box = [number, number, number, number, number, number];

interface Unit {
  /** 0 concrete block, 1 fin, 2 distant block */
  kind: number;
  /** cascade order: rows respond one after another, bottom first */
  row: number;
  base: Box;
  /** change at full expansion, one per open configuration */
  open: [Box, Box];
  /** kicks push the block this way (x, z) and grow it (sx, sz), in units at full push */
  push: [number, number, number, number];
  face: [number, number, number, number];
  /** opening width / height share of a cell, lit-window share, plants */
  look: [number, number, number, number];
  seed: number;
  /** fins: parent block, which face (0 +x, 1 +z, 2 −x, 3 −z), place along it (0..1), depth out */
  parent?: number;
  side?: number;
  along?: number;
  depth?: number;
  /** dynamic */
  e: number;
  v: number;
  m: number;
  mv: number;
  rot: number;
  cur: Box;
  /** the drop: hoisted height above its place, vertical speed, and when it lets go */
  fy: number;
  fv: number;
  fAt: number;
}

interface Bush {
  parent: number;
  /** place on the parent's top: x, z as a share of its size (−0.5..0.5); hang = sits on the edge */
  fx: number;
  fz: number;
  r: number;
  seed: number;
  /** shape: height stretch (0.5 a low mat .. 2 a tall shrub), and whether it spills down over the edge */
  tall?: number;
  hang?: boolean;
}

/** a mixed clump of growth on a terrace: mostly small, now and then a big shrub or a small tree, some trailing over the edge */
function plantClump(bushes: Bush[], parent: number, rand: () => number, n: number) {
  for (let b = 0; b < n; b++) {
    const k = rand();
    const big = k > 0.86;
    const mat = k < 0.35;
    bushes.push({
      parent,
      fx: (rand() - 0.5) * 0.95,
      fz: mat ? 0.47 : 0.15 + rand() * 0.3,
      r: big ? 0.6 + rand() * 0.35 : mat ? 0.22 + rand() * 0.18 : 0.18 + rand() * 0.22,
      seed: rand(),
      tall: big ? 1.3 + rand() * 0.8 : mat ? 0.45 + rand() * 0.25 : 0.8 + rand() * 0.6,
      hang: mat,
    });
  }
}

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const Z6 = (): Box => [0, 0, 0, 0, 0, 0];

function unit(o: Partial<Unit> & { base: Box }): Unit {
  return {
    kind: 0,
    row: 0,
    open: [Z6(), Z6()],
    push: [0, 0, 0, 0],
    face: [BLANK, 1, 1, 0.3],
    look: [0.6, 0.55, 1, 0],
    seed: Math.random(),
    e: 0,
    v: 0,
    m: 0,
    mv: 0,
    rot: 0,
    cur: [...o.base] as Box,
    fy: 0,
    fv: 0,
    fAt: -1,
    ...o,
  };
}

interface Model {
  units: Unit[];
  bushes: Bush[];
  rows: number;
  /** the reflecting pool: centre x, z, half width, half length */
  pool: [number, number, number, number];
  /** where the camera looks from (radians round the building; 0 = from +z) */
  az: number;
  /** extra distance for overhangs that reach toward the camera (share of the half depth) */
  depthK: number;
  /** share of the frame height the building fills when calm (wide, looming forms want less) */
  fill: number;
}

/** fins along one face of a block */
function addFins(units: Unit[], parentIdx: number, side: number, count: number, depth: number, rand: () => number) {
  const p = units[parentIdx];
  for (let i = 0; i < count; i++) {
    units.push(
      unit({
        kind: 1,
        row: p.row,
        base: [0, 0, 0, 0.09, p.base[4] * 0.96, depth],
        parent: parentIdx,
        side,
        along: (i + 0.5) / count,
        depth,
        face: [BLANK, 1, 1, 0],
        seed: rand(),
      }),
    );
  }
}

/** the distant city: low hazy slabs round the horizon */
function addCity(units: Unit[], rand: () => number, az: number) {
  for (let i = 0; i < 34; i++) {
    const a = az + Math.PI + (rand() - 0.5) * 3.6;
    const r = 70 + rand() * 70;
    const w = 4 + rand() * 12;
    const h = 2 + rand() * rand() * 14;
    units.push(unit({ kind: 2, row: 0, base: [Math.sin(a) * r, h / 2, Math.cos(a) * r, w, h, 3 + rand() * 8], face: [rand() < 0.5 ? GRID : SLOT, 1.1, 1, 0.2], seed: rand() }));
  }
}

/**
 * Stacked tower: a concrete core with blocks two or three floors tall stacked up it, each offset to a
 * side and cantilevered; open, the blocks slide further out and the floors pull apart.
 */
function buildTower(seed: number, fins: number, rand: () => number): Model {
  const units: Unit[] = [];
  const bushes: Bush[] = [];
  const podH = 1.5;
  // podium: a long low block with a deep ribbon window
  units.push(unit({ row: 0, base: [0.4, podH / 2, 0.8, 14, podH, 8.5], face: [SLOT, 3.4, 1.5, 0.9], look: [0.92, 0.4, 0.6, 1], seed: rand() }));
  const pods: { h: number; dir: number }[] = [];
  const n = 5;
  const dirs = [0, 1, 2, 1, 0, 2, 1, 3];
  const rot = Math.floor(seed) % 4;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const h = i === n - 1 ? 4 : i === 1 ? 2 : 3;
    pods.push({ h, dir: (dirs[(i + rot) % dirs.length] + (seed % 2 ? 2 : 0)) % 4 });
    total += h;
  }
  const gap = 0.75;
  const coreH = podH + total + 0.8;
  // the core runs the full height and grows as the floors pull apart
  units.push(
    unit({
      row: 0,
      base: [0, coreH / 2, -0.2, 3.2, coreH, 3.2],
      open: [
        [0, (gap * n) / 2, 0, 0, gap * n, 0],
        [0, (1.8 * n) / 2, 0, 0.6, 1.8 * n, 0.6],
      ],
      face: [SLOT, 3.2, 1, 0.7],
      look: [0.12, 0.88, 0.5, 0],
      seed: rand(),
    }),
  );
  // a second slim shaft beside it
  units.push(
    unit({
      row: 0,
      base: [3.0, (coreH - 2) / 2, -1.9, 1.7, coreH - 2, 1.7],
      open: [
        [0, (gap * (n - 1)) / 2, 0, 0, gap * (n - 1), 0],
        [-0.4, (1.75 * (n - 1)) / 2, 0.6, 0, 1.75 * (n - 1), 0],
      ],
      face: [BLANK, 1, 1, 0],
      seed: rand(),
    }),
  );
  const DX = [1, 0, -1, 0];
  const DZ = [0, 1, 0, -1];
  let y = podH;
  for (let i = 0; i < n; i++) {
    const { h, dir } = pods[i];
    const top = i === n - 1;
    const w = top ? 8.6 : 5.4 + rand() * 2.2;
    const d = top ? 6.4 : 4.2 + rand() * 1.4;
    const along = dir % 2 === 0;
    const sx = along ? w : d;
    const sz = along ? d : w;
    const off0 = 1.3 + rand() * 0.6;
    const off1 = 2.2 + rand() * 1.8;
    const dir2 = (dir + 1 + (i % 2) * 2) % 4;
    const off2 = 1.6 + rand() * 1.6;
    const cx = DX[dir] * off0;
    const cz = DZ[dir] * off0 + (top ? 0.4 : 0);
    const r = rand();
    const style = top ? (seed % 2 ? SAW : VOID) : r < 0.3 ? BLANK : r < 0.55 ? VOID : r < 0.75 ? GRID : r < 0.88 ? SAW : SLOT;
    const cell: [number, number, number, number] =
      style === GRID ? [GRID, 1.3, 1, 0.7] : style === VOID ? [VOID, 99, 99, 2.6] : style === SLOT ? [SLOT, 99, 1, 0.8] : style === SAW ? [SAW, 0.7, 1, 0] : [BLANK, 1, 1, 0];
    const lookO: [number, number, number, number] = style === GRID ? [0.5, 0.56, 1, 0.4] : style === VOID ? [0.46, 0.52, 0, 0.3] : style === SLOT ? [0.9, 0.36, 1, 0.5] : [0, 0, 0, 0.3];
    const yc = y + h / 2;
    // the two open configurations travel far, and stay hung on the core: a block that slides a long way
    // out also extrudes, so its inner end stays in the core and the rest is a long cantilever
    const reach = (d: number, o: number, len: number) => Math.max(0, 2 * (o + 1.0) - len) * (d % 2 === 0 ? 1 : 0);
    const reachZ = (d: number, o: number, len: number) => Math.max(0, 2 * (o + 1.0) - len) * (d % 2 === 1 ? 1 : 0);
    const o0 = top ? 1.4 : off1 * 1.25;
    const o1 = top ? 2.2 : off2 + 2.6 + rand() * 1.6;
    const len0 = dir % 2 === 0 ? sx : sz;
    const len1 = dir2 % 2 === 0 ? sx : sz;
    const tele = top ? 1.9 : 1.75;
    const u = unit({
      row: i + 1,
      base: [cx, yc, cz, sx, h, sz],
      open: [
        [DX[dir] * o0 - cx * 0.3, gap * (i + 1), DZ[dir] * o0 - cz * 0.3, (top ? 1.6 : 0) + reach(dir, o0, len0) * 0.7, top ? 0.5 : 0, (top ? 1.0 : 0) + reachZ(dir, o0, len0) * 0.7],
        [DX[dir2] * o1 - cx, tele * (i + 1), DZ[dir2] * o1 - cz, (top ? 3.4 : 0.3) + reach(dir2, o1, len1), top ? 1.4 : 0.2, (top ? 2.2 : 0.3) + reachZ(dir2, o1, len1)],
      ],
      push: [DX[dir] * 0.45, DZ[dir] * 0.45, 0, 0],
      face: cell,
      look: lookO,
      seed: rand(),
    });
    units.push(u);
    const idx = units.length - 1;
    if (!top && rand() < 0.55) {
      // a smaller block hung off the other side
      const odir = (dir + 2) % 4;
      const ow = 2.2 + rand() * 1.2;
      const oh = Math.min(h, 2);
      units.push(
        unit({
          row: i + 1,
          base: [DX[odir] * 1.6, y + oh / 2 + (h - oh), DZ[odir] * 1.6 - 0.2, odir % 2 === 0 ? ow : 2.4, oh, odir % 2 === 0 ? 2.4 : ow],
          open: [
            [DX[odir] * 1.6, gap * (i + 1), DZ[odir] * 1.6, 0, 0, 0],
            [DX[odir] * 2.2, 1.75 * (i + 1) + 0.6, DZ[odir] * 2.2 + 0.6, odir % 2 === 0 ? 2.2 : 0, 0.4, odir % 2 === 0 ? 0 : 2.2],
          ],
          push: [DX[odir] * 0.35, DZ[odir] * 0.35, 0, 0],
          face: rand() < 0.5 ? [GRID, 0.7, 1, 0.38] : [BLANK, 1, 1, 0],
          look: [0.5, 0.5, 1, 0.4],
          seed: rand(),
        }),
      );
    }
    // fins on blocks facing the camera side
    if (fins > 0.05 && (style === GRID || style === SLOT) && rand() < 0.35 + 0.6 * fins) {
      const side = DZ[dir] >= 0 ? 1 : DX[dir] > 0 ? 0 : 1;
      const width = side % 2 === 0 ? sz : sx;
      addFins(units, idx, side, Math.max(4, Math.round((width / 0.55) * Math.min(1, 0.4 + fins))), 0.42 + 0.3 * fins, rand);
    }
    // planters on the roof edges
    for (let k = 0; k < 3; k++) bushes.push({ parent: idx, fx: (rand() - 0.5) * 0.9, fz: 0.42 * (rand() < 0.5 ? 1 : -1), r: 0.35 + rand() * 0.35, seed: rand() });
    y += h;
  }
  for (let k = 0; k < 7; k++) bushes.push({ parent: 0, fx: (rand() - 0.5) * 0.95, fz: 0.44, r: 0.4 + rand() * 0.4, seed: rand() });
  const az = -0.78;
  addCity(units, rand, az);
  return { units, bushes, rows: n + 2, pool: [0.4, 32, 8, 25], az, depthK: 0.45, fill: 0.79 };
}

/**
 * Inverted pyramid: a narrow base and floors that step out as they rise, a grid of deep windows on
 * every floor and a heavy sculpted top floor hovering over it all; open, the floors flare further and
 * the top lifts.
 */
function buildSlab(seed: number, fins: number, rand: () => number): Model {
  const units: Unit[] = [];
  const bushes: Bush[] = [];
  const lean = seed % 2 ? 1 : -1;
  // the base: a narrow core on a plinth
  units.push(unit({ row: 0, base: [0, 0.25, 0, 13, 0.5, 10], face: [BLANK, 1, 1, 0], seed: rand() }));
  // the core and pilotis stretch as the first floor lifts, so it never floats
  units.push(unit({ row: 0, base: [0, 0.5 + 1.1, 0, 4.2, 2.2, 3.4], open: [[0, 0.05, 0, 0, 0.1, 0], [0, 0.2, 0, 0, 0.4, 0]], face: [SLOT, 99, 1.1, 0.7], look: [0.8, 0.5, 1, 0], seed: rand() }));
  // pilotis
  for (let k = 0; k < 4; k++) {
    const x = k % 2 ? 2.9 : -2.9;
    const z = k < 2 ? 2.3 : -2.3;
    units.push(unit({ row: 0, base: [x, 0.5 + 1.1, z, 0.55, 2.2, 0.55], open: [[x * 0.3, 0.05, z * 0.3, 0, 0.1, 0], [x * 0.5, 0.2, z * 0.5, 0, 0.4, 0]], face: [BLANK, 1, 1, 0], seed: rand() }));
  }
  const L = 7;
  let y = 2.7;
  const step = 0.62;
  for (let i = 0; i < L; i++) {
    const w = 6.2 + i * step;
    const d = 5.0 + i * step * 0.8;
    const top = i === L - 1;
    const h = top ? 1.7 : 1;
    const dy = 0.1 * (i + 1);
    units.push(
      unit({
        row: i + 1,
        base: [0, y + h / 2, 0, top ? w + 1.4 : w, h, top ? d + 1.2 : d],
        open: [
          [0, dy + (top ? 0.45 : 0), 0, i * step * 1.05 + (top ? 0.8 : 0), top ? 0.3 : 0, i * step * 0.85 + (top ? 0.6 : 0)],
          // the drop: the floors shear apart left and right, the stack telescopes up and the cap swells
          [top ? lean * 0.8 : (i % 2 ? 1 : -1) * lean * (0.7 + 0.42 * i), 0.4 * (i + 1) + (top ? 1.3 : 0), top ? 0.6 : 0.22 * i, i * step * 1.5 + (top ? 4.2 : 0), top ? 0.9 : 0, i * step * 1.1 + (top ? 3.2 : 0)],
        ],
        push: [0, 0, 0.5, 0.4],
        face: top ? [SAW, 0.5, 1.7, 0] : [GRID, 0.62, 1, 0.36],
        look: [0.6, 0.56, 1, 0.25],
        seed: rand(),
      }),
    );
    if (top && fins > 0.05) {
      // a row of deep fins on the hovering top floor's front
      addFins(units, units.length - 1, 1, Math.round(10 + 10 * fins), 0.5 + 0.3 * fins, rand);
    }
    if (i % 2 === 1) for (let k = 0; k < 4; k++) bushes.push({ parent: units.length - 1, fx: (rand() - 0.5) * 0.9, fz: 0.46, r: 0.3 + rand() * 0.3, seed: rand() });
    y += h;
  }
  for (let k = 0; k < 8; k++) bushes.push({ parent: 0, fx: (rand() - 0.5) * 0.95, fz: (rand() < 0.5 ? 1 : -1) * 0.45, r: 0.45 + rand() * 0.4, seed: rand() });
  const az = -0.55;
  addCity(units, rand, az);
  return { units, bushes, rows: L + 1, pool: [0, 32, 9, 25], az, depthK: 1.0, fill: 0.66 };
}

/**
 * Hillside terraces: rows of long blocks stepping up and back, deep loggias in every front, planters
 * along every terrace; open, the rows push forward like drawers, alternating, and the stack climbs.
 */
function buildTerraces(seed: number, fins: number, rand: () => number): Model {
  const units: Unit[] = [];
  const bushes: Bush[] = [];
  const R = 7;
  const W = 4;
  for (let r = 0; r < R; r++) {
    const segs = W - (r > 4 ? 1 : 0);
    for (let k = 0; k < segs; k++) {
      const sw = 3.3 + rand() * 0.5;
      const x = (k - (segs - 1) / 2) * 3.75 + (r % 2 ? 0.6 : -0.3);
      const dpt = 2.4 + 1.6;
      const z = 3.5 - r * 1.55 - 0.8;
      const alt = (k + r) % 2;
      units.push(
        unit({
          row: r,
          base: [x, r * 1.0 + 0.5, z, sw, 1, dpt],
          open: [
            [0, r * 0.2, 0.5 + alt * 1.3, 0, 0.0, 0.4],
            // the drop: the drawers fly out the other way, far, and the hillside heaves up
            [alt ? -1.3 : 1.3, r * 0.55, 2.6 - alt * 1.8, 0.4, 0.15, 1.2],
          ],
          push: [0, 0.6, 0, 0],
          face: [GRID, 1.15, 1, 0.62],
          look: [0.78, 0.66, 1, 1],
          seed: rand(),
        }),
      );
      const idx = units.length - 1;
      if (fins > 0.3 && rand() < fins * 0.35) addFins(units, idx, 1, 6, 0.35, rand);
      // sparse and uneven: some terraces bare, some thick
      const nClump = rand() < 0.3 ? 0 : 1 + Math.floor(rand() * 3.2);
      plantClump(bushes, idx, rand, nClump);
    }
  }
  // a stair tower at one end
  units.push(unit({ row: 0, base: [8.4, 4.2, -1.5, 2.2, 8.4, 2.2], open: [[0.6, 0.8, 0, 0, 1.6, 0], [-0.4, 1.2, 0.8, 0, 2.4, 0]], face: [SLOT, 99, 1, 0.5], look: [0.16, 0.86, 0.4, 0.6], seed: rand() }));
  const az = -0.42 + (seed % 2 ? 0.2 : 0);
  addCity(units, rand, az);
  return { units, bushes, rows: R, pool: [0, 30, 11, 23], az, depthK: 0.6, fill: 0.74 };
}

function buildModel(form: number, seed: number, fins: number): Model {
  const rand = rng(1000 + seed * 97 + form * 13);
  return form === 1 ? buildSlab(seed, fins, rand) : form === 2 ? buildTerraces(seed, fins, rand) : buildTower(seed, fins, rand);
}

/* ───────────────────────── shaders ───────────────────────── */

const BOX_VERT_COMMON = /* glsl */ `
attribute vec4 aPos;   // centre xyz, yaw
attribute vec4 aSize;  // size xyz, kind
attribute vec4 aFace;  // style, cell width, cell height, recess depth
attribute vec4 aLook;  // opening share x / y, lit-window share, plants
attribute vec4 aDyn;   // seed, row glow, void glow, -
vec3 boxWorld(out vec3 nW, out vec3 lp) {
  lp = position * aSize.xyz;
  float c = cos(aPos.w), s = sin(aPos.w);
  vec3 rp = vec3(c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z);
  nW = vec3(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z);
  return aPos.xyz + rp;
}
`;

const BOX_VERT = /* glsl */ `
${BOX_VERT_COMMON}
varying vec3 vW, vN, vLN, vLP;
varying vec4 vSize, vFace, vLook, vDyn;
void main() {
  vec3 nW, lp;
  vec3 w = boxWorld(nW, lp);
  vW = w; vN = nW; vLN = normal; vLP = lp;
  vSize = aSize; vFace = aFace; vLook = aLook; vDyn = aDyn;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const DEPTH_VERT = /* glsl */ `
${BOX_VERT_COMMON}
void main() {
  vec3 nW, lp;
  vec3 w = boxWorld(nW, lp);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const BUSH_VERT_COMMON = /* glsl */ `
attribute vec4 aBush; // centre xyz, radius
attribute vec4 aBush2; // seed, hang, height stretch, -
vec3 bushWorld(out vec3 nW) {
  float s = aBush2.x * 17.0;
  vec3 p = position;
  float n = snoise(p * 1.6 + s) * 0.3 + snoise(p * 3.7 + s * 2.0) * 0.14;
  p *= 1.0 + n;
  float tall = aBush2.z > 0.01 ? aBush2.z : 0.72;
  p.y *= tall;
  // taller growth narrows toward the top, low mats spread
  p.xz *= mix(1.0, 1.0 - 0.35 * max(position.y, 0.0), step(1.1, tall)) * (tall < 0.7 ? 1.3 : 1.0);
  vec3 w = aBush.xyz + p * aBush.w;
  w.y += (tall - 0.72) * aBush.w * 0.5;
  // hanging growth spills down over the edge
  if (aBush2.y > 0.5 && position.y < 0.0) w.y += position.y * aBush.w * 2.6 * (0.6 + 0.8 * fract(s * 3.1 + position.x * 2.0));
  // sway with the wind, more at the top
  float sway = (position.y * 0.5 + 0.5) * aBush.w;
  w.xz += uFeelWind * sway * (0.04 + 0.12 * uFeelGust) * sin(uFeelWindPhase * 2.2 + s);
  nW = normalize(position + n * position);
  return w;
}
`;

const BUSH_VERT = /* glsl */ `
${BUSH_VERT_COMMON}
varying vec3 vW, vN;
varying float vSeed;
void main() {
  vec3 nW;
  vec3 w = bushWorld(nW);
  vW = w; vN = nW; vSeed = aBush2.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const BUSH_DEPTH_VERT = /* glsl */ `
${BUSH_VERT_COMMON}
void main() {
  vec3 nW;
  vec3 w = bushWorld(nW);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`;

/** lighting shared by every lit surface */
const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uSunAmt, uAmb, uNight, uFloodFall, uFlash;
uniform sampler2D uShadow;
uniform mat4 uShadowMat;
uniform vec2 uShadowTexel;
uniform sampler2D uTop;
uniform mat4 uTopMat;
uniform vec2 uTopRange;
uniform vec3 uHorizon;
uniform float uFogK, uStainAmt, uPlantAmt, uCheap;
uniform vec3 uRimDir;

float shadowAt(vec3 w, vec3 n) {
  vec4 p = uShadowMat * vec4(w + n * 0.05, 1.0);
  vec3 s = p.xyz * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float z = s.z - 0.0006;
  vec2 t = uShadowTexel;
  float sum = step(z, texture2D(uShadow, s.xy).r) * 2.0;
  if (uCheap > 0.5) return sum * 0.5;
  sum += step(z, texture2D(uShadow, s.xy + vec2(t.x, t.y) * 0.75).r);
  sum += step(z, texture2D(uShadow, s.xy + vec2(-t.x, t.y) * 0.75).r);
  sum += step(z, texture2D(uShadow, s.xy + vec2(t.x, -t.y) * 0.75).r);
  sum += step(z, texture2D(uShadow, s.xy + vec2(-t.x, -t.y) * 0.75).r);
  return sum / 6.0;
}

/* height of whatever is highest above (x, z), from the top-down map */
float topH(vec2 xz) {
  vec4 p = uTopMat * vec4(xz.x, 0.0, xz.y, 1.0);
  vec2 uv = p.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -99.0;
  return uTopRange.x - texture2D(uTop, uv).r * uTopRange.y;
}

/* how much of the sky a point sees: dark under overhangs, in gaps between floors and at the foot of walls */
float skyOcc(vec3 w, vec3 n) {
  float o = 0.0;
  if (abs(n.y) < 0.5) {
    // a wall: look out from it, near and further, and to either side
    vec2 t = vec2(-n.z, n.x);
    vec2 c = w.xz + n.xz * 0.3;
    o += smoothstep(w.y + 0.04, w.y + 0.8, topH(c)) * 1.5;
    o += smoothstep(w.y + 0.04, w.y + 1.8, topH(c + n.xz * 0.9));
    o += smoothstep(w.y + 0.04, w.y + 1.8, topH(c + t * 0.8)) * 0.75;
    o += smoothstep(w.y + 0.04, w.y + 1.8, topH(c - t * 0.8)) * 0.75;
    return o / 4.0;
  }
  vec2 c = w.xz;
  o += smoothstep(w.y + 0.04, w.y + 0.9, topH(c)) * 2.0;
  o += smoothstep(w.y + 0.04, w.y + 1.6, topH(c + vec2(0.8, 0.0)));
  o += smoothstep(w.y + 0.04, w.y + 1.6, topH(c + vec2(-0.8, 0.0)));
  o += smoothstep(w.y + 0.04, w.y + 1.6, topH(c + vec2(0.0, 0.8)));
  o += smoothstep(w.y + 0.04, w.y + 1.6, topH(c + vec2(0.0, -0.8)));
  return o / 6.0;
}

/* concrete value → palette: void black, concrete in shade, concrete in sun */
/* (a soft plateau on each ink, so a printed finish reads shade as shade and sun as sun) */
vec3 concrete(float v) {
  vec3 c = mix(uFg, uAccent2, smoothstep(0.06, 0.33, v));
  c = mix(c, uAccent2 * 1.06, smoothstep(0.33, 0.5, v) * 0.5);
  return mix(c, uAccent, smoothstep(0.52, 0.82, v));
}

float lightAt(vec3 w, vec3 n, out float sun) {
  float ndl = max(dot(n, uSunDir), 0.0);
  float sh = ndl > 0.0 ? shadowAt(w, n) : 0.0;
  float occ = uCheap > 0.5 ? 0.2 : skyOcc(w, n);
  // sky from above, bounce from the sunlit plaza from below (soffits and the feet of walls)
  float sky = 0.62 + 0.38 * n.y;
  float bounce = uSunAmt * (1.0 - uNight) * (0.5 - 0.5 * n.y) * 0.24 * exp(-max(w.y, 0.0) * 0.05);
  float amb = (uAmb * sky + bounce) * (1.0 - 0.55 * occ);
  float fall = mix(1.0, exp(-max(w.y, 0.0) * uFloodFall), uNight);
  sun = ndl * sh * fall;
  // night: a weaker cool light from behind and above picks out the edges the flood can't reach
  float rim = uNight * 0.3 * pow(max(dot(n, uRimDir), 0.0), 1.5) * (1.0 - 0.5 * occ);
  return amb + uSunAmt * sun + rim + uFlash * (0.4 + 0.3 * n.y);
}

vec3 fogged(vec3 col, vec3 w) {
  float d = length(w - cameraPosition);
  return mix(col, uHorizon, 1.0 - exp(-d * uFogK));
}
`;

const BOX_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec3 vW, vN, vLN, vLP;
varying vec4 vSize, vFace, vLook, vDyn;

/* board-formed concrete: horizontal planks, panel joints, tie holes, mottling; returns a value offset */
float boardTex(vec2 p, float seed, float dist) {
  float ph = 0.105;
  float rowf = p.y / ph;
  float row = floor(rowf);
  float fy = fract(rowf);
  float lw = fwidth(rowf);
  float fine = 1.0 - smoothstep(0.18, 0.5, lw);
  float tone = (hash11(row * 7.13 + seed * 31.0) - 0.5) * 0.09 * (0.4 + 0.6 * fine);
  float seam = (1.0 - smoothstep(0.0, max(lw * 1.2, 0.07), min(fy, 1.0 - fy))) * fine;
  float grain = (tnoise(vec2(p.x * 1.4 + seed * 9.0, row * 3.7)) - 0.5) * 0.06 * fine;
  // formwork panels: a joint every 1.2 units across, every 6 planks up
  vec2 pg = vec2(p.x / 1.2, rowf / 6.0);
  vec2 pf = abs(fract(pg) - 0.5) * vec2(1.2, ph * 6.0);
  vec2 pw = fwidth(pg) * vec2(1.2, ph * 6.0);
  float joint = (1.0 - smoothstep(0.0, max(pw.x * 1.2, 0.012), 0.6 - pf.x)) + (1.0 - smoothstep(0.0, max(pw.y * 1.2, 0.012), ph * 3.0 - pf.y));
  joint *= 1.0 - smoothstep(0.25, 0.8, max(fwidth(pg.x), fwidth(pg.y)) * 6.0);
  // tie holes: four per panel, in two rows
  vec2 tg = vec2(p.x / 0.6, rowf / 3.0);
  vec2 tf = (fract(tg) - 0.5) * vec2(0.6, ph * 3.0);
  float hole = 1.0 - smoothstep(0.016, 0.03, length(tf));
  hole *= 1.0 - smoothstep(0.08, 0.3, fwidth(tg.x));
  float mottle = (tnoise(p * 0.35 + seed * 5.0) - 0.5) * 0.12 + (tnoise(p * 1.7 + seed) - 0.5) * 0.05;
  return tone + grain + mottle - seam * 0.045 - joint * 0.07 - hole * 0.22;
}

/* rain streaks running down from an edge (top of the face, or under a window sill) */
float streaks(vec2 p, float fromTop, float seed) {
  float s = tnoise(vec2(p.x * 5.5 + seed * 13.0, p.y * 0.18)) * 0.7 + tnoise(vec2(p.x * 17.0 + seed, p.y * 0.4)) * 0.3;
  s = smoothstep(0.42, 0.85, s);
  return s * exp(-fromTop * 0.9);
}

void main() {
  vec3 n = normalize(vN);
  vec3 ln = vLN;
  float kind = vSize.w;
  float style = vFace.x;
  float seed = vDyn.x;
  vec3 V = normalize(vW - cameraPosition);

  // face frame: T across the face, up, N out
  bool side = abs(ln.y) < 0.5;
  vec3 tl = side ? normalize(cross(vec3(0.0, 1.0, 0.0), ln)) : vec3(1.0, 0.0, 0.0);
  float fw = side ? abs(dot(tl, vSize.xyz)) : vSize.x;
  float fh = side ? vSize.y : vSize.z;
  float u = side ? dot(vLP, tl) : vLP.x;
  float v = side ? vLP.y : vLP.z;
  float faceId = side ? (ln.x > 0.5 ? 0.0 : ln.z > 0.5 ? 1.0 : ln.x < -0.5 ? 2.0 : 3.0) : (ln.y > 0.0 ? 4.0 : 5.0);
  float fseed = hash11(seed * 91.0 + faceId * 7.0);
  vec3 tW = side ? normalize(cross(vec3(0.0, 1.0, 0.0), n)) : vec3(1.0, 0.0, 0.0);
  float dist = length(vW - cameraPosition);

  // saw-tooth panels: each column a slanted facet with a narrow dark return
  vec3 nS = n;
  float crease = 0.0;
  if (side && style > 3.5 && kind < 0.5) {
    float cw = fw / max(1.0, floor(fw / vFace.y + 0.3));
    float x = fract((u + fw * 0.5) / cw);
    float band = abs(fract((v + fh * 0.5) / max(vFace.z, 0.5) + 0.5) - 0.5) * max(vFace.z, 0.5);
    if (band > 0.09) {
      float a = x < 0.78 ? 0.5 : -1.05;
      nS = normalize(n * cos(a) + tW * sin(a));
      crease = 1.0 - smoothstep(0.0, fwidth(x) * 1.5 + 0.01, abs(x - 0.78));
    }
  }

  // openings: windows and voids as real recesses
  bool inOpen = false;
  vec3 col;
  float sunLit;
  if (side && (style > 0.5 && style < 3.5) && kind < 0.5 && fseed < (style > 1.5 && style < 2.5 ? 0.62 : 0.92)) {
    float cwn = max(1.0, floor(fw / vFace.y + 0.3));
    float chn = max(1.0, floor(fh / vFace.z + 0.3));
    float cw = fw / cwn;
    float ch = fh / chn;
    float cu = (u + fw * 0.5) / cw;
    float cv = (v + fh * 0.5) / ch;
    vec2 cell = floor(vec2(cu, cv));
    vec2 q = (fract(vec2(cu, cv)) - 0.5) * vec2(cw, ch);
    q.y -= 0.05 * ch;
    vec2 ho = 0.5 * vec2(vLook.x * cw, vLook.y * ch);
    if (abs(q.x) < ho.x && abs(q.y) < ho.y && min(cw, ch) > 0.2) {
      inOpen = true;
      float D = vFace.w;
      // view ray and sun in face coordinates (x across, y up, z out)
      vec3 rd = vec3(dot(V, tW), V.y, dot(V, n));
      vec3 ls = vec3(dot(uSunDir, tW), uSunDir.y, dot(uSunDir, n));
      rd.z = min(rd.z, -1e-3);
      float tx = (sign(rd.x) * ho.x - q.x) / (abs(rd.x) < 1e-4 ? 1e-4 : rd.x);
      float ty = (sign(rd.y) * ho.y - q.y) / (abs(rd.y) < 1e-4 ? 1e-4 : rd.y);
      float tz = -D / rd.z;
      float t = min(tz, min(tx, ty));
      vec3 h = vec3(q, 0.0) + rd * t;
      vec3 nw = t == tz ? vec3(0.0, 0.0, 1.0) : t == tx ? vec3(-sign(rd.x), 0.0, 0.0) : vec3(0.0, -sign(rd.y), 0.0);
      float lit = 0.0;
      if (ls.z > 0.01) {
        float s = -h.z / ls.z;
        vec2 e = h.xy + ls.xy * s;
        lit = step(abs(e.x), ho.x) * step(abs(e.y), ho.y);
      }
      float frameSh = shadowAt(vW, n);
      float fall = mix(1.0, exp(-max(vW.y, 0.0) * uFloodFall), uNight);
      float ndl = max(dot(nw, ls), 0.0);
      float depthIn = -h.z;
      float occ = exp(-depthIn * (style > 1.5 && style < 2.5 ? 1.3 : 2.2));
      float val = uAmb * 0.75 * occ + uSunAmt * ndl * lit * frameSh * fall * (0.55 + 0.45 * occ) + uFlash * 0.3 * occ;
      sunLit = ndl * lit * frameSh;
      vec3 wallC = concrete(val);
      // lit windows: per cell, more in rows the kick has just lit
      // at night whole floors are lit or dark, with a few odd rooms
      float cellH = mix(hash21(cell + vec2(seed * 37.0, faceId * 11.0)), hash21(vec2(cell.y, seed * 37.0)), uNight * 0.8);
      float glowOn = step(cellH, vLook.z * (0.08 + 0.92 * clamp(uSunAmt < 0.5 ? 1.0 : 0.6, 0.0, 1.0)) + vDyn.y);
      float glowAmt = glowOn * (0.85 + 0.15 * sin(uTime * 1.3 + cellH * 40.0));
      if (t == tz) {
        if (style > 1.5 && style < 2.5) {
          // a void: black, or glowing from deep inside
          col = mix(uFg, uMuted, vDyn.z * (0.55 + 0.45 * occ));
          col = mix(col, wallC, 0.25 * occ * (1.0 - vDyn.z));
        } else {
          // glass: dark, a little of the sky in it, or a warm lit room
          float fres = pow(1.0 - abs(rd.z), 3.0);
          vec3 glass = mix(uFg, mix(uAccent2, uBg, 0.6), 0.12 + 0.35 * fres);
          glass = mix(glass, uAccent, 0.5 * sunLit);
          // lit rooms: the extra ink by day (amber), the floodlit cream at night (the extra ink is the ember then)
          vec3 glowC = mix(uMuted, mix(uAccent, vec3(1.0), 0.1), uNight);
          col = mix(glass, glowC * (1.0 + 0.15 * glowAmt), glowAmt);
        }
      } else {
        col = wallC;
        // warm spill from a lit room onto the reveal
        col = mix(col, mix(uMuted, uAccent, uNight), glowAmt * 0.45 * smoothstep(0.0, D, depthIn));
        if (style > 1.5 && style < 2.5) col = mix(col, uMuted, vDyn.z * smoothstep(0.2, D, depthIn) * 0.7);
      }
    }
  }

  if (!inOpen) {
    float sun;
    float val = lightAt(vW, nS, sun);
    sunLit = sun;
    // the surface: planks on walls, a finer cast on roofs and soffits
    vec2 tp = side ? vec2(u + seed * 13.0, vW.y) : vW.xz + seed * 7.0;
    float tex = boardTex(tp, seed, dist);
    float fromTop = side ? (fh * 0.5 - v) : 9.0;
    float st = side ? streaks(vec2(u + seed * 5.0, v), fromTop, seed) : 0.0;
    // streaks under each window row too
    if (side && style > 0.5 && style < 3.5) {
      float chn = max(1.0, floor(fh / vFace.z + 0.3));
      float ch = fh / chn;
      float under = fract((v + fh * 0.5) / ch);
      st = max(st, streaks(vec2(u * 1.3 + seed, v), (1.0 - under) * ch * 2.4, seed + 3.0) * 0.8);
    }
    float base = side ? exp(-max(vW.y, 0.0) * 1.4) * 0.5 : 0.0;
    // water staining: big soft blotches, heavier toward the bottom of each block
    float blot = smoothstep(0.05, 0.55, tfbm(tp * vec2(0.22, 0.32) + seed * 3.0, 3) + 0.25 * (1.0 - clamp(fromTop / max(fh, 0.1), 0.0, 1.0)));
    float wear = clamp(st * 1.1 + base * 0.5 + blot * 0.55, 0.0, 1.0) * uStainAmt;
    // pour lifts: each floor's pour sits a shade apart, with a cold joint between
    float liftF = vW.y / 1.0;
    float lift = (hash11(floor(liftF) * 3.7 + seed * 17.0) - 0.5) * 0.07;
    float lw2 = fwidth(liftF);
    float cold = side ? (1.0 - smoothstep(0.0, max(lw2 * 1.3, 0.012), abs(fract(liftF + 0.5) - 0.5))) * (1.0 - smoothstep(0.05, 0.3, lw2)) : 0.0;
    tex += (side ? lift : 0.0) - cold * 0.08;
    val = val * (1.0 + tex * (0.6 + 0.2 * sun)) + tex * 0.12;
    val = val * (1.0 - (0.42 - 0.28 * sun) * wear) - crease * 0.25;
    col = concrete(val);
    // the distant city: flat hazy silhouettes, lit side a touch lighter
    if (kind > 1.5) col = mix(uBg, uAccent2, 0.3 - 0.12 * sun);
    // shade takes a breath of the sky
    col = mix(col, uBg, 0.08 * (1.0 - sun) * (0.5 + 0.5 * n.y) * (1.0 - uNight));
    // a hairline catches the light on the arrises
    vec2 e2 = vec2(fw * 0.5 - abs(u), fh * 0.5 - abs(v));
    float arris = 1.0 - smoothstep(0.0, 0.02 + fwidth(u) * 1.2, min(e2.x, e2.y));
    col = mix(col, side ? concrete(val + 0.18) : col, arris * 0.5 * sun);

    // overgrowth: moss on the roofs, vines hanging down the walls
    float plants = vLook.w * uPlantAmt;
    if (plants > 0.01 && kind < 0.5) {
      float leafN = tnoise(vW.xz * 2.3 + vW.y * 1.7) * 0.6 + tnoise(vec2(u, vW.y) * 6.0 + seed) * 0.4;
      float cover = 0.0;
      if (!side && ln.y > 0.0) cover = smoothstep(0.62 - 0.55 * plants, 0.7 - 0.5 * plants, tnoise(vW.xz * 0.6 + seed * 3.0) * 0.6 + leafN * 0.4);
      if (side) {
        float hang = plants * fh * (0.15 + 1.1 * tnoise(vec2(u * 1.7 + seed * 11.0, 0.5)) * tnoise(vec2(u * 0.45 + seed, 2.5)));
        cover = (1.0 - smoothstep(hang - 0.25, hang, fromTop)) * smoothstep(0.25, 0.55, leafN + 0.25 * plants);
        cover = max(cover, smoothstep(0.88 - 0.25 * plants, 0.95, tnoise(vec2(u, vW.y) * 1.3 + seed) ) * step(0.5, plants));
      }
      float lv = 0.32 + 0.68 * clamp(sun, 0.0, 1.0) + (leafN - 0.5) * 0.4;
      vec3 leaf = mix(mix(uFg, uMuted, 0.42), uMuted, smoothstep(0.25, 0.7, lv));
      col = mix(col, leaf, cover);
    }
  }
  if (kind < 1.5) col = fogged(col, vW);
  gl_FragColor = vec4(col, 1.0);
}
`;

const BUSH_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec3 vW, vN;
varying float vSeed;
void main() {
  vec3 n = normalize(vN);
  float sun;
  float val = lightAt(vW, n, sun);
  float leaf = tnoise(vW.xz * 7.0 + vW.y * 5.0 + vSeed * 9.0);
  float lv = 0.25 + 0.75 * sun + (leaf - 0.5) * 0.5 + 0.15 * n.y;
  vec3 c = mix(mix(uFg, uMuted, 0.4), uMuted, smoothstep(0.3, 0.75, lv));
  c = mix(c, mix(uMuted, uAccent, 0.35), smoothstep(0.85, 1.1, lv) * 0.5);
  gl_FragColor = vec4(fogged(c, vW), 1.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vW;
uniform vec3 uHorizon, uSunDir;
uniform float uClouds, uNight, uCloudT, uFlash;
void main() {
  vec3 d = normalize(vW - cameraPosition);
  float h = d.y;
  vec3 zenith = mix(uBg, uFg, 0.1 + 0.25 * uNight);
  vec3 col = mix(uHorizon, uBg, smoothstep(-0.02, 0.32, h));
  col = mix(col, zenith, smoothstep(0.35, 0.95, h));
  if (h > 0.0 && uClouds > 0.01) {
    vec2 p = d.xz / (h + 0.12) * 0.55 + vec2(uCloudT, uCloudT * 0.3);
    float c = tfbm(p * 0.9, 5);
    float shape = c * 0.5 + 0.5 + 0.3 * (tnoise(p * 0.3) - 0.5);
    float cov = smoothstep(0.64 - 0.3 * uClouds, 0.675 - 0.3 * uClouds, shape) * smoothstep(0.0, 0.14, h);
    // lit tops, shaded bellies: brighter where the cloud thins toward the sun
    float c2 = tfbm(p * 0.9 + uSunDir.xz * 0.12, 5);
    float lit = smoothstep(0.3, 0.6, 0.75 + (c - c2) * 5.0 + (shape - 0.6) * 1.5);
    // bellies stay close to the sky (no grey rim when printed in a few inks); the lit cores are the cloud
    // (a crisp step from sky to cloud: a soft one passes through every mid ink and prints as a rim)
    float core = smoothstep(0.0, 0.015, shape - (0.68 - 0.3 * uClouds)) * step(0.5, lit);
    vec3 cl = mix(uBg, mix(uAccent, vec3(1.0), 0.15), core);
    cl = mix(cl, mix(uBg, uAccent2, 0.3), uNight * 0.85);
    col = mix(col, cl, cov * (1.0 - 0.6 * uNight));
  }
  col += uFlash * 0.35 * (1.0 - 0.75 * uNight);
  gl_FragColor = vec4(col, 1.0);
}
`;

const DUST_VERT = /* glsl */ `
attribute vec2 aInfo; // age share 0..1, size in metres
uniform float uPx;
varying float vAge;
varying float vSeed;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vAge = aInfo.x;
  vSeed = fract(position.x * 1.37 + position.z * 0.71);
  // puffs swell as they drift
  float s = aInfo.y * (0.6 + 1.6 * sqrt(aInfo.x));
  gl_PointSize = aInfo.x >= 1.0 ? 0.0 : s * uPx / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAG = /* glsl */ `
uniform float uSunAmt, uNight;
varying float vAge;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float lumpy = tnoise(gl_PointCoord * 2.2 + vSeed * 17.0) * 0.6 + tnoise(gl_PointCoord * 5.0 + vSeed * 5.0) * 0.25;
  // a soft billow, not a bead: wide falloff broken up by noise
  float a = (1.0 - smoothstep(0.0, 1.0, r * (0.85 + 0.5 * lumpy))) * smoothstep(0.2, 0.6, lumpy + 0.25) * pow(1.0 - vAge, 1.4);
  a *= 0.7;
  if (a < 0.02) discard;
  // pale concrete dust, lit from the top, a little darker underneath
  float lit = 0.5 + 0.5 * clamp(-c.y * 2.0 + 0.2, 0.0, 1.0);
  vec3 col = mix(uAccent2, uAccent, (0.45 + 0.4 * lit) * min(1.0, 0.4 + uSunAmt));
  col = mix(col, uBg, 0.3 * (1.0 - uNight));
  gl_FragColor = vec4(col, a * (0.85 - 0.35 * uNight));
}
`;

const GROUND_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GROUND_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec3 vW;
uniform vec4 uPoolRect;
uniform vec2 uPoolDir;
uniform float uPoolOn;
uniform sampler2D uRefl;
uniform vec2 uReflSize;
uniform vec4 uRipple0, uRipple1, uRipple2;
float ring(vec2 p, vec4 r) {
  float d = length(p - r.xy);
  float age = r.z;
  float rad = age * 3.2;
  float x = d - rad;
  return sin(x * 9.0) * exp(-x * x * 1.4) * exp(-age * 0.9) * r.w;
}
void main() {
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec2 pd = vW.xz - uPoolRect.xy;
  vec2 pr = vec2(dot(pd, vec2(uPoolDir.y, -uPoolDir.x)), dot(pd, uPoolDir));
  vec2 inside = uPoolRect.zw - abs(pr);
  float pool = uPoolOn * step(0.0, min(inside.x, inside.y));
  float coping = uPoolOn * step(-0.35, min(inside.x, inside.y)) * (1.0 - pool);
  float sun;
  float val = lightAt(vW, n, sun);
  // paving: big slabs with dark joints
  vec2 g = vW.xz / 1.6;
  vec2 gf = abs(fract(g) - 0.5);
  vec2 gw = fwidth(g);
  float joint = (1.0 - smoothstep(0.5 - gw.x * 1.5, 0.5, gf.x + 0.0)) ;
  joint = max(1.0 - smoothstep(0.0, gw.x * 1.4, 0.5 - gf.x), 1.0 - smoothstep(0.0, gw.y * 1.4, 0.5 - gf.y));
  joint *= 1.0 - smoothstep(0.1, 0.4, max(gw.x, gw.y));
  float tone = (hash21(floor(g)) - 0.5) * 0.08 + (tnoise(vW.xz * 0.4) - 0.5) * 0.1;
  float v = val * (0.9 + tone) - joint * 0.12 + coping * 0.08;
  vec3 col = concrete(v * 0.86);
  if (pool > 0.5) {
    // still water: the building mirrored, a little darker, ripples on the hits
    vec2 suv = gl_FragCoord.xy / uReflSize;
    float rp = ring(vW.xz, uRipple0) + ring(vW.xz, uRipple1) + ring(vW.xz, uRipple2);
    float wind = (tnoise(vW.xz * vec2(0.8, 2.6) + uFeelWindPhase * vec2(0.3, 0.1)) - 0.5) * (0.004 + 0.012 * uFeelGust);
    vec2 off = vec2(rp * 0.012 + wind, rp * 0.02 + wind * 2.0);
    vec3 refl = texture2D(uRefl, suv + off).rgb;
    float fres = 0.62 + 0.3 * pow(1.0 - abs(normalize(cameraPosition - vW).y), 2.0);
    vec3 deep = mix(uFg, uAccent2, 0.25);
    col = mix(deep, refl, fres);
    col = mix(col, uAccent, clamp(rp, 0.0, 1.0) * 0.12);
  }
  col = fogged(col, vW);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ───────────────────────── the scene ───────────────────────── */

const MAXU = 420;
const MAXD = 700;
const MAXB = 320;
const HIST = 360; // 6 s at 60 Hz

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const massing: SceneDef = {
  id: 'massing',
  name: 'Massing',
  description:
    'A brutalist building as a sculpture of heavy board-formed concrete blocks, shot from low down in hard light beside a reflecting pool. The blocks are the instrument: still in the quiet, breathing row by row on the kick, sliding out into cantilevers through the build, slamming into a new configuration on the drop.',
  category: 'form',
  style: 'world',
  tags: ['architectural', 'heavy', 'monumental', 'cinematic', 'dramatic', 'minimal', 'industrial', 'dark', 'intense', 'rhythmic'],
  handInks: 4,
  params,
  create(init): SceneInstance {
    const shared = init.shared;
    const scene = new THREE.Scene();
    const refScene = new THREE.Scene();
    const casterScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, init.width / Math.max(1, init.height), 0.3, 900);
    const mirrorCam = new THREE.PerspectiveCamera();
    mirrorCam.matrixWorldAutoUpdate = false;
    const sunCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 1, 300);
    const topCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 1, 120);

    /* shared uniforms (one object each, used by every material) */
    const U = {
      uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
      uSunAmt: { value: 0.8 },
      uAmb: { value: 0.42 },
      uNight: { value: 0 },
      uFloodFall: { value: 0 },
      uFlash: { value: 0 },
      uShadow: { value: null as THREE.Texture | null },
      uShadowMat: { value: new THREE.Matrix4() },
      uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      uTop: { value: null as THREE.Texture | null },
      uTopMat: { value: new THREE.Matrix4() },
      uTopRange: { value: new THREE.Vector2(0, 1) },
      uHorizon: { value: new THREE.Color() },
      uFogK: { value: 0.004 },
      uStainAmt: { value: 0.5 },
      // 1 while drawing the reflection: one shadow tap and no sky-occlusion taps (the water blurs it anyway)
      uCheap: { value: 0 },
      uRimDir: { value: new THREE.Vector3(0, 1, 0) },
      uPlantAmt: { value: 0 },
    };

    /* instanced blocks */
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(box.getIndex());
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    const attr = (k: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAXU * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(k, a);
      return a;
    };
    const aPos = attr('aPos');
    const aSize = attr('aSize');
    const aFace = attr('aFace');
    const aLook = attr('aLook');
    const aDyn = attr('aDyn');
    geo.instanceCount = 0;

    const boxMat = makeMaterial({ params, shared, vertex: BOX_VERT, fragment: BOX_FRAG, extra: { ...U } });
    const boxDepth = makeMaterial({ params, shared, vertex: DEPTH_VERT, fragment: DEPTH_FRAG });
    const boxes = new THREE.Mesh(geo, boxMat);
    boxes.frustumCulled = false;
    const boxesRef = new THREE.Mesh(geo, boxMat);
    boxesRef.frustumCulled = false;
    const boxesCast = new THREE.Mesh(geo, boxDepth);
    boxesCast.frustumCulled = false;
    scene.add(boxes);
    refScene.add(boxesRef);
    casterScene.add(boxesCast);

    /* shrubs */
    const ico = new THREE.IcosahedronGeometry(1, 2);
    const bgeo = new THREE.InstancedBufferGeometry();
    bgeo.setIndex(ico.getIndex());
    bgeo.setAttribute('position', ico.getAttribute('position'));
    bgeo.setAttribute('normal', ico.getAttribute('normal'));
    const aBush = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 4), 4);
    const aBush2 = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 4), 4);
    aBush.setUsage(THREE.DynamicDrawUsage);
    bgeo.setAttribute('aBush', aBush);
    bgeo.setAttribute('aBush2', aBush2);
    bgeo.instanceCount = 0;
    const bushMat = makeMaterial({ params, shared, vertex: BUSH_VERT, fragment: BUSH_FRAG, extra: { ...U } });
    const bushDepth = makeMaterial({ params, shared, vertex: BUSH_DEPTH_VERT, fragment: DEPTH_FRAG });
    const bushes = new THREE.Mesh(bgeo, bushMat);
    bushes.frustumCulled = false;
    const bushesRef = new THREE.Mesh(bgeo, bushMat);
    bushesRef.frustumCulled = false;
    const bushesCast = new THREE.Mesh(bgeo, bushDepth);
    bushesCast.frustumCulled = false;
    scene.add(bushes);
    refScene.add(bushesRef);
    casterScene.add(bushesCast);

    /* dust: concrete puffs where blocks slam down */
    const dPos = new Float32Array(MAXD * 3);
    const dVel = new Float32Array(MAXD * 3);
    const dAge = new Float32Array(MAXD).fill(99);
    const dLife = new Float32Array(MAXD).fill(1);
    const dSize = new Float32Array(MAXD);
    let dHead = 0;
    const dgeo = new THREE.BufferGeometry();
    const dPosAttr = new THREE.BufferAttribute(dPos, 3);
    const dInfo = new Float32Array(MAXD * 2); // age share, size
    const dInfoAttr = new THREE.BufferAttribute(dInfo, 2);
    dPosAttr.setUsage(THREE.DynamicDrawUsage);
    dInfoAttr.setUsage(THREE.DynamicDrawUsage);
    dgeo.setAttribute('position', dPosAttr);
    dgeo.setAttribute('aInfo', dInfoAttr);
    const dustMat = makeMaterial({
      params,
      shared,
      vertex: DUST_VERT,
      fragment: DUST_FRAG,
      extra: { uPx: { value: 720 }, uSunAmt: U.uSunAmt, uNight: U.uNight },
      transparent: true,
      depthWrite: false,
    });
    const dust = new THREE.Points(dgeo, dustMat);
    dust.frustumCulled = false;
    scene.add(dust);
    const spawnDust = (x: number, y: number, z: number, sx: number, sz: number, amt: number) => {
      const count = Math.min(26, Math.round(7 + amt * 12));
      for (let k = 0; k < count; k++) {
        const i = dHead;
        dHead = (dHead + 1) % MAXD;
        // round the block's foot: along its edges, blowing outward
        const t = Math.random();
        const edge = Math.floor(Math.random() * 4);
        const ex = edge < 2 ? (t - 0.5) * sx : (edge === 2 ? 0.5 : -0.5) * sx;
        const ez = edge < 2 ? (edge === 0 ? 0.5 : -0.5) * sz : (t - 0.5) * sz;
        const len = Math.hypot(ex, ez) || 1;
        dPos[i * 3] = x + ex;
        dPos[i * 3 + 1] = y + (Math.random() - 0.3) * 0.3;
        dPos[i * 3 + 2] = z + ez;
        const sp = (1.5 + Math.random() * 3.5) * (0.6 + 0.6 * amt);
        dVel[i * 3] = (ex / len) * sp + (Math.random() - 0.5);
        dVel[i * 3 + 1] = (Math.random() - 0.25) * 1.6;
        dVel[i * 3 + 2] = (ez / len) * sp + (Math.random() - 0.5);
        dAge[i] = 0;
        dLife[i] = 1.4 + Math.random() * 1.6;
        dSize[i] = 1.1 + Math.random() * 1.8 * (0.7 + 0.5 * amt);
      }
    };

    /* sky dome */
    const skyMat = makeMaterial({
      params,
      shared,
      vertex: SKY_VERT,
      fragment: SKY_FRAG,
      extra: { uHorizon: U.uHorizon, uSunDir: U.uSunDir, uNight: U.uNight, uFlash: U.uFlash, uClouds: { value: 0.4 }, uCloudT: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    const skyRef = new THREE.Mesh(skyGeo, skyMat);
    skyRef.renderOrder = -10;
    skyRef.frustumCulled = false;
    scene.add(sky);
    refScene.add(skyRef);

    /* ground and pool */
    const reflRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    const groundMat = makeMaterial({
      params,
      shared,
      vertex: GROUND_VERT,
      fragment: GROUND_FRAG,
      extra: {
        ...U,
        uPoolRect: { value: new THREE.Vector4(0, 14, 6, 8) },
        uPoolDir: { value: new THREE.Vector2(0, 1) },
        uPoolOn: { value: 1 },
        uRefl: { value: reflRT.texture },
        uReflSize: { value: new THREE.Vector2(1, 1) },
        uRipple0: { value: new THREE.Vector4(0, 0, 99, 0) },
        uRipple1: { value: new THREE.Vector4(0, 0, 99, 0) },
        uRipple2: { value: new THREE.Vector4(0, 0, 99, 0) },
      },
    });
    const groundGeo = new THREE.PlaneGeometry(600, 600);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.frustumCulled = false;
    scene.add(ground);

    /* shadow and height maps */
    const mkDepthRT = (s: number) => {
      const rt = new THREE.WebGLRenderTarget(s, s, { depthBuffer: true });
      rt.depthTexture = new THREE.DepthTexture(s, s);
      rt.depthTexture.type = THREE.UnsignedIntType;
      return rt;
    };
    let shadowSize = 2048;
    let shadowRT = mkDepthRT(shadowSize);
    const topRT = mkDepthRT(512);
    U.uTop.value = topRT.depthTexture;
    U.uShadow.value = shadowRT.depthTexture;

    const materials = [boxMat, boxDepth, bushMat, bushDepth, skyMat, groundMat, dustMat];

    /* model state */
    let model: Model | null = null;
    let modelKey = '';
    const poolC = [0, 14];
    const hist = new Float32Array(HIST * 2);
    let histHead = 0;
    let histAcc = 0;
    let histInit = false;
    let peak = false;
    let cfg = 0;
    let drops = 0;
    let lastSince = 99;
    let push: number[] = [];
    let pushV: number[] = [];
    let rowGlow: number[] = [];
    let kickCount = 0;
    const pending: { row: number; at: number; amt: number }[] = [];
    const snareTimes: number[] = [];
    let snareCount = 0;
    let clock = 0;
    const landI = new Int32Array(64);
    const landA = new Float32Array(64);
    let landN = 0;
    // landings over the last moment (decays), to share the dust budget
    let landSum = 0;
    let shake = 0;
    let shakeV = 0;
    let shakeY = 0;
    let ember = 0;
    let flash = 0;
    let cloudT = 0;
    const ripples = [new THREE.Vector4(0, 0, 99, 0), new THREE.Vector4(0, 0, 99, 0), new THREE.Vector4(0, 0, 99, 0)];
    let rippleI = 0;
    /* camera state */
    const bMin = new THREE.Vector3(-6, 0, -4);
    const bMax = new THREE.Vector3(6, 20, 4);
    let bInit = false;
    let drama = 0;
    let camDist = 40;
    let camInit = false;
    let swing = 0;
    let tiltUp = 0;

    const ensureModel = (p: FrameContext['params']) => {
      const form = Math.max(0, FORMS.indexOf(str(p, 'form', 'tower') as (typeof FORMS)[number]));
      const seed = Math.round(num(p, 'seed', 3));
      const fins = Math.round(num(p, 'fins', 0.6) * 10) / 10;
      const key = `${form}:${seed}:${fins}`;
      if (key === modelKey && model) return model;
      modelKey = key;
      model = buildModel(Math.min(FORMS.length - 1, Math.max(0, form)), seed, fins);
      const R = model.rows;
      push = new Array(R).fill(0);
      pushV = new Array(R).fill(0);
      rowGlow = new Array(R).fill(0);
      bInit = false;
      // the pool lies between the building and the camera
      const sa = Math.sin(model.az);
      const ca = Math.cos(model.az);
      poolC[0] = sa * model.pool[1] + ca * model.pool[0];
      poolC[1] = ca * model.pool[1] - sa * model.pool[0];
      // static per-instance data
      const n = Math.min(MAXU, model.units.length);
      for (let i = 0; i < n; i++) {
        const u = model.units[i];
        aFace.setXYZW(i, u.face[0], u.face[1], u.face[2], u.face[3]);
      }
      aFace.needsUpdate = true;
      geo.instanceCount = n;
      const nb = Math.min(MAXB, model.bushes.length);
      for (let i = 0; i < nb; i++) {
        const b = model.bushes[i];
        aBush2.setXYZW(i, b.seed, b.tall === undefined || b.hang ? 1 : 0, b.tall ?? 0, 0);
      }
      aBush2.needsUpdate = true;
      return model;
    };

    const tmpMin = new THREE.Vector3();
    const tmpMax = new THREE.Vector3();
    const reflectY = new THREE.Matrix4().makeScale(1, -1, 1);

    function update(frame: FrameContext) {
      const dt = stepDt(frame);
      const a = frame.audio;
      const f = frame.feel;
      const p = frame.params;
      clock += dt;
      const m = ensureModel(p);
      const move = num(p, 'move', 1);
      const weight = num(p, 'weight', 1);
      const camAmt = num(p, 'camera', 1);
      const night = num(p, 'night', 0);
      const sunP = num(p, 'sun', 1);
      const glowP = num(p, 'glow', 0.05);
      const emberP = num(p, 'ember', 0);
      const plantsP = num(p, 'plants', 0.1);
      const R = m.rows;

      /* the song → how open the building is */
      const since = f.sinceDrop;
      const dropNow = since < lastSince - 0.5 || (since < 0.25 && lastSince > 0.25);
      lastSince = since;
      if (dropNow) {
        drops++;
        // every drop slams the building into the other open configuration
        cfg = drops % 2;
        peak = true;
        flash = 1;
        ember = 1;
        ripples[rippleI].set(poolC[0] - Math.sin(m.az) * m.pool[3] * 0.6, poolC[1] - Math.cos(m.az) * m.pool[3] * 0.6, 0, 1.6);
        rippleI = (rippleI + 1) % 3;
      }
      const sec = f.section;
      const quietPart = sec === 'break' || sec === 'outro' || sec === 'intro';
      if (peak && (quietPart || f.intensity < 0.42)) peak = false;
      if (!peak && (sec === 'chorus' || sec === 'drop') && f.intensity > 0.62) peak = true;
      // the build opens it only part way (the rest is saved for the drop)
      let target = 0.05 + 0.28 * smooth(0.22, 0.8, f.intensity) + 0.4 * f.tension;
      // the building draws in for the last second before a known drop
      if (f.toDrop < 1.2) target -= 0.32 * smooth(0, 1, 1 - f.toDrop / 1.2);
      if (peak) target = 1;
      target = Math.max(0, Math.min(1, target)) * Math.min(1, move);
      // record it (with the configuration) so each row can follow a little later
      if (!histInit) {
        for (let i = 0; i < HIST; i++) {
          hist[i * 2] = target;
          hist[i * 2 + 1] = cfg;
        }
        histInit = true;
      }
      histAcc += dt * 60;
      while (histAcc >= 1) {
        histAcc -= 1;
        histHead = (histHead + 1) % HIST;
        hist[histHead * 2] = target;
        hist[histHead * 2 + 1] = cfg;
      }
      const lagRow = peak || f.tension > 0.3 ? 0.075 : 0.16;

      /* hits */
      for (let r = 0; r < R; r++) {
        const acc = -140 * push[r] - 13 * pushV[r];
        pushV[r] += acc * dt;
        push[r] += pushV[r] * dt;
        rowGlow[r] *= Math.exp(-dt * 1.6);
      }
      if (a.kickHit && a.playing !== false) {
        kickCount++;
        const amt = (0.5 + 0.5 * a.kick) * Math.min(1.2, move);
        if (peak) {
          // a wave up through the whole building
          for (let r = 0; r < R; r++) pending.push({ row: r, at: clock + r * 0.035, amt: amt * 0.9 });
          ripples[rippleI].set(poolC[0] + (Math.random() - 0.5) * m.pool[2], poolC[1] + (Math.random() - 0.5) * m.pool[2], 0, 0.5 * a.kick);
          rippleI = (rippleI + 1) % 3;
        } else if (f.intensity > 0.25) {
          // one row at a time, climbing the facade
          const r = kickCount % R;
          pending.push({ row: r, at: clock, amt });
        }
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const q = pending[i];
        if (clock >= q.at) {
          if (q.row < R) {
            pushV[q.row] += 3.2 * q.amt;
            rowGlow[q.row] = Math.min(1, rowGlow[q.row] + 0.6 * glowP + 0.35 * q.amt * glowP);
          }
          pending.splice(i, 1);
        }
      }
      if (a.snareHit) {
        snareCount++;
        snareTimes.push(clock);
        if (snareTimes.length > 8) snareTimes.shift();
      }
      // the voids burn on the drop and cool over a few seconds
      ember = Math.max(0, ember - dt * 0.3);
      flash = Math.max(0, flash - dt * 3.5);

      /* each block follows the recorded expansion from its own delay; big changes fall and slam */
      const units = m.units;
      const n = Math.min(MAXU, units.length);
      let impact = 0;
      for (let i = 0; i < n; i++) {
        const u = units[i];
        if (u.kind === 2) continue;
        const delay = (u.kind === 1 ? u.row + 0.5 : u.row) * lagRow;
        const back = Math.min(HIST - 1, Math.round(delay * 60));
        const hi = (histHead - back + HIST) % HIST;
        const tE = hist[hi * 2];
        const tM = hist[hi * 2 + 1];
        // expansion
        const diff = tE - u.e;
        if (Math.abs(diff) < 0.05 && Math.abs(u.v) < 0.25) {
          u.e = approach(u.e, tE, 3.2, dt);
          u.v = 0;
        } else {
          const A = diff > 0 ? 9 : 3.2;
          u.v += Math.sign(diff) * A * dt;
          if (Math.sign(u.v) !== Math.sign(diff)) u.v = Math.sign(diff) * Math.min(Math.abs(u.v), 0.4);
          u.v = Math.max(-2.5, Math.min(2.5, u.v));
          u.e += u.v * dt;
          if ((tE - u.e) * diff <= 0) {
            u.e = tE;
            if (u.kind === 0) impact = Math.max(impact, Math.abs(u.v) * (0.5 + 0.1 * u.base[4]));
            u.v = 0;
          }
        }
        // configuration
        const dm = tM - u.m;
        if (Math.abs(dm) > 1e-3) {
          u.mv += Math.sign(dm) * 7 * dt;
          u.m += u.mv * dt;
          if ((tM - u.m) * dm <= 0) {
            u.m = tM;
            if (u.kind === 0) impact = Math.max(impact, Math.abs(u.mv) * 0.4);
            u.mv = 0;
          }
        }
      }
      /* the drop: blocks hang a little higher through the last beat before it, are flung up and swung out on
         it, then fall under gravity and slam into their new places, bottom row first, each with a puff of dust */
      const g = 46;
      const hoistT = f.toDrop < 1.6 && !peak ? smooth(0, 1, 1 - f.toDrop / 1.6) : 0;
      if (dropNow) {
        for (let i = 0; i < n; i++) {
          const u = units[i];
          if (u.kind === 0 && u.row > 0) u.fAt = clock + 0.02 + u.row * 0.055;
        }
      }
      landN = 0;
      for (let i = 0; i < n; i++) {
        const u = units[i];
        if (u.kind !== 0 || u.row === 0) continue;
        const H = (1.7 + 0.6 * u.row) * Math.min(1.2, move);
        if (u.fAt === -1) {
          u.fy = approach(u.fy, hoistT * H * 0.6, 4, dt);
          continue;
        }
        if (u.fAt >= 0) {
          if (clock < u.fAt) continue;
          u.fv = Math.sqrt(2 * g * Math.max(0.3, H - u.fy));
          u.fAt = -2;
        }
        u.fv -= g * dt;
        u.fy += u.fv * dt;
        if (u.fy <= 0 && u.fv < 0) {
          const hit = Math.min(2.2, -u.fv * 0.075 * (0.6 + 0.12 * u.base[4]));
          impact = Math.max(impact, hit);
          if (landN < landI.length) {
            landI[landN] = i;
            landA[landN] = hit;
            landN++;
          }
          u.fy = 0;
          if (u.fv < -5) u.fv = -u.fv * 0.1;
          else {
            u.fv = 0;
            u.fAt = -1;
          }
        }
      }
      if (impact > 0.15) shakeV -= Math.min(2.4, impact) * 0.9 * weight;

      /* geometry */
      const bmin = tmpMin.set(1e9, 1e9, 1e9);
      const bmax = tmpMax.set(-1e9, -1e9, -1e9);
      const DX = [1, 0, -1, 0];
      const DZ = [0, 1, 0, -1];
      for (let i = 0; i < n; i++) {
        const u = units[i];
        const c = u.cur;
        if (u.kind === 1 && u.parent !== undefined) {
          const pu = units[u.parent].cur;
          const s = u.side ?? 1;
          const nx = DX[s];
          const nz = DZ[s];
          const half = s % 2 === 0 ? pu[3] / 2 : pu[5] / 2;
          const width = s % 2 === 0 ? pu[5] : pu[3];
          const tx = -nz;
          const tz = nx;
          const pr = push[u.row] ?? 0;
          const dep = (u.depth ?? 0.4) * (1 + 0.35 * units[u.parent].e) + pr * 0.25;
          const off = ((u.along ?? 0.5) - 0.5) * width * 0.94;
          c[0] = pu[0] + nx * (half + dep / 2) + tx * off;
          c[1] = pu[1];
          c[2] = pu[2] + nz * (half + dep / 2) + tz * off;
          c[3] = 0.085;
          c[4] = pu[4] * 0.97;
          c[5] = dep;
          // louvres: each snare turns the row, one fin after another
          const fd = (u.along ?? 0) * 0.32;
          let flips = snareCount;
          for (const st of snareTimes) if (st + fd > clock) flips--;
          const tgt = (flips % 2 ? 0.55 : 0) * Math.min(1, move);
          u.rot = approach(u.rot, tgt, 10, dt);
          // a plate standing out of the face: deep along the face's normal, thin across it
          aPos.setXYZW(i, c[0], c[1], c[2], u.rot);
          if (s % 2 === 0) aSize.setXYZW(i, c[5], c[4], c[3], 1);
          else aSize.setXYZW(i, c[3], c[4], c[5], 1);
        } else {
          const b = u.base;
          const o0 = u.open[0];
          const o1 = u.open[1];
          const mm = u.m;
          const e = u.e;
          const pr = push[u.row] ?? 0;
          for (let k = 0; k < 6; k++) c[k] = b[k] + e * (o0[k] + (o1[k] - o0[k]) * mm);
          c[0] += u.push[0] * pr;
          c[2] += u.push[1] * pr;
          c[3] += u.push[2] * pr;
          c[5] += u.push[3] * pr;
          c[1] += u.fy;
          // strain: the overhangs shiver under the build's tension, the higher the more
          if (u.kind === 0 && u.row > 0 && f.tension > 0.05) {
            const tr = f.tension * f.tension * 0.035 * Math.min(1, u.row / 4);
            c[1] += tr * Math.sin(clock * 37 + u.seed * 61);
            c[0] += tr * 0.6 * Math.sin(clock * 29 + u.seed * 23);
          }
          aPos.setXYZW(i, c[0], c[1], c[2], 0);
          aSize.setXYZW(i, c[3], c[4], c[5], u.kind);
        }
        // openings breathe a little with the push; voids open as the building opens
        const pr = push[u.row] ?? 0;
        const openK = u.face[0] === VOID ? 0.82 + 0.18 * u.e + 0.5 * pr : 1 + 0.25 * pr;
        aLook.setXYZW(i, Math.min(0.92, u.look[0] * openK), Math.min(0.9, u.look[1] * openK), u.look[2] * glowP, u.look[3]);
        aDyn.setXYZW(i, u.seed, (rowGlow[u.row] ?? 0) * (u.look[2] > 0 ? 1 : 0), ember * emberP, 0);
        if (u.kind !== 2) {
          // frame the building where it will rest, not where a flung block is in the air
          const fy = u.kind === 0 ? u.fy : u.parent !== undefined ? units[u.parent].fy : 0;
          bmin.set(Math.min(bmin.x, c[0] - c[3] / 2), Math.min(bmin.y, c[1] - fy - c[4] / 2), Math.min(bmin.z, c[2] - c[5] / 2));
          bmax.set(Math.max(bmax.x, c[0] + c[3] / 2), Math.max(bmax.y, c[1] - fy + c[4] / 2), Math.max(bmax.z, c[2] + c[5] / 2));
        }
      }
      landSum = landSum * Math.exp(-dt * 2.5) + landN;
      for (let k = 0; k < landN; k++) {
        const c = units[landI[k]].cur;
        // a dust budget: many small blocks landing together share it
        spawnDust(c[0], c[1] - c[4] / 2, c[2], c[3], c[5], landA[k] * weight * Math.min(1, 5 / Math.max(1, landSum)));
      }
      // dust drifts out, slows, rises a little and thins away
      const drag = Math.exp(-dt * 1.7);
      for (let i = 0; i < MAXD; i++) {
        if (dAge[i] >= 1) {
          dInfo[i * 2] = 1;
          continue;
        }
        dAge[i] = Math.min(1, dAge[i] + dt / dLife[i]);
        dVel[i * 3] *= drag;
        dVel[i * 3 + 1] = dVel[i * 3 + 1] * drag + 0.35 * dt;
        dVel[i * 3 + 2] *= drag;
        dPos[i * 3] += dVel[i * 3] * dt;
        dPos[i * 3 + 1] += dVel[i * 3 + 1] * dt;
        dPos[i * 3 + 2] += dVel[i * 3 + 2] * dt;
        dInfo[i * 2] = dAge[i];
        dInfo[i * 2 + 1] = dSize[i];
      }
      dPosAttr.needsUpdate = true;
      dInfoAttr.needsUpdate = true;
      dustMat.uniforms.uPx.value = frame.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      aPos.needsUpdate = true;
      aSize.needsUpdate = true;
      aLook.needsUpdate = true;
      aDyn.needsUpdate = true;

      /* shrubs ride on their blocks */
      const nb = plantsP > 0.01 ? Math.min(MAXB, Math.round(m.bushes.length * Math.min(1, 0.25 + plantsP))) : 0;
      for (let i = 0; i < nb; i++) {
        const bsh = m.bushes[i];
        const pu = units[bsh.parent].cur;
        const r = bsh.r * (0.6 + 0.6 * plantsP);
        aBush.setXYZW(i, pu[0] + bsh.fx * pu[3], pu[1] + pu[4] / 2 + r * 0.35, pu[2] + bsh.fz * pu[5], r);
      }
      aBush.needsUpdate = true;
      bgeo.instanceCount = nb;

      /* light: Feel's sun by day, one floodlight from below at night */
      const ang = f.light;
      // the sun stays on the camera's side of the front face, so the front reads lit and the flank in shade;
      // it swings round from a low raking morning light to a higher, flatter afternoon one
      const elev = 0.3 + 0.42 * Math.sin(ang);
      const sideSign = Math.round(num(p, 'seed', 3)) % 2 ? -1 : 1;
      const az = m.az + 1.0 - 0.3 * Math.cos(ang);
      const sunDir = U.uSunDir.value;
      const day = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
      // low and raking (steeper and the podium would shadow the whole tower), fading with height
      const flood = new THREE.Vector3(Math.sin(m.az + 0.55 * sideSign) * 0.8, -0.2, Math.cos(m.az + 0.55 * sideSign) * 0.8).normalize();
      sunDir.copy(day).lerp(flood, night).normalize();
      // the cool rim: from the far side of the flood, high up
      U.uRimDir.value.set(-Math.sin(m.az + 1.4 * sideSign) * 0.7, 0.55, -Math.cos(m.az + 1.4 * sideSign) * 0.7).normalize();
      const chorusStrobe = night * (peak ? 0.25 * a.kick : 0);
      U.uSunAmt.value = (0.1 + 0.72 * sunP) * (1 - night) + night * (1.25 + chorusStrobe);
      U.uAmb.value = (0.72 - 0.24 * sunP) * (1 - night) + night * 0.1;
      U.uNight.value = night;
      U.uFloodFall.value = 0.045;
      U.uFlash.value = flash * (0.25 + 0.5 * night) * weight * 0.6;
      U.uStainAmt.value = num(p, 'stain', 0.55);
      U.uPlantAmt.value = plantsP;
      const pal = frame.palette.c;
      U.uHorizon.value.copy(pal.bg).lerp(pal.accent, night > 0.5 ? 0.1 : 0.22);
      skyMat.uniforms.uClouds.value = num(p, 'clouds', 0.45);
      cloudT += dt * (0.012 + 0.03 * f.gust) * (frame.audio.playing ? 1 : 0.4);
      skyMat.uniforms.uCloudT.value = cloudT;

      /* bounds, eased so the camera reframes slowly as the building grows */
      if (!bInit) {
        bMin.copy(bmin);
        bMax.copy(bmax);
        bInit = true;
      } else {
        const k = 1 - Math.exp(-dt * 1.4);
        bMin.lerp(bmin, k);
        bMax.lerp(bmax, k);
      }

      /* camera */
      const dramaT = Math.min(1, 0.55 * f.tension + 0.85 * f.release + (peak ? 0.3 : 0)) * camAmt;
      drama = approach(drama, dramaT, dramaT > drama ? (f.sinceDrop < 0.5 ? 9 : 1.2) : 0.35, dt);
      swing = approach(swing, (drops % 2 ? 1 : -1) * Math.min(1, f.release * 1.4 + (peak ? 0.3 : 0)) * camAmt, 0.6, dt);
      tiltUp = approach(tiltUp, f.tension * camAmt, 0.8, dt);
      const aspect = frame.aspect;
      const camAz = m.az + 0.08 * Math.sin(clock * 0.021) + 0.22 * swing;
      const fov = 38 * (aspect < 1 ? Math.min(1.55, 1 / Math.pow(aspect, 0.55)) : 1) * (1 + 0.32 * drama);
      camera.fov = fov;
      camera.aspect = aspect;
      const tanV = Math.tan((fov * Math.PI) / 360);
      const tanH = tanV * aspect;
      const right = new THREE.Vector3(Math.cos(camAz), 0, -Math.sin(camAz));
      let wMin = 1e9;
      let wMax = -1e9;
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? bMax.x : bMin.x;
        const z = k & 2 ? bMax.z : bMin.z;
        const d = x * right.x + z * right.z;
        wMin = Math.min(wMin, d);
        wMax = Math.max(wMax, d);
      }
      const height = bMax.y;
      const cx = (bMin.x + bMax.x) / 2;
      const cz = (bMin.z + bMax.z) / 2;
      const depthHalf = Math.max(bMax.x - bMin.x, bMax.z - bMin.z) / 2;
      // monumental framing: the building fills most of the frame height, its foot a strip of pool above
      // the bottom edge; at the peak it grows past the top edge (the crown cropped)
      const footB = 0.11;
      const fill = m.fill + 0.12 * drama;
      const frameH = height / fill;
      const needH = frameH / 2;
      const needW = (wMax - wMin) * 0.5 * (aspect < 1 ? 0.8 : 1.02);
      const depthK = m.depthK;
      const fitH = needH / tanV;
      const fitW = needW / tanH;
      const dTarget = Math.max(fitH, fitW) + depthHalf * depthK;
      if (!camInit) {
        camDist = dTarget;
        camInit = true;
      } else camDist = approach(camDist, dTarget, f.sinceDrop < 0.6 ? 6 : 1.1, dt);
      // the jolt when blocks land
      const sAcc = -90 * shake - 11 * shakeV;
      shakeV += sAcc * dt;
      shake += shakeV * dt;
      shakeY = shake * 0.3;
      const camY = Math.max(0.35, 0.95 - 0.5 * drama) + shakeY;
      const cmid = (wMin + wMax) / 2;
      const lookX = cx + right.x * (cmid - (cx * right.x + cz * right.z));
      const lookZ = cz + right.z * (cmid - (cx * right.x + cz * right.z));
      camera.position.set(lookX + Math.sin(camAz) * camDist, camY, lookZ + Math.cos(camAz) * camDist);
      // the frame's centre in the building's plane, from the frame actually used (width may have set it)
      const frameA = 2 * Math.max(0.1, camDist - depthHalf * depthK) * tanV;
      const ty = frameA * (0.5 - footB);
      const pitchFull = Math.atan2(ty - camY, camDist);
      const pitchBase = pitchFull * Math.min(0.95, 0.12 + 0.55 * drama + 0.3 * tiltUp);
      // the jolt nods the camera too (not compensated by the lens shift)
      const pitch = pitchBase + shake * 0.025;
      camera.up.set(0, 1, 0);
      camera.lookAt(camera.position.x - Math.sin(camAz) * Math.cos(pitch), camY + Math.sin(pitch), camera.position.z - Math.cos(camAz) * Math.cos(pitch));
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      // lens shift for the rest, so the verticals stay parallel when the camera is calm
      const shift = Math.tan(pitchFull - pitchBase) / tanV;
      camera.projectionMatrix.elements[9] = shift * 0.92;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      /* sun shadow camera round the building */
      const ctr = new THREE.Vector3((bMin.x + bMax.x) / 2, bMax.y / 2, (bMin.z + bMax.z) / 2);
      const rad = Math.max(bMax.x - bMin.x, bMax.y, bMax.z - bMin.z) * 0.62 + 4;
      sunCam.left = -rad;
      sunCam.right = rad;
      sunCam.top = rad;
      sunCam.bottom = -rad;
      sunCam.near = 1;
      sunCam.far = 160 + rad * 2;
      sunCam.position.copy(ctr).addScaledVector(sunDir, 80 + rad);
      sunCam.up.set(0, 1, 0);
      if (Math.abs(sunDir.y) > 0.98) sunCam.up.set(0, 0, 1);
      sunCam.lookAt(ctr);
      sunCam.updateMatrixWorld();
      sunCam.updateProjectionMatrix();
      U.uShadowMat.value.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
      // top-down height map
      const trad = Math.max(bMax.x - bMin.x, bMax.z - bMin.z) * 0.5 + 6;
      topCam.left = -trad;
      topCam.right = trad;
      topCam.top = trad;
      topCam.bottom = -trad;
      topCam.near = 1;
      topCam.far = 100;
      topCam.position.set(ctr.x, 80, ctr.z);
      topCam.up.set(0, 0, -1);
      topCam.lookAt(ctr.x, 0, ctr.z);
      topCam.updateMatrixWorld();
      topCam.updateProjectionMatrix();
      U.uTopMat.value.multiplyMatrices(topCam.projectionMatrix, topCam.matrixWorldInverse);
      U.uTopRange.value.set(80 - topCam.near, topCam.far - topCam.near);

      /* pool */
      const poolOn = num(p, 'pool', 1);
      groundMat.uniforms.uPoolOn.value = poolOn > 0.5 ? 1 : 0;
      groundMat.uniforms.uPoolRect.value.set(poolC[0], poolC[1], m.pool[2], m.pool[3]);
      groundMat.uniforms.uPoolDir.value.set(Math.sin(m.az), Math.cos(m.az));
      for (const r of ripples) r.z += dt;
      groundMat.uniforms.uRipple0.value.copy(ripples[0]);
      groundMat.uniforms.uRipple1.value.copy(ripples[1]);
      groundMat.uniforms.uRipple2.value.copy(ripples[2]);

      sky.position.copy(camera.position);
      skyRef.position.copy(camera.position);
      sky.updateMatrixWorld();
      skyRef.updateMatrixWorld();

      for (const mat of materials) syncMaterial(mat, frame, params);
    }

    return {
      render(frame, target) {
        update(frame);
        const r = frame.renderer;
        const coarse = quality.current().sceneScale < 1;
        const want = coarse ? 1024 : 2048;
        if (want !== shadowSize) {
          shadowRT.dispose();
          shadowSize = want;
          shadowRT = mkDepthRT(want);
          U.uShadow.value = shadowRT.depthTexture;
        }
        U.uShadowTexel.value.set(1 / shadowSize, 1 / shadowSize);
        // shadows and the height map
        r.setRenderTarget(shadowRT);
        r.render(casterScene, sunCam);
        r.setRenderTarget(topRT);
        r.render(casterScene, topCam);
        // the reflection: the same view mirrored in the water, at reduced size
        const poolOn = (groundMat.uniforms.uPoolOn.value as number) > 0.5;
        if (poolOn) {
          const rs = coarse ? 0.35 : 0.5;
          const rw = Math.max(2, Math.round(frame.width * rs));
          const rh = Math.max(2, Math.round(frame.height * rs));
          if (reflRT.width !== rw || reflRT.height !== rh) reflRT.setSize(rw, rh);
          mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
          mirrorCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
          mirrorCam.matrixWorld.multiplyMatrices(reflectY, camera.matrixWorld);
          mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();
          boxMat.side = THREE.BackSide;
          bushMat.side = THREE.BackSide;
          skyMat.side = THREE.FrontSide;
          r.setRenderTarget(reflRT);
          U.uCheap.value = 1;
          r.render(refScene, mirrorCam);
          U.uCheap.value = 0;
          boxMat.side = THREE.FrontSide;
          bushMat.side = THREE.FrontSide;
          skyMat.side = THREE.BackSide;
        }
        groundMat.uniforms.uReflSize.value.set(frame.width, frame.height);
        r.setRenderTarget(target);
        r.render(scene, camera);
      },
      dispose() {
        shadowRT.dispose();
        topRT.dispose();
        reflRT.dispose();
        box.dispose();
        geo.dispose();
        ico.dispose();
        bgeo.dispose();
        dgeo.dispose();
        skyGeo.dispose();
        groundGeo.dispose();
        for (const mat of materials) mat.dispose();
      },
    };
  },
};
