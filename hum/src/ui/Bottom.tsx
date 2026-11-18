import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { LAYERS } from '../core/palettes';
import { onFrame } from '../state/live';
import { assignLook, findLook, makeVideo, sectionIndexAt, sectionNames } from '../state/plan';
import { presetToLook } from '../presets/apply';
import { useStudio } from '../state/store';
import { LAYER_MIME, Slider, Toggle } from './controls';
import { Pause, Play, Sparkle } from './Icons';
import { LOOK_MIME, STATIC_THUMBS } from './Library';
import { peekHandlers } from './Peek';

const fmtTime = (t: number) => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function Bottom() {
  return (
    <div className="bottom">
      <Transport />
      <LayerStrip />
    </div>
  );
}

function Transport() {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const analyzing = useStudio((s) => s.analyzing);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tap, setTap] = useState<number[]>([]);

  useEffect(
    () =>
      onFrame(() => {
        const p = audioEngine.playing;
        setPlaying((prev) => (prev !== p ? p : prev));
        const f = audioEngine.frame;
        if (timeRef.current) {
          timeRef.current.textContent =
            audioEngine.kind === 'mic' ? 'Live' : `${fmtTime(f.time)} / ${fmtTime(f.duration)}`;
        }
        drawScrubber(canvas.current, analysis, f.time, f.duration);
      }),
    [analysis],
  );

  const seek = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = audioEngine.frame.duration;
    if (d) audioEngine.seek(((e.clientX - r.left) / r.width) * d);
  };

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
    <div className="transport">
      <button className="play" onClick={() => audioEngine.toggle()} disabled={!track || track.source === 'mic'} title="Play / pause (space)">
        {playing ? <Pause /> : <Play style={{ marginLeft: 2 }} />}
      </button>
      <span className="time" ref={timeRef}>
        0:00 / 0:00
      </span>
      <div className="scrubber" onPointerDown={seek} onPointerMove={(e) => e.buttons & 1 && seek(e)}>
        <canvas ref={canvas} />
        {!track && <span className="scrub-note">Drop a song anywhere, or pick a demo</span>}
        {analyzing && <span className="scrub-note right">Listening…</span>}
      </div>
      <div className="feel">
        <ImpactKnob />
        <HandToggle />
      </div>
      <span className="time">{analysis ? `${Math.round(analysis.bpm)} bpm` : audioEngine.frame.bpm ? `${Math.round(audioEngine.frame.bpm)} bpm` : '– bpm'}</span>
      <button className="btn sm has-tip tip-left" data-tip="Tap along 4+ times to set the tempo" onClick={onTap}>
        Tap
      </button>
      {analysis && analysis.sections.length > 0 && <SongMap />}
    </div>
  );
}

/* group tints: sections that sound alike share a colour */
const GROUP_TINT = ['#dfe5ff', '#ffe2cc', '#d8efe1', '#ecdff5', '#f4ecc6', '#e4e2dc', '#d4ecf4', '#f5d9d9'];
const GROUP_INK = ['#2f4bff', '#e2620b', '#2b8a55', '#8f47c4', '#9a7f00', '#77756e', '#1b86a8', '#c94040'];

/**
 * The song map: the song's parts under the waveform, each with the look it gets. Click a part to
 * jump there, drag a look onto it to change it, hover to preview its look.
 */
