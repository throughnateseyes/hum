import { useState } from 'react';
import { direct } from '../director/client';
import { useStudio } from '../state/store';
import { lookToPreset } from '../presets/apply';
import { Arrow, Code, Sparkle } from './Icons';

export function readAccessCode(): string {
  try {
    return localStorage.getItem('hum.accessCode') ?? '';
  } catch {
    return '';
  }
}

const BASE_SUGGESTIONS = [
  'feel every blomp of the bass',
  'rain on a window at 3am',
  'first love, overexposed film',
  'cold chrome, techno warehouse',
  'a memory dissolving',
];

export function Director() {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'preset' | 'shader'>('preset');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const analysis = useStudio((s) => s.analysis);

  const sugs = analysis ? [`match the ${analysis.tags.slice(0, 2).join(', ')} mood`, ...BASE_SUGGESTIONS.slice(0, 3)] : BASE_SUGGESTIONS.slice(0, 4);

  const run = async (text: string) => {
    const p = text.trim();
    if (!p || busy) return;
    setBusy(true);
    setNote(null);
    const s = useStudio.getState();
    try {
      const res = await direct({
        prompt: p,
        mode,
        track: s.analysis ? { summary: s.analysis.summary, bpm: s.analysis.bpm, mood: s.analysis.mood, tags: s.analysis.tags } : null,
        current: s.sceneId ? lookToPreset(s, { id: s.presetId ?? 'current', name: 'Current look', description: '', tags: [] }) : null,
      }, { accessCode: readAccessCode() || undefined });
      if (res.shader) {
        s.addCustomShader(res.shader);
        s.setScene(res.shader.id);
      } else if (res.preset) {
        const preset = { ...res.preset, custom: true };
        s.applyPreset(preset);
        useStudio.setState((st) => ({ customPresets: [preset, ...st.customPresets.filter((x) => x.id !== preset.id)].slice(0, 40) }));
      }
      setNote(`${res.source === 'claude' ? (res.via === 'subscription' ? '✦ Claude (your plan)' : '✦ Claude') : '◦ Offline director'} — ${res.note}`);
    } catch (e) {
      setNote(`Couldn't direct that: ${String(e)}`);
    }
    setBusy(false);
  };

  return (
    <div className="director">
      {focused && !busy && (
        <div className="director-sugs">
          {sugs.map((s) => (
            <button
              key={s}
              onMouseDown={(e) => {
                e.preventDefault();
                setPrompt(s);
                void run(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="director-box"
        onSubmit={(e) => {
          e.preventDefault();
          void run(prompt);
        }}
      >
        <Sparkle width={15} height={15} style={{ color: 'var(--accent)', flex: 'none' }} />
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={mode === 'preset' ? 'Describe a feeling — the director builds a look…' : 'Describe a visual — Claude writes a new shader…'}
          maxLength={600}
        />
        <div className="seg" title="Look = combine existing scenes & effects · Shader = write brand-new GLSL">
          <button type="button" className={mode === 'preset' ? 'on' : ''} onClick={() => setMode('preset')}>
            Look
          </button>
          <button type="button" className={mode === 'shader' ? 'on' : ''} onClick={() => setMode('shader')}>
            <Code width={12} height={12} style={{ verticalAlign: '-2px' }} /> Shader
          </button>
        </div>
        <button className="btn primary icon" type="submit" disabled={busy || !prompt.trim()} style={{ width: 34, height: 32, borderRadius: 10 }}>
          {busy ? <span className="spin" /> : <Arrow width={15} height={15} />}
        </button>
      </form>
      {note && <div className="director-note">{note}</div>}
    </div>
  );
}
