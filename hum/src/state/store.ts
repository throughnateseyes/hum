import { isMix, type Mix } from '../director/mix';
import { create } from 'zustand';
import type {
  ClipAsset,
  CustomShaderSpec,
  EffectInstance,
  HandStyle,
  LayerId,
  Lyrics,
  Modulation,
  Palette,
  ParamValue,
  PartShot,
  PhotoAsset,
  Preset,
  TrackAnalysis,
} from '../core/types';
import { PALETTES } from '../core/palettes';
import { getEffect } from '../fx';
import { getScene, registerScene } from '../scenes';
import { makeCustomShaderScene } from '../scenes/custom';
import { presetToLook, lookToPreset, type LookState } from '../presets/apply';
import { PRESETS } from '../presets';
import { loadPlaced, NOTHING, savePlaced, type Placed } from '../arrange/types';
import { loadDrawParts, saveDrawParts } from '../draw/parts';
import { cleanGraphics, type GraphicId } from '../shot/graphics';
import { cleanInks, INK_DEFAULT, type InkColors } from '../shot/inks';
import { loadSongName, saveSongName, type SongName } from './songName';
import type { DrawingAsset, DrawPart } from '../draw/types';
import { uid } from './modulation';
import type { VideoPlan } from './plan';
import { isTransitionId, type TransitionId } from '../core/transitionList';
import { isFinishId, type FinishId } from '../core/direction';
import { loadTweaks, saveTweaks, tweakOf, withTweak, type LookTweak, type TweakTable } from './tweaks';

export type Aspect = 'fill' | '16:9' | '9:16' | '1:1' | '4:5';
/** the right panel's tabs. 'video', 'part' and 'render' are the new layout; the first four are the old one, on their way out */
export type InspectorTab = 'video' | 'part' | 'render';
export type LyricStyle = 'off' | 'subtitle' | 'big' | 'cutout' | 'auto';
/** big / cutout lyrics on looks that already show the words themselves (typewriter, word cloud…) */
export type LyricsOnBoards = 'hide' | 'show';
/** the lyric typeface: 'auto' follows the song (or Claude's plan); the rest are bundled fonts */
export type LyricFont = 'auto' | 'grotesk' | 'serif' | 'condensed' | 'mono' | 'hand';
export const LYRIC_FONTS: LyricFont[] = ['auto', 'grotesk', 'serif', 'condensed', 'mono', 'hand'];
/** the lyrics' lettering: 'auto' matches the video's finish; the rest put one type kit everywhere */
export type TypeKitSetting = 'auto' | 'clean' | 'tape' | 'film' | 'print';
export const TYPE_KITS: TypeKitSetting[] = ['auto', 'clean', 'tape', 'film', 'print'];
/** small board windows over the picture: during a played video plan, always, or never */
export type PopupMode = 'video' | 'always' | 'off';
/** what the pop-up windows show: instruments (little board modules), other looks playing live, or both */
export type WindowKind = 'instruments' | 'looks' | 'both';
/** song colours: every look in a video leans toward the video's main look's colours (off, blend halfway, match) */
export type SongColors = 'off' | 'blend' | 'match';
/** how often a video plan changes the picture: calmer, follow the song, or faster */
export type Pace = 'slow' | 'song' | 'fast';
export type LyricsStatus = 'idle' | 'searching' | 'found' | 'plain' | 'none' | 'instrumental';
/** progress while pasted lyrics are being synced to the song */
export type LyricsSync = { stage: 'prepare' | 'download' | 'listening'; frac: number } | null;

/**
 * One-tap start: what a newly loaded song is doing on its way to a playing video (the stage shows one
 * calm progress state for it). 'listen': being decoded and analysed; 'plan': the video being planned.
 * `since` (ms) and `duration` (s, the song's length once known) let the stage pace its progress bar.
 */
export type Startup = { step: 'listen' | 'plan'; since: number; duration: number } | null;

