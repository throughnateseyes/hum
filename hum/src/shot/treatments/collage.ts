/**
 * Collage: one big picture with fragments of the part's other pictures layered over it (reference: a
 * huge eye with cut-out photos, flat colour patches and rings over it, edges torn).
 *
 * The rule: the frame's grid is dealt a set of fragments once a bar, from the arrangement: cut-out
 * rectangles of the other pictures (some with a white border, like a print), shapes cut from them by
 * brightness with torn edges, flat patches of the shot's colours and the odd ring. They overlap on
 * purpose and crowd the edges; the middle round the focus point is kept for the big picture, which
 * stays the one clear thing. Two fragments are there when the bar starts and one more lands on each
 * kick, with a small jolt.
 *
 * With one picture only, the fragments are details of it at other crops.
 */
import * as THREE from 'three';
import { HEAD_GLSL, TAIL_GLSL, headUniforms, makeMaterial, strictFor, unit, type TreatFrame } from './common';

export const MAX_FRAGS = 16;
/** fragments already down when a bar starts; one more lands on each kick */
const AT_BAR = 6;

const FRAG = /* glsl */ `
${HEAD_GLSL}
${TAIL_GLSL}
uniform sampler2D tM1, tM2, tM3;
uniform vec3 uMA;
uniform vec4 uRect[${MAX_FRAGS}];
uniform vec4 uKind[${MAX_FRAGS}];
uniform vec4 uTint[${MAX_FRAGS}];
uniform float uFrags, uAspect;

vec3 media(float src, vec2 uv) {
  uv = clamp(uv, 0.002, 0.998);
  if (src < 0.5) return bed(uv).rgb;
  if (src < 1.5) return texture2D(tM1, uv).rgb;
  if (src < 2.5) return texture2D(tM2, uv).rgb;
  return texture2D(tM3, uv).rgb;
}
float aspectOf(float src) { return src < 0.5 ? uAspect : src < 1.5 ? uMA.x : src < 2.5 ? uMA.y : uMA.z; }

void main() {
  vec4 b = bed(vUv);
  vec3 col = b.rgb;
  vec2 px = vUv * uRes;
  for (int i = 0; i < ${MAX_FRAGS}; i++) {
    if (float(i) >= uFrags) break;
    vec4 r = uRect[i];   // x0, y0, x1, y1 in uv
    vec4 k = uKind[i];   // kind, source, zoom, seed
    vec4 t = uTint[i];   // colour, and how far it has landed (0..1)
    if (t.a <= 0.0) continue;
    // landing: it drops in a little large and settles
    vec2 mid = (r.xy + r.zw) * 0.5;
    vec2 p = mid + (vUv - mid) * (1.0 + 0.08 * (1.0 - t.a));
    // a torn edge: the box's border wanders by a few pixels of noise
    float tear = (vnoise(px * 0.09 + k.w * 13.0) - 0.5) * 9.0 + (vnoise(px * 0.4 + k.w) - 0.5) * 3.0;
    vec2 e = tear / uRes;
    bool inside = p.x > r.x + e.x && p.x < r.z - e.x && p.y > r.y + e.y && p.y < r.w - e.y;
    if (!inside) continue;
    vec2 local = (p - r.xy) / (r.zw - r.xy);
    float boxAspect = (r.z - r.x) / (r.w - r.y) * uAspect;
    // the picture cropped to fill the fragment, pushed in by its zoom, off centre by its seed
    vec2 q = local - 0.5;
    float fa = aspectOf(k.y);
    if (boxAspect > fa) q.y *= fa / boxAspect; else q.x *= boxAspect / fa;
    vec2 shift = (vec2(hash1(k.w), hash1(k.w + 3.1)) - 0.5) * (1.0 - 1.0 / k.z);
    vec2 uv = 0.5 + q / k.z + shift;
    if (k.x < 0.5) {
      // a print: the picture inside a thin white border
      float border = 5.0 / min((r.z - r.x) * uRes.x, (r.w - r.y) * uRes.y);
      bool edge = local.x < border * (r.w - r.y) / (r.z - r.x) * uRes.y / uRes.x || local.x > 1.0 - border * (r.w - r.y) / (r.z - r.x) * uRes.y / uRes.x || local.y < border || local.y > 1.0 - border;
      col = (edge && t.r > 1.5) ? vec3(0.96) : media(k.y, uv);
    } else if (k.x < 1.5) {
      // a cut-out: only the picture's light (or dark) parts, so its edge is torn by the threshold
      vec3 c = media(k.y, uv);
      float l = luma(c) + (vnoise(px * 0.5) - 0.5) * 0.06;
      if ((t.g > 0.5) ? l > t.b : l < t.b) col = c;
    } else if (k.x < 2.5) {
      // a flat patch of colour
      col = t.rgb;
    } else if (k.x > 3.5) {
      // a slice: a band of the big picture slid sideways, like a torn strip laid back crooked
      col = bed(vec2(vUv.x + (hash1(k.w) - 0.5) * 0.3, vUv.y)).rgb;
    } else {
      // a ring
      vec2 rq = (local - 0.5) * vec2(boxAspect, 1.0);
      float rr = length(rq) / (0.5 * min(boxAspect, 1.0));
      if (rr > 0.62 && rr < 0.98) col = t.rgb;
    }
  }
  gl_FragColor = finish(col, b);
}
`;

