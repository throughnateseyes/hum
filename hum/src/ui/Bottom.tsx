import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { LAYERS } from '../core/palettes';
import { onFrame } from '../state/live';
import { useStudio } from '../state/store';
import { LAYER_MIME } from './controls';
import { Pause, Play } from './Icons';

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
            audioEngine.kind === 'mic' ? 'LIVE' : `${fmtTime(f.time)} / ${fmtTime(f.duration)}`;
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
        {!track && (
          <span className="label" style={{ position: 'absolute', left: 12, top: 15 }}>
            Drop a song anywhere · or pick a demo
          </span>
        )}
        {analyzing && (
          <span className="label" style={{ position: 'absolute', right: 10, top: 15, color: 'var(--accent)' }}>
            listening…
          </span>
        )}
      </div>
      <span className="time">{analysis ? `${Math.round(analysis.bpm)} BPM` : audioEngine.frame.bpm ? `${Math.round(audioEngine.frame.bpm)} BPM` : '— BPM'}</span>
      <button className="btn sm" onClick={onTap} title="Tap 4+ times to set the tempo">
        Tap
      </button>
    </div>
  );
}

const SECTION_COLORS: Record<string, string> = {
  intro: '#c9c6bd',
  verse: '#9db4ff',
  build: '#ffb36b',
  drop: '#2f4bff',
  break: '#b6d6c4',
  outro: '#c9c6bd',
};

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
    // sections
    for (const s of a.sections) {
      const x0 = (s.start / a.duration) * w;
      const x1 = (s.end / a.duration) * w;
      g.fillStyle = SECTION_COLORS[s.label] ?? '#ccc';
      g.globalAlpha = 0.9;
      g.fillRect(x0, h - 3, x1 - x0 - 1, 3);
      g.globalAlpha = 1;
      if (x1 - x0 > 40) {
        g.fillStyle = '#98958c';
        g.font = '9px "IBM Plex Mono", monospace';
        g.fillText(s.label.toUpperCase(), x0 + 4, 10);
      }
    }
    // waveform overview
    const ov = a.overview;
    const mid = h / 2 + 3;
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
          title={`${l.label} — ${l.hint}. Drag onto a slider to route it.`}
        >
          <div className="fill" style={{ height: '100%', transform: 'scaleY(0)' }} />
          <div className="bar" style={{ bottom: 0 }} />
          <span className="lbl">{l.short}</span>
        </div>
      ))}
    </div>
  );
}