export interface ClipProgress {
  /** 'depth': reading the depth its Inside shots are drawn from (a render; `frac` is of that) */
  phase: 'prep' | 'depth' | 'rec' | 'save';
  frac: number;
  /** the stretch of the song being recorded (s) */
  start: number;
  end: number;
  /** render timeline: the size being made ("1080×1920"), and which of how many */
  size?: string;
  index?: number;
  count?: number;
  /** seconds since it began */
  elapsed?: number;
  /** about how many seconds are left for everything asked for (every size); undefined until it can be trusted. `timeLeftText` (render/timeLeft.ts) puts it in words */
  left?: number;
  /** how fast it goes against the song: 2 makes two seconds of video a second; undefined until it can be trusted */
  speed?: number;
  /** while depth is read: the shot, of how many (0: not known yet), and whether the model is still coming down */
  n?: number;
  of?: number;
  loading?: boolean;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'director';
  text: string;
  mode: 'preset' | 'shader' | 'plan';
  at: number;
  /** what the director made, so it can be re-applied from the history */
  presetId?: string;
  shaderId?: string;
  title?: string;
  source?: 'claude' | 'local';
  via?: 'api' | 'subscription';
  error?: boolean;
}

export interface TrackInfo {
  name: string;
  source: 'demo' | 'file' | 'mic';
  id?: string;
}

export interface StudioState extends LookState {
  presetId: string | null;
  track: TrackInfo | null;
  /** what the person calls the song that is loaded (null: what its file's name says; see songName.ts) */
  songName: SongName | null;
  analysis: TrackAnalysis | null;
  analyzing: boolean;
  photos: PhotoAsset[];
  clips: ClipAsset[];
  /** every drawing kept in this browser, deleted ones too until a reload (src/draw/session.ts asks the questions) */
  drawings: DrawingAsset[];
  /** ids of drawings that were deleted (so a delete can be undone) */
  drawTrash: string[];
  /** what parts of this song do with drawings, by time */
  drawParts: DrawPart[];
  /** the pop-ups and drawings placed by hand in this song, by time (src/arrange) */
  placed: Placed;
  /** small drawings beside the lyrics when a word that has one is sung */
  drawOverlay: boolean;
  /** a video made from the person's footage has drawings standing in some of its shots (director/footageArt.ts) */
  drawInScene: boolean;
  text: string;
  aspect: Aspect;
  inspectorTab: InspectorTab;
  /** parts of the song picked on the timeline (section indices, in the order picked); the Part tab edits them all */
  selectedParts: number[];
  /** the row of live meters under the timeline shows (it is only for dragging onto a slider) */
  metersOpen: boolean;
  /** hand-drawn for one part: true on, false off, null as the video is set (missing: all as the video) */
  partHand: (boolean | null)[] | null;
  /** each part's own footage choices: style, arrangement, treatment, which media and how it is framed (missing: all as the look) */
  partShot: (PartShot | null)[] | null;
  /** the same choices for a look playing on its own, with no video plan (the Look tab's Picture controls) */
  soloShot: PartShot | null;
  /** the words a look that writes text shows in one part (null: its own words, from the lyrics or the title text) */
  partWords: (string | null)[] | null;
  perform: boolean;
  autoPilot: boolean;
  sensitivity: number;
  /** how hard everything reacts to the music: 0 still, 1 normal, 2 wild */
  impact: number;
  /** how loud the song plays here, 0 to 1 (the visuals don't change) */
  volume: number;
  muted: boolean;
  quality: number;
  customPresets: Preset[];
  customShaders: CustomShaderSpec[];
  shaderError: string | null;
  toast: string | null;
  /** a TikTok / Reels clip export in progress: getting ready, then recording (frac 0..1 of the clip) */
  clip: ClipProgress | null;
  chat: ChatMsg[];
  directorOpen: boolean;
  directorHeight: number;
  /** the song's video plan: a look per section */
  plan: VideoPlan | null;
  /**
   * The person's own pop-up level for each part of this song (0 none … 3 lots; null = the planner's).
   * Wins over the video plan's `pops`, survives re-plans and saved plans (kept per song in
   * planCache.ts), and also applies with Pop-ups set to Always. Set it with setPartPops.
   */
  partPops: (number | null)[] | null;
  /** switch looks along the song map while playing */
  planOn: boolean;
  planning: boolean;
  /** the step a directed Make is at, in plain words (null: none running), and a short line when a step failed (director/footageDirector.ts) */
  making: { text: string; n?: number; of?: number } | null;
  makeNote: string;
  lyrics: Lyrics | null;
  lyricsStatus: LyricsStatus;
  /** why nothing was found, or what was searched */
  lyricsNote: string;
  lyricStyle: LyricStyle;
  /** the user chose a lyric style themselves (until then it's Auto) */
  lyricStylePicked: boolean;
  lyricsOnBoards: LyricsOnBoards;
  lyricFont: LyricFont;
  /** the lyrics' lettering: 'auto' matches the finish, or one kit everywhere (render/typeKits) */
  typeKit: TypeKitSetting;
  /** sync new songs' lyrics to the singing by listening, on their own (where the device can) */
  lyricsAutoSync: boolean;
  lyricsSync: LyricsSync;
  /** what the automatic lookup searched for (prefills the search box) */
  lyricsQuery: { title?: string; artist?: string };
  /** share of pasted words the listener matched, after a sync (null when not synced by listening) */
  lyricsMatched: number | null;
  /** the tap-to-fix panel is open */
  tapSync: boolean;
  /** hand-drawn finish over every scene */
  hand: HandStyle;
  popups: PopupMode;
  windowKind: WindowKind;
  songColors: SongColors;
  /** shot pacing for video plans */
  pace: Pace;
  /** how much of a video is the person's own footage (director/mix.ts) */
  mix: Mix;
  /** clips running slowly glide between their frames (shot/slowmo.ts) */
  smoothSlow: boolean;
  /** what may not cover the picture, in the whole video (shot/graphics.ts) */
  graphicsOff: GraphicId[];
  /** the colours the drawn and printed finishes use (shot/inks.ts) */
  inkColors: InkColors;
  /** how looks change: picked from the song (auto), one transition always, or 'cut' */
  transition: 'auto' | TransitionId;
  /** transition length in beats (0 = picked from the song) */
  transitionBeats: number;
  /** the finish over every look: 'auto' follows the playing video's Direction (else Hand-drawn when it's on) */
  finish: 'auto' | FinishId;
  /** the person picked a finish themselves; until then every video is Hand-drawn (the house look) */
  finishPicked: boolean;
  /** a finish being tried on while the pointer rests on it in the Video tab (null: none). Never saved, never undone, never rendered. */
  finishPreview: 'auto' | FinishId | null;
  /** one-tap start: a song that's dropped, picked or chosen as a demo is analysed, planned and played from the top on its own */
  oneTap: boolean;
  /**
   * Changes made to looks while fine-tuning them, by look id, for the loaded song (state/tweaks.ts).
   * applyPreset lays a look's tweak over its preset every time the look comes back.
   */
  tweaks: TweakTable;
  /** a one-tap start under way (null when nothing is loading) */
  startup: Startup;
  /** the song is ready but the browser wouldn't start sound without a tap: the stage shows a big play button */
  needsTap: boolean;

