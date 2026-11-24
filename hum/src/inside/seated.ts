/**
 * Which shots' drawings found a place to stand, and which had no room, as the shots are laid out (on screen,
 * in the check's stills or in a render). The list of drawings says so (src/ui/DrawnHere.tsx).
 */
import { create } from 'zustand';
import type { DrawnPut, DrawnSize } from './drawnIds';

/** `at`: where the part starts, in song seconds */
const keyOf = (at: number, put: DrawnPut, size: DrawnSize) => `${at.toFixed(2)}|${put}|${size}`;

export const useSeated = create<{ seats: Record<string, boolean> }>(() => ({ seats: {} }));

/** a drawing was laid out in a shot whose depth was read: did it find a place? (one shot of the part is enough) */
export function noteSeat(at: number, put: DrawnPut, size: DrawnSize, ok: boolean) {
  const key = keyOf(at, put, size);
  const { seats } = useSeated.getState();
  if (seats[key] === ok || seats[key]) return;
  useSeated.setState({ seats: { ...seats, [key]: ok } });
}

/** a new song, a new video or another shape of frame: what was known is no longer so */
export const forgetSeats = () => useSeated.setState({ seats: {} });

/** undefined: not laid out yet */
export const seatedAt = (seats: Record<string, boolean>, at: number, put: DrawnPut, size: DrawnSize): boolean | undefined => seats[keyOf(at, put, size)];
