import { useEffect, useRef, useState, type CSSProperties, type SVGProps } from 'react';
import { LAYERS, PALETTES } from '../core/palettes';
import type { EffectCategory, LayerId, Palette } from '../core/types';
import { allEffects, getEffect } from '../fx';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { findLook, validPlan } from '../state/plan';
import { useStudio, type InspectorTab } from '../state/store';
import { clipBlocker } from '../render/clipExport';
import { clipForTikTok } from '../render/timeline';
import { takeName } from '../presets/fit';
import { Clamp, ParamControl, Section, Slider, Toggle, groupParams } from './controls';
import { Camera, Down, Plus, Up, X } from './Icons';
import { TakesStrip } from './Takes';
import { useLookFamily } from './lookFamily';
import { RenderBar, toggleRenderMode, useRenderMode } from './RenderBar';
import { saveStill } from './capture';
import { PartPanel } from './PartPanel';
import { VideoPanel } from './VideoPanel';

/**
 * The right panel, by what you are changing: the whole Video, the Part picked on the timeline (or,
 * with no video plan, the Look on screen), and Render. The Director chat docks under it (App.tsx).
 */
export function Inspector() {
  const tab = useStudio((s) => s.inspectorTab);
  const set = useStudio((s) => s.set);
  const hasPlan = useStudio((s) => validPlan(s.plan, s.analysis));
  const picked = useStudio((s) => s.selectedParts.length > 0);
  const shown = tabShown(tab);
  const tabs: [InspectorTab, string][] = [
    ['video', 'Video'],
    ['part', hasPlan ? 'Part' : 'Look'],
    ['render', 'Render'],
  ];

  // the Render tab is render mode: the song map shows the stretch for as long as the tab is open
  useEffect(() => {
    const on = useRenderMode.getState().on;
    if ((shown === 'render') !== on) toggleRenderMode();
  }, [shown]);

  // Video is where you start when there's a video; without one, the look on screen. Only when a plan
  // appears (or on first load), so it never pulls the tab away from someone who picked one.
  const hadPlan = useRef<boolean | null>(null);
  useEffect(() => {
    const first = hadPlan.current === null;
    const s = useStudio.getState();
    if (first && !hasPlan && s.inspectorTab === 'video') set({ inspectorTab: 'part' });
    if (!first && hasPlan && !hadPlan.current && tabShown(s.inspectorTab) === 'part' && !s.selectedParts.length) set({ inspectorTab: 'video' });
    hadPlan.current = hasPlan;
  }, [hasPlan, set]);

  // picking parts on the timeline brings the Part tab forward
  useEffect(() => {
    if (picked) set({ inspectorTab: 'part' });
  }, [picked, set]);

  return (
    <aside className="inspector">
      <div className="insp-tabs">
        <div className="seg full" role="tablist" aria-label="Panel">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={shown === id} className={shown === id ? 'on' : ''} onClick={() => set({ inspectorTab: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {shown === 'video' && <VideoPanel />}
        {shown === 'part' && <PartTab />}
        {shown === 'render' && <RenderPanel />}
      </div>
    </aside>
  );
}

/** the tab to draw for a stored tab id (ids from before the three tabs all mean the look: Part) */
function tabShown(tab: InspectorTab): 'video' | 'part' | 'render' {
  return tab === 'video' || tab === 'render' ? tab : 'part';
}

/* ───────────────────────── Part / Look ───────────────────────── */

/** the part (from PartPanel), the look's takes, then the look's own settings tucked under Fine-tune */
function PartTab() {
  const many = useStudio((s) => s.selectedParts.length > 1);
  const fxCount = useStudio((s) => s.effects.length);
  const modCount = useStudio((s) => s.modulations.length);
  return (
    <div className="pt">
      <PartPanel />
      {/* several parts picked: their looks differ, so one look's takes and sliders don't apply to all */}
      {!many && (
        <>
          <TakesStrip compact />
          <Section id="part.tune" title="Fine-tune this look" sub="Sliders, effects, colours, sound" collapsible defaultOpen={false}>
            <div className="tune">
              <Section id="tune.params" title="Parameters" collapsible defaultOpen={false}>
                <ParamsBody />
              </Section>
              <Section id="tune.fx" title="Effects" right={fxCount ? <span className="param-val">{fxCount}</span> : undefined} collapsible defaultOpen={false}>
                <FxBody />
              </Section>
              <Section id="tune.colours" title="Colours" collapsible defaultOpen={false}>
                <ColoursBody />
              </Section>
              <Section id="tune.sound" title="Reacts to sound" right={modCount ? <span className="param-val">{modCount}</span> : undefined} collapsible defaultOpen={false}>
                <SoundBody />
              </Section>
              <Section id="tune.save" title="Save as a take" collapsible defaultOpen={false}>
                <SaveTake />
              </Section>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

const CAT_NAME: Record<string, string> = { form: '3D form', field: 'Field', photo: 'Photo', board: 'Instrument board', code: 'Made by the director', footage: 'Your footage' };

/** the scene's own sliders, in its groups */
function ParamsBody() {
  const sceneId = useStudio((s) => s.sceneId);
  const params = useStudio((s) => s.sceneParams);
  const setParam = useStudio((s) => s.setSceneParam);
  const shaderError = useStudio((s) => s.shaderError);
  const customShaders = useStudio((s) => s.customShaders);
  const def = getScene(sceneId);
  const [showCode, setShowCode] = useState(false);
  if (!def) return <p className="empty-note">No scene on screen.</p>;
  const spec = customShaders.find((c) => c.id === def.id);
  return (
    <>
      <div className="tune-head">
        <span className="eyebrow">{CAT_NAME[def.category] ?? def.category}</span>
        <b>{def.name}</b>
        <Clamp key={def.id} text={def.description} lines={2} />
      </div>
      {shaderError && <div className="code">{shaderError}</div>}
      {groupParams(def.params).map(([g, defs]) => (
        <div className="tune-group" key={g}>
          <div className="sub-label">{g}</div>
          {defs.map((d) => (
            <ParamControl key={d.id} def={d} value={params[d.id]} onChange={(v) => setParam(d.id, v)} target={`scene.${d.id}`} live={() => live.scene[d.id]} />
          ))}
        </div>
      ))}
      {spec && (
        <div className="tune-group">
          <button className="btn sm ghost" onClick={() => setShowCode(!showCode)}>
            {showCode ? 'Hide the shader code' : 'Show the shader code'}
          </button>
          {showCode && <pre className="code quiet">{spec.fragment}</pre>}
        </div>
      )}
    </>
  );
}

const FX_CATS: [EffectCategory, string][] = [
  ['texture', 'Texture'],
  ['color', 'Colour'],
  ['distort', 'Distort'],
  ['glitch', 'Glitch'],
  ['time', 'Time'],
  ['optics', 'Optics'],
];

/** the effect stack: applied top to bottom, each one opens to its sliders */
function FxBody() {
  const effects = useStudio((s) => s.effects);
  const { addEffect, removeEffect, toggleEffect, moveEffect, setEffectParam } = useStudio.getState();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const all = allEffects();
  return (
    <>
      <div className="section-h">
        <span className="sub-label">{effects.length ? 'Applied top to bottom' : 'No effects. The look shows as it is.'}</span>
        <button className="btn sm" onClick={() => setAdding(!adding)}>
          {adding ? (
            'Done'
          ) : (
            <>
              <Plus width={13} height={13} /> Add
            </>
          )}
        </button>
      </div>
      {effects.map((e) => {
        const def = getEffect(e.effectId);
        if (!def) return null;
        const isOpen = open === e.instanceId;
        return (
          <div key={e.instanceId} className={`fx-item ${e.enabled ? '' : 'off'}`}>
            <div className="fx-head">
              <button className="n" onClick={() => setOpen(isOpen ? null : e.instanceId)} aria-expanded={isOpen}>
                <svg className="sec-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                  <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {def.name}
              </button>
              <button className="btn icon sm ghost" title="Move up" onClick={() => moveEffect(e.instanceId, -1)}>
                <Up width={13} height={13} />
              </button>
              <button className="btn icon sm ghost" title="Move down" onClick={() => moveEffect(e.instanceId, 1)}>
                <Down width={13} height={13} />
              </button>
              <Toggle on={e.enabled} onChange={() => toggleEffect(e.instanceId)} label={`${def.name} on`} />
              <button className="btn icon sm ghost" title="Remove" onClick={() => removeEffect(e.instanceId)}>
                <X width={13} height={13} />
              </button>
            </div>
            {isOpen && (
              <div className="fx-body">
                <p className="fx-desc">{def.description}</p>
                {def.params.map((d) => (
                  <ParamControl
                    key={d.id}
                    def={d}
                    value={e.params[d.id]}
                    onChange={(v) => setEffectParam(e.instanceId, d.id, v)}
                    target={`fx.${e.instanceId}.${d.id}`}
                    live={() => live.fx.get(e.instanceId)?.[d.id]}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {adding &&
        FX_CATS.map(([cat, label]) => {
          const list = all.filter((x) => x.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat} className="tune-group">
              <div className="sub-label">{label}</div>
              <div className="fx-add">
                {list.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => {
                      addEffect(d.id);
                      const s = useStudio.getState().effects;
                      setOpen(s[s.length - 1]?.instanceId ?? null);
                    }}
                  >
                    <b>{d.name}</b>
                    <span>{d.description}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
    </>
  );
}

const COLOR_KEYS: [keyof Omit<Palette, 'id' | 'name'>, string][] = [
  ['bg', 'Background'],
  ['fg', 'Ink'],
  ['accent', 'Accent'],
  ['accent2', 'Accent 2'],
  ['muted', 'Muted'],
];

/**
 * The look's colours: the five colours on screen, the palettes this video already uses, and every
 * other palette behind More colours (there are a hundred of them; nobody should scroll past them).
 */
function ColoursBody() {
  const palette = useStudio((s) => s.palette);
  const plan = useStudio((s) => s.plan);
  const analysis = useStudio((s) => s.analysis);
  const { setPalette, setPaletteColor } = useStudio.getState();
  const [more, setMore] = useState(false);
  const inVideo: Palette[] = [];
  if (validPlan(plan, analysis)) {
    for (const id of plan.looks) {
      const p = findLook(id)?.palette;
      if (p && p.id !== palette.id && !inVideo.some((x) => x.id === p.id)) inVideo.push(p);
    }
  }
  return (
    <>
      <div className="sub-label">On screen · {palette.name}</div>
      <div className="color-grid">
        {COLOR_KEYS.map(([k, label]) => (
          <label key={k} className="color-in">
            <input type="color" value={palette[k]} onChange={(e) => setPaletteColor(k, e.target.value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {inVideo.length > 0 && (
        <div className="tune-group">
          <div className="sub-label">In this video</div>
          <PaletteGrid list={inVideo.slice(0, 8)} on={palette.id} pick={setPalette} />
        </div>
      )}
      <button className="btn sm ghost more-btn" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? 'Fewer colours' : `More colours (${PALETTES.length})`}
      </button>
      {more && <PaletteGrid list={PALETTES} on={palette.id} pick={setPalette} />}
    </>
  );
}

function PaletteGrid({ list, on, pick }: { list: Palette[]; on: string; pick: (p: Palette) => void }) {
  return (
    <div className="pal-grid">
      {list.map((p) => (
        <button key={p.id} className={`pal ${on === p.id ? 'on' : ''}`} onClick={() => pick(p)} title={p.name}>
          <div className="pal-sw">
            <i style={{ background: p.bg }} />
            <i style={{ background: p.accent }} />
            <i style={{ background: p.accent2 }} />
            <i style={{ background: p.fg }} />
          </div>
          <div className="pn">{p.name}</div>
        </button>
      ))}
    </div>
  );
}

/** what each meter hears, in plain words (the meters under the timeline use the same names) */
const HEARS: Record<LayerId, string> = {
  level: 'How loud the song is overall',
  sub: 'The deepest low end, more felt than heard',
  bass: 'The bassline and the body of the kick',
  lowMid: 'The warm lower middle of the mix',
  mid: 'Vocals and lead instruments',
  highMid: 'The bite at the start of each note',
  air: 'Hi-hats, cymbals and shimmer up top',
  kick: 'Each kick drum hit',
  snare: 'Each snare or clap',
  hat: 'Each hi-hat tick',
  energy: 'How intense this part of the song is (changes slowly)',
  brightness: 'How bright or dark the sound is',
  flux: 'How quickly the sound is changing',
  build: 'Rises through a build-up',
  drop: 'Fires when the drop hits',
  beatPhase: 'Counts up once every beat',
  sway: 'A slow swing in time with the bars',
};

function targetLabel(target: string): string {
  const s = useStudio.getState();
  const parts = target.split('.');
  if (parts[0] === 'scene') {
    const def = getScene(s.sceneId);
    return `${def?.params.find((p) => p.id === parts[1])?.label ?? parts[1]}`;
  }
  const inst = s.effects.find((e) => e.instanceId === parts[1]);
  const def = inst ? getEffect(inst.effectId) : undefined;
  return `${def?.name ?? 'Effect'} · ${def?.params.find((p) => p.id === parts[2])?.label ?? parts[2]}`;
}

/**
 * Reacts to sound (it used to be called Routing): each meter is something Hum hears in the song, and
 * any slider can move with any of them. Open, it shows the meter row under the timeline (metersOpen),
 * since that row is only there to drag from.
 */
function SoundBody() {
  const mods = useStudio((s) => s.modulations);
  const sceneId = useStudio((s) => s.sceneId);
  const effects = useStudio((s) => s.effects);
  const sensitivity = useStudio((s) => s.sensitivity);
  const { updateModulation, removeModulation, addModulation, set } = useStudio.getState();
  const [src, setSrc] = useState<LayerId>('bass');
  const [tgt, setTgt] = useState('');
  const [legend, setLegend] = useState(false);

  // shown means open: the meters appear under the timeline for as long as this is on screen
  useEffect(() => {
    useStudio.getState().set({ metersOpen: true });
    return () => useStudio.getState().set({ metersOpen: false });
  }, []);

  const scene = getScene(sceneId);
  const targets: { value: string; label: string }[] = [
    ...(scene?.params.filter((p) => p.type === 'number').map((p) => ({ value: `scene.${p.id}`, label: p.label })) ?? []),
    ...effects.flatMap((e) => {
      const d = getEffect(e.effectId);
      return (d?.params ?? []).filter((p) => p.type === 'number').map((p) => ({ value: `fx.${e.instanceId}.${p.id}`, label: `${d!.name} · ${p.label}` }));
    }),
  ];
  const layerName = (id: LayerId) => LAYERS.find((l) => l.id === id)?.label ?? id;
  return (
    <>
      <p className="panel-intro">
        Hum hears separate things in the song: the kick, the bass, the hi-hats, how loud it is. Each one is a meter under the timeline. Link one to a slider and the slider moves with it.
      </p>
      {mods.map((m) => (
        <div className="link-row" key={m.id} style={{ opacity: m.enabled ? 1 : 0.5 }}>
          <div className="link-top">
            <select className="src-chip" value={m.source} onChange={(e) => updateModulation(m.id, { source: e.target.value as LayerId })} aria-label="Sound" title={HEARS[m.source]}>
              {LAYERS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="link-to">moves {targetLabel(m.target)}</span>
            <button className="btn icon sm ghost" onClick={() => removeModulation(m.id)} aria-label={`Stop ${layerName(m.source)} moving ${targetLabel(m.target)}`} title="Remove this link">
              <X width={12} height={12} />
            </button>
          </div>
          <div className="link-amt has-tip" data-tip="How far the slider moves with the sound. Below 0 it moves the other way.">
            <Slider value={m.amount} min={-1} max={1} onChange={(v) => updateModulation(m.id, { amount: v })} />
            <span className="param-val">{Math.round(m.amount * 100)}%</span>
          </div>
        </div>
      ))}
      <div className="link-add">
        <span className="sub-label">{mods.length ? 'Link another' : 'Make a slider move with the sound'}</span>
        <div className="link-add-row">
          <select className="sel" value={src} onChange={(e) => setSrc(e.target.value as LayerId)} aria-label="Sound to follow" title={HEARS[src]}>
            {LAYERS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="link-word">moves</span>
          <select className="sel" value={tgt} onChange={(e) => setTgt(e.target.value)} aria-label="Slider to move">
            <option value="">a slider…</option>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn icon" disabled={!tgt} onClick={() => tgt && addModulation(src, tgt, 0.4)} aria-label="Add this link" title="Add this link">
            <Plus width={13} height={13} />
          </button>
        </div>
        <p className="field-note">{HEARS[src]}. Or drag a meter from under the timeline onto any slider.</p>
      </div>
      <div className="field">
        <div className="param-top has-tip" data-tip="How strongly Hum hears the song. Turn it up for a quiet song, down for a loud one.">
          <span className="param-name">Listening strength</span>
          <span className="param-val">{sensitivity.toFixed(2)}×</span>
        </div>
        <Slider value={sensitivity} min={0.3} max={2.5} onChange={(v) => set({ sensitivity: v })} />
      </div>
      <button className="btn sm ghost more-btn" aria-expanded={legend} onClick={() => setLegend(!legend)}>
        {legend ? 'Hide what each meter hears' : 'What each meter hears'}
      </button>
      {legend && (
        <dl className="legend">
          {LAYERS.map((l) => (
            <div key={l.id}>
              <dt>{l.label}</dt>
              <dd>{HEARS[l.id]}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** keep what's on screen (colours, sliders, effects) as a take of this look, or as a look of your own */
function SaveTake() {
  const fam = useLookFamily();
  const [name, setName] = useState('');
  const save = () => {
    const st = useStudio.getState();
    if (fam) {
      const p = st.saveCurrentAsPreset(name.trim() || `Take ${fam.takes.length + 1}`, fam.id);
      st.flash(`Saved “${takeName(p)}” as a take of ${fam.name}`);
    } else {
      const p = st.saveCurrentAsPreset(name.trim() || 'Untitled look');
      st.flash(`Saved “${p.name}” to your looks`);
    }
    setName('');
  };
  return (
    <form
      className="save-row"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input className="txt" placeholder={fam ? `Name this take of ${fam.name}…` : 'Name this look…'} value={name} onChange={(e) => setName(e.target.value)} aria-label="Take name" />
      <button className="btn" type="submit">
        Save
      </button>
    </form>
  );
}

/* ───────────────────────── Render ───────────────────────── */

/** Render: one quick clip for socials, then pick a stretch of the song, choose sizes, make the files */
function RenderPanel() {
  return (
    <div className="render-panel">
      <ClipQuick />
      <div className="rp-sep">
        <span className="sub-label">Or pick a stretch and sizes</span>
      </div>
      <p className="hint">Drag across the timeline to choose a stretch, or double-click a part.</p>
      <RenderBar />
      <div className="render-extra">
        <button className="btn sm" onClick={() => void saveStill()}>
          <Camera width={14} height={14} /> Save a still image
        </button>
      </div>
    </div>
  );
}

/**
 * One click: a vertical 1080×1920 clip of the song's best 15 to 30 seconds, with sound, in the current
 * look. While it records the button fills up left to right; clicking it again (or Esc) cancels.
 */
function ClipQuick() {
  const clip = useStudio((s) => s.clip);
  const blocked = useStudio((s) => clipBlocker(s));
  const flash = useStudio((s) => s.flash);
  const len = clip ? clip.end - clip.start : 0;
  const label = !clip ? 'Clip for socials' : clip.phase === 'prep' ? 'Finding the drop…' : clip.phase === 'save' ? 'Saving…' : `${Math.floor(clip.frac * len)} / ${Math.round(len)} s`;
  return (
    <div className="rp-clip">
      <button
        className={`btn clip rp-clip-btn ${clip ? 'on' : ''} ${blocked && !clip ? 'off' : ''}`}
        style={clip ? ({ '--p': clip.phase === 'prep' ? 0 : clip.frac } as CSSProperties) : undefined}
        onClick={() => {
          if (clip) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          else if (blocked) flash(blocked);
          else void clipForTikTok();
        }}
        aria-label={clip ? `Making clip, ${label}. Click to cancel` : 'Clip for socials: TikTok or Reels'}
        aria-disabled={!!blocked && !clip}
      >
        <ClipIcon width={14} height={14} />
        <span className="lbl-wide">{label}</span>
        {clip && <span className="rp-clip-x">Cancel</span>}
      </button>
      <p className="field-note">{clip ? 'Making the clip. Click or press Esc to stop.' : (blocked ?? 'A vertical clip of the best 15 to 30 seconds, ready for TikTok or Reels.')}</p>
    </div>
  );
}

function ClipIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
