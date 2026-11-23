import type { Backing } from './legibility';

/**
 * How each look wants lyrics treated, filled from the legibility audit (docs/LYRICS-AUDIT.md).
 *
 *   suits   how well each overlay medium sits on the look, 0 (never) … 1 (made for it)
 *   zones   where the picture is calm enough for text, best first
 *   own     'carries': the look shows the sung line itself (typewriter, lyric wall, word cards), so
 *           overlay text stands down there; 'echoes': it has lyric bits (up next, a crawl, word scores)
 *           that the overlay shouldn't sit on top of; 'none'
 *   ink     'look' keeps the look's own text colour when it reads; 'light' / 'dark' force a neutral
 *   plate   the backing family that suits the look when the picture needs help (the guard picks
 *           how much): 'shadow' (halo only), 'soft' (feathered plate), 'band' (solid strip),
 *           'paper' (torn paper strip, for print and board looks)
 */
export type Medium = 'subtitle' | 'big' | 'cutout' | 'sparse' | 'knockout';
export type Zone = 'top' | 'middle' | 'bottom' | 'left' | 'right';
export type Own = 'none' | 'carries' | 'echoes';

export interface LyricProfile {
  suits: Record<Medium, number>;
  zones: Zone[];
  own: Own;
  ink: 'look' | 'light' | 'dark';
  plate: Exclude<Backing, 'none'>;
}

/**
 * Knockout (one huge word at a time, knockout.ts) brings its own answer to a busy picture (the words
 * are cut out of a flat field), so it suits nearly every look: at least moderately, more where big
 * type already sits well. Looks that show the words themselves stand it down like any overlay.
 */
const P = (subtitle: number, big: number, cutout: number, sparse: number, zones: Zone[], own: Own, ink: LyricProfile['ink'], plate: LyricProfile['plate']): LyricProfile => ({
  suits: { subtitle, big, cutout, sparse, knockout: own === 'carries' ? 0.2 : Math.max(0.55, big) },
  zones,
  own,
  ink,
  plate,
});

/**
 * Per built-in look (preset id), from the audit: subtitle, big, cutout, sparse fit; calm zones; own lyrics; ink; plate.
 * Zones follow where the sampled picture was calmest (lowest backing needed, lowest busyness).
 */
