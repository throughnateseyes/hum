/**
 * Footage looks and the planner.
 *
 * A look whose scene has `usesClips` plays the person's own video clips as its picture. Without clips
 * it shows nothing worth watching, so for every planner (Claude's plan request, the offline plan, gap
 * filling, rotations, interludes, taste picks, skip and quick-replace, the single-look director) such a
 * look simply doesn't exist until a clip is added. A person can still pick one by hand from the library.
 *
 * With clips, footage carries the video (see `footageCut` in state/plan.ts). Footage looks are told
 * apart by their scene's flag, never by their ids, so new footage looks join in on their own.
 */
import type { Preset, SceneDef } from '../core/types';
import { drawingsReady } from '../draw/session';
import { PRESETS } from '../presets';
import { allScenes, getScene } from '../scenes';
import { useStudio } from '../state/store';

/** how many video clips the person has added */
export function clipCount(): number {
  return useStudio.getState().clips?.length ?? 0;
}

/** the look plays the person's clips (its scene is built on them) */
export function playsClips(p: Pick<Preset, 'sceneId'> | undefined): boolean {
  return !!p && !!getScene(p.sceneId)?.usesClips;
}

/** may a planner use this scene right now? (a clip scene only once there are clips, a drawing scene only once the song has drawings) */
export function sceneMayPlan(s: Pick<SceneDef, 'usesClips' | 'usesDrawings'> | undefined): boolean {
  return (!s?.usesClips || clipCount() > 0) && sceneShows(s);
}

/**
 * May this scene be seen at all, in any list, shuffle or suggestion? Looks made of drawings don't exist
 * until the song has some (and never do where drawings aren't allowed).
 */
export function sceneShows(s: Pick<SceneDef, 'usesDrawings'> | undefined): boolean {
  return !s?.usesDrawings || drawingsReady();
}

/** `sceneShows` for a look */
export const lookShows = (p: Pick<Preset, 'sceneId'> | undefined): boolean => !p || sceneShows(getScene(p.sceneId));

/**
 * May a planner use this look right now? The one question every planner asks before offering,
 * picking, pooling or suggesting a look. Unknown looks pass: whoever asked already handles those.
 */
export function mayPlan(p: Pick<Preset, 'sceneId'> | undefined): boolean {
  return !p || sceneMayPlan(getScene(p.sceneId));
}

/** `mayPlan` by look id (for lists of ids: taste picks, rotations) */
export function mayPlanId(id: string | null | undefined): boolean {
  if (!id) return true;
  const p = useStudio.getState().customPresets.find((x) => x.id === id) ?? PRESETS.find((x) => x.id === id);
  return mayPlan(p);
}

/** the scenes the single-look director may use now; `keep` (the scene on screen) always stays */
export function directorScenes(keep?: string): SceneDef[] {
  return allScenes().filter((s) => s.id === keep || sceneMayPlan(s));
}
