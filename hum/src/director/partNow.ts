/**
 * What each part of the playing video shows, worked out: what the director and the person chose, and what
 * the run dealt where neither did (src/shot/run.ts). Keep, Redo and the other choices all start from it.
 */
import type { PartShot, Preset, TrackAnalysis } from '../core/types';
import { isMoment, type MomentId } from '../moments';
import { layShot, plannedShot } from '../shot/partShots';
import type { Run } from '../shot/run';
import { findLook, validPlan, type VideoPlan } from '../state/plan';
import { useStudio, type StudioState } from '../state/store';
import { runOfCut } from './footageTiming';

export interface Playing {
  plan: VideoPlan;
  analysis: TrackAnalysis;
  hand: (PartShot | null)[] | null;
}

/** the video with one look per part that this song plays (null without one) */
export function playingVideo(s: StudioState = useStudio.getState()): Playing | null {
  const a = s.analysis;
  if (!a || !s.plan?.flat || !validPlan(s.plan, a)) return null;
  return { plan: s.plan, analysis: a, hand: s.partShot?.length === a.sections.length ? s.partShot : null };
}

export const laidAt = (v: Playing, i: number): PartShot | null => layShot(plannedShot(v.plan, i), v.hand?.[i]);

/** a part as it plays */
export interface PartNow {
  i: number;
  look: Preset | undefined;
  /** it shows the person's clips and photos */
  footage: boolean;
  /** what was chosen for it, with everything the run dealt filled in (an empty record for a part that isn't footage) */
  shot: PartShot;
  moment: MomentId | null;
}

let memo: { plan: VideoPlan; hand: Playing['hand']; media: unknown; photos: unknown; tweaks: unknown; run: { run: Run; deckIds: string[] } | null } | null = null;

function runNow(v: Playing): { run: Run; deckIds: string[] } | null {
  const s = useStudio.getState();
  if (memo && memo.plan === v.plan && memo.hand === v.hand && memo.media === s.clips && memo.photos === s.photos && memo.tweaks === s.tweaks) return memo.run;
  memo = { plan: v.plan, hand: v.hand, media: s.clips, photos: s.photos, tweaks: s.tweaks, run: runOfCut({ plan: v.plan, analysis: v.analysis, shotAt: (i) => laidAt(v, i) }) };
  return memo.run;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function partNow(v: Playing, i: number): PartNow {
  const look = v.plan.looks[i] ? findLook(v.plan.looks[i]!) : undefined;
  const laid = laidAt(v, i);
  const own = laid?.moment ?? v.plan.moments?.[i];
  const r = runNow(v);
  const seq = r?.run.seqs[i];
  const first = seq?.shots[0];
  if (!r || !first) return { i, look, footage: false, shot: laid ?? {}, moment: isMoment(own) ? own : null };
  // (the fragments and tiles of a collage, the second panel of a split: they come after the picture)
  const dealt = [...seq!.shots.map((x) => x.footageIndex), ...seq!.shots.flatMap((x) => [...(x.alt !== undefined ? [x.alt] : []), ...(x.extra ?? [])])];
  const media = laid?.media?.length ? laid.media : [...new Set(dealt)].flatMap((x) => r.deckIds[x] ?? []);
  return {
    i,
    look,
    footage: true,
    moment: isMoment(own) ? own : null,
    shot: {
      ...laid,
      style: first.style,
      treatment: first.treatment ?? 'none',
      motion: first.motion ?? 'play',
      media,
      ...(first.hit ? {} : { from: r3(first.clipFrom ?? 0) }),
    },
  };
}

/**
 * What a kept part is pinned to: everything the run dealt to it written down, and its place, so nothing that
 * changes round it can reach it. What the person chose stays theirs, over it.
 */
export function pinOf(v: Playing, i: number): { shot: PartShot | null; hand: PartShot | null } | null {
  const now = partNow(v, i);
  if (!now.footage) return null;
  const hand = v.hand?.[i] ?? null;
  const planned = plannedShot(v.plan, i);
  const laid = laidAt(v, i) ?? {};
  const shot: PartShot = { ...planned };
  if (!laid.style || laid.style === 'auto') shot.style = now.shot.style;
  if (!laid.treatment || laid.treatment === 'auto') shot.treatment = now.shot.treatment;
  if (!laid.motion) shot.motion = now.shot.motion;
  if (!laid.media?.length) shot.media = now.shot.media;
  let nextHand = hand;
  if (now.shot.from !== undefined && laid.from === undefined) {
    // a start goes with the record its picture came from
    if (hand?.media?.length && hand.media[0] !== planned?.media?.[0]) nextHand = { ...hand, from: now.shot.from };
    else shot.from = now.shot.from;
  }
  if (!shot.pin) {
    // the number of its first shot, counted across the song
    const seqs = runNow(v)!.run.seqs;
    shot.pin = { part: i, shot: seqs.slice(0, i).reduce((n, q) => n + (q?.shots.length ?? 0), 0) };
  }
  return { shot, hand: nextHand };
}
