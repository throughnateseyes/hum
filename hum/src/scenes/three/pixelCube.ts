/**
 * Pixel Cube — a chunky 3×3 puzzle cube on a flat pastel poster. Each face is a 12×12 pixel
 * picture drawn from the music (spectrum, waveform, a kick ripple, a little face, the beat
 * number, a loudness history). Layers turn on the beat — scrambling the pictures — then the
 * cube solves itself back so they read again. Drops send the whole cube tumbling. Small poster
 * type (date, title, artist), corner brackets, dot clusters and rules sit around it.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { approach, stepDt } from './common';
import { dropEdge, FONT_SANS, songInfo } from './songInfo';

const PX = 12; // pixels per face edge (4 per sticker)
const SP = 1.03; // cubie spacing

const params: ParamDef[] = [
  {
    id: 'every',
    label: 'Turn every',
    group: 'Motion',
    type: 'select',
    default: '1',
    options: [
      { value: '0.5', label: '½ beat' },
      { value: '1', label: 'Beat' },
      { value: '2', label: '2 beats' },
      { value: '4', label: 'Bar' },
    ],
  },
  { id: 'depth', label: 'Scramble depth', group: 'Motion', type: 'number', min: 1, max: 16, step: 1, default: 6, hint: 'Moves before the cube solves itself again' },
  { id: 'hold', label: 'Hold solved', group: 'Motion', type: 'number', min: 0, max: 16, step: 1, default: 6, hint: 'Beats the solved cube rests before scrambling again' },
  { id: 'spin', label: 'Idle spin', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
  { id: 'tumble', label: 'Drop tumble', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  { id: 'pop', label: 'Kick pop', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'size', label: 'Cube size', group: 'Style', type: 'number', min: 0.5, max: 1.5, step: 0.01, default: 1 },
  { id: 'grid', label: 'Pixel grid', group: 'Style', type: 'number', min: 0, max: 0.25, step: 0.01, default: 0.03 },
  { id: 'poster', label: 'Poster type', group: 'Style', type: 'bool', default: true },
];

/* ───────── pixel faces ───────── */

// 3×5 digits, rows top→bottom
const DIGITS: Record<string, string[]> = {
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
};

interface Faces {
  /** 6 faces × PX × PX colour indices: 0 dark, 1 ink (yellow), 2 light */
  px: Uint8Array;
}

function drawFaces(f: Faces, a: FrameContext['audio'], hist: Float32Array, histHead: number, sinceKick: number, blink: number) {
  const px = f.px;
  const set = (face: number, x: number, y: number, c: number) => {
    if (x < 0 || y < 0 || x >= PX || y >= PX) return;
    px[face * PX * PX + y * PX + x] = c;
  };
  const fill = (face: number, c: number) => px.fill(c, face * PX * PX, (face + 1) * PX * PX);

  // 0 front (+z): spectrum bars, peak pixel light
  fill(0, 0);
  for (let x = 0; x < PX; x++) {
    const s = a.spectrum[Math.min(127, 3 + Math.floor((x / PX) * 84))];
    const h = Math.round(Math.pow(s, 1.2) * PX);
    for (let y = 0; y < h; y++) set(0, x, y, y === h - 1 ? 2 : 1);
  }
  // 1 top (+y): waveform line, dark on ink
  fill(1, 1);
  let prevY = -1;
  for (let x = 0; x < PX; x++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v += a.waveform[Math.floor(((x * 8 + k) / (PX * 8)) * 300)];
    v /= 8;
    const y = Math.max(0, Math.min(PX - 1, Math.round((v * 2.2 * 0.5 + 0.5) * (PX - 1))));
    if (prevY >= 0) for (let yy = Math.min(prevY, y); yy <= Math.max(prevY, y); yy++) set(1, x, yy, 0);
    set(1, x, y, 0);
    prevY = y;
  }
  // 2 right (+x): square ripples from the centre on kicks
  fill(2, 0);
  const r = sinceKick * 14;
  for (let y = 0; y < PX; y++)
    for (let x = 0; x < PX; x++) {
      const d = Math.max(Math.abs(x - 5.5), Math.abs(y - 5.5));
      if (Math.abs(d - r) < 0.75 && r < 9) set(2, x, y, 2);
      else if (Math.abs(d - (r - 3.5)) < 0.6 && r < 12 && r > 3.5) set(2, x, y, 1);
    }
  if (sinceKick < 0.12) for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) set(2, x, y, 1);
  // 3 back (-z): a little face, mouth opens with the level, blinks on snares
  fill(3, 0);
  for (let y = 0; y < PX; y++)
    for (let x = 0; x < PX; x++) if (Math.hypot(x - 5.5, y - 5.5) < 5.6) set(3, x, y, 1);
  const eyeH = blink > 0 ? 1 : 2;
  for (let k = 0; k < eyeH; k++) {
    set(3, 3, 7 + k, 0);
    set(3, 8, 7 + k, 0);
  }
  const open = Math.min(3, Math.round(a.level * 4.5));
  for (let x = 4; x <= 7; x++) set(3, x, 3, 0);
  for (let k = 1; k <= open; k++) for (let x = 4; x <= 7; x++) set(3, x, 3 - k, k === open ? 0 : 2);
  set(3, 3, 4, 0);
  set(3, 8, 4, 0);
  // 4 bottom (-y): the beat in the bar, big
  fill(4, 0);
  const dg = DIGITS[String((a.beatCount % 4) + 1)];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if (dg[y][x] === '1') for (let k = 0; k < 4; k++) set(4, 3 + x * 2 + (k & 1), 10 - y * 2 - (k >> 1), 1);
  // 5 left (-x): loudness history, light bars on ink
  fill(5, 1);
  for (let x = 0; x < PX; x++) {
    const v = hist[(histHead - (PX - 1 - x) + PX * 4) % PX];
    const h = Math.round(v * PX);
    for (let y = 0; y < h; y++) set(5, x, y, y === h - 1 ? 0 : 2);
  }
}

