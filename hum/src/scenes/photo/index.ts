import type { SceneDef } from '../../core/types';
import { photoDissolve } from './dissolve';
import { photoMosh } from './mosh';
import { photoMosaic } from './mosaic';
import { photoRipple } from './ripple';

export { createPlaceholderPhoto } from './placeholder';
export { loadPhoto } from './loadPhoto';

export const scenes: SceneDef[] = [photoDissolve, photoMosh, photoMosaic, photoRipple];
