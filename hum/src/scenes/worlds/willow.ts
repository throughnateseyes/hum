import type { FrameContext } from '../../core/types';
import { num } from '../../core/uniforms';
import { HM_LIB, defineClockedShaderScene, rateClock, sinceKickClock, type ClockDef, type ClockState } from '../shader/lib';

/*
 * Willow: a woodblock print of weeping willows over a still lake. The feeling is a held breath by
 * the water: stillness and nostalgia, then the wind arrives.
 *
 * How the picture is made (one full-screen fragment, one evaluation of the world per pixel):
 * - The world is drawn by `wlWorld(w)` in "shore space" (x across, y = height above the waterline).
 *   Pixels below the waterline call the same function with y mirrored and x smeared by ripple bands
 *   and kick rings, so the reflection is the real scene, not a copy.
 * - The canopy is five curtains, back to front. A curtain hangs from a row of mounds; x is cut into
 *   narrow columns (strands) with hashed lengths, and each strand is a herringbone of short leaf
 *   strokes. Every leaf prints in exactly one flat ink; "light" is only the chance that a leaf
 *   takes the highlight ink, which is what gives the knitted, dithered look of the print.
 * - Wind offsets a strand sideways by how far down it you are, so strands swing from their tops.
 * - Everything is composited front to back with one-pixel coverage, so edges stay hard but clean.
 *
 * Palette roles: bg = the flat sky / water ink, fg = the black keyline (trunks, shore, figures),
 * accent = the main leaf ink, accent2 = the highlight leaf ink (its pale tint is the sun and the
 * unprinted paper), muted = the deep shadow ink between the leaves.
 *
 * Nothing in the shader multiplies time by an audio level: wind phase, water phase, leaf travel and
 * every section-level state are integrated or sprung in the clocks at the bottom of the file.
 */
