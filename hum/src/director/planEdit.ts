/**
 * Change the playing video plan in plain words ("make the chorus calmer", "fewer pop-ups", "big words
 * on the chorus") without making a new one.
 *
 * Only the current plan goes up, one short line per section, and only the sections that change come
 * back. It runs on the small model (server/models.ts), so an edit costs a fraction of what a new plan
 * costs and answers in a few seconds. The change is checked against the looks that exist, drops still
 * get their cut, and the saved plan for the song is updated (planCache.ts).
 */
import { lookStyle } from '../core/styles';
import { familyIdOf, familyOf } from '../presets/fit';
import { cleanPlanTransition } from '../core/transitionList';
import type { TrackAnalysis } from '../core/types';
import { allLooks, ensureDropCuts, findLook, sectionDrops, type VideoPlan } from '../state/plan';
import { LYRIC_MEDIUMS, type LyricMedium } from '../state/lyricPlan';
import { useStudio } from '../state/store';
import { getScene } from '../scenes';
import { postDirector } from './access';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface PlanEditResult {
  ok: boolean;
  note: string;
  via?: 'api' | 'subscription';
  /** how many sections changed */
  changed?: number;
}

/** apply the server's checked changes to a plan */
export function applyPlanEdit(plan: VideoPlan, a: TrackAnalysis, changes: unknown[]): { plan: VideoPlan; changed: number } {
  const n = a.sections.length;
  const looks = [...plan.looks];
  const why = a.sections.map((_, i) => plan.why[i] ?? '');
  const rotate = a.sections.map((_, i) => plan.rotate?.[i] ?? null);
  const pops = a.sections.map((_, i) => plan.pops?.[i] ?? 1);
  const shotBars = a.sections.map((_, i) => plan.shotBars?.[i] ?? null);
  const transitions = a.sections.map((_, i) => plan.transitions?.[i] ?? null);
  const parts = plan.lyricPlan ? [...plan.lyricPlan.parts] : null;
  const touched = new Set<number>();
  // parts that sound the same keep the same look, like picking a look by hand does: a new look for one
  // chorus goes to every chorus that had the same look, unless the edit says something else for it
  const own = new Set(changes.filter(isObj).map((c) => c.index));
  const spread: Record<string, unknown>[] = [];
  for (const c of changes) {
    if (!isObj(c) || typeof c.index !== 'number' || typeof c.lookId !== 'string' || !a.sections[c.index]) continue;
    const i = c.index;
    a.sections.forEach((sec, j) => {
      if (j !== i && !own.has(j) && sec.group === a.sections[i].group && plan.looks[j] === plan.looks[i]) {
        own.add(j);
        spread.push({ ...c, index: j });
      }
    });
  }
  for (const c of [...changes, ...spread]) {
    if (!isObj(c) || typeof c.index !== 'number' || c.index < 0 || c.index >= n) continue;
    const i = c.index;
    if (typeof c.lookId === 'string' && findLook(c.lookId) && c.lookId !== looks[i]) {
      looks[i] = c.lookId;
      rotate[i] = null; // picked around the new look unless the edit gave one
      why[i] = 'changed on request';
      touched.add(i);
    }
    if (Array.isArray(c.rotate)) {
      const r = c.rotate.filter((id): id is string => typeof id === 'string' && !!findLook(id) && id !== looks[i]).slice(0, 3);
      rotate[i] = r.length ? r : null;
      touched.add(i);
    }
    if (typeof c.pops === 'number') {
      pops[i] = Math.max(0, Math.min(3, Math.round(c.pops)));
      touched.add(i);
    }
    if (typeof c.pace === 'number' && [1, 2, 4, 8].includes(c.pace)) {
      shotBars[i] = c.pace;
      touched.add(i);
    }
    if (typeof c.transition === 'string') {
      const t = cleanPlanTransition({ ...(transitions[i] ?? {}), into: c.transition });
      if (t) {
        transitions[i] = t;
        touched.add(i);
      }
    }
    if (parts && typeof c.lyric === 'string' && LYRIC_MEDIUMS.includes(c.lyric as LyricMedium) && parts[i]) {
      parts[i] = { medium: c.lyric as LyricMedium, moment: parts[i]?.moment ?? null, why: 'changed on request' };
      touched.add(i);
    }
  }
  const next: VideoPlan = {
    ...plan,
    looks,
    why,
    rotate,
    pops,
    shotBars,
    transitions,
    ...(plan.lyricPlan && parts ? { lyricPlan: { ...plan.lyricPlan, parts } } : {}),
  };
  return { plan: ensureDropCuts(next, a), changed: touched.size };
}

