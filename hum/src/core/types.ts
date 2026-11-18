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

/* ───────────────────────── Scenes ───────────────────────── */

export interface SharedResources {
  /** 128×1 float texture of the current spectrum (red channel, 0..1) */
  spectrumTex: THREE.DataTexture;
  /** 512×1 float texture of the waveform (red channel, -1..1 mapped to 0..1) */
  waveformTex: THREE.DataTexture;
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

export interface SceneInstance {
  /** Draw one frame into `target` (it is already sized). Must not render to screen. */
  render(frame: FrameContext, target: THREE.WebGLRenderTarget): void;
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
  /** mood words this scene expresses well */
  tags: string[];
  params: ParamDef[];
  modulations?: ModulationSeed[];
  usesPhotos?: boolean;
  /** true when the scene expects a light (off-white) background by default */
  light?: boolean;
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
  sceneParams?: ParamValues;
  effects: PresetEffect[];
  modulations: PresetModulation[];
  palette: Palette;
  /** created by the AI director or the user */
  custom?: boolean;
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
