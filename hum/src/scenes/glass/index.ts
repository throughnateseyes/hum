import type { SceneDef } from '../../core/types';
import { glassAndamento } from './andamento';
import { glassRose } from './rose';
import { glassShatter } from './shatter';
import { glassWindow } from './window';

/** glass: stained-glass windows, a rose dome, a smalti mosaic and a window that shatters */
export const scenes: SceneDef[] = [glassWindow, glassRose, glassAndamento, glassShatter];
