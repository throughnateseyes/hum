/** What may cover the picture at a moment of the song (shot/graphics.ts holds what there is to cover it with). */
import type { GraphicId } from '../shot/graphics';
import { offIn } from '../shot/graphics';
import { shotOfPart } from '../shot/partShots';
import { useStudio } from './store';

/** may the words bring their own panels and bands at song time t? */
export function panelsAt(t: number): boolean {
  const s = useStudio.getState();
  const secs = s.analysis?.sections;
  let shot = s.planOn ? null : s.soloShot;
  if (s.planOn && secs?.length && s.plan?.looks.length === secs.length) {
    let i = 0;
    for (let k = secs.length - 1; k > 0; k--)
      if (t >= secs[k].start) {
        i = k;
        break;
      }
    shot = shotOfPart(i, s);
  }
  return !offIn(shot, s.graphicsOff).includes('words');
}

/** switch one of them for the whole video */
export function setGraphic(id: GraphicId, on: boolean) {
  const { graphicsOff, set } = useStudio.getState();
  const off = graphicsOff.filter((x) => x !== id);
  set({ graphicsOff: on ? off : [...off, id] });
}
