import type { AudioFrame } from '../../core/types';
import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock, speedClock } from '../shader/lib';

/**
 * Confetti — an edge-to-edge pointillist field: tens of thousands of tiny hard-edged flecks
 * (squares and rhombs) in a handful of flat inks on paper. From a distance it is fizzing colour
 * noise; up close every fleck is crisp. The feeling is joy: the static-electric fizz of a crowd.
 *
 * The music is the hidden order in the noise. Nothing is ever outlined; shapes only exist as a
 * bias in which flecks are there, which way they lean and which ink they carry:
 *   - the flecks lean along a slow flow field (iron filings) and hop along it on every kick;
 *   - a ring of re-inked flecks spreads from a new point on each kick, bass rolls through as
 *     waves of a single ink, the spectrum stands in the field as columns of density;
 *   - a snare swaps two inks inside one band for an instant, hats sprinkle the brightest ink;
 *   - energy sets how full and how many-coloured the paper is (quiet = sparse and cool);
 *   - a build pulls the noise into order (rings, rows or a spiral closing on an emptying
 *     centre), and the drop throws everything back out of that centre, bigger and in every ink.
 *
 * Palette roles: bg = paper · accent = the dominant ink (sky blue), nearly alone when it is
 * quiet · fg = the dark ink (navy), the first to join · accent2 = the hot ink (red: kick ring,
 * hot rings in a build) · muted = the bright ink (yellow: snare band, hat sparks) · plus two
 * mixes: accent printed over muted (green) and accent2 let down with paper (pink). On a dark
 * palette the same roles give neon flecks on black.
 *
 * How it is drawn: six lattices of cells, each at its own angle, scale and drift so no grid can
 * be seen. Every cell holds one fleck, jittered inside it; each pixel tests the four nearest
 * cells of each lattice, so a fleck is never clipped at a cell border. Everything that decides a
 * fleck (is it there, its ink, its lean) is evaluated at the fleck's centre, so flecks stay
 * whole and flat, and the edge is antialiased from the true pixel distance at any resolution.
 */
