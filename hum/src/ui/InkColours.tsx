/**
 * The colours a drawn or printed finish (Hand-drawn, Riso, Ink wash) uses, under the finish in the Video
 * tab, and one part's own in its Picture group. Where they come from is shot/inks.ts.
 */
import { useEffect, useState } from 'react';
import { getPalette, PALETTES } from '../core/palettes';
import type { ClipAsset, ClipPalette, Palette } from '../core/types';
import { INK_ROLES, inksFrom, tonesOf, type InkColors, type InkMode, type InkSet } from '../shot/inks';
import { readTones, tonesOfAll } from '../state/inks';
import { useStudio } from '../state/store';
import { Field, Seg, Slider } from './controls';
import './covers.css';

const MODES: { v: InkMode; label: string; tip: string; span: number }[] = [
  { v: 'clips', label: 'Each clip', tip: 'The colours in the clip on screen. They change with the cut.', span: 4 },
  { v: 'video', label: 'All clips', tip: 'One set mixed from every clip, the whole video through.', span: 4 },
  { v: 'sets', label: 'Palettes', tip: 'Palettes you pick, dealt to the parts. A chorus that comes back keeps its colours.', span: 4 },
  { v: 'own', label: 'My own', tip: 'Five colours you choose.', span: 6 },
  { v: 'look', label: 'The look’s', tip: 'The colours of the look playing.', span: 6 },
];
const ROLE_NAMES: Record<(typeof INK_ROLES)[number], string> = { bg: 'Paper', fg: 'Line', accent: 'Ink 1', accent2: 'Ink 2', muted: 'Ink 3' };

export function Swatches({ c }: { c: InkSet }) {
  return (
    <span className="ink-sw" aria-hidden>
      {INK_ROLES.map((k) => (
        <i key={k} style={{ background: c[k] }} />
      ))}
    </span>
  );
}

/** re-draws once clips added before their colours were read have been */
function useTones(clips: ClipAsset[]) {
  const [, tick] = useState(0);
  useEffect(() => {
    let on = true;
    void readTones(clips).then((any) => any && on && tick((n) => n + 1));
    return () => {
      on = false;
    };
  }, [clips]);
}

const put = (patch: Partial<InkColors>) => {
  const s = useStudio.getState();
  s.set({ inkColors: { ...s.inkColors, ...patch } });
};

