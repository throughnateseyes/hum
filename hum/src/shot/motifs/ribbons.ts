/**
 * Ribbons and threads: long flat bands that run through the shot's 3D space (prototype, see
 * src/dev/shot.ts).
 *
 * ribbons  Five to seven flat bands, each laid along a smooth curve that starts far down the road
 *          (beyond everything else in the shot) and ends just in front of the lens. As the world
 *          slides toward the camera they come up out of the distance, sweep across the picture and
 *          curve past the lens. Two are wide and slow, two are thin and curl round a wide one's path,
 *          one or two corkscrew. Each band turns over gently along its length, so it shows its front
 *          in a palette colour and its back a shade darker (or lighter). A ribbon draws itself on from
 *          its far end over the first few beats, swells a little on the kicks (taking turns, so they
 *          never all pump together), and its tail runs up to meet its head in the last two beats.
 *          Away from the plane in focus a band goes soft and faint, most of all close to the lens.
 *
 * threads  The quiet version for the calm stretch before the drop: a dozen hairlines in ink and paper
 *          that run almost straight down the road and bend in to meet at the focus point far away,
 *          drawn on over the shot's first three beats.
 *
 * Everything here is a pure function of song time: update() only sets uniforms.
 */
import * as THREE from 'three';
import { CAM_Z, FOV, inkOf, type Motif, type MotifContext, type MotifFactory, type MotifFrame } from '../kit';
import { clamp01, easeOutCubic, since, smooth } from '../time';

const TAU = Math.PI * 2;

const STRIP_VERT = /* glsl */ `
#define CAM_Z ${CAM_Z.toFixed(2)}
attribute float aAlong;  // 0 at the far end, 1 at the near end
attribute float aSide;   // -1..1 across the band
attribute vec3 aDir;     // the band's width direction (twisting along its length)
attribute vec3 aTan;     // the direction the centre line runs
uniform float uTravel;   // how far the world has slid toward the camera
uniform float uHalf;     // half the band's width
uniform float uSwell;    // width multiplier (the kicks)
uniform float uBlurK;    // how quickly the band goes soft away from the plane in focus
uniform float uFacing;   // 1: turn the width to face the camera (hairlines), 0: follow aDir
uniform float uBend;     // how hard the far end bends toward the focus point (threads)
uniform vec2 uFocus;     // the focus point on the plane in focus
uniform float uPx;       // world size of one pixel per unit of distance from the camera
varying float vAlong;
varying float vSide;
varying float vBlur;
varying float vGrow;
varying float vThin;
varying float vZc;
void main() {
  vec3 c = position;
  float zc = c.z + uTravel;
  if (uBend > 0.0) {
    // the point that lands on the focus point on screen at this depth
    vec2 target = uFocus * max(0.0, CAM_Z - zc) / CAM_Z;
    float far = 1.0 - aAlong;
    c.xy = mix(c.xy, target, uBend * far * far);
  }
  float lens = max(0.35, CAM_Z - zc);
  float hw = uHalf * uSwell;
  // depth of field: sharp on the plane in focus, softer the further from it, most of all near the lens
  float coc = abs(zc) / lens * uBlurK;
  float blur = min(1.6, coc / max(hw, 1e-4));
  // never thinner than ~0.7px on screen: a thinner band keeps its ink by going fainter instead
  float shown = max(hw, 0.7 * uPx * lens);
  float grow = 1.0 + blur;
  vec3 dir = aDir;
  if (uFacing > 0.5) {
    vec3 s = cross(aTan, vec3(-c.xy, CAM_Z - zc));
    float l = length(s);
    if (l > 1e-5) dir = s / l;
  }
  vec3 p = c + dir * aSide * shown * grow;
  vAlong = aAlong;
  vSide = aSide;
  vBlur = blur;
  vGrow = grow;
  vThin = hw / shown;
  vZc = zc;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const STRIP_FRAG = /* glsl */ `
