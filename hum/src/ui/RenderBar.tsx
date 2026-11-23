/**
 * The render timeline's controls. "Render" (top bar, or by the song map) turns the map into a picker:
 * drag across it to choose a stretch (it snaps to bars and to the parts' edges; hold ⌥ for beats),
 * double-click a part to take the whole part, or use Best part / Whole song. Dragging scrubs: the
 * stage shows the moment under the edge being moved. The meter row underneath becomes the render
 * row: start and end (each settable to the playhead, I / O), which sizes, 30 or 60 fps, and the
 * button. While it renders the row is a progress bar, and the stage shows the frames as they're made.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { audioEngine } from '../audio/engine';
import { pickClip } from '../audio/clipWindow';
import { beatOffset } from '../audio/frameDsp';
import type { TrackAnalysis } from '../core/types';
import { sectionIndexAt, sectionNames } from '../state/plan';
import { useStudio } from '../state/store';
import { cancelRender, RENDER_SIZES, renderBlocker, renderVideos, setRenderPreview, type RenderSize } from '../render/timeline';
import { beginScrub, endScrub, scrubTo, showMoment } from '../state/scrub';
import './render.css';

type SizeId = RenderSize['id'];

interface RenderMode {
  on: boolean;
  /** the chosen stretch (s); null until something is picked */
  range: { start: number; end: number; label: string } | null;
  /** the song the range belongs to (a new song clears it) */
  forSong: number;
  sizes: SizeId[];
  fps: 30 | 60;
  /** while an edge is being dragged: which one, and where (the stage shows that moment) */
  scrub: { edge: 'start' | 'end'; t: number } | null;
}

const SAVE_KEY = 'hum.render';
function loadPrefs(): Pick<RenderMode, 'sizes' | 'fps'> {
  try {
    const j = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}');
    const sizes = Array.isArray(j.sizes) ? j.sizes.filter((x: string) => RENDER_SIZES.some((s) => s.id === x)) : [];
    return { sizes: sizes.length ? sizes : ['9:16'], fps: j.fps === 60 ? 60 : 30 };
  } catch {
    return { sizes: ['9:16'], fps: 30 };
  }
}
function savePrefs(m: Pick<RenderMode, 'sizes' | 'fps'>) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ sizes: m.sizes, fps: m.fps }));
  } catch {
    /* private window */
  }
}

export const useRenderMode = create<RenderMode>(() => ({ on: false, range: null, forSong: 0, scrub: null, ...loadPrefs() }));

const fmtLen = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

function bestPart(a: TrackAnalysis) {
  const w = pickClip(a);
  return { start: w.start, end: w.end, label: w.why };
}

/** turn render mode on or off (on: start from the best part if nothing is picked yet) */
export function toggleRenderMode() {
  const m = useRenderMode.getState();
  const a = useStudio.getState().analysis;
  if (m.on) {
    useRenderMode.setState({ on: false });
    return;
  }
  const fresh = !m.range || m.forSong !== a?.duration;
  useRenderMode.setState({ on: true, ...(fresh && a ? { range: bestPart(a), forSong: a.duration } : {}) });
}

/** where a dragged time lands: a part's edge when it's close, else the bar line (the beat with ⌥) */
function snap(a: TrackAnalysis, t: number, pxPerSec: number, fine: boolean): number {
  const d = a.duration;
  let best = Math.max(0, Math.min(d, t));
  let bestGap = 10 / pxPerSec;
  for (const s of a.sections) {
    for (const e of [s.start, s.end]) {
      if (Math.abs(e - t) < bestGap) {
        bestGap = Math.abs(e - t);
        best = e;
      }
    }
  }
  if (bestGap < 10 / pxPerSec) return best;
  const bpm = a.bpm > 40 && a.bpm < 240 ? a.bpm : 120;
  const unit = (60 / bpm) * (fine ? 1 : 4);
  const off = beatOffset(a, bpm);
  const g = off + Math.round((t - off) / unit) * unit;
  return Math.max(0, Math.min(d, g));
}

/** "0:24.3": a time to the tenth, for the in and out points (they snap to bars, not whole seconds) */
export const fmtPrecise = (t: number) => {
  const tt = Math.max(0, Math.round(t * 10) / 10);
  const m = Math.floor(tt / 60);
  const s = tt - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};

