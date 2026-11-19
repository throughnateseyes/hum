import * as THREE from 'three';
import type { Feel } from '../core/feel';
import type { FinishId } from '../core/direction';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createFullscreenQuad } from '../core/sceneHelpers';
import type { AudioFrame, ResolvedPalette } from '../core/types';

/**
 * Finishes: one shared surface over the finished picture (after the look, its effects, the transition
 * and the impact pass; before pop-ups, scene windows and lyrics). A video picks one in its Direction
 * (core/direction.ts), so every look in it is shot on the same stock.
 *
 *   film   16mm: grain that lives, a gate that weaves (more in gusts), red-orange halation round the
 *          highlights, a flicker on kicks, a print-stock tone curve, soft vignette, dust and the odd scratch
 *   riso   a risograph print: the picture separated into two or three palette inks, grain-dithered,
 *          never perfectly solid, each ink out of register (it jumps on snares), on toothy paper
 *   ink    sumi ink wash on rice paper: a few soft washes, darker where they pool at the edges, bleeding
 *          along the fibres; pale tones are left as bare paper. Calm on purpose
 *   tape   VHS: soft luma with the VCR's sharpening ring, colour smeared late and sideways, lines that
 *          jitter on hits, a tracking roll on the drop, head-switching noise along the bottom
 *
 * Each takes its paper and inks from the palette on screen, so it agrees with Song colours. Time comes
 * only from the frame context (never the wall clock), so a frame-by-frame render looks the same as
 * playback. 'clean' and 'hand' aren't drawn here: clean draws nothing, hand is `HandPass`.
 */

export interface FinishContext {
  /** seconds, from the frame context */
  time: number;
  dt: number;
  audio: AudioFrame;
  feel: Feel;
  palette: ResolvedPalette;
  width: number;
  height: number;
}

type GpuFinish = 'film' | 'riso' | 'ink' | 'tape';
export const isGpuFinish = (id: FinishId): id is GpuFinish => id === 'film' || id === 'riso' || id === 'ink' || id === 'tape';

