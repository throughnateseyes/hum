/**
 * Trace: the part's pictures pinned up as a tracking board (the "surveillance desktop" look: photos
 * as hard-edged tiles on a dark field, thin lines traced from point to point across them, boxes
 * locked onto details, crosshairs and small mono readouts).
 *
 * The rule:
 *   tiles      four or five of the part's pictures, one large and the rest small, laid on the frame's
 *              grid from a handful of composed arrangements (mirrored, and turned for a wide frame).
 *              A new arrangement is dealt each bar: the tiles slide to it in one eased move on the bar
 *              line and hold. With one picture the small tiles are close crops of it, each centred on
 *              one of its anchor points; with more pictures than tiles, one small tile takes the next
 *              picture on every kick
 *   anchors    the points of each picture worth pointing at (its brightest spots and strongest
 *              corners, found once per picture; stills.ts)
 *   the trace  a path from anchor to anchor, tile to tile, growing one segment on every beat, the
 *              newest drawn in as it arrives; only the last nine stay, the oldest fading as the next
 *              lands, so it reads as something being traced rather than a web
 *   tracking   one box held on the large tile's first anchor, one that locks onto the newest point on
 *              every beat (it closes in from twice its size), each with a short label
 *   readouts   the tiles' file names and the large tile's position and size, the newest point's
 *              coordinates beside a hairline crosshair through it, and the bar, time and tempo
 *   scan       a line sweeps down one tile each beat, a different tile every beat
 *
 * Palette: the pictures in a reduced tone (grey for Clean, ink to paper for Tinted, three flat bands
 * for Flat), the lines, boxes and points in the one accent, the type and hairlines in paper on an ink
 * field (ink on paper for Flat). Everything resets at the shot's start and is drawn from song time.
 */
import * as THREE from 'three';
import type { Anchor } from '../stills';
import { HEAD_GLSL, TAIL_GLSL, barOf, clock, headUniforms, hitsBefore, makeMaterial, readable, unit, type TreatFrame } from './common';
import { ATLAS_GLSL, TextLines, atlasTexture, textGlsl } from './glyphs';

export const MAX_TILES = 5;
/** pictures a board can draw from (the shot's own and five more) */
export const MAX_PICTURES = 6;
const MAX_SEGS = 9;
const LINES = 12;

