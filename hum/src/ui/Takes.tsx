/**
 * The takes strip at the top of the Inspector: the family the look on screen belongs to, what it's for
 * (its fit), and every take of it (built-in and the person's own) to switch between in one click. Save
 * take keeps what's on screen (colours, sliders, effects) as a new take of the same family.
 */
import { useMemo, useState } from 'react';
import type { LookFamily } from '../presets/fit';
import { familyIdOf, familyOf, ROLES, takeName, withCustom } from '../presets/fit';
import { findLook, pickLook } from '../state/plan';
import { useStudio } from '../state/store';
import { noteHandPick } from '../state/taste';
import { Plus, X } from './Icons';
import { Thumb } from './Library';

const level = (e: number) => (e < 0.2 ? 'quiet' : e < 0.45 ? 'soft' : e < 0.7 ? 'lively' : 'loud');

/** "Best for intro, verse, breakdown · drifts · soft to lively" */
function fitLine(f: LookFamily): string {
  const roles = f.fit.roles.slice(0, 3).map((r) => (ROLES.find((x) => x.id === r)?.label ?? r).toLowerCase());
  const motion = { still: 'barely moves', drifting: 'drifts', pulsing: 'moves on the beat', explosive: 'bursts on hits' }[f.fit.motion];
  const [lo, hi] = f.fit.energy;
  const range = level(lo) === level(hi) ? level(lo) : `${level(lo)} to ${level(hi)}`;
  return `Best for ${roles.join(', ')} · ${motion} · ${range}`;
}

export function TakesStrip() {
  const presetId = useStudio((s) => s.presetId);
  const sceneId = useStudio((s) => s.sceneId);
  const custom = useStudio((s) => s.customPresets);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  const fam = useMemo((): LookFamily | null => {
    const { families } = withCustom(custom);
    const p = presetId ? findLook(presetId) : undefined;
    if (p) {
      const id = familyIdOf(p);
      return families.find((f) => f.id === id) ?? familyOf(p);
    }
    // a scene picked on its own: the family built on it, so its takes are one click away
    return families.find((f) => f.takes.some((t) => t.sceneId === sceneId)) ?? null;
  }, [presetId, sceneId, custom]);
  // a look of the person's own that isn't a take of anything has no family to show
  if (!fam || (fam.takes.length === 1 && fam.takes[0].custom && !fam.takes[0].family)) return null;

  const save = () => {
    const st = useStudio.getState();
    const label = name.trim() || `Take ${fam.takes.length + 1}`;
    const p = st.saveCurrentAsPreset(label, fam.id);
    st.flash(`Saved “${takeName(p)}” as a take of ${fam.name}`);
    setName('');
    setSaving(false);
  };

  return (
    <div className="takes-strip">
      <div className="takes-head">
        <h3 title={fam.blurb}>{fam.name}</h3>
        <span className="label">{fam.takes.length === 1 ? '1 take' : `${fam.takes.length} takes`}</span>
      </div>
      <p className="takes-fit">{fitLine(fam)}</p>
      <div className="takes-row" role="group" aria-label={`${fam.name} takes`}>
        {fam.takes.map((p) => (
          <div key={p.id} className={`take-tile ${p.id === presetId ? 'on' : ''}`}>
            <button
              className="take-pick"
              title={`${takeName(p)}: ${p.description}`}
              aria-pressed={p.id === presetId}
              onClick={() => {
                noteHandPick(p, 'pick');
                pickLook(p);
              }}
            >
              <div className="tt-img">
                <Thumb p={p} />
              </div>
              <div className="tt-pal" aria-hidden>
                <i style={{ background: p.palette.bg }} />
                <i style={{ background: p.palette.accent }} />
                <i style={{ background: p.palette.accent2 }} />
                <i style={{ background: p.palette.fg }} />
              </div>
              <div className="tt-name">{takeName(p)}</div>
            </button>
            {p.custom && (
              <button className="tt-del" title="Delete this take" aria-label={`Delete ${takeName(p)}`} onClick={() => useStudio.getState().deleteCustomPreset(p.id)}>
                <X width={10} height={10} />
              </button>
            )}
          </div>
        ))}
        <div className="take-tile add">
          <button className="take-pick" title={`Save what's on screen as a new take of ${fam.name}`} onClick={() => setSaving(!saving)}>
            <div className="tt-img">
              <Plus width={14} height={14} />
            </div>
            <div className="tt-name">Save take</div>
          </button>
        </div>
      </div>
      {saving && (
        <form
          className="takes-save"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input className="txt" autoFocus placeholder={`Name this take of ${fam.name}…`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Take name" />
          <button className="btn primary" type="submit">
            Save
          </button>
        </form>
      )}
    </div>
  );
}
