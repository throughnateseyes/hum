/**
 * The phone layout's dock: a slim tab row along the bottom (Looks, Look settings, Lyrics, Export) and
 * the bottom sheet the tabs open. The picture, the transport and the song map stay above it, where the
 * thumb reaches them; the panels rise from the bottom edge, peek / half / full, and slide away on a
 * pull down, a second tap on their tab, or a swipe down on the picture (a swipe up brings the last one
 * back, stageGestures.ts). On a phone held sideways the sheet takes the right-hand column instead.
 */
import { useEffect, type ReactNode } from 'react';
import { useStudio, type PopupMode } from '../state/store';
import { pickLook } from '../state/plan';
import { lookShows } from '../director/footage';
import { PRESETS } from '../presets';
import { Sheet } from './Sheet';
import { Library } from './Library';
import { Inspector } from './Inspector';
import { DirectorPanel } from './Director';
import { LyricsPanel } from './Lyrics';
import { activeFinish } from '../state/direction';
import { Slider, Toggle } from './controls';
import { toggleHand } from './hand';
import { FramePicker } from './Perform';
import { RenderBar, toggleRenderMode, useRenderMode } from './RenderBar';
import { ShareClip } from './ShareClip';
import { saveStill } from './capture';
import { closePanel, openPanel, PANEL_NAME, useLayout, usePhoneUi, type PanelId } from './layout';
import { Camera, Looks, Quote, Share, Shuffle, Sliders, X } from './Icons';
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
  const pool = PRESETS.filter((p) => p.id !== s.presetId && lookShows(p));
  if (pool.length) pickLook(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * Look settings: the frame, how it reacts, then the inspector and the chat with Claude. The phone renders
 * from its own Export panel, so the inspector's Render tab is hidden here (phone.css): left open, it kept
 * render mode on after the sheet closed, and the song map stopped opening parts.
 */
function SettingsPanel() {
  useEffect(() => {
    if (useStudio.getState().inspectorTab === 'render') useStudio.getState().set({ inspectorTab: 'video' });
  }, []);
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

/** Export: the share clip first, then a still, and the full render row */
function ExportPanel() {
  const clip = useStudio((s) => !!s.clip);
  const rendering = useRenderMode((s) => s.on);
  return (
    <div className="ph-export">
      <ShareClip />
      <div className="ph-sep" />
      <div className="ph-row ph-capture">
        <button className="btn" disabled={clip} onClick={() => void saveStill()}>
          <Camera width={15} height={15} /> Save a still
        </button>
      </div>
      <button className={`btn ghost ph-more ${rendering ? 'on' : ''}`} aria-expanded={rendering} onClick={toggleRenderMode}>
        {rendering ? 'Hide other sizes' : 'Other sizes and stretches…'}
      </button>
      {rendering && (
        <div className="ph-render">
          <RenderBar />
        </div>
      )}
    </div>
  );
}

/* ───────── how it feels: Impact, Hand-drawn and Pop-ups (the desktop has them in the Video tab) ───────── */

/** how hard it reacts, the hand-drawn finish and the pop-ups, in a row at the top of Look settings */
function FeelControls() {
  return (
    <>
      <ImpactKnob />
      <HandToggle />
      <OverlaysSwitch />
    </>
  );
}

/** one-click hand-drawn finish (its settings live in the Video tab) */
function HandToggle() {
  const on = useStudio((s) => activeFinish(s) === 'hand');
  return (
    <label className="sw boxed has-tip tip-left" data-tip="Choppy frames, wobbly lines, ink on paper. Fine-tune it in the Video tab. (H)">
      <Toggle on={on} onChange={() => toggleHand()} />
      Hand-drawn
    </label>
  );
}

/** the pop-up windows over the picture: one switch for all of them (when they show lives in the Video tab) */
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
      data-tip={`The little pop-up windows over the picture. ${on ? (mode === 'always' ? 'Showing all the time.' : 'Showing while a video plays.') : 'Hidden.'} Choose when they show in the Video tab.`}
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
