/**
 * What a part of the video does with the person's media: two records, one over the other.
 *
 *   plan.shots[i]   what the director chose (Claude, or the offline planner), part of the plan
 *   partShot[i]     what the person chose by hand, kept apart in the store
 *
 * The hand always wins, field by field, and is the only one that counts as a change: the timeline's
 * dot, "Reset this part" and a remake all look at partShot alone. A remake replaces the director's
 * records with its new ones and carries the person's across.
 */
import type { PartShot } from '../core/types';
import type { LyricMedium } from '../state/lyricPlan';
import type { VideoPlan } from '../state/plan';
import { useStudio } from '../state/store';

/** the person's choices laid over the director's */
export function layShot(planned: PartShot | null | undefined, hand: PartShot | null | undefined): PartShot | null {
  if (!planned) return hand ?? null;
  if (!hand) return planned;
  const under: PartShot = { ...planned };
  // the director's framing and start were for its own picture: another picture is shown as it is
  if (hand.media?.length && hand.media[0] !== planned.media?.[0]) {
    delete under.from;
    delete under.focusX;
    delete under.focusY;
    delete under.zoom;
  }
  return { ...under, ...hand };
}

/** what the director chose for part i (null: nothing, or an older plan) */
export function plannedShot(plan: VideoPlan | null | undefined, i: number): PartShot | null {
  return plan?.shots && plan.shots.length === plan.looks.length ? (plan.shots[i] ?? null) : null;
}

/** what part i does, whoever chose it */
export function shotOfPart(i: number, s: { plan: VideoPlan | null; partShot: (PartShot | null)[] | null } = useStudio.getState()): PartShot | null {
  return layShot(plannedShot(s.plan, i), s.partShot?.[i]);
}

/** a choice the director made for a stretch of the song: plan.cues, dealt to the parts when a plan is flattened */
export interface ShotCue {
  /** song seconds */
  at: number;
  end: number;
  shot: PartShot;
  /** what the shot does for the idea of the video, in a few words */
  why?: string;
  /** how the words appear on it */
  lyric?: LyricMedium;
}

/** the cue a part starting at t plays under */
export const cueAt = (cues: ShotCue[], t: number) => cues.find((x) => t >= x.at - 0.06 && t < x.end - 0.06);

/**
 * The director's choices for parts starting at `bounds`, from its cues by time. A part that starts
 * later than its cue (a faster Pace cut the stretch up, or the person split it) carries the cue's
 * picture on rather than starting it again.
 */
export function shotsFromCues(cues: ShotCue[], bounds: number[]): (PartShot | null)[] {
  return bounds.map((b) => {
    const c = cueAt(cues, b);
    if (!c) return null;
    return Math.abs(c.at - b) < 0.06 ? c.shot : withoutStart(c.shot);
  });
}

export function withoutStart(s: PartShot): PartShot {
  const { from: _from, ...rest } = s;
  // its drawing is found standing there, rather than arriving again
  return rest.drawn ? { ...rest, drawn: { ...rest.drawn, enter: 'there' } } : rest;
}