/** tap palettes on and off; the number is the order they are dealt in */
function PalettePick({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="pal-grid ink-pals" role="group" aria-label="Palettes">
      {PALETTES.map((p) => {
        const at = ids.indexOf(p.id);
        return (
          <button key={p.id} className={`pal ${at >= 0 ? 'on' : ''}`} aria-pressed={at >= 0} title={p.name} onClick={() => onChange(at >= 0 ? ids.filter((x) => x !== p.id) : [...ids, p.id].slice(-8))}>
            <Swatches c={p} />
            <div className="pn">
              {at >= 0 && ids.length > 1 ? `${at + 1} · ` : ''}
              {p.name}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function InkControls({ full }: { full: boolean }) {
  const k = useStudio((s) => s.inkColors);
  const clips = useStudio((s) => s.clips);
  const palette = useStudio((s) => s.palette);
  const [hover, setHover] = useState<InkMode | null>(null);
  const [all, setAll] = useState(false);
  useTones(clips);
  const note = MODES.find((m) => m.v === (hover ?? k.mode))?.tip ?? '';
  const mixed = clips.length ? inksFrom(tonesOfAll(clips.map((c) => c.palette)), k.paper) : null;
  const fromClips = k.mode === 'clips' || k.mode === 'video';
  return (
    <div className="ink" aria-label="Colours">
      <Field label="Colours">
        <Seg value={k.mode} options={MODES} cols={12} onChange={(v) => put({ mode: v })} onHover={setHover} label="Where the colours come from" />
      </Field>
      <p className="field-note">{note}</p>

      {fromClips && !clips.length && <p className="field-note">Add clips in the Library’s Footage tab to use their colours. Until then the look’s are used.</p>}
      {k.mode === 'clips' && clips.length > 0 && (
        <div className="ink-clips">
          {clips.slice(0, all ? clips.length : 6).map((c) => (
            <div key={c.id} className="ink-clip" title={c.name}>
              {c.thumb && <img src={c.thumb} alt="" />}
              <Swatches c={inksFrom(tonesOf(c.palette), k.paper)} />
            </div>
          ))}
          {clips.length > 6 && (
            <button className="btn sm ghost" onClick={() => setAll(!all)}>
              {all ? 'Fewer clips' : `All ${clips.length} clips`}
            </button>
          )}
        </div>
      )}
      {k.mode === 'video' && mixed && <Swatches c={mixed} />}
      {fromClips && clips.length > 0 && (
        <>
          <Field label="Printed on">
            <Seg
              value={k.paper}
              options={[
                { v: 'light' as const, label: 'Light paper' },
                { v: 'dark' as const, label: 'Dark paper' },
              ]}
              cols={2}
              onChange={(v) => put({ paper: v })}
              label="Printed on"
            />
          </Field>
          <Field label="Follow the feeling" value={`${Math.round(k.feel * 100)}%`} tip="Quiet parts fade, loud parts glow.">
            <Slider value={k.feel} min={0} max={1} step={0.05} onChange={(v) => put({ feel: v })} />
          </Field>
        </>
      )}

      {k.mode === 'sets' && <PalettePick ids={k.sets} onChange={(sets) => put({ sets })} />}

      {k.mode === 'own' && (
        <>
          <div className="color-grid">
            {INK_ROLES.map((r) => (
              <label key={r} className="color-in">
                <input type="color" value={k.own[r]} onChange={(e) => put({ own: { ...k.own, [r]: e.target.value } })} />
                <span>{ROLE_NAMES[r]}</span>
              </label>
            ))}
          </div>
          <div className="cov-all">
            {mixed && (
              <button className="btn sm" onClick={() => put({ own: mixed })}>
                Start from my clips
              </button>
            )}
            <button className="btn sm" onClick={() => put({ own: { bg: palette.bg, fg: palette.fg, accent: palette.accent, accent2: palette.accent2, muted: palette.muted } })}>
              Start from the look
            </button>
          </div>
        </>
      )}
      {full && <p className="field-note">Inks is on All, so the picture keeps every colour. Pick a number of inks to print with these.</p>}
    </div>
  );
}

const WAYS: { v: string; label: string }[] = [
  { v: 'clips', label: 'Each clip' },
  { v: 'video', label: 'All clips' },
  { v: 'own', label: 'My own' },
  { v: 'look', label: 'The look’s' },
];
export const inkName = (v: string | null): string => (v === null ? 'As the video' : (WAYS.find((w) => w.v === v)?.label ?? getPalette(v).name));

/** one part's colours: as the video, one of the ways above, or a palette of its own */
export function PartInks({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (v: string | undefined) => void }) {
  const own = useStudio((s) => s.inkColors.own);
  const paper = useStudio((s) => s.inkColors.paper);
  const clips = useStudio((s) => s.clips);
  const look = useStudio((s) => s.palette);
  useTones(clips);
  const strip = (ps: ClipPalette[]): InkSet | null => (ps.length ? inksFrom(tonesOfAll(ps), paper) : null);
  const sw: Record<string, InkSet | null> = { clips: strip(clips.slice(0, 1).map((c) => c.palette)), video: strip(clips.map((c) => c.palette)), own, look };
  const cell = (id: string, name: string, c: InkSet | Palette | null) => (
    <button key={id} className={`pal ${value === id ? 'on' : ''}`} aria-pressed={value === id} disabled={disabled} title={name} onClick={() => onChange(value === id ? undefined : id)}>
      {c && <Swatches c={c} />}
      <div className="pn">{name}</div>
    </button>
  );
  return (
    <div className="pal-grid ink-pals" role="group" aria-label="Colours here">
      <button className={`pal ${value === null ? 'on' : ''}`} aria-pressed={value === null} disabled={disabled} onClick={() => onChange(undefined)}>
        <div className="pn">As the video</div>
      </button>
      {WAYS.map((w) => cell(w.v, w.label, sw[w.v]))}
      {PALETTES.map((p) => cell(p.id, p.name, p))}
    </div>
  );
}
