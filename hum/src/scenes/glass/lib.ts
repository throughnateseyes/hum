/**
 * Shared pieces for the glass looks (src/scenes/glass/*): how a pane of real glass looks with light
 * coming through it, the palette turned into a whole box of glass colours, and the "re-lay" clock that
 * hands each new part of the song a fresh design.
 *
 * Colour: a window needs dozens of glass colours, a palette has five. Every pane picks one of the
 * palette's glass inks (accent2, fg, accent, muted, in that order along a composition value so the
 * window has a design: warm round the sun, cool at the rim) and then leans its hue, depth and chroma a
 * little, the way no two sheets of cathedral glass match. Because the inks are the palette's, a song
 * palette (core/songPalette.ts) re-colours the whole window.
 *
 * Roles: bg = lead, grout and the dark room, fg = the light itself (sun, sky) and the pale glass,
 * accent / accent2 / muted = the coloured glass.
 */
import type { FrameContext } from '../../core/types';
import type { ClockDef } from '../shader/lib';

/* ───────────────────────── GLSL ───────────────────────── */

export const GLASS_LIB = /* glsl */ `
vec3 gLin(vec3 c) { return c * c; }
// hue turn in YIQ (a cheap, even-looking hue shift)
vec3 gHue(vec3 c, float a) {
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toYiq * c;
  float cs = cos(a), sn = sin(a);
  y.yz = vec2(y.y * cs - y.z * sn, y.y * sn + y.z * cs);
  return max(toRgb * y, vec3(0.0));
}
vec3 gSat(vec3 c, float s) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return max(mix(vec3(l), c, s), vec3(0.0)); }

// the four glass inks, in composition order (warm core → light → cool → rim)
vec3 gInk(float i) {
  if (i < 0.5) return uAccent2;
  if (i < 1.5) return gSat(mix(uFg, uAccent2, 0.4), 1.6);
  if (i < 2.5) return uAccent;
  return uMuted;
}
// a pane's glass colour (gamma space): t = composition value 0..1, h1..h3 = the pane's dice
vec3 gPaneInk(float t, float h1, float h2, float h3, float spread) {
  // the design runs warm → light → cool; the rim ink (muted) only takes the far end
  float k = clamp(t + (h1 - 0.5) * spread, 0.0, 0.999) * 3.35;
  // now and then a pane from anywhere in the box: abundance
  if (h2 > 0.9) k = fract(h3 * 7.13) * 4.0;
  vec3 c = gInk(floor(k));
  // the next ink bleeds in a little (streaky sheets)
  c = mix(c, gInk(mod(floor(k) + 1.0, 4.0)), 0.15 * fract(k));
  c = gHue(c, (h2 - 0.5) * 0.4);
  c *= 0.78 + 0.42 * h3;
  return gSat(c, 1.2 + 0.3 * h1);
}

// glass surface: xy = how it bends the light, z = streak / milk inside the sheet
//   kind 0 cathedral (soft waves) · 1 hammered (dimples) · 2 seedy (bubbles) · 3 streaky (wisps) · 4 reamy (lines)
vec3 gSurface(vec2 p, float kind, float h) {
  vec2 q = p + h * 17.0;
  if (kind < 0.5) {
    float e = 0.03;
    float a = tfbm(q * 3.2, 3), b = tfbm(q * 3.2 + vec2(e, 0.0), 3), c = tfbm(q * 3.2 + vec2(0.0, e), 3);
    return vec3((b - a) / e, (c - a) / e, a) * vec3(0.05, 0.05, 1.0);
  }
  if (kind < 1.5) {
    vec2 g = q * 21.0;
    g.x += 0.5 * mod(floor(g.y), 2.0);
    vec2 f = fract(g) - 0.5 + (hash22(floor(g)) - 0.5) * 0.35;
    return vec3(f * 0.06 * (1.0 - 1.6 * dot(f, f)), 0.3 * tnoise(q * 4.0));
  }
  if (kind < 2.5) {
    float w = tnoise(q * 2.5);
    return vec3(vec2(tnoise(q * 2.5 + 3.1), w) - 0.5, w) * vec3(0.04, 0.04, 0.6);
  }
  if (kind < 3.5) {
    vec2 d = rot2(h * 6.28) * q;
    float s = tfbm(vec2(d.x * 0.7, d.y * 5.0), 4);
    return vec3(0.025 * s, 0.01, smoothstep(-0.2, 0.5, s));
  }
  vec2 d = rot2(h * 3.0) * q;
  float r = sin(d.y * 55.0 + 3.0 * tnoise(d * 3.0));
  return vec3(0.0, 0.035 * r, 0.25 + 0.25 * r);
}

// seed bubbles in seedy glass: bright rim, small dark core
float gBubbles(vec2 p, float h) {
  vec2 g = p * 26.0 + h * 9.0;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float r = hash21(id + 3.7);
  if (r > 0.22) return 0.0;
  vec2 o = (hash22(id) - 0.5) * 0.5;
  float rad = 0.05 + 0.14 * fract(r * 13.0);
  float d = length(f - o) / rad;
  return smoothstep(1.0, 0.75, d) * (smoothstep(0.35, 0.8, d) - 0.5);
}
`;

