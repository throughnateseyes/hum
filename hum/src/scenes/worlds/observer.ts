import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { buildSceneFragment, createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef, SceneInstance } from '../../core/types';
import { createBaseUniforms, num, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import { useStudio } from '../../state/store';
import { HM_LIB } from '../shader/lib';
import { approach, stepDt } from '../three/common';
import { currentLyric, dropEdge, songInfo } from '../three/songInfo';

/**
 * Observer — a screen full of old program windows that look back at you. The frame is tiled and
 * stacked with little grey windows (thin title bars, 1px bevels, tiny buttons) of many sizes, and
 * inside them there are only two things: a huge human eye in extreme close-up, tinted like an
 * over-saturated webcam, and a blue sky full of fat cumulus clouds. One sky carries the sung words in
 * soft glowing capitals. The feeling is dreamy unease: tenderness under surveillance, being watched
 * by your own screen.
 *
 * The windows are the rhythm section. A kick opens a new window (every other kick when it is quiet),
 * a snare starts a cascade (one window repeated down and across, a step per 16th), the oldest close on
 * the beat when there are more open than the part wants. Intensity sets how many: two or three big
 * calm skies in the intro, wall to wall and mostly eyes in the chorus. Every eye follows the window
 * that just opened; pupils open with the bass and tighten on bright loud moments, lids blink on
 * phrase starts and some snares, hats put four-point sparkles in the skies. Tension multiplies and
 * shrinks the windows toward the middle while every eye turns to stare straight out at you and the
 * pupils narrow. The drop is a CRT switching off and on: the picture squeezes to a bright line and a
 * dot, then snaps back with a whole new wall of windows and every pupil blown wide. A break closes
 * them one by one until a single sky is left.
 *
 * Two passes: the windows (a list kept in JS, sent as uniform arrays, the topmost one covering each
 * pixel is drawn), then a screen pass for the crunchy screen-capture finish (soft posterising, a
 * touch of chroma offset, faint scanlines) and the CRT collapse.
 *
 * Palette roles: bg = the black between windows · fg = window chrome and the glow of the words ·
 * accent = sky blue and the ice-blue eye tint · accent2 = the violet / pink eye tint ·
 * muted = title bars and cloud shadows. The darker of bg / fg is always the gap and the lighter one
 * the chrome, so it holds on a light palette too.
 */

const MAXW = 32;

const windowsFrag = /* glsl */ `
${HM_LIB}
uniform vec4 uObRect[${MAXW}];   // centre xy, half size zw (screen units: height 1, origin centre)
uniform vec4 uObA[${MAXW}];      // kind, seed, tint, crop scale
uniform vec4 uObB[${MAXW}];      // crop centre xy, pop flash, open (0..1, <1 = zoom outlines)
uniform float uObCount;
uniform float uObTop;            // index of the active (newest) window
uniform float uObTb;             // title bar height
uniform float uObBd;             // frame width
uniform vec2 uObGaze;            // the point every eye looks at
uniform float uObGazeAmt;        // 0 = all staring straight out
uniform float uObPupil;          // pupil radius as a share of the iris
uniform float uObBlink;          // seconds since the shared blink
uniform float uObHatT, uObHatN;  // seconds since a hat, hat counter
uniform float uObSat;            // tint saturation (the afterglow pushes it)
uniform float uObClock;
uniform sampler2D uObText;

vec3 gGap; vec3 gLight; vec3 gChrome; vec3 gHi; vec3 gLo; vec3 gWhite;

float obFill(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

/* ---------------- the eye ----------------
   Eye units: the socket runs x -1..1, the opening about y -0.27..0.4. g = where the iris sits
   (gaze), blink 0..1. Returns a lightness 0..1; irisM is the iris mask (for the tint). */
float obLid(float x, float h, float pw) { return h * pow(clamp(1.0 - x * x, 0.0, 1.0), pw); }

float obEye(vec2 e, vec2 g, float blink, float seed, float pupil, float aa, float squint, out float irisM) {
  float x = e.x;
  float tilt = 0.07 * x;
  float open = 1.0 - blink;
  float yL = -obLid(x, 0.27 - 0.04 * g.y + 0.03 * squint, 0.95) + tilt;
  float yU = obLid(x, 0.41 + 0.09 * g.y - 0.12 * squint, 0.72) + tilt;
  yU = mix(yL + 0.01, yU, open);
  float inX = 1.0 - smoothstep(0.96, 1.0, abs(x));
  float inside = obFill(e.y - yU, aa) * obFill(yL - e.y, aa) * inX;

  // skin: soft, a little texture, darker toward the opening, a crease over the lid
  float sk = 0.6 + 0.07 * tfbm(e * 7.0 + seed * 13.0, 3) - 0.1 * smoothstep(0.5, 1.4, length(e * vec2(0.8, 1.4)));
  float above = e.y - yU;
  float crease = obLid(x, 0.62 + 0.06 * g.y, 0.6) + tilt - 0.2 * blink;
  sk -= 0.12 * exp(-pow((e.y - crease) / 0.035, 2.0)) * inX;
  sk += 0.08 * smoothstep(0.0, 0.2, above) * (1.0 - smoothstep(0.2, 0.5, above));   // the lid catches light
  sk -= 0.16 * exp(-max(yL - e.y, 0.0) * 14.0) * step(e.y, yL);                    // under the eye

  // white of the eye: shaded toward the corners and under the upper lid
  float scl = 0.86 - 0.3 * smoothstep(0.35, 1.0, abs(x - g.x * 0.3));
  scl -= 0.05 * smoothstep(0.55, 0.9, tnoise(e * 18.0 + seed));                      // faint veins
  float lidSh = smoothstep(0.0, 0.16, yU - e.y);
  scl *= 0.62 + 0.38 * lidSh;

  // iris: radial fibres, a darker limbal ring, a pale collarette round the pupil
  float R = 0.34;
  vec2 ic = e - g;
  float r = length(ic);
  vec2 dir = ic / max(r, 1e-4);
  float fib = tnoise(dir * 13.0 + r * 2.2 + seed * 7.0) * 0.6 + tnoise(dir * 34.0 - r * 4.0 + seed) * 0.4;
  float il = 0.5 + 0.42 * (fib - 0.5) * 2.0;
  il += 0.12 * (1.0 - r / R);
  il *= 1.0 - 0.7 * smoothstep(R * 0.68, R * 0.98, r);
  float P = R * pupil;
  il += 0.2 * exp(-pow((r - P * 1.55) / (0.035 + P * 0.15), 2.0));
  il *= 0.55 + 0.45 * lidSh;
  float pm = obFill(r - P, aa * 1.2);
  il = mix(il, 0.02, pm);
  irisM = obFill(r - R, aa * 1.5) * inside;
  float ball = mix(scl, il, obFill(r - R, aa * 1.5));

  // the catchlight, upper left of the pupil, and a small second one
  vec2 cl = ic - vec2(-0.33, 0.3) * R;
  float cd = length(max(abs(cl) - vec2(0.03, 0.022), 0.0)) - 0.024;
  ball = mix(ball, 1.0, obFill(cd, aa) * 0.95);
  ball += 0.18 * exp(-dot(cl, cl) * 300.0);
  ball = mix(ball, 0.92, obFill(length(ic - vec2(0.3, -0.26) * R) - 0.018, aa) * 0.8);

  float l = mix(sk, ball, inside);

  // lash line, then the lashes themselves, curling outwards
  l *= 1.0 - 0.85 * exp(-pow((e.y - yU) / (0.022 + aa), 2.0)) * inX;
  l *= 1.0 - 0.5 * exp(-pow((e.y - yL) / (0.012 + aa), 2.0)) * inX;
  float dy = e.y - yU;
  float sx = sign(x + 1e-4);
  float xs = (x + sx * (dy * dy * 2.6 + dy * 0.35 * abs(x))) * 34.0;
  float li = floor(xs);
  float lh = hash11(li * 1.37 + seed);
  float lenU = 0.24 * (1.0 - 0.75 * x * x) * (0.5 + 0.5 * lh);
  float wU = 0.2 * (1.0 - clamp(dy / lenU, 0.0, 1.0));
  float aL = aa * 34.0 + 0.04;
  float lash = step(0.0, dy) * step(dy, lenU) * obFill(abs(fract(xs + lh * 0.3) - 0.5) - wU, aL) * step(abs(x), 0.97);
  float dl = yL - e.y;
  float xl = (x + sx * (dl * dl * 6.0 + dl * 0.8 * abs(x))) * 26.0;
  float lh2 = hash11(floor(xl) * 2.1 + seed);
  float lenL = 0.055 * (1.0 - x * x) * (0.4 + 0.6 * lh2);
  float wL = 0.09 * (1.0 - clamp(dl / max(lenL, 1e-3), 0.0, 1.0));
  lash = max(lash, 0.7 * step(0.0, dl) * step(dl, lenL) * obFill(abs(fract(xl + lh2 * 0.4) - 0.5) - wL, aa * 26.0 + 0.04) * step(abs(x), 0.85) * step(0.5, lh2));
  l = mix(l, 0.03, lash * 0.92);
  return clamp(l, 0.0, 1.0);
}

void obTints(float t, out vec3 a, out vec3 b) {
  if (t < 0.5) { a = uAccent; b = uAccent2; }
  else if (t < 1.5) { a = uAccent2; b = uAccent; }
  else if (t < 2.5) { a = mix(uAccent, uAccent2, 0.5); b = uAccent; }
  else { a = mix(uAccent, gChrome, 0.3); b = uAccent2; }
}

// webcam grade: deep tinted shadows, a saturated middle, highlights blown toward white
vec3 obRamp(float l, vec3 a, vec3 b) {
  vec3 sh = mix(gGap, b, 0.3) * 0.16;
  vec3 mid = mix(b, a, smoothstep(0.2, 0.6, l));
  vec3 hi = mix(a, gWhite, 0.75);
  return l < 0.45 ? mix(sh, mid, l / 0.45) : mix(mid, hi, (l - 0.45) / 0.55);
}

/* ---------------- the sky ----------------
   Sky units: one shared sky, y -1 (horizon) .. 1 (high); every window shows a piece of it. */
vec3 obSky(vec2 s, float aa) {
  float dusk = smoothstep(0.1, 0.26, abs(uFeelDay - 0.5));
  vec3 top = uAccent * mix(0.62, 0.42, dusk);
  vec3 hor = mix(mix(uAccent, gLight, 0.42), mix(uAccent2, gLight, 0.4), dusk * 0.75);
  vec3 col = mix(hor, top, smoothstep(-0.8, 1.0, s.y));

  // fat cumulus, drifting on the shared wind; lit from above, grey-blue underneath
  vec2 q = s * vec2(0.9, 1.35) * 1.25 - uFeelWind * uFeelWindPhase * 0.06;
  float n = tfbm(q, 5);
  float nA = tfbm(q + vec2(0.03, 0.09), 4);
  float base = 0.04 + 0.1 * s.y;
  float cl = smoothstep(base, base + 0.09, n + 0.04 * tnoise(q * 9.0));
  // lit where the cloud thins above (the tops), grey-blue in the flat bellies
  float lit = clamp(0.62 + (n - nA) * 7.0 + 0.8 * (n - base - 0.1), 0.0, 1.0);
  vec3 cc = mix(mix(uMuted, gLight, 0.35), mix(gLight, gWhite, 0.8), lit);
  cc = mix(cc, mix(uAccent2, gLight, 0.6), dusk * 0.3 * (1.0 - lit));
  col = mix(col, cc, cl);

  // four-point sparkles: a few light up on each hat, a few twinkle by themselves
  vec2 gs = s * 2.6;
  vec2 gi = floor(gs);
  vec2 gh = hash22(gi + 7.0);
  vec2 d = gs - gi - 0.2 - 0.6 * gh;
  float on = step(hash21(gi + uObHatN * 1.37), 0.32) * exp(-uObHatT * 4.0);
  float idle = pow(0.5 + 0.5 * sin(uObClock * (1.0 + gh.x) + gh.y * 40.0), 18.0) * 0.6 * step(0.5, gh.x);
  float amp = max(on, idle);
  vec2 ad = abs(d);
  float k = 0.004 / max(aa * 2.6, 0.0015);
  float star = max(exp(-ad.x * 60.0) * exp(-ad.y * 7.0), exp(-ad.y * 60.0) * exp(-ad.x * 7.0)) + exp(-dot(d, d) * 500.0);
  col = mix(col, gWhite, clamp(star * amp * min(k, 1.5), 0.0, 1.0));
  return col;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float px = 1.0 / uResolution.y;

  bool lightBg = luma(uBg) > luma(uFg);
  gGap = lightBg ? uFg : uBg;
  gLight = lightBg ? uBg : uFg;
  gChrome = mix(gLight, uMuted, 0.2);
  gWhite = mix(gLight, vec3(1.0), 0.55);
  gHi = mix(gChrome, gWhite, 0.7);
  gLo = mix(gChrome, gGap, 0.55);

  float tb = uObTb;
  float bd = uObBd;
  float shOff = max(3.0 * px, tb * 0.22);

  // find the topmost window here; on the way down note drop shadows and zoom outlines
  int hit = -1;
  float shadow = 0.0;
  float outline = 0.0;
  for (int i = ${MAXW - 1}; i >= 0; i--) {
    if (float(i) >= uObCount) continue;
    vec4 r = uObRect[i];
    vec2 lp = p - r.xy;
    float op = uObB[i].w;
    if (op < 1.0) {
      // opening / closing: three nested outlines, the old way windows zoomed
      for (int k = 0; k < 3; k++) {
        float sc = clamp(op * 1.15 - float(k) * 0.16, 0.0, 1.0);
        if (sc <= 0.02) continue;
        float sd = abs(sdBox(lp, r.zw * sc)) - px * 0.7;
        outline = max(outline, obFill(sd, px * 0.7) * (1.0 - float(k) * 0.28));
      }
      continue;
    }
    vec2 dd = abs(lp) - r.zw;
    if (max(dd.x, dd.y) < 0.0) { hit = i; break; }
    vec2 ds = abs(lp - vec2(shOff, -shOff)) - r.zw;
    if (max(ds.x, ds.y) < 0.0) shadow = 1.0;
  }

  vec3 col = gGap;
  // TV static in the gaps (off by default)
  if (u_static > 0.001) {
    float row = floor(fc.y / max(1.0, 2.0 * uResolution.y / 1080.0));
    float st = hash21(vec2(floor(fc.x / (3.0 + 9.0 * hash11(row))), row) + floor(uObClock * 24.0) * 3.1);
    vec3 sc = mix(uAccent, uAccent2, hash11(row * 1.7 + floor(uObClock * 24.0)));
    col = mix(col, mix(sc, gLight, 0.3) * 0.75, pow(st, 3.0) * u_static);
  }

  if (hit >= 0) {
    vec4 r = uObRect[hit];
    vec4 A = uObA[hit];
    vec4 B = uObB[hit];
    vec2 lp = p - r.xy;
    float kind = A.x;
    float seed = A.y;
    float edge = min(r.z - abs(lp.x), r.w - abs(lp.y));
    bool isTop = abs(float(hit) - uObTop) < 0.5;

    if (edge < bd) {
      // frame with a 1px bevel: light on the top / left, dark on the bottom / right
      col = gChrome;
      bool tl = (lp.x < 0.0 && r.z - abs(lp.x) < r.w - abs(lp.y)) || (lp.y > 0.0 && r.w - abs(lp.y) <= r.z - abs(lp.x));
      float outer = 1.0 - step(px * 1.01, edge);
      float inner = step(bd - px * 1.01, edge);
      col = mix(col, tl ? gHi : gLo * 0.7, outer);
      col = mix(col, tl ? gLo : gHi, inner * 0.8);
    } else if (lp.y > r.w - bd - tb) {
      // title bar: a soft gradient when active, flat grey behind; tiny glyphs; three buttons
      float tx = (lp.x + r.z) / (2.0 * r.z);
      vec3 tA = mix(uMuted * 0.7, mix(uMuted, uAccent, 0.55), tx);
      vec3 tI = mix(uMuted, gChrome, 0.55);
      col = isTop ? tA : tI;
      float ty = (lp.y - (r.w - bd - tb)) / tb;
      // glyphs: little 3-column pixel letters, grouped into words
      float gx = (lp.x + r.z - bd - tb * 1.1) / (tb * 0.36);
      float ci = floor(gx);
      float nC = 6.0 + floor(hash11(seed * 3.3) * 14.0);
      float space = step(hash11(ci * 1.9 + seed * 17.0), 0.18);
      float gcol = floor(fract(gx) * 4.0);
      float grow = floor(ty * 7.0);
      float bit = step(0.38, hash21(vec2(ci * 4.0 + gcol, grow) + seed * 9.0)) * step(gcol, 2.5) * step(2.0, grow) * step(grow, 4.5);
      float glyph = bit * step(0.0, gx) * step(ci, nC) * (1.0 - space);
      col = mix(col, isTop ? gHi : gLo, glyph);
      // a small icon at the left
      vec2 ip = vec2(lp.x + r.z - bd - tb * 0.55, lp.y - (r.w - bd - tb * 0.5));
      col = mix(col, isTop ? mix(uAccent, gWhite, 0.4) : gLo, obFill(sdBox(ip, vec2(tb * 0.26)), px * 0.6));
      col = mix(col, gGap, obFill(abs(sdBox(ip, vec2(tb * 0.26))) - px * 0.5, px * 0.5) * 0.6);
      // buttons at the right
      float bs = tb * 0.34;
      for (int k = 0; k < 3; k++) {
        vec2 bp = vec2(lp.x - (r.z - bd - tb * 0.55 - float(k) * tb * 0.86), lp.y - (r.w - bd - tb * 0.5));
        float bb = sdBox(bp, vec2(bs));
        if (bb < px) {
          vec3 face = gChrome;
          float be = -bb;
          bool btl = bp.x < -bp.y;
          face = mix(face, btl ? gHi : gLo * 0.7, 1.0 - step(px * 1.01, be));
          vec2 g = bp / bs;
          float mk = 0.0;
          if (k == 0) mk = obFill(min(abs(g.x - g.y), abs(g.x + g.y)) * bs - px * 0.7, px * 0.6) * step(max(abs(g.x), abs(g.y)), 0.5);
          else if (k == 1) mk = obFill(abs(sdBox(g, vec2(0.45))) * bs - px * 0.6, px * 0.6);
          else mk = obFill(sdBox(g - vec2(0.0, -0.4), vec2(0.45, 0.06)) * bs, px * 0.6);
          face = mix(face, gGap * 0.8, mk * 0.85);
          col = mix(col, face, obFill(bb, px * 0.5));
        }
      }
      col = mix(col, gHi, 0.35 * B.z);
    } else {
      // content
      vec2 cMin = vec2(-r.z + bd, -r.w + bd);
      vec2 cMax = vec2(r.z - bd, r.w - bd - tb);
      vec2 csz = cMax - cMin;
      vec2 luv = (lp - cMin) / csz;
      float cAsp = csz.x / csz.y;
      vec2 q = (luv - 0.5) * vec2(cAsp, 1.0);
      float aaU = A.w / csz.y * px * 1.2;
      if (kind < 2.5) {
        vec2 e = B.xy + q * A.w;
        // gaze: toward the shared point, as seen from this window; tension pulls it to dead centre
        vec2 dv = uObGaze - r.xy;
        vec2 g = dv / (length(dv) + 0.35) * 0.3 * uObGazeAmt;
        float sj = floor(uObClock * (0.35 + 0.3 * hash11(seed)) + seed * 5.0);
        g += (hash22(vec2(sj, seed)) - 0.5) * 0.05 * uObGazeAmt;
        if (kind > 0.5 && kind < 1.5) { e.x = -e.x; g.x = -g.x; }
        // blinks: the shared one, and each eye's own now and then
        float per = 4.0 + 5.0 * hash11(seed * 1.3);
        float own = mod(uObClock + seed * 11.0, per);
        float bt = min(uObBlink, own);
        float blink = bt < 0.16 ? sin(bt / 0.16 * PI) : 0.0;
        blink = clamp(blink * u_blink * 1.2, 0.0, 1.0);
        float irisM;
        float l = obEye(e, g, blink, seed, uObPupil, aaU, uFeelTension, irisM);
        vec3 ta; vec3 tb2;
        obTints(A.z, ta, tb2);
        if (kind > 1.5) {
          // posterised: four hard levels, the colours pushed harder
          l = floor(l * 3.999) / 3.0;
          col = obRamp(l, ta, tb2);
          col = mix(col, ta * 1.1, irisM * 0.4 * step(0.2, l));
        } else {
          col = obRamp(l, ta, tb2);
          col = mix(col, mix(ta, tb2, 0.25) * (0.5 + l), irisM * 0.35 * smoothstep(0.04, 0.12, l));
        }
        col = hmSat(col, uObSat);
      } else {
        vec2 s = B.xy + q * A.w;
        col = obSky(s, aaU);
        if (kind > 3.5) {
          // the words, in soft glowing capitals
          vec2 tuv = containUv(luv, vec2(2.0, 1.0), cAsp);
          float ok = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
          vec4 tx = texture2D(uObText, tuv) * ok;
          col = mix(col, mix(uAccent * 0.5, gGap, 0.3), 0.25);
          col *= 0.9 - 0.45 * tx.g;
          col += mix(gWhite, uAccent2, 0.15) * tx.g * tx.g * 0.35;
          col = mix(col, gWhite, tx.r);
        }
      }
      // a sunken 1px edge round the picture
      float ce = min(min(lp.x - cMin.x, cMax.x - lp.x), min(lp.y - cMin.y, cMax.y - lp.y));
      col = mix(col, gGap, (1.0 - step(px * 1.01, ce)) * 0.7);
      col = mix(col, gWhite, B.z * 0.45);
    }
  } else {
    col = mix(col, gGap * 0.5, shadow * 0.6);
  }
  col = mix(col, gHi, outline);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const screenFrag = /* glsl */ `
${HM_LIB}
uniform sampler2D tScene;
uniform vec2 uObSq;        // CRT squeeze (x, y), 1 = full picture
uniform float uObLine;     // glow of the collapsed line / dot
uniform float uObFlash;    // the switch-on flash
uniform float uObChroma;   // chroma offset in px

void main() {
  vec2 fc = gl_FragCoord.xy;
  float ps = max(1.0, uResolution.y / 1080.0);
  vec3 gap = luma(uBg) > luma(uFg) ? uFg : uBg;
  vec3 lite = luma(uBg) > luma(uFg) ? uBg : uFg;
  vec2 c = (vUv - 0.5) / max(uObSq, vec2(1e-3)) + 0.5;
  float inside = step(0.0, c.x) * step(c.x, 1.0) * step(0.0, c.y) * step(c.y, 1.0);
  vec2 off = vec2(uObChroma * ps / uResolution.x, 0.0);
  vec3 col;
  col.r = texture2D(tScene, c + off).r;
  col.g = texture2D(tScene, c).g;
  col.b = texture2D(tScene, c - off).b;
  col = mix(gap, col, inside);
  // a squeezed picture burns brighter
  col *= 1.0 + 2.5 * (1.0 - uObSq.y) * inside;
  // the collapsed line, and the last dot
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float lw = uObSq.x * uAspect * 0.5;
  float lineG = exp(-abs(p.y) * 160.0) * (1.0 - smoothstep(lw * 0.85, lw * 1.05 + 0.01, abs(p.x)));
  float dotG = exp(-length(p) * 40.0) * (1.0 - smoothstep(0.05, 0.6, uObSq.x));
  vec3 glow = mix(lite, vec3(1.0), 0.6);
  col += glow * uObLine * (lineG * 0.9 + dotG * 1.4);
  col = mix(col, glow, uObFlash * 0.55 * inside);
  // soft posterising and scanlines: a screen capture of a screen
  float lv = mix(24.0, 6.0, u_crunch);
  vec3 qz = floor(col * lv + 0.5) / lv;
  col = mix(col, qz, 0.55 * u_crunch);
  float sl = 0.5 + 0.5 * sin(fc.y / ps * PI * 0.667);
  col *= 1.0 - 0.13 * u_crunch * sl;
  col += hmGrain(fc, uTime) * (0.02 + 0.03 * u_crunch);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const params: ParamDef[] = [
  { id: 'density', label: 'Windows', group: 'Shape', type: 'number', min: 0.3, max: 1.5, step: 0.01, default: 1, hint: 'How many windows a part opens' },
  { id: 'size', label: 'Window size', group: 'Shape', type: 'number', min: 0.6, max: 1.5, step: 0.01, default: 1 },
  { id: 'eyes', label: 'Eyes vs sky', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'More eyes or more sky in the windows' },
  { id: 'cascade', label: 'Cascades', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'Snares repeat a window down and across the screen' },
  { id: 'gaze', label: 'Gaze', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'How far the eyes follow the window that just opened' },
  { id: 'blink', label: 'Blinks', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'pupil', label: 'Pupil response', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Pupils open with the bass and tighten on bright loud moments' },
  { id: 'collapse', label: 'CRT drop', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'The picture collapses to a line and a dot on the drop' },
  { id: 'crunch', label: 'Screen crunch', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Posterising, chroma offset and scanlines' },
  { id: 'static', label: 'Gap static', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0, hint: 'TV static in the black between windows' },
];

/* ───────────────────────── the window manager ───────────────────────── */

const KIND_EYE = 0;
const KIND_MIRROR = 1;
const KIND_POSTER = 2;
const KIND_SKY = 3;
const KIND_TEXT = 4;

interface Win {
  x: number;
  y: number;
  hw: number;
  hh: number;
  kind: number;
  seed: number;
  tint: number;
  crop: [number, number, number];
  born: number;
  closing: number; // -1 while open
}

interface Cascade {
  tpl: Omit<Win, 'born' | 'closing'>;
  dx: number;
  dy: number;
  left: number;
  next: number;
  step: number;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeIn = (t: number) => Math.pow(clamp(t, 0, 1), 2.2);
const easeOutBack = (t: number) => {
  const c = 1.9;
  const x = clamp(t, 0, 1) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};

const OPEN_T = 0.13;
const CLOSE_T = 0.11;

/* ───────────────────────── the words ───────────────────────── */

const TEXT_W = 1024;
const TEXT_H = 512;
const TEXT_FONT = `'Inter Variable', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif`;

interface Word {
  t: string;
  sung: boolean;
}

/** what the word window says now: the sung line (words not yet sung held back), or song facts */
function wordsNow(frame: FrameContext, mem: { lastLine: string; lastEnd: number }): { key: string; words: Word[] } {
  const t = frame.audio.time;
  const cur = currentLyric(t);
  if (cur) {
    let upto = 99;
    try {
      const ln = useStudio.getState().lyrics?.lines[cur.i];
      if (ln?.words?.length) {
        upto = -1;
        for (let k = 0; k < ln.words.length; k++) if (ln.words[k].t <= t + 0.05) upto = k;
      }
    } catch {
      /* no word timings */
    }
    mem.lastLine = cur.text;
    mem.lastEnd = t;
    const ws = cur.text.toUpperCase().split(/\s+/).filter(Boolean);
    const words = ws.map((w, k) => ({ t: w, sung: k <= upto }));
    return { key: `${cur.i}:${Math.min(upto, ws.length)}`, words };
  }
  if (mem.lastLine && t - mem.lastEnd < 3 && t >= mem.lastEnd) {
    const words = mem.lastLine.toUpperCase().split(/\s+/).filter(Boolean).map((w) => ({ t: w, sung: true }));
    return { key: `last:${mem.lastLine}`, words };
  }
  const info = songInfo();
  const sec = frame.feel.section ?? frame.analysis?.character?.mood ?? '';
  const lines = [info.title, info.artist, sec ? `· ${sec} ·` : ''].filter(Boolean).join(' / ');
  const words = lines.toUpperCase().split(/\s+/).filter(Boolean).map((w) => ({ t: w, sung: true }));
  return { key: `info:${lines}`, words };
}

function drawWords(ctx: CanvasRenderingContext2D, words: Word[]) {
  // opaque black, so the channels hold real values (a transparent canvas un-premultiplies the glow to full)
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TEXT_W, TEXT_H);
  if (!words.length) return;
  // explicit breaks ('/') from the fallback, otherwise wrap into at most three lines
  const maxW = TEXT_W * 0.84;
  let size = 112;
  let lines: Word[][] = [];
  const setFont = (s: number) => {
    ctx.font = `600 ${s}px ${TEXT_FONT}`;
    try {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(s * 0.06).toFixed(1)}px`;
    } catch {
      /* older canvas */
    }
  };
  for (; size >= 28; size -= 6) {
    setFont(size);
    lines = [[]];
    let w = 0;
    const space = ctx.measureText(' ').width;
    for (const wd of words) {
      if (wd.t === '/') {
        if (lines[lines.length - 1].length) lines.push([]);
        w = 0;
        continue;
      }
      const ww = ctx.measureText(wd.t).width;
      if (w > 0 && w + space + ww > maxW) {
        lines.push([]);
        w = 0;
      }
      lines[lines.length - 1].push(wd);
      w += (w > 0 ? space : 0) + ww;
    }
    lines = lines.filter((l) => l.length);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l.map((x) => x.t).join(' ')).width));
    if (lines.length <= 3 && widest <= maxW && lines.length * size * 1.18 <= TEXT_H * 0.8) break;
  }
  const lh = size * 1.18;
  const y0 = TEXT_H / 2 - ((lines.length - 1) * lh) / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const space = ctx.measureText(' ').width;
  // red channel = the crisp letters, green = a wide soft glow
  for (const pass of [0, 1]) {
    ctx.shadowColor = pass === 0 ? 'rgba(0,255,0,1)' : 'rgba(0,0,0,0)';
    ctx.shadowBlur = pass === 0 ? size * 0.55 : 0;
    lines.forEach((ln, li) => {
      const total = ctx.measureText(ln.map((x) => x.t).join(' ')).width;
      let x = (TEXT_W - total) / 2;
      for (const wd of ln) {
        const a = wd.sung ? 1 : 0.42;
        ctx.fillStyle = pass === 0 ? `rgba(0,255,0,${a})` : `rgba(255,0,0,${a})`;
        ctx.globalCompositeOperation = pass === 0 ? 'source-over' : 'lighter';
        ctx.fillText(wd.t, x, y0 + li * lh);
        x += ctx.measureText(wd.t).width + space;
      }
    });
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
}

/* ───────────────────────── the scene ───────────────────────── */

function create(init: { shared: FrameContext['shared'] }): SceneInstance {
  const shared = init.shared;
  const rects = Array.from({ length: MAXW }, () => new THREE.Vector4());
  const as = Array.from({ length: MAXW }, () => new THREE.Vector4());
  const bs = Array.from({ length: MAXW }, () => new THREE.Vector4());

  const canvas = document.createElement('canvas');
  canvas.width = TEXT_W;
  canvas.height = TEXT_H;
  const tctx = canvas.getContext('2d')!;
  const textTex = new THREE.CanvasTexture(canvas);
  textTex.colorSpace = THREE.NoColorSpace;
  textTex.minFilter = THREE.LinearFilter;
  textTex.generateMipmaps = false;

  const wu = {
    ...createBaseUniforms(shared, params),
    uObRect: { value: rects },
    uObA: { value: as },
    uObB: { value: bs },
    uObCount: { value: 0 },
    uObTop: { value: 0 },
    uObTb: { value: 0.03 },
    uObBd: { value: 0.004 },
    uObGaze: { value: new THREE.Vector2() },
    uObGazeAmt: { value: 1 },
    uObPupil: { value: 0.42 },
    uObBlink: { value: 9 },
    uObHatT: { value: 9 },
    uObHatN: { value: 0 },
    uObSat: { value: 1 },
    uObClock: { value: 0 },
    uObText: { value: textTex },
  };
  const wMat = new THREE.ShaderMaterial({
    uniforms: wu,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildSceneFragment(windowsFrag, params),
    depthTest: false,
    depthWrite: false,
  });
  const su = {
    ...createBaseUniforms(shared, params),
    tScene: { value: null as THREE.Texture | null },
    uObSq: { value: new THREE.Vector2(1, 1) },
    uObLine: { value: 0 },
    uObFlash: { value: 0 },
    uObChroma: { value: 1 },
  };
  const sMat = new THREE.ShaderMaterial({
    uniforms: su,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildSceneFragment(screenFrag, params),
    depthTest: false,
    depthWrite: false,
  });
  const wQuad = createFullscreenQuad(wMat);
  const sQuad = createFullscreenQuad(sMat);
  let rt: THREE.WebGLRenderTarget | null = null;

  const rng = mulberry(0x0b5e4ee);
  let wins: Win[] = [];
  let cascade: Cascade | null = null;
  let clock = 0;
  let aspect = 0;
  let started = false;
  let kicks = 0;
  let snares = 0;
  let lastKick = -99;
  let beatAcc = 0;
  let beatN = 0;
  let lastOpen = -99;
  let blinkAt = -9;
  let hatAt = -9;
  let hatN = 0;
  let gx = 0;
  let gy = 0;
  let tgx = 0;
  let tgy = 0;
  let pupil = 0.42;
  let textKey = '';
  let textLine = -2;
  let infoAt = -99;
  const textMem = { lastLine: '', lastEnd: -99 };
  // CRT: 0 idle, 1 switching off, 2 switching on
  let crt = 0;
  let crtAt = 0;
  let crtDur = 0.3;
  let lastDropAt = -99;
  let lastSince = 99;
  const dropHit = dropEdge();

  const short = () => Math.min(aspect, 1);
  const titleH = (h: number) => Math.max(0.024 * short(), 13 / Math.max(1, h));

  function crop(kind: number): [number, number, number] {
    if (kind === KIND_SKY || kind === KIND_TEXT) return [(rng() * 2 - 1) * 3, -0.1 + rng() * 0.7, 0.9 + rng() * 0.9];
    const r = rng();
    if (r < 0.4) return [(rng() - 0.5) * 0.25, (rng() - 0.5) * 0.15, 0.55 + rng() * 0.3]; // the iris, huge
    if (r < 0.8) return [(rng() - 0.5) * 0.2, 0.05 + rng() * 0.1, 1.0 + rng() * 0.6]; // the whole eye
    return [(rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.25), 0.05, 0.8 + rng() * 0.3]; // off to one side
  }

  function pickKind(f: FrameContext): number {
    const eyes = num(f.params, 'eyes', 0.55);
    const share = clamp(0.2 + 0.65 * f.feel.intensity + (eyes - 0.55) * 0.9 + 0.2 * f.feel.tension, 0.04, 0.96);
    if (rng() >= share) return KIND_SKY;
    const v = rng();
    return v < 0.16 ? KIND_POSTER : v < 0.32 ? KIND_MIRROR : KIND_EYE;
  }

  function makeWin(kind: number, x: number, y: number, hw: number, hh: number): Win {
    return { x, y, hw, hh, kind, seed: Math.floor(rng() * 997) + rng(), tint: Math.floor(rng() * 4), crop: crop(kind), born: clock, closing: -1 };
  }

  /** window half sizes for the part we are in: big and calm when quiet, smaller and many when full */
  function sizeFor(f: FrameContext, kind: number): [number, number] {
    const S = short();
    const it = f.feel.intensity;
    const sz = num(f.params, 'size', 1);
    let w = S * (0.8 - 0.26 * it) * (0.72 + rng() * 0.56) * sz * (1 - 0.5 * f.feel.tension);
    const ars = [4 / 3, 3 / 2, 1, 16 / 9, 5 / 4, 4 / 5];
    let ar = kind === KIND_TEXT ? 2 : ars[Math.floor(rng() * ars.length)];
    if (kind !== KIND_TEXT && aspect < 0.8 && rng() < 0.5) ar = 1 / ar;
    if (kind === KIND_TEXT) w = Math.max(w, S * (0.62 + 0.12 * rng()) * sz * (1 - 0.4 * f.feel.tension));
    w = Math.min(w, aspect * 0.94);
    const tb = titleH(f.height);
    let hh = (w / ar + tb) / 2;
    if (hh > 0.46) {
      hh = 0.46;
      w = (hh * 2 - tb) * ar;
    }
    return [w / 2, hh];
  }

  function place(f: FrameContext, hw: number, hh: number, inset = 0.75): [number, number] {
    const pull = 1 - 0.75 * f.feel.tension;
    const open = wins.filter((w) => w.closing < 0);
    const recent = open.slice(-5);
    let best: [number, number] = [0, 0];
    let bestS = -1e9;
    for (let k = 0; k < 10; k++) {
      const x = (rng() * 2 - 1) * Math.max(0, aspect / 2 - hw * inset) * pull;
      const y = (rng() * 2 - 1) * Math.max(0, 0.5 - hh * inset) * pull;
      let d = 1;
      for (const w of recent) d = Math.min(d, Math.hypot(w.x - x, w.y - y));
      // prefer black: how many windows already cover the middle and corners of this spot
      let cov = 0;
      for (const w of open) {
        for (const [ox, oy] of [[0, 0], [-0.6, 0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, -0.6]]) {
          if (Math.abs(x + ox * hw - w.x) < w.hw && Math.abs(y + oy * hh - w.y) < w.hh) cov += ox === 0 ? 2 : 1;
        }
      }
      const s = d * 0.6 - cov * 0.12 * (1 - f.feel.tension) + rng() * 0.12;
      if (s > bestS) {
        bestS = s;
        best = [x, y];
      }
    }
    return best;
  }

  function push(w: Win) {
    wins.push(w);
    while (wins.length > MAXW) {
      // too many: drop the oldest that is not the word window
      const i = wins.findIndex((x) => x.kind !== KIND_TEXT);
      wins.splice(i >= 0 ? i : 0, 1);
    }
    // the word window stays on top, so the line being sung can be read
    const ti = wins.findIndex((x) => x.kind === KIND_TEXT && x.closing < 0);
    if (ti >= 0 && ti < wins.length - 1) wins.push(wins.splice(ti, 1)[0]);
  }

  function openOne(f: FrameContext, kind = pickKind(f)) {
    const [hw, hh] = sizeFor(f, kind);
    // the words always fit on screen; the others may run off the edge like a messy desktop
    const [x, y] = place(f, hw, hh, kind === KIND_TEXT ? 1.04 : 0.75);
    const w = makeWin(kind, x, y, hw, hh);
    push(w);
    lastOpen = clock;
    tgx = x;
    tgy = y;
    return w;
  }

  function openText(f: FrameContext) {
    for (const w of wins) if (w.kind === KIND_TEXT && w.closing < 0) w.closing = clock;
    openOne(f, KIND_TEXT);
  }

  function startCascade(f: FrameContext) {
    const amt = num(f.params, 'cascade', 0.8);
    const n = Math.round((6 + Math.floor(rng() * 3)) * amt);
    if (n < 2) return;
    const S = short();
    const kind = rng() < 0.72 ? (rng() < 0.2 ? KIND_MIRROR : KIND_EYE) : KIND_SKY;
    const sz = num(f.params, 'size', 1);
    const w = S * (0.24 + rng() * 0.14) * sz * (1 - 0.35 * f.feel.tension);
    const tb = titleH(f.height);
    const hw = w / 2;
    const hh = (w / (4 / 3) + tb) / 2;
    const st = tb * 1.35;
    const span = st * (n - 1);
    const pull = 1 - 0.6 * f.feel.tension;
    const xr = Math.max(0, aspect - 2 * hw - span);
    const yr = Math.max(0, 1 - 2 * hh - span);
    const x0 = (-aspect / 2 + hw + rng() * xr) * pull;
    const y0 = (0.5 - hh - rng() * yr) * pull;
    const base = makeWin(kind, x0, y0, hw, hh);
    const bps = f.audio.bpm > 0 ? f.audio.bpm / 60 : 2;
    cascade = { tpl: base, dx: st, dy: -st, left: n, next: clock, step: 1 / (bps * 4) };
  }

  /** a whole new wall: split the frame into cells (any aspect), one window per cell, a few overlapping */
  function newLayout(f: FrameContext, n: number) {
    for (const w of wins) if (w.closing < 0) w.closing = clock;
    wins = wins.filter((w) => clock - w.closing < CLOSE_T);
    const S = short();
    const tb = titleH(f.height);
    const cells: [number, number, number, number][] = [[-aspect / 2, -0.5, aspect / 2, 0.5]];
    while (cells.length < n) {
      let bi = 0;
      let ba = 0;
      cells.forEach((c, i) => {
        const a = (c[2] - c[0]) * (c[3] - c[1]) * (0.7 + 0.6 * rng());
        if (a > ba) {
          ba = a;
          bi = i;
        }
      });
      const c = cells.splice(bi, 1)[0];
      const t = 0.36 + rng() * 0.28;
      if (c[2] - c[0] > c[3] - c[1]) {
        const m = c[0] + (c[2] - c[0]) * t;
        cells.push([c[0], c[1], m, c[3]], [m, c[1], c[2], c[3]]);
      } else {
        const m = c[1] + (c[3] - c[1]) * t;
        cells.push([c[0], c[1], c[2], m], [c[0], m, c[2], c[3]]);
      }
    }
    // shuffle so the stacking order is not the split order
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const quiet = n <= 4;
    for (const c of cells) {
      const gap = S * (quiet ? 0.05 + rng() * 0.05 : 0.006 + rng() * 0.02);
      const grow = !quiet && rng() < 0.35 ? S * (0.02 + rng() * 0.06) : 0;
      let hw = Math.max(tb * 2, (c[2] - c[0]) / 2 - gap + grow);
      let hh = Math.max(tb * 2, (c[3] - c[1]) / 2 - gap + grow);
      // no slivers: keep every window between a tall 1:2 and a wide 2.4:1
      hw = Math.min(hw, hh * 2.4);
      hh = Math.min(hh, hw * 2);
      const x = (c[0] + c[2]) / 2 + (rng() - 0.5) * gap;
      const y = (c[1] + c[3]) / 2 + (rng() - 0.5) * gap;
      const w = makeWin(pickKind(f), x, y, hw, hh);
      w.born = clock - rng() * 0.05;
      push(w);
    }
    openText(f);
    lastOpen = clock;
  }

  let thinning = false;
  function closeOldest() {
    const open = wins.filter((w) => w.closing < 0);
    if (open.length <= 1) return;
    // eyes go first when it is thinning out, so a quiet part ends on sky
    const old = (thinning ? open.find((w) => w.kind < KIND_SKY) : undefined) ?? open.find((w) => w.kind !== KIND_TEXT) ?? open[0];
    // the last thing left in a quiet part is a sky
    if (open.length === 2 && old.kind !== KIND_SKY && old.kind !== KIND_TEXT) {
      const other = open.find((w) => w !== old)!;
      if (other.kind !== KIND_SKY && other.kind !== KIND_TEXT) other.kind = KIND_SKY;
    }
    old.closing = clock;
  }

  function targetCount(f: FrameContext) {
    const fe = f.feel;
    if (fe.section === 'break') return 1;
    const d = num(f.params, 'density', 1);
    const n = (2 + 24 * Math.pow(fe.intensity, 1.4)) * d + 10 * fe.tension * d;
    return Math.round(clamp(n, 1, MAXW - 6));
  }

  function render(frame: FrameContext, target: THREE.WebGLRenderTarget) {
    const dt = stepDt(frame);
    clock += dt;
    const a = frame.audio;
    const fe = frame.feel;
    const bps = a.bpm > 0 ? a.bpm / 60 : 2;

    if (!started || Math.abs(frame.aspect - aspect) > 0.02) {
      aspect = frame.aspect;
      started = true;
      newLayout(frame, Math.max(2, targetCount(frame)));
      for (const w of wins) w.born = clock - 1;
    }

    /* the drop: switch off (ahead of a known drop), then on again with a whole new wall */
    const collapse = num(frame.params, 'collapse', 1);
    const dropNow = (dropHit(frame) || (fe.sinceDrop < 0.1 && lastSince > 0.5)) && clock - lastDropAt > 2;
    lastSince = fe.sinceDrop;
    if (crt === 0 && collapse > 0.01 && fe.toDrop > 0.02 && fe.toDrop < 0.42 && clock - lastDropAt > 2) {
      crt = 1;
      crtAt = clock;
      crtDur = fe.toDrop;
    }
    const switchOn = () => {
      lastDropAt = clock;
      crt = collapse > 0.01 ? 2 : 0;
      crtAt = clock;
      newLayout(frame, Math.max(targetCount(frame), 14));
      blinkAt = clock - 1;
    };
    if (dropNow) {
      if (crt === 1 || collapse <= 0.01) switchOn();
      else {
        // no warning (live input): a quick switch-off first
        crt = 1;
        crtAt = clock;
        crtDur = 0.16;
        lastDropAt = clock;
      }
    }
    if (crt === 1 && clock - crtAt > crtDur + 0.25) switchOn();

    /* beats, kicks, snares, hats */
    const prevBeat = Math.floor(beatAcc);
    beatAcc += dt * bps * (a.playing ? 1 : 0.35);
    const beatTick = Math.floor(beatAcc) !== prevBeat;
    if (beatTick) beatN++;
    const target_ = targetCount(frame);
    const live = () => wins.filter((w) => w.closing < 0).length;
    const breaking = fe.section === 'break';

    if (crt !== 1) {
      if (a.kickHit) {
        kicks++;
        lastKick = clock;
        if (!breaking && (fe.intensity >= 0.38 || kicks % 2 === 0)) {
          openOne(frame);
          if (live() > target_ + 2) closeOldest();
        }
      }
      if (beatTick) {
        const over = live() - target_;
        thinning = breaking || fe.intensity < 0.3;
        const nClose = breaking ? Math.ceil(over / 2.5) : over > 4 ? 2 : over > 0 ? 1 : 0;
        for (let k = 0; k < nClose; k++) closeOldest();
        // no drums: the screen still turns over, slowly
        if (clock - lastKick > 1.5) {
          if (live() < target_ && beatN % 2 === 0) openOne(frame);
          else if (beatN % 8 === 0 && fe.section !== 'break') {
            openOne(frame);
            closeOldest();
          }
        }
        // a blink on each phrase, but never in the first moments of the drop (they open wide instead)
        if (beatN % 16 === 0 && clock - lastDropAt > 1.5) blinkAt = clock;
      }
      if (a.snareHit) {
        snares++;
        if (!breaking && (fe.intensity > 0.45 || snares % 2 === 0)) startCascade(frame);
        if (rng() < 0.3 && clock - lastDropAt > 1.5) blinkAt = clock;
      }
    }
    if (a.hatHit) {
      hatAt = clock;
      hatN = (hatN + 1) % 997;
    }
    if (cascade && clock >= cascade.next && crt !== 1) {
      const c = cascade;
      const k = Math.round((clock - c.next) / c.step);
      const w: Win = { ...c.tpl, crop: [...c.tpl.crop] as [number, number, number], born: clock, closing: -1 };
      push(w);
      c.tpl = { ...c.tpl, x: c.tpl.x + c.dx, y: c.tpl.y + c.dy };
      c.left--;
      c.next += c.step * Math.max(1, k + 1);
      tgx = w.x;
      tgy = w.y;
      lastOpen = clock;
      if (c.left <= 0) cascade = null;
    }

    /* the words */
    const cur = currentLyric(a.time);
    const lineId = cur ? cur.i : -1;
    if (lineId !== textLine) {
      if (lineId >= 0 && crt !== 1) openText(frame);
      textLine = lineId;
    } else if (lineId < 0 && clock - infoAt > 16 / bps && crt !== 1 && fe.section !== 'break') {
      infoAt = clock;
      if (!textMem.lastLine || a.time - textMem.lastEnd > 3) openText(frame);
    }
    const wn = wordsNow(frame, textMem);
    if (wn.key !== textKey) {
      textKey = wn.key;
      drawWords(tctx, wn.words);
      textTex.needsUpdate = true;
    }

    /* gaze, pupils */
    if (clock - lastOpen > 1.4) {
      // nothing new: the eyes wander
      tgx = Math.sin(clock * 0.31) * aspect * 0.35 + Math.sin(clock * 0.13 + 2) * 0.1;
      tgy = Math.sin(clock * 0.23 + 1) * 0.3;
    }
    gx = approach(gx, tgx, 22, dt);
    gy = approach(gy, tgy, 22, dt);
    const pr = num(frame.params, 'pupil', 1);
    const glare = clamp((a.level * (0.4 + a.brightness) - 0.45) * 2.5, 0, 1);
    const pt = clamp(0.4 + (0.2 * a.bass + 0.1 * a.sub) * pr - 0.16 * glare * pr - 0.2 * fe.tension + 0.38 * Math.pow(fe.release, 1.5), 0.17, 0.86);
    pupil = approach(pupil, pt, pt > pupil ? 9 : 5, dt);

    /* the window list → uniforms (oldest first; the shader walks from the top down) */
    wins = wins.filter((w) => w.closing < 0 || clock - w.closing < CLOSE_T);
    const n = Math.min(wins.length, MAXW);
    let top = 0;
    for (let i = 0; i < n; i++) {
      const w = wins[i];
      let op = clamp((clock - w.born) / OPEN_T, 0, 1);
      if (w.closing >= 0) op = Math.min(op, 1 - clamp((clock - w.closing) / CLOSE_T, 0, 1)) * 0.999;
      if (op >= 1) top = i;
      rects[i].set(w.x, w.y, w.hw, w.hh);
      as[i].set(w.kind, w.seed, w.tint, w.crop[2]);
      const flash = op >= 1 ? Math.exp(-(clock - w.born - OPEN_T) * 14) : 0;
      bs[i].set(w.crop[0], w.crop[1], flash, op >= 1 ? 1 : op * 0.999);
    }

    updateBaseUniforms(wu, frame);
    updateParamUniforms(wu, params, frame.params);
    wu.uObCount.value = n;
    wu.uObTop.value = top;
    wu.uObTb.value = titleH(frame.height);
    wu.uObBd.value = Math.max(0.0035 * short(), 2.5 / Math.max(1, frame.height));
    (wu.uObGaze.value as THREE.Vector2).set(gx, gy);
    wu.uObGazeAmt.value = num(frame.params, 'gaze', 0.85) * (1 - 0.9 * fe.tension);
    wu.uObPupil.value = pupil;
    wu.uObBlink.value = clock - blinkAt;
    wu.uObHatT.value = clock - hatAt;
    wu.uObHatN.value = hatN;
    wu.uObSat.value = 1 + 0.7 * fe.release + 0.15 * fe.intensity;
    wu.uObClock.value = clock % 1000;

    /* the screen: CRT squeeze */
    let sx = 1;
    let sy = 1;
    let line = 0;
    let flash = 0;
    if (crt === 1) {
      const u = clamp((clock - crtAt) / Math.max(0.05, crtDur), 0, 1);
      sy = u < 0.7 ? 1 - (1 - 0.006) * easeIn(u / 0.7) : 0.006;
      sx = u < 0.7 ? 1 : 1 - (1 - 0.012) * easeIn((u - 0.7) / 0.3);
      line = clamp((u - 0.35) / 0.35, 0, 1);
    } else if (crt === 2) {
      const o = (clock - crtAt) / 0.34;
      if (o >= 1) crt = 0;
      sx = Math.min(1, 0.012 + easeOut(o / 0.25));
      sy = o < 0.18 ? 0.006 : Math.max(0.006, easeOutBack((o - 0.18) / 0.82));
      line = clamp(1 - o * 2.5, 0, 1);
      flash = clamp(1 - o * 2.2, 0, 1) * 0.8;
    }
    sx = 1 + (sx - 1) * collapse;
    sy = 1 + (sy - 1) * collapse;

    if (!rt || rt.width !== frame.width || rt.height !== frame.height) {
      rt?.dispose();
      rt = makeRenderTarget(frame.width, frame.height);
    }
    wQuad.render(frame.renderer, rt);

    updateBaseUniforms(su, frame);
    updateParamUniforms(su, params, frame.params);
    su.tScene.value = rt.texture;
    (su.uObSq.value as THREE.Vector2).set(sx, sy);
    su.uObLine.value = line * collapse;
    su.uObFlash.value = flash * collapse;
    su.uObChroma.value = num(frame.params, 'crunch', 0.5) * (1.2 + 2.5 * a.kick + 3 * fe.release * a.bass);
    sQuad.render(frame.renderer, target);
  }

  return {
    render,
    dispose() {
      wMat.dispose();
      sMat.dispose();
      wQuad.dispose();
      sQuad.dispose();
      textTex.dispose();
      rt?.dispose();
    },
  };
}

export const observer: SceneDef = {
  id: 'observer',
  name: 'Observer',
  description:
    'A screen stacked with little old program windows that look back at you: huge tinted eyes in extreme close-up and blue skies full of cumulus, one of them carrying the sung words in soft glowing capitals. Kicks open windows, snares cascade one down the screen, the eyes follow whatever just opened and their pupils breathe with the bass. A build crowds the windows toward the middle with every eye staring out, the drop switches the screen off to a line and a dot and back on to a whole new wall.',
  category: 'field',
  style: 'world',
  tags: ['dreamy', 'melancholic', 'nostalgic', 'retro', 'lofi', 'glitch', 'psychedelic', 'experimental', 'electronic', 'pop', 'lyrics', 'hypnotic'],
  showsLyrics: true,
  params,
  modulations: [
    { source: 'bass', param: 'pupil', amount: 0.12 },
    { source: 'hat', param: 'crunch', amount: 0.15 },
  ],
  create,
};
