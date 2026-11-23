/**
 * Sort: pixel sorting (reference: a landscape smeared into long streaks of its own colours, in
 * stepped diagonal bands).
 *
 * The rule: the frame is read in strips along one direction. A strip is cut into segments whose ends
 * step across the frame from band to band (the staircase), and inside a segment every run of pixels
 * whose brightness falls in the threshold is sorted: sixteen samples of the run are put in order of
 * brightness and spread back along it, so the run becomes a streak from its darkest colour to its
 * brightest. Some bands smear instead (the run takes the colour it starts on). Pixels outside the
 * threshold stay as they are, so the picture's shapes hold.
 *
 * The run length follows loudness and jumps on every kick; the direction, the threshold and which
 * bands are thick come from the arrangement.
 */
import * as THREE from 'three';
import { HEAD_GLSL, TAIL_GLSL, headUniforms, hitsBefore, makeMaterial, unit, type TreatFrame } from './common';

const FRAG = /* glsl */ `
${HEAD_GLSL}
${TAIL_GLSL}
uniform vec2 uDir;
uniform float uLen, uStep, uBand, uSeed, uDesc, uSmear;
uniform vec2 uThr;

float lumAt(vec2 p) { return luma(bed(p / uRes).rgb); }
bool inRun(vec2 p) {
  vec4 c = bed(p / uRes);
  float l = luma(c.rgb);
  return c.a > 0.5 && l >= uThr.x && l <= uThr.y;
}

void main() {
  vec2 px = vUv * uRes;
  vec4 b = bed(vUv);
  vec2 d = uDir;
  vec2 n = vec2(-d.y, d.x);
  vec2 c = uRes * 0.5;
  float u = dot(px - c, d);
  float v = dot(px - c, n);

  // bands across the strips: each is thin streaks (1 px), fine (3 px) or chunky blocks (8 px)
  float band = floor(v / uBand);
  float hb = hash1(band * 1.7 + uSeed);
  float th = hb < 0.3 ? 8.0 : hb < 0.62 ? 3.0 : 1.0;
  float vs = (floor(v / th) + 0.5) * th;
  // every pixel of a strip reads the strip's middle line, so a chunky band sorts as blocks
  vec2 o = c + n * vs;

  if (!inRun(o + d * u)) { gl_FragColor = finish(b.rgb, b); return; }

  // the segment this pixel is in: its ends step across the frame band by band (the staircase)
  float L = uLen * (0.55 + 0.9 * hash1(band * 3.1 + uSeed * 1.3));
  float shift = band * uStep + hash1(band + 0.5) * L * 0.25;
  float seg = floor((u + shift) / L);
  float a0 = seg * L - shift;
  float a1 = a0 + L;

  // march out to the ends of the run (inside the segment)
  float st = max(1.0, L / 28.0);
  float rs = u;
  float re = u;
  for (int i = 0; i < 28; i++) {
    float x = rs - st;
    if (x < a0 || !inRun(o + d * x)) break;
    rs = x;
  }
  for (int i = 0; i < 28; i++) {
    float x = re + st;
    if (x > a1 || !inRun(o + d * x)) break;
    re = x;
  }
  float len = re - rs;
  if (len < 3.0) { gl_FragColor = finish(b.rgb, b); return; }
  float pos = clamp((u - rs) / len, 0.0, 1.0);

  vec3 col;
  if (hash1(band * 5.3 + seg * 0.37 + uSeed) < uSmear) {
    // a smear: the run drags the colour it starts on, fading a little toward its end
    vec3 head = bed((o + d * rs) / uRes).rgb;
    vec3 here = bed((o + d * u) / uRes).rgb;
    col = mix(head, here, pos * pos * 0.35);
  } else {
    // sixteen samples of the run, put in order of brightness
    vec4 s[16];
    for (int i = 0; i < 16; i++) {
      vec3 cc = bed((o + d * (rs + len * (float(i) + 0.5) / 16.0)) / uRes).rgb;
      s[i] = vec4(cc, luma(cc));
    }
    for (int i = 1; i < 16; i++) {
      vec4 key = s[i];
      int j = i - 1;
      for (int k = 0; k < 16; k++) {
        if (j < 0) break;
        bool after = uDesc > 0.5 ? s[j].a < key.a : s[j].a > key.a;
        if (!after) break;
        s[j + 1] = s[j];
        j--;
      }
      s[j + 1] = key;
    }
    float f = pos * 15.0;
    int i0 = int(floor(f));
    int i1 = min(15, i0 + 1);
    vec3 lo = s[0].rgb;
    vec3 hi = s[0].rgb;
    for (int i = 0; i < 16; i++) {
      if (i == i0) lo = s[i].rgb;
      if (i == i1) hi = s[i].rgb;
    }
    col = mix(lo, hi, fract(f));
  }
  gl_FragColor = finish(col, b);
}
`;

/** the directions a sort can run, by arrangement: across, down, and two diagonals */
const DIRS = [0, 0, Math.PI / 2, Math.PI / 7, -Math.PI / 7, Math.PI / 4];

export class Sort {
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = makeMaterial(FRAG, {
      ...headUniforms(),
      uDir: { value: new THREE.Vector2(1, 0) },
      uLen: { value: 200 },
      uStep: { value: 40 },
      uBand: { value: 36 },
      uSeed: { value: 0 },
      uDesc: { value: 1 },
      uSmear: { value: 0.3 },
      uThr: { value: new THREE.Vector2(0.3, 1) },
    });
  }

  update(f: TreatFrame, w: number, h: number) {
    const u = this.material.uniforms;
    const r = (k: number) => unit(f.layout, k, 31);
    const ang = DIRS[Math.floor(r(1) * DIRS.length)];
    (u.uDir.value as THREE.Vector2).set(Math.cos(ang), Math.sin(ang));
    const short = Math.min(w, h);
    const kick = hitsBefore(f.kicks, f.t, f.shotStart).since;
    // loud parts run long; every kick throws the runs out further for a moment
    const len = short * (0.16 + 0.5 * f.loud) * (1 + 1.1 * Math.exp(-kick / 0.14)) * (1 + 0.6 * Math.max(0, f.speed - 1) / 2.4);
    u.uLen.value = len;
    u.uBand.value = Math.round(short * (0.035 + r(2) * 0.04));
    u.uStep.value = (r(3) < 0.5 ? -1 : 1) * short * (0.03 + r(4) * 0.05);
    u.uSeed.value = (f.layout % 991) * 0.37;
    u.uDesc.value = r(5) < 0.5 ? 1 : 0;
    u.uSmear.value = 0.15 + r(6) * 0.3;
    // which pixels sort: the brights, the mids or all but the darkest, against the picture's own range
    const [c0, c1] = f.scheme.cuts;
    const pick = Math.floor(r(7) * 3);
    if (pick === 0) (u.uThr.value as THREE.Vector2).set(c0 * 0.9, 1);
    else if (pick === 1) (u.uThr.value as THREE.Vector2).set(c0 * 0.5, c1 + (1 - c1) * 0.6);
    else (u.uThr.value as THREE.Vector2).set(c0 * 0.35, 1);
  }

  dispose() {
    this.material.dispose();
  }
}
