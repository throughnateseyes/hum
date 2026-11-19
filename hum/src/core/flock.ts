/**
 * Flock: a crowd of small bodies that steer by their neighbours (schools of fish, birds, leaves on a
 * gust, drifting plankton). One engine for every look made of many bodies, so each of them costs a
 * simulation step on the CPU and a single instanced draw on the GPU.
 *
 * Bodies live in a box centred on the origin (x right, y up, z toward the viewer). Each frame a body
 * looks at the neighbours in its grid cell and the cells around it and steers to keep its distance
 * (separation), match their heading (alignment) and stay with them (cohesion), plus whatever the look
 * adds: a point to gather round, a current to ride, a shove away from a point when a kick lands.
 *
 *   const flock = new Flock(1500, 7, { bounds: [4, 2.2, 1.2] });
 *   const geo = new THREE.InstancedBufferGeometry();  // your body mesh, plus:
 *   flock.bind(geo);                                  // aPos (vec3), aVel (vec3), aMisc (vec4: phase, seed, speed, age)
 *   // each frame
 *   flock.params.speed = 0.6 + feel.intensity;        // drive it from the music
 *   if (audio.kickHit) flock.shove(0, 0, 0, 1.5, 2);  // scatter from a point
 *   flock.step(dt);
 *   flock.sync(geo, Math.round(flock.n * amount));    // upload, draw the first N bodies
 *
 * In the vertex shader, `FLOCK_GLSL` gives `flockBasis(aVel)` to point a body along its heading.
 */
import * as THREE from 'three';

export interface FlockParams {
  /** half-size of the box the flock lives in (world units) */
  bounds: [number, number, number];
  /** cruising speed, units per second */
  speed: number;
  /** how far a body looks for neighbours */
  radius: number;
  /** steering weights */
  separation: number;
  alignment: number;
  cohesion: number;
  /** restless, individual wandering (0 = perfectly drilled, 1 = loose) */
  wander: number;
  /** how hard a body can turn (acceleration, units/s²) */
  agility: number;
  /** a current every body rides (added to its steering), e.g. the shared wind */
  flow: [number, number, number];
  /** pull toward `target` (0 = none) */
  gather: number;
  target: [number, number, number];
  /** bodies hold a ring of this radius round the target instead of piling onto it (0 = a point) */
  orbit: number;
}

export const FLOCK_DEFAULTS: FlockParams = {
  bounds: [4, 2.2, 1],
  speed: 1,
  radius: 0.45,
  separation: 1.4,
  alignment: 1,
  cohesion: 0.8,
  wander: 0.35,
  agility: 4,
  flow: [0, 0, 0],
  gather: 0,
  target: [0, 0, 0],
  orbit: 0,
};