precision highp float;
#define CAM_Z ${CAM_Z.toFixed(2)}
uniform vec3 uColor;   // front
uniform vec3 uBack;    // back
uniform float uHead;   // the drawn window along the band, in aAlong units
uniform float uTail;
uniform float uSoft;   // how soft its ends are
uniform float uAlpha;
varying float vAlong;
varying float vSide;
varying float vBlur;
varying float vGrow;
varying float vThin;
varying float vZc;
void main() {
  if (vZc > CAM_Z - 0.3) discard;
  // distance from the centre line in units of the band's half width (1 = its edge)
  float e = abs(vSide) * vGrow;
  float f = vBlur + fwidth(e);
  float cover = 1.0 - smoothstep(1.0 - f, 1.0 + f, e);
  float reveal = smoothstep(uTail, uTail + uSoft, vAlong) * (1.0 - smoothstep(uHead - uSoft, uHead, vAlong));
  float a = cover * reveal * uAlpha * vThin / (1.0 + vBlur * 0.6);
  if (a < 0.004) discard;
  gl_FragColor = vec4(gl_FrontFacing ? uColor : uBack, a);
}
`;

/** one band's mesh and the numbers its clock needs */
interface Strip {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** when its head starts drawing on (s) and how long it takes */
  t0: number;
  dur: number;
  /** the kicks this band swells on (empty for none) */
  kicks: number[];
}

/**
 * A flat band along a curve: two vertices per step, both at the centre line, pushed apart in the
 * vertex shader so the width can swell and blur without rebuilding anything.
 * `twist` is how many half turns the width direction makes along the band.
 */
function stripGeometry(curve: THREE.Curve<THREE.Vector3>, segments: number, twist: number, twist0: number): THREE.BufferGeometry {
  const n = segments + 1;
  const pos = new Float32Array(n * 6);
  const along = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  const dir = new Float32Array(n * 6);
  const tan = new Float32Array(n * 6);
  const frames = curve.computeFrenetFrames(segments, false);
  // start the width across the line of sight (tangential round the camera's axis), so the band opens
  // toward the lens instead of arriving edge on
  const p0 = curve.getPointAt(0);
  const radial = new THREE.Vector3(p0.x, p0.y, 0);
  if (radial.lengthSq() < 1e-6) radial.set(1, 0, 0);
  const w0 = new THREE.Vector3().crossVectors(frames.tangents[0], radial.normalize());
  const base = Math.atan2(w0.dot(frames.binormals[0]), w0.dot(frames.normals[0])) + twist0;
  const p = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    const th = base + twist * Math.PI * u;
    w.copy(frames.normals[i]).multiplyScalar(Math.cos(th)).addScaledVector(frames.binormals[i], Math.sin(th));
    const t = frames.tangents[i];
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      pos.set([p.x, p.y, p.z], j * 3);
      dir.set([w.x, w.y, w.z], j * 3);
      tan.set([t.x, t.y, t.z], j * 3);
      along[j] = u;
      side[j] = k ? 1 : -1;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
  geo.setIndex(index);
  return geo;
}

function baseMaterial(ctx: MotifContext): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: STRIP_VERT,
    fragmentShader: STRIP_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTravel: { value: 0 },
      uHalf: { value: 0.05 },
      uSwell: { value: 1 },
      uBlurK: { value: 0.11 },
      uFacing: { value: 0 },
      uBend: { value: 0 },
      uFocus: { value: new THREE.Vector2() },
      uPx: { value: (2 * Math.tan(((FOV / 2) * Math.PI) / 180)) / Math.max(1, ctx.height) },
      uColor: { value: new THREE.Color() },
      uBack: { value: new THREE.Color() },
      uHead: { value: 0 },
      uTail: { value: 0 },
      uSoft: { value: 0.04 },
      uAlpha: { value: 1 },
    },
  });
}

/** the shared clock and bookkeeping for a set of strips */
function stripMotif(ctx: MotifContext, strips: Strip[], soft: number): Motif {
  const object = new THREE.Group();
  for (const s of strips) object.add(s.mesh);
  const { beat, end } = ctx;
  return {
    space: 'world',
    object,
    update(f: MotifFrame) {
      const { t } = f;
      // the tails run up to meet the heads over the last two beats, so everything leaves cleanly
      const out = smooth(end - beat * 2, end, t);
      for (const s of strips) {
        const u = s.mat.uniforms;
        const head = easeOutCubic(clamp01((t - s.t0) / s.dur)) * (1 + soft);
        u.uHead.value = head;
        u.uTail.value = -soft + (head + soft) * out;
        u.uTravel.value = f.travel;
        (u.uFocus.value as THREE.Vector2).set(f.focusX, f.focusY);
        if (s.kicks.length) {
          // a quick rise and a ~quarter-beat fall: +35% at most
          const dt = since(s.kicks, t);
          u.uSwell.value = 1 + 0.35 * smooth(0, 0.035, dt) * Math.exp(-dt / (beat * 0.12));
        }
      }
    },
    dispose() {
      for (const s of strips) {
        s.mesh.geometry.dispose();
        s.mat.dispose();
      }
    },
  };
}

/** a band from its curve and its look; the material is a clone of `base` with its own uniforms */
function makeStrip(base: THREE.ShaderMaterial, curve: THREE.Curve<THREE.Vector3>, opts: { segments: number; twist: number; twist0: number; half: number; color: THREE.Color; back: THREE.Color; alpha: number; soft: number; facing?: boolean; bend?: number; blurK?: number }): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const geo = stripGeometry(curve, opts.segments, opts.twist, opts.twist0);
  const mat = base.clone();
  const u = mat.uniforms;
  u.uHalf.value = opts.half;
  (u.uColor.value as THREE.Color).copy(opts.color);
  (u.uBack.value as THREE.Color).copy(opts.back);
  u.uAlpha.value = opts.alpha;
  u.uSoft.value = opts.soft;
  u.uFacing.value = opts.facing ? 1 : 0;
  u.uBend.value = opts.bend ?? 0;
  if (opts.blurK !== undefined) u.uBlurK.value = opts.blurK;
  u.uTail.value = -opts.soft;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return { mesh, mat };
}

/**
 * Control points running down the road from z0 to z1, wandering within ±ax, ±ay. Points near the lens
 * are kept off the camera's axis, so a band sweeps past it instead of filling the picture.
 */
function wander(ctx: MotifContext, n: number, z0: number, z1: number, ax: number, ay: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const jitter = i > 0 && i < n - 1 ? ((ctx.rnd() - 0.5) * 0.6) / (n - 1) : 0;
    const z = z0 + (z1 - z0) * (i / (n - 1) + jitter);
    let x = (ctx.rnd() * 2 - 1) * ax;
    let y = (ctx.rnd() * 2 - 1) * ay;
    if (z > -2) {
      const r = Math.hypot(x / ax, y / ay);
      if (r < 0.6) {
        const a = r > 1e-3 ? Math.atan2(y / ay, x / ax) : ctx.rnd() * TAU;
        x = Math.cos(a) * 0.6 * ax;
        y = Math.sin(a) * 0.6 * ay;
      }
    }
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

/** points that wind round a path: `radius` in x and y, `turns` times along its length */
function coil(ctx: MotifContext, path: THREE.Curve<THREE.Vector3>, rx: number, ry: number, turns: number, samples = 140): THREE.Vector3[] {
  const phase = ctx.rnd() * TAU;
  const spin = ctx.rnd() < 0.5 ? -1 : 1;
  const pts: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    path.getPointAt(u, c);
    const a = phase + spin * turns * TAU * u;
    pts.push(new THREE.Vector3(c.x + Math.cos(a) * rx, c.y + Math.sin(a) * ry, c.z));
  }
  return pts;
}

/** the back of a band: a little toward ink for light colours, toward paper for the ink one */
function backOf(ctx: MotifContext, which: number | 'ink' | 'paper'): THREE.Color {
  const front = inkOf(ctx.palette, which);
  if (which === 'ink') return front.lerp(inkOf(ctx.palette, 'paper'), 0.22);
  return front.lerp(inkOf(ctx.palette, 'ink'), which === 'paper' ? 0.14 : 0.2);
}

type Kind = 'wide' | 'curl' | 'screw';

export const ribbons: MotifFactory = (ctx) => {
  const { halfW, halfH, beat, start } = ctx;
  const s = Math.min(halfW, halfH);
  const z0 = -(ctx.depth + 4);
  const z1 = 3;
  const ax = 1.3 * halfW;
  const ay = 1.2 * halfH;
  const soft = 0.045;

  // who's who: two wide, a corkscrew, two that curl round a wide one, and maybe a second of each
  const count = 5 + Math.floor(ctx.rnd() * 3);
  const roster: Kind[] = (['wide', 'wide', 'screw', 'curl', 'curl', 'screw', 'curl'] as Kind[]).slice(0, count);
  // colours: flats dealt in a shuffled order; the two curls wear ink and paper
  const flats = [0, 1, 2, 3, 4];
  for (let i = flats.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rnd() * (i + 1));
    [flats[i], flats[j]] = [flats[j], flats[i]];
  }
  let nextFlat = 0;
  let curls = 0;

  const base = baseMaterial(ctx);
  const wides: THREE.Curve<THREE.Vector3>[] = [];
  const strips: Strip[] = [];
  roster.forEach((kind, r) => {
    let curve: THREE.Curve<THREE.Vector3>;
    let half: number;
    let twist: number;
    let which: number | 'ink' | 'paper';
    let alpha = 1;
    if (kind === 'wide') {
      curve = new THREE.CatmullRomCurve3(wander(ctx, 4 + Math.floor(ctx.rnd() * 2), z0, z1, ax, ay), false, 'centripetal');
      wides.push(curve);
      half = s * (0.07 + ctx.rnd() * 0.035);
      twist = 1 + ctx.rnd() * 1.4;
      which = flats[nextFlat++ % 5];
      alpha = 0.93;
    } else if (kind === 'screw') {
      const path = new THREE.CatmullRomCurve3(wander(ctx, 4, z0, z1, ax * 0.75, ay * 0.75), false, 'centripetal');
      const rad = s * (0.25 + ctx.rnd() * 0.2);
      curve = new THREE.CatmullRomCurve3(coil(ctx, path, rad, rad, 3 + ctx.rnd() * 2), false, 'centripetal');
      half = s * (0.035 + ctx.rnd() * 0.02);
      twist = 2 + ctx.rnd() * 2;
      which = flats[nextFlat++ % 5];
    } else {
      const host = wides[curls % Math.max(1, wides.length)];
      const rad = s * (0.08 + ctx.rnd() * 0.08);
      curve = new THREE.CatmullRomCurve3(coil(ctx, host, rad, rad, 6 + ctx.rnd() * 4, 180), false, 'centripetal');
      half = s * (0.012 + ctx.rnd() * 0.01);
      twist = 2 + ctx.rnd() * 2;
      which = curls === 0 ? 'ink' : curls === 1 ? 'paper' : flats[nextFlat++ % 5];
      curls++;
    }
    const { mesh, mat } = makeStrip(base, curve, {
      segments: kind === 'wide' ? 180 : 230,
      twist,
      twist0: (ctx.rnd() - 0.5) * 0.8,
      half,
      color: inkOf(ctx.palette, which),
      back: backOf(ctx, which),
      alpha,
      soft,
    });
    strips.push({
      mesh,
      mat,
      t0: start + ctx.rnd() * 2 * beat,
      dur: (6 + ctx.rnd() * 2) * beat,
      // take turns on the kicks: even ribbons on the even kicks, odd on the odd
      kicks: ctx.kicks.filter((_, i) => i % 2 === r % 2),
    });
  });
  base.dispose();
  return stripMotif(ctx, strips, soft);
};

export const threads: MotifFactory = (ctx) => {
  const { halfW, halfH, beat, start } = ctx;
  const z0 = -(ctx.depth + 4);
  const soft = 0.06;
  const count = 10 + Math.floor(ctx.rnd() * 5);
  const base = baseMaterial(ctx);
  const strips: Strip[] = [];
  const turn0 = ctx.rnd() * TAU;
  for (let i = 0; i < count; i++) {
    // fanned round the picture near the lens, gathered near the middle far away
    const a = turn0 + (i / count) * TAU + (ctx.rnd() - 0.5) * 0.4;
    const r = 0.6 + ctx.rnd() * 0.7;
    const near = new THREE.Vector3(Math.cos(a) * r * halfW, Math.sin(a) * r * halfH, 2.5 + ctx.rnd() * 0.5);
    const far = new THREE.Vector3((ctx.rnd() - 0.5) * 0.3 * halfW, (ctx.rnd() - 0.5) * 0.3 * halfH, z0);
    const pts = [0, 0.4, 0.75, 1].map((u) => {
      const p = far.clone().lerp(near, u);
      if (u > 0 && u < 1) {
        p.x += (ctx.rnd() - 0.5) * 0.06 * halfW;
        p.y += (ctx.rnd() - 0.5) * 0.06 * halfH;
      }
      return p;
    });
    const which = ctx.rnd() < 0.5 ? 'ink' : 'paper';
    const { mesh, mat } = makeStrip(base, new THREE.CatmullRomCurve3(pts, false, 'centripetal'), {
      segments: 120,
      twist: 0,
      twist0: 0,
      half: 0.003 + ctx.rnd() * 0.003,
      color: inkOf(ctx.palette, which),
      back: inkOf(ctx.palette, which),
      alpha: 0.7 + ctx.rnd() * 0.2,
      soft,
      facing: true,
      bend: 0.85,
      blurK: 0.05,
    });
    // all drawn on by the end of the shot's third beat
    const lag = ctx.rnd() * 0.8 * beat;
    strips.push({ mesh, mat, t0: start + lag, dur: (1.6 + ctx.rnd() * 0.6) * beat, kicks: [] });
  }
  base.dispose();
  return stripMotif(ctx, strips, soft);
};
