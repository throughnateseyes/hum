import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
import { addClipFiles, handleFiles } from '../state/tracks';
import { noteHandPick } from '../state/taste';
import { Cube, Grid, Image as ImageIcon, Layers, Plus, Sparkle, X } from './Icons';
import { hidePeek, peekHandlers } from './Peek';

type Tab = 'looks' | 'scenes' | 'photos' | 'footage';

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

export function Library() {
  const [tab, setTab] = useState<Tab>('looks');
  const photos = useStudio((s) => s.photos);
  const clips = useStudio((s) => s.clips);
  return (
    <aside className="library">
      <div className="panel-tabs">
        <button className={tab === 'looks' ? 'on' : ''} onClick={() => setTab('looks')}>
          Looks
        </button>
        <button className={tab === 'scenes' ? 'on' : ''} onClick={() => setTab('scenes')}>
          Scenes
        </button>
        <button className={tab === 'photos' ? 'on' : ''} onClick={() => setTab('photos')}>
          Photos{photos.length ? ` ${photos.length}` : ''}
        </button>
        <button className={tab === 'footage' ? 'on' : ''} onClick={() => setTab('footage')}>
          Footage{clips.length ? ` ${clips.length}` : ''}
        </button>
      </div>
      <div className="panel-body">
        {tab === 'looks' && <Looks />}
        {tab === 'scenes' && <Scenes />}
        {tab === 'photos' && <Photos />}
        {tab === 'footage' && <Footage />}
      </div>
    </aside>
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

function Looks() {
  const presetId = useStudio((s) => s.presetId);
  const custom = useStudio((s) => s.customPresets);
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
  const usable = useMemo(() => families.filter((f) => f.takes.some((p) => getScene(p.sceneId))), [families]);
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

  return (
    <>
      <div className="lib-search">
        <input className="txt" type="search" placeholder={`Search ${usable.length} looks…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search looks" />
      </div>
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
      {list.length === 0 && <p className="panel-intro">{part === 'now' && !nowName ? 'Play the song and the looks that fit the part playing will show here.' : 'No looks match. Try another part or theme.'}</p>}
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

/* preset looks keep stable effect ids so the preview doesn't recompile shaders on every hover */
const peekLooks = new Map<string, ReturnType<typeof presetToLook>>();
function presetPeekLook(p: Preset) {
  let l = peekLooks.get(p.id);
  if (!l) peekLooks.set(p.id, (l = presetToLook(p)));
  return l;
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
  const scenes = allScenes();
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

function Photos() {
  const photos = useStudio((s) => s.photos);
  const removePhoto = useStudio((s) => s.removePhoto);
  const input = useRef<HTMLInputElement>(null);
  const photoScenes = allScenes().filter((s) => s.usesPhotos);
  return (
    <>
      <p className="panel-intro">Add photos and the music will dissolve, mosh and rebuild them. A new photo comes in every 4 bars.</p>
      <div className="photo-grid">
        {photos.map((p) => (
          <div className="ph" key={p.id}>
            <PhotoImg src={p.image} />
            <button onClick={() => removePhoto(p.id)} aria-label="Remove photo">×</button>
          </div>
        ))}
        <button className="drop-tile" onClick={() => input.current?.click()} title="Add photos">
          <Plus />
        </button>
      </div>
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
      <div className="section-h">
        <span className="label">Photo scenes</span>
      </div>
      {photoScenes.map((s) => (
        <button key={s.id} className="scene-row" {...sceneRowProps(s.id, s.name, () => pickScene(s.id))}>
          <Glyph c="photo" />
          <span style={{ minWidth: 0 }}>
            <div className="t">{s.name}</div>
            <div className="d">{s.description}</div>
          </span>
        </button>
      ))}
    </>
  );
}

const fmtClipLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function Footage() {
  const clips = useStudio((s) => s.clips);
  const removeClip = useStudio((s) => s.removeClip);
  const input = useRef<HTMLInputElement>(null);
  const clipScenes = allScenes().filter((s) => s.usesClips);
  return (
    <>
      <p className="panel-intro">
        {clips.length
          ? 'Clips become the picture in Footage looks, cut and coloured to the song. Drop more on the page any time.'
          : 'Add video clips and Footage looks use them as the picture, cut and coloured to the song. You can also just drop them on the page.'}
      </p>
      <div className="clip-grid">
        {clips.map((c) => (
          <div className="clip" key={c.id}>
            <div className="clip-img">
              <img src={c.thumb} alt={`Thumbnail of ${c.name}`} loading="lazy" decoding="async" />
              <span className="clip-len">{fmtClipLen(c.duration)}</span>
              <button className="clip-del" onClick={() => removeClip(c.id)} aria-label={`Remove clip ${c.name}`}>
                ×
              </button>
            </div>
            <div className="clip-name" title={c.name}>
              {c.name}
            </div>
          </div>
        ))}
        <button className="drop-tile clip-add" onClick={() => input.current?.click()} title="Add clips" aria-label="Add clips">
          <Plus />
        </button>
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => input.current?.click()}>
        Add clips
      </button>
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
      {clipScenes.length > 0 && (
        <>
          <div className="section-h">
            <span className="label">Footage looks</span>
          </div>
          {clipScenes.map((s) => (
            <button key={s.id} className="scene-row" {...sceneRowProps(s.id, s.name, () => pickScene(s.id))}>
              <Glyph c={s.category} />
              <span style={{ minWidth: 0 }}>
                <div className="t">{s.name}</div>
                <div className="d">{s.description}</div>
              </span>
            </button>
          ))}
        </>
      )}
    </>
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
