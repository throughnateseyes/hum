/**
 * Hum — core contracts.
 *
 * Pipeline:  audio file / mic
 *              → AudioEngine (real-time)  → AudioFrame (layers, every frame)
 *              → TrackAnalysis (offline)  → sections, drops, mood
 *            AudioFrame → Modulation matrix → resolved params
 *            SceneInstance.render(frame, target)  → RenderTarget
 *            Effect chain (GLSL passes)           → screen / recorder
 */
import type * as THREE from 'three';
import type { Feel } from './feel';
import type { StyleId } from './styles';

/* ───────────────────────── Audio ───────────────────────── */

/** Every signal the audio engine extracts. All are 0..1 unless noted. */
export type LayerId =
  | 'level' // overall loudness (rms, adaptive)
  | 'sub' // 20–60 Hz   — the "felt" low end, dubstep wobble floor
  | 'bass' // 60–250 Hz  — kick body, bassline
  | 'lowMid' // 250–500 Hz — warmth, body of instruments
  | 'mid' // 500–2k Hz  — vocals, leads
  | 'highMid' // 2k–6k Hz  — presence, snares, attack
  | 'air' // 6k–20k Hz  — hats, shimmer, breath
  | 'kick' // transient envelope: low-band onsets (jumps to 1, decays)
  | 'snare' // transient envelope: mid/high-mid onsets
  | 'hat' // transient envelope: air onsets
  | 'energy' // slow, long-term loudness (seconds) — the "intensity" of a section
  | 'brightness' // spectral centroid — dark/warm (0) vs bright/harsh (1)
  | 'flux' // spectral flux — how fast the sound is changing
  | 'beatPhase' // 0→1 sawtooth across each beat (tempo-locked)
  | 'build' // rises while energy climbs (risers, build-ups)
  | 'drop' // envelope fired when a drop hits (big energy jump after a build)
  | 'sway'; // slow -1..1 sine locked to the bar (4 beats) — gentle motion

export interface AudioFrame {
  playing: boolean;
  /** seconds into the track */
  time: number;
  duration: number;
  level: number;
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  air: number;
  kick: number;
  snare: number;
  hat: number;
  energy: number;
  brightness: number;
  flux: number;
  beatPhase: number;
  build: number;
  drop: number;
  sway: number;
  /** true only on the frame an onset/beat happened */
  onset: boolean;
  beat: boolean;
  kickHit: boolean;
  snareHit: boolean;
  hatHit: boolean;
  beatCount: number;
  bpm: number;
  /** 128 log-spaced bins, 0..1, smoothed */
  spectrum: Float32Array;
  /** 512 samples, -1..1 */
  waveform: Float32Array;
  /** all layer values by id (same numbers as the fields above) */
  layers: Record<LayerId, number>;
}

export interface TrackSection {
  start: number;
  end: number;
  /** mean energy 0..1 */
  energy: number;
  label: 'intro' | 'verse' | 'chorus' | 'bridge' | 'build' | 'drop' | 'break' | 'outro';
  /** sections that sound alike share a group (0, 1, 2…), so a returning chorus can return to its look */
  group: number;
}

export interface LyricWord {
  t: number;
  end: number;
  text: string;
}
export interface LyricLine {
  /** seconds */
  t: number;
  end: number;
  text: string;
  /** word timings, when the source has them */
  words?: LyricWord[];
}
export interface Lyrics {
  lines: LyricLine[];
  /** lines have times (otherwise only `plain` text is known) */
  synced: boolean;
  source: 'file' | 'lrclib' | 'pasted';
  title?: string;
  artist?: string;
  plain?: string;
  instrumental?: boolean;
}

export interface MoodProfile {
  /** 0 calm … 1 intense */
  arousal: number;
  /** 0 sad/dark … 1 happy/bright (heuristic) */
  valence: number;
  /** 0 dark/warm … 1 bright/harsh */
  brightness: number;
  /** 0 sparse … 1 dense/busy */
  density: number;
  /** share of energy below 250 Hz */
  lowEnd: number;
  /** loudness variation, 0 flat … 1 very dynamic */
  dynamics: number;
}

