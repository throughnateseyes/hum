/**
 * Which words stand in an inside shot: the ones sung in it, on time; with nothing sung there, the words
 * the person typed for the part, then the director's, then (in a song with no lyrics) the title where a
 * part lands.
 */
import { wordsOf } from '../render/lyricTiming';
import type { Shot } from '../shot/sequence';
import { partWordsAt } from '../state/direction';
import { lyricPlanNow } from '../state/lyricPlan';
import { useStudio } from '../state/store';
import { CARRY, type SungWord } from './layout';

/** a word as it is set: capitals, without the punctuation that only helps when reading a line */
const clean = (w: string) =>
  w
    .replace(/[^\p{L}\p{N}'’&$%+-]/gu, '')
    .replace(/^['’-]+|[-]+$/g, '')
    .toUpperCase();

/** are the song's lyrics being shown over the part at song time t? */
function lyricsShown(t: number): boolean {
  const s = useStudio.getState();
  if (s.lyricStyle === 'off' || !s.lyrics?.synced || !s.lyrics.lines.length) return false;
  const a = s.analysis;
  const i = a?.sections.findIndex((x) => t < x.end) ?? -1;
  const part = lyricPlanNow({ analysis: a, lyrics: s.lyrics, plan: s.plan, planOn: s.planOn })?.parts[i];
  return part?.medium !== 'none';
}

const set = (text: string): SungWord[] =>
  text
    .split(/\s+/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 5)
    .map((w) => ({ text: w, t: 0, end: 0 }));

/** `title`: the title in words, for a song with no lyrics; `opens`: the shot opens its part of the song */
export function wordsIn(shot: Shot, title: string[], opens: boolean): { words: SungWord[]; sung: boolean } {
  const mid = (shot.start + shot.end) / 2;
  const s = useStudio.getState();
  if (lyricsShown(mid)) {
    const words: SungWord[] = [];
    for (const line of s.lyrics!.lines) {
      if (line.end < shot.start - 1 || line.t > shot.end + 1) continue;
      for (const w of wordsOf(line)) {
        const text = clean(w.text);
        if (text && (w.end > shot.start || w.t >= shot.start - CARRY) && w.t < shot.end - CARRY) words.push({ text, t: w.t, end: w.end });
      }
    }
    if (words.length) return { words, sung: true };
  }
  const own = partWordsAt(s, mid) || shot.say;
  if (own) return { words: set(own), sung: false };
  // the video opens on its title
  if (title.length && opens && shot.start < 0.5) return { words: set(title.join(' ')), sung: false };
  if (!s.lyrics?.lines.length && title.length && opens && shot.arrive === 'hit') return { words: set(title.join(' ')), sung: false };
  return { words: [], sung: false };
}