  applyPreset: (p: Preset) => void;
  setScene: (id: string) => void;
  setSceneParam: (id: string, v: ParamValue) => void;
  addEffect: (effectId: string) => void;
  removeEffect: (instanceId: string) => void;
  toggleEffect: (instanceId: string) => void;
  moveEffect: (instanceId: string, dir: -1 | 1) => void;
  setEffectParam: (instanceId: string, id: string, v: ParamValue) => void;
  addModulation: (source: LayerId, target: string, amount?: number) => void;
  updateModulation: (id: string, patch: Partial<Modulation>) => void;
  removeModulation: (id: string) => void;
  setPalette: (p: Palette) => void;
  setPaletteColor: (key: keyof Omit<Palette, 'id' | 'name'>, hex: string) => void;
  /** the look on screen back to its preset: its tweaks for this song are forgotten */
  resetLookTweaks: () => void;
  /** put the look on screen back together from its preset and its tweaks (after an undo changed the tweaks) */
  reapplyLook: () => void;
  addPhotos: (p: PhotoAsset[]) => void;
  removePhoto: (id: string) => void;
  addClips: (c: ClipAsset[]) => void;
  removeClip: (id: string) => void;
  /** `family`: save it as a take of that look family (src/presets/families.ts) */
  saveCurrentAsPreset: (name: string, family?: string) => Preset;
  deleteCustomPreset: (id: string) => void;
  addCustomShader: (spec: CustomShaderSpec) => void;
  addCustomPreset: (p: Preset) => void;
  pushChat: (m: Omit<ChatMsg, 'id' | 'at'>) => void;
  clearChat: () => void;
  set: (patch: Partial<StudioState>) => void;
  flash: (msg: string) => void;
  /**
   * How busy pop-ups get in part `sectionIndex` (an index into analysis.sections): 0 none (no
   * instrument pop-ups and no scene windows at all), 1 a few … 3 lots, or null to hand the part back
   * to the planner. Read the result with partPopsAt() (state/plan.ts).
   */
  setPartPops: (sectionIndex: number, level: number | null) => void;
}

