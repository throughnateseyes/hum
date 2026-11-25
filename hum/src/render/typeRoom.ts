/**
 * Where the picture's own type is, and where the lyrics are, for each to keep clear of the other.
 *
 * A footage look draws type of its own into the picture (a style's title and slates, a treatment's
 * labels, the words standing in an Inside shot). Each frame it notes their boxes here; the lyric layer
 * takes them as places to stay off, like pop-up windows. And the lyric layer's own boxes are left here
 * for the next frame, so type that a line is coming to stand on can leave (the lyric wins).
 *
 * Kept per renderer: a render's stage and the one on screen don't hear each other.
 */
import type * as THREE from 'three';
import { coveredShare, NO_KEEP_OUT, type KeepOut, type Rect } from './legibility';

interface Room {
  type: Rect[];
  keep: KeepOut;
  cuts: number;
  finish: boolean;
}
const rooms = new WeakMap<THREE.WebGLRenderer, Room>();
function roomOf(r: THREE.WebGLRenderer): Room {
  let room = rooms.get(r);
  if (!room) rooms.set(r, (room = { type: [], keep: NO_KEEP_OUT, cuts: 0, finish: false }));
  return room;
}

/** the picture's type this frame (normalized boxes, y from the top) */
export function noteType(r: THREE.WebGLRenderer, boxes: readonly Rect[]) {
  roomOf(r).type.push(...boxes);
}
export const typeBoxes = (r: THREE.WebGLRenderer): readonly Rect[] => roomOf(r).type;
/** a new frame: nothing noted yet */
export const clearType = (r: THREE.WebGLRenderer) => {
  roomOf(r).type.length = 0;
};

/** where the lyrics are this frame, and where the next line is likely to land */
export const setLyricRoom = (r: THREE.WebGLRenderer, keep: KeepOut) => {
  roomOf(r).keep = keep;
};
/** do the lyrics (or the line due next) stand on box `b`? */
export function lyricsOn(r: THREE.WebGLRenderer, b: Rect, soon = true): boolean {
  const { now, next } = roomOf(r).keep;
  return (!!now && coveredShare(b, [now]) > 0.02) || (soon && !!next && coveredShare(b, [next]) > 0.02);
}

/** is a finish going to be worked over the picture? (small type is set sturdier for it) */
export const setFinished = (r: THREE.WebGLRenderer, on: boolean) => {
  roomOf(r).finish = on;
};
export const finished = (r: THREE.WebGLRenderer) => roomOf(r).finish;

/** the picture was cut this frame without the look changing (one footage shot to the next) */
export const noteCut = (r: THREE.WebGLRenderer) => {
  roomOf(r).cuts++;
};
export const cutsSeen = (r: THREE.WebGLRenderer) => roomOf(r).cuts;
