/**
 * Moods: one-tap directions that keep a whole video inside one world.
 *
 * A mood is a hand-picked set of look families (and, for a family that spans worlds, only the takes
 * that belong: Precast's Night take is night city, its Winter take is brutal) plus the finish and the
 * transition set the video's Direction uses (core/direction.ts). Picking a mood re-plans the video
 * with only those looks: the offline planner (state/plan.ts localPlan) and the Claude planner (the
 * request only carries the mood's looks, and the prompt says why) both stay inside it, so parts vary
 * by take and by neighbouring families of one world, never by jumping to an unrelated scene.
 *
 * The rotation inside each part, the look a strong drop cuts to, a skipped look's replacement and the
 * scene windows all keep to the playing plan's mood too.
 *
 * Adding a family: put its id in every mood whose world it belongs to (or a take id when only some of
 * its takes do). A family in no mood still plays in videos without a mood. In dev the console warns
 * about ids here that name no family or look.
 */
import type { FinishId, TransitionSetId } from '../core/direction';
import type { Preset } from '../core/types';
import { allFamilies, familyIdOf } from './fit';
import { PRESETS } from './library';

export const MOOD_IDS = ['brutal', 'dreamy', 'hacker', 'nature', 'club', 'paper', 'night', 'playful'] as const;
export type MoodId = (typeof MOOD_IDS)[number];
export const isMoodId = (v: unknown): v is MoodId => typeof v === 'string' && (MOOD_IDS as readonly string[]).includes(v);

export interface Mood {
  id: MoodId;
  name: string;
  /** plain-English tooltip */
  tip: string;
  /** the world in a few words, for the Claude planner */
  world: string;
  /**
   * family ids (every take) or look ids (only that take), roughly in order of how central they are;
   * "=id" is only that take where a family's lead take has the family's own id (=laminar: Dusk garden)
   */
  looks: string[];
  /** the finish for soft songs and for loud ones */
  finish: [soft: FinishId, loud: FinishId];
  transitions: TransitionSetId;
}

export const MOODS: Mood[] = [
  {
    id: 'brutal',
    name: 'Brutal',
    tip: 'Concrete, hard light and heavy blocks: brutalist buildings, scans and dark rooms. Hard cuts, film grain.',
    world: 'brutalist concrete, raking hard light, monochrome scans and dark rooms',
    looks: ['massing', 'precast', 'signal-scan', 'contours', 'slit-archive', 'ridgeline-press', 'glass-planes', 'tracking-hud', 'chrome-warehouse', 'sub-pressure', 'blomp-grid', 'mission-control'],
    finish: ['film', 'clean'],
    transitions: 'kinetic',
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    tip: 'Soft light, silk, glass and slow water. Nothing hard. Long dissolves.',
    world: 'soft glowing light, silk, crystal, clouds and slow water; nothing harsh',
    looks: ['silk', 'soft-orbs', 'prism', 'rain-window', 'combed-light', 'marble-dream', 'jellies', 'still-water', 'gilded-clouds', 'above-the-clouds', 'orrery', 'lensing', '=laminar', 'laminar-studio'],
    finish: ['film', 'clean'],
    transitions: 'soft',
  },
  {
    id: 'hacker',
    name: 'Hacker',
    tip: 'Code rain, terminals, old screens and machine vision, played off an old tape. Glitchy swaps.',
    world: 'code rain, terminals, CRT screens, tracking overlays and machine vision',
    looks: ['undercode', 'terminal-swarm', 'tracking-hud', 'signal-scan', 'observer', 'retro-desktop', 'slit-archive', 'contours', 'datamosh', 'tunnel-vision', 'mission-control', 'lab-notes'],
    finish: ['tape', 'tape'],
    transitions: 'glitch',
  },
  {
    id: 'nature',
    name: 'Nature',
    tip: 'Sky, water, leaves and creatures: one landscape all the way through. Ink wash or film, organic dissolves.',
    world: 'one landscape: sky, water, trees, leaves, fish and wings',
    looks: ['willow', 'canopy', 'golden-avenue', 'garden', 'wing', 'jellies', 'shoal', 'still-water', 'gilded-clouds', 'above-the-clouds', 'herbarium', 'signal-forest', '=laminar', 'fountain-park', 'song-forecast'],
    finish: ['ink', 'film'],
    transitions: 'organic',
  },
  {
    id: 'club',
    name: 'Club',
    tip: 'Dark rooms, chrome, tunnels and neon. Built for bass. Clean and sharp, hard cuts.',
    world: 'a dark club: chrome, tunnels, lasers, neon and bass pressure',
    looks: ['sub-pressure', 'blomp-grid', 'chrome-warehouse', 'tunnel-vision', 'swarm-bloom', 'neurones', 'kaleido-candy', 'lensing', 'particle-columns', 'datamosh', 'night-windows-neon-rain', 'fountain-neon', 'confetti-night', 'arcade-night'],
    finish: ['clean', 'clean'],
    transitions: 'kinetic',
  },
  {
    id: 'paper',
    name: 'Paper',
    tip: 'Print, riso, halftone, cut paper and type on a page. Printed in riso inks, graphic wipes.',
    world: 'print on paper: riso, halftone, cut paper, posters and type',
    looks: ['paper-visualizer', 'glyph-mosaic', 'halftone-flow', 'specimen-tiles', 'overprint', 'ridgeline-press', 'bead-fire', 'confetti', 'herbarium', 'garden-doodle', 'flip-cards-paper', 'word-drop', 'ribbon-type', 'text-wall', 'dot-assembly', 'diary', 'oto-sketch'],
    finish: ['riso', 'riso'],
    transitions: 'graphic',
  },
  {
    id: 'night',
    name: 'Night city',
    tip: 'Lit windows, night trains, wet streets and fountains after dark. Shot on film, fades to black.',
    world: 'a city after dark: lit windows, trains, streetlight, fountains and screens',
    looks: ['night-windows', 'night-train', 'retro-desktop-midnight', 'particle-columns', '=fountain-show', 'fountain-tender', 'fountain-gold', 'laminar-night', 'soft-orbs-night-mobile', 'soft-orbs-amber-lamps', 'precast-night', 'massing-night', 'observer-phosphor', 'glass-planes'],
    finish: ['film', 'film'],
    transitions: 'film',
  },
  {
    id: 'playful',
    name: 'Playful',
    tip: 'Toys, cubes, confetti and bold colour cards. Drawn by hand, graphic wipes.',
    world: 'toys and bold graphics: cubes, confetti, colour cards and pixel art',
    looks: ['gradient-cubes', 'pixel-cube', 'confetti', 'kaleido-candy', 'flip-cards', 'dot-assembly', 'clay-orb', 'overprint', 'word-drop', 'arcade'],
    finish: ['hand', 'riso'],
    transitions: 'graphic',
  },
];