export const HAND_DEFAULT: HandStyle = { on: true, fps: 60, wobble: 0.5, inks: 3, paper: 0.6, misprint: 0.45, lines: 0.35 };

/** a stored or AI-made hand style, with anything missing or out of range fixed */
export function cleanHand(h: unknown): HandStyle | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const o = h as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
  // settings saved before smooth became the default (no v: 2) start smooth too
  const fps = o.v === 2 && (o.fps === 12 || o.fps === 8) ? o.fps : 60;
  const inks = typeof o.inks === 'number' ? (Math.max(0, Math.min(4, Math.round(o.inks))) as HandStyle['inks']) : HAND_DEFAULT.inks;
  return {
    on: o.on !== false,
    fps,
    wobble: n(o.wobble, HAND_DEFAULT.wobble),
    inks,
    paper: n(o.paper, HAND_DEFAULT.paper),
    misprint: n(o.misprint, HAND_DEFAULT.misprint),
    lines: n(o.lines, HAND_DEFAULT.lines),
  };
}

const LS_KEY = 'hum.v1';
const ASPECTS: Aspect[] = ['fill', '16:9', '9:16', '1:1', '4:5'];

/** settings as they were kept, with anything that doesn't hold left out */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cleanSettings(j: any): Partial<StudioState> {
  return {
    aspect: ASPECTS.includes(j.aspect as Aspect) ? (j.aspect as Aspect) : undefined,
    sensitivity: typeof j.sensitivity === 'number' ? j.sensitivity : undefined,
    quality: typeof j.quality === 'number' ? j.quality : undefined,
    impact: typeof j.impact === 'number' ? j.impact : undefined,
    volume: typeof j.volume === 'number' ? Math.min(1, Math.max(0, j.volume)) : undefined,
    muted: typeof j.muted === 'boolean' ? j.muted : undefined,
    directorOpen: typeof j.directorOpen === 'boolean' ? j.directorOpen : undefined,
    directorHeight: typeof j.directorHeight === 'number' ? j.directorHeight : undefined,
    hand: cleanHand(j.hand),
    popups: j.popups === 'off' || j.popups === 'always' || j.popups === 'video' ? (j.popups as PopupMode) : undefined,
    windowKind: j.windowKind === 'instruments' || j.windowKind === 'looks' || j.windowKind === 'both' ? (j.windowKind as WindowKind) : undefined,
    songColors: j.songColors === 'off' || j.songColors === 'blend' || j.songColors === 'match' ? (j.songColors as SongColors) : undefined,
    pace: j.pace === 'slow' || j.pace === 'fast' || j.pace === 'song' ? (j.pace as Pace) : undefined,
    mix: isMix(j.mix) ? j.mix : undefined,
    smoothSlow: typeof j.smoothSlow === 'boolean' ? j.smoothSlow : undefined,
    graphicsOff: cleanGraphics(j.graphicsOff),
    inkColors: cleanInks(j.inkColors),
    transition: j.transition === 'auto' || isTransitionId(j.transition) ? j.transition : undefined,
    transitionBeats: typeof j.transitionBeats === 'number' && j.transitionBeats >= 0 && j.transitionBeats <= 8 ? j.transitionBeats : undefined,
    // a finish only sticks once the person has picked one (an old saved Auto doesn't count)
    finish: j.finishPicked === true && (j.finish === 'auto' || isFinishId(j.finish)) ? j.finish : undefined,
    finishPicked: j.finishPicked === true,
    // a style only sticks once the user has picked one; before that every song gets Auto
    lyricStyle: j.lyricStylePicked && ['off', 'subtitle', 'big', 'cutout', 'auto'].includes(j.lyricStyle) ? (j.lyricStyle as LyricStyle) : undefined,
    lyricStylePicked: j.lyricStylePicked === true,
    lyricsOnBoards: j.lyricsOnBoards === 'show' || j.lyricsOnBoards === 'hide' ? (j.lyricsOnBoards as LyricsOnBoards) : undefined,
    lyricFont: LYRIC_FONTS.includes(j.lyricFont) ? (j.lyricFont as LyricFont) : undefined,
    typeKit: TYPE_KITS.includes(j.typeKit) ? (j.typeKit as TypeKitSetting) : undefined,
    lyricsAutoSync: typeof j.lyricsAutoSync === 'boolean' ? j.lyricsAutoSync : undefined,
    oneTap: typeof j.oneTap === 'boolean' ? j.oneTap : undefined,
    drawOverlay: typeof j.drawOverlay === 'boolean' ? j.drawOverlay : undefined,
    // (kept under a new name when it became off unless asked for)
    drawInScene: typeof j.drawAuto === 'boolean' ? j.drawAuto : undefined,
  };
}