/** put the start at the playhead (I); an end that would come before it moves along, keeping the length */
export function setInAtPlayhead() {
  const a = useStudio.getState().analysis;
  if (!a) return;
  const d = a.duration;
  const t = Math.max(0, Math.min(d - 0.5, audioEngine.currentTime));
  const r = useRenderMode.getState().range;
  const len = r ? r.end - r.start : 15;
  const end = r && r.end - t >= 0.5 ? r.end : Math.min(d, t + len);
  useRenderMode.setState({ range: { start: t, end, label: 'your selection' }, forSong: d });
}

/** put the end at the playhead (O); a start that would come after it moves back, keeping the length */
export function setOutAtPlayhead() {
  const a = useStudio.getState().analysis;
  if (!a) return;
  const d = a.duration;
  const t = Math.max(0.5, Math.min(d, audioEngine.currentTime));
  const r = useRenderMode.getState().range;
  const len = r ? r.end - r.start : 15;
  const start = r && t - r.start >= 0.5 ? r.start : Math.max(0, t - len);
  useRenderMode.setState({ range: { start, end: t, label: 'your selection' }, forSong: d });
}

/**
 * Over the song map in render mode: the chosen stretch, with the rest dimmed. Drag across to choose,
 * drag an edge to adjust, drag the middle to move it: while dragging, the playhead and the stage
 * follow the edge being moved, like scrubbing in a video editor. A click moves the playhead (to play
 * from there); a double-click takes the whole part.
 */
export function RangeOverlay({ a }: { a: TrackAnalysis }) {
  const range = useRenderMode((s) => s.range);
  const scrub = useRenderMode((s) => s.scrub);
  const busy = useStudio((s) => !!s.clip);
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'new' | 'start' | 'end' | 'move'; x0: number; t0: number; s0: number; e0: number; moved: boolean } | null>(null);
  const d = a.duration;

  const timeAt = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    return { t: Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d, pps: r.width / d };
  };
  const setRange = (start: number, end: number, label: string) => {
    if (end - start < 0.5) return false;
    useRenderMode.setState({ range: { start, end, label }, forSong: d });
    return true;
  };
  /** the edge the stage shows while dragging */
  const follow = (edge: 'start' | 'end', t: number) => {
    useRenderMode.setState({ scrub: { edge, t } });
    scrubTo(t);
  };

  const onDown = (e: React.PointerEvent) => {
    if (busy || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { t, pps } = timeAt(e.clientX);
    const s0 = range?.start ?? t;
    const e0 = range?.end ?? t;
    // the grips are easier to catch with a finger
    const near = (e.pointerType === 'touch' ? 14 : 8) / pps;
    const mode = range && Math.abs(t - s0) < near ? 'start' : range && Math.abs(t - e0) < near ? 'end' : range && t > s0 && t < e0 ? 'move' : 'new';
    drag.current = { mode, x0: e.clientX, t0: t, s0, e0, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    if (!g.moved && Math.abs(e.clientX - g.x0) < 4) return;
    if (!g.moved) beginScrub();
    g.moved = true;
    const { t, pps } = timeAt(e.clientX);
    const sn = (x: number) => snap(a, x, pps, e.altKey);
    if (g.mode === 'new') {
      const p = sn(g.t0);
      const q = sn(t);
      if (setRange(Math.min(p, q), Math.max(p, q), 'your selection')) follow(q < p ? 'start' : 'end', q);
    } else if (g.mode === 'start') {
      const s = Math.min(sn(t), g.e0 - 0.5);
      setRange(s, g.e0, 'your selection');
      follow('start', s);
    } else if (g.mode === 'end') {
      const en = Math.max(sn(t), g.s0 + 0.5);
      setRange(g.s0, en, 'your selection');
      follow('end', en);
    } else {
      const len = g.e0 - g.s0;
      const s = Math.max(0, Math.min(d - len, sn(g.s0 + (t - g.t0))));
      setRange(s, s + len, 'your selection');
      follow('start', s);
    }
  };
  const finish = () => {
    const sc = useRenderMode.getState().scrub;
    useRenderMode.setState({ scrub: null });
    if (!sc) {
      endScrub(audioEngine.currentTime);
      return;
    }
    // playing on after an edit: from the start, or a couple of seconds before the end to hear it land
    const r = useRenderMode.getState().range;
    const resume = sc.edge === 'end' && r ? Math.max(r.start, sc.t - END_PREROLL) : sc.t;
    endScrub(sc.t, resume);
  };
  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g) return;
    if (g.moved) {
      finish();
      return;
    }
    // a click: move the playhead there, like anywhere else on the song map
    showMoment(timeAt(e.clientX).t);
  };
  const onDouble = (e: React.MouseEvent) => {
    if (busy) return;
    const { t } = timeAt(e.clientX);
    const i = sectionIndexAt(a.sections, t);
    const sec = a.sections[i];
    if (sec) setRange(sec.start, sec.end, sectionNames(a.sections)[i]);
  };

  const l = range ? (range.start / d) * 100 : 0;
  const w = range ? ((range.end - range.start) / d) * 100 : 0;
  return (
    <div
      className={`rg ${busy ? 'busy' : ''} ${scrub ? 'scrubbing' : ''}`}
      ref={el}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        if (drag.current?.moved) finish();
        drag.current = null;
      }}
      onDoubleClick={onDouble}
      title={busy ? undefined : 'Drag to pick a stretch · click to move the playhead · double-click a part to take all of it'}
    >
      {range ? (
        <>
          <div className="rg-dim" style={{ left: 0, width: `${l}%` }} />
          <div className="rg-dim" style={{ left: `${l + w}%`, right: 0 }} />
          <div className="rg-sel" style={{ left: `${l}%`, width: `${w}%` }}>
            <i className={`rg-h l ${scrub?.edge === 'start' ? 'on' : ''}`} />
            <i className={`rg-h r ${scrub?.edge === 'end' ? 'on' : ''}`} />
            <span className={`rg-tag ${w < 14 ? 'out' : ''}`}>
              {fmtPrecise(range.start)}–{fmtPrecise(range.end)} · {fmtLen(range.end - range.start)}
            </span>
          </div>
        </>
      ) : (
        <div className="rg-dim" style={{ left: 0, right: 0 }} />
      )}
    </div>
  );
}

