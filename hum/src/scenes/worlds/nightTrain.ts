import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, rateClock } from '../shader/lib';

/**
 * Night Train — the last train home, and the song is in your headphones. An empty subway car at
 * night seen down the aisle in one-point perspective: long bench seats down both sides, grab poles,
 * rows of hand straps hanging from the rails, strip lights on the ceiling, dark windows with the
 * city going by. It is drawn as a real 3D box (the view ray is intersected with the floor, ceiling,
 * walls, benches, poles, rails, straps and the two passengers, all analytic, no raymarch) and then
 * quantised to a handful of inks with ordered dithering at a chunky pixel size, so it is pixel art
 * that moves: the perspective, the lights and the sway are continuous, the pixels stay put.
 * The feeling is tired, safe and a little lonely: motion while sitting still.
 *
 * The music is the track. The car sways and bobs with the tempo, the straps are pendulums pushed on
 * every kick, snares make the tubes dip, and the windows show the outside at a speed set by the
 * song. Quiet parts: the car is nearly dark, one tube buzzing, a slow skyline in the window, a
 * single passenger. Verse: into the tunnel, lamps streak past. Build (feel.tension): the train
 * accelerates, the streaks stretch into lines, the lights strobe, the camera dollies down the aisle.
 * Drop: it bursts out of the tunnel into a wall of neon and a bright sky, the car flashes warm and
 * every strap swings; the chorus stays open and fully lit. Break: it slows into a station, the
 * platform's light boxes drift past and stop. A hanging route display shows the song time and the
 * stations (sections) along the line; one passenger nods on the beat, the other is on her phone.
 *
 * Palette roles: bg = the deepest navy (shadow, night, tunnel) · muted = the slate/teal body of
 * the car · fg = cream tube light and the brightest highlights · accent = hot orange (tube halos,
 * LED display, tunnel lamps, the warm flash) · accent2 = dusty pink seats (and signs outside).
 * Every ink is a mix of these; on a light palette the darker of bg/fg is used as the night.
 */
