/**
 * Control over what the director does, part by part, on the video that plays:
 *
 *   Keep     setKept, useKept                         a remake, an edit from the chat and the checks leave the part alone
 *   Redo     redoParts, useRedo, cancelRedo           another choice for a few parts, with a wish in plain words (redo.ts)
 *   Choices  choicesFor, previewChoice, applyChoice   other choices, ready at once (choices.ts)
 *
 * Parts are numbers in the playing video's parts, as everywhere (store.selectedParts, partEdit.ts).
 */
import { useMemo } from 'react';
import { keepParts } from '../state/partEdit';
import { listNames, partNames } from '../state/plan';
import { useStudio } from '../state/store';
import { choicesFor, type Choice } from './choices';
import { pinOf, playingVideo } from './partNow';

export { applyChoice, choicesFor, endPreview, previewChoice, type Choice } from './choices';
export { cancelRedo, MOST_REDO, redoParts, useRedo, type RedoResult } from './redo';

export interface Kept {
  /** all of them are kept */
  on: boolean;
  /** some are */
  some: boolean;
  /** there is a video whose parts can be kept */
  can: boolean;
}

/** whether these parts are kept, kept up to date */
export function useKept(parts: number[]): Kept {
  const plan = useStudio((s) => s.plan);
  const a = useStudio((s) => s.analysis);
  const n = a?.sections.length ?? 0;
  const here = parts.filter((i) => i >= 0 && i < n);
  const can = !!plan?.flat && plan.looks.length === n && here.length > 0;
  const kept = can ? here.filter((i) => plan.kept?.[i]).length : 0;
  return { on: kept > 0 && kept === here.length, some: kept > 0, can };
}

/** every kept part of the playing video */
export const keptParts = (): number[] => {
  const v = playingVideo();
  return v ? v.analysis.sections.flatMap((_, i) => (v.plan.kept?.[i] ? [i] : [])) : [];
};

/** keep these parts exactly as they are, or let them go again: one undo step */
export function setKept(parts: number[], on: boolean): boolean {
  const s = useStudio.getState();
  const v = playingVideo(s);
  if (!v || s.clip) return false;
  const done = keepParts(parts, on, (i) => pinOf(v, i));
  if (done) {
    const names = partNames(v.analysis);
    const what = parts.length > 3 ? `${parts.length} parts` : listNames([...parts].sort((x, y) => x - y).map((i) => names[i]));
    s.flash(on ? `${what} ${parts.length > 1 ? 'are' : 'is'} kept as ${parts.length > 1 ? 'they are' : 'it is'}` : `${what} can change again`);
  }
  return done;
}

/** the other choices for a part, kept up to date as the video, the media and the part change */
export function useChoices(part: number): Choice[] {
  const plan = useStudio((s) => s.plan);
  const a = useStudio((s) => s.analysis);
  const hand = useStudio((s) => s.partShot);
  const clips = useStudio((s) => s.clips);
  const photos = useStudio((s) => s.photos);
  const tweaks = useStudio((s) => s.tweaks);
  const lyrics = useStudio((s) => s.lyrics);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => choicesFor(part), [part, plan, a, hand, clips, photos, tweaks, lyrics]);
}
