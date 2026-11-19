import type { SceneDef } from '../../core/types';
import { aboveClouds } from './aboveClouds';
import { canopy } from './canopy';
import { gildedClouds } from './gildedClouds';
import { stillWater } from './stillWater';

/** organic, nature-themed looks (realistic three.js): clouds, canopy, light, water */
export const scenes: SceneDef[] = [gildedClouds, canopy, aboveClouds, stillWater];
