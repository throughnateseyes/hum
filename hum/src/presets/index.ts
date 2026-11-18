import type { Preset } from '../core/types';
import { PRESETS } from './library';

export { PRESETS };
export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