/** after dragging the end, playback picks up this far before it, so you hear the clip end */
const END_PREROLL = 2.5;

/** the row under the song map in render mode: quick picks, sizes, frame rate, Render (or the progress while it runs) */
export function RenderBar() {
  useInOutKeys();
  const a = useStudio((s) => s.analysis);
  const clip = useStudio((s) => s.clip);
  const blocked = useStudio((s) => renderBlocker({ ...s, clip: null }));
  const { range, sizes, fps } = useRenderMode();

  // a new song: start over from its best part
  useEffect(() => {
    const m = useRenderMode.getState();
    if (a && m.forSong !== a.duration) useRenderMode.setState({ range: bestPart(a), forSong: a.duration });
  }, [a]);

  if (clip && clip.count !== undefined) {
    const which = RENDER_SIZES.find((z) => `${z.w}×${z.h}` === clip.size);
    return (
      <div className="rb rb-run">
        <div className="rb-bar">
          <i style={{ transform: `scaleX(${clip.phase === 'prep' ? 0 : clip.frac})` }} />
          <span>
            {clip.phase === 'prep' ? 'Getting ready…' : `Rendering ${which?.id ?? clip.size}${clip.count > 1 ? ` · ${(clip.index ?? 0) + 1} of ${clip.count}` : ''} · ${Math.round(clip.frac * 100)}%`}
          </span>
        </div>
        <span className="rb-hint">Esc cancels</span>
        <button className="btn sm" onClick={cancelRender}>
          Cancel
        </button>
      </div>
    );
  }

  const chosen = RENDER_SIZES.filter((z) => sizes.includes(z.id));
  const toggleSize = (id: SizeId) => {
    const next = sizes.includes(id) ? sizes.filter((x) => x !== id) : RENDER_SIZES.map((z) => z.id).filter((x) => x === id || sizes.includes(x));
    useRenderMode.setState({ sizes: next });
    savePrefs({ sizes: next, fps });
  };
  const setFps = (v: 30 | 60) => {
    useRenderMode.setState({ fps: v });
    savePrefs({ sizes, fps: v });
  };
  const go = () => {
    if (!range || !chosen.length || clip) return;
    void renderVideos({ start: range.start, end: range.end, sizes: chosen, fps, label: range.label });
  };
  const why = blocked ?? (!range ? 'Drag across the song to pick a stretch' : !chosen.length ? 'Pick at least one size' : null);
  const what = range ? (range.label === 'your selection' ? 'Your selection' : cap(range.label)) : '';

  return (
    <div className="rb" tabIndex={-1} aria-label="Render a stretch of the song">
      <div className="rb-picks">
        <button className="btn sm" disabled={!a} onClick={() => a && useRenderMode.setState({ range: bestPart(a), forSong: a.duration })} title="The strongest 15–30 s: the biggest drop or hook">
          Best part
        </button>
        <button className="btn sm" disabled={!a} onClick={() => a && useRenderMode.setState({ range: { start: 0, end: a.duration, label: 'the whole song' }, forSong: a.duration })}>
          Whole song
        </button>
        {range ? (
          <div className="rb-io" role="group" aria-label="Start and end">
            <InOut edge="start" t={range.start} />
            <InOut edge="end" t={range.end} />
            <span className="rb-len" title={what}>
              {fmtLen(range.end - range.start)}
              <span className="rb-what"> · {what}</span>
            </span>
          </div>
        ) : (
          <span className="rb-hint">Drag across the song, or double-click a part</span>
        )}
      </div>
      <div className="rb-opts">
        <div className="rb-sizes" role="group" aria-label="Sizes">
          {RENDER_SIZES.map((z) => (
            <label key={z.id} className={`rb-size ${sizes.includes(z.id) ? 'on' : ''}`} title={`${z.w}×${z.h} · ${z.hint}`}>
              <input type="checkbox" checked={sizes.includes(z.id)} onChange={() => toggleSize(z.id)} />
              <i className="rb-shape" style={{ aspectRatio: `${z.w} / ${z.h}` }} />
              {z.id}
            </label>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Frame rate">
          {([30, 60] as const).map((v) => (
            <button key={v} className={fps === v ? 'on' : ''} onClick={() => setFps(v)}>
              {v} fps
            </button>
          ))}
        </div>
        <button className="btn primary sm rb-go has-tip tip-left" disabled={!!why} data-tip={why ?? `Makes ${chosen.length === 1 ? 'an MP4' : `${chosen.length} MP4s, one after another`}. Nothing plays while it works, and every size shows exactly the same moments.`} onClick={go}>
          Render {chosen.length > 1 ? `${chosen.length} videos` : 'video'}
        </button>
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One end of the stretch: its time (click to see that moment on the stage) and Set, which moves it
 * to the playhead (I for the start, O for the end, as in video editors).
 */
function InOut({ edge, t }: { edge: 'start' | 'end'; t: number }) {
  const start = edge === 'start';
  return (
    <span className="rb-mark">
      <button className="rb-time has-tip" data-tip={`Show the ${edge} on the stage`} onClick={() => showMoment(t)}>
        <span className="rb-k">{start ? 'Start' : 'End'}</span>
        {fmtPrecise(t)}
      </button>
      <button
        className="rb-set has-tip"
        data-tip={`${start ? 'Start' : 'End'} the video at the playhead  ${start ? 'I' : 'O'}`}
        aria-label={`Set the ${edge} to the playhead`}
        onClick={start ? setInAtPlayhead : setOutAtPlayhead}
      >
        <PinIcon flip={!start} />
      </button>
    </span>
  );
}

/** a bracket with the playhead line: "set this end here" */
function PinIcon({ flip }: { flip: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M6 2.5H3.5v11H6" />
      <path d="M10 2v12" />
    </svg>
  );
}

/** I and O while the render row is open (not while typing, not during a render) */
export function useInOutKeys() {
  const on = useRenderMode((s) => s.on);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (useStudio.getState().clip || !useStudio.getState().analysis) return;
      const k = e.key.toLowerCase();
      if (k !== 'i' && k !== 'o') return;
      e.preventDefault();
      if (k === 'i') setInAtPlayhead();
      else setOutAtPlayhead();
      const r = useRenderMode.getState().range;
      if (r) useStudio.getState().flash(`${k === 'i' ? 'Start' : 'End'} set to ${fmtPrecise(k === 'i' ? r.start : r.end)}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
}

/** over the stage while a render runs: the frames as they're made */
export function RenderPreview({ size }: { size: string }) {
  const c = useRef<HTMLCanvasElement>(null);
  const [dims] = useState(() => {
    const [w, h] = size.split('×').map(Number);
    const s = Math.min(640 / (w || 16), 640 / (h || 9));
    return { w: Math.round((w || 16) * s), h: Math.round((h || 9) * s) };
  });
  useEffect(() => {
    const el = c.current!;
    const g = el.getContext('2d');
    if (g) {
      g.fillStyle = '#111';
      g.fillRect(0, 0, el.width, el.height);
    }
    setRenderPreview(el);
    return () => setRenderPreview(null);
  }, []);
  return <canvas className="render-preview" ref={c} width={dims.w} height={dims.h} />;
}