const HEAD = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform sampler2D uNoise;
uniform vec2 uRes;
uniform float uTime;
uniform float uKick, uSnare, uDrop, uBuild;
uniform float uIntensity, uTension, uRelease, uWarmth, uGust;
uniform vec2 uWind;
uniform vec3 uPaper, uInkA, uInkB, uInkC;

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
/* the shared noise texture: 1 unit = 1 texel, smooth between texels, repeats every 256 */
vec4 nz(vec2 p){ return texture2D(uNoise, (p + 0.5) / 256.0); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/* ───────────────────────── film ───────────────────────── */
const FILM = /* glsl */ `
uniform float uGate;
vec3 finish(){
  float s = uRes.y / 1080.0;
  vec2 fc = gl_FragCoord.xy;
  float fr = floor(uTime * 24.0);                  // film frames: grain, weave and dirt change 24 times a second
  float ft = fr / 24.0;

  // gate weave: the film wanders in the gate (mostly up and down, from the claw), a fresh position
  // each frame; gusts of the shared wind push it further, along the wind
  vec2 wv = (nz(vec2(ft * 2.7, 17.0)).rg - 0.5) * 2.0;
  wv += (vec2(h21(vec2(fr, 1.3)), h21(vec2(fr, 7.1))) - 0.5) * 0.45;
  vec2 weave = vec2(wv.x * 0.55, wv.y) * (1.0 + 2.2 * uGust) * s;
  weave += uWind * uGust * (nz(vec2(ft * 1.1, 41.0)).b - 0.5) * 5.0 * s;
  vec2 uv = vUv + weave / uRes;
  vec3 c = texture2D(tMap, uv).rgb;

  // halation and diffusion from one jittered spiral of taps: highlights bleed a red-orange glow into
  // what's around them (light scattering back through the film base), and nothing is razor sharp
  float a0 = h21(fc * 0.731 + fract(fr * 0.137) * 61.0) * 6.2832;
  vec3 soft = vec3(0.0);
  vec3 halo = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float a = a0 + fi * 2.39996;
    float rr = (2.0 + 22.0 * sqrt((fi + 0.5) / 8.0)) * s;
    vec3 sm = texture2D(tMap, uv + vec2(cos(a), sin(a)) * rr / uRes).rgb;
    soft += sm * step(fi, 2.5);
    halo += sm * smoothstep(0.5, 0.95, lum(sm));
  }
  soft *= 0.3333;
  halo *= 0.125;
  c = mix(c, soft, 0.16);
  float hl = lum(halo);
  c += uInkB * hl * (0.55 + 0.3 * uRelease) * (1.0 - smoothstep(0.45, 0.9, lum(c)));

  // exposure: the projector lamp breathes a little, and kicks flicker it
  float flick = 1.0 + (h21(vec2(fr, 3.7)) - 0.5) * 0.03 + uKick * 0.05 * (0.5 + h21(vec2(fr, 9.1)));
  c *= flick;

  // print stock: a gentle S, highlights that roll off instead of clipping, blacks lifted into the
  // palette's shadow colour, highlights a touch warm
  c = max(c, 0.0);
  float L0 = max(lum(c), 1e-4);
  float Ls = mix(L0, L0 * L0 * (3.0 - 2.0 * L0), 0.3);
  if (Ls > 0.72) Ls = 0.72 + 0.3 * (1.0 - exp(-(Ls - 0.72) / 0.3));
  c *= Ls / L0;
  c = mix(c, vec3(lum(c)), smoothstep(0.65, 1.0, L0) * 0.3);
  c = uInkA + c * (1.0 - uInkA);
  c *= mix(vec3(1.0), uInkC, smoothstep(0.45, 1.0, lum(c)) * 0.5);

  // grain: two sizes of clumps plus a little colour in the dye clouds, strongest in the mid-tones,
  // a new pattern every film frame
  vec2 go = vec2(h21(vec2(fr, 11.0)), h21(vec2(fr, 23.0))) * 256.0;
  float gs = max(1.0, 1.2 * s);
  float g1 = nz(fc / gs + go).r - 0.5;
  float g2 = nz(fc / (gs * 2.4) + go.yx).b - 0.5;
  vec3 gc = nz(fc / gs + go.yx + 91.0).gba - 0.5;
  float L = lum(c);
  float amt = 0.13 * (0.3 + 2.8 * L * (1.0 - L)) * (0.9 + 0.2 * uIntensity);
  c += (g1 * 0.75 + g2 * 0.6) * amt + gc * amt * 0.3;

  // soft vignette
  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= 1.0 - smoothstep(0.25, 1.1, length(q * vec2(0.8, 1.0))) * 0.24;

  // dust on the print: a few dark specks and hairs, each for one frame
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = vec2(h21(vec2(fr, 41.0 + fi)), h21(vec2(fr, 53.0 + fi))) * uRes;
    float ang = h21(vec2(fr, 79.0 + fi)) * 6.2832;
    vec2 dd = fc - p;
    dd = vec2(cos(ang) * dd.x - sin(ang) * dd.y, sin(ang) * dd.x + cos(ang) * dd.y);
    dd.x /= 1.0 + 5.0 * step(0.65, h21(vec2(fr, 83.0 + fi)));
    float rr = (1.0 + 2.6 * h21(vec2(fr, 67.0 + fi))) * s;
    float speck = 1.0 - smoothstep(rr * 0.5, rr, length(dd));
    c = mix(c, uInkA * 0.6, speck * step(0.62, h21(vec2(fr, 31.0 + fi))) * 0.8);
  }
  // now and then a faint scratch that runs for a moment
  float sk = floor(uTime * 1.3);
  if (h21(vec2(sk, 5.0)) > 0.72) {
    float x = h21(vec2(sk, 9.0)) * uRes.x + (h21(vec2(fr, 2.0)) - 0.5) * 2.5 * s;
    float ln = 1.0 - smoothstep(0.3 * s, 1.2 * s, abs(fc.x - x));
    ln *= smoothstep(0.35, 0.7, nz(vec2(x * 0.1, fc.y / (50.0 * s) + fr * 5.0)).r);
    c += ln * 0.09;
  }

  // the gate: rounded corners, fixed while the picture weaves inside them
  vec2 hp = abs(vUv - 0.5) * uRes;
  float rad = 0.05 * uRes.y;
  vec2 d = hp - (uRes * 0.5 - 1.5 * s - rad);
  float sd = length(max(d, 0.0)) - rad + (nz(fc * 0.2).r - 0.5) * 2.0 * s;
  c = mix(c, uInkA * 0.35, smoothstep(-2.0 * s, 1.5 * s, sd) * uGate);
  return c;
}`;

/* ───────────────────────── riso ───────────────────────── */
const RISO = /* glsl */ `
uniform mat3 uSep;
uniform vec2 uReg0, uReg1, uReg2;
uniform float uKeyAbs;
vec3 absorb(vec3 c){ return -log(clamp(c, 0.012, 1.0) / uPaper); }
/* how much of each ink this spot of the picture needs (least squares in ink-density space); nothing
   is darker than the key ink, so the darks print as the key alone rather than every ink stacked */
vec3 coverAt(vec2 uv){
  vec3 D = absorb(texture2D(tMap, uv).rgb);
  float dl = dot(max(D, 0.0), vec3(0.2126, 0.7152, 0.0722));
  D *= min(1.0, uKeyAbs / max(dl, 1e-3));
  vec3 k = uSep * D;
  return clamp(k, 0.0, 1.0);
}
float tooth(vec2 fc, float s){
  return nz(fc / (vec2(2.0, 7.0) * s)).r * 0.45 + nz(fc / (16.0 * s) + 31.0).g * 0.55;
}
vec3 layer(vec3 col, vec3 ink, float cov, float k, vec2 fc, vec2 go, float s, float paper){
  // ink can't hold the faintest dots, and never prints perfectly solid
  cov = clamp((cov - 0.04) / 0.92, 0.0, 1.0);
  // grain: a dither threshold spread evenly over 0..1 (so coverage is honest) and nudged by a
  // smoother noise so the grain clumps; a new pattern for every print
  float gs = max(1.0, 1.1 * s);
  float th = fract(h21(floor(fc / gs) + go + k * 71.0) + nz(fc / (gs * 3.0) + go.yx + k * 29.0).a * 0.8);
  float on = smoothstep(th - 0.16, th + 0.16, cov * 1.06);
  // the drum skips the paper's high points where the ink is thin
  on *= 1.0 - smoothstep(0.7, 0.84, paper) * (1.0 - cov * 0.7);
  // riso ink is translucent and never quite even: solids are a little light and blotchy
  float mottle = nz(fc / (24.0 * s) + go * 0.3 + k * 17.0).b * 0.6 + nz(fc / (90.0 * s) + k * 5.0).g * 0.4;
  float dens = 0.86 + 0.12 * mottle;
  return col * mix(vec3(1.0), ink / uPaper, on * dens);
}
vec3 finish(){
  float s = uRes.y / 1080.0;
  vec2 fc = gl_FragCoord.xy;
  float fr = floor(uTime * 12.0);                  // a new print 12 times a second
  vec2 go = vec2(h21(vec2(fr, 3.0)), h21(vec2(fr, 5.0))) * 256.0;
  float paper = tooth(fc, s);
  vec3 col = uPaper * (1.0 - (paper - 0.5) * 0.06);
  float ca = coverAt(vUv + uReg0 / uRes).x;
  float cb = coverAt(vUv + uReg1 / uRes).y;
  float cc = coverAt(vUv + uReg2 / uRes).z;
  col = layer(col, uInkA, ca, 0.0, fc, go, s, paper);
  col = layer(col, uInkB, cb, 1.0, fc, go, s, paper);
  col = layer(col, uInkC, cc, 2.0, fc, go, s, paper);
  return col;
}`;

/* ───────────────────────── ink wash ───────────────────────── */
const INK = /* glsl */ `
uniform float uZero, uFull;
vec3 finish(){
  float s = uRes.y / 1080.0;
  vec2 fc = gl_FragCoord.xy;
  float t = uTime;
  // wet paper: the wash creeps along the fibres; a drop wets it more and the ink spreads, then dries
  float wet = (1.0 + 1.6 * uRelease + 1.2 * uDrop) * s;
  vec2 fib = nz(fc / (vec2(10.0, 2.6) * s) + vec2(0.0, t * 0.12)).rg - 0.5;
  vec2 wob = nz(fc / (42.0 * s) + vec2(t * 0.04, 3.0)).ba - 0.5;
  vec2 uv = vUv + (fib * 3.0 + wob * 8.0) * wet / uRes;
  vec3 pic = texture2D(tMap, uv).rgb;
  float v = lum(pic);
  float vb = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0472 + 0.4;
    float rr = (i < 3 ? 6.0 : 16.0) * s * (1.0 + 0.6 * uRelease);
    vb += lum(texture2D(tMap, uv + vec2(cos(a), sin(a)) * rr / uRes).rgb);
  }
  vb /= 6.0;
  // the look's background is the bare paper and what it draws with is the ink, whichever way round
  // that is (dark on light, or light on dark): density runs from the palette's background brightness
  // (uZero) to its drawing colour's (uFull)
  float d = clamp((v - uZero) / (uFull - uZero), 0.0, 1.2);
  float db = clamp((vb - uZero) / (uFull - uZero), 0.0, 1.2);
  // spacious: faint tones stay bare paper, the rest settles into three soft washes
  float w = smoothstep(0.1, 0.95, mix(d, db, 0.6));
  float x = w * 3.0;
  float washes = (floor(x) + smoothstep(0.25, 0.75, fract(x))) / 3.0;
  float dens = pow(mix(w, washes, 0.75), 1.5);
  // pigment pools where a wash meets dry paper, so every shape has a darker rim
  dens += clamp((d - db) * 2.4, 0.0, 1.0) * 0.45 * step(0.02, w);
  // granulation: pigment settles into the paper's valleys
  float grainP = nz(fc / (1.8 * s)).r * 0.45 + nz(fc / (6.0 * s) + 13.0).g * 0.55;
  dens *= 0.8 + 0.4 * grainP;
  dens *= 0.88 + 0.22 * uIntensity;
  // ink and colour: where the look is vivid the wash takes its colour (watered down) instead of sumi
  float sat = max(max(pic.r, pic.g), pic.b) - min(min(pic.r, pic.g), pic.b);
  float vivid = smoothstep(0.18, 0.6, sat);
  vec3 absInk = -log(clamp(uInkA / uPaper, 0.02, 1.0));
  vec3 absCol = -log(clamp(mix(pic, uPaper, 0.2) / uPaper, 0.02, 1.0));
  vec3 col = uPaper * (1.0 - (nz(fc / (vec2(3.0, 14.0) * s) + 7.0).b - 0.5) * 0.05);
  col *= exp(-(absInk * dens * (1.0 - 0.7 * vivid) + absCol * min(dens, 1.0) * vivid * 0.9));
  return col;
}`;

/* ───────────────────────── tape ───────────────────────── */
const TAPE = /* glsl */ `
uniform float uRoll, uRollY;
vec3 rgb2yiq(vec3 c){ return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 yiq2rgb(vec3 c){ return vec3(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z); }
vec3 finish(){
  float s = uRes.y / 1080.0;
  vec2 fc = gl_FragCoord.xy;
  float fr = floor(uTime * 30.0);
  float y = vUv.y;
  float line = floor((1.0 - y) * 486.0);
  // every line wavers a little; hits shake them
  float jit = nz(vec2(line * 0.43, fr * 1.7)).r - 0.5;
  float shake = 0.8 + 3.5 * uKick + 5.0 * uSnare + 8.0 * smoothstep(0.6, 1.0, uDrop);
  float dx = jit * 2.0 * shake * s + sin(y * 9.0 + uTime * 1.7) * 0.7 * s;
  // tracking roll on the drop: a band of torn, noisy lines sweeps down the picture
  float band = exp(-pow((y - uRollY) / 0.04, 2.0)) * uRoll;
  float tail = smoothstep(uRollY - 0.0, uRollY + 0.18, y) * (1.0 - step(uRollY + 0.18, y)) * uRoll;
  dx += band * (nz(vec2(line * 1.3, fr * 3.1)).g - 0.3) * 70.0 * s + tail * 6.0 * s;
  // head switching: the bottom few lines tear off to the right
  float hs = 1.0 - smoothstep(0.0, 0.028, y);
  dx += hs * (14.0 + 16.0 * nz(vec2(line * 2.0, fr)).b) * s;
  vec2 uv = vec2(vUv.x - dx / uRes.x, y);
  // luma: VHS only resolves about 240 lines across, so it's soft sideways; then the VCR's sharpening
  // leaves a bright and dark ring after every edge
  vec2 px = vec2(2.6 * s / uRes.x, 0.0);
  vec3 c0 = texture2D(tMap, uv).rgb;
  vec3 c1 = texture2D(tMap, uv - px).rgb;
  vec3 c2 = texture2D(tMap, uv + px).rgb;
  vec3 c3 = texture2D(tMap, uv - px * 2.6).rgb;
  vec3 W = vec3(0.299, 0.587, 0.114);
  float Y = dot(c0 * 0.4 + (c1 + c2) * 0.3, W);
  Y += (Y - dot(c3, W)) * 0.22;
  // colour: far lower resolution still, smeared sideways and arriving late
  vec2 cs = vec2(5.0 * s / uRes.x, 0.0);
  vec3 ch = (c1 * 0.5 + texture2D(tMap, uv - cs * 1.5).rgb + texture2D(tMap, uv - cs * 2.8).rgb + texture2D(tMap, uv - cs * 4.2).rgb * 0.8 + texture2D(tMap, uv - cs * 5.8).rgb * 0.5) / 3.8;
  vec3 iq = rgb2yiq(ch);
  iq.yz *= 0.9;
  iq.yz += (vec2(nz(vec2(line * 0.9, fr * 2.3)).r, nz(vec2(line * 0.7, fr * 1.9 + 50.0)).g) - 0.5) * 0.045;
  vec3 c = yiq2rgb(vec3(Y, iq.yz));
  // snow, heavier in the roll and the head switch
  float sn = h21(fc + fract(fr * 0.618) * 97.0) - 0.5;
  c += sn * (0.045 + band * 0.5 + hs * 0.25);
  // dropouts: short bright streaks where the oxide is worn
  float dl = h21(vec2(line, fr));
  if (dl > 0.9965) {
    float x0 = h21(vec2(line, fr + 1.0));
    float len = 0.015 + 0.06 * h21(vec2(line, fr + 2.0));
    float on = step(x0, vUv.x) * step(vUv.x, x0 + len);
    c = mix(c, uPaper, on * 0.75);
  }
  // tape never reaches true black: blacks lift into the palette's shadow colour
  c = uInkA + max(c, 0.0) * (1.0 - uInkA);
  // the faintest scanline texture
  c *= 1.0 - 0.035 * step(0.5, fract(fc.y / max(2.0, 3.0 * s)));
  return c;
}`;

const SRC: Record<GpuFinish, string> = { film: FILM, riso: RISO, ink: INK, tape: TAPE };
const FRAG = (body: string) => `${HEAD}${body}
uniform float uAmt;
void main(){
  vec3 base = texture2D(tMap, vUv).rgb;
  gl_FragColor = vec4(clamp(mix(base, finish(), uAmt), 0.0, 1.0), 1.0);
}`;

/* ───────────────────────── colours from the palette ───────────────────────── */

const lumOf = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const satOf = (c: THREE.Color) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
const OFF_WHITE = new THREE.Color(0.95, 0.93, 0.88);
const tmp = new THREE.Color();

function palColors(p: ResolvedPalette): THREE.Color[] {
  return [p.c.bg, p.c.fg, p.c.accent, p.c.accent2, p.c.muted];
}
/** paper: the palette's lightest colour, mostly bleached to an off-white */
function paperOf(p: ResolvedPalette, out: THREE.Color, keep = 0.3) {
  const lightest = palColors(p).reduce((a, b) => (lumOf(b) > lumOf(a) ? b : a));
  return out.copy(OFF_WHITE).lerp(lightest, lumOf(lightest) > 0.55 ? keep : keep * 0.4);
}
function darkestOf(p: ResolvedPalette) {
  return palColors(p).reduce((a, b) => (lumOf(b) < lumOf(a) ? b : a));
}
/** push a colour away from grey, like a pure printing ink */
function inky(c: THREE.Color, out: THREE.Color, k = 0.25) {
  const l = lumOf(c);
  out.setRGB(l + (c.r - l) * (1 + k), l + (c.g - l) * (1 + k), l + (c.b - l) * (1 + k));
  out.r = Math.min(1, Math.max(0.02, out.r));
  out.g = Math.min(1, Math.max(0.02, out.g));
  out.b = Math.min(1, Math.max(0.02, out.b));
  return out;
}
const dist = (a: THREE.Color, b: THREE.Color) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/* small deterministic random, so a render is the same every time */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class FinishPass {
  private mats = new Map<GpuFinish, THREE.ShaderMaterial>();
  private quad = createFullscreenQuad(new THREE.MeshBasicMaterial());
  /** per-frame state: kept here so it advances once per frame whatever draws it */
  private st = { t: Number.NaN, snare: 0, drop: 0, jumps: 0, zero: -1, full: -1, rollT: 99, reg: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] };
  private sep = new THREE.Matrix3();
  private ink = { paper: new THREE.Color(), a: new THREE.Color(), b: new THREE.Color(), c: new THREE.Color() };
  private sepKey = '';
  private keyAbs = 3;

  constructor(private noise: THREE.Texture) {
    this.jump(0);
  }

  private mat(id: GpuFinish): THREE.ShaderMaterial {
    let m = this.mats.get(id);
    if (m) return m;
    m = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: null },
        uNoise: { value: this.noise },
        uRes: { value: new THREE.Vector2(2, 2) },
        uTime: { value: 0 },
        uAmt: { value: 1 },
        uKick: { value: 0 },
        uSnare: { value: 0 },
        uDrop: { value: 0 },
        uBuild: { value: 0 },
        uIntensity: { value: 0 },
        uTension: { value: 0 },
        uRelease: { value: 0 },
        uWarmth: { value: 0.5 },
        uGust: { value: 0 },
        uWind: { value: new THREE.Vector2(1, 0) },
        uPaper: { value: new THREE.Color() },
        uInkA: { value: new THREE.Color() },
        uInkB: { value: new THREE.Color() },
        uInkC: { value: new THREE.Color() },
        uGate: { value: 0.6 },
        uSep: { value: new THREE.Matrix3() },
        uReg0: { value: new THREE.Vector2() },
        uReg1: { value: new THREE.Vector2() },
        uReg2: { value: new THREE.Vector2() },
        uZero: { value: 1 },
        uFull: { value: 0 },
        uRoll: { value: 0 },
        uRollY: { value: 2 },
        uKeyAbs: { value: 3 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG(SRC[id]),
      depthTest: false,
      depthWrite: false,
    });
    this.mats.set(id, m);
    return m;
  }

  /** new registration for every riso ink (a fresh pass through the printer) */
  private jump(n: number) {
    const [r0, r1, r2] = this.st.reg;
    const a = (k: number) => hash(n * 3.17 + k) * Math.PI * 2;
    const m = (k: number, lo: number, hi: number) => lo + (hi - lo) * hash(n * 5.31 + k + 40);
    r0.set(Math.cos(a(1)), Math.sin(a(1))).multiplyScalar(m(1, 0.3, 1.2));
    r1.set(Math.cos(a(2)), Math.sin(a(2))).multiplyScalar(m(2, 1.5, 4.5));
    r2.set(Math.cos(a(3)), Math.sin(a(3))).multiplyScalar(m(3, 1.5, 4.0));
  }

  /** step the finish's own state to this frame (once per frame, however many times it is drawn) */
  advance(o: FinishContext) {
    const st = this.st;
    if (o.time === st.t) return;
    const dt = Number.isNaN(st.t) ? 0 : Math.max(0, Math.min(0.25, o.dt));
    st.t = o.time;
    const a = o.audio;
    // riso: a new registration on each snare hit
    if (a.snare > 0.7 && st.snare <= 0.55) this.jump(++st.jumps);
    // tape: a tracking roll starts when a drop lands
    if (a.drop - st.drop > 0.25 && a.drop > 0.5) st.rollT = 0;
    else st.rollT += dt;
    st.snare = a.snare;
    st.drop = a.drop;
    // ink wash: paper is the palette's background brightness, full ink its drawing colour's (or the
    // colour that stands out most from the background), eased so a cut doesn't flash
    const p = o.palette;
    const zero = lumOf(p.c.bg);
    let full = lumOf(p.c.fg);
    if (Math.abs(full - zero) < 0.25) full = palColors(p).map(lumOf).reduce((x, y) => (Math.abs(y - zero) > Math.abs(x - zero) ? y : x));
    if (Math.abs(full - zero) < 0.25) full = zero > 0.5 ? zero - 0.4 : zero + 0.4;
    const k = st.zero < 0 ? 1 : Math.min(1, dt * 2.5);
    st.zero += (zero - st.zero) * k;
    st.full += (full - st.full) * k;
  }

  /**
   * Draw `input` through finish `id` into `target`. Returns false (and draws nothing) for finishes
   * that aren't drawn here ('clean', 'hand'), so the caller draws the picture as it is.
   */
  render(r: THREE.WebGLRenderer, input: THREE.Texture, target: THREE.WebGLRenderTarget | null, id: FinishId, o: FinishContext, amount = 1): boolean {
    if (!isGpuFinish(id)) return false;
    this.advance(o);
    const m = this.mat(id);
    const u = m.uniforms;
    const a = o.audio;
    const f = o.feel;
    u.tMap.value = input;
    u.uRes.value.set(o.width, o.height);
    u.uTime.value = o.time;
    u.uAmt.value = amount;
    u.uKick.value = a.kick;
    u.uSnare.value = a.snare;
    u.uDrop.value = a.drop;
    u.uBuild.value = a.build;
    u.uIntensity.value = f.intensity;
    u.uTension.value = f.tension;
    u.uRelease.value = f.release;
    u.uWarmth.value = f.warmth;
    u.uGust.value = f.gust;
    u.uWind.value.set(f.windX, f.windY);
    this.colours(id, o.palette, f.warmth, u);
    if (id === 'riso') {
      u.uSep.value.copy(this.sep);
      u.uKeyAbs.value = this.keyAbs;
      const s = o.height / 1080;
      u.uReg0.value.copy(this.st.reg[0]).multiplyScalar(s);
      u.uReg1.value.copy(this.st.reg[1]).multiplyScalar(s);
      u.uReg2.value.copy(this.st.reg[2]).multiplyScalar(s);
    } else if (id === 'ink') {
      u.uZero.value = this.st.zero;
      u.uFull.value = this.st.full;
    } else if (id === 'tape') {
      const t = this.st.rollT;
      u.uRoll.value = t > 2 ? 0 : Math.min(1, t / 0.12) * (1 - Math.min(1, Math.max(0, (t - 0.9) / 0.5)));
      u.uRollY.value = 1.12 - t * 0.85;
    }
    this.quad.mesh.material = m;
    this.quad.render(r, target);
    return true;
  }

  /** paper and inks for this finish, from the palette on screen */
  private colours(id: GpuFinish, p: ResolvedPalette, warmth: number, u: Record<string, THREE.IUniform>) {
    const { paper, a, b, c } = this.ink;
    // the riso inks are cached by palette; any other finish writes over them
    if (id !== 'riso') this.sepKey = '';
    if (id === 'film') {
      // shadows: the palette's darkest colour, very dark; halation: red-orange leaning to the warmest colour
      const dk = darkestOf(p);
      a.copy(dk).multiplyScalar(0.5).lerp(tmp.setRGB(0.02, 0.018, 0.024), 0.5);
      a.r = Math.max(a.r, 0.012);
      a.g = Math.max(a.g, 0.012);
      a.b = Math.max(a.b, 0.014);
      const warm = palColors(p).reduce((x, y) => (y.r - y.b + satOf(y) * 0.3 > x.r - x.b + satOf(x) * 0.3 ? y : x));
      b.setRGB(1.0, 0.3, 0.1).lerp(warm, 0.3);
      // highlight tint of the print: a little warm, warmer when the song is
      c.setRGB(1.0 + 0.03 + 0.03 * warmth, 1.0, 0.97 - 0.05 * warmth);
      paper.copy(paperOf(p, paper));
      // the gate's dark corners only read on dark looks; on light ones they'd look stuck on
      u.uGate.value = 0.55 * Math.max(0, 1 - lumOf(p.c.bg) * 1.6);
    } else if (id === 'riso') {
      this.risoInks(p);
    } else if (id === 'ink') {
      paperOf(p, paper, 0.25);
      // sumi: the darkest palette colour taken nearly to black, keeping its hue
      const dk = darkestOf(p);
      a.copy(dk).multiplyScalar(0.45).lerp(tmp.setRGB(0.06, 0.06, 0.07), 0.45);
      // the colour wash: the most vivid palette colour, lightened like a watercolour
      const viv = palColors(p).reduce((x, y) => (satOf(y) > satOf(x) ? y : x));
      b.copy(viv).lerp(paper, 0.25);
    } else {
      // tape: lifted blacks in the palette's darkest colour; dropouts in its lightest
      const dk = darkestOf(p);
      a.copy(dk).multiplyScalar(0.25).add(tmp.setRGB(0.03, 0.03, 0.035));
      paperOf(p, paper, 0.6);
    }
    (u.uPaper.value as THREE.Color).copy(paper);
    (u.uInkA.value as THREE.Color).copy(a);
    (u.uInkB.value as THREE.Color).copy(b);
    (u.uInkC.value as THREE.Color).copy(c);
  }

  /**
   * Riso inks: an off-white paper, then up to three inks from the palette. The key ink is its most
   * vivid dark colour (navy, deep green, red, blue), since riso is about colour, or its darkest when it
   * has none; then the two most vivid others, pushed purer like riso drums. An ink that would print
   * almost the same as one already chosen is skipped, so a palette with one strong colour prints in
   * two. The separation matrix solves, per pixel, how much of each ink is needed in density space
   * (ridge-regularised least squares), worked out here once per palette.
   */
  private risoInks(p: ResolvedPalette) {
    const { paper, a, b, c } = this.ink;
    const key = `${p.bg}${p.fg}${p.accent}${p.accent2}${p.muted}`;
    if (key === this.sepKey) return;
    this.sepKey = key;
    paperOf(p, paper, 0.12);
    const cols = palColors(p);
    const darks = cols.filter((x) => lumOf(x) > 0.06 && lumOf(x) < 0.42 && satOf(x) > 0.15);
    const dk = darks.sort((x, y) => satOf(y) * (1 - lumOf(y)) - satOf(x) * (1 - lumOf(x)))[0] ?? darkestOf(p);
    a.copy(dk);
    if (lumOf(a) > 0.3) a.multiplyScalar(0.3 / Math.max(0.05, lumOf(a)));
    // density of an ink against the paper, per channel
    const dens = (ink: THREE.Color) =>
      [0, 1, 2].map((i) => -Math.log(Math.min(1, Math.max(0.012, [ink.r, ink.g, ink.b][i]) / Math.max(0.05, [paper.r, paper.g, paper.b][i]))));
    const cos = (x: number[], y: number[]) => dot(x, y) / Math.max(1e-6, Math.sqrt(dot(x, x) * dot(y, y)));
    const rest = cols.filter((x) => x !== dk && lumOf(x) > 0.08 && dist(x, paper) > 0.18).sort((x, y) => satOf(y) - satOf(x));
    const chosen = [dens(a)];
    const pick = (out: THREE.Color, k: number) => {
      for (const x of rest) {
        const d = dens(inky(x, tmp, k));
        if (chosen.every((y) => cos(d, y) < 0.965)) {
          out.copy(tmp);
          chosen.push(d);
          return true;
        }
      }
      return false;
    };
    if (!pick(b, 0.25)) inky(rest[0] ?? cols[2], b);
    if (!pick(c, 0.15)) c.copy(paper);
    const K = [dens(a), dens(b), dens(c)]; // K[j][i]: ink j, channel i
    this.keyAbs = Math.max(0.3, dot(K[0], [0.2126, 0.7152, 0.0722]));
    // P = (KᵀK + λI)⁻¹ Kᵀ
    const lam = 0.02;
    const G = new THREE.Matrix3().set(
      dot(K[0], K[0]) + lam, dot(K[0], K[1]), dot(K[0], K[2]),
      dot(K[1], K[0]), dot(K[1], K[1]) + lam, dot(K[1], K[2]),
      dot(K[2], K[0]), dot(K[2], K[1]), dot(K[2], K[2]) + lam,
    );
    G.invert();
    const Kt = new THREE.Matrix3().set(K[0][0], K[0][1], K[0][2], K[1][0], K[1][1], K[1][2], K[2][0], K[2][1], K[2][2]);
    this.sep.multiplyMatrices(G, Kt);
  }

  dispose() {
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.quad.dispose();
  }
}

const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
