/**
 * The seek bar in full screen: a slim line across the bottom of the picture that you can grab
 * anywhere. The song's parts are short gaps in the line and its drops are small dots above it, so
 * "the second verse" or "the drop" is easy to aim at; hovering shows the time and the part's name.
 *
 * Dragging behaves like the render handles (src/state/scrub.ts): the song pauses, the picture
 * follows the pointer (look, lyric line, how hard it hits), and a song that was playing plays on
 * from where you let go. A click jumps straight there. Near a part's start or a drop the pointer
 * snaps onto it, so a click lands on the downbeat rather than a hair before it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import type { TrackAnalysis } from '../core/types';
import { onFrame } from '../state/live';
import { sectionIndexAt, sectionNames } from '../state/plan';
import { beginScrub, endScrub, isScrubbing, scrubTo, showMoment } from '../state/scrub';
import { originalOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { dropList, fmtTime } from './song';

/** how close (px) the pointer has to be to a part's start or a drop to snap onto it */
const SNAP_PX = 7;
/** ← → step, in seconds */
export const SEEK_STEP = 5;

/** part names per analysis, worked out once (the frame loop asks every frame) */
const nameCache = new WeakMap<TrackAnalysis['sections'], string[]>();
function namesOf(secs: TrackAnalysis['sections']): string[] {
  let v = nameCache.get(secs);
  if (!v) nameCache.set(secs, (v = sectionNames(secs)));
  return v;
}

/**
 * The song's own sections, as Hum heard them. Every shot of a video is its own part (flatPlan.ts), but
 * the marks, the names and Shift ← / → go by the song's sections (Intro, Verse, Drop…), not by shot.
 */
function song(): TrackAnalysis | null {
  const a = useStudio.getState().analysis;
  return a ? originalOf(a) : null;
}

const duration = () => {
  const a = useStudio.getState().analysis;
  return a?.duration || audioEngine.frame.duration || 0;
};

/** move by `by` seconds (← / →): the picture follows even while paused */
export function seekBy(by: number) {
  if (audioEngine.kind !== 'file') return;
  const d = duration();
  if (!d) return;
  showMoment(Math.max(0, Math.min(d - 0.05, audioEngine.currentTime + by)));
}

/**
 * The previous or next section of the song (Shift ← / →). Back works like a music player's back
 * button: more than two seconds into a section goes to its start, otherwise to the one before.
 */
export function jumpPart(dir: 1 | -1) {
  if (audioEngine.kind !== 'file') return;
  const secs = song()?.sections ?? [];
  if (!secs.length) return seekBy(dir * SEEK_STEP * 3);
  const t = audioEngine.currentTime;
  const i = sectionIndexAt(secs, t);
  let j: number;
  if (dir < 0) j = t - secs[i].start > 2 || i === 0 ? i : i - 1;
  else j = i + 1;
  if (j >= secs.length) return;
  showMoment(secs[j].start + 0.01);
  useStudio.getState().flash(namesOf(secs)[j]);
}

/** `t` is where the mark sits, `at` where a click on it lands: just past it, so a paused stage shows the new part's look */
type Mark = { t: number; kind: 'part' | 'drop'; at: number };

/** the places a click snaps to: each part's start (after the first) and each drop */
function marksOf(a: TrackAnalysis | null): Mark[] {
  if (!a?.sections.length) return [];
  const marks: Mark[] = a.sections.slice(1).map((s) => ({ t: s.start, kind: 'part', at: s.start + 0.01 }));
  for (const d of dropList(a)) marks.push({ t: d.t, kind: 'drop', at: d.t + 0.01 });
  return marks;
}

