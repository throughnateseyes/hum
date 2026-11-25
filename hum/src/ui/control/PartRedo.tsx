import { useState } from 'react';
import { MOST_REDO, redoParts, useKept, useRedo } from '../../director/control';
import { useStudio } from '../../state/store';

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
  const line = kept ? '' : parts.length > MOST_REDO ? `At most ${MOST_REDO} parts at a time.` : mine || running ? note : '';
  return (
    <section className="pp-redo" aria-label={many ? 'Redo these parts' : 'Redo this part'}>
      <div className="pp-redo-row">
      <input
        className="txt"
        value={wish}
        maxLength={300}
        placeholder={kept ? 'Kept as it is' : 'Closer, calmer, another clip…'}
        aria-label="What you want instead"
        disabled={kept}
        onChange={(e) => setWish(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !running && !busy && !kept) go();
        }}
      />
        {running ? (
          <button type="button" className="btn" onClick={cancel}>
            <span className="spin" /> Stop
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy || kept} onClick={go} title={`The director chooses ${many ? 'these parts' : 'this part'} again and leaves the rest of the video as it is. Say what you want, or leave it empty for another take.`}>
            Redo
          </button>
        )}
      </div>
      {line && (
        <p className="field-note" aria-live="polite">
          {line}
        </p>
      )}
    </section>
  );
}
