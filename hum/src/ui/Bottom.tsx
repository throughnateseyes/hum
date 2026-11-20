import { activeFinish, setFinish } from '../state/direction';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { LAYERS } from '../core/palettes';
import type { TrackAnalysis } from '../core/types';
import { onFrame } from '../state/live';
import { assignLook, findLook, interludeLength, makeVideo, partEdits, sectionIndexAt, sectionNames } from '../state/plan';
import { presetToLook } from '../presets/apply';
import { useStudio, type PopupMode } from '../state/store';
import { LAYER_MIME, Slider, Toggle } from './controls';
import { Film, Pause, Play, Plus, Sparkle, Wave } from './Icons';
import { LOOK_MIME, STATIC_THUMBS } from './Library';
import { peekHandlers } from './Peek';
import { noteHandPick } from '../state/taste';
import { toggleBreakdown, useBreakdown } from './Breakdown';
import { GROUP_INK, dropList, fmtTime, lookBg } from './song';
import { Volume } from './Volume';
import { RangeOverlay, RenderBar, toggleRenderMode, useRenderMode } from './RenderBar';
import { MoodRow } from './Moods';
import { PartSheet, togglePartSheet, usePartSheet } from './PartSheet';
import { openPanel, useLayout } from './layout';

/**
 * Three rows: the transport and the feel controls, one timeline (the song's parts with their looks
 * on top, the waveform under them, one playhead through both), and the live layer meters.
 */
export function Bottom() {
  // render mode: the song map picks a stretch and the meter row becomes the render row
  const rendering = useRenderMode((s) => s.on);
  // a phone keeps the render row in its Export panel (the meters are for dragging, which touch can't do)
  const phone = useLayout((s) => s.phone);
  return (
    <div className="bottom">
      <TopRow />
      <Timeline />
      {!rendering && <MoodRow />}
      {phone ? null : rendering ? <RenderBar /> : <LayerStrip />}
      <PartSheet />
    </div>
  );
}

/** how hard it reacts, the hand-drawn finish and the pop-ups (the phone shows them in Look settings) */
export function FeelControls() {
  return (
    <>
      <ImpactKnob />
      <HandToggle />
      <OverlaysSwitch />
    </>
  );
}

function TopRow() {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const planOn = useStudio((s) => s.planOn);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef<HTMLSpanElement>(null);
  const partRef = useRef<HTMLSpanElement>(null);
  const [tap, setTap] = useState<number[]>([]);
  const hasPlan = !!plan && !!analysis && plan.looks.length === analysis.sections.length;

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
        // the part playing (shown on phones, where the song map's names get small)
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
        <Volume />
        <span className="time" ref={timeRef}>
          0:00 / 0:00
        </span>
        <span className="time part-now" ref={partRef} />
        <span className="time bpm">{analysis ? `${Math.round(analysis.bpm)} bpm` : audioEngine.frame.bpm ? `${Math.round(audioEngine.frame.bpm)} bpm` : '– bpm'}</span>
        <button className="btn sm has-tip" data-tip="Tap along 4+ times to set the tempo" onClick={onTap}>
          Tap tempo
        </button>
        {hasPlan && (
          <label className="sw boxed has-tip" data-tip="On: the looks change with each part of the song, as Make a video planned. Off: one look stays until you pick another.">
            <Toggle on={planOn} onChange={(v) => useStudio.getState().set({ planOn: v, autoPilot: v ? false : useStudio.getState().autoPilot })} />
            Use video plan
          </label>
        )}
      </div>
      <div className="bt-group feel">
        <ImpactKnob />
        <HandToggle />
        <OverlaysSwitch />
      </div>
    </div>
  );
}

/** the name of the part playing at t ("Chorus 2"), names worked out once per song */
const partNames = new WeakMap<TrackAnalysis, string[]>();
function partName(a: TrackAnalysis, t: number): string {
  let names = partNames.get(a);
  if (!names) partNames.set(a, (names = sectionNames(a.sections)));
  return names[sectionIndexAt(a.sections, t)] ?? '';
}

