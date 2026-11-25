/**
 * How long a render has left. The render counts the frames it has made (each weighed by the size of its
 * picture, with the run-up before every video counted too) and this turns that into seconds: how fast it
 * has gone so far mixed with how fast it is going now, eased, so the number counts down instead of jumping
 * at every cut between an easy look and a heavy one. Pure: the clock is handed in.
 */

/** what the store's render progress says about time (store.ts, ClipProgress) */
export interface RenderTime {
  /** seconds since the render began */
  elapsed: number;
  /** seconds left for everything asked for (every size); undefined until it can be trusted */
  left?: number;
  /** seconds of video made per second of waiting (2 is twice real time); undefined until it can be trusted */
  speed?: number;
}

/** nothing is said before this many seconds of making frames, and this many of them */
const TRUST_S = 3;
const TRUST_FRAMES = 12;
/** how far back "now" looks (s), and how much it counts against the whole render so far */
const RECENT_S = 12;
const RECENT_SHARE = 0.4;
/** the estimate moves most of the way to a new reading in this long (s) */
const EASE_S = 4;

/** frames of a video this size cost about this much (1 for 1080p): part of a frame's work goes with its pixels, part doesn't */
export const frameWeight = (w: number, h: number): number => 0.4 + 0.6 * ((w * h) / (1920 * 1080));

export class RenderClock {
  private from = -1;
  private marks: { at: number; work: number; frames: number }[] = [];
  private shown: number | undefined;
  private shownAt = 0;

  /** `total`: all the work there is (frames times their weight); `began`: when the render did (ms); `fps`: of the video */
  constructor(
    private readonly total: number,
    private readonly began: number,
    private readonly fps: number,
  ) {}

  /** where the render has got to: `work` of the total done, `frames` drawn so far, at `now` (ms) */
  at(now: number, work: number, frames: number): RenderTime {
    const elapsed = Math.max(0, (now - this.began) / 1000);
    if (this.from < 0) {
      // the clock starts at the first frame: what came before it (the sound, opening clips) is not coming again
      if (frames <= 0) return { elapsed };
      this.from = now;
    }
    const marks = this.marks;
    if (!marks.length || now - marks[marks.length - 1].at >= 200) marks.push({ at: now, work, frames });
    while (marks.length > 2 && now - marks[1].at > RECENT_S * 1000) marks.shift();
    const first = this.first ?? (this.first = { work, frames });
    const secs = (now - this.from) / 1000;
    const made = frames - first.frames;
    if (secs < TRUST_S || made < TRUST_FRAMES) return { elapsed };
    const all = { work: (work - first.work) / secs, frames: made / secs };
    const since = marks[0];
    const span = (now - since.at) / 1000;
    const recent = span > 1 ? { work: (work - since.work) / span, frames: (frames - since.frames) / span } : all;
    const rate = all.work * (1 - RECENT_SHARE) + recent.work * RECENT_SHARE;
    if (!(rate > 0)) return { elapsed };
    const raw = Math.max(0, this.total - work) / rate;
    const dt = (now - this.shownAt) / 1000;
    // it counts down by itself, and eases to what is now thought
    this.shown = this.shown === undefined ? raw : Math.max(0, this.shown - dt + (raw - (this.shown - dt)) * (1 - Math.exp(-dt / EASE_S)));
    this.shownAt = now;
    return { elapsed, left: work >= this.total ? 0 : this.shown, speed: (all.frames * (1 - RECENT_SHARE) + recent.frames * RECENT_SHARE) / this.fps };
  }
  private first: { work: number; frames: number } | null = null;
}

/** "about 4 min left", "about 20 s left", "almost done"; nothing while it isn't known */
export function timeLeftText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, seconds);
  if (s < 4) return 'almost done';
  if (s < 57.5) return `about ${Math.max(5, Math.round(s / 5) * 5)} s left`;
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `about ${m} min left`;
  const t = Math.round(m / 5) * 5;
  return `about ${Math.floor(t / 60)} h${t % 60 ? ` ${t % 60} min` : ''} left`;
}
