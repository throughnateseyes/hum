import { useState } from 'react';
import { LAYERS, PALETTES } from '../core/palettes';
import type { EffectCategory, HandStyle, LayerId, Palette } from '../core/types';
import { allEffects, getEffect } from '../fx';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio, type InspectorTab, type Pace, type PopupMode } from '../state/store';
import { TRANSITIONS } from '../core/transitionList';
import { Clamp, Field, ParamControl, Section, Slider, Toggle, groupParams } from './controls';
import { Down, Plus, Up, X } from './Icons';
import { readAccessCode } from './Director';
import { TasteGroup } from './Taste';

const CAT_NAME: Record<string, string> = { form: '3D form', field: 'Field', photo: 'Photo', board: 'Instrument board', code: 'Made by the director' };

export function Inspector() {
  const tab = useStudio((s) => s.inspectorTab);
  const set = useStudio((s) => s.set);
  const fxCount = useStudio((s) => s.effects.length);
  const modCount = useStudio((s) => s.modulations.length);
  const tabs: [InspectorTab, string, number][] = [
    ['scene', 'Scene', 0],
    ['fx', 'Effects', fxCount],
    ['layers', 'Routing', modCount],
    ['look', 'Look', 0],
  ];
  return (
    <aside className="inspector">
      <div className="panel-tabs" role="tablist">
        {tabs.map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => set({ inspectorTab: id })}>
            {label}
            {n > 0 && <span className="tab-n">{n}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'scene' && <ScenePanel />}
        {tab === 'fx' && <FxPanel />}
        {tab === 'layers' && <RoutingPanel />}
        {tab === 'look' && <LookPanel />}
      </div>
    </aside>
  );
}

