/**
 * The Video tab of the right panel: everything that shapes the whole video. Make / Remake and the
 * moods first, then the finish (with the hand-drawn settings right under it when that finish is on,
 * since that's the one people come here for), how hard and how fast it moves, the pop-ups, the
 * transitions, the words and the song colours. The rarely touched switches sit under More.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FINISHES, finishName, type FinishId } from '../core/direction';
import { TRANSITIONS } from '../core/transitionList';
import type { HandStyle } from '../core/types';
import { forgetAccessCode, learnCan, learnNeed, openAccessGate, useAccessGate } from '../director/access';
import { quality as governor } from '../render/quality';
import { perfReport, perfSummary } from '../render/perfReport';
import { KIT_CHOICES, kitFor, warmKit, type KitId } from '../render/typeKits';
import { activeFinish, playingDirection, setFinish } from '../state/direction';
import { makeVideo, validPlan } from '../state/plan';
import { useStudio, type LyricStyle, type Pace, type PopupMode, type SongColors, type TypeKitSetting, type WindowKind } from '../state/store';
import { DrawingsSection } from './Drawings';
import { Field, Section, Seg, Slider, SwitchRow } from './controls';
import { Lock, Sparkle } from './Icons';
import { MoodRow } from './Moods';
import { TasteGroup } from './Taste';

export function VideoPanel() {
  return (
    <div className="vp">
      <MakeBlock />
      <FramesSection />
      <FinishSection />
      <Section id="video.move" title="Movement">
        <ImpactField />
        <PaceField />
      </Section>
      <PopupSection />
      <TransitionSection />
      <WordsSection />
      <ColourSection />
      <DrawingsSection />
      <MoreSection />
    </div>
  );
}

/* ───────── make the video ───────── */

function MakeBlock() {
  const analysis = useStudio((s) => s.analysis);
  const track = useStudio((s) => s.track);
  const planning = useStudio((s) => s.planning);
  const plan = useStudio((s) => s.plan);
  const planOn = useStudio((s) => s.planOn);
  const hasPlan = validPlan(plan, analysis);
  const parts = analysis?.sections.length ?? 0;
  // without a code on a site that wants one, the button wears a lock (it still works: it asks first)
  const locked = useAccessGate((s) => s.need === 'code' && !s.saved);
  // after a reload the start screen never shows, so ask the server here too (once per page, free)
  useEffect(() => {
    void learnNeed();
    void learnCan();
  }, []);
  return (
    <div className="vp-make">
      <button
        className={`btn primary vp-go has-tip tip-below ${locked ? 'locked' : ''}`}
        disabled={planning || !parts}
        // locked: the press goes through the access gate first (postDirector opens it straight away,
        // since the server's answer is already known), then plans once the code is in
        onClick={() => void makeVideo('', { fresh: hasPlan })}
        data-tip={
          locked
            ? `Claude’s version needs an access code. Press to enter one. ${hasPlan ? 'The video playing now was made by Hum’s built-in director.' : 'Without a code, Hum’s built-in director makes it.'}`
            : hasPlan
              ? 'A fresh take on this song: new looks for every part, played from the top.'
              : 'Gives every part of the song a look (calm intro, big drops, the chorus coming back) and plays it from the top. A song you made a video for before plays its saved video.'
        }
      >
        {planning ? <span className="spin" /> : locked ? <Lock width={13} height={13} aria-hidden /> : <Sparkle width={13} height={13} />}
        {planning ? 'Planning…' : hasPlan ? 'Remake video' : 'Make a video'}
      </button>
      {!parts && (
        <p className="field-note">
          {!track ? 'Load a song first. Its parts show up on the timeline.' : track.source === 'mic' ? 'Videos need a song file, not live sound.' : 'Listening to the song…'}
        </p>
      )}
      <MoodRow />
      {hasPlan && (
        <SwitchRow
          label="Play the video plan"
          note={planOn ? 'Looks change with each part of the song' : 'One look stays until you pick another'}
          on={planOn}
          onChange={(v) => useStudio.getState().set({ planOn: v, autoPilot: v ? false : useStudio.getState().autoPilot })}
        />
      )}
    </div>
  );
}

