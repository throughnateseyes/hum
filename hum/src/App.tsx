import { useEffect, useRef, useState } from 'react';
import { audioEngine } from './audio/engine';
import { DEMO_TRACKS } from './audio/demoTracks';
import { PRESETS } from './presets';
import { allScenes, getScene } from './scenes';
import { useStudio, type InspectorTab } from './state/store';
import { canListenToTab, handleFiles, loadDemo, restoreSession, useMic, useTab } from './state/tracks';
import { renderBlocker } from './render/timeline';
import { Bottom } from './ui/Bottom';
import { toggleHand } from './ui/hand';
import { validPlan } from './state/plan';
import { BrowserTab, Camera, Chevron, Expand, Film, Mic, Upload } from './ui/Icons';
import { DirectorPanel, focusDirector } from './ui/Director';
import { AccessGate } from './ui/AccessGate';
import { Inspector } from './ui/Inspector';
import { Library } from './ui/Library';
import { PeekWindow } from './ui/Peek';
import { LyricsChip } from './ui/Lyrics';
import { TapSync } from './ui/TapSync';
import { pickLook } from './state/plan';
import { noteHandPick } from './state/taste';
import { keepNow, skipNow } from './ui/Taste';
import { StageView } from './ui/StageView';
import { Breakdown } from './ui/Breakdown';
import { nudgeVolume, toggleMute, useVolumeSync } from './ui/Volume';
import { jumpPart, seekBy, SEEK_STEP } from './ui/SeekBar';
import { FramePicker, PerformControls, cycleFrame, enterPerform, exitPerform, togglePerform, usePerformSync } from './ui/Perform';
import { saveStill } from './ui/capture';
import { useLayout, useLayoutWatch } from './ui/layout';
import { PhoneDock } from './ui/Phone';

export default function App() {
  const perform = useStudio((s) => s.perform);
  const toast = useStudio((s) => s.toast);
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  usePerformSync();
  useVolumeSync();
  // phones (touch, up to 760 px) get their own layout: ui/layout.ts, ui/Phone.tsx
  useLayoutWatch();
  const phone = useLayout((s) => s.phone);
  const land = useLayout((s) => s.land);

  // initial look
  // the song and the clips from last time come back (state/saved.ts)
  useEffect(() => {
    void restoreSession();
  }, []);

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
      // a clip export owns the song and the stage until it's done (its own handler takes Esc)
      if (s.clip) return;
      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.toggle();
      } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) {
        togglePerform();
      } else if (e.key === 'Escape' && s.perform) {
        exitPerform();
      } else if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        cycleFrame(e.shiftKey ? -1 : 1);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && s.perform && audioEngine.kind === 'file' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // full screen is for watching: ← → move through the song like a video player, ⇧ by whole parts
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) jumpPart(dir);
        else seekBy(dir * SEEK_STEP);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === ']' || e.key === '[') {
        const i = PRESETS.findIndex((p) => p.id === s.presetId);
        const j = (i + (e.key === 'ArrowRight' || e.key === ']' ? 1 : -1) + PRESETS.length) % PRESETS.length;
        if (PRESETS[j]) {
          noteHandPick(PRESETS[j], 'browse');
          pickLook(PRESETS[j]);
        }
      } else if ((e.key === 'k' || e.key === 'K') && !e.metaKey && !e.ctrlKey) {
        keepNow();
      } else if ((e.key === 'x' || e.key === 'X') && !e.metaKey && !e.ctrlKey) {
        skipNow();
      } else if (e.key === '/') {
        e.preventDefault();
        s.set({ directorOpen: true });
        requestAnimationFrame(focusDirector);
      } else if (e.key === 'r' && !e.metaKey) {
        // R picks a look at random (there's no button for it any more)
        shuffle();
      } else if (e.key === 'h' && !e.metaKey) {
        toggleHand();
      } else if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleMute(true);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        nudgeVolume(e.key === 'ArrowUp' ? 0.1 : -0.1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`app ${perform ? 'perform' : ''} ${over ? 'dropzone-over' : ''} ${phone ? 'phone' : ''} ${phone && land ? 'land' : ''}`}
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
      {phone ? <PhoneTopbar /> : <Topbar />}
      {!phone && <Library />}
      {!phone && <PeekWindow />}
      <TapSync />
      <main className="center">
        <StageView />
        <Breakdown />
        <Bottom />
      </main>
      {phone ? (
        <PhoneDock />
      ) : (
        <div className="right">
          <Inspector />
          <DirectorPanel />
        </div>
      )}
      <PerformControls />
      <AccessGate />
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
  const input = useRef<HTMLInputElement>(null);

  // the tap that opens the picker is the gesture that lets the song start once it's planned
  const openFiles = () => {
    audioEngine.unlock();
    input.current?.click();
  };

  return (
    <header className="topbar">
      <div className="tb-left">
        <div className="brand" aria-label="hum">
          <span className="brand-mark" />
          <span className="brand-word">hum</span>
        </div>
        <SourceMenu onOpenFiles={openFiles} />
        <LyricsChip />
        <button className="btn icon ghost has-tip tip-below" data-tip="Open audio or photos" aria-label="Open audio or photos" onClick={openFiles}>
          <Upload width={15} height={15} />
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
      </div>
      <div className="tb-right">
        <FramePicker />
        <span className="tb-div" />
        <button className="btn icon ghost has-tip tip-below" data-tip="Save a still image of the picture" aria-label="Save a still image" onClick={() => void saveStill()}>
          <Camera width={15} height={15} />
        </button>
        <RenderButton />
        <button className="btn ghost tb-perform has-tip tip-below tip-end" onClick={enterPerform} data-tip="Full screen, the controls hide (F)">
          <Expand width={13} height={13} /> Perform
        </button>
      </div>
    </header>
  );
}

