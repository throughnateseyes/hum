import type { FinishId } from '../../core/direction';
import type { Palette } from '../../core/types';
import type { TypeKitSetting } from '../../state/store';
import type { KInks } from '../knockout';
import type { Role, TypeLayout, Voice } from '../lyricAuto';
import { css, hexRGB, kitMoving, mix, type KitLine } from './common';
import { drawFilm, filmInks, filmVoice } from './film';
import { kitFontsReady, loadKitFonts, type FontKit } from './fonts';
import { drawPrint, printInks, printVoice } from './print';
import { drawTape, tapeBands, tapeVoice } from './tape';

/**
 * Type kits: the lettering belongs to the finish. Each finish has a kit (a display face, a text face,
 * a way the letters are built, a palette rule and small secondary lines) so the words look made by
 * the same process as the picture. The kit decides how each lyric medium is drawn; which medium a
 * part gets, its timing and its layout stay with the lyric layer (lyricLayer.ts).
 *
 *   clean   today's type, on top of the picture: the neutral kit
 *   tape    1984 tape: striped logotype in phosphor bands, LED dot-matrix subtitles, terminal lines (tape.ts)
 *   film    1975 title card: fat '70s lettering on stacked flat shadows, rounded stripes (film.ts)
 *   print   riso poster: words stretched across ink bands, fat rounded stacked outlines (print.ts)
 *   hand    the hand-drawn finish's: the clean type, drawn through the hand-drawn pass as today
 *
 * Under a kit (tape, film, print with a GPU finish on), the stage draws the lyrics BEFORE the finish
 * (stage.ts), so the finish's grain, bleed, misregistration and frame stepping work on the letters
 * too and the words share the picture's wear. Each kit keeps them readable in its own way: the LED
 * plate, the ink band and the paper panel are the words' own backing; the rest keep the legibility
 * guard's backing under them (legibility.ts).
 */

export type KitId = 'clean' | 'tape' | 'film' | 'print' | 'hand';

/** the choices in the Video tab's Words section */
export const KIT_CHOICES: { v: TypeKitSetting; label: string; tip: string }[] = [
  { v: 'auto', label: 'Matches the finish', tip: 'The lettering follows the finish: tape type on Tape, title-card type on Film, poster type on Riso and Ink wash' },
  { v: 'clean', label: 'Clean', tip: 'Crisp modern type over the picture, whatever the finish' },
  { v: 'tape', label: 'Tape', tip: 'A 1984 tape sleeve: wide striped letters in glowing colour bands, LED signs for subtitles' },
  { v: 'film', label: 'Film', tip: 'A 1970s title card: fat lettering with stacked colour shadows and rounded stripes' },
  { v: 'print', label: 'Print', tip: 'A risograph poster: words stretched across ink bands, fat rounded letters' },
];

/** which kit sets the words: the one picked, or the finish's own */
export function kitFor(setting: TypeKitSetting, finish: FinishId): KitId {
  if (setting !== 'auto') return setting;
  if (finish === 'tape' || finish === 'film' || finish === 'hand') return finish;
  if (finish === 'riso' || finish === 'ink') return 'print';
  return 'clean';
}

/** the lettering goes in before the finish (so the finish works on it too), not over it */
export function underFinish(kit: KitId, finish: FinishId): boolean {
  return (kit === 'tape' || kit === 'film' || kit === 'print') && (finish === 'film' || finish === 'riso' || finish === 'ink' || finish === 'tape');
}

export interface TypeKit {
  id: KitId;
  fonts?: FontKit;
  /** the voice for a role, in place of the song family's */
  voice?(role: Role | 'kicker', base: Voice): Voice;
  /** draws a laid-out line (subtitle, big, sparse, giant) */
  draw?(k: KitLine): void;
  /** this medium brings its own plate: the guard's backing isn't drawn under it */
  ownPlate?(role: Role, medium: KitLine['medium']): boolean;
  /** the knockout face (a family key knockout.ts knows) */
  knockFace?: string;
  /** how knockout's solid words are inked */
  knockInks?(base: KInks, light: boolean, pal: Palette): KInks;
  /** still moving at t (so the layer keeps redrawing) */
  moving?(L: TypeLayout, t: number): boolean;
}

const CLEAN: TypeKit = { id: 'clean' };
const HAND: TypeKit = { id: 'hand' };

const TAPE: TypeKit = {
  id: 'tape',
  fonts: 'tape',
  voice: tapeVoice,
  draw: drawTape,
  ownPlate: (role) => role === 'caption',
  knockFace: 'kit-tape',
  knockInks: (base, light, pal) => {
    const col = tapeBands(pal, light)[0];
    return {
      ink: base.ink,
      accent: css(col),
      // a phosphor glow round the letters
      shadow: (g, size) => {
        g.shadowColor = css(col, light ? 0.75 : 0.35);
        g.shadowBlur = size * 0.18;
        g.shadowOffsetX = 0;
        g.shadowOffsetY = 0;
      },
    };
  },
  // the sparse caret blinks: keep drawing while an aside is up (the rest settle once the words land)
  moving: (L, t) => L.role === 'aside' || kitMoving(L, t),
};

const FILM: TypeKit = {
  id: 'film',
  fonts: 'film',
  voice: filmVoice,
  draw: drawFilm,
  knockFace: 'kit-film',
  knockInks: (base, light, pal) => {
    const c = filmInks(pal, light);
    return {
      ink: css(c.main),
      accent: css(c.main),
      // one flat offset shadow in the warm shadow colour, like a printed title
      shadow: (g, size) => {
        g.shadowColor = css(c.sh1);
        g.shadowBlur = 0;
        g.shadowOffsetX = size * 0.05;
        g.shadowOffsetY = size * 0.05;
      },
    };
  },
  moving: (L, t) => kitMoving(L, t, 0.4),
};

const PRINT: TypeKit = {
  id: 'print',
  fonts: 'print',
  voice: printVoice,
  draw: drawPrint,
  ownPlate: (role, medium) => role === 'caption' || (role === 'display' && medium === 'big'),
  knockFace: 'kit-print',
  knockInks: (base, light, pal) => {
    const inks = printInks(pal);
    return {
      ink: base.ink,
      accent: base.accent,
      shadow: (g, size) => {
        g.shadowColor = css(light ? inks[0] : mix(inks[0], hexRGB('#ffffff'), 0.2));
        g.shadowBlur = 0;
        g.shadowOffsetX = size * 0.06;
        g.shadowOffsetY = size * 0.06;
      },
    };
  },
  moving: (L, t) => L.role === 'giant' || kitMoving(L, t),
};

const KITS: Record<KitId, TypeKit> = { clean: CLEAN, tape: TAPE, film: FILM, print: PRINT, hand: HAND };

/**
 * The kit to set a line in. A kit whose faces are still loading sets nothing yet (the clean kit
 * stands in); asking starts the load, and the layer lays the line out again when they arrive.
 */
export function typeKit(id: KitId): TypeKit {
  const k = KITS[id];
  if (!k.fonts) return k;
  if (kitFontsReady(k.fonts)) return k;
  void loadKitFonts(k.fonts);
  return CLEAN;
}

/** start loading a kit's faces ahead of time (when it's picked) */
export function warmKit(id: KitId) {
  const f = KITS[id].fonts;
  if (f) void loadKitFonts(f);
}

export { kitFontVersion } from './fonts';
export { songFacts, type KitLine } from './common';
