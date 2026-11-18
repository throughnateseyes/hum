import type { AudioFrame, Preset } from '../core/types';
import { PRESETS } from '../presets';
import { useStudio } from './store';
import { live } from './live';
import { transitionForNow } from './transitionPick';
import { pickByTaste } from './taste';

/**
 * Auto-pilot: when enabled, switches looks on drops and every 32 beats,
 * preferring the presets the track analysis suggested, weighted by the person's taste memory.
 */
let lastSwitchBeat = 0;
let prevDrop = 0;
let cursor = 0;

export function autopilotTick(a: AudioFrame) {
  const s = useStudio.getState();
  const dropEdge = a.drop > 0.95 && prevDrop <= 0.95;
  prevDrop = a.drop;
  if (!s.autoPilot || s.planOn || !a.playing) {
    lastSwitchBeat = a.beatCount;
    return;
  }
  const due = a.beat && a.beatCount - lastSwitchBeat >= 32 && a.beatCount % 16 === 0;
  if (!dropEdge && !due) return;
  lastSwitchBeat = a.beatCount;

  const pool: Preset[] = [];
  const suggested = s.analysis?.suggestedPresets ?? [];
  for (const id of suggested) {
    const p = PRESETS.find((x) => x.id === id);
    if (p) pool.push(p);
  }
  if (pool.length < 4) for (const p of PRESETS) if (!pool.includes(p)) pool.push(p);
  const candidates = pool.slice(0, 8).filter((p) => p.id !== s.presetId);
  if (!candidates.length) return;
  // on a drop, prefer something intense
  let pick: Preset;
  if (dropEdge) {
    const intense = candidates.filter((p) => p.tags.some((t) => ['heavy', 'aggressive', 'intense', 'dubstep', 'chaotic', 'bass'].includes(t)));
    pick = (intense.length ? pickByTaste(intense) : undefined) ?? candidates[0];
  } else {
    // learned taste picks most switches; about one in five explores (see taste.ts)
    cursor = (cursor + 1) % candidates.length;
    pick = pickByTaste(candidates) ?? candidates[cursor];
  }
  // drops cut hard; the regular switches use the Transition setting and the music
  if (live.stage) live.stage.nextTransition = transitionForNow(dropEdge ? 'drop' : 'auto', a.time, a.beatCount * 1.37, dropEdge);
  s.applyPreset(pick);
}
