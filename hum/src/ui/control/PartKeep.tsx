import { setKept, useKept } from '../../director/control';
import { Lock } from '../Icons';

/** Keep: the parts picked come through a remake and the director's changes exactly as they are */
export function PartKeep({ parts, disabled }: { parts: number[]; disabled?: boolean }) {
  const { on, some, can } = useKept(parts);
  if (!can) return null;
  const what = parts.length > 1 ? 'These parts' : 'This part';
  return (
    <button
      type="button"
      className={`btn sm ghost pp-keep ${on ? 'on' : ''}`}
      aria-pressed={on ? true : some ? 'mixed' : false}
      disabled={disabled}
      onClick={() => setKept(parts, !on)}
      title={on ? 'Kept: Remake, the chat and the director’s own checks leave it exactly as it is. Click to let it change again.' : `${what} will come through Remake, the chat and the director’s own checks exactly as now. You can still change it by hand.`}
    >
      <Lock width={12} height={12} />
      {on ? 'Kept' : some ? 'Keep all' : 'Keep'}
    </button>
  );
}
