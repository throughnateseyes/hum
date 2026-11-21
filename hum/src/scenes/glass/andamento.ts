import { TONEMAP_LIB } from '../nature/volume';
import { HM_LIB, defineClockedShaderScene } from '../shader/lib';
import { GLASS_LIB, easeClock, hitClocks, relayClocks } from './lib';

/**
 * Andamento: a glass-tile mosaic whose tiles are laid in rows that follow the forms, the way a
 * mosaicist lays smalti (the rows are the "andamento").
 *
 *   - motifs (a sun, a flower, an owl's eye, a target, a whirlpool) are laid in rings of hand-cut
 *     tiles round their centres; their outline is echoed in a halo of background rows, and beyond it
 *     the background flows in long wavy rows like water
 *   - every tile is cut by hand: uneven sides, a slight turn, grout between. Tiles are glass, lit from
 *     the room: each sits at its own small tilt so the light catches some and not others, a bevelled
 *     edge, gold-leaf tiles that flash, iridescent ones that shift colour as the light moves
 *
 * Music: the background rows ripple and flow with the song; the motifs turn slowly, the eye's pupil
 * opens with the bass and the sun's rays grow with the energy. Each kick sends a ring of tilting
 * tiles across the wall (a ring of glints), snares flip a scatter of tiles over to their gold backs.
 * A build sets the tiles trembling and dims the background round the motifs; every new part of the
 * song the tiles flip over in a wave and a new mosaic assembles out of them, fast and bright on the
 * drop. Never the same mosaic twice.
 */
