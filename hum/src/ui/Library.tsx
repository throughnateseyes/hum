import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { STYLES, sceneStyle } from '../core/styles';
import type { LookRole, LookTheme, Preset, SceneCategory, TrackAnalysis } from '../core/types';
import { allScenes, getScene } from '../scenes';
import { presetToLook } from '../presets/apply';
import { bestTake, familyIdOf, familyOf, fitScore, ROLES, takeName, THEMES, withCustom, type LookFamily } from '../presets/fit';
import { audioEngine } from '../audio/engine';
import { live } from '../state/live';
import { findLook, partEnergy, pickLook, pickScene, sectionIndexAt, sectionNames } from '../state/plan';
import './library.css';
import { sceneLook, useStudio } from '../state/store';
import { withTweak, type LookTweak } from '../state/tweaks';
import { addClipFiles, handleFiles } from '../state/tracks';
import { noteHandPick } from '../state/taste';
import { lookShows, playsClips, sceneShows } from '../director/footage';
import { useCanDraw, useDrawingsHere } from '../draw/hooks';
import { DrawingsTab } from './Drawings';
import { Chevron, Cube, Film, Grid, Image as ImageIcon, Layers, Plus, Sparkle, X } from './Icons';
import { hidePeek, peekHandlers } from './Peek';
import { canShow, giveMedia, hereTarget, MEDIA_MIME, pictureKind, targetWords } from './footageMedia';

type Tab = 'looks' | 'photos' | 'footage' | 'drawings';

/* real thumbnails are captured from the stage the first time a look is shown */
const thumbs = new Map<string, string>();
const thumbListeners = new Set<() => void>();
function useThumb(id: string) {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    thumbListeners.add(f);
    return () => {
      thumbListeners.delete(f);
    };
  }, []);
  return thumbs.get(id);
}
async function captureThumb(id: string) {
  const stage = live.stage;
  if (!stage || thumbs.has(id)) return;
  thumbs.set(id, stage.capture(120, 120).toDataURL('image/jpeg', 0.8));
  thumbListeners.forEach((f) => f());
}

const CAT_GLYPH: Record<SceneCategory, typeof Cube> = { form: Cube, field: Layers, photo: ImageIcon, board: Grid, code: Sparkle };
const Glyph = ({ c }: { c: SceneCategory }) => {
  const I = CAT_GLYPH[c];
  return (
    <span className="glyph">
      <I width={14} height={14} />
    </span>
  );
};

/** drag a look card onto a song-map section */
export const LOOK_MIME = 'application/x-hum-look';

/* thumbnails rendered from each built-in look (src/dev/thumbs.ts makes them) */
export const STATIC_THUMBS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../assets/thumbs/*.jpg', { eager: true, import: 'default', query: '?url' })).map(([path, url]) => [
    path.split('/').pop()!.replace(/\.jpg$/, ''),
    url,
  ]),
);

export function Thumb({ p }: { p: Preset }) {
  const captured = useThumb(p.id);
  const url = STATIC_THUMBS[p.id] ?? captured;
  if (url) return <img src={url} alt="" loading="lazy" decoding="async" />;
  const cat = getScene(p.sceneId)?.category ?? 'field';
  const { bg, fg, accent, accent2 } = p.palette;
  return (
    <svg viewBox="0 0 54 54" width="100%" height="100%" style={{ display: 'block', background: bg }}>
      {cat === 'form' && <circle cx="27" cy="28" r="14" fill={accent} opacity="0.9" />}
      {cat === 'form' && <circle cx="22" cy="23" r="5" fill={accent2} opacity="0.7" />}
      {cat === 'field' &&
        [0, 1, 2, 3, 4, 5].map((i) => (
          <path key={i} d={`M0 ${12 + i * 6} Q 14 ${4 + i * 7} 27 ${12 + i * 6} T 54 ${12 + i * 6}`} stroke={i % 2 ? accent2 : accent} fill="none" strokeWidth="1.4" />
        ))}
      {cat === 'photo' &&
        [0, 1, 2, 3].map((i) => <rect key={i} x={6 + (i % 2) * 22} y={8 + Math.floor(i / 2) * 20} width="20" height="18" fill={i === 1 ? accent : accent2} opacity={0.5 + i * 0.12} />)}
      {cat === 'board' && (
        <g stroke={fg} strokeWidth="0.6" fill="none" opacity="0.7">
          <rect x="5" y="5" width="44" height="22" />
          <rect x="5" y="30" width="21" height="19" />
          <rect x="28" y="30" width="21" height="19" />
          <path d={`M7 20 L12 14 L17 18 L22 9 L27 16 L32 12 L37 19 L42 11 L47 15`} stroke={accent} strokeWidth="1.2" />
          <circle cx="38.5" cy="39.5" r="6" stroke={accent} />
        </g>
      )}
      {cat === 'code' && (
        <text x="27" y="32" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="12" fill={accent}>
          {'{ }'}
        </text>
      )}
    </svg>
  );
}

/**
 * The Library: three tabs that all work the same way. Each opens with one short line saying what
 * it's for and one control (search, or add), then the list or grid. The raw scenes looks are built
 * from live at the bottom of Looks, folded away, since few people need them.
 */
