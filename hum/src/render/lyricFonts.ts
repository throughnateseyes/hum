import type { LyricFont } from '../state/store';

/**
 * The lyric typefaces. All bundled with @fontsource (imported in index.css), so lyrics look the same
 * on every machine and nothing is fetched from a font service at runtime. 'rounded' and 'typewriter'
 * are families Claude's video plan may still ask for; they use the system's own faces.
 */
export const LYRIC_FAMILIES: Record<string, string> = {
  grotesk: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: '"Playfair Display Variable", Didot, "Bodoni 72", Georgia, serif',
  condensed: '"Oswald Variable", "Avenir Next Condensed", "Arial Narrow", Impact, sans-serif',
  mono: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace',
  hand: '"Caveat Variable", "Bradley Hand", "Segoe Print", cursive',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Varela Round", sans-serif',
  typewriter: '"American Typewriter", "Courier New", Courier, serif',
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
  if (!first || !/Variable/.test(first)) return;
  void Promise.all(['400', '700', 'italic 400'].map((w) => document.fonts.load(`${w} 48px ${first}`).catch(() => [])))
    .then(() => {
      version++;
    })
    .catch(() => {});
}
