import type { SceneDef } from '../../core/types';
import { halftoneFlow } from './halftoneFlow';
import { beadFire } from './beadFire';
import { confetti } from './confetti';
import { specimenTiles } from './specimenTiles';

/** print looks: dots, beads, flecks and tiles, things that look printed or made by hand */
export const scenes: SceneDef[] = [halftoneFlow, beadFire, confetti, specimenTiles];