export function SeekBar({ onDragChange }: { onDragChange?: (dragging: boolean) => void }) {
  const cut = useStudio((s) => s.analysis);
  const analysis = cut ? originalOf(cut) : null;
  const el = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x0: number; moved: boolean; t: number; id: number } | null>(null);
  const dragT = useRef<number | null>(null);
  const seekRaf = useRef(0);

  const secs = analysis?.sections ?? [];
  const names = namesOf(secs);
  const marks = useMemo(() => marksOf(analysis), [analysis]);
  const drops = useMemo(() => (analysis ? dropList(analysis) : []), [analysis]);
  const d = analysis?.duration ?? 0;

  // gaps in the line where one part ends and the next begins
  const mask = useMemo(() => {
    if (!analysis || analysis.sections.length < 2) return undefined;
    const stops = ['#000 0'];
    for (const s of analysis.sections.slice(1)) {
      const p = (s.start / analysis.duration) * 100;
      stops.push(`#000 calc(${p}% - 1px)`, `transparent calc(${p}% - 1px)`, `transparent calc(${p}% + 1px)`, `#000 calc(${p}% + 1px)`);
    }
    stops.push('#000 100%');
    const g = `linear-gradient(to right, ${stops.join(', ')})`;
    return { maskImage: g, WebkitMaskImage: g };
  }, [analysis]);

  // the line, the knob and the numbers follow the song every frame (written straight to the page)
  useEffect(() => {
    let last = '';
    let lastSec = -1;
    return onFrame(() => {
      const dur = duration();
      const t = dragT.current ?? audioEngine.currentTime;
      const p = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 0;
      const v = (Math.round(p * 10000) / 100).toFixed(2);
      if (v !== last) {
        last = v;
        if (fill.current) fill.current.style.transform = `scaleX(${p})`;
        if (knob.current) knob.current.style.left = `${v}%`;
      }
      const sec = Math.floor(t);
      const box = el.current;
      if (box && sec !== lastSec) {
        lastSec = sec;
        const a = song();
        const part = a?.sections.length ? namesOf(a.sections)[sectionIndexAt(a.sections, t)] : '';
        box.setAttribute('aria-valuenow', String(sec));
        box.setAttribute('aria-valuemax', String(Math.round(dur)));
        box.setAttribute('aria-valuetext', `${fmtTime(t)} of ${fmtTime(dur)}${part ? `, ${part}` : ''}`);
      }
    });
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(seekRaf.current);
      if (isScrubbing()) endScrub(audioEngine.currentTime);
    },
    [],
  );

  /** the song time under the pointer, snapped onto a nearby part start or drop */
  const timeAt = (clientX: number, snap = true): { t: number; at: number; x: number; w: number } => {
    const r = el.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    const dur = d || duration();
    const t = dur > 0 ? (x / r.width) * dur : 0;
    if (snap && dur > 0) {
      let best: Mark | null = null;
      let bestPx = SNAP_PX;
      for (const m of marks) {
        const px = Math.abs((m.t / dur) * r.width - x);
        // a drop on a part's start wins: it's the moment people aim for
        if (px < bestPx || (best && px === bestPx && m.kind === 'drop')) {
          best = m;
          bestPx = px;
        }
      }
      if (best) return { t: best.t, at: best.at, x: (best.t / dur) * r.width, w: r.width };
    }
    return { t, at: t, x, w: r.width };
  };

  /** the stage shows t: through a scrub while one runs, else (a live recording keeps playing) a plain seek */
  const follow = (t: number) => {
    dragT.current = t;
    if (isScrubbing()) return scrubTo(t);
    cancelAnimationFrame(seekRaf.current);
    seekRaf.current = requestAnimationFrame(() => audioEngine.seek(t));
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || audioEngine.kind !== 'file') return;
    e.preventDefault();
    el.current?.setPointerCapture(e.pointerId);
    const p = timeAt(e.clientX);
    drag.current = { x0: e.clientX, moved: false, t: p.at, id: e.pointerId };
    dragT.current = p.at;
    setHover(p);
    setDragging(true);
    onDragChange?.(true);
    // a press jumps there at once, playing or not
    showMoment(p.at);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (e.pointerType !== 'touch' || g) setHover(timeAt(e.clientX, true));
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.abs(e.clientX - g.x0) < 3) return;
    if (!g.moved) beginScrub();
    g.moved = true;
    const p = timeAt(e.clientX);
    g.t = p.at;
    follow(p.at);
  };
  const finish = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(seekRaf.current);
    if (g.moved) {
      if (isScrubbing()) endScrub(g.t);
      else audioEngine.seek(g.t);
    }
    dragT.current = null;
    setDragging(false);
    onDragChange?.(false);
    if (e.pointerType === 'touch') setHover(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const dur = duration();
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      if (e.shiftKey) jumpPart(1);
      else seekBy(SEEK_STEP);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      if (e.shiftKey) jumpPart(-1);
      else seekBy(-SEEK_STEP);
    } else if (e.key === 'PageDown') jumpPart(1);
    else if (e.key === 'PageUp') jumpPart(-1);
    else if (e.key === 'Home') showMoment(0);
    else if (e.key === 'End') showMoment(Math.max(0, dur - 1));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const tip = hover ?? null;
  const tipPart = tip && secs.length ? names[sectionIndexAt(secs, tip.t + 0.01)] : '';
  const nearDrop = tip && d > 0 && drops.some((x) => Math.abs((x.t / d) * tip.w - tip.x) < 1);
  const tipX = tip ? Math.max(44, Math.min(tip.w - 44, tip.x)) : 0;
  const hoverSec = tip && secs.length ? secs[sectionIndexAt(secs, tip.t + 0.01)] : null;

  return (
    <div
      ref={el}
      className={`seek ${dragging ? 'dragging' : ''} ${tip ? 'hovering' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Song position"
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={0}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={(e) => !drag.current && e.pointerType !== 'touch' && setHover(null)}
      onKeyDown={onKey}
    >
      <div className="seek-rail" style={mask}>
        <div className="seek-bg" />
        {hoverSec && d > 0 && (
          <div className="seek-part" style={{ left: `${(hoverSec.start / d) * 100}%`, width: `${((hoverSec.end - hoverSec.start) / d) * 100}%` }} />
        )}
        <div className="seek-fill" ref={fill} />
      </div>
      {d > 0 &&
        drops.map((x, i) => (
          <i key={i} className={`seek-drop ${x.strength >= 0.7 ? 'big' : ''}`} style={{ left: `${(x.t / d) * 100}%`, ['--s' as string]: String(0.45 + 0.55 * x.strength) }} />
        ))}
      <div className="seek-knob" ref={knob} />
      {tip && (
        <div className="seek-tip" style={{ left: tipX }} aria-hidden>
          {(nearDrop || tipPart) && <b>{nearDrop ? (tipPart && tipPart.startsWith('Drop') ? tipPart : `Drop · ${tipPart}`) : tipPart}</b>}
          <span>{fmtTime(tip.t)}</span>
        </div>
      )}
    </div>
  );
}

/** "1:23 / 3:45 · Verse 2", kept fresh without re-rendering */
export function SeekTime() {
  const time = useRef<HTMLSpanElement>(null);
  const part = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onFrame(() => {
        const live = audioEngine.kind === 'mic';
        const t = audioEngine.currentTime;
        const text = live ? 'Live' : `${fmtTime(t)} / ${fmtTime(duration())}`;
        if (time.current && time.current.textContent !== text) time.current.textContent = text;
        const a = song();
        const p = !live && a?.sections.length ? namesOf(a.sections)[sectionIndexAt(a.sections, t)] : '';
        if (part.current && part.current.textContent !== p) part.current.textContent = p;
      }),
    [],
  );
  return (
    <span className="pb-time">
      <span ref={time}>0:00 / 0:00</span>
      <span className="pb-part" ref={part} />
    </span>
  );
}
