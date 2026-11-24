/**
 * The emotional moments a part of a video can be, by id, with one line each (no three.js and nothing
 * else from the app in here, so the server's prompts can read the same list). What each one does to
 * the cut, the speed and the camera is in recipes.ts.
 */
export const MOMENT_IDS = ['ache', 'hush', 'held', 'lift', 'rush', 'release', 'float', 'fury', 'glow', 'drift', 'reveal', 'aftermath'] as const;

export type MomentId = (typeof MOMENT_IDS)[number];

export interface MomentInfo {
  id: MomentId;
  name: string;
  /** when to reach for it and what it does, one line (Claude reads this) */
  line: string;
}

export const MOMENTS: MomentInfo[] = [
  { id: 'ache', name: 'Ache', line: 'longing; one long shot, slowing down, a slow push in on the subject' },
  { id: 'hush', name: 'Hush', line: 'near silence; a still, very slow picture held back, almost no cuts' },
  { id: 'held', name: 'Held breath', line: 'the beat before a drop; time slows until it all but stops, pushing in' },
  { id: 'lift', name: 'Lift', line: 'a build opening up; the picture speeds up and pulls back as it goes' },
  { id: 'rush', name: 'Rush', line: 'running; fast short shots that jump on the kick and speed into the cut' },
  { id: 'release', name: 'Release', line: 'the drop or chorus landing; a burst off the hit that opens out wide' },
  { id: 'float', name: 'Float', line: 'weightless; an even slow drift sideways with soft changes' },
  { id: 'fury', name: 'Fury', line: 'the hardest moment; very short shots, hard kicks, jolts, broken picture' },
  { id: 'glow', name: 'Glow', line: 'warm and full; steady picture, gentle push, soft dissolves' },
  { id: 'drift', name: 'Drift', line: 'wandering verse; natural speed, easy sideways travel, plain picture' },
  { id: 'reveal', name: 'Reveal', line: 'first sight of something; starts close on the subject and pulls back to show it' },
  { id: 'aftermath', name: 'Aftermath', line: 'after the peak or the end; the picture runs down to a stop and settles' },
];

export const isMoment = (v: unknown): v is MomentId => typeof v === 'string' && (MOMENT_IDS as readonly string[]).includes(v);