/* ───────────────────────── Re-lay clock ───────────────────────── */

/**
 * A fresh design for each new part of the song: the drop, every section change, and every
 * `phraseBeats` beats inside a long section. Clock values (as u_<id> in GLSL):
 *   gRelay  0..1 progress of the change going on (1 = settled, only seed A shows)
 *   gSeedA  the design showing; gSeedB the one being laid in
 *   gOx/gOy where the change starts (short-side units, centre 0,0)
 *   gKind   1 when the change is a drop (a fast flood), 0 for a quiet re-lay
 * Seeds follow the song (its length and tempo) and the change count, so a song never loops back to an
 * earlier design and an export renders the same windows as the live view.
 */
export function relayClocks(o: { phraseBeats?: number; quiet?: number; drop?: number } = {}): Record<string, ClockDef> {
  const phrase = o.phraseBeats ?? 32;
  const quietDur = o.quiet ?? 3.2;
  const dropDur = o.drop ?? 1.3;
  const seedOf = (n: number, f: FrameContext) => {
    const s = (f.analysis?.duration ?? 61.7) * 7.31 + (f.analysis?.bpm ?? 117) * 1.37 + n * 12.9898;
    return Math.floor((Math.sin(s) * 43758.5453 - Math.floor(Math.sin(s) * 43758.5453)) * 997) + 1;
  };
  return {
    gRelay: {
      init: 1,
      step: (v, f, _s, m) => {
        if (m.init !== 1) {
          m.init = 1;
          m.n = 0;
          m.seedA = seedOf(0, f);
          m.seedB = m.seedA;
          m.sec = f.feel.sectionIndex;
          m.prevSince = f.feel.sinceDrop;
          m.beats = 0;
          m.last = -10;
          m.clock = 0;
          m.dur = quietDur;
        }
        m.clock += f.dt;
        let trigger = 0;
        if (f.feel.sinceDrop < m.prevSince - 0.05 && f.feel.sinceDrop < 0.6) trigger = 2;
        m.prevSince = f.feel.sinceDrop;
        if (f.feel.sectionIndex !== m.sec) {
          if (m.sec >= 0 && f.feel.sectionIndex >= 0 && !trigger) trigger = 1;
          m.sec = f.feel.sectionIndex;
        }
        if (f.audio.beat && f.audio.playing) m.beats++;
        if (!trigger && m.beats >= phrase) trigger = 1;
        // two triggers in a breath (a drop on a section line) are one change; a drop still upgrades it
        if (trigger && m.clock - m.last < 1.5 && !(trigger === 2 && m.kind !== 1)) trigger = 0;
        if (trigger) {
          if (v < 1) m.seedA = m.seedB;
          m.n++;
          m.seedB = seedOf(m.n, f);
          m.beats = 0;
          m.last = m.clock;
          m.kind = trigger === 2 ? 1 : 0;
          m.dur = trigger === 2 ? dropDur : quietDur;
          const a = (m.seedB * 2.399) % (Math.PI * 2);
          const r = trigger === 2 ? 0 : 0.35 + 0.5 * ((m.seedB * 0.618) % 1);
          m.ox = Math.cos(a) * r;
          m.oy = Math.sin(a) * r;
          return 0;
        }
        if (v >= 1) return 1;
        const nv = v + f.dt / m.dur;
        if (nv >= 1) {
          m.seedA = m.seedB;
          return 1;
        }
        return nv;
      },
    },
    gSeedA: { init: 1, step: (_v, _f, _s, m) => m.seedA ?? 1 },
    gSeedB: { init: 1, step: (_v, _f, _s, m) => m.seedB ?? 1 },
    gOx: { step: (_v, _f, _s, m) => m.ox ?? 0 },
    gOy: { step: (_v, _f, _s, m) => m.oy ?? 0 },
    gKind: { step: (_v, _f, _s, m) => m.kind ?? 0 },
  };
}

/** a kick counter, time since the kick, and the same for the snare (as u_kc, u_sk, u_sc, u_ss) */
export const hitClocks: Record<string, ClockDef> = {
  kc: { step: (v, f) => (f.audio.kickHit ? (v + 1) % 997 : v) },
  sk: { init: 100, step: (v, f) => (f.audio.kickHit ? 0 : Math.min(v + f.dt, 100)) },
  sc: { step: (v, f) => (f.audio.snareHit ? (v + 1) % 997 : v) },
  ss: { init: 100, step: (v, f) => (f.audio.snareHit ? 0 : Math.min(v + f.dt, 100)) },
};

/** eases toward a target with a rate (1/s) */
export function easeClock(target: (f: FrameContext) => number, rate: number, init = 0): ClockDef {
  return { init, step: (v, f) => v + (target(f) - v) * (1 - Math.exp(-rate * f.dt)) };
}
