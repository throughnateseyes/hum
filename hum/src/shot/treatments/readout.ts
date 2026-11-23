/**
 * Readout: the subject as an analysis readout (reference: two figures as coarse magenta pixels on
 * grey paper, thin numbered boxes on them, small captions and a timestamp in mono type).
 *
 * The rule: the frame is read as coarse pixels whose size steps with the beat. The pixels are split
 * by brightness at the level that best separates the picture into two (Otsu's method), and the side
 * that covers less of the frame is the subject: it is drawn in ONE accent colour, in two or three
 * shades, on a flat grey paper with a little grain; pixels just short of the cut are a pale tint of
 * the accent. The two or three largest connected blobs of the subject get a thin numbered box each,
 * locked onto them frame by frame, with a caption that says something true about the song.
 *
 * Every frame reads the coarse pixels back (a few hundred bytes) to find the cut and the blobs, so
 * the boxes are a function of the picture on screen and nothing else. Live, the read is asynchronous
 * (a pixel-pack buffer and a fence: a synchronous readPixels makes the page wait for the GPU to finish
 * everything queued so far, which stalls Direct3D badly), so the cut and the boxes follow the picture
 * a frame or two late; the coarse pixels themselves are always this frame's. The first frame of a
 * shot, and a render (render/timeline.ts takes the async read away so frames come out the same every
 * time), still read synchronously.
 */
import * as THREE from 'three';
import { HEAD_GLSL, TAIL_GLSL, barOf, clock, headUniforms, makeMaterial, strictFor, unit, type TreatFrame } from './common';
import { ATLAS_GLSL, TEXT_GLSL, TextLines, atlasTexture } from './glyphs';

const COARSE = /* glsl */ `
${HEAD_GLSL}
uniform vec2 uGrid;
uniform float uPx;
uniform vec2 uOff;
void main() {
  // one texel per coarse pixel: the picture's average brightness under it, and how much of it is picture
  vec2 cell = floor(gl_FragCoord.xy);
  if (cell.x >= uGrid.x || cell.y >= uGrid.y) { gl_FragColor = vec4(0.0); return; }
  vec2 o = uOff + cell * uPx;
  float l = 0.0;
  float a = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec4 c = bed((o + (vec2(float(i), float(j)) + 0.5) * uPx / 4.0) / uRes);
    l += luma(c.rgb);
    a += c.a;
  }
  gl_FragColor = vec4(l / 16.0, a / 16.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
${HEAD_GLSL}
${ATLAS_GLSL}
${TEXT_GLSL}
${TAIL_GLSL}
uniform sampler2D tCoarse;
uniform vec2 uGrid, uCoarseSize, uOff;
uniform float uPx, uCut, uPol, uSpan, uSeed, uBeatN, uGrain;
uniform vec2 uBand;
uniform vec3 uField, uAccent, uLine;
uniform vec4 uBox[3];
uniform float uBoxes;

float soft(vec2 cell) {
  // the cell's brightness softened with its neighbours (1-2-1 each way), so the subject of a busy
  // picture reads as a shape rather than a speckle; read() softens the same way before the cut
  float l = 0.0;
  float w = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    if (c.x < 0.0 || c.y < 0.0 || c.x > uGrid.x - 1.0 || c.y > uGrid.y - 1.0) continue;
    vec2 t = texture2D(tCoarse, (c + 0.5) / uCoarseSize).rg;
    float k = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0) * step(0.5, t.g);
    l += t.r * k;
    w += k;
  }
  return w > 0.0 ? l / w : texture2D(tCoarse, (cell + 0.5) / uCoarseSize).r;
}

float boxLine(vec2 px, vec4 r, float w) {
  // the outline of a box (x0, y0, x1, y1), w px thick
  vec2 lo = r.xy;
  vec2 hi = r.zw;
  bool inside = px.x > lo.x - w && px.x < hi.x + w && px.y > lo.y - w && px.y < hi.y + w;
  bool inner = px.x > lo.x && px.x < hi.x && px.y > lo.y && px.y < hi.y;
  return inside && !inner ? 1.0 : 0.0;
}

void main() {
  vec2 px = vUv * uRes;
  vec4 b = bed(vUv);
  vec2 cell = floor((px - uOff) / uPx);
  float l = soft(clamp(cell, vec2(0.0), uGrid - 1.0));
  // how far into the subject this pixel is, in units of the picture's spread
  float s = (uPol > 0.5 ? l - uCut : uCut - l) / max(0.04, uSpan);

  // paper: flat grey with a fine grain
  float grain = (hash(floor(px)) - 0.5) * uGrain + (vnoise(px * 0.35) - 0.5) * uGrain * 0.8;
  vec3 col = uField * (1.0 + grain);
  if (s > 0.0) {
    // the subject: one colour in three shades, deeper toward its core; the shades split the subject
    // into thirds (uBand), so a busy picture whose subject sits close to the cut still gets all three
    float shade = s > uBand.y ? 1.0 : s > uBand.x ? 0.8 : 0.58;
    col = mix(uField, uAccent, shade);
    col = mix(col, uAccent * 1.12, step(uBand.y, s) * 0.5);
    // a few coarse pixels hold a scrap of fine texture, changing on the beat
    float h = hash(cell + floor(uBeatN) * 0.37 + uSeed);
    if (h < 0.05) {
      vec2 sub = floor(fract((px - uOff) / uPx) * 5.0);
      col = mix(col, mix(uField, uAccent, 0.4 + 0.6 * hash(sub + cell)), 0.85);
    }
  } else if (s > -0.35) {
    // just short of the cut: a pale tint of the accent, the haze round the subject
    col = mix(uField, uAccent, 0.3 + 0.25 * step(-0.15, s));
  }
  col *= 1.0 + grain * 0.6;

  for (int i = 0; i < 3; i++) {
    if (float(i) >= uBoxes) break;
    col = mix(col, uLine, boxLine(px, uBox[i], 1.6));
  }
  col = textOver(px, col);
  // the paper covers the whole picture, fields and all, except where the style printed a solid field
  gl_FragColor = finish(col, b);
}
`;

