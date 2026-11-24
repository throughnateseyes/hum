/**
 * Art direction steps: see server/steps/types.ts. Both need 'draw'.
 *
 *   art        the story and the cut → one brief for the whole video, the few drawings it needs, and the
 *              shots each stands in
 *   artReview  stills of those shots, with the drawings in them → what to move, take out or draw again
 *
 * Claude only chooses. The drawing itself is the draw step's (draw.ts); where exactly one stands is worked
 * out against the picture's depth by the app (src/inside/drawn.ts).
 */
import { HAND_IDS, isHandId } from '../../src/draw/format.js';
import { DRAWN_ENTERS, DRAWN_PUTS, DRAWN_SIZES, PUT_LINES } from '../../src/inside/drawnIds.js';
import { DATA_RULE, describeSong, readMedia, readParts, wishLine } from './footage.js';
import type { Step, StepTool } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, ids: readonly T[], d: T): T => (ids.includes(v as T) ? (v as T) : d);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : -1);

/** drawings new and old in one video, and how many of them may be new */
export const MOST_DRAWINGS = 5;
const MOST_NEW = 4;
const MOST_THINGS = 3;

const PUTS = DRAWN_PUTS.map((p) => `  - ${p}: ${PUT_LINES[p]}`).join('\n');

/* ───────────────────────── art ───────────────────────── */

const ART_SYSTEM = `You are the art director of a music video made from a person's own clips. The story is set and the cut is made. Some shots are "inside": the clip becomes a place, words stand in it behind people and buildings, and parts of it turn to flat colour on the beat. You decide what is drawn by hand into that place. A drawing is cut out of paper in the video's own few colours and really stands in the picture: people pass in front of it, it keeps its place as the camera moves, it arrives on the cut and moves only on the beat.

Work like an art director with one idea and a small budget. A viewer should feel someone thought about this from the first frame to the last, and no two videos should get the same answer.

1. thread: the one idea the drawings carry, one sentence of at most 24 words, concrete, about THIS song and THESE pictures. It must add something the footage does not already show. rules: two or three short rules everything drawn obeys ("always at the edge of the crowd", "only things that hold light"). They must be specific enough to rule things out.

2. hand: ${HAND_IDS.join(', ')}. pen: fine and precise, tender, witty. brush: bold ink, dramatic, few strokes. marker: thick even line, playful, loud. pencil: soft, intimate. colour: true for flat patches of the video's colours under the line (usually, so it belongs to the painted place). manner: one sentence on how this hand draws. One hand for the whole video.

3. things: one to ${MOST_THINGS} recurring images, no more. One is usually the thread itself. Each has a start, and where the song changes it an end: the same object, seen the same way, changed by what happened (a closed door, then open with light in it; a full cup, then tipped over). At least one thing must change by the last big moment, unless the song truly never moves.
  - Start from what is concrete in the words and the pictures: something named, held, worn, left behind, or missing from the pictures though the song is about it. A specific thing beats a symbol. Never the stock set (hearts, roses, clocks, masks, headphones, records, microphones, notes, crowns, skulls, butterflies, eyes, wings) unless the song names it.
  - It must belong where it will stand: something that could be on that street, in that room or on that horizon, at a strange size or in a strange state. The interest comes from the size, the place and the moment, not from decoration.
  - If a drawing the person already has (listed as D1, D2…) is exactly what the thread needs, use it: give its key as reuse and no brief. Judge hard. One that only roughly fits is worse than none, and you need not use any.
  - A new drawing needs name (two or three plain words), brief and wide (tall, wide or square). brief, two or three sentences for the illustrator: the thing, the viewpoint, the pose, the three features that make it recognisable and the one detail that makes it this song's. It stands alone in a picture, so: one solid object with a closed outline, sitting flat on its own base, seen from the side or three-quarter at eye level; large plain areas that can take flat colour; nothing separate floating round it (no rain, sparks, motion lines, scattered dots or ground). No people, faces, lettering or numbers. An end's brief says it is the same object as the start, and exactly what differs.
  - At most ${MOST_NEW} new drawings in all, and ${MOST_DRAWINGS} with the reused ones. Fewer, better placed, is better.

4. places: where each stands. Use only the parts offered. For each: part, thing (its number), stage (start or end), put, size, enter and why.
  - Every drawing you ask for must have a place, and each must be seen at least twice if the song allows: people only notice what comes back. About one offered part in three at the most. The rest of the shots are left alone, so that the drawn ones mean something.
  - Place by meaning. The line that names it, the first sight, the moment before the drop, the drop itself, the return of a chorus. why says what it does there in at most 10 plain words, for the musician to read. If you cannot say why it is in that shot, do not place it.
  - Give a thing a shape over the song: small or far off when it first appears, closer or bigger as the song builds, changed where the song changes, and one last sight near the end. Stage end never comes before start.
  - put:
${PUTS}
    Choose by what the picture is of: ground needs a visible floor, road or field and some empty space; between needs people or things near the camera to stand behind; far needs a skyline, hills or sky; wall needs a street or corridor seen along its length. Close-ups of faces and pictures without depth take none.
  - size: small, medium or large. enter: draw (it draws itself over the first beat or two: for a first sight, or a quiet moment), rise (it springs up on the cut: for a hit or a loud part), there (already standing: for a return).
  - A part with many words has little room, so prefer parts with few or no words, or a small size. Never two different things in one part, and not in neighbouring parts unless it is the same thing carrying on.

Write plainly, sentence case, no exclamation marks, no dashes used as punctuation. ${DATA_RULE}`;

