import type { SceneDef } from '../../core/types';
import { aura } from './aura';
import { chromeBlobs } from './chromeBlobs';
import { flowHair } from './flowHair';
import { liquidMarble } from './liquidMarble';
import { slitSmear } from './slitSmear';
import { subPressure } from './subPressure';
import { topo } from './topo';

export const scenes: SceneDef[] = [liquidMarble, aura, chromeBlobs, slitSmear, topo, subPressure, flowHair];