interface Blob {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** the beat's pixel size, as a share of the short side: big on the bar line, smaller after */
const STEPS = [1, 0.72, 0.86, 0.6];

export class Readout {
  readonly coarse: THREE.ShaderMaterial;
  readonly material: THREE.ShaderMaterial;
  private rt: THREE.WebGLRenderTarget | null = null;
  private buf = new Uint8Array(4);
  /** the grid the last finished read was taken on (the boxes are placed on it), and its shot */
  private read: { cols: number; rows: number; px: number; off: THREE.Vector2; shot: number; buf: Uint8Array } | null = null;
  private pending = false;
  private readonly lines = new TextLines();
  private readonly boxes = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];

  constructor() {
    this.coarse = makeMaterial(COARSE, { ...headUniforms(), uGrid: { value: new THREE.Vector2(1, 1) }, uPx: { value: 24 }, uOff: { value: new THREE.Vector2() } });
    this.material = makeMaterial(FRAG, {
      ...headUniforms(),
      tAtlas: { value: atlasTexture() },
      ...this.lines.uniforms(),
      tCoarse: { value: null },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uCoarseSize: { value: new THREE.Vector2(1, 1) },
      uOff: { value: new THREE.Vector2() },
      uPx: { value: 24 },
      uCut: { value: 0.5 },
      uPol: { value: 1 },
      uSpan: { value: 0.3 },
      uBand: { value: new THREE.Vector2(0.4, 0.9) },
      uSeed: { value: 0 },
      uBeatN: { value: 0 },
      uGrain: { value: 0.06 },
      uField: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uLine: { value: new THREE.Color() },
      uBox: { value: this.boxes },
      uBoxes: { value: 0 },
    });
  }