export function Library() {
  const [tab, setTab] = useState<Tab>('looks');
  const photos = useStudio((s) => s.photos.filter((p) => !p.builtin).length);
  const clips = useStudio((s) => s.clips.length);
  // the drawings shelf isn't there at all for people whose access doesn't include drawings
  const canDraw = useCanDraw();
  const drawn = useDrawingsHere().length;
  const drawnScenes = drawn ? allScenes().filter((s) => (s.usesDrawings || s.usesFigures) && sceneShows(s)) : [];
  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: 'looks', label: 'Looks', n: 0 },
    { id: 'photos', label: 'Photos', n: photos },
    { id: 'footage', label: 'Footage', n: clips },
    ...(canDraw ? [{ id: 'drawings' as const, label: 'Drawings', n: 0 }] : []),
  ];
  return (
    <aside className="library">
      {/* the same segmented control as the right panel's tabs (Inspector.tsx) */}
      <div className="insp-tabs lib-tabs">
        <div className={`seg full ${canDraw ? 'four' : ''}`} role="tablist" aria-label="Library">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.n > 0 && <span className="tab-n">{t.n}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === 'looks' && <Looks onAddFootage={() => setTab('footage')} />}
        {tab === 'photos' && <Photos />}
        {tab === 'footage' && <Footage />}
        {tab === 'drawings' && canDraw && (
          <>
            <DrawingsTab />
            {drawnScenes.length > 0 && <SceneRows label="Looks made of drawings" scenes={drawnScenes} />}
          </>
        )}
      </div>
    </aside>
  );
}

/** the top of every Library tab: one line on what it's for, then its one control */
function TabHead({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="lib-head">
      <p className="lib-note">{note}</p>
      {children}
    </div>
  );
}

/* ───────── looks: one card per family, filtered by the job it does and what it's of ───────── */

type PartFilter = LookRole | 'now' | 'all';

/** short chip labels for the parts (the full names are the chips' tooltips) */
const PART_CHIP: Record<LookRole, string> = { intro: 'Intro', verse: 'Verse', build: 'Build', peak: 'Drop', break: 'Break', bridge: 'Bridge', outro: 'Outro' };
/** a family "fits" a part when it scores at least this (presets/fit.ts fitScore) */
const FITS = 0.35;

