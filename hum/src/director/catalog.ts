/**
 * Compact text catalog of everything the AI director may reference: scenes + params,
 * effects + params, palettes, audio layers. Built from the live registries on demand,
 * sent with each director request (server caps it at 20 kB).
 */
import type { EffectDef, ParamDef, SceneDef } from '../core/types';
import { LAYERS, PALETTES, isLightPalette } from '../core/palettes';
import { sceneStyle } from '../core/styles';
import { allScenes } from '../scenes';
import { allEffects } from '../fx';

export const CATALOG_MAX_CHARS = 19_500;

const trim = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

/** e.g. `size n 0..1=0.5`, `ink c=#16161a`, `mode s[grid|rings]=grid`, `invert b=false` */
export function formatParam(p: ParamDef): string {
  switch (p.type) {
    case 'number':
      return `${p.id} n ${fmtNum(p.min)}..${fmtNum(p.max)}=${fmtNum(p.default)}`;
    case 'color':
      return `${p.id} c=${p.default}`;
    case 'bool':
      return `${p.id} b=${p.default}`;
    case 'select':
      return `${p.id} s[${p.options.map((o) => o.value).join('|')}]=${p.default}`;
  }
}

function sceneLine(s: SceneDef, detail: number): string {
  const flags = [s.category, `style:${sceneStyle(s)}`, s.light ? 'light' : '', s.usesPhotos ? 'photos' : ''].filter(Boolean).join(',');
  const head = `${s.id} [${flags}] ${s.tags.slice(0, 6).join(',')}`;
  const desc = detail >= 1 ? ` — ${trim(s.description, detail >= 2 ? 110 : 60)}` : '';
  const params = s.params.map(formatParam).join('; ');
  return `${head}${desc}\n  ${params || '(no params)'}`;
}

function effectLine(e: EffectDef, detail: number): string {
  const desc = detail >= 1 ? ` — ${trim(e.description, detail >= 2 ? 90 : 50)}` : '';
  const params = e.params.map(formatParam).join('; ');
  return `${e.id} [${e.category}]${desc}\n  ${params || '(no params)'}`;
}

export interface CatalogInputs {
  scenes?: SceneDef[];
  effects?: EffectDef[];
}

/** Build the prompt catalog from the live registries (or supplied lists). */
export function buildCatalog(inputs: CatalogInputs = {}): string {
  const scenes = (inputs.scenes ?? allScenes()).filter((s) => s.category !== 'code' || !s.tags.includes('generated'));
  const effects = inputs.effects ?? allEffects();

  const build = (detail: number) => {
    const out: string[] = [];
    out.push('PARAM FORMAT: id n min..max=default | id c=#hex | id b=bool | id s[options]=default');
    out.push(`\nSCENES (${scenes.length}) — id [category,flags] tags — description`);
    for (const s of scenes) out.push(sceneLine(s, detail));
    out.push(`\nEFFECTS (${effects.length}) — chain order = array order`);
    for (const e of effects) out.push(effectLine(e, detail));
    out.push('\nPALETTES — id: bg fg accent accent2 muted (light/dark)');
    for (const p of PALETTES) out.push(`${p.id}: ${p.bg} ${p.fg} ${p.accent} ${p.accent2} ${p.muted} (${isLightPalette(p) ? 'light' : 'dark'})`);
    out.push('\nLAYERS (modulation sources, 0..1; sway -1..1)');
    out.push(LAYERS.map((l) => (detail >= 1 ? `${l.id}: ${l.hint}` : l.id)).join(detail >= 1 ? '\n' : ', '));
    return out.join('\n');
  };

  for (const detail of [2, 1, 0]) {
    const text = build(detail);
    if (text.length <= CATALOG_MAX_CHARS) return text;
  }
  return build(0).slice(0, CATALOG_MAX_CHARS);
}