/* ───────────────────────── the timeline ───────────────────────── */

function Timeline() {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const analyzing = useStudio((s) => s.analyzing);
  const planning = useStudio((s) => s.planning);
  const plan = useStudio((s) => s.plan);
  const bdOpen = useBreakdown((s) => s.open);
  const renderOn = useRenderMode((s) => s.on);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(600);
  const secs = analysis?.sections ?? [];
  const hasPlan = !!plan && !!analysis && plan.looks.length === secs.length;

  useLayoutEffect(() => {
    const el = lane.current!;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // the waveform's size comes from a ResizeObserver, so the frame loop never reads layout
  const waveSize = useRef({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (waveSize.current = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    waveSize.current = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let lastLeft = '';
    let lastShow = '';
    return onFrame(() => {
      const f = audioEngine.frame;
      const d = analysis?.duration || f.duration;
      const t = audioEngine.kind === 'mic' ? 0 : audioEngine.currentTime;
      drawWave(canvas.current, waveSize.current, analysis, t, d);
      const el = head.current;
      if (el) {
        const show = d > 0 && audioEngine.kind !== 'mic' ? '' : 'none';
        const left = `${d > 0 ? Math.round((t / d) * 10000) / 100 : 0}%`;
        if (show !== lastShow) el.style.display = lastShow = show;
        if (left !== lastLeft) el.style.left = lastLeft = left;
      }
    });
  }, [analysis]);

  const seek = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = audioEngine.frame.duration;
    if (d) audioEngine.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d);
  };

  const drops = analysis ? dropList(analysis) : [];

  return (
    <div className="tl">
      <div className="tl-lane" ref={lane}>
        {analysis && secs.length > 0 ? (
          <SectionRow a={analysis} laneW={laneW} />
        ) : (
          <div className="tl-secs tl-placeholder">
            {!track
              ? 'Drop a song anywhere, or pick a demo. Its parts show up here.'
              : track.source === 'mic'
                ? 'Live input: parts and looks need a song file'
                : analyzing
                  ? 'Listening to the song…'
                  : 'No parts found in this song'}
          </div>
        )}
        <div className="tl-wave" onPointerDown={seek} onPointerMove={(e) => e.buttons & 1 && seek(e)} title="Click or drag to move through the song">
          <canvas ref={canvas} />
          {analysis &&
            drops.map((d, i) => (
              <button
                key={i}
                className={`tl-drop ${d.strength >= 0.7 ? 'big' : ''}`}
                style={{ left: `${(d.t / analysis.duration) * 100}%`, ['--s' as string]: String(0.35 + 0.65 * d.strength) }}
                title={`Drop at ${fmtTime(d.t)} · strength ${Math.round(d.strength * 100)}%${d.why ? ` · ${d.why}` : ''}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  audioEngine.seek(Math.max(0, d.t - 0.01));
                }}
              />
            ))}
        </div>
        <div className="tl-head" ref={head} />
        {renderOn && analysis && secs.length > 0 && <RangeOverlay a={analysis} />}
      </div>
      <div className="tl-side">
        <button
          className="btn primary tl-make has-tip tip-left"
          disabled={planning || !analysis || !secs.length}
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
        <button
          className={`btn tl-bd has-tip tip-left ${bdOpen ? 'on' : ''}`}
          disabled={!track}
          onClick={toggleBreakdown}
          data-tip="See how Hum took the song apart: waveform, bands, drums, bass and lead notes, drops (B)"
        >
          <Wave width={14} height={14} />
          Breakdown
        </button>
        <button
          className={`btn tl-render has-tip tip-left ${renderOn ? 'on' : ''}`}
          disabled={!analysis || !secs.length}
          onClick={() => {
            // a phone: the render row lives in the Export panel (the song map still shows the stretch)
            if (useLayout.getState().phone) {
              if (!useRenderMode.getState().on) toggleRenderMode();
              openPanel('export', 'peek');
            } else toggleRenderMode();
          }}
          data-tip="Pick a stretch of the song and make it into videos: the same moments at 9:16, 4:5, 1:1 or 16:9"
        >
          <Film width={14} height={14} />
          Render
        </button>
      </div>
    </div>
  );
}

/** what a look being dragged from the library would do if dropped here */
function useDraggedLook() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const start = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt?.types.includes(LOOK_MIME)) setId(dt.getData(LOOK_MIME) || null);
    };
    const end = () => setId(null);
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, []);
  return id;
}

/**
 * The song's parts, each a block as wide as the part. A block with a look shows that look's picture
 * and name; a block without one is a dashed empty slot. Drag a look from the library onto a block
 * to use it there (and in the parts that sound the same; hold ⌥ for just that part).
 */
function SectionRow({ a, laneW }: { a: TrackAnalysis; laneW: number }) {
  const plan = useStudio((s) => s.plan);
  useStudio((s) => s.customPresets.length);
  const dragId = useDraggedLook();
  const [over, setOver] = useState<{ i: number; alt: boolean } | null>(null);
  const blocks = useRef<(HTMLButtonElement | null)[]>([]);
  const secs = a.sections;
  const names = sectionNames(secs);
  const hasPlan = !!plan && plan.looks.length === secs.length;
  const looks = secs.map((_, i) => (hasPlan ? (plan!.looks[i] ?? null) : null));
  const dragLook = dragId ? findLook(dragId) : undefined;
  const dragging = !!dragId;
  const sheetAt = usePartSheet((s) => s.index);
  const partPops = useStudio((s) => s.partPops);
  const edits = partEdits(plan, a, partPops);

  useEffect(
    () =>
      onFrame(() => {
        const i = sectionIndexAt(secs, audioEngine.currentTime);
        blocks.current.forEach((el, j) => el?.classList.toggle('now', j === i));
      }),
    [secs],
  );

  useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);

  // mirrors assignLook: the target, the parts that sound alike and share its look, and every empty part
  const affected = (j: number) => {
    if (!over) return false;
    const i = over.i;
    if (j === i) return true;
    if (!looks[j]) return true;
    return !over.alt && secs[j].group === secs[i].group && looks[j] === looks[i];
  };
  const others = over ? secs.map((_, j) => j).filter((j) => j !== over.i && affected(j)) : [];
  const fills = others.filter((j) => !looks[j]).length;
  const alike = others.length - fills;

  return (
    <div className={`tl-secs ${dragging ? 'dragging' : ''}`}>
      {secs.map((sec, i) => {
        const look = findLook(looks[i]);
        const frac = (sec.end - sec.start) / a.duration;
        const px = frac * laneW;
        const size = px < 46 ? 'tiny' : px < 104 ? 'small' : '';
        const why = hasPlan ? (plan!.why[i] ?? '') : '';
        const g = sec.group % GROUP_INK.length;
        const preview = over && dragLook && affected(i) ? dragLook : undefined;
        const shown = preview ?? look;
        const interId = hasPlan ? plan!.interludes?.[i] : null;
        const inter = findLook(interId);
        const interFrac = inter ? Math.min(0.6, interludeLength(sec, a.bpm) / (sec.end - sec.start)) : 0;
        return (
          <button
            key={i}
            ref={(el) => {
              blocks.current[i] = el;
            }}
            className={`tl-sec ${shown ? 'filled' : 'empty'} ${size} ${preview ? 'preview' : ''} ${over?.i === i ? 'over' : ''} ${edits[i] ? 'edited' : ''} ${sheetAt === i ? 'open' : ''}`}
            style={{ flexGrow: sec.end - sec.start }}
            data-part={i}
            aria-haspopup="dialog"
            aria-expanded={sheetAt === i}
            title={`${names[i]} · ${fmtTime(sec.start)}–${fmtTime(sec.end)} · ${look ? look.name : 'no look yet'}${inter ? ` (opens with ${inter.name})` : ''}${edits[i] ? ' · changed by you' : ''}${why ? ` — ${why}` : ''} · click to change this part`}
            onClick={() => togglePartSheet(i)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(LOOK_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (over?.i !== i || over.alt !== e.altKey) setOver({ i, alt: e.altKey });
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o?.i === i ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData(LOOK_MIME);
              if (!id) return;
              const placed = findLook(id);
              if (placed) noteHandPick(placed, 'place', sec.label);
              assignLook(i, id, !e.altKey);
            }}
            {...(look && !dragging && sheetAt === null
              ? peekHandlers({
                  key: `sec:${i}:${look.id}`,
                  title: `${names[i]} · ${look.name}`,
                  hint: why || 'Click to change this part, or drag a look onto it',
                  poster: STATIC_THUMBS[look.id],
                  place: 'above',
                  getLook: () => (useStudio.getState().presetId === look.id ? null : presetToLook(look)),
                })
              : {})}
          >
            {shown && <span className="tl-pic" style={lookBg(shown)} />}
            {inter && !preview && <span className="tl-inter" style={{ width: `${interFrac * 100}%`, ...lookBg(inter) }} title={`Opens with ${inter.name} for a few bars`} />}
            {edits[i] && !preview && <span className="tl-edit" aria-label="changed by you" />}
            <span className="tl-name">
              <i style={{ background: GROUP_INK[g] }} />
              {size !== 'tiny' && <b>{names[i]}</b>}
            </span>
            {size !== 'tiny' && (
              <span className="tl-look">
                {shown ? (
                  shown.name
                ) : (
                  <>
                    <Plus width={11} height={11} />
                    {size ? 'Empty' : dragging ? 'Drop a look' : 'No look yet'}
                  </>
                )}
              </span>
            )}
          </button>
        );
      })}
      {over && dragLook && (
        <div className="tl-droptip" style={{ left: `${(((secs[over.i].start + secs[over.i].end) / 2) / a.duration) * 100}%` }}>
          <b>{dragLook.name}</b> → {names[over.i]}
          {alike > 0 && <span>+ {alike === 1 ? 'the part like it' : `${alike} parts like it`}</span>}
          {fills > 0 && <span>+ fills {fills === 1 ? 'the empty part' : `${fills} empty parts`}</span>}
          {!over.alt && alike > 0 && <em>hold ⌥ for just this part</em>}
        </div>
      )}
    </div>
  );
}

/** the song's waveform drawn once per size in both colours (played, still to come), see drawWave */
let waveCache: { a: TrackAnalysis; w: number; h: number; dpr: number; played: HTMLCanvasElement; ahead: HTMLCanvasElement; px: number } | null = null;

function waveLayer(a: TrackAnalysis, w: number, h: number, dpr: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ov = a.overview;
  const mid = h / 2;
  g.fillStyle = color;
  for (let x = 0; x < w; x += 2) {
    const i0 = Math.floor((x / w) * ov.length);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 2) / w) * ov.length));
    let v = 0;
    for (let i = i0; i < i1 && i < ov.length; i++) v = Math.max(v, ov[i]);
    const hh = Math.max(0.5, v * (h * 0.44));
    g.fillRect(x, mid - hh, 1.4, hh * 2);
  }
  // part boundaries
  g.fillStyle = 'rgba(23,23,26,0.12)';
  for (const s of a.sections.slice(1)) g.fillRect(Math.round((s.start / a.duration) * w), 0, 1, h);
  return c;
}

/**
 * The timeline waveform. For a song it's two pictures made once per size (the played part dark, the
 * rest light), and each frame only copies them in when the playhead has moved a pixel, so a playing
 * song costs almost nothing here. Before analysis it draws the live waveform.
 */
function drawWave(c: HTMLCanvasElement | null, size: { w: number; h: number }, a: TrackAnalysis | null, t: number, d: number) {
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { w, h } = size;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    waveCache = null;
  }
  const g = c.getContext('2d')!;
  if (a) {
    let wc = waveCache;
    if (!wc || wc.a !== a || wc.w !== w || wc.h !== h || wc.dpr !== dpr) {
      wc = waveCache = { a, w, h, dpr, played: waveLayer(a, w, h, dpr, '#17171a'), ahead: waveLayer(a, w, h, dpr, '#c9c5bb'), px: -1 };
    }
    // the playhead in device pixels, on the 2-px bar grid the bars are drawn on
    const px = Math.round(Math.max(0, Math.min(1, d > 0 ? t / d : 0)) * w / 2) * 2 * dpr;
    if (px === wc.px) return;
    wc.px = px;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(wc.ahead, 0, 0);
    if (px > 0) g.drawImage(wc.played, 0, 0, px, c.height, 0, 0, px, c.height);
    return;
  }
  waveCache = null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (audioEngine.kind !== 'none') {
    // live waveform while analysing / mic
    const wf = audioEngine.frame.waveform;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const v = wf[Math.floor((x / w) * wf.length)] ?? 0;
      const y = h / 2 + v * h * 0.4;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = '#17171a';
    g.lineWidth = 1;
    g.stroke();
  }
}

/* ───────────────────────── feel controls ───────────────────────── */

/** one-click hand-drawn finish (its settings live in the Look tab) */
function HandToggle() {
  const on = useStudio((s) => activeFinish(s) === 'hand');
  return (
    <label className="sw boxed has-tip tip-left" data-tip="Choppy frames, wobbly lines, ink on paper. Fine-tune it in the Look tab. (H)">
      <Toggle on={on} onChange={() => toggleHand()} />
      Hand-drawn
    </label>
  );
}

/** Hand-drawn is one of the finishes: on picks it, off picks Clean (the Finish picker in the Look tab can go back to Auto) */
export function toggleHand() {
  const on = activeFinish(useStudio.getState()) === 'hand';
  setFinish(on ? 'clean' : 'hand');
  useStudio.getState().flash(on ? 'Hand-drawn off (Finish: Clean)' : 'Hand-drawn on. Fine-tune it in the Look tab');
}

/** the pop-up windows over the picture: one switch for all of them (when they show lives in the Look tab) */
let lastPopupsOn: Exclude<PopupMode, 'off'> = 'video';
function OverlaysSwitch() {
  const mode = useStudio((s) => s.popups);
  const on = mode !== 'off';
  if (on) lastPopupsOn = mode;
  const set = () => {
    const s = useStudio.getState();
    // read the store, not this render: two quick clicks must still flip twice
    const v = s.popups === 'off';
    if (!v) lastPopupsOn = s.popups as Exclude<PopupMode, 'off'>;
    s.set({ popups: v ? lastPopupsOn : 'off' });
    s.flash(v ? (lastPopupsOn === 'always' ? 'Pop-up windows on, all the time' : 'Pop-up windows on during videos') : 'Pop-up windows off');
  };
  return (
    <label
      className="sw boxed has-tip tip-left"
      data-tip={`The little pop-up windows over the picture. ${on ? (mode === 'always' ? 'Showing all the time.' : 'Showing while a video plays.') : 'Hidden.'} Choose when they show in the Look tab.`}
    >
      <Toggle on={on} onChange={set} />
      Pop-ups
    </label>
  );
}

function ImpactKnob() {
  const impact = useStudio((s) => s.impact);
  const set = useStudio((s) => s.set);
  return (
    <div className="impact has-tip" data-tip="How hard the visuals react to the music. 0% is still, 100% is normal, 200% is wild.">
      <span className="impact-l">Impact</span>
      <div className="impact-s">
        <Slider value={impact} min={0} max={2} step={0.05} onChange={(v) => set({ impact: v })} />
      </div>
      <span className="impact-v">{Math.round(impact * 100)}%</span>
    </div>
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
