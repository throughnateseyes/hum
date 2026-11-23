import { useMemo } from 'react';
import type { LookFamily } from '../presets/fit';
import { familyIdOf, familyOf, withCustom } from '../presets/fit';
import { findLook } from '../state/plan';
import { useStudio } from '../state/store';

/**
 * The look family on screen, for the takes strip and Save as a take (null for a look of the
 * person's own that isn't a take of anything).
 */
export function useLookFamily(): LookFamily | null {
  const presetId = useStudio((s) => s.presetId);
  const sceneId = useStudio((s) => s.sceneId);
  const custom = useStudio((s) => s.customPresets);
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
  if (!fam || (fam.takes.length === 1 && fam.takes[0].custom && !fam.takes[0].family)) return null;
  return fam;
}
