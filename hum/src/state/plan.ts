/**
 * Song map + video plan.
 *
 * The analysis splits a song into sections (intro, verse, chorus, build, drop…) and groups the ones
 * that sound alike. A plan gives each section a look; while "Follow song map" is on, the stage
 * switches looks at section boundaries — dissolving into calm sections, cutting hard on drops and
 * choruses. Picking a look while the plan plays puts it into the current section (and into the
 * sections that sound the same), so editing is just: play to a part, pick a look.
 */
import { audioEngine } from '../audio/engine';
import { textBetween } from '../audio/lyrics';
import type { AudioFrame, Preset, TrackAnalysis, TrackSection } from '../core/types';
import { PRESETS } from '../presets';
import { live } from './live';
import { useStudio } from './store';

export interface VideoPlan {
  title: string;
  note: string;
  /** preset id per section index */
  looks: (string | null)[];
  /** one short reason per section (Claude plans only) */
  why: string[];
  source: 'claude' | 'local';
  via?: 'api' | 'subscription';
  /** analysis this plan belongs to (sections must match) */
  duration: number;
  /** pop-up windows per section: 0 none … 3 lots (missing → picked from the section's label) */
  pops?: number[];
  /** a board look shown for the first few bars of a section, before its own look (null = none) */
  interludes?: (string | null)[];
}

export const LABEL_NAME: Record<TrackSection['label'], string> = {
  intro: 'Intro',
  verse: 'Verse',
  chorus: 'Chorus',
  bridge: 'Bridge',
  build: 'Build',
  drop: 'Drop',
  break: 'Break',
  outro: 'Outro',
};

/** "Verse 2", "Chorus 1"… numbered only when a label appears more than once */
export function sectionNames(sections: TrackSection[]): string[] {
  const total: Record<string, number> = {};
  for (const s of sections) total[s.label] = (total[s.label] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return sections.map((s) => {
    seen[s.label] = (seen[s.label] ?? 0) + 1;
    return total[s.label] > 1 ? `${LABEL_NAME[s.label]} ${seen[s.label]}` : LABEL_NAME[s.label];
  });
}

export function allLooks(): Preset[] {
  return [...useStudio.getState().customPresets, ...PRESETS];
}
export function findLook(id: string | null | undefined): Preset | undefined {
  return id ? allLooks().find((p) => p.id === id) : undefined;
}

export function sectionIndexAt(sections: TrackSection[], t: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].start) return i;
  return 0;
}

const validPlan = (plan: VideoPlan | null, a: TrackAnalysis | null): plan is VideoPlan =>
  !!plan && !!a && plan.looks.length === a.sections.length && Math.abs(plan.duration - a.duration) < 0.5;

/* ───────────────────────── sequencer (runs every frame) ───────────────────────── */

/** dissolves start a little early so they finish on the downbeat */
const LEAD_S = 0.45;
/** hard cuts fire a frame early so the new look is on screen when the hit lands */
const CUT_EARLY_S = 0.02;
const hardCut = (s: TrackSection) => s.label === 'drop' || s.label === 'chorus';

export function planTick(a: AudioFrame) {
  const s = useStudio.getState();
  if (!s.planOn || audioEngine.kind !== 'file' || !validPlan(s.plan, s.analysis)) return;
  const secs = s.analysis!.sections;
  let i = sectionIndexAt(secs, a.time + (a.playing ? CUT_EARLY_S : 0));
  const next = secs[i + 1];
  let cut = false;
  if (next && a.playing && !hardCut(next) && !s.plan!.interludes?.[i + 1] && next.start - a.time < LEAD_S) i += 1;
  else cut = a.playing && hardCut(secs[i]) && a.time - secs[i].start < 0.25;
  // a board interlude takes the first bars of its section, then cuts hard to the section's own look
  let lookId = s.plan!.looks[i];
  const inter = findLook(s.plan!.interludes?.[i]);
  const bpm = a.bpm > 30 ? a.bpm : s.analysis!.bpm;
  if (inter) {
    const into = a.time - secs[i].start;
    const len = interludeLength(secs[i], bpm);
    if (into < len) {
      lookId = inter.id;
      cut = a.playing && into < 0.25;
      if (a.playing && len - into < 2.5) {
        const main = findLook(s.plan!.looks[i]);
        if (main && main.sceneId !== s.sceneId) live.stage?.prewarm(main.sceneId);
      }
    } else if (a.playing && into < len + 0.3) cut = true;
  }
  // get the next part's scene ready a moment before it starts
  const upcoming = secs[i + 1];
  if (upcoming && a.playing && upcoming.start - a.time < 2.5) {
    const nextLook = findLook(s.plan!.interludes?.[i + 1]) ?? findLook(s.plan!.looks[i + 1]);
    if (nextLook && nextLook.sceneId !== s.sceneId) live.stage?.prewarm(nextLook.sceneId);
  }
  const look = findLook(lookId);
  if (!look || look.id === s.presetId) return;
  if (live.stage) live.stage.nextFadeMs = cut ? 1 : a.playing ? 700 : 250;
  s.applyPreset(look);
}

