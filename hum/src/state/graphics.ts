/** What may cover the picture at a moment of the song (shot/graphics.ts holds what there is to cover it with). */
import type { GraphicId } from '../shot/graphics';
import { offIn } from '../shot/graphics';
import { shotRecordAt } from './inks';
import { useStudio } from './store';

/** may the words bring their own panels and bands at song time t? */
export function panelsAt(t: number): boolean {
  const shot = shotRecordAt(t);
  return !offIn(shot, useStudio.getState().graphicsOff).includes('words');
}

/** switch one of them for the whole video */
export function setGraphic(id: GraphicId, on: boolean) {
  const { graphicsOff, set } = useStudio.getState();
  const off = graphicsOff.filter((x) => x !== id);
  set({ graphicsOff: on ? off : [...off, id] });
}