export interface TrackAnalysis {
  duration: number;
  bpm: number;
  /** ~1000 points, peak amplitude 0..1 — for the scrubber */
  overview: Float32Array;
  /** same resolution, smoothed energy 0..1 */
  energyCurve: Float32Array;
  /** same resolution, per-band energy 0..1 */
  lowCurve: Float32Array;
  midCurve: Float32Array;
  highCurve: Float32Array;
  sections: TrackSection[];
  /** times (s) of detected drops */
  drops: number[];
  mood: MoodProfile;
  /** mood words, e.g. ['melancholic', 'spacious', 'slow'] */
  tags: string[];
  /** preset ids that fit, best first */
  suggestedPresets: string[];
  /** a short plain-text description, used as context for the AI director */
  summary: string;
  /** the song taken apart into layers (missing on analyses made before it existed) */
  layers?: TrackLayers;
  /** each drop with how big it is, same order as `drops` (missing → treat every drop as 1) */
  dropInfo?: TrackDrop[];
  /** what kind of song this is, judged from the sound (missing on older analyses) */
  character?: TrackCharacter;
  /** key, chords, harmonic tension and key changes (missing on older analyses, see src/audio/harmony.ts) */
  harmony?: TrackHarmony;
}

/** a key: its home note (0 = C … 11 = B) and mode */
export interface TrackKey {
  tonic: number;
  minor: boolean;
  /** e.g. 'A minor', 'Eb major' */
  name: string;
  /** 0..1 */
  confidence: number;
}

/** a chord heard over a stretch of beats (major and minor triads only: a G7 reads as G) */
export interface TrackChord {
  t: number;
  end: number;
  /** pitch class of the root, 0 = C (−1 = no chord) */
  root: number;
  minor: boolean;
  /** e.g. 'Am', 'F', 'Eb'; 'N' when nothing chord-like is sounding */
  name: string;
}

/** where the harmony comes home: V → I, or tension falling onto the home chord */
export interface TrackResolution {
  t: number;
  /** 0..1: 1 is a full V → I cadence */
  strength: number;
  from: string;
  to: string;
}

/** the harmony of one section (same order as `sections`) */
export interface SectionHarmony {
  key: TrackKey;
  /** beats per chord on average (0 = no chords heard) */
  beatsPerChord: number;
  changesPerBar: number;
  /** mean harmonic tension 0..1 */
  tension: number;
  /** this section sits in a key the song lifted up to (a half or whole step up, usually the last chorus) */
  lift?: boolean;
  /** an earlier section whose chords this one plays again, how closely (0..1) and moved by how many semitones */
  repeatOf?: number;
  repeatSim?: number;
  transpose?: number;
}

export interface TrackHarmony {
  key: TrackKey;
  /** how far the recording sits off A440, in semitones */
  tuning: number;
  chords: TrackChord[];
  /** times (s) where the chord changes; they sit on beats */
  changes: number[];
  resolutions: TrackResolution[];
  keyChanges: { t: number; section: number; from: string; to: string; semitones: number; lift: boolean }[];
  sections: SectionHarmony[];
  /** 0..1 harmonic tension, same resolution as `energyCurve`: 0 at home, high on a dominant or a clash */
  tension: Float32Array;
}

/** one pitched note heard in a layer */
export interface TrackNote {
  /** start and end in seconds */
  t: number;
  end: number;
  /** MIDI note number (60 = middle C) */
  midi: number;
  /** loudness 0..1 */
  v: number;
}

/** the song taken apart: when each drum hits and which notes the bass and lead play */
export interface TrackLayers {
  /** hit times (s) */
  kick: number[];
  snare: number[];
  hat: number[];
  bass: TrackNote[];
  lead: TrackNote[];
  /** vocals present, as [start, end] spans (s) */
  vocal: [number, number][];
}

export interface TrackDrop {
  t: number;
  /** 0..1: 1 is the biggest moment in the song */
  strength: number;
  /** a few words on why it counts as a drop, e.g. 'bass and kick return after a 16-bar build' */
  why: string;
}

export interface TrackCharacter {
  /** best genre guess, e.g. 'dubstep', 'indie pop', 'lo-fi hip hop' */
  genre: string;
  /** 0..1 */
  confidence: number;
  /** instruments heard, most prominent first, e.g. ['sub bass', 'synth lead', 'vocals'] */
  instruments: string[];
  /** one or two words for what the song is going for, e.g. 'euphoric', 'heartbroken' */
  mood: string;
}

/* ───────────────────────── Params ───────────────────────── */

interface ParamBase {
  id: string;
  label: string;
  /** optional grouping in the inspector, e.g. 'Shape', 'Motion', 'Color' */
  group?: string;
  hint?: string;
}
export interface NumberParam extends ParamBase {
  type: 'number';
  min: number;
  max: number;
  step?: number;
  default: number;
}
export interface ColorParam extends ParamBase {
  type: 'color';
  default: string; // '#rrggbb'
}
export interface BoolParam extends ParamBase {
  type: 'bool';
  default: boolean;
}
export interface SelectParam extends ParamBase {
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}
export type ParamDef = NumberParam | ColorParam | BoolParam | SelectParam;
export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