  /** the coarse texture, big enough for the smallest pixel size at this frame size */
  private target(w: number, h: number): THREE.WebGLRenderTarget {
    const short = Math.min(w, h);
    const px = Math.max(4, Math.round(short * 0.042 * Math.min(...STEPS)));
    const cw = Math.ceil(w / px) + 2;
    const ch = Math.ceil(h / px) + 2;
    if (!this.rt || this.rt.width !== cw || this.rt.height !== ch) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(cw, ch, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.buf = new Uint8Array(cw * ch * 4);
    }
    return this.rt;
  }

  /** read the picture as coarse pixels, find the cut and the blobs; then the shader is ready to draw */
  update(f: TreatFrame, w: number, h: number, renderer: THREE.WebGLRenderer, bedTex: THREE.Texture, draw: (m: THREE.Material, t: THREE.WebGLRenderTarget) => void) {
    const short = Math.min(w, h);
    const beatN = Math.floor((f.t - f.shotStart) / f.beat + 1e-4);
    const px = Math.max(4, Math.round(short * 0.042 * STEPS[beatN % STEPS.length]));
    const cols = Math.ceil(w / px);
    const rows = Math.ceil(h / px);
    const off = new THREE.Vector2(Math.floor((w - cols * px) / 2), Math.floor((h - rows * px) / 2));
    const rt = this.target(w, h);
    const cu = this.coarse.uniforms;
    cu.tBed.value = bedTex;
    (cu.uRes.value as THREE.Vector2).set(w, h);
    (cu.uGrid.value as THREE.Vector2).set(cols, rows);
    cu.uPx.value = px;
    (cu.uOff.value as THREE.Vector2).copy(off);
    draw(this.coarse, rt);
    const grid = { cols, rows, px, off: off.clone(), shot: f.shotStart };
    const ar = renderer as THREE.WebGLRenderer & { readRenderTargetPixelsAsync?: (...a: unknown[]) => Promise<unknown> };
    if (!ar.readRenderTargetPixelsAsync || !this.read || this.read.shot !== f.shotStart) {
      renderer.readRenderTargetPixels(rt, 0, 0, cols, rows, this.buf);
      this.read = { ...grid, buf: this.buf.slice(0, cols * rows * 4) };
    } else if (!this.pending) {
      this.pending = true;
      const into = new Uint8Array(cols * rows * 4);
      ar.readRenderTargetPixelsAsync(rt, 0, 0, cols, rows, into)
        .then(() => {
          // a read that finished after a cut belongs to the old shot
          if (this.read?.shot === grid.shot) this.read = { ...grid, buf: into };
        })
        .catch(() => undefined)
        .finally(() => {
          this.pending = false;
        });
    }
    this.analyse(f, w, h, rt, cols, rows, px, off, beatN, short);
  }

