/**
 * The Video tab of the right panel: everything that shapes the whole video. Make / Remake, the idea it
 * had, and what the next Make goes by (the mood, how much footage); then one row a setting, each showing
 * what it is set to and opening where it stands: the ones reached for most first (Finish open), the rest
 * folded under More, with the rarely touched switches under Settings in there.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { finishName, type FinishId } from '../core/direction';
import { TRANSITIONS } from '../core/transitionList';
import type { HandStyle } from '../core/types';
import { ownMedia } from '../director/media';
import type { Mix } from '../director/mix';
import { framesNoteShown, framesSentBefore } from '../director/footageNotice';
import { forgetAccessCode, learnCan, learnNeed, openAccessGate, useAccessGate } from '../director/access';
import { quality as governor } from '../render/quality';
import { perfReport, perfSummary } from '../render/perfReport';
import { KIT_CHOICES, kitFor, warmKit, type KitId } from '../render/typeKits';
import { activeFinish, playingDirection } from '../state/direction';
import { setGraphic } from '../state/graphics';
import { inked } from '../state/inks';
import { InkControls } from './InkColours';
import { GRAPHIC_IDS, GRAPHICS } from '../shot/graphics';
import { makeVideo, validPlan } from '../state/plan';
import { useStudio, type LyricStyle, type Pace, type PopupMode, type SongColors, type TypeKitSetting, type WindowKind } from '../state/store';
import { changeLyrics } from './lyricsOpen';
import { DrawingsSection } from './Drawings';
import { FinishTiles, finishTip } from './FinishTiles';
import { getScene } from '../scenes';
import { Field, Group, Section, Seg, Slider, SwitchRow } from './controls';
import { Lock, Sparkle } from './Icons';
import { MOODS } from '../presets/moods';
import { MoodRow } from './Moods';
import { TasteGroup } from './Taste';
import './covers.css';

export function VideoPanel() {
  return (
    <div className="vp">
      <MakeBlock />
      {/* the ones reached for most, Finish open; the rest folded under More (both remembered: controls.tsx) */}
      <Group label="The look of it">
        <FinishSection />
        <ColourSection />
        <TransitionSection />
        <WordsSection />
        <CoversSection />
      </Group>
      <Group label="More" id="video.morefold" hint="Frames, pace, pop-ups, drawings, settings">
        <FramesSection />
        <MoveSection />
        <PopupSection />
        <DrawingsSection />
        <MoreSection />
      </Group>
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
  const making = useStudio((s) => s.making);
  const makeNote = useStudio((s) => s.makeNote);
  const hasPlan = validPlan(plan, analysis);
  const about = plan?.feeling?.about || plan?.flat?.src.feeling?.about;
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
      <FramesNote />
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
        {planning ? (making ? 'Making your video' : 'Planning…') : hasPlan ? 'Remake video' : 'Make a video'}
      </button>
      {making && (
        <div className="vp-step" role="status">
          <span>
            {making.text}
            {making.of ? ` ${making.n} of ${making.of}` : ''}
          </span>
          <button className="btn sm ghost" onClick={() => void import('../director/footageDirector').then((d) => d.cancelMake())}>
            Cancel
          </button>
        </div>
      )}
      {!planning && hasPlan && (plan!.idea || about) && <Story idea={plan!.idea ?? ''} about={about ?? ''} />}
      {!planning && makeNote && <p className="field-note">{makeNote}</p>}
      {!parts && (
        <p className="field-note">
          {!track ? 'Load a song first. Its parts show up on the timeline.' : track.source === 'mic' ? 'Videos need a song file, not live sound.' : 'Listening to the song…'}
        </p>
      )}
      {hasPlan && !planOn && (
        <div className="vp-off">
          <span>The video plan is off, so one look stays on.</span>
          <button className="btn sm" onClick={() => useStudio.getState().set({ planOn: true, autoPilot: false })}>
            Play it
          </button>
        </div>
      )}
      {!!parts && (
        <div className="vp-next">
          <MoodSection />
          <MixField />
        </div>
      )}
    </div>
  );
}

