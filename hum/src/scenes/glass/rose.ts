import { TONEMAP_LIB } from '../nature/volume';
import { HM_LIB, defineClockedShaderScene } from '../shader/lib';
import { GLASS_LIB, easeClock, hitClocks, relayClocks } from './lib';

/**
 * Rose Window: a stained-glass dome seen from straight below, in rings round a bright oculus.
 *
 * The dome is laid out in log-polar space, so every cell is square however far out it sits, and the
 * rings can flow outward forever: a new ring is born at the oculus and grows to the rim, each one its
 * own design (rings of roundels, pointed petals, wavy flames, chequers, scallop arches, a jewelled
 * band), never the same sequence twice. An iron armature of spokes and hoops holds it. Colour follows
 * the radius, like the dome it is drawn from: a hot core round the oculus, gold flames, a cool rim.
 *
 * Music: the dome breathes and blooms with the song. Rings drift outward slowly in the quiet and
 * faster as it gets louder, and turn against each other on the beat; each kick sends a ring of light
 * out from the centre, snares flash alternate panes, hats glint in the roundels. A build twists the
 * whole rose into a spiral and pulls the light into the oculus; the drop lets the spiral go, surges a
 * ring outward in a flood of light and blooms a new design out from the centre.
 */
const RINGS_PER_TURN = 50;
const RW = ((Math.PI * 2) / RINGS_PER_TURN) * 3;