function ScenePanel() {
  const sceneId = useStudio((s) => s.sceneId);
  const params = useStudio((s) => s.sceneParams);
  const setParam = useStudio((s) => s.setSceneParam);
  const shaderError = useStudio((s) => s.shaderError);
  const customShaders = useStudio((s) => s.customShaders);
  const def = getScene(sceneId);
  const [showCode, setShowCode] = useState(false);
  if (!def) return <p className="label">No scene</p>;
  const spec = customShaders.find((c) => c.id === def.id);
  return (
    <>
      <div className="insp-head">
        <div className="eyebrow">{CAT_NAME[def.category] ?? def.category}</div>
        <h3>{def.name}</h3>
        <Clamp key={def.id} text={def.description} />
      </div>
      {shaderError && (
        <Section id="scene.err" title={<span style={{ color: 'var(--danger)' }}>Shader error</span>}>
          <div className="code">{shaderError}</div>
        </Section>
      )}
      {groupParams(def.params).map(([g, defs]) => (
        <Section id={`scene.${g}`} key={g} title={g}>
          {defs.map((d) => (
            <ParamControl
              key={d.id}
              def={d}
              value={params[d.id]}
              onChange={(v) => setParam(d.id, v)}
              target={`scene.${d.id}`}
              live={() => live.scene[d.id]}
            />
          ))}
        </Section>
      ))}
      {spec && (
        <Section
          id="scene.glsl"
          title="Generated GLSL"
          right={
            <button className="btn sm ghost" onClick={() => setShowCode(!showCode)}>
              {showCode ? 'Hide' : 'Show'}
            </button>
          }
        >
          {showCode && <pre className="code quiet">{spec.fragment}</pre>}
        </Section>
      )}
      <p className="hint">Drag a meter from the strip under the stage onto any slider to make it move with that part of the music.</p>
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

function FxPanel() {
  const effects = useStudio((s) => s.effects);
  const { addEffect, removeEffect, toggleEffect, moveEffect, setEffectParam } = useStudio.getState();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(effects.length === 0);
  const all = allEffects();
  return (
    <>
      <div className="section-h">
        <span className="label">Applied top to bottom</span>
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
      {effects.length === 0 && !adding && <p className="empty-note">No effects. The raw scene is showing.</p>}
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
              <Toggle on={e.enabled} onChange={() => toggleEffect(e.instanceId)} />
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
            <div key={cat}>
              <div className="section-h">
                <span className="label">{label}</span>
              </div>
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

function RoutingPanel() {
  const mods = useStudio((s) => s.modulations);
  const sceneId = useStudio((s) => s.sceneId);
  const effects = useStudio((s) => s.effects);
  const sensitivity = useStudio((s) => s.sensitivity);
  const { updateModulation, removeModulation, addModulation, set } = useStudio.getState();
  const [src, setSrc] = useState<LayerId>('bass');
  const [tgt, setTgt] = useState('');
  const scene = getScene(sceneId);
  const targets: { value: string; label: string }[] = [
    ...(scene?.params.filter((p) => p.type === 'number').map((p) => ({ value: `scene.${p.id}`, label: `Scene · ${p.label}` })) ?? []),
    ...effects.flatMap((e) => {
      const d = getEffect(e.effectId);
      return (d?.params ?? []).filter((p) => p.type === 'number').map((p) => ({ value: `fx.${e.instanceId}.${p.id}`, label: `${d!.name} · ${p.label}` }));
    }),
  ];
  return (
    <>
      <p className="panel-intro">Each layer is a signal pulled out of the music. Route any of them to any slider, or drag a meter from under the stage onto one.</p>
      <Section id="route.sens" title="Sensitivity" right={<span className="param-val">{sensitivity.toFixed(2)}×</span>}>
        <Slider value={sensitivity} min={0.3} max={2.5} onChange={(v) => set({ sensitivity: v })} />
      </Section>
      <Section id="route.list" title="Routings" right={mods.length ? <span className="param-val">{mods.length}</span> : undefined}>
        {mods.length === 0 && <p className="empty-note">None yet. Pick a layer and a slider below.</p>}
        {mods.map((m) => (
          <div className="mod-row" key={m.id} style={{ opacity: m.enabled ? 1 : 0.5 }}>
            <select className="src-chip" value={m.source} onChange={(e) => updateModulation(m.id, { source: e.target.value as LayerId })} aria-label="Layer">
              {LAYERS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <div style={{ minWidth: 0 }}>
              <div className="mod-target">→ {targetLabel(m.target)}</div>
              <Slider value={m.amount} min={-1} max={1} onChange={(v) => updateModulation(m.id, { amount: v })} />
            </div>
            <div className="mod-end">
              <span className="param-val">{Math.round(m.amount * 100)}%</span>
              <button className="btn icon sm ghost" onClick={() => removeModulation(m.id)} aria-label="Remove routing">
                <X width={12} height={12} />
              </button>
            </div>
          </div>
        ))}
        <div className="mod-add">
          <select className="sel" value={src} onChange={(e) => setSrc(e.target.value as LayerId)} aria-label="Layer">
            {LAYERS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <select className="sel" value={tgt} onChange={(e) => setTgt(e.target.value)} aria-label="Slider">
            <option value="">Choose a slider…</option>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn icon" disabled={!tgt} onClick={() => tgt && addModulation(src, tgt, 0.4)} aria-label="Add routing">
            <Plus width={13} height={13} />
          </button>
        </div>
      </Section>
      <Section id="route.legend" title="What the layers mean" collapsible defaultOpen={false}>
        <dl className="legend">
          {LAYERS.map((l) => (
            <div key={l.id}>
              <dt>{l.label}</dt>
              <dd>{l.hint}</dd>
            </div>
          ))}
        </dl>
      </Section>
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
const HAND_FPS: { v: HandStyle['fps']; label: string }[] = [
  { v: 60, label: 'Smooth' },
  { v: 12, label: 'Drawn' },
  { v: 8, label: 'Choppy' },
];
const HAND_INKS: { v: HandStyle['inks']; label: string }[] = [
  { v: 0, label: 'Full colour' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 3, label: '3' },
  { v: 4, label: '4' },
];

/** a segmented control that fills its row */
function Seg<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={`seg full ${disabled ? 'is-off' : ''}`}>
      {options.map((o) => (
        <button key={String(o.v)} className={value === o.v ? 'on' : ''} disabled={disabled} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** the hand-drawn finish: frame rate, inks from the palette, wobble, paper, misprint, pencil */
function HandGroup() {
  const hand = useStudio((s) => s.hand);
  const set = useStudio((s) => s.set);
  const put = (patch: Partial<HandStyle>) => set({ hand: { ...useStudio.getState().hand, ...patch } });
  const slider = (key: 'wobble' | 'paper' | 'misprint' | 'lines', name: string, hint: string) => (
    <Field key={key} label={name} value={`${Math.round(hand[key] * 100)}%`} tip={hint}>
      <Slider value={hand[key]} min={0} max={1} step={0.01} onChange={(v) => put({ [key]: v })} />
    </Field>
  );
  return (
    <Section id="look.hand" title="Hand-drawn" sub="Choppy frames, wobbly lines, ink on paper (H)" right={<Toggle on={hand.on} onChange={(v) => put({ on: v })} label="Hand-drawn" />}>
      {hand.on && (
        <>
          <Field
            label="Frames"
            tip="Smooth keeps motion fluid and only re-draws the lines. Drawn (12 a second) and Choppy (8) hold each picture like hand animation; kicks, snares and drops always get a fresh one."
          >
            <Seg value={hand.fps} options={HAND_FPS} onChange={(v) => put({ fps: v })} />
          </Field>
          <Field label="Inks" tip="Print with a few flat inks from the palette, or keep every colour.">
            <Seg value={hand.inks} options={HAND_INKS} onChange={(v) => put({ inks: v })} />
          </Field>
          {slider('wobble', 'Wobble', 'How much each drawing strays from the last')}
          {slider('lines', 'Pencil lines', 'An outline wherever the picture has an edge')}
          {slider('paper', 'Paper', 'Paper fibre, grain and uneven ink')}
          {hand.inks > 0 && slider('misprint', 'Misprint', 'Inks printed slightly out of line with each other')}
        </>
      )}
    </Section>
  );
}

const POPUP_MODES: { v: PopupMode; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'video', label: 'In videos' },
  { v: 'always', label: 'Always' },
];

const PACES: { v: Pace; label: string }[] = [
  { v: 'slow', label: 'Slow' },
  { v: 'song', label: 'Song-driven' },
  { v: 'fast', label: 'Fast' },
];

const LENGTHS: { v: number; label: string }[] = [
  { v: 0, label: 'Auto' },
  { v: 0.5, label: '½' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 4, label: '4' },
  { v: 8, label: '8' },
];

/** how a made video moves: how often it cuts, how one look turns into the next, the pop-ups, auto-pilot */
function VideoGroup() {
  const pace = useStudio((s) => s.pace);
  const transition = useStudio((s) => s.transition);
  const beats = useStudio((s) => s.transitionBeats);
  const popups = useStudio((s) => s.popups);
  const autoPilot = useStudio((s) => s.autoPilot);
  const set = useStudio((s) => s.set);
  const info = TRANSITIONS.find((t) => t.id === transition);
  return (
    <Section id="look.video" title="Video" sub="How a made video moves from look to look" collapsible>
      <Field
        label="Pace"
        value={pace === 'song' ? 'Cuts with the music' : pace === 'slow' ? 'Holds longer' : 'Cuts twice as often'}
        tip="Song-driven: cuts on the music's phrases and hits, faster when it's loud and busy, at least every ~10 s. Slow holds each picture longer; Fast cuts about twice as often. Big drops always cut."
      >
        <Seg value={pace} options={PACES} onChange={(v) => set({ pace: v })} />
      </Field>
      <Field
        label="Transition"
        tip="Auto: long dissolves and fades in calm parts, wipes and slit-scans on builds, quick pushes or hard cuts when it's loud. Pick one to use it for every change (videos, auto-pilot and your own picks). Big drops always cut."
      >
        <select className="sel" value={transition} onChange={(e) => set({ transition: e.target.value as typeof transition })}>
          <option value="auto">Auto (fits the song)</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <p className="field-note">{transition === 'auto' ? 'Picked to fit the song and the moment' : transition === 'cut' ? 'Hard cuts, no blending' : `Always ${info?.blurb ?? ''}`}</p>
      </Field>
      <Field label="Transition length" value="beats" tip="How long a transition takes, locked to the song's tempo. Auto: longer in calm parts, short and punchy in loud ones.">
        <Seg value={beats} options={LENGTHS} onChange={(v) => set({ transitionBeats: v })} disabled={transition === 'cut'} />
      </Field>
      <Field
        label="Pop-up windows"
        tip="Busy little windows (radar, terminal, Pong…) pop in on drops and new parts. In videos: while a video plan plays, busier on choruses and drops. Always: a few keep coming whatever is playing."
      >
        <Seg value={popups} options={POPUP_MODES} onChange={(v) => set({ popups: v })} />
      </Field>
      <div className="row-switch">
        <span>
          <b>Auto-pilot</b>
          <small>Switch looks on drops and every 8 bars</small>
        </span>
        <Toggle on={autoPilot} onChange={(v) => set({ autoPilot: v })} label="Auto-pilot" />
      </div>
    </Section>
  );
}

function LookPanel() {
  const palette = useStudio((s) => s.palette);
  const text = useStudio((s) => s.text);
  const quality = useStudio((s) => s.quality);
  const { setPalette, setPaletteColor, set, saveCurrentAsPreset, flash } = useStudio.getState();
  const [name, setName] = useState('');
  const save = () => {
    const p = saveCurrentAsPreset(name.trim() || 'Untitled look');
    setName('');
    flash(`Saved “${p.name}” to your looks`);
  };
  return (
    <>
      <form
        className="save-row"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input className="txt" placeholder="Name this look…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Look name" />
        <button className="btn primary" type="submit">
          Save look
        </button>
      </form>
      <Section id="look.palette" title="Palette" sub={palette.name} collapsible>
        <div className="pal-grid">
          {PALETTES.map((p) => (
            <button key={p.id} className={`pal ${palette.id === p.id ? 'on' : ''}`} onClick={() => setPalette(p)} title={p.name}>
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
        <div className="color-grid">
          {COLOR_KEYS.map(([k, label]) => (
            <label key={k} className="color-in">
              <input type="color" value={palette[k]} onChange={(e) => setPaletteColor(k, e.target.value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </Section>
      <VideoGroup />
      <HandGroup />
      <TasteGroup />
      <Section id="look.text" title="Title text" sub="Shown by scenes that use text (the boards, mostly)" collapsible defaultOpen={false}>
        <textarea className="txt" placeholder="are you still there" value={text} onChange={(e) => set({ text: e.target.value })} aria-label="Title text" />
      </Section>
      <Section id="look.advanced" title="Advanced" collapsible defaultOpen={false}>
        <Field label="Render quality" value={`${Math.round(quality * 100)}%`} tip="Lower it if the picture stutters on a slower computer.">
          <Slider value={quality} min={0.4} max={1} step={0.05} onChange={(v) => set({ quality: v })} />
        </Field>
        <Field label="Director access code">
          <input
            className="txt"
            type="password"
            placeholder="Only if the site owner set one"
            defaultValue={readAccessCode()}
            onChange={(e) => {
              try {
                localStorage.setItem('hum.accessCode', e.target.value);
              } catch {
                /* storage unavailable */
              }
            }}
          />
        </Field>
      </Section>
    </>
  );
}
