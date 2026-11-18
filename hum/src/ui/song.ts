/** small helpers shared by the bottom bar's timeline and the breakdown view */
import type { Preset, TrackAnalysis } from '../core/types';
import { STATIC_THUMBS } from './Library';

export const fmtTime = (t: number) => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

/* sections that sound alike share a colour */
export const GROUP_TINT = ['#dfe5ff', '#ffe2cc', '#d8efe1', '#ecdff5', '#f4ecc6', '#e4e2dc', '#d4ecf4', '#f5d9d9'];
export const GROUP_INK = ['#2f4bff', '#e2620b', '#2b8a55', '#8f47c4', '#9a7f00', '#77756e', '#1b86a8', '#c94040'];

/** each drop with its strength (0..1): the analysis' own numbers when it has them, else every drop is full size */
export function dropList(a: TrackAnalysis): { t: number; strength: number; why: string }[] {
  if (a.dropInfo?.length) return a.dropInfo;
  return a.drops.map((t) => ({ t, strength: 1, why: '' }));
}

/** a look's picture: its thumbnail, else a gradient of its palette */
export function lookBg(p: Preset): { backgroundImage: string } {
  const url = STATIC_THUMBS[p.id];
  if (url) return { backgroundImage: `url(${url})` };
  const { bg, accent, accent2 } = p.palette;
  return { backgroundImage: `linear-gradient(135deg, ${bg} 0%, ${accent} 60%, ${accent2} 100%)` };
}
