/**
 * Undercode's figure: an anonymous mannequin built from 19 tapered capsules (round cones), posed by a
 * handful of joint angles and blended between poses. No face, no likeness: a body plan and a stance.
 *
 * World units are metres, y up, the figure stands on y = 0 facing +z (toward the camera at rest).
 * `solve` turns a pose into primitives (two vec4 per capsule: end a + radius, end b + radius) for the
 * figure shader, plus the right hand's position (where objects gather) and a bounding box.
 */

/* pose channels (all angles in radians): Lift (m off the ground), Crouch (m), Yaw, Lean (+ forward), Tilt,
   HeadPitch (+ down), HeadYaw, arms R then L (raise forward, spread, elbow bend, wrist), legs R then L
   (hip lift forward, spread, knee), Breath 0..1 */
export const J = {
  Lift: 0,
  Crouch: 1,
  Yaw: 2,
  Lean: 3,
  Tilt: 4,
  HeadPitch: 5,
  HeadYaw: 6,
  RRaise: 7,
  RSpread: 8,
  RBend: 9,
  RWrist: 10,
  LRaise: 11,
  LSpread: 12,
  LBend: 13,
  LWrist: 14,
  RLegLift: 15,
  RLegSpread: 16,
  RKnee: 17,
  LLegLift: 18,
  LLegSpread: 19,
  LKnee: 20,
  Breath: 21,
  COUNT: 22,
} as const;

export type Pose = Float32Array;

function pose(o: Partial<Record<keyof typeof POSE_KEYS, number>>): Pose {
  const p = new Float32Array(J.COUNT);
  for (const [k, v] of Object.entries(o)) p[POSE_KEYS[k as keyof typeof POSE_KEYS]] = v as number;
  return p;
}
const POSE_KEYS = {
  lift: J.Lift,
  crouch: J.Crouch,
  yaw: J.Yaw,
  lean: J.Lean,
  tilt: J.Tilt,
  headPitch: J.HeadPitch,
  headYaw: J.HeadYaw,
  rRaise: J.RRaise,
  rSpread: J.RSpread,
  rBend: J.RBend,
  rWrist: J.RWrist,
  lRaise: J.LRaise,
  lSpread: J.LSpread,
  lBend: J.LBend,
  lWrist: J.LWrist,
  rLegLift: J.RLegLift,
  rLegSpread: J.RLegSpread,
  rKnee: J.RKnee,
  lLegLift: J.LLegLift,
  lLegSpread: J.LLegSpread,
  lKnee: J.LKnee,
} as const;

/** the stances. Each part of the song picks one (see the scene's poseFor) */
export const POSES = {
  // standing, weight on one leg, head a little bowed: the quiet figure
  stand: pose({ lean: 0.02, tilt: 0.02, headPitch: 0.22, rRaise: 0.04, rSpread: 0.13, rBend: 0.18, lRaise: 0.02, lSpread: 0.12, lBend: 0.12, rLegLift: 0.04, rLegSpread: 0.07, rKnee: 0.04, lLegLift: 0.1, lLegSpread: 0.05, lKnee: 0.2 }),
  // looking up and away, one hand loose: the verse's other beat
  look: pose({ yaw: -0.45, lean: -0.03, tilt: -0.03, headPitch: -0.2, headYaw: 0.55, rRaise: 0.12, rSpread: 0.16, rBend: 0.35, lRaise: -0.06, lSpread: 0.1, lBend: 0.1, rLegLift: 0.12, rLegSpread: 0.08, rKnee: 0.18, lLegLift: -0.04, lLegSpread: 0.06, lKnee: 0.04 }),
  // one hand raised, palm out, holding the world back: the build and the frozen moment
  halt: pose({ yaw: -0.3, lean: 0.05, crouch: 0.05, headPitch: 0.04, headYaw: 0.18, rRaise: 1.3, rSpread: 0.18, rBend: 0.22, rWrist: 1.25, lRaise: -0.32, lSpread: 0.3, lBend: 0.45, lWrist: 0.2, rLegLift: 0.32, rLegSpread: 0.1, rKnee: 0.22, lLegLift: -0.22, lLegSpread: 0.12, lKnee: 0.18 }),
  // suspended mid-leap: arms flung wide, one knee up, the other leg trailing
  leap: pose({ lift: 0.55, lean: -0.18, tilt: 0.06, headPitch: -0.28, rRaise: 0.55, rSpread: 1.55, rBend: 0.25, lRaise: 0.35, lSpread: 1.7, lBend: 0.2, rLegLift: 1.25, rLegSpread: 0.1, rKnee: 1.7, lLegLift: -0.5, lLegSpread: 0.08, lKnee: 0.75 }),
  // floating, gravity let go: arms open and low, legs loose, face up
  float: pose({ lift: 0.45, lean: -0.08, tilt: 0.1, headPitch: -0.5, rRaise: 0.3, rSpread: 1.3, rBend: 0.35, rWrist: 0.3, lRaise: 0.15, lSpread: 1.4, lBend: 0.3, lWrist: 0.3, rLegLift: 0.5, rLegSpread: 0.08, rKnee: 0.95, lLegLift: 0.1, lLegSpread: 0.06, lKnee: 1.15 }),
  // down on one knee, one hand on the ground: the break
  kneel: pose({ crouch: 0.5, lean: 0.38, headPitch: 0.5, yaw: 0.35, rRaise: 0.5, rSpread: 0.14, rBend: 0.1, rWrist: -0.5, lRaise: 0.75, lSpread: 0.22, lBend: 1.0, rLegLift: 1.4, rLegSpread: 0.14, rKnee: 1.4, lLegLift: 0.35, lLegSpread: 0.08, lKnee: 1.85 }),
} as const;
export type PoseId = keyof typeof POSES;

