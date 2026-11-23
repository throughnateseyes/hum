/**
 * The kits' typefaces, loaded only when a kit is first used (not in the app's first load): the CSS
 * comes in with a dynamic import (Vite splits it, and its font files, out of the main bundle), then
 * document.fonts.load fetches the faces, because canvas text never asks for a web font by itself.
 * Until a kit's faces are in, its lines are set by the clean kit; the version below bumps when they
 * arrive, and the lyric layer lays the line out again in them.
 *
 * Every face is SIL Open Font Licence 1.1, from @fontsource:
 *   Krona One       wide heavy grotesk: the tape logotype            (latin, ~12 KB)
 *   VT323           a DEC VT320 terminal face: tape's "> …" lines and the LED dot matrix (~20 KB)
 *   Shrikhand       fat '70s italic display: film's title lettering  (~16 KB)
 *   Bagel Fat One   fat rounded letters: print's display face        (~24 KB)
 *   Fredoka         rounded grotesk, variable weight: print's text face (~32 KB)
 * Film's text face is Fraunces, already bundled for the clean lyrics.
 */

export const KIT_FACES = {
  tapeWide: '"Krona One", "Archivo Variable", "Arial Black", sans-serif',
  tapeTerm: 'VT323, "IBM Plex Mono", ui-monospace, monospace',
  filmDisplay: 'Shrikhand, "Fraunces Variable", Georgia, serif',
  filmText: '"Fraunces Variable", "Playfair Display Variable", Georgia, serif',
  printDisplay: '"Bagel Fat One", "Fredoka Variable", "Arial Rounded MT Bold", sans-serif',
  printText: '"Fredoka Variable", "Arial Rounded MT Bold", sans-serif',
} as const;

export type FontKit = 'tape' | 'film' | 'print';

const LOAD: Record<FontKit, () => Promise<unknown>> = {
  tape: () => Promise.all([import('@fontsource/krona-one/latin-400.css'), import('@fontsource/vt323/latin-400.css')]),
  film: () => import('@fontsource/shrikhand/latin-400.css'),
  print: () => Promise.all([import('@fontsource/bagel-fat-one/latin-400.css'), import('@fontsource-variable/fredoka/wght.css')]),
};
const FACES: Record<FontKit, string[]> = {
  tape: ['400 48px "Krona One"', '400 48px VT323'],
  film: ['400 48px Shrikhand', '600 48px "Fraunces Variable"', 'italic 500 48px "Fraunces Variable"'],
  print: ['400 48px "Bagel Fat One"', '500 48px "Fredoka Variable"', '650 48px "Fredoka Variable"'],
};

const state: Record<FontKit, 'idle' | 'loading' | 'ready'> = { tape: 'idle', film: 'idle', print: 'idle' };
let version = 0;
/** bumps whenever a kit's faces finish loading */
export const kitFontVersion = () => version;
export const kitFontsReady = (k: FontKit) => state[k] === 'ready';

/** start loading a kit's faces (once); cheap to call every frame */
export function loadKitFonts(k: FontKit): Promise<void> {
  if (state[k] !== 'idle' || typeof document === 'undefined') return Promise.resolve();
  state[k] = 'loading';
  const done = () => {
    state[k] = 'ready';
    version++;
  };
  return LOAD[k]()
    .then(() => Promise.all(FACES[k].map((f) => (document.fonts ? document.fonts.load(f).catch(() => []) : []))))
    .then(done, done);
}
