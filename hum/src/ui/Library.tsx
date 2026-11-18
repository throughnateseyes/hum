import { useEffect, useMemo, useRef, useState } from 'react';
import type { Preset, SceneCategory } from '../core/types';
import { PRESETS } from '../presets';
import { allScenes, getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio } from '../state/store';
import { handleFiles } from '../state/tracks';
import { Cube, Grid, Image as ImageIcon, Layers, Plus, Sparkle, X } from './Icons';

type Tab = 'looks' | 'scenes' | 'photos';

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
const CAT_LABEL: Record<SceneCategory, string> = {
  board: 'Instrument boards',
  form: '3D forms',
  field: 'Fields',
  photo: 'Photo',
  code: 'Generated',
};

/* thumbnails rendered from each built-in look (src/dev/thumbs.ts makes them) */
const STATIC_THUMBS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../assets/thumbs/*.jpg', { eager: true, import: 'default', query: '?url' })).map(([path, url]) => [
    path.split('/').pop()!.replace(/\.jpg$/, ''),
    url,
  ]),
);

function Thumb({ p }: { p: Preset }) {
  const captured = useThumb(p.id);
  const url = STATIC_THUMBS[p.id] ?? captured;
  if (url) return <img src={url} alt="" />;
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
      </div>
      <div className="panel-body">
        {tab === 'looks' && <Looks />}
        {tab === 'scenes' && <Scenes />}
        {tab === 'photos' && <Photos />}
      </div>
    </aside>
  );
}

const MOODS = ['all', 'heavy', 'sad', 'dreamy', 'calm', 'euphoric', 'glitch', 'photo', 'minimal'];

function Looks() {
  const presetId = useStudio((s) => s.presetId);
  const custom = useStudio((s) => s.customPresets);
  const analysis = useStudio((s) => s.analysis);
  const applyPreset = useStudio((s) => s.applyPreset);
  const deleteCustomPreset = useStudio((s) => s.deleteCustomPreset);
  const [mood, setMood] = useState('all');
  const suggested = analysis?.suggestedPresets ?? [];

  const list = useMemo(() => {
    let l = PRESETS.filter((p) => getScene(p.sceneId));
    if (mood !== 'all') l = l.filter((p) => p.tags.includes(mood) || (mood === 'photo' && getScene(p.sceneId)?.category === 'photo'));
    if (suggested.length && mood === 'all') {
      const rank = (p: Preset) => {
        const i = suggested.indexOf(p.id);
        return i < 0 ? 999 : i;
      };
      l = [...l].sort((a, b) => rank(a) - rank(b));
    }
    return l;
  }, [mood, suggested]);

  // capture a thumbnail for whatever look is showing
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!presetId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void captureThumb(presetId), 1600);
  }, [presetId]);

  return (
    <>
      <div className="filter-row">
        {MOODS.map((m) => (
          <button key={m} className={`chip ${mood === m ? 'on' : ''}`} onClick={() => setMood(m)}>
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      {custom.length > 0 && (
        <>
          <div className="section-h">
            <span className="label">Yours</span>
          </div>
          <div className="cards">
            {custom.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <PresetCard p={p} on={presetId === p.id} onClick={() => applyPreset(p)} />
                <button
                  className="btn icon sm ghost card-del"
                  onClick={() => deleteCustomPreset(p.id)}
                  title="Delete look"
                >
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="section-h">
        <span className="label">{suggested.length && mood === 'all' ? 'Ranked for this track' : 'Presets'}</span>
        <span className="label">{list.length}</span>
      </div>
      <div className="cards">
        {list.map((p) => (
          <PresetCard key={p.id} p={p} on={presetId === p.id} suggested={suggested.slice(0, 3).includes(p.id)} onClick={() => applyPreset(p)} />
        ))}
      </div>
    </>
  );
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
const HOVER_INTENT_MS = 260;

/** hover to preview a scene on the stage, click to keep it */
function hoverPreview(sceneId: string, pick: () => void) {
  return {
    onMouseEnter: () => {
      clearTimeout(hoverTimer);
      const s = useStudio.getState();
      if (s.recording || (s.sceneId === sceneId && !s.previewId)) return;
      hoverTimer = setTimeout(() => useStudio.getState().previewScene(sceneId), HOVER_INTENT_MS);
    },
    onMouseLeave: () => {
      clearTimeout(hoverTimer);
      useStudio.getState().endPreview(false);
    },
    onClick: () => {
      clearTimeout(hoverTimer);
      const s = useStudio.getState();
      if (s.previewId === `scene:${sceneId}`) s.endPreview(true);
      else pick();
    },
  };
}

function PresetCard({ p, on, suggested, onClick }: { p: Preset; on: boolean; suggested?: boolean; onClick: () => void }) {
  const previewing = useStudio((s) => s.previewId === p.id);
  return (
    <button
      className={`card ${on && !previewing ? 'on' : ''} ${previewing ? 'previewing' : ''}`}
      onMouseEnter={() => {
        clearTimeout(hoverTimer);
        const s = useStudio.getState();
        if (s.recording || s.presetId === p.id) return;
        hoverTimer = setTimeout(() => useStudio.getState().previewPreset(p), HOVER_INTENT_MS);
      }}
      onMouseLeave={() => {
        clearTimeout(hoverTimer);
        useStudio.getState().endPreview(false);
      }}
      onClick={() => {
        clearTimeout(hoverTimer);
        const s = useStudio.getState();
        if (s.previewId === p.id) s.endPreview(true);
        else onClick();
      }}
    >
      <div className="thumb">
        <Thumb p={p} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="title">{p.name}</div>
        <div className="desc">{p.description}</div>
      </div>
      {suggested && <span className="suggested">Fits</span>}
    </button>
  );
}

function Scenes() {
  const sceneId = useStudio((s) => s.sceneId);
  const setScene = useStudio((s) => s.setScene);
  useStudio((s) => s.customShaders.length); // re-render when AI scenes are added
  const scenes = allScenes();
  const cats: SceneCategory[] = ['board', 'form', 'field', 'photo', 'code'];
  return (
    <>
      {cats.map((c) => {
        const list = scenes.filter((s) => s.category === c);
        if (!list.length) return null;
        return (
          <div key={c}>
            <div className="section-h">
              <span className="label">{CAT_LABEL[c]}</span>
              <span className="label">{list.length}</span>
            </div>
            {list.map((s) => (
              <button key={s.id} className={`scene-row ${sceneId === s.id ? 'on' : ''}`} {...hoverPreview(s.id, () => setScene(s.id))}>
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
  const setScene = useStudio((s) => s.setScene);
  const input = useRef<HTMLInputElement>(null);
  const photoScenes = allScenes().filter((s) => s.usesPhotos);
  return (
    <>
      <p style={{ color: 'var(--ink-2)', margin: '4px 2px 10px', fontSize: 12 }}>
        Add photos and the music will dissolve, mosh and rebuild them. A new photo comes in every 4 bars.
      </p>
      <div className="photo-grid">
        {photos.map((p) => (
          <div className="ph" key={p.id}>
            <PhotoImg src={p.image} />
            <button onClick={() => removePhoto(p.id)}>×</button>
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
        <button key={s.id} className="scene-row" {...hoverPreview(s.id, () => setScene(s.id))}>
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
