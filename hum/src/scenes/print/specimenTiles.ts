import type { AudioFrame } from '../../core/types';
import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, speedClock } from '../shader/lib';

/**
 * Specimen Tiles — a lab sheet of sound. A grid of rounded tiles printed on paper, each one a
 * small plate resonating to one part of the song (cymatics): kick tiles are glowing "suns" whose
 * core swells on every kick, snare tiles are Chladni figures that snap to a new mode on the hit,
 * hat tiles flicker fine speckle, and the rest follow one band each as breathing rings, bulging
 * woven grids, spots that grow and merge into honeycomb, and stripes that bend with the waveform.
 *
 * The feeling: curious and warm, a 70s lab notebook that turns out to be alive.
 *
 * Arc — quiet: most tiles are a flat tone with a faint slow figure, a few awake. Verse: tiles wake
 * by energy and step up through their modes on the hits. Build: tiles fall into the same ring
 * pattern one after another, a wave of agreement crossing the sheet, tightening and darkening.
 * Drop: every tile jumps to its inverse and reshuffles to a new family at once, then the whole
 * sheet buzzes for the chorus. Break: they drift back to quiet individual patterns.
 *
 * Palette roles — bg: the paper. fg: the contrast ink (near-black on a light sheet) and the rims
 * of the sun tiles. accent: the main ink (orange) and the body of the suns. accent2: second ink
 * (magenta). muted: third ink (mustard) and the tint of aged paper. Every other tone on the sheet
 * is a mix of two of those (amber, plum, slate, olive, vermilion), so any palette gives a full shelf.
 */