function loadPersisted(): Partial<StudioState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return {
      ...cleanSettings(j),
      customPresets: Array.isArray(j.customPresets) ? j.customPresets : [],
      customShaders: Array.isArray(j.customShaders) ? j.customShaders : [],
      chat: Array.isArray(j.chat) ? j.chat : [],
    };
  } catch {
    return {};
  }
}
/** the most clips kept at once (each is a decoded video file in memory) */
export const MAX_CLIPS = 12;

/** everything the person has set, as it is kept */
export function settingsOf(s: StudioState) {
  return {
    customPresets: s.customPresets,
    customShaders: s.customShaders,
    aspect: s.aspect,
    sensitivity: s.sensitivity,
    quality: s.quality,
    impact: s.impact,
    volume: s.volume,
    muted: s.muted,
    chat: s.chat.slice(-60),
    directorOpen: s.directorOpen,
    directorHeight: s.directorHeight,
    lyricStyle: s.lyricStyle,
    lyricStylePicked: s.lyricStylePicked,
    lyricsOnBoards: s.lyricsOnBoards,
    lyricFont: s.lyricFont,
    typeKit: s.typeKit,
    lyricsAutoSync: s.lyricsAutoSync,
    hand: { ...s.hand, v: 2 },
    popups: s.popups,
    windowKind: s.windowKind,
    songColors: s.songColors,
    pace: s.pace,
    mix: s.mix,
    smoothSlow: s.smoothSlow,
    graphicsOff: s.graphicsOff,
    inkColors: s.inkColors,
    transition: s.transition,
    transitionBeats: s.transitionBeats,
    finish: s.finish,
    finishPicked: s.finishPicked,
    oneTap: s.oneTap,
    drawOverlay: s.drawOverlay,
    drawAuto: s.drawInScene,
  };
}

function persist(s: StudioState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settingsOf(s)));
  } catch {
    /* storage may be unavailable */
  }
}