/** ask for the change and put it on; never throws for server trouble */
export async function editVideo(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<PlanEditResult> {
  const s = useStudio.getState();
  const a = s.analysis;
  const plan = s.plan;
  if (!a || !plan || plan.looks.length !== a.sections.length) return { ok: false, note: 'Make a video first, then ask for changes to it.' };
  // every look, in the app's order: the list is the same for every edit, so it's read back from the
  // prompt cache after the first one
  const looks = allLooks()
    .filter((p) => getScene(p.sceneId))
    .map((p) => ({ id: p.id, tags: p.tags.slice(0, 4), style: lookStyle(p), family: familyIdOf(p), roles: familyOf(p).fit.roles.slice(0, 3) }));
  const drops = sectionDrops(a);
  let res: Response;
  try {
    res = await postDirector(
      (accessCode) => ({
        mode: 'planEdit',
        prompt: prompt.slice(0, 600),
        track: { summary: a.summary, bpm: a.bpm, mood: a.mood, tags: a.tags },
        sections: a.sections.map((x, i) => ({ label: x.label, group: x.group, energy: x.energy, ...(drops[i] ? { drop: { strength: drops[i]!.strength } } : {}) })),
        looks,
        plan: {
          looks: plan.looks,
          rotate: plan.rotate ?? [],
          // what actually plays: the person's own per-part levels (setPartPops) over the plan's
          pops: a.sections.map((_, i) => s.partPops?.[i] ?? plan.pops?.[i] ?? 1),
          pace: plan.shotBars ?? [],
          lyric: plan.lyricPlan ? plan.lyricPlan.parts.map((p) => p?.medium ?? null) : [],
        },
        accessCode,
      }),
      opts,
    );
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return { ok: false, note: 'Couldn’t reach the AI director (offline?).' };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const serverNote = isObj(json) && typeof (json.note ?? json.error) === 'string' ? String(json.note ?? json.error).slice(0, 200) : '';
  if (!res.ok) {
    if (res.status === 501) return { ok: false, note: 'AI is switched off on this site, so the plan can’t be edited in words. Pick a look while a part plays to change it by hand.' };
    if (res.status === 403) return { ok: false, note: 'The AI director needs an access code.' };
    return { ok: false, note: serverNote || `AI director error (${res.status}).` };
  }
  if (!isObj(json) || !isObj(json.edit) || !Array.isArray(json.edit.changes)) return { ok: false, note: 'The AI director sent an unreadable edit.' };
  const via = json.via === 'subscription' ? ('subscription' as const) : ('api' as const);
  // the song or the plan may have changed while Claude was thinking
  const now = useStudio.getState();
  if (now.analysis !== a || now.plan !== plan) return { ok: false, note: 'The plan changed while Claude was thinking, so this edit was dropped.' };
  const { plan: next, changed } = applyPlanEdit(plan, a, json.edit.changes);
  if (!changed) return { ok: true, note: serverNote || 'Nothing needed to change.', via, changed: 0 };
  // a part whose pop-ups the edit changed is the plan's again (the newest wish wins over an older hand setting)
  const own = now.partPops?.length === a.sections.length ? [...now.partPops] : null;
  if (own) for (let i = 0; i < own.length; i++) if ((next.pops?.[i] ?? null) !== (plan.pops?.[i] ?? null)) own[i] = null;
  now.set({ plan: next, planOn: true, ...(own ? { partPops: own.some((v) => v !== null) ? own : null } : {}) });
  return { ok: true, note: serverNote || 'Changed the plan.', via, changed };
}