/* ───────────────────────── Palette ───────────────────────── */

export interface Palette {
  id: string;
  name: string;
  bg: string;
  fg: string;
  accent: string;
  accent2: string;
  muted: string;
}
export interface ResolvedPalette extends Palette {
  c: { bg: THREE.Color; fg: THREE.Color; accent: THREE.Color; accent2: THREE.Color; muted: THREE.Color };
}

/* ───────────────────────── Photos ───────────────────────── */

export interface PhotoAsset {
  id: string;
  name: string;
  texture: THREE.Texture;
  /** the decoded source (for CPU sampling, e.g. building point clouds) */
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  width: number;
  height: number;
  /** true for the built-in placeholder photo */
  builtin?: boolean;
}

/* ───────────────────────── Clips ───────────────────────── */

/** A clip's colours, taken from its own frames (see src/shot/palette.ts) */
export interface ClipPalette {
  /** five flat colours, one per brightness band from shadows to highlights */
  flats: string[];
  ink: string;
  paper: string;
  /** four brightness levels (0..1) that split the clip's picture into five equal bands */
  cuts: number[];
}

/** A video clip the person added: footage for the footage looks (src/scenes/footage) */
export interface ClipAsset {
  id: string;
  name: string;
  /** an object URL for the file. Every look that plays the clip opens its own <video> on it, so two
   *  pictures (the stage and a render, say) never fight over one player. */
  url: string;
  /** the file itself, kept so the clip can be saved and opened again */
  file: Blob;
  /** seconds */
  duration: number;
  width: number;
  height: number;
  /** a small still for the library (a data URL) */
  thumb: string;
  palette: ClipPalette;
}

/** what the app measured in a clip or photo by itself, before Claude looked */
export interface MediaMeasure {
  /** the seconds of the clip that were measured, and how much the picture moves there (0 still .. 1 a lot) */
  at: number[];
  motion: number[];
  /** 0..1: how bright the picture is on the whole */
  bright: number;
  /** 0..1: how much the camera shakes (0: steady, or a photo) */
  shake: number;
}

/** What Claude saw in one clip or photo (director/media.ts). Kept by media id, so each is watched once. */
export interface MediaNotes {
  id: string;
  /** the shape of these notes; older ones are watched again */
  v: number;
  kind: 'clip' | 'photo';
  /** what it shows, a few words */
  subject: string;
  /** where the subject sits, 0..1 from the left and from the bottom */
  focusX: number;
  focusY: number;
  mood: string[];
  /** 0 still and quiet .. 1 frantic */
  energy: number;
  /** how the camera moves, and how close it is */
  camera: string;
  size: string;
  /** good seconds to start a shot on, best first, and why */
  ins: { at: number; why: string }[];
  faces: boolean;
  text: boolean;
  measure: MediaMeasure;
}

/**
 * What one part of the video does with the person's media, when its look is a footage look. Every
 * field is optional: a missing one falls back to the look's own setting (or, for media, to the
 * automatic dealing of clips and photos).
 */
export interface PartShot {
  /** a footage style id, or 'auto' */
  style?: string;
  /** 1..999: the same style arranged differently */
  seed?: number;
  /** how the picture itself is broken down: 'none', 'mosh', 'sort', 'cells', 'readout', 'collage', 'trace' */
  treatment?: string;
  /** what a video clip does in time, beyond playing: 'play', 'stutter', 'echo', 'reverse', 'slices' */
  motion?: string;
  /** ids of the clips and photos this part may use, in order (missing: dealt automatically) */
  media?: string[];
  /** where the picture is centred, 0..1 from the left and from the bottom */
  focusX?: number;
  focusY?: number;
  /** how far it is pushed in: 1 fits the frame, up to 3 */
  zoom?: number;
  /** the second of the first clip the part starts on (missing: carries on from where that clip stopped) */
  from?: number;
  /** what the part is meant to feel like (a moment id, src/moments): how the picture runs and the camera moves */
  moment?: string;
  /** Inside only: the words that stand in the picture when nothing is sung there (a few, in order) */
  say?: string;
}

/* ───────────────────────── Scenes ───────────────────────── */

export interface SharedResources {
  /** 128×1 float texture of the current spectrum (red channel, 0..1) */
  spectrumTex: THREE.DataTexture;
  /** 512×1 float texture of the waveform (red channel, -1..1 mapped to 0..1) */
  waveformTex: THREE.DataTexture;
  /** 256×256 random values for cheap shader noise (`uNoiseTex`; see core/noise.ts) */
  noiseTex: THREE.DataTexture;
  /** full-screen quad helpers */
  blit: (texture: THREE.Texture, target: THREE.WebGLRenderTarget | null) => void;
}

