/**
 * Is a Look request a small change to the look on screen ("warmer", "less busy", "hit harder on the
 * kick") rather than a new look from a feeling ("rain on a window at 3am")?
 *
 * Small changes go to the small, cheap model with a shorter catalog (see server/models.ts). When in
 * doubt it says no, so a real creative request never lands on the small model.
 */

const TWEAK_WORDS =
  /\b(more|less|fewer|too|warmer|cooler|colder|hotter|brighter|darker|lighter|dimmer|slower|faster|calmer|busier|softer|harder|louder|quieter|bigger|smaller|thicker|thinner|sharper|smoother|stronger|weaker|subtler|punchier|simpler|cleaner|grainier|tone (it )?down|turn (it )?(up|down)|crank|dial (it )?(up|down|back)|swap the (colou?rs?|palette)|change the (colou?rs?|palette)|(add|remove|drop|no) (some |the |a )?(grain|glow|blur|bloom|trails?|glitch|effects?|vignette|noise))\b/i;
const NEW_WORDS = /\b(new|different|something else|from scratch|instead|like a|like the|feels? like|reminds?)\b/i;

export function isTweak(prompt: string, hasCurrent: boolean): boolean {
  if (!hasCurrent) return false;
  const p = prompt.trim();
  const words = p.split(/\s+/).length;
  if (!p || words > 10) return false;
  if (NEW_WORDS.test(p)) return false;
  return TWEAK_WORDS.test(p) || /^(make it|a bit|bit|slightly|way)\b/i.test(p);
}
