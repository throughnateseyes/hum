import { activeFinish, setFinish } from '../state/direction';
import { useStudio } from '../state/store';

/**
 * The H key: Hand-drawn is one of the finishes, so on picks it and off picks Clean (the Finish
 * picker in the Video tab can go back to Auto).
 */
export function toggleHand() {
  const on = activeFinish(useStudio.getState()) === 'hand';
  setFinish(on ? 'clean' : 'hand');
  useStudio.getState().flash(on ? 'Hand-drawn off (Finish: Clean)' : 'Hand-drawn on. Fine-tune it in the Video tab');
}
