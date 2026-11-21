import type { SceneDef } from '../../core/types';
import { chalk } from './chalk';
import { crystal } from './crystal';
import { flurry } from './flurry';
import { snowfall } from './snowfall';

/** snow and snowflakes: a crystal growing live, flakes tumbling in 3D, snow falling on a street or a wood, chalk flakes on a board */
export const scenes: SceneDef[] = [crystal, flurry, snowfall, chalk];