const DRAWING_PROPS = {
  type: 'object',
  properties: {
    reuse: { type: 'string', description: 'A D key, instead of a new drawing.' },
    name: { type: 'string' },
    brief: { type: 'string' },
    wide: { type: 'string', enum: ['tall', 'wide', 'square'] },
  },
};

const ART_TOOL: StepTool = {
  name: 'direct_art',
  description: 'The thread, the rules, the hand, the recurring things and where each stands.',
  input_schema: {
    type: 'object',
    properties: {
      thread: { type: 'string' },
      rules: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      hand: { type: 'string', enum: [...HAND_IDS] },
      colour: { type: 'boolean' },
      manner: { type: 'string' },
      things: {
        type: 'array',
        maxItems: MOST_THINGS,
        items: {
          type: 'object',
          properties: { why: { type: 'string', description: 'What it stands for, at most 16 words.' }, start: DRAWING_PROPS, end: DRAWING_PROPS },
          required: ['why', 'start'],
        },
      },
      places: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            part: { type: 'integer' },
            thing: { type: 'integer', description: 'Its position in things, from 0.' },
            stage: { type: 'string', enum: ['start', 'end'] },
            put: { type: 'string', enum: [...DRAWN_PUTS] },
            size: { type: 'string', enum: [...DRAWN_SIZES] },
            enter: { type: 'string', enum: [...DRAWN_ENTERS] },
            why: { type: 'string' },
          },
          required: ['part', 'thing', 'stage', 'put', 'size', 'enter', 'why'],
        },
      },
    },
    required: ['thread', 'rules', 'hand', 'colour', 'manner', 'things', 'places'],
  },
};