const FRAG = /* glsl */ `
${HEAD_GLSL}
${ATLAS_GLSL}
${textGlsl(LINES)}
${TAIL_GLSL}
uniform sampler2D tP0, tP1, tP2, tP3, tP4, tP5;
uniform vec4 uTile[${MAX_TILES}];
uniform vec4 uCrop[${MAX_TILES}];
uniform vec4 uMeta[${MAX_TILES}];
uniform float uTiles;
uniform vec4 uSeg[${MAX_SEGS}];
uniform float uSegA[${MAX_SEGS}];
uniform float uSegs;
uniform vec4 uNode[${MAX_SEGS + 1}];
uniform float uNodes;
uniform vec4 uBox[2];
uniform float uBoxes;
uniform vec3 uCross;
uniform vec3 uField, uDark, uLight, uMid, uAccent, uHair;
uniform float uMode, uLineW;
uniform vec2 uCuts;
uniform vec4 uGrid;
uniform vec2 uGridN;

vec3 pic(float s, vec2 uv) {
  uv = clamp(uv, 0.001, 0.999);
  if (s < 0.5) return texture2D(tP0, uv).rgb;
  if (s < 1.5) return texture2D(tP1, uv).rgb;
  if (s < 2.5) return texture2D(tP2, uv).rgb;
  if (s < 3.5) return texture2D(tP3, uv).rgb;
  if (s < 4.5) return texture2D(tP4, uv).rgb;
  return texture2D(tP5, uv).rgb;
}

// the picture in the board's reduced tone, its own range spread over the whole print
vec3 tone(vec3 c) {
  float l = luma(c);
  float lo = uCuts.x * 0.6;
  float hi = uCuts.y + (1.0 - uCuts.y) * 0.4;
  float k = smoothstep(0.0, 1.0, clamp((l - lo) / max(0.1, hi - lo), 0.0, 1.0));
  if (uMode < 1.5) return mix(uDark, uLight, k);
  float w = max(fwidth(k), 0.01);
  return mix(mix(uDark, uMid, smoothstep(0.36 - w, 0.36 + w, k)), uLight, smoothstep(0.68 - w, 0.68 + w, k));
}

float segDist(vec2 p, vec4 s) {
  vec2 pa = p - s.xy;
  vec2 ba = s.zw - s.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}

// a crisp hairline: full inside half its width, one pixel of falloff
float hair(float d, float w) { return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, d); }

void main() {
  vec2 px = vUv * uRes;
  vec4 b = bed(vUv);
  vec3 col = uField;

  // the board's grid: a small cross at every module corner
  vec2 gq = (px - uGrid.xy) / uGrid.zw;
  vec2 gn = floor(gq + 0.5);
  if (gn.x >= 0.0 && gn.y >= 0.0 && gn.x <= uGridN.x && gn.y <= uGridN.y) {
    vec2 gd = abs(px - (uGrid.xy + gn * uGrid.zw));
    float arm = uLineW * 3.5;
    float cross_ = max(step(gd.x, uLineW * 0.5) * step(gd.y, arm), step(gd.y, uLineW * 0.5) * step(gd.x, arm));
    col = mix(col, uHair, cross_ * 0.3);
  }

  // the tiles, the large one first so the small ones sit over it while they slide
  for (int i = 0; i < ${MAX_TILES}; i++) {
    if (float(i) >= uTiles) break;
    vec4 r = uTile[i];
    vec4 m = uMeta[i];
    if (m.y <= 0.0) continue;
    if (px.x < r.x || px.x > r.z || px.y < r.y || px.y > r.w) continue;
    vec2 local = (px - r.xy) / (r.zw - r.xy);
    vec4 c = uCrop[i];
    vec3 t = tone(pic(m.x, mix(c.xy, c.zw, local)));
    // the scan: a line sweeping down the tile, the rows it has passed lifted a little
    if (m.z > -1.0) {
      float dy = px.y - m.z;
      t = mix(t, uLight, step(0.0, dy) * exp(-dy / (uLineW * 18.0)) * 0.22);
      t = mix(t, uAccent, hair(abs(dy), uLineW * 1.5));
    }
    // a hard edge, and a hairline round it
    float edge = min(min(px.x - r.x, r.z - px.x), min(px.y - r.y, r.w - px.y));
    t = mix(t, uHair, hair(edge, uLineW * 2.0) * 0.7);
    // a tile arriving flicks on: a frame of paper, then the picture
    col = m.y < 0.5 ? uLight : t;
  }

  // the crosshair through the newest point
  if (uCross.z > 0.0) {
    float d = min(abs(px.x - uCross.x), abs(px.y - uCross.y));
    col = mix(col, uHair, hair(d, uLineW) * uCross.z);
  }

  // the trace
  for (int i = 0; i < ${MAX_SEGS}; i++) {
    if (float(i) >= uSegs) break;
    col = mix(col, uAccent, hair(segDist(px, uSeg[i]), uLineW * 1.6) * uSegA[i]);
  }
  for (int i = 0; i < ${MAX_SEGS + 1}; i++) {
    if (float(i) >= uNodes) break;
    vec4 n = uNode[i];
    vec2 d = abs(px - n.xy);
    float s = abs(n.z);
    float inside = step(max(d.x, d.y), s);
    // a solid point, or (the newest) an open square round a dot
    float ring = n.z < 0.0 ? inside * (1.0 - step(max(d.x, d.y), s - uLineW * 1.6)) + step(max(d.x, d.y), uLineW * 1.6) : inside;
    col = mix(col, uAccent, ring * n.w);
  }

  // the tracking boxes: corner brackets
  for (int i = 0; i < 2; i++) {
    if (float(i) >= uBoxes) break;
    vec4 bx = uBox[i];
    vec2 d = abs(px - bx.xy);
    float s = bx.z;
    float onEdge = max(step(abs(d.x - s), uLineW * 0.8) * step(d.y, s + uLineW * 0.8), step(abs(d.y - s), uLineW * 0.8) * step(d.x, s + uLineW * 0.8));
    float corner = step(s * 0.55, max(d.x, d.y)) * step(s * 0.5, min(d.x, d.y));
    col = mix(col, uAccent, onEdge * corner * bx.w);
  }

  col = textOver(px, col);
  gl_FragColor = finish(col, b);
}
`;

