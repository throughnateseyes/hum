import type { FrameContext } from '../../core/types';
import { num } from '../../core/uniforms';
import type { ClockDef, ClockState } from './lib';
import { HM_LIB, defineClockedShaderScene } from './lib';

/*
 * Flow Hair — line-integral convolution of fine value noise along a slowly evolving orientation field.
 *
 * Why it looks the way it does (and what keeps it from going janky):
 * - The field is an ORIENTATION field (hair has no head or tail): the radial bends are blended in
 *   doubled-angle space, the spectrum grass as a plain continuous angle, and every streamline step
 *   is sign-aligned with the previous one, so there are no seams where a strand flips and walks
 *   back on itself.
 * - Streamlines are integrated with midpoint steps and sampled densely (taps closer than one noise
 *   cell) under a Hann window, so strands are continuous hairlines that taper at their ends instead
 *   of beaded dashes, and small field changes only nudge the faint ends.
 * - Ink is anti-aliased with fwidth(), so strands stay hairline-sharp without stair-steps at any DPR.
 * - Nothing in the shader reads a raw audio envelope: every drive (mid comb, kick surge, snare flick,
 *   drop gust, spectrum grass, even the user's params / modulations) goes through the springs and
 *   followers below, so the fur sways and swells instead of snapping between frames.
 */
