/**
 * Redo: see server/steps/types.ts
 *
 *   redo     a few parts of a video that plays, and what is round them -> another choice for each
 *
 * One small call. It works in the words the shots step does (footage.ts), so an answer reads the same.
 */
import { cleanShots, DATA_RULE, isObj, line, list, MOMENT_LINES, readCut, SHOT_PROPS, SHOT_RULES } from './footage.js';
import type { Step } from './types';

type Obj = Record<string, unknown>;

/** parts chosen again in one call, looks offered for each, earlier tries told */
const MOST_PARTS = 8;
const MOST_LOOKS = 12;
const MOST_TRIED = 4;

const LYRICS = ['subtitle', 'sparse', 'big', 'knockout'];
const lookId = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9][\w:.-]{0,79}$/.test(v) ? v : '');

const REDO_SYSTEM = `You are the editor of a music video that is already made. The person wants a few parts of it chosen again. The parts listed as footage are those; every other part stays exactly as it is and is there so you can cut between its neighbours. You work from an assistant's notes on the pictures.

For each part listed as footage give one entry, with a choice that is clearly different from what it shows now (and from anything listed as tried): another picture, or the same one seen another way (another second, another size, another style). A small nudge is not another choice.

When the person says what they want, that decides. It is a wish about these parts of the video only ("closer" is more zoom or a closer picture, "calmer" is a quieter picture, moment and style, a clip named by what is in it is that clip).

Without a wish, choose what the idea and the song ask for there and the present choice gives less of. Do not repeat the picture of a neighbour on either side. Parts marked set by the person stay as they are. The ones said to be kept are there on purpose: cut around them, and never show their picture right beside them.

Some parts show a graphic look instead of the person's media, and say which. For those answer with look, one id from the looks offered for that part, and leave media out, unless the wish asks for their footage there: then answer with a shot, as for the others.

${SHOT_RULES}
- lyric: how the words appear in a part that has them: subtitle (a quiet caption), sparse (small and quiet), big (a display line), knockout (one word at a time, huge, few words only). Usually left out.

Moments:
${MOMENT_LINES}

Write why plainly, sentence case, no exclamation marks. ${DATA_RULE}`;

// (no hard limits in the form: an answer that breaks one is written again whole, and finish checks it anyway)
const REDO_TOOL = {
  name: 'choose_again',
  description: 'One entry for every part listed as footage.',
  input_schema: {
    type: 'object',
    properties: {
      shots: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ...SHOT_PROPS, look: { type: 'string', description: 'Only for a part that shows a graphic look: one of the looks offered for it.' } },
          required: ['i', 'why'],
        },
      },
    },
    required: ['shots'],
  },
};

/** the looks offered for the graphic parts among them, by part */
function readLooks(raw: unknown, open: Map<number, number>): { ids: Map<number, string[]>; lines: string[] } {
  const ids = new Map<number, string[]>();
  const lines: string[] = [];
  for (const x of list(raw, MOST_PARTS)) {
    if (!isObj(x) || typeof x.i !== 'number' || !open.has(x.i) || ids.has(x.i)) continue;
    const looks = list(x.looks, MOST_LOOKS).filter(isObj).filter((l) => lookId(l.id));
    if (!looks.length) continue;
    ids.set(x.i, looks.map((l) => lookId(l.id)));
    lines.push(`part ${x.i} shows ${line(x.now, 60) || 'a graphic look'}. Looks offered: ${looks.map((l) => `${lookId(l.id)} (${[line(l.name, 40), ...list(l.tags, 4).map((t) => line(t, 16))].filter(Boolean).join(', ')})`).join('; ')}`);
  }
  return { ids, lines };
}

const redo: Step = {
  maxImages: 0,
  prepare(body) {
    const cut = readCut(body);
    if (!cut.parts.open.size) return 'There is no part to choose again.';
    if (cut.parts.open.size > MOST_PARTS) return `At most ${MOST_PARTS} parts are chosen again at a time.`;
    const looks = readLooks(body.looks, cut.parts.open);
    if (!cut.media.lines.length && !looks.ids.size) return 'There is nothing to choose from.';
    const kept = list(body.kept, 60).filter((k): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 0 && k <= 400 && !cut.parts.open.has(k));
    const tried = list(body.tried, MOST_PARTS * MOST_TRIED)
      .filter(isObj)
      .filter((x) => typeof x.i === 'number' && cut.parts.open.has(x.i) && !!line(x.was, 120))
      .map((x) => `part ${String(x.i)}: ${line(x.was, 120)}`);
    return {
      tier: 'small',
      effort: 'low',
      system: REDO_SYSTEM,
      prompt: [
        cut.text,
        looks.lines.length ? `Parts with a graphic look:\n${looks.lines.join('\n')}` : '',
        kept.length ? `Kept by the person on purpose: ${kept.map((k) => `part ${k}`).join(', ')}.` : '',
        tried.length ? `Tried already, and not what they wanted:\n${tried.join('\n')}` : '',
        `Choose again: ${[...cut.parts.open.keys()].map((k) => `part ${k}`).join(', ')}.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      tool: REDO_TOOL,
      // room for a little thinking besides the answer
      maxTokens: 2500 + cut.parts.open.size * 160,
      finish(output) {
        if (!isObj(output)) return null;
        const raw = list(output.shots, 40).filter(isObj);
        // (a style or treatment left out is the plain one)
        const got: Obj[] = cleanShots(raw.map((x) => ({ treatment: 'none', ...x })), cut.allowed);
        for (const x of raw) {
          const i = x.i as number;
          const id = lookId(x.look);
          if (got.some((s) => s.i === i) || !looks.ids.get(i)?.includes(id)) continue;
          const why = line(x.why, 110);
          got.push({ i, look: id, ...(why ? { why } : {}), ...(cut.parts.words.has(i) && LYRICS.includes(x.lyric as string) ? { lyric: x.lyric } : {}) });
        }
        return got.length ? { shots: got } : null;
      },
    };
  },
};

export const REDO_STEPS: Record<string, Step> = { redo };
