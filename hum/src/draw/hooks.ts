import { useAccessGate } from '../director/access';
import { useStudio } from '../state/store';
import { allDrawings, drawingsHere } from './session';
import type { DrawingAsset } from './types';

/** may this person use drawings? Nothing about them is shown without it. */
export const useCanDraw = () => useAccessGate((g) => g.canDraw);

/** this song's drawings (empty where drawings aren't allowed) */
export function useDrawingsHere(): DrawingAsset[] {
  useCanDraw();
  return useStudio((s) => drawingsHere(s));
}

/** every drawing in this browser (empty where drawings aren't allowed) */
export function useAllDrawings(): DrawingAsset[] {
  useCanDraw();
  return useStudio((s) => allDrawings(s));
}
