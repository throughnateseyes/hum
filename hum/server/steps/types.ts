/**
 * Director steps: the smaller Claude calls a longer job is made of (watching footage, planning shots,
 * drawing one object). Each is one request: the app runs them in order, so every step is short, shows
 * progress, can be retried alone, and stays inside a serverless function's time limit.
 *
 * A step only describes its call. Access, limits, spend, images and both backends (the API and the
 * claude CLI) are handled once, in runStep (server/steps/index.ts).
 */
import type { Tier } from '../models';

export interface StepTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StepCall {
  tier: Tier;
  /** low | medium | high */
  effort: string;
  /** the same text for every request, so it reads from the prompt cache */
  system: string;
  /** everything about this request (untrusted data is clipped by the step) */
  prompt: string;
  tool: StepTool;
  maxTokens: number;
  /** check and clean Claude's answer; null = unusable */
  finish: (output: unknown) => Record<string, unknown> | null;
}

export interface Step {
  /** a permission beyond having a code (see canDraw in server/limits.ts) */
  needs?: 'draw';
  /** how many JPEGs `body.images` may hold */
  maxImages: number;
  /** build the call from the (untrusted) body; a string is what's wrong with the request */
  prepare: (body: Record<string, unknown>, images: number) => StepCall | string;
}
