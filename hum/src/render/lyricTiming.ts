import type { LyricLine } from '../core/types';

/**
 * When lyric words are on screen. Shared by the lyric layer and the pop-ups that show the sung line
 * (scenes/board/mod-words.ts), so both put the same words up at the same moment and take them down
 * at the same moment. No canvas or three.js here: a board module can import it without pulling in
 * the renderer.
 *
 * Every line stays up long enough to read (READ_BASE + READ_PER_WORD a word), and its last word
 * stays up a moment after it's sung. Lines that come too fast to read on their own are shown
 * together; a showing that has to make way pulls its late words in so every word is drawn first.
 */

/** read time: base + per word (s), and never less than READ_MIN */
const READ_BASE = 0.6;
const READ_PER_WORD = 0.28;
const READ_MIN = 1.4;
/** a line's last word stays up at least this long after it starts (s) */
const TAIL = 0.75;
/** lines merged into one showing never go over this many words (or three lines) */
const MAX_SHOWN_WORDS = 14;
/** a showing appears this much before its first word, so the eye arrives with the voice */
export const LEAD = 0.08;

export interface Word {
  text: string;
  t: number;
  end: number;
}

/** word timings: real ones when the lyrics have them, otherwise spread across the line by length */
export function wordsOf(line: LyricLine): Word[] {
  if (line.words?.length) return line.words;
  const parts = line.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, w) => a + w.length + 1, 0);
  const span = Math.max(0.4, (line.end - line.t) * 0.82);
  let acc = 0;
  return parts.map((text) => {
    const t = line.t + (acc / total) * span;
    acc += text.length + 1;
    return { text, t, end: line.t + (acc / total) * span };
  });
}

/** how long a line of n words needs on screen to be read */
export const readTime = (n: number) => Math.max(READ_MIN, READ_BASE + READ_PER_WORD * n);

/** what is on screen at once: one lyric line, or a few quick ones together, with display times */
export interface Showing {
  /** first and last lyric line (indices into the lines) */
  first: number;
  last: number;
  /** on screen from t to end (end includes the read time; the fade-out comes after) */
  t: number;
  end: number;
  text: string;
  words: Word[];
  timed: boolean;
}

const shownCache = new WeakMap<LyricLine[], Showing[]>();

/**
 * Turn timed lines into what's shown: each line stays up for its read time and a moment after its
 * last word; lines that start before the one before could be read join it (up to three lines /
 * MAX_SHOWN_WORDS), so nothing flashes by. If a showing still has to leave early for the next one,
 * its late words are pulled in so every word is drawn before it goes.
 */
export function showings(lines: LyricLine[]): Showing[] {
  const hit = shownCache.get(lines);
  if (hit) return hit;
  const out: Showing[] = [];
  let k = 0;
  while (k < lines.length) {
    const first = k;
    let words = wordsOf(lines[k]).map((w) => ({ ...w }));
    let timed = !!lines[k].words?.length;
    let last = k;
    while (last + 1 < lines.length && last - first < 2 && words.length) {
      const nx = lines[last + 1];
      const upFor = nx.t - lines[first].t;
      const tailFor = nx.t - words[words.length - 1].t;
      if (upFor >= readTime(words.length) && tailFor >= TAIL) break;
      const nw = wordsOf(nx);
      if (words.length + nw.length > MAX_SHOWN_WORDS) break;
      words = words.concat(nw.map((w) => ({ ...w })));
      timed = timed && !!nx.words?.length;
      last++;
    }
    k = last + 1;
    if (!words.length) continue;
    const t = lines[first].t;
    const next = lines[last + 1]?.t ?? Infinity;
    const lastW = words[words.length - 1];
    const want = Math.max(lines[last].end, lastW.end + 0.25, lastW.t + TAIL, t + readTime(words.length));
    const end = Math.min(want, next);
    // every word is drawn before the showing goes: if it must leave early, pull its late words in
    const latest = end - 0.35;
    const w0 = Math.min(words[0].t, latest);
    if (lastW.t > latest && latest > t) {
      const f = (latest - w0) / Math.max(1e-3, lastW.t - w0);
      for (const w of words) {
        if (w.t > w0) w.t = w0 + (w.t - w0) * f;
        w.end = Math.min(end, Math.max(w.t + 0.05, w0 + (w.end - w0) * f));
      }
    }
    out.push({ first, last, t, end, text: words.map((w) => w.text).join(' '), words, timed });
  }
  shownCache.set(lines, out);
  return out;
}

/** index of the last showing that has started by time t (-1 before the first) */
export function showingAt(shows: Showing[], t: number): number {
  let lo = 0;
  let hi = shows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (shows[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The showing on screen at song time t, the way the lyric layer shows it: from LEAD before its
 * first word until its end (null between showings).
 */
export function showingNow(lines: LyricLine[], t: number): { i: number; line: Showing } | null {
  const shows = showings(lines);
  const i = showingAt(shows, t + LEAD);
  return i >= 0 && t + LEAD < shows[i].end ? { i, line: shows[i] } : null;
}

/* ───────────────────────── one place for the words ───────────────────────── */

/**
 * A pop-up that shows the sung line (the "now singing" window, mod-words.ts) says so here every
 * frame it draws; the lyric layer reads it and stands down, so the words are in one place at a time.
 * Read-and-clear: a window that closed stops saying so, and the overlay comes back.
 */
let lineWindowOpen = false;
export function noteLineWindow() {
  lineWindowOpen = true;
}
/** was a sung-line pop-up drawn since the last call? (clears the note) */
export function takeLineWindow(): boolean {
  const v = lineWindowOpen;
  lineWindowOpen = false;
  return v;
}
