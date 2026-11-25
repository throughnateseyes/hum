import { useEffect, useRef } from 'react';
import { applyChoice, endPreview, previewChoice, useChoices, type Choice } from '../../director/control';
import { useStudio } from '../../state/store';
import { useMedia } from '../footageMedia';
import { Thumb } from '../Library';

/** Other choices: up to four things this part could show instead; resting on one shows it, a click puts it in */
export function PartChoices({ part }: { part: number }) {
  const choices = useChoices(part);
  const media = useMedia();
  const busy = useStudio((s) => s.planning || !!s.clip);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stop = () => {
    clearTimeout(wait.current);
    endPreview();
  };
  // a pointer passing over tries nothing on
  const rest = (c: Choice) => {
    clearTimeout(wait.current);
    wait.current = setTimeout(() => previewChoice(c), 180);
  };
  // what was tried on goes when this does
  useEffect(() => stop, [part]);
  if (!choices.length) return null;
  const picture = (c: Choice) => {
    if (c.thumb.kind === 'look') return <Thumb p={c.thumb.look} />;
    const { id, focusX, focusY, zoom } = c.thumb;
    const at = `${focusX * 100}% ${(1 - focusY) * 100}%`;
    const src = media.find((m) => m.id === id)?.thumb;
    return src ? <img src={src} alt="" loading="lazy" style={{ objectPosition: at, ...(zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: at } : {}) }} /> : null;
  };
  return (
    <section className="pp-quick" aria-label="Other choices for this part">
      <div className="ps-h">
        <h3>Other choices</h3>
        <span>Rest on one to try it</span>
      </div>
      <div className="pp-qrow pp-choices" onMouseLeave={stop}>
        {choices.map((c) => (
          <button key={c.id} type="button" className="pp-q" title={c.detail ? `${c.label}: ${c.detail}` : c.label} disabled={busy} onMouseEnter={() => rest(c)} onFocus={(e) => e.currentTarget.matches(':focus-visible') && previewChoice(c)} onBlur={stop} onClick={() => {
              clearTimeout(wait.current);
              applyChoice(c);
            }}>
            <span className="pp-qpic">{picture(c)}</span>
            <span className="pp-qn">{c.short}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