/** GLSL for the vertex shader: the instanced attributes and a basis that points +x along the heading */
export const FLOCK_GLSL = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aMisc; // x swim phase (radians, advances with distance swum), y seed 0..1, z speed, w seconds alive
mat3 flockBasis(vec3 v) {
  vec3 f = normalize(v + vec3(1e-5, 0.0, 0.0));
  vec3 s = normalize(cross(f, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-5));
  vec3 u = cross(s, f);
  return mat3(f, u, s); // columns: forward, up, side
}
`;

/** neighbours a body takes into account (the nearest few it meets first) */
const MAX_NEIGHBOURS = 10;

export class Flock {
  readonly n: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** per body: swim phase, seed, speed, seconds alive */
  readonly misc: Float32Array;
  readonly params: FlockParams;
  private acc: Float32Array;
  private cellOf: Int32Array;
  private order: Int32Array;
  private cellStart = new Int32Array(0);
  private gx = 1;
  private gy = 1;
  private clock = 0;
  private attrs: THREE.InstancedBufferAttribute[] = [];

  constructor(n: number, seed = 1, params: Partial<FlockParams> = {}) {
    this.n = n;
    this.params = { ...FLOCK_DEFAULTS, ...params };
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.misc = new Float32Array(n * 4);
    this.acc = new Float32Array(n * 3);
    this.cellOf = new Int32Array(n);
    this.order = new Int32Array(n);
    let a = (seed * 0x9e3779b1) >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const [bx, by, bz] = this.params.bounds;
    for (let i = 0; i < n; i++) {
      this.pos[i * 3] = (rand() * 2 - 1) * bx;
      this.pos[i * 3 + 1] = (rand() * 2 - 1) * by;
      this.pos[i * 3 + 2] = (rand() * 2 - 1) * bz;
      const ang = rand() * Math.PI * 2;
      this.vel[i * 3] = Math.cos(ang) * this.params.speed;
      this.vel[i * 3 + 1] = Math.sin(ang) * this.params.speed * 0.4;
      this.vel[i * 3 + 2] = (rand() - 0.5) * 0.2;
      this.misc[i * 4] = rand() * Math.PI * 2;
      this.misc[i * 4 + 1] = rand();
      this.misc[i * 4 + 2] = this.params.speed;
      this.misc[i * 4 + 3] = 0;
    }
  }

  /** Push every body within `radius` of a point away from it (a kick, a drop, a predator). */
  shove(x: number, y: number, z: number, power: number, radius: number) {
    const { pos, vel, n } = this;
    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - x;
      const dy = pos[i * 3 + 1] - y;
      const dz = pos[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 1e-4;
      const k = (power * (1 - d / radius)) / d;
      vel[i * 3] += dx * k;
      vel[i * 3 + 1] += dy * k;
      vel[i * 3 + 2] += dz * k;
    }
  }

  /** Give every body a push in one direction (a gust), strongest for the ones it reaches first. */
  gust(x: number, y: number, z: number) {
    const { vel, misc, n } = this;
    for (let i = 0; i < n; i++) {
      const k = 0.6 + 0.8 * misc[i * 4 + 1];
      vel[i * 3] += x * k;
      vel[i * 3 + 1] += y * k;
      vel[i * 3 + 2] += z * k;
    }
  }

  step(dtRaw: number) {
    const dt = Math.min(Math.max(dtRaw, 0), 1 / 20);
    if (dt <= 0) return;
    this.clock += dt;
    const { n, pos, vel, acc, misc, params: p } = this;
    const [bx, by, bz] = p.bounds;
    const R = Math.max(0.05, p.radius);
    const R2 = R * R;
    const sepR = R * 0.55;

    /* sort bodies into a grid on x,y (the box is shallow in z, so depth only counts in the distance) */
    const gx = Math.max(1, Math.min(96, Math.ceil((bx * 2.4) / R)));
    const gy = Math.max(1, Math.min(96, Math.ceil((by * 2.4) / R)));
    if (gx !== this.gx || gy !== this.gy || this.cellStart.length !== gx * gy + 1) {
      this.gx = gx;
      this.gy = gy;
      this.cellStart = new Int32Array(gx * gy + 1);
    }
    const cs = this.cellStart;
    cs.fill(0);
    const cellOf = this.cellOf;
    for (let i = 0; i < n; i++) {
      const cx = Math.min(gx - 1, Math.max(0, Math.floor(((pos[i * 3] / (bx * 1.2)) * 0.5 + 0.5) * gx)));
      const cy = Math.min(gy - 1, Math.max(0, Math.floor(((pos[i * 3 + 1] / (by * 1.2)) * 0.5 + 0.5) * gy)));
      const c = cy * gx + cx;
      cellOf[i] = c;
      cs[c + 1]++;
    }
    for (let c = 0; c < gx * gy; c++) cs[c + 1] += cs[c];
    // counting sort: after this, cs[c + 1] is where cell c starts in `order` and cs[c + 2] (or n) where it ends
    const order = this.order;
    for (let i = n - 1; i >= 0; i--) order[--cs[cellOf[i] + 1]] = i;

    const t = this.clock;
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      const px = pos[ix];
      const py = pos[ix + 1];
      const pz = pos[ix + 2];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let cxs = 0;
      let cys = 0;
      let czs = 0;
      let cnt = 0;
      const c0 = cellOf[i];
      const cx0 = c0 % gx;
      const cy0 = (c0 - cx0) / gx;
      for (let oy = -1; oy <= 1 && cnt < MAX_NEIGHBOURS; oy++) {
        const cy = cy0 + oy;
        if (cy < 0 || cy >= gy) continue;
        for (let ox = -1; ox <= 1 && cnt < MAX_NEIGHBOURS; ox++) {
          const cx = cx0 + ox;
          if (cx < 0 || cx >= gx) continue;
          const c = cy * gx + cx;
          const end = c + 2 <= gx * gy ? cs[c + 2] : n;
          for (let k = cs[c + 1]; k < end && cnt < MAX_NEIGHBOURS; k++) {
            const j = order[k];
            if (j === i) continue;
            const jx = j * 3;
            const dx = pos[jx] - px;
            const dy = pos[jx + 1] - py;
            const dz = pos[jx + 2] - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > R2) continue;
            cnt++;
            ax += vel[jx];
            ay += vel[jx + 1];
            az += vel[jx + 2];
            cxs += dx;
            cys += dy;
            czs += dz;
            const d = Math.sqrt(d2) + 1e-4;
            if (d < sepR) {
              const push = (sepR - d) / (sepR * d);
              sx -= dx * push;
              sy -= dy * push;
              sz -= dz * push;
            }
          }
        }
      }
      const seed = misc[i * 4 + 1];
      let fx = p.flow[0];
      let fy = p.flow[1];
      let fz = p.flow[2];
      if (cnt > 0) {
        const inv = 1 / cnt;
        fx += (ax * inv - vel[ix]) * p.alignment + cxs * inv * p.cohesion * 2 + sx * p.separation * 3;
        fy += (ay * inv - vel[ix + 1]) * p.alignment + cys * inv * p.cohesion * 2 + sy * p.separation * 3;
        fz += (az * inv - vel[ix + 2]) * p.alignment + czs * inv * p.cohesion * 2 + sz * p.separation * 3;
      }
      // each body's own restlessness: a slow turning push, different for every seed
      const w = p.wander * p.speed * 2;
      const ph = seed * 61.7 + t * (0.5 + seed * 0.9);
      fx += Math.sin(ph * 1.3 + py * 1.1) * w;
      fy += Math.cos(ph * 0.9 + px * 0.8) * w * 0.6;
      fz += Math.sin(ph * 0.7 + 2.1) * w * 0.4;
      if (p.gather > 0) {
        let tx = p.target[0] - px;
        let ty = p.target[1] - py;
        const tz = p.target[2] - pz;
        if (p.orbit > 0) {
          // hold a ring: pulled in from outside it, pushed out from inside, and carried round it
          const d = Math.hypot(tx, ty) + 1e-4;
          const k = (d - p.orbit) / d;
          const swirl = p.orbit / d;
          const ox = -ty * swirl;
          const oy = tx * swirl;
          tx = tx * k + ox;
          ty = ty * k + oy;
        }
        fx += tx * p.gather;
        fy += ty * p.gather;
        fz += tz * p.gather;
      }
      // soft walls: steer back before the edge of the box
      const wall = p.agility * 1.5;
      const ex = Math.abs(px) / bx;
      const ey = Math.abs(py) / by;
      const ez = Math.abs(pz) / bz;
      if (ex > 0.8) fx -= Math.sign(px) * (ex - 0.8) * 5 * wall;
      if (ey > 0.8) fy -= Math.sign(py) * (ey - 0.8) * 5 * wall;
      if (ez > 0.8) fz -= Math.sign(pz) * (ez - 0.8) * 5 * wall;
      // a body can only turn so hard
      const fm = Math.hypot(fx, fy, fz);
      const lim = p.agility * (0.7 + 0.6 * seed);
      if (fm > lim) {
        const k = lim / fm;
        fx *= k;
        fy *= k;
        fz *= k;
      }
      acc[ix] = fx;
      acc[ix + 1] = fy;
      acc[ix + 2] = fz;
    }

    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      let vx = vel[ix] + acc[ix] * dt;
      let vy = vel[ix + 1] + acc[ix + 1] * dt;
      let vz = vel[ix + 2] + acc[ix + 2] * dt;
      // ease back to cruising speed (so a shove decays into a glide), a little different per body
      const sp = Math.hypot(vx, vy, vz) + 1e-5;
      const want = p.speed * (0.8 + 0.4 * misc[i * 4 + 1]);
      const ns = sp + (want - sp) * (1 - Math.exp(-dt * (sp > want ? 2.2 : 4)));
      const k = ns / sp;
      vx *= k;
      vy *= k;
      vz *= k;
      vel[ix] = vx;
      vel[ix + 1] = vy;
      vel[ix + 2] = vz;
      pos[ix] += vx * dt;
      pos[ix + 1] += vy * dt;
      pos[ix + 2] += vz * dt;
      misc[i * 4] += dt * (2 + ns * 7);
      misc[i * 4 + 2] = ns;
      misc[i * 4 + 3] += dt;
    }
  }

  /** Add the instanced attributes to a geometry (aPos, aVel, aMisc). */
  bind(geo: THREE.InstancedBufferGeometry) {
    const mk = (arr: Float32Array, size: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.attrs.push(a);
      return a;
    };
    geo.setAttribute('aPos', mk(this.pos, 3));
    geo.setAttribute('aVel', mk(this.vel, 3));
    geo.setAttribute('aMisc', mk(this.misc, 4));
    geo.instanceCount = this.n;
  }

  /** Upload this frame's bodies; `count` draws only the first so many (thin the flock in quiet parts). */
  sync(geo?: THREE.InstancedBufferGeometry, count = this.n) {
    for (const a of this.attrs) a.needsUpdate = true;
    if (geo) geo.instanceCount = Math.max(0, Math.min(this.n, Math.round(count)));
  }
}
