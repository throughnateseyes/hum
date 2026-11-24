/**
 * Plain: the footage alone, nothing laid over it. The style for the parts where the picture itself is
 * the point (and the one lyrics sit on most easily).
 */
import * as THREE from 'three';
import type { StyleFactory } from '../kit';

export const plain: StyleFactory = (ctx) => ({
  object: new THREE.Group(),
  mask: null,
  update(_f, bed) {
    bed.tone[0] = ctx.tone;
  },
  dispose() {},
});
