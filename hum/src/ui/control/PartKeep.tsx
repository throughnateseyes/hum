import { setKept, useKept } from '../../director/control';
import { SwitchRow } from '../controls';

/** Keep: the parts picked come through a remake and the director's changes exactly as they are */
export function PartKeep({ parts }: { parts: number[] }) {
  const { on, some, can } = useKept(parts);
  if (!can) return null;
  const many = parts.length > 1;
  return (
    <SwitchRow
      label={many ? 'Keep these parts' : 'Keep this part'}
      note={on ? 'Remake and the director leave it as it is' : some ? 'Some of them are kept' : undefined}
      tip="A kept part comes through Remake video, changes asked for in the chat and the director’s own checks exactly as it is. You can still change it by hand."
      on={on}
      onChange={(v) => setKept(parts, v)}
    />
  );
}
