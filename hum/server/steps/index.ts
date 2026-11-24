import type { DirectorEnv, DirectorResult, LocalBackend } from '../director';
import { modelForTier } from '../models.js';
import { DRAW_STEPS } from './draw.js';
import { FOOTAGE_STEPS } from './footage.js';
import { readImages } from './images.js';
import type { Step, StepTool } from './types';

const STEPS: Record<string, Step> = { ...FOOTAGE_STEPS, ...DRAW_STEPS };

/** own keys only, so a mode like "constructor" isn't a step */
export const stepFor = (mode: unknown): Step | null => (typeof mode === 'string' && Object.hasOwn(STEPS, mode) ? STEPS[mode] : null);

/** the API call, handed in by director.ts (it owns spend, retries and errors) */
export type ApiCall = (label: string, model: string, effort: string, system: string, tool: StepTool, content: unknown, maxTokens: number) => Promise<DirectorResult | { input: unknown }>;

/** one step, after access has been checked and before limits are (`gate`), so a bad request costs no hourly slot */
export async function runStep(mode: string, step: Step, body: Record<string, unknown>, env: DirectorEnv, local: LocalBackend | null, gate: () => Promise<DirectorResult | null>, api: ApiCall): Promise<DirectorResult> {
  const images = readImages(body.images, step.maxImages);
  if (typeof images === 'string') return { status: 400, json: { error: 'bad_request', note: images } };
  const call = step.prepare(body, images.length);
  if (typeof call === 'string') return { status: 400, json: { error: 'bad_request', note: call } };
  const stopped = await gate();
  if (stopped) return stopped;

  const effort = env.HUM_EFFORT?.trim() || call.effort;
  let output: unknown;
  if (local) {
    const r = await local({
      mode,
      system: call.system,
      prompt: `${call.prompt}\n\nAnswer with the structured output: ${call.tool.description}`,
      schema: call.tool.input_schema,
      effort,
      tier: call.tier,
      images,
    });
    if (!r.ok) return { status: r.status, json: { error: r.error, note: r.note } };
    output = r.output;
  } else {
    const text = `${call.prompt}\n\nCall the ${call.tool.name} tool with your answer.`;
    const content = images.length ? [...images.map((s) => ({ type: 'image', source: { type: 'base64', ...s } })), { type: 'text', text }] : text;
    const r = await api(mode, modelForTier(env, call.tier), effort, call.system, call.tool, content, call.maxTokens);
    if ('status' in r) return r;
    output = r.input;
  }
  const json = call.finish(output);
  if (!json) return { status: 502, json: { error: 'bad_output', note: 'Claude’s answer couldn’t be used.' } };
  return { status: 200, json: { ...json, source: 'claude', via: local ? 'subscription' : 'api' } };
}
