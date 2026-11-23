/**
 * Skip (X) and Like (K) for the shot that's playing, from the keyboard, the Perform controls and the
 * stage: with a video plan playing one look per part (state/flatPlan.ts) they change only that part,
 * and say so with a short note on the picture (the look toast). Without a plan they fall back to the
 * taste buttons' old behaviour (Taste.tsx): Keep remembers the look, Skip moves on to another.
 *
 * Quick picks (1–5): the Part panel registers the five looks it shows for the picked part, and the
 * number keys put one of them in.
 */
import type { Preset } from '../core/types';
import { likePlayingPart, skipPlayingPart } from '../state/flatPlan';
import { setPartsLook } from '../state/partEdit';
import { toastLook } from './layout';
import { keepNow, skipNow } from './Taste';

export function skipShot() {
  const r = skipPlayingPart();
  if (r) toastLook(`Skipped: now ${r.to.name}`, '', 1);
  else skipNow();
}

export function likeShot() {
  const r = likePlayingPart();
  if (r) toastLook(r.liked ? 'Liked' : 'Like taken back', r.look.name, 1);
  else keepNow();
}

/** the quick picks the Part panel is showing now (none when it isn't showing them) */
let quick: { parts: number[]; looks: Preset[] } | null = null;
export function setQuickPicks(q: { parts: number[]; looks: Preset[] } | null) {
  quick = q;
}

/** put quick pick n (1–5) into the picked part; false when there's none to put */
export function applyQuickPick(n: number): boolean {
  const p = quick?.looks[n - 1];
  if (!quick || !p) return false;
  setPartsLook(quick.parts, p.id);
  return true;
}
