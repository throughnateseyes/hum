/**
 * Perform mode and the frame (aspect ratio) picker.
 *
 * Perform hides the panels and asks the browser for real fullscreen. Where the browser can't go
 * fullscreen (iPhone Safari only allows it for <video>), it stays a full-window view. Leaving
 * fullscreen with the browser's own Esc also leaves Perform.
 *
 * The frame can be switched any time, in the editor or while performing: the same look, plan and
 * lyrics, re-laid out for 16:9, 9:16, 4:5 or 1:1 (A cycles through them).
 */
import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { useStudio, type Aspect } from '../state/store';
import { Pause, Play, Shrink } from './Icons';
import { SeekBar, SeekTime } from './SeekBar';
import { Volume } from './Volume';

export const FRAMES: { id: Aspect; name: string; hint: string }[] = [
  { id: 'fill', name: 'Fill', hint: 'Fill the space' },
  { id: '16:9', name: '16:9', hint: 'Wide, for YouTube and screens' },
  { id: '9:16', name: '9:16', hint: 'Tall, for Reels, TikTok and Stories' },
  { id: '4:5', name: '4:5', hint: 'Portrait, for the feed' },
  { id: '1:1', name: '1:1', hint: 'Square' },
];

/* ───────────── fullscreen ───────────── */

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

function requestFs() {
  const el = document.documentElement as FsEl;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
    // no fullscreen here (iPhone, an iframe without allow): the full-window view is the fallback
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch {
    /* same fallback */
  }
}

function exitFs() {
  if (!fsElement()) return;
  const d = document as FsDoc;
  try {
    const p = document.exitFullscreen ? document.exitFullscreen() : d.webkitExitFullscreen?.();
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch {
    /* already out */
  }
}

/** must run inside a click or key press, or the browser refuses fullscreen */
export function enterPerform() {
  useStudio.getState().set({ perform: true });
  requestFs();
}

export function exitPerform() {
  useStudio.getState().set({ perform: false });
  exitFs();
}

export function togglePerform() {
  if (useStudio.getState().perform) exitPerform();
  else enterPerform();
}

/** keep Perform and the browser's fullscreen in step (the browser's Esc only ends fullscreen) */
export function usePerformSync() {
  useEffect(() => {
    const onChange = () => {
      if (!fsElement() && useStudio.getState().perform) useStudio.getState().set({ perform: false });
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
}

/* ───────────── frame ───────────── */

export function setFrame(id: Aspect) {
  const s = useStudio.getState();
  if (s.aspect === id) return;
  s.set({ aspect: id });
  const f = FRAMES.find((x) => x.id === id);
  s.flash(id === 'fill' ? 'Frame: fill' : `Frame: ${f?.name ?? id}`);
}

export function cycleFrame(dir = 1) {
  const i = FRAMES.findIndex((f) => f.id === useStudio.getState().aspect);
  setFrame(FRAMES[(i + dir + FRAMES.length) % FRAMES.length].id);
}

/** a small outline of the ratio, so the buttons read at a glance */
function FrameGlyph({ id }: { id: Aspect }) {
  const box: Record<Aspect, [number, number]> = { fill: [14, 10], '16:9': [16, 9], '9:16': [9, 16], '4:5': [11, 13.75], '1:1': [12, 12] };
  const [w, h] = box[id];
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      <rect
        x={(18 - w) / 2}
        y={(18 - h) / 2}
        width={w}
        height={h}
        rx={1.6}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={id === 'fill' ? '2.4 1.8' : undefined}
      />
    </svg>
  );
}

export function FramePicker({ labels = false, tipBelow = true }: { labels?: boolean; tipBelow?: boolean }) {
  const aspect = useStudio((s) => s.aspect);
  return (
    <div className="seg frame-seg" role="radiogroup" aria-label="Frame">
      {FRAMES.map((f) => (
        <button
          key={f.id}
          role="radio"
          aria-checked={aspect === f.id}
          aria-label={`${f.name}: ${f.hint}`}
          className={`has-tip ${tipBelow ? 'tip-below' : ''} ${aspect === f.id ? 'on' : ''}`}
          data-tip={`${f.name} · ${f.hint}  A`}
          onClick={() => setFrame(f.id)}
        >
          <FrameGlyph id={f.id} />
          {labels && <span>{f.name}</span>}
        </button>
      ))}
    </div>
  );
}

/* ───────────── controls while performing ───────────── */

/** the bar fades this long after the pointer last moved (a tap on a touch screen keeps it a little longer) */
const IDLE_MS = 2500;
const TOUCH_IDLE_MS = 3500;

/**
 * A slim bar along the bottom, video-player style: the seek line on top (see SeekBar), and under it
 * play / pause, the time and the part you're in, volume, the frame and the way out. It shows on any
 * mouse move, tap or key, fades after a moment of stillness or when the pointer leaves the window,
 * and hides the cursor with it. Only the page draws it: recordings and renders take the picture
 * from the canvas, so it never shows up in them.
 */
export function PerformControls() {
  const perform = useStudio((s) => s.perform);
  const clip = useStudio((s) => !!s.clip);
  const seekable = useStudio((s) => !!s.track && s.track.source !== 'mic');
  const [playing, setPlaying] = useState(audioEngine.playing);
  const [shown, setShown] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const dragging = useRef(false);
  const wakeRef = useRef<(ms?: number) => void>(() => {});

  useEffect(() => {
    if (!perform) return;
    const id = window.setInterval(() => setPlaying(audioEngine.playing), 250);
    return () => window.clearInterval(id);
  }, [perform]);

  useEffect(() => {
    if (!perform) return;
    const wake = (ms = IDLE_MS) => {
      setShown(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!hovering.current && !dragging.current) setShown(false);
      }, ms);
    };
    wakeRef.current = wake;
    const onPointer = (e: PointerEvent) => wake(e.pointerType === 'touch' ? TOUCH_IDLE_MS : IDLE_MS);
    const onKey = () => wake();
    // the pointer left the window: nothing to hover, so get out of the way
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget || dragging.current) return;
      window.clearTimeout(timer.current);
      hovering.current = false;
      setShown(false);
    };
    wake();
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    document.addEventListener('mouseout', onOut);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mouseout', onOut);
    };
  }, [perform]);

  useEffect(() => {
    document.documentElement.classList.toggle('perform-idle', perform && !shown);
    return () => document.documentElement.classList.remove('perform-idle');
  }, [perform, shown]);

  if (!perform) return null;
  return (
    <div
      className={`perform-bar ${shown ? 'shown' : ''}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') hovering.current = true;
      }}
      onPointerLeave={() => (hovering.current = false)}
    >
      {seekable && !clip && (
        <SeekBar
          onDragChange={(v) => {
            dragging.current = v;
            if (!v) wakeRef.current();
          }}
        />
      )}
      <div className="pb-row">
        <button
          className="btn icon ghost pb-play has-tip"
          data-tip={playing ? 'Pause  Space' : 'Play  Space'}
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={clip || !seekable}
          onClick={() => audioEngine.toggle()}
        >
          {playing ? <Pause width={16} height={16} /> : <Play width={16} height={16} />}
        </button>
        <SeekTime />
        <span className="spacer" />
        <Volume dark />
        <FramePicker tipBelow={false} />
        <button className="btn icon ghost pb-exit has-tip tip-left" data-tip="Exit full screen  Esc" aria-label="Exit full screen" onClick={exitPerform}>
          <Shrink width={16} height={16} />
        </button>
      </div>
    </div>
  );
}
