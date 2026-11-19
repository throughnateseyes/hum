/**
 * Style families: what kind of picture a scene makes, whatever the mood. Every scene belongs to one
 * (`SceneDef.style`), a look takes its scene's unless it sets its own, and the library, the planner and
 * the AI director sort and pick by them. Moods live in `tags`; a style is the visual language.
 */
import type { Preset, SceneDef } from './types';

export type StyleId = 'world' | 'light' | 'particles' | 'form' | 'print' | 'type' | 'data' | 'photo' | 'board';

export const STYLES: { id: StyleId; label: string; hint: string }[] = [
  { id: 'world', label: 'Worlds', hint: 'Places and living things: sky, water, forest, city, creatures' },
  { id: 'light', label: 'Light', hint: 'Light, liquid, glass and cloth: soft abstract fields' },
  { id: 'particles', label: 'Particles', hint: 'Swarms, networks and crowds of small bodies' },
  { id: 'form', label: 'Forms', hint: '3D objects and architecture' },
  { id: 'print', label: 'Print', hint: 'Dots, beads, tiles, mosaics and paper: things that look printed or made by hand' },
  { id: 'type', label: 'Type', hint: 'Posters and lyric pieces, where words are the picture' },
  { id: 'data', label: 'Data', hint: 'Scans, read-outs, contours and machine vision' },
  { id: 'photo', label: 'Photo', hint: 'Your photos, taken apart and rebuilt by the music' },
  { id: 'board', label: 'Boards', hint: 'Instrument sheets: many small modules reading the song' },
];

const BY_ID = new Map(STYLES.map((s) => [s.id, s]));
export const styleLabel = (id: StyleId) => BY_ID.get(id)?.label ?? id;
export const isStyle = (v: unknown): v is StyleId => typeof v === 'string' && BY_ID.has(v as StyleId);

/** a scene's style family; scenes that don't name one (AI-written scenes, older ones) fall back on their category */
export function sceneStyle(def: Pick<SceneDef, 'style' | 'category'> | undefined): StyleId {
  if (def?.style) return def.style;
  switch (def?.category) {
    case 'board':
      return 'board';
    case 'photo':
      return 'photo';
    case 'form':
      return 'form';
    default:
      return 'light';
  }
}

/* The scene registry tells us each scene's family as it loads (src/scenes/index.ts), so code that only
   has a look in hand (the library, the planner) can ask for its family without importing every scene. */
const bySceneId = new Map<string, StyleId>();
export function noteSceneStyle(def: Pick<SceneDef, 'id' | 'style' | 'category'>) {
  bySceneId.set(def.id, sceneStyle(def));
}

/** a look's style family: its own when it names one, otherwise its scene's */
export function lookStyle(p: Pick<Preset, 'style' | 'sceneId'>): StyleId {
  return p.style ?? bySceneId.get(p.sceneId) ?? 'light';
}