/** what the video is about: the first lines of the idea, and the rest (with what the words say) on a click */
function Story({ idea, about }: { idea: string; about: string }) {
  const [open, setOpen] = useState(false);
  const first = idea || about;
  return (
    <div className={`vp-story ${open ? 'open' : ''}`}>
      <div className="vp-story-h">
        <span className="grp-l">{idea ? 'The idea' : 'What the words say'}</span>
        {(first.length > 120 || (idea && about)) && (
          <button type="button" className="clamp-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
      <p className="vp-idea">{first}</p>
      {open && idea && about && (
        <>
          <span className="grp-l">What the words say</span>
          <p className="vp-about">{about}</p>
        </>
      )}
    </div>
  );
}

function MoodSection() {
  const hasPlan = useStudio((s) => validPlan(s.plan, s.analysis));
  const mood = useStudio((s) => s.plan?.mood ?? null);
  return (
    <Section id="video.mood" title="Mood" sub="One tap plans the whole video again inside one world." value={hasPlan ? (MOODS.find((m) => m.id === mood)?.name ?? 'Any') : 'Any'} collapsible defaultOpen={!hasPlan}>
      <MoodRow />
    </Section>
  );
}

const MIXES: { v: Mix; label: string; tip: string }[] = [
  { v: 'only', label: 'Only mine', tip: 'Every part plays your clips and photos, with nothing else filling the frame' },
  { v: 'most', label: 'Mostly mine', tip: 'Your footage carries the video, and a part or two cut away to one of Hum’s looks' },
  { v: 'mixed', label: 'Mixed', tip: 'About half your footage and half Hum’s looks, each where the song suits it' },
  { v: 'hum', label: 'Mostly Hum', tip: 'Hum’s looks carry the video, and your footage comes in where it counts most' },
];

/** how much of the video is the person's own footage; only once there is some */
function MixField() {
  const ready = useStudio((s) => s.clips.length > 0 || s.photos.filter((p) => !p.builtin).length >= 2);
  const mix = useStudio((s) => s.mix);
  const plan = useStudio((s) => s.plan);
  const analysis = useStudio((s) => s.analysis);
  const stale = validPlan(plan, analysis) && (plan.mix ?? 'most') !== mix;
  if (!ready) return null;
  return (
    <Section id="video.mix" title="Your footage" sub={MIXES.find((m) => m.v === mix)?.tip} value={`${MIXES.find((m) => m.v === mix)?.label ?? ''}${stale ? ' · remake to use' : ''}`} collapsible defaultOpen={false}>
      <Seg value={mix} cols={2} options={MIXES} onChange={(v) => useStudio.getState().set({ mix: v })} label="How much of the video is your footage" />
    </Section>
  );
}

/**
 * Said before the first small frames of the person's own footage are sent, while there is any; it goes once
 * they have been. Until it has been on screen nothing is sent (state/plan.ts makeVideo).
 */
function FramesNote() {
  const clips = useStudio((s) => s.clips);
  const photos = useStudio((s) => s.photos);
  const making = useStudio((s) => !!s.making);
  const [before] = useState(framesSentBefore);
  const media = clips.length + photos.length > 0 ? ownMedia() : [];
  const show = media.length > 0 && !before && (making || !framesSentBefore());
  useEffect(() => {
    if (show) framesNoteShown();
  }, [show]);
  if (!show) return null;
  const what = media.every((m) => m.kind === 'photo') ? 'your photos' : media.every((m) => m.kind === 'clip') ? 'your clips' : 'your clips and photos';
  return <p className="field-note">{`To direct from ${what}, Hum sends Claude a few small frames of each, once. Whole files and sound stay on this computer.`}</p>;
}

/* ───────── finish, with the hand-drawn settings under it ───────── */

function FinishSection() {
  const finish = useStudio((s) => s.finish);
  const fullColour = useStudio((s) => s.hand.inks === 0);
  const dir = useStudio(playingDirection);
  const lookName = useStudio((s) => getScene(s.sceneId)?.name ?? 'This look');
  // the tile under the pointer: the line says what it is while the video tries it on
  const [trying, setTrying] = useState<'auto' | FinishId | null>(null);
  // what is drawn without the tile being tried (activeFinish reads the preview too)
  const shown = useStudio((s) => activeFinish({ ...s, finishPreview: null }));
  const note =
    trying !== null && !(trying === finish && (trying === 'auto' || shown === trying))
      ? `${finishTip(trying)} Showing on the video: click to keep it.`
      : finish === 'auto'
        ? dir
          ? `This video uses ${finishName(dir.finish)}.`
          : `No video playing, so ${finishName(shown)}.`
        : shown !== finish
          ? `${lookName} stays clean under ${finishName(finish)}, the default. Click ${finishName(finish)} to draw it anyway.`
          : finish === 'hand'
            ? 'Wobbly lines and flat inks, like hand animation. (H)'
            : finishTip(finish);
  return (
    <Section id="video.finish" title="Finish" sub="One surface over every look, like shooting it all on the same film." value={finish === 'auto' ? `Auto · ${finishName(shown)}` : finishName(shown)} collapsible defaultOpen>
      <FinishTiles onTry={setTrying} />
      <p className="field-note fin-note">{note}</p>
      {/* the finish's own settings fold under one row, so Finish can stay open without filling the tab; they
          follow the finish picked, not one being tried on, so nothing jumps while hovering */}
      {inked(shown) && (
        <Section id="video.finish.tune" title={`Fine-tune ${finishName(shown)}`} value={shown === 'hand' ? 'Colours, lines, paper' : 'Colours'} collapsible defaultOpen={false}>
          <InkControls full={shown === 'hand' && fullColour} />
          {shown === 'hand' && <HandSettings />}
        </Section>
      )}
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
    <Section id="video.frames" title="Frames" value={FRAMES.find((f) => f.v === fps)?.label ?? ''} collapsible defaultOpen={false}>
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
      <Field label="Inks" tip="Print with a few flat inks of these colours, or keep every colour.">
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

function MoveSection() {
  const impact = useStudio((s) => s.impact);
  const pace = useStudio((s) => s.pace);
  return (
    <Section id="video.move" title="Impact and pace" value={`${Math.round(impact * 100)}% · ${PACES.find((p) => p.v === pace)?.label ?? ''}`} collapsible defaultOpen={false}>
      <ImpactField />
      <PaceField />
      <SmoothField />
    </Section>
  );
}

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

/** clips running slowly glide between their frames; only once there are clips */
function SmoothField() {
  const clips = useStudio((s) => s.clips.length > 0);
  const on = useStudio((s) => s.smoothSlow);
  if (!clips) return null;
  return <SwitchRow label="Smooth slow motion" note="Slow clips glide instead of stepping from frame to frame" on={on} onChange={(v) => useStudio.getState().set({ smoothSlow: v })} />;
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
    <Section id="video.pops" title="Pop-ups" sub="Little windows that pop in on drops and new parts." value={POPUP_MODES.find((m) => m.v === popups)?.label ?? ''} collapsible defaultOpen={false}>
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
    <Section id="video.trans" title="Transitions" sub="How one look turns into the next." value={`${transition === 'auto' ? 'Auto' : (info?.name ?? transition)}${transition !== 'cut' && beats ? ` · ${beats === 0.5 ? '½' : beats} ${beats <= 1 ? 'beat' : 'beats'}` : ''}`} collapsible defaultOpen={false}>
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

/* ───────── what covers the picture ───────── */

function CoversSection() {
  const off = useStudio((s) => s.graphicsOff);
  const clips = useStudio((s) => s.clips.length + s.photos.filter((p) => !p.builtin).length > 0);
  const [hover, setHover] = useState<string | null>(null);
  const on = GRAPHIC_IDS.length - off.length;
  const tip = GRAPHICS.flatMap((g) => g.items).find((x) => x.id === hover)?.tip;
  return (
    <Section id="video.covers" title="Graphics" sub="What may go over your clips. A part can have its own answer in the Part tab." value={on === GRAPHIC_IDS.length ? 'All on' : on ? `${on} of ${GRAPHIC_IDS.length} on` : 'All off'} collapsible defaultOpen={false}>
      <div className="cov-all">
        <button className="btn sm" disabled={!off.length} onClick={() => useStudio.getState().set({ graphicsOff: [] })}>
          All on
        </button>
        <button className="btn sm" disabled={!on} onClick={() => useStudio.getState().set({ graphicsOff: [...GRAPHIC_IDS] })}>
          All off
        </button>
      </div>
      {GRAPHICS.map((g) => (
        <Field key={g.group} label={g.group}>
          <div className="cov" role="group" aria-label={g.group}>
            {g.items.map((x) => {
              const is = !off.includes(x.id);
              return (
                <button key={x.id} className={`cov-chip ${is ? 'on' : ''}`} aria-pressed={is} onClick={() => setGraphic(x.id, !is)} onPointerEnter={() => setHover(x.id)} onPointerLeave={() => setHover(null)}>
                  <i aria-hidden />
                  {x.label}
                </button>
              );
            })}
          </div>
        </Field>
      ))}
      <p className="field-note">{tip ? `${tip}.` : clips ? 'A shot with its graphic off plays the same clip, clean. Turn it back on and it returns.' : 'These show on videos made with your clips and photos.'}</p>
    </Section>
  );
}

/* ───────── words ───────── */

const LYRIC_STYLES: { v: LyricStyle; label: string; span: number; tip: string }[] = [
  { v: 'auto', label: 'Auto', span: 3, tip: 'Each part of the song gets its own way of showing the words, like a lyric video' },
  { v: 'subtitle', label: 'Subtitles', span: 3, tip: 'A quiet caption low in the picture' },
  { v: 'big', label: 'Big', span: 2, tip: 'One line at a time, set large, each word shown as it is sung' },
  { v: 'cutout', label: 'Collage', span: 2, tip: 'Each word on its own scrap of printed paper' },
  { v: 'off', label: 'Off', span: 2, tip: 'No lyrics on the video' },
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
    <Section id="video.words" title="Words" value={status === 'found' ? (LYRIC_STYLES.find((l) => l.v === style)?.label ?? '') : text.trim() ? 'Title' : 'No lyrics'} collapsible defaultOpen={false}>
      {(status === 'found' || status === 'plain' || status === 'none') && (
        <button className="btn sm ghost" onClick={changeLyrics}>
          {status === 'none' ? 'Find lyrics…' : 'Wrong lyrics? Change them…'}
        </button>
      )}
      {status === 'found' && (
        <Field label="Lyrics" tip="How the song's words show on the video. More lyric settings (font, timing) are under Lyrics in the top bar.">
          <Seg value={style} options={LYRIC_STYLES} cols={6} onChange={(v) => set({ lyricStyle: v, lyricStylePicked: true })} label="Lyrics style" />
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
    <Section id="video.colours" title="Song colours" sub="Makes a video of many looks feel like one piece." value={SONG_COLORS.find((c) => c.v === songColors)?.label ?? ''} collapsible defaultOpen={false}>
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
  const planOn = useStudio((s) => s.planOn);
  const hasPlan = useStudio((s) => validPlan(s.plan, s.analysis));
  const quality = useStudio((s) => s.quality);
  const set = useStudio((s) => s.set);
  // the quality governor (src/render/quality.ts) easing off right now; re-renders only when that changes
  const easing = useSyncExternalStore(
    (f) => governor.subscribe(f),
    () => governor.easing,
  );
  return (
    <Section id="video.more" title="Settings" value={quality < 1 ? `Quality ${Math.round(quality * 100)}%` : ''} collapsible defaultOpen={false}>
      {hasPlan && (
        <SwitchRow
          label="Play the video plan"
          note={planOn ? 'Looks change with each part of the song' : 'One look stays until you pick another'}
          on={planOn}
          onChange={(v) => set({ planOn: v, autoPilot: v ? false : useStudio.getState().autoPilot })}
        />
      )}
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