const fragment = /* glsl */ `
${HM_LIB}
#define CF_LAYERS 6

// direction of the slow flow field at p (height units): the grain the flecks lean along
vec2 cfFlow(vec2 p, float t) {
  float a = 1.7 * sin(p.x * 2.3 + 1.3 * sin(p.y * 1.7 + t * 0.21) + t * 0.13)
          + 1.3 * sin(p.y * 2.9 - t * 0.17 + 1.1 * sin(p.x * 1.4 - t * 0.11));
  return vec2(cos(a), sin(a));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float H = uResolution.y;
  vec2 ctr = 0.5 * uResolution;
  // fleck size is in px of a 1080-short-side frame, so landscape and portrait match
  float pxs = max(0.3, min(uResolution.x, uResolution.y) / 1080.0);
  float t = u_clk;
  float heat = clamp(u_heat, 0.0, 1.0);
  float tens = clamp(u_tens, 0.0, 1.0);

  // the six inks
  vec3 inkOver = mix(hmSat(mix(uAccent, uMuted, 0.5), 1.7), uAccent * uMuted * 1.2, hmIsLight());
  inkOver = clamp(inkOver, 0.0, 1.0);
  vec3 inkTint = mix(uAccent2, hmLight(), 0.5);
  vec3 spark = luma(uFg) > luma(uMuted) ? uFg : uMuted;
  if (distance(spark, uBg) < 0.3) spark = uAccent2;

  // drop: a front races out of the centre; behind it the field is full, bigger and every colour
  float sd = u_sd;
  float Rd = sd * 2.6;
  float dropOn = exp(-sd * 0.4) * min(u_burst, 1.0);
  float burstZ = (1.0 - exp(-sd * 14.0)) * exp(-sd * 0.9) * u_burst;
  float fresh = exp(-sd * 1.3);

  // kick: a ring spreads from a new point; all flecks hop
  float sk = u_sk;
  float kn = u_kickN;
  vec2 kc = (vec2(hash11(kn * 1.37 + 0.2), hash11(kn * 2.71 + 0.7)) - 0.5) * vec2(0.7 * uAspect, 0.6);
  float Rk = sk * 2.2;
  float kWidth = 0.035 + 0.07 * sk;
  float kFade = 0.75 * exp(-sk * 2.4) * u_kickAmp * u_ripple;
  float kShift = hash11(kn * 1.37 + 0.11);
  float kShiftPrev = hash11((kn - 1.0) * 1.37 + 0.11);
  float hopEnv = exp(-sk * 9.0) * u_kickAmp * u_hop;
  float hopAmt = min(0.1 * hopEnv, 0.11);

  // snare: one tilted band of the field
  float sa = (hash11(u_sc * 3.1 + 0.4) - 0.5) * 0.7;
  vec2 sn = vec2(sin(sa), cos(sa));
  float sPos = (hash11(u_sc * 1.93 + 2.2) - 0.5) * 0.75;
  float sWid = 0.07 + 0.08 * hash11(u_sc * 5.3 + 1.1);
  float snOn = clamp(1.0 - u_ss / 0.22, 0.0, 1.0);

  // bass: plane waves, each crest carrying one of the five other inks
  float wa = 0.5 + t * 0.03;
  vec2 wdir = vec2(cos(wa), sin(wa));
  float wAmp = u_waves * (0.04 + 0.6 * uBass);

  // build formation
  float holeR = (0.04 + 0.26 * tens) * min(1.0, uAspect * 1.1);
  float bandsN = max(4.0, floor(7.0 * uAspect + 0.5));
  float ringsK = 6.5 / sqrt(min(1.0, uAspect));

  // smooth, slow fields are read once per pixel (they barely change across a fleck);
  // everything with an edge is read at the fleck's centre so no fleck is ever cut
  vec2 pp = (fc - ctr) / H;
  vec2 flow = cfFlow(pp, t);
  float cloud = sin(pp.x * 2.1 + t * 0.19 + 1.5 * sin(pp.y * 1.6 - t * 0.12))
              * sin(pp.y * 2.6 - t * 0.15 + 1.2 * sin(pp.x * 1.9 + t * 0.1));
  float wPhase = (dot(pp, wdir) * 7.0 - u_bassClk) / TAU;
  float crest = smoothstep(0.55, 0.95, cos(TAU * wPhase)) * wAmp;
  float crestInk = 1.0 + mod(floor(wPhase + 0.5), 5.0);

  // upper bounds (same for every fleck at this pixel) used to skip flecks out of reach early
  float szMax = mix(0.8, 1.2, max(heat, dropOn)) * (1.0 + 0.45 * kFade + 0.45 * dropOn * fresh);
  float elMax = 1.1 + 0.14 * clamp(u_align + (1.0 - u_align) * tens, 0.0, 1.0);
  float mvMax = hopAmt + 0.025;
  float hatThr = 0.09 * uHat;

  float baseCell = u_size * pxs / 0.36;
  vec3 col = uBg;

  for (int l = 0; l < CF_LAYERS; l++) {
    float fl = float(l);
    // big flecks underneath, small on top
    float cellPx = baseCell * mix(1.3, 0.78, fl / float(CF_LAYERS - 1));
    // build draws the layers in, the drop throws them out at different speeds (parallax scatter),
    // and every kick gives them a small push outward
    float zoom = max(0.3, 1.0 - tens * (0.03 + 0.02 * fl) + burstZ * (0.1 + 0.13 * fl) + hopEnv * 0.004 * (1.0 + fl));
    float la = 0.37 + fl * 1.13;
    float lc = cos(la);
    float ls = sin(la);
    mat2 R = mat2(lc, -ls, ls, lc);
    mat2 Rt = mat2(lc, ls, -ls, lc);
    // each lattice slides its own way (three directions 120 degrees apart, so nothing drifts overall)
    vec2 ldir = vec2(lc * lc - ls * ls, 2.0 * lc * ls);
    float aaM = 0.6 / (cellPx * zoom);
    vec2 slide = ldir * (t * 5.0 * (0.6 + 0.2 * fl) + 3.5 * hopEnv) * pxs + vec2(913.0, 517.0) * (fl + 1.0);
    vec2 g = (R * ((fc - ctr) / zoom) + slide) / cellPx;
    vec2 base = floor(g - 0.5);

    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 cell = base + vec2(float(i), float(j));
        vec2 hs = cell + fl * 57.31;
        vec2 h1 = hash22(hs);
        vec2 cpos = cell + 0.1 + 0.8 * h1;
        vec2 dq = g - cpos;
        if (dot(dq, dq) > 0.38) continue;
        vec2 h2 = hash22(hs * 1.31 + 71.7);
        // size, shear and the hat blink are known from the hashes alone:
        // skip now if this pixel is out of the fleck's reach
        float szBase = 0.18 * (0.62 + 0.76 * h2.y);
        float hb = step(fract(h2.x * 91.3 + u_hc * 0.618), hatThr);
        float shear = (fract(h1.x * 53.1) - 0.5) * 0.7;
        float reach = min(szBase * szMax * (1.0 + 0.45 * hb), 0.25) * length(vec2(elMax + abs(shear), 1.0)) + mvMax + aaM;
        if (dot(dq, dq) > reach * reach) continue;
        vec2 h3 = hash22(hs.yx * 0.77 + 13.1);
        // where this fleck sits on screen (height units, centre origin)
        vec2 pw = (Rt * (cpos * cellPx - slide)) * zoom / H;
        float r = length(pw);

        float inside = dropOn * (1.0 - smoothstep(Rd - 0.3, Rd, r));
        float flash = inside * fresh;
        float heatL = max(heat, inside);

        // density: section energy, slow clouds when quiet, spectrum columns (lows in the middle)
        float sx = clamp(abs(pw.x) / (0.5 * uAspect), 0.0, 0.999);
        float bx = (floor(sx * bandsN) + 0.5) / bandsN;
        float sp = textureLod(uSpectrum, vec2(0.02 + 0.8 * bx, 0.5), 0.0).r * (0.7 + 0.9 * bx);
        float dens = (mix(0.24, 0.9, heatL) + 0.2 * cloud * (1.0 - heatL) + u_bands * max(sp - 0.3, -0.12) * 1.6 + 0.15 * flash) * u_density;

        // build: order out of noise
        vec2 tang = vec2(1.0, 0.0);
        float tn = tens * (1.0 - inside);
        float hot = 0.0;
        if (tens > 0.002) {
          float fr = r;
          float arg = u_ringClk;
          if (u_formation > 0.5 && u_formation < 1.5) {
            fr = abs(pw.y);
          } else {
            tang = vec2(-pw.y, pw.x) / max(r, 0.0001);
            if (u_formation > 1.5) arg += atan(pw.y, pw.x) / TAU;
          }
          arg += fr * ringsK;
          float stripe = 0.5 + 0.5 * cos(TAU * arg);
          float hole = smoothstep(holeR * 0.55, holeR, fr);
          dens = mix(dens, clamp((stripe - 0.45) * 3.0, 0.0, 1.05), tn) * mix(1.0, hole, tn);
          hot = tn * step(mod(floor(arg + 0.5), 3.0), 0.5);
        }

        float appear = smoothstep(0.0, 0.09, dens - h2.x);
        if (appear <= 0.0) continue;

        // kick ring
        float kd = length(pw - kc);
        float kx = (kd - Rk) / kWidth;
        float front = exp(-kx * kx) * kFade;

        // ink: mostly the dominant one; energy (and the voice) lets the others in
        float hi = h3.y;
        if (fract(h1.y * 61.7) < 0.4 * min(u_ripple, 1.0)) hi = fract(hi + (kd < Rk ? kShift : kShiftPrev));
        float v = clamp(heatL + 0.25 * uMid - 0.5 * tn, 0.0, 1.0);
        float others = clamp(mix(0.08, 0.5, v) * u_colors + 0.35 * flash, 0.0, 0.92);
        float ink = 0.0;
        float x = (hi - (1.0 - others)) / others;
        if (x >= 0.0) {
          float navy = mix(0.75, 0.17, v);
          if (x < navy) ink = 1.0;
          else {
            float y = (x - navy) / (1.0 - navy);
            ink = y < 0.34 ? 2.0 : (y < 0.63 ? 3.0 : (y < 0.8 ? 4.0 : 5.0));
          }
        }
        // bass waves roll through, each crest carrying one ink
        if (fract(h2.x * 43.3) < crest * (1.0 - flash)) ink = crestInk;
        // build: some rings go hot
        if (ink < 0.5 && fract(h3.x * 23.7) < hot) ink = 2.0;
        // snare: dominant <-> bright ink inside the band
        if (snOn > 0.0 && abs(dot(pw, sn) - sPos) < sWid && fract(h2.y * 13.7) < snOn * 1.4) {
          if (ink < 0.5) ink = 3.0;
          else if (ink > 2.5 && ink < 3.5) ink = 0.0;
        }
        // kick ring front flips to the hot ink
        if (fract(h3.x * 7.7) < front * (1.0 - flash)) ink = 2.0;

        vec3 ic = uAccent;
        if (ink > 0.5) ic = uFg;
        if (ink > 1.5) ic = uAccent2;
        if (ink > 2.5) ic = uMuted;
        if (ink > 3.5) ic = inkOver;
        if (ink > 4.5) ic = inkTint;
        // hats: a sprinkle blinks to the brightest ink
        ic = mix(ic, spark, hb);

        float sz = szBase * mix(0.8, 1.2, heatL) * (1.0 + 0.45 * front + 0.45 * flash) * (1.0 + 0.45 * hb) * appear;
        sz = min(sz, 0.25);

        // lean: flow field (tangent to the formation during a build) blended with a random angle
        float al = clamp(u_align + (1.0 - u_align) * tn, 0.0, 1.0);
        vec2 dir = normalize(mix(flow, tang, tn) + vec2(0.0001, 0.0));
        float idle = sin(t * 1.1 + h3.x * 40.0);
        float ra = ((h3.x - 0.5) * PI + 0.3 * idle) * (1.0 - al);
        float ca = cos(ra);
        float sn2 = sin(ra);
        vec2 ax = vec2(ca * dir.x - sn2 * dir.y, sn2 * dir.x + ca * dir.y);
        // hop on the kick + a small idle shimmy, both along the fleck's own axis
        float mv = hopAmt * (0.4 + 0.6 * h1.x) + 0.025 * idle;
        vec2 ds = Rt * dq - ax * mv;
        vec2 lq = vec2(dot(ds, ax), dot(ds, vec2(-ax.y, ax.x)));
        float el = 1.0 + 0.1 * fract(h1.y * 37.9) + 0.14 * al;
        lq.x += lq.y * shear;
        float d = max(abs(lq.x) - sz * el, abs(lq.y) - sz / el);
        float a = clamp(0.5 - d * cellPx * zoom, 0.0, 1.0);
        col = mix(col, ic, a);
      }
    }
  }

  col += hmGrain(fc, uTime) * 0.02;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const ease = (pick: (a: AudioFrame) => number, up: number, down = up): ClockDef => ({
  step: (v, f) => {
    const target = pick(f.audio);
    return v + (target - v) * (1 - Math.exp(-f.dt * (target > v ? up : down)));
  },
});

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

export const confetti = defineClockedShaderScene(
  {
    id: 'confetti',
    name: 'Confetti',
    description:
      'An edge-to-edge field of tiny hard-edged flecks in a few flat inks on paper, fizzing like a happy crowd. Flecks hop on every kick while a ring of re-inked ones spreads out, bass rolls through as waves of one colour, snares swap two inks in one band and hats sprinkle bright ones. Quiet parts are sparse and cool; a build pulls the noise into rings around an emptying centre and the drop throws it all back out in every colour.',
    category: 'field',
    style: 'print',
    fragment,
    light: true,
    tags: ['playful', 'happy', 'upbeat', 'pop', 'energetic', 'euphoric', 'bouncy', 'graphic', 'tactile', 'indie', 'uplifting', 'electronic'],
    params: [
      { id: 'size', label: 'Fleck size', group: 'Shape', type: 'number', min: 4, max: 26, step: 0.5, default: 9, hint: 'Edge length in px of a 1080p frame' },
      { id: 'density', label: 'Density', group: 'Shape', type: 'number', min: 0.3, max: 1.6, step: 0.01, default: 1, hint: 'How much of the paper is covered; the song still thins and fills it' },
      { id: 'align', label: 'Grain', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'How strongly flecks lean along the hidden flow, like iron filings' },
      {
        id: 'formation',
        label: 'Build formation',
        group: 'Shape',
        type: 'select',
        options: [
          { value: 'rings', label: 'Rings' },
          { value: 'rows', label: 'Rows' },
          { value: 'spiral', label: 'Spiral' },
        ],
        default: 'rings',
        hint: 'The order the noise falls into during a build-up',
      },
      { id: 'speed', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 3, step: 0.01, default: 1 },
      { id: 'hop', label: 'Kick hop', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Every fleck jumps along its grain on a kick' },
      { id: 'ripple', label: 'Kick ring', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'A ring of re-inked flecks spreads from a new point on each kick' },
      { id: 'waves', label: 'Bass waves', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'Waves of a single ink travelling through with the bass' },
      { id: 'bands', label: 'Spectrum columns', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6, hint: 'The spectrum as columns of density, lows in the middle' },
      { id: 'burst', label: 'Drop scatter', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
      { id: 'colors', label: 'Colour mix', group: 'Color', type: 'number', min: 0, max: 1.6, step: 0.01, default: 1, hint: 'How many flecks leave the dominant ink for the others' },
    ],
    modulations: [
      { source: 'mid', param: 'colors', amount: 0.15 },
      { source: 'energy', param: 'density', amount: 0.1 },
    ],
  },
  {
    clk: speedClock('speed', 1, (f) => 0.35 + 0.8 * f.audio.energy + 0.4 * f.audio.bass + 0.6 * Math.max(f.audio.build, f.feel.tension)),
    sk: sinceKickClock,
    kickN: kickCountClock,
    // strength of the last kick, held until the next one
    kickAmp: { step: (v, f) => (f.audio.kickHit ? Math.max(0.35, f.audio.kick) : v) },
    ss: { init: 100, step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)) },
    sc: { step: (v, f) => (f.audio.snareHit ? (v + 1) % 997 : v) },
    hc: { step: (v, f) => (f.audio.hatHit ? (v + 1) % 997 : v) },
    sd: sinceDropClock,
    // section state, eased so the paper fills and empties over a second or two
    heat: ease((a) => a.energy, 1.6, 1.0),
    // build tension: follows the build; after a drop it holds until the front has swept the frame
    tens: {
      step: (v, f, state) => {
        const b = Math.max(f.audio.build, f.feel.tension);
        if (state.sd < 0.45 && b < v) return v;
        return v + (b - v) * (1 - Math.exp(-f.dt * (b > v ? 6 : 5)));
      },
    },
    // the formation closes on the centre faster as the build climbs
    ringClk: { step: (v, f) => (v + f.dt * (0.12 + 1.5 * Math.max(f.audio.build, f.feel.tension))) % 1000 },
    // bass waves travel faster the more bass there is
    bassClk: { step: (v, f) => (v + f.dt * (0.5 + 5 * f.audio.bass + 3 * f.audio.sub)) % (Math.PI * 2000) },
  },
);
