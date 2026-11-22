import { TONEMAP_LIB } from '../nature/volume';
import { HM_LIB, defineClockedShaderScene } from '../shader/lib';
import { GLASS_LIB, easeClock, hitClocks, relayClocks } from './lib';

/**
 * Leaded Light: a stained-glass window with the sun behind it, done as real glass.
 *
 *   - three ways of leading it: cathedral (irregular panes round medallions of rings and spokes with a
 *     faceted jewel at the heart), geometric (a Mondrian of rectangles cut by big circles, a few
 *     chevron panes of clear reamy glass) and strips (long angled strips cut on the slant)
 *   - every pane is its own sheet: cathedral waves, hammered dimples, seedy bubbles, streaky
 *     opalescent wisps or reamy lines. The texture bends the light, so the sun and the trees outside
 *     show through it smeared, sparkling in every dimple; milky sheets glow instead of showing through
 *   - lead came with a rounded face, soldered joints, and the light spilling over its edges
 *   - "wall": the same window seen as the light it throws: coloured light pooled on a plaster wall
 *     in the shape of two lancets and a rose, soft at the edges, caustic shimmer in it, dust in the beam
 *
 * Music: the light swells with the song and the sun crosses the window as the song runs dawn to dusk.
 * Each kick lights a different scatter of panes, snares another; hats twinkle the seed bubbles. A
 * build draws the light into the sun and dims the rim; the drop floods it white and lays in a new
 * window from the sun outward, pane by pane. Every section and every eight bars a new design is laid
 * in from somewhere else, never the same one twice.
 */
