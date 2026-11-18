import type { AudioFrame, Preset } from '../core/types';
import { PRESETS } from '../presets';
import { useStudio } from './store';

/**
 * Auto-pilot: when enabled, switches looks on drops and every 32 beats,
 * preferring the presets the track analysis suggested.
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
    pick = intense.length ? intense[Math.floor(Math.random() * intense.length)] : candidates[0];
  } else {
    cursor = (cursor + 1) % candidates.length;
    pick = candidates[cursor];
  }
  s.applyPreset(pick);
}
