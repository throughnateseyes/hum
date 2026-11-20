import * as THREE from 'three';
import { lineAt } from '../../../audio/lyrics';
import { FULLSCREEN_VERT, GLSL_COMMON, GLSL_HEADER } from '../../../core/glsl';
import { buildSceneFragment, createFullscreenQuad, makeRenderTarget } from '../../../core/sceneHelpers';
import type { FrameContext, LyricLine, ParamDef, SceneDef, SceneInit, SceneInstance, TrackSection } from '../../../core/types';
import { bool, createBaseUniforms, num, str, updateBaseUniforms, updateParamUniforms } from '../../../core/uniforms';
import { quality } from '../../../render/quality';
import { useStudio } from '../../../state/store';
import { approach, Spring, stepDt } from '../common';
import { songInfo } from '../songInfo';
import { acquireAtlas, glyphFor, releaseAtlas } from './atlas';
import { blendPose, copyPose, J, makeSolved, POSES, PRIMS, solve, type PoseId } from './rig';
import { BLUR_FRAG, BRIGHT_FRAG, COMPOSE_FRAG, FIGURE_FRAG, OBJ_FRAG, OBJ_VERT, RAIN_FRAG } from './shaders';

/**
 * Undercode: the hidden system under the picture. Columns of an invented machine script rain down
 * at three depths, and an anonymous figure stands in the stream, drawn only by a finer, brighter rain
 * that runs over its body. Time is the instrument:
 *
 *   quiet parts   slow, sparse rain; the figure assembles out of it and breathes, head bowed
 *   verse         the rain at speed; the figure looks up and turns; kicks send a shockwave through the
 *                 code, snares tear the scan sideways, hats make single glyphs flash
 *   build         time slows: the rain decelerates and the glyphs stretch, the figure raises one hand,
 *                 and rounds, glyph shards and droplets of code fly in from the dark, slowing as they come
 *   the drop      everything freezes mid-air: the rounds hang in front of the open palm trailing wake
 *                 rings, the air rings with concentric ripples, and the camera orbits the frozen moment
 *                 for a bar; then time snaps back and everything blasts outward
 *   chorus        gravity lets go: the rain falls upward, the figure floats and leaps, shards drift up
 *   break         one figure on one knee in a slow drizzle, a few droplets hanging in the air
 *   outro         the figure comes apart into the rain
 *
 * The sung line assembles out of the rain letter by letter as each word is sung (decoding through
 * random glyphs, locking, then dissolving back into falling code). Without lyrics: the title and
 * the part names.
 *
 * Palette roles: bg = the void · accent = the code · accent2 = dim and distant code · fg = the
 * leading glyphs, highlights and the sung words · muted = the floating dots of the print take.
 */