export const LOOK_PROFILES: Record<string, LyricProfile> = {
  // boards: cream paper with dense modules (the bottom rows are the busiest), or dark instrument panels
  'orbit-board': P(0.7, 0.2, 0.4, 0.5, ['bottom', 'right', 'top'], 'carries', 'dark', 'paper'),
  'lab-notes': P(0.8, 0.5, 0.6, 0.7, ['top', 'middle', 'left'], 'none', 'dark', 'paper'),
  'oto-sketch': P(0.8, 0.4, 0.6, 0.7, ['top', 'middle', 'right'], 'none', 'dark', 'paper'),
  'arcade-board': P(0.8, 0.45, 0.6, 0.7, ['top', 'left', 'right'], 'echoes', 'dark', 'paper'),
  'arcade-night': P(0.8, 0.45, 0.6, 0.7, ['top', 'left'], 'none', 'light', 'soft'),
  'mission-control': P(0.8, 0.5, 0.6, 0.7, ['top', 'left', 'middle'], 'none', 'light', 'soft'),
  'dear-diary': P(0.7, 0.2, 0.4, 0.5, ['bottom', 'left', 'top'], 'carries', 'dark', 'paper'),
  'diary-ink': P(0.7, 0.2, 0.4, 0.5, ['bottom', 'left', 'top'], 'carries', 'dark', 'paper'),
  'song-forecast': P(0.8, 0.55, 0.6, 0.7, ['top', 'bottom', 'middle'], 'echoes', 'dark', 'paper'),
  // loud fields: strobing, glitching, busy everywhere; paper cutouts read where big type can't
  'sub-pressure': P(1, 0.45, 0.9, 0.6, ['bottom', 'left', 'top'], 'none', 'light', 'band'),
  'chrome-warehouse': P(1, 0.6, 0.75, 0.6, ['bottom', 'top', 'left'], 'none', 'light', 'soft'),
  'kaleido-candy': P(0.9, 0.35, 0.9, 0.5, ['middle', 'top', 'bottom'], 'none', 'look', 'band'),
  'slit-archive': P(1, 0.55, 0.8, 0.7, ['top', 'bottom', 'left'], 'none', 'light', 'soft'),
  'datamosh': P(1, 0.7, 0.8, 0.7, ['bottom', 'top', 'middle'], 'none', 'light', 'soft'),
  'glyph-mosaic': P(0.9, 0.3, 0.85, 0.5, ['top', 'right', 'bottom'], 'none', 'dark', 'paper'),
  'glyph-negative': P(0.9, 0.3, 0.85, 0.45, ['top', 'bottom', 'right'], 'none', 'light', 'band'),
  'marble-dream': P(1, 0.7, 0.65, 0.8, ['middle', 'top', 'right'], 'none', 'look', 'soft'),
  // soft, dark fields: calm almost everywhere, made for big quiet type
  'rain-window': P(1, 0.9, 0.55, 0.9, ['middle', 'bottom', 'top'], 'none', 'look', 'shadow'),
  'ink-dissolve': P(1, 0.95, 0.65, 0.9, ['middle', 'top', 'bottom'], 'none', 'look', 'shadow'),
  'paper-ghost': P(1, 0.75, 0.8, 0.8, ['middle', 'top', 'bottom'], 'none', 'light', 'shadow'),
  'silk-mourning': P(1, 0.75, 0.6, 0.85, ['top', 'right', 'middle'], 'none', 'look', 'soft'),
  'terminal-swarm': P(1, 0.85, 0.7, 0.85, ['bottom', 'top', 'middle'], 'none', 'look', 'shadow'),
  'tunnel-vision': P(1, 0.9, 0.7, 0.9, ['top', 'bottom', 'left'], 'none', 'look', 'shadow'),
  'violet-glass': P(1, 0.8, 0.7, 0.8, ['top', 'left', 'bottom'], 'none', 'look', 'shadow'),
  'glasshouse': P(1, 0.75, 0.7, 0.8, ['top', 'left', 'bottom'], 'none', 'look', 'shadow'),
  'ice-columns': P(1, 0.75, 0.7, 0.85, ['top', 'right', 'bottom'], 'none', 'look', 'shadow'),
  'sodium-columns': P(1, 0.75, 0.7, 0.85, ['top', 'left', 'right'], 'none', 'look', 'shadow'),
  // fine light textures: readable ink, but the grain wants a halo
  'combed-light': P(1, 0.85, 0.7, 0.85, ['middle', 'top', 'bottom'], 'none', 'look', 'shadow'),
  'contours': P(1, 0.85, 0.7, 0.85, ['top', 'middle', 'bottom'], 'none', 'look', 'shadow'),
  // a subject in the middle (orb, cube, blob, swarm, waveform, target): text goes above or below it
  'blomp-grid': P(1, 0.3, 0.6, 0.8, ['top', 'bottom'], 'none', 'dark', 'soft'),
  'clay-pulse': P(1, 0.6, 0.7, 0.8, ['top', 'bottom'], 'none', 'look', 'shadow'),
  'ridgeline-press': P(1, 0.55, 0.7, 0.8, ['top', 'bottom'], 'none', 'look', 'shadow'),
  'swarm-bloom': P(1, 0.75, 0.6, 0.85, ['bottom', 'top', 'left'], 'none', 'look', 'shadow'),
  'one-bit-orb': P(1, 0.5, 0.7, 0.8, ['bottom', 'top'], 'none', 'dark', 'shadow'),
  'pixel-cube': P(1, 0.5, 0.7, 0.8, ['top', 'bottom'], 'none', 'dark', 'soft'),
  'pixel-cube-bubblegum': P(1, 0.5, 0.7, 0.8, ['top', 'bottom'], 'none', 'dark', 'soft'),
  'tracking-hud': P(1, 0.6, 0.7, 0.85, ['top', 'bottom', 'right'], 'none', 'look', 'shadow'),
  'surveillance': P(1, 0.6, 0.7, 0.85, ['top', 'bottom', 'right'], 'none', 'look', 'shadow'),
  'paper-visualizer': P(1, 0.6, 0.75, 0.85, ['top', 'bottom'], 'none', 'look', 'paper'),
  'paper-tangerine': P(1, 0.6, 0.75, 0.85, ['top', 'bottom'], 'none', 'look', 'paper'),
  // photos: the picture decides; dark lower thirds and busy mosaics push text to the calm side
  'ripple-postcard': P(1, 0.6, 0.8, 0.7, ['right', 'top', 'middle'], 'none', 'look', 'soft'),
  'blue-mosaic': P(1, 0.55, 0.8, 0.7, ['right', 'top', 'middle'], 'none', 'look', 'soft'),
  // looks that show the sung words themselves: overlay stands down
  'redacted': P(0.8, 0.2, 0.5, 0.4, ['bottom', 'left'], 'carries', 'light', 'band'),
  'highlighter': P(0.8, 0.2, 0.5, 0.4, ['top', 'left'], 'carries', 'dark', 'paper'),
  'flip-cards': P(0.8, 0.2, 0.5, 0.4, ['top', 'bottom'], 'carries', 'light', 'band'),
  'flip-cards-paper': P(0.8, 0.2, 0.5, 0.4, ['bottom', 'top'], 'carries', 'dark', 'paper'),
  // golden avenue: busy canopy up top, the lit path and the glow at the end of the avenue are calm
  'golden-avenue': P(1, 0.75, 0.75, 0.85, ['bottom', 'middle', 'top'], 'none', 'look', 'soft'),
  'golden-avenue-dusk': P(1, 0.75, 0.75, 0.85, ['bottom', 'middle', 'top'], 'none', 'look', 'soft'),
  'golden-avenue-birch': P(1, 0.75, 0.75, 0.85, ['bottom', 'middle', 'top'], 'none', 'look', 'soft'),
};

