/**
 * The 3D forms an inside shot can have (forms.ts draws them): their names, and which a shot of a song asks
 * for. No drawing code here. What the picture has room for is settled against its depth (InsideShot).
 */
import type { MomentId } from '../moments';

export const FORM_IDS = ['rings', 'frames', 'blocks', 'crossing'] as const;
export type FormId = (typeof FORM_IDS)[number];
export const isForm = (v: unknown): v is FormId => (FORM_IDS as readonly unknown[]).includes(v);

export const FORMS: Record<FormId, { label: string; tip: string }> = {
  rings: { label: 'Rings', tip: 'Two rings round a person, half of each behind them' },
  frames: { label: 'Frames', tip: 'Square frames one behind the other down the street, turning on the beat' },
  blocks: { label: 'Blocks', tip: 'Tall blocks that rise out of the ground behind people' },
  crossing: { label: 'Crossing', tip: 'White road markings lift off the ground as blocks. Needs clear markings' },
};

/** what a shot asks for, the one it would most like first; `level` 0..1 is how far into the song's big moments it is */
export interface FormWish {
  ids: FormId[];
  level: number;
  /** the person picked it: it stands wherever it can be drawn at all */
  asked: boolean;
}

/** the moments that have a form, and whether it is the video's main one */
const BIG: Partial<Record<MomentId, 'main' | 'other'>> = { release: 'main', rush: 'main', fury: 'main', lift: 'other', reveal: 'other', glow: 'other' };
export const formMoment = (m: MomentId | undefined) => (m ? (BIG[m] ?? null) : null);

const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * The order a video prefers them in, from how the song hits (`hits`, kicks per beat): a song that pounds gets
 * frames and blocks, one that flows gets rings. The same song always gets the same order.
 */
export function songForms(hits: number, seed: number): FormId[] {
  const h = Math.min(1, Math.max(0, hits));
  const score: [FormId, number][] = [
    ['rings', 1 - 0.55 * h + 0.35 * hash(seed + 1)],
    ['frames', 0.6 + 0.3 * h + 0.35 * hash(seed + 2)],
    ['blocks', 0.45 + 0.4 * h + 0.35 * hash(seed + 3)],
  ];
  score.sort((a, b) => b[1] - a[1]);
  return score.map((x) => x[0]);
}

/**
 * Which parts of a video have one: the biggest moments first, never two parts in a row, and no more than a
 * third of them. `kinds` is each part's moment ('' where it can't have one). Gives each chosen part's number
 * among them, in order.
 */
const WEIGHT: Partial<Record<MomentId, number>> = { release: 6, reveal: 5, rush: 4, fury: 3, lift: 2, glow: 2 };
export function formParts(kinds: (MomentId | '')[]): Map<number, number> {
  const open = kinds.map((m, i) => ({ i, w: m ? (WEIGHT[m] ?? 0) : 0 })).filter((x) => x.w > 0);
  open.sort((a, b) => b.w - a.w || a.i - b.i);
  const most = Math.max(1, Math.round(kinds.length / 3));
  const got: number[] = [];
  for (const { i } of open) if (got.length < most && !got.some((g) => Math.abs(g - i) < 2)) got.push(i);
  got.sort((a, b) => a - b);
  return new Map(got.map((i, n) => [i, n]));
}

/** does this shot of its part have one? The first, and in a loud part every third after it; never one too short to read */
export const formShot = (kind: 'main' | 'other', index: number, seconds: number) => seconds >= 1.1 && (index === 0 || (kind === 'main' && index % 3 === 0));