/** the section playing now, polled twice a second while something needs it */
function useSectionNow(a: TrackAnalysis | null, on: boolean): number {
  const [i, setI] = useState(-1);
  useEffect(() => {
    if (!a || !on) return;
    const tick = () => setI(sectionIndexAt(a.sections, audioEngine.currentTime));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [a, on]);
  return a && on ? i : -1;
}

/** lower-case text a family is found by: its name, idea, takes, tags and themes */
const searchText = new WeakMap<LookFamily, string>();
function haystack(f: LookFamily): string {
  let s = searchText.get(f);
  if (!s) {
    const themes = f.fit.themes.map((t) => THEMES.find((x) => x.id === t)?.label ?? t);
    s = [f.name, f.blurb, ...themes, ...f.takes.flatMap((p) => [p.name, takeName(p), p.description, ...p.tags])].join(' ').toLowerCase();
    searchText.set(f, s);
  }
  return s;
}

function Looks({ onAddFootage }: { onAddFootage: () => void }) {
  const presetId = useStudio((s) => s.presetId);
  const hasClips = useStudio((s) => s.clips.length > 0);
  const [blocks, setBlocks] = useState(false);
  // (which kinds: the Sketchbook looks and the line figure looks come and go apart)
  const drawnKinds = [...new Set(useDrawingsHere().map((d) => d.kind))].sort().join();
  const ownLooks = useStudio((s) => s.customPresets);
  // looks made of drawings only exist once this song has some
  const custom = useMemo(() => ownLooks.filter(lookShows), [ownLooks, drawnKinds]);
  const analysis = useStudio((s) => s.analysis);
  const deleteCustomPreset = useStudio((s) => s.deleteCustomPreset);
  const [part, setPart] = useState<PartFilter>('all');
  const [theme, setTheme] = useState<LookTheme | 'all'>('all');
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const suggested = analysis?.suggestedPresets ?? EMPTY;
  const nowIdx = useSectionNow(analysis, part === 'now');
  const nowSec = analysis && nowIdx >= 0 ? analysis.sections[nowIdx] : null;
  const nowName = analysis && nowIdx >= 0 ? sectionNames(analysis.sections)[nowIdx] : '';
  const currentFamily = useMemo(() => {
    const p = presetId ? findLook(presetId) : undefined;
    return p ? familyIdOf(p) : null;
  }, [presetId]);

  const { families, loose } = useMemo(() => withCustom(custom), [custom]);
  // footage looks play the person's own clips: with none added they'd show nothing, so they stay out
  // of the list (one quiet row below says how to bring them in)
  const usable = useMemo(
    () => families.filter((f) => f.takes.some((p) => getScene(p.sceneId)) && (hasClips || !f.takes.every((p) => playsClips(p))) && f.takes.some(lookShows)),
    [families, hasClips, drawnKinds],
  );
  const footageHidden = !hasClips && families.some((f) => f.takes.length > 0 && f.takes.every((p) => playsClips(p)));
  const filtering = part !== 'all' || theme !== 'all' || !!q;
  const ranked = suggested.length > 0 && !filtering;

  const { list, near } = useMemo((): { list: LookFamily[]; near: boolean } => {
    const rankOf = (f: LookFamily) => {
      let r = 999;
      for (const p of f.takes) {
        const i = suggested.indexOf(p.id);
        if (i >= 0 && i < r) r = i;
      }
      return r;
    };
    let l = usable;
    if (theme !== 'all') l = l.filter((f) => f.fit.themes.includes(theme));
    if (q) l = l.filter((f) => q.split(/\s+/).every((w) => haystack(f).includes(w)));
    // the job: families that fit the part, best fit first (the part playing now is judged at its own energy)
    const fitOf =
      part === 'now'
        ? nowSec && analysis
          ? (f: LookFamily) => fitScore(bestTake(f, suggested), nowSec.label, partEnergy(analysis, nowIdx))
          : null
        : part !== 'all'
          ? (f: LookFamily) => fitScore(bestTake(f, suggested), part)
          : null;
    if (fitOf) {
      // the fit decides who's in; the song's ranking only nudges the order (up to +0.25 for its first pick)
      const nudge = (f: LookFamily) => {
        const r = rankOf(f);
        return r < suggested.length ? 0.25 * (1 - r / suggested.length) : 0;
      };
      const all = l.map((f) => ({ f, fit: fitOf(f) })).sort((x, y) => y.fit + nudge(y.f) - (x.fit + nudge(x.f)));
      const fits = all.filter((x) => x.fit >= FITS - 0.16);
      // nothing of this theme does the job: the closest few rather than an empty panel
      if (!fits.length && all.length) return { list: all.slice(0, 4).map((x) => x.f), near: true };
      return { list: fits.map((x) => x.f), near: false };
    }
    // a search lists name matches first ("night" → Night Windows before a look that mentions midnight)
    const tier = (f: LookFamily) => (!q ? 0 : f.name.toLowerCase().includes(q) ? 0 : f.takes.some((p) => takeName(p).toLowerCase().includes(q)) ? 1 : 2);
    if (suggested.length || q) return { list: [...l].sort((a, b) => tier(a) - tier(b) || rankOf(a) - rankOf(b)), near: false };
    return { list: l, near: false };
  }, [usable, theme, q, part, nowSec, nowIdx, analysis, suggested]);

  // with no song to rank against and no filter, families are listed theme by theme
  const groups = useMemo(() => {
    if (ranked || filtering) return null;
    return THEMES.map((t) => ({ id: t.id as string, label: t.label, hint: t.hint, looks: list.filter((f) => f.fit.themes[0] === t.id) })).filter((g) => g.looks.length);
  }, [ranked, filtering, list]);
  const top = useMemo(() => new Set(ranked ? list.slice(0, 3).map((f) => f.id) : []), [ranked, list]);

  // capture a thumbnail for whatever look is showing
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!presetId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void captureThumb(presetId), 1600);
  }, [presetId]);

  const title =
    part === 'now'
      ? nowName
        ? `${near ? 'Closest for' : 'Fits'} ${nowName}`
        : 'Play the song to fit the part'
      : part !== 'all'
        ? `${near ? 'Closest for' : 'Fits'} the ${ROLES.find((r) => r.id === part)?.label.toLowerCase()}`
        : ranked
          ? 'Ranked for this track'
          : 'Looks';

  // the footage row shows with no filter, or when a search is after video
  const showFootageRow = footageHidden && part === 'all' && theme === 'all' && (!q || /foot|video|clip|film/.test(q));

  return (
    <>
      <TabHead note="Click a look to play it, or drag it onto a part of the song.">
        <input className="txt lib-search" type="search" placeholder={`Search ${usable.length} looks`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search looks" />
      </TabHead>
      <div className="filter-row slide" role="group" aria-label="Part of the song">
        <span className="filter-name" title="The job a look does in a song">Part</span>
        <button className={`chip ${part === 'all' ? 'on' : ''}`} onClick={() => setPart('all')}>
          Any
        </button>
        {analysis && (
          <button className={`chip now ${part === 'now' ? 'on' : ''}`} title="Looks that fit the part of the song playing now" onClick={() => setPart(part === 'now' ? 'all' : 'now')}>
            Playing now
          </button>
        )}
        {ROLES.map((r) => (
          <button key={r.id} className={`chip ${part === r.id ? 'on' : ''}`} title={`${r.label}: ${r.hint}`} onClick={() => setPart(part === r.id ? 'all' : r.id)}>
            {PART_CHIP[r.id]}
          </button>
        ))}
      </div>
      <div className="filter-row slide" role="group" aria-label="Theme">
        <span className="filter-name" title="What a look is of">Theme</span>
        <button className={`chip ${theme === 'all' ? 'on' : ''}`} onClick={() => setTheme('all')}>
          Any
        </button>
        {THEMES.map((t) => (
          <button key={t.id} className={`chip ${theme === t.id ? 'on' : ''}`} title={t.hint} onClick={() => setTheme(theme === t.id ? 'all' : t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {showFootageRow && (
        <button className="lib-footage-row" onClick={onAddFootage} title="Opens the Footage tab">
          <Film width={14} height={14} aria-hidden />
          <span>
            <b>Footage</b>: add clips to use your own video
          </span>
        </button>
      )}
      {custom.length > 0 && !filtering && (
        <>
          <div className="section-h">
            <span className="label">Yours</span>
            <span className="label">{custom.length}</span>
          </div>
          <div className="cards">
            {custom.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <PresetCard p={p} on={presetId === p.id} sub={!loose.includes(p) ? `A take of ${familyOf(p).name}` : undefined} onClick={() => handPick(p)} />
                <button className="btn icon sm ghost card-del" onClick={() => deleteCustomPreset(p.id)} title="Delete look">
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {(groups ?? [{ id: 'all', label: title, hint: '', looks: list }]).map((g) => (
        <div key={g.id}>
          <div className="section-h" title={g.hint || undefined}>
            <span className="label">{g.label}</span>
            <span className="label">{g.looks.length}</span>
          </div>
          <div className="cards">
            {g.looks.map((f) => (
              <FamilyCard key={f.id} f={f} take={bestTake(f, suggested)} on={currentFamily === f.id} presetId={presetId} fits={top.has(f.id)} />
            ))}
          </div>
        </div>
      ))}
      {list.length === 0 && <p className="lib-empty">{part === 'now' && !nowName ? 'Play the song and the looks that fit the part playing will show here.' : 'No looks match. Try another part or theme.'}</p>}
      {!filtering && (
        <>
          <button className={`lib-more ${blocks ? 'open' : ''}`} aria-expanded={blocks} onClick={() => setBlocks(!blocks)}>
            <Chevron width={12} height={12} aria-hidden />
            {blocks ? 'Hide the building blocks' : 'Show the building blocks'}
          </button>
          {blocks && (
            <div className="lib-blocks">
              <p className="lib-note">The plain scenes every look is made from. Click one to switch to it and keep your colours and effects.</p>
              <Scenes />
            </div>
          )}
        </>
      )}
    </>
  );
}

const EMPTY: string[] = [];

/** a look clicked in the library counts toward the person's taste */
function handPick(p: Preset) {
  noteHandPick(p, 'pick');
  pickLook(p);
}

/**
 * One card per family: the take it would play (the one that suits the song, else the last one used),
 * its name and idea, and a swatch per take; click a swatch to play that take straight away.
 */
const FamilyCard = memo(function FamilyCard({ f, take, on, presetId, fits }: { f: LookFamily; take: Preset; on: boolean; presetId: string | null; fits: boolean }) {
  const showing = on ? (f.takes.find((p) => p.id === presetId) ?? take) : take;
  return (
    <div className={`card fam ${on ? 'on' : ''}`}>
      <button
        className="card-hit"
        draggable
        onDragStart={(e) => {
          hidePeek();
          e.dataTransfer.setData(LOOK_MIME, showing.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        {...peekHandlers({
          key: showing.id,
          title: f.takes.length > 1 ? `${f.name} · ${takeName(showing)}` : f.name,
          hint: 'Click to use this look',
          poster: STATIC_THUMBS[showing.id],
          getLook: () => (useStudio.getState().presetId === showing.id ? null : presetPeekLook(showing)),
        })}
        onClick={() => {
          hidePeek();
          handPick(showing);
        }}
        aria-label={`${f.name}${f.takes.length > 1 ? `, ${f.takes.length} takes` : ''}`}
      />
      <div className="thumb">
        <Thumb p={showing} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="title">
          <span>{f.name}</span>
          {fits && <span className="suggested">Fits</span>}
        </div>
        <div className="desc">{f.blurb}</div>
        {f.takes.length > 1 && (
          <div className="takes" role="group" aria-label={`${f.name} takes`}>
            {f.takes.map((p) => (
              <button
                key={p.id}
                className={`take-dot ${p.id === showing.id ? 'on' : ''}`}
                title={takeName(p)}
                aria-label={takeName(p)}
                style={{ background: `linear-gradient(135deg, ${p.palette.bg} 50%, ${p.palette.accent} 50%)` }}
                onClick={() => {
                  hidePeek();
                  handPick(p);
                }}
              />
            ))}
            <span className="takes-n">{f.takes.length} takes</span>
          </div>
        )}
      </div>
    </div>
  );
});

/** hover a scene row to preview it (current colours and effects), click to switch */
function sceneRowProps(id: string, name: string, pick: () => void) {
  return {
    ...peekHandlers({
      key: `scene:${id}`,
      title: name,
      hint: 'Click to switch to this scene',
      getLook: () => {
        const s = useStudio.getState();
        if (s.sceneId === id) return null;
        const look = sceneLook(id, s.modulations);
        return look && { ...look, effects: s.effects, palette: s.palette };
      },
    }),
    onClick: () => {
      hidePeek();
      pick();
    },
  };
}

/*
 * preset looks keep stable effect ids so the preview doesn't recompile shaders on every hover; a look
 * fine-tuned for this video previews with its tweak on (state/tweaks.ts), so what you see is what plays
 */
const peekLooks = new Map<string, { t: LookTweak | undefined; look: ReturnType<typeof presetToLook> }>();
function presetPeekLook(p: Preset) {
  const t = useStudio.getState().tweaks[p.id];
  let l = peekLooks.get(p.id);
  if (!l || l.t !== t) peekLooks.set(p.id, (l = { t, look: presetToLook(withTweak(p, t)) }));
  return l.look;
}

function PresetCard({ p, on, suggested, sub, onClick }: { p: Preset; on: boolean; suggested?: boolean; sub?: string; onClick: () => void }) {
  return (
    <button
      className={`card ${on ? 'on' : ''}`}
      draggable
      onDragStart={(e) => {
        hidePeek();
        e.dataTransfer.setData(LOOK_MIME, p.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      {...peekHandlers({
        key: p.id,
        title: p.name,
        hint: 'Click to use this look',
        poster: STATIC_THUMBS[p.id],
        getLook: () => (useStudio.getState().presetId === p.id ? null : presetPeekLook(p)),
      })}
      onClick={() => {
        hidePeek();
        onClick();
      }}
    >
      <div className="thumb">
        <Thumb p={p} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="title">
          <span>{p.name}</span>
          {suggested && <span className="suggested">Fits</span>}
        </div>
        <div className="desc">{sub ?? p.description}</div>
      </div>
    </button>
  );
}

function Scenes() {
  const sceneId = useStudio((s) => s.sceneId);
  useStudio((s) => s.customShaders.length); // re-render when AI scenes are added
  useDrawingsHere();
  const scenes = allScenes().filter(sceneShows);
  // by style family; scenes Claude wrote for you come last as their own group
  const groups = [
    ...STYLES.map((st) => ({ key: st.id as string, label: st.label, hint: st.hint, list: scenes.filter((s) => s.category !== 'code' && sceneStyle(s) === st.id) })),
    { key: 'code', label: 'Generated', hint: 'Scenes Claude wrote for you', list: scenes.filter((s) => s.category === 'code') },
  ];
  return (
    <>
      {groups.map(({ key, label, hint, list }) => {
        if (!list.length) return null;
        return (
          <div key={key}>
            <div className="section-h" title={hint}>
              <span className="label">{label}</span>
              <span className="label">{list.length}</span>
            </div>
            {list.map((s) => (
              <button key={s.id} className={`scene-row ${sceneId === s.id ? 'on' : ''}`} {...sceneRowProps(s.id, s.name, () => pickScene(s.id))}>
                <Glyph c={s.category} />
                <span style={{ minWidth: 0 }}>
                  <div className="t">{s.name}</div>
                  <div className="d">{s.description}</div>
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** a scene row in the Photos and Footage tabs: the looks that use what you added */
function SceneRows({ label, scenes }: { label: string; scenes: { id: string; name: string; description: string; category: SceneCategory }[] }) {
  if (!scenes.length) return null;
  return (
    <>
      <div className="section-h">
        <span className="label">{label}</span>
      </div>
      {scenes.map((s) => (
        <button key={s.id} className="scene-row" {...sceneRowProps(s.id, s.name, () => pickScene(s.id))}>
          <Glyph c={s.category} />
          <span style={{ minWidth: 0 }}>
            <div className="t">{s.name}</div>
            <div className="d">{s.description}</div>
          </span>
        </button>
      ))}
    </>
  );
}

function Photos() {
  const photos = useStudio((s) => s.photos);
  const removePhoto = useStudio((s) => s.removePhoto);
  const input = useRef<HTMLInputElement>(null);
  const photoScenes = allScenes().filter((s) => s.usesPhotos);
  // the built-in stand-in photo isn't one of yours: it isn't listed and can't be removed
  const mine = photos.filter((p) => !p.builtin);
  return (
    <>
      <TabHead note="Photo looks break up and rebuild your photos to the music. Drag one onto a part to put it there.">
        <button className="btn lib-add" onClick={() => input.current?.click()}>
          <Plus width={14} height={14} aria-hidden /> Add photos
        </button>
      </TabHead>
      {mine.length ? (
        <div className="lib-grid">
          {mine.map((p) => (
            <div className="lib-tile" key={p.id} {...mediaDrag(p.id)}>
              <div className="lib-tile-img">
                <PhotoImg src={p.image} />
                <UseHere id={p.id} kind="photo" name={p.name} />
                <button className="lib-tile-del" onClick={() => removePhoto(p.id)} aria-label={`Remove photo ${p.name}`} title="Remove">
                  <X width={11} height={11} aria-hidden />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="lib-empty">No photos yet. You can also drop them anywhere on the page.</p>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <SceneRows label="Looks that use photos" scenes={photoScenes} />
    </>
  );
}

const fmtClipLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Your video clips: a tidy grid of uniform tiles that always fits the panel, each tile showing the
 * clip at its own shape (tall, wide or square), its length, and a remove button on hover or focus.
 */
function Footage() {
  const clips = useStudio((s) => s.clips);
  const removeClip = useStudio((s) => s.removeClip);
  const input = useRef<HTMLInputElement>(null);
  const clipScenes = allScenes().filter((s) => s.usesClips);
  return (
    <>
      <TabHead note="Your clips become the picture in the Footage look, cut to the song. Drag one onto a part to put it there.">
        <button className="btn lib-add" onClick={() => input.current?.click()}>
          <Plus width={14} height={14} aria-hidden /> Add clips
        </button>
      </TabHead>
      {clips.length ? (
        <div className="lib-grid">
          {clips.map((c) => (
            <div className="lib-tile" key={c.id} {...mediaDrag(c.id)}>
              <div className="lib-tile-img clip">
                <img src={c.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
                <UseHere id={c.id} kind="clip" name={c.name} />
                <span className="lib-tile-len" aria-label={`${Math.round(c.duration)} seconds`}>
                  {fmtClipLen(c.duration)}
                </span>
                <button className="lib-tile-del" onClick={() => removeClip(c.id)} aria-label={`Remove clip ${c.name}`} title="Remove">
                  <X width={11} height={11} aria-hidden />
                </button>
              </div>
              <div className="lib-tile-name" title={c.name}>
                {c.name}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="lib-empty">No clips yet. You can also drop videos anywhere on the page once a song is playing.</p>
      )}
      <input
        ref={input}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addClipFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {clips.length > 0 && <SceneRows label="Looks that use your clips" scenes={clipScenes} />}
    </>
  );
}

/** a clip or photo tile can be dragged onto a part on the timeline, or onto the stage */
function mediaDrag(id: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      hidePeek();
      e.dataTransfer.setData(MEDIA_MIME, id);
      e.dataTransfer.effectAllowed = 'copy';
    },
  };
}

/**
 * "Use for this shot" on a clip or photo tile, on hover or focus: shown while parts are picked (or a look
 * that shows pictures plays on its own), it makes this the picture there (footageMedia.ts giveMedia).
 */
function UseHere({ id, kind, name }: { id: string; kind: 'clip' | 'photo'; name: string }) {
  const picked = useStudio((s) => s.selectedParts.length);
  const solo = useStudio((s) => !s.planOn || !s.plan);
  const soloKind = useStudio((s) => pictureKind(s.sceneId));
  const busy = useStudio((s) => !!s.clip);
  if (!picked && !(solo && canShow(soloKind, { kind }))) return null;
  const words = targetWords(hereTarget());
  return (
    <button
      type="button"
      className="lib-tile-use"
      disabled={busy}
      title={`Make ${name} the picture of ${words}. ⌘-click adds it to the ones there.`}
      onClick={(e) => giveMedia(id, hereTarget(), e.metaKey || e.ctrlKey)}
    >
      Use for {words}
    </button>
  );
}

function PhotoImg({ src }: { src: HTMLImageElement | HTMLCanvasElement | ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
    const s = Math.min(w, h);
    c.width = c.height = 160;
    c.getContext('2d')!.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 160, 160);
  }, [src]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
