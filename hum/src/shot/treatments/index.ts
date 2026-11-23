/**
 * Treatments: how the picture itself is broken down, under a footage style's shapes and type.
 *
 *   none     the picture as the style prints it
 *   mosh     it melts in soft blocks dragged along a motion field, with a few hard square artefacts;
 *            a cut lands pushed by the motion before it (mosh.ts)
 *   sort     runs of it, chosen by brightness, sorted into streaks in stepped diagonal bands (sort.ts)
 *   cells    rebuilt on a character grid: blocks, digits and punctuation in four or five flat colours
 *            on a dark field (cells.ts)
 *   readout  the subject in coarse pixels of one colour on grey, with numbered boxes locked onto it
 *            and captions in mono type (readout.ts)
 *   collage  one big picture with cut-out fragments of the part's other pictures over it (collage.ts)
 *
 * Every one is drawn from song time alone (Mosh keeps a field of where each block has been dragged,
 * re-worked from a fixed point whenever the time jumps, so it too is a function of song time).
 */
import type { TrackSection } from '../../core/types';

export const TREATMENT_IDS = ['none', 'mosh', 'sort', 'cells', 'readout', 'collage'] as const;
export type TreatmentId = (typeof TREATMENT_IDS)[number];

export const TREATMENT_NAMES: Record<TreatmentId, string> = {
  none: 'None',
  mosh: 'Mosh',
  sort: 'Sort',
  cells: 'Cells',
  readout: 'Readout',
  collage: 'Collage',
};

export const isTreatment = (s: string | undefined): s is TreatmentId => !!s && (TREATMENT_IDS as readonly string[]).includes(s);

/** the treatments that suit a part, best first (Auto) */
function suits(sec: TrackSection, pictures: number): TreatmentId[] {
  const e = sec.energy;
  const collage: TreatmentId[] = pictures >= 3 ? ['collage'] : [];
  switch (sec.label) {
    case 'chorus':
    case 'drop':
      return e > 0.6 ? ['mosh', 'sort', ...collage] : ['sort', 'mosh', 'none'];
    case 'build':
      return ['cells', 'sort', 'readout'];
    case 'break':
    case 'bridge':
      return ['readout', 'cells', ...collage];
    case 'verse':
      return e > 0.55 ? ['sort', 'none', 'cells'] : ['none', 'readout', 'none'];
    case 'intro':
    case 'outro':
      return ['none', 'readout'];
    default:
      return ['none'];
  }
}

/**
 * The treatment for one shot. A fixed choice is used as it is (Collage needs a second picture; with
 * only one it is still drawn, from crops of the one). 'auto' picks from what suits the section, from
 * its group and the shot's place in it, never the treatment of the footage shot before unless it is
 * None.
 */
export function treatmentForShot(sec: TrackSection, k: number, choice: string, seed: number, prev: TreatmentId | '', pictures: number): TreatmentId {
  if (isTreatment(choice)) return choice;
  if (choice !== 'auto') return 'none';
  const list = suits(sec, pictures).filter((s) => s === 'none' || s !== prev);
  if (!list.length) return 'none';
  let h = (Math.floor(seed) * 2654435761 + sec.group * 40503 + k * 97) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  // the best fit comes up twice as often as the others
  const r = ((h ^ (h >>> 13)) >>> 0) % (list.length + 1);
  return list[r === list.length ? 0 : r];
}