/* ───────── tiny 3D maths (no allocations per frame) ───────── */

type V3 = [number, number, number];
type M3 = Float64Array; // row-major 3 × 3

const m3 = () => new Float64Array(9);
function rotX(o: M3, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  o.set([1, 0, 0, 0, c, -s, 0, s, c]);
  return o;
}
function rotY(o: M3, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  o.set([c, 0, s, 0, 1, 0, -s, 0, c]);
  return o;
}
function rotZ(o: M3, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  o.set([c, -s, 0, s, c, 0, 0, 0, 1]);
  return o;
}
function mul(o: M3, a: M3, b: M3) {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  o.set(r);
  return o;
}
function app(m: M3, x: number, y: number, z: number): V3 {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

export const PRIMS = 19;

export interface Solved {
  /** PRIMS × 4: end a (xyz) + radius */
  a: Float32Array;
  b: Float32Array;
  hand: V3;
  /** palm direction of the right hand (unit), where objects come from */
  palm: V3;
  chest: V3;
  min: V3;
  max: V3;
}

export function makeSolved(): Solved {
  return { a: new Float32Array(PRIMS * 4), b: new Float32Array(PRIMS * 4), hand: [0, 0, 0], palm: [0, 0, 1], chest: [0, 1.3, 0], min: [0, 0, 0], max: [0, 0, 0] };
}

const Rb = m3(), Rt = m3(), Rp = m3(), Rh = m3(), T1 = m3(), T2 = m3(), T3 = m3(), Ra = m3(), Rf = m3();

/** forward kinematics: pose → capsules. `root` places the figure (x, z on the ground; y is added to the pose's lift) */
export function solve(p: Pose, root: V3, out: Solved) {
  let n = 0;
  const minV: V3 = [1e9, 1e9, 1e9];
  const maxV: V3 = [-1e9, -1e9, -1e9];
  const prim = (a: V3, ra: number, b: V3, rb: number) => {
    out.a.set([a[0], a[1], a[2], ra], n * 4);
    out.b.set([b[0], b[1], b[2], rb], n * 4);
    n++;
    for (let k = 0; k < 3; k++) {
      minV[k] = Math.min(minV[k], a[k] - ra, b[k] - rb);
      maxV[k] = Math.max(maxV[k], a[k] + ra, b[k] + rb);
    }
  };
  const breath = p[J.Breath];
  rotY(Rb, p[J.Yaw]);
  mul(Rt, Rb, mul(T1, rotX(T2, p[J.Lean]), rotZ(T3, p[J.Tilt])));
  mul(Rp, Rb, rotX(T1, p[J.Lean] * 0.25));
  const pelvis: V3 = [root[0], root[1] + 0.98 - p[J.Crouch] + p[J.Lift], root[2]];
  const T = (x: number, y: number, z: number) => add(pelvis, app(Rt, x, y, z));
  const Pp = (x: number, y: number, z: number) => add(pelvis, app(Rp, x, y, z));

  // torso: belly, two chest masses (wider than deep), neck, head
  const sw = 1 + 0.04 * breath;
  prim(T(0, 0.02, 0), 0.112, T(0, 0.25, 0.005), 0.122 * sw);
  prim(T(-0.072, 0.27, 0.0), 0.112 * sw, T(-0.088, 0.45 + 0.01 * breath, -0.005), 0.118 * sw);
  prim(T(0.072, 0.27, 0.0), 0.112 * sw, T(0.088, 0.45 + 0.01 * breath, -0.005), 0.118 * sw);
  prim(T(0, 0.5, 0), 0.05, T(0, 0.61, 0.012), 0.044);
  mul(Rh, Rt, mul(T1, rotY(T2, p[J.HeadYaw]), rotX(T3, p[J.HeadPitch])));
  const neckTop = T(0, 0.62, 0.01);
  const hc = add(neckTop, app(Rh, 0, 0.12, 0.015));
  prim(add(hc, app(Rh, 0, -0.04, 0.018)), 0.088, add(hc, app(Rh, 0, 0.035, -0.012)), 0.1);
  out.chest = T(0, 0.38, 0.05);
  // where the open hand faces: the body's front
  out.palm = app(Rt, 0, 0, 1);

  // pelvis
  prim(Pp(-0.06, 0.05, 0), 0.118, Pp(-0.095, -0.04, 0), 0.105);
  prim(Pp(0.06, 0.05, 0), 0.118, Pp(0.095, -0.04, 0), 0.105);

  // arms: side −1 is the figure's right (screen left at rest)
  for (const side of [-1, 1] as const) {
    const o = side < 0 ? J.RRaise : J.LRaise;
    const raise = p[o], spread = p[o + 1], bend = p[o + 2], wrist = p[o + 3];
    const S = T(side * 0.19, 0.49 + 0.012 * breath, -0.01);
    mul(Ra, Rt, mul(T1, rotZ(T2, side * spread), rotX(T3, -raise)));
    const E = add(S, app(Ra, 0, -0.29, 0));
    mul(Rf, Ra, rotX(T1, -bend));
    const W = add(E, app(Rf, 0, -0.265, 0));
    mul(T2, Rf, rotX(T1, -wrist));
    const hd = app(T2, 0, -1, 0);
    const Hn = add(W, scl(hd, 0.09));
    prim(S, 0.054, E, 0.043);
    prim(E, 0.043, W, 0.031);
    prim(add(W, scl(hd, 0.012)), 0.033, Hn, 0.027);
    if (side < 0) out.hand = add(W, scl(hd, 0.06));
  }

  // legs
  for (const side of [-1, 1] as const) {
    const o = side < 0 ? J.RLegLift : J.LLegLift;
    const lift = p[o], spread = p[o + 1], knee = p[o + 2];
    const Hp = Pp(side * 0.095, -0.05, 0);
    mul(Ra, Rp, mul(T1, rotZ(T2, side * spread), rotX(T3, -lift)));
    const K = add(Hp, app(Ra, 0, -0.44, 0));
    mul(Rf, Ra, rotX(T1, knee));
    const A = add(K, app(Rf, 0, -0.44, 0));
    // the foot points forward, flexed a little with the knee
    mul(T2, Rf, rotX(T1, -Math.PI / 2 + 0.15 - 0.25 * Math.min(1, knee)));
    const fd = app(T2, 0, -1, 0);
    prim(Hp, 0.085, K, 0.056);
    prim(K, 0.056, A, 0.038);
    prim(add(A, scl(fd, -0.035)), 0.04, add(A, scl(fd, 0.16)), 0.03);
  }

  out.min = minV;
  out.max = maxV;
  return out;
}

/** blend `cur` toward `target` (per channel, exponential) */
export function blendPose(cur: Pose, target: Pose, k: number) {
  for (let i = 0; i < J.COUNT; i++) if (i !== J.Breath) cur[i] += (target[i] - cur[i]) * k;
}

export function copyPose(p: Pose): Pose {
  return new Float32Array(p);
}