const art: Step = {
  needs: 'draw',
  maxImages: 0,
  prepare(body) {
    const media = readMedia(body.media);
    const parts = readParts(body.parts);
    const offered = new Set(list(body.offer, 120).map(int).filter((i) => parts.open.has(i)));
    if (!offered.size) return 'There is no shot to draw into.';
    const have = new Map<string, string>();
    for (const x of list(body.have, 14)) {
      if (!isObj(x)) continue;
      const k = text(x.key, 4);
      const name = text(x.name, 40);
      if (/^D\d{1,2}$/.test(k) && name && !have.has(k)) have.set(k, `${k}: ${name}${text(x.why, 160) ? `. ${text(x.why, 160)}` : ''}${text(x.wide, 8) ? ` (${text(x.wide, 8)})` : ''}`);
    }
    const st = isObj(body.story) ? body.story : {};
    const idea = text(st.idea, 220);
    const sections = list(st.sections, 40).map((x, i) => (isObj(x) && text(x.moment, 12) ? `section ${i}: ${text(x.moment, 12)}${text(x.note, 140) ? `. ${text(x.note, 140)}` : ''}` : '')).filter(Boolean);
    const lines = list(body.lyrics, 110).map((l) => text(l, 110)).filter(Boolean);
    const last = list(body.last, 6).map((x) => text(x, 60)).filter(Boolean);
    return {
      tier: 'main',
      effort: 'medium',
      system: ART_SYSTEM,
      prompt: [
        wishLine(body),
        `The song${text(body.title, 100) ? `: ${text(body.title, 100)}` : ''}\n${describeSong(body)}${text(body.about, 200) ? `\nWhat it is about: ${text(body.about, 200)}` : ''}`,
        idea ? `The story of the video: ${idea}${text(st.arc, 320) ? `\nArc: ${text(st.arc, 320)}` : ''}` : '',
        sections.join('\n'),
        lines.length ? `Its words, each line once:\n${lines.join('\n')}` : 'It has no words.',
        text(body.paint, 160) ? `The colours everything is painted in: ${text(body.paint, 160)}` : '',
        `The person's media:\n${media.lines.join('\n')}`,
        `Parts:\n${parts.lines.join('\n')}`,
        `Parts offered for drawings: ${[...offered].join(', ')}`,
        have.size ? `Drawings the person already has for this song:\n${[...have.values()].join('\n')}` : 'The person has no drawings for this song yet.',
        last.length ? `The last video of this song drew: ${last.join(', ')}. Come at it from somewhere else this time.` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      tool: ART_TOOL,
      maxTokens: 9000,
      finish(out) {
        if (!isObj(out)) return null;
        let fresh = 0;
        let all = 0;
        const drawing = (x: unknown): Obj | null => {
          if (!isObj(x) || all >= MOST_DRAWINGS) return null;
          const reuse = text(x.reuse, 4);
          if (have.has(reuse)) {
            all++;
            return { reuse };
          }
          const name = text(x.name, 40);
          const brief = text(x.brief, 700);
          if (!name || !brief || fresh >= MOST_NEW) return null;
          fresh++;
          all++;
          return { name, brief, wide: x.wide === 'tall' || x.wide === 'wide' ? x.wide : 'square' };
        };
        // every start before any end, so a budget that runs out costs an ending and not a thing
        const raw = list(out.things, MOST_THINGS);
        const starts = raw.map((x) => (isObj(x) ? drawing(x.start) : null));
        const things = raw.map((x, i) => {
          const end = starts[i] && isObj(x) && isObj(x.end) ? drawing(x.end) : null;
          return starts[i] ? { why: text((x as Obj).why, 160), start: starts[i], ...(end ? { end } : {}) } : null;
        });
        const most = Math.max(2, Math.min(12, Math.ceil(offered.size * 0.4)));
        const seen = new Set<number>();
        const places: Obj[] = [];
        for (const x of list(out.places, 40)) {
          if (!isObj(x) || places.length >= most) continue;
          const part = int(x.part);
          const thing = int(x.thing);
          if (!offered.has(part) || seen.has(part) || !things[thing]) continue;
          seen.add(part);
          places.push({
            part,
            thing,
            stage: x.stage === 'end' && things[thing].end ? 'end' : 'start',
            put: oneOf(x.put, DRAWN_PUTS, 'between'),
            size: oneOf(x.size, DRAWN_SIZES, 'medium'),
            enter: oneOf(x.enter, DRAWN_ENTERS, 'draw'),
            why: text(x.why, 110),
          });
        }
        if (!places.length) return null;
        return {
          thread: text(out.thread, 220),
          rules: list(out.rules, 3).map((r) => text(r, 120)).filter(Boolean),
          style: { hand: isHandId(out.hand) ? out.hand : 'pen', colour: out.colour !== false, manner: text(out.manner, 300) },
          things,
          places,
        };
      },
    };
  },
};

/* ───────────────────────── artReview ───────────────────────── */

const REVIEW_SYSTEM = `You check the drawings in a music video. The sheets show one still from each shot that has a drawing standing in it, labelled with the part's number. Each drawing is a paper cut-out meant to be part of the place: it stands on something, people and things pass in front of it, and it shares the video's few flat colours. Large words, flat colour, ribbons and bars in the stills are the video's own and are not yours to judge.

For each still ask three things. Does it look as if it stands IN the picture, or stuck ON it? Can a viewer tell in one second what it is? Does it sit well in the frame (not on a face, not on the words, not a speck, not swallowing the shot)?

Answer only for the parts where something is wrong:
- move: another place or size would fix it. Give put and size.
- remove: no place in this shot will hold it, or it fights what the shot is about. A cut with fewer, better drawings is the better cut, so do not be shy with this.
- redraw: the drawing itself reads as something else, or is a tangle, wherever it stands. Give note, one sentence to the illustrator. At most two in the whole video.
problem: what is wrong, at most 10 plain words. A still with no drawing to be seen in it found no room: leave it out unless another put from the list clearly has room there, then move.

put is one of:
${PUTS}

If it is good, leave it out. An empty list is a fine answer. ${DATA_RULE}`;

const REVIEW_TOOL: StepTool = {
  name: 'check_drawings',
  description: 'The parts whose drawing should change. An empty list when all is well.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            part: { type: 'integer' },
            problem: { type: 'string' },
            do: { type: 'string', enum: ['move', 'remove', 'redraw'] },
            put: { type: 'string', enum: [...DRAWN_PUTS] },
            size: { type: 'string', enum: [...DRAWN_SIZES] },
            note: { type: 'string' },
          },
          required: ['part', 'problem', 'do'],
        },
      },
    },
    required: ['changes'],
  },
};