/* ───────── finish, with the hand-drawn settings under it ───────── */

// two rows on a 12-column grid: Auto, Clean and Hand-drawn (the one people reach for) a little wider
// on top, the four film-like finishes under them
const FINISH_OPTS: { v: 'auto' | FinishId; label: string; tip?: string; span: number }[] = [
  { v: 'auto', label: 'Auto', tip: 'Each video picks the finish that fits the song', span: 4 },
  ...(['clean', 'hand', 'film', 'riso', 'ink', 'tape'] as FinishId[]).map((id, i) => {
    const f = FINISHES.find((x) => x.id === id)!;
    return { v: f.id, label: f.name, tip: f.tip, span: i < 2 ? 4 : 3 };
  }),
];

function FinishSection() {
  const finish = useStudio((s) => s.finish);
  const now = useStudio(activeFinish);
  const dir = useStudio(playingDirection);
  const info = FINISHES.find((f) => f.id === (finish === 'auto' ? now : finish));
  const note =
    finish === 'auto'
      ? dir
        ? `This video uses ${finishName(dir.finish)}.`
        : `No video playing, so ${finishName(now)}.`
      : now === 'hand'
        ? 'Wobbly lines and flat inks, like hand animation. (H)'
        : (info?.tip ?? '');
  return (
    <Section id="video.finish" title="Finish" sub="One surface over every look, like shooting it all on the same film">
      <Seg value={finish} options={FINISH_OPTS} onChange={setFinish} cols={12} label="Finish" />
      <p className="field-note">{note}</p>
      {now === 'hand' && <HandSettings />}
    </Section>
  );
}

const FRAMES: { v: HandStyle['fps']; label: string; tip: string }[] = [
  { v: 60, label: 'Smooth', tip: 'A new picture every frame: fluid, like normal video' },
  { v: 12, label: 'Drawn', tip: '12 pictures a second, each held for a moment, the way hand-drawn animation moves. Kicks, snares and drops still land exactly on time.' },
  { v: 8, label: 'Choppy', tip: '8 pictures a second: a stop-motion feel. Kicks, snares and drops still land exactly on time.' },
];
const FRAMES_NOTE: Record<HandStyle['fps'], string> = {
  60: 'Fluid motion. Try Drawn for a hand-made, less polished feel.',
  12: 'Each picture is held for a moment, like hand-drawn animation. Works with every look and finish.',
  8: 'Fewer pictures, held longer: stop-motion. Works with every look and finish.',
};

/** How many pictures a second: for the whole video, whatever the finish */
function FramesSection() {
  const fps = useStudio((s) => s.hand.fps);
  // hovering a choice explains that choice; otherwise the line describes the one in use
  const [hover, setHover] = useState<HandStyle['fps'] | null>(null);
  const note = hover !== null && hover !== fps ? (FRAMES.find((f) => f.v === hover)?.tip ?? '') : FRAMES_NOTE[fps];
  return (
    <Section id="video.frames" title="Frames" sub="How smoothly the picture moves">
      <Seg value={fps} options={FRAMES} onChange={(v) => useStudio.getState().set({ hand: { ...useStudio.getState().hand, fps: v } })} onHover={setHover} label="Frames" />
      <p className="field-note">{note}</p>
    </Section>
  );
}
const HAND_INKS: { v: HandStyle['inks']; label: string }[] = [
  { v: 0, label: 'All' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 3, label: '3' },
  { v: 4, label: '4' },
];

