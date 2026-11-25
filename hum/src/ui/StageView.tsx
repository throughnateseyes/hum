import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Stage } from '../render/stage';
import { live } from '../state/live';
import { useStudio, type Aspect } from '../state/store';
import { LoadingStage, TapToPlay } from './Loading';
import { TasteHud } from './Taste';
import { Volume } from './Volume';
import { WelcomeLayer } from './Welcome';
import { fmtPrecise, RenderPreview, useRenderMode } from './RenderBar';
import { togglePerform } from './Perform';
import { ArrangeLayer } from './arrange/ArrangeLayer';
import { Expand, Shrink } from './Icons';
import { lastTouchTap, useStageGestures } from './stageGestures';
import { useStageUi } from './layout';
import { giveMedia, MEDIA_MIME, playingTarget } from './footageMedia';
import { partNames } from '../state/plan';

const RATIOS: Record<Exclude<Aspect, 'fill'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

export function StageView() {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const aspect = useStudio((s) => s.aspect);
  const perform = useStudio((s) => s.perform);
  const quality = useStudio((s) => s.quality);
  const clip = useStudio((s) => s.clip);
  const hasTrack = useStudio((s) => !!s.track);
  const scrub = useRenderMode((s) => s.scrub);
  const controls = useStageUi((s) => s.controls);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [dropOver, setDropOver] = useState(false);
  // touch: swipe for looks, swipe up for the panels, tap for the controls, double-tap for full screen
  useStageGestures(frame);

  useEffect(() => {
    const stage = new Stage(canvas.current!);
    live.stage = stage;
    // the layout effect may have measured before the stage existed
    const fr = frame.current!;
    stage.setSize(fr.clientWidth, fr.clientHeight);
    stage.start();
    return () => {
      live.stage = null;
      stage.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const fit = () => {
      const cs = getComputedStyle(el);
      const pw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ph = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      let w = pw;
      let h = ph;
      if (aspect !== 'fill') {
        const r = RATIOS[aspect];
        if (pw / ph > r) w = ph * r;
        else h = pw / r;
      }
      w = Math.max(2, Math.floor(w));
      h = Math.max(2, Math.floor(h));
      setSize({ w, h });
      live.stage?.setSize(w, h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, perform, quality]);

  return (
    <div className="stage-wrap" ref={wrap}>
      <div
        className={`stage-frame ${controls ? 'ctl' : ''}`}
        ref={frame}
        style={{ width: size.w, height: size.h }}
        // a clip or photo dragged from the Library: the picture of the part playing (or of the look)
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(MEDIA_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dropOver) setDropOver(true);
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropOver(false);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(MEDIA_MIME);
          setDropOver(false);
          if (!id) return;
          e.preventDefault();
          giveMedia(id, playingTarget(), e.metaKey || e.ctrlKey);
        }}
      >
        <canvas ref={canvas} />
        <LoadingStage />
        <TapToPlay />
        <TasteHud />
        {/* volume over the picture, shown while the pointer is on it (phones keep it in the play row) */}
        {hasTrack && !clip && (
          <div className="stage-vol">
            <Volume dark />
          </div>
        )}
        {/* a render draws off screen: show its frames here as they're made */}
        {clip?.count !== undefined && clip.size && <RenderPreview key={clip.size} size={clip.size} />}
        {hasTrack && !clip && <FullscreenButton frame={frame} perform={perform} />}
        <div className="stage-hud">
          {scrub && (
            <span className="hud-pill scrub">
              {scrub.edge === 'start' ? 'Start' : 'End'} · {fmtPrecise(scrub.t)}
            </span>
          )}
          {clip && (
            <span className="hud-pill rec">
              <i /> {clip.phase === 'prep' ? 'Getting ready' : clip.phase === 'save' ? 'Saving' : clip.count !== undefined ? 'Rendering' : 'Clip'} · {clip.size ?? '1080×1920'}
              {clip.count !== undefined && clip.count > 1 ? ` (${(clip.index ?? 0) + 1} of ${clip.count})` : ''} · Esc cancels
            </span>
          )}
        </div>
        <ArrangeLayer />
        <LookToast />
        <WelcomeLayer />
        {dropOver && <StageDrop />}
      </div>
    </div>
  );
}

/** over the stage while a clip or photo is dragged onto it: where it will go */
function StageDrop() {
  const t = playingTarget();
  const a = useStudio.getState().analysis;
  const where = t === 'solo' || !a ? 'this look' : partNames(a)[t.parts[0]];
  return (
    <div className="stage-drop" aria-hidden>
      <span>Make it the picture of {where}</span>
    </div>
  );
}

/** the light note a swipe leaves: the look's name (and its take), sliding in from the swipe's side */
function LookToast() {
  const look = useStageUi((s) => s.look);
  if (!look) return null;
  return (
    <div key={look.key} className={`look-toast ${look.dir > 0 ? 'from-right' : 'from-left'}`} aria-live="polite">
      <b>{look.name}</b>
      {look.sub && <span>{look.sub}</span>}
    </div>
  );
}

/** controls on the stage fade out after this long without the pointer moving */
const IDLE_MS = 2200;

/**
 * Full screen, YouTube style: a button in the picture's top-right corner that fades in when the
 * pointer moves over the stage (a tap on a touch screen) and out again when it rests. Double-click
 * the picture or press F for the same thing. It is Perform: real fullscreen where the browser allows
 * it, a full-window view where it doesn't (iPhone).
 */
function FullscreenButton({ frame, perform }: { frame: RefObject<HTMLDivElement | null>; perform: boolean }) {
  const [hovered, setShown] = useState(false);
  // a touch screen: a tap on the picture shows it with the other controls (stageGestures.ts)
  const tapped = useStageUi((s) => s.controls);
  const shown = hovered || tapped;
  const timer = useRef<number | undefined>(undefined);
  const over = useRef(false);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wake = (ms = IDLE_MS) => {
      setShown(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => !over.current && setShown(false), ms);
    };
    const onMove = (e: PointerEvent) => e.pointerType !== 'touch' && wake();
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      window.clearTimeout(timer.current);
      setShown(false);
    };
    // double-click the picture (not a button or card on it) to go full screen and back
    const onDouble = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('button, a, input, textarea, select, label, .welcome, .taste-hud, .stage-vol, .arr')) return;
      // a double-tap is handled by the touch gestures already
      if (Date.now() - lastTouchTap < 700) return;
      e.preventDefault();
      togglePerform();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('dblclick', onDouble);
    return () => {
      window.clearTimeout(timer.current);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('dblclick', onDouble);
    };
  }, [frame]);

  const label = perform ? 'Exit full screen' : 'Full screen';
  return (
    <button
      className={`stage-fs has-tip tip-below tip-end ${shown ? 'shown' : ''}`}
      data-tip={perform ? 'Exit full screen  Esc' : 'Full screen  F · or double-click the picture'}
      aria-label={label}
      onPointerEnter={() => (over.current = true)}
      onPointerLeave={() => (over.current = false)}
      onClick={togglePerform}
    >
      {perform ? <Shrink width={18} height={18} /> : <Expand width={18} height={18} />}
    </button>
  );
}