export interface TracePicture {
  texture: THREE.Texture;
  aspect: number;
  anchors?: Anchor[];
  name?: string;
}

/** a tile in grid modules (column, row from the top, width, height), on a 6 x 10 board */
type Cell = [number, number, number, number];
const GW = 6;
const GH = 10;

/** composed arrangements for a tall frame: the large tile first; a wide frame turns them */
const BOARDS: Cell[][] = [
  [
    [0, 0, 4, 5],
    [4, 1, 2, 2],
    [3, 6, 3, 2],
    [0, 6, 2, 2],
    [1, 8, 2, 2],
  ],
  [
    [1, 2, 5, 4],
    [0, 0, 2, 2],
    [0, 7, 3, 3],
    [4, 7, 2, 2],
    [3, 0, 2, 1],
  ],
  [
    [0, 3, 6, 4],
    [0, 0, 2, 2],
    [3, 0, 3, 2],
    [1, 8, 2, 2],
    [4, 8, 2, 2],
  ],
  [
    [0, 4, 4, 6],
    [1, 0, 2, 2],
    [4, 1, 2, 3],
    [4, 5, 2, 2],
    [4, 8, 2, 2],
  ],
  [
    [2, 1, 4, 5],
    [0, 0, 2, 2],
    [0, 3, 2, 2],
    [0, 7, 3, 3],
    [4, 7, 2, 2],
  ],
];

/** a file name in a few characters the glyph atlas has: NAME.EXT */
function shortName(name: string | undefined, i: number): string {
  const n = (name ?? '').toUpperCase();
  const dot = n.lastIndexOf('.');
  const base = (dot > 0 ? n.slice(0, dot) : n).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 9);
  const ext = dot > 0 ? n.slice(dot + 1).replace(/[^A-Z0-9]/g, '').slice(0, 3) : '';
  if (!base) return `PIC_${String(i + 1).padStart(2, '0')}`;
  return ext ? `${base}.${ext}` : base;
}

const pad = (v: number, n = 4) => String(Math.max(0, Math.round(v))).padStart(n, '0');

interface Tile {
  /** px, from the bottom-left */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** which picture, and the part of it shown (texture space) */
  src: number;
  crop: [number, number, number, number];
  /** the anchor the crop is centred on, when it is a close crop (-1: the whole picture) */
  focus: number;
}

export class Trace {
  readonly material: THREE.ShaderMaterial;
  private readonly lines = new TextLines(LINES);
  private readonly tile = Array.from({ length: MAX_TILES }, () => new THREE.Vector4());
  private readonly crop = Array.from({ length: MAX_TILES }, () => new THREE.Vector4());
  private readonly meta = Array.from({ length: MAX_TILES }, () => new THREE.Vector4());
  private readonly seg = Array.from({ length: MAX_SEGS }, () => new THREE.Vector4());
  private readonly segA = new Array<number>(MAX_SEGS).fill(0);
  private readonly node = Array.from({ length: MAX_SEGS + 1 }, () => new THREE.Vector4());
  private readonly box = [new THREE.Vector4(), new THREE.Vector4()];

