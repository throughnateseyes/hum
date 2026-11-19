import type { TrackAnalysis } from '../core/types';

/** The stretch of a song a short vertical clip should show. */
export interface ClipWindow {
  /** where the clip starts and ends (s) */
  start: number;
  end: number;
  /** the moment it is built around (the drop or hook), a beat or two after `start` */
  anchor: number;
  /** a few words on why this stretch, e.g. 'the drop at 1:04' */
  why: string;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/**
 * Pick the strongest 15–30 s of a song for a TikTok / Reels clip: the biggest drop or hook, judged by
 * its size, how loud the stretch after it stays, and how much it jumps out of what came before. The
 * clip starts a beat or two before that moment and ends on a section line or a bar line near `target`.
 */
export function pickClip(a: TrackAnalysis, target = 20, min = 15, max = 30): ClipWindow {
  const dur = a.duration;
  if (dur <= min + 0.5) return { start: 0, end: dur, anchor: 0, why: 'the whole song' };

  const curve = a.energyCurve;
  const n = curve.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, curve[i]);
  peak = peak || 1;
  const mean = (t0: number, t1: number) => {
    if (!n) return 0;
    const i0 = Math.max(0, Math.floor((t0 / dur) * n));
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t1 / dur) * n)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += curve[i];
    return s / Math.max(1, i1 - i0) / peak;
  };

  const beat = 60 / (a.bpm > 40 && a.bpm < 220 ? a.bpm : 120);
  const bar = beat * 4;
  // two beats of run-up, or one at slow tempos; never less than half a second
  const lead = Math.max(0.5, beat * 2 <= 2.2 ? beat * 2 : beat);

  type Cand = { t: number; strength: number; why: string };
  const cands: Cand[] = [];
  const drops = a.dropInfo ?? a.drops.map((t) => ({ t, strength: 1, why: '' }));
  for (const d of drops) cands.push({ t: d.t, strength: d.strength, why: `the drop at ${fmt(d.t)}` });
  for (const s of a.sections) {
    if (s.start < 1 || (s.label !== 'chorus' && s.label !== 'drop')) continue;
    if (cands.some((c) => Math.abs(c.t - s.start) < 0.75)) continue;
    cands.push({ t: s.start, strength: s.label === 'drop' ? 0.65 : 0.55, why: `the ${s.label} at ${fmt(s.start)}` });
  }
  if (!cands.length) {
    // no sections or drops to go on: the loudest stretch, on the bar grid
    for (let t = bar; t + min < dur; t += bar) cands.push({ t, strength: 0, why: `the loudest part, from ${fmt(t)}` });
  }

  let best: Cand | null = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const after = mean(c.t, Math.min(dur, c.t + target - lead));
    const before = mean(Math.max(0, c.t - 4), c.t);
    const contrast = Math.max(0, Math.min(1, (after - before) * 2));
    let score = 0.5 * after + 0.35 * c.strength + 0.15 * contrast;
    if (c.t - lead + min > dur) score -= 1; // not enough song left after it
    if (c.t < 8) score -= 0.1; // the beat arriving right at the top is rarely the best bit
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const anchor = best!.t;
  let start = Math.max(0, anchor - lead);
  if (start + min > dur) start = Math.max(0, dur - min);

  // end on a section line near the target if there is one, otherwise on a whole number of bars
  let end = 0;
  let endGap = 6;
  for (const s of a.sections) {
    const len = s.end - start;
    if (len < min || len > max) continue;
    const gap = Math.abs(len - target);
    if (gap < endGap) {
      endGap = gap;
      end = s.end;
    }
  }
  if (!end) {
    const bars = Math.max(1, Math.round((target - (anchor - start)) / bar));
    end = anchor + bars * bar;
    while (end - start > max) end -= bar;
    while (end - start < min) end += bar;
  }
  end = Math.min(end, dur);
  return { start, end, anchor, why: best!.why };
}
