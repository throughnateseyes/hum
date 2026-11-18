import { useState } from 'react';
import { LAYERS, PALETTES } from '../core/palettes';
import type { EffectCategory, LayerId, Palette } from '../core/types';
import { allEffects, getEffect } from '../fx';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio, type Aspect, type InspectorTab } from '../state/store';
import { ParamControl, Slider, Toggle, groupParams } from './controls';
import { Down, Plus, Up, X } from './Icons';
import { readAccessCode } from './Director';

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
        <div className="label">{def.category}</div>
        <h3>{def.name}</h3>
        <p>{def.description}</p>
        <div className="tags">
          {def.tags.slice(0, 6).map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
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
      <p className="label" style={{ textAlign: 'center', margin: '14px 0 0', lineHeight: 1.6 }}>
        Drag a layer meter from the bottom strip
        <br />
        onto any slider to make it react
      </p>
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
        <span className="label">Stack · top runs first</span>
        <button className="btn sm" onClick={() => setAdding(!adding)}>
          <Plus width={13} height={13} /> Add
        </button>
      </div>
      {effects.length === 0 && !adding && <p style={{ color: 'var(--ink-3)' }}>No effects. The raw scene is showing.</p>}
      {effects.map((e, i) => {
        const def = getEffect(e.effectId);
        if (!def) return null;
        const isOpen = open === e.instanceId;
        return (
          <div key={e.instanceId} className={`fx-item ${e.enabled ? '' : 'off'}`}>
            <div className="fx-head">
              <span className="idx">{String(i + 1).padStart(2, '0')}</span>
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
                  {l.short}
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
              <span className="tag" style={{ marginRight: 6 }}>
                {l.short}
              </span>
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
