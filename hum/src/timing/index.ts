/**
 * Timing: what happens inside the person's clips, and landing it on the song.
 *
 *   read.ts     a clip → how it moves and the moments in it (kept in this browser, read once)
 *   events.ts   the measuring itself, pure
 */
export * from './types';
export { motionOf, readMotion, readMotions } from './read';
export { eventsOf, timeParts, type AccentKind, type TimedPart, type TimingInput, type Wanted } from './solve';
