/**
 * A floor for the shot (prototype, see src/dev/shot.ts): a ground plane of thin ink lines running off
 * to the horizon below the focus, so the picture has something to stand on and the speed ramp reads
 * as flying forward over it.
 *
 * The grid is worked out in the fragment shader from where each pixel lands on the plane, so one quad
 * draws all of it, with lines that stay the same width on screen however far away they are. It draws
 * on from the distance toward the camera over the first beats and pulls back into the distance at the
 * end. On every kick a pale band rolls away across it. A handful of small posts stand on grid
 * crossings and rise as the grid reaches them, giving parallax as they pass the lens.
 */
import * as THREE from 'three';
import { CAM_Z, SHAPE, ShapeCloud, inkOf, type MotifFactory, type ShapeId } from '../kit';
import { clamp01, easeInCubic, easeOutBack, easeOutCubic, since, smooth } from '../time';

/** how far from the camera the grid has faded out completely (world units along z) */
const FAR = 16;
/** where the reveal front stands with nothing drawn, and with everything drawn (z relative to the camera's space) */
const FRONT_FAR = CAM_Z - FAR - 2;
const FRONT_NEAR = CAM_Z + 1;

const FLOOR_VERT = /* glsl */ `
varying vec3 vP;
void main() {
  // The quad is a child of the world space, which the stage slides toward the camera by the travel.
  // The grid is laid out in the quad's own space (before the model matrix), so it is carried along
  // with the world and the lines stream past the camera by themselves; uTravel is only used in the
  // fragment shader to know how far each point now is from the camera.
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FLOOR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vP;
uniform vec3 uInk;
uniform vec3 uPulse;
uniform float uCell;
uniform float uTravel;
uniform float uFront;
uniform float uPulseZ;
uniform float uPulseA;
uniform float uHalfX;
uniform float uAlpha;

// how much of this pixel a line of width px (screen pixels) covers, d being the distance in pixels
float cover(float d, float px) {
  return clamp(px * 0.5 + 0.5 - d, 0.0, 1.0);
}

void main() {
  vec2 g = vP.xz / uCell;
  vec2 fw = max(fwidth(g), vec2(1e-5));
  vec2 d = abs(fract(g - 0.5) - 0.5) / fw;
  vec2 g4 = g * 0.25;
  vec2 fw4 = fw * 0.25;
  vec2 d4 = abs(fract(g4 - 0.5) - 0.5) / fw4;
  // lines closer together than a few pixels fade out before they can shimmer
  vec2 thin = 1.0 - smoothstep(0.22, 0.55, fw);
  vec2 thin4 = 1.0 - smoothstep(0.22, 0.55, fw4);
  float lx = max(cover(d.x, 1.2) * thin.x, cover(d4.x, 1.9) * thin4.x);
  float lz = max(cover(d.y, 1.2) * thin.y, cover(d4.y, 1.9) * thin4.y);
  float line = max(lx, lz);

  float zc = vP.z + uTravel;
  float dist = ${CAM_Z.toFixed(1)} - zc;
  float fade = (1.0 - smoothstep(${(FAR * 0.45).toFixed(1)}, ${FAR.toFixed(1)}, dist)) * smoothstep(0.6, 2.4, dist);
  fade *= 1.0 - smoothstep(0.82, 1.0, abs(vP.x) / uHalfX);
  // the grid only exists behind the reveal front
  fade *= clamp((uFront - zc) / 1.5, 0.0, 1.0);

  // the kick's band, one cell wide, rolling away from the camera
  float band = (1.0 - smoothstep(uCell * 0.3, uCell * 0.5, abs(zc - uPulseZ))) * uPulseA;

  float lineA = line * 0.55;
  float fill = band * 0.3;
  float a = (lineA + fill * (1.0 - lineA)) * fade * uAlpha;
  if (a < 0.003) discard;
  vec3 col = mix(uInk, uPulse, clamp(band * 1.6, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}
`;

interface Marker {
  x: number;
  z: number;
  h: number;
  top: ShapeId;
  color: THREE.Color;
}

