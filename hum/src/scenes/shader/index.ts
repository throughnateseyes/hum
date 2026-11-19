import type { SceneDef } from '../../core/types';
import { aura } from './aura';
import { chromeBlobs } from './chromeBlobs';
import { flowHair } from './flowHair';
import { liquidMarble } from './liquidMarble';
import { slitSmear } from './slitSmear';
import { subPressure } from './subPressure';
import { topo } from './topo';
import { glyphMosaic } from './glyphMosaic';
import { textWall } from './textWall';
import { signalScan } from './signalScan';
import { softOrbs } from './softOrbs';
import { prism } from './prism';

export const scenes: SceneDef[] = [liquidMarble, aura, chromeBlobs, slitSmear, topo, subPressure, flowHair, glyphMosaic];

// inspo looks: lyric text wall (a canvas scene)
scenes.push(textWall);

// looks built from the reference boards
scenes.push(signalScan, softOrbs, prism);
