import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock, speedClock } from '../shader/lib';

/**
 * Halftone Flow — a sculpture of poured paint hanging in dark space, printed as a fixed grid of
 * coloured dots. Under the screen is a slow marbled painting: overlapping ribbons, each with a lit
 * ridge where it folds over the one below and a shadowed crease where it tucks under the next. The
 * dot grid never moves; the painting flows through it. Dot size is the lightness of the paint, so
 * highlights are fat dots that almost touch and shadows are pinpricks, and the edge of the form
 * frays into loose dots and small clumps instead of ending in a line.
 *
 * Palette roles: bg = the dark space (or the paper), fg = the lightest ink (lit ridges, sparkles),
 * accent = the warm paint (upper zone), accent2 = the cool paint (lower zone), muted = the deep
 * shadow ink (creases, and the second print pass that sits between the main dots).
 */
const fragment = /* glsl */ `
${HM_LIB}

// size of the folds against the frame
const float HF_SCALE = 1.3;

// the same for every dot in a frame (set once at the top of main)
float gT;        // flow clock
float gOpen;     // 0 = thin wisps, 1 = the form fills the frame
float gTens;     // build tension 0..1
float gTwist;    // knot twist (build winds it up, the drop throws it the other way)
float gFold;     // fold depth
float gRingR;    // radius of the kick's pressure ring
float gRingA;    // and its strength
float gSplit;    // gap between the two wisps while the form is thin
float gCarry;    // how far the folds carry the silhouette
float gFray;     // width of the frayed edge
vec2  gKc;       // where the last kick pressed
vec2  gRadW;     // wisp radii (along the ribbons, across them)
vec2  gRadF;     // frame-filling radii
mat2  gAxis;     // turns the frame so the ribbons run along x
vec3  gHi;       // lightest tint to mix a lit ridge toward
vec3  gLo;       // darkest, to press an ink deeper
float gLift;     // +1 on a dark ground, -1 on paper: which way 'brighter' moves the dot size
float gKnotR;    // radius of the knot a build winds the form into

// a few neighbouring bins averaged, so adjacent-bin jitter doesn't flicker a vein
float hfBand(float x) { return (spectrum(x - 0.03) + spectrum(x) + spectrum(x + 0.03)) / 3.0; }

// one ink of a family, picked by k: the paint itself, a lit tint, a deep shade toward the
// shadow ink, a darker pressing of itself, a blend toward the other family, or nearly the
// lightest ink
vec3 hfInk(vec3 base, vec3 other, float k) {
  if (k < 0.34) return base;
  if (k < 0.56) return mix(base, gHi, 0.5);
  if (k < 0.68) return mix(base, uMuted, 0.45);
  if (k < 0.78) return mix(base, gLo, 0.3);
  if (k < 0.85) return mix(base, other, 0.4);
  return mix(gHi, base, 0.15);
}

// The painting under the screen, sampled at one dot site (p = aspect-correct position, jit = a
// random number for this dot). Returns the ink there. tone = lightness of the paint 0..1;
// body = how deep inside the form the site is (0 at the edge, 1 one fray-width in, negative
// outside); swell = the kick ring passing.
vec3 hfPaint(vec2 p, float jit, out float tone, out float body, out float swell) {
  // kick: a pressure ring travels out through the paint and bulges it as it passes
  vec2 kp = p - gKc;
  float kr = length(kp);
  float rx = kr - gRingR;
  swell = exp(-rx * rx * 70.0) * gRingA;
  p -= kp * (swell * 0.07 / max(kr, 0.14));

  // build: the form winds in on itself
  float r = length(p);
  vec2 k = rot2(gTwist * exp(-r * 2.0)) * p;
  k *= 1.0 + 0.8 * gTens;

  // broad drift, then four passes of folding (each fold pushes the paint sideways along a wave)
  vec2 u0 = gAxis * k;
  vec2 w = u0 * HF_SCALE;
  vec2 n = vec2(snoise(w * 0.45 + vec2(gT * 0.11, -gT * 0.07)), snoise(w * 0.45 + vec2(31.7 - gT * 0.09, 11.3 + gT * 0.1)));
  w += 0.55 * n;
  float a = gFold;
  float fq = 1.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    w.x += a * sin(w.y * 1.7 * fq + gT * 0.6 + fi * 1.3 + u_lurch);
    w.y += a * cos(w.x * 1.4 * fq - gT * 0.45 + fi * 2.1);
    a *= 0.52;
    fq *= 1.65;
  }

  // the silhouette is carried part of the way by the folds: a wisp follows its ribbon, the full
  // form holds its place in the frame while its outline is pulled about
  vec2 um = mix(u0, w / HF_SCALE, gCarry);
  vec2 fm = um * gAxis;
  float dy = min(abs(um.y - gSplit), abs(um.y + gSplit * 1.4) * 1.5);
  float eW = length(vec2(um.x / gRadW.x, dy / gRadW.y));
  vec2 fr = abs(fm) / gRadF;
  float eF = pow(fr.x * fr.x * fr.x + fr.y * fr.y * fr.y, 1.0 / 3.0);
  float e = mix(eW, eF, gOpen);
  e = mix(e, length(um) / gKnotR, smoothstep(0.0, 0.7, gTens));
  e += (0.14 + 0.2 * gOpen) * snoise(um * 1.9 + vec2(gT * 0.13, 7.7)) + 0.1 * gOpen * n.y;
  body = (1.0 - e + 0.12 * uKick * u_ring) / gFray;

  // ribbons: bands of the folded coordinate, each cut twice at uneven points so widths vary
  float b = w.y * u_ribbons + 0.35 * n.x;
  float id = floor(b);
  float h = fract(b);
  float lo = id;
  float wd = 1.0;
  for (int i = 0; i < 2; i++) {
    float cut = 0.28 + 0.44 * hash11(id * 0.731 + 3.1);
    if (h < cut) { h /= cut; wd *= cut; id = id * 2.0 + 0.37; }
    else { h = (h - cut) / (1.0 - cut); lo += cut * wd; wd *= 1.0 - cut; id = id * 2.0 + 1.61; }
  }

  // shading: a lit ridge where the ribbon laps over the one below, falling into its crease;
  // slow billows along its length, fine brush streaks, and pools where the paint thins to nothing
  float lit = exp(-h * 9.0) * smoothstep(0.0, 0.05, h);
  tone = mix(0.92, 0.22, smoothstep(0.3, 1.0, h)) + 0.3 * lit;
  tone *= 0.84 + 0.16 * sin(w.x * 2.1 + id * 1.9 + gT * 0.35);
  tone *= 0.9 + 0.16 * n.y;
  tone += 0.07 * sin(b * 23.0 + 2.0 * sin(w.x * 1.7));
  float pool = smoothstep(0.25, 0.8, snoise(w * 2.7 + vec2(3.0, gT * 0.1)));
  tone -= 0.55 * pool * (1.0 - lit);
  tone += (jit - 0.5) * 0.16 + gLift * (0.15 * (1.0 - gOpen) + 0.45 * swell);

  // colour: warm above, cool below; in between each ribbon turns at its own height, and the
  // turn is dithered dot by dot so the two paints mingle. Along its length a ribbon drifts
  // between two inks of its family, and some dots take the neighbouring ink, so it is speckled
  // like paint rather than flat
  float zone = fm.y * 2.6 + (lo + 0.5 * wd) / (u_ribbons * HF_SCALE) * 1.4 + (jit - 0.5) * 0.22;
  float warm = step(hash11(id * 1.93 + 0.7), smoothstep(-0.32, 0.32, zone));
  vec3 base = mix(uAccent2, uAccent, warm);
  vec3 other = mix(uAccent, uAccent2, warm);
  float kk = hash11(id * 2.77 + 5.3) + (jit - 0.5) * 0.2;
  float along = smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(w.x * 0.9 + id * 2.3) + (jit - 0.5) * 0.35);
  vec3 ink = mix(hfInk(base, other, kk), hfInk(base, other, fract(kk + 0.37)), along);
  // a vein of the opposite colour runs down the ribbon; its spectrum bin pushes it wider
  float sp = hfBand(0.03 + 0.7 * hash11(id * 4.1 + 2.2));
  float vw = 0.03 + 0.3 * sp * u_bands;
  float vein = (1.0 - smoothstep(vw, vw + 0.03, abs(h - 0.55))) * step(0.4, hash11(id * 5.9 + 1.1));
  ink = mix(ink, other, vein);
  tone += 0.25 * vein * sp;
  // the ridge leans to the lightest ink, the crease to the shadow ink
  ink = mix(ink, gHi, lit * 0.75);
  ink = mix(ink, uMuted, smoothstep(0.6, 1.0, h) * 0.35);
  // the knot burns bright
  vec3 hot = gLift > 0.0 ? mix(gHi, base, 0.2) : mix(base, gLo, 0.3);
  ink = mix(ink, hot, gTens * 0.75);
  // the kick ring lifts the paint it passes through
  ink = mix(ink, gLift > 0.0 ? mix(base, gHi, 0.55) : base, 0.5 * swell);
  tone = clamp(mix(tone, 0.5 + 0.5 * gLift, 0.6 * gTens), 0.0, 1.0);
  return ink;
}

// which dots are printed at the edge: per-dot threshold with a little clumping
// (each snare re-rolls the thresholds, so the loose edge shivers)
float hfPresent(vec2 cid, float body) {
  float thr = mix(hash21(cid + 3.7 + u_snareN * 0.37), vnoise(cid * 0.37 + 11.0), 0.45) * 0.9;
  float pr = pow(clamp(body, 0.0, 1.0), 0.75);
  // loose dots beyond the edge; a build gathers a cloud of them around the knot
  pr = max(pr, (0.1 + 0.45 * gTens) * exp(mix(10.0, 1.6, gTens) * gFray * min(body, 0.0)));
  return smoothstep(thr, thr + 0.1, pr);
}

float hfDot(vec2 q, float r, float e) {
  return (1.0 - smoothstep(r - e, r + e, length(q))) * smoothstep(0.0, 0.04, r);
}

float hfBurst(float s) { return clamp((1.0 - exp(-s * 14.0)) * exp(-s * 1.4) * 1.3, 0.0, 1.0); }

void main() {
  vec2 fc = gl_FragCoord.xy;
  float isL = hmIsLight();
  float ext = u_ext;
  float burst = hfBurst(u_sinceDrop);

  gT = u_clk;
  gHi = hmLight();
  gLo = hmDark();
  gLift = 1.0 - 2.0 * isL;
  gTens = clamp(u_tens, 0.0, 1.0);
  gTwist = gTens * 2.6 - burst * 1.1;
  gOpen = smoothstep(0.4, 0.95, ext);
  gFold = u_fold * (0.75 + 0.4 * u_sBass + 0.15 * clamp(ext, 0.0, 1.0) + 0.35 * burst);
  float land = smoothstep(0.75, 1.4, uAspect);
  gAxis = rot2(mix(1.2, 0.22, land) * (1.0 - 0.5 * gOpen));
  float longR = 0.5 * mix(1.0, uAspect, land);
  gRadW = vec2(longR * (0.7 + 0.5 * ext), mix(0.03, 0.5, pow(clamp(ext, 0.0, 1.0), 1.25)));
  gRadF = 0.5 * vec2(uAspect, 1.0) * mix(0.45, 1.15, ext);
  gSplit = 0.12 * (1.0 - gOpen);
  gKnotR = 0.2 * mix(0.62, 1.0, land) * (1.0 + 0.8 * gTens);
  gFray = (0.08 + 0.4 * u_fray) * (1.0 - 0.5 * gTens) * (0.6 + 0.4 * gOpen);
  gCarry = mix(0.85, 0.35, gOpen) * (1.0 - 0.85 * gTens);
  float seed = u_kickN;
  gKc = (vec2(hash11(seed * 1.37 + 0.2), hash11(seed * 2.71 + 0.7)) - 0.5) * vec2(0.3 * uAspect, 0.3) * (0.25 + 0.75 * gOpen);
  gRingR = u_sinceKick * 0.95;
  gRingA = exp(-u_sinceKick * 2.6) * u_kickAmp * u_ring;

  // the screen: a fixed grid, pitch in px (scaled with the short side so the dot count holds)
  float pitch = max(3.0, u_pitch * min(uResolution.x, uResolution.y) / 1080.0);
  float aa = 0.7 / pitch;
  float dotScale = 0.5 * u_dot * (0.84 + 0.16 * clamp(ext, 0.0, 1.0)) * (1.0 + 0.1 * uDrop + 0.06 * uKick);
  vec2 asp = vec2(uAspect, 1.0);
  vec2 g = fc / pitch;

  // first pass: the colour inks. One dot per cell, sized by the paint's lightness at its centre
  vec2 cid = floor(g);
  vec2 q = fract(g) - 0.5;
  vec2 p = ((cid + 0.5) * pitch / uResolution - 0.5) * asp;
  float tone; float body; float swell;
  float jit = hash21(cid * 0.71 + 19.3);
  vec3 ink = hfPaint(p, jit, tone, body, swell);
  float present = hfPresent(cid, body);
  float sizeTone = mix(tone, 1.0 - 0.85 * tone, isL);
  float area = present * mix(0.45, 1.0, clamp(body, 0.0, 1.0)) * mix(0.015, 1.0, pow(sizeTone, 0.9));
  // build: the dots shrink away from the core of the knot
  area *= mix(1.0, 0.12 + 0.88 * smoothstep(0.0, 0.45, body * gFray), gTens);
  float r = dotScale * sqrt(area) * (1.0 + 0.9 * swell);
  ink = hmSat(ink, 1.0 + 0.3 * uDrop + 0.1 * gOpen);
  ink *= mix(0.86 + 0.2 * tone, 1.0, isL);
  // hats: single dots flash to the lightest ink
  float spark = step(1.0 - 0.05 * u_sparkle, hash21(cid * 1.31 + u_hatN * 7.13)) * uHat * step(0.2, present);
  r = mix(r, 0.5 * u_dot, spark);
  ink = mix(ink, uFg, spark);
  float d1 = hfDot(q, min(r, 0.56), aa);

  // second pass: the shadow ink, printed half a cell off so its dots sit between the first ones.
  // Snares knock it out of register for a moment.
  vec2 g2 = g + 0.5 + vec2(0.3, -0.12) * uSnare;
  vec2 cid2 = floor(g2);
  vec2 q2 = fract(g2) - 0.5;
  vec2 site2 = (cid2 + 0.5 - (g2 - g)) * pitch;
  vec2 p2 = (site2 / uResolution - 0.5) * asp;
  float tone2; float body2; float swell2;
  vec3 ink2 = hfPaint(p2, hash21(cid2 * 0.71 + 41.9), tone2, body2, swell2);
  float present2 = hfPresent(cid2 + 57.0, body2);
  float area2 = present2 * (1.0 - smoothstep(0.1, 0.62, tone2)) * u_shadow;
  float r2 = dotScale * 0.72 * sqrt(area2) * (1.0 + 0.5 * swell2 + 0.25 * uSnare);
  vec3 shade = mix(uMuted, ink2, 0.35);
  float d2 = hfDot(q2, min(r2, 0.5), aa);

  vec3 col = uBg;
  // on dark the shadow pass goes under the colour; on paper it overprints
  col = mix(col, shade * 0.85, d2 * (1.0 - isL));
  col = mix(col, ink, d1);
  col = mix(col, col * (shade + 0.12), d2 * isL);

  col += hmGrain(fc, uTime) * 0.025;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Seconds since the drop fired (rising edge of the drop envelope). */
const sinceDropClock: ClockDef = {
  init: 100,
  step: (v, f, _s, mem) => {
    const d = f.audio.drop;
    const fired = d > 0.6 && (mem.sdPrev ?? 0) <= 0.6;
    mem.sdPrev = d;
    return fired ? 0 : Math.min(v + f.dt, 100);
  },
};

const ease = (v: number, target: number, rate: number, dt: number) => v + (target - v) * (1 - Math.exp(-dt * rate));

/**
 * How much of the frame the form holds: 0 = a wisp, 1 = most of the frame. Follows the song's
 * energy over a second or two, is pulled in by a build, and is thrown wide open by a drop.
 */
const extentClock: ClockDef = {
  init: -1,
  step: (v, f, s) => {
    const a = f.audio;
    let target = Math.min(1, Math.max(0, (a.energy - 0.08) / 0.8));
    target = target * (1 - 0.8 * Math.max(a.build, f.feel.tension)) + 0.12 * a.drop;
    if (v < 0) return target; // first frame: start in the right state wherever the song is
    if (s.sinceDrop < 0.45) return ease(v, 1.3, 14, f.dt);
    return ease(v, target, 1.2, f.dt);
  },
};

export const halftoneFlow = defineClockedShaderScene(
  {
    id: 'halftone-flow',
    name: 'Halftone Flow',
    description:
      'Folds of poured paint hanging in the dark, printed as a fine fixed grid of coloured dots: fat dots on the lit ridges, pinpricks in the creases, and edges that fray into loose dots. It is a wisp in quiet parts and fills the frame in a chorus; bass deepens the folds, each kick sends a ring that swells the dots as it passes, hats sparkle single dots. A build winds it into a small bright knot and the drop bursts it open.',
    category: 'field',
    style: 'print',
    fragment,
    tags: ['dreamy', 'organic', 'tactile', 'graphic', 'psychedelic', 'warm', 'cinematic', 'romantic', 'hypnotic', 'electronic', 'indie', 'euphoric'],
    params: [
      { id: 'pitch', label: 'Dot pitch', group: 'Shape', type: 'number', min: 4, max: 28, step: 0.5, default: 9, hint: 'Distance between dots (px at 1080)' },
      { id: 'dot', label: 'Dot size', group: 'Shape', type: 'number', min: 0.5, max: 1.2, step: 0.01, default: 0.96, hint: '1 = the biggest dots just touch' },
      { id: 'ribbons', label: 'Ribbons', group: 'Shape', type: 'number', min: 0.4, max: 4, step: 0.05, default: 1.1, hint: 'How many ribbons the paint is cut into' },
      { id: 'fold', label: 'Fold depth', group: 'Shape', type: 'number', min: 0, max: 1.2, step: 0.01, default: 0.5, hint: 'Bass folds it deeper still' },
      { id: 'fray', label: 'Edge fray', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'How far the edge breaks up into loose dots' },
      { id: 'speed', label: 'Flow speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: 'ring', label: 'Kick ring', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'The pressure ring that swells the dots on each kick' },
      { id: 'sparkle', label: 'Hat sparkle', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'bands', label: 'Spectrum veins', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'The spectrum widens veins of the opposite colour inside the ribbons' },
      { id: 'shadow', label: 'Shadow pass', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Second print pass in the shadow ink, between the main dots' },
    ],
    modulations: [
      { source: 'sub', param: 'fold', amount: 0.1 },
      { source: 'brightness', param: 'bands', amount: 0.2 },
    ],
  },
  {
    clk: speedClock('speed', 0.3, (f) => 0.45 + 0.8 * f.audio.bass + 0.5 * f.audio.energy + 0.9 * Math.max(f.audio.build, f.feel.tension)),
    sinceKick: sinceKickClock,
    kickAmp: { step: (v, f) => (f.audio.kickHit ? f.audio.kick : v) },
    kickN: kickCountClock,
    hatN: { step: (v, f) => (f.audio.hatHit ? (v + 1) % 997 : v) },
    snareN: { step: (v, f) => (f.audio.snareHit ? (v + 1) % 997 : v) },
    // each snare lurches the folds one step on (eased, so it shoves rather than jumps)
    lurch: {
      step: (v, f, _s, mem) => {
        if (f.audio.snareHit) mem.lurchTo = (mem.lurchTo ?? 0) + 0.55;
        return ease(v, mem.lurchTo ?? 0, 9, f.dt);
      },
    },
    sinceDrop: sinceDropClock,
    ext: extentClock,
    // build tension, eased in; released fast when the drop lands
    tens: { step: (v, f, s) => ease(v, Math.max(f.audio.build, f.feel.tension) * 0.9, s.sinceDrop < 1 ? 14 : 5, f.dt) },
    sBass: { step: (v, f) => ease(v, f.audio.bass, 8, f.dt) },
  },
);
