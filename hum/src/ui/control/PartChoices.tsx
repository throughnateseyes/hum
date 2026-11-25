import { useEffect, useRef } from 'react';
import { applyChoice, endPreview, previewChoice, useChoices, type Choice } from '../../director/control';
import { useStudio } from '../../state/store';
import { Field } from '../controls';
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
    const { id, focusX, focusY } = c.thumb;
    const src = media.find((m) => m.id === id)?.thumb;
    return src ? <img src={src} alt="" loading="lazy" style={{ objectPosition: `${focusX * 100}% ${(1 - focusY) * 100}%` }} /> : null;
  };
  return (
    <Field label="Other choices" tip="Rest on one to see it where the part plays. Nothing changes until you click.">
      <div className="cards" onMouseLeave={stop}>
        {choices.map((c) => (
          <button key={c.id} type="button" className="card" disabled={busy} onMouseEnter={() => rest(c)} onFocus={(e) => e.currentTarget.matches(':focus-visible') && previewChoice(c)} onBlur={stop} onClick={() => {
              clearTimeout(wait.current);
              applyChoice(c);
            }}>
            <span className="thumb">{picture(c)}</span>
            <span>
              <span className="title">
                <span>{c.label}</span>
              </span>
              {c.detail && <span className="desc">{c.detail}</span>}
            </span>
          </button>
        ))}
      </div>
    </Field>
  );
}