/** frame rate, inks from the palette, wobble, pencil lines, paper, misprint */
function HandSettings() {
  const hand = useStudio((s) => s.hand);
  const put = (patch: Partial<HandStyle>) => useStudio.getState().set({ hand: { ...useStudio.getState().hand, ...patch } });
  const slider = (key: 'wobble' | 'paper' | 'misprint' | 'lines', name: string, hint: string) => (
    <Field key={key} label={name} value={`${Math.round(hand[key] * 100)}%`} tip={hint}>
      <Slider value={hand[key]} min={0} max={1} step={0.01} onChange={(v) => put({ [key]: v })} />
    </Field>
  );
  return (
    <div className="vp-hand" aria-label="Hand-drawn settings">
      <Field label="Inks" tip="Print with a few flat inks from the palette, or keep every colour.">
        <Seg value={hand.inks} options={HAND_INKS} onChange={(v) => put({ inks: v })} label="Inks" />
      </Field>
      {slider('wobble', 'Wobble', 'How much each drawing strays from the last')}
      {slider('lines', 'Pencil lines', 'An outline wherever the picture has an edge')}
      {slider('paper', 'Paper', 'Paper fibre, grain and uneven ink')}
      {hand.inks > 0 && slider('misprint', 'Misprint', 'Inks printed slightly out of line with each other')}
    </div>
  );
}

/* ───────── movement ───────── */

function ImpactField() {
  const impact = useStudio((s) => s.impact);
  return (
    <Field label="Impact" value={`${Math.round(impact * 100)}%`} tip="How hard the picture reacts to the music. 0% is still, 100% is normal, 200% is wild.">
      <Slider value={impact} min={0} max={2} step={0.05} onChange={(v) => useStudio.getState().set({ impact: v })} />
    </Field>
  );
}

const PACES: { v: Pace; label: string }[] = [
  { v: 'slow', label: 'Slow' },
  { v: 'song', label: 'Normal' },
  { v: 'fast', label: 'Fast' },
];

function PaceField() {
  const pace = useStudio((s) => s.pace);
  return (
    <Field
      label="Pace"
      value={pace === 'song' ? 'Cuts with the music' : pace === 'slow' ? 'Holds longer' : 'Cuts twice as often'}
      tip="Normal: cuts on the music's phrases and hits, faster when it's loud and busy, at least every 10 seconds or so. Slow holds each picture longer; Fast cuts about twice as often. Big drops always cut."
    >
      <Seg value={pace} options={PACES} onChange={(v) => useStudio.getState().set({ pace: v })} label="Pace" />
    </Field>
  );
}

/* ───────── pop-ups ───────── */

const POPUP_MODES: { v: PopupMode; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'video', label: 'In videos' },
  { v: 'always', label: 'Always' },
];

const WINDOW_KINDS: { v: WindowKind; label: string }[] = [
  { v: 'instruments', label: 'Instruments' },
  { v: 'looks', label: 'Looks' },
  { v: 'both', label: 'Both' },
];

function PopupSection() {
  const popups = useStudio((s) => s.popups);
  const windowKind = useStudio((s) => s.windowKind);
  const set = useStudio((s) => s.set);
  return (
    <Section id="video.pops" title="Pop-ups" sub="Little windows that pop in on drops and new parts">
      <Field label="Show them" tip="In videos: while a video plan plays, busier on choruses and drops. Always: a few keep coming whatever is playing.">
        <Seg value={popups} options={POPUP_MODES} onChange={(v) => set({ popups: v })} label="Pop-ups" />
      </Field>
      {popups !== 'off' && (
        <Field
          label="What's in them"
          tip="Instruments: little radar, terminal and Pong windows. Looks: other looks play in little windows over the picture, stacking up on snares and bursting open after a drop. Both: a mix."
        >
          <Seg value={windowKind} options={WINDOW_KINDS} onChange={(v) => set({ windowKind: v })} label="What the windows show" />
        </Field>
      )}
    </Section>
  );
}

/* ───────── transitions ───────── */

const LENGTHS: { v: number; label: string }[] = [
  { v: 0, label: 'Auto' },
  { v: 0.5, label: '½' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 4, label: '4' },
  { v: 8, label: '8' },
];

