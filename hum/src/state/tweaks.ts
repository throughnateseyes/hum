/**
 * Changes made to a look while fine-tuning it (the Part tab's "Fine-tune this look"), kept per song.
 *
 * The look on screen is rebuilt from its preset every time it comes back: the next shot that uses it,
 * a seek, a remake, a reload. Without this, a slider moved by hand lasted only until the next cut. So
 * each look keeps the difference between what its preset makes and what the person made of it, and
 * applyPreset (store.ts) puts that difference back on top every time. The difference is small (the
 * sliders that moved, and the effects, sound links or colours only when those changed), it is saved
 * per song in localStorage, and it comes back on reload.
 *
 * A tweak belongs to the look, not to one part: every part of this video that uses the look gets it.
 * "Save as a take" is still how a version is kept beyond this song.
 *
 * Nothing here reads the store (store.ts imports this file), so it is plain functions over data.
 */
import type { Palette, ParamValue, Preset, PresetEffect, PresetModulation } from '../core/types';
import { lookToPreset, type LookState } from '../presets/apply';

export interface LookTweak {
  /** scene sliders that differ from the preset, by param id */
  sceneParams?: Record<string, ParamValue>;
  /** the whole effect stack, in preset form, when it differs (added, removed, moved, switched, a slider moved) */
  effects?: PresetEffect[];
  /** every sound link, in preset form (effect targets by index), when they differ */
  modulations?: PresetModulation[];
  /** the five colours, when they differ */
  palette?: Palette;
}

/** a song's tweaks, by look id */
export type TweakTable = Record<string, LookTweak>;

/** what the Fine-tune sections show a "changed" mark for */
export interface TweakParts {
  params: boolean;
  fx: boolean;
  colours: boolean;
  sound: boolean;
}

export function tweakParts(t: LookTweak | undefined): TweakParts {
  return { params: !!t?.sceneParams, fx: !!t?.effects, colours: !!t?.palette, sound: !!t?.modulations };
}

/** the preset with the tweak laid over it (the id stays, so it still reads as the same look) */
export function withTweak(p: Preset, t: LookTweak | undefined): Preset {
  if (!t) return p;
  return {
    ...p,
    sceneParams: t.sceneParams ? { ...p.sceneParams, ...t.sceneParams } : p.sceneParams,
    effects: t.effects ?? p.effects,
    modulations: t.modulations ?? p.modulations,
    palette: t.palette ?? p.palette,
  };
}

const META = { id: '', name: '', description: '', tags: [] };
const COLOURS = ['bg', 'fg', 'accent', 'accent2', 'muted'] as const;

/**
 * How `now` differs from `base` (the look as its preset makes it), or null when it doesn't. Both must be
 * the same scene: a different scene is not a tweak of this look.
 */
export function tweakOf(base: LookState, now: LookState): LookTweak | null {
  if (base.sceneId !== now.sceneId) return null;
  const t: LookTweak = {};
  const params: Record<string, ParamValue> = {};
  let anyParam = false;
  for (const k of Object.keys(now.sceneParams)) {
    if (now.sceneParams[k] !== base.sceneParams[k]) {
      params[k] = now.sceneParams[k];
      anyParam = true;
    }
  }
  if (anyParam) t.sceneParams = params;
  // effects and sound links compare in preset form, where instance ids become positions
  const b = lookToPreset(base, META);
  const n = lookToPreset(now, META);
  if (JSON.stringify(b.effects) !== JSON.stringify(n.effects)) t.effects = n.effects;
  if (JSON.stringify(b.modulations) !== JSON.stringify(n.modulations)) t.modulations = n.modulations;
  if (COLOURS.some((k) => base.palette[k] !== now.palette[k])) t.palette = { ...now.palette };
  return Object.keys(t).length ? t : null;
}

/* ───────── kept per song ───────── */

const KEY = 'hum.tweaks';
/** songs remembered (oldest dropped first), as many as saved plans */
const MAX_SONGS = 24;

type Saved = Record<string, { at: number; looks: TweakTable }>;

function readAll(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Saved) : {};
  } catch {
    return {};
  }
}

/** the tweaks saved for this song ('' when no song is loaded) */
export function loadTweaks(song: string): TweakTable {
  const e = readAll()[song];
  return e && e.looks && typeof e.looks === 'object' ? e.looks : {};
}

export function saveTweaks(song: string, table: TweakTable) {
  try {
    const all = readAll();
    delete all[song];
    if (Object.keys(table).length) all[song] = { at: Date.now(), looks: table };
    const keys = Object.keys(all).sort((x, y) => all[x].at - all[y].at);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the tweaks last until the page closes */
  }
}
