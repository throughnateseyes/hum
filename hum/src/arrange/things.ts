/**
 * What is on the picture right now, for the Arrange view (src/ui/arrange): while it is open, every layer
 * says what it drew and where, each frame. And the drag in progress: a thing being moved or resized is
 * drawn where the hand has it, and only written down when it is let go.
 */
import type { Spot } from './types';

export interface Box {
  /** 0..1 from the frame's top-left */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ThingKind = 'pop' | 'window' | 'standing' | 'placed' | 'beside';
export interface Thing {
  /** one thing keeps its key from frame to frame, and when a dealt one is first moved */
  key: string;
  kind: ThingKind;
  name: string;
  box: Box;
  /** where it sits by its own settings (the box may be moving: a push in, a bump, stepping aside for the words) */
  spot: Spot;
  from: number;
  to: number;
  /** put there by hand */
  hand: boolean;
  /** its width over its height, on screen */
  ratio: number;
  /** pop-ups: their id in the part's list; drawings: the drawing's id */
  ref: string;
  /** standing drawings: the start of the part they stand in, and how much the picture is pushed in over them */
  part?: number;
  push?: number;
}

interface Trial {
  key: string;
  spot: Spot;
}

let on = false;
let things: Thing[] = [];
let words: Box[] = [];
let trial: Trial | null = null;

/** the layers only keep count while someone is arranging */
export const arranging = () => on;
export function setArranging(v: boolean) {
  on = v;
  if (!v) {
    things = [];
    words = [];
    trial = null;
  }
}

/** a new picture is about to be drawn */
export function beginThings() {
  if (!on) return;
  things = [];
  words = [];
}
export function noteThing(t: Thing) {
  if (!on) return;
  // (a place drawn twice in one picture, as while two shots cross, has its things once)
  const k = things.findIndex((x) => x.key === t.key);
  if (k >= 0) things.splice(k, 1);
  things.push(t);
}
export function noteWords(b: Box) {
  if (on && b.x1 > b.x0) words.push(b);
}
/** what the last picture had on it, the topmost last */
export const thingsNow = (): readonly Thing[] => things;
export const wordsNow = (): readonly Box[] => words;

/** the thing in the hand, where the hand has it (null: none is) */
export function tryOut(t: Trial | null) {
  trial = t;
}
export const trialOf = (key: string): Spot | null => (trial && trial.key === key ? trial.spot : null);
export const trialNow = () => trial;

export const standingKey = (partStart: number) => `standing:${partStart.toFixed(2)}`;