const fragment = /* glsl */ `
${HM_LIB}
#define WL_OVER acc += rem * L.a * L.rgb; rem *= 1.0 - L.a;

// the inks of this print, mixed once per frame in main()
vec3 kKey;   // keyline
vec3 kDeep;  // shadow between leaves
vec3 kLeaf;  // main leaf ink
vec3 kHi;    // highlight leaf ink
vec3 kSky;   // sky and water
vec3 kSun;   // sun disc, ring strokes, bare paper
vec3 kFar;   // far bank

float gPx;      // one pixel, in world units
float gHw;      // half the visible width
float gTop;     // height of the frame above the waterline
float gWater;   // depth of the frame below it
float gCw;      // strand width
float gTrunkX;  // the near tree
float gTree2X;  // the tree cut by the left edge
float gGapX;    // where the curtain parts
float gGapW;    // how wide it can part
float gGapProf; // 0 at the top of the frame, 1 at the shore
float gOpen;    // how open the curtain is now
float gLit;     // 0 quiet .. 1 chorus
float gSunR;
float gSunY;
float gEnd;     // where the bank stops
float gArch;    // how high the strand ends lift around a trunk

// coverage of a shape from its signed distance (one pixel of anti-aliasing)
float wlCov(float d) { return clamp(0.5 - d / gPx, 0.0, 1.0); }

float wlSeg(vec2 p, vec2 a, vec2 b, float r1, float r2) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(r1, r2, h);
}

// a row of uneven domes, 0..1
float wlScallop(float x) {
  float a = fract(x) - 0.5;
  float b = fract(x * 0.618 + 0.37) - 0.5;
  return max(1.0 - 4.0 * a * a, 0.82 * (1.0 - 4.0 * b * b));
}

// Sideways push on the strand at x (the caller scales it by the distance down the strand).
// crest = how hard the air is moving here: leaves in a gust show their pale undersides.
float wlWind(float x, float lay, out float crest) {
  // idle breath
  float s = 0.014 * sin(x * 2.3 + u_idle * 0.9 + lay * 1.7) + 0.008 * sin(x * 5.3 - u_idle * 1.3 + lay * 0.6);
  // bass: slow gusts that travel across the curtain as a wave
  // (they travel downwind: u_wdir is the shared wind's side, eased, so a change of wind turns them smoothly)
  float ph = x * 2.4 * u_wdir - u_gustT + lay * 0.3;
  float g = sin(ph) + 0.45 * sin(ph * 2.3 + 1.3);
  crest = smoothstep(0.3, 1.2, g) * u_sBass;
  s += 0.085 * (u_sBass + 0.25 * uFeelGust) * g * u_wdir;
  // build: everything leans downwind (u_lean already carries the wind's side)
  s += 0.3 * u_lean;
  // kick: a shiver that starts at the trunk and runs outward
  float fr = abs(x - gTrunkX) - u_sinceKick * 1.9;
  float kv = u_kAmp * u_shiver * exp(-fr * fr * 50.0) * exp(-u_sinceKick * 2.4);
  s += (x < gTrunkX ? -1.0 : 1.0) * 0.1 * kv * cos(fr * 14.0);
  crest += 1.5 * kv;
  return s * u_wind;
}

/*
 * One curtain of hanging strands. Returns ink + coverage.
 *   lay: 0 back .. 4 front · base/amp/freq: the mound line it hangs from · tipLo/tipHi: how low the
 *   strand ends reach · tone: 0 prints in the deep inks, 1 in the bright ones · arch: how much the
 *   strand ends lift around the trunks · crown: how much the mound line rises over each tree
 */
vec4 wlCurtain(vec2 w, float lay, float base, float amp, float freq, float tipLo, float tipHi, float tone, float arch, float crown) {
  if (w.y < tipLo - 0.02) return vec4(0.0);
  float sd = lay * 7.31 + 1.7;
  // the gust parts the curtain: strands either side of the gap are pushed outward and bunch up
  float side = w.x < gGapX ? -1.0 : 1.0;
  float a = abs(w.x - gGapX);
  float G = gOpen * gGapW * gGapProf * (0.74 + 0.09 * lay);
  if (a < G - gPx) return vec4(0.0);
  float Wn = G * 2.4 + 0.1;
  float a0 = a < Wn ? max(a - G, 0.0) * Wn / (Wn - G) : a;
  float x = gGapX + side * a0;
  float cov = G > 0.0 ? clamp((a - G) / gPx + 0.5, 0.0, 1.0) : 1.0;

  // the branch line: a row of mounds
  float ct1 = (x - gTrunkX) / (0.3 * gArch);
  float ct2 = (x - gTree2X) / (0.3 * gArch);
  float top = base + amp * wlScallop(x * freq + sd) + crown * gArch * (exp(-ct1 * ct1) + exp(-ct2 * ct2));
  float d = top - w.y;
  if (d < -gPx) return vec4(0.0);
  cov *= clamp(d / gPx + 0.5, 0.0, 1.0);

  // wind: the push grows with the distance down the strand, so strands swing from their tops
  float crest;
  float push = wlWind(x, lay, crest);
  float xs = x - push * d * (0.35 + 1.1 * d);
  float cx = xs / gCw + sd * 13.0;
  float col = floor(cx);
  float u = cx - col - 0.5;
  vec2 hc = hash22(vec2(col, sd));

  // where this strand ends: swags of tips, every strand its own length, lifted around the trunks,
  // blown up at the gap, bounced by the snare
  float xc = (col + 0.5 - sd * 13.0) * gCw;
  float tip = mix(tipLo, tipHi, 0.55 * wlScallop(xc * 1.9 + sd * 3.0) + 0.45 * hc.x);
  float dt1 = (xc - gTrunkX) / (0.19 * gArch);
  float dt2 = (xc - gTree2X) / (0.19 * gArch);
  tip += arch * gArch * (exp(-dt1 * dt1) + 0.6 * exp(-dt2 * dt2));
  tip += gOpen * 0.3 * exp(-a0 * 7.0);
  tip += u_flick * 0.022 * (hc.y - 0.5);
  float below = w.y - tip;
  if (below < -gPx) return vec4(0.0);
  cov *= clamp(below / gPx + 0.5, 0.0, 1.0);

  // leaf marks: a herringbone of short strokes either side of the stem, narrowing to the tip
  float wHalf = 0.45 * clamp(below / (gCw * 5.0) + 0.3, 0.0, 1.0);
  float inCol = clamp((wHalf - abs(u)) * gCw / gPx + 0.5, 0.0, 1.0);
  float ch = d / gCw * 0.85 - abs(u) * 1.45 + hc.y * 9.0 + u_flick * 0.5 * (hc.x - 0.5);
  float n = floor(ch);
  float f = ch - n;
  float fw = 1.7 * gPx / gCw;
  float sdl = f < 0.62 ? min(f, 0.62 - f) : -min(f - 0.62, 1.0 - f);
  float leaf = clamp(sdl / fw + 0.5, 0.0, 1.0) * inCol;
  // the body of the curtain prints solid (shadow ink between the leaves); the last few leaves of
  // every strand hang free against whatever is behind
  float body = step(gCw * (3.0 + 9.0 * hc.x), below);
  vec3 gapInk = mix(kDeep, kKey, 0.5 * (1.0 - tone));
  if (leaf <= 0.0) return vec4(gapInk, cov * body);

  // Every leaf prints in one of three inks. light = the chance it takes the highlight ink,
  // shade = the chance it takes the shadow green.
  float sideId = col * 2.0 + (u < 0.0 ? 0.0 : 1.0);
  float lh = hash21(vec2(sideId, n) + sd);
  float cap = exp(-d * mix(9.0, 13.0, tone)); // the lit crown of each mound
  float fringe = exp(-below * 26.0);          // the hanging ends catch the light again
  float sunPatch = smoothstep(0.54, 0.76, vnoise(vec2(x * 1.7 + u_drift + lay * 3.1, w.y * 2.6 - u_drift * 0.4)));
  float lightP = u_sun * (0.03 + 0.1 * gLit + (0.95 * cap + 0.4 * fringe * tone) * (0.5 + 0.5 * gLit) + sunPatch * (0.08 + 0.55 * u_sMid));
  lightP += 0.55 * crest + 0.6 * gOpen * exp(-a0 * 4.0) + 0.3 * u_blow;
  lightP *= 1.0 - 0.6 * u_sBuild;
  float shadeP = smoothstep(0.015, 0.13, d) * (0.9 - 0.2 * gLit - 0.45 * sunPatch) * (1.0 - 0.6 * fringe);
  // snares light whole strands, hats single leaves
  lightP += uSnare * u_sparkle * 0.85 * step(0.7, hash21(vec2(col, u_snareN + sd)));
  float spark = uHat * u_sparkle * step(0.86, hash21(vec2(sideId + n * 31.7, u_hatN + sd)));

  vec3 leafInk = mix(kDeep, kLeaf, 0.45 + 0.55 * tone);
  vec3 hiInk = mix(kLeaf, kHi, 0.3 + 0.7 * tone);
  vec3 ink = lh < lightP ? hiInk : (lh > 1.0 - shadeP ? mix(gapInk, leafInk, 0.38) : leafInk);
  ink = mix(ink, kHi, clamp(spark * 1.4, 0.0, 1.0));
  return vec4(mix(gapInk, ink, leaf), cov * mix(leaf, 1.0, body));
}

// a tree: trunk, root flare, forking limbs. Distance in world units.
float wlTree(vec2 w, float tx, float sc) {
  vec2 p = vec2(w.x - tx, w.y) / sc;
  if (abs(p.x) > 0.27 || p.y > 0.43) return 1.0;
  p.x += (vnoise(vec2(p.y * 34.0, tx * 3.0)) - 0.5) * 0.009 + 0.01 * sin(p.y * 11.0); // hand-cut edge, a slow bend
  float d = wlSeg(p, vec2(-0.006, -0.01), vec2(0.0, 0.03), 0.055, 0.034);
  d = min(d, wlSeg(p, vec2(0.0, 0.0), vec2(0.004, 0.13), 0.037, 0.03));
  // it splits low into two stems that climb into the crown
  d = min(d, wlSeg(p, vec2(0.0, 0.12), vec2(-0.024, 0.39), 0.024, 0.013));
  d = min(d, wlSeg(p, vec2(0.012, 0.11), vec2(0.075, 0.27), 0.021, 0.013));
  d = min(d, wlSeg(p, vec2(0.075, 0.27), vec2(0.088, 0.39), 0.013, 0.008));
  // the crooked low limb and its twig
  d = min(d, wlSeg(p, vec2(0.045, 0.185), vec2(0.13, 0.2), 0.008, 0.0055));
  d = min(d, wlSeg(p, vec2(0.13, 0.2), vec2(0.17, 0.172), 0.0055, 0.0035));
  d = min(d, wlSeg(p, vec2(0.17, 0.172), vec2(0.222, 0.196), 0.0035, 0.0015));
  d = min(d, wlSeg(p, vec2(0.13, 0.2), vec2(0.158, 0.262), 0.004, 0.0015));
  d = min(d, wlSeg(p, vec2(-0.012, 0.22), vec2(-0.09, 0.31), 0.008, 0.003));
  return d * sc;
}

float wlPerson(vec2 p, float h) {
  float d = wlSeg(p, vec2(0.0, 0.14 * h), vec2(0.0, 0.66 * h), 0.15 * h, 0.105 * h);
  return min(d, length(p - vec2(0.0, 0.88 * h)) - 0.105 * h);
}

// someone sitting; p is measured from the seat, seatH is how far the feet have to drop
float wlSitter(vec2 p, float h, float seatH) {
  float d = wlSeg(p, vec2(0.0, 0.02 * h), vec2(0.0, 0.5 * h), 0.15 * h, 0.11 * h);
  d = min(d, length(p - vec2(0.0, 0.74 * h)) - 0.11 * h);
  d = min(d, wlSeg(p, vec2(0.0, 0.03 * h), vec2(0.24 * h, 0.03 * h), 0.07 * h, 0.06 * h));
  return min(d, wlSeg(p, vec2(0.24 * h, 0.03 * h), vec2(0.27 * h, -seatH), 0.05 * h, 0.045 * h));
}

// the bank across the middle, and the small life on it. Everything here is keyline ink.
vec4 wlShore(vec2 w) {
  if (w.y > 0.095) return vec4(0.0);
  float rough = (vnoise(vec2(w.x * 70.0, 1.3)) - 0.5) * 0.003;
  float d = sdBox(w - vec2(gEnd - 4.0, 0.0), vec2(4.0, 0.0115 + rough)) - 0.0025;
  vec3 ink = kKey;
  // the stone kerb: a broken line of shadow ink along the edge
  float kerb = step(abs(w.y - 0.0075), 0.002) * step(0.4, hash11(floor(w.x / (gCw * 0.7)) + 3.0)) * step(w.x, gEnd - 0.01);
  ink = mix(ink, kDeep, kerb);
  if (u_figures > 0.5) {
    float y0 = 0.0135;
    float seat = 0.0165;
    vec2 p = w - vec2(-0.06 * gHw, y0);
    // a bench
    float e = sdBox(p - vec2(0.0, seat), vec2(0.056, 0.0016));
    e = min(e, sdBox(vec2(abs(p.x) - 0.046, p.y - seat * 0.5), vec2(0.0016, seat * 0.5)));
    // three sitting: a man in a hat, someone beside him, a child
    e = min(e, wlSitter(p - vec2(-0.036, seat), 0.046, seat));
    e = min(e, sdBox(p - vec2(-0.036, seat + 0.0415), vec2(0.0045, 0.0034)));
    e = min(e, sdBox(p - vec2(-0.036, seat + 0.0388), vec2(0.0082, 0.0009)));
    e = min(e, wlSitter(p - vec2(0.002, seat), 0.039, seat));
    e = min(e, wlSitter(p - vec2(0.027, seat), 0.028, seat));
    // two standing a little apart
    e = min(e, wlPerson(p - vec2(0.095, 0.0), 0.05));
    e = min(e, wlPerson(p - vec2(0.119, 0.0), 0.045));
    // a bicycle left against the tree
    vec2 b = w - vec2(gTrunkX - 0.085, y0 + 0.0122);
    e = min(e, abs(length(vec2(abs(b.x) - 0.017, b.y)) - 0.0113) - 0.0011);
    float fr = wlSeg(b, vec2(-0.017, 0.0), vec2(-0.005, 0.014), 0.0009, 0.0009);
    fr = min(fr, wlSeg(b, vec2(-0.005, 0.014), vec2(0.012, 0.0145), 0.0009, 0.0009));
    fr = min(fr, wlSeg(b, vec2(0.012, 0.0145), vec2(0.0, 0.0), 0.0009, 0.0009));
    fr = min(fr, wlSeg(b, vec2(0.0, 0.0), vec2(-0.006, 0.0175), 0.0009, 0.0009));
    fr = min(fr, wlSeg(b, vec2(0.017, 0.0), vec2(0.011, 0.021), 0.0009, 0.0009));
    fr = min(fr, wlSeg(b, vec2(0.007, 0.0215), vec2(0.014, 0.0205), 0.0011, 0.0011));
    fr = min(fr, wlSeg(b, vec2(-0.0095, 0.018), vec2(-0.003, 0.018), 0.0013, 0.0013));
    e = min(e, fr);
    // a boatman out past the end of the bank
    vec2 q = w - vec2(0.85 * gHw, 0.0045 + 0.0012 * sin(u_idle * 1.1));
    float hull = max(wlSeg(q, vec2(-0.034, 0.003), vec2(0.034, 0.003), 0.0048, 0.0048), q.y - 0.0052);
    hull = min(hull, wlSeg(q, vec2(0.034, 0.003), vec2(0.046, 0.0095), 0.0022, 0.001));
    e = min(e, hull);
    e = min(e, wlPerson(q - vec2(-0.014, 0.004), 0.036));
    e = min(e, wlSeg(q, vec2(-0.02, 0.043), vec2(0.018, -0.004), 0.0008, 0.0008));
    d = min(d, e);
  }
  return vec4(ink, wlCov(d));
}

// behind the trees: the flat sky, the far bank, and the sun that the drop lets in
vec3 wlSky(vec2 w) {
  vec3 c = kSky;
  vec2 sp = w - vec2(gGapX, gSunY);
  float r = length(sp);
  float up = clamp(gOpen * 1.6, 0.0, 1.0);
  // two flat halos, then the disc with a cloud bar cut across it
  c = mix(c, mix(kSky, kSun, 0.28), wlCov(r - gSunR * 2.9) * up);
  c = mix(c, mix(kSky, kSun, 0.55), wlCov(r - gSunR * 1.8) * up);
  float bar = wlCov(sdBox(sp - vec2(gSunR * 0.35, -gSunR * 0.42), vec2(gSunR * 1.25, gSunR * 0.035)) - gSunR * 0.05);
  bar = max(bar, wlCov(sdBox(sp - vec2(-gSunR * 0.5, -gSunR * 0.72), vec2(gSunR * 0.8, gSunR * 0.02)) - gSunR * 0.04));
  c = mix(c, kSun, wlCov(r - gSunR) * (1.0 - bar));
  float bank = 0.007 + 0.02 * wlScallop(w.x * 7.0 + 0.3) * (0.35 + 0.65 * vnoise(vec2(w.x * 3.1, 7.7)));
  return mix(c, kFar, wlCov(w.y - bank));
}

vec3 wlWorld(vec2 w) {
  vec3 acc = vec3(0.0);
  float rem = 1.0;
  vec4 L;
  float T = gTop;
  // the gap is a pointed arch that opens from the hem: closed where the curtains hang from,
  // widest at the shore, and taller the further it is blown open
  float gh = 0.94 * T * clamp(gOpen * 2.4, 0.0, 1.0);
  gGapProf = gh > 0.0 ? pow(clamp((gh - w.y) / gh, 0.0, 1.0), 1.3) : 0.0;
  L = wlShore(w);
  WL_OVER
  if (rem > 0.004) { L = wlCurtain(w, 4.0, 0.3 * T, 0.11 * T, 2.3, 0.028, 0.085, 1.0, 0.26, 0.0); WL_OVER }
  if (rem > 0.004) { L = wlCurtain(w, 3.0, 0.5 * T, 0.11 * T, 1.7, 0.034, 0.105, 0.85, 0.26, 0.15); WL_OVER }
  if (rem > 0.004) {
    float dT = min(wlTree(w, gTrunkX, gArch), wlTree(w, gTree2X, 1.12 * gArch));
    float cv = wlCov(dT);
    if (cv > 0.0) {
      // bark: a few long cuts of shadow ink
      float bark = step(0.8, vnoise(vec2(w.x * 240.0, w.y * 11.0)));
      L = vec4(mix(kKey, kDeep, bark * 0.75), cv);
      WL_OVER
    }
  }
  if (rem > 0.004) { L = wlCurtain(w, 2.0, 0.68 * T, 0.1 * T, 1.35, 0.04, 0.12, 0.6, 0.0, 0.04); WL_OVER }
  if (rem > 0.004) { L = wlCurtain(w, 1.0, 0.86 * T, 0.09 * T, 1.1, 0.05, 0.14, 0.35, 0.0, 0.0); WL_OVER }
  if (rem > 0.004) { L = wlCurtain(w, 0.0, T + 0.2, 0.0, 1.0, 0.07, 0.17, 0.0, 0.0, 0.0); WL_OVER }
  if (rem > 0.004) acc += rem * wlSky(w);
  return acc;
}

// one ring on the water: bends the reflection as it passes and prints two thin crests
void wlRing(vec2 ws, vec2 c, float age, float amp, inout vec2 disp, inout float ink) {
  if (amp < 0.01) return;
  vec2 e = vec2(ws.x - c.x, (ws.y - c.y) * 3.6);
  float r = length(e);
  float wv = r - (0.012 + age * 0.15);
  if (abs(wv) > 0.12) return;
  float born = smoothstep(0.0, 0.12, age);
  float env = amp * born * exp(-wv * wv * 240.0);
  disp += env * cos(wv * 85.0) * vec2(0.012 * e.x / max(r, 0.001), 0.02);
  // screen-space distance to the crest lines (the ring is squashed by the low viewpoint)
  float grad = length(vec2(e.x, e.y * 3.6)) / max(r, 0.001);
  float th = (0.0012 + 0.0016 * amp) * born;
  float l1 = clamp((th - abs(wv) / grad) / gPx + 0.5, 0.0, 1.0);
  float l2 = clamp((th * 0.6 - abs(wv + 0.074) / grad) / gPx + 0.5, 0.0, 1.0) * step(0.074, r);
  // the cut skips: crests print as broken arcs
  float ang = atan(e.y, e.x);
  float skip = step(0.24, hash11(floor(ang * 7.0 + c.x * 40.0) + floor(r * 9.0)));
  ink = max(ink, max(l1, 0.7 * l2) * skip * clamp(amp * 2.5, 0.0, 1.0));
}

// leaves torn off by the gust, tumbling across the frame
float wlLeaves(vec2 p, float sc, float sd, float amt, out float tone) {
  vec2 q = p * sc;
  q.x *= u_wdir; // mirrored when the wind blows the other way, so they always fly downwind
  q.x -= u_leafT * (2.2 + sd);
  q.y += u_leafT * 0.4 + 0.35 * sin(q.x * 0.6 + sd * 5.0);
  vec2 id = floor(q);
  vec2 f = q - id - 0.5;
  vec2 h = hash22(id + sd * 17.0);
  tone = h.y;
  if (h.x > amt) return 0.0;
  vec2 o = (hash22(id + 3.7 + sd) - 0.5) * 0.5;
  // they ride the wind long-side on, rocking as they go
  vec2 l = rot2(0.7 * sin(u_leafT * (2.0 + 4.0 * h.y) + h.y * 40.0) - 0.2) * (f - o);
  float d = length(l * vec2(1.0, 3.8)) - (0.13 + 0.1 * h.y);
  return clamp(0.5 - d / (gPx * sc * 2.2), 0.0, 1.0);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);

  // framing: world units are screen heights in landscape; portrait steps back a little so the
  // canopy is taller and there is more water under it
  float zoom = mix(1.3, 1.0, smoothstep(0.6, 1.5, uAspect));
  vec2 w = vec2((vUv.x - 0.5) * uAspect, vUv.y - u_horizon) * zoom;
  gPx = zoom / uResolution.y;
  gHw = 0.5 * uAspect * zoom;
  gTop = (1.0 - u_horizon) * zoom;
  gWater = u_horizon * zoom;
  gCw = max(0.0105 / u_density, 4.5 * gPx);
  gTrunkX = -0.42 * gHw;
  gTree2X = -gHw - 0.012 - 0.07 * (1.0 - smoothstep(0.6, 1.5, uAspect)); // mostly out of a narrow frame
  gGapX = 0.3 * gHw;
  gGapW = 0.34 * min(1.0, gHw * 1.5);
  gEnd = 0.66 * gHw;
  gOpen = max(u_open - 0.015, 0.0);
  gArch = 1.15 * gTop / 0.63;
  gSunR = 0.085 * min(1.0, gHw * 2.0);
  gSunY = mix(-1.3 * gSunR, 0.2, clamp(gOpen * 1.5, 0.0, 1.0));

  // weather and light: energy brightens the inks, a build darkens the whole print
  gLit = smoothstep(0.1, 0.9, u_sE);
  float storm = u_sBuild;
  kKey = uFg;
  kSun = mix(uAccent2, vec3(1.0), 0.6);
  kDeep = mix(uMuted, uFg, 0.3 * (1.0 - gLit)) * (1.0 - 0.2 * storm);
  kLeaf = mix(mix(uAccent, uMuted, 0.42), uAccent, gLit) * (1.0 - 0.22 * storm);
  kHi = mix(mix(uAccent2, uAccent, 0.45), uAccent2, gLit) * (1.0 - 0.15 * storm);
  kSky = uBg * (0.8 + 0.2 * gLit) * (1.0 - 0.5 * storm);
  kSky = mix(kSky, mix(uBg, kSun, 0.4), 0.6 * clamp(gOpen, 0.0, 1.0));
  kFar = mix(kSky, kDeep, 0.6);

  vec3 col;
  if (w.y >= 0.0) {
    col = wlWorld(w);
  } else {
    // the reflection: the same world, mirrored, smeared sideways in ripple bands
    float s = -w.y;
    float sn = s / gWater;
    float rough = u_rough * u_rings;
    // bands are hair-thin by the far shore and widen toward the viewer
    float bq = pow(sn, 0.6) * 46.0;
    float bj = floor(bq);
    float bf = bq - bj;
    vec2 bh = hash22(vec2(bj, 4.7));
    float slide = sin(u_waterT * (0.7 + 1.5 * bh.x) + bh.y * TAU);
    vec2 disp = vec2(rough * ((0.003 + 0.024 * sn) * slide + 0.006 * sin(s * 55.0 - u_waterT * 1.7)), 0.0);
    float ringInk = 0.0;
    vec2 ws = vec2(w.x, s);
    wlRing(ws, vec2(u_r0X * gHw, u_r0S * gWater), u_r0Age, u_r0Amp * u_rings, disp, ringInk);
    wlRing(ws, vec2(u_r1X * gHw, u_r1S * gWater), u_r1Age, u_r1Amp * u_rings, disp, ringInk);
    wlRing(ws, vec2(u_r2X * gHw, u_r2S * gWater), u_r2Age, u_r2Amp * u_rings, disp, ringInk);
    wlRing(ws, vec2(u_r3X * gHw, u_r3S * gWater), u_r3Age, u_r3Amp * u_rings, disp, ringInk);
    col = wlWorld(vec2(w.x + disp.x, max(s * 1.08 + disp.y, 0.0)));
    // reflections print a step deeper
    col = mix(col, kSky * 0.7, 0.24);
    // strokes lying on the surface: dashes of sky and of shadow, more of them as it roughens
    float dens = 0.1 + 0.5 * min(rough, 1.0);
    float mk = vnoise(vec2(w.x * (26.0 - 14.0 * sn) + bh.x * 37.0 + u_waterT * 0.3 * (bh.y - 0.5), bj * 1.37));
    float fwb = max(fwidth(bq), 0.0001);
    float line = clamp((0.17 - abs(bf - 0.45)) / fwb + 0.5, 0.0, 1.0);
    float dash = line * smoothstep(0.56, 0.56 + 30.0 * gPx, mk) * step(bh.y, dens);
    col = mix(col, bh.x < 0.6 ? mix(kSky, kSun, 0.18) : mix(kDeep, kKey, 0.35), dash * 0.9);
    col = mix(col, mix(kSky, kSun, 0.62), ringInk);
  }

  // leaves in the air
  if (u_leaves > 0.004) {
    float t1;
    float t2;
    float l1 = wlLeaves(w, 13.0, 0.0, u_leaves, t1);
    float l2 = wlLeaves(w + 3.3, 21.0, 1.0, u_leaves * 0.8, t2);
    col = mix(col, t2 < 0.5 ? kLeaf : mix(kDeep, kLeaf, 0.4), l2);
    col = mix(col, t1 < 0.55 ? kHi : (t1 < 0.85 ? kLeaf : kKey), l1);
  }

  // the print itself: paper tooth, uneven inking, baren streaks, specks where the block missed
  float tooth = hash21(floor(fc / pxs)) - 0.5;
  float blot = vnoise(fc / (pxs * 150.0)) - 0.5 + 0.5 * (vnoise(fc / (pxs * 21.0) + 9.0) - 0.5);
  float streak = vnoise(vec2(fc.x / (pxs * 260.0), fc.y / (pxs * 2.5))) - 0.5;
  col *= 1.0 + u_grain * (0.06 * tooth + 0.1 * blot + 0.06 * streak);
  float miss = step(0.985, hash21(floor(fc / (pxs * 1.5)) + 7.0)) * step(0.5, vnoise(fc / (pxs * 55.0) + 3.0));
  col = mix(col, kSun, miss * 0.45 * min(u_grain, 1.0));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── Smoothed drive ───────────────────────── */

type Get = (f: FrameContext, s: ClockState, mem: Record<string, number>) => number;
let key = 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** One-pole follower with separate rise / fall time constants (s). Starts at its target. */
function follow(get: Get, rise: number, fall: number): ClockDef {
  const k = `f${key++}`;
  return {
    step: (v, f, s, mem) => {
      const t = get(f, s, mem);
      if (!mem[k]) {
        mem[k] = 1;
        return t;
      }
      return v + (t - v) * (1 - Math.exp(-f.dt / (t > v ? rise : fall)));
    },
  };
}

/** Damped spring toward `target` (zeta < 1 overshoots and swings back, like a branch). Starts at rest on its target. */
function spring(omega: number, zeta: number, target: Get): ClockDef {
  const k = `s${key++}`;
  return {
    step: (x, f, s, mem) => {
      const tgt = target(f, s, mem);
      if (!mem[`${k}i`]) {
        mem[`${k}i`] = 1;
        mem[`${k}v`] = 0;
        return tgt;
      }
      let v = mem[`${k}v`] ?? 0;
      const h = f.dt / 4;
      for (let i = 0; i < 4; i++) {
        v += (omega * omega * (tgt - x) - 2 * zeta * omega * v) * h;
        x += v * h;
      }
      mem[`${k}v`] = v;
      return x;
    },
  };
}

/** A hit (jumps to `trigger`'s value, decays over `decay` s) seen through a spring: it swells in, then melts. */
function pulse(omega: number, zeta: number, decay: number, trigger: Get): ClockDef {
  const k = `p${key++}`;
  return spring(omega, zeta, (f, s, mem) => {
    const a = trigger(f, s, mem);
    const env = a ? a : (mem[k] ?? 0) * Math.exp(-f.dt / decay);
    mem[k] = env;
    return env;
  });
}

/** True on the frame the drop envelope crosses 0.6 (once per drop). */
function dropFired(f: FrameContext, mem: Record<string, number>, k: string) {
  const d = f.audio.drop;
  const fired = d > 0.6 && (mem[k] ?? 0) <= 0.6;
  mem[k] = d;
  return fired;
}

/*
 * Rings on the water. Four slots; ring n lands in slot n % 4. A kick drops one at a hashed spot;
 * when the drums have been silent for a while a single slow ring spreads from the middle every few
 * seconds, so the break is never dead. `ringN` is stepped first and leaves the kind of ring it
 * started this frame in mem.ringKind (0 none, 1 kick, 2 quiet).
 */
const RINGS = 4;
const ringCount: ClockDef = {
  step: (v, f, _s, mem) => {
    mem.sinceDrum = f.audio.kickHit ? 0 : (mem.sinceDrum ?? 0) + f.dt;
    mem.sinceRing = (mem.sinceRing ?? 0.35) + f.dt;
    mem.idleT = (mem.idleT ?? 3) + f.dt;
    let kind = 0;
    if (f.audio.kickHit && mem.sinceRing > 0.3) kind = 1;
    else if (mem.sinceDrum > 1.4 && mem.idleT > 4.2) kind = 2;
    mem.ringKind = kind;
    if (!kind) return v;
    mem.sinceRing = 0;
    mem.idleT = 0;
    return (v + 1) % 997;
  },
};
const ringHit = (i: number, s: ClockState, mem: Record<string, number>) => (mem.ringKind ?? 0) > 0 && Math.round(s.ringN) % RINGS === i;
const ringSlot = (i: number): Record<string, ClockDef> => ({
  [`r${i}Age`]: { init: 100, step: (v, f, s, mem) => (ringHit(i, s, mem) ? 0 : Math.min(v + f.dt, 100)) },
  // across the frame, as a fraction of the half-width
  [`r${i}X`]: { step: (v, _f, s, mem) => (ringHit(i, s, mem) ? (mem.ringKind === 2 ? 0.12 + 0.3 * (hash(s.ringN) - 0.5) : (hash(s.ringN * 1.37) - 0.5) * 1.7) : v) },
  // down the water, as a fraction of its depth
  [`r${i}S`]: { step: (v, _f, s, mem) => (ringHit(i, s, mem) ? (mem.ringKind === 2 ? 0.42 : 0.16 + 0.6 * hash(s.ringN * 2.71 + 5)) : v) },
  // kick rings fade fast (the next one is coming); the quiet ring lingers
  [`r${i}Amp`]: {
    step: (v, f, s, mem) => {
      if (ringHit(i, s, mem)) {
        mem[`r${i}Fade`] = mem.ringKind === 2 ? 0.4 : 1.5;
        return mem.ringKind === 2 ? 0.9 : 0.45 + 0.55 * Math.min(1, f.audio.kick);
      }
      return v * Math.exp(-f.dt * (mem[`r${i}Fade`] ?? 1.5));
    },
  },
});

const counter = (hit: (f: FrameContext) => boolean): ClockDef => ({ step: (v, f) => (hit(f) ? (v + 1) % 997 : v) });

export const willow = defineClockedShaderScene(
  {
    id: 'willow',
    name: 'Willow',
    description:
      'A woodblock print of weeping willows over a still lake: curtains of hanging strands knitted from small leaf strokes in flat inks, black trunks, a thin shore with a bench and a few tiny figures, all mirrored in the water. Wind is the music: bass sends gusts across the curtain, each kick is a shiver from the trunk and a ring on the water, hats flick single leaves to the highlight ink and vocals drift patches of sun through the leaves. A build leans everything one way under a darkening sky, then the drop blows the curtain open so the sun rises through the gap and leaves fly.',
    category: 'form',
    style: 'world',
    fragment,
    tags: ['nature', 'organic', 'calm', 'nostalgic', 'graphic', 'tactile', 'dreamy', 'melancholic', 'acoustic', 'indie', 'spacious', 'tender'],
    params: [
      { id: 'density', label: 'Strand fineness', group: 'Shape', type: 'number', min: 0.6, max: 1.8, step: 0.01, default: 1, hint: 'Finer strands knit a tighter texture' },
      { id: 'horizon', label: 'Waterline', group: 'Shape', type: 'number', min: 0.22, max: 0.55, step: 0.005, default: 0.37, hint: 'How far up the frame the shore sits' },
      { id: 'figures', label: 'People on the shore', group: 'Shape', type: 'bool', default: true },
      { id: 'wind', label: 'Wind', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far the strands swing in the gusts' },
      { id: 'shiver', label: 'Kick shiver', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Each kick sends a shiver out from the trunk' },
      { id: 'rings', label: 'Water', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Kick rings and the ripples that smear the reflection' },
      { id: 'sparkle', label: 'Leaf flicker', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Hats flick single leaves to the highlight ink, snares light whole strands' },
      { id: 'gust', label: 'Drop gust', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'How far the drop blows the curtain open' },
      { id: 'sun', label: 'Highlight ink', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How much of the canopy prints in the highlight ink' },
      { id: 'grain', label: 'Print texture', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Paper tooth and uneven inking' },
    ],
    modulations: [
      { source: 'bass', param: 'wind', amount: 0.12 },
      { source: 'mid', param: 'sun', amount: 0.15 },
    ],
  },
  {
    // eased audio (rise, fall in seconds)
    sE: follow((f) => f.audio.energy, 1.0, 1.6),
    sBass: follow((f) => Math.max(f.audio.bass, 0.8 * f.audio.sub), 0.16, 0.55),
    sMid: follow((f) => f.audio.mid, 0.3, 0.8),
    sBuild: follow((f) => Math.max(f.audio.build, f.feel.tension) * (1 - f.audio.drop), 0.35, 0.3),
    // which side the shared wind blows toward (+1 right, -1 left), eased so a change swings the strands across
    wdir: follow((f) => (f.feel.windX >= 0 ? 1 : -1), 1.2, 1.2),
    // drop: one great gust that swells over a few frames and blows itself out over ~2 s
    blow: pulse(10, 0.7, 1.9, (f, _s, mem) => (dropFired(f, mem, 'blowPrev') ? 1.25 : 0)),
    // after a drop the place stays open and bright for as long as the energy holds
    bloom: {
      step: (v, f, s, mem) => {
        const calm = Math.max(0, 1 - 3 * s.sBuild);
        const tgt = sstep(0.72, 0.95, s.sE) * calm;
        if (!mem.bloomInit) {
          mem.bloomInit = 1;
          return tgt;
        }
        if (dropFired(f, mem, 'bloomPrev')) return 1;
        const hold = s.sE > 0.6 && s.sBuild < 0.1 ? Math.max(tgt, v) : tgt;
        return v + (hold - v) * (1 - Math.exp(-f.dt / (hold > v ? 3 : 1.4)));
      },
    },
    // how far the curtain is parted (it overshoots and swings back)
    open: spring(8, 0.5, (f, s) => clamp(num(f.params, 'gust', 0.85) * (s.blow + 0.42 * s.bloom + 0.06 * s.bloom * s.sBass), 0, 1.15)),
    // build: the strands lean; released at the drop they swing back through upright
    lean: spring(3.4, 0.3, (_f, s) => (0.9 * s.sBuild + 0.1 * s.bloom) * s.wdir),
    // snare: strand ends bounce one way, then the other
    flick: pulse(16, 0.6, 0.18, (f, _s, mem) => {
      if (!f.audio.snareHit) return 0;
      mem.snareSign = (mem.snareSign ?? 1) > 0 ? -1 : 1;
      return mem.snareSign * Math.max(0.2, Math.min(1, f.audio.snare));
    }),
    // integrated phases (speed changes never make them jump)
    idle: rateClock((f) => 0.45 + 0.9 * f.audio.energy),
    // the travelling gusts ride the shared wind's phase, so they carry straight on across a cut
    gustT: { step: (_v, f) => (f.feel.windPhase * 2.2) % 10000 },
    drift: { step: (v, f, s) => (v + f.dt * (0.05 + 0.3 * s.sMid)) % 10000 },
    // the water roughens with energy, bass and snares; mirror-flat when quiet
    rough: follow((f, s) => clamp(0.03 + 0.8 * sstep(0.15, 0.9, s.sE) + 0.3 * s.sBass * s.sE + 0.35 * f.audio.snare + 0.6 * s.blow, 0, 1.5), 0.12, 0.9),
    waterT: { step: (v, f, s) => (v + f.dt * (0.4 + 1.6 * s.rough)) % 10000 },
    // leaves in the air: a few tear loose late in a build, the drop strips a cloud of them
    leaves: follow((_f, s) => clamp(0.4 * s.blow + 0.07 * s.bloom * s.sE + 0.12 * s.sBuild * s.sBuild, 0, 0.6), 0.1, 1.6),
    leafT: { step: (v, f, s) => (v + f.dt * (0.3 + 1.5 * s.blow + 0.7 * s.sBuild + 0.4 * s.sE)) % 10000 },
    // kick shiver, snare and hat seeds
    sinceKick: sinceKickClock,
    kAmp: { step: (v, f) => (f.audio.kickHit ? 0.5 + 0.5 * Math.min(1, f.audio.kick) : v) },
    snareN: counter((f) => f.audio.snareHit),
    hatN: counter((f) => f.audio.hatHit),
    // rings on the water
    ringN: ringCount,
    ...ringSlot(0),
    ...ringSlot(1),
    ...ringSlot(2),
    ...ringSlot(3),
  },
);
