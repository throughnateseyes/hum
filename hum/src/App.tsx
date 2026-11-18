import { useEffect, useRef, useState } from 'react';
import { audioEngine } from './audio/engine';
import { DEMO_TRACKS } from './audio/demoTracks';
import { PRESETS } from './presets';
import { allScenes, getScene } from './scenes';
import { live } from './state/live';
import { useStudio } from './state/store';
import { handleFiles, loadDemo, useMic } from './state/tracks';
import { Recorder, download } from './render/recorder';
import { Bottom, toggleHand } from './ui/Bottom';
import { Camera, Expand, Mic, Rec, Shuffle, Upload, X } from './ui/Icons';
import { DirectorPanel, focusDirector } from './ui/Director';
import { Inspector } from './ui/Inspector';
import { Library } from './ui/Library';
import { PeekWindow } from './ui/Peek';
import { LyricsChip } from './ui/Lyrics';
import { TapSync } from './ui/TapSync';
import { pickLook } from './state/plan';
import { StageView } from './ui/StageView';
import { Breakdown } from './ui/Breakdown';

const recorder = new Recorder();

export default function App() {
  const perform = useStudio((s) => s.perform);
  const toast = useStudio((s) => s.toast);
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);

  // initial look
  useEffect(() => {
    const s = useStudio.getState();
    if (!s.sceneId) {
      const first = PRESETS.find((p) => getScene(p.sceneId));
      if (first) s.applyPreset(first);
      else if (allScenes()[0]) s.setScene(allScenes()[0].id);
    }
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const s = useStudio.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.toggle();
      } else if (e.key === 'f') {
        s.set({ perform: !s.perform });
      } else if (e.key === 'Escape' && s.perform) {
        s.set({ perform: false });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = PRESETS.findIndex((p) => p.id === s.presetId);
        const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + PRESETS.length) % PRESETS.length;
        if (PRESETS[j]) pickLook(PRESETS[j]);
      } else if (e.key === '/') {
        e.preventDefault();
        s.set({ directorOpen: true });
        requestAnimationFrame(focusDirector);
      } else if (e.key === 'r' && !e.metaKey) {
        shuffle();
      } else if (e.key === 'h' && !e.metaKey) {
        toggleHand();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`app ${perform ? 'perform' : ''} ${over ? 'dropzone-over' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setOver(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setOver(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        dragDepth.current = 0;
        setOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
      style={{ position: 'relative' }}
    >
      <Topbar />
      <Library />
      <PeekWindow />
      <TapSync />
      <main className="center">
        <StageView />
        <Breakdown />
        <Bottom />
      </main>
      <div className="right">
        <Inspector />
        <DirectorPanel />
      </div>
      {perform && (
        <button className="btn perform-exit" onClick={() => useStudio.getState().set({ perform: false })}>
          <X width={13} height={13} /> Exit (esc)
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function shuffle() {
  const s = useStudio.getState();
  const pool = PRESETS.filter((p) => p.id !== s.presetId);
  if (pool.length) pickLook(pool[Math.floor(Math.random() * pool.length)]);
}

function Topbar() {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const recording = useStudio((s) => s.recording);
  const set = useStudio((s) => s.set);
  const flash = useStudio((s) => s.flash);
  const input = useRef<HTMLInputElement>(null);

  const toggleRec = async () => {
    const stage = live.stage;
    if (!stage) return;
    if (!recorder.active) {
      try {
        recorder.start(stage.canvas);
        set({ recording: true });
      } catch (e) {
        flash(`Recording isn't supported here: ${String(e)}`);
      }
    } else {
      const blob = await recorder.stop();
      set({ recording: false });
      const ext = recorder.mime.includes('mp4') ? 'mp4' : 'webm';
      download(blob, `hum-${Date.now()}.${ext}`);
      flash(`Saved a ${ext.toUpperCase()} clip`);
    }
  };

  const still = async () => {
    const url = await live.stage?.snapshot();
    if (url) download(url, `hum-${Date.now()}.png`);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        hum
      </div>
      {track ? (
        <div className="trackpill">
          <span className="dot">{track.source === 'mic' ? <Mic width={10} height={10} /> : <span style={{ fontSize: 8 }}>♪</span>}</span>
          <span className="name">{track.name}</span>
          {analysis && (
            <span className="meta">
              {Math.round(analysis.bpm)} bpm · {analysis.tags.slice(0, 3).join(', ')}
            </span>
          )}
        </div>
      ) : (
        <div className="trackpill" style={{ color: 'var(--ink-3)' }}>
          <span className="dot" style={{ background: 'var(--line-2)' }} />
          No track
        </div>
      )}
      <LyricsChip />
      <div className="seg" style={{ marginLeft: 4 }}>
        {DEMO_TRACKS.map((d) => (
          <button key={d.id} className={track?.id === d.id ? 'on' : ''} onClick={() => void loadDemo(d.id)} title={d.description}>
            {d.name}
          </button>
        ))}
      </div>
      <button className="btn icon ghost has-tip tip-below" data-tip="Open audio or photos" onClick={() => input.current?.click()}>
        <Upload width={15} height={15} />
      </button>
      <button className="btn icon ghost has-tip tip-below" data-tip="Listen to the microphone" onClick={() => void useMic()}>
        <Mic width={15} height={15} />
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="spacer" />
      <button className="btn icon ghost has-tip tip-below" data-tip="Shuffle look  R" onClick={shuffle}>
        <Shuffle width={15} height={15} />
      </button>
      <button className="btn icon ghost has-tip tip-below" data-tip="Save a still image" onClick={() => void still()}>
        <Camera width={15} height={15} />
      </button>
      <button className={`btn rec ${recording ? 'on' : ''}`} onClick={() => void toggleRec()} title="Record video with audio">
        <Rec width={10} height={10} style={{ color: recording ? '#fff' : 'var(--rec)' }} />
        {recording ? 'Stop' : 'Record'}
      </button>
      <button className="btn primary" onClick={() => set({ perform: true })} title="Full-bleed perform mode (F)">
        <Expand width={13} height={13} /> Perform
      </button>
    </header>
  );
}
