/**
 * Which Claude model does which job. Big creative jobs (a whole video plan, a new GLSL scene, a look
 * from a feeling) stay on the main model; small edits ("make the chorus calmer", "warmer") go to a
 * small, fast model that costs about a twentieth as much.
 *
 * Env (all optional):
 *   HUM_MODEL          main model, default claude-sonnet-5-5
 *   HUM_PLAN_MODEL     model for "Make a video" (default: HUM_MODEL)
 *   HUM_SHADER_MODEL   model for "New scene" (default: HUM_MODEL)
 *   HUM_EDIT_MODEL     model for small edits to a plan or a look, default claude-haiku-5-5
 *                      ("main" sends edits to the main model too)
 *   HUM_BEST_MODEL     model for drawing, default claude-opus-5-5
 *
 * Your Claude subscription in dev (server/cliDirector.ts) has its own pair: HUM_CLI_MODEL (default
 * sonnet) and HUM_CLI_EDIT_MODEL (default haiku), plus HUM_CLI_BEST_MODEL (default opus).
 */
import type { DirectorEnv } from './director';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EDIT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_BEST_MODEL = 'claude-opus-5-5';

/** what a request asks for */
export type Task = 'plan' | 'planEdit' | 'preset' | 'presetEdit' | 'shader';
/** main = the big model, small = the edit model, best = the strongest (drawings) */
export type Tier = 'main' | 'small' | 'best';

export const tierOf = (task: Task): Tier => (task === 'planEdit' || task === 'presetEdit' ? 'small' : 'main');

export function modelFor(env: DirectorEnv, task: Task): string {
  const main = env.HUM_MODEL?.trim() || DEFAULT_MODEL;
  if (task === 'plan') return env.HUM_PLAN_MODEL?.trim() || main;
  if (task === 'shader') return env.HUM_SHADER_MODEL?.trim() || main;
  if (task === 'preset') return main;
  const edit = env.HUM_EDIT_MODEL?.trim();
  if (edit === 'main') return main;
  return edit || DEFAULT_EDIT_MODEL;
}

/** the API model for a director step (server/steps) */
export function modelForTier(env: DirectorEnv, tier: Tier): string {
  if (tier === 'best') return env.HUM_BEST_MODEL?.trim() || DEFAULT_BEST_MODEL;
  return modelFor(env, tier === 'small' ? 'planEdit' : 'plan');
}
