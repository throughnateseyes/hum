import type { ParamValues } from '../core/types';
import type { Stage } from '../render/stage';

/** Per-frame values the UI reads without React re-renders. */
export const live = {
  scene: {} as ParamValues,
  fx: new Map<string, ParamValues>(),
  stage: null as Stage | null,
};

const subs = new Set<() => void>();
let running = false;
function loop() {
  subs.forEach((f) => f());
  if (subs.size) requestAnimationFrame(loop);
  else running = false;
}
/** Subscribe to a shared animation-frame tick. Returns an unsubscribe fn. */
export function onFrame(cb: () => void) {
  subs.add(cb);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => {
    subs.delete(cb);
  };
}