function SongMap() {
  const analysis = useStudio((s) => s.analysis)!;
  const plan = useStudio((s) => s.plan);
  const planOn = useStudio((s) => s.planOn);
  const planning = useStudio((s) => s.planning);
  useStudio((s) => s.customPresets.length);
  const [over, setOver] = useState(-1);
  const blocks = useRef<(HTMLButtonElement | null)[]>([]);
  const head = useRef<HTMLDivElement>(null);
  const secs = analysis.sections;
  const names = sectionNames(secs);
  const hasPlan = !!plan && plan.looks.length === secs.length;

  useEffect(
    () =>
      onFrame(() => {
        const t = audioEngine.currentTime;
        const i = sectionIndexAt(secs, t);
        blocks.current.forEach((el, j) => el?.classList.toggle('now', j === i));
        if (head.current) head.current.style.left = `${(t / analysis.duration) * 100}%`;
      }),
    [secs, analysis.duration],
  );

  return (
    <div className="sm-row">
      <button
        className="btn sm primary sm-make has-tip"
        disabled={planning}
        onClick={() => void makeVideo()}
        data-tip="Claude gives every part of the song a look (calm intro, big drops, the chorus coming back) and plays it from the top."
      >
        {planning ? <span className="spin" /> : <Sparkle width={13} height={13} />}
        {planning ? 'Planning…' : hasPlan ? 'Remake video' : 'Make a video'}
      </button>
      <div className="songmap">
        {secs.map((sec, i) => {
          const look = hasPlan ? findLook(plan!.looks[i]) : undefined;
          const g = sec.group % GROUP_TINT.length;
          const narrow = (sec.end - sec.start) / analysis.duration < 0.07;
          const why = hasPlan ? plan!.why[i] : '';
          return (
            <button
              key={i}
              ref={(el) => {
                blocks.current[i] = el;
              }}
              className={`sm-sec ${narrow ? 'narrow' : ''} ${over === i ? 'over' : ''}`}
              style={{ flexGrow: sec.end - sec.start, background: GROUP_TINT[g], ['--g' as string]: GROUP_INK[g] }}
              title={`${names[i]} · ${fmtTime(sec.start)}–${fmtTime(sec.end)}${look ? ` · ${look.name}` : ''}${why ? ` — ${why}` : ''}`}
              onClick={() => audioEngine.seek(sec.start + 0.01)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(LOOK_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setOver(i);
              }}
              onDragLeave={() => setOver(-1)}
              onDrop={(e) => {
                setOver(-1);
                const id = e.dataTransfer.getData(LOOK_MIME);
                if (id) assignLook(i, id, !e.altKey);
              }}
              {...(look
                ? peekHandlers({
                    key: `sec:${i}:${look.id}`,
                    title: `${names[i]} · ${look.name}`,
                    hint: why || 'Click to jump here, drag a look on to change it',
                    poster: STATIC_THUMBS[look.id],
                    place: 'above',
                    getLook: () => (useStudio.getState().presetId === look.id ? null : presetToLook(look)),
                  })
                : {})}
            >
              {look && STATIC_THUMBS[look.id] && !narrow && <img src={STATIC_THUMBS[look.id]} alt="" />}
              {look && !STATIC_THUMBS[look.id] && !narrow && <i className="sm-swatch" style={{ background: look.palette.accent }} />}
              {!narrow && (
                <span className="sm-txt">
                  <b>{names[i]}</b>
                  {look && <em>{look.name}</em>}
                </span>
              )}
            </button>
          );
        })}
        <div className="sm-head" ref={head} />
      </div>
      <label className="sm-follow has-tip tip-left" data-tip="When on, the looks change with the song’s parts as it plays. Picking a look while it plays puts it into that part.">
        {hasPlan ? (
          <>
            <Toggle on={planOn} onChange={(v) => useStudio.getState().set({ planOn: v, autoPilot: v ? false : useStudio.getState().autoPilot })} />
            Follow
          </>
        ) : (
          <span className="sm-hint">Drag looks onto parts</span>
        )}
      </label>
    </div>
  );
}

/** one-click hand-drawn finish (its settings live in the Look tab) */
function HandToggle() {
  const on = useStudio((s) => s.hand.on);
  return (
    <button
      className={`hand-btn has-tip ${on ? 'on' : ''}`}
      data-tip="Hand-drawn: choppy frames, wobbly lines, ink on paper. Fine-tune it in the Look tab. (H)"
      onClick={() => toggleHand()}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 2.5l3 3L6 13H3v-3z" />
        <path d="M9 4l3 3" />
      </svg>
      Hand-drawn
    </button>
  );
}

export function toggleHand() {
  const s = useStudio.getState();
  s.set({ hand: { ...s.hand, on: !s.hand.on } });
  s.flash(s.hand.on ? 'Hand-drawn off' : 'Hand-drawn on. Fine-tune it in the Look tab');
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

function drawScrubber(c: HTMLCanvasElement | null, a: ReturnType<typeof useStudio.getState>['analysis'], t: number, d: number) {
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const prog = d > 0 ? t / d : 0;
  if (a) {
    // waveform overview
    const ov = a.overview;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * ov.length);
      const v = ov[i] ?? 0;
      const hh = Math.max(0.5, v * (h * 0.36));
      g.fillStyle = x / w < prog ? '#17171a' : '#cdc9bf';
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    // energy curve
    g.beginPath();
    for (let x = 0; x < w; x += 2) {
      const i = Math.floor((x / w) * a.energyCurve.length);
      const y = h - 4 - (a.energyCurve[i] ?? 0) * (h - 14);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(47,75,255,0.55)';
    g.lineWidth = 1;
    g.stroke();
    // drops
    for (const dt of a.drops) {
      const x = (dt / a.duration) * w;
      g.fillStyle = '#2f4bff';
      g.fillRect(x - 0.5, 0, 1, h);
      g.beginPath();
      g.moveTo(x - 4, 0);
      g.lineTo(x + 4, 0);
      g.lineTo(x, 5);
      g.fill();
    }
  } else if (audioEngine.kind !== 'none') {
    // live waveform while analysing / mic
    const wf = audioEngine.frame.waveform;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const v = wf[Math.floor((x / w) * wf.length)] ?? 0;
      const y = h / 2 + v * h * 0.35;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = '#17171a';
    g.lineWidth = 1;
    g.stroke();
  }
  if (d > 0) {
    const x = prog * w;
    g.fillStyle = '#ff3b30';
    g.fillRect(x - 0.75, 0, 1.5, h);
  }
}

function LayerStrip() {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(
    () =>
      onFrame(() => {
        const f = audioEngine.frame;
        LAYERS.forEach((l, i) => {
          const el = refs.current[i];
          if (!el) return;
          const v = Math.max(0, Math.min(1, f.layers[l.id] ?? 0));
          (el.children[0] as HTMLElement).style.transform = `scaleY(${v})`;
          (el.children[1] as HTMLElement).style.bottom = `${v * 100}%`;
          const hit = (l.id === 'kick' && f.kick > 0.6) || (l.id === 'snare' && f.snare > 0.6) || (l.id === 'hat' && f.hat > 0.6) || (l.id === 'drop' && f.drop > 0.5);
          el.classList.toggle('hit', hit);
        });
      }),
    [],
  );
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
