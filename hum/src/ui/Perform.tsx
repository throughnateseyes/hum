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
import { playingPart } from '../state/flatPlan';
import { onFrame } from '../state/live';
import { Pause, Play, Shrink, X } from './Icons';
import { likeShot, skipShot } from './shotActions';
import { SeekBar, SeekTime } from './SeekBar';
import { Volume } from './Volume';
import './performShot.css';

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
 * play / pause, the time and the part you're in, Like and Skip for the shot on screen (K, X), volume,
 * the frame and the way out. It shows on any
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
  const shownRef = useRef(shown);
  shownRef.current = shown;
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
    const onPointer = (e: PointerEvent) => {
      // a touch on the picture is a tap or a swipe (stageGestures.ts): a tap toggles the bar below
      if (e.pointerType === 'touch' && (e.target as HTMLElement).closest?.('.stage-frame')) return;
      wake(e.pointerType === 'touch' ? TOUCH_IDLE_MS : IDLE_MS);
    };
    const onStageTap = () => {
      if (shownRef.current && !dragging.current) {
        window.clearTimeout(timer.current);
        setShown(false);
      } else wake(TOUCH_IDLE_MS);
    };
    window.addEventListener('hum:stage-tap', onStageTap);
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
      window.removeEventListener('hum:stage-tap', onStageTap);
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
        <ShotButtons />
        <Volume dark />
        <FramePicker tipBelow={false} />
        <button className="btn icon ghost pb-exit has-tip tip-left" data-tip="Exit full screen  Esc" aria-label="Exit full screen" onClick={exitPerform}>
          <Shrink width={16} height={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * Like (K) and Skip (X) for the shot on screen, while performing: a skip changes only that shot's look,
 * a like keeps it (shotActions.ts). The heart is filled while the shot playing is liked.
 */
function ShotButtons() {
  const plan = useStudio((s) => s.plan);
  const [part, setPart] = useState(() => playingPart());
  useEffect(
    () =>
      onFrame(() => {
        const i = playingPart();
        setPart((p) => (p === i ? p : i));
      }),
    [],
  );
  if (!plan || part < 0) return null;
  const liked = !!plan.liked?.[part];
  return (
    <div className="pb-shot" role="group" aria-label="This shot">
      <button className={`btn ghost pb-like has-tip ${liked ? 'on' : ''}`} data-tip={liked ? 'Liked. Press again to take it back  K' : 'Like this shot: it stays as it is  K'} aria-pressed={liked} onClick={likeShot}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 20s-7-4.4-9.2-8.7C1.3 8.2 3 4.8 6.4 4.4c2-.2 3.6.9 4.6 2.5 1-1.6 2.6-2.7 4.6-2.5 3.4.4 5.1 3.8 3.6 6.9C19 15.6 12 20 12 20z"
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
        <span>Like</span>
        <kbd>K</kbd>
      </button>
      <button className="btn ghost pb-skip has-tip" data-tip="Skip this shot: another look here, the rest stays  X" onClick={skipShot}>
        <X width={13} height={13} />
        <span>Skip</span>
        <kbd>X</kbd>
      </button>
    </div>
  );
}