function TransitionSection() {
  const transition = useStudio((s) => s.transition);
  const beats = useStudio((s) => s.transitionBeats);
  const set = useStudio((s) => s.set);
  const info = TRANSITIONS.find((t) => t.id === transition);
  return (
    <Section id="video.trans" title="Transitions" sub="How one look turns into the next">
      <Field
        label="Style"
        tip="Auto: long dissolves in calm parts, wipes on builds, quick pushes or hard cuts when it's loud. Pick one to use it for every change. Big drops always cut."
      >
        <select className="sel" value={transition} onChange={(e) => set({ transition: e.target.value as typeof transition })} aria-label="Transition">
          <option value="auto">Auto (fits the song)</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <p className="field-note">{transition === 'auto' ? 'Picked to fit the song and the moment' : transition === 'cut' ? 'Hard cuts, no blending' : `Always ${info?.blurb ?? ''}`}</p>
      </Field>
      {transition !== 'cut' && (
        <Field label="Length" value="in beats" tip="How long a transition takes, locked to the song's tempo. Auto: longer in calm parts, short and punchy in loud ones.">
          <Seg value={beats} options={LENGTHS} onChange={(v) => set({ transitionBeats: v })} label="Transition length in beats" />
        </Field>
      )}
    </Section>
  );
}

/* ───────── words ───────── */

const LYRIC_STYLES: { v: LyricStyle; label: string; tip: string }[] = [
  { v: 'auto', label: 'Auto', tip: 'Each part of the song gets its own way of showing the words, like a lyric video' },
  { v: 'subtitle', label: 'Subtitles', tip: 'A quiet caption low in the picture' },
  { v: 'big', label: 'Big', tip: 'One line at a time, set large, each word shown as it is sung' },
  { v: 'cutout', label: 'Collage', tip: 'Each word on its own scrap of printed paper' },
  { v: 'off', label: 'Off', tip: 'No lyrics on the video' },
];

/** "Matches the finish" takes the whole first row; the four kits share the second */
const LETTERING = KIT_CHOICES.map((c) => ({ ...c, span: c.v === 'auto' ? 4 : 1 }));
const KIT_NAME: Record<KitId, string> = { clean: 'clean type', tape: 'Tape lettering', film: 'Film lettering', print: 'Print lettering', hand: 'hand-drawn lettering' };

function WordsSection() {
  const status = useStudio((s) => s.lyricsStatus);
  const style = useStudio((s) => s.lyricStyle);
  const kit = useStudio((s) => s.typeKit);
  const now = useStudio(activeFinish);
  const text = useStudio((s) => s.text);
  const set = useStudio((s) => s.set);
  // hovering a choice explains it; otherwise the line says which lettering is in use
  const [hover, setHover] = useState<TypeKitSetting | null>(null);
  const kitNote =
    hover !== null && hover !== kit
      ? (KIT_CHOICES.find((c) => c.v === hover)?.tip ?? '')
      : kit === 'auto'
        ? `${finishName(now)} finish, so ${KIT_NAME[kitFor('auto', now)]}.`
        : (KIT_CHOICES.find((c) => c.v === kit)?.tip ?? '');
  const pick = (v: TypeKitSetting) => {
    warmKit(kitFor(v, now));
    set({ typeKit: v });
  };
  return (
    <Section id="video.words" title="Words">
      {status === 'found' && (
        <Field label="Lyrics" tip="How the song's words show on the video. More lyric settings (font, timing) are under Lyrics in the top bar.">
          <Seg value={style} options={LYRIC_STYLES} onChange={(v) => set({ lyricStyle: v, lyricStylePicked: true })} label="Lyrics style" />
        </Field>
      )}
      {status === 'found' && (
        <Field label="Lettering" tip="The kind of type the words are set in. Each finish has its own, or pick one for the whole video.">
          <Seg value={kit} options={LETTERING} onChange={pick} onHover={setHover} cols={4} label="Lettering" />
          <p className="field-note">{kitNote}</p>
        </Field>
      )}
      <Field label="Title text" tip="Shown by looks that use text (the instrument boards, mostly)">
        <textarea className="txt" rows={2} placeholder="are you still there" value={text} onChange={(e) => set({ text: e.target.value })} aria-label="Title text" />
      </Field>
    </Section>
  );
}