const artReview: Step = {
  needs: 'draw',
  maxImages: 2,
  prepare(body, images) {
    if (!images) return 'There is nothing to check.';
    const placed = new Map<number, Obj>();
    const lines: string[] = [];
    for (const x of list(body.places, 12)) {
      if (!isObj(x) || int(x.part) < 0 || placed.has(int(x.part)) || !text(x.name, 40)) continue;
      placed.set(int(x.part), x);
      lines.push(`part ${int(x.part)}: ${text(x.name, 40)}, ${oneOf(x.put, DRAWN_PUTS, 'between')}, ${oneOf(x.size, DRAWN_SIZES, 'medium')}${text(x.why, 110) ? `. ${text(x.why, 110)}` : ''}`);
    }
    if (!placed.size) return 'There is nothing to check.';
    return {
      tier: 'main',
      effort: 'low',
      system: REVIEW_SYSTEM,
      prompt: [text(body.thread, 220) ? `What the drawings are about: ${text(body.thread, 220)}` : '', `The drawings:\n${lines.join('\n')}`].filter(Boolean).join('\n\n'),
      tool: REVIEW_TOOL,
      maxTokens: 2500,
      finish(out) {
        if (!isObj(out) || !Array.isArray(out.changes)) return null;
        const seen = new Set<number>();
        let again = 0;
        const changes: Obj[] = [];
        for (const x of list(out.changes, 24)) {
          if (!isObj(x)) continue;
          const part = int(x.part);
          const was = placed.get(part);
          if (!was || seen.has(part)) continue;
          const what = oneOf(x.do, ['move', 'remove', 'redraw'] as const, 'move');
          if (what === 'redraw' && (!text(x.note, 200) || ++again > 2)) continue;
          const put = oneOf(x.put, DRAWN_PUTS, oneOf(was.put, DRAWN_PUTS, 'between'));
          const size = oneOf(x.size, DRAWN_SIZES, oneOf(was.size, DRAWN_SIZES, 'medium'));
          if (what === 'move' && put === was.put && size === was.size) continue;
          seen.add(part);
          changes.push({ part, do: what, problem: text(x.problem, 110), ...(what === 'move' ? { put, size } : {}), ...(what === 'redraw' ? { note: text(x.note, 200) } : {}) });
        }
        return { changes };
      },
    };
  },
};

export const ART_STEPS: Record<string, Step> = { art, artReview };
