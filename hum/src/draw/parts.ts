/**
 * What each part of a song does with drawings (DrawPart), kept per song in this browser. No store in
 * here: the store itself loads and saves with it.
 */
import type { DrawPart } from './types';

const PARTS_KEY = 'hum.drawParts';
/** songs kept, oldest dropped first (as many as the other per-song settings) */
const MAX_SONGS = 24;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readParts(): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(localStorage.getItem(PARTS_KEY) ?? '{}');
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadDrawParts(song: string): DrawPart[] {
  return cleanDrawParts(song ? readParts()[song] : null);
}

export function cleanDrawParts(raw: unknown): DrawPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((p: Record<string, unknown> | null) => {
    const from = num(p?.from);
    const to = num(p?.to);
    if (from === null || to === null || to <= from) return [];
    const ids = Array.isArray(p?.ids) ? p.ids.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
    return [{ from, to, ...(ids.length ? { ids } : {}), ...(p?.off === true ? { off: true } : {}) }];
  });
}

export function saveDrawParts(song: string, parts: DrawPart[]) {
  if (!song) return;
  try {
    const all = readParts();
    delete all[song];
    if (parts.length) all[song] = parts;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SONGS))) delete all[k];
    localStorage.setItem(PARTS_KEY, JSON.stringify(all));
  } catch {
    /* storage may be unavailable */
  }
}

/** the setting that covers time t (a part's middle), or null */
export function drawPartAt(parts: DrawPart[], t: number): DrawPart | null {
  for (let i = parts.length - 1; i >= 0; i--) if (t >= parts[i].from && t < parts[i].to) return parts[i];
  return null;
}
