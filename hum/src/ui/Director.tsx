import { useEffect, useRef, useState } from 'react';
import { direct } from '../director/client';
import { lookToPreset } from '../presets/apply';
import { getScene } from '../scenes';
import { useStudio, type ChatMsg } from '../state/store';
import { Arrow, Chevron, Redo, Sparkle, Trash } from './Icons';

export function readAccessCode(): string {
  try {
    return localStorage.getItem('hum.accessCode') ?? '';
  } catch {
    return '';
  }
}

type Mode = 'preset' | 'shader';

/** Plain-language help for the two director modes. */
export const MODE_HELP: Record<Mode, { label: string; tip: string }> = {
  preset: {
    label: 'Look',
    tip: 'Mixes the pieces Hum already has — a scene, effects, colours and what reacts to the music — into a new combination. Quick, and every slider stays tweakable.',
  },
  shader: {
    label: 'New scene',
    tip: 'Claude draws a brand-new visual from scratch, one that didn’t exist before. Slower and sometimes misses, but it can make something truly new. It’s saved under Scenes.',
  },
};

const SUGGESTIONS = ['Feel every blomp of the bass', 'Rain on a window at 3am', 'First love, overexposed film', 'A memory slowly dissolving'];

const DIRECTOR_INPUT_ID = 'director-input';
export const focusDirector = () => document.getElementById(DIRECTOR_INPUT_ID)?.focus();

function sourceLabel(m: ChatMsg) {
  if (m.error) return 'Didn’t work';
  if (m.source === 'local') return 'Offline director';
  return m.via === 'subscription' ? 'Claude · your plan' : 'Claude';
}

