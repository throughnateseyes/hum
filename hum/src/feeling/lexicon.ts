/**
 * A rough reading of a lyric line without Claude: a few hundred plain words, what they lean towards, and a
 * "not" in front turning them round. It misses irony and story; it is only better than nothing.
 */
import type { Emotion } from './list';

const WORDS: Record<Emotion, string> = {
  sad: 'cry crying cried tears tear sorrow sad sadness broken break breaking hurt hurts hurting pain grief mourn lost loss gone goodbye funeral grave ashes bleed bleeding heartbreak heartbroken weep ruin ruined sorry regret blue',
  longing: 'miss missing missed wish wishing remember remembered memory memories return waiting wait distance far away without alone lonely lonesome empty ghost home again someday',
  tender: 'hold holding gentle soft softly whisper hush cradle close closer safe warm sleep baby darling dear lullaby mother child',
  hopeful: 'hope rise rising dawn morning tomorrow believe faith free freedom heal light shine begin new bright open fly sky someday better',
  joyful: 'happy joy dance dancing laugh laughing smile smiling sing celebrate party summer sunshine golden alive good wonderful beautiful',
  desire: 'love loving lover kiss kissing touch skin lips want wanting need body heart desire burn fire crazy fever heaven',
  defiant: 'never fight fighting stand strong king queen crown war win won run running break free rebel louder power unstoppable mine',
  angry: 'hate rage kill liar lies lying betrayed enemy damn hell bitter blame burn scream screaming fight violent blood',
  afraid: 'afraid fear scared dark darkness shadow shadows nightmare monster drown drowning falling fall lost danger trapped hide hiding shaking',
  numb: 'nothing numb cold grey gray hollow empty tired sleepwalk fade fading faded pills drunk floating blank void',
  playful: 'fun play playing game crazy wild silly toy candy bounce pop shake wiggle money cash flex drip',
  calm: 'calm peace quiet still river ocean sea breeze slow breathe breathing drift garden moon stars',
};
const TONE: Record<Emotion, number> = { sad: -0.75, longing: -0.45, tender: 0.3, hopeful: 0.55, joyful: 0.85, desire: 0.35, defiant: 0.1, angry: -0.5, afraid: -0.65, numb: -0.5, playful: 0.6, calm: 0.25 };

const byWord = new Map<string, Emotion[]>();
for (const [e, list] of Object.entries(WORDS) as [Emotion, string][]) for (const w of list.split(' ')) byWord.set(w, [...(byWord.get(w) ?? []), e]);

const NOT = new Set(['not', "don't", 'dont', "can't", 'cant', 'no', "won't", 'wont', "ain't", 'aint', 'without', "isn't", "wasn't", "couldn't"]);

/** null: nothing in the line says anything */
export function readLine(text: string): { emotion: Emotion; tone: number; weight: number; word: number } | null {
  const words = text.toLowerCase().replace(/[’]/g, "'").split(/\s+/).map((w) => w.replace(/[^\p{L}']/gu, ''));
  const votes = new Map<Emotion, number>();
  let tone = 0;
  let hits = 0;
  let word = -1;
  words.forEach((w, i) => {
    const es = byWord.get(w) ?? byWord.get(w.replace(/'s$|s$|in'?$/, ''));
    if (!es) return;
    const turned = NOT.has(words[i - 1]) || NOT.has(words[i - 2]);
    for (const e of es) {
      votes.set(e, (votes.get(e) ?? 0) + 1 / es.length);
      tone += ((turned ? -0.6 : 1) * TONE[e]) / es.length;
    }
    hits++;
    word = i;
  });
  if (!hits) return null;
  const emotion = [...votes].sort((x, y) => y[1] - x[1])[0][0];
  return { emotion, tone: Math.max(-1, Math.min(1, tone / hits)), weight: Math.min(0.6, 0.3 + 0.12 * hits), word };
}