export interface FrameContext {
  renderer: THREE.WebGLRenderer;
  /** seconds since the scene was created (always advances) */
  time: number;
  dt: number;
  frame: number;
  /** render target size in device pixels */
  width: number;
  height: number;
  aspect: number;
  audio: AudioFrame;
  /** where the song is emotionally (tension, release, intensity, warmth) and the shared world (wind, time of day); see core/feel.ts */
  feel: Feel;
  /** scene params with modulation already applied */
  params: ParamValues;
  palette: ResolvedPalette;
  /** always at least one photo (built-in placeholder if the user added none) */
  photos: PhotoAsset[];
  shared: SharedResources;
  analysis: TrackAnalysis | null;
  /** lyric / title text the user typed (may be empty) */
  text: string;
}

export interface SceneInit {
  renderer: THREE.WebGLRenderer;
  width: number;
  height: number;
  shared: SharedResources;
}

/** what a scene is told before a frame of a render (see SceneInstance.prepare) */
export interface PrepareContext {
  /** the look's settings for this scene, before modulation */
  params: ParamValues;
  analysis: TrackAnalysis | null;
  photos: PhotoAsset[];
}

export interface SceneInstance {
  /** Draw one frame into `target` (it is already sized). Must not render to screen. */
  render(frame: FrameContext, target: THREE.WebGLRenderTarget): void;
  /**
   * Renders only (frame by frame, not in real time): called before each frame with the song time (s)
   * about to be drawn, and awaited. A scene that shows something it has to wait for (a video frame)
   * gets it ready here; render() for that same time then draws it without waiting. `frame` carries
   * what render() is about to be given, because a scene cut to on this frame has not drawn yet.
   */
  prepare?(songTime: number, frame: PrepareContext): Promise<void>;
  resize?(width: number, height: number): void;
  dispose(): void;
}

export type SceneCategory = 'form' | 'field' | 'photo' | 'board' | 'code';

/** A suggested default audio→param routing, applied when the scene is picked from the library. */
export interface ModulationSeed {
  source: LayerId;
  /** scene param id */
  param: string;
  /** -1..1, fraction of the param's range */
  amount: number;
}

export interface SceneDef {
  id: string;
  name: string;
  description: string;
  category: SceneCategory;
  /** the style family it belongs to (see core/styles.ts); falls back on the category when missing */
  style?: StyleId;
  /** mood words this scene expresses well */
  tags: string[];
  params: ParamDef[];
  modulations?: ModulationSeed[];
  usesPhotos?: boolean;
  /** true when the scene is built on the person's video clips (the footage looks) */
  usesClips?: boolean;
  /** true when the scene draws the line figures made for the person (src/figures) */
  usesFigures?: boolean;
  /** true when the scene is built on the drawings made for the song (the Sketchbook looks) */
  usesDrawings?: boolean;
  /** true when the scene expects a light (off-white) background by default */
  light?: boolean;
  /** true when the scene already shows the sung words itself (typewriter, word cloud, lyric text);
   *  big lyrics over it are hidden unless the user asks for them anyway */
  showsLyrics?: boolean;
  /** the fewest printing inks this scene still reads with under the hand-drawn finish (4 = every
   *  palette role, muted included). The finish prints with more inks while the scene plays, never fewer
   *  than the person chose, and full colour (0 inks) is left alone */
  handInks?: 1 | 2 | 3 | 4;
  /** true when the scene falls apart under the hand-drawn finish (fine detail, soft gradients): it shows
   *  clean until the person picks a finish themselves */
  prefersClean?: boolean;
  create(init: SceneInit): SceneInstance;
}

/* ───────────────────────── Effects ───────────────────────── */

export type EffectCategory = 'texture' | 'color' | 'distort' | 'time' | 'glitch' | 'optics';

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  category: EffectCategory;
  params: ParamDef[];
  /**
   * GLSL (WebGL1-style: texture2D / gl_FragColor) fragment shader with a `void main()`.
   * The engine prepends the shared header (see src/core/glsl.ts): tInput, tPrev, vUv,
   * uResolution, uTime, audio uniforms, palette uniforms, the common function library,
   * and one uniform per param named `u_<paramId>` (number/bool/select → float, color → vec3).
   */
  fragment: string;
  /** if true, `tPrev` holds this effect's own previous output (for trails / feedback) */
  feedback?: boolean;
}

export interface EffectInstance {
  instanceId: string;
  effectId: string;
  enabled: boolean;
  params: ParamValues;
}

