/**
 * The phone layout's dock: a slim tab row along the bottom (Looks, Look settings, Lyrics, Export) and
 * the bottom sheet the tabs open. The picture, the transport and the song map stay above it, where the
 * thumb reaches them; the panels rise from the bottom edge, peek / half / full, and slide away on a
 * pull down, a second tap on their tab, or a swipe down on the picture (a swipe up brings the last one
 * back, stageGestures.ts). On a phone held sideways the sheet takes the right-hand column instead.
 */
import type { ReactNode } from 'react';
import { useStudio } from '../state/store';
import { pickLook } from '../state/plan';
import { PRESETS } from '../presets';
import { Sheet } from './Sheet';
import { Library } from './Library';
import { Inspector } from './Inspector';
import { DirectorPanel } from './Director';
import { LyricsPanel } from './Lyrics';
import { FeelControls } from './Bottom';
import { FramePicker } from './Perform';
import { RenderBar, toggleRenderMode, useRenderMode } from './RenderBar';
import { ShareClip } from './ShareClip';
import { saveStill, toggleRecording } from './capture';
import { closePanel, openPanel, PANEL_NAME, useLayout, usePhoneUi, type PanelId } from './layout';
import { Camera, Looks, Quote, Rec, Share, Shuffle, Sliders, X } from './Icons';
import './phone.css';

const TABS: { id: PanelId; icon: (p: { width: number; height: number }) => ReactNode }[] = [
  { id: 'looks', icon: (p) => <Looks {...p} /> },
  { id: 'settings', icon: (p) => <Sliders {...p} /> },
  { id: 'lyrics', icon: (p) => <Quote {...p} /> },
  { id: 'export', icon: (p) => <Share {...p} /> },
];

/** the tab label (Look settings is "Settings" in the row; the sheet's heading says it in full) */
const TAB_LABEL: Record<PanelId, string> = { looks: 'Looks', settings: 'Settings', lyrics: 'Lyrics', export: 'Export' };

export function PhoneDock() {
  const { panel, snap, last } = usePhoneUi();
  // held sideways the sheet is the right-hand column: it always stands full height there
  const land = useLayout((s) => s.land);
  const lyricsFound = useStudio((s) => s.lyricsStatus === 'found' || s.lyricsStatus === 'plain');
  const shown = panel ?? last;
  return (
    <>
      <Sheet
        className="ph-sheet"
        open={!!panel}
        snap={land ? 'full' : snap}
        onSnap={(s) => usePhoneUi.setState({ snap: s })}
        onClose={closePanel}
        label={PANEL_NAME[shown]}
        header={
          <div className="ph-head">
            <b>{PANEL_NAME[shown]}</b>
            <button className="btn icon ghost ph-close" aria-label={`Close ${PANEL_NAME[shown]}`} onClick={closePanel}>
              <X width={16} height={16} />
            </button>
          </div>
        }
      >
        <PanelBody id={shown} />
      </Sheet>
      <nav className="ph-tabs" aria-label="Panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`ph-tab ${panel === t.id ? 'on' : ''}`}
            aria-pressed={panel === t.id}
            aria-label={PANEL_NAME[t.id]}
            onClick={() => (panel === t.id ? closePanel() : openPanel(t.id))}
          >
            {t.icon({ width: 20, height: 20 })}
            <span>{TAB_LABEL[t.id]}</span>
            {t.id === 'lyrics' && lyricsFound && <i className="ph-dot" aria-hidden />}
          </button>
        ))}
      </nav>
    </>
  );
}

function PanelBody({ id }: { id: PanelId }) {
  if (id === 'looks') return <Library />;
  if (id === 'lyrics') return <LyricsPanel onClose={closePanel} />;
  if (id === 'export') return <ExportPanel />;
  return <SettingsPanel />;
}

function shuffle() {
  const s = useStudio.getState();
  const pool = PRESETS.filter((p) => p.id !== s.presetId);
  if (pool.length) pickLook(pool[Math.floor(Math.random() * pool.length)]);
}

/** Look settings: the frame, how it reacts, then the inspector and the chat with Claude */
function SettingsPanel() {
  return (
    <div className="ph-settings">
      <div className="ph-row">
        <FramePicker labels tipBelow={false} />
      </div>
      <div className="ph-row ph-feel">
        <FeelControls />
        <button className="btn ph-shuffle" onClick={shuffle}>
          <Shuffle width={15} height={15} /> Shuffle
        </button>
      </div>
      <Inspector />
      <DirectorPanel />
    </div>
  );
}

/** Export: the share clip first, then a live recording, a still, and the full render row */
function ExportPanel() {
  const recording = useStudio((s) => s.recording);
  const clip = useStudio((s) => !!s.clip);
  const rendering = useRenderMode((s) => s.on);
  return (
    <div className="ph-export">
      <ShareClip />
      <div className="ph-sep" />
      <div className="ph-row ph-capture">
        <button className={`btn rec ${recording ? 'on' : ''}`} disabled={clip} onClick={() => void toggleRecording()}>
          <Rec width={10} height={10} style={{ color: recording ? '#fff' : 'var(--rec)' }} />
          {recording ? 'Stop and save' : 'Record live'}
        </button>
        <button className="btn" disabled={clip} onClick={() => void saveStill()}>
          <Camera width={15} height={15} /> Save a still
        </button>
      </div>
      <button className={`btn ghost ph-more ${rendering ? 'on' : ''}`} aria-expanded={rendering} onClick={toggleRenderMode}>
        {rendering ? 'Hide other sizes' : 'Other sizes and stretches…'}
      </button>
      {rendering && (
        <div className="ph-render">
          <p className="ph-hint">Pick a stretch on the song map above, then the sizes to make.</p>
          <RenderBar />
        </div>
      )}
    </div>
  );
}
