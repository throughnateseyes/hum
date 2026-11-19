import type { AudioFrame } from '../../core/types';
import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, rateClock } from '../shader/lib';

/**
 * Night Windows — a picture-book city at night, seen from above and across. One big tower with a
 * softly curved facade stands in the middle, floor after floor of small lit rooms (warm glass,
 * coloured panels, tiny people, lamps and furniture), and a sea of smaller buildings runs back
 * into a dusk-blue distance. The feeling is lonely-together: a whole city listening to the same
 * song, each behind its own window.
 *
 * The tower is the instrument. Floors are frequency bands (bass at the street, air at the roof)
 * and the lit rooms spread out from the middle of each floor with its band, so the facade reads
 * as an equaliser made of people's evenings. A kick sends a wave of light up the tower floor by
 * floor (and flashes the roof lights when it arrives), snares flick a scatter of rooms on or off
 * and turn a few to cold TV light, hats twinkle in the far city, vocals warm the middle floors.
 * Energy is how awake the city is. A build climbs the tower floor after floor with the city
 * following, a drop turns every light on at once, a break lets them go out one by one.
 *
 * Palette roles: bg = dusk sky and the hazy far city · fg = the warm window light ·
 * accent = second window colour (orange / red panels, warm rooms, roof beacons) ·
 * accent2 = cold TV light and teal panels · muted = building bodies, floor bands and keylines.
 * On a light palette bg and fg swap jobs (the lighter one is always the window light) and a pale
 * muted is darkened, so it stays a city at night.
 */