const fragment = /* glsl */ `
${HM_LIB}

// rounded box: b = half size, r = corner radius
float stBox(vec2 p, vec2 b, float r) { return sdBox(p, b - r) - r; }

// 0 at the centre, 1 on a squircle through the tile's edge: rings that stay rounded all the way in
float stSq(vec2 p, vec2 b) { vec2 q = p / b; q *= q; q *= q; return sqrt(sqrt(q.x + q.y)); }

float stPick(float i, float a, float b, float c, float d, float e, float f) {
  if (i < 0.5) return a;
  if (i < 1.5) return b;
  if (i < 2.5) return c;
  if (i < 3.5) return d;
  if (i < 4.5) return e;
  return f;
}

// the ink shelf: the five palette colours plus two-colour mixes
vec3 stInk(float i) {
  if (i < 1.0) return uFg;
  if (i < 3.0) return uAccent;
  if (i < 4.0) return uAccent2;
  if (i < 5.0) return uMuted;
  if (i < 6.0) return mix(uAccent, uMuted, 0.5);    // amber
  if (i < 7.0) return mix(uAccent2, uFg, 0.55);     // plum
  if (i < 8.0) return mix(uFg, uBg, 0.42);          // slate
  if (i < 9.0) return mix(uBg, uMuted, 0.35);       // pale
  if (i < 10.0) return mix(uMuted, uFg, 0.45);      // olive
  if (i < 11.0) return mix(uAccent, uAccent2, 0.5); // vermilion
  return mix(uFg, uAccent2, 0.22);                  // deep
}

// grounds lean on the main ink and the dark, the way a real sheet is mostly two or three inks
vec3 stGround(float x) {
  if (x < 0.25) return uAccent;
  if (x < 0.38) return mix(uAccent, uMuted, 0.5);
  if (x < 0.50) return uMuted;
  if (x < 0.62) return mix(uFg, uAccent2, 0.22);
  if (x < 0.72) return uFg;
  if (x < 0.79) return uAccent2;
  if (x < 0.85) return mix(uAccent, uAccent2, 0.5);
  if (x < 0.90) return mix(uAccent2, uFg, 0.55);
  if (x < 0.95) return mix(uFg, uBg, 0.42);
  return mix(uBg, uMuted, 0.35);
}

// Chladni figure of a square plate (x in 0..1), scaled to roughly a distance. Higher k = busier.
float stChladni(vec2 x, float k, vec2 sd) {
  float n = 1.0 + min(k, 4.0) + floor(sd.x * 2.0);
  float m = n + 1.0 + mod(floor(k * 1.5 + sd.y * 3.0), 3.0);
  float sg = mod(k + floor(sd.y * 2.0), 2.0) < 0.5 ? 1.0 : -1.0;
  float f = cos(n * PI * x.x) * cos(m * PI * x.y) + sg * cos(m * PI * x.x) * cos(n * PI * x.y);
  return f / (PI * 0.5 * (n + m));
}

// woven grid: rounded blocks (kind 0) or cross-hatch threads (kind 1), in cell units
float stWeave(vec2 w, float sz, float kind) {
  vec2 c = abs(fract(w) - 0.5);
  if (kind < 0.5) return -(sdBox(c, vec2(sz - 0.07)) - 0.07);
  return sz * 0.6 - min(c.x, c.y);
}

// offset to the nearest centre of a hex lattice (centres 1 apart)
vec2 stHex(vec2 w) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(w, s) - s * 0.5;
  vec2 b = mod(w - s * 0.5, s) - s * 0.5;
  return dot(a, a) < dot(b, b) ? a : b;
}
float stHexD(vec2 c) { c = abs(c); return max(c.x, dot(c, vec2(0.5, 0.8660254))); }

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, min(uResolution.x, uResolution.y) / 1080.0);
  float t = u_clk;

  // ── the sheet: whole tiles inside a paper margin; the short side holds u_count of them
  float margin = min(uResolution.x, uResolution.y) * 0.03;
  vec2 area = uResolution - 2.0 * margin;
  float n = max(1.0, floor(u_count + 0.5));
  vec2 cnt = uAspect >= 1.0
    ? vec2(max(1.0, floor(area.x / area.y * n / 1.06 + 0.5)), n)
    : vec2(n, max(1.0, floor(area.y / area.x * n * 1.06 + 0.5)));
  vec2 cellPx = area / cnt;
  vec2 g = (fc - margin) / cellPx;
  vec2 id = clamp(floor(g), vec2(0.0), cnt - 1.0);
  vec2 lp = (g - id - 0.5) * cellPx;
  float gut = u_gutter * min(cellPx.x, cellPx.y);
  vec2 hpx = (cellPx - gut) * 0.5;
  float S = min(hpx.x, hpx.y);          // px per tile unit (the short half-side is 1)
  float px = 1.0 / S;
  vec2 hb = hpx / S;
  vec2 tuv = (id + 0.5) / cnt;

  vec2 h = hash22(id + 17.3);
  vec2 h2 = hash22(id * 1.7 + 41.9);

  // ── section state
  // build: tiles agree one after another, sweeping along the long side of the sheet
  float ord = uAspect >= 1.0 ? tuv.x * 0.86 + (1.0 - tuv.y) * 0.14 : (1.0 - tuv.y) * 0.86 + tuv.x * 0.14;
  float front = u_bld * u_agree * 1.14 - ord * 0.9 - 0.05 - (h.x - 0.5) * 0.05;
  float agree = step(0.0, front);
  float frontFade = smoothstep(0.0, 0.05, abs(front));   // a tile blanks for a moment as it switches
  float tight = agree * clamp(u_bld * u_agree, 0.0, 1.0);

  // drop: the thump runs outward from the centre of the sheet, the flash is everywhere at once
  float cdist = length(tuv - 0.5);
  // (for the first 0.11 s the old sheet stands as its own negative, then the new one lands)
  float inv = step(u_sd, 0.11);
  float sdl = u_sd - 0.11 - cdist * 0.2;
  float pop = sdl > 0.0 ? exp(-sdl * 5.0) * (1.0 - exp(-sdl * 40.0)) : 0.0;
  float glare = (1.0 - inv) * exp(-max(u_sd - 0.11, 0.0) * 5.0);

  // energy wakes the tiles, each at its own threshold
  float th = hash21(id * 3.1 + 5.5);
  float wake = clamp((u_en * 1.25 + (u_wake - 0.5) * 1.3 + 0.06 - th) / 0.2, 0.0, 1.0);
  wake = max(wake, agree);

  // ── family + source. Reshuffled by every drop; single tiles also swap on a kick now and then
  float gen = (u_dropN - inv) * 3.0 + floor((u_kickN + floor(h.y * 64.0)) / 64.0);
  float fh = hash21(id * 1.31 + vec2(gen * 7.13, 3.7 + gen * 1.9));
  vec3 hc = vec3(hash22(id * 2.3 + 7.1 + gen * 13.7), hash21(id * 0.7 + 2.9 + gen * 5.3));
  float fam = 6.0;                       // speckle  (hat)
  if (fh < 0.16) fam = 0.0;              // sun      (kick)
  else if (fh < 0.33) fam = 1.0;         // chladni  (snare / band)
  else if (fh < 0.48) fam = 2.0;         // rings    (band)
  else if (fh < 0.62) fam = 3.0;         // woven    (band)
  else if (fh < 0.77) fam = 4.0;         // cells    (band)
  else if (fh < 0.89) fam = 5.0;         // stripes  (band)
  if (agree > 0.5) fam = 2.0;

  float bi = floor(h.x * 6.0);
  float L = stPick(bi, u_l0, u_l1, u_l2, u_l3, u_l4, u_l5);
  float M = stPick(bi, u_m0, u_m1, u_m2, u_m3, u_m4, u_m5);
  float slice = spectrum(0.03 + 0.75 * h2.y);
  float wav = waveform(0.5 + 0.07 * (h2.x < 0.4 ? lp.y : lp.x) / S);

  float src = clamp(0.75 * L + 0.5 * slice, 0.0, 1.0);
  if (fam < 0.5) src = uKick;
  else if (fam > 5.5) src = max(uHat, 0.6 * uAir);
  else if (fam < 1.5 && h2.x < 0.55) src = 0.45 + 0.55 * uSnare;
  float amp = wake * clamp(0.22 + 0.85 * src * u_react, 0.0, 1.0);
  amp = mix(amp, 0.6 + 0.4 * u_bld, agree);

  // ── tile space. Each tile sits a hair off the grid, thumps on kicks and pops on the drop
  vec2 P = lp / S;
  P -= (h2 - 0.5) * 0.05;
  P = rot2((h.y - 0.5) * 0.035) * P;
  P /= 1.0 + (0.01 + 0.03 * u_en) * uKick * wake + 0.11 * pop * u_react;
  float d = stBox(P, hb, u_round);
  // a loud plate buzzes
  vec2 Pv = P + 0.012 * amp * u_en * vec2(sin(t * 61.0 + h.x * 40.0), cos(t * 53.0 + h.y * 40.0));
  // second ink is printed a touch off register
  float ra = h2.x * TAU;
  // ...and a plate that is really moving doubles
  vec2 off = u_misreg * (2.0 * pxs * px + 0.01) * (1.0 + 2.2 * amp * u_en) * vec2(cos(ra), sin(ra));
  vec2 Pb = Pv + off;
  float lensR = clamp(dot(Pv / hb, Pv / hb) * 0.5, 0.0, 1.0);

  float w0 = 1.2 * pxs * px + 0.012;     // scanned-print softness
  float fA = -1.0;                        // main ink field, tile units, > 0 = ink
  float fB = -1.0;                        // second ink field
  float wA = w0;
  float wB = w0 * 1.6;
  float oB = 0.55;
  float sunHeat = 0.0;
  float sand = hash21(floor(fc / (1.6 * pxs)) + id * 9.1) - 0.5;

  if (fam < 0.5) {
    // sun: a soft rounded core inside a body inside a dark rim; swells and blooms on the kick
    float kv = clamp(uKick * u_react, 0.0, 1.3) * (0.35 + 0.65 * wake);
    float sb = min(0.5 + 0.12 * h2.x + 0.03 * sin(t * 0.9 + h.x * TAU) + 0.17 * kv + 0.05 * wake * u_en, 0.84);
    float sc = sb * (0.3 + 0.2 * h2.y + 0.1 * wake) + 0.13 * kv;
    fB = -stBox(Pb, hb * sb, u_round * sb);
    fA = -stBox(Pv, hb * sc, u_round * sc * 1.3);
    wB = 0.05 + 0.06 * h.y + 0.07 * kv;
    wA = 0.10 + 0.07 * kv;
    sunHeat = clamp(0.35 + 0.65 * kv, 0.0, 1.0);
    oB = 1.0;
  } else if (fam < 1.5) {
    // chladni: sand gathers on the nodal lines; the mode snaps on the snare or steps with a band
    vec2 x = Pv / hb * 0.5 + 0.5;
    vec2 xb = Pb / hb * 0.5 + 0.5;
    float k0 = floor(M);
    float k1 = k0 + 1.0;
    float bl = smoothstep(0.1, 0.9, fract(M));
    if (h2.x < 0.55) {
      float top = 1.6 + 3.6 * u_en;
      k0 = floor(hash21(id * 1.13 + vec2(u_snN - 1.0, (u_snN - 1.0) * 0.37)) * top);
      k1 = floor(hash21(id * 1.13 + vec2(u_snN, u_snN * 0.37)) * top);
      bl = smoothstep(0.0, 0.07, u_ss);
    }
    float f = mix(stChladni(x, k0, h2), stChladni(x, k1, h2), bl);
    float fb = mix(stChladni(xb, k0, h2), stChladni(xb, k1, h2), bl);
    fA = (0.010 + 0.022 * amp - abs(f) + sand * (0.03 - 0.018 * amp)) * 2.0;
    fB = fb * 2.0;
    oB = 0.4;
  } else if (fam < 2.5) {
    // rings: follow the tile's rounded shape, or spread from an off-centre point; spacing breathes
    bool circ = h2.x < 0.4 && agree < 0.5;
    vec2 c0 = (h - 0.5) * hb * 1.3;
    float rrA = circ ? length(Pv - c0) : 1.0 - stSq(Pv, hb);
    float rrB = circ ? length(Pb - c0) : 1.0 - stSq(Pb, hb);
    float k = (1.8 + 0.8 * M + 0.9 * h2.y) * (1.0 + 0.08 * sin(t * 1.1 + h.y * TAU) + 0.22 * L * wake);
    float ph = t * 0.3 * (h.y < 0.5 ? 1.0 : -1.0);
    float duty = mix(0.25, -0.1, amp);
    // agreed: one common figure that tightens and darkens as the build climbs; snares push it outward
    k = mix(k, 2.0 + 2.6 * tight, agree) * u_detail;
    ph = mix(ph, t * 0.25 + 0.5 * (u_snN - exp(-u_ss * 14.0)), agree);
    duty = mix(duty, mix(0.1, -0.55, tight * tight), agree);
    fA = (sin((rrA * k - ph) * TAU) - duty) / (TAU * k);
    fB = sin((rrB * k * 0.5 - ph * 0.5 + 0.15) * TAU) / (PI * k);
    oB = 0.5 * (1.0 - agree);
  } else if (fam < 3.5) {
    // woven: a grid bulging like a lens; the bulge and the thread weight follow the band
    float bulge = 0.2 + 0.25 * h2.y + 0.3 * L * wake + 0.08 * uKick * wake;
    float N = (2.1 + 0.5 * M + 1.3 * h.y) * u_detail;
    vec2 drift = vec2(t * 0.05, -t * 0.035) + h * 7.0;
    float sz = 0.17 + 0.2 * amp;
    float kind = step(0.55, h2.x);
    fA = stWeave(Pv * (1.0 - bulge * (1.0 - lensR)) * N + drift, sz, kind) / N;
    fB = (stWeave(Pb * (1.0 - bulge * (1.0 - lensR)) * N + drift, sz, kind) + 0.09) / N;
  } else if (fam < 4.5) {
    // cells: spots on a hex lattice that grow with the band and merge into honeycomb
    float bulge = 0.12 + 0.2 * h2.y + 0.15 * L * wake;
    float N = (2.3 + 0.45 * M + 1.2 * h.y) * u_detail;
    vec2 w = Pv * (1.0 - bulge * (1.0 - lensR)) * N + h * 9.0;
    w += 0.13 * vec2(snoise(w * 0.6 + t * 0.12), snoise(w * 0.6 + 9.0 - t * 0.12));
    vec2 c = stHex(w);
    vec2 cb = stHex(w + off * N);
    float each = hash21(floor((w - c) * 2.0 + 0.5) + id);
    float R = (0.16 + 0.27 * amp) * (0.8 + 0.4 * each) * (1.0 + 0.12 * amp * sin(t * 2.3 + each * TAU));
    float mg = smoothstep(0.32, 0.46, R);
    fA = (R - mix(length(c), stHexD(c), mg)) / N;
    fB = (R + 0.1 - mix(length(cb), stHexD(cb), mg)) / N;
  } else if (fam < 5.5) {
    // stripes: bands that bend with the waveform; snares shear them
    bool vert = h2.x < 0.4;
    vec2 s = vert ? Pv.yx : Pv;
    vec2 sb = vert ? Pb.yx : Pb;
    float k = (1.3 + 0.4 * M + 0.8 * h.y) * u_detail;
    float bend = (0.03 + 0.14 * amp) * sin(s.x * 2.3 + t * 0.9 + h.x * TAU) + wav * 0.3 * amp
      + uSnare * wake * 0.07 * sin(s.x * 3.1 + u_snN * 2.4);
    float a = (s.y + bend) * k * TAU;
    float ab = (sb.y + bend) * k * TAU;
    fA = (sin(a) + 0.45 * sin(a * 0.5 + 1.3 + h.y * 4.0) - 0.15) / (TAU * k);
    fB = sin(ab * 0.5 + 2.6 + t * 0.2) / (PI * k);
    oB = 0.8;
  } else {
    // speckle: fine dots that flicker to a new scatter on every hat
    float N = (6.0 + 4.0 * h2.y) * u_detail;
    vec2 w = Pv * N;
    vec2 ci = floor(w);
    vec2 j = hash22(ci + id * 3.7);
    vec2 cf = fract(w) - 0.5 - (j - 0.5) * 0.45;
    float flick = hash21(ci + id * 3.7 + vec2(u_htN * 1.37, u_htN * 0.71));
    float dens = clamp(0.2 + 0.25 * uAir + 0.5 * uHat * u_react, 0.0, 0.95) * (0.35 + 0.65 * wake);
    float on = step(1.0 - dens, mix(j.x, flick, 0.65));
    fA = (on * (0.15 + 0.2 * flick + 0.1 * uHat) - length(cf)) / N;
    vec2 wb = Pb * N * 0.45 + 3.3;
    vec2 jb = hash22(floor(wb) + id * 5.1);
    vec2 cfb = fract(wb) - 0.5 - (jb - 0.5) * 0.4;
    fB = (step(jb.x, 0.45 + 0.3 * amp) * (0.2 + 0.18 * jb.y) - length(cfb)) / (N * 0.45);
  }

  // ── inks. Ground + two inks from the shelf, forced apart in tone so every figure reads
  vec3 light = hmLight();
  vec3 dark = hmDark();
  vec3 deep = mix(dark, uAccent2, 0.12);
  vec3 pale = mix(light, uMuted, 0.25);
  vec3 G = stGround(hc.x);
  vec3 I1 = stInk(floor(hc.y * 12.0));
  vec3 I2 = stInk(floor(hc.z * 12.0));
  float lg = luma(G);
  if (abs(luma(I1) - lg) < 0.22) I1 = abs(luma(deep) - lg) > abs(luma(pale) - lg) ? deep : pale;
  if (abs(luma(I2) - lg) < 0.1) I2 = mix(G, I1, 0.5);
  if (fam < 0.5 && agree < 0.5) {
    // sun: dark rim, coloured body, light core
    G = hc.x < 0.6 ? deep : (hc.x < 0.8 ? mix(dark, uAccent2, 0.4) : mix(dark, uMuted, 0.35));
    I2 = hc.y < 0.5 ? uAccent : (hc.y < 0.7 ? mix(uAccent, uAccent2, 0.5) : (hc.y < 0.85 ? uAccent2 : mix(uAccent, uMuted, 0.5)));
    vec3 hot = luma(uMuted) > luma(I2) ? mix(uMuted, light, 0.4) : light;
    I1 = mix(I2, hot, 0.3 + 0.6 * sunHeat);
    // asleep suns are embers
    I2 = mix(mix(G, I2, 0.6), I2, wake);
  }
  // agreement: every tile prints the same dark ink on its own colour (dark tiles borrow a bright one)
  if (agree > 0.5) {
    if (abs(luma(deep) - lg) < 0.25) G = luma(I2) - luma(deep) > 0.25 ? I2 : mix(uAccent, uMuted, hc.z);
    I1 = deep;
  }
  // the drop: every tile jumps to its inverse
  vec3 Gi = mix(G, I1, inv);
  vec3 Ii = mix(I1, G, inv);

  // ink is uneven and bleeds a little at the edges
  float blot = vnoise(fc / (20.0 * pxs) + id * 3.3);
  float blot2 = vnoise(fc / (5.0 * pxs) + 31.0);
  float bleed = (blot2 - 0.5) * 0.02 * (0.5 + 4.0 * u_grain);
  float show = mix(0.2 + 0.04 * sin(t * 0.6 + h.x * TAU), 1.0, wake) * frontFade;
  if (fam < 0.5) show = max(show, 0.55) * frontFade;
  float aB = smoothstep(-wB, wB, fB + bleed) * oB * show;
  float aA = smoothstep(-wA, wA, fA + bleed) * show * (0.86 + 0.14 * blot);
  aA *= 1.0 - 0.6 * step(0.994 - 0.05 * u_grain, hash21(floor(fc / (1.3 * pxs)) + 3.0));   // pinholes

  vec3 ground = mix(Gi, mix(Gi, uBg, 0.25), (1.0 - wake) * 0.5);   // sleeping tiles are a little washed
  // some tiles carry a soft bloom of a neighbouring tone under the figure
  float bloomT = step(0.45, h2.y) * (1.0 - agree) * (fam < 0.5 ? 0.0 : 1.0);
  ground = mix(ground, mix(ground, I2, 0.5), bloomT * (0.55 - 0.25 * wake) * smoothstep(1.0, 0.1, lensR * 1.5 + 0.25 * blot));
  ground *= 0.93 + 0.12 * blot;
  vec3 tile = mix(ground, I2, aB * (1.0 - 0.5 * inv));
  tile = mix(tile, Ii, aA);
  tile = mix(tile, light, 0.22 * glare);
  // lens: tone falls off toward the edge, then a thin darker rim (also slightly off register)
  float edge = smoothstep(0.45, 0.0, -d);
  tile *= 1.0 - 0.22 * edge * edge;
  float dr = stBox(P + off * 0.6, hb, u_round);
  float rim = smoothstep(-0.06, -0.025, dr) * (0.75 + 0.5 * blot2);
  tile *= 1.0 - 0.45 * rim;

  // ── paper: mottled, aged at the edges, with a faint halo where the ink soaked in
  float deckle = (blot2 - 0.5) * 0.02;
  float mask = 1.0 - smoothstep(-w0, w0, d + deckle);
  vec2 vv = vUv - 0.5;
  vec3 paper = uBg * (0.97 + 0.06 * vnoise(fc / (70.0 * pxs)));
  paper = mix(paper, mix(uBg, uMuted, 0.5), 0.22 * mix(0.3, 1.0, hmIsLight()) * smoothstep(0.12, 0.5, dot(vv, vv) * 1.7));
  paper = mix(paper, ground * 0.8, 0.22 * exp(-max(d, 0.0) * 16.0));
  paper = mix(paper, mix(uBg, uFg, 0.6), 0.5 * step(0.9985, hash21(floor(fc / (2.2 * pxs)) + 71.0)));   // dust

  vec3 col = mix(paper, tile, mask);
  // scan grain: mostly the paper's own tooth, a little live
  col *= 1.0 + (hash21(floor(fc / pxs) + 11.0) - 0.5) * u_grain * 0.9 + sand * u_grain * 0.25;
  col += hmGrain(fc, uTime) * u_grain * 0.35;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const ease = (v: number, target: number, dt: number, rate: number) => v + (target - v) * (1 - Math.exp(-dt * rate));

type Band = 'sub' | 'bass' | 'lowMid' | 'mid' | 'highMid' | 'air';
const BANDS: Band[] = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air'];

/** A band's level, eased and auto-gained against its own recent peak so every tile gets to move. */
const levelClock = (band: Band): ClockDef => ({
  step: (v, f, _s, mem) => {
    const raw = f.audio[band];
    const key = `pk_${band}`;
    const pk = Math.max(raw, (mem[key] ?? 0.35) - f.dt * 0.02, 0.35);
    mem[key] = pk;
    return ease(v, Math.min(1, raw / pk), f.dt, 9);
  },
});

/**
 * A band's vibration mode: a whole number that follows the level (higher in loud sections). It
 * steps up as soon as the level asks for it, but only steps down on a kick or snare, and the value
 * snaps on hits and eases otherwise, so the sheet changes in time with the drums.
 */
const modeClock = (i: number): ClockDef => ({
  step: (v, f, state, mem) => {
    const target = state[`l${i}`] * (1.4 + 3.4 * state.en);
    const key = `q_${i}`;
    let q = mem[key] ?? 0;
    const hit = f.audio.kickHit || f.audio.snareHit;
    if (target - q > 0.6 || (hit && q - target > 0.6) || q - target > 1.6) q = Math.round(target);
    mem[key] = q;
    return ease(v, q, f.dt, hit ? 60 : 11);
  },
});

const counter = (pick: (a: AudioFrame) => boolean, wrap: number): ClockDef => ({
  step: (v, f) => (pick(f.audio) ? (v + 1) % wrap : v),
});

const clocks: Record<string, ClockDef> = {
  clk: speedClock('speed', 1, (f) => 0.3 + 0.8 * f.audio.energy + 0.3 * f.audio.build),
  // drops: count them (each one reshuffles the sheet) and time since the last
  dropN: {
    step: (v, f, _s, mem) => {
      const d = f.audio.drop;
      mem.dropEdge = d > 0.6 && (mem.dropPrev ?? 0) <= 0.6 ? 1 : 0;
      mem.dropPrev = d;
      return mem.dropEdge ? (v + 1) % 64 : v;
    },
  },
  sd: { init: 100, step: (v, f, _s, mem) => (mem.dropEdge ? 0 : Math.min(v + f.dt, 100)) },
  // build: climbs with the riser, lets go the instant the drop lands, relaxes slowly otherwise
  bld: {
    step: (v, f, state) => {
      if (state.sd < 0.11) return v; // the old sheet stands for a blink as its own negative
      if (state.sd < 2) return 0;
      const b = Math.max(f.audio.build, f.feel.tension);
      return ease(v, b, f.dt, b > v ? 5 : 0.7);
    },
  },
  // (a drop lands loud at once rather than easing in)
  en: { step: (v, f, _s, mem) => (mem.dropEdge ? Math.max(v, 0.85) : ease(v, f.audio.energy, f.dt, 1.1)) },
  kickN: counter((a) => a.kickHit, 960),
  snN: counter((a) => a.snareHit, 1000),
  ss: { init: 100, step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)) },
  htN: counter((a) => a.hatHit, 997),
};
BANDS.forEach((b, i) => (clocks[`l${i}`] = levelClock(b)));
BANDS.forEach((_b, i) => (clocks[`m${i}`] = modeClock(i)));

export const specimenTiles = defineClockedShaderScene(
  {
    id: 'specimen-tiles',
    name: 'Specimen Tiles',
    description:
      'A printed specimen sheet of sound: a grid of rounded tiles on paper, each one a small plate resonating to one part of the song. Kick tiles are glowing suns that swell on every kick, snare tiles are sand figures that snap to a new mode on the hit, hat tiles flicker speckle, and the rest breathe as rings, woven grids, honeycomb and stripes, one band each. Build-ups pull every tile into the same tightening rings, a drop flips the sheet to its inverse and reshuffles it, and quiet parts let most tiles fall asleep.',
    category: 'field',
    style: 'print',
    fragment,
    light: true,
    tags: ['graphic', 'tactile', 'retro', 'nostalgic', 'warm', 'playful', 'experimental', 'psychedelic', 'indie', 'electronic', 'house', 'bouncy'],
    params: [
      { id: 'count', label: 'Tiles', group: 'Shape', type: 'number', min: 2, max: 9, step: 1, default: 5, hint: 'Tiles across the short side; the long side fills to match' },
      { id: 'gutter', label: 'Gutter', group: 'Shape', type: 'number', min: 0.04, max: 0.4, step: 0.005, default: 0.13 },
      { id: 'round', label: 'Corner', group: 'Shape', type: 'number', min: 0.02, max: 0.7, step: 0.01, default: 0.24 },
      { id: 'detail', label: 'Pattern scale', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1, hint: 'How fine the figures inside each tile are' },
      { id: 'speed', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 3, step: 0.01, default: 1 },
      { id: 'react', label: 'Resonance', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How hard each tile answers its part of the song' },
      { id: 'wake', label: 'Awake tiles', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Low: only loud sections wake the sheet. High: always buzzing' },
      { id: 'agree', label: 'Build agreement', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Build-ups pull tiles into one shared pattern, one after another' },
      { id: 'misreg', label: 'Misregistration', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far the second ink is printed off the first' },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.3, step: 0.005, default: 0.1 },
    ],
    modulations: [
      { source: 'bass', param: 'react', amount: 0.12 },
      { source: 'brightness', param: 'misreg', amount: 0.15 },
    ],
  },
  clocks,
);