export interface CollagePicture {
  texture: THREE.Texture;
  aspect: number;
}

interface Frag {
  rect: [number, number, number, number];
  kind: number;
  src: number;
  zoom: number;
  seed: number;
  tint: [number, number, number, number];
}

export class Collage {
  readonly material: THREE.ShaderMaterial;
  private readonly rect = Array.from({ length: MAX_FRAGS }, () => new THREE.Vector4());
  private readonly kind = Array.from({ length: MAX_FRAGS }, () => new THREE.Vector4());
  private readonly tint = Array.from({ length: MAX_FRAGS }, () => new THREE.Vector4());
  private dealt: { key: string; frags: Frag[] } | null = null;

  constructor() {
    this.material = makeMaterial(FRAG, {
      ...headUniforms(),
      tM1: { value: null },
      tM2: { value: null },
      tM3: { value: null },
      uMA: { value: new THREE.Vector3(1, 1, 1) },
      uRect: { value: this.rect },
      uKind: { value: this.kind },
      uTint: { value: this.tint },
      uFrags: { value: 0 },
      uAspect: { value: 1 },
    });
  }

  /** the bar's fragments, dealt on the frame's grid from the arrangement */
  private deal(f: TreatFrame, w: number, h: number, bar: number, pictures: number): Frag[] {
    const key = `${f.layout}|${bar}|${pictures}|${w}x${h}|${f.focus.x.toFixed(2)},${f.focus.y.toFixed(2)}`;
    if (this.dealt?.key === key) return this.dealt.frags;
    const r = (k: number) => unit(f.layout, bar, k);
    const portrait = h > w;
    const cols = portrait ? 4 : 8;
    const rows = portrait ? 7 : 4;
    const m = 0.04;
    const cw = (1 - 2 * m) / cols;
    const rh = (1 - 2 * m) / rows;
    // the keep: a box round the focus point the big picture keeps clear
    const kx = f.focus.x;
    const ky = f.focus.y;
    const kw = portrait ? 0.24 : 0.16;
    const kh = portrait ? 0.14 : 0.22;
    const cover = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, Math.min(x1, kx + kw) - Math.max(x0, kx - kw)) * Math.max(0, Math.min(y1, ky + kh) - Math.max(y0, ky - kh));
    const frags: Frag[] = [];
    const s = f.scheme;
    const st = strictFor(s, f.palette, f.colour);
    const rgb = (c: THREE.Color): [number, number, number] => [c.r, c.g, c.b];
    const flats = [rgb(st.a), rgb(st.b), rgb(st.white), rgb(st.a), rgb(st.c), rgb(new THREE.Color(s.ink))];
    const n = MAX_FRAGS - Math.floor(r(1) * 3);
    for (let i = 0; i < n && frags.length < MAX_FRAGS; i++) {
      // big pieces first (they go underneath), then middling ones, then small patches, rings and strips
      const big = i < 4;
      let fw = big ? 2 + Math.floor(r(10 + i) * (portrait ? 2 : 3)) : 1 + Math.floor(r(10 + i) * 2);
      let fh = big ? 2 + Math.floor(r(30 + i) * (portrait ? 3 : 2)) : 1 + Math.floor(r(30 + i) * 2);
      const kind = r(50 + i);
      if (i % 3 === 2) fw = fh = 1;
      let cx = Math.floor(r(70 + i) * (cols - fw + 1));
      let cy = Math.floor(r(90 + i) * (rows - fh + 1));
      // half a module of offset now and then, so the edges do not all line up
      const nudgeX = r(110 + i) < 0.4 ? cw * 0.5 : 0;
      const nudgeY = r(130 + i) < 0.4 ? rh * 0.5 : 0;
      let x0 = m + cx * cw + nudgeX;
      let y0 = m + cy * rh + nudgeY;
      let x1 = x0 + fw * cw;
      let y1 = y0 + fh * rh;
      // a big fragment over the keep is pushed out to the nearer side
      if (fw * fh > 1 && cover(x0, y0, x1, y1) > kw * kh * 0.35) {
        if ((x0 + x1) / 2 < kx) {
          cx = 0;
          fw = Math.min(fw, Math.max(1, Math.floor((kx - kw - m) / cw)));
        } else {
          fw = Math.min(fw, Math.max(1, Math.floor((1 - m - (kx + kw)) / cw)));
          cx = cols - fw;
        }
        x0 = m + cx * cw;
        x1 = x0 + fw * cw;
        if (cover(x0, y0, x1, y1) > kw * kh * 0.35) {
          cy = y0 + y1 > 2 * ky ? rows - fh : 0;
          y0 = m + cy * rh;
          y1 = y0 + fh * rh;
        }
      }
      const others = Math.max(0, pictures);
      const src = others ? 1 + Math.floor(r(150 + i) * others) : 0;
      let k: number;
      if (fw * fh === 1) k = kind < 0.55 ? 2 : kind < 0.8 ? 3 : 0;
      else if (kind < 0.4) k = 0;
      else if (kind < 0.68) k = 1;
      else if (kind < 0.84) k = 2;
      else k = 4;
      // a strip runs the width of a few columns and is thin
      if (k === 4) {
        y1 = y0 + rh * 0.35;
        x1 = Math.min(1 - m, x0 + cw * (2 + Math.floor(r(260 + i) * 2)));
      }
      const colour = flats[Math.floor(r(170 + i) * flats.length)];
      frags.push({
        rect: [x0, y0, x1, y1],
        kind: k,
        src: k === 1 && !others ? 0 : src,
        zoom: src === 0 ? 1.8 + r(190 + i) * 1.6 : 1 + r(190 + i) * 0.9,
        seed: r(210 + i) * 100,
        // for prints, red > 1.5 asks for the border; for cut-outs: keep light (g 1) or dark parts, and the level
        tint: k === 0 ? [r(230 + i) < 0.55 ? 2 : 0, 0, 0, 1] : k === 1 ? [0, r(240 + i) < 0.6 ? 1 : 0, 0.35 + r(250 + i) * 0.3, 1] : [...colour, 1],
      });
    }
    this.dealt = { key, frags };
    return frags;
  }

  update(f: TreatFrame, w: number, h: number, pictures: CollagePicture[]) {
    const u = this.material.uniforms;
    u.uAspect.value = w / h;
    const ms = [u.tM1, u.tM2, u.tM3];
    const as = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const p = pictures[i % Math.max(1, pictures.length)];
      ms[i].value = p?.texture ?? null;
      as[i] = p?.aspect ?? 1;
    }
    (u.uMA.value as THREE.Vector3).set(as[0], as[1], as[2]);
    const barLen = f.beat * 4;
    const bar = Math.floor((f.t - f.partStart) / barLen + 1e-4);
    const barStart = f.partStart + bar * barLen;
    const frags = this.deal(f, w, h, bar, pictures.length);
    // a few are there from the start of the bar; one more lands on each kick
    const kicks = f.kicks.filter((k) => k >= barStart - 0.02 && k <= f.t);
    const shown = Math.min(frags.length, AT_BAR + kicks.length);
    frags.forEach((fr, i) => {
      this.rect[i].set(...fr.rect);
      this.kind[i].set(fr.kind, fr.src, fr.zoom, fr.seed);
      const landed = i < AT_BAR ? Math.min(1, (f.t - Math.max(barStart, f.shotStart)) / 0.08) : i < shown ? Math.min(1, (f.t - kicks[i - AT_BAR]) / 0.08) : 0;
      this.tint[i].set(fr.tint[0], fr.tint[1], fr.tint[2], i < shown ? Math.max(0.001, landed) : 0);
    });
    u.uFrags.value = frags.length;
  }

  dispose() {
    this.material.dispose();
  }
}
