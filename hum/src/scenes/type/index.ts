import type { SceneDef } from '../../core/types';
import { wordDrop } from './wordDrop';
import { ribbonType } from './ribbonType';

/** type looks: words are the picture (ribbons of type, falling lyric tags) */
export const scenes: SceneDef[] = [wordDrop, ribbonType];