/** how long a board interlude plays at the top of a section: 4 bars, at most ~45% of the section */
export function interludeLength(sec: TrackSection, bpm: number): number {
  const bars4 = (16 * 60) / Math.max(40, bpm || 120);
  return Math.max(2.5, Math.min(bars4, (sec.end - sec.start) * 0.45));
}

/* ───────────────────────── pop-up windows ───────────────────────── */

/** pop-ups per section label when the plan doesn't say */
const POPS_BY_LABEL: Record<TrackSection['label'], number> = { intro: 1, verse: 1, chorus: 2, bridge: 1, build: 2, drop: 3, break: 1, outro: 0 };

/**
 * How busy the pop-up layer should be right now: 0 none … 3 lots. "In videos" follows the playing
 * video plan (its per-section marks, or the section's label); "Always" keeps a few coming anyway.
 */
export function popLevelAt(t: number): number {
  const s = useStudio.getState();
  if (s.popups === 'off') return 0;
  const a = s.analysis;
  const planned = s.planOn && audioEngine.kind === 'file' && validPlan(s.plan, a);
  if (planned) {
    const i = sectionIndexAt(a!.sections, t);
    const v = s.plan!.pops?.[i];
    return typeof v === 'number' ? Math.max(0, Math.min(3, Math.round(v))) : POPS_BY_LABEL[a!.sections[i].label];
  }
  if (s.popups !== 'always') return 0;
  if (!a?.sections.length) return 1;
  const sec = a.sections[sectionIndexAt(a.sections, t)];
  return Math.max(1, POPS_BY_LABEL[sec.label]);
}

/* ───────────────────────── picks while a plan is on ───────────────────────── */

/**
 * Use a look. With the song map on, it also goes into the section that's playing and into every
 * section that sounds the same and shared that section's look.
 */
export function pickLook(p: Preset) {
  const s = useStudio.getState();
  if (s.planOn && validPlan(s.plan, s.analysis)) {
    const i = sectionIndexAt(s.analysis!.sections, audioEngine.currentTime);
    assignLook(i, p.id, true);
  }
  s.applyPreset(p);
}

/** Put a look into section i (and its look-alikes when `spread`). */
export function assignLook(i: number, presetId: string, spread = true) {
  const s = useStudio.getState();
  if (!s.analysis) return;
  const secs = s.analysis.sections;
  const plan: VideoPlan = validPlan(s.plan, s.analysis)
    ? { ...s.plan!, looks: [...s.plan!.looks] }
    : { title: 'Your song map', note: '', looks: secs.map(() => null), why: [], source: 'local', duration: s.analysis.duration };
  const old = plan.looks[i];
  plan.looks[i] = presetId;
  let also = 0;
  if (spread) {
    secs.forEach((sec, j) => {
      if (j !== i && sec.group === secs[i].group && plan.looks[j] === old) {
        plan.looks[j] = presetId;
        also++;
      }
    });
  }
  // fill empty sections so the song map always has something to follow
  for (let j = 0; j < plan.looks.length; j++) if (!plan.looks[j]) plan.looks[j] = presetId;
  s.set({ plan, planOn: true, autoPilot: false });
  const names = sectionNames(secs);
  const look = findLook(presetId);
  s.flash(`${names[i]}${also ? ` and ${also} like it now use` : ' now uses'} “${look?.name ?? 'this look'}”`);
}

/** A scene isn't a saved look, so picking one pauses the song map rather than fighting it. */
export function pickScene(id: string) {
  const s = useStudio.getState();
  if (s.planOn) {
    s.set({ planOn: false });
    s.flash('Song map paused while you try a scene. Turn “Follow” back on to resume.');
  }
  s.setScene(id);
}

/* ───────────────────────── offline planner ───────────────────────── */

const LOUD = ['heavy', 'aggressive', 'intense', 'dubstep', 'glitch', 'euphoric', 'energetic', 'driving', 'techno', 'trance'];
const SOFT = ['calm', 'minimal', 'sad', 'dreamy', 'ambient', 'tender', 'spacious', 'slow', 'melancholic', 'piano'];
const intensity = (p: Preset) => p.tags.filter((t) => LOUD.includes(t)).length - p.tags.filter((t) => SOFT.includes(t)).length;

/**
 * A plan without Claude: three looks from the track's suggestions — a calm one for intros, breaks and
 * outros, a main one for verses and builds, a peak one for choruses and drops — with a fourth for a
 * bridge. Sections that sound alike always share a look.
 */