const fragment = /* glsl */ `
${HM_LIB}
#define LOOKUPS 5
#define TAPS 7
float gBase;
float gTurb;
float gScale;
vec2 gOff;
float gTens;
float gGust;
float gGrass;
float gUp;
float gR1; float gA1;
float gR2; float gA2;

// doubled-angle form of a unit direction (d and -d map to the same vector)
vec2 fhDbl(vec2 d) { return vec2(d.x * d.x - d.y * d.y, 2.0 * d.x * d.y); }

// a unit direction for a doubled-angle vector (sign arbitrary; callers align it)
vec2 fhHalf(vec2 v) {
  v /= length(v) + 1e-6;
  return v.x >= 0.0 ? normalize(vec2(1.0 + v.x, v.y)) : normalize(vec2(v.y, 1.0 - v.x));
}

// smoothed band heights, centre (lows) → edges (highs)
float fhGrass(float xs) {
  float f = clamp(xs, 0.0, 1.0) * 5.0;
  float i = min(floor(f), 4.0);
  float t = f - i;
  t = t * t * (3.0 - 2.0 * t);
  float a = i < 0.5 ? u_g0 : i < 1.5 ? u_g1 : i < 2.5 ? u_g2 : i < 3.5 ? u_g3 : u_g4;
  float b = i < 0.5 ? u_g1 : i < 1.5 ? u_g2 : i < 2.5 ? u_g3 : i < 3.5 ? u_g4 : u_g5;
  return mix(a, b, t);
}

// two expanding kick rings (the last one keeps fading while the new one grows)
float fhRings(float rl) {
  float w1 = (rl - gR1) * 6.0;
  float w2 = (rl - gR2) * 6.0;
  return exp(-w1 * w1) * gA1 + exp(-w2 * w2) * gA2;
}

// hair orientation at pixel q, in doubled-angle form
vec2 hairField(vec2 q) {
  vec2 p = (q - 0.5 * uResolution) / uResolution.y;
  float n = snoise(p * gScale + gOff);
  float a = gBase + n * PI * gTurb;
  // spectrum grass: strands stand up from the bottom edge to the height of their band. Blended as a
  // plain angle (a is continuous and gUp is one fixed lift of "up"), so the band edge has no seam.
  float xs = abs(p.x) / (0.5 * uAspect);
  float hgt = fhGrass(xs) * (1.0 + 0.6 * clamp(xs, 0.0, 1.0)) * gGrass;
  float stand = (1.0 - smoothstep(-0.5 + hgt * 0.3, -0.5 + hgt + 0.12, p.y)) * smoothstep(0.0, 0.08, hgt);
  a = mix(a, gUp, stand * 0.8);
  vec2 D = vec2(cos(2.0 * a), sin(2.0 * a));
  float rl = length(p);
  vec2 R = fhDbl(p / max(rl, 0.0001));
  float core = smoothstep(0.02, 0.2, rl);
  // build: the hair is drawn in toward the centre
  D = mix(D, R, gTens * 0.3 * core);
  // kick rings: strands inside the wave lean outward
  D = mix(D, R, clamp(fhRings(rl), 0.0, 0.45) * core);
  // drop: a gust from the centre combs every strand outward
  return mix(D, R, gGust * 0.75 * core);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pxs = max(1.0, uResolution.y / 1080.0);
  float flinch = u_flinch;
  float surge = u_surge * flinch;
  gTens = clamp(u_sBuild * u_tension, 0.0, 1.0);
  gGust = clamp(u_gust * u_burst, 0.0, 1.2);
  gGrass = u_bands * 0.5;
  // the mids sweep the comb, air sways it, snares flick it (all eased)
  gBase = radians(u_sDir) + u_comb * (0.8 * (u_sMid - 0.25) + 0.15 * u_sAir) + 0.25 * u_flick * flinch;
  // the lift of "up" nearest the slider direction (it only flips when the slider crosses 0° / ±180°)
  gUp = PI * 0.5 + PI * floor((radians(u_sDir) - PI * 0.5) / PI + 0.5);
  gOff = vec2(u_clk * 0.11 + u_slide, -u_clk * 0.07 + u_comb * 0.4 * u_sAir);
  gTurb = u_sCurl * (0.6 + 0.25 * u_sHigh + 0.3 * surge) * (1.0 + 0.8 * gTens);
  gScale = u_sScale * (1.0 + 0.6 * gTens);
  // rings fade in (no pop at the centre) and are mostly off-frame by the time a third kick lands
  gR1 = u_sinceKick * 1.3;
  float rise1 = 1.0 - exp(-u_sinceKick * 9.0);
  gA1 = u_wave * u_kickAmp * rise1 * rise1 * exp(-u_sinceKick * 1.8);
  gR2 = u_prevKick * 1.3;
  float rise2 = 1.0 - exp(-u_prevKick * 9.0);
  gA2 = u_wave * u_prevAmp * rise2 * rise2 * exp(-u_prevKick * 1.8) * exp(-u_sinceKick * 6.0);

  // the kick wave gently shoves the strands outward as it passes
  vec2 pc = (fc - 0.5 * uResolution) / uResolution.y;
  float rc = length(pc);
  float front = fhRings(rc) * smoothstep(0.02, 0.2, rc);
  vec2 fs = fc - (pc / max(rc, 0.0001)) * front * 0.012 * uResolution.y;

  // line-integral convolution: LOOKUPS field lookups per side (midpoint steps), TAPS noise taps per
  // lookup (spaced under one noise cell, so strands are continuous), Hann window
  float len = u_sLength * pxs * (1.0 + 0.3 * u_sSub + 0.12 * surge + 0.5 * gGust) * (1.0 - 0.3 * gTens);
  float h = len / float(LOOKUPS * TAPS);
  float cell = max(1.0, u_fineness * pxs);
  float cellC = cell * 10.0; // soft locks: one tap per lookup still oversamples these cells
  vec2 d0 = fhHalf(hairField(fs));
  float acc = vnoise(fs / cell);
  float wsum = 1.0;
  float w2sum = 1.0;
  float accC = vnoise(fs / cellC + 31.7);
  float wsumC = 1.0;
  float w2sumC = 1.0;
  for (int s = 0; s < 2; s++) {
    vec2 dp = s == 0 ? d0 : -d0;
    vec2 q = fs;
    for (int i = 0; i < LOOKUPS; i++) {
      vec2 d = fhHalf(hairField(q + dp * h * float(TAPS) * 0.5));
      d *= dot(d, dp) < 0.0 ? -1.0 : 1.0;
      for (int j = 0; j < TAPS; j++) {
        q += d * h;
        float w = 0.5 + 0.5 * cos(PI * float(i * TAPS + j + 1) / float(LOOKUPS * TAPS + 1));
        acc += w * vnoise(q / cell);
        wsum += w;
        w2sum += w * w;
      }
      float wc = 0.5 + 0.5 * cos(PI * float(i + 1) / float(LOOKUPS + 1));
      accC += wc * vnoise(q / cellC + 31.7);
      wsumC += wc;
      w2sumC += wc * wc;
      dp = d;
    }
  }
  // normalise to ~unit variance (value noise sd ≈ 0.21, neighbouring taps are correlated)
  float z = (acc / wsum - 0.5) * wsum / (0.27 * sqrt(w2sum));
  float zc = (accC / wsumC - 0.5) * wsumC / (0.23 * sqrt(w2sumC));

  // clumps: strands bunch in soft locks
  float clump = snoise(fs / (150.0 * pxs) + vec2(u_clk * 0.03, 0.0));
  z += u_sClump * clump * 0.8;
  // energy only thins / thickens the fur a little (the AGC keeps it near 1 most of a song)
  float th = u_sThreshold + 0.35 - 0.45 * u_sEnergy - 0.35 * gTens - 0.45 * gGust - 0.2 * surge;
  float aa = 0.5 * fwidth(z);
  float ink = smoothstep(th - aa, th + 0.9 + aa, z);

  vec3 col = uBg * (1.0 + (hash21(fc) - 0.5) * 0.035); // paper tooth (static)
  // under-layer: soft broad locks of tint beneath the hairlines
  float wash = smoothstep(-0.2, 1.8, zc + 0.6 * u_sClump * clump) * (0.16 + 0.08 * u_sEnergy + 0.1 * gGust);
  col = mix(col, mix(uBg, uAccent, 0.55), wash);
  vec3 strand = mix(uAccent, uAccent2, 0.6 * smoothstep(0.25, 0.9, vnoise(fs / (180.0 * pxs) + u_clk * 0.05)));
  // the kick wave front picks up accent2
  strand = mix(strand, uAccent2, clamp(front, 0.0, 1.0) * 0.5);
  col = mix(col, strand, ink * 0.9);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── Smoothed drive ───────────────────────── */

type Get = (f: FrameContext, s: ClockState, mem: Record<string, number>) => number;
let key = 0;

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
      const tau = t > v ? rise : fall;
      return v + (t - v) * (1 - Math.exp(-f.dt / tau));
    },
  };
}

/** A scene param, eased (so slider drags and modulation routings glide instead of jumping). */
const eased = (id: string, fallback: number, tau = 0.3) => follow((f) => num(f.params, id, fallback), tau, tau);

/**
 * Critically damped spring (exact step, stable at any dt) toward `target`. It starts from rest, so
 * even a step in the target eases in (zero speed on the first frame) and settles without overshoot.
 */
function spring(omega: number, target: Get): ClockDef {
  const k = `s${key++}`;
  return {
    step: (x, f, s, mem) => {
      const tgt = target(f, s, mem);
      if (!mem[`${k}i`]) {
        mem[`${k}i`] = 1;
        mem[`${k}v`] = 0;
        return tgt;
      }
      const v = mem[`${k}v`] ?? 0;
      const dt = f.dt;
      const y = x - tgt;
      const e = Math.exp(-omega * dt);
      const c = v + omega * y;
      mem[`${k}v`] = (v - omega * c * dt) * e;
      return tgt + (y + c * dt) * e;
    },
  };
}

/**
 * A hit envelope (jumps to `trigger`'s value, decays over `decay` s) seen through a spring, so every
 * hit swells in, peaks a little later and melts away; nothing ever moves at full speed on frame one.
 */
function pulse(omega: number, decay: number, trigger: Get): ClockDef {
  const k = `p${key++}`;
  return spring(omega, (f, s, mem) => {
    const a = trigger(f, s, mem);
    const env = a ? a : (mem[k] ?? 0) * Math.exp(-f.dt / decay);
    mem[k] = env;
    return env;
  });
}

const RING_GAP = 0.3;
/** A kick starts a new ring (read by the ring clocks before `sinceKick` steps). */
const ringStarts = (f: FrameContext, s: ClockState) => f.audio.kickHit && s.sinceKick > RING_GAP;

/** True on the frame the drop envelope crosses 0.6 (once per drop). */
function dropFired(f: FrameContext, mem: Record<string, number>, k: string) {
  const d = f.audio.drop;
  const fired = d > 0.6 && (mem[k] ?? 0) <= 0.6;
  mem[k] = d;
  return fired;
}

export const flowHair = defineClockedShaderScene(
  {
    id: 'flow-hair',
    name: 'Flow Hair',
    description:
      'Thousands of hairline strokes combed through a slowly evolving flow field (line-integral convolution) — ultramarine on paper over soft locks of tint. The spectrum lifts strands from the bottom edge like grass, kicks send an eased surge and a ring through the fur, snares flick the comb, build-ups draw the hair inward and a drop blows a slow gust out of the centre that re-combs everything.',
    category: 'field',
    fragment,
    tags: ['organic', 'editorial', 'calm', 'textured', 'flowing', 'minimal', 'delicate', 'hypnotic'],
    light: true,
    params: [
      { id: 'scale', label: 'Field scale', group: 'Shape', type: 'number', min: 0.3, max: 4, step: 0.01, default: 1.4 },
      { id: 'curl', label: 'Curl', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8 },
      { id: 'direction', label: 'Direction', group: 'Shape', type: 'number', min: -180, max: 180, step: 1, default: 30, hint: 'degrees' },
      { id: 'length', label: 'Stroke length', group: 'Strokes', type: 'number', min: 8, max: 120, step: 1, default: 48, hint: 'px' },
      { id: 'fineness', label: 'Fineness', group: 'Strokes', type: 'number', min: 1, max: 4, step: 0.05, default: 1.5, hint: 'strand width in px' },
      { id: 'threshold', label: 'Sparseness', group: 'Strokes', type: 'number', min: -1, max: 2, step: 0.01, default: 0.4 },
      { id: 'clump', label: 'Clumping', group: 'Strokes', type: 'number', min: 0, max: 2, step: 0.01, default: 0.6 },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: 'comb', label: 'Comb (mid/air)', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'wave', label: 'Kick wave', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
      { id: 'flinch', label: 'Kick flinch', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.6, hint: 'Kicks send an eased surge through the hair; snares flick the comb' },
      { id: 'bands', label: 'Spectrum grass', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Strands stand up from the bottom edge to the height of their band' },
      { id: 'burst', label: 'Drop gust', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Build-ups twist the field tighter and draw it inward' },
    ],
    modulations: [
      { source: 'mid', param: 'direction', amount: 0.03 },
      { source: 'air', param: 'curl', amount: 0.08 },
      { source: 'energy', param: 'threshold', amount: -0.12 },
    ],
  },
  {
    // eased audio (rise, fall in seconds)
    sMid: follow((f) => f.audio.mid, 0.35, 0.7),
    sAir: follow((f) => f.audio.air, 0.3, 0.7),
    sHigh: follow((f) => f.audio.highMid, 0.25, 0.6),
    sSub: follow((f) => Math.max(f.audio.sub, f.audio.bass), 0.12, 0.5),
    sEnergy: follow((f) => f.audio.energy, 0.3, 0.9),
    sBuild: follow((f) => f.audio.build, 0.4, 0.8),
    // spectrum grass, six bands from the centre out
    g0: follow((f) => f.audio.sub, 0.08, 0.35),
    g1: follow((f) => f.audio.bass, 0.08, 0.35),
    g2: follow((f) => f.audio.lowMid, 0.08, 0.35),
    g3: follow((f) => f.audio.mid, 0.08, 0.35),
    g4: follow((f) => f.audio.highMid, 0.08, 0.35),
    g5: follow((f) => f.audio.air, 0.08, 0.35),
    // eased params (so modulation routings and slider drags glide)
    sDir: eased('direction', 30, 0.4),
    sCurl: eased('curl', 0.8),
    sScale: eased('scale', 1.4, 0.4),
    sLength: eased('length', 48),
    sThreshold: eased('threshold', 0.4),
    sClump: eased('clump', 0.6),
    // kick: a surge that swells in over ~0.15 s and melts away
    surge: pulse(13, 0.25, (f) => (f.audio.kickHit ? Math.max(0.05, Math.min(1, f.audio.kick)) : 0)),
    // snare: the comb flicks one way, then the other
    flick: pulse(11, 0.25, (f, _s, mem) => {
      if (!f.audio.snareHit) return 0;
      mem.snareSign = (mem.snareSign ?? 1) > 0 ? -1 : 1;
      return mem.snareSign * Math.max(0.05, Math.min(1, f.audio.snare));
    }),
    // drop: a gust that swells over ~0.5 s and settles over ~2 s
    gust: pulse(3.5, 1.8, (f, _s, mem) => (dropFired(f, mem, 'gustPrev') ? 1.25 : 0)),
    // drop: the noise field glides to a new combing (spring, so it eases in and out)
    slide: spring(1.4, (f, _s, mem) => {
      if (dropFired(f, mem, 'slidePrev')) mem.slideTarget = (mem.slideTarget ?? 0) + 1.8;
      return mem.slideTarget ?? 0;
    }),
    // audio-scaled time (integrated, so speed changes never make the phase jump)
    clk: {
      step: (v, f, s) => (v + f.dt * num(f.params, 'speed', 0.15) * (0.5 + 1.2 * s.sEnergy + 0.4 * s.sMid + 1.0 * s.sBuild)) % 10000,
    },
    // kick rings: the previous ring keeps expanding (and melts away) while the new one grows; kick
    // rolls closer than RING_GAP don't restart the ring (the surge carries them)
    prevKick: { init: 100, step: (v, f, s) => Math.min((ringStarts(f, s) ? s.sinceKick : v) + f.dt, 100) },
    prevAmp: { step: (v, f, s) => (ringStarts(f, s) ? s.kickAmp : v) },
    sinceKick: { init: 100, step: (v, f, s) => (ringStarts(f, s) ? 0 : Math.min(v + f.dt, 100)) },
    kickAmp: { step: (v, f, s) => (f.audio.kickHit && s.sinceKick === 0 ? Math.min(1, f.audio.kick) : v) },
  },
);
