/**
 * Dev helper: play a video plan with made-up test lines and log how readable each lyric frame is.
 *
 *   const C = await import('/src/dev/lyricCheck.ts');
 *   await C.testLines();                        // loads made-up lines over the loaded song (memory only)
 *   const log = await C.playCheck();            // play the current plan through, sampling 5× a second
 *   C.summary(log)                              // per part: medium, backings, zones, mean / worst miss share
 *
 * The miss share is `stage.lyricLayer.legibilityNow()`: how much of the line's box misses the
 * contrast target with the ink and backing actually on screen. Clear the lines after with
 * `useStudio.setState({ lyrics: null, lyricsStatus: 'idle' })`.
 */
import { audioEngine } from '../audio/engine';
import { live } from '../state/live';
import { useStudio } from '../state/store';

const TEXTS = [
  'paper moons over the quiet harbour',
  'we kept the lights on just to see',
  'every window singing back at me',
  'hold the static close tonight',
  'run until the morning breaks',
  'nothing left but neon rain',
  'turn it up and let it go',
  'we were never meant to stay',
  'falling through the open sky',
  'say my name and light the fire',
  'all the rivers running home',
  'one more time before the dawn',
];

/** made-up lines every `every` seconds across the loaded song (setState skips persistence) */
export function testLines(every = 4.2) {
  const a = useStudio.getState().analysis;
  if (!a) throw new Error('no analysis');
  const lines = [];
  let k = 0;
  for (let t = 1.5; t < a.duration - 2; t += every) lines.push({ t, end: t + every * 0.8, text: TEXTS[k++ % TEXTS.length] });
  useStudio.setState({ lyrics: { lines, synced: true, source: 'pasted' }, lyricsStatus: 'found', lyricStyle: 'auto' });
  return lines.length;
}

export interface CheckRow {
  t: number;
  line: number;
  part: string;
  look: string;
  medium: string;
  zone?: string;
  moment?: string | null;
  backing?: string;
  bad: number;
}

/** sample the playing song until it stops or loops (lines only, after their fade-in) */
export function playCheck(stepMs = 200): Promise<CheckRow[]> {
  return new Promise((res) => {
    const layer = (live.stage as unknown as { lyricLayer: { legibilityNow(): { medium: string; zone: string; moment: string | null; backing: string; bad: number } | null } }).lyricLayer;
    const out: CheckRow[] = [];
    const st = useStudio.getState();
    const a = st.analysis!;
    const lines = st.lyrics?.lines ?? [];
    let last = -1;
    const iv = setInterval(() => {
      const t = audioEngine.currentTime;
      if (t < last - 1 || !audioEngine.frame.playing) {
        clearInterval(iv);
        res(out);
        return;
      }
      last = t;
      const li = lines.findIndex((l) => t + 0.08 >= l.t && t + 0.08 < l.end);
      if (li < 0 || t + 0.08 < lines[li].t + 0.3) return;
      const v = layer.legibilityNow();
      const sec = [...a.sections].reverse().find((s) => t >= s.start)!;
      out.push({ t: Math.round(t * 100) / 100, line: li, part: sec.label, look: useStudio.getState().presetId ?? '', medium: v?.medium ?? 'own', zone: v?.zone, moment: v?.moment, backing: v?.backing, bad: v ? Math.round(v.bad * 1000) / 1000 : 0 });
    }, stepMs);
  });
}

export function summary(rows: CheckRow[]) {
  const by: Record<string, { n: number; bad: number; worst: number; b: Set<string>; z: Set<string>; looks: Set<string> }> = {};
  for (const x of rows) {
    const k = `${x.part}: ${x.medium}${x.moment ? ` + ${x.moment}` : ''}`;
    const e = (by[k] ??= { n: 0, bad: 0, worst: 0, b: new Set(), z: new Set(), looks: new Set() });
    e.n++;
    e.bad += x.bad;
    e.worst = Math.max(e.worst, x.bad);
    if (x.backing) e.b.add(x.backing);
    if (x.zone) e.z.add(x.zone);
    e.looks.add(x.look);
  }
  return {
    frames: rows.length,
    over10: rows.filter((x) => x.bad > 0.1).length,
    mediums: [...new Set(rows.map((x) => x.medium))],
    parts: Object.fromEntries(
      Object.entries(by).map(([k, e]) => [k, `${e.n} frames, miss mean ${(e.bad / e.n).toFixed(3)} worst ${e.worst.toFixed(3)}; backing ${[...e.b].join('/')}; zone ${[...e.z].join('/')}; looks ${[...e.looks].join(', ')}`]),
    ),
  };
}
