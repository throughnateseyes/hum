/** The inks at a moment of the song (shot/inks.ts says what they are and where they come from). */
import { getPalette, PALETTES } from '../core/palettes';
import type { ClipAsset, ClipPalette, Palette, PartShot, TrackAnalysis } from '../core/types';
import { hasTones, INK_ROLES, inksFrom, lateTones, tonesFromPixels, tonesOf, type InkSet } from '../shot/inks';
import { shotOfPart } from '../shot/partShots';
import { originalOf } from './planCache';
import { useStudio } from './store';

/** the finishes that draw in inks */
export const inked = (finish: string) => finish === 'hand' || finish === 'riso' || finish === 'ink';

/** the record of the shot playing at song time t (the look's own when no video plan plays) */
export function shotRecordAt(t: number): PartShot | null {
  const s = useStudio.getState();
  const secs = s.analysis?.sections;
  if (!s.planOn) return s.soloShot;
  if (!secs?.length || s.plan?.looks.length !== secs.length) return null;
  let i = 0;
  for (let k = secs.length - 1; k > 0; k--)
    if (t >= secs[k].start) {
      i = k;
      break;
    }
  return shotOfPart(i, s);
}

interface Mood {
  /** per part of the song: -1 quiet .. 1 loud, against the song itself */
  glow: number[];
  /** per part: which of the dealt palettes is its own (parts that sound alike share one) */
  deal: number[];
}
const moods = new WeakMap<TrackAnalysis, Mood>();
function moodOf(a: TrackAnalysis): Mood {
  let m = moods.get(a);
  if (!m) {
    const es = a.sections.map((x) => x.energy);
    const lo = Math.min(...es);
    const span = Math.max(0.08, Math.max(...es) - lo);
    const seen: number[] = [];
    const deal = a.sections.map((x) => {
      const at = seen.indexOf(x.group);
      return at >= 0 ? at : seen.push(x.group) - 1;
    });
    m = { glow: es.map((e) => Math.min(1, ((e - lo) / span) * 2 - 1)), deal };
    moods.set(a, m);
  }
  return m;
}
function partOf(a: TrackAnalysis, t: number): number {
  let i = 0;
  for (let k = 0; k < a.sections.length; k++) if (t >= a.sections[k].start) i = k;
  return i;
}

/** every clip and photo's tones in one list: the first of each, then the second of each... */
export function tonesOfAll(palettes: ClipPalette[]): string[] {
  const lists = palettes.map(tonesOf);
  const out: string[] = [];
  for (let k = 0; k < 6 && out.length < 40; k++) for (const l of lists) if (l[k]) out.push(l[k]);
  return out;
}

const made = new Map<string, Palette>();
function named(key: string, make: () => InkSet): Palette {
  let p = made.get(key);
  if (!p) {
    if (made.size > 300) made.clear();
    p = { id: `inks-${key}`, name: 'Inks', ...make() };
    made.set(key, p);
  }
  return p;
}

/**
 * The colours to draw with at song time t, or null for the look's own. `shown` is the palette of the
 * clip or photo on screen, when there is one.
 */
export function inksAt(t: number, shown: ClipPalette | null): Palette | null {
  const s = useStudio.getState();
  const k = s.inkColors;
  const own = shotRecordAt(t)?.inks;
  const a = s.analysis ? originalOf(s.analysis) : null;
  const i = a?.sections.length ? partOf(a, t) : -1;
  const set = own && PALETTES.some((p) => p.id === own) ? own : null;
  if (set) return getPalette(set);
  const mode = own === 'look' || own === 'clips' || own === 'video' || own === 'own' ? own : k.mode;
  if (mode === 'own') return named(`own ${INK_ROLES.map((r) => k.own[r]).join('')}`, () => k.own);
  if (mode === 'sets') {
    const ids = k.sets.filter((id) => PALETTES.some((p) => p.id === id));
    return ids.length ? getPalette(ids[i < 0 || !a ? 0 : moodOf(a).deal[i] % ids.length]) : null;
  }
  if (mode === 'look') return null;
  // the clip on screen; a look with no clip of the person's on it keeps its own colours
  const tones = mode === 'clips' ? (shown ? tonesOf(shown) : null) : s.clips.length ? tonesOfAll(s.clips.map((c) => c.palette)) : shown ? tonesOf(shown) : null;
  if (!tones?.length) return null;
  const glow = a && i >= 0 ? Math.round(moodOf(a).glow[i] * k.feel * 8) / 8 : 0;
  return named(`${mode} ${k.paper} ${glow} ${tones.join('')}`, () => inksFrom(tones, k.paper, glow));
}

/** read the tones of clips added before tones were (from their library stills); true when any were read */
export async function readTones(clips: ClipAsset[]): Promise<boolean> {
  let any = false;
  for (const c of clips) {
    if (hasTones(c.palette) || !c.thumb) continue;
    const img = new Image();
    img.src = c.thumb;
    try {
      await img.decode();
    } catch {
      continue;
    }
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 64, 64);
    const tones = tonesFromPixels(g.getImageData(0, 0, 64, 64).data);
    if (tones.length) {
      lateTones(c.palette, tones);
      any = true;
    }
  }
  return any;
}

// clips are read as they arrive, so a render finds them read
void readTones(useStudio.getState().clips);
useStudio.subscribe((s, was) => {
  if (s.clips !== was.clips) void readTones(s.clips);
});
