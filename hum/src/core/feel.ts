/**
 * Feel: one shared reading of where the song is emotionally, handed to every scene each frame
 * (`frame.feel`, and `uFeel*` uniforms in shaders).
 *
 * The audio layers say what is sounding right now. Feel says what it means for the picture: how big
 * this part is, whether it is winding up or has just let go, and how warm it is. Because the song was
 * analysed up front, Feel also looks ahead: tension starts to rise in the seconds before a drop the
 * analysis knows is coming, so a look can wind up before the hit instead of reacting after it.
 *
 * It also carries a little "world" (wind, time of day) that belongs to the stage, not to a look, so
 * a cut from one look to another keeps the same weather and the same light, and a video made of many
 * looks reads as one place.
 */
import type { AudioFrame, TrackAnalysis, TrackSection } from './types';

export interface Feel {
  /** 0..1: how big this part of the song is, eased over about a second. Quiet intro ≈ 0.15, full chorus ≈ 0.9 */
  intensity: number;
  /** 0..1: winding up. Rises through a build-up, and through the last seconds before a drop that is known to be coming */
  tension: number;
  /** 0..1: letting go. Jumps to 1 when a drop lands and fades over about ten seconds (the afterglow) */
  release: number;
  /** 0..1: cold and dark ↔ warm and bright. The song's own mood, nudged by how bright it sounds now */
  warmth: number;

  /** seconds until the next drop the analysis found (99 when none is known) */
  toDrop: number;
  /** seconds since the last drop landed (99 before the first) */
  sinceDrop: number;
  /** the part of the song playing now (null without an analysis) */
  section: TrackSection['label'] | null;
  /** index of that part in `analysis.sections` (-1 without an analysis) */
  sectionIndex: number;
  /** 0..1 through the current part */
  sectionT: number;
  /** seconds until the next part starts (99 when unknown) */
  toSection: number;
  /** 0..1 through the song (0 for live input) */
  songT: number;

  /** the world: which way the wind blows (a unit vector, x right, y up) — drifts slowly, the same for every look */
  windX: number;
  windY: number;
  /** 0..1: how hard it is blowing right now (bass and build-ups push it, a drop is a gust) */
  gust: number;
  /** wind travel so far: integrates the gust, so anything swaying on it keeps its phase across looks */
  windPhase: number;
  /** time of day, 0..1: 0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk. A song runs from dawn to dusk */
  day: number;
  /** direction the light comes from, radians (0 = from the right, PI/2 = from above); follows the day */
  light: number;
}

export function emptyFeel(): Feel {
  return {
    intensity: 0,
    tension: 0,
    release: 0,
    warmth: 0.5,
    toDrop: 99,
    sinceDrop: 99,
    section: null,
    sectionIndex: -1,
    sectionT: 0,
    toSection: 99,
    songT: 0,
    windX: 1,
    windY: 0,
    gust: 0,
    windPhase: 0,
    day: 0.4,
    light: Math.PI * 0.6,
  };
}

/** names of the float uniforms every shader gets (see GLSL_HEADER); uFeelWind is a vec2 on top of these */
export const FEEL_UNIFORMS = {
  uFeelIntensity: 'intensity',
  uFeelTension: 'tension',
  uFeelRelease: 'release',
  uFeelWarmth: 'warmth',
  uFeelToDrop: 'toDrop',
  uFeelSinceDrop: 'sinceDrop',
  uFeelSectionT: 'sectionT',
  uFeelSongT: 'songT',
  uFeelGust: 'gust',
  uFeelWindPhase: 'windPhase',
  uFeelDay: 'day',
  uFeelLight: 'light',
} as const satisfies Record<string, keyof Feel>;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** how long before a known drop the tension starts to rise (s), and how long the afterglow lasts */
const ANTICIPATE = 6;
const AFTERGLOW = 7;

/** Turns audio frames (and the song's analysis, when there is one) into a Feel. One per stage. */
export class FeelTracker {
  readonly feel = emptyFeel();
  private lastT = -1;
  private prevDrop = 0;
  private windSeed = 0;
  private clock = 0;

