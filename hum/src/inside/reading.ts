/**
 * What the stage needs of a picture's depth reading (src/depth does the reading; src/inside/readings.ts
 * keeps one per clip and photo), and the note that tells the lyric overlay the words are already in the
 * picture this frame.
 */
import type { ClipScene } from '../depth/types';

export interface Reading {
  /** what is known so far; null before the first look at it is done */
  readonly scene: ClipScene | null;
  /** read these seconds of the clip (and settle once they are in, or cannot be had) */
  need(ranges: [number, number][]): Promise<void>;
}

/** are the maps for these seconds of the clip all in? */
export function hasRange(s: ClipScene | null, from: number, to: number): boolean {
  if (!s || !s.times.length) return false;
  const pad = s.step * 0.6;
  let any = false;
  for (let i = 0; i < s.times.length; i++) {
    if (s.times[i] < from - pad || s.times[i] > to + pad) continue;
    any = true;
    if (!s.maps[i]) return false;
  }
  return any || s.times.length === 1 ? s.maps.some(Boolean) : false;
}

let noted = false;
/** an inside shot drew the sung words itself this frame */
export const noteInside = () => {
  noted = true;
};
/** asked once a frame by the lyric layer, after the picture is drawn */
export function takeInside(): boolean {
  const was = noted;
  noted = false;
  return was;
}