/** the phone's top bar: the song (and where songs come from) and a way to open one; the rest is in the dock */
function PhoneTopbar() {
  const input = useRef<HTMLInputElement>(null);
  const openFiles = () => {
    audioEngine.unlock();
    input.current?.click();
  };
  return (
    <header className="topbar ph-top">
      <div className="brand" aria-label="hum">
        <span className="brand-mark" />
      </div>
      <SourceMenu onOpenFiles={openFiles} />
      <button className="btn icon ghost ph-open" aria-label="Open a song" onClick={openFiles}>
        <Upload width={18} height={18} />
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </header>
  );
}

/**
 * The top bar's one primary button: opens the Render tab (pick any stretch, any sizes, or a quick
 * clip for socials). A second click goes back to the tab you came from.
 */
let lastTab: InspectorTab = 'video';
function RenderButton() {
  const on = useStudio((s) => s.inspectorTab === 'render');
  const blocked = useStudio((s) => renderBlocker({ ...s, clip: null }));
  const flash = useStudio((s) => s.flash);
  return (
    <button
      className={`btn primary tb-render has-tip tip-below ${on ? 'on' : ''} ${blocked && !on ? 'off' : ''}`}
      onClick={() => {
        if (blocked && !on) return flash(blocked);
        const s = useStudio.getState();
        if (!on) lastTab = s.inspectorTab === 'render' ? lastTab : s.inspectorTab;
        s.set({ inspectorTab: on ? (lastTab === 'render' ? (validPlan(s.plan, s.analysis) ? 'video' : 'part') : lastTab) : 'render' });
      }}
      data-tip={blocked && !on ? blocked : on ? 'Close the Render tab' : 'Make the song into a video file, or a quick clip for socials'}
      aria-label="Render a video"
      aria-pressed={on}
      aria-disabled={!!blocked && !on}
    >
      <Film width={14} height={14} />
      <span className="lbl-wide">Render</span>
    </button>
  );
}

/**
 * The song now playing, as a button: it opens the places a song can come from (the two demos, a file
 * from disk, the microphone). Keeps the topbar to one quiet pill instead of five controls.
 */
function SourceMenu({ onOpenFiles }: { onOpenFiles: () => void }) {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="src" ref={box}>
      <button className={`trackpill ${track ? '' : 'none'} ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="dot">
          {track?.name === 'Tab audio' ? (
            <BrowserTab width={11} height={11} />
          ) : track?.source === 'mic' ? (
            <Mic width={10} height={10} />
          ) : track ? (
            <span style={{ fontSize: 8 }}>♪</span>
          ) : null}
        </span>
        <span className="name">{track ? track.name : 'Choose a song'}</span>
        {track && analysis && (
          <span className="meta">
            {Math.round(analysis.bpm)} bpm · {analysis.tags.slice(0, 3).join(', ')}
          </span>
        )}
        <Chevron width={12} height={12} className="caret" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-h">Demos</div>
          {DEMO_TRACKS.map((d) => (
            <button key={d.id} role="menuitem" className={`menu-item ${track?.id === d.id ? 'on' : ''}`} onClick={pick(() => void loadDemo(d.id))}>
              <b>{d.name}</b>
              <span>{d.description}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item row" onClick={pick(onOpenFiles)}>
            <Upload width={14} height={14} />
            <b>Open audio or photos…</b>
          </button>
          <button role="menuitem" className={`menu-item row ${track?.source === 'mic' && track.name !== 'Tab audio' ? 'on' : ''}`} onClick={pick(() => void useMic())}>
            <Mic width={14} height={14} />
            <b>Listen to the microphone</b>
          </button>
          {canListenToTab() && (
            <button
              role="menuitem"
              className={`menu-item row ${track?.name === 'Tab audio' ? 'on' : ''}`}
              onClick={pick(() => void useTab())}
              title="Play the song on YouTube in another tab, pick that tab, keep Share tab audio on"
            >
              <BrowserTab width={14} height={14} />
              <span className="mi-text">
                <b>Listen to a tab</b>
                <span>A song playing in another tab, e.g. YouTube</span>
              </span>
            </button>
          )}
          <p className="menu-foot">Or drop a song anywhere on the page.</p>
        </div>
      )}
    </div>
  );
}