export const floor: MotifFactory = (ctx) => {
  const { halfW, halfH, palette, beat, start, end, kicks, depth } = ctx;
  const root = new THREE.Group();
  const y0 = -0.62 * halfH;
  const cell = 0.55 * halfH;
  const halfX = 3 * halfW;
  // long enough that its far edge sits well past the fade even at the end of the shot
  const zNear = 5;
  const zFar = -(depth + 14 + FAR + 10);

  const geo = new THREE.PlaneGeometry(halfX * 2, zNear - zFar);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0, (zNear + zFar) / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uInk: { value: inkOf(palette, 'ink') },
      uPulse: { value: inkOf(palette, 0) },
      uCell: { value: cell },
      uTravel: { value: 0 },
      uFront: { value: FRONT_FAR },
      uPulseZ: { value: 0 },
      uPulseA: { value: 0 },
      uHalfX: { value: halfX },
      uAlpha: { value: 1 },
    },
  });
  const u = mat.uniforms;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  root.add(mesh);

  // posts on grid crossings, kept off the middle column so none rises straight through the lens
  const reach = Math.max(1, Math.floor((2.6 * halfW) / cell));
  const rows = Math.max(1, Math.round((depth + 2) / cell));
  const tops = [inkOf(palette, 1), inkOf(palette, 'paper'), inkOf(palette, 3), inkOf(palette, 'ink'), inkOf(palette, 2)];
  const stemColor = inkOf(palette, 'ink');
  const count = 8 + Math.floor(ctx.rnd() * 5);
  const markers: Marker[] = [];
  for (let i = 0; i < count; i++) {
    const side = ctx.rnd() < 0.5 ? -1 : 1;
    const col = 1 + Math.floor(ctx.rnd() * reach);
    const row = Math.floor(ctx.rnd() * (rows + 1));
    markers.push({
      x: side * col * cell,
      z: -row * cell,
      h: (0.25 + ctx.rnd() * 0.65) * halfH,
      top: ctx.rnd() < 0.5 ? SHAPE.disc : SHAPE.rect,
      color: tops[Math.floor(ctx.rnd() * tops.length)],
    });
  }
  const cloud = new ShapeCloud(markers.length * 2, { shadowColor: palette.ink, width: ctx.width, height: ctx.height, order: 3 });
  root.add(cloud.object);
  const stemW = halfH * 0.007;
  const topS = halfH * 0.045;

  return {
    space: 'world',
    object: root,
    update(f) {
      const t = f.t;
      const reveal = easeOutCubic(clamp01((t - start) / (beat * 3)));
      const withdraw = easeInCubic(clamp01((t - (end - beat * 2)) / (beat * 2)));
      let front = FRONT_FAR + (FRONT_NEAR - FRONT_FAR) * reveal;
      front += (FRONT_FAR - front) * withdraw;

      // the band leaves just below the bottom of the frame and rolls off toward the horizon in a beat
      const s = since(kicks, t) / beat;
      const roll = easeOutCubic(clamp01(s));
      u.uPulseZ.value = 2.6 - 13 * roll;
      u.uPulseA.value = s < 1.2 ? 0.7 * (1 - smooth(0.15, 1.1, s)) * smooth(0, 0.06, s) : 0;
      u.uTravel.value = f.travel;
      u.uFront.value = front;

      cloud.begin();
      for (const m of markers) {
        if (!ShapeCloud.ahead(m.z, f.travel)) continue;
        const zc = m.z + f.travel;
        const rise = easeOutBack(clamp01((front - zc) / 2.5));
        if (rise <= 0.001) continue;
        const alpha = 1 - smooth(FAR * 0.6, FAR, CAM_Z - zc);
        const hh = m.h * rise;
        cloud.add(SHAPE.rect, m.x, y0 + hh / 2, m.z, stemW, hh, stemColor, alpha * 0.9);
        cloud.add(m.top, m.x, y0 + hh, m.z, topS, topS, m.color, alpha);
      }
      cloud.commit(f.travel);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      cloud.dispose();
    },
  };
};