const persisted = loadPersisted();
for (const spec of persisted.customShaders ?? []) {
  try {
    registerScene(makeCustomShaderScene(spec));
  } catch {
    /* ignore */
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The look on screen as its preset made it, before any tweak: what a change made while fine-tuning is
 * told against. applyPreset sets it; a scene picked on its own (setScene) has no preset, so no tweaks.
 */
let base: { preset: Preset; look: LookState } | null = null;

/** true while applyPreset puts a look on (playback, not an edit: history.ts reads it) */
let applyingLook = false;
export function isApplyingLook(): boolean {
  return applyingLook;
}

/**
 * true while the app itself changes store.soloShot (cleared because another scene came on screen,
 * brought back after a reload): bookkeeping, not an edit, so history.ts folds it in without a step.
 */
let soloQuiet = false;
export function isSoloQuiet(): boolean {
  return soloQuiet;
}
/** set store.soloShot without making an Undo step (see isSoloQuiet) */
export function setSoloShotQuietly(v: PartShot | null) {
  soloQuiet = true;
  try {
    useStudio.setState({ soloShot: v });
  } finally {
    soloQuiet = false;
  }
}

/**
 * A fine-tuning change `next` to the look on screen, with the look's tweak for this song brought up to
 * date in the same store change (so the change is there again the next time the look comes back).
 */
function tuned(s: StudioState, next: Partial<StudioState>): Partial<StudioState> {
  const id = s.presetId;
  if (!Object.keys(next).length || !id || !base || base.preset.id !== id) return next;
  const now: LookState = {
    sceneId: s.sceneId,
    sceneParams: next.sceneParams ?? s.sceneParams,
    effects: next.effects ?? s.effects,
    modulations: next.modulations ?? s.modulations,
    palette: next.palette ?? s.palette,
  };
  const t: LookTweak | null = tweakOf(base.look, now);
  if (!t && !s.tweaks[id]) return next;
  const tweaks = { ...s.tweaks };
  if (t) tweaks[id] = t;
  else delete tweaks[id];
  return { ...next, tweaks };
}

/** a scene with its default params; keeps effect routings, swaps in the scene's own suggested routings */
export function sceneLook(id: string, mods: Modulation[]) {
  const def = getScene(id);
  if (!def) return null;
  const sceneParams: Record<string, ParamValue> = {};
  for (const d of def.params) sceneParams[d.id] = d.default;
  const keep = mods.filter((m) => !m.target.startsWith('scene.'));
  const seeds: Modulation[] = (def.modulations ?? []).map((m) => ({
    id: uid('mod'),
    source: m.source,
    target: `scene.${m.param}`,
    amount: m.amount,
    enabled: true,
  }));
  return { sceneId: id, sceneParams, modulations: [...keep, ...seeds] };
}

export const useStudio = create<StudioState>((set, get) => ({
  sceneId: '',
  sceneParams: {},
  effects: [],
  modulations: [],
  palette: PALETTES[0],
  presetId: null,
  track: null,
  analysis: null,
  analyzing: false,
  photos: [],
  clips: [],
  text: '',
  aspect: (persisted.aspect as Aspect) ?? 'fill',
  inspectorTab: 'video',
  selectedParts: [],
  metersOpen: false,
  partHand: null,
  partShot: null,
  soloShot: null,
  partWords: null,
  perform: false,
  autoPilot: false,
  sensitivity: persisted.sensitivity ?? 1,
  impact: persisted.impact ?? 1,
  volume: persisted.volume ?? 1,
  muted: persisted.muted ?? false,
  quality: persisted.quality ?? 1,
  customPresets: persisted.customPresets ?? [],
  customShaders: persisted.customShaders ?? [],
  shaderError: null,
  toast: null,
  clip: null,
  chat: persisted.chat ?? [],
  directorOpen: persisted.directorOpen ?? true,
  directorHeight: persisted.directorHeight ?? 320,
  plan: null,
  partPops: null,
  planOn: false,
  planning: false,
  making: null,
  makeNote: '',
  lyrics: null,
  lyricsStatus: 'idle',
  lyricsNote: '',
  lyricStyle: persisted.lyricStyle ?? 'auto',
  lyricStylePicked: persisted.lyricStylePicked ?? false,
  lyricsOnBoards: persisted.lyricsOnBoards ?? 'hide',
  lyricFont: persisted.lyricFont ?? 'auto',
  typeKit: persisted.typeKit ?? 'auto',
  lyricsAutoSync: persisted.lyricsAutoSync ?? true,
  lyricsSync: null,
  lyricsQuery: {},
  lyricsMatched: null,
  tapSync: false,
  hand: persisted.hand ?? HAND_DEFAULT,
  popups: persisted.popups ?? 'video',
  windowKind: persisted.windowKind ?? 'both',
  songColors: persisted.songColors ?? 'blend',
  pace: persisted.pace ?? 'song',
  mix: persisted.mix ?? 'most',
  smoothSlow: persisted.smoothSlow ?? true,
  graphicsOff: persisted.graphicsOff ?? [],
  inkColors: persisted.inkColors ?? INK_DEFAULT,
  transition: persisted.transition ?? 'auto',
  transitionBeats: persisted.transitionBeats ?? 0,
  // Hand-drawn is the house look: a plan's own finish only shows once the person picks Auto
  finish: persisted.finish ?? 'hand',
  finishPicked: persisted.finishPicked ?? false,
  finishPreview: null,
  oneTap: persisted.oneTap ?? true,
  drawings: [],
  drawTrash: [],
  drawParts: [],
  songName: null,
  placed: NOTHING,
  drawOverlay: persisted.drawOverlay ?? true,
  drawInScene: persisted.drawInScene ?? false,
  tweaks: loadTweaks(''),
  startup: null,
  needsTap: false,

  applyPreset: (p) => {
    const plain = presetToLook(p);
    if (!getScene(plain.sceneId)) return;
    base = { preset: p, look: plain };
    // the person's changes to this look in this song go back on top of the preset, every time
    const t = get().tweaks[p.id];
    const look = t ? presetToLook(withTweak(p, t)) : plain;
    const hand = cleanHand(p.hand);
    applyingLook = true;
    try {
      set({ ...look, presetId: p.id, shaderError: null, ...(hand ? { hand } : {}) });
    } finally {
      applyingLook = false;
    }
  },

  setScene: (id) => {
    const look = sceneLook(id, get().modulations);
    if (!look) return;
    set({ ...look, presetId: null, shaderError: null });
  },
  setSceneParam: (id, v) => set((s) => tuned(s, { sceneParams: { ...s.sceneParams, [id]: v } })),

  addEffect: (effectId) => {
    const def = getEffect(effectId);
    if (!def) return;
    const params: Record<string, ParamValue> = {};
    for (const d of def.params) params[d.id] = d.default;
    const inst: EffectInstance = { instanceId: uid('fx'), effectId, enabled: true, params };
    set((s) => tuned(s, { effects: [...s.effects, inst] }));
  },
  removeEffect: (instanceId) =>
    set((s) =>
      tuned(s, {
        effects: s.effects.filter((e) => e.instanceId !== instanceId),
        modulations: s.modulations.filter((m) => !m.target.startsWith(`fx.${instanceId}.`)),
      }),
    ),
  toggleEffect: (instanceId) =>
    set((s) => tuned(s, { effects: s.effects.map((e) => (e.instanceId === instanceId ? { ...e, enabled: !e.enabled } : e)) })),
  moveEffect: (instanceId, dir) =>
    set((s) => {
      const i = s.effects.findIndex((e) => e.instanceId === instanceId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.effects.length) return {};
      const arr = s.effects.slice();
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return tuned(s, { effects: arr });
    }),
  setEffectParam: (instanceId, id, v) =>
    set((s) =>
      tuned(s, {
        effects: s.effects.map((e) => (e.instanceId === instanceId ? { ...e, params: { ...e.params, [id]: v } } : e)),
      }),
    ),

  addModulation: (source, target, amount = 0.5) =>
    set((s) => tuned(s, { modulations: [...s.modulations, { id: uid('mod'), source, target, amount, enabled: true }] })),
  updateModulation: (id, patch) =>
    set((s) => tuned(s, { modulations: s.modulations.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  removeModulation: (id) => set((s) => tuned(s, { modulations: s.modulations.filter((m) => m.id !== id) })),

  setPalette: (p) => set((s) => tuned(s, { palette: { ...p } })),
  setPaletteColor: (key, hex) => set((s) => tuned(s, { palette: { ...s.palette, id: 'custom', name: 'Custom', [key]: hex } })),

  resetLookTweaks: () => {
    const s = get();
    const id = s.presetId;
    if (!id || !s.tweaks[id]) return;
    const tweaks = { ...s.tweaks };
    delete tweaks[id];
    if (base && base.preset.id === id) set({ ...presetToLook(base.preset), tweaks });
    else set({ tweaks });
  },
  reapplyLook: () => {
    const s = get();
    if (base && base.preset.id === s.presetId) s.applyPreset(base.preset);
  },

  addPhotos: (p) => set((s) => ({ photos: [...s.photos, ...p] })),
  removePhoto: (id) =>
    set((s) => {
      const ph = s.photos.find((x) => x.id === id);
      ph?.texture.dispose();
      return { photos: s.photos.filter((x) => x.id !== id) };
    }),

  addClips: (c) =>
    set((s) => {
      // past the most there is room for, the ones already here stay: a video may be made of them
      const room = Math.max(0, MAX_CLIPS - s.clips.length);
      for (const d of c.slice(room)) URL.revokeObjectURL(d.url);
      return room ? { clips: [...s.clips, ...c.slice(0, room)] } : {};
    }),
  removeClip: (id) =>
    set((s) => {
      const c = s.clips.find((x) => x.id === id);
      if (c) URL.revokeObjectURL(c.url);
      return { clips: s.clips.filter((x) => x.id !== id) };
    }),

  saveCurrentAsPreset: (name, family) => {
    const s = get();
    // a take keeps the tags of the look it came from, so the planner and the analysis still know what it's for
    const from = family ? [...s.customPresets, ...PRESETS].find((x) => x.id === s.presetId) : undefined;
    const p = lookToPreset(s, { id: uid('preset'), name, description: family ? `Your take${from ? ` on ${from.name}` : ''}` : 'Saved from the studio', tags: from ? [...from.tags] : ['custom'] });
    if (family) {
      p.family = family;
      p.variant = name;
    }
    if (s.hand.on) p.hand = { ...s.hand };
    // The take is what's on screen now, and later changes are told against it. The look it came from
    // keeps its tweak: the parts of this video that use that look still look the way they were made.
    base = { preset: p, look: { sceneId: s.sceneId, sceneParams: s.sceneParams, effects: s.effects, modulations: s.modulations, palette: s.palette } };
    set({ customPresets: [p, ...s.customPresets], presetId: p.id });
    persist(get());
    return p;
  },
  deleteCustomPreset: (id) => {
    set((s) => ({ customPresets: s.customPresets.filter((p) => p.id !== id) }));
    persist(get());
  },
  addCustomShader: (spec) => {
    registerScene(makeCustomShaderScene(spec));
    set((s) => ({ customShaders: [spec, ...s.customShaders.filter((x) => x.id !== spec.id)] }));
    persist(get());
  },

  addCustomPreset: (p) => {
    set((s) => ({ customPresets: [p, ...s.customPresets.filter((x) => x.id !== p.id)].slice(0, 40) }));
    persist(get());
  },
  pushChat: (m) => {
    set((s) => ({ chat: [...s.chat, { ...m, id: uid('msg'), at: Date.now() }].slice(-60) }));
    persist(get());
  },
  clearChat: () => {
    set({ chat: [] });
    persist(get());
  },

  set: (patch) => {
    set(patch);
    if ('aspect' in patch || 'sensitivity' in patch || 'quality' in patch || 'impact' in patch || 'volume' in patch || 'muted' in patch || 'directorOpen' in patch || 'directorHeight' in patch || 'lyricStyle' in patch || 'lyricsOnBoards' in patch || 'lyricFont' in patch || 'typeKit' in patch || 'lyricsAutoSync' in patch || 'hand' in patch || 'popups' in patch || 'windowKind' in patch || 'songColors' in patch || 'pace' in patch || 'mix' in patch || 'smoothSlow' in patch || 'graphicsOff' in patch || 'inkColors' in patch || 'transition' in patch || 'transitionBeats' in patch || 'finish' in patch || 'oneTap' in patch || 'drawOverlay' in patch || 'drawInScene' in patch) persist(get());
  },
  setPartPops: (i, level) => {
    const a = get().analysis;
    if (!a || !Number.isInteger(i) || i < 0 || i >= a.sections.length) return;
    const prev = get().partPops;
    const next = prev && prev.length === a.sections.length ? [...prev] : a.sections.map(() => null);
    next[i] = level === null || !Number.isFinite(level) ? null : Math.max(0, Math.min(3, Math.round(level)));
    set({ partPops: next.some((v) => v !== null) ? next : null });
  },
  flash: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));

// Each song keeps its own look tweaks and what its parts do with drawings: a song that loads brings its
// own back, and every change is saved.
let tweakSong = '';
useStudio.subscribe((s, prev) => {
  const song = s.track?.name ?? '';
  if (song !== tweakSong) {
    tweakSong = song;
    useStudio.setState({ tweaks: loadTweaks(song), drawParts: loadDrawParts(song), placed: loadPlaced(song), songName: loadSongName(song) });
    return;
  }
  if (s.tweaks !== prev.tweaks) saveTweaks(song, s.tweaks);
  if (s.drawParts !== prev.drawParts) saveDrawParts(song, s.drawParts);
  if (s.placed !== prev.placed) savePlaced(song, s.placed);
  if (s.songName !== prev.songName) saveSongName(song, s.songName);
});
