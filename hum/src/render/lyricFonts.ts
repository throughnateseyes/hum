import type { LyricFont } from '../state/store';

/**
 * The lyric typefaces. All bundled with @fontsource (imported in index.css), so lyrics look the same
 * on every machine and nothing is fetched from a font service at runtime.
 *
 * FACES are the single faces lyric type is set in (lyricAuto.ts picks them per role);
 * LYRIC_FAMILIES are the song-level families (what Claude's plan and the font picker name), each a
 * stack led by the face that family is mostly set in. 'rounded' is a family older plans may still ask
 * for (set as grotesk); 'typewriter' is IBM Plex Mono.
 */
export const FACES = {
  /** display serif with a true italic: emotional lines, the giant word */
  instrument: '"Instrument Serif", "Fraunces Variable", "Playfair Display Variable", Georgia, serif',
  /** variable serif with optical sizes: serif captions, heavier serif lines */
  fraunces: '"Fraunces Variable", "Playfair Display Variable", Georgia, serif',
  /** tight grotesk: headlines and subtitles */
  tight: '"Inter Tight Variable", "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  /** variable width grotesk: condensed lines (set with fontStretch), widening on held notes */
  archivo: '"Archivo Variable", "Oswald Variable", "Avenir Next Condensed", "Arial Narrow", sans-serif',
  /** kept for the picker's old looks and as fallbacks */
  inter: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  playfair: '"Playfair Display Variable", Didot, "Bodoni 72", Georgia, serif',
  oswald: '"Oswald Variable", "Avenir Next Condensed", "Arial Narrow", Impact, sans-serif',
  mono: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace',
  plex: '"IBM Plex Mono", "SF Mono", Menlo, "Courier New", monospace',
  hand: '"Caveat Variable", "Bradley Hand", "Segoe Print", cursive',
} as const;

export const LYRIC_FAMILIES: Record<string, string> = {
  grotesk: FACES.tight,
  serif: FACES.instrument,
  condensed: FACES.archivo,
  mono: FACES.mono,
  hand: FACES.hand,
  rounded: FACES.tight,
  typewriter: FACES.plex,
};

/** names in the font picker */
export const LYRIC_FONT_NAME: Record<LyricFont, string> = {
  auto: 'Auto',
  grotesk: 'Clean',
  serif: 'Serif',
  condensed: 'Condensed',
  mono: 'Mono',
  hand: 'Handwritten',
};

/** the CSS font stack a picker option is previewed in */
export function previewFamily(f: LyricFont): string {
  return f === 'auto' ? LYRIC_FAMILIES.grotesk : LYRIC_FAMILIES[f];
}

/** bumps whenever a lyric font finishes loading, so cached canvas layouts are redone in it */
let version = 0;
const asked = new Set<string>();
export const lyricFontVersion = () => version;

/**
 * Canvas text doesn't trigger web-font loading the way DOM text does: ask for the faces up front.
 * Cheap to call every frame (each family is only asked for once).
 */
export function ensureLyricFont(family: string | undefined) {
  if (!family || asked.has(family) || typeof document === 'undefined' || !document.fonts) return;
  asked.add(family);
  const first = /^\s*("[^"]+"|[^,]+)/.exec(family)?.[1];
  if (!first || !/Variable|IBM Plex Mono|Instrument Serif/.test(first)) return;
  const faces = /IBM Plex Mono/.test(first) ? ['400', '500'] : /Instrument Serif/.test(first) ? ['400', 'italic 400'] : ['300', '400', '700', 'italic 400'];
  void Promise.all(faces.map((w) => document.fonts.load(`${w} 48px ${first}`).catch(() => [])))
    .then(() => {
      version++;
    })
    .catch(() => {});
}