  constructor() {
    this.material = makeMaterial(FRAG, {
      ...headUniforms(),
      tAtlas: { value: atlasTexture() },
      ...this.lines.uniforms(),
      tP0: { value: null },
      tP1: { value: null },
      tP2: { value: null },
      tP3: { value: null },
      tP4: { value: null },
      tP5: { value: null },
      uTile: { value: this.tile },
      uCrop: { value: this.crop },
      uMeta: { value: this.meta },
      uTiles: { value: 0 },
      uSeg: { value: this.seg },
      uSegA: { value: this.segA },
      uSegs: { value: 0 },
      uNode: { value: this.node },
      uNodes: { value: 0 },
      uBox: { value: this.box },
      uBoxes: { value: 0 },
      uCross: { value: new THREE.Vector3() },
      uField: { value: new THREE.Color() },
      uDark: { value: new THREE.Color() },
      uLight: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uHair: { value: new THREE.Color() },
      uMode: { value: 1 },
      uLineW: { value: 1 },
      uCuts: { value: new THREE.Vector2(0.33, 0.66) },
      uGrid: { value: new THREE.Vector4() },
      uGridN: { value: new THREE.Vector2() },
    });
  }

  /** the board's modules in px: origin (bottom-left of the grid), module size, and how many */
  private geometry(w: number, h: number) {
    const short = Math.min(w, h);
    const m = Math.round(short * 0.075);
    const wide = w > h;
    const gw = wide ? GH : GW;
    const gh = wide ? GW : GH;
    return { m, gw, gh, mw: (w - 2 * m) / gw, mh: (h - 2 * m) / gh, gap: Math.max(8, Math.round(short * 0.034)), wide };
  }

  /** the tiles' places (px, bottom-left origin) in bar `bar`'s arrangement */
  private placeOf(f: TreatFrame, w: number, h: number, bar: number, count: number): [number, number, number, number][] {
    const g = this.geometry(w, h);
    // a new arrangement each bar, never the one before it
    const pick = (k: number) => Math.floor(unit(f.layout, k, 11) * BOARDS.length);
    let which = pick(bar);
    if (which === pick(bar - 1)) which = (which + 1) % BOARDS.length;
    const flipX = unit(f.layout, bar, 13) < 0.5;
    const flipY = unit(f.layout, bar, 17) < 0.3;
    return BOARDS[which].slice(0, count).map(([c, r, cw, rh]) => {
      let [x, y, ww, hh] = g.wide ? [r, c, rh, cw] : [c, r, cw, rh];
      if (flipX) x = g.gw - x - ww;
      if (flipY) y = g.gh - y - hh;
      const half = g.gap / 2;
      const left = g.m + x * g.mw + half;
      const right = g.m + (x + ww) * g.mw - half;
      const top = h - (g.m + y * g.mh + half);
      const bottom = h - (g.m + (y + hh) * g.mh - half);
      return [left, bottom, right, top];
    });
  }