/* ───────── poster ───────── */

function drawPoster(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  pal: FrameContext['palette'],
  o: { title: string; artist: string; prog: number; kick: number; hatBits: number; spec: Float32Array; showType: boolean },
) {
  const u = Math.min(w, h * 0.75) / 100;
  const m = 6 * u;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = pal.fg;
  ctx.strokeStyle = pal.fg;
  const dot = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // corner brackets (top right), tightening on kicks
  const bs = 14 * u;
  const bx = w - m - bs;
  const by = m;
  const inset = o.kick * 1.2 * u;
  const arm = 4 * u;
  ctx.lineWidth = 0.45 * u;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  const corners: [number, number, number, number][] = [
    [bx + inset, by + inset, 1, 1],
    [bx + bs - inset, by + inset, -1, 1],
    [bx + inset, by + bs - inset, 1, -1],
    [bx + bs - inset, by + bs - inset, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.moveTo(x + sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * arm);
  }
  ctx.stroke();

  // a cluster of dots on the left that re-deals on hats
  for (let i = 0; i < 6; i++) {
    const on = (o.hatBits >> i) & 1;
    const cx = m + (i % 3) * 3.2 * u;
    const cy = 33 * u + Math.floor(i / 3) * 3.2 * u;
    if (on || i === 0) dot(cx, cy, 0.85 * u);
  }
  dot(m, 42 * u, 0.85 * u);

  // halftone patch whose dots swell with the spectrum (bottom right)
  const hx = w - m - 10 * u;
  const hy = h - 30 * u;
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 5; x++) {
      const s = o.spec[8 + x * 14 + y * 3] ?? 0;
      dot(hx + x * 2.4 * u, hy + y * 2.4 * u, (0.25 + s * 0.75) * u);
    }
  // a few loose dots
  dot(w * 0.42, h - 13 * u, 0.4 * u);
  dot(w * 0.5, h - 13 * u, 0.4 * u);
  dot(w * 0.58, h - 13 * u, 0.4 * u);

  if (!o.showType) return;
  // date + braille-ish dots + rule (top left)
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }).toLowerCase();
  ctx.font = `500 ${3.6 * u}px ${FONT_SANS}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(date, m, m + 3.6 * u);
  for (let i = 0; i < 5; i++) if (i !== 2) dot(m + i * 1.6 * u + 0.4 * u, m + 6.2 * u, 0.32 * u);
  ctx.fillRect(m, m + 13 * u, 14 * u, 0.4 * u);

  // title + artist, then a rule with the song position as a heavy chunk (bottom left)
  const tSize = 5.4 * u;
  ctx.font = `500 ${tSize}px ${FONT_SANS}`;
  let title = o.title.replace(/\.+$/, '') + '.';
  const maxW = w * 0.45;
  while (ctx.measureText(title).width > maxW && title.length > 4) title = title.slice(0, -2).trimEnd() + '.';
  ctx.fillText(title, m, h - m - 8.5 * u);
  ctx.font = `500 ${3.2 * u}px ${FONT_SANS}`;
  ctx.fillText(o.artist.toLowerCase(), m, h - m - 3.6 * u);
  const ruleW = Math.min(w * 0.42, 44 * u);
  ctx.fillRect(m, h - m, ruleW, 0.3 * u);
  const chunk = 6 * u;
  ctx.fillRect(m + (ruleW - chunk) * o.prog, h - m - 0.5 * u, chunk, 1.3 * u);
}

/* ───────── scene ───────── */

interface Cubie {
  obj: THREE.Group;
  pos: THREE.Vector3;
}

type Move = { axis: 0 | 1 | 2; layer: number; dir: number };

const easeBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

const STICKER_VERT = /* glsl */ `
attribute vec2 aLocal;
varying vec2 vA;
varying vec2 vL;
varying vec3 vN;
void main() {
  vA = uv;
  vL = aLocal;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const STICKER_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uGrid;
uniform vec3 uGridCol;
varying vec2 vA;
varying vec2 vL;
varying vec3 vN;
void main() {
  vec2 l = vL - 0.5;
  vec2 b = vec2(0.5);
  float rr = 0.13;
  vec2 qd = max(abs(l) - b + rr, 0.0);
  if (length(qd) - rr > 0.0) discard;
  vec3 c = texture2D(uAtlas, vA).rgb;
  vec2 pc = fract(vA * vec2(${(PX * 6).toFixed(1)}, ${PX.toFixed(1)}));
  float g = step(pc.x, uGrid) + step(pc.y, uGrid);
  c = mix(c, uGridCol, clamp(g, 0.0, 1.0) * 0.4);
  vec3 n = normalize(vN);
  float lit = 0.8 + 0.28 * max(dot(n, normalize(vec3(-0.35, 0.55, 0.75))), 0.0);
  float spec = pow(max(dot(n, normalize(vec3(0.25, 0.45, 1.0))), 0.0), 40.0) * 0.18;
  gl_FragColor = vec4(c * lit + spec, 1.0);
}
`;

export const pixelCube: SceneDef = {
  id: 'pixel-cube',
  name: 'Pixel Cube',
  description:
    'A chunky 3×3 puzzle cube on a pastel poster. Each face is pixel art drawn from the music; layers turn on the beat, scrambling the pictures, then the cube solves itself so they read again. Drops send it tumbling.',
  category: 'form',
  style: 'form',
  tags: ['playful', 'bouncy', 'pop', 'graphic', 'upbeat', 'house', 'energetic', 'tactile'],
  light: true,
  params,
  create() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 16);

    /* poster backdrop */
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const posterTex = new THREE.CanvasTexture(canvas);
    posterTex.colorSpace = THREE.NoColorSpace;
    posterTex.minFilter = THREE.LinearFilter;
    posterTex.generateMipmaps = false;
    scene.background = posterTex;

    /* light */
    scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(-4, 6, 8);
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(6, -2, 4);
    scene.add(key, rim);

    /* atlas: 6 faces side by side */
    const faces: Faces = { px: new Uint8Array(6 * PX * PX) };
    const atlasData = new Uint8Array(PX * 6 * PX * 4);
    const atlas = new THREE.DataTexture(atlasData, PX * 6, PX, THREE.RGBAFormat);
    atlas.magFilter = THREE.NearestFilter;
    atlas.minFilter = THREE.NearestFilter;
    atlas.generateMipmaps = false;
    atlas.colorSpace = THREE.NoColorSpace;

    const stickerMat = new THREE.ShaderMaterial({
      vertexShader: STICKER_VERT,
      fragmentShader: STICKER_FRAG,
      uniforms: { uAtlas: { value: atlas }, uGrid: { value: 0.07 }, uGridCol: { value: new THREE.Color() } },
    });
    const bodyMat = new THREE.MeshPhongMaterial({ shininess: 38, specular: new THREE.Color(0x2a2a2a) });
    const bodyGeo = new RoundedBoxGeometry(0.97, 0.97, 0.97, 4, 0.16);

    const root = new THREE.Group(); // positioned on the poster
    const tumble = new THREE.Group(); // drop tumble + kick pop
    const cube = new THREE.Group(); // holds cubies
    const pivot = new THREE.Group();
    root.add(tumble);
    tumble.add(cube);
    cube.add(pivot);
    scene.add(root);

    // sticker face orientation: plane rotation + how (x,y,z) maps to the face picture's (col,row)
    const FACE_DEF: { n: THREE.Vector3; rot: (g: THREE.BufferGeometry) => void; cr: (p: THREE.Vector3) => [number, number] }[] = [
      { n: new THREE.Vector3(0, 0, 1), rot: () => {}, cr: (p) => [p.x + 1, p.y + 1] },
      { n: new THREE.Vector3(0, 1, 0), rot: (g) => g.rotateX(-Math.PI / 2), cr: (p) => [p.x + 1, -p.z + 1] },
      { n: new THREE.Vector3(1, 0, 0), rot: (g) => g.rotateY(Math.PI / 2), cr: (p) => [-p.z + 1, p.y + 1] },
      { n: new THREE.Vector3(0, 0, -1), rot: (g) => g.rotateY(Math.PI), cr: (p) => [-p.x + 1, p.y + 1] },
      { n: new THREE.Vector3(0, -1, 0), rot: (g) => g.rotateX(Math.PI / 2), cr: (p) => [p.x + 1, p.z + 1] },
      { n: new THREE.Vector3(-1, 0, 0), rot: (g) => g.rotateY(-Math.PI / 2), cr: (p) => [p.z + 1, p.y + 1] },
    ];

    const cubies: Cubie[] = [];
    const ownGeos: THREE.BufferGeometry[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const p = new THREE.Vector3(x, y, z);
          const obj = new THREE.Group();
          obj.position.copy(p).multiplyScalar(SP);
          obj.add(new THREE.Mesh(bodyGeo, bodyMat));
          FACE_DEF.forEach((fd, fi) => {
            if (p.dot(fd.n) < 0.5) return;
            const g = new THREE.PlaneGeometry(0.8, 0.8);
            const uv = g.attributes.uv.array as Float32Array;
            g.setAttribute('aLocal', new THREE.BufferAttribute(uv.slice(), 2));
            const [c, r] = fd.cr(p);
            for (let i = 0; i < uv.length; i += 2) {
              uv[i] = (fi * PX + (c + uv[i]) * (PX / 3)) / (PX * 6);
              uv[i + 1] = (r + uv[i + 1]) / 3;
            }
            fd.rot(g);
            g.translate(fd.n.x * 0.487, fd.n.y * 0.487, fd.n.z * 0.487);
            ownGeos.push(g);
            obj.add(new THREE.Mesh(g, stickerMat));
          });
          cube.add(obj);
          cubies.push({ obj, pos: p.clone() });
        }

    /* crosshair overlay */
    const overlay = new THREE.Scene();
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const crossMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true });
    const crossH = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), crossMat);
    const crossV = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), crossMat);
    const cross = new THREE.Group();
    cross.add(crossH, crossV);
    overlay.add(cross);

    /* state */
    const stack: Move[] = [];
    let move: (Move & { t: number; dur: number }) | null = null;
    let solving = false;
    let holdLeft = 4;
    let nextBeat = -1;
    const hist = new Float32Array(PX);
    let histHead = 0;
    let sinceKick = 10;
    let blink = 0;
    let pop = 0;
    let tumbleT = 1;
    const tumbleAxis = new THREE.Vector3(1, 0, 0);
    const tumbleQ = new THREE.Quaternion();
    let hatBits = 0b101101;
    let posterAcc = 1;
    let lastPosterKey = '';
    const isDrop = dropEdge();
    const m4 = new THREE.Matrix4();
    const centre = new THREE.Vector3();

    const startMove = (mv: Move, beatSec: number) => {
      cube.updateMatrixWorld(true);
      pivot.rotation.set(0, 0, 0);
      pivot.updateMatrixWorld(true);
      for (const c of cubies) if (Math.round(c.pos.getComponent(mv.axis)) === mv.layer) pivot.attach(c.obj);
      move = { ...mv, t: 0, dur: Math.min(0.34, Math.max(0.16, beatSec * 0.55)) };
    };
    const endMove = () => {
      if (!move) return;
      const ax = ['x', 'y', 'z'] as const;
      pivot.rotation[ax[move.axis]] = (move.dir * Math.PI) / 2;
      pivot.updateMatrixWorld(true);
      for (const c of [...pivot.children]) cube.attach(c);
      for (const c of cubies) {
        c.obj.position.set(Math.round(c.obj.position.x / SP) * SP, Math.round(c.obj.position.y / SP) * SP, Math.round(c.obj.position.z / SP) * SP);
        c.pos.copy(c.obj.position).divideScalar(SP).round();
        // snap the rotation to exact quarter turns so error never builds up
        m4.makeRotationFromQuaternion(c.obj.quaternion);
        const e = m4.elements;
        for (let i = 0; i < 16; i++) e[i] = Math.round(e[i]);
        c.obj.quaternion.setFromRotationMatrix(m4);
      }
      pivot.rotation.set(0, 0, 0);
      move = null;
    };
    const randomMove = (): Move => {
      const last = stack[stack.length - 1];
      for (;;) {
        const mv: Move = { axis: (Math.floor(Math.random() * 3) as 0 | 1 | 2), layer: Math.floor(Math.random() * 3) - 1, dir: Math.random() < 0.5 ? -1 : 1 };
        if (!last || last.axis !== mv.axis || last.layer !== mv.layer) return mv;
      }
    };

    function update(frame: FrameContext) {
      const dt = stepDt(frame);
      const a = frame.audio;
      const p = frame.params;
      const pal = frame.palette;
      const bps = a.bpm > 0 ? a.bpm / 60 : 2;

      /* colours */
      bodyMat.color.copy(pal.c.accent);
      (stickerMat.uniforms.uGridCol.value as THREE.Color).copy(pal.c.fg);
      stickerMat.uniforms.uGrid.value = num(p, 'grid', 0.07);
      crossMat.color.copy(pal.c.muted);

      /* music → pixels */
      sinceKick = a.kickHit ? 0 : sinceKick + dt;
      blink = a.snareHit ? 0.12 : Math.max(0, blink - dt);
      // loudness history ticks 6× a second
      const tick = Math.floor(frame.time * 6);
      if (tick !== histHead) {
        histHead = tick;
        hist[tick % PX] = Math.min(1, a.level * 1.1);
      }
      drawFaces(faces, a, hist, histHead % PX, sinceKick, blink);
      const cols = [pal.c.fg, pal.c.accent2, pal.c.muted];
      for (let f = 0; f < 6; f++)
        for (let y = 0; y < PX; y++)
          for (let x = 0; x < PX; x++) {
            const c = cols[faces.px[f * PX * PX + y * PX + x]];
            const o = (y * PX * 6 + f * PX + x) * 4;
            atlasData[o] = c.r * 255;
            atlasData[o + 1] = c.g * 255;
            atlasData[o + 2] = c.b * 255;
            atlasData[o + 3] = 255;
          }
      atlas.needsUpdate = true;

      /* turns on the beat */
      const every = parseFloat(str(p, 'every', '1')) || 1;
      const beatPos = Math.floor((a.beatCount + a.beatPhase) / every);
      if (move) {
        move.t += dt / move.dur;
        const ax = ['x', 'y', 'z'] as const;
        if (move.t >= 1) endMove();
        else pivot.rotation[ax[move.axis]] = ((move.dir * Math.PI) / 2) * easeBack(move.t);
      }
      const beatNow = a.playing ? beatPos : Math.floor(frame.time * 1.2);
      if (beatNow !== nextBeat) {
        nextBeat = beatNow;
        if (!move) {
          const depth = Math.round(num(p, 'depth', 6));
          if (holdLeft > 0) holdLeft--;
          else if (solving) {
            const mv = stack.pop();
            if (mv) startMove({ ...mv, dir: -mv.dir }, every / bps);
            if (!stack.length) {
              solving = false;
              holdLeft = Math.round(num(p, 'hold', 6) / every);
            }
          } else {
            const mv = randomMove();
            stack.push(mv);
            startMove(mv, every / bps);
            if (stack.length >= depth) solving = true;
          }
        }
      }

      /* drop tumble, kick pop */
      if (isDrop(frame) && num(p, 'tumble', 1) > 0) {
        tumbleT = 0;
        tumbleAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      }
      if (tumbleT < 1) {
        tumbleT = Math.min(1, tumbleT + dt / 1.3);
        const e = 1 - Math.pow(1 - tumbleT, 3);
        tumbleQ.setFromAxisAngle(tumbleAxis, e * Math.PI * 2 * num(p, 'tumble', 1));
        tumble.quaternion.copy(tumbleQ);
      } else tumble.quaternion.identity();
      pop = approach(pop, 0, 9, dt);
      if (a.kickHit) pop = Math.max(pop, a.kick);
      const tumbleBoost = tumbleT < 1 ? Math.sin(tumbleT * Math.PI) * 0.12 : 0;
      tumble.scale.setScalar(1 + pop * 0.07 * num(p, 'pop', 0.5) + tumbleBoost);

      /* idle spin + poster placement */
      const spin = num(p, 'spin', 0.35);
      const t = frame.time;
      cube.rotation.set(0.52 + Math.sin(t * 0.21) * 0.12 * spin + a.sway * 0.04, -0.72 + t * 0.12 * spin, 0.22 + Math.sin(t * 0.17) * 0.06 * spin);
      const asp = frame.aspect;
      const size = num(p, 'size', 1);
      const vh = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      const fit = Math.min(vh, (vh * asp) / 1.15) * 0.165 * size;
      root.scale.setScalar(fit);
      root.position.set(asp > 1 ? vh * asp * 0.1 : vh * asp * 0.08, asp > 1 ? -vh * 0.02 : vh * 0.02, 0);

      /* crosshair at the cube's centre, on top */
      root.updateMatrixWorld(true);
      centre.setFromMatrixPosition(root.matrixWorld).project(camera);
      const ch = 0.045 * (1 + pop * 0.4);
      const lw = 0.0032 * 2;
      cross.position.set(centre.x, centre.y, 0);
      crossH.scale.set(ch * 2 / asp, lw, 1);
      crossV.scale.set(lw / asp, ch * 2, 1);
      crossMat.opacity = 0.95;

      /* poster (redrawn ~20×/s when something changed) */
      if (a.hatHit) hatBits = (Math.random() * 64) | 1;
      posterAcc += dt;
      const w = Math.max(2, Math.round(frame.width * 0.75));
      const h = Math.max(2, Math.round(frame.height * 0.75));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        posterAcc = 1;
        lastPosterKey = '';
        posterTex.dispose();
      }
      if (posterAcc > 0.05) {
        posterAcc = 0;
        const info = songInfo();
        const prog = a.duration > 0 ? a.time / a.duration : 0;
        const k = `${info.title}|${info.artist}|${prog.toFixed(3)}|${pop.toFixed(2)}|${hatBits}|${a.spectrum[20].toFixed(2)}|${pal.bg}${pal.fg}|${p.poster}|${document.fonts?.status}`;
        if (k !== lastPosterKey) {
          lastPosterKey = k;
          drawPoster(ctx, w, h, pal, { title: info.title, artist: info.artist, prog, kick: pop, hatBits, spec: a.spectrum, showType: p.poster !== false });
          posterTex.needsUpdate = true;
        }
      }
    }

    return {
      render(frame, target) {
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          camera.updateProjectionMatrix();
        }
        update(frame);
        const r = frame.renderer;
        r.setRenderTarget(target);
        r.render(scene, camera);
        const ac = r.autoClear;
        r.autoClear = false;
        r.render(overlay, ortho);
        r.autoClear = ac;
      },
      dispose() {
        posterTex.dispose();
        atlas.dispose();
        stickerMat.dispose();
        bodyMat.dispose();
        bodyGeo.dispose();
        crossMat.dispose();
        crossH.geometry.dispose();
        crossV.geometry.dispose();
        for (const g of ownGeos) g.dispose();
      },
    };
  },
};