const params: ParamDef[] = [
  { id: 'speed', label: 'Rain speed', group: 'Rain', type: 'number', min: 0.2, max: 2.5, step: 0.01, default: 1 },
  { id: 'density', label: 'Density', group: 'Rain', type: 'number', min: 0.1, max: 1, step: 0.01, default: 0.62, hint: 'How many columns are raining; quiet parts thin it out' },
  { id: 'size', label: 'Glyph size', group: 'Rain', type: 'number', min: 0.6, max: 1.8, step: 0.01, default: 1 },
  { id: 'depth', label: 'Depth', group: 'Rain', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'The far layers of rain and how much they fade into the dark' },
  { id: 'trail', label: 'Trails', group: 'Rain', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1, hint: 'How long each stream of glyphs lingers behind its leading glyph' },
  {
    id: 'script',
    label: 'Script',
    group: 'Rain',
    type: 'select',
    options: [
      { value: 'mixed', label: 'Mixed: script, mirrored numerals, symbols' },
      { value: 'script', label: 'Script only' },
      { value: 'hex', label: 'Hex terminal' },
    ],
    default: 'mixed',
  },
  { id: 'figure', label: 'Figure', group: 'Figure', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How strongly the stream draws the figure' },
  { id: 'poses', label: 'Pose per part', group: 'Figure', type: 'bool', default: true, hint: 'Stand in the quiet, raise a hand in the build, leap in the chorus, kneel in the break' },
  { id: 'bullet', label: 'Bullet time', group: 'Time', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Slow motion through the build and the freeze on the drop' },
  { id: 'objects', label: 'Objects in the air', group: 'Time', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Rounds, glyph shards and droplets of code that fly in and hang frozen' },
  { id: 'orbit', label: 'Camera orbit', group: 'Time', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How far the camera swings round the frozen moment' },
  {
    id: 'gravity',
    label: 'Gravity',
    group: 'Time',
    type: 'select',
    options: [
      { value: 'reverse', label: 'Chorus falls upward' },
      { value: 'tumble', label: 'Chorus tumbles (up, sideways)' },
      { value: 'off', label: 'Always down' },
    ],
    default: 'reverse',
  },
  { id: 'glow', label: 'Phosphor glow', group: 'Finish', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'scan', label: 'Scanlines', group: 'Finish', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
  { id: 'print', label: 'Print', group: 'Finish', type: 'select', options: [{ value: 'screen', label: 'Screen' }, { value: 'poster', label: 'Halftone poster' }], default: 'screen', hint: 'The poster draws the figure as a halftone of code, with grey dots floating over it' },
  { id: 'dots', label: 'Floating dots', group: 'Finish', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
  { id: 'words', label: 'Words from the rain', group: 'Finish', type: 'bool', default: true, hint: 'The sung line assembles out of the rain (title and part names without lyrics)' },
  { id: 'grain', label: 'Grain', group: 'Finish', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.02 },
];

/* ───────── small helpers ───────── */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
type V3 = [number, number, number];

type Phase = 'quiet' | 'verse' | 'build' | 'peak' | 'break' | 'outro';
function phaseOf(sec: TrackSection['label'] | null, intensity: number, tension: number): Phase {
  switch (sec) {
    case 'intro':
      return 'quiet';
    case 'verse':
    case 'bridge':
      return 'verse';
    case 'build':
      return 'build';
    case 'chorus':
    case 'drop':
      return 'peak';
    case 'break':
      return 'break';
    case 'outro':
      return 'outro';
    default:
      if (tension > 0.5) return 'build';
      if (intensity > 0.72) return 'peak';
      if (intensity < 0.28) return 'quiet';
      return 'verse';
  }
}

/* ───────── objects in the air ───────── */

const N_ROUNDS = 14;
const RINGS_PER = 2;
const N_SHARDS = 12;
const N_DROPS = 10;
const N_OBJ = N_ROUNDS + N_SHARDS + N_DROPS;
const N_INST = N_OBJ + N_ROUNDS * RINGS_PER;

interface Obj {
  kind: 0 | 1 | 2;
  seed: number;
  /** where it starts (relative to the hand) and where it comes to rest (relative to the hand) */
  from: V3;
  to: V3;
  delay: number;
  rate: number;
  size: number;
  glyph: number;
  spin: number;
  spinRate: number;
  p: V3;
  v: V3;
  dir: V3;
  alpha: number;
}

function makeObjects(): Obj[] {
  const out: Obj[] = [];
  for (let i = 0; i < N_OBJ; i++) {
    const kind: 0 | 1 | 2 = i < N_ROUNDS ? 0 : i < N_ROUNDS + N_SHARDS ? 1 : 2;
    const s = i * 7.31 + 1.7;
    out.push({
      kind,
      seed: hash(s),
      from: [0, 0, 0],
      to: [0, 0, 0],
      delay: hash(s + 1) * 0.55,
      rate: 0.75 + 0.6 * hash(s + 2),
      size: kind === 0 ? 0.095 + 0.025 * hash(s + 3) : kind === 1 ? 0.05 + 0.05 * hash(s + 3) : 0.028 + 0.03 * hash(s + 3),
      glyph: Math.floor(hash(s + 4) * 48),
      spin: hash(s + 5) * 6.28,
      spinRate: (hash(s + 6) - 0.5) * 3,
      p: [0, -50, 0],
      v: [0, 0, 0],
      dir: [0, 0, -1],
      alpha: 0,
    });
  }
  return out;
}

/* ───────── the sung words ───────── */

const WORD_COLS = 40;
const WORD_ROWS = 4;

interface WordLine {
  key: string;
  text: string;
  t: number;
  end: number;
  words?: { t: number; end: number; text: string }[];
}

/** the line to show now: the sung line, else the title and the parts' names */
function wordLineAt(time: number, analysis: FrameContext['analysis'], typed: string): WordLine | null {
  let lines: LyricLine[] | null = null;
  try {
    const l = useStudio.getState().lyrics;
    lines = l?.synced && l.lines.length ? l.lines : null;
  } catch {
    lines = null;
  }
  const info = songInfo();
  const credit = (t: string) => `${t} / ${info.artist}`;
  if (lines) {
    // before the first sung line the title and artist come up out of the rain
    if (lines[0].t > 4.5 && time > 0.8 && time < lines[0].t - 1.2) {
      return { key: 'title', text: credit(typed.trim() || info.title), t: 1.2, end: Math.min(lines[0].t - 1.6, 9) };
    }
    const hit = lineAt(lines, time + 0.45);
    if (!hit || !hit.line.text.trim() || time > hit.line.end + 1.6) return null;
    return { key: `l${hit.i}`, text: hit.line.text, t: hit.line.t, end: Math.max(hit.line.end, hit.line.t + 1), words: hit.line.words };
  }
  const secs = analysis?.sections;
  const title = typed.trim() || info.title;
  if (!secs?.length) {
    if (time > 1 && time < 7.5) return { key: 'title', text: credit(title), t: 1.2, end: 5.5 };
    return null;
  }
  let i = secs.length - 1;
  while (i > 0 && time < secs[i].start) i--;
  const s = secs[i];
  const t0 = s.start + 0.6;
  if (time < t0 - 0.5 || time > t0 + 4.6) return null;
  const name = i === 0 ? credit(title) : s.label === 'drop' || s.label === 'chorus' ? title : `${s.label} ${String(i).padStart(2, '0')}`;
  return { key: `s${i}`, text: name, t: t0, end: t0 + 3 };
}

/** lay a line out on the word grid: word wrap into at most WORD_ROWS rows, each cell's reveal time */
function layoutWords(line: WordLine, maxCols: number, data: Float32Array): { cols: number; rows: number } {
  data.fill(-1);
  const text = line.text.replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  const rows: string[][] = [[]];
  let len = 0;
  for (const w of words) {
    const add = (len ? 1 : 0) + w.length;
    if (len + add > maxCols && len > 0 && rows.length < WORD_ROWS) {
      rows.push([w]);
      len = w.length;
    } else {
      rows[rows.length - 1].push(w);
      len += add;
    }
  }
  // reveal times: by word when the source has them, else spread over the line
  const timed = line.words && line.words.length === words.length ? line.words : null;
  const dur = Math.max(0.6, Math.min(line.end - line.t, 3.2));
  const totalChars = text.replace(/ /g, '').length || 1;
  let wi = 0;
  let ci = 0;
  let cols = 0;
  rows.forEach((r, ri) => {
    const s = r.join(' ').slice(0, WORD_COLS);
    cols = Math.max(cols, s.length);
    let wordStart = 0;
    for (let x = 0; x < s.length; x++) {
      const ch = s[x];
      if (ch === ' ') {
        wi++;
        wordStart = x + 1;
        continue;
      }
      const g = glyphFor(ch);
      const j = x - wordStart;
      const reveal = timed ? timed[Math.min(wi, timed.length - 1)].t + j * 0.035 : line.t + (ci / totalChars) * dur * 0.8;
      ci++;
      const o = (ri * WORD_COLS + x) * 4;
      data[o] = g;
      data[o + 1] = reveal;
      data[o + 2] = line.end + 0.25 + (x / Math.max(1, s.length)) * 0.35;
      data[o + 3] = 0;
    }
    wi++;
  });
  return { cols: Math.max(1, cols), rows: rows.length };
}

/* ───────── the scene ───────── */

function create(init: SceneInit): SceneInstance {
  const atlas = acquireAtlas();
  const quadVert = FULLSCREEN_VERT;

  // figure pass
  const primA = new Float32Array(PRIMS * 4);
  const primB = new Float32Array(PRIMS * 4);
  const figU = {
    ...createBaseUniforms(init.shared, []),
    uPA: { value: primA },
    uPB: { value: primB },
    uCamPos: { value: new THREE.Vector3() },
    uCamR: { value: new THREE.Vector3() },
    uCamU: { value: new THREE.Vector3() },
    uCamF: { value: new THREE.Vector3() },
    uTanH: { value: 0.3 },
    uShift: { value: 0 },
    uBMin: { value: new THREE.Vector3() },
    uBMax: { value: new THREE.Vector3() },
    uKey: { value: new THREE.Vector3(-0.45, 0.6, 0.66).normalize() },
  };
  const figMat = new THREE.ShaderMaterial({ uniforms: figU, vertexShader: quadVert, fragmentShader: buildSceneFragment(FIGURE_FRAG, []), depthTest: false, depthWrite: false });
  const figQuad = createFullscreenQuad(figMat);

  // rain pass
  const wordData = new Float32Array(WORD_COLS * WORD_ROWS * 4).fill(-1);
  const wordTex = new THREE.DataTexture(wordData, WORD_COLS, WORD_ROWS, THREE.RGBAFormat, THREE.FloatType);
  wordTex.magFilter = wordTex.minFilter = THREE.NearestFilter;
  wordTex.needsUpdate = true;
  const rainU = {
    ...createBaseUniforms(init.shared, params),
    uAtlas: { value: atlas },
    uFig: { value: null as THREE.Texture | null },
    uWords: { value: wordTex },
    uWordBox: { value: new THREE.Vector4(0, 0, 10, 16) },
    uWordDims: { value: new THREE.Vector2(WORD_COLS, WORD_ROWS) },
    uWordT: { value: 0 },
    uRainT: { value: 0 },
    uMutT: { value: 0 },
    uGrav: { value: 0 },
    uStretch: { value: 1 },
    uDensity: { value: 0.6 },
    uPool: { value: 0 },
    uDepth: { value: 1 },
    uCells: { value: new THREE.Vector4(9, 14, 30, 9) },
    uPar: { value: new THREE.Vector3() },
    uKickW: { value: new THREE.Vector4(0, 0, 0, 0) },
    uDropW: { value: new THREE.Vector4(0, 0, 0, 0) },
    uRip: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uSparkle: { value: 0 },
    uSparkleSeed: { value: 0 },
    uFigAmt: { value: 1 },
    uFigGrid: { value: new THREE.Vector3(0, 0, 9) },
    uFreeze: { value: 0 },
    uFigBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uAssemble: { value: 1 },
    uDissolve: { value: 0 },
    uFigDir: { value: 1 },
    uFigHalftone: { value: 0 },
    uFigBottom: { value: 0.1 },
    uFigTop: { value: 0.9 },
    uTrailK: { value: 1 },
    uBright: { value: 1 },
  };
  const rainMat = new THREE.ShaderMaterial({ uniforms: rainU, vertexShader: quadVert, fragmentShader: buildSceneFragment(RAIN_FRAG, params), depthTest: false, depthWrite: false });
  const rainQuad = createFullscreenQuad(rainMat);

  // objects
  const objects = makeObjects();
  const geo = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(N_INST * 3), 3);
  const iDir = new THREE.InstancedBufferAttribute(new Float32Array(N_INST * 3), 3);
  const iData = new THREE.InstancedBufferAttribute(new Float32Array(N_INST * 4), 4);
  const iExtra = new THREE.InstancedBufferAttribute(new Float32Array(N_INST * 4), 4);
  for (const a of [iPos, iDir, iData, iExtra]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iDir', iDir);
  geo.setAttribute('iData', iData);
  geo.setAttribute('iExtra', iExtra);
  geo.instanceCount = N_INST;
  const pre = `${GLSL_HEADER}\n${GLSL_COMMON}\n`;
  const objU = { ...createBaseUniforms(init.shared, []), uAtlas: { value: atlas }, uFig: { value: null as THREE.Texture | null } };
  const objMat = new THREE.ShaderMaterial({
    uniforms: objU,
    vertexShader: pre + OBJ_VERT,
    fragmentShader: pre + OBJ_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const objMesh = new THREE.Mesh(geo, objMat);
  objMesh.frustumCulled = false;
  const objScene = new THREE.Scene();
  objScene.add(objMesh);
  const cam = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 100);

  // bloom + compose
  const brightU = { ...createBaseUniforms(init.shared, []), uSrc: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() } };
  const brightMat = new THREE.ShaderMaterial({ uniforms: brightU, vertexShader: quadVert, fragmentShader: buildSceneFragment(BRIGHT_FRAG, []), depthTest: false, depthWrite: false });
  const brightQuad = createFullscreenQuad(brightMat);
  const blurU = { ...createBaseUniforms(init.shared, []), uSrc: { value: null as THREE.Texture | null }, uDir: { value: new THREE.Vector2() } };
  const blurMat = new THREE.ShaderMaterial({ uniforms: blurU, vertexShader: quadVert, fragmentShader: buildSceneFragment(BLUR_FRAG, []), depthTest: false, depthWrite: false });
  const blurQuad = createFullscreenQuad(blurMat);
  const compU = {
    ...createBaseUniforms(init.shared, []),
    uScene: { value: null as THREE.Texture | null },
    uBloom: { value: null as THREE.Texture | null },
    uTear: { value: 0 },
    uTearSeed: { value: 0 },
    uFlash: { value: 0 },
    uGlowAmt: { value: 1 },
    uScan: { value: 0.3 },
    uPrint: { value: 0 },
    uDots: { value: 0 },
    uDotT: { value: 0 },
    uGrainAmt: { value: 0.02 },
    uFreeze: { value: 0 },
    uAtlas: { value: atlas },
    uBill: { value: new THREE.Vector4(0, 0, 8, 3) },
  };
  const compMat = new THREE.ShaderMaterial({ uniforms: compU, vertexShader: quadVert, fragmentShader: buildSceneFragment(COMPOSE_FRAG, []), depthTest: false, depthWrite: false });
  const compQuad = createFullscreenQuad(compMat);

  let figRT: THREE.WebGLRenderTarget | null = null;
  let sceneRT: THREE.WebGLRenderTarget | null = null;
  let bloomA: THREE.WebGLRenderTarget | null = null;
  let bloomB: THREE.WebGLRenderTarget | null = null;
  const ensureRTs = (W: number, H: number, figScale: number) => {
    const fw = Math.max(16, Math.round(W * figScale));
    const fh = Math.max(16, Math.round(H * figScale));
    if (!figRT || figRT.width !== fw || figRT.height !== fh) {
      figRT?.dispose();
      figRT = makeRenderTarget(fw, fh);
    }
    if (!sceneRT || sceneRT.width !== W || sceneRT.height !== H) {
      sceneRT?.dispose();
      sceneRT = makeRenderTarget(W, H);
      bloomA?.dispose();
      bloomB?.dispose();
      const bw = Math.max(8, Math.round(W / 4));
      const bh = Math.max(8, Math.round(H / 4));
      bloomA = makeRenderTarget(bw, bh);
      bloomB = makeRenderTarget(bw, bh);
    }
  };

  /* ───────── state ───────── */
  const solved = makeSolved();
  const pose = copyPose(POSES.stand);
  let poseId: PoseId = 'stand';
  let started = false;
  let ts = 0.4; // how fast time runs (1 = real time, 0 = frozen)
  let boost = 0;
  let rainT = 0;
  let mutT = 0;
  let objT = 0;
  let dotT = 0;
  let breathPh = 0;
  let bodyYaw = 0;
  let mySince = 99; // seconds since the drop edge (real time)
  let freezeHold = 0;
  let frozen = false;
  let sinceSnap = 99;
  let dropStrength = 1;
  let yawAcc = 0;
  let yawHome = 0;
  let lastTear = 0;
  let orbitNow = 0;
  let orbitGoal = 0;
  let camDist = 4;
  let camLookY = 1;
  let frameK = 0.76;
  let push = 0;
  let shiftX = 0;
  let assemble = 0;
  let dissolve = 0;
  let stretch = 1;
  let density = 0.4;
  let kickR = 0;
  let kickAmp = 0;
  let dropR = 0;
  let dropAmp = 0;
  let tear = 0;
  let tearSeed = 0;
  let sparkle = 0;
  let sparkleSeed = 0;
  let flash = 0;
  let freezeLook = 0;
  let objMode: 'none' | 'in' | 'freeze' | 'blast' | 'drift' | 'hang' = 'none';
  let objFade = 0;
  let wordKey = '';
  let wordLayout = { cols: 1, rows: 1 };
  let wordCell = 20;
  let figAmt = 1;
  let figCell = 9;
  const grav = new Spring(10, 5.5, 0);
  let gravSign = 1;
  const tmpV = new THREE.Vector3();

  const poseFor = (phase: Phase, beat: number, posesOn: boolean): PoseId => {
    if (!posesOn) return phase === 'build' || phase === 'peak' ? 'halt' : 'stand';
    const bar = Math.floor(beat / 4);
    switch (phase) {
      case 'quiet':
        return 'stand';
      case 'verse':
        return Math.floor(bar / 4) % 2 === 0 ? 'stand' : 'look';
      case 'build':
        return 'halt';
      case 'peak':
        if (frozen) return poseId;
        return sinceSnap < 4 || Math.floor(bar / 4) % 2 === 0 ? 'leap' : 'float';
      case 'break':
        return 'kneel';
      case 'outro':
        return 'stand';
    }
  };

  return {
    render(frame: FrameContext, target: THREE.WebGLRenderTarget) {
      const r = frame.renderer;
      const dt = stepDt(frame);
      const P = frame.params;
      const a = frame.audio;
      const feel = frame.feel;
      const W = frame.width;
      const H = frame.height;
      const aspect = W / H;
      const landscape = clamp01((aspect - 1.15) / 0.45);
      const portrait = clamp01((1 / aspect - 1.15) / 0.45);
      const S = Math.min(W, H);
      const bpm = a.bpm > 0 ? a.bpm : 120;
      const beatLen = 60 / bpm;
      const bulletK = num(P, 'bullet', 1);
      const orbitK = num(P, 'orbit', 1);
      const objK = num(P, 'objects', 1);
      const gravityMode = str(P, 'gravity', 'reverse');
      const posterOn = str(P, 'print', 'screen') === 'poster';

      // where the song is
      const intensity = feel.intensity;
      const tension = Math.max(feel.tension, a.build);
      const phase = phaseOf(feel.section, intensity, tension);
      const anticip = feel.toDrop < 6.5 ? smooth(6.5, 0.25, feel.toDrop) : 0;

      // the drop: freeze for a bar (two beats in a slow song), orbit, snap back
      mySince = Math.min(99, mySince + dt);
      const dropEdge = (feel.sinceDrop < 0.12 && mySince > 1.5) || (a.drop > 0.6 && mySince > 1.5 && feel.sinceDrop < 0.5);
      if (dropEdge) {
        mySince = 0;
        const drops = frame.analysis?.drops ?? [];
        let k = -1;
        for (let i = 0; i < drops.length; i++) if (Math.abs(drops[i] - a.time) < 1.5) k = i;
        dropStrength = k >= 0 ? (frame.analysis?.dropInfo?.[k]?.strength ?? 1) : 1;
        const bar = 4 * beatLen;
        freezeHold = bulletK > 0.05 && dropStrength > 0.4 ? Math.min(2.6, Math.max(1.1, bar > 2.6 ? 2 * beatLen : bar)) * (0.5 + 0.5 * bulletK) : 0;
        frozen = freezeHold > 0;
        flash = 1;
        dropR = S * 0.08;
        dropAmp = S * 0.012 * (0.6 + 0.4 * dropStrength);
        orbitGoal = (Math.PI * 0.72) * orbitK * (0.6 + 0.4 * dropStrength);
        orbitNow = 0;
        // the objects must be there for the money shot, build or no build
        if (objMode !== 'in' || objT < 0.75) objT = 0.86;
        objMode = frozen ? 'freeze' : 'blast';
        if (!frozen) sinceSnap = 0;
      }
      if (frozen && mySince >= freezeHold) {
        frozen = false;
        sinceSnap = 0;
        boost = 2.4;
        yawAcc += orbitGoal;
        yawHome = Math.PI * 2 * Math.ceil((yawAcc - 0.4) / (Math.PI * 2));
        orbitNow = 0;
        orbitGoal = 0;
        objMode = 'blast';
        kickR = 0;
        kickAmp = S * 0.03;
      }
      sinceSnap = Math.min(99, sinceSnap + dt);
      freezeLook = frozen ? approach(freezeLook, 1, 10, dt) : approach(freezeLook, 0, 5, dt);

      // how fast time runs
      const quietish = phase === 'quiet' || phase === 'break' || phase === 'outro';
      const baseTs = quietish ? 0.34 : phase === 'peak' ? 1.05 + 0.25 * intensity : 0.8 + 0.25 * intensity;
      const buildSlow = phase === 'build' ? Math.max(tension * 0.9, smooth(0, 1, feel.sectionT) * 0.75) : 0;
      const slow = clamp01(Math.max(buildSlow, anticip)) * bulletK;
      const tsGoal = baseTs * (1 - 0.92 * Math.pow(slow, 1.25));
      boost *= Math.exp(-dt * 2.2);
      if (!started) ts = tsGoal;
      ts = frozen ? 0 : approach(ts, tsGoal + boost, mySince < 2.5 + freezeHold ? 9 : 3, dt);
      const speedK = num(P, 'speed', 1);
      rainT += dt * ts * speedK * 9;
      mutT += dt * (frozen ? 0 : 0.15 + ts);
      dotT += dt * ts;
      breathPh += dt * ts * (quietish ? 1.1 : 1.6);

      // the glyphs stretch as time slows, and snap back with it
      stretch = approach(stretch, frozen ? stretch : 1 + 0.75 * slow, 4, dt);
      density = approach(density, num(P, 'density', 0.62) * (quietish ? 0.42 : phase === 'peak' ? 1.0 : phase === 'build' ? 1.0 : 0.9), 1.5, dt);

      // gravity: the chorus lets go (once time is running again)
      const flip = phase === 'peak' && !frozen && gravityMode !== 'off';
      let gravGoal = 0;
      if (flip) {
        if (gravityMode === 'tumble') {
          const bar = Math.floor(a.beatCount / 4);
          gravGoal = [Math.PI, Math.PI * 0.5, Math.PI, Math.PI * 1.5][Math.floor(bar / 4) % 4];
        } else gravGoal = Math.PI;
      }
      if (!started) grav.value = gravGoal;
      const g = grav.step(gravGoal, frozen ? 0 : dt);
      gravSign = Math.cos(g) >= 0 ? 1 : -1;

      // the figure: pose for the part, breathing, assembling in the intro, coming apart at the end
      const posesOn = bool(P, 'poses', true);
      poseId = poseFor(phase, a.beatCount, posesOn);
      const poseGoal = POSES[poseId];
      const poseRate = frozen ? 0 : (phase === 'peak' ? 3.2 : 1.9) * Math.min(1.6, Math.max(0.3, ts));
      if (!started) pose.set(poseGoal);
      else blendPose(pose, poseGoal, 1 - Math.exp(-poseRate * dt));
      pose[J.Breath] = 0.5 + 0.5 * Math.sin(breathPh * 1.4) * (quietish ? 1 : 0.5);
      // floating: a slow turn and bob while gravity is off
      const floating = flip ? 1 : 0;
      bodyYaw = frozen ? bodyYaw : bodyYaw + dt * ts * (floating ? 0.35 : 0) + (floating ? 0 : -bodyYaw * Math.min(1, dt * 0.6));
      const bob = floating * 0.06 * Math.sin(breathPh * 0.9);
      const saveYaw = pose[J.Yaw];
      pose[J.Yaw] += bodyYaw;
      solve(pose, [0, bob, 0], solved);
      pose[J.Yaw] = saveYaw;
      primA.set(solved.a);
      primB.set(solved.b);

      const asmGoal = phase === 'quiet' && feel.sectionIndex === 0 ? smooth(0.05, 0.7, feel.sectionT) : 1;
      assemble = !started ? asmGoal : approach(assemble, Math.max(asmGoal, assemble * (phase === 'quiet' ? 1 : 0)), 2, dt);
      if (phase !== 'quiet') assemble = approach(assemble, 1, 1.5, dt);
      const disGoal = phase === 'outro' ? smooth(0.25, 0.95, feel.sectionT) : 0;
      dissolve = !started ? disGoal : approach(dissolve, disGoal, 1.5, dt);
      figAmt = approach(figAmt, num(P, 'figure', 1) * (quietish ? 0.9 : phase === 'peak' ? 1.2 : 1), 2, dt);

      // the camera: low, looking up a little; orbits the frozen moment; frames the figure for any shape
      const tanH = Math.tan((34 * Math.PI) / 360);
      const figH = solved.max[1] - solved.min[1];
      const figW = Math.max(Math.abs(solved.max[0]), Math.abs(solved.min[0]), Math.abs(solved.max[2]), Math.abs(solved.min[2])) * 2;
      // framing per part: close and intimate in the quiet, full figure in the verse, pushing in through
      // the build, wide while gravity is off; the freeze dollies in on the hand and what hangs before it
      const frameGoal = (posterOn ? 1.12 : 1) * (phase === 'quiet' ? 1.18 : phase === 'break' ? 0.98 : phase === 'build' ? 0.8 + 0.2 * slow : phase === 'peak' ? 0.72 : phase === 'outro' ? 0.86 : 0.76);
      frameK = !started ? frameGoal : approach(frameK, frameGoal, frozen ? 0 : 0.7, dt);
      const fracH = frameK * (1 - 0.16 * portrait - 0.06 * (1 - landscape - portrait));
      const fracW = 0.8;
      const distGoal = Math.max(figH / fracH / (2 * tanH), figW / fracW / (2 * tanH * aspect), 1.2);
      camDist = !started ? distGoal : approach(camDist, distGoal, frozen ? 0 : 1.2, dt);
      // close shots look at the chest, wide ones at the middle of the body
      const mid = (solved.min[1] + solved.max[1]) / 2;
      const closeT = clamp01((frameK - 0.8) / 0.35);
      const lookGoal = mid + (solved.chest[1] + 0.12 - mid) * closeT + 0.06 * portrait * figH;
      camLookY = !started ? lookGoal : approach(camLookY, lookGoal, frozen ? 0 : 1.6, dt);
      if (frozen) {
        orbitNow = orbitGoal * easeInOut(clamp01(mySince / Math.max(0.1, freezeHold)));
        push = approach(push, 1, 3.2, dt);
      } else push = approach(push, 0, 2.2, dt);
      const sway = 0.22 * Math.sin(a.time * 0.11) * orbitK + (phase === 'peak' ? 0.08 * Math.sin(a.time * 0.37) : 0);
      // after an orbit the camera keeps going round, slowly, until it faces the figure again
      if (!frozen) {
        const left = yawHome - yawAcc;
        yawAcc += Math.sign(left) * Math.min(Math.abs(left), dt * Math.max(0.2, ts) * (phase === 'peak' ? 0.32 : 0.2));
      }
      const yaw = yawAcc + orbitNow + sway;
      const lift = frozen ? Math.sin(Math.PI * clamp01(mySince / freezeHold)) * 0.4 * orbitK : 0;
      const pk = push * 0.62;
      const tx = (solved.hand[0] + solved.palm[0] * 0.55) * pk;
      const ty = camLookY + (solved.hand[1] - 0.05 - camLookY) * pk;
      const tz = (solved.hand[2] + solved.palm[2] * 0.55) * pk;
      const dist = camDist * (1 - 0.4 * push);
      const camY = ty - 0.22 * (1 - closeT * 0.6) + lift;
      cam.position.set(tx + Math.sin(yaw) * dist, camY, tz + Math.cos(yaw) * dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(tx, ty, tz);
      cam.aspect = aspect;
      cam.fov = 34;
      cam.updateProjectionMatrix();
      // the figure stands right of centre in a landscape frame (the words take the left), centred otherwise
      const shiftGoal = 0.34 * landscape * (1 - 0.6 * push);
      shiftX = !started ? shiftGoal : approach(shiftX, shiftGoal, 1.5, dt);
      cam.projectionMatrix.elements[8] = -shiftX;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      cam.updateMatrixWorld();
      const m = cam.matrixWorld.elements;
      figU.uCamPos.value.copy(cam.position);
      figU.uCamR.value.set(m[0], m[1], m[2]);
      figU.uCamU.value.set(m[4], m[5], m[6]);
      figU.uCamF.value.set(-m[8], -m[9], -m[10]);
      figU.uTanH.value = tanH;
      // the key light rides with the camera (upper left, in front), so an orbit never shows an unlit body
      figU.uKey.value.set(-0.5 * m[0] + 0.62 * m[4] + 0.6 * m[8], -0.5 * m[1] + 0.62 * m[5] + 0.6 * m[9], -0.5 * m[2] + 0.62 * m[6] + 0.6 * m[10]).normalize();
      figU.uShift.value = shiftX;
      figU.uBMin.value.set(...solved.min);
      figU.uBMax.value.set(...solved.max);

      const toPx = (p: V3) => {
        tmpV.set(p[0], p[1], p[2]).project(cam);
        return [(tmpV.x * 0.5 + 0.5) * W, (tmpV.y * 0.5 + 0.5) * H, tmpV.z] as const;
      };
      const chestPx = toPx(solved.chest);
      const handPx = toPx(solved.hand);
      const topPx = toPx([0, solved.max[1], 0]);
      const botPx = toPx([0, solved.min[1], 0]);
      // the figure's box on screen (for the dark it stands in)
      let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      for (let k = 0; k < 8; k++) {
        const q = toPx([k & 1 ? solved.max[0] : solved.min[0], k & 2 ? solved.max[1] : solved.min[1], k & 4 ? solved.max[2] : solved.min[2]]);
        bx0 = Math.min(bx0, q[0]);
        bx1 = Math.max(bx1, q[0]);
        by0 = Math.min(by0, q[1]);
        by1 = Math.max(by1, q[1]);
      }

      // hits: the kick's shockwave (it runs on the scene's clock, so it hangs in the freeze), the snare's tear, hat sparkle
      if (a.kickHit && !frozen) {
        kickR = S * 0.02;
        kickAmp = S * 0.011 * (0.5 + 0.5 * a.kick) * (quietish ? 0.5 : 1);
      }
      kickR += dt * ts * S * 1.1;
      kickAmp *= Math.exp(-dt * ts * 1.6);
      dropR += dt * (frozen ? 0 : ts) * S * 0.35;
      dropAmp *= Math.exp(-dt * (frozen ? 0 : 1.2));
      if (a.snareHit && !frozen && frame.time - lastTear > 0.2) {
        lastTear = frame.time;
        tear = Math.max(tear, (0.55 + 0.45 * a.snare) * (quietish ? 0.4 : phase === 'build' ? 0.45 : 1));
        tearSeed = Math.floor(hash(a.time * 13.1) * 97);
      }
      tear *= Math.exp(-dt * 14);
      if (a.hatHit && !frozen) {
        sparkle = Math.min(1.4, 0.6 + a.hat);
        sparkleSeed = hash(a.time * 7.7) * 100;
      }
      sparkle *= Math.exp(-dt * 9);
      flash *= Math.exp(-dt * 26);

      // objects in the air
      const wantIn = phase === 'build' || anticip > 0.05;
      if (!frozen && sinceSnap > 1.8) {
        const next = wantIn ? 'in' : phase === 'peak' ? 'drift' : phase === 'break' ? 'hang' : 'none';
        if (next === 'in' && objMode !== 'in') objT = 0;
        objMode = next;
      }
      if (objMode === 'in') {
        const total = phase === 'build' ? Math.max(0.5, feel.toSection) : feel.toDrop;
        objT = Math.min(0.92, objT + (dt * ts * 0.9) / Math.max(2, Math.min(total, 10)));
      }
      objFade = approach(objFade, objMode === 'none' ? 0 : 1, 2.5, dt);
      const hand = solved.hand;
      const palm = solved.palm;
      for (let i = 0; i < N_OBJ; i++) {
        const o = objects[i];
        const h1 = hash(o.seed * 91 + 1);
        const h2 = hash(o.seed * 91 + 2);
        const h3 = hash(o.seed * 91 + 3);
        const visible = objK > 0 && i < Math.ceil(N_OBJ * Math.min(1, objK)) ? 1 : 0;
        if (objMode === 'in' || objMode === 'freeze') {
          if (objMode === 'in') {
            // paths: rounds come at the palm from in front of it, shards and drops from all round
            if (o.kind === 0) {
              // a loose cone in front of the open hand, the nearest ones closest to it
              const sx = palm[2], sz = -palm[0];
              const sl = Math.hypot(sx, sz) || 1;
              const reach = 0.28 + 1.25 * h3;
              const wide = (0.12 + 0.3 * h3) * 1.2;
              const lx = (sx / sl) * (h1 - 0.5) * 2 * wide, lz = (sz / sl) * (h1 - 0.5) * 2 * wide;
              const ly = (h2 - 0.5) * 2 * wide * 0.7;
              o.to = [hand[0] + palm[0] * reach + lx, hand[1] + palm[1] * reach + ly - 0.05, hand[2] + palm[2] * reach + lz];
              o.from = [o.to[0] + palm[0] * 8 + lx * 2, o.to[1] + ly * 2 + 0.2, o.to[2] + palm[2] * 8 + lz * 2];
            } else {
              const th = h1 * Math.PI * 2;
              const ph = (h2 - 0.45) * 1.1;
              const rad = 0.7 + 0.7 * h3;
              const dx = Math.cos(th) * Math.cos(ph), dy = Math.sin(ph), dz = Math.sin(th) * Math.cos(ph);
              const c = solved.chest;
              o.to = [c[0] + dx * rad + palm[0] * 0.2, c[1] + dy * rad * 0.9, c[2] + dz * rad + palm[2] * 0.2];
              o.from = [o.to[0] + dx * 6, o.to[1] + dy * 4 + 1, o.to[2] + dz * 6];
            }
            const u = clamp01((objT - o.delay * 0.6) / (1 - o.delay * 0.6)) * (0.9 + 0.1 * o.rate);
            const e = 1 - Math.pow(1 - u, 2.2);
            const np: V3 = [o.from[0] + (o.to[0] - o.from[0]) * e, o.from[1] + (o.to[1] - o.from[1]) * e, o.from[2] + (o.to[2] - o.from[2]) * e];
            const dx = o.to[0] - o.from[0], dy = o.to[1] - o.from[1], dz = o.to[2] - o.from[2];
            const dl = Math.hypot(dx, dy, dz) || 1;
            o.dir = [dx / dl, dy / dl, dz / dl];
            o.p = np;
            o.alpha = smooth(0.0, 0.12, u) * visible;
          }
          o.v = [0, 0, 0];
          if (!frozen) o.spin += dt * ts * o.spinRate;
        } else if (objMode === 'blast') {
          if (sinceSnap < dt * 1.5) {
            // the snap: everything thrown outward from the figure
            const c = solved.chest;
            const dx = o.p[0] - c[0], dy = o.p[1] - c[1], dz = o.p[2] - c[2];
            const dl = Math.hypot(dx, dy, dz) || 1;
            const sp = 7 + 9 * h1;
            o.v = [(dx / dl) * sp, (dy / dl) * sp + 1.5, (dz / dl) * sp];
            if (o.kind === 0) o.dir = [o.v[0] / sp, o.v[1] / sp, o.v[2] / sp];
          }
          o.p = [o.p[0] + o.v[0] * dt, o.p[1] + o.v[1] * dt, o.p[2] + o.v[2] * dt];
          o.spin += dt * o.spinRate * 4;
          o.alpha = Math.max(0, 1 - sinceSnap / 1.5) * visible;
        } else if (objMode === 'drift') {
          // weightless debris: shards and drops drifting up round the figure (rounds are gone)
          const span = 5;
          const rise = ((h1 * span + dotT * (0.25 + 0.35 * h2) * gravSign * -1) % span + span) % span;
          const th = h3 * Math.PI * 2 + i;
          const rad = 0.7 + 1.6 * h2;
          o.p = [Math.cos(th) * rad, -0.8 + (gravSign < 0 ? rise : span - rise), Math.sin(th) * rad];
          o.spin += dt * ts * o.spinRate;
          o.alpha = (o.kind === 0 ? 0 : 0.75) * visible * smooth(0, 1.2, sinceSnap - 1.6) * Math.min(1, 1.5 * Math.sin((Math.PI * (gravSign < 0 ? rise : span - rise)) / span));
        } else if (objMode === 'hang') {
          // the break: a few droplets hanging still by the lowered hand
          const keep = o.kind === 2 && i < N_ROUNDS + N_SHARDS + 4;
          const th = h1 * Math.PI * 2;
          o.p = [hand[0] + Math.cos(th) * (0.25 + 0.3 * h2), hand[1] + 0.25 + 0.4 * h3 + 0.03 * Math.sin(breathPh + i), hand[2] + Math.sin(th) * (0.25 + 0.3 * h2)];
          o.spin += dt * 0.2 * o.spinRate;
          o.alpha = keep ? 0.9 * visible : 0;
        } else o.alpha = 0;
      }
      // instances: the objects, then three wake rings behind each round
      const pa = iPos.array as Float32Array, da = iDir.array as Float32Array, ia = iData.array as Float32Array, ea = iExtra.array as Float32Array;
      const ripples = rainU.uRip.value;
      for (const rv of ripples) rv.set(0, 0, 0, 0);
      let ri = 0;
      const moving = objMode === 'in' ? Math.min(3, ts * 3) : objMode === 'blast' ? 5 : 0;
      for (let i = 0; i < N_OBJ; i++) {
        const o = objects[i];
        pa.set(o.p, i * 3);
        da.set(o.dir, i * 3);
        ia.set([o.kind, o.size, o.alpha * objFade, o.glyph], i * 4);
        ea.set([o.kind === 0 ? moving : 0, o.spin, 0, o.seed], i * 4);
        if (o.kind === 0) {
          const showRings = (objMode === 'in' || objMode === 'freeze') && i % 2 === 0 ? o.alpha * objFade : 0;
          for (let k = 0; k < RINGS_PER; k++) {
            const j = N_OBJ + i * RINGS_PER + k;
            const back = 0.13 + 0.2 * k;
            pa.set([o.p[0] - o.dir[0] * back, o.p[1] - o.dir[1] * back, o.p[2] - o.dir[2] * back], j * 3);
            da.set(o.dir, j * 3);
            ia.set([3, 0.035 + 0.035 * k, showRings * (0.75 - 0.25 * k), 0], j * 4);
            ea.set([0, 0, 0, o.seed + k * 0.3], j * 4);
          }
          if (showRings > 0.2 && ri < ripples.length) {
            const pp = toPx([o.p[0] - o.dir[0] * 0.3, o.p[1] - o.dir[1] * 0.3, o.p[2] - o.dir[2] * 0.3]);
            const near = toPx([o.p[0] - o.dir[0] * 0.3 + 0.12, o.p[1] - o.dir[1] * 0.3, o.p[2] - o.dir[2] * 0.3]);
            const rpx = Math.abs(near[0] - pp[0]) + 4;
            ripples[ri++].set(pp[0], pp[1], rpx * 1.4, Math.min(S * 0.006, rpx * 0.12) * showRings);
          }
        }
      }
      iPos.needsUpdate = iDir.needsUpdate = iData.needsUpdate = iExtra.needsUpdate = true;

      // the words
      const wordsOn = bool(P, 'words', true);
      const line = wordsOn ? wordLineAt(a.time, frame.analysis, frame.text) : null;
      const cellGoal = Math.round(Math.min(Math.max(S * 0.064, 14), 120));
      if (!line) {
        if (wordKey) {
          wordData.fill(-1);
          wordTex.needsUpdate = true;
          wordKey = '';
        }
      } else if (line.key !== wordKey || wordCell !== cellGoal) {
        wordKey = line.key;
        wordCell = cellGoal;
        const maxW = landscape > 0.5 ? W * 0.44 : W * 0.86;
        let ch = cellGoal;
        let lay = layoutWords(line, Math.max(6, Math.floor(maxW / (ch * 0.64))), wordData);
        if (lay.rows >= WORD_ROWS) {
          ch = Math.round(ch * 0.8);
          lay = layoutWords(line, Math.max(6, Math.floor(maxW / (ch * 0.64))), wordData);
        }
        wordLayout = lay;
        wordCell = ch;
        wordTex.needsUpdate = true;
      }
      {
        const ch = wordCell;
        const cw = ch * 0.64;
        const bw = wordLayout.cols * cw;
        const bh = wordLayout.rows * ch;
        const x0 = landscape > 0.5 ? W * 0.075 : (W - bw) / 2;
        // landscape: a block on the left (lifted to the top while the freeze dollies in); otherwise above the head
        const topL = H * 0.5 + bh / 2 + H * 0.08;
        const top = landscape > 0.5 ? topL + (H * 0.9 - topL) * push : H - Math.max(H * 0.07, (H - topPx[1]) * 0.5 - bh / 2);
        rainU.uWordBox.value.set(Math.round(x0), Math.round(top), cw, ch);
        rainU.uWordDims.value.set(WORD_COLS, WORD_ROWS);
      }
      rainU.uWordT.value = a.time;

      /* ───────── draw ───────── */
      const qs = quality.current().sceneScale;
      ensureRTs(W, H, qs < 0.8 ? 0.25 : 1 / 3);
      const fRT = figRT!;
      const sRT = sceneRT!;
      const bA = bloomA!;
      const bB = bloomB!;
      const base = { width: W, height: H, time: frame.time, audio: a, palette: frame.palette, feel };

      // figure
      updateBaseUniforms(figU, { ...base, width: fRT.width, height: fRT.height });
      figQuad.render(r, fRT);

      // rain
      updateBaseUniforms(rainU, base);
      updateParamUniforms(rainU, params, P);
      const size = num(P, 'size', 1) * (S / 720);
      const pool = str(P, 'script', 'mixed');
      rainU.uFig.value = fRT.texture;
      rainU.uRainT.value = rainT;
      rainU.uMutT.value = mutT;
      rainU.uGrav.value = g;
      rainU.uStretch.value = stretch;
      rainU.uDensity.value = Math.min(1, density);
      rainU.uPool.value = pool === 'hex' ? 2 : pool === 'script' ? 1 : 0;
      rainU.uDepth.value = num(P, 'depth', 1);
      rainU.uTrailK.value = num(P, 'trail', 1) * (quietish ? 0.8 : 1);
      rainU.uCells.value.set(9 * size, 15 * size, 34 * size, 8.5 * size * Math.max(0.75, Math.min(1.3, camDist / 4.2)) * (posterOn ? 1.25 : 1));
      // parallax: as the camera swings round, near rain sweeps past faster than far rain
      const yawPx = (yaw + 0.0) * W * 0.5;
      rainU.uPar.value.set(yawPx * 0.35, yawPx * 0.7, yawPx * 1.5);
      rainU.uKickW.value.set(chestPx[0], chestPx[1], kickR, kickAmp);
      rainU.uDropW.value.set(handPx[0], handPx[1], dropR, dropAmp);
      rainU.uSparkle.value = sparkle;
      rainU.uSparkleSeed.value = sparkleSeed;
      rainU.uFigAmt.value = figAmt;
      // the body's glyph grid is pinned to the body on screen and scales with it, so a dolly zooms into
      // the code instead of re-dealing it: about 60 rows from head to foot
      const figPxH = Math.max(40, by1 - by0);
      const cellGoalF = Math.min(44, Math.max(6 * (S / 720), (figPxH / 60) * (posterOn ? 1.55 : 1) * num(P, 'size', 1)));
      figCell = !started ? cellGoalF : approach(figCell, cellGoalF, 6, dt);
      rainU.uFigGrid.value.set(chestPx[0], chestPx[1], figCell);
      rainU.uFigBox.value.set((bx0 + bx1) / 2, (by0 + by1) / 2, Math.max(10, (bx1 - bx0) / 2), Math.max(10, (by1 - by0) / 2));
      rainU.uAssemble.value = assemble;
      rainU.uDissolve.value = dissolve;
      rainU.uFigDir.value = gravSign;
      rainU.uFigHalftone.value = posterOn ? 1 : 0;
      rainU.uFigBottom.value = clamp01(botPx[1] / H);
      rainU.uFigTop.value = clamp01(topPx[1] / H);
      rainU.uBright.value = 1;
      rainQuad.render(r, sRT);

      // objects
      updateBaseUniforms(objU, base);
      objU.uFig.value = fRT.texture;
      const ac = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(sRT);
      r.render(objScene, cam);
      r.autoClear = ac;

      // bloom
      updateBaseUniforms(brightU, base);
      brightU.uSrc.value = sRT.texture;
      brightU.uTexel.value.set(1 / W, 1 / H);
      brightQuad.render(r, bA);
      updateBaseUniforms(blurU, base);
      blurU.uSrc.value = bA.texture;
      blurU.uDir.value.set(1.6 / bA.width, 0);
      blurQuad.render(r, bB);
      blurU.uSrc.value = bB.texture;
      blurU.uDir.value.set(0, 1.6 / bA.height);
      blurQuad.render(r, bA);

      // compose
      updateBaseUniforms(compU, base);
      compU.uScene.value = sRT.texture;
      compU.uBloom.value = bA.texture;
      compU.uTear.value = tear;
      compU.uTearSeed.value = tearSeed;
      compU.uFlash.value = flash * 0.4 * (0.5 + 0.5 * dropStrength);
      compU.uFreeze.value = freezeLook;
      rainU.uFreeze.value = freezeLook;
      compU.uGlowAmt.value = num(P, 'glow', 1) * (0.9 + 0.3 * intensity);
      compU.uScan.value = num(P, 'scan', 0.3);
      compU.uPrint.value = posterOn ? 1 : 0;
      compU.uDots.value = num(P, 'dots', 0);
      compU.uDotT.value = dotT;
      compU.uBill.value.set(W / 2, H * 0.035 + S * 0.03, Math.max(5, S * 0.013), 3);
      compU.uGrainAmt.value = num(P, 'grain', 0.02);
      compQuad.render(r, target);

      started = true;
    },
    dispose() {
      releaseAtlas();
      for (const mtl of [figMat, rainMat, objMat, brightMat, blurMat, compMat]) mtl.dispose();
      for (const q of [figQuad, rainQuad, brightQuad, blurQuad, compQuad]) q.dispose();
      geo.dispose();
      plane.dispose();
      wordTex.dispose();
      figRT?.dispose();
      sceneRT?.dispose();
      bloomA?.dispose();
      bloomB?.dispose();
    },
  };
}

export const undercode: SceneDef = {
  id: 'undercode',
  name: 'Undercode',
  description:
    'Columns of an invented machine script rain down at three depths over black, and an anonymous figure stands in the stream, drawn only by a finer, brighter rain running over its body. Quiet parts are a slow drizzle with the figure breathing; kicks send shockwaves through the code, snares tear the scan, hats flash single glyphs. Through a build time slows, the glyphs stretch, the figure raises a hand and rounds and shards of code fly in; on the drop everything freezes mid-air in rings of rippling air while the camera orbits the frozen moment, then time snaps back and it all blasts outward. In the chorus gravity lets go and the rain falls upward. The sung words assemble out of the rain.',
  category: 'field',
  style: 'data',
  tags: ['electronic', 'techno', 'dark', 'futuristic', 'glitch', 'cinematic', 'intense', 'hypnotic', 'aggressive', 'drops', 'cold', 'industrial', 'edm', 'dubstep'],
  params,
  showsLyrics: true,
  handInks: 4,
  modulations: [{ source: 'energy', param: 'glow', amount: 0.08 }],
  create,
};
