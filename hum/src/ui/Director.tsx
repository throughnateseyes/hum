import { useEffect, useRef, useState } from 'react';
import { direct } from '../director/client';
import { lookToPreset } from '../presets/apply';
import { getScene } from '../scenes';
import { familyForNew } from '../presets/fit';
import { findLook, pickLook, pickScene } from '../state/plan';
import { useStudio, type ChatMsg, type InspectorTab } from '../state/store';
import { Arrow, Redo, Sparkle, Trash } from './Icons';

/** the saved access code now lives with the access gate */
export { readAccessCode } from '../director/access';

type Mode = 'preset' | 'shader' | 'plan';

/** Plain-language help for the director modes. */
export const MODE_HELP: Record<Mode, { label: string; tip: string }> = {
  plan: {
    label: 'Video',
    tip: 'Change the video you made in plain words: “calmer chorus”, “something brighter on the drop”, “fewer pop-ups”. Only the parts you mention change. Quick and cheap.',
  },
  preset: {
    label: 'Look',
    tip: 'Mixes the pieces Hum already has — a scene, effects, colours and what reacts to the music — into a new combination. Quick, and every slider stays tweakable.',
  },
  shader: {
    label: 'New scene',
    tip: 'Claude draws a brand-new visual from scratch, one that didn’t exist before. Slower and sometimes misses, but it can make something truly new. It’s saved under Scenes.',
  },
};

const DIRECTOR_INPUT_ID = 'director-input';
export const focusDirector = () => document.getElementById(DIRECTOR_INPUT_ID)?.focus();

function sourceLabel(m: ChatMsg) {
  if (m.error) return 'Didn’t work';
  if (m.source === 'local') return 'Offline director';
  return m.via === 'subscription' ? 'Claude · your plan' : 'Claude';
}

/**
 * The Director, docked under the right panel: one calm input with the last few messages over it.
 * Its mode follows the tab: on the Video tab (with a video) it changes the video, on the Part / Look
 * tab it makes a look. New scene is there for drawing something from scratch.
 */