export function DirectorPanel() {
  const open = useStudio((s) => s.directorOpen);
  const height = useStudio((s) => s.directorHeight);
  const chat = useStudio((s) => s.chat);
  const analysis = useStudio((s) => s.analysis);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('preset');
  const [busy, setBusy] = useState<Mode | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // keep the newest message in view
  useEffect(() => {
    const el = log.current;
    if (el && (chat.length || busy)) el.scrollTop = el.scrollHeight;
  }, [chat.length, busy, open]);

  // grow the input with its text (1–5 lines)
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
  }, [prompt]);

  const run = async (text: string) => {
    const p = text.trim();
    if (!p || busy) return;
    const s = useStudio.getState();
    s.set({ directorOpen: true });
    s.pushChat({ role: 'user', text: p, mode });
    setPrompt('');
    setBusy(mode);
    try {
      const res = await direct(
        {
          prompt: p,
          mode,
          track: s.analysis ? { summary: s.analysis.summary, bpm: s.analysis.bpm, mood: s.analysis.mood, tags: s.analysis.tags } : null,
          current: s.sceneId ? lookToPreset(s, { id: s.presetId ?? 'current', name: 'Current look', description: '', tags: [] }) : null,
        },
        { accessCode: readAccessCode() || undefined },
      );
      const st = useStudio.getState();
      if (res.shader) {
        st.addCustomShader(res.shader);
        st.setScene(res.shader.id);
        st.pushChat({ role: 'director', text: res.note, mode, shaderId: res.shader.id, title: res.shader.name, source: res.source, via: res.via });
      } else if (res.preset) {
        const preset = { ...res.preset, custom: true };
        st.addCustomPreset(preset);
        st.applyPreset(preset);
        st.pushChat({ role: 'director', text: res.note, mode, presetId: preset.id, title: preset.name, source: res.source, via: res.via });
      } else {
        st.pushChat({ role: 'director', text: res.note || 'Nothing came back.', mode, error: true });
      }
    } catch (e) {
      useStudio.getState().pushChat({ role: 'director', text: `Couldn’t direct that: ${String(e)}`, mode, error: true });
    }
    setBusy(null);
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = useStudio.getState().directorHeight;
    const move = (ev: PointerEvent) => {
      const max = window.innerHeight - 240;
      useStudio.setState({ directorHeight: Math.round(Math.max(170, Math.min(max, h0 + (y0 - ev.clientY)))) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      useStudio.getState().set({ directorHeight: useStudio.getState().directorHeight });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const sugs = analysis?.tags.length ? [`Match the ${analysis.tags.slice(0, 2).join(', ')} mood`, ...SUGGESTIONS.slice(0, 3)] : SUGGESTIONS;

  return (
    <section className={`director ${open ? 'open' : ''}`} style={open ? { height } : undefined}>
      {open && <div className="split-handle" onPointerDown={startResize} title="Drag to resize" />}
      <header className="dir-head">
        <button className="dir-toggle" onClick={() => useStudio.getState().set({ directorOpen: !open })} title={open ? 'Collapse' : 'Expand'}>
          <Chevron width={14} height={14} style={{ transform: open ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }} />
          Director
        </button>
        <span className="spacer" />
        {open && chat.length > 0 && (
          <button className="btn icon sm ghost" title="Clear history" onClick={() => useStudio.getState().clearChat()}>
            <Trash width={13} height={13} />
          </button>
        )}
      </header>

      {open && (
        <div className="dir-log" ref={log}>
          {chat.length === 0 && !busy && (
            <div className="dir-empty">
              <p>Describe a feeling and the director turns it into visuals. Ask for changes too — “warmer”, “less busy”, “hit harder on the kick”.</p>
              <div className="mode-explain">
                {(['preset', 'shader'] as Mode[]).map((m) => (
                  <div key={m}>
                    <b>{MODE_HELP[m].label}</b>
                    <span>{MODE_HELP[m].tip}</span>
                  </div>
                ))}
              </div>
              <div className="dir-sugs">
                {sugs.map((t) => (
                  <button key={t} onClick={() => void run(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.map((m) => (m.role === 'user' ? <UserMsg key={m.id} m={m} /> : <BotMsg key={m.id} m={m} />))}
          {busy && (
            <div className="msg bot">
              <div className="pending">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {busy === 'shader' ? 'Drawing a new scene… this one takes a bit' : 'Building a look…'}
              </div>
            </div>
          )}
        </div>
      )}

      <form
        className="dir-input"
        onSubmit={(e) => {
          e.preventDefault();
          void run(prompt);
        }}
      >
        <textarea
          id={DIRECTOR_INPUT_ID}
          ref={input}
          rows={1}
          value={prompt}
          maxLength={600}
          placeholder={mode === 'preset' ? 'Describe a feeling…' : 'Describe something new to draw…'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void run(prompt);
            } else if (e.key === 'Escape') {
              (e.target as HTMLElement).blur();
            }
          }}
        />
        <div className="dir-row">
          <div className="seg">
            {(['preset', 'shader'] as Mode[]).map((m) => (
              <button key={m} type="button" className={`has-tip ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)} data-tip={MODE_HELP[m].tip}>
                {MODE_HELP[m].label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="send" type="submit" disabled={!!busy || !prompt.trim()} title="Send (Enter)">
            {busy ? <span className="spin" /> : <Arrow width={14} height={14} />}
          </button>
        </div>
      </form>
    </section>
  );
}

function UserMsg({ m }: { m: ChatMsg }) {
  return (
    <div className="msg user">
      <div className="bubble">{m.text}</div>
      {m.mode === 'shader' && <div className="msg-meta">New scene</div>}
    </div>
  );
}

function BotMsg({ m }: { m: ChatMsg }) {
  const presetId = useStudio((s) => s.presetId);
  const sceneId = useStudio((s) => s.sceneId);
  const preset = useStudio((s) => (m.presetId ? s.customPresets.find((p) => p.id === m.presetId) : undefined));
  const active = (m.presetId && presetId === m.presetId) || (m.shaderId && sceneId === m.shaderId && !presetId);
  const canApply = !active && (preset || (m.shaderId && getScene(m.shaderId)));
  const apply = () => {
    const s = useStudio.getState();
    if (preset) s.applyPreset(preset);
    else if (m.shaderId) s.setScene(m.shaderId);
  };
  return (
    <div className={`msg bot ${m.error ? 'err' : ''}`}>
      {m.title && (
        <div className="msg-title">
          <Sparkle width={12} height={12} />
          {m.title}
          {active && <span className="now">Showing</span>}
        </div>
      )}
      <div className="msg-text">{m.text}</div>
      <div className="msg-meta">
        {sourceLabel(m)}
        {canApply && (
          <button onClick={apply}>
            <Redo width={11} height={11} /> Use again
          </button>
        )}
      </div>
    </div>
  );
}