  update(audio: AudioFrame, analysis: TrackAnalysis | null, dt: number): Feel {
    const f = this.feel;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.clock += dt;
    const t = audio.time;
    // a seek or a new song: take the state from the analysis instead of easing across the jump
    const jumped = this.lastT < 0 || Math.abs(t - this.lastT) > 1.5;
    const prevT = this.lastT;
    this.lastT = t;

    /* where we are in the song */
    const secs = analysis?.sections;
    let energyHere = audio.energy;
    if (secs?.length) {
      let i = secs.length - 1;
      while (i > 0 && t < secs[i].start) i--;
      const s = secs[i];
      f.sectionIndex = i;
      f.section = s.label;
      f.sectionT = clamp01((t - s.start) / Math.max(0.01, s.end - s.start));
      f.toSection = i < secs.length - 1 ? Math.max(0, s.end - t) : 99;
      // the analysed level of this part steadies the live one (a quiet bar inside a chorus is still a chorus)
      energyHere = 0.55 * audio.energy + 0.45 * s.energy;
    } else {
      f.sectionIndex = -1;
      f.section = null;
      f.sectionT = 0;
      f.toSection = 99;
    }
    const dur = analysis?.duration || audio.duration || 0;
    f.songT = dur > 0 ? clamp01(t / dur) : 0;

    /* drops: the ones the analysis knows about, and any the live detector fires */
    let toDrop = 99;
    let sinceKnown = 99;
    let nextStrength = 1;
    let crossed = false;
    const drops = analysis?.drops;
    if (drops?.length) {
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i] - t;
        if (d > 0) {
          if (d < toDrop) {
            toDrop = d;
            nextStrength = analysis?.dropInfo?.[i]?.strength ?? 1;
          }
        } else if (-d < sinceKnown) sinceKnown = -d;
        if (!jumped && prevT < drops[i] && t >= drops[i]) crossed = true;
      }
    }
    const liveEdge = audio.drop > 0.6 && this.prevDrop <= 0.6;
    this.prevDrop = audio.drop;
    f.toDrop = toDrop;
    if (jumped) {
      f.sinceDrop = sinceKnown;
      f.release = Math.exp(-sinceKnown / AFTERGLOW);
    } else if (liveEdge || crossed) {
      if (f.sinceDrop > 1) {
        f.sinceDrop = 0;
        f.release = 1;
      }
    } else {
      f.sinceDrop = Math.min(99, f.sinceDrop + dt);
      f.release *= Math.exp(-dt / AFTERGLOW);
    }

    /* tension: the live build-up, or the approach to a known drop, whichever is further along */
    const approach = toDrop < ANTICIPATE ? Math.pow(1 - toDrop / ANTICIPATE, 1.6) * (0.5 + 0.5 * nextStrength) : 0;
    const tensionNow = f.sinceDrop < 0.4 ? 0 : clamp01(Math.max(audio.build, approach));
    f.tension = jumped ? tensionNow : ease(f.tension, tensionNow, tensionNow > f.tension ? 6 : 12, dt);

    /* intensity: slow, but a drop lands at once */
    const target = clamp01(energyHere + 0.12 * f.release);
    f.intensity = jumped ? target : ease(f.intensity, target, f.sinceDrop < 0.6 ? 14 : 0.9, dt);

    /* warmth */
    const mood = analysis?.mood;
    const warm = clamp01(mood ? 0.15 + 0.5 * mood.valence + 0.2 * audio.brightness + 0.15 * f.release + 0.1 * (f.intensity - 0.5) : 0.5 + 0.4 * (audio.brightness - 0.5));
    f.warmth = jumped ? warm : ease(f.warmth, warm, 0.4, dt);

    /* the world */
    if (jumped && dur > 0) this.windSeed = (dur * 7.13 + (analysis?.bpm ?? 0) * 0.37) % (Math.PI * 2);
    // mostly sideways, wandering slowly; steadier songs keep a steadier wind
    const ang = this.windSeed + 0.5 * Math.sin(this.clock * 0.05) + 0.25 * Math.sin(this.clock * 0.013 + 1.7);
    const side = Math.cos(ang) >= 0 ? 1 : -1;
    const lift = 0.28 * Math.sin(ang * 2.0 + this.clock * 0.021);
    const n = Math.hypot(side, lift);
    f.windX = side / n;
    f.windY = lift / n;
    const gustNow = clamp01(0.12 + 0.3 * f.intensity + 0.35 * audio.bass * audio.energy + 0.45 * f.tension + 0.6 * Math.exp(-f.sinceDrop * 0.9));
    f.gust = jumped ? gustNow : ease(f.gust, gustNow, 2.2, dt);
    f.windPhase = (f.windPhase + dt * (0.25 + 1.6 * f.gust)) % 10000;
    // a song is a day: dawn at the start, dusk at the end; loud parts pull toward noon, quiet ones toward the edges
    const dayTarget = dur > 0 ? 0.24 + 0.52 * f.songT + (0.5 - (0.24 + 0.52 * f.songT)) * 0.35 * f.intensity : 0.3 + 0.2 * f.intensity;
    f.day = jumped ? dayTarget : ease(f.day, dayTarget, 0.25, dt);
    // the sun rises on the left, stands overhead at noon and sets on the right
    f.light = Math.PI * (1 - clamp01((f.day - 0.2) / 0.6));
    return f;
  }
}
