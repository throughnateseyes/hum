import type { ClockDef } from '../shader/lib';
import { HM_LIB, defineClockedShaderScene, kickCountClock, rateClock, sinceKickClock } from '../shader/lib';
import { num } from '../../core/uniforms';

/**
 * Bead Fire — hot-rod flame licks worked in loom beadwork. The picture is decided once per bead:
 * a rising flame field is read at each bead's centre and quantised into a handful of inks, so
 * outlines are a bead or two wide and every edge is stepped. Then each bead is drawn as a small
 * glass square with a bevel, a sheen and dark thread between.
 *
 * Feeling: heat, swagger, wanting something badly. Energy is the heat of the whole piece: embers
 * along the bottom when it is quiet, flames to the top of the frame in a chorus.
 *
 * Palette roles
 *   bg      the ground the fire burns on (red)
 *   fg      the outline of every lick (black); the thread between beads is the darker of bg / fg
 *   accent  the flame body, sparks and embers (gold)
 *   accent2 white-hot beads: lick tips, the kick flare, popped sparks, hat glints
 *   muted   darker dye lots in the ground
 */
const fragment = /* glsl */ `
${HM_LIB}

// The kick flare: a band of extra heat that leaves the bottom on every kick and runs up the frame.
float bfFlare(float y01) {
  float e = (y01 - u_sk * 1.7 + 0.16) / 0.13;
  return exp(-e * e) * exp(-u_sk * 2.0) * u_ka;
}

// How far up the frame the fire stands right now (0 = bottom edge, 1 = top edge).
float bfTop() {
  return u_tall + 0.05 * uKick * u_flare + 1.3 * exp(-u_sd * 0.9);
}

// One lick: a teardrop with a round foot and a long pointed tip that wags. > 0 inside.
// P = point and c = cell, both in lick units (x: one lick wide, y: one row of licks tall).
// t comes back as 0 at the foot, 1 at the point.
float bfLick(vec2 P, vec2 c, float rows, float top, out float t) {
  vec2 h = hash22(c + 0.5);
  float h3 = hash21(c * 1.9 + 7.3);
  vec2 foot = c + vec2(0.5 + (h.x - 0.5) * 0.56, h.y * 0.5);
  // where its foot sits in the frame: licks above the fire line shrink away to nothing
  float y01 = (foot.y * u_lick * 3.0 + u_rise) / rows + 0.5;
  float live = 1.0 - smoothstep(-0.24, 0.05, y01 - top);
  t = -1.0;
  if (live < 0.16 || h3 * 1.7 - h.x < -0.45) return -4.0;      // some cells stay empty
  float tens = clamp(max(uBuild, uFeelTension), 0.0, 1.0);
  // each lick breathes on its own, stretches when the kick flare passes and winds up taller in a build
  float len = (0.88 + 0.52 * h3) * (0.86 + 0.18 * sin(u_lk * (0.8 + 1.3 * h.x) + h3 * 40.0));
  len = min(len * (0.68 + 0.3 * u_heat + (0.5 * bfFlare(y01) + 0.14 * uKick) * u_flare + 0.3 * tens) * live, 1.45);
  float wid = (0.36 + 0.22 * h.y) * mix(0.3, 1.0, live) * (0.86 + 0.18 * u_heat - 0.2 * tens) * (0.7 + 0.3 * len);
  // every lick leans its own way, so no foot sits flat on a row
  float lean = (hash11(h3 * 91.7 + h.x) - 0.5) * 0.7;
  float up = P.y - foot.y + lean * (P.x - foot.x);
  t = up / max(len, 0.02);
  float tc = clamp(t, 0.0, 1.0);
  // the centre line snakes more toward the tip, and the tip wags
  float cx = foot.x + u_curl * min(len, 1.0) * (0.52 * sin(tc * 4.4 + h3 * TAU + 0.6 * sin(u_lk * 1.7 + h.x * 30.0)) * tc - lean * 0.9 * tc * tc);
  // a rounded foot (a row is three licks tall), then a long taper to the point
  float hh = clamp(up * 3.0 / (wid * 1.5), 0.0, 1.0);
  float p = 1.12 * sqrt(hh * (2.0 - hh)) * pow(1.0 - tc, 1.15);
  // past either end the field falls away at the same rate as it does sideways, so a dying lick leaves no stray outline
  float past = (max(-up, 0.0) + max(up - len, 0.0)) * 3.0 / wid;
  return p - abs(P.x - cx) / wid - past;
}

// The flame field at a bead centre (bead units, origin at the frame centre, y up). > 0 is fire.
// tip: 0 at the foot of the nearest lick, 1 at its point.
float bfField(vec2 b, float rows, vec2 warp, out float tip) {
  float ya = b.y - u_rise;                       // everything is carried upward by the rise clock
  vec2 q = vec2(b.x, ya) / u_lick;
  vec2 P = vec2(q.x, q.y / 3.0) + warp;
  float top = bfTop();
  float row = floor(P.y);
  float f = -4.0;
  tip = 0.0;
  for (int j = 0; j < 2; j++) {
    float r = row - float(j);
    float xr = P.x + hash11(r * 0.377 + 0.11) * 7.0;       // each row is shifted like brickwork
    float col = floor(xr);
    for (int i = -1; i <= 1; i++) {
      float tt;
      float fi = bfLick(vec2(xr, P.y), vec2(col + float(i), r), rows, top, tt);
      if (fi > f) { f = fi; tip = tt; }
    }
  }
  return f;
}

// Spark beads: every column climbs at its own pace, one bead at a time.
float bfSpark(vec2 cid) {
  float up = floor(u_spk * (0.5 + hash11(cid.x * 0.731 + 0.17)));
  return hash21(vec2(cid.x, cid.y - up) + 0.5);
}
// 1 when this bead is a spark that the last snare popped
float bfPopped(vec2 cid, float dens) {
  float sh = bfSpark(cid);
  return step(sh, dens) * step(hash21(vec2(sh * 91.0, u_sc + 0.5)), 0.6);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  // bead pitch follows the frame's area, so 4K keeps the same number of beads as 720p
  float cs = max(3.0, u_bead * sqrt(uResolution.x * uResolution.y) / 1440.0);
  vec2 g = (fc - 0.5 * uResolution) / cs;
  // hand-strung: the rows wander by a fraction of a bead
  g += u_hand * 0.36 * (vec2(vnoise(g * 0.06 + 3.0), vnoise(g * 0.06 + 40.0)) - 0.5);
  vec2 cid = floor(g);
  vec2 lq = fract(g) - 0.5;
  vec2 b = cid + 0.5;
  float rows = uResolution.y / cs;
  float y01 = b.y / rows + 0.5;
  float j1 = hash21(cid + 0.37);
  float j2 = hash21(cid * 1.7 + 9.1);
  float j3 = hash21(cid * 0.63 + 21.4);

  float heat = clamp(u_heat, 0.0, 1.0);
  float build = clamp(max(uBuild, uFeelTension), 0.0, 1.0);

  // ── the picture, one decision per bead ──────────────────────────────────────────────
  float tip, tipX, tipY;
  // a slow wide sway bends whole tongues together; rows of licks ride a wave so they never line up
  // (read once per bead and shared by the three field samples)
  vec2 wq = vec2(b.x, b.y - u_rise) / u_lick;
  vec2 warp = vec2(u_curl * 0.7 * snoise(vec3(wq.x * 0.19 + 3.1, wq.y * 0.3, u_ev)),
                   0.4 * snoise(vec2(wq.x * 0.11 + 5.0, wq.y * 0.07 + u_ev * 0.4)));
  float f0 = bfField(b, rows, warp, tip);
  float fx = bfField(b + vec2(1.0, 0.0), rows, warp, tipX);
  float fy = bfField(b + vec2(0.0, 1.0), rows, warp, tipY);
  vec2 grad = vec2(fx - f0, fy - f0);
  float gl = max(length(grad), 0.012);
  vec2 nrm = grad / gl;                                   // points into the flame
  float d = f0 / gl + (j1 - 0.5) * 0.5 * u_hand;          // distance to the edge, in beads
  // (its front is ragged, and different on every kick)
  float fl = bfFlare(y01 + 0.12 * (vnoise(vec2(b.x * 0.08, u_kn * 3.7)) - 0.5)) * u_flare;

  // the outline is heavier on the lower-right, like a sign-painter's drop shadow; builds thicken it
  float wOut = u_outline * (1.0 + 1.3 * build) * (0.8 + 0.9 * max(0.0, dot(-nrm, vec2(0.707, -0.707))));
  float wBody = u_body * (0.8 + 0.45 * heat) + 1.5 * fl;

  // inks: 0 ground · 1 outline · 2 flame body · 3 white-hot · 4 hollow of the flame
  float ink = 0.0;
  if (d >= 0.0) {
    ink = d < wBody ? 2.0 : 4.0;
    if (tip > 0.84 - 0.05 * heat - 0.25 * fl) ink = 3.0;
    // the hotter the song, the nearer the white-hot core comes to the edge; the kick flare blows it wide open
    if (d > wBody + max(0.7, mix(6.0, 0.9, heat) - 5.5 * fl)) ink = 3.0;
  } else if (d > -wOut) {
    ink = 1.0;
  }

  // ── sparks, embers ──────────────────────────────────────────────────────────────────
  float snEnv = exp(-u_ss * 6.0);
  float top = bfTop();
  float reach = mix(0.3, 1.0, 1.0 - smoothstep(top - 0.1, top + 0.55, y01));
  float dens = u_sparks * reach * (0.0035 + 0.011 * heat + 0.012 * build + 0.022 * snEnv);
  float sh = bfSpark(cid);
  float spark = step(sh, dens);
  float popped = spark * step(hash21(vec2(sh * 91.0, u_sc + 0.5)), 0.6) * step(u_ss, 0.24);
  // a popped spark throws a plus of gold beads for an instant
  float plus = 0.0;
  if (u_ss < 0.11) {
    plus = max(max(bfPopped(cid + vec2(1.0, 0.0), dens), bfPopped(cid - vec2(1.0, 0.0), dens)),
               max(bfPopped(cid + vec2(0.0, 1.0), dens), bfPopped(cid - vec2(0.0, 1.0), dens)));
  }
  // embers: a bed of beads along the bottom that breathe slowly
  float bed = 1.0 - smoothstep(0.0, 0.2 + 0.2 * heat, y01 + 0.05 * (j2 - 0.5));
  float ember = step(j3, 0.62 * bed * bed + 0.01);
  float breath = 0.5 + 0.5 * sin(uTime * (0.5 + 1.4 * j1) + j3 * 60.0);

  // ── drop: a fireball rolls up the frame; inside it the inks swap (gold ground, red flames) ──
  float yr = y01 + 0.16 * (vnoise(vec2(b.x * 0.045, u_sd * 2.5 + 3.0)) - 0.5) + 0.07 * (vnoise(vec2(b.x * 0.17 + 9.0, u_sd * 4.0)) - 0.5) + 0.025 * (j2 - 0.5);
  float lead = u_sd * 2.3 - 0.06;
  float tail = (u_sd - 0.55) * 1.6 - 0.06;
  float ball = step(tail, yr) * step(yr, lead);
  float rim = ball * step(lead - 0.035 - 0.03 * j1, yr);

  // ── colours ─────────────────────────────────────────────────────────────────────────
  vec3 hi = uAccent2;
  if (luma(uAccent) > luma(hi)) hi = uAccent;
  if (luma(uFg) > luma(hi)) hi = uFg;
  float lot = step(vnoise(b * 0.11 + 7.0) * 0.8 + 0.2 * j2, 0.34 + 0.18 * (1.0 - heat));  // darker dye lots
  vec3 cGround = mix(uBg, uMuted, min(0.55 * lot + 0.4 * (1.0 - heat), 1.0)) * mix(0.82, 1.08, heat);   // cools toward muted when quiet
  vec3 cHollow = mix(uBg, uAccent, 0.04 + 0.1 * heat) * mix(0.9, 1.12, heat);
  vec3 cBody = uAccent;
  if (j2 < 0.24) cBody = mix(uAccent, uBg, 0.32);
  else if (j2 > 0.88) cBody = mix(uAccent, uAccent2, 0.3);

  vec3 c = cGround;
  if (ink > 3.5) c = cHollow;
  if (ink < 0.5 || ink > 3.5) {
    c = mix(c, mix(uAccent, uBg, 0.25), ember * (0.25 + 0.75 * breath) * (ink < 0.5 ? 1.0 : 0.6));
    c = mix(c, uAccent2, ember * step(0.93, breath) * step(j1, 0.3) * 0.6);
  }
  if (ink < 0.5) {
    c = mix(c, uAccent, spark);
    c = mix(c, uAccent, plus * (1.0 - spark));
    c = mix(c, uAccent2, popped);
  }
  if (ball > 0.5) {
    if (ink < 0.5) c = cBody;
    else if (ink > 3.5) c = mix(uAccent, uBg, 0.3);
    else if (ink > 1.5 && ink < 2.5) c = uBg;
    if (rim > 0.5 && (ink < 0.5 || ink > 1.5)) c = uAccent2;        // its leading edge is white-hot
  } else {
    if (ink > 1.5 && ink < 2.5) c = cBody;
  }
  if (ink > 0.5 && ink < 1.5) c = uFg;
  if (ink > 2.5 && ink < 3.5) c = uAccent2;

  // hats: single beads catch the light
  float glint = step(hash21(cid + vec2(u_hc * 13.7, u_hc * 7.1)), 0.006 + 0.008 * heat) * uHat;
  c = mix(c, hi, 0.55 * glint);

  // ── the bead itself ─────────────────────────────────────────────────────────────────
  // dye lots and wear: no two beads quite the same
  c *= 1.0 + (j1 - 0.5) * 0.26 * u_hand;
  c = mix(c, uMuted, 0.22 * step(j3, 0.06) * u_hand * step(ink, 0.5));
  vec2 lp = lq - (hash22(cid + 5.5) - 0.5) * 0.1 * u_hand;
  float hw = 0.43 - 0.035 * j2 * u_hand;
  float rad = 0.15;
  float dBox = sdBox(lp, vec2(hw - rad)) - rad;
  float aa = 0.9 / cs;
  float mask = 1.0 - smoothstep(-aa, aa, dBox);
  float bev = dot(lp, vec2(-0.75, 0.75));
  float edge = smoothstep(-0.2, 0.0, dBox);
  vec2 sp = lp - vec2(-0.12, 0.14);
  float sheen = exp(-dot(sp, sp) * 55.0) * (0.3 + 0.9 * glint);
  vec3 bead = c * (1.0 + 0.55 * bev - 0.32 * edge);
  bead = mix(bead, mix(c, hi, 0.75), clamp(sheen, 0.0, 1.0) * 0.5);
  // the thread between beads; hot beads bleed a little light into it
  vec3 grout = hmDark() * 0.22 + c * 0.07;
  vec3 col = mix(grout, bead, mask);

  col += hmGrain(fc, uTime) * 0.03;
  vec2 vv = vUv - 0.5;
  col *= 1.0 - dot(vv, vv) * 0.28;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const ease = (v: number, target: number, dt: number, rate: number) => v + (target - v) * (1 - Math.exp(-dt * rate));

/** Heat of the whole piece: the section energy, eased over a second or so. Starts where the song is. */
const heatClock: ClockDef = {
  step: (v, f, _s, mem) => {
    if (!mem.heatOn) {
      mem.heatOn = 1;
      return f.audio.energy;
    }
    return ease(v, f.audio.energy, f.dt, 0.9);
  },
};

/** How tall the fire stands (fraction of the frame): energy sets the state, bass leans on it. */
const tallClock: ClockDef = {
  step: (v, f, s, mem) => {
    const a = f.audio;
    mem.bass = ease(mem.bass ?? a.bass, a.bass, f.dt, 4);
    const e = s.heat ?? a.energy;
    const h = num(f.params, 'height', 1);
    const target = h * (0.05 + 1.5 * Math.pow(e, 1.6) + 0.3 * (mem.bass - 0.25) * (0.35 + e) + 0.22 * Math.max(a.build, f.feel.tension));
    if (!mem.tallOn) {
      mem.tallOn = 1;
      return target;
    }
    return ease(v, target, f.dt, target > v ? 2.4 : 1.1);
  },
};

const sinceDropClock: ClockDef = {
  init: 100,
  step: (v, f, _s, mem) => {
    const d = f.audio.drop;
    const fired = d > 0.6 && (mem.sdPrev ?? 0) <= 0.6;
    mem.sdPrev = d;
    return fired ? 0 : Math.min(v + f.dt, 100);
  },
};

export const beadFire = defineClockedShaderScene(
  {
    id: 'bead-fire',
    name: 'Bead Fire',
    description:
      'Hot-rod flame licks worked in beadwork: gold tongues with a black outline and white-hot tips climb a red ground, every edge stepped on a grid of small glass beads. Bass sets how tall the fire stands, each kick sends a flare up through it, snares pop the spark beads white and hats make single beads glint. Quiet parts die back to embers, builds climb with a thickening outline, and a drop rolls a fireball up the frame.',
    category: 'field',
    style: 'print',
    fragment,
    tags: ['warm', 'intense', 'heavy', 'energetic', 'tactile', 'graphic', 'retro', 'aggressive', 'hip-hop', 'driving', 'bass', 'dark'],
    params: [
      { id: 'bead', label: 'Bead size', group: 'Shape', type: 'number', min: 6, max: 30, step: 0.5, default: 12, hint: 'Scales with the frame, so 4K keeps the same number of beads' },
      { id: 'lick', label: 'Flame size', group: 'Shape', type: 'number', min: 6, max: 30, step: 0.5, default: 12, hint: 'Width of one lick, in beads' },
      { id: 'curl', label: 'Curl', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How far the tongues bend and hook' },
      { id: 'body', label: 'Flame body', group: 'Shape', type: 'number', min: 0.8, max: 10, step: 0.1, default: 1.8, hint: 'Beads of gold inside the outline before the flame goes hollow' },
      { id: 'outline', label: 'Outline', group: 'Shape', type: 'number', min: 0, max: 3, step: 0.05, default: 1.1, hint: 'Beads of outline; build-ups thicken it' },
      { id: 'hand', label: 'Hand-made', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Wandering rows, uneven beads and dye lots' },
      { id: 'speed', label: 'Rise', group: 'Motion', type: 'number', min: 0, max: 2.5, step: 0.01, default: 1 },
      { id: 'height', label: 'Fire height', group: 'Reactivity', type: 'number', min: 0.3, max: 1.6, step: 0.01, default: 1, hint: 'How much of the frame the fire takes at a given energy' },
      { id: 'flare', label: 'Kick flare', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
      { id: 'sparks', label: 'Sparks', group: 'Reactivity', type: 'number', min: 0, max: 2.5, step: 0.01, default: 1, hint: 'Stray beads rising off the fire; snares pop them' },
    ],
    modulations: [
      { source: 'bass', param: 'height', amount: 0.08 },
      { source: 'energy', param: 'body', amount: 0.12 },
    ],
  },
  {
    heat: heatClock,
    tall: tallClock,
    // climb in beads per second: a slow smoulder when quiet, a roar in the chorus, a lurch on the drop
    // (wraps far out, so a long set never sees the pattern jump)
    rise: {
      step: (v, f) => {
        const a = f.audio;
        const rate = num(f.params, 'speed', 1) * (1.2 + 14 * Math.pow(a.energy, 1.5) + 5 * a.bass + 8 * Math.max(a.build, f.feel.tension) + 30 * a.drop);
        return (v + f.dt * rate) % 180000;
      },
    },
    // the licking clock: how fast each tongue stretches, shrinks and wags
    lk: rateClock((f) => num(f.params, 'speed', 1) * (0.8 + 3.2 * f.audio.energy + 1.5 * f.audio.bass + 2 * Math.max(f.audio.build, f.feel.tension))),
    // slow change of shape, so a lick is never the same twice on its way up
    ev: rateClock((f) => 0.05 + 0.12 * f.audio.energy),
    // spark climb, beads per second
    spk: rateClock((f) => 3 + 14 * f.audio.energy + 24 * f.audio.build + 12 * f.audio.snare),
    sk: sinceKickClock,
    kn: kickCountClock,
    ka: { step: (v, f) => (f.audio.kickHit ? Math.max(0.35, f.audio.kick) : v) },
    sd: sinceDropClock,
    ss: { init: 100, step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)) },
    sc: { step: (v, f) => (f.audio.snareHit ? (v + 1) % 997 : v) },
    hc: { step: (v, f) => (f.audio.hatHit ? (v + 1) % 997 : v) },
  },
);