/** fallbacks by scene category, for scenes picked directly and people's own looks */
export const CATEGORY_PROFILES: Record<string, LyricProfile> = {
  board: P(0.7, 0.35, 0.5, 0.6, ['top', 'bottom'], 'echoes', 'dark', 'paper'),
  photo: P(1, 0.6, 0.8, 0.7, ['bottom', 'top', 'middle'], 'none', 'look', 'soft'),
  field: P(1, 0.85, 0.7, 0.9, ['middle', 'bottom', 'top'], 'none', 'look', 'shadow'),
  form: P(1, 0.75, 0.7, 0.8, ['bottom', 'top', 'middle'], 'none', 'look', 'shadow'),
  code: P(1, 0.7, 0.7, 0.7, ['bottom', 'middle', 'top'], 'none', 'look', 'soft'),
};

const DEFAULT = CATEGORY_PROFILES.form;

/** the profile for a look, falling back to its scene's kind */
export function profileFor(lookId: string | null | undefined, category?: string, showsLyrics?: boolean): LyricProfile {
  const p = (lookId && LOOK_PROFILES[lookId]) || (category && CATEGORY_PROFILES[category]) || DEFAULT;
  return showsLyrics && p.own !== 'carries' ? { ...p, own: 'carries' } : p;
}

/** backings the guard may use on a look, lightest first */
export function ladderFor(p: LyricProfile): Backing[] {
  if (p.plate === 'paper') return ['none', 'shadow', 'paper'];
  if (p.plate === 'band') return ['none', 'shadow', 'band'];
  if (p.plate === 'soft') return ['none', 'shadow', 'soft', 'band'];
  return ['none', 'shadow', 'soft', 'band'];
}
