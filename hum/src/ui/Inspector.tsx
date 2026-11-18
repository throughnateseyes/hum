import { useState } from 'react';
import { LAYERS, PALETTES } from '../core/palettes';
import type { EffectCategory, HandStyle, LayerId, Palette } from '../core/types';
import { allEffects, getEffect } from '../fx';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio, type Aspect, type InspectorTab, type Pace, type PopupMode } from '../state/store';
import { TRANSITIONS } from '../core/transitionList';
import { ParamControl, Slider, Toggle, groupParams } from './controls';
import { Down, Plus, Up, X } from './Icons';
import { readAccessCode } from './Director';
import { TasteGroup } from './Taste';

const CAT_NAME: Record<string, string> = { form: '3D form', field: 'Field', photo: 'Photo', board: 'Instrument board', code: 'Made by the director' };

export function Inspector() {
  const tab = useStudio((s) => s.inspectorTab);
  const set = useStudio((s) => s.set);
  const fxCount = useStudio((s) => s.effects.length);
  const modCount = useStudio((s) => s.modulations.length);
  const tabs: [InspectorTab, string][] = [
    ['scene', 'Scene'],
    ['fx', `Effects${fxCount ? ` ${fxCount}` : ''}`],
    ['layers', `Routing${modCount ? ` ${modCount}` : ''}`],
    ['look', 'Look'],
  ];
  return (
    <aside className="inspector">
      <div className="panel-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => set({ inspectorTab: id })}>
            {label}
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
        <p>{def.description}</p>
      </div>
      {shaderError && (
        <div className="group">
          <div className="group-title">
            <span className="label" style={{ color: 'var(--danger)' }}>
              Shader error
            </span>
          </div>
          <div className="code">{shaderError}</div>
        </div>
      )}
      {groupParams(def.params).map(([g, defs]) => (
        <div className="group" key={g}>
          <div className="group-title">
            <span className="label">{g}</span>
          </div>
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
        </div>
      ))}
      <p className="hint">Drag a meter from the strip under the stage onto any slider to make it move with that part of the music.</p>
      {spec && (
        <div className="group" style={{ marginTop: 14 }}>
          <div className="group-title">
            <span className="label">Generated GLSL</span>
            <button className="btn sm ghost" onClick={() => setShowCode(!showCode)}>
              {showCode ? 'Hide' : 'Show'}
            </button>
          </div>
          {showCode && (
            <pre className="code" style={{ color: 'var(--ink-2)', background: 'var(--panel-2)', borderColor: 'var(--line)', maxHeight: 320 }}>
              {spec.fragment}
            </pre>
          )}
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
          <Plus width={13} height={13} /> Add
        </button>
      </div>
      {effects.length === 0 && !adding && <p style={{ color: 'var(--ink-3)' }}>No effects. The raw scene is showing.</p>}
      {effects.map((e) => {
        const def = getEffect(e.effectId);
        if (!def) return null;
        const isOpen = open === e.instanceId;
        return (
          <div key={e.instanceId} className={`fx-item ${e.enabled ? '' : 'off'}`}>
            <div className="fx-head">
              <span className="n" onClick={() => setOpen(isOpen ? null : e.instanceId)}>
                {def.name}
              </span>
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
                <p style={{ color: 'var(--ink-3)', fontSize: 11.5, margin: '8px 0 2px' }}>{def.description}</p>
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
      <div className="insp-head">
        <h3>Audio routing</h3>
        <p>Each layer is a signal pulled out of the music. Route any of them to any slider.</p>
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">Sensitivity</span>
          <span className="param-val">{sensitivity.toFixed(2)}×</span>
        </div>
        <Slider value={sensitivity} min={0.3} max={2.5} onChange={(v) => set({ sensitivity: v })} />
        <div style={{ height: 6 }} />
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">Routings</span>
        </div>
        {mods.length === 0 && <p style={{ color: 'var(--ink-3)', margin: '4px 0 8px' }}>None yet.</p>}
        {mods.map((m) => (
          <div className="mod-row" key={m.id} style={{ opacity: m.enabled ? 1 : 0.5 }}>
            <select
              className="src-chip"
              value={m.source}
              onChange={(e) => updateModulation(m.id, { source: e.target.value as LayerId })}
              style={{ border: 0, appearance: 'none', cursor: 'pointer' }}
            >
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
            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <span className="param-val" style={{ width: 34, textAlign: 'right' }}>
                {Math.round(m.amount * 100)}%
              </span>
              <button className="btn icon sm ghost" onClick={() => removeModulation(m.id)}>
                <X width={12} height={12} />
              </button>
            </div>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr auto', gap: 6, padding: '10px 0 4px' }}>
          <select className="sel" value={src} onChange={(e) => setSrc(e.target.value as LayerId)}>
            {LAYERS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <select className="sel" value={tgt} onChange={(e) => setTgt(e.target.value)}>
            <option value="">Choose a target…</option>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!tgt} onClick={() => tgt && addModulation(src, tgt, 0.4)}>
            <Plus width={13} height={13} />
          </button>
        </div>
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">What the layers mean</span>
        </div>
        {LAYERS.map((l) => (
          <div key={l.id} className="kv" style={{ padding: '3px 0' }}>
            <span style={{ fontSize: 12 }}>
              {l.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', textAlign: 'right' }}>{l.hint}</span>
          </div>
        ))}
      </div>
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
const ASPECTS: Aspect[] = ['fill', '16:9', '9:16', '4:5', '1:1'];
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

/** the hand-drawn finish: frame rate, inks from the palette, wobble, paper, misprint, pencil */
function HandGroup() {
  const hand = useStudio((s) => s.hand);
  const set = useStudio((s) => s.set);
  const put = (patch: Partial<HandStyle>) => set({ hand: { ...useStudio.getState().hand, ...patch } });
  const slider = (key: 'wobble' | 'paper' | 'misprint' | 'lines', name: string, hint: string) => (
    <div className="param" key={key}>
      <div className="param-top has-tip" data-tip={hint}>
        <span className="param-name">{name}</span>
        <span className="param-val">{Math.round(hand[key] * 100)}%</span>
      </div>
      <Slider value={hand[key]} min={0} max={1} step={0.01} onChange={(v) => put({ [key]: v })} />
    </div>
  );
  return (
    <div className="group">
      <div className="kv" style={{ marginBottom: hand.on ? 10 : 2 }}>
        <span>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Hand-drawn</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Choppy frames, wobbly lines, ink on paper</div>
        </span>
        <Toggle on={hand.on} onChange={(v) => put({ on: v })} />
      </div>
      {hand.on && (
        <>
          <div className="param-top has-tip" data-tip="Smooth keeps motion fluid and only re-draws the lines. Drawn (12 a second) and Choppy (8) hold each picture like hand animation; kicks, snares and drops always get a fresh one.">
            <span className="param-name">Frames</span>
          </div>
          <div className="seg" style={{ marginBottom: 10 }}>
            {HAND_FPS.map((f) => (
              <button key={f.v} className={hand.fps === f.v ? 'on' : ''} onClick={() => put({ fps: f.v })}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="param-top has-tip" data-tip="Print with a few flat inks from the palette above, or keep every colour.">
            <span className="param-name">Inks</span>
          </div>
          <div className="seg" style={{ marginBottom: 10 }}>
            {HAND_INKS.map((f) => (
              <button key={f.v} className={hand.inks === f.v ? 'on' : ''} onClick={() => put({ inks: f.v })}>
                {f.label}
              </button>
            ))}
          </div>
          {slider('wobble', 'Wobble', 'How much each drawing strays from the last')}
          {slider('lines', 'Pencil lines', 'An outline wherever the picture has an edge')}
          {slider('paper', 'Paper', 'Paper fibre, grain and uneven ink')}
          {hand.inks > 0 && slider('misprint', 'Misprint', 'Inks printed slightly out of line with each other')}
        </>
      )}
    </div>
  );
}

const POPUP_MODES: { v: PopupMode; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'video', label: 'In videos' },
  { v: 'always', label: 'Always' },
];

/** little board windows (radar, terminal, Pong…) that pop in over the picture */
function PopupsGroup() {
  const mode = useStudio((s) => s.popups);
  const set = useStudio((s) => s.set);
  return (
    <div className="group">
      <div className="kv" style={{ marginBottom: 10 }}>
        <span>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Pop-ups</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Busy little windows pop in on drops and new parts</div>
        </span>
        <Toggle on={mode !== 'off'} onChange={(v) => set({ popups: v ? 'video' : 'off' })} />
      </div>
      <div
        className="seg has-tip"
        data-tip="In videos: while a video plan plays (Make a video), busier on choruses and drops. Always: a few keep coming whatever is playing."
        style={{ marginBottom: 2 }}
      >
        {POPUP_MODES.map((m) => (
          <button key={m.v} className={mode === m.v ? 'on' : ''} onClick={() => set({ popups: m.v })}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const PACES: { v: Pace; label: string }[] = [
  { v: 'slow', label: 'Slow' },
  { v: 'song', label: 'Song-driven' },
  { v: 'fast', label: 'Fast' },
];

/** how often a video plan changes the picture */
function PaceGroup() {
  const pace = useStudio((s) => s.pace);
  const set = useStudio((s) => s.set);
  return (
    <div className="group">
      <div className="kv" style={{ marginBottom: 10 }}>
        <span>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Pace</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>How often a video changes the picture</div>
        </span>
      </div>
      <div
        className="seg has-tip"
        data-tip="Song-driven: cuts on the music's phrases and hits, faster when it's loud and busy, at least every ~10 s. Slow holds each picture longer; Fast cuts about twice as often. Big drops always cut."
        style={{ marginBottom: 2 }}
      >
        {PACES.map((m) => (
          <button key={m.v} className={pace === m.v ? 'on' : ''} onClick={() => set({ pace: m.v })}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const LENGTHS: { v: number; label: string }[] = [
  { v: 0, label: 'Auto' },
  { v: 0.5, label: '½' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 4, label: '4' },
  { v: 8, label: '8' },
];

/** how one look turns into the next: picked from the song, one transition always, or hard cuts */
function TransitionGroup() {
  const transition = useStudio((s) => s.transition);
  const beats = useStudio((s) => s.transitionBeats);
  const set = useStudio((s) => s.set);
  const info = TRANSITIONS.find((t) => t.id === transition);
  return (
    <div className="group">
      <div className="kv" style={{ marginBottom: 10 }}>
        <span>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Transition</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {transition === 'auto' ? 'Picked to fit the song and the moment' : transition === 'cut' ? 'Hard cuts, no blending' : `Always ${info?.blurb ?? ''}`}
          </div>
        </span>
      </div>
      <div
        className="has-tip"
        data-tip="Auto: long dissolves and fades in calm parts, wipes and slit-scans on builds, quick pushes or hard cuts when it's loud. Pick one to use it for every change (videos, auto-pilot and your own picks). Big drops always cut."
        style={{ marginBottom: 8 }}
      >
        <select className="sel" style={{ width: '100%' }} value={transition} onChange={(e) => set({ transition: e.target.value as typeof transition })}>
          <option value="auto">Auto (fits the song)</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="kv" style={{ margin: '4px 0 6px' }}>
        <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>Length in beats</span>
      </div>
      <div
        className="seg has-tip"
        data-tip="How long a transition takes, locked to the song's tempo. Auto: longer in calm parts, short and punchy in loud ones."
        style={{ marginBottom: 2, opacity: transition === 'cut' ? 0.45 : 1 }}
      >
        {LENGTHS.map((m) => (
          <button key={m.v} className={beats === m.v ? 'on' : ''} disabled={transition === 'cut'} onClick={() => set({ transitionBeats: m.v })}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function LookPanel() {
  const palette = useStudio((s) => s.palette);
  const text = useStudio((s) => s.text);
  const aspect = useStudio((s) => s.aspect);
  const quality = useStudio((s) => s.quality);
  const autoPilot = useStudio((s) => s.autoPilot);
  const { setPalette, setPaletteColor, set, saveCurrentAsPreset, flash } = useStudio.getState();
  const [name, setName] = useState('');
  return (
    <>
      <div className="group">
        <div className="group-title">
          <span className="label">Palette</span>
        </div>
        <div className="pal-grid">
          {PALETTES.map((p) => (
            <button key={p.id} className={`pal ${palette.id === p.id ? 'on' : ''}`} onClick={() => setPalette(p)}>
              <div className="sw">
                <i style={{ background: p.bg }} />
                <i style={{ background: p.accent }} />
                <i style={{ background: p.accent2 }} />
                <i style={{ background: p.fg }} />
              </div>
              <div className="pn">{p.name}</div>
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px', padding: '12px 0 6px' }}>
          {COLOR_KEYS.map(([k, label]) => (
            <label key={k} className="color-in">
              <input type="color" value={palette[k]} onChange={(e) => setPaletteColor(k, e.target.value)} />
              <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{label}</span>
            </label>
          ))}
        </div>
      </div>
      <TasteGroup />
      <HandGroup />
      <PaceGroup />
      <TransitionGroup />
      <PopupsGroup />
      <div className="group">
        <div className="group-title">
          <span className="label">Lyric / title text</span>
        </div>
        <textarea
          className="txt"
          placeholder="are you still there"
          value={text}
          onChange={(e) => set({ text: e.target.value })}
          style={{ marginBottom: 6 }}
        />
        <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--ink-3)' }}>Shown by scenes that use text (the boards, mostly).</p>
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">Frame</span>
        </div>
        <div className="seg" style={{ marginBottom: 10 }}>
          {ASPECTS.map((a) => (
            <button key={a} className={aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })}>
              {a === 'fill' ? 'Fill' : a}
            </button>
          ))}
        </div>
        <div className="param-top">
          <span className="param-name">Render quality</span>
          <span className="param-val">{Math.round(quality * 100)}%</span>
        </div>
        <Slider value={quality} min={0.4} max={1} step={0.05} onChange={(v) => set({ quality: v })} />
        <div className="kv" style={{ marginTop: 8 }}>
          <span>
            <div style={{ fontSize: 12.5 }}>Auto-pilot</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Switch looks on drops and every 8 bars</div>
          </span>
          <Toggle on={autoPilot} onChange={(v) => set({ autoPilot: v })} />
        </div>
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">Director access code</span>
        </div>
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
          style={{ marginBottom: 6 }}
        />
      </div>
      <div className="group">
        <div className="group-title">
          <span className="label">Save this look</span>
        </div>
        <div style={{ display: 'flex', gap: 6, paddingBottom: 4 }}>
          <input className="txt" placeholder="Name it…" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn primary"
            onClick={() => {
              const p = saveCurrentAsPreset(name.trim() || 'Untitled look');
              setName('');
              flash(`Saved “${p.name}” to your looks`);
            }}
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}
