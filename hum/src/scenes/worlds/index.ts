import type { SceneDef } from '../../core/types';
import { willow } from './willow';
import { nightWindows } from './nightWindows';
import { signalForest } from './signalForest';
import { jellies } from './jellies';
import { shoal } from './shoal';
import { observer } from './observer';
import { retroDesktop } from './retroDesktop';
import { orrery } from './orrery';
import { nightTrain } from './nightTrain';

/** worlds: places and living things, drawn rather than photographed */
export const scenes: SceneDef[] = [willow, nightWindows, signalForest, jellies, shoal, observer, retroDesktop, orrery, nightTrain];
