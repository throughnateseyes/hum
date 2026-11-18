import type { LayerId, Modulation, ParamDef, ParamValues } from '../core/types';

/**
 * Apply modulation routings to a param set. `prefix` is 'scene' or 'fx.<instanceId>'.
 * amount is a fraction of the param's range; bool params flip when the modulated value > 0.5.
 */
export function resolveParams(
  defs: ParamDef[],
  base: ParamValues,
  mods: Modulation[],
  prefix: string,
  layers: Record<LayerId, number>,
  out: ParamValues = {},
): ParamValues {
  for (const d of defs) out[d.id] = base[d.id] ?? d.default;
  for (const m of mods) {
    if (!m.enabled) continue;
    const dot = m.target.lastIndexOf('.');
    if (m.target.slice(0, dot) !== prefix) continue;
    const pid = m.target.slice(dot + 1);
    const d = defs.find((x) => x.id === pid);
    if (!d) continue;
    const sig = layers[m.source] ?? 0;
    if (d.type === 'number') {
      const cur = out[pid] as number;
      const v = cur + m.amount * (d.max - d.min) * sig;
      out[pid] = Math.min(d.max, Math.max(d.min, v));
    } else if (d.type === 'bool') {
      const cur = out[pid] ? 1 : 0;
      out[pid] = cur + m.amount * sig > 0.5;
    } else if (d.type === 'select') {
      const i = d.options.findIndex((o) => o.value === out[pid]);
      const j = Math.round(i + m.amount * (d.options.length - 1) * sig);
      out[pid] = d.options[Math.min(d.options.length - 1, Math.max(0, j))].value;
    }
  }
  return out;
}

let n = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(n++).toString(36)}`;