const fragment = /* glsl */ `
${HM_LIB}

const float NT_W = 1.35;      // half width of the car
const float NT_H = 2.25;      // ceiling
const float NT_SEATX = 0.84;  // bench front (|x|)
const float NT_SEATY = 0.46;  // seat top
const float NT_BACKX = 1.17;  // backrest front
const float NT_BACKY = 0.98;  // backrest top
const float NT_BAY = 6.0;     // one bay: a door section, then a bench
const float NT_DOOR = 1.7;
const float NT_END = 24.0;    // the far door
const float NT_LSEG = 1.5;    // ceiling tube spacing
const float NT_LX = 0.5;      // the two rows of tubes
const float NT_PX = 0.8;      // grab poles
const float NT_RX = 0.88;     // strap rails
const float NT_RY = 1.99;
const float NT_SS = 0.6;      // strap spacing
const float NT_ZD = 4.6;      // the hanging route display

// inks (set once in main)
vec3 gD;  vec3 gN;  vec3 gM1; vec3 gM;  vec3 gM2;
vec3 gP1; vec3 gP;  vec3 gP2; vec3 gA1; vec3 gA;  vec3 gL;  vec3 gW;
float gB;     // ordered-dither threshold of this chunky pixel
float gFoot;  // world size of one chunky pixel at distance 1

vec3 ntRamp(vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, float v) {
  float x = clamp(v, 0.0, 1.0) * 4.0;
  float i = min(floor(x) + step(gB, fract(x)), 4.0);
  if (i < 0.5) return c0;
  if (i < 1.5) return c1;
  if (i < 2.5) return c2;
  if (i < 3.5) return c3;
  return c4;
}
vec3 ntDith(vec3 a, vec3 b, float t) { return t > gB ? b : a; }
vec3 ntLift(vec3 col, vec3 ink) { return luma(ink) > luma(col) ? ink : col; }

// one ceiling tube: is it on, is it dipping on the snare, strobing on the build
float ntLamp(float k, float s) {
  if (k < 0.0 || (k + 1.0) * NT_LSEG > NT_END) return 0.0;
  float h = hash21(vec2(k * 1.37 + 0.5, s * 17.0 + 3.0));
  float on = smoothstep(h - 0.04, h + 0.04, u_lit);
  // one tube that never quite gives up
  float buzz = step(abs(k - 2.0), 0.5) * step(s, 0.5);
  float fl = step(0.16, hash11(floor(uTime * 17.0) * 1.31 + 0.7)) * (0.82 + 0.18 * sin(uTime * 100.0));
  on = max(on, buzz * mix(fl * 1.5, 1.0, smoothstep(0.3, 0.7, u_lit)));
  float dip = step(hash21(vec2(k + s * 31.0, u_sc * 1.13)), 0.55) * exp(-u_ss * 6.0) * u_flicker;
  float stb = step(0.5, fract(u_stb + h));
  float strobe = mix(1.0, 0.2 + 0.8 * stb, smoothstep(0.2, 0.85, uFeelTension) * u_flicker);
  return on * (1.0 - 0.8 * dip) * strobe * (1.0 + 0.5 * u_blz);
}

// diffuse light from the two rows of tubes
float ntLight(vec3 P, vec3 N) {
  float kc = floor(P.z / NT_LSEG);
  float sum = 0.0;
  for (int s = 0; s < 2; s++) {
    float sx = s == 0 ? -NT_LX : NT_LX;
    for (int i = 0; i < 5; i++) {
      float k = kc - 2.0 + float(i);
      float b = ntLamp(k, float(s));
      if (b <= 0.0) continue;
      float zc = (k + 0.5) * NT_LSEG;
      vec3 L = vec3(sx, NT_H - 0.05, clamp(P.z, zc - 0.55, zc + 0.55)) - P;
      float d2 = dot(L, L);
      float ndl = max(dot(N, L) * inversesqrt(d2 + 1e-4), 0.0);
      sum += b * (0.2 + 0.8 * ndl) / (0.6 + 1.5 * d2);
    }
  }
  return sum;
}

// tube brightness along a row at depth z (0 between tubes)
float ntTubeAt(float z, float s, float soft) {
  float k = floor(z / NT_LSEG);
  float lz = abs(z - (k + 0.5) * NT_LSEG);
  return ntLamp(k, s) * (1.0 - smoothstep(0.52 - soft, 0.52 + soft, lz));
}

bool ntInBench(float z) {
  float lz = z - floor(z / NT_BAY) * NT_BAY;
  return lz >= NT_DOOR && z > -6.0 && z < NT_END;
}

// a bench block: |x| in [x0, NT_W], y in [y0, y1], along the bench sections
void ntBench(vec3 ro, vec3 rd, float s, float x0, float y0, float y1, inout float tb, inout vec3 nb, inout int mb, int id) {
  float t1 = (s * x0 - ro.x) / rd.x;
  vec3 P = ro + rd * t1;
  if (t1 > 0.0 && t1 < tb && P.y >= y0 && P.y <= y1 && ntInBench(P.z)) { tb = t1; nb = vec3(-s, 0.0, 0.0); mb = id; }
  if (rd.y < 0.0 && ro.y > y1) {
    float t2 = (y1 - ro.y) / rd.y;
    vec3 Q = ro + rd * t2;
    if (t2 > 0.0 && t2 < tb && Q.x * s >= x0 && Q.x * s <= NT_W && ntInBench(Q.z)) { tb = t2; nb = vec3(0.0, 1.0, 0.0); mb = id; }
  }
  // the end of the next bench, seen through a door gap
  float lz = P.z - floor(P.z / NT_BAY) * NT_BAY;
  if (lz < NT_DOOR && rd.z > 0.0) {
    float zs = floor(P.z / NT_BAY) * NT_BAY + NT_DOOR;
    float t3 = (zs - ro.z) / rd.z;
    vec3 R = ro + rd * t3;
    if (t3 > 0.0 && t3 < tb && R.x * s >= x0 && R.x * s <= NT_W && R.y >= y0 && R.y <= y1 && zs < NT_END) { tb = t3; nb = vec3(0.0, 0.0, -1.0); mb = id; }
  }
}

/* ---------------- outside ---------------- */

vec3 ntSky(float el, out float br) {
  float day = uFeelDay;
  float sun = smoothstep(0.24, 0.4, day) * (1.0 - smoothstep(0.6, 0.76, day));
  float tw = exp(-pow((day - 0.27) / 0.07, 2.0)) + exp(-pow((day - 0.73) / 0.07, 2.0));
  float rel = uFeelRelease;
  float g = clamp(el * 1.6 + 0.1, 0.0, 1.0);
  vec3 hi = ntRamp(gD, gN, gM1, gM, gM2, 0.15 + 0.55 * sun + 0.3 * rel);
  vec3 lo = ntRamp(gN, gP1, gP, gA, gL, 0.08 + 0.35 * sun + 0.5 * tw + 0.45 * rel);
  br = 0.1 + 0.4 * sun + 0.3 * tw + 0.6 * rel;
  return ntDith(lo, hi, smoothstep(0.0, 0.8, g));
}

vec3 ntOpen(vec3 ro, vec3 rd, float s, out float br) {
  float hz = length(rd.xz);
  float el = rd.y / hz;
  vec3 col = ntSky(el, br);
  // far skyline
  float tf = (s * 70.0 - ro.x) / rd.x;
  vec3 F = ro + rd * tf;
  float zw = F.z + u_dist * 0.6;
  float bi = floor(zw / 6.0);
  vec2 bh = hash22(vec2(bi, 3.0));
  float top = -4.0 + 5.0 + 22.0 * bh.x * bh.x;
  if (F.y < top) {
    col = ntDith(gD, gN, 0.25 + 0.3 * bh.y);
    vec2 wc = floor(vec2(zw / 1.4, F.y / 1.6));
    float lit = step(hash21(wc + bi * 7.0), 0.1 + 0.25 * uFeelIntensity + 0.3 * uFeelRelease);
    float inW = step(0.35, fract(zw / 1.4)) * step(0.4, fract(F.y / 1.6));
    col = mix(col, hash21(wc + 9.0) < 0.7 ? gA1 : gL, lit * inW);
  }
  // near: low roofs and catenary poles (or a wall of neon after the drop)
  float tn = (s * 11.0 - ro.x) / rd.x;
  vec3 Nn = ro + rd * tn;
  float zn = Nn.z + u_dist;
  float ni = floor(zn / 5.0);
  vec2 nh = hash22(vec2(ni, 11.0));
  float ntop = -4.0 + 2.5 + 4.0 * nh.x;
  // neon blocks: almost every block on the drop, thinning out as the afterglow fades
  float blk = floor(zn / 14.0);
  float neon = step(hash11(blk * 3.7 + 1.0), uFeelRelease * 1.25 * u_neon);
  if (neon > 0.5) {
    col = ntDith(gD, gN, 0.6);
    vec2 sc = vec2(zn / 2.8, Nn.y / 1.15);
    vec2 si = floor(sc);
    vec2 sf = fract(sc) - 0.5;
    float hs = hash21(si + vec2(blk * 13.0, 0.0));
    float kind = hash21(si + 7.7);
    float on = step(hs, 0.62) * step(abs(sf.x), 0.4) * step(abs(sf.y), 0.36);
    float blink = step(0.22, hash21(si + vec2(u_hc * 0.37, 2.0)));   // the hats flick a few signs
    vec3 sk = mix(mix(gA, gP, step(0.35, kind)), mix(gP2, gL, step(0.85, kind)), step(0.65, kind));
    col = mix(col, sk, on * blink);
    float core = on * step(abs(sf.y), 0.09) * step(0.45, fract(sf.x * 5.0 + kind * 3.0));
    col = mix(col, gW, core * blink);
    br += 0.5;
  } else if (Nn.y < ntop) {
    col = gD;
    float wl = step(hash21(floor(vec2(zn / 1.2, Nn.y / 1.0)) + 3.0), 0.08 + 0.12 * uFeelIntensity) * step(0.4, fract(zn / 1.2));
    col = mix(col, gA1, wl);
  }
  // catenary poles
  float pz = zn - floor(zn / 24.0) * 24.0;
  float pw = max(0.12, gFoot * tn * 0.6);
  if (pz < pw && Nn.y < 3.5) col = gD;
  return col;
}

vec3 ntTunnel(vec3 ro, vec3 rd, float s, out float br) {
  float t = (s * (NT_W + 1.2) - ro.x) / rd.x;
  vec3 Q = ro + rd * t;
  float zw = Q.z + u_dist;
  float blurR = clamp(u_spd * 0.035, 0.0, 1.0);
  // ribs and cable runs, faintly lit by the car's own windows
  float rib = step(fract(zw / 1.5), 0.2);
  float wallL = mix(rib * 0.55, 0.12, blurR) * (1.0 - smoothstep(0.6, 2.6, abs(Q.y - 1.3)));
  vec3 col = ntDith(gD, gN, wallL);
  float cable = 1.0 - smoothstep(0.03, 0.03 + gFoot * t, abs(Q.y - 2.15));
  col = mix(col, gN, cable * 0.9);
  // lamps, smeared into streaks by the speed and stretched into lines by the build
  float sp = 9.0;
  float rel = zw - floor(zw / sp) * sp;
  float len = 0.12 + u_spd * 0.045 + uFeelTension * uFeelTension * 10.0 * u_streak;
  float dz = rel <= len ? 0.0 : min(rel - len, sp - rel);
  float py = gFoot * t;
  float dy = abs(Q.y - 1.55);
  float lamp = exp(-dz * dz / (0.02 + py * py)) * (1.0 - smoothstep(0.05, 0.05 + 1.5 * py, dy));
  float halo = exp(-dz * dz / (0.2 + py * py)) * exp(-dy * dy / 0.06);
  float li = floor(zw / sp);
  float lh = hash11(li * 2.3 + 0.4);
  vec3 lc = mix(gA, mix(gL, gP, step(0.8, lh)), step(0.55, lh));
  col = ntLift(col, ntDith(col, gA1, halo * 1.4));
  col = ntLift(col, ntDith(col, lc, lamp * 1.6));
  col = ntLift(col, ntDith(col, gW, lamp * 1.6 - 1.0));
  // a low signal lamp now and then
  float rel2 = zw - floor(zw / 23.0) * 23.0;
  float dz2 = rel2 <= len ? 0.0 : min(rel2 - len, 23.0 - rel2);
  float sig = exp(-dz2 * dz2 / (0.01 + py * py)) * (1.0 - smoothstep(0.04, 0.04 + 1.5 * py, abs(Q.y - 0.7)));
  col = ntLift(col, ntDith(col, gP, sig * 1.5));
  br = 0.05;
  return col;
}

vec3 ntStation(vec3 ro, vec3 rd, float s, out float br) {
  float t = (s * (NT_W + 0.9) - ro.x) / rd.x;
  vec3 Q = ro + rd * t;
  float zw = Q.z + u_dist;
  float py = gFoot * t;
  // tiled wall
  vec3 col = ntDith(gM1, gM, 0.35 + 0.3 * step(0.5, fract(Q.y / 0.3)));
  col = mix(col, gN, step(Q.y, 1.25));
  // light boxes and posters
  float rel = zw - floor(zw / 8.0) * 8.0;
  float band = step(1.35, Q.y) * step(Q.y, 1.9);
  float box = band * step(0.5, rel) * step(rel, 3.6);
  float inner = step(1.42, Q.y) * step(Q.y, 1.83) * step(0.65, rel) * step(rel, 3.45);
  col = mix(col, gD, box);
  col = mix(col, ntDith(gL, gW, 0.5), inner);
  float post = band * step(4.6, rel) * step(rel, 6.0);
  float ph = hash11(floor(zw / 8.0) + 0.3);
  col = mix(col, ph < 0.5 ? gP : gA1, post);
  col = mix(col, gP2, post * step(1.55, Q.y) * step(Q.y, 1.65));
  // name band
  float nb = step(1.95, Q.y) * step(Q.y, 2.12);
  col = mix(col, gD, nb);
  col = mix(col, gL, nb * step(0.55, fract(zw / 0.5)) * step(2.0, Q.y) * step(Q.y, 2.07) * step(fract(zw / 14.0), 0.35));
  col = mix(col, gD, 1.0 - smoothstep(0.0, py * 1.2, abs(rel - 7.4) - 0.15));
  br = 0.45;
  return col;
}

vec3 ntMode(float m, vec3 ro, vec3 rd, float s, out float br) {
  if (m < 0.5) return ntTunnel(ro, rd, s, br);
  if (m < 1.5) return ntOpen(ro, rd, s, br);
  return ntStation(ro, rd, s, br);
}

vec3 ntOutside(vec3 ro, vec3 rd, float s, vec3 P) {
  // the new place starts ahead of the car and sweeps back along it
  float m = P.z > u_pz ? u_mc : u_mp;
  float br;
  vec3 col = ntMode(m, ro, rd, s, br);
  // the drop: the windows flood with light for a moment
  col = ntLift(col, ntDith(col, gL, u_blz * 1.3));
  col = ntLift(col, ntDith(col, gW, u_blz * 1.3 - 0.5));
  return col;
}

/* ---------------- the route display ---------------- */

vec3 ntDisplay(vec2 q, out float lit) {
  // q: panel coords from the bottom-left, in glyph pixels (31 x 7)
  vec2 c = floor(q);
  lit = 0.0;
  vec3 col = gD;
  if (c.x < 0.5 || c.y < 0.5 || c.x > 30.5 || c.y > 5.5) return col;
  float on = 0.0;
  vec2 g = c - vec2(1.0, 1.0);
  float tsec = max(u_tm, 0.0);
  float mm = floor(tsec / 60.0);
  float ss = floor(mod(tsec, 60.0));
  float ci = floor(g.x / 4.0);
  vec2 lc = vec2(g.x - ci * 4.0, g.y);
  if (ci < 0.5) on = hmDigit(lc, mod(floor(mm / 10.0), 10.0));
  else if (ci < 1.5) on = hmDigit(lc, mod(mm, 10.0));
  else if (ci < 2.5) on = (floor(lc.x) == 1.0 && (floor(lc.y) == 1.0 || floor(lc.y) == 3.0)) ? step(0.5, fract(tsec)) : 0.0;
  else if (ci < 3.5) on = hmDigit(lc, floor(ss / 10.0));
  else if (ci < 4.5) on = hmDigit(lc, mod(ss, 10.0));
  // the line: one stop per section, the ones passed lit, this one blinking
  if (g.x >= 21.0 && g.x <= 28.0) {
    float n = clamp(u_nsec, 2.0, 8.0);
    float pos = u_nsec > 0.5 ? (u_isec + 0.5) / max(u_nsec, 1.0) : uFeelSongT;
    float x = (g.x - 21.0) / 7.0;
    float stop = floor(x * (n - 1.0) + 0.5);
    float isStop = step(abs(x * (n - 1.0) - stop), 0.5 / 7.0 * (n - 1.0) + 0.01);
    float passed = step(x, pos);
    if (g.y > 1.5 && g.y < 2.5) on = max(on, passed * 0.6 + 0.2);
    if (g.y > 0.5 && g.y < 3.5 && isStop > 0.5) {
      float here = step(abs(x - pos), 0.5 / (n - 1.0));
      on = max(on, max(passed, here * step(0.5, fract(uTime * 1.5))));
    }
  }
  lit = on;
  col = on > 0.7 ? gA : (on > 0.1 ? gA1 : ntDith(gD, gN, 0.3 * step(0.5, fract(q.x)) * step(0.5, fract(q.y))));
  return col;
}

/* ---------------- passengers ---------------- */

// a seated figure in profile in the plane z = zf, facing the aisle. u = |x|, y up.
float ntFigure(vec2 q, float nod, float phone, out float headD, out float glowD, out float partK) {
  // drawn a little larger than life so it reads at this pixel size; scaled about the seat edge
  q = (q - vec2(NT_SEATX, NT_SEATY)) / 1.2 + vec2(NT_SEATX, NT_SEATY);
  float lean = 0.03 * nod;
  float d = sdBox(q - vec2(1.03 - lean, 0.77), vec2(0.11, 0.25)) - 0.035;            // torso, a coat
  d = min(d, sdBox(q - vec2(0.93, 0.53), vec2(0.17, 0.07)) - 0.02);                  // thighs
  d = min(d, sdBox(q - vec2(0.79, 0.27), vec2(0.05, 0.24)) - 0.015);                 // shins
  d = min(d, sdBox(q - vec2(0.8, 0.03), vec2(0.08, 0.03)));                          // shoes
  vec2 hc = vec2(0.99 - 0.06 * nod - 0.04 * phone, 1.17 - 0.07 * nod - 0.04 * phone);
  headD = length(q - hc) - 0.1;
  // forearm out to the knees (and a phone in the hand)
  float arm = sdBox(q - vec2(0.9, 0.69 + 0.09 * phone), vec2(0.12, 0.035));
  d = min(d, arm);
  glowD = phone > 0.5 ? sdBox(q - vec2(0.79, 0.8), vec2(0.03, 0.045)) : 1e3;
  // 0 coat, 1 face, 2 hair, 3 headphones
  partK = 0.0;
  if (headD < 0.0) {
    partK = (q.x - hc.x) < -0.01 - 0.04 * (q.y - hc.y) ? 1.0 : 2.0;
    if (length(q - hc - vec2(0.015, 0.0)) < 0.045) partK = 3.0;
  }
  return min(d, headD);
}

void main() {
  vec2 res = uResolution;
  float cell = max(1.0, floor(u_pixel * res.y / 720.0 + 0.5));
  vec2 ci = floor(gl_FragCoord.xy / cell);
  vec2 fc = (ci + 0.5) * cell;
  gB = bayer8(ci);
  vec2 p = (fc / res - 0.5) * vec2(uAspect, 1.0);

  float inten = uFeelIntensity;
  float ten = uFeelTension;
  float rel = uFeelRelease;

  // inks: the darker of bg/fg is the night, the lighter the tube light
  vec3 dark = luma(uBg) <= luma(uFg) ? uBg : uFg;
  vec3 light = luma(uBg) <= luma(uFg) ? uFg : uBg;
  float warm = clamp(u_blz * 0.9 + rel * 0.25, 0.0, 1.0) * u_warmth;
  gD = dark * 0.55;
  gN = dark;
  gM1 = mix(dark, uMuted, 0.5);
  gM = uMuted;
  gM2 = mix(uMuted, light, 0.42);
  gP1 = mix(dark, uAccent2, 0.5);
  gP = uAccent2;
  gP2 = mix(uAccent2, light, 0.45);
  gA1 = mix(dark, uAccent, 0.5);
  gA = uAccent;
  gL = light;
  gW = mix(light, vec3(1.0), 0.5);
  // the drop flashes the car warm
  gM = mix(gM, gA1, warm * 0.55);
  gM2 = mix(gM2, mix(gA, gL, 0.5), warm * 0.7);
  gM1 = mix(gM1, mix(gN, gA, 0.35), warm * 0.4);

  // camera: sway and bob with the tempo, a dolly down the aisle on the build
  float swA = sin(u_ride * PI);
  float amp = u_sway * (0.35 + 0.65 * inten + 0.4 * ten);
  float rumble = (tnoise(vec2(u_dist * 0.7, 3.0)) - 0.5) * 0.012 * clamp(u_spd / 12.0, 0.0, 1.5);
  vec3 ro = vec3(0.05 * swA * amp + rumble, 1.22 - 0.016 * exp(-u_sk * 7.0) * amp + 0.005 * sin(u_ride * TAU), -1.4 + u_dly);
  float roll = 0.014 * swA * amp + rumble * 0.6;
  vec2 pr = rot2(roll) * p;
  vec3 rd = normalize(vec3(pr.x + 0.012 * swA * amp, pr.y, u_fov));
  gFoot = cell / res.y / u_fov;

  // ---------- what does the ray hit?
  float tb = 1e9; vec3 nb = vec3(0.0); int mb = 0;
  // 1 floor, 2 ceiling, 3 wall, 4 end wall
  if (rd.y < 0.0) { float t = -ro.y / rd.y; if (t < tb) { tb = t; nb = vec3(0.0, 1.0, 0.0); mb = 1; } }
  if (rd.y > 0.0) { float t = (NT_H - ro.y) / rd.y; if (t < tb) { tb = t; nb = vec3(0.0, -1.0, 0.0); mb = 2; } }
  float sd = rd.x >= 0.0 ? 1.0 : -1.0;
  { float t = (sd * NT_W - ro.x) / rd.x; if (t > 0.0 && t < tb) { tb = t; nb = vec3(-sd, 0.0, 0.0); mb = 3; } }
  if (rd.z > 0.0) { float t = (NT_END - ro.z) / rd.z; if (t < tb) { tb = t; nb = vec3(0.0, 0.0, -1.0); mb = 4; } }
  // 5 seat, 6 backrest
  ntBench(ro, rd, sd, NT_SEATX, 0.0, NT_SEATY, tb, nb, mb, 5);
  ntBench(ro, rd, sd, NT_BACKX, NT_SEATY, NT_BACKY, tb, nb, mb, 6);

  vec2 rxz = rd.xz;
  float hl = length(rxz);
  vec2 dxz = rxz / hl;
  // 7 grab poles: the three nearest the ray's crossing of the pole line
  {
    float tc = (sd * NT_PX - ro.x) / rd.x;
    float zc = ro.z + rd.z * tc;
    float k0 = floor((zc - 1.8) / 2.0 + 0.5);
    for (int i = 0; i < 3; i++) {
      float zp = 1.8 + (k0 - 1.0 + float(i)) * 2.0;
      if (zp > NT_END - 0.2 || zp < ro.z) continue;
      vec2 v = vec2(sd * NT_PX, zp) - ro.xz;
      float tp = dot(v, dxz);
      float perp = abs(v.x * dxz.y - v.y * dxz.x);
      float R = max(0.022, 0.55 * gFoot * tp / hl);
      if (perp < R && tp > 0.0) {
        float th = (tp - sqrt(R * R - perp * perp)) / hl;
        float yh = ro.y + rd.y * th;
        if (th < tb && yh > 0.0 && yh < NT_RY) {
          tb = th; mb = 7;
          vec3 Ph = ro + rd * th;
          nb = normalize(vec3(Ph.x - sd * NT_PX, 0.0, Ph.z - zp));
        }
      }
    }
  }
  // 8 rails along the ceiling (both sides)
  for (int s = 0; s < 2; s++) {
    float sx = s == 0 ? -NT_RX : NT_RX;
    vec2 o = ro.xy - vec2(sx, NT_RY);
    vec2 d = rd.xy;
    float dd = dot(d, d);
    float tc = -dot(o, d) / dd;
    float dist = length(o + d * tc);
    float R = max(0.018, 0.5 * gFoot * tc);
    float zc = ro.z + rd.z * tc;
    if (tc > 0.0 && tc < tb && dist < R && zc < NT_END) {
      tb = tc; mb = 8;
      nb = normalize(vec3(o + d * tc, -0.2));
    }
  }
  // 9 straps: rings hanging off the rails, swinging
  float ringHit = 0.0;
  for (int s = 0; s < 2; s++) {
    float sx = s == 0 ? -NT_RX : NT_RX;
    float tx = (sx - ro.x) / rd.x;
    float zx = tx > 0.0 ? ro.z + rd.z * tx : ro.z + 40.0;
    float k0 = floor(zx / NT_SS);
    for (int i = 0; i < 3; i++) {
      float k = k0 - 1.0 + float(i);
      float hk = hash11(k * 1.91 + float(s) * 7.0);
      float th = u_swF * (0.7 + 0.6 * hk) + 0.04 * sin(uTime * 4.9 + hk * 6.3);
      float ph = u_swA * (0.6 + 0.8 * hash11(k * 3.3 + float(s))) + 0.05 * sin(uTime * 5.3 + hk * 9.0) * (0.3 + inten);
      float Ls = 0.26;
      float Rr = 0.07;
      float zk = (k + 0.5) * NT_SS + (Ls + Rr) * sin(th) * 0.8;
      if (zk < ro.z + 0.3 || zk > NT_END - 0.3) continue;
      float t = (zk - ro.z) / rd.z;
      if (t <= 0.0 || t > tb) continue;
      vec2 q = ro.xy + rd.xy * t;
      vec2 piv = vec2(sx, NT_RY);
      vec2 dir = vec2(sin(ph), -cos(ph)) ;
      float Le = Ls * cos(th);
      float w = max(0.011, 0.5 * gFoot * t);
      vec2 pa = q - piv;
      float h = clamp(dot(pa, dir) / Le, 0.0, 1.0);
      float dS = length(pa - dir * Le * h) - w;
      vec2 rc = piv + dir * (Le + Rr * cos(th));
      float dR = abs(length((q - rc) * vec2(1.0, 1.0 / max(cos(th), 0.4))) - Rr) - w;
      if (min(dS, dR) < 0.0) {
        tb = t; mb = 9; nb = vec3(0.0, 0.0, -1.0);
        ringHit = dR < dS ? 1.0 : 0.0;
      }
    }
  }
  // 10 passengers, 11 the route display
  float figHead = 0.0; float figGlow = 1e3;
  for (int i = 0; i < 2; i++) {
    float fs = i == 0 ? 1.0 : -1.0;
    float zf = i == 0 ? 4.8 : 14.8;
    float show = i == 0 ? 1.0 : smoothstep(0.4, 0.6, inten);
    if (show < gB) continue;
    float t = (zf - ro.z) / rd.z;
    if (t <= 0.0 || t > tb) continue;
    vec2 q = ro.xy + rd.xy * t;
    q.x *= fs;
    float nod = i == 0 ? (exp(-u_sk * 5.0) * smoothstep(0.2, 0.5, inten + 0.2) * 0.8 + 0.35 + 0.3 * sin(uTime * 0.37)) : 0.0;
    float hd; float gd; float pk;
    float d = ntFigure(q, nod, i == 0 ? 0.0 : 1.0, hd, gd, pk);
    if (min(d, gd) < 0.0) {
      tb = t; mb = 10; nb = normalize(vec3(-fs, 0.2, -0.6));
      figHead = pk; figGlow = gd;
    }
  }
  vec2 dispQ = vec2(0.0);
  {
    float t = (NT_ZD - ro.z) / rd.z;
    vec2 q = ro.xy + rd.xy * t;
    if (t > 0.0 && t < tb && abs(q.x) < 0.66 && q.y > 1.93 && q.y < 2.21) {
      tb = t; mb = 11; nb = vec3(0.0, 0.0, -1.0);
      dispQ = vec2(q.x + 0.66, q.y - 1.93) / 0.0425;
    }
    // the rods it hangs from
    if (t > 0.0 && t < tb && abs(abs(q.x) - 0.45) < max(0.008, 0.5 * gFoot * t) && q.y >= 2.21 && q.y < NT_H) { tb = t; mb = 8; nb = vec3(0.0, -0.3, -1.0); }
  }

  vec3 P = ro + rd * tb;

  // light reaching the hit point: the tubes, the outside through the windows, a little ambient
  float m0 = 5.0 > u_pz ? u_mc : u_mp;
  float flood = 0.0;
  if (m0 < 0.5) {
    float r = mod(5.0 + u_dist, 9.0);
    flood = 0.12 * exp(-r * 0.6) * (1.0 - clamp(u_spd * 0.03, 0.0, 0.7)) + 0.03;
  } else if (m0 < 1.5) {
    float sun = smoothstep(0.24, 0.4, uFeelDay) * (1.0 - smoothstep(0.6, 0.76, uFeelDay));
    flood = 0.06 + 0.16 * sun + 0.7 * rel;
  } else flood = 0.28;
  float amb = (0.06 + 0.1 * inten) * u_expo;
  float side = smoothstep(0.2, NT_W, abs(P.x)) * 0.6 + 0.4;
  float L = ntLight(P, nb) * u_expo + amb + flood * side * (0.5 + 0.5 * max(dot(nb, vec3(-sd, 0.3, 0.0)), 0.0) + 0.3);
  L = 1.0 - exp(-1.5 * L);   // soft shoulder so a fully lit car keeps its shading

  vec3 col = gD;
  float isWindow = 0.0;
  if (mb == 1) {
    // floor: rubber with a pale aisle strip, joints, and the tubes reflected in it
    float stripe = step(abs(P.x), 0.28);
    float lv = L * (0.55 + 0.12 * stripe);
    float joint = 1.0 - smoothstep(0.0, gFoot * tb * 1.2, abs(fract(P.z / 1.5 + 0.5) - 0.5) * 1.5);
    lv *= 1.0 - 0.3 * joint;
    col = ntRamp(gD, gN, gM1, gM, gM2, lv);
    // reflection: mirror the ray into the ceiling tubes
    vec3 rr = vec3(rd.x, -rd.y, rd.z);
    float tr = NT_H / rr.y;
    vec3 C = P + rr * tr;
    float refl = 0.0;
    for (int s = 0; s < 2; s++) {
      float sx = s == 0 ? -NT_LX : NT_LX;
      float wx = 1.0 - smoothstep(0.03, 0.12 + 0.01 * tr, abs(C.x - sx));
      refl += wx * ntTubeAt(C.z, float(s), 0.3);
    }
    refl *= 0.6 * (1.0 - smoothstep(10.0, 26.0, tb * 0.6)) * u_glow;
    col = ntLift(col, ntDith(col, gM1, refl * 2.2));
    col = ntLift(col, ntDith(col, gA1, refl * 2.0 - 0.6));
    col = ntLift(col, ntDith(col, gA, refl * 2.0 - 1.3));
  } else if (mb == 2) {
    // ceiling: panels, a centre vent, the tubes themselves
    float lv = L * 0.75;
    float vent = step(abs(P.x), 0.18);
    lv *= 1.0 - 0.35 * vent;
    col = ntRamp(gD, gN, gM1, gM, gM2, lv);
    col = mix(col, gN, vent * step(0.7, fract(P.z * 2.0)));   // vent slats
    for (int s = 0; s < 2; s++) {
      float sx = s == 0 ? -NT_LX : NT_LX;
      float fx = abs(P.x - sx);
      float hw = max(0.07, 0.6 * gFoot * tb);
      if (fx < hw + 0.03) {
        float b = ntTubeAt(P.z, float(s), 0.0);
        float housing = step(hw, fx);
        vec3 tube = b < 0.05 ? gN : (b < 0.5 ? ntDith(gA1, gA, b * 2.0) : (b < 1.0 ? ntDith(gA, gL, (b - 0.5) * 2.0) : ntDith(gL, gW, b - 1.0)));
        col = mix(tube, gN, housing);
      }
    }
  } else if (mb == 3) {
    // side wall: windows, doors, the ad strip
    float lz = P.z - floor(P.z / NT_BAY) * NT_BAY;
    float bench = step(NT_DOOR, lz);
    float lv = L * 0.8;
    col = ntRamp(gD, gN, gM1, gM, gM2, lv);
    float fw = gFoot * tb;
    if (bench > 0.5) {
      float wz = lz - NT_DOOR;
      float w1 = step(0.15, wz) * step(wz, 2.05);
      float w2 = step(2.25, wz) * step(wz, 4.15);
      float inY = step(1.04, P.y) * step(P.y, 1.74);
      isWindow = (w1 + w2) * inY;
      // frame
      float fr = (w1 + w2) * step(1.0, P.y) * step(P.y, 1.78) * (1.0 - isWindow);
      col = mix(col, ntRamp(gD, gD, gN, gM1, gM, lv), fr);
      // ad cards
      float ad = step(1.84, P.y) * step(P.y, 2.06);
      float card = fract(wz / 0.72);
      float ch = hash11(floor(wz / 0.72) + floor(P.z / NT_BAY) * 5.0 + sd * 3.0);
      float inCard = ad * step(0.08, card) * step(card, 0.92) * step(wz, 4.3);
      vec3 cc = ch < 0.35 ? ntRamp(gN, gP1, gP, gP2, gL, lv * 1.1) : (ch < 0.7 ? ntRamp(gD, gN, gM1, gM2, gL, lv * 1.2) : ntRamp(gN, gA1, gA, gL, gW, lv));
      col = mix(col, cc, inCard);
      col = mix(col, ntRamp(gD, gN, gN, gM1, gM, lv), inCard * step(0.45, fract(P.y / 0.07)) * step(0.5, ch) * step(card, 0.6));
    } else {
      // door: two leaves, tall windows, rubber seal down the middle
      float inDoor = step(0.08, lz) * step(lz, NT_DOOR - 0.08) * step(P.y, 2.0);
      float dw = (step(0.24, lz) * step(lz, 0.74) + step(0.96, lz) * step(lz, 1.46)) * step(0.95, P.y) * step(P.y, 1.76);
      col = mix(col, ntRamp(gD, gN, gM1, gM, gM2, lv * 0.85), inDoor);
      col = mix(col, gD, inDoor * (1.0 - smoothstep(0.0, fw * 1.2, abs(lz - NT_DOOR * 0.5) - 0.01)));
      isWindow = dw;
      col = mix(col, gN, inDoor * (1.0 - smoothstep(0.0, fw, abs(P.y - 2.0))));
    }
    if (isWindow > 0.5) {
      col = ntOutside(ro, rd, sd, P);
      // a faint reflection of the lit car in the glass
      float rf = clamp(L * 0.35, 0.0, 0.4) * (1.0 - step(0.8, m0) * step(m0, 1.2) * rel);
      col = ntLift(col, ntDith(col, gN, rf * 1.5));
    }
  } else if (mb == 4) {
    // the far end: a door with a dark window into the next car
    float lv = L * 0.85;
    col = ntRamp(gD, gN, gM1, gM, gM2, lv);
    float door = step(abs(P.x), 0.44) * step(P.y, 1.98);
    col = mix(col, ntRamp(gD, gN, gN, gM1, gM, lv), door);
    float dw = step(abs(P.x), 0.27) * step(1.0, P.y) * step(P.y, 1.7);
    col = mix(col, ntDith(gD, gN, 0.3), dw);
    float side2 = step(0.62, abs(P.x)) * step(abs(P.x), 1.12) * step(1.05, P.y) * step(P.y, 1.72);
    col = mix(col, ntDith(gD, gN, 0.3), side2);
  } else if (mb == 5) {
    // seat cushion: dusty pink, the kick plate under it in shadow
    float lv = L * (nb.y > 0.5 ? 1.05 : 0.8);
    float plate = step(P.y, 0.3) * step(0.5, abs(nb.x));
    col = plate > 0.5 ? ntRamp(gD, gD, gN, gM1, gM, lv * 0.7) : ntRamp(gD, gN, gP1, gP, gP2, lv);
    // the line between two seats
    float sz = fract((P.z - NT_DOOR) / 0.72);
    col = mix(col, ntRamp(gD, gD, gN, gP1, gP, lv), (1.0 - plate) * step(sz, 0.06) * step(0.5, nb.y + abs(nb.x)));
  } else if (mb == 6) {
    float lv = L * 0.9;
    col = ntRamp(gD, gN, gP1, gP, gP2, lv);
    col = mix(col, ntRamp(gD, gD, gN, gP1, gP, lv), step(fract((P.z - NT_DOOR) / 0.72), 0.05));
  } else if (mb == 7 || mb == 8) {
    // brushed metal: a hard highlight off the tubes
    float spec = pow(clamp(L * 0.9, 0.0, 1.4), 1.3);
    col = ntRamp(gD, gM1, gM, gM2, gL, spec * 0.85 + 0.1);
  } else if (mb == 9) {
    float lv = L * 0.95;
    col = ringHit > 0.5 ? ntRamp(gD, gN, gM1, gM2, gL, lv) : ntRamp(gD, gD, gN, gM1, gM, lv);
  } else if (mb == 10) {
    // a dark coat against the pink seats, a face caught by the tubes, headphones on
    float lv = L;
    col = ntRamp(gD, gD, gN, gN, gM1, lv);
    if (figHead > 0.5) col = ntRamp(gD, gN, gP1, gP2, gL, lv * 1.1 + 0.15);
    if (figHead > 1.5) col = gD;
    if (figHead > 2.5) col = ntDith(gA1, gA, 0.4 + lv);
    if (figGlow < 0.0) col = gW;
  } else if (mb == 11) {
    float lit;
    col = ntDisplay(dispQ, lit);
  }

  // ---------- glow: haze around the tubes, done in the air along the ray
  float glow = 0.0;
  for (int s = 0; s < 2; s++) {
    float sx = s == 0 ? -NT_LX : NT_LX;
    vec2 o = ro.xy - vec2(sx, NT_H - 0.05);
    vec2 d = rd.xy;
    float dd = dot(d, d);
    float tc = -dot(o, d) / dd;
    if (tc > 0.0) {
      tc = min(tc, tb);
      float dist = length(o + d * tc);
      float zc = ro.z + rd.z * tc;
      float b = ntTubeAt(zc, float(s), 0.35);
      float rpx = dist / (gFoot * tc);         // distance in chunky pixels
      glow += b * (0.55 * exp(-dist * dist / 0.035) + 0.5 * exp(-rpx * 0.45));
    }
  }
  glow *= u_glow * (1.0 + 0.6 * warm);
  col = ntLift(col, ntDith(col, gA1, glow * 1.8));
  col = ntLift(col, ntDith(col, gA, glow * 1.6 - 0.7));
  col = ntLift(col, ntDith(col, gL, glow * 1.4 - 1.1));

  // the drop: a warm flash over everything for a beat
  col = ntLift(col, ntDith(col, gA1, u_blz * u_blz * u_blz * 0.6 * u_warmth));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const bps = (bpm: number) => (bpm > 0 ? bpm / 60 : 2);
const pnum = (p: Record<string, unknown>, id: string, d: number) => (typeof p[id] === 'number' ? (p[id] as number) : d);
const since = (hit: (f: Parameters<ClockDef['step']>[1]) => boolean): ClockDef => ({
  init: 100,
  step: (v, f) => (hit(f) ? 0 : Math.min(v + f.dt, 100)),
});
const count = (hit: (f: Parameters<ClockDef['step']>[1]) => boolean): ClockDef => ({
  step: (v, f) => (hit(f) ? (v + 1) % 997 : v),
});

export const nightTrain = defineClockedShaderScene(
  {
    id: 'night-train',
    name: 'Night Train',
    description:
      'The inside of an empty subway car at night, drawn as dithered pixel art in a handful of colours: benches, poles, swinging hand straps and strip lights running down to the far door. The car sways with the tempo, straps swing on every kick, tubes dip on snares and lights streak past the windows; a build stretches the streaks into lines and strobes the car, the drop bursts out of the tunnel into neon, and the break pulls into a quiet station.',
    category: 'form',
    style: 'world',
    fragment,
    tags: ['lofi', 'melancholic', 'nostalgic', 'retro', 'dark', 'calm', 'cinematic', 'indie', 'electronic', 'hypnotic', 'sad', 'driving'],
    params: [
      { id: 'pixel', label: 'Pixel size', group: 'Shape', type: 'number', min: 2, max: 10, step: 0.5, default: 4, hint: 'Size of one art pixel at 720p (scales with the resolution)' },
      { id: 'fov', label: 'Lens', group: 'Shape', type: 'number', min: 0.7, max: 1.6, step: 0.01, default: 1.0, hint: 'Lower is wider: more seats and windows' },
      { id: 'speed', label: 'Train speed', group: 'Motion', type: 'number', min: 0.2, max: 2, step: 0.01, default: 1 },
      { id: 'sway', label: 'Sway', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How much the car rocks with the tempo' },
      { id: 'swing', label: 'Strap swing', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How hard each kick pushes the hand straps' },
      { id: 'flicker', label: 'Light flicker', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Tubes dipping on snares and strobing on the build' },
      { id: 'streak', label: 'Streak stretch', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far tunnel lamps stretch into lines as the build winds up' },
      { id: 'neon', label: 'Neon city', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How much neon floods the windows after the drop' },
      { id: 'expo', label: 'Light', group: 'Color', type: 'number', min: 0.4, max: 1.8, step: 0.01, default: 1 },
      { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Dithered halo round the tubes and their floor reflections' },
      { id: 'warmth', label: 'Warm flash', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
    ],
    modulations: [
      { source: 'bass', param: 'glow', amount: 0.08 },
      { source: 'kick', param: 'sway', amount: 0.06 },
    ],
  },
  {
    // song time, and where we are along the line, for the route display
    tm: { step: (_v, f) => f.audio.time },
    nsec: { step: (_v, f) => f.analysis?.sections?.length ?? 0 },
    isec: { step: (_v, f) => Math.max(0, f.feel.sectionIndex) },
    // share of tubes that are on: one buzzing in the quiet, all of them in the chorus
    lit: {
      step: (v, f) => {
        const fe = f.feel;
        const x = clamp01(-0.12 + 1.45 * (fe.intensity - 0.18) / 0.55 + 0.5 * fe.release);
        return v + (x - v) * (1 - Math.exp(-f.dt * (fe.sinceDrop < 0.3 ? 20 : 1.2)));
      },
    },
    // where the train is: tunnel (0), open city (1) or a station (2). The new place starts at u_pz
    // (car coordinates) and sweeps back along the car as the train travels.
    mc: {
      init: 1,
      step: (v, f, st, mem) => {
        const fe = f.feel;
        const dropEdge = f.audio.drop > 0.6 && (mem.dPrev ?? 0) <= 0.6;
        mem.dPrev = f.audio.drop;
        const hit = dropEdge || fe.sinceDrop < 0.05;
        const hadDrop = fe.sinceDrop < 99;
        mem.stT = v === 2 ? (mem.stT ?? 0) + f.dt : 0;
        let target = 0;
        if (fe.release > 0.25 || (hadDrop && fe.intensity > 0.55)) target = 1;
        else if (hadDrop && fe.intensity < 0.4) target = (mem.stT ?? 0) > 16 ? 1 : 2;
        else if (!hadDrop && fe.intensity < 0.3) target = 1;
        if (hit) target = 1;
        if (target === v) {
          mem.hold = 0;
          return v;
        }
        mem.hold = (mem.hold ?? 0) + f.dt;
        if (!hit && mem.hold < 0.8) return v;
        mem.hold = 0;
        mem.mp = v;
        mem.pz = hit ? 9 : target === 2 ? 18 : 26;
        if (target === 2 && v === 1 && st.spd < 1) mem.pz = -50;
        return target;
      },
    },
    mp: { init: 1, step: (_v, _f, _s, mem) => mem.mp ?? 1 },
    // speed in metres a second: wakes with the song, races on the build, stops at a station
    spd: {
      init: 4,
      step: (v, f, st, mem) => {
        const fe = f.feel;
        const sp = pnum(f.params, 'speed', 1);
        let x = sp * (3 + 9 * fe.intensity + 14 * fe.tension + 8 * fe.release);
        let rate = x > v ? 0.7 : 0.45;
        if (st.mc === 2) {
          x = (mem.pz ?? 0) > -2 ? 2.5 * sp : 0;
          rate = 0.35;
        }
        if (fe.sinceDrop < 0.05) v += 6 * sp;
        return v + (x - v) * (1 - Math.exp(-f.dt * rate));
      },
    },
    pz: {
      init: -50,
      step: (_v, f, st, mem) => {
        const z = Math.max(-200, (mem.pz ?? -50) - st.spd * f.dt);
        mem.pz = z;
        return z;
      },
    },
    dist: { step: (v, f, st) => (v + st.spd * f.dt) % 9000 },
    // the sway: one rock every two beats
    ride: rateClock((f) => bps(f.audio.bpm) * 0.5),
    sk: since((f) => f.audio.kickHit),
    ss: since((f) => f.audio.snareHit),
    sc: count((f) => f.audio.snareHit),
    sh: since((f) => f.audio.hatHit),
    hc: count((f) => f.audio.hatHit),
    // tube strobe phase: faster as the build winds up
    stb: rateClock((f) => bps(f.audio.bpm) * (0.5 + 3.5 * f.feel.tension)),
    // the drop's warm flash
    blz: {
      step: (v, f, _s, mem) => {
        const d = f.audio.drop;
        const hit = (d > 0.6 && (mem.bPrev ?? 0) <= 0.6) || f.feel.sinceDrop < 0.03;
        mem.bPrev = d;
        return hit ? 1 : v * Math.exp(-f.dt * 1.3);
      },
    },
    // the slow dolly down the aisle as tension winds up, drifting back after
    dly: {
      step: (v, f) => {
        const x = 3.2 * f.feel.tension + 1.2 * f.feel.release;
        return v + (x - v) * (1 - Math.exp(-f.dt * (x > v ? 0.6 : 0.12)));
      },
    },
    // strap pendulums: sideways (pushed by the sway and every kick) and fore/aft (by the train speeding up and braking)
    swA: {
      step: (v, f, st, mem) => {
        const fe = f.feel;
        const k = pnum(f.params, 'swing', 1);
        let vel = mem.swAv ?? 0;
        const sway = Math.sin(st.ride * Math.PI);
        let force = -sway * 3 * pnum(f.params, 'sway', 1) * (0.35 + 0.65 * fe.intensity);
        if (f.audio.kickHit) {
          mem.kd = (mem.kd ?? 1) * -1;
          vel += mem.kd * k * (0.35 + 1.1 * fe.intensity + 0.7 * fe.release);
        }
        if (fe.sinceDrop < 0.05) vel += 2.5 * k;
        force += -26 * v - 1.3 * vel;
        vel += force * f.dt;
        mem.swAv = vel;
        return Math.max(-1.1, Math.min(1.1, v + vel * f.dt));
      },
    },
    swF: {
      step: (v, f, st, mem) => {
        const k = pnum(f.params, 'swing', 1);
        let vel = mem.swFv ?? 0;
        const acc = f.dt > 0 ? (st.spd - (mem.spPrev ?? st.spd)) / f.dt : 0;
        mem.spPrev = st.spd;
        if (f.audio.kickHit) vel += 0.25 * k * (0.3 + f.feel.intensity);
        const force = -acc * 0.25 * k - 24 * v - 1.1 * vel;
        vel += force * f.dt;
        mem.swFv = vel;
        return Math.max(-0.9, Math.min(0.9, v + vel * f.dt));
      },
    },
  },
);
