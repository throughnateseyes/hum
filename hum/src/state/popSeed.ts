/**
 * Which pop-ups a part gets is dealt from a seed, so a part shows the same pop-ups every time it
 * plays until someone asks for a different deal. A stub for now: the pop-up engineer fills it in.
 */

/** the seed for part `index` of the song that is loaded (the same number until it is reshuffled) */
export function popSeedFor(index: number): number {
  return index + 1;
}

/** deal these parts a different set of pop-ups (the Part panel's "Shuffle pop-ups") */
export function reshufflePops(parts: number[]): void {
  void parts;
}