export function localPlan(a: TrackAnalysis): VideoPlan {
  // the curated looks first, then the person's own, then everything else
  const suggested = a.suggestedPresets.map((id) => findLook(id)).filter((p): p is Preset => !!p);
  const ranked = [...suggested.filter((p) => !p.custom), ...suggested.filter((p) => p.custom)];
  for (const p of PRESETS) if (!ranked.includes(p)) ranked.push(p);
  const top = ranked.slice(0, 8);
  const main = top[0];
  const peak = [...top.slice(1)].sort((x, y) => intensity(y) - intensity(x))[0] ?? main;
  const calm = [...top].filter((p) => p !== peak).sort((x, y) => intensity(x) - intensity(y))[0] ?? main;
  const bridge = top.find((p) => p !== main && p !== peak && p !== calm) ?? calm;
  const byLabel: Record<TrackSection['label'], Preset> = {
    intro: calm,
    outro: calm,
    break: calm,
    verse: main,
    build: main,
    chorus: peak,
    drop: peak,
    bridge,
  };
  const groupLook = new Map<number, string>();
  const looks = a.sections.map((s) => {
    const id = groupLook.get(s.group) ?? byLabel[s.label].id;
    if (!groupLook.has(s.group)) groupLook.set(s.group, id);
    return id;
  });
  const pops = a.sections.map((s) => POPS_BY_LABEL[s.label]);
  // one busy instrument-board interlude: at the top of the bridge or break (else the second verse)
  const interludes: (string | null)[] = a.sections.map(() => null);
  const used = new Set(looks);
  const boards = allLooks().filter((p) => !p.custom && p.sceneId.startsWith('board-') && !used.has(p.id));
  const boardPick = boards.find((p) => suggested.includes(p)) ?? boards[Math.floor(a.duration) % Math.max(1, boards.length)];
  let at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'bridge' || s.label === 'break'));
  if (at < 0) at = a.sections.findIndex((s, i) => s.label === 'verse' && a.sections.slice(0, i).some((x) => x.label === 'verse'));
  // short songs: open the first build (or the first verse after the intro) with it instead
  if (at < 0) at = a.sections.findIndex((s, i) => i > 0 && (s.label === 'build' || s.label === 'verse'));
  if (boardPick && at > 0 && a.sections.length >= 4) interludes[at] = boardPick.id;
  const names = sectionNames(a.sections);
  return {
    title: 'Song map',
    note: `Calm sections get “${calm.name}”, the body “${main.name}”, and the big moments “${peak.name}”. Parts that sound alike share a look.${
      boardPick && interludes[at] ? ` ${names[at]} opens with “${boardPick.name}” for a few bars, and little windows pop up on the big moments.` : ''
    }`,
    looks,
    why: [],
    source: 'local',
    duration: a.duration,
    pops,
    interludes,
  };
}

/* ───────────────────────── one-click video ───────────────────────── */

/**
 * Plan a video for the loaded song: Claude picks a look per section (offline plan if Claude isn't
 * reachable), then the song restarts from the top with the song map on.
 */
export async function makeVideo(wish = '') {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || s.planning) return;
  s.set({ planning: true });
  const { requestPlan } = await import('../director/client');
  const { readAccessCode } = await import('../ui/Director');
  const { getScene } = await import('../scenes');
  const looks = allLooks().filter((p) => getScene(p.sceneId));
  const lyr = s.lyrics;
  const offline = localPlan(a);
  let plan: VideoPlan = offline;
  let reason = '';
  try {
    const r = await requestPlan(
      {
        wish,
        track: { summary: a.summary, bpm: a.bpm, mood: a.mood, tags: a.tags },
        sections: a.sections.map((x) => ({
          label: x.label,
          group: x.group,
          start: x.start,
          end: x.end,
          energy: x.energy,
          ...(lyr?.synced ? { lyrics: textBetween(lyr.lines, x.start, x.end) } : {}),
        })),
        ...(lyr && !lyr.synced && lyr.plain ? { lyrics: lyr.plain.slice(0, 1500) } : {}),
        looks: looks.map((p) => ({ id: p.id, name: p.name, description: p.description, tags: p.tags, category: getScene(p.sceneId)?.category ?? '' })),
      },
      { accessCode: readAccessCode() || undefined },
    );
    if (r.ok) {
      plan = {
        title: r.title,
        note: r.note,
        looks: r.looks.map((id, i) => id ?? offline.looks[i]),
        why: r.why,
        source: 'claude',
        via: r.via,
        duration: a.duration,
        pops: r.pops.map((v, i) => v ?? offline.pops?.[i] ?? 1),
        interludes: r.interludes,
      };
    } else reason = r.reason;
  } catch (e) {
    reason = String(e);
  }
  // the song may have changed while Claude was thinking
  const now = useStudio.getState();
  if (now.analysis !== a) {
    now.set({ planning: false });
    return;
  }
  now.set({ plan, planOn: true, autoPilot: false, planning: false });
  now.pushChat({
    role: 'director',
    mode: 'plan',
    title: plan.title,
    text: plan.source === 'claude' ? plan.note : `${reason ? `${reason} ` : ''}${plan.note}`.trim(),
    source: plan.source,
    via: plan.via,
  });
  audioEngine.seek(0);
  void audioEngine.play().catch(() => {});
}