/* ───────────────────────── Modulation ───────────────────────── */

export interface Modulation {
  id: string;
  source: LayerId;
  /** 'scene.<paramId>' or 'fx.<instanceId>.<paramId>' */
  target: string;
  /** -1..1 — fraction of the param's range added at full signal */
  amount: number;
  enabled: boolean;
}

/* ───────────────────────── Presets ───────────────────────── */

export interface PresetEffect {
  effectId: string;
  params?: ParamValues;
  enabled?: boolean;
}

export interface PresetModulation {
  source: LayerId;
  /** 'scene.<paramId>' or 'fx.<indexInPresetEffects>.<paramId>' */
  target: string;
  amount: number;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** mood / genre words, e.g. ['dubstep', 'heavy', 'aggressive'] */
  tags: string[];
  sceneId: string;
  /** style family, when the look reads differently from its scene (otherwise the scene's) */
  style?: StyleId;
  sceneParams?: ParamValues;
  effects: PresetEffect[];
  modulations: PresetModulation[];
  palette: Palette;
  /** a hand-drawn finish saved with the look (looks without one leave the current setting alone) */
  hand?: HandStyle;
  /** created by the AI director or the user */
  custom?: boolean;
  /**
   * The look family this is a take of (src/presets/families.ts). Built-in looks are placed by the
   * families table; a look can also name its family here (custom takes do). Missing → it is a family
   * of its own.
   */
  family?: string;
  /** short name of this take inside its family ("Moonlight", "Neon"); missing → from the table or the name */
  variant?: string;
  /** fit for a look that is its own family and isn't in the families table (missing parts are inferred from tags) */
  fit?: Partial<LookFit>;
}

/* ───────── look families: what part of a song a look is for ───────── */

/**
 * The job a look does in a song. Section labels map onto these: chorus and drop are both `peak`,
 * break is `break` (a breakdown).
 */
export type LookRole = 'intro' | 'verse' | 'build' | 'peak' | 'break' | 'bridge' | 'outro';
/** how a look moves most of the time: barely, slowly, on the beat, or in bursts */
export type LookMotion = 'still' | 'drifting' | 'pulsing' | 'explosive';
/** what a look is of (subject matter), for the library filter; a family has one or two */
export type LookTheme = 'nature' | 'city' | 'club' | 'light' | 'paper' | 'graphic' | 'type' | 'retro' | 'data' | 'photo' | 'board';

export interface LookFit {
  /** the parts it serves best, best first */
  roles: LookRole[];
  /** the energy it feels right at, 0 still … 1 flat out */
  energy: [number, number];
  motion: LookMotion;
  themes: LookTheme[];
  /** families it sits well next to (in a rotation or the next part) */
  pairs: string[];
  /** families it fights with */
  clashes: string[];
}

/** the hand-drawn finish over the whole frame (see src/render/handPass.ts) */
export interface HandStyle {
  on: boolean;
  /** new drawings per second: 60 moves smoothly (only the lines re-draw, 12 times a second), 12 is "on twos", 8 is "on threes" */
  fps: 60 | 12 | 8;
  /** how much each drawing strays from the last, 0..1 */
  wobble: number;
  /** printing inks besides the paper (1–4, from the palette); 0 keeps full colour */
  inks: 0 | 1 | 2 | 3 | 4;
  /** paper fibre, grain and uneven ink, 0..1 */
  paper: number;
  /** inks printed slightly out of line with each other, 0..1 */
  misprint: number;
  /** pencil outline along edges, 0..1 */
  lines: number;
}

/* ───────────────────────── Director (AI) ───────────────────────── */

export interface CustomShaderSpec {
  id: string;
  name: string;
  description: string;
  /** fragment shader using the scene shader header (see src/core/glsl.ts) */
  fragment: string;
  params: ParamDef[];
  modulations?: ModulationSeed[];
}

export interface DirectorRequest {
  prompt: string;
  mode: 'preset' | 'shader';
  /** analysis.summary + numbers, if a track is loaded */
  track?: { summary: string; bpm: number; mood: MoodProfile; tags: string[] } | null;
  /** the current preset, for "make it more X" style edits */
  current?: Preset | null;
}

export interface DirectorResponse {
  preset?: Preset;
  shader?: CustomShaderSpec;
  /** one or two sentences explaining the creative choice */
  note: string;
  /** 'claude' when the model answered, 'local' for the offline heuristic */
  source: 'claude' | 'local';
  /** how Claude was reached: an API key, or the local claude CLI on your subscription */
  via?: 'api' | 'subscription';
}