/* ───────── colours ───────── */

const SONG_COLORS: { v: SongColors; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'blend', label: 'Blend' },
  { v: 'match', label: 'Match' },
];

function ColourSection() {
  const songColors = useStudio((s) => s.songColors);
  return (
    <Section id="video.colours" title="Song colours" sub="Makes a video of many looks feel like one piece">
      <Seg value={songColors} options={SONG_COLORS} onChange={(v) => useStudio.getState().set({ songColors: v })} label="Song colours" />
      <p className="field-note">
        {songColors === 'off' ? 'Each look keeps its own colours.' : songColors === 'blend' ? 'Every look leans toward the colours of the look used most.' : 'Every look uses the colours of the look used most.'}
      </p>
    </Section>
  );
}

/* ───────── more ───────── */

function MoreSection() {
  const oneTap = useStudio((s) => s.oneTap);
  const autoPilot = useStudio((s) => s.autoPilot);
  const quality = useStudio((s) => s.quality);
  const set = useStudio((s) => s.set);
  // the quality governor (src/render/quality.ts) easing off right now; re-renders only when that changes
  const easing = useSyncExternalStore(
    (f) => governor.subscribe(f),
    () => governor.easing,
  );
  return (
    <Section id="video.more" title="More" collapsible defaultOpen={false}>
      <SwitchRow label="Make a video when a song loads" note="Drop a song and it plans the video and plays it from the top" on={oneTap} onChange={(v) => set({ oneTap: v })} />
      <SwitchRow label="Auto-pilot" note="Without a video plan, switch looks on drops and every 8 bars" on={autoPilot} onChange={(v) => set({ autoPilot: v })} />
      <Field
        label="Render quality"
        value={`${Math.round(quality * 100)}%${easing ? ' · easing off' : ''}`}
        tip="The most detail Hum draws. When frames run late it eases off by itself and brings the detail back when there is room. Lower this if it still stutters."
      >
        <Slider value={quality} min={0.4} max={1} step={0.05} onChange={(v) => set({ quality: v })} />
      </Field>
      <PerformanceRow />
      <AccessCodeRow />
      <TasteGroup />
    </Section>
  );
}

/**
 * How the picture is running on this computer, in three lines, and the full report to copy and send
 * (src/render/perfReport.ts). Refreshes once a second, only while More is open.
 */
function PerformanceRow() {
  const [lines, setLines] = useState(perfSummary);
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  useEffect(() => {
    const id = window.setInterval(() => setLines(perfSummary()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const copy = async () => {
    const text = perfReport();
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      // no clipboard permission: put the report in a window the person can copy from
      window.prompt('Copy this report:', text);
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(''), 2500);
  };
  return (
    <Field label="Performance" tip="How smoothly Hum is drawing on this computer. If it stutters, play the song for a minute, press Copy report and send it to us.">
      <div className="field-note" style={{ marginTop: 0 }}>
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      <div className="code-row">
        <span className="spacer" />
        <button className="btn sm ghost" onClick={copy}>
          {copied === 'ok' ? 'Copied' : 'Copy report'}
        </button>
      </div>
    </Field>
  );
}

/** the saved AI access code: quiet, just change or forget it (the gate asks for it when needed) */
function AccessCodeRow() {
  const saved = useAccessGate((s) => s.saved);
  return (
    <div className="code-row">
      <span>AI access code: {saved ? 'saved' : 'none'}</span>
      <span className="spacer" />
      <button className="btn sm ghost" onClick={openAccessGate}>
        {saved ? 'Change' : 'Enter'}
      </button>
      {saved && (
        <button className="btn sm ghost" onClick={forgetAccessCode}>
          Forget
        </button>
      )}
    </div>
  );
}