  update(f: TreatFrame, w: number, h: number, pictures: TracePicture[]) {
    const u = this.material.uniforms;
    const short = Math.min(w, h);
    const lw = Math.max(1, short / 720);
    u.uLineW.value = lw;
    const pics = pictures.slice(0, MAX_PICTURES);
    const P = Math.max(1, pics.length);
    const texs = [u.tP0, u.tP1, u.tP2, u.tP3, u.tP4, u.tP5];
    texs.forEach((x, i) => (x.value = pics[i]?.texture ?? pics[0]?.texture ?? null));
    const count = P <= 2 ? 4 : MAX_TILES;
    const anchorsOf = (s: number): Anchor[] => (pics[s]?.anchors?.length ? pics[s].anchors! : [[0.4, 0.6], [0.62, 0.4], [0.5, 0.5]]);

    // the bar, the slide into its arrangement, and the beats and kicks counted from the shot's start
    const barLen = f.beat * 4;
    const bar = Math.floor((f.t - f.partStart) / barLen + 1e-4);
    const firstBar = Math.floor((f.shotStart - f.partStart) / barLen + 1e-4);
    const barStart = f.partStart + bar * barLen;
    const move = Math.min(0.45, f.beat * 0.9);
    const k = bar > firstBar ? easeInOut(Math.min(1, (f.t - barStart) / move)) : 1;
    const now = this.placeOf(f, w, h, bar, count);
    const was = bar > firstBar ? this.placeOf(f, w, h, bar - 1, count) : now;
    const kicks = hitsBefore(f.kicks, f.t, f.shotStart + 1e-3).n;

    // which picture each tile shows: the shot's own in the large tile, then the others in turn; with
    // more pictures than tiles, the small tile whose turn it is takes the next picture on each kick
    const srcOf = (i: number): { src: number; focus: number } => {
      if (i === 0) return { src: 0, focus: -1 };
      if (P === 1) return { src: 0, focus: (i - 1) % anchorsOf(0).length };
      let src = i < P ? i : 1 + ((i - 1) % (P - 1));
      if (P > count) {
        for (let j = kicks - 1; j >= 0; j--) {
          if (1 + (j % (count - 1)) !== i) continue;
          src = 1 + ((count - 1 + j) % (P - 1));
          break;
        }
      }
      // a picture shown twice is a close crop the second time
      return { src, focus: i >= P && P <= count ? (i - 1) % anchorsOf(src).length : -1 };
    };

    const tiles: Tile[] = now.map((r, i) => {
      const x0 = lerp(was[i][0], r[0], k);
      const y0 = lerp(was[i][1], r[1], k);
      const x1 = lerp(was[i][2], r[2], k);
      const y1 = lerp(was[i][3], r[3], k);
      const { src, focus } = srcOf(i);
      // the crop: the picture filling the tile, a little pushed in and drifting over the bar; a close
      // crop is a quarter of the picture, centred on its anchor
      const aspect = pics[src]?.aspect ?? 1;
      const ta = (x1 - x0) / Math.max(1, y1 - y0);
      let cw = ta > aspect ? 1 : ta / aspect;
      let ch = ta > aspect ? aspect / ta : 1;
      const into = clamp01((f.t - Math.max(barStart, f.shotStart)) / barLen);
      const zoom = (focus >= 0 ? 3 : 1.06) * (1 + 0.04 * into);
      cw /= zoom;
      ch /= zoom;
      let cx = 0.5;
      let cy = 0.5;
      if (focus >= 0) [cx, cy] = anchorsOf(src)[focus];
      else if (i === 0) {
        cx = f.focus.x;
        cy = f.focus.y;
      }
      const dx = (unit(f.layout, bar, i, 19) - 0.5) * 0.03 * into;
      cx = Math.min(1 - cw / 2, Math.max(cw / 2, cx + dx));
      cy = Math.min(1 - ch / 2, Math.max(ch / 2, cy));
      return { x0, y0, x1, y1, src, crop: [cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2], focus };
    });

    // tiles come on one after another as the shot opens
    const opened = f.t - f.shotStart;
    const stagger = Math.min(0.09, f.beat / 4);
    // the scan: one tile a beat
    const beatN = Math.floor((f.t - f.partStart) / f.beat + 1e-4);
    const beatAt = f.partStart + beatN * f.beat;
    const scanOn = beatN % count;
    const scanK = (f.t - beatAt) / (f.beat * 0.7);
    tiles.forEach((tl, i) => {
      this.tile[i].set(tl.x0, tl.y0, tl.x1, tl.y1);
      this.crop[i].set(...tl.crop);
      const shown = opened - i * stagger;
      const appear = shown < 0 ? 0 : shown < 1 / 30 ? 0.25 : 1;
      const scanY = i === scanOn && scanK < 1 && opened > f.beat * 0.5 ? tl.y1 - (tl.y1 - tl.y0) * scanK : -2;
      this.meta[i].set(tl.src, appear, scanY, 0);
    });
    u.uTiles.value = tiles.length;

    // a point of the trace: an anchor of a tile, where it is on screen now
    const pointOf = (ti: number, which: number): [number, number] => {
      const tl = tiles[ti];
      const list = anchorsOf(tl.src);
      const a = tl.focus >= 0 ? list[tl.focus] : list[which % list.length];
      const lx = clamp((a[0] - tl.crop[0]) / (tl.crop[2] - tl.crop[0]), 0.1, 0.9);
      const ly = clamp((a[1] - tl.crop[1]) / (tl.crop[3] - tl.crop[1]), 0.1, 0.9);
      return [lerp(tl.x0, tl.x1, lx), lerp(tl.y0, tl.y1, ly)];
    };
    // the path: round the board from the large tile, through the small ones in an order the
    // arrangement deals, and back, taking a different anchor of the large tile each time round
    const order = [...Array(count - 1).keys()].map((x) => x + 1).sort((a, b) => unit(f.layout, a, 23) - unit(f.layout, b, 23));
    const nodeAt = (j: number): [number, number] => {
      const lap = Math.floor(j / count);
      const pos = j % count;
      return pos === 0 ? pointOf(0, lap) : pointOf(order[pos - 1], lap + pos);
    };
    // one step on every beat after the shot's first
    const firstStep = f.partStart + Math.ceil((f.shotStart + f.beat * 0.75 - f.partStart) / f.beat - 1e-4) * f.beat;
    const steps = f.t < firstStep ? 0 : Math.floor((f.t - firstStep) / f.beat + 1e-4) + 1;
    const lastStep = firstStep + (steps - 1) * f.beat;
    const grow = steps ? easeOut(clamp01((f.t - lastStep) / Math.min(0.18, f.beat * 0.45))) : 0;
    const fromSeg = Math.max(0, steps - MAX_SEGS);
    let segs = 0;
    for (let s = fromSeg; s < steps; s++) {
      const a = nodeAt(s);
      const bb = nodeAt(s + 1);
      const end = s === steps - 1 ? [lerp(a[0], bb[0], grow), lerp(a[1], bb[1], grow)] : bb;
      this.seg[segs].set(a[0], a[1], end[0], end[1]);
      // the oldest fades as the newest grows in
      this.segA[segs] = s === steps - MAX_SEGS ? 1 - grow : 1;
      segs++;
    }
    u.uSegs.value = segs;
    let nodes = 0;
    const newest = steps ? nodeAt(steps) : null;
    for (let s = fromSeg; s < steps; s++) {
      const p = nodeAt(s);
      this.node[nodes++].set(p[0], p[1], lw * 2.6, s === fromSeg && steps > MAX_SEGS ? 1 - grow : 1);
    }
    if (newest && grow >= 1) this.node[nodes++].set(newest[0], newest[1], -lw * 6.5, 1);
    u.uNodes.value = nodes;
    (u.uCross.value as THREE.Vector3).set(newest?.[0] ?? 0, newest?.[1] ?? 0, newest && grow >= 1 ? 0.35 : 0);

    // the tracking boxes: one held on the large tile, one locking onto the newest point each beat
    const half = short * 0.045;
    const lock = (since: number) => half * (1 + 1.2 * (1 - easeOut(clamp01(since / 0.2))));
    let boxes = 0;
    if (opened > f.beat * 0.5) {
      const p = pointOf(0, 0);
      this.box[boxes++].set(p[0], p[1], lock(f.t - Math.max(f.shotStart + f.beat * 0.5, bar > firstBar ? barStart : -1e9)), 1);
    }
    if (newest && grow >= 1) this.box[boxes++].set(newest[0], newest[1], lock(f.t - lastStep - Math.min(0.18, f.beat * 0.45)) * 0.75, 1);
    u.uBoxes.value = boxes;

    // colours
    const s = f.scheme;
    const flat = f.colour === 'flat';
    const ink = new THREE.Color(s.ink);
    const paper = new THREE.Color(s.paper);
    (u.uField.value as THREE.Color).copy(flat ? paper : ink);
    if (f.colour === 'clean') {
      (u.uDark.value as THREE.Color).setRGB(0.07, 0.07, 0.075);
      (u.uLight.value as THREE.Color).setRGB(0.9, 0.9, 0.89);
    } else {
      (u.uDark.value as THREE.Color).copy(ink).lerp(new THREE.Color(0, 0, 0), flat ? 0 : 0.2);
      (u.uLight.value as THREE.Color).copy(paper);
    }
    (u.uMid.value as THREE.Color).set(s.mid);
    (u.uAccent.value as THREE.Color).set(s.accent);
    (u.uHair.value as THREE.Color).copy(flat ? ink : paper);
    u.uMode.value = flat ? 2 : 1;
    (u.uCuts.value as THREE.Vector2).set(s.cuts[0], s.cuts[1]);
    const g = this.geometry(w, h);
    (u.uGrid.value as THREE.Vector4).set(g.m, g.m, g.mw, g.mh);
    (u.uGridN.value as THREE.Vector2).set(g.gw, g.gh);

    // the readouts
    const L = this.lines;
    L.clear();
    const cap = Math.max(9, Math.round(short * 0.017));
    const cw = cap * 0.62;
    const text = flat ? ink : paper;
    const back = flat ? paper : ink;
    const fit = (x: number, len: number) => Math.min(w - g.m * 0.5 - len * cw, Math.max(g.m * 0.5, x));
    tiles.forEach((tl, i) => {
      if (opened - i * stagger < 0) return;
      const label = `${String(i + 1).padStart(2, '0')} ${shortName(pics[tl.src]?.name, tl.src)}${tl.focus >= 0 ? ' ZOOM' : ''}`;
      // above the tile's top-left corner, in the gutter
      L.add(label, fit(tl.x0, label.length), tl.y1 + cap * 0.45, cap, text, null);
    });
    const big = tiles[0];
    const pos = `X${pad(big.x0)} Y${pad(h - big.y1)} W${pad(big.x1 - big.x0)} H${pad(big.y1 - big.y0)}`;
    L.add(pos, fit(big.x1 - pos.length * cw, pos.length), big.y0 - cap * 1.45, cap, text, null);
    if (boxes > 0) {
      const p = this.box[0];
      const l = `TRK 01 ${shortName(pics[0]?.name, 0)}`;
      L.add(l, fit(p.x + p.z + cap * 0.5, l.length), p.y + p.z - cap, cap, text, back);
    }
    if (newest && grow >= 1) {
      const l = `${pad(newest[0])}.${pad(h - newest[1])}`;
      L.add(l, fit(newest[0] + half * 0.75 + cap * 0.5, l.length), newest[1] - cap * 0.5, cap, readable(u.uAccent.value as THREE.Color, back), back);
    }
    const stamp = `BAR ${String(barOf(f)).padStart(3, '0')} · ${clock(f.t, true)} · ${f.labels.tempo}`;
    L.add(stamp, g.m * 0.5 + cap * 0.2, g.m * 0.5 - cap * 0.3, cap, text, null);
    const count2 = `TRC ${String(steps).padStart(3, '0')} · PTS ${String(Math.min(steps, MAX_SEGS) + 1).padStart(2, '0')}`;
    L.add(count2, w - g.m * 0.5 - count2.length * cw, g.m * 0.5 - cap * 0.3, cap, text, null);
    L.without(f.taken, w, h);
    L.commit();
    u.uLines.value = L.count;
  }

  dispose() {
    this.material.dispose();
    this.lines.texture.dispose();
  }
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
