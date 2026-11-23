import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { audioEngine } from '../audio/engine';
import { LAYERS } from '../core/palettes';
import type { TrackAnalysis } from '../core/types';
import { historyLabels, onHistoryChange, redo, undo } from '../state/history';
import { onFrame } from '../state/live';
import { makeVideo, sectionIndexAt, sectionNames, validPlan } from '../state/plan';
import { originalOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { LAYER_MIME, Toggle } from './controls';
import { Pause, Play, Redo, Sparkle, Wave } from './Icons';
import { toggleBreakdown, useBreakdown } from './Breakdown';
import { fmtTime } from './song';
import { Volume } from './Volume';
import { MoodRow } from './Moods';
import { PartSheet } from './PartSheet';
import { Timeline } from './Timeline';
import { useLayout } from './layout';
import './timeline.css';

/**
 * The bottom of the app: the transport (play, time, the part playing, tempo, volume, Breakdown) and the
 * timeline (Timeline.tsx). The live layer meters show only while store.metersOpen is on (they are for
 * dragging a sound onto a slider). Make a video, the moods and the whole-video switches live in the
 * right panel's Video tab (VideoPanel.tsx).
 *
 * A phone keeps its own bottom: Make a video, Breakdown and undo / redo under the timeline, the mood
 * row under that, and the part sheet for a tapped part.
 */
export function Bottom() {
  const phone = useLayout((s) => s.phone);
  const meters = useStudio((s) => s.metersOpen);
  return (
    <div className="bottom">
      <TopRow />
      <Timeline side={phone ? <PhoneSide /> : undefined} />
      {phone && <MoodRow />}
      {!phone && meters && <LayerStrip />}
      {phone && <PartSheet />}
    </div>
  );
}

function TopRow() {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const planOn = useStudio((s) => s.planOn);
  const phone = useLayout((s) => s.phone);
  const bdOpen = useBreakdown((s) => s.open);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef<HTMLSpanElement>(null);
  const partRef = useRef<HTMLSpanElement>(null);
  const [tap, setTap] = useState<number[]>([]);
  const hasPlan = validPlan(plan, analysis);

  useEffect(
    () =>
      onFrame(() => {
        const p = audioEngine.playing;
        setPlaying((prev) => (prev !== p ? p : prev));
        const f = audioEngine.frame;
        const el = timeRef.current;
        // the text changes once a second: only touch the page when it does
        const text = audioEngine.kind === 'mic' ? 'Live' : `${fmtTime(f.time)} / ${fmtTime(f.duration)}`;
        if (el && el.textContent !== text) el.textContent = text;
        // the part playing
        const pe = partRef.current;
        const a = useStudio.getState().analysis;
        if (pe) {
          const name = a?.sections.length && audioEngine.kind === 'file' ? partName(a, audioEngine.currentTime) : '';
          if (pe.textContent !== name) pe.textContent = name;
        }
      }),
    [],
  );

  const onTap = () => {
    const now = performance.now();
    const t = [...tap.filter((x) => now - x < 2500), now];
    setTap(t);
    if (t.length >= 4) {
      const iv = (t[t.length - 1] - t[0]) / (t.length - 1);
      audioEngine.bpmOverride = Math.round(60000 / iv);
      useStudio.getState().flash(`Tempo locked to ${audioEngine.bpmOverride} bpm`);
    }
  };

  return (
    <div className="bt-row">
      <div className="bt-group">
        <button className="play" onClick={() => audioEngine.toggle()} disabled={!track || track.source === 'mic'} title="Play / pause (space)">
          {playing ? <Pause /> : <Play style={{ marginLeft: 2 }} />}
        </button>
        {phone && <Volume />}
        <span className="time" ref={timeRef}>
          0:00 / 0:00
        </span>
        <span className={`time bt-part ${phone ? 'part-now' : ''}`} ref={partRef} title="The part playing now" />
        {phone && hasPlan && (
          <label className="sw boxed has-tip" data-tip="On: the looks change with each part of the song, as Make a video planned. Off: one look stays until you pick another.">
            <Toggle on={planOn} onChange={(v) => useStudio.getState().set({ planOn: v, autoPilot: v ? false : useStudio.getState().autoPilot })} />
            Use video plan
          </label>
        )}
      </div>
      {!phone && (
        <div className="bt-group">
          <UndoRedo />
          <span className="time bpm" title="The song’s tempo">
            {analysis ? `${Math.round(analysis.bpm)} bpm` : audioEngine.frame.bpm ? `${Math.round(audioEngine.frame.bpm)} bpm` : '– bpm'}
          </span>
          <button className="btn sm has-tip" data-tip="Tap along 4+ times to set the tempo" onClick={onTap}>
            Tap tempo
          </button>
          <span className="bt-vol">
            <Volume />
          </span>
          <button
            className={`btn icon sm ghost bt-bd has-tip tip-left ${bdOpen ? 'on' : ''}`}
            disabled={!track}
            onClick={toggleBreakdown}
            aria-pressed={bdOpen}
            aria-label="Breakdown"
            data-tip="Breakdown: how Hum took the song apart, its bands, drums, bass, lead notes and drops (B)"
          >
            <Wave width={14} height={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Undo and redo (state/history.ts): small and quiet, faded when there's nothing to take back, and the
 * tooltip names the step. They stay hoverable when faded (aria-disabled, not disabled) so the tooltip
 * can say why nothing happens.
 */
function UndoRedo() {
  const { undo: u, redo: r } = useSyncExternalStore(onHistoryChange, historyLabels);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const key = mac ? '⌘' : 'Ctrl+';
  return (
    <span className="bt-hist" style={{ display: 'inline-flex', gap: 2 }}>
      <button
        className="btn icon sm ghost has-tip"
        aria-label={u ? `Undo: ${u}` : 'Nothing to undo'}
        aria-disabled={!u}
        style={u ? undefined : { opacity: 0.35, cursor: 'default' }}
        data-tip={u ? `Undo: ${u} (${key}Z)` : 'Nothing to undo yet'}
        onClick={undo}
      >
        <Redo width={14} height={14} style={{ transform: 'scaleX(-1)' }} />
      </button>
      <button
        className="btn icon sm ghost has-tip"
        aria-label={r ? `Redo: ${r}` : 'Nothing to redo'}
        aria-disabled={!r}
        style={r ? undefined : { opacity: 0.35, cursor: 'default' }}
        data-tip={r ? `Redo: ${r} (${mac ? '⇧⌘Z' : 'Ctrl+Y'})` : 'Nothing to redo'}
        onClick={redo}
      >
        <Redo width={14} height={14} />
      </button>
    </span>
  );
}

/** the phone's buttons under the timeline: Make a video, Breakdown, and undo / redo (state/history.ts) */
function PhoneSide() {
  const track = useStudio((s) => s.track);
  const bdOpen = useBreakdown((s) => s.open);
  const { undo: u, redo: r } = useSyncExternalStore(onHistoryChange, historyLabels);
  return (
    <>
      <MakeVideoButton />
      <button className={`btn tl-bd ${bdOpen ? 'on' : ''}`} disabled={!track} onClick={toggleBreakdown}>
        <Wave width={14} height={14} />
        Breakdown
      </button>
      <button className="btn icon ghost ph-hist" disabled={!u} aria-label={u ? `Undo: ${u}` : 'Nothing to undo'} onClick={undo}>
        <Redo width={18} height={18} style={{ transform: 'scaleX(-1)' }} />
      </button>
      <button className="btn icon ghost ph-hist" disabled={!r} aria-label={r ? `Redo: ${r}` : 'Nothing to redo'} onClick={redo}>
        <Redo width={18} height={18} />
      </button>
    </>
  );
}

/** the name of the part playing at t ("Chorus 2"), names worked out once per list of parts */
const partNames = new WeakMap<TrackAnalysis, string[]>();
function partName(a: TrackAnalysis, t: number): string {
  // the song's own section (Intro, Drop…), not the shot: every shot is a part of its own (flatPlan.ts)
  const song = originalOf(a);
  let names = partNames.get(song);
  if (!names) partNames.set(song, (names = sectionNames(song.sections)));
  return names[sectionIndexAt(song.sections, t)] ?? '';
}

/**
 * Make a video / Remake video: Claude gives every part of the song a look. The one primary button for
 * the whole video (the Video tab mounts it; the phone keeps it by its timeline).
 */
export function MakeVideoButton({ className = '' }: { className?: string }) {
  const analysis = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const planning = useStudio((s) => s.planning);
  const hasPlan = validPlan(plan, analysis);
  return (
    <button
      className={`btn primary tl-make has-tip tip-left ${className}`}
      disabled={planning || !analysis || !analysis.sections.length}
      onClick={() => void makeVideo('', { fresh: hasPlan })}
      data-tip={
        hasPlan
          ? 'Ask Claude for a fresh take on this song: new looks for every part, played from the top.'
          : 'Claude gives every part of the song a look (calm intro, big drops, the chorus coming back) and plays it from the top. A song you’ve made a video for before plays its saved video, free.'
      }
    >
      {planning ? <span className="spin" /> : <Sparkle width={13} height={13} />}
      {planning ? 'Planning…' : hasPlan ? 'Remake video' : 'Make a video'}
    </button>
  );
}

/* ───────────────────────── live layer meters ───────────────────────── */

function LayerStrip() {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const meterV: number[] = [];
    const meterHit: boolean[] = [];
    return onFrame(() => {
      const f = audioEngine.frame;
      LAYERS.forEach((l, i) => {
        const el = refs.current[i];
        if (!el) return;
        // a 1% step is invisible on a meter this size; when nothing moves (paused, silence) nothing is written
        const v = Math.round(Math.max(0, Math.min(1, f.layers[l.id] ?? 0)) * 100) / 100;
        const hit = (l.id === 'kick' && f.kick > 0.6) || (l.id === 'snare' && f.snare > 0.6) || (l.id === 'hat' && f.hat > 0.6) || (l.id === 'drop' && f.drop > 0.5);
        if (meterV[i] !== v) {
          meterV[i] = v;
          (el.children[0] as HTMLElement).style.transform = `scaleY(${v})`;
          (el.children[1] as HTMLElement).style.bottom = `${v * 100}%`;
        }
        if (meterHit[i] !== hit) el.classList.toggle('hit', (meterHit[i] = hit));
      });
    });
  }, []);
  return (
    <div className="layer-strip">
      {LAYERS.map((l, i) => (
        <div
          key={l.id}
          className="meter"
          ref={(el) => {
            refs.current[i] = el;
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(LAYER_MIME, l.id);
            e.dataTransfer.effectAllowed = 'link';
          }}
          title={`${l.label}: ${l.hint}. Drag onto a slider to route it.`}
        >
          <div className="fill" style={{ height: '100%', transform: 'scaleY(0)' }} />
          <div className="bar" style={{ bottom: 0 }} />
          <span className="lbl">{l.short}</span>
        </div>
      ))}
    </div>
  );
}