const byId = new Map(MOODS.map((m) => [m.id, m]));
export const moodById = (id: MoodId | null | undefined): Mood | undefined => (id ? byId.get(id) : undefined);

/** a mood's entries split into whole families and single takes ("=laminar": the take, not the family it leads) */
const sets = new Map<MoodId, { fams: Set<string>; takes: Set<string> }>();
function setOf(m: Mood) {
  let s = sets.get(m.id);
  if (!s) {
    const famIds = new Set(allFamilies().map((f) => f.id));
    s = { fams: new Set(), takes: new Set() };
    for (const e of m.looks) {
      if (e.startsWith('=')) s.takes.add(e.slice(1));
      else if (famIds.has(e)) s.fams.add(e);
      else s.takes.add(e);
    }
    sets.set(m.id, s);
  }
  return s;
}

/** the look belongs to the mood's world: its family is listed, or this take is */
export function inMood(p: Pick<Preset, 'id' | 'family'>, mood: Mood | MoodId | null | undefined): boolean {
  const m = typeof mood === 'string' ? byId.get(mood) : mood;
  if (!m) return true;
  const s = setOf(m);
  return s.takes.has(p.id) || s.fams.has(familyIdOf(p));
}

/** a filter for a mood (everything passes without one) */
export function moodFilter(mood: MoodId | null | undefined): ((p: Preset) => boolean) | undefined {
  const m = moodById(mood);
  return m ? (p: Preset) => inMood(p, m) : undefined;
}

/** the finish for this mood on a song this lively (0 calm … 1 loud) */
export const moodFinish = (m: Mood, arousal: number): FinishId => m.finish[arousal > 0.55 ? 1 : 0];

/** the look a mood's chip shows: its first listed family's lead take (or the listed take itself) */
export function moodCover(m: Mood): Preset | undefined {
  const first = m.looks[0].replace(/^=/, '');
  return allFamilies().find((f) => f.id === first)?.takes[0] ?? PRESETS.find((p) => p.id === first);
}

if (import.meta.env?.DEV) {
  // a typo here silently shrinks a mood, so say so while developing
  const fams = new Set(allFamilies().map((f) => f.id));
  const looks = new Set(PRESETS.map((p) => p.id));
  for (const m of MOODS) {
    for (const e of m.looks) {
      const id = e.replace(/^=/, '');
      if (e.startsWith('=') ? !looks.has(id) : !fams.has(id) && !looks.has(id)) console.warn(`[moods] ${m.id}: no family or look "${e}"`);
    }
  }
}

/* snow (src/scenes/snow): the crystal and the woods belong to nature, the crystal and the flurry to
 * dreamy, the night street, black ice and the flurry to night, the chalk board to paper and playful */
for (const [mood, ids] of [
  ['nature', ['snow-crystal', 'dusk-woods']],
  ['dreamy', ['=snow-crystal', 'snow-flurry']],
  ['night', ['first-snow', 'black-ice', 'snow-flurry']],
  ['paper', ['chalk-flakes']],
  ['playful', ['chalk-flakes']],
] as const) MOODS.find((m) => m.id === mood)?.looks.push(...ids);