const fragment = /* glsl */ `
${HM_LIB}
${GLASS_LIB}
${TONEMAP_LIB}

#define NM 4

struct Tile { vec2 id; vec2 l; vec2 c; float t; float kind; float cell; float seam; vec2 ax; float deep; };

vec2 anHalf() { return uResolution / min(uResolution.x, uResolution.y); }

// motif i of a design: centre xy, radius z, type w
vec4 anMotif(float i, float seed) {
  vec2 hf = anHalf();
  float h = hash11(seed * 0.37 + i * 1.91);
  // the first motif is big and near the middle, the others smaller, spread out
  vec2 C = i < 0.5 ? (hash22(vec2(seed, 1.7)) - 0.5) * hf * 0.6
                   : (hash22(vec2(seed * 1.3, i * 4.1)) - 0.5) * (hf * 2.0 - 0.3);
  float R = i < 0.5 ? 0.55 + 0.35 * h : 0.22 + 0.3 * h;
  float type = floor(hash11(seed * 2.3 + i * 0.77) * 5.0);
  if (i > 0.5 && hash11(seed * 5.9 + i) < 0.25) R = 0.0;
  return vec4(C, R, type);
}

// the background: long wavy rows, drifting
float anField(vec2 p, float seed, out vec2 g) {
  float ang = hash11(seed * 1.3) * TAU;
  vec2 dir = vec2(cos(ang), sin(ang));
  float A = (0.08 + 0.08 * hash11(seed * 2.1)) * (0.85 + 0.3 * uFeelIntensity);
  vec2 k1 = rot2(hash11(seed * 3.3) * TAU) * vec2(1.6, 0.0);
  vec2 k2 = rot2(hash11(seed * 4.7) * TAU) * vec2(2.6, 0.0);
  float t = u_aFlow;
  float a1 = dot(p, k1) + t, a2 = dot(p, k2) - t * 1.3;
  g = dir + A * cos(a1) * k1 + A * 0.6 * cos(a2) * k2;
  return dot(p, dir) + A * sin(a1) + A * 0.6 * sin(a2);
}

// colour of a motif's tile (palette position; < -0.5 dark, > 1.5 light, -9 = halo / background)
float anMotifT(float type, float nd, float phi, float row, float seg, float h, out float deep) {
  deep = 0.0;
  float rays = 10.0 + 2.0 * floor(h * 5.0);
  float tri = abs(fract(phi * rays / TAU + 0.5) - 0.5) * 2.0;
  if (type < 0.5) {
    // sun: a gold disc, a ring, rays that grow with the energy
    if (nd < 0.3) return 0.95 - 0.06 * mod(row + seg, 2.0);
    if (nd < 0.42) return 0.0;
    float reach = 0.6 + 0.4 * uFeelIntensity;
    if (tri < (1.0 - (nd - 0.42) / (0.58 * reach)) * 0.8) return step(0.5, tri / 0.8) > 0.5 ? 0.96 : 0.3;
    return -9.0;
  }
  if (type < 1.5) {
    // flower: dark seeds, a ring, petals with a deeper edge
    float k = 5.0 + floor(h * 4.0);
    float pt = abs(fract(phi * k / TAU + 0.5) - 0.5) * 2.0;
    if (nd < 0.2) return mod(row + seg, 3.0) < 0.5 ? 0.95 : -1.0;
    if (nd < 0.28) return 0.95;
    float w = pow(sin(PI * clamp((nd - 0.24) / 0.76, 0.0, 1.0)), 0.6) * 0.85;
    if (pt < w) { deep = step(w - 0.2, pt); return 0.02 + 0.3 * nd * nd; }
    return -9.0;
  }
  if (type < 2.5) {
    // an owl's eye: the pupil opens with the bass, a gold iris, a dark rim, pale feathers
    float pr = 0.26 + 0.14 * uBass + 0.06 * uFeelTension;
    if (nd < pr) return (row < 1.5 && seg < 0.5) ? 2.0 : -1.0;
    if (nd < 0.7) return 0.95 + 0.04 * (h - 0.5) - 0.1 * step(0.8, fract(seg * 0.618));
    if (nd < 0.8) return -1.0;
    if (tri < 0.85) return mod(seg, 3.0) < 0.5 ? 0.0 : 2.0;
    return -9.0;
  }
  if (type < 3.5) {
    // target: bands of two inks
    float w = 1.0 + floor(h * 3.0);
    return mod(floor(row / w), 2.0) < 0.5 ? 0.0 + 0.1 * h : (h > 0.5 ? 2.0 : 0.95);
  }
  // whirlpool (its rows are a spiral): three inks in turn
  float m = mod(row, 3.0);
  return m < 0.5 ? 0.02 : (m < 1.5 ? 0.33 : 0.95);
}

Tile anLayout(vec2 p, float seed, float s) {
  Tile T;
  T.cell = s;
  T.deep = 0.0;
  // nearest motif by reach
  float best = 9.0, second = 9.0;
  vec4 M = vec4(0.0);
  float mi = -1.0;
  for (int i = 0; i < NM; i++) {
    vec4 m = anMotif(float(i), seed);
    if (m.z <= 0.0) continue;
    float nd = length(p - m.xy) / m.z;
    if (nd < best) { second = best; best = nd; M = m; mi = float(i); }
    else if (nd < second) second = nd;
  }
  float reach = 1.55;
  if (best < reach) {
    vec2 d = p - M.xy;
    float rho = length(d);
    float rot = u_aTurn * (mod(mi, 2.0) < 0.5 ? 1.0 : -1.0) * (0.6 + 0.4 * hash11(mi + seed)) + hash11(seed + mi * 3.0) * TAU;
    float phi = atan(d.y, d.x) + rot;
    float u = rho / s;
    if (M.w > 3.5) u += (phi - rot) / TAU * 3.0 * (mod(seed, 2.0) < 1.0 ? 1.0 : -1.0);
    float row = floor(u);
    float n = max(1.0, floor(TAU * max(row, 0.0) + 0.5));
    if (row < 0.5) n = 1.0;
    float off = hash11(row * 1.37 + seed + mi * 11.0);
    float a = fract(phi / TAU) * n + off;
    float seg = floor(a);
    T.l = vec2(fract(u), fract(a));
    T.id = vec2(row + mi * 200.0, mod(seg, n));
    float ca = ((seg + 0.5 - off) / n) * TAU - rot;
    vec2 dir = vec2(cos(ca), sin(ca));
    T.c = M.xy + dir * (row + 0.5) * s;
    T.ax = dir;
    float h = hash11(seed * 7.7 + mi * 3.1);
    T.t = best < 1.0 ? anMotifT(M.w, best, phi - rot + hash11(mi + seed) * 2.0, row, mod(seg, n), h, T.deep) : -9.0;
    T.kind = T.t < -8.0 ? 2.0 : 1.0;
    // seam where this motif's halo meets the background or another motif
    T.seam = min(reach - best, (second - best) * 0.5) * M.z;
    if (row < 0.5) T.l = vec2(0.5 + rho / s * 0.45 * cos(phi), 0.5 + rho / s * 0.45 * sin(phi));
  } else {
    vec2 g;
    float F = anField(p, seed, g);
    vec2 gn = normalize(g);
    vec2 perp = vec2(-gn.y, gn.x);
    float ang = hash11(seed * 1.3) * TAU;
    vec2 perp0 = vec2(-sin(ang), cos(ang));
    float u = F / s;
    float row = floor(u);
    float along = dot(p, perp0) / s + hash11(row * 1.61 + seed) * 7.0;
    float seg = floor(along);
    T.l = vec2(fract(u), fract(along));
    T.id = vec2(row, seg);
    T.c = p - (T.l.x - 0.5) * s * gn - (T.l.y - 0.5) * s * perp;
    T.ax = gn;
    T.t = -9.0;
    T.kind = 0.0;
    T.seam = 9.0;
  }
  // background colour: streams of colour run along the rows
  if (T.t < -8.0) {
    vec2 g2;
    float F2 = anField(T.c, seed, g2);
    T.t = 0.6 + 0.4 * tnoise(vec2(F2 * 2.2, dot(T.c, vec2(0.7, -0.4)) * 0.6) + seed * 3.1);
  }
  return T;
}

// one tile's coverage (1 inside, 0 grout), its bevel normal (xy) and the dice
float anCut(Tile T, float squash, float px, out vec2 bev, out vec3 hh) {
  hh = vec3(hash21(T.id * 1.37 + 0.11), hash21(T.id * 2.91 + 5.1), hash21(T.id * 0.71 + 9.7));
  vec2 q = T.l - 0.5;
  q = rot2((hh.x - 0.5) * 0.24) * q;
  q.y /= max(squash, 0.02);
  // hand-cut: each side set in by its own amount
  vec4 ins = 0.07 + 0.09 * vec4(hh.x, hh.y, hh.z, fract(hh.x * 7.7 + hh.y));
  ins *= u_grout;
  vec2 lo = -0.5 + ins.xy, hi = 0.5 - ins.zw;
  vec2 c = 0.5 * (lo + hi), hs = 0.5 * (hi - lo);
  vec2 dq = q - c;
  float rr = 0.08;
  vec2 e = abs(dq) - hs + rr;
  float sd = (length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - rr) * T.cell;
  float cover = 1.0 - smoothstep(-px, px, sd);
  float bw = T.cell * 0.18;
  bev = normalize(dq + 1e-4) * smoothstep(-bw, 0.0, sd) * 0.9;
  // the seam between laid areas is a grout line too
  cover *= smoothstep(0.0, px * 1.5, T.seam - T.cell * 0.08);
  return cover;
}

vec3 anInk(float t, vec3 hh) {
  if (t < -0.5) return mix(uBg, uMuted, 0.15) * (0.35 + 0.25 * hh.y);
  if (t > 1.5) return mix(uFg, uAccent2, 0.08) * (0.85 + 0.15 * hh.y);
  return gPaneInk(t, hh.x, hh.y, hh.z, 0.16);
}

vec3 anShade(Tile T, vec3 hh, vec2 bev, vec2 p, float squash, float flipGold) {
  vec3 alb = gLin(anInk(T.t, hh));
  if (T.deep > 0.5) alb *= 0.45;
  // gold leaf: some of the gold tiles, and the back of a flipped tile
  float gold = step(0.88, T.t) * step(T.t, 1.2) * step(hh.z, 0.4) * step(0.5, T.kind);
  gold = max(gold, flipGold);
  float L = uFeelLight;
  vec3 ld = normalize(vec3(cos(L) * 0.8, 0.45 + 0.45 * sin(L), 0.75));
  vec3 hv = normalize(ld + vec3(0.0, 0.0, 1.0));
  // the tile's own tilt, a ripple on each kick that turns tiles to catch the light, trembling on the build
  vec2 tilt = (hh.xy - 0.5) * 0.22;
  vec2 ko = (hash22(vec2(u_kc, 3.7)) - 0.5) * anHalf() * 1.6;
  float kd = length(T.c - ko);
  float wave = exp(-pow((kd - u_sk * 1.9) / 0.16, 2.0)) * exp(-u_sk * 1.3) * u_shimmer;
  tilt = mix(tilt, hv.xy / hv.z + (hh.xy - 0.5) * 0.08, clamp(wave, 0.0, 1.0));
  tilt += (hash22(T.id + floor(uTime * 24.0)) - 0.5) * 0.25 * uFeelTension * u_shimmer;
  tilt += T.ax * (1.0 - squash) * 2.0;
  vec3 n = normalize(vec3(tilt + bev * 0.65 + (vec2(tnoise(p * 60.0), tnoise(p * 60.0 + 7.0)) - 0.5) * 0.2, 1.0));
  float dif = max(dot(n, ld), 0.0);
  float nh = max(dot(n, hv), 0.0);
  vec3 light = gLin(uFg) * u_aLight;
  vec3 col;
  if (gold > 0.5) {
    vec3 au = gLin(mix(uAccent2, vec3(1.0, 0.78, 0.35), 0.65));
    col = au * (0.25 + 0.35 * dif) * light + au * light * (pow(nh, 14.0) * 2.5 + pow(nh, 120.0) * 6.0);
  } else {
    // glass smalti: colour from inside the tile, a glossy uneven face
    col = alb * (0.35 + 0.85 * dif) * light;
    col += alb * light * 0.18 * (tnoise(p * 9.0 + hh.x * 20.0));
    col += light * (pow(nh, 70.0) * 1.6 + pow(nh, 9.0) * 0.06);
    // iridescent tiles shift colour as the light moves over them
    if (fract(hh.y * 17.3) < u_iris) {
      float ph = dot(n, hv) * 3.0 + hh.x * 2.0 + uFeelLight;
      vec3 film = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + ph));
      col = mix(col, (alb * 0.4 + gLin(film) * 0.6) * light * (0.5 + dif), 0.5);
    }
  }
  return col;
}

void main() {
  vec2 res = uResolution;
  float sm = min(res.x, res.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / (0.5 * sm);
  float px = 2.0 / sm;
  float s = 2.0 / u_tiles;

  Tile A = anLayout(p, u_gSeedA, s);
  // snares flip a scatter of tiles to their gold backs
  vec3 hhA;
  float fl = step(fract(hash21(A.id * 3.3 + 1.0) + u_sc * 0.618), 0.07 * u_shimmer);
  float fph = clamp(u_ss / 0.45, 0.0, 1.0);
  float squash = fl > 0.5 ? abs(cos(fph * PI)) : 1.0;
  float flipGold = fl > 0.5 && fph > 0.25 && fph < 0.75 ? 1.0 : 0.0;
  vec2 bev;
  float cover;
  vec3 col;
  float fresh = 0.0;
  if (u_gRelay < 1.0) {
    // the relay: tiles flip over in a wave, the new mosaic on their other side
    Tile B = anLayout(p, u_gSeedB, s);
    vec2 O = vec2(u_gOx, u_gOy);
    float band = 0.28;
    float front = u_gRelay * (length(anHalf()) + 1.2 + band) - band;
    float pa = clamp((front - length(A.c - O) - hash21(A.id) * 0.15) / band, 0.0, 1.0);
    float pb = clamp((front - length(B.c - O) - hash21(B.id) * 0.15) / band, 0.0, 1.0);
    vec3 hhB;
    vec2 bevB;
    float cb = pb > 0.5 ? anCut(B, -cos(pb * PI), px, bevB, hhB) : 0.0;
    if (cb > 0.001) {
      col = anShade(B, hhB, bevB, p, -cos(pb * PI), 0.0);
      cover = cb;
      fresh = (1.0 - pb) * 2.0;
      A = B;
    } else {
      // an old tile keeps turning (its gold back showing) until the new one beside it lands
      float sq = max(abs(cos(min(pa, 0.5 + 0.5 * pb) * PI)), 0.2);
      cover = anCut(A, sq * squash, px, bev, hhA) * (1.0 - smoothstep(0.75, 1.0, pb));
      col = anShade(A, hhA, bev, p, sq * squash, pa > 0.3 ? 1.0 : flipGold);
    }
  } else {
    cover = anCut(A, squash, px, bev, hhA);
    col = anShade(A, hhA, bev, p, squash, flipGold);
  }
  col += gLin(uFg) * fresh * (0.3 + 0.8 * u_gKind) * u_aLight;
  // grout: dark and matt, a little light in it
  vec3 grout = gLin(uBg) * (0.25 + 0.15 * tnoise(p * 40.0)) * u_aLight;
  col = mix(grout, col, cover);
  // the build dims the background round the motifs
  float focus = A.kind > 0.5 ? 1.0 : 0.0;
  col *= mix(1.0, mix(0.35, 1.25, focus), uFeelTension * 0.8);
  float flood = exp(-uFeelSinceDrop * 1.4) * step(uFeelSinceDrop, 20.0);
  col *= 1.0 + flood * 1.0;
  vec2 uv = gl_FragCoord.xy / res;
  float vig = 1.0 - 0.4 * pow(length((uv - 0.5) * vec2(1.0, 0.85)) * 1.3, 2.2);
  vec3 outc = ntToDisplay(col * vig, u_exposure * 1.1);
  outc += hmGrain(gl_FragCoord.xy, uTime) * u_grain;
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

export const glassAndamento = defineClockedShaderScene(
  {
    id: 'glass-andamento',
    name: 'Andamento',
    description:
      'A glass-tile mosaic laid the way mosaicists lay smalti: rows of hand-cut tiles ring a sun, a flower, an owl\'s eye or a whirlpool, their outline echoed in the background, which flows in long wavy rows like water. Tiles catch the light at their own tilts, gold-leaf tiles flash, iridescent ones shift colour. The rows ripple with the song, kicks send rings of glinting tiles across the wall, snares flip tiles to their gold backs, and every new part the tiles flip over in a wave and a new mosaic assembles.',
    category: 'field',
    style: 'print',
    fragment,
    tags: ['organic', 'colourful', 'playful', 'warm', 'dreamy', 'nature', 'tender', 'groovy', 'indie', 'acoustic', 'folk', 'world', 'hypnotic', 'uplifting'],
    params: [
      { id: 'tiles', label: 'Tiles', group: 'Shape', type: 'number', min: 14, max: 70, step: 1, default: 34, hint: 'Rows of tiles across the short side' },
      { id: 'grout', label: 'Grout', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1, hint: 'Width of the gaps between tiles' },
      { id: 'flow', label: 'Flow', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast the background rows ripple' },
      { id: 'turn', label: 'Motif turn', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'shimmer', label: 'Shimmer', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Rings of glinting tiles on the kick, gold flips on the snare' },
      { id: 'iris', label: 'Iridescent tiles', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
      { id: 'exposure', label: 'Exposure', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.02 },
    ],
    modulations: [],
    handInks: 4,
  },
  {
    ...hitClocks,
    aLight: easeClock((f) => 0.7 + 0.45 * f.feel.intensity + 0.15 * f.audio.level + 0.3 * f.feel.release, 2, 0.8),
    ...relayClocks({ phraseBeats: 32, quiet: 3.5, drop: 1.4 }),
    aFlow: {
      step: (v, f) => {
        const k = typeof f.params.flow === 'number' ? f.params.flow : 1;
        return (v + f.dt * k * (0.12 + 0.6 * f.feel.intensity + 0.3 * f.audio.bass)) % 10000;
      },
    },
    aTurn: {
      step: (v, f) => {
        const k = typeof f.params.turn === 'number' ? f.params.turn : 1;
        return (v + f.dt * k * (0.02 + 0.1 * f.audio.energy)) % 1000;
      },
    },
  },
);
