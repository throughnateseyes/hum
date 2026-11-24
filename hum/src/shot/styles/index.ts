/**
 * The footage styles: each one idea, built from two or three elements with a clear order of size,
 * placed on the frame's grid and moving on the bar (the contract is in src/shot/kit.ts).
 *
 *   plain    the footage alone, nothing on it
 *   caption  the footage alone, with a small accent slate on one corner        (quiet parts)
 *   poster   one word enormous on a flat field, the footage inside the letters
 *   window   a flat field with one large opening, the footage inside it
 *   slab     one huge accent shape cropping the footage from an edge
 *   grid     the frame cut into cells that fill and empty on the beat
 *   split    two or three panels of the same clip, each a different crop
 *
 * "Auto" picks one per part of the song from its role and energy, and never the same twice running.
 */
import type { TrackSection } from '../../core/types';
import { rank, type MomentId, type Serves } from '../../moments';
import type { StyleFactory } from '../kit';
import { caption } from './caption';
import { card } from './card';
import { grid } from './grid';
import { plain } from './plain';
import { poster } from './poster';
import { slab } from './slab';
import { split } from './split';
import { window } from './window';

export const STYLE_IDS = ['plain', 'caption', 'poster', 'window', 'slab', 'grid', 'split'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const STYLE_NAMES: Record<StyleId, string> = {
  plain: 'Plain',
  caption: 'Caption',
  poster: 'Poster',
  window: 'Window',
  slab: 'Slab',
  grid: 'Grid',
  split: 'Split',
};

export const STYLES: Record<StyleId | 'card', StyleFactory> = { plain, caption, poster, window, slab, grid, split, card };

export const isStyle = (s: string): s is StyleId => (STYLE_IDS as readonly string[]).includes(s);

/** the moments each style serves (src/moments): 3 made for it, 2 good, 1 now and then */
export const STYLE_SERVES: Record<StyleId, Serves> = {
  plain: { ache: 3, hush: 3, held: 3, float: 3, glow: 3, drift: 3, reveal: 3, aftermath: 3, lift: 3, rush: 2, release: 3, fury: 2 },
  caption: { reveal: 2, aftermath: 2, hush: 1 },
  poster: { release: 2, fury: 2 },
  window: { reveal: 1, float: 2, ache: 1, held: 1, drift: 1 },
  slab: { release: 2, rush: 1, lift: 2, drift: 1, glow: 1 },
  grid: { fury: 3, rush: 3, lift: 2 },
  split: { drift: 2, rush: 2, glow: 1 },
};

/** the styles that suit a part, best first */
function suits(sec: TrackSection): StyleId[] {
  const e = sec.energy;
  switch (sec.label) {
    case 'intro':
    case 'outro':
      return e > 0.5 ? ['window', 'caption', 'split'] : ['caption', 'window'];
    case 'verse':
      return e > 0.6 ? ['split', 'slab', 'window'] : ['split', 'window', 'slab', 'caption'];
    case 'build':
      return ['grid', 'slab', 'split'];
    case 'chorus':
    case 'drop':
      return e > 0.55 ? ['poster', 'grid', 'slab'] : ['slab', 'poster', 'window'];
    case 'break':
    case 'bridge':
      return e > 0.5 ? ['window', 'split', 'slab'] : ['window', 'caption', 'split'];
    default:
      return ['slab', 'window'];
  }
}

/**
 * The style for one shot of a section, when every shot is a part of its own (src/shot/run.ts). A fixed
 * choice is used as it is. 'auto' picks from what suits the section, never the style of the footage
 * shot before (`prev`). The pick comes from the section's group and the shot's place in it, so a chorus
 * that comes back opens on the style it had the first time. `moment`: what the part is meant to feel like.
 */
export function styleForShot(sec: TrackSection, k: number, choice: string, seed: number, prev: StyleId | '', moment?: MomentId): StyleId {
  if (isStyle(choice)) return choice;
  // a shot with a moment draws from what serves it (the best two or three); else from what suits the section
  const list = (moment ? rank(STYLE_SERVES, moment, STYLE_IDS).slice(0, 3) : suits(sec)).filter((s) => s !== prev || s === 'plain');
  if (!list.length) return prev === 'caption' ? 'window' : 'caption';
  let h = (Math.floor(seed) * 374761393 + sec.group * 668265263 + k * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  // the best fit comes up twice as often as the others
  const r = ((h ^ (h >>> 16)) >>> 0) % (list.length + 1);
  return list[r === list.length ? 0 : r];
}

/**
 * The style for part `index` of the song. A fixed choice is used as it is; 'auto' picks from what
 * suits the part, moved round by the seed, never repeating the part before. Parts that sound alike
 * (the same group) get the same style, so a chorus comes back looking like itself.
 */
export function styleForPart(sections: TrackSection[], index: number, choice: string, seed: number): StyleId {
  if (isStyle(choice)) return choice;
  const picks: StyleId[] = [];
  const firstOfGroup = new Map<number, StyleId>();
  for (let i = 0; i <= index && i < sections.length; i++) {
    const sec = sections[i];
    const had = firstOfGroup.get(sec.group);
    const prev = picks[i - 1];
    let pick: StyleId;
    if (had && had !== prev) pick = had;
    else {
      const list = suits(sec).filter((s) => s !== prev);
      // the best fit comes up twice as often as the others
      const r = Math.abs(Math.floor(seed) * 7 + i * 3) % (list.length + 1);
      pick = list[r === list.length ? 0 : r] ?? 'caption';
    }
    if (!firstOfGroup.has(sec.group)) firstOfGroup.set(sec.group, pick);
    picks.push(pick);
  }
  return picks[Math.min(index, picks.length - 1)] ?? 'caption';
}