const fragment = /* glsl */ `
${HM_LIB}

const float NW_HOR = 0.5;      // horizon height (p.y); the city runs right up to it
const float NW_GND = 1.3;      // how far below the horizon the nearest row stands
const float NW_STEP = 0.2485;  // each row back is 0.78x the size of the one in front

// shared tones, set once in main
vec3 gLit;    // window light: fg (or bg, on a light palette, so the windows are always the bright thing)
vec3 gSky;    // dusk sky and distance: bg (or fg on a light palette)
vec3 gBody;   // building bodies: muted, held dark enough for a lit window to read against
vec3 gInk;    // keylines
vec3 gHot;    // window light pushed toward white
vec3 gHaze;   // distance
vec3 gOff;    // dark glass
vec3 gGlow;   // street light
float gDim;   // blue hour: unlit surfaces sink when the city sleeps

float nwFill(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

// six smoothed bands laid up the tower, bottom (sub) to top (air)
float nwBand(float fn) {
  float x = clamp(fn, 0.0, 1.0) * 6.0 - 0.5;
  float i = clamp(floor(x), 0.0, 4.0);
  float f = clamp(x - i, 0.0, 1.0);
  f = f * f * (3.0 - 2.0 * f);
  float a = u_b0; float b = u_b1;
  if (i > 0.5) { a = u_b1; b = u_b2; }
  if (i > 1.5) { a = u_b2; b = u_b3; }
  if (i > 2.5) { a = u_b3; b = u_b4; }
  if (i > 3.5) { a = u_b4; b = u_b5; }
  return mix(a, b, f);
}

// the picture-book panel colours (walls, blinds, curtains)
vec3 nwPanel(float h) {
  if (h < 0.26) return uAccent;
  if (h < 0.46) return uAccent2;
  if (h < 0.62) return mix(uAccent, gLit, 0.55);
  if (h < 0.76) return mix(uAccent2, gSky, 0.45);
  if (h < 0.9) return mix(gLit, vec3(1.0), 0.6);
  return mix(gBody, gSky, 0.6);
}

// What is in one bay of a room: a person, some furniture, a lamp. q.x is centred and measured in
// window heights, q.y runs 0 (floor) to 1 (ceiling). Returns the distance to the dark shapes;
// lampD is the distance to a lamp shade (drawn light, not dark).
float nwRoom(vec2 q, vec2 id, out float lampD) {
  vec4 h = vec4(hash22(id + 3.1), hash22(id * 1.7 + 9.4));
  float d = 1e3;
  lampD = 1e3;
  float side = h.y < 0.5 ? -1.0 : 1.0;
  float fx = 0.0;
  if (h.x < 0.6) {
    // a person: standing or sitting, nodding on the kick, leaning with the bar
    float sit = step(0.5, h.z);
    float top = mix(0.56, 0.38, sit);
    float nod = uKick * 0.035 * u_life;
    float lean = uSway * 0.03 * u_life * (0.3 + u_wk);
    vec2 c = vec2(side * 0.2, 0.0);
    d = min(d, sdBox(q - c - vec2(lean * 0.5, top * 0.5 - 0.03), vec2(0.05, top * 0.5 - 0.03)) - 0.035);
    d = min(d, length(q - c - vec2(lean, top + 0.1 - nod)) - 0.078);
    fx = -side * 0.2;
  }
  float k = floor(h.w * 6.0);
  if (k < 0.5) {            // desk and screen
    d = min(d, sdBox(q - vec2(fx, 0.2), vec2(0.17, 0.02)));
    d = min(d, sdBox(q - vec2(fx + 0.1, 0.1), vec2(0.014, 0.1)));
    d = min(d, sdBox(q - vec2(fx - 0.02, 0.34), vec2(0.08, 0.065)));
  } else if (k < 1.5) {     // sofa
    d = min(d, sdBox(q - vec2(fx, 0.09), vec2(0.15, 0.06)) - 0.03);
    d = min(d, sdBox(q - vec2(fx - side * 0.13, 0.2), vec2(0.025, 0.1)) - 0.025);
  } else if (k < 2.5) {     // plant
    d = min(d, sdBox(q - vec2(fx, 0.07), vec2(0.05, 0.07)));
    d = min(d, length(q - vec2(fx - 0.03, 0.27)) - 0.1);
    d = min(d, length(q - vec2(fx + 0.06, 0.39)) - 0.075);
  } else if (k < 3.5) {     // floor lamp
    d = min(d, sdBox(q - vec2(fx, 0.26), vec2(0.011, 0.26)));
    lampD = sdBox(q - vec2(fx, 0.6), vec2(0.075, 0.06));
  } else if (k < 4.5) {     // shelf with books, a cabinet under it
    d = min(d, sdBox(q - vec2(fx, 0.64), vec2(0.17, 0.016)));
    d = min(d, sdBox(q - vec2(fx - 0.05, 0.73), vec2(0.07, 0.07)));
    d = min(d, sdBox(q - vec2(fx, 0.09), vec2(0.13, 0.09)));
  } else {                  // pendant lamp over a table
    d = min(d, sdBox(q - vec2(fx, 0.9), vec2(0.008, 0.1)));
    lampD = length(q - vec2(fx, 0.76)) - 0.065;
    d = min(d, sdBox(q - vec2(fx, 0.2), vec2(0.15, 0.02)));
    d = min(d, sdBox(q - vec2(fx, 0.1), vec2(0.014, 0.1)));
  }
  return d;
}

// One row of the far city. Rows are numbered from the nearest (0) back; each is a strip of hashed
// building rectangles standing on its own ground line. True when p is inside one of them.
bool nwRowHit(vec2 p, float j, float camx, out vec4 geo, out vec4 hs, out float s) {
  s = exp(-NW_STEP * j);
  float ly = p.y - (NW_HOR - NW_GND * s);
  geo = vec4(0.0);
  hs = vec4(0.0);
  if (ly < 0.0) return false;
  float tall = (j < 1.5 ? 0.45 : 1.0) * u_skyline;      // low roofs in front, so the tower's feet show
  float cw = 0.14 * s;
  float x = (p.x - camx * (s - 0.62)) / cw + hash11(j + 0.7) * 53.0;
  float ix = floor(x);
  hs = vec4(hash22(vec2(ix, j * 7.0 + 1.0)), hash22(vec2(ix + 31.0, j * 3.0 + 5.0)));
  float hh = s * (0.27 + 0.4 * hs.x * hs.x) * tall;
  if (ly > hh) return false;
  float wHalf = 0.5 * (0.7 + 0.29 * hs.y);
  float fx = fract(x) - 0.5 - (hs.z - 0.5) * (1.0 - 2.0 * wHalf);
  if (abs(fx) > wHalf) return false;
  geo = vec4(fx * cw, ly, wHalf * cw, hh);
  return true;
}

// Paint a building of the far city: body, a strip of roof seen from above, a grid of windows.
vec3 nwBuilding(vec4 geo, vec4 hs, float s, float j, float px, float awake, float fillB) {
  float lx = geo.x; float ly = geo.y; float bw = geo.z; float hh = geo.w;
  float fog = 0.9 * smoothstep(1.0, 14.0, j);
  vec3 body = gBody * mix(0.8, 1.2, hs.w);
  if (hs.z > 0.86) body = mix(body, uAccent, 0.28);
  else if (hs.z < 0.1) body = mix(body, uAccent2, 0.2);
  body = mix(body, gSky, 0.16 * hs.y) * gDim;
  float rh = min(hh * 0.4, s * (0.03 + 0.05 * hs.w));
  float wall = hh - rh;
  float lw = px * clamp(s * 2.4, 0.55, 1.2);
  float lightAmt = 0.0;
  vec3 col;
  if (ly > wall) {
    // roof, with a plant room on it
    col = mix(body, gSky * gDim, 0.45) * 1.12;
    float ry = (ly - wall) / rh;
    // parapet: a darker rim just inside the edge
    float rim = min(bw - abs(lx), min(ly - wall, hh - ly)) - 0.12 * rh;
    col = mix(col, body * 0.9, 1.0 - smoothstep(0.0, 1.5 * px, abs(rim) - 0.5 * px));
    // a plant room and a hatch
    vec2 rq = vec2(lx - (hs.y - 0.5) * bw, ly - wall - rh * 0.52);
    col = mix(col, body * 0.7, nwFill(sdBox(rq, vec2(bw * 0.2, rh * 0.16)), px));
    col = mix(col, mix(body, gSky, 0.6), nwFill(sdBox(rq + vec2((hs.x - 0.5) * bw * 1.1, (hs.w - 0.5) * rh * 0.2), vec2(bw * 0.09, rh * 0.08)), px) * step(0.3, hs.x));
    col = mix(col, gInk, (1.0 - smoothstep(lw - px, lw + px, ry * rh)) * 0.8);
  } else {
    float st = hs.z;
    vec2 wc = st < 0.35 ? vec2(0.021, 0.026) : (st < 0.7 ? vec2(0.014, 0.021) : vec2(0.03, 0.024));
    wc = max(wc * s, vec2(3.2 * px));
    float ncol = max(1.0, floor(2.0 * bw / wc.x - 0.4));
    float gx = lx / wc.x + ncol * 0.5;
    float gy = ly / wc.y - 0.4;
    vec2 id = floor(vec2(gx, gy));
    vec2 f = vec2(gx, gy) - id;
    float nrow = floor(wall / wc.y - 0.6);
    float ok = step(0.0, gx) * step(gx, ncol) * step(0.0, gy) * step(id.y + 0.5, nrow);
    vec2 wh = st < 0.35 ? vec2(0.3, 0.3) : (st < 0.7 ? vec2(0.27, 0.34) : vec2(0.46, 0.27));
    float wm = nwFill(sdBox(f - 0.5, wh), 0.8 * px / min(wc.x, wc.y)) * ok;
    // offices light a run of windows together; flats light one by one
    vec2 lid = st < 0.7 ? id : vec2(floor(id.x / 3.0), id.y);
    float seed = hs.x * 57.0 + hs.y * 131.0 + j * 3.0;
    float thr = hash21(lid + seed);
    float mood = (hs.w - 0.5) * 0.4;
    float lvl = awake * 1.08 + mood * (1.0 - 0.8 * awake) + 0.06 * u_life * sin(uTime * (0.05 + 0.12 * thr) + thr * 40.0);
    lvl *= 1.0 - 0.6 * u_bld * (1.0 - fillB);
    lvl = mix(lvl, max(lvl, 0.9), fillB);
    lvl = max(lvl, u_blz * 1.3);
    float lit = smoothstep(thr - 0.04, thr + 0.04, lvl);
    float kind = hash21(lid * 1.3 + seed + 4.0);
    vec3 lc = kind < 0.7 ? gLit : (kind < 0.83 ? mix(gLit, vec3(1.0), 0.55) : (kind < 0.93 ? mix(gLit, uAccent, 0.55) : uAccent2));
    // hats: a few windows somewhere out there catch the light
    float tw = step(hash21(lid + seed + u_hc * 3.7), 0.09 * u_twinkle * (0.4 + 1.6 * fog)) * exp(-u_sh * 5.0);
    lit = max(lit, tw);
    lc = mix(lc, gHot, max(tw, u_blz * 0.6));
    vec3 offc = gOff * (0.78 + 0.3 * hs.w);
    col = mix(body, mix(offc, lc, lit), wm);
    lightAmt = wm * lit;
  }
  // street light climbing the foot of the facade
  col = mix(col, gGlow, u_glowA * 0.5 * exp(-ly / (0.045 * s)));
  // keyline
  float ed = min(bw - abs(lx), hh - ly);
  col = mix(col, gInk, (1.0 - smoothstep(lw - px, lw + px, ed)) * (0.85 - 0.5 * fog));
  // distance: bodies sink into the haze, lights carry further
  return mix(col, gHaze, fog * (1.0 - 0.6 * lightAmt));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);

  float wake = clamp(u_wk, 0.0, 1.0);
  float blaze = u_blz;
  // share of rooms with the light on, before the music adds to it
  float awake = clamp(0.045 + 0.9 * pow(wake, 1.8) + 0.2 * u_lift + (u_awake - 0.5) * 0.7, 0.0, 1.0);

  float day = step(luma(uFg), luma(uBg));
  gLit = mix(uFg, uBg, day);
  gSky = mix(uBg, uFg, day);
  // the shared time of day leans the sky a little: earlier is a bluer, lighter dusk, later a deeper night
  // (dark palettes only; neutral around the middle of the song)
  float night = smoothstep(0.3, 0.75, uFeelDay);
  gSky = mix(gSky, gSky * mix(vec3(1.0, 1.06, 1.16), vec3(0.84, 0.86, 0.9), night), 1.0 - day);
  gBody = uMuted * min(1.0, 0.22 / max(luma(uMuted), 1e-3));
  gDim = mix(0.62, 1.0, clamp(wake * 1.2 + blaze, 0.0, 1.0)) * (1.0 - 0.25 * u_bld);
  gInk = gBody * 0.3;
  gHot = mix(gLit, vec3(1.0), 0.6);
  gHaze = mix(gSky, gLit, 0.03 + 0.07 * wake + 0.12 * blaze) * mix(0.8, 1.0, wake) * (1.0 - 0.3 * u_bld);
  gOff = mix(gBody, gSky, 0.4) * 0.72 * gDim;
  gGlow = mix(uAccent, gLit, 0.6);

  // slow camera: a sideways drift with parallax, a breath of zoom, a small push in on the drop
  float dc = u_cam;
  vec2 cam = vec2(sin(dc * 0.11) + 0.5 * sin(dc * 0.047 + 1.3), sin(dc * 0.083 + 2.0)) * vec2(0.045, 0.006) * u_drift;
  float zoom = 1.0 - 0.012 * sin(dc * 0.06) * u_drift - 0.018 * blaze;
  p *= zoom;
  p.y += cam.y;
  float px = zoom / uResolution.y;

  // ---- tower geometry (always evaluated, so the derivatives are defined everywhere)
  float hwT = clamp(0.4 * uAspect, 0.15, 0.29);
  float yb = -0.47;
  float yt = 0.34;
  float xn = p.x / hwT;
  float xc = clamp(xn, -0.9995, 0.9995);
  float sag = 0.04 * u_curve * hwT / 0.27;                 // the floor lines dip toward the middle
  float uu = mix(xc, asin(xc) / 1.5708, 0.7 * u_curve);    // bays crowd together toward the edges
  float nF = floor(u_floors);
  float nC = max(4.0, floor(u_bays * hwT / 0.27 + 0.5));
  float fh = (yt - yb) / nF;
  float v = (p.y + sag * (1.0 - xc * xc) - yb) / fh;
  float cx = (uu * 0.5 + 0.5) * nC;
  float dcx = fwidth(cx);
  float dv = px / fh;
  float roofTop = yt + 0.04 * (hwT / 0.27) * (1.0 - pow(abs(xc), 6.0));

  vec3 col = vec3(0.0);
  bool done = false;
  vec4 geo; vec4 hs; float s;
  float hitJ = -1.0;

  // ---- which building is here? Only a few rows can reach this height: walk them front to back.
  bool towerHit = abs(xn) < 1.0 && v >= 0.0 && p.y < roofTop;
  float maxHf = 0.67 * u_skyline;
  float dy = max(NW_HOR - p.y, 1e-3);
  float jA = max(0.0, ceil(log((NW_GND - maxHf) / dy) / NW_STEP));
  float jB = min(floor(log(NW_GND / dy) / NW_STEP), 14.0);
  for (int i = 0; i < 9; i++) {
    float j = jA + float(i);
    if (j > jB) break;
    if (j > 1.5 && towerHit) break;                       // rows 0 and 1 stand in front of the tower
    if (nwRowHit(p, j, cam.x, geo, hs, s)) { hitJ = j; break; }
  }

  // ---- the tower
  if (hitJ < 0.0 && towerHit) {
    done = true;
    float shade = 1.0 - 0.16 * pow(abs(xn), 3.0);
    if (v < nF) {
      float fi = floor(v);
      float fv = v - fi;
      float fn = (fi + 0.5) / nF;
      float slab = 0.3;
      // kick: a wave of light climbing floor by floor
      float wpos = u_sk / 0.4;
      float wv = (fn - wpos) * nF / 2.0;
      float wave = exp(-wv * wv) * exp(-u_sk * 1.2) * u_wave;

      if (fi > nF - 1.5) {
        // crown: a dark band with a row of roof lights that flash when the wave arrives
        col = gBody * 0.42 * gDim;
        vec2 lq = vec2(fract(cx) - 0.5, (fv - 0.6) * fh / (2.0 * hwT / nC));
        float ld = length(lq) - 0.16;
        float fl = clamp(max(blaze * 1.2, wave * 1.3), 0.0, 1.0);
        col = mix(col, mix(uAccent * (0.45 + 0.3 * wake), gHot, fl), nwFill(ld, dcx * 0.5));
        col = mix(col, gInk, 1.0 - smoothstep(dv * 0.6, dv * 1.6, fv));
      } else if (fv < slab) {
        // floor band, with a pale lip that carries the kick wave
        col = mix(gBody * 0.52 * gDim, gGlow, 0.2 * awake * awake + 0.3 * blaze);   // a full house spills onto the bands
        float lip = smoothstep(slab - 0.1 - dv, slab - 0.1, fv);
        col = mix(col, mix(mix(gBody, gSky, 0.5) * gDim, gHot, clamp(wave, 0.0, 1.0)), lip);
      } else {
        float b = (fv - slab) / (1.0 - slab);
        float winH = fh * (1.0 - slab);
        // rooms are one or two bays wide, staggered per floor
        float off = mod(fi, 2.0);
        float pair = floor((cx + off) * 0.5);
        float dbl = step(hash21(vec2(pair, fi * 1.3 + 0.7)), 0.42);
        float r0 = dbl > 0.5 ? pair * 2.0 - off : floor(cx);
        float rw = 1.0 + dbl;
        vec2 rid = vec2(r0, fi);
        float a = (cx - r0) / rw;
        vec4 rh = vec4(hash22(rid * vec2(1.0, 1.7) + 0.37), hash22(rid + 5.5));

        // is the light on? energy, the equaliser, the build, the kick wave and the drop all vote
        float bandL = mix(nwBand(fn), spectrum(fn * 0.8 + 0.02), 0.35);
        float reach = bandL * 1.3 * u_eq;
        float xr = abs((r0 + rw * 0.5) / nC * 2.0 - 1.0);
        float inBar = smoothstep(0.0, 0.08, reach - xr + (rh.z - 0.5) * 0.22);
        float lvl = awake + 0.07 * u_life * sin(uTime * (0.06 + 0.14 * rh.w) + rh.w * 40.0);
        float climb = smoothstep(0.0, 0.03, u_bld * 1.1 - fn) * step(0.01, u_bld);
        lvl += inBar * 0.5 * min(u_eq, 1.0) * (1.0 - 0.6 * u_bld);
        // the build: every floor below the line is on, everything above it holds its breath
        lvl = mix(lvl * (1.0 - 0.8 * u_bld), max(lvl, 0.96), climb);
        lvl += wave * 0.9;
        lvl = max(lvl, blaze * 1.3);
        float lit = smoothstep(rh.x - 0.035, rh.x + 0.035, lvl);
        // snare: a scatter of rooms flick over, a few go to TV light
        float sn = hash21(rid + u_sc * 13.7 + 2.2);
        float calm = 1.0 - clamp(blaze * 1.5, 0.0, 1.0);
        lit = mix(lit, 1.0 - lit, step(sn, 0.1 * u_snap * (1.0 - 0.55 * awake)) * calm);
        float tvOn = max(step(hash21(rid + 8.8), 0.06 * u_tv), step(0.9, sn) * step(sn, 0.9 + 0.07 * u_tv * u_snap));
        tvOn *= calm * (1.0 - climb) * (1.0 - 0.6 * awake);
        lit *= 1.0 - tvOn;

        // glass
        vec3 warm = rh.y < 0.6 ? gLit : (rh.y < 0.8 ? mix(gLit, vec3(1.0), 0.5) : mix(gLit, uAccent, 0.4));
        float vox = exp(-pow((fn - 0.5) / 0.2, 2.0)) * u_b3;                      // vocals warm the middle floors
        warm = mix(warm, mix(uAccent, gLit, 0.3), clamp(vox * 1.3, 0.0, 0.75));
        float heat = clamp(inBar * bandL * 0.8 + wave * 0.8 + blaze + vox * 0.3 + 0.3 * u_lift, 0.0, 1.0);
        warm = mix(warm, gHot, heat * 0.6 + 0.15 * awake * awake) * mix(0.84, 1.06, b);
        vec3 dark = mix(gOff * mix(0.8, 1.12, rh.z), gSky * gDim, 0.22 * b);
        float fk = u_tvc + rh.w * 20.0;
        float flick = mix(hash21(vec2(floor(fk), rh.z * 91.0)), hash21(vec2(floor(fk) + 1.0, rh.z * 91.0)), smoothstep(0.7, 1.0, fract(fk)));
        float tvSide = step(0.5, rh.z);
        vec3 tvc = mix(dark, uAccent2, (0.35 + 0.65 * flick) * mix(1.0, 0.45, abs(a - tvSide)));
        vec3 glass = mix(mix(dark, tvc, tvOn), warm, lit);

        // a coloured panel on one side of the room
        float pk = hash21(rid + 1.9);
        if (pk < 0.55 * u_panels) {
          float pw = (0.2 + 0.25 * rh.w) / rw;
          float pm = rh.z < 0.5 ? step(a, pw) : step(1.0 - pw, a);
          vec3 pc = nwPanel(hash21(rid + 6.3));
          glass = mix(glass, mix(mix(dark, pc, 0.3), pc * mix(0.9, 1.05, b), max(lit, tvOn * 0.4)), pm);
        }

        // who and what is inside
        float ba = fract(cx);
        vec2 q = vec2((ba - 0.5) * (2.0 * hwT / nC) / winH, b);
        float lampD;
        float rd = nwRoom(q, vec2(floor(cx), fi), lampD);
        float aq = 0.8 * px / winH;
        vec3 shape = mix(dark * 0.62, gBody * 0.36, lit);
        glass = mix(glass, shape, nwFill(rd, aq) * (0.55 + 0.45 * lit));
        glass = mix(glass, mix(shape, gHot, lit), nwFill(lampD, aq));

        // a curtain that slowly opens and closes
        float ck = hash21(rid + 4.4);
        if (ck < 0.2 * u_life) {
          float cur = smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(uTime * (0.09 + 0.1 * rh.w) + rh.z * TAU));
          float ca = rh.w < 0.5 ? a : 1.0 - a;
          vec3 cc = nwPanel(hash21(rid + 7.7)) * (0.9 + 0.1 * step(0.5, fract(ca * rw * 6.0)));
          glass = mix(glass, mix(mix(dark, cc, 0.25), mix(warm, cc, 0.6), lit), step(ca, cur * 1.02) * step(0.01, cur));
        }

        col = glass;
        // mullions and the frame of the glass
        float da = min(a, 1.0 - a) * rw;
        col = mix(col, gInk, 1.0 - smoothstep(0.5 * dcx, 1.3 * dcx, da));
        float db = min(fv - slab, 1.0 - fv);
        col = mix(col, gInk, 1.0 - smoothstep(0.4 * dv, 1.2 * dv, db));
      }
      col *= shade;
    } else {
      // roof: a pale slab with plant rooms
      col = mix(gBody, gSky, 0.38) * gDim;
      float rx = xn * 3.2 + 0.5;
      vec2 rid = vec2(floor(rx), 77.0);
      vec2 rr = hash22(rid);
      vec2 rq = vec2(fract(rx) - 0.5 - (rr.x - 0.5) * 0.3, (p.y - yt) / (roofTop - yt + 1e-4) - 0.5);
      float bd = sdBox(rq, vec2(0.1 + 0.16 * rr.y, 0.14 + 0.1 * rr.x));
      col = mix(col, gBody * 0.62 * gDim, nwFill(bd, dcx) * step(0.25, rr.x));
      col = mix(col, gInk, 1.0 - smoothstep(0.0, 1.5 * px, roofTop - p.y));
    }
    // the tower's own outline
    col = mix(col, gInk, 1.0 - smoothstep(1.0 * px, 2.0 * px, (1.0 - abs(xn)) * hwT));
  }

  if (hitJ >= 0.0) {
    // the build climbs the screen, the far city following the tower
    float fillB = smoothstep(0.0, 0.06, (u_bld * 1.1 - 0.45) - (p.y + 0.5)) * step(0.01, u_bld);
    col = nwBuilding(geo, hs, s, hitJ, px, awake, fillB);
    done = true;
  }
  if (!done) {
    // streets between the buildings, and the sky over the last roofs
    float sg = dy / NW_GND;
    float jg = -log(sg) / NW_STEP;
    float fog = 0.9 * smoothstep(1.0, 14.0, jg);
    vec3 road = gBody * 0.4 * gDim;
    // the street, in ground units that keep their shape as they recede
    vec2 g = vec2((p.x - cam.x * (sg - 0.62)) / sg, jg * NW_GND * NW_STEP);
    // street lamps: small warm pools, brighter as the city wakes
    vec2 lg = g / vec2(0.075, 0.105);
    vec2 lf = (fract(lg) - 0.5) * vec2(0.075, 0.105) / 0.075;
    float pool = exp(-dot(lf, lf) * 26.0);
    road = mix(road, gGlow, u_glowA * (0.1 + 0.6 * pool));
    road = mix(road, gHot, clamp(u_glowA * 2.0, 0.0, 1.0) * nwFill(length(lf) - 0.035, 0.8 * px / (0.075 * sg)) * smoothstep(1.0, 3.0, 0.005 * sg / px));
    // people out in the street: more of them when the song is up
    vec2 cg = g / 0.0105;
    vec2 ci = floor(cg);
    vec2 ch = hash22(ci + 17.0);
    float who = step(ch.x, 0.06 + 0.4 * awake);
    float cd = length((cg - ci - 0.5 - (ch - 0.5) * 0.6) * vec2(1.25, 1.0)) - 0.17;
    vec3 coat = ch.y < 0.5 ? gInk * 1.4 : mix(nwPanel(fract(ch.y * 7.3)), gBody, 0.3) * mix(0.5, 1.0, clamp(u_glowA * 1.6, 0.0, 1.0)) * gDim;
    road = mix(road, coat, who * nwFill(cd, 0.8 * px / (0.0105 * sg)) * smoothstep(1.5, 4.0, 0.0105 * sg / px));
    col = mix(road, gHaze, fog);
    // past the last roofs: lights too far away to be buildings, some of them caught by the hats
    if (jg > 13.0) {
      vec2 dg = floor(fc / max(2.0, 3.0 * uResolution.y / 1080.0));
      float dh = hash21(dg);
      float dtw = step(hash21(dg + u_hc * 3.7), 0.07 * u_twinkle) * exp(-u_sh * 5.0);
      float far = smoothstep(13.0, 14.0, jg) * (1.0 - smoothstep(18.0, 30.0, jg));
      col = mix(col, mix(gLit, gHot, dtw), far * max(step(dh, 0.04 + 0.12 * awake) * 0.45, dtw * 0.9));
    }
  }

  // ---- roof beacons on two masts: slow blink, a flash on the drop
  for (int i = 0; i < 2; i++) {
    float mx = (i == 0 ? -0.46 : 0.52) * hwT;
    float mTop = yt + 0.05 * hwT / 0.27 + (i == 0 ? 0.05 : 0.032);
    float mBase = yt + 0.02 * hwT / 0.27;
    float md = sdBox(p - vec2(mx, (mTop + mBase) * 0.5), vec2(0.6 * px, (mTop - mBase) * 0.5));
    col = mix(col, gInk, nwFill(md, px * 0.7));
    float bl = max(0.5 + 0.5 * sin(uTime * 1.7 + float(i) * 2.1), 0.0);
    bl = max(pow(bl, 6.0) * (0.5 + 0.5 * wake), blaze);
    float bd = length(p - vec2(mx, mTop));
    col = mix(col, mix(uAccent, gHot, blaze), nwFill(bd - 2.2 * px, px) * (0.35 + 0.65 * bl));
    col = mix(col, mix(uAccent, gHot, blaze * 0.7), bl * 0.45 * exp(-bd * bd / (0.00012 + 0.0012 * blaze)));
  }

  // the drop lifts the whole frame for a moment
  col = mix(col, gHot, blaze * blaze * 0.14);
  col += hmGrain(fc, uTime) * 0.022;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** follow a level with separate rise and fall speeds (per second) */
const ease = (pick: (a: AudioFrame) => number, up: number, down: number): ClockDef => ({
  step: (v, f) => {
    const x = pick(f.audio);
    return v + (x - v) * (1 - Math.exp(-f.dt * (x > v ? up : down)));
  },
});
const since = (hit: (a: AudioFrame) => boolean): ClockDef => ({
  init: 100,
  step: (v, f) => (hit(f.audio) ? 0 : Math.min(v + f.dt, 100)),
});
const count = (hit: (a: AudioFrame) => boolean): ClockDef => ({
  step: (v, f) => (hit(f.audio) ? (v + 1) % 997 : v),
});

export const nightWindows = defineClockedShaderScene(
  {
    id: 'night-windows',
    name: 'Night Windows',
    description:
      'An illustrated city at night with one big tower of small lit rooms in the middle. The floors are frequency bands, so the facade lights up like an equaliser made of people at home; kicks send a wave of light up the tower, snares flick rooms on and off and hats twinkle far away. Quiet parts leave a handful of windows in the blue hour, a drop turns the whole city on at once.',
    category: 'form',
    style: 'world',
    fragment,
    tags: ['cinematic', 'nostalgic', 'melancholic', 'warm', 'dreamy', 'graphic', 'lofi', 'pop', 'indie', 'electronic', 'spacious', 'euphoric'],
    params: [
      { id: 'floors', label: 'Floors', group: 'Shape', type: 'number', min: 10, max: 40, step: 1, default: 22 },
      { id: 'bays', label: 'Rooms per floor', group: 'Shape', type: 'number', min: 10, max: 44, step: 1, default: 24 },
      { id: 'curve', label: 'Facade curve', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How round the front of the tower is' },
      { id: 'skyline', label: 'Skyline height', group: 'Shape', type: 'number', min: 0.4, max: 1.6, step: 0.01, default: 1 },
      { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'life', label: 'Slow life', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Curtains, lights toggling, people nodding along' },
      { id: 'awake', label: 'Awake', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How many rooms are lit before the music adds to it' },
      { id: 'eq', label: 'Equaliser', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far each floor lights up with its frequency band' },
      { id: 'wave', label: 'Kick wave', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85 },
      { id: 'snap', label: 'Snare flicks', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'twinkle', label: 'Far twinkles', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Hats light windows in the far city' },
      { id: 'panels', label: 'Coloured panels', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'tv', label: 'TV light', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Rooms lit by a cold flickering screen' },
      { id: 'glow', label: 'Street glow', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
    ],
    modulations: [{ source: 'sub', param: 'glow', amount: 0.15 }],
  },
  {
    // how awake the city is: quick to wake, slow to fall asleep (lights go out one by one)
    wk: ease((a) => a.energy, 1.3, 0.4),
    // the build, held a moment after it ends so a build without a drop still lets go gently
    // (max with feel.tension: it also rises in the seconds before a drop the analysis knows is coming)
    bld: {
      step: (v, f) => {
        const x = Math.max(f.audio.build, f.feel.tension);
        return v + (x - v) * (1 - Math.exp(-f.dt * (x > v ? 6 : 1.6)));
      },
    },
    // the drop: everything on at once, then settling
    blz: {
      step: (v, f, _s, mem) => {
        const d = f.audio.drop;
        const hit = d > 0.6 && (mem.prev ?? 0) <= 0.6;
        mem.prev = d;
        return hit ? 1 : v * Math.exp(-f.dt * 1.1);
      },
    },
    // after a drop the city stays up later than the energy alone would keep it
    lift: {
      step: (v, f, _s, mem) => {
        const d = f.audio.drop;
        const hit = d > 0.6 && (mem.prev ?? 0) <= 0.6;
        mem.prev = d;
        return hit ? 1 : v * Math.exp(-f.dt * (f.audio.energy < 0.35 ? 0.9 : 0.07));
      },
    },
    sk: since((a) => a.kickHit),
    ss: since((a) => a.snareHit),
    sc: count((a) => a.snareHit),
    sh: since((a) => a.hatHit),
    hc: count((a) => a.hatHit),
    b0: ease((a) => a.sub, 14, 4),
    b1: ease((a) => a.bass, 14, 4),
    b2: ease((a) => a.lowMid, 12, 4),
    b3: ease((a) => a.mid, 12, 3.5),
    b4: ease((a) => a.highMid, 14, 5),
    b5: ease((a) => a.air, 16, 6),
    cam: rateClock((f) => 0.6 + 0.8 * f.audio.energy),
    tvc: rateClock((f) => 2.2 + 7 * f.audio.energy),
    // street glow: rises with the energy, breathes with the bass
    glowA: {
      step: (v, f) => {
        const g = typeof f.params.glow === 'number' ? f.params.glow : 0.6;
        const x = g * (0.1 + 0.9 * f.audio.energy) * (0.85 + 0.3 * f.audio.bass);
        return v + (x - v) * (1 - Math.exp(-f.dt * 3));
      },
    },
  },
);
