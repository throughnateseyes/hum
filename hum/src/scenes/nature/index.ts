import type { SceneDef } from '../../core/types';
import { aboveClouds } from './aboveClouds';
import { canopy } from './canopy';
import { gildedClouds } from './gildedClouds';
import { stillWater } from './stillWater';
import { laminar } from './laminar';
import { fountainShow } from './fountains';

import { wing } from './wing';

/** organic, nature-themed looks (realistic three.js): clouds, canopy, light, water */
export const scenes: SceneDef[] = [gildedClouds, canopy, aboveClouds, stillWater, laminar];

// looks built from the reference boards
scenes.push(wing);

// a choreographed water show
scenes.push(fountainShow);
