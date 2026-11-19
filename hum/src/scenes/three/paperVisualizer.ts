/**
 * Paper Visualizer — red cut-paper shapes standing up off a sheet of white card stock, seen
 * from a low angle in soft daylight with long soft shadows. Four shapes take turns (spectrum
 * bars → a smooth filled curve → a waterfall of stacked line slices → a radial ring of wavy
 * lines), folding flat and springing back up on section changes and drops. Small paper type
 * (title, artist, time) and a scrubber with a red bead sit on the sheet; tiny dots hop on kicks.
 */
import * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { approach, Spring, stepDt } from './common';
import { dropEdge, fmtClock, FONT_SANS, sectionIndex, songInfo } from './songInfo';

const W = 8; // plot width (world units)
const NB = 40; // bars
const NC = 180; // curve points
const NS = 26; // waterfall slices (and history depth)
const NP = 110; // points per waterfall slice
const NR = 13; // radial rings
const NA = 144; // points per ring
const NDOT = 80;
const MODES = ['bars', 'curve', 'waterfall', 'radial'] as const;

const params: ParamDef[] = [
  {
    id: 'mode',
    label: 'Shape',
    group: 'Shape',
    type: 'select',
    default: 'auto',
    hint: 'Auto moves to the next shape on every section change and drop',
    options: [
      { value: 'auto', label: 'Auto (by section)' },
      { value: 'bars', label: 'Bars' },
      { value: 'curve', label: 'Curve' },
      { value: 'waterfall', label: 'Waterfall' },
      { value: 'radial', label: 'Radial' },
    ],
  },
  { id: 'amp', label: 'Height', group: 'Shape', type: 'number', min: 0.2, max: 2, step: 0.01, default: 1 },
  { id: 'flow', label: 'Waterfall speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'hop', label: 'Dot hop', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How many dots jump on each kick' },
  { id: 'drift', label: 'Camera drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'shadow', label: 'Shadow', group: 'Light', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'soft', label: 'Shadow softness', group: 'Light', type: 'number', min: 1, max: 16, step: 0.5, default: 7 },
  { id: 'sun', label: 'Sun angle', group: 'Light', type: 'number', min: -1, max: 1, step: 0.01, default: 0.25 },
  { id: 'labels', label: 'Paper type', group: 'Style', type: 'bool', default: true, hint: 'Title, artist, time and the scrubber' },
];

/** vertical paper strips: `count` ribbons of `n` points, two vertices (bottom, top) per point */
function ribbonGeometry(count: number, n: number) {
  const pos = new Float32Array(count * n * 2 * 3);
  const idx: number[] = [];
  for (let r = 0; r < count; r++) {
    const o = r * n * 2;
    for (let i = 0; i < n - 1; i++) {
      const a = o + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function paperNoise() {
  const S = 256;
  const d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const x = i % S;
    const y = (i / S) | 0;
    // fibres: a little streaky noise
    const fib = Math.sin(x * 0.9 + Math.sin(y * 0.13) * 4) * 0.5 + 0.5;
    const v = 246 + Math.random() * 7 + fib * 2;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.min(255, v);
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(26, 26);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** a flat paper label: canvas text on a plane that casts a shadow */
function makeLabel(worldW: number, worldH: number, cw: number, ch: number) {
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.4, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), mat);
  mesh.castShadow = true;
  mesh.rotation.x = -Math.PI / 2;
  let key = '';
  return {
    mesh,
    draw(text: string, color: string, align: CanvasTextAlign, weight = 450, scale = 0.72) {
      const k = `${text}|${color}|${align}|${document.fonts?.status}`;
      if (k === key) return;
      key = k;
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = color;
      let px = ch * scale;
      ctx.font = `${weight} ${px}px ${FONT_SANS}`;
      const wmax = cw * 0.98;
      const tw = ctx.measureText(text).width;
      if (tw > wmax) {
        px *= wmax / tw;
        ctx.font = `${weight} ${px}px ${FONT_SANS}`;
      }
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      const x = align === 'left' ? cw * 0.01 : align === 'right' ? cw * 0.99 : cw / 2;
      ctx.fillText(text, x, ch * 0.54);
      tex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
    },
  };
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** spectrum read with linear interpolation over the musical part of the 128 log bins */
function specAt(spec: Float32Array, u: number) {
  const x = 2 + Math.min(Math.max(u, 0), 1) * 100;
  const i = Math.floor(x);
  const f = x - i;
  return spec[i] * (1 - f) + spec[Math.min(i + 1, spec.length - 1)] * f;
}

const CAMS: { pos: THREE.Vector3; look: THREE.Vector3 }[] = [
  { pos: new THREE.Vector3(1.8, 2.5, 11.6), look: new THREE.Vector3(0, 0.5, 0.5) }, // bars
  { pos: new THREE.Vector3(-1.7, 2.3, 11.4), look: new THREE.Vector3(0, 0.45, 0.5) }, // curve
  { pos: new THREE.Vector3(7.4, 4.6, 9.0), look: new THREE.Vector3(-0.2, 0.2, 0.1) }, // waterfall
  { pos: new THREE.Vector3(0.2, 5.6, 9.6), look: new THREE.Vector3(0, 0.1, 0.6) }, // radial
];

export const paperVisualizer: SceneDef = {
  id: 'paper-visualizer',
  name: 'Paper Visualizer',
  description:
    'Red cut-paper shapes standing up off white card stock in soft daylight: spectrum bars, a smooth curve, a waterfall of line slices and a radial ring, folding into each other on section changes and drops. Paper type, a scrubber and dots that hop on kicks.',
  category: 'form',
  style: 'print',
  tags: ['tactile', 'minimal', 'editorial', 'clean', 'pop', 'indie', 'calm', 'playful'],
  light: true,
  params,
  modulations: [{ source: 'energy', param: 'amp', amount: 0.12 }],
  create() {
    const scene = new THREE.Scene();
    const fogCol = new THREE.Color();
    scene.background = fogCol;
    scene.fog = new THREE.Fog(fogCol, 18, 42);
    const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 80);

    /* light: low sun from behind-right → long shadows toward the viewer */
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); // soft (blurred) shadows don't need more
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -12;
    sc.right = 12;
    sc.top = 12;
    sc.bottom = -12;
    sc.near = 1;
    sc.far = 40;
    sun.shadow.bias = -0.0005;
    sun.shadow.blurSamples = 10;
    scene.add(sun, sun.target);
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2ca, 1.75);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-2, 3, 10);
    scene.add(hemi, fill);

    /* the sheet */
    const noise = paperNoise();
    const paperMat = new THREE.MeshLambertMaterial({ map: noise });
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), paperMat);
    paper.rotation.x = -Math.PI / 2;
    paper.receiveShadow = true;
    scene.add(paper);

    const ink = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const dotMat = new THREE.MeshLambertMaterial();

    /* mode 0: bars */
    const barGeo = new THREE.BoxGeometry(0.13, 1, 0.05);
    barGeo.translate(0, 0.5, 0);
    const bars = new THREE.InstancedMesh(barGeo, ink, NB);
    bars.castShadow = true;
    bars.frustumCulled = false;
    const barSpring = Array.from({ length: NB }, () => new Spring(220, 15, 0.05));
    const gBars = new THREE.Group();
    gBars.add(bars);

    /* mode 1: smooth filled curve */
    const curveGeo = ribbonGeometry(1, NC);
    const curve = new THREE.Mesh(curveGeo, ink);
    curve.castShadow = true;
    curve.frustumCulled = false;
    const curveSm = new Float32Array(NC);
    const gCurve = new THREE.Group();
    gCurve.add(curve);

    /* mode 2: waterfall of line slices; mode 3: radial rings (both read the same history) */
    const hist = new Float32Array(NS * NP);
    let head = 0;
    let histAcc = 0;
    const fallGeo = ribbonGeometry(NS, NP);
    const fall = new THREE.Mesh(fallGeo, ink);
    fall.castShadow = true;
    fall.frustumCulled = false;
    const gFall = new THREE.Group();
    gFall.add(fall);
    const ringGeo = ribbonGeometry(NR, NA + 1);
    const ring = new THREE.Mesh(ringGeo, ink);
    ring.castShadow = true;
    ring.frustumCulled = false;
    const gRing = new THREE.Group();
    gRing.add(ring);

    // fixed x/z layout + normals (strips stay vertical, so normals never change)
    {
      const p = curveGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < NC; i++) {
        const x = (i / (NC - 1) - 0.5) * W;
        p.set([x, 0, 0, x, 0.1, 0], i * 6);
      }
      curveGeo.computeVertexNormals();
      const f = fallGeo.attributes.position.array as Float32Array;
      for (let s = 0; s < NS; s++)
        for (let i = 0; i < NP; i++) {
          const x = (i / (NP - 1) - 0.5) * W * 0.9;
          const z = 1.5 - s * 0.16;
          f.set([x, 0, z, x, 0.1, z], (s * NP + i) * 6);
        }
      fallGeo.computeVertexNormals();
      const r = ringGeo.attributes.position.array as Float32Array;
      for (let k = 0; k < NR; k++) {
        const rad = 0.42 + k * 0.17;
        for (let i = 0; i <= NA; i++) {
          const th = (i / NA) * Math.PI * 2;
          const x = Math.cos(th) * rad;
          const z = Math.sin(th) * rad;
          r.set([x, 0, z, x, 0.1, z], (k * (NA + 1) + i) * 6);
        }
      }
      ringGeo.computeVertexNormals();
    }

    const groups = [gBars, gCurve, gFall, gRing];
    for (const g of groups) {
      g.visible = false;
      g.scale.y = 0.001;
      scene.add(g);
    }

    /* dots */
    const dotGeo = new THREE.SphereGeometry(0.021, 10, 8);
    const dots = new THREE.InstancedMesh(dotGeo, dotMat, NDOT);
    dots.castShadow = true;
    dots.frustumCulled = false;
    const dx = new Float32Array(NDOT);
    const dz = new Float32Array(NDOT);
    const dy = new Float32Array(NDOT);
    const dvy = new Float32Array(NDOT);
    const ds = new Float32Array(NDOT);
    for (let i = 0; i < NDOT; i++) {
      let x = 0;
      let z = 0;
      for (let t = 0; t < 20; t++) {
        x = rand(-6, 6);
        z = rand(-3.6, 3.4);
        if (!(Math.abs(x) < 4.4 && Math.abs(z) < 2.7) || Math.random() < 0.12) break;
      }
      dx[i] = x;
      dz[i] = z;
      ds[i] = rand(0.6, 1.4);
    }
    scene.add(dots);

    /* paper type + scrubber */
    const title = makeLabel(3.2, 0.44, 1024, 142);
    // the title floats upright at the back, like a paper tag on a pin
    title.mesh.rotation.set(0, -0.12, 0);
    const artist = makeLabel(3.2, 0.48, 1024, 154);
    artist.mesh.position.set(-3.0, 0.12, 1.2);
    artist.mesh.rotation.z = 0.06;
    const clock = makeLabel(1.4, 0.46, 384, 126);
    clock.mesh.position.set(3.5, 0.12, 2.2);
    const rodMat = new THREE.MeshLambertMaterial();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, W + 0.6, 8), rodMat);
    rod.rotation.z = Math.PI / 2;
    rod.position.set(0, 0.07, 2.75);
    rod.castShadow = true;
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.055, 18, 14), ink);
    bead.castShadow = true;
    const labels = new THREE.Group();
    labels.add(title.mesh, artist.mesh, clock.mesh, rod, bead);
    scene.add(labels);

    /* state */
    const barM = new THREE.Matrix4();
    const camPos = CAMS[0].pos.clone();
    const camLook = CAMS[0].look.clone();
    const camGoal = new THREE.Vector3();
    let firstFrame = true;
    const tmp = new THREE.Vector3();
    const fgCol = new THREE.Color();
    let shown = 0;
    let want = 0;
    let autoStep = 0;
    let lastSection = -2;
    let lastBeatMode = 0;
    let lastStepAt = -10;
    const fold = new Spring(140, 11, 0);
    let flutter = 0;
    let push = 0;
    const isDrop = dropEdge();

    function update(frame: FrameContext) {
      const dt = stepDt(frame);
      const a = frame.audio;
      const p = frame.params;
      const pal = frame.palette;
      const amp = num(p, 'amp', 1);

      /* colours */
      fogCol.copy(pal.c.bg).multiplyScalar(0.93);
      (scene.fog as THREE.Fog).color.copy(fogCol);
      paperMat.color.copy(pal.c.bg);
      ink.color.copy(pal.c.accent);
      dotMat.color.copy(pal.c.fg).lerp(pal.c.bg, 0.15);
      rodMat.color.copy(pal.c.muted).lerp(pal.c.bg, 0.3);

      /* light */
      const sunA = num(p, 'sun', 0.25);
      sun.position.set(Math.sin(sunA * 1.3) * 9, 3.6, -Math.cos(sunA * 1.3) * 9);
      sun.shadow.intensity = num(p, 'shadow', 0.7);
      sun.shadow.radius = num(p, 'soft', 7);

      /* which shape */
      const dropHit = isDrop(frame);
      const sec = sectionIndex(frame);
      const modeSel = str(p, 'mode', 'auto');
      if (modeSel === 'auto') {
        if (sec >= 0) {
          if (lastSection === -2) lastSection = sec;
          if (sec !== lastSection) {
            lastSection = sec;
            if (frame.time - lastStepAt > 2) autoStep++;
            lastStepAt = frame.time;
          }
        } else {
          const block = Math.floor(a.beatCount / 32);
          if (block !== lastBeatMode) {
            lastBeatMode = block;
            autoStep++;
          }
        }
        // a drop that lands on a section change counts once
        if (dropHit && frame.time - lastStepAt > 2) {
          autoStep++;
          lastStepAt = frame.time;
        }
        want = autoStep % MODES.length;
      } else want = Math.max(0, MODES.indexOf(modeSel as (typeof MODES)[number]));

      // fold the old shape flat, then spring the new one up
      if (shown !== want) {
        fold.step(0, dt * 1.6);
        if (fold.value < 0.03) {
          shown = want;
          fold.value = 0;
          fold.vel = 0;
        }
      } else fold.step(1, dt);
      for (let i = 0; i < groups.length; i++) {
        const on = i === shown;
        groups[i].visible = on && fold.value > 0.004;
        if (on) groups[i].scale.y = Math.max(0.004, fold.value);
      }

      /* snare flutter, drop push */
      flutter = approach(flutter, 0, 7, dt);
      if (a.snareHit) flutter = 1;
      push = approach(push, 0, 2.5, dt);
      if (dropHit) push = 1;
      groups[shown].rotation.x = -flutter * 0.045;

      /* history for waterfall / rings */
      histAcc += dt * (5 + num(p, 'flow', 0.45) * 26);
      while (histAcc >= 1) {
        histAcc -= 1;
        head = (head + 1) % NS;
        const o = head * NP;
        for (let i = 0; i < NP; i++) hist[o + i] = specAt(a.spectrum, i / (NP - 1));
      }

      if (shown === 0) {
        for (let i = 0; i < NB; i++) {
          const u = i / (NB - 1);
          const s = specAt(a.spectrum, u * 0.92);
          const h = barSpring[i].step(0.04 + Math.pow(s, 1.6) * 1.45 * amp + a.kick * 0.1 * (1 - u), dt);
          barM.makeScale(1, Math.max(0.01, h), 1);
          barM.setPosition((u - 0.5) * W, 0, 0);
          bars.setMatrixAt(i, barM);
        }
        bars.instanceMatrix.needsUpdate = true;
      } else if (shown === 1) {
        const pc = curveGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < NC; i++) {
          const u = i / (NC - 1);
          let s = 0;
          for (let k = -2; k <= 2; k++) s += specAt(a.spectrum, u * 0.92 + k * 0.006) * (k === 0 ? 0.36 : Math.abs(k) === 1 ? 0.22 : 0.1);
          const edge = Math.min(1, u * 14, (1 - u) * 14);
          const target = (0.015 + Math.pow(s, 2.2) * 2.0 * amp) * edge;
          curveSm[i] = approach(curveSm[i], target, target > curveSm[i] ? 30 : 9, dt);
          pc[i * 6 + 4] = curveSm[i] + 0.004;
        }
        curveGeo.attributes.position.needsUpdate = true;
      } else if (shown === 2) {
        const pf = fallGeo.attributes.position.array as Float32Array;
        for (let s = 0; s < NS; s++) {
          const o = ((head - s + NS) % NS) * NP;
          const fade = 1 - (s / NS) * 0.35;
          for (let i = 0; i < NP; i++) {
            const u = i / (NP - 1);
            const edge = Math.min(1, u * 10, (1 - u) * 10);
            const top = 0.03 + Math.pow(hist[o + i], 1.8) * 1.5 * amp * fade * edge;
            const k = (s * NP + i) * 6;
            pf[k + 1] = Math.max(0, top - 0.035);
            pf[k + 4] = top;
          }
        }
        fallGeo.attributes.position.needsUpdate = true;
      } else {
        const pr = ringGeo.attributes.position.array as Float32Array;
        const tt = frame.time;
        for (let r = 0; r < NR; r++) {
          const o = ((head - r * 2 + NS * 4) % NS) * NP;
          const fall0 = 1 - r / NR;
          for (let i = 0; i <= NA; i++) {
            const th = (i / NA) * Math.PI * 2;
            const u = Math.abs(((th / Math.PI) % 2) - 1); // mirrored: symmetric crown
            const hv = hist[o + Math.min(NP - 1, Math.round(u * 0.85 * (NP - 1)))];
            const wav = Math.sin(th * 9 + tt * 1.4 - r * 0.6) * 0.035 * (0.4 + a.mid);
            const top = 0.07 + wav + Math.pow(hv, 1.7) * 1.2 * amp * (0.35 + 0.65 * fall0);
            const k = (r * (NA + 1) + i) * 6;
            pr[k + 1] = Math.max(0, top - 0.04);
            pr[k + 4] = Math.max(0.04, top);
          }
        }
        ringGeo.attributes.position.needsUpdate = true;
      }

      /* dots hop on kicks */
      const hop = num(p, 'hop', 0.6);
      for (let i = 0; i < NDOT; i++) {
        if ((a.kickHit && Math.random() < hop * 0.45) || (dropHit && Math.random() < 0.9))
          dvy[i] = (1.2 + Math.random() * 1.6) * (0.6 + a.kick * 0.6) * (dropHit ? 1.5 : 1);
        dvy[i] -= 11 * dt;
        dy[i] += dvy[i] * dt;
        if (dy[i] < 0) {
          dy[i] = 0;
          dvy[i] = dvy[i] < -1.2 ? -dvy[i] * 0.3 : 0;
        }
        barM.makeScale(ds[i], ds[i], ds[i]);
        barM.setPosition(dx[i], 0.021 * ds[i] + dy[i], dz[i]);
        dots.setMatrixAt(i, barM);
      }
      dots.instanceMatrix.needsUpdate = true;

      /* type */
      const showLabels = p.labels !== false;
      labels.visible = showLabels;
      if (showLabels) {
        const info = songInfo();
        const fg = '#' + fgCol.copy(pal.c.fg).lerp(pal.c.bg, 0.12).getHexString();
        title.draw(info.title, fg, 'right', 420);
        title.mesh.position.set(3.1, 2.05 + Math.sin(frame.time * 0.8) * 0.04 + a.level * 0.08, -1.9);
        artist.draw(info.artist, fg, 'left', 520);
        clock.draw(fmtClock(a.time), fg, 'right', 400, 0.62);
        const prog = a.duration > 0 ? Math.min(1, a.time / a.duration) : (frame.time * 0.02) % 1;
        bead.position.set((prog - 0.5) * W, 0.07, 2.75);
        const bs = 1 + a.kick * 0.35;
        bead.scale.setScalar(bs);
      }

      /* camera: per-shape angle, slow drift, a push on the drop */
      const cam = CAMS[shown];
      const drift = num(p, 'drift', 0.5);
      // pull back on narrower frames so the whole plot (plus a margin) stays in view
      const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(frame.aspect, 0.3);
      const need = (shown === 3 ? 4.2 : 5.3) / halfTan;
      camGoal.copy(cam.pos).sub(cam.look);
      camGoal.setLength(Math.max(camGoal.length(), need)).add(cam.look);
      if (firstFrame) {
        camPos.copy(camGoal);
        firstFrame = false;
      }
      camPos.lerp(camGoal, 1 - Math.exp(-dt * 0.9));
      camLook.lerp(cam.look, 1 - Math.exp(-dt * 0.9));
      const t = frame.time;
      camera.position.set(
        camPos.x + Math.sin(t * 0.11) * 0.9 * drift + a.sway * 0.25 * drift,
        camPos.y + Math.sin(t * 0.07 + 1) * 0.25 * drift,
        camPos.z + Math.cos(t * 0.09) * 0.4 * drift,
      );
      tmp.copy(camLook).sub(camera.position).multiplyScalar(push * 0.18);
      camera.position.add(tmp);
      camera.position.y += a.kick * 0.03;
      camera.lookAt(camLook);
    }

    return {
      render(frame, target) {
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          // keep the whole sheet in frame on tall screens
          camera.fov = frame.aspect < 1 ? 30 * Math.min(1.8, 1 / frame.aspect) : 30;
          camera.updateProjectionMatrix();
        }
        update(frame);
        const r = frame.renderer;
        const prevOn = r.shadowMap.enabled;
        const prevType = r.shadowMap.type;
        r.shadowMap.enabled = true;
        r.shadowMap.type = THREE.VSMShadowMap;
        r.setRenderTarget(target);
        r.render(scene, camera);
        r.shadowMap.enabled = prevOn;
        r.shadowMap.type = prevType;
      },
      dispose() {
        title.dispose();
        artist.dispose();
        clock.dispose();
        noise.dispose();
        sun.shadow.map?.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        });
      },
    };
  },
};