const fragment = /* glsl */ `
${HM_LIB}
${GLASS_LIB}
${TONEMAP_LIB}

#define RW ${RW.toFixed(6)}
#define RC 0.085

struct RCell { vec2 id; float edge; float iron; float t; float kind; float flag; vec2 lc; };

// one ring of the dome. u = log radius (zoomed), a = angle, r = radius (screen), seed = the design
RCell roRing(float u, float a, float r, float seed) {
  RCell C;
  float k = floor(u / RW);
  float fu = u / RW - k;
  float hk = hash11(k * 1.618 + seed * 0.37);
  float hk2 = hash11(k * 2.71 + seed * 1.13);
  float type = floor(hk * 6.0);
  float dir = (mod(k, 2.0) < 0.5 ? 1.0 : -1.0) * (0.5 + hash11(k + seed * 3.1));
  float aa = a + u_rRot * dir + hk2 * 6.0;
  float H = RW * r;                       // ring height on screen
  C.iron = min(fu, 1.0 - fu) * H;
  C.edge = 9.0;
  C.flag = 0.0;
  C.kind = 0.0;
  C.lc = vec2(0.5);
  float tRing = (hk2 - 0.5) * 0.35;
  if (type < 0.5) {
    // roundels, two or three rows, offset like bricks
    float rows = 2.0 + floor(hk2 * 2.0);
    float fr = fu * rows;
    float row = floor(fr);
    float N = floor(TAU / (RW / rows) + 0.5);
    float s = aa / TAU * N + row * 0.5;
    float seg = floor(s);
    vec2 q = vec2(fract(s), fract(fr)) - 0.5;
    float cell = H / rows;
    float d = length(q) * cell;
    float rad = 0.43 * cell;
    C.edge = abs(d - rad);
    C.lc = q;
    if (d < rad) { C.id = vec2(k * 7.0 + row, seg); C.flag = 1.0; C.kind = 5.0; C.t = tRing + 0.1 * mod(seg + row, 2.0); }
    else { C.id = vec2(k * 7.0 + row + 3.0, seg); C.t = tRing + 0.22; C.kind = 0.0; }
  } else if (type < 1.5) {
    // pointed petals, split down the middle, sky between them
    float N = floor(TAU / RW * 0.55 + 0.5);
    float s = aa / TAU * N;
    float seg = floor(s);
    float x = fract(s) * 2.0 - 1.0;
    float y = fu;
    float segW = TAU / N * r;
    float w = 0.92 * pow(max(1.0 - y, 0.0), 0.6) * smoothstep(-0.05, 0.3, y);
    float e = (w - abs(x)) * segW * 0.5;
    float inner = (y - 0.55) * H;
    C.edge = abs(e);
    if (e > 0.0) {
      C.edge = min(C.edge, abs(x) * segW * 0.5);
      C.edge = min(C.edge, abs(inner));
      C.id = vec2(k * 7.0 + step(0.0, x) + 2.0 * step(0.0, inner), seg);
      C.t = tRing + 0.18 * step(0.0, inner);
      C.kind = 3.0;
      C.flag = 2.0;
    } else {
      C.id = vec2(k * 7.0 + 5.0, seg + step(0.0, x) * 0.5);
      C.t = tRing + 0.4;
      C.kind = 1.0;
    }
  } else if (type < 2.5) {
    // flames: tall strips with wavy borders that sway
    float N = floor(TAU / RW * 2.2 + 0.5);
    float wob = 0.18 * sin(fu * 9.0 + floor(aa / TAU * N) * 1.7 + uTime * 1.3);
    float s = aa / TAU * N + wob;
    float seg = floor(s);
    float segW = TAU / N * r;
    float cut = 0.3 + 0.4 * hash11(seg + k * 5.0 + seed);
    float ex = min(fract(s), 1.0 - fract(s)) * segW;
    C.edge = min(ex, abs(fu - cut) * H);
    C.id = vec2(k * 7.0 + step(cut, fu), seg);
    C.t = tRing + 0.16 * mod(seg, 2.0) + 0.1 * step(cut, fu);
    C.kind = 3.0;
  } else if (type < 3.5) {
    // chequers
    float rows = 3.0;
    float fr = fu * rows;
    float row = floor(fr);
    float N = floor(TAU / (RW / rows) + 0.5);
    float s = aa / TAU * N;
    float seg = floor(s);
    float cell = H / rows;
    C.edge = min(min(fract(s), 1.0 - fract(s)), min(fract(fr), 1.0 - fract(fr))) * cell;
    C.id = vec2(k * 7.0 + row, seg);
    C.t = tRing + 0.3 * mod(seg + row, 2.0);
    C.kind = 0.0;
  } else if (type < 4.5) {
    // scallop arches rising from the inner hoop, a jewel between each pair
    float N = floor(TAU / RW * 1.1 + 0.5);
    float s = aa / TAU * N;
    float seg = floor(s);
    float segW = TAU / N * r;
    vec2 q = vec2((fract(s) - 0.5) * segW, fu * H);
    float arch = length(q - vec2(0.0, H * 0.25)) - segW * 0.46;
    float pillar = abs(q.x) - segW * 0.46;
    float inside = q.y < H * 0.25 ? pillar : arch;
    vec2 jq = vec2(abs(fract(s + 0.5) - 0.5) * segW, q.y - H * 0.8);
    float jw = length(jq) - H * 0.12;
    C.edge = min(abs(inside), abs(jw));
    if (jw < 0.0) { C.id = vec2(k * 7.0 + 4.0, floor(s + 0.5)); C.t = 0.95 - tRing; C.kind = 5.0; C.flag = 1.0; C.lc = jq / (H * 0.24); }
    else if (inside < 0.0) { C.id = vec2(k * 7.0, seg); C.t = tRing; C.kind = 1.0; C.edge = min(C.edge, abs(q.y - H * 0.25) + 9.0 * step(0.0, -q.y)); }
    else { C.id = vec2(k * 7.0 + 2.0, seg); C.t = tRing + 0.35; C.kind = 0.0; }
  } else {
    // a jewelled band: a ribbon of glass between two thin leads, jewels along it
    float N = floor(TAU / RW * 1.6 + 0.5);
    float s = aa / TAU * N;
    float seg = floor(s);
    float segW = TAU / N * r;
    vec2 q = vec2((fract(s) - 0.5) * segW, (fu - 0.5) * H);
    float band = abs(q.y) - H * 0.2;
    float jw = length(q) - min(segW, H) * 0.3;
    C.edge = min(abs(band), abs(jw));
    if (jw < 0.0) { C.id = vec2(k * 7.0 + 1.0, seg); C.t = 0.9 - tRing; C.kind = 5.0; C.flag = 1.0; C.lc = q / (min(segW, H) * 0.6); }
    else if (band < 0.0) { C.id = vec2(k * 7.0 + 2.0, floor(s * 0.5)); C.t = tRing + 0.12; C.kind = 4.0; }
    else { C.id = vec2(k * 7.0 + 3.0 + step(0.0, q.y), seg); C.t = tRing + 0.3; C.kind = 0.0; }
  }
  return C;
}

vec2 roHalf() { return uResolution / min(uResolution.x, uResolution.y); }

void main() {
  vec2 res = uResolution;
  float sm = min(res.x, res.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / (0.5 * sm);
  float px = 2.0 / sm;
  // the kick breathes the dome
  p *= 1.0 - 0.025 * uKick * u_pulse;
  float r = max(length(p), 1e-4);
  float lr = log(r);
  float a = atan(p.y, p.x);
  // the build twists the rose into a spiral
  float twist = u_rTwist;
  a += twist * (lr + 1.2);
  float u = lr - u_rZoom;
  float rMax = length(roHalf());
  float tPos = clamp((lr - log(RC * 1.6)) / (log(rMax) - log(RC * 1.6)), 0.0, 1.0);

  // a new design blooms out from the oculus
  float seed = u_gSeedA;
  float fresh = 0.0;
  if (u_gRelay < 1.0) {
    float front = mix(log(RC), log(rMax) + 0.3, u_gRelay);
    if (lr < front) { seed = u_gSeedB; fresh = exp(-(front - lr) * 4.0); }
  }
  RCell C = roRing(u, a, r, seed);
  float t = clamp(pow(tPos, 1.5) * 0.9 + C.t, 0.0, 1.0);

  vec3 hh = vec3(hash21(C.id * 1.37 + seed * 0.11), hash21(C.id * 2.91 + seed * 0.37 + 5.1), hash21(C.id * 0.71 + seed * 0.73 + 9.7));
  vec3 ink = gPaneInk(t, hh.x, hh.y, hh.z, 0.22);
  // roundels: spun "bullseye" glass, rings rippling round a thick centre
  vec2 bend;
  float thick = (1.0 + 0.6 * hh.y) * (0.7 + 0.6 * tnoise(p * 3.0 + hh.z * 20.0));
  thick *= 1.0 + 0.5 * smoothstep(0.03, 0.0, C.edge);
  if (C.kind > 4.5) {
    float lr2 = length(C.lc);
    bend = normalize(C.lc + 1e-4) * sin(lr2 * 30.0) * 0.05;
    thick *= 1.25 - 0.6 * lr2;
  } else {
    vec3 S = gSurface(p * 1.3, C.kind, hh.x);
    bend = S.xy;
    thick *= 1.0 + 0.3 * S.z;
  }
  vec3 tint = gLin(ink);
  // daylight through the dome: brightest over the oculus, clouds drifting over the glass
  vec2 q = p + bend * 3.0 * u_texture;
  float cloud = 0.75 + 0.5 * tnoise(q * 1.4 + vec2(uTime * 0.03, uTime * 0.017));
  float gather = mix(1.0, 0.25 + 1.6 * exp(-r * 2.2), uFeelTension * 0.85);
  vec3 back = gLin(uFg) * u_gGlow * (0.3 + 1.3 * exp(-r * 1.1)) * cloud;
  back += gLin(uFg) * exp(-length(q) * 4.0) * 3.0 * u_gGlow;
  vec3 seen = back * pow(tint, vec3(thick)) * gather;
  // hits: a ring of light out from the centre on every kick, alternate panes on the snare, glints on hats
  float lp = (lr - log(RC)) - u_sk * 4.0;
  float ring = exp(-lp * lp * 6.0) * exp(-u_sk * 1.2) * u_pulse;
  float fs = step(0.5, mod(C.id.y + u_sc, 2.0)) * step(0.55, hh.y) * exp(-u_ss * 5.0) * u_pulse;
  seen *= 1.0 + 2.2 * ring + 1.5 * fs;
  if (C.kind > 4.5) seen += tint * gLin(uFg) * smoothstep(0.85, 1.0, hash21(C.id + floor(uTime * 8.0))) * uHat * 3.0 * u_pulse;
  seen += gLin(uFg) * tint * fresh * (0.6 + 1.2 * u_gKind);

  // lead between panes, iron hoops between rings, iron spokes
  float lw = 0.0075 * u_lead * clamp(r * 1.6 + 0.3, 0.45, 1.1);
  float S = 8.0 + 4.0 * floor(hash11(seed * 0.71) * 2.0);
  float sa = atan(p.y, p.x) + twist * (lr + 1.2) + u_rRot * 0.15;
  float spoke = abs(fract(sa / TAU * S + 0.5) - 0.5) * TAU / S * r;
  float iw = lw * 2.3;
  float lead = 1.0 - smoothstep(lw - px, lw + px, C.edge);
  float iron = max(1.0 - smoothstep(iw - px, iw + px, C.iron), (1.0 - smoothstep(iw * 0.8 - px, iw * 0.8 + px, spoke)) * step(RC * 2.2, r));
  vec3 leadCol = gLin(uBg) * 0.08 + vec3(0.006);
  leadCol += seen * 0.25 * smoothstep(0.5, 1.0, clamp(C.edge / lw, 0.0, 1.0));
  vec3 col = mix(seen, leadCol, lead);
  vec3 ironCol = gLin(uBg) * 0.05 + vec3(0.004);
  ironCol += gLin(uFg) * 0.03 * u_gGlow * smoothstep(0.0, iw, min(C.iron, spoke));
  col = mix(col, ironCol, iron);

  // the oculus: clear faceted glass with the sun straight through it
  float rc = RC * (1.0 + 0.15 * uKick * u_pulse);
  if (r < rc + lw * 2.0) {
    float fa = floor((a + PI) / TAU * 10.0);
    vec2 fb = (hash22(vec2(fa, seed)) - 0.5) * 0.6;
    vec3 oc = gLin(mix(uFg, vec3(1.0), 0.4)) * (2.5 + 3.0 * exp(-length(p + fb * 0.1) * 30.0)) * u_gGlow * (1.0 + uFeelTension * 1.5);
    float m = 1.0 - smoothstep(rc - px, rc + px, r);
    float rim = 1.0 - smoothstep(lw * 1.8 - px, lw * 1.8 + px, abs(r - rc));
    col = mix(col, oc, m);
    col = mix(col, ironCol, rim);
  }
  // bright glass hazes the iron near the centre
  col += gLin(uFg) * exp(-r * 3.0) * 0.18 * u_gGlow;
  float flood = exp(-uFeelSinceDrop * 1.5) * step(uFeelSinceDrop, 20.0);
  col *= 1.0 + flood * 1.2;
  vec2 uv = gl_FragCoord.xy / res;
  float vig = 1.0 - 0.4 * pow(length((uv - 0.5) * vec2(1.0, 0.85)) * 1.3, 2.2);
  vec3 outc = ntToDisplay(col * vig, u_exposure * (0.85 + 0.25 * uFeelIntensity));
  outc += hmGrain(gl_FragCoord.xy, uTime) * u_grain;
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

export const glassRose = defineClockedShaderScene(
  {
    id: 'glass-rose',
    name: 'Rose Window',
    description:
      'A stained-glass dome seen from below, in rings round a bright oculus: roundels, pointed petals, wavy flames, chequers and jewelled bands, a hot core, gold flames and a cool rim. New rings are born at the centre and flow outward forever, each a new design; they turn against each other on the beat, kicks send rings of light outward, a build twists the rose into a spiral and the drop lets it go in a flood of light and blooms a new dome from the centre.',
    category: 'field',
    style: 'light',
    fragment,
    tags: ['euphoric', 'cinematic', 'epic', 'spiritual', 'hypnotic', 'uplifting', 'anthemic', 'warm', 'colourful', 'psychedelic', 'pop', 'edm', 'emotional', 'dreamy'],
    params: [
      { id: 'flow', label: 'Bloom speed', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast new rings flow out from the oculus (louder is faster)' },
      { id: 'spin', label: 'Spin', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast the rings turn against each other' },
      { id: 'spiral', label: 'Spiral on the build', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far a build twists the rose into a spiral' },
      { id: 'pulse', label: 'Hit light', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Rings of light on the kick, flashing panes on the snare, glints on hats' },
      { id: 'lead', label: 'Lead', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1 },
      { id: 'texture', label: 'Glass texture', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'exposure', label: 'Exposure', group: 'Color', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.025 },
    ],
    modulations: [],
    handInks: 4,
  },
  {
    ...hitClocks,
    gGlow: easeClock((f) => 0.4 + 0.7 * f.feel.intensity + 0.25 * f.audio.level + 0.4 * f.feel.release, 2.5, 0.6),
    ...relayClocks({ phraseBeats: 32, quiet: 4, drop: 1.6 }),
    rZoom: {
      step: (v, f) => {
        const k = typeof f.params.flow === 'number' ? f.params.flow : 1;
        const rate = RW * (0.05 + 0.3 * f.feel.intensity + 0.15 * f.audio.level) * k + RW * 2.4 * Math.exp(-f.feel.sinceDrop * 2.2);
        return (v + f.dt * rate) % (RW * 997);
      },
    },
    rRot: {
      step: (v, f) => {
        const k = typeof f.params.spin === 'number' ? f.params.spin : 1;
        return (v + f.dt * k * (0.04 + 0.22 * f.audio.energy + 0.1 * f.audio.kick)) % 1000;
      },
    },
    rTwist: easeClock((f) => (typeof f.params.spiral === 'number' ? f.params.spiral : 1) * (1.3 * f.feel.tension + 0.06 * f.audio.sway), 3),
  },
);
