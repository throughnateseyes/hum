import { num } from '../../core/uniforms';
import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, rateClock, sinceKickClock } from '../shader/lib';
import { approach, beatsPerSecond } from '../three/common';

/**
 * Wing: one butterfly wing in extreme close-up on black, so big it runs off the frame. Fragile and
 * intimate: something small and alive, breathing.
 *
 * Everything is drawn in polar coordinates anchored at the wing root: the angle picks the cell
 * between two veins, the radius runs from root to margin. The wing is a flat plane hinged on the
 * body; opening and closing is a real rotation about that hinge with a little perspective.
 *
 * Palette roles: bg = the black behind the wing, and the velvet patch and eyespot pupils (they read
 * as holes through to it); fg = the cream membrane; accent = the coral blush and, mixed with muted,
 * the orange margin; accent2 = the thin electric rings round the eyespots and along the edge;
 * muted = the warm brown of the veins, striations and the furry body.
 */
const fragment = /* glsl */ `
${HM_LIB}
const float WG_A0 = 0.30;    // leading edge, radians above the wing axis
const float WG_A1 = -1.50;   // trailing edge
const float WG_N = 9.0;      // cells between the main veins; an eyespot sits in most of them
const float WG_D = 3.6;      // camera distance for the fold, in wing lengths
const float WG_BOW = 0.13;   // how much the whole wing bows (curves the leading edge)

float wgSmin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// angle of vein i as a 0..1 fraction of the fan: unevenly spaced, the two edges pinned
float wgVein(float i) {
  if (i < 0.5) return 0.0;
  if (i > WG_N - 0.5) return 1.0;
  return (i + 0.56 * (hash11(i * 5.37 + 2.1) - 0.5)) / WG_N;
}

// x = cell index, y = position across the cell 0..1, z = the cell's width (fraction of the fan)
vec3 wgCell(float th) {
  float i = clamp(floor(th * WG_N), 0.0, WG_N - 1.0);
  float a = wgVein(i);
  float b = wgVein(i + 1.0);
  if (th < a && i > 0.5) { i -= 1.0; b = a; a = wgVein(i); }
  else if (th > b && i < WG_N - 1.5) { i += 1.0; a = b; b = wgVein(i + 1.0); }
  return vec3(i, clamp((th - a) / max(b - a, 0.001), 0.0, 1.0), b - a);
}

// the outline without its scallops: a long leading edge, a waist, a fuller lower lobe
float wgBase(float th) {
  return mix(1.0, 0.8, th) + 0.085 * sin(th * 6.6 + 3.5);
}

// screen → the wing's own frame (root at the origin, +x out along the wing, y along the body)
vec2 wgPlace(vec2 p, float twist) {
  float land = smoothstep(0.7, 1.7, uAspect);
  vec2 rootPos = vec2(0.5 * uAspect - mix(0.03, 0.07, land), mix(0.2, 0.38, land));
  float sc = mix(0.82, 1.45, land) * u_size;
  vec2 s = (p - rootPos) * vec2(-1.0, 1.0);
  return rot2(mix(-0.07, -0.2, land) + twist) * s / sc;
}

// undo the fold: the wing is a plane rotated about the body axis by al, seen with perspective
vec2 wgUnfold(vec2 s, float al) {
  float ca = cos(al);
  float sa = sin(al);
  float x = s.x * WG_D / max(WG_D * ca + s.x * sa, 0.25);
  return vec2(x, s.y * (WG_D - x * sa) / WG_D);
}

// rough depth inside the silhouette (> 0 inside); used to seed the dust
float wgSil(vec2 p, float al) {
  vec2 q = wgUnfold(wgPlace(p, 0.0), al);
  q.y += WG_BOW * q.x * q.x;
  float r = length(q);
  float th = (WG_A0 - atan(q.y, q.x)) / (WG_A0 - WG_A1);
  return min(wgBase(clamp(th, 0.0, 1.0)) * 0.97 - r, min(th, 1.0 - th) * (WG_A0 - WG_A1) * r);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  if (u_mirror > 0.5) p.x = -p.x;

  float span = WG_A0 - WG_A1;
  float en = clamp(u_en, 0.0, 1.0);
  float tens = clamp(max(uBuild, uFeelTension) * u_tension, 0.0, 1.0);
  float sk = u_sinceKick;
  float sd = u_sinceDrop;
  float al = (1.0 - u_open) * 1.45;            // fold angle: 0 = flat open, ~83 deg = shut
  float tilt = 1.0 - cos(al);

  // ── place and unfold ──────────────────────────────────────────────────────
  vec2 s = wgPlace(p, 0.02 * uSnare);          // snares give the whole wing a tiny twitch
  vec2 q = wgUnfold(s, al);
  q.y += WG_BOW * q.x * q.x;
  float r = length(q);
  float th = (WG_A0 - atan(q.y, q.x)) / span;  // 0 = leading edge … 1 = trailing edge
  float thc = clamp(th, 0.0, 1.0);
  // the veins bow a little on their way out (pinned at both edges), with a hand-drawn wobble
  float thw = thc + 0.085 * (r - 0.45) * 4.0 * thc * (1.0 - thc);
  thw += 0.004 * snoise(vec2(thc * 11.0, r * 5.0)) * smoothstep(0.0, 0.1, thc) * (1.0 - smoothstep(0.9, 1.0, thc));
  thw = clamp(thw, 0.0, 1.0);
  vec3 cell = wgCell(thw);
  float ci = cell.x;
  float cf = cell.y;
  float cw = cell.z;

  // ── silhouette: a scalloped margin r = R(theta), a lobe per cell with a notch at each vein ──
  float base = wgBase(thw);
  float u2 = 2.0 * cf - 1.0;
  float scal = 0.06;
  float R = base * (1.0 - scal * abs(u2) * u2 * u2);
  float dR = base * scal * 6.0 * u2 * u2 / cw;                          // |dR/dtheta|
  float dm = (R - r) / sqrt(1.0 + pow(dR / (span * max(r, 0.2)), 2.0)); // distance in from the margin
  float dEdge = min(th, 1.0 - th) * span * r;                           // … and from the two straight edges
  float din = min(dm, dEdge);
  float rn = r / base;
  float aa = fwidth(din) + 1e-5;
  float inside = smoothstep(-aa, aa, din);
  float px = fwidth(r) + 1e-5;

  // ── the kick pulse: light runs root → margin along the veins, and lands on the eyespots ──
  float tArr = 0.3;                                                     // seconds to reach the margin
  float kAmp = u_pulse * u_kickAmp;
  float front = sk / tArr * 0.92;
  float pulse = exp(-pow((rn - front) / 0.16, 2.0)) * exp(-sk * 1.6) * kAmp * step(sk, 3.0);
  float arrive = smoothstep(tArr - 0.09, tArr, sk) * exp(-max(sk - tArr, 0.0) * 6.0) * kAmp;
  // a build gathers the light back at the root
  float gather = tens * exp(-rn * (5.0 - 3.0 * tens));

  // ── eyespots: ringed discs just inside each scallop (own cell + neighbours so rings can merge) ──
  float ds = 1e3;
  float swell = 1.0 + 0.28 * uBass + 0.16 * uSub + 0.5 * arrive - 0.3 * tens;
  for (int k = -1; k <= 1; k++) {
    float j = ci + float(k);
    if (j < 0.5 || j > WG_N - 1.5) continue;
    float va = wgVein(j);
    float vb = wgVein(j + 1.0);
    float tc = 0.5 * (va + vb);
    float h = hash11(j * 3.17 + 7.3);
    float rad = u_spots * (0.016 + 0.03 * h * h) * swell;
    float rc = wgBase(tc) * (0.885 - 0.035 * h);
    ds = min(ds, length(vec2((thw - tc) * span * rc, r - rc)) - rad);
  }
  // contour field: distance in from the margin band and out from the pupils, smoothly joined, so the
  // rings wrap spots and margin together like a contour map
  // (toward the inner margin the bands peel off the edge, and the wing sinks into the body's shadow)
  float inner = smoothstep(0.84, 1.0, thw);
  float dmB = dm + 0.3 * inner;
  float rim = 0.026;
  float m = wgSmin(dmB - rim, ds, 0.04) + 0.012 * (vnoise(q * 42.0) - 0.5);
  float am = fwidth(m) + 1e-5;

  // ── veins ──
  // each cell is zipped: two minor veins fork off the main ones part-way out and settle at 1/3 and 2/3
  float fh = hash11(ci * 7.7 + 1.3);
  float fh2 = hash11(ci * 4.1 + 8.6);
  float rfL = base * (0.22 + 0.3 * fh);
  float rfR = base * (0.2 + 0.3 * fh2);
  float aL = smoothstep(rfL, rfL + 0.4, r) / 3.0;
  float aR = smoothstep(rfR, rfR + 0.4, r) / 3.0;
  float cz = (1.0 / 3.0) + (cf - aL) / max(1.0 - aL - aR, 0.01) / 3.0;
  if (cf < aL) cz = cf / max(aL, 1e-4) / 3.0;
  if (cf > 1.0 - aR) cz = 1.0 - (1.0 - cf) / max(aR, 1e-4) / 3.0;
  float arc = cw * span * r;                                            // the cell's width here
  float taper = mix(1.5, 0.55, smoothstep(0.0, 1.0, rn));
  float dv = min(cf, 1.0 - cf) * arc;
  float vW = 0.003 * taper;
  float vein = 1.0 - smoothstep(vW - px, vW + px, dv);
  float dv2 = min(abs(cf - aL) + step(aL, 0.004), abs(cf - 1.0 + aR) + step(aR, 0.004)) * arc;
  float vW2 = vW * 0.6;
  float vein2 = 1.0 - smoothstep(vW2 - px, vW2 + px, dv2);
  float veinSoft = max(exp(-dv / 0.012), 0.7 * exp(-dv2 / 0.009));
  float veinMask = smoothstep(rim * 0.6, rim * 1.6, dmB);

  // ── membrane ──────────────────────────────────────────────────────────────
  vec3 ink = uBg;
  vec3 cream = uFg;
  vec3 brown = uMuted;
  vec3 orange = mix(uAccent, uMuted, 0.42);
  vec3 pink = mix(uFg, uAccent, 0.5);
  // thin-film edge colour: slides with brightness / air and with the viewing angle
  float irid = clamp(0.7 * uBrightness + 0.9 * uAir + 0.3 * uSnare, 0.0, 1.0);
  float film = 0.5 + 0.5 * sin(thw * 17.0 + al * 5.0 + irid * 4.0 + r * 6.0);
  vec3 blue = mix(uAccent2, uFg, 0.22 * film * irid);
  blue = mix(blue, uAccent, 0.16 * (1.0 - film) * irid);

  // soft painterly tone, stretched along the veins, and long brushed streaks
  float tone = fbm(vec2(thw * 6.0, r * 2.4) + 3.7, 2);
  float tone2 = snoise(vec2(thw * 2.6 + 9.0, r * 1.7 - 2.0));
  float streak = vnoise(vec2(thw * 150.0, r * 1.6 + 4.0)) - 0.5;
  vec3 shadow = mix(cream, brown, 0.55);
  vec3 col = mix(cream, shadow, clamp(0.1 + 0.3 * smoothstep(-0.3, 0.6, tone) + 0.22 * streak, 0.0, 1.0));
  // each cell is a shallow pleat: lighter along its middle, shaded toward the veins
  float dome = sin(PI * cf);
  col = mix(col, shadow, (1.0 - dome) * 0.22);
  // blush: a coral wash inside the margin bands and over the leading shoulder; mids warm it
  float warm = u_blush * (0.5 + 0.5 * uMid + 0.2 * uLowMid);
  float bl = (1.0 - smoothstep(0.02, 0.3, m)) * (0.7 + 0.4 * tone2);
  bl += 0.7 * exp(-pow((thw - 0.1) / 0.14, 2.0)) * smoothstep(0.3, 0.8, rn) * (0.7 + 0.3 * tone);
  bl += 0.22 * smoothstep(0.0, 0.7, tone2) * smoothstep(0.3, 0.8, rn);
  bl *= 0.85 + 0.5 * streak;
  col = mix(col, pink, clamp(bl * warm, 0.0, 0.9));
  col = mix(col, uAccent, clamp((1.0 - smoothstep(0.05, 0.16, m)) * 0.42 * warm, 0.0, 0.7));

  // fine striations between the veins (their count differs per cell), faded where they get too dense
  float strN = 9.0 + 3.0 * step(0.5, hash11(ci * 2.3 + 0.7));
  float su = cz * strN + 0.2 * dome * snoise(vec2(r * 6.0, ci * 3.1 + cz * 2.0));
  float sw = fwidth(su);
  float sdist = abs(su - floor(su + 0.5));
  float sbreak = 0.55 + 0.45 * vnoise(vec2(floor(su + 0.5) * 7.3 + ci * 31.0, r * 9.0));
  float sline = (1.0 - smoothstep(0.05, 0.05 + max(sw, 0.02) * 1.5, sdist)) * sbreak;
  float sfade = (1.0 - smoothstep(0.25, 0.7, sw)) * smoothstep(0.08, 0.28, rn) * smoothstep(-0.01, 0.07, m);
  col = mix(col, mix(col, brown, 0.6) * 0.85, sline * sfade * 0.5);
  // wet ridge: a light edge beside every striation
  float sridge = 1.0 - smoothstep(0.0, 0.2, abs(fract(su) - 0.24));
  col = mix(col, cream, sridge * sfade * 0.2);

  // ── the velvet patch near the root, with a warm halo round it ──
  float pSwell = 1.0 + 0.25 * uBass + 0.2 * uSub + 0.25 * gather;
  vec2 pd = vec2((thw - 0.6) * span * 0.36, (r - 0.265) * 0.72);
  float feather = (vnoise(vec2(thw * 130.0, r * 2.2)) - 0.5) * 0.06 * smoothstep(0.12, 0.45, r);
  float dp = length(pd) - 0.1 * pSwell + feather;
  vec3 amber = mix(uMuted, uFg, 0.3);
  col = mix(col, amber, exp(-max(dp, 0.0) / 0.06) * 0.75);
  col = mix(col, mix(uMuted, uAccent, 0.3), exp(-max(dp, 0.0) / 0.028) * 0.8);

  // ── margin bands and eyespot rings on the contour field ──
  float snap = 0.35 * uSnare;                                          // snares flare the rings
  float b1 = 0.008 * (1.0 + snap);
  float b2 = 0.035;
  float b3 = 0.047;
  float bandO = smoothstep(b2 - am, b2 + am, m) * (1.0 - smoothstep(b3, b3 + 0.014, m));
  col = mix(col, orange, bandO * 0.85);
  float bandC = 1.0 - smoothstep(b2 - am, b2 + am, m);
  col = mix(col, mix(cream, shadow, 0.16 + 0.14 * (1.0 - dome) + 0.14 * tone), bandC);
  // the notches between the lobes pool with blue
  float notch = smoothstep(0.5, 1.0, abs(u2)) * (1.0 - smoothstep(0.015, 0.075, dmB - rim)) * step(0.0, dmB - rim);
  col = mix(col, blue, notch * (0.45 + 0.35 * film));
  // a faint second ring inside the cream, like a contour line
  col = mix(col, mix(cream, orange, 0.55), bandC * (1.0 - smoothstep(0.0, 0.004 + am, abs(m - 0.024))) * 0.4);
  float bandB = 1.0 - smoothstep(b1 - am, b1 + am, m);
  col = mix(col, blue, bandB);
  // the outermost rim: orange, hatched with fine dark lines, a blue thread on its inner side
  float inRim = 1.0 - smoothstep(rim - am, rim + am, dmB);
  float hx = cf * 26.0 + r * 3.0;
  float hatch = 1.0 - smoothstep(0.1, 0.1 + max(fwidth(hx), 0.02) * 1.5, abs(fract(hx) - 0.5));
  vec3 rimCol = mix(orange, ink, hatch * 0.3);
  rimCol = mix(rimCol, blue, (1.0 - smoothstep(0.0, 0.007, abs(dmB - rim * 0.78))) * (0.5 + 0.5 * film));
  col = mix(col, rimCol, inRim * step(0.0, ds));

  // the veins themselves, with a wet highlight riding one side
  vec3 veinCol = mix(brown, ink, 0.3);
  col = mix(col, veinCol, max(vein, vein2 * 0.85) * veinMask * 0.85);
  float vhl = (1.0 - smoothstep(vW * 1.2, vW * 3.4, dv)) * step(cf, 0.5) * (1.0 - vein);
  col = mix(col, cream, vhl * veinMask * 0.22);

  // the patch and the pupils go on last: holes through to the background
  float patchM = 1.0 - smoothstep(-0.03, 0.03, dp);
  col = mix(col, mix(ink, brown, 0.05 + 0.05 * tone), patchM);
  float pupil = 1.0 - smoothstep(-am, am, ds);
  col = mix(col, ink, pupil);
  // a darker dusting where the wing meets the body
  col = mix(col, mix(ink, brown, 0.25), exp(-r / 0.07) * 0.9);
  // … and along the inner margin, where it sinks into the body's shadow
  float sink = smoothstep(0.78, 0.99, thw + 0.03 * streak);
  col = mix(col, ink, sink * 0.96);

  // ── how awake the colour is ──
  // follows the song's energy; at a drop it blooms from the root out to the margin
  float bfront = sd * 2.1;
  float ahead = smoothstep(bfront - 0.3, bfront, rn);                  // 1 where the bloom has not reached yet
  float bloom = (1.0 - ahead) * exp(-sd * 0.45) * step(sd, 30.0);
  float held = ahead * (1.0 - smoothstep(0.45, 0.75, sd));             // the margin stays dark until it arrives
  float wake = max(smoothstep(0.05, 0.55, en), bloom) * (1.0 - 0.65 * max(tens, held));
  float rich = max(smoothstep(0.3, 0.9, en), bloom);
  // in the dark only the edge and the rings keep their colour
  float edgeKeep = max(1.0 - smoothstep(0.0, 0.09, min(m + rim, din * 2.2)), 0.0);
  float lev = mix(0.1 + 0.62 * edgeKeep, 1.0, wake);
  // folded wings turn away from the light; a soft wet sheen sweeps out as it opens
  float shade = 1.0 - tilt * (0.25 + 0.45 * smoothstep(0.0, 1.0, q.x));
  // the shared light (uFeelLight, screen angle) in the wing's own frame: +x out along the wing, +y up the body
  vec2 ls = vec2(cos(uFeelLight), sin(uFeelLight));
  if (u_mirror > 0.5) ls.x = -ls.x;
  vec2 lw = rot2(mix(-0.07, -0.2, smoothstep(0.7, 1.7, uAspect))) * (ls * vec2(-1.0, 1.0));
  // the sheen sits toward the side the light comes from: further out when lit from beyond the tip,
  // nearer the root when lit from behind the body, along the leading edge when lit from above
  float sheen = exp(-pow((q.x - (0.12 + 0.8 * u_open + 0.16 * lw.x)) / 0.24, 2.0)) * (0.08 + 0.25 * tilt);
  sheen *= 1.0 + 0.45 * lw.y * (1.0 - 2.0 * thc);
  float gloss = sheen * (0.6 + 1.6 * exp(-pow((cf - 0.36) / 0.13, 2.0)));
  col = hmSat(col, mix(0.62, 1.18, rich));
  col = mix(col, cream, gloss * (1.0 - patchM) * (1.0 - pupil));
  col = mix(uBg, col, clamp(lev * shade, 0.0, 1.0));

  // light in the wiring (screened on, so it glows in the dark and warms the lit membrane)
  vec3 hot = mix(uAccent, uFg, 0.55);
  float lit = pulse + gather * 1.15 + 0.16 * rich;
  float vglow = veinSoft * veinMask * lit * 0.95 + max(vein, vein2) * veinMask * lit * 0.8;
  // … and it lands on the rings
  vglow += arrive * (1.0 - smoothstep(0.0, 0.05, abs(m - 0.015))) * 0.45;
  col = 1.0 - (1.0 - col) * (1.0 - hot * clamp(vglow, 0.0, 1.0) * (1.0 - pupil) * (1.0 - 0.7 * patchM));

  // hats: scale-glitter, single scales catching the light along the striations
  vec2 gid = vec2(floor(su) + ci * 37.0, floor(r * 60.0));
  float gh = hash21(gid + floor(u_hatSeed) * 17.0);
  vec2 gf = vec2(fract(su), fract(r * 60.0)) - 0.5;
  float spark = step(0.9, gh) * exp(-dot(gf, gf) * 60.0) * uHat * uHat * u_glitter * sfade * (1.0 - patchM) * (1.0 - sink);
  col = mix(col, mix(uFg, uAccent2, step(0.975, gh) * 0.6), clamp(spark * 2.2, 0.0, 1.0));

  // ── outside: the glow that makes the edge sit wet against the black ──
  float dout = max(-din, 0.0);
  float gl = u_glow * (0.3 + 0.5 * wake + 0.2 * uKick * u_pulse + 0.5 * arrive + 0.3 * tens);
  vec3 glowCol = mix(orange, blue, 0.25 + 0.3 * film);
  float halo = exp(-dout / 0.01) * 0.8 + exp(-dout / 0.05) * 0.2;
  vec3 outside = mix(uBg, glowCol, clamp(halo * gl, 0.0, 0.9) * smoothstep(0.03, 0.2, r) * (1.0 - smoothstep(0.8, 1.02, th)));
  col = mix(outside, col, inside * (1.0 - smoothstep(0.93, 1.0, th)));
  // root glow: the build's gathered light, and a breath of it on every kick
  float rootGlow = exp(-r / 0.16) * (0.9 * tens + 0.25 * exp(-sk * 5.0) * kAmp);
  col = 1.0 - (1.0 - col) * (1.0 - hot * clamp(rootGlow, 0.0, 0.9));

  // ── the body: a dark furry sliver along the hinge (it does not fold) ──
  vec2 bq = (s - vec2(-0.085, -0.12)) / vec2(0.1, 0.6);
  float bd = length(bq) - 1.0;
  float hair = vnoise(vec2((s.y + s.x * 0.9) * 170.0, s.x * 14.0 - s.y * 3.0));
  float hair2 = vnoise(vec2((s.y + s.x * 0.9) * 55.0 + 7.0, s.x * 6.0));
  float bodyM = 1.0 - smoothstep(-0.3, 0.02 + 0.3 * (hair - 0.5) + 0.14 * (hair2 - 0.5), bd);
  vec3 bodyCol = mix(mix(ink, brown, 0.14), mix(ink, brown, 0.5), smoothstep(0.45, 0.95, hair) * hair2);
  // the hairs catch the light along the body's edge
  bodyCol = mix(bodyCol, mix(brown, cream, 0.2), smoothstep(-0.3, 0.05, bd) * smoothstep(0.7, 1.0, hair) * hair2 * 0.6);
  bodyCol = mix(uBg, bodyCol, 0.3 + 0.7 * max(wake, 0.7 * tens));
  col = mix(col, bodyCol, bodyM);

  // ── drop: a scatter of scale-dust lifts off the wing and drifts up ──
  if (sd < 5.0 && u_dust > 0.001) {
    float dust = 0.0;
    for (int l = 0; l < 2; l++) {
      float fl = float(l);
      float sc = 30.0 + 22.0 * fl;
      float rise = (1.0 - exp(-sd * (0.9 + 0.3 * fl))) * (0.16 + 0.1 * fl);
      vec2 g0 = (p - vec2(0.02 * (fl - 0.5), rise)) * sc;
      vec2 id = floor(g0);
      vec2 hh = hash22(id + fl * 31.0);
      vec2 o = (hh - 0.5) * 0.6 + 0.22 * vec2(sin(sd * 1.7 + hh.x * TAU), cos(sd * 1.3 + hh.y * TAU)) * min(sd, 1.0);
      float d = length(fract(g0) - 0.5 - o);
      float born = step(0.0, wgSil((id + 0.5) / sc, al)) * step(0.5, hash21(id + 5.0 + fl));
      float tw = 0.55 + 0.45 * sin(sd * 11.0 + hh.y * 40.0);
      dust += (1.0 - smoothstep(0.02, 0.1 - 0.03 * fl, d)) * born * tw;
    }
    float life = smoothstep(0.0, 0.12, sd) * exp(-sd * 0.9);
    col = mix(col, mix(uFg, uAccent, 0.3), clamp(dust * life * u_dust, 0.0, 1.0));
  }

  col += hmGrain(fc, uTime) * 0.03;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── Clocks ───────────────────────── */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The song's energy, eased over a second or two (rises faster than it falls). */
const energyClock: ClockDef = {
  init: -1,
  step: (v, f) => {
    const e = clamp01(f.audio.energy);
    return v < 0 ? e : approach(v, e, e > v ? 1.4 : 0.7, f.dt);
  },
};

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

/** Strength of the last kick, held until the next one. */
const kickAmpClock: ClockDef = { step: (v, f) => (f.audio.kickHit ? Math.max(0.35, f.audio.kick) : v) };

/** Counts hats, so each one lights a different handful of scales. */
const hatSeedClock: ClockDef = { step: (v, f) => (f.audio.hatHit ? (v + 1) % 997 : v) };

/** Tremble phase: speeds up through a build. */
const trembleClock: ClockDef = {
  step: (v, f) => {
    const b = clamp01(Math.max(f.audio.build, f.feel.tension));
    return (v + f.dt * Math.PI * 2 * (3 + 9 * b * b)) % (Math.PI * 200);
  },
};

/**
 * How open the wing is (0 = shut, 1 = flat open; it can overshoot a little). A damped spring chases
 * a target set by the energy, a slow breath once a bar, the build (folds it shut) and the drop
 * (snaps it open); kicks flick it.
 */
const openClock: ClockDef = {
  init: 0.3,
  step: (_v, f, s, mem) => {
    const a = f.audio;
    const dt = Math.min(f.dt, 0.05);
    const e = smooth(0.08, 0.92, s.en);
    const tension = clamp01(Math.max(a.build, f.feel.tension)) * num(f.params, 'tension', 0.85);
    let target = 0.3 + 0.7 * e;
    // the breath: one slow close-and-open per bar, shallower when the wing is wide open
    const depth = num(f.params, 'breath', 0.5) * (0.34 - 0.16 * e);
    target -= depth * (0.5 - 0.5 * Math.cos(Math.PI * 2 * s.bar));
    target += (0.04 * a.bass + 0.03 * a.sway) * (1 - tension);
    target += (0.05 - target) * Math.pow(tension, 0.75);
    target += (1.04 - target) * clamp01(a.drop * 1.6);

    let x = mem.openX ?? target;
    let vel = mem.openVel ?? 0;
    if (a.kickHit) vel -= 0.55 * num(f.params, 'pulse', 1) * (0.5 + 0.5 * a.kick) * (1 - 0.6 * tension);
    const d = a.drop;
    if (d > 0.6 && (mem.openDropPrev ?? 0) <= 0.6) vel += 5;
    mem.openDropPrev = d;
    // stiffer through the drop so the snap is fast
    const k = 70 + 160 * clamp01(d);
    const damp = 2 * Math.sqrt(k) * 0.62;
    vel += (k * (target - x) - damp * vel) * dt;
    x += vel * dt;
    mem.openX = x;
    mem.openVel = vel;
    const tremble = 0.035 * tension * Math.sin(s.trem) * (0.4 + 0.6 * tension);
    return Math.min(1.12, Math.max(0.02, x + tremble));
  },
};

export const wing = defineClockedShaderScene(
  {
    id: 'wing',
    name: 'Wing',
    description:
      'One butterfly wing in extreme close-up on black: veins fanning from the root across a cream and coral membrane, a velvet-black patch, a scalloped margin of ringed eyespots. It breathes open and shut with the tempo; each kick sends light down the veins to the eyespots, which dilate as it lands. Quiet parts fold it nearly shut and dim, a build trembles it closed and a drop snaps it open in full colour with a lift of scale-dust.',
    category: 'form',
    style: 'world',
    fragment,
    tags: ['nature', 'organic', 'tender', 'dreamy', 'calm', 'romantic', 'warm', 'indie', 'acoustic', 'cinematic', 'tactile', 'ambient'],
    params: [
      { id: 'size', label: 'Close-up', group: 'Shape', type: 'number', min: 0.6, max: 1.6, step: 0.01, default: 1, hint: 'How much of the frame the wing fills' },
      { id: 'spots', label: 'Eyespots', group: 'Shape', type: 'number', min: 0, max: 1.8, step: 0.01, default: 1 },
      { id: 'mirror', label: 'Mirror', group: 'Shape', type: 'bool', default: false, hint: 'Hang the wing from the other side' },
      { id: 'breath', label: 'Breath', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.5, hint: 'How far it closes and opens once a bar' },
      { id: 'pulse', label: 'Vein pulse', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Kicks send light from the root down the veins; the eyespots dilate when it lands' },
      { id: 'tension', label: 'Build fold', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'Build-ups tremble the wing shut and gather the glow at the root' },
      { id: 'glitter', label: 'Scale glitter', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Hats catch single scales along the striations' },
      { id: 'dust', label: 'Drop dust', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Scale-dust lifts off when the wing snaps open' },
      { id: 'blush', label: 'Blush', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.9, hint: 'The coral wash; mids warm it' },
      { id: 'glow', label: 'Edge glow', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
    ],
    modulations: [
      { source: 'mid', param: 'blush', amount: 0.12 },
      { source: 'sway', param: 'glow', amount: 0.1 },
    ],
  },
  {
    en: energyClock,
    bar: rateClock((f) => beatsPerSecond(f) / 4),
    trem: trembleClock,
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    sinceDrop: sinceDropClock,
    hatSeed: hatSeedClock,
    open: openClock,
  },
);