export function DirectorPanel() {
  const chat = useStudio((s) => s.chat);
  const tab = useStudio((s) => s.inspectorTab);
  const hasPlan = useStudio((s) => !!s.plan && !!s.analysis && s.plan.looks.length === s.analysis.sections.length);
  const [prompt, setPrompt] = useState('');
  // the mode follows the tab (the Video tab talks about the video, the others about the look); a
  // mode picked by hand holds until the tab changes
  const [pick, setPick] = useState<{ tab: InspectorTab; mode: Mode } | null>(null);
  const picked: Mode = pick && pick.tab === tab ? pick.mode : tab === 'video' && hasPlan ? 'plan' : 'preset';
  const setMode = (m: Mode) => setPick({ tab, mode: m });
  // "Video" only makes sense while there's a video plan to change
  const mode: Mode = picked === 'plan' && !hasPlan ? 'preset' : picked;
  const modes: Mode[] = hasPlan ? ['preset', 'shader', 'plan'] : ['preset', 'shader'];
  const [busy, setBusy] = useState<Mode | null>(null);
  const [open, setOpen] = useState(false);
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
    s.pushChat({ role: 'user', text: p, mode });
    setPrompt('');
    setBusy(mode);
    if (mode === 'plan') {
      try {
        const { editVideo } = await import('../director/planEdit');
        const r = await editVideo(p);
        useStudio.getState().pushChat({ role: 'director', text: r.note, mode, title: r.ok && r.changed ? 'Video changed' : undefined, source: 'claude', via: r.via, error: !r.ok });
      } catch (e) {
        useStudio.getState().pushChat({ role: 'director', text: `Couldn’t change the video: ${String(e)}`, mode, error: true });
      }
      setBusy(null);
      return;
    }
    try {
      // the saved code is sent by the client; a missing or wrong one opens the access gate
      const res = await direct({
        prompt: p,
        mode,
        track: s.analysis ? { summary: s.analysis.summary, bpm: s.analysis.bpm, mood: s.analysis.mood, tags: s.analysis.tags } : null,
        current: s.sceneId ? lookToPreset(s, { id: s.presetId ?? 'current', name: 'Current look', description: '', tags: [] }) : null,
      });
      const st = useStudio.getState();
      if (res.shader) {
        st.addCustomShader(res.shader);
        pickScene(res.shader.id);
        st.pushChat({ role: 'director', text: res.note, mode, shaderId: res.shader.id, title: res.shader.name, source: res.source, via: res.via });
      } else if (res.preset) {
        // a look the director made on the scene of an existing look family becomes a take of it
        const fam = familyForNew(res.preset.sceneId, s.presetId ? findLook(s.presetId) : undefined);
        const preset = { ...res.preset, custom: true, ...(fam ? { family: fam, variant: res.preset.name } : {}) };
        st.addCustomPreset(preset);
        pickLook(preset);
        st.pushChat({ role: 'director', text: res.note, mode, presetId: preset.id, title: preset.name, source: res.source, via: res.via });
      } else {
        st.pushChat({ role: 'director', text: res.note || 'Nothing came back.', mode, error: true });
      }
    } catch (e) {
      useStudio.getState().pushChat({ role: 'director', text: `Couldn’t direct that: ${String(e)}`, mode, error: true });
    }
    setBusy(null);
  };

  // closed: the last answer, in two lines at most; open: the last messages, scrolling
  const last = chat.length ? chat[chat.length - 1] : null;
  // (a new video's answer opens with its idea, which the Video tab has at its top)
  const idea = useStudio((s) => s.plan?.idea?.trim() ?? '');
  const recent = open ? chat.slice(-20) : last && !busy ? [last] : [];

  return (
    <section className="director">
      {(chat.length > 0 || busy) && (
        <div className="dir-head">
          <span className="grp-l">Director</span>
          <span className="spacer" />
          {chat.length > 0 && (
            <button type="button" className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'History'}
            </button>
          )}
          {open && !busy && chat.length > 0 && (
            <button
              className="btn icon sm ghost"
              type="button"
              title="Clear the history"
              aria-label="Clear the history"
              onClick={() => {
                useStudio.getState().clearChat();
                setOpen(false);
              }}
            >
              <Trash width={13} height={13} />
            </button>
          )}
        </div>
      )}
      {(recent.length > 0 || busy) && (
        <div className={`dir-log ${open ? 'open' : ''}`} ref={log}>
          {recent.map((m) => (m.role === 'user' ? <UserMsg key={m.id} m={m} /> : <BotMsg key={m.id} m={m} without={open ? '' : idea} />))}
          {busy && (
            <div className="msg bot">
              <div className="pending">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {busy === 'shader' ? 'Drawing a new scene… this one takes a bit' : busy === 'plan' ? 'Changing the video…' : 'Building a look…'}
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
          placeholder={mode === 'preset' ? 'Describe a feeling for this look…' : mode === 'plan' ? 'What should change in the video?' : 'Describe something new to draw…'}
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
          <div className="seg dir-modes" role="radiogroup" aria-label="What to change">
            {modes.map((m) => (
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
      {m.mode === 'plan' && <div className="msg-meta">Video</div>}
    </div>
  );
}

function BotMsg({ m, without = '' }: { m: ChatMsg; without?: string }) {
  const text = without && m.text.startsWith(without) ? m.text.slice(without.length).trim() : m.text;
  const presetId = useStudio((s) => s.presetId);
  const sceneId = useStudio((s) => s.sceneId);
  const preset = useStudio((s) => (m.presetId ? s.customPresets.find((p) => p.id === m.presetId) : undefined));
  const active = (m.presetId && presetId === m.presetId) || (m.shaderId && sceneId === m.shaderId && !presetId);
  const canApply = !active && (preset || (m.shaderId && getScene(m.shaderId)));
  const apply = () => {
    if (preset) pickLook(preset);
    else if (m.shaderId) pickScene(m.shaderId);
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
      {text && <div className="msg-text">{text}</div>}
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