const fragment = /* glsl */ `
${HM_LIB}
${GLASS_LIB}
${TONEMAP_LIB}

struct Pane { vec2 id; vec2 c; float edge; float joint; float t; float flag; };

vec2 gwHalf() { return uResolution / min(uResolution.x, uResolution.y); }

// the window's design: a composition value 0..1 for every point
float gwComp(vec2 c, float seed) {
  float m = floor(hash11(seed * 0.731 + 0.17) * 4.0);
  vec2 C = (hash22(vec2(seed, 3.1)) - 0.5) * vec2(1.4, 0.9);
  if (m < 0.5) return clamp(length(c - C) * 0.6, 0.0, 1.0);
  if (m < 1.5) {
    float a = atan(c.y - C.y, c.x - C.x) / TAU + seed * 0.13;
    return clamp(0.45 * abs(fract(a * 3.0) - 0.5) * 2.0 + 0.4 * length(c - C), 0.0, 1.0);
  }
  if (m < 2.5) { vec2 dir = normalize(hash22(vec2(seed, 7.7)) - 0.5); return clamp(dot(c, dir) * 0.45 + 0.5, 0.0, 1.0); }
  return clamp(tnoise(c * 0.9 + seed) * 1.4 - 0.2, 0.0, 1.0);
}

void gwMedallions(vec2 p, float seed, inout Pane P) {
  vec2 hf = gwHalf();
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float hk = hash11(seed * 1.31 + fk * 3.3);
    if (k > 0 && hk > 0.6) continue;
    vec2 C = (hash22(vec2(seed * 1.7, fk * 5.1 + 1.0)) - 0.5) * (hf * 2.0 - 0.5);
    float R = (0.3 + 0.32 * hash11(seed * 2.9 + fk)) * (k == 0 ? 1.15 : 0.85);
    vec2 d = p - C;
    float r = length(d);
    float e = abs(r - R);
    P.edge = min(P.edge, e * 0.75);
    if (r < R) {
      float nr = 2.0 + floor(hash11(seed + fk * 9.1) * 2.0);
      float jr = R * 0.24;
      if (r < jr) {
        // the jewel: faceted, a lead ring round it
        P.id = vec2(500.0 + fk, 0.0);
        P.c = C;
        P.edge = min(P.edge, jr - r);
        P.flag = 2.0;
        P.t = hash11(seed * 4.1 + fk);
        continue;
      }
      float u = (r - jr) / (R - jr) * nr;
      float ring = floor(u);
      float n = (4.0 + 4.0 * floor(hash11(seed * 3.7 + fk + ring) * 3.0)) * (ring + 1.0);
      float ang = atan(d.y, d.x) + fk + ring * 0.5 * hash11(seed + ring);
      float a = ang / TAU * n;
      float seg = floor(a);
      float er = min(fract(u), 1.0 - fract(u)) * (R - jr) / nr;
      float ea = min(fract(a), 1.0 - fract(a)) * TAU / n * r;
      P.edge = min(min(er, ea), min(jr - r < 0.0 ? r - jr : 1.0, R - r));
      P.id = vec2(100.0 + fk * 10.0 + ring, seg);
      float mid = jr + (ring + 0.5) / nr * (R - jr);
      float ma = (seg + 0.5) / n * TAU - fk - ring * 0.5 * hash11(seed + ring);
      P.c = C + mid * vec2(cos(ma), sin(ma));
      // a medallion has its own design: rings of colour, alternating petals
      P.t = fract(hash11(seed * 5.3 + fk) + ring * 0.27 + 0.12 * mod(seg, 2.0));
      P.flag = 1.0;
    }
  }
}

Pane gwCathedral(vec2 p, float seed, float size) {
  Pane P;
  float sc = size * 0.5 * (0.85 + 0.3 * hash11(seed * 1.7));
  vec2 off = hash22(vec2(seed, 1.3)) * 40.0;
  vec2 x = p * sc + off;
  vec2 n = floor(x);
  vec2 f = fract(x);
  float jit = 0.85;
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = 0.5 + (hash22(n + g + seed * 0.37) - 0.5) * jit;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float e1 = 8.0, e2 = 8.0;
  for (int j = -2; j <= 2; j++)
  for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 o = 0.5 + (hash22(n + g + seed * 0.37) - 0.5) * jit;
    vec2 r = g + o - f;
    vec2 dd = r - mr;
    if (dot(dd, dd) > 1e-5) {
      float e = dot(0.5 * (mr + r), normalize(dd));
      if (e < e1) { e2 = e1; e1 = e; } else if (e < e2) e2 = e;
    }
  }
  P.id = n + mg;
  P.c = (x + mr - off) / sc;
  P.edge = e1 / sc;
  P.joint = e2 / sc;
  P.t = gwComp(P.c, seed);
  P.flag = 0.0;
  gwMedallions(p, seed, P);
  return P;
}

// rectangles split again and again, snapped to a loose grid
void gwSplit(vec2 p, float seed, float minS, float grid, inout vec2 lo, inout vec2 hi, out float id) {
  id = 1.0;
  for (int i = 0; i < 9; i++) {
    vec2 s = hi - lo;
    if (max(s.x, s.y) < minS * (0.7 + 0.7 * hash11(id * 1.3 + seed))) break;
    float h = hash11(id * 0.917 + seed * 3.1);
    bool vx = s.x > s.y * (0.6 + 0.8 * hash11(id + seed * 7.7));
    float t = 0.25 + 0.5 * h;
    if (vx) {
      float sp = lo.x + s.x * t;
      if (s.x > grid * 3.0) sp = clamp(floor(sp / grid + 0.5) * grid, lo.x + grid, hi.x - grid);
      if (p.x < sp) { hi.x = sp; id = id * 2.0; } else { lo.x = sp; id = id * 2.0 + 1.0; }
    } else {
      float sp = lo.y + s.y * t;
      if (s.y > grid * 3.0) sp = clamp(floor(sp / grid + 0.5) * grid, lo.y + grid, hi.y - grid);
      if (p.y < sp) { hi.y = sp; id = id * 2.0; } else { lo.y = sp; id = id * 2.0 + 1.0; }
    }
  }
}

Pane gwGeometric(vec2 p, float seed, float size) {
  Pane P;
  vec2 hf = gwHalf();
  float grid = 1.0 / size;
  float minS = 2.4 / size;
  vec2 lo = -hf - 0.03, hi = hf + 0.03;
  float id;
  float sd = seed;
  float tOff = 0.0;
  float circ = 9.0;
  P.flag = 0.0;
  // big circles: their own subdivision and colours inside
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    if (k > 1 && hash11(seed * 2.1 + fk) > 0.55) continue;
    vec2 C = (hash22(vec2(seed * 0.9, fk * 3.7 + 2.0)) - 0.5) * (hf * 2.0 - 0.4);
    C = floor(C / grid + 0.5) * grid;
    float R = (0.22 + 0.38 * hash11(seed * 1.9 + fk * 5.0));
    float r = length(p - C);
    circ = min(circ, abs(r - R));
    if (r < R && sd == seed) { sd = seed + 31.0 + fk * 7.0; tOff = 0.35 + 0.3 * hash11(fk + seed); P.flag = 1.0; }
  }
  gwSplit(p, sd, minS * (P.flag > 0.5 ? 0.7 : 1.0), grid, lo, hi, id);
  P.edge = min(min(min(p.x - lo.x, hi.x - p.x), min(p.y - lo.y, hi.y - p.y)), circ);
  P.c = 0.5 * (lo + hi);
  P.id = vec2(id, sd);
  P.joint = 9.0;
  P.t = fract(gwComp(P.c, seed) + tOff);
  // now and then a tall pane of clear chevrons
  vec2 s = hi - lo;
  if (P.flag < 0.5 && hash11(id * 3.3 + seed) < 0.12 && s.y > s.x * 1.4) {
    float w = s.x * 0.5;
    float v = (p.y + abs(p.x - P.c.x)) / w;
    float ev = min(fract(v), 1.0 - fract(v)) * w * 0.7071;
    P.edge = min(P.edge, min(ev, abs(p.x - P.c.x)));
    P.id += vec2(floor(v) * 0.37, step(p.x, P.c.x) * 0.71);
    P.flag = 3.0;
  }
  return P;
}

Pane gwStrips(vec2 p, float seed, float size) {
  Pane P;
  float ang = (hash11(seed * 2.3) - 0.5) * 1.0;
  vec2 q = rot2(ang) * p;
  float w = 2.0 / (size * 1.5);
  float u = q.x / w;
  float k0 = floor(u);
  float k = k0;
  float bk = k0 + 0.4 * (hash11(k0 + seed) - 0.5);
  if (u < bk) k = k0 - 1.0;
  else if (u > k0 + 1.0 + 0.4 * (hash11(k0 + 1.0 + seed) - 0.5)) k = k0 + 1.0;
  float b0 = k + 0.4 * (hash11(k + seed) - 0.5);
  float b1 = k + 1.0 + 0.4 * (hash11(k + 1.0 + seed) - 0.5);
  float eU = min(u - b0, b1 - u) * w;
  float slant = (hash11(k * 1.7 + seed) - 0.5) * 1.4;
  float L = w * (1.6 + 5.0 * hash11(k * 3.1 + seed));
  float xc = 0.5 * (b0 + b1) * w;
  float off = hash11(k * 4.3 + seed) * 10.0;
  float v = (q.y + (q.x - xc) * slant) / L + off;
  float j = floor(v);
  float eV = min(fract(v), 1.0 - fract(v)) * L / sqrt(1.0 + slant * slant);
  P.edge = min(eU, eV);
  P.id = vec2(k, j);
  P.joint = 9.0;
  vec2 cq = vec2(xc, (j + 0.5 - off) * L);
  P.c = rot2(-ang) * cq;
  // strips keep to a narrow family of colours that drifts across the window
  P.t = clamp(gwComp(P.c, seed) * 0.55 + 0.25 * hash11(k * 9.1 + seed), 0.0, 1.0);
  P.flag = 0.0;
  return P;
}

Pane gwPattern(vec2 p, float seed) {
  if (u_pattern < 0.5) return gwCathedral(p, seed, u_size);
  if (u_pattern < 1.5) return gwGeometric(p, seed, u_size);
  return gwStrips(p, seed, u_size);
}

vec2 gwSun() {
  vec2 hf = gwHalf();
  float L = uFeelLight;
  return vec2(cos(L) * 0.8 * hf.x, -0.15 + 0.7 * sin(L) * hf.y);
}

// what is behind the glass: sky, the trees outside (soft through the glass), the sun
vec3 gwBack(vec2 q, float blur, float sunK) {
  vec2 sun = gwSun();
  float d = length(q - sun);
  vec3 sky = gLin(mix(uFg, uAccent, 0.22)) * (0.62 + 0.22 * q.y) * u_gGlow;
  float trees = smoothstep(-0.05, 0.4, tfbm(q * 1.1 + vec2(uFeelWindPhase * 0.04, 0.0), 4) + 0.05 - q.y * 0.35);
  float twig = smoothstep(0.03, 0.0, abs(tfbm(q * 2.3 + 4.0, 3)) - 0.01) * smoothstep(0.6, -0.4, q.y);
  sky *= 1.0 - (0.78 * trees + 0.5 * twig * (1.0 - blur)) * u_world;
  float core = exp(-d * d / (0.01 + blur * 0.06)) * 22.0;
  float halo = exp(-d * mix(2.8, 1.5, blur)) * 1.5;
  return sky + gLin(uFg) * (core + halo) * sunK;
}

vec3 gwShade(Pane P, vec2 p, float seed, float px, out float leadMask) {
  vec3 hh = vec3(hash21(P.id * 1.37 + seed * 0.11), hash21(P.id * 2.91 + seed * 0.37 + 5.1), hash21(P.id * 0.71 + seed * 0.73 + 9.7));
  float kind = floor(hash21(P.id + seed * 1.9 + 2.2) * 5.0);
  float clear = step(fract(hh.x * 31.7), u_clear);
  vec3 ink = gPaneInk(P.t, hh.x, hh.y, hh.z, 0.4);
  if (P.flag > 2.5) { clear = 1.0; kind = 4.0; }
  if (clear > 0.5) ink = mix(vec3(0.92), uFg, 0.35) * (0.92 + 0.08 * hh.y);
  vec3 tint = gLin(ink);
  vec3 S = gSurface(p, kind, hh.x);
  vec2 bend = S.xy * u_texture;
  float sunK = u_sun * (0.55 + 0.7 * u_gGlow);
  // the build draws the light into the sun
  vec2 sun = gwSun();
  float gather = mix(1.0, 0.25 + 1.5 * exp(-length(P.c - sun) * 1.3), uFeelTension * 0.85);
  // the jewel: facets throw the sun about
  if (P.flag > 1.5 && P.flag < 2.5) {
    float fa = floor((atan(p.y - P.c.y, p.x - P.c.x) + PI) / TAU * 8.0);
    bend = (hash22(vec2(fa, seed)) - 0.5) * 0.9;
    tint = gLin(gSat(ink, 1.4)) * 1.2;
  }
  float milk = kind > 2.5 && kind < 3.5 ? 0.7 : 0.15 * (1.0 - clear);
  vec3 sharp = gwBack(p + bend * 6.0, 0.0, sunK);
  vec3 soft = gwBack(P.c, 1.0, sunK);
  // sheets are never even: thicker and thinner patches, darker at the cut edges under the came
  float thick = (0.75 + 0.5 * hh.y + 0.35 * S.z) * (0.65 + 0.8 * tnoise(p * 2.3 + hh.z * 31.0));
  thick *= 1.0 + 0.6 * smoothstep(0.05, 0.0, P.edge);
  vec3 T = pow(tint, vec3(thick));
  vec3 seen = mix(sharp, soft * 0.8 + gLin(uFg) * 0.08, milk * mix(0.5, 1.0, S.z)) * T;
  // streaky sheets: a second colour wisps through
  if (kind > 2.5 && kind < 3.5) seen = mix(seen, soft * gLin(mix(ink, uFg, 0.6)) * 0.9, S.z * 0.5);
  seen *= gather;
  // seed bubbles catch the light (hats make them twinkle)
  if (kind > 1.5 && kind < 2.5) seen += mix(tint, vec3(1.0), 0.35) * gLin(uFg) * gBubbles(p, hh.x) * (0.3 + 1.6 * uHat * u_flare) * u_gGlow;
  // kicks light one scatter of panes, snares another
  float fk = step(fract(hh.y * 13.7 + u_kc * 0.618), 0.08 * u_flare) * exp(-u_sk * 4.5);
  float fs = step(fract(hh.z * 11.3 + u_sc * 0.382), 0.06 * u_flare) * exp(-u_ss * 5.5);
  seen *= 1.0 + 2.6 * fk + 2.0 * fs;
  seen += tint * gLin(uFg) * (1.2 * fk + 0.8 * fs);

  // lead came: rounded face, the light spilling over its edges, soldered joints
  float lw = 0.015 * u_lead * (P.flag > 0.5 && P.flag < 1.5 ? 0.85 : 1.0);
  float e = P.edge;
  float jn = smoothstep(lw * 2.2, lw * 1.2, P.joint) * smoothstep(lw * 2.4, 0.0, e);
  float lwj = lw * (1.0 + 0.6 * jn);
  leadMask = 1.0 - smoothstep(lwj - px, lwj + px, e);
  float prof = clamp(e / lwj, 0.0, 1.0);
  vec3 lead = gLin(uBg) * 0.08 + vec3(0.006);
  lead *= 0.5 + 0.8 * (1.0 - prof * prof);
  lead += gLin(uFg) * 0.025 * smoothstep(0.35, 0.0, abs(prof - 0.3)) * u_gGlow;
  lead += seen * 0.2 * smoothstep(0.55, 1.0, prof);
  return mix(seen, lead, leadMask);
}

// the wall: the window as the light it throws
vec3 gwWall(vec2 p, float px) {
  vec2 hf = gwHalf();
  float L = uFeelLight;
  // the light lands skewed by the sun's angle and slides along the wall as the day goes on
  vec2 o = vec2(-cos(L) * 0.3 * hf.x, -0.2 - 0.08 * sin(L));
  float sk = -cos(L) * 0.45;
  vec2 w = p - o;
  w.x -= w.y * sk;
  w *= vec2(0.82, 0.74);
  // two lancets and a rose above them
  float lanW = 0.36, lanH = 0.78, gap = 0.16;
  vec2 lq = vec2(abs(w.x) - (lanW + gap) * 0.5, w.y + 0.25);
  float body = sdBox(lq - vec2(0.0, -0.1), vec2(lanW * 0.5, lanH * 0.5));
  // pointed arch on top
  vec2 aq = lq - vec2(0.0, lanH * 0.5 - 0.1);
  float arch = max(max(length(aq - vec2(-lanW * 0.5, 0.0)), length(aq - vec2(lanW * 0.5, 0.0))) - lanW, -aq.y);
  float lancet = min(body, arch);
  float rose = length(w - vec2(0.0, 0.64)) - 0.27;
  float shape = min(lancet, rose);
  // the light's edge is soft (the sun is not a point), softer further from the window
  float pen = 0.025 + 0.02 * u_size * 0.1;
  float lit = 1.0 - smoothstep(-pen, pen, shape);
  // the pattern, blurred: a few taps of the window, leads soft
  vec3 acc = vec3(0.0);
  float leadAcc = 0.0;
  vec2 wp = w * 1.6;
  // outside the patch of light the pattern is never seen: skip the taps (most of the frame)
  int taps = shape < pen * 1.5 ? 2 : 0;
  for (int i = 0; i < 2; i++) {
    if (i >= taps) break;
    vec2 j = (vec2(hash11(float(i) * 3.1), hash11(float(i) * 7.7)) - 0.5) * 0.022;
    Pane P = gwPattern(wp + j, u_gSeedA);
    float seed = u_gSeedA;
    if (u_gRelay < 1.0) {
      Pane Q = gwPattern(wp + j, u_gSeedB);
      float front = u_gRelay * (length(hf) * 1.6 + 1.6);
      if (length(Q.c - vec2(u_gOx, u_gOy)) < front) { P = Q; seed = u_gSeedB; }
    }
    vec3 hh = vec3(hash21(P.id * 1.37 + seed * 0.11), hash21(P.id * 2.91 + seed * 0.37 + 5.1), hash21(P.id * 0.71 + seed * 0.73 + 9.7));
    vec3 ink = gPaneInk(P.t, hh.x, hh.y, hh.z, 0.4);
    if (step(fract(hh.x * 31.7), u_clear) > 0.5 || P.flag > 2.5) ink = mix(vec3(0.95), uFg, 0.4);
    float fk = step(fract(hh.y * 13.7 + u_kc * 0.618), 0.08 * u_flare) * exp(-u_sk * 4.5);
    acc += gLin(gSat(ink, 1.35)) * (1.0 + 1.5 * fk);
    leadAcc += smoothstep(0.022 * u_lead, 0.006, P.edge);
  }
  acc *= 0.5;
  leadAcc *= 0.5;
  // light through coloured glass stays saturated on the wall: deepen it before it is brightened
  acc = pow(acc, vec3(1.25)) * 1.3;
  // caustic shimmer: the textured glass focuses the light into moving threads
  float ca = tnoise(wp * 5.0 + vec2(uTime * 0.15, uTime * 0.11)) + tnoise(wp * 9.0 - vec2(uTime * 0.13, -uTime * 0.07)) * 0.6;
  float caust = 0.75 + 0.6 * pow(smoothstep(0.7, 1.45, ca), 2.0) * (0.6 + uHat * u_flare + 0.6 * uFeelIntensity);
  // clouds pass in quiet parts
  float cloud = mix(1.0, 0.45 + 0.55 * smoothstep(0.25, 0.75, tnoise(vec2(uTime * 0.07, 3.0))), 1.0 - uFeelIntensity);
  float sunK = u_sun * (0.5 + 0.9 * u_gGlow) * cloud;
  // mullions: a stone bar between the lancets, the iron of the rose
  float bars = smoothstep(0.012, 0.004, abs(abs(w.x) - 0.0)) * step(w.y, 0.38);
  vec3 light = acc * (1.0 - 0.85 * leadAcc) * (1.0 - bars) * caust * sunK * 2.6;
  float gather = mix(1.0, 0.3 + 1.6 * exp(-length(w) * 1.6), uFeelTension * 0.8);
  light *= gather;
  // plaster: warm grain, dim fill light from the room
  float pl = 0.85 + 0.15 * tfbm(p * 6.0, 4) + 0.05 * tnoise(p * 60.0);
  // plaster is near white whatever the palette (a coloured wall would muddy every pane's light)
  vec3 wall = gLin(gSat(mix(uFg, vec3(0.86, 0.83, 0.78), 0.5), 0.35)) * pl;
  vec3 col = wall * (0.06 + 0.05 * u_gGlow) + wall * light * lit;
  // the light's haze off the wall and dust in the beam
  float beam = exp(-max(shape, 0.0) * 3.0) * 0.06 * sunK;
  vec2 dq = p * 18.0 + vec2(uTime * 0.12, uTime * 0.05);
  vec2 di = floor(dq);
  float mote = smoothstep(0.08, 0.0, length(fract(dq) - 0.5 - (hash22(di) - 0.5) * 0.6)) * step(0.93, hash21(di));
  col += gLin(uFg) * (beam + mote * 0.35 * lit * sunK);
  return col;
}

void main() {
  vec2 res = uResolution;
  float sm = min(res.x, res.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / (0.5 * sm);
  float px = 2.0 / sm;
  vec3 col;
  float flood = exp(-uFeelSinceDrop * 1.6) * step(uFeelSinceDrop, 20.0);
  if (u_view > 0.5) {
    col = gwWall(p, px);
  } else {
    Pane P = gwPattern(p, u_gSeedA);
    float seed = u_gSeedA;
    float fresh = 0.0;
    if (u_gRelay < 1.0) {
      Pane Q = gwPattern(p, u_gSeedB);
      float front = u_gRelay * (length(gwHalf()) + 1.6);
      float dq = length(Q.c - vec2(u_gOx, u_gOy)) + hash21(Q.id + u_gSeedB) * 0.4;
      if (dq < front) { P = Q; seed = u_gSeedB; fresh = exp(-(front - dq) * 3.0); }
    }
    float leadMask;
    col = gwShade(P, p, seed, px, leadMask);
    // a pane just laid in glows as it settles
    col += gLin(uFg) * fresh * (1.0 - leadMask) * (0.35 + 0.7 * u_gKind);
    // a soft bloom: bright glass hazes the leads and the air in front of it
    vec2 sun = gwSun();
    col += gLin(uFg) * exp(-length(p - sun) * 2.2) * 0.12 * u_sun * u_gGlow;
  }
  col *= 1.0 + flood * 1.1;
  vec2 uv = gl_FragCoord.xy / res;
  float vig = 1.0 - 0.35 * pow(length((uv - 0.5) * vec2(1.0, 0.8)) * 1.3, 2.4);
  vec3 outc = ntToDisplay(col * vig, u_exposure * (0.85 + 0.25 * uFeelIntensity));
  outc += hmGrain(gl_FragCoord.xy, uTime) * u_grain;
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

export const glassWindow = defineClockedShaderScene(
  {
    id: 'glass-window',
    name: 'Leaded Light',
    description:
      'A stained-glass window with the sun behind it, done as real glass: cathedral, hammered, seedy and opalescent sheets in lead came, the sun and trees smeared through the texture. The light swells with the song and the sun crosses the window; kicks and snares light scatters of panes, a build draws the light into the sun, and the drop floods it white and lays in a new window pane by pane. A new design every section. Can also show the coloured light the window throws on a wall.',
    category: 'field',
    style: 'light',
    fragment,
    tags: ['dreamy', 'cinematic', 'euphoric', 'uplifting', 'spiritual', 'warm', 'romantic', 'emotional', 'colourful', 'organic', 'tender', 'epic', 'pop', 'indie', 'acoustic'],
    params: [
      {
        id: 'view',
        label: 'View',
        group: 'Shape',
        type: 'select',
        default: 'window',
        options: [
          { value: 'window', label: 'The window' },
          { value: 'wall', label: 'Light on the wall' },
        ],
      },
      {
        id: 'pattern',
        label: 'Leading',
        group: 'Shape',
        type: 'select',
        default: 'cathedral',
        options: [
          { value: 'cathedral', label: 'Cathedral' },
          { value: 'geometric', label: 'Geometric' },
          { value: 'strips', label: 'Strips' },
        ],
      },
      { id: 'size', label: 'Panes', group: 'Shape', type: 'number', min: 2, max: 12, step: 0.1, default: 5, hint: 'How many panes across the short side' },
      { id: 'lead', label: 'Lead', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1, hint: 'Width of the lead came between panes' },
      { id: 'clear', label: 'Clear glass', group: 'Color', type: 'number', min: 0, max: 0.8, step: 0.01, default: 0.12, hint: 'Share of panes in clear textured glass' },
      { id: 'texture', label: 'Glass texture', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How much the hammered, rippled glass bends the light' },
      { id: 'world', label: 'Trees outside', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'sun', label: 'Sun', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'flare', label: 'Pane flares', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Kicks and snares light scatters of panes; hats twinkle the bubbles' },
      { id: 'exposure', label: 'Exposure', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.025 },
    ],
    modulations: [],
    handInks: 4,
  },
  {
    ...hitClocks,
    gGlow: easeClock((f) => 0.35 + 0.75 * f.feel.intensity + 0.25 * f.audio.level + 0.4 * f.feel.release, 2.5, 0.6),
    ...relayClocks({ phraseBeats: 32 }),
  },
);
