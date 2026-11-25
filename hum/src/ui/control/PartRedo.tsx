import { useState } from 'react';
import { MOST_REDO, redoParts, useKept, useRedo } from '../../director/control';
import { useStudio } from '../../state/store';
import { Field } from '../controls';

/** Redo: the director chooses the parts picked again, with a wish in plain words when there is one */
export function PartRedo({ parts }: { parts: number[] }) {
  const { running, parts: on, note, cancel } = useRedo();
  const { on: kept, can } = useKept(parts);
  const busy = useStudio((s) => s.planning || !!s.clip);
  const [wish, setWish] = useState('');
  if (!can) return null;
  const many = parts.length > 1;
  const go = () => void redoParts(parts, wish);
  // what it says belongs to the parts it was about
  const mine = on.some((i) => parts.includes(i));
  const line = kept ? (many ? 'These parts are kept. Let one go to redo it.' : 'This part is kept. Let it go to redo it.') : parts.length > MOST_REDO ? `At most ${MOST_REDO} parts at a time.` : mine || running ? note : '';
  return (
    <Field label={many ? 'Redo these parts' : 'Redo this part'} tip="The director chooses this again, and leaves the rest of the video as it is. Say what you want, or leave it empty for another take.">
      <input
        className="txt"
        value={wish}
        maxLength={300}
        placeholder="Closer on the face, calmer, the bridge clip"
        aria-label="What you want instead"
        disabled={kept}
        onChange={(e) => setWish(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !running && !busy && !kept) go();
        }}
      />
      <div className="save-row">
        {running ? (
          <button type="button" className="btn sm" onClick={cancel}>
            <span className="spin" /> Stop
          </button>
        ) : (
          <button type="button" className="btn sm" disabled={busy || kept} onClick={go}>
            Redo
          </button>
        )}
      </div>
      {line && (
        <p className="field-note" aria-live="polite">
          {line}
        </p>
      )}
    </Field>
  );
}
