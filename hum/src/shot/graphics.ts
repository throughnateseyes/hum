/**
 * What the person lets cover their picture: the footage styles' graphics, the treatments that rebuild the
 * picture, and the panels and bands behind the words. All of it is on until it is switched off, for the whole
 * project (store.graphicsOff) or for one shot (PartShot.graphics: 'off' clears it all there, 'on' allows it all).
 *
 * A shot whose style is off plays plain, and one whose treatment is off plays untreated, from the same stretch
 * of the same clip: the cut, the speeds and the words don't move, so switching one back on brings back exactly
 * what was there. Imports nothing that runs: the store keeps the list.
 */
import type { PartShot } from '../core/types';
import type { Sequence } from './sequence';
import type { StyleId } from './styles';
import type { TreatmentId } from './treatments';

type GraphicStyle = Exclude<StyleId, 'inside' | 'plain'>;
type GraphicTreatment = Exclude<TreatmentId, 'none'>;
export type GraphicId = GraphicStyle | `t-${GraphicTreatment}` | 'words';

const STYLE: [GraphicStyle, string, string][] = [
  ['slab', 'Slab', 'A flat band along one edge, sliding over on each bar'],
  ['window', 'Window', 'A flat field with your clip in an opening'],
  ['poster', 'Poster', 'One huge word with your clip inside its letters'],
  ['grid', 'Grid', 'The picture cut into cells on the beat'],
  ['split', 'Split', 'Two panels side by side or stacked'],
  ['caption', 'Caption', 'A small slate in one corner'],
];
const TREAT: [GraphicTreatment, string, string][] = [
  ['mosh', 'Mosh', 'The picture melts in blocks'],
  ['sort', 'Sort', 'Rows smear into long streaks'],
  ['cells', 'Cells', 'Rebuilt from little characters'],
  ['readout', 'Readout', 'Coarse pixels with boxes and captions'],
  ['collage', 'Collage', 'Cut-out pieces of other clips on top'],
  ['trace', 'Trace', 'Clips pinned up with lines between them'],
];

export const GRAPHICS: { group: string; items: { id: GraphicId; label: string; tip: string }[] }[] = [
  { group: 'Shapes over the picture', items: STYLE.map(([id, label, tip]) => ({ id, label, tip })) },
  { group: 'Effects on the picture', items: TREAT.map(([id, label, tip]) => ({ id: `t-${id}` as const, label, tip })) },
  { group: 'Behind the words', items: [{ id: 'words', label: 'Panels and bands', tip: 'The coloured bars and boxes lyrics sit on (Print and Tape lettering)' }] },
];
export const GRAPHIC_IDS: GraphicId[] = GRAPHICS.flatMap((g) => g.items.map((x) => x.id));
const known = new Set<string>(GRAPHIC_IDS);

export const cleanGraphics = (v: unknown): GraphicId[] | undefined => (Array.isArray(v) ? GRAPHIC_IDS.filter((id) => v.includes(id)) : undefined);

/** what is off in a shot with this record */
export function offIn(shot: PartShot | null | undefined, off: readonly GraphicId[]): readonly GraphicId[] {
  return shot?.graphics === 'off' ? GRAPHIC_IDS : shot?.graphics === 'on' ? [] : off;
}

/** a shot's style and treatment are offered (or chosen) only while they are on */
export const styleOn = (id: string, off: readonly GraphicId[]) => !known.has(id) || !off.includes(id as GraphicId);
export const treatmentOn = (id: string, off: readonly GraphicId[]) => !known.has(`t-${id}`) || !off.includes(`t-${id}` as GraphicId);

/** the shots as they are drawn with these off (the same list when nothing in it is) */
export function drawnWith(seq: Sequence, off: readonly GraphicId[]): Sequence {
  if (!off.length) return seq;
  const changes = seq.shots.some((s) => !styleOn(s.style, off) || !treatmentOn(s.treatment ?? 'none', off));
  if (!changes) return seq;
  return {
    ...seq,
    shots: seq.shots.map((s) => ({
      ...s,
      ...(styleOn(s.style, off) ? {} : { style: 'plain' as const }),
      ...(treatmentOn(s.treatment ?? 'none', off) ? {} : { treatment: 'none' as const }),
    })),
  };
}
