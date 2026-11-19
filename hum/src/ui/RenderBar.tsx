/**
 * The render timeline's controls. "Render" by the song map turns the map into a picker: drag across
 * it to choose a stretch (it snaps to bars and to the parts' edges; hold ⌥ for beats), click a part to
 * take the whole part, or use Best part / Whole song. The meter row underneath becomes the render
 * row: which sizes, 30 or 60 fps, and the button. While it renders the row is a progress bar, and the
 * stage shows the frames as they're made.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { pickClip } from '../audio/clipWindow';
import { beatOffset } from '../audio/frameDsp';
import type { TrackAnalysis } from '../core/types';
import { sectionIndexAt, sectionNames } from '../state/plan';
import { useStudio } from '../state/store';
import { cancelRender, RENDER_SIZES, renderBlocker, renderVideos, setRenderPreview, type RenderSize } from '../render/timeline';
import { fmtTime } from './song';
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

export const useRenderMode = create<RenderMode>(() => ({ on: false, range: null, forSong: 0, ...loadPrefs() }));

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

/**
 * Over the song map in render mode: the chosen stretch, with the rest dimmed. Drag to choose, drag
 * an edge to adjust, drag the middle to move it, click a part to take that part.
 */
export function RangeOverlay({ a }: { a: TrackAnalysis }) {
  const range = useRenderMode((s) => s.range);
  const busy = useStudio((s) => !!s.clip);
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'new' | 'start' | 'end' | 'move'; x0: number; t0: number; s0: number; e0: number; moved: boolean } | null>(null);
  const d = a.duration;

  const timeAt = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    return { t: Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d, pps: r.width / d, x: clientX - r.left, w: r.width };
  };
  const setRange = (start: number, end: number, label: string) => {
    if (end - start < 0.5) return;
    useRenderMode.setState({ range: { start, end, label }, forSong: d });
  };

  const onDown = (e: React.PointerEvent) => {
    if (busy || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { t, pps } = timeAt(e.clientX);
    const s0 = range?.start ?? t;
    const e0 = range?.end ?? t;
    const near = 8 / pps;
    const mode = range && Math.abs(t - s0) < near ? 'start' : range && Math.abs(t - e0) < near ? 'end' : range && t > s0 && t < e0 ? 'move' : 'new';
    drag.current = { mode, x0: e.clientX, t0: t, s0, e0, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    if (!g.moved && Math.abs(e.clientX - g.x0) < 4) return;
    g.moved = true;
    const { t, pps } = timeAt(e.clientX);
    const sn = (x: number) => snap(a, x, pps, e.altKey);
    if (g.mode === 'new') {
      const p = sn(g.t0);
      const q = sn(t);
      setRange(Math.min(p, q), Math.max(p, q), 'your selection');
    } else if (g.mode === 'start') setRange(Math.min(sn(t), g.e0 - 0.5), g.e0, 'your selection');
    else if (g.mode === 'end') setRange(g.s0, Math.max(sn(t), g.s0 + 0.5), 'your selection');
    else {
      const len = g.e0 - g.s0;
      const s = Math.max(0, Math.min(d - len, sn(g.s0 + (t - g.t0))));
      setRange(s, s + len, 'your selection');
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g || g.moved) return;
    // a click: take the part under the pointer
    const { t } = timeAt(e.clientX);
    const i = sectionIndexAt(a.sections, t);
    const sec = a.sections[i];
    if (sec) setRange(sec.start, sec.end, sectionNames(a.sections)[i]);
  };

  const l = range ? (range.start / d) * 100 : 0;
  const w = range ? ((range.end - range.start) / d) * 100 : 0;
  return (
    <div className={`rg ${busy ? 'busy' : ''}`} ref={el} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (drag.current = null)}>
      {range ? (
        <>
          <div className="rg-dim" style={{ left: 0, width: `${l}%` }} />
          <div className="rg-dim" style={{ left: `${l + w}%`, right: 0 }} />
          <div className="rg-sel" style={{ left: `${l}%`, width: `${w}%` }}>
            <i className="rg-h l" />
            <i className="rg-h r" />
            <span className="rg-tag">
              {fmtTime(range.start)}–{fmtTime(range.end)} · {fmtLen(range.end - range.start)}
            </span>
          </div>
        </>
      ) : (
        <div className="rg-dim" style={{ left: 0, right: 0 }} />
      )}
    </div>
  );
}

/** the row under the song map in render mode: quick picks, sizes, frame rate, Render (or the progress while it runs) */
export function RenderBar() {
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

  return (
    <div className="rb">
      <div className="rb-picks">
        <button className="btn sm" disabled={!a} onClick={() => a && useRenderMode.setState({ range: bestPart(a), forSong: a.duration })} title="The strongest 15–30 s: the biggest drop or hook">
          Best part
        </button>
        <button className="btn sm" disabled={!a} onClick={() => a && useRenderMode.setState({ range: { start: 0, end: a.duration, label: 'the whole song' }, forSong: a.duration })}>
          Whole song
        </button>
        <span className="rb-hint">{range ? `${range.label === 'your selection' ? 'Your selection' : cap(range.label)} · ${fmtLen(range.end - range.start)}` : 'Drag across the song, or click a part'}</span>
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
