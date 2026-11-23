/**
 * Song facts for the poster-style scenes (paper visualizer, pixel cube, flip cards): title,
 * artist, the line being sung and which section we're in. The store is read lazily (inside
 * render only), because the store imports the scene registry.
 */
import type { FrameContext, LyricLine } from '../../core/types';
import { lineAt } from '../../audio/lyrics';
import { useStudio } from '../../state/store';

export interface SongInfo {
  title: string;
  artist: string;
  /** false when `artist` is only a stand-in ('Unknown artist'): scenes that make words from it skip it */
  artistKnown: boolean;
}

/**
 * A file name made readable: no extension, no underscores, no track number in front, no "(Official
 * Video)" or "[320kbps]" tags. "03_Pressure (Official Audio).mp3" → "Pressure".
 */
export const strip = (s: string) =>
  s
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[([][^)\]]*(official|audio|video|lyric|visuali[sz]er|kbps|remaster|hq|hd)[^)\]]*[)\]]/gi, '')
    .replace(/^\s*\d{1,3}\s*[-.)]?\s+(?=\S)/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

export function songInfo(): SongInfo {
  try {
    const s = useStudio.getState();
    const name = strip(s.track?.name ?? '');
    let title = (s.lyrics?.title || '').trim();
    let artist = (s.lyrics?.artist || '').trim();
    if (!title) {
      const m = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) {
        title = m[2];
        if (!artist) artist = m[1];
      } else title = name;
    }
    if (!artist && s.track?.source === 'demo') artist = 'Hum demo';
    if (!artist && s.track?.source === 'mic') artist = 'Live';
    return { title: title || 'Untitled', artist: artist || 'Unknown artist', artistKnown: !!artist };
  } catch {
    return { title: 'Untitled', artist: 'Unknown artist', artistKnown: false };
  }
}

/**
 * The words the person gave the part playing at `time` (the Part tab's Words field), '' when none.
 * Only while the video plan plays, as the parts are the plan's.
 */
export function partWords(time: number): string {
  try {
    const s = useStudio.getState();
    const secs = s.analysis?.sections;
    const w = s.partWords;
    if (!s.planOn || !secs || !w || w.length !== secs.length || s.plan?.looks.length !== secs.length) return '';
    let i = 0;
    for (let k = secs.length - 1; k >= 0; k--) {
      if (time >= secs[k].start) {
        i = k;
        break;
      }
    }
    return w[i]?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Looks whose scene writes words of its own (from the frame's text: the part's words, the title text or
 * the line being sung): the Part tab offers a Words field for these.
 */
export function sceneShowsWords(sceneId: string | undefined): boolean {
  return !!sceneId && (WORD_SCENES.has(sceneId) || sceneId.startsWith('board-'));
}
const WORD_SCENES = new Set(['flip-cards', 'undercode', 'ribbon-type', 'text-wall', 'word-drop']);

function syncedLines(): LyricLine[] | null {
  try {
    const l = useStudio.getState().lyrics;
    return l?.synced && l.lines.length ? l.lines : null;
  } catch {
    return null;
  }
}

/** the synced lyric line being sung now ({index, text}), or null between lines / without lyrics */
export function currentLyric(time: number): { i: number; text: string } | null {
  const lines = syncedLines();
  if (!lines) return null;
  const hit = lineAt(lines, time + 0.1);
  if (!hit || time > hit.line.end + 0.8 || !hit.line.text.trim()) return null;
  return { i: hit.i, text: hit.line.text };
}

export const hasSyncedLyrics = () => syncedLines() !== null;

/**
 * Index of the current analysed section (-1 before analysis). Changes when the song moves into
 * a new section, so scenes can react to "section change".
 */
export function sectionIndex(frame: FrameContext): number {
  const secs = frame.analysis?.sections;
  if (!secs?.length) return -1;
  const t = frame.audio.time;
  for (let i = secs.length - 1; i >= 0; i--) if (t >= secs[i].start) return i;
  return 0;
}

/** detects the frame a drop fires (drop envelope rising through 0.6) */
export function dropEdge() {
  let prev = 0;
  return (frame: FrameContext) => {
    const d = frame.audio.drop;
    const hit = d > 0.6 && prev <= 0.6;
    prev = d;
    return hit;
  };
}

export const fmtClock = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const FONT_SANS = `'Inter Variable', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif`;
export const FONT_MONO = `'IBM Plex Mono', ui-monospace, Menlo, monospace`;