  /** find the cut and the blobs on the last read grid, and set up the shader for this frame's grid */
  private analyse(f: TreatFrame, w: number, h: number, rt: THREE.WebGLRenderTarget, curCols: number, curRows: number, curPx: number, curOff: THREE.Vector2, beatN: number, short: number) {
    const R = this.read!;
    const { cols, rows, px, off } = R;
    const buf = R.buf;

    // the coarse pixels softened with their neighbours the way the shader does (soft())
    const sm = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let l = 0;
        let wt = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const cx = x + i;
            const cy = y + j;
            if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
            const k = cy * cols + cx;
            if (buf[k * 4 + 1] < 128) continue;
            const g = (i === 0 ? 2 : 1) * (j === 0 ? 2 : 1);
            l += (buf[k * 4] / 255) * g;
            wt += g;
          }
        }
        sm[y * cols + x] = wt ? l / wt : buf[(y * cols + x) * 4] / 255;
      }
    }
    // the cut that best splits the picture's coarse pixels into two (Otsu), and which side is smaller
    const hist = new Float32Array(64);
    let total = 0;
    for (let i = 0; i < cols * rows; i++) {
      if (buf[i * 4 + 1] < 128) continue;
      hist[Math.min(63, Math.floor(sm[i] * 64))]++;
      total++;
    }
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += i * hist[i];
    let wB = 0;
    let sB = 0;
    let best = 0;
    let cutBin = 32;
    for (let i = 0; i < 64; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB;
      const mF = (sum - sB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) {
        best = between;
        cutBin = i;
      }
    }
    let below = 0;
    for (let i = 0; i <= cutBin; i++) below += hist[i];
    const cut = (cutBin + 1) / 64;
    // the subject is the side that covers less of the frame (a figure on a field)
    const pol = below > total - below ? 1 : 0;
    // the spread of the subject side, so the shades fall across it evenly
    let far = cutBin;
    if (pol) for (let i = 63; i > cutBin; i--) { if (hist[i]) { far = i; break; } }
    else for (let i = 0; i <= cutBin; i++) { if (hist[i]) { far = i; break; } }
    const span = Math.max(0.05, Math.abs(far / 64 - cut));

    // the largest blobs of the subject (4-connected), in coarse pixels
    const isSub = (i: number) => buf[i * 4 + 1] >= 128 && (pol ? sm[i] > cut : sm[i] < cut);
    // the subject's thirds, for its three shades
    const depth: number[] = [];
    for (let i = 0; i < cols * rows; i++) if (isSub(i)) depth.push((pol ? sm[i] - cut : cut - sm[i]) / Math.max(0.04, span));
    depth.sort((a, b) => a - b);
    const band = depth.length >= 6 ? [depth[Math.floor(depth.length / 3)], depth[Math.floor((depth.length * 2) / 3)]] : [0.4, 0.9];
    const label = new Int32Array(cols * rows).fill(-1);
    const blobs: (Blob & { id: number })[] = [];
    const stack: number[] = [];
    for (let i = 0; i < cols * rows; i++) {
      if (label[i] >= 0 || !isSub(i)) continue;
      const blob = { id: i, area: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
      stack.push(i);
      label[i] = i;
      while (stack.length) {
        const j = stack.pop()!;
        const x = j % cols;
        const y = (j - x) / cols;
        blob.area++;
        blob.x0 = Math.min(blob.x0, x);
        blob.x1 = Math.max(blob.x1, x);
        blob.y0 = Math.min(blob.y0, y);
        blob.y1 = Math.max(blob.y1, y);
        const next = [x > 0 ? j - 1 : -1, x < cols - 1 ? j + 1 : -1, y > 0 ? j - cols : -1, y < rows - 1 ? j + cols : -1];
        for (const k of next) {
          if (k < 0 || label[k] >= 0 || !isSub(k)) continue;
          label[k] = i;
          stack.push(k);
        }
      }
      if (blob.area >= 3) blobs.push(blob);
    }
    blobs.sort((a, b) => b.area - a.area || a.x0 - b.x0 || a.y0 - b.y0);
    // a box round the whole of a big blob says nothing: box its top instead (the head of a figure, the
    // crest of a hill), a square no wider than a third of the frame, centred on the blob's highest row
    const most = Math.max(3, Math.round(Math.min(cols, rows) * 0.34));
    const top = blobs.slice(0, 3).map((bl) => {
      const tall = bl.y1 - bl.y0 + 1;
      const wide = bl.x1 - bl.x0 + 1;
      if (tall <= most && wide <= most) return bl;
      const side = Math.min(most, Math.max(tall, wide));
      let lo = 1e9;
      let hi = -1;
      for (let x = bl.x0; x <= bl.x1; x++) {
        if (label[bl.y1 * cols + x] !== bl.id) continue;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      const mid = Math.round((lo + hi) / 2);
      const x0 = Math.max(0, Math.min(cols - side, mid - Math.floor(side / 2)));
      const y1 = Math.min(rows - 1, bl.y1);
      return { ...bl, x0, x1: x0 + side - 1, y0: Math.max(0, y1 - side + 1), y1 };
    });

    const s = strictFor(f.scheme, f.palette, f.colour);
    const u = this.material.uniforms;
    // the coarse pixels are this frame's grid; the cut, the boxes and captions come from the last read
    u.tCoarse.value = rt.texture;
    (u.uGrid.value as THREE.Vector2).set(curCols, curRows);
    (u.uCoarseSize.value as THREE.Vector2).set(rt.width, rt.height);
    (u.uOff.value as THREE.Vector2).copy(curOff);
    u.uPx.value = curPx;
    u.uCut.value = cut;
    u.uPol.value = pol;
    u.uSpan.value = span;
    (u.uBand.value as THREE.Vector2).set(band[0], Math.max(band[0] + 1e-3, band[1]));
    u.uSeed.value = (f.layout % 977) * 0.53;
    u.uBeatN.value = beatN;
    u.uGrain.value = f.colour === 'flat' ? 0 : 0.07;
    // grey paper, leaning very slightly to the scheme's paper; the subject in one colour
    const paper = new THREE.Color(f.scheme.paper);
    (u.uField.value as THREE.Color).setRGB(0.66, 0.66, 0.67).lerp(paper.multiplyScalar(0.7), 0.15);
    (u.uAccent.value as THREE.Color).copy(f.colour === 'clean' ? s.b : s.a);
    (u.uLine.value as THREE.Color).copy(f.colour === 'clean' ? s.c : new THREE.Color(f.scheme.ink).lerp(s.b, 0.6));

    const L = this.lines;
    L.clear();
    const cap = Math.max(9, Math.round(short * 0.026));
    const ink = new THREE.Color(f.scheme.ink);
    top.forEach((bl, i) => {
      // the box sits on the coarse grid, a hair outside the blob's pixels (y counts up from the bottom)
      const x0 = off.x + bl.x0 * px - 2;
      const x1 = off.x + (bl.x1 + 1) * px + 2;
      const y0 = off.y + bl.y0 * px - 2;
      const y1 = off.y + (bl.y1 + 1) * px + 2;
      this.boxes[i].set(x0, y0, x1, y1);
      L.add(String(i + 1), x0 - cap * 0.8, y1 - cap * 0.4, cap, ink);
    });
    u.uBoxes.value = top.length;
    // captions: true things about the song, beside the first two boxes
    const bar = barOf(f);
    const captions = [f.labels.part, f.labels.tempo, `BAR ${String(bar).padStart(3, '0')}`];
    top.slice(0, 2).forEach((bl, i) => {
      const right = off.x + (bl.x1 + 1) * px + cap * 0.6;
      const left = off.x + bl.x0 * px - cap * 0.6;
      const text = captions[(i + Math.floor(unit(f.layout, 3) * 3)) % captions.length];
      const width = text.length * cap * 0.62;
      const x = right + width < w - cap ? right : Math.max(cap, left - width);
      L.add(text, x, off.y + (bl.y1 + 1) * px - cap * 1.1, cap, ink);
    });
    // the stamp across the top: the song, the time, the bar
    const m = Math.round(short * 0.035);
    const stamp = Math.max(10, Math.round(short * 0.03));
    const title = (f.labels.title || 'HUM').slice(0, 16);
    const time = clock(f.t, true);
    L.add(title, m, h - m - stamp, stamp, ink);
    L.add(time, Math.round(w / 2 - (time.length * stamp * 0.62) / 2), h - m - stamp, stamp, ink);
    const no = String(bar).padStart(3, '0');
    L.add(no, w - m - no.length * stamp * 0.62, h - m - stamp, stamp, ink);
    L.commit();
    u.uLines.value = L.count;
  }

  dispose() {
    this.coarse.dispose();
    this.material.dispose();
    this.rt?.dispose();
    this.lines.texture.dispose();
  }
}
