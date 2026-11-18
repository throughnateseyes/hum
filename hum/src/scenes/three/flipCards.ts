/**
 * Flip Cards — a grid of rounded colour cards, each with one big bold word turned in 90° steps.
 * Cards flip over on the beat to show a new word and colour pairing, skew into perspective
 * trapezoids on snares, bounce on kicks; every section deals a new set of colour pairings and a
 * drop flips the whole grid at once. Words come from the synced lyrics (the line being sung),
 * else the track title and artist, else a few short words.
 */
import * as THREE from 'three';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { approach, Spring, stepDt } from './common';
import { currentLyric, dropEdge, FONT_SANS, sectionIndex, songInfo } from './songInfo';

const params: ParamDef[] = [
  {
    id: 'grid',
    label: 'Grid',
    group: 'Layout',
    type: 'select',
    default: 'auto',
    hint: 'Auto: 4×2 on wide screens, 2×2 on tall ones',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: '2x2', label: '2 × 2' },
      { value: '3x2', label: '3 × 2' },
      { value: '4x2', label: '4 × 2' },
      { value: '3x3', label: '3 × 3' },
    ],
  },
  { id: 'gap', label: 'Gap', group: 'Layout', type: 'number', min: 0, max: 0.3, step: 0.005, default: 0.06 },
  { id: 'round', label: 'Corner radius', group: 'Layout', type: 'number', min: 0, max: 0.25, step: 0.005, default: 0.07 },
  {
    id: 'colors',
    label: 'Colours',
    group: 'Color',
    type: 'select',
    default: 'candy',
    options: [
      { value: 'candy', label: 'Candy pairs' },
      { value: 'palette', label: 'From the palette' },
    ],
  },
  { id: 'flips', label: 'Flips per beat', group: 'Reactivity', type: 'number', min: 0, max: 3, step: 0.05, default: 1 },
  { id: 'skew', label: 'Snare skew', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'bounce', label: 'Kick bounce', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'tilt', label: 'Idle tilt', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
];

// card colour, word colour
const CANDY: [string, string][] = [
  ['#0b3a2a', '#f7a1c4'],
  ['#ffd400', '#4a4200'],
  ['#4e0a7a', '#1fe26e'],
  ['#ff6b2b', '#ffe100'],
  ['#1f3cff', '#ffc2d4'],
  ['#f2ece0', '#151515'],
  ['#e8341c', '#ffe7cf'],
  ['#bfa6ff', '#1b1866'],
  ['#9bf0c6', '#0d4a2c'],
  ['#ff9fc1', '#c3001b'],
  ['#141414', '#ffd400'],
  ['#2d6bff', '#e8ff3a'],
];

const FALLBACK = ['flip', 'it', 'hum', 'turn', 'now', 'again', 'yes', 'go', 'up', 'over', 'hey', 'oh'];

const cleanWords = (s: string) =>
  s
    .replace(/[“”"()[\]{}]/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter(Boolean);

interface Face {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mat: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
}

interface Card {
  slot: THREE.Group;
  tilt: THREE.Group;
  flipper: THREE.Group;
  faces: [Face, Face];
  front: 0 | 1;
  flip: { axis: THREE.Vector3; t: number; dur: number; delay: number } | null;
  tiltX: Spring;
  tiltY: Spring;
  pair: [string, string];
  word: string;
  /** seconds since this card last flipped (so the beat picks stale cards first) */
  age: number;
  phase: number;
}

const easeInOutBack = (t: number) => {
  const c2 = 1.7 * 1.525;
  return t < 0.5 ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
};

export const flipCards: SceneDef = {
  id: 'flip-cards',
  name: 'Flip Cards',
  description:
    'A grid of rounded colour cards, each with one big bold word turned in 90° steps. Cards flip on the beat to new words and colour pairings, skew into perspective on snares and bounce on kicks; sections deal new colours and drops flip them all. Words come from the lyrics being sung, else the title and artist.',
  category: 'form',
  tags: ['playful', 'bold', 'pop', 'upbeat', 'energetic', 'bouncy', 'graphic', 'typographic'],
  showsLyrics: true,
  params,
  create() {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 10);
    const grid = new THREE.Group();
    scene.add(grid);

    let cards: Card[] = [];
    let layoutKey = '';
    let cardW = 1;
    let cardH = 1;
    let queue: string[] = [];
    let lyricKey = '';
    let lastSection = -2;
    let deal = 0;
    let lastBeat = -1;
    let flipBudget = 0;
    let punch = 0;
    const isDrop = dropEdge();
    const q = new THREE.Quaternion();
    const qT = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();

    // one soft rounded shadow shared by every card (only shows on light backgrounds)
    const shCanvas = document.createElement('canvas');
    shCanvas.width = 160;
    shCanvas.height = 200;
    {
      const c = shCanvas.getContext('2d')!;
      c.filter = 'blur(9px)';
      c.fillStyle = '#000';
      c.beginPath();
      c.roundRect(22, 22, 116, 156, 14);
      c.fill();
    }
    const shTex = new THREE.CanvasTexture(shCanvas);
    shTex.colorSpace = THREE.NoColorSpace;
    const shMat = new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0 });
    const shGeo = new THREE.PlaneGeometry(1, 1);

    const makeFace = (cw: number, ch: number): Face => {
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d')!;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.FrontSide, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      return { canvas, ctx, tex, mat, mesh };
    };

    const disposeCards = () => {
      for (const c of cards)
        for (const f of c.faces) {
          f.tex.dispose();
          f.mat.dispose();
          f.mesh.geometry.dispose();
        }
      grid.clear();
      cards = [];
    };

    const paintFace = (f: Face, pair: [string, string], word: string, round: number) => {
      const { ctx, canvas } = f;
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = pair[0];
      ctx.beginPath();
      const r = Math.min(W, H) * round * 1.6;
      ctx.roundRect(1, 1, W - 2, H - 2, r);
      ctx.fill();
      // the word, turned 0/90/180/270 and pushed toward an edge
      const k = Math.floor(Math.random() * 4);
      const turned = k % 2 === 1;
      const along = turned ? H : W;
      const across = turned ? W : H;
      const pad = Math.min(W, H) * 0.085;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate((k * Math.PI) / 2);
      let px = 100;
      ctx.font = `760 ${px}px ${FONT_SANS}`;
      const tw = ctx.measureText(word).width;
      px = Math.min((px * (along - pad * 2)) / Math.max(tw, 1), (across - pad * 2) * (word.length <= 3 ? 0.62 : 0.5) * 1.35);
      ctx.font = `760 ${px}px ${FONT_SANS}`;
      const m = ctx.measureText(word);
      const capH = px * 0.73;
      const left = Math.random() < 0.5;
      const top = Math.random() < 0.55;
      const x = left ? -along / 2 + pad : along / 2 - pad - m.width;
      const y = top ? -across / 2 + pad + capH : across / 2 - pad - px * 0.05;
      ctx.fillStyle = pair[1];
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(word, x, y);
      ctx.restore();
      f.tex.needsUpdate = true;
    };

    const pairsFor = (frame: FrameContext): [string, string][] => {
      if (str(frame.params, 'colors', 'candy') === 'palette') {
        const p = frame.palette;
        return [
          [p.accent, p.bg],
          [p.accent2, p.fg],
          [p.fg, p.accent2],
          [p.muted, p.accent],
          [p.accent, p.fg],
          [p.fg, p.bg],
        ];
      }
      return CANDY;
    };
    const pickPair = (frame: FrameContext, self?: Card): [string, string] => {
      const all = pairsFor(frame);
      // each section deals a hand of 4 pairings out of the set; prefer the one least on show
      const hand: [string, string][] = [];
      for (let i = 0; i < 4; i++) hand.push(all[(deal * 5 + i * 7) % all.length]);
      let best = hand[0];
      let bestScore = Infinity;
      for (const p of hand) {
        let score = Math.random() * 0.5;
        for (const c of cards) if (c !== self && c.pair[0] === p[0]) score += 1;
        if (self && self.pair[0] === p[0]) score += 2;
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      return best;
    };

    const sourceWords = (frame: FrameContext): string[] => {
      const lyr = currentLyric(frame.audio.time);
      if (lyr) return cleanWords(lyr.text);
      const typed = cleanWords(frame.text || '');
      if (typed.length) return typed;
      const info = songInfo();
      const w = [...cleanWords(info.title), ...cleanWords(info.artist)].filter((x) => !/^unknown|^untitled$/i.test(x));
      return w.length ? [...w, ...FALLBACK.slice(0, 2)] : FALLBACK;
    };
    const nextWord = (frame: FrameContext) => {
      if (!queue.length) queue = sourceWords(frame).slice(0, 12);
      if (!queue.length) queue = [...FALLBACK];
      return queue.shift()!;
    };

    const startFlip = (frame: FrameContext, c: Card, delay = 0, dur = 0.5) => {
      if (c.flip) return;
      const word = nextWord(frame);
      const pair = pickPair(frame, c);
      const back = c.faces[1 - c.front];
      paintFace(back, pair, word, num(frame.params, 'round', 0.07));
      c.pair = pair;
      c.word = word;
      const axis = Math.random() < 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      // the hidden face sits so that after a half turn about `axis` it faces the camera upright
      qT.setFromAxisAngle(axis, Math.PI).invert();
      back.mesh.quaternion.copy(qT);
      back.mesh.visible = true;
      c.flip = { axis, t: 0, dur, delay };
      c.age = 0;
    };

    const layout = (frame: FrameContext) => {
      const sel = str(frame.params, 'grid', 'auto');
      const gap = num(frame.params, 'gap', 0.06);
      const round = num(frame.params, 'round', 0.07);
      const asp = frame.aspect;
      const key = `${sel}|${asp.toFixed(3)}|${gap}|${round}`;
      if (key === layoutKey) return;
      layoutKey = key;
      let cols = 2;
      let rows = 2;
      if (sel === 'auto') {
        if (asp > 1.3) cols = 4;
        else if (asp > 0.95) cols = 3;
      } else [cols, rows] = sel.split('x').map(Number);
      const vh = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      const vw = vh * asp;
      const g = gap * vh * 0.25;
      cardH = (vh * 0.86 - g * (rows - 1)) / rows;
      cardW = cardH * 0.8;
      if (cardW * cols + g * (cols - 1) > vw * 0.9) {
        cardW = (vw * 0.9 - g * (cols - 1)) / cols;
        cardH = Math.min(cardH, cardW * 1.35);
      }
      // keep words when the grid is rebuilt
      const oldWords = cards.map((c) => c.word);
      disposeCards();
      const cw = cardW >= cardH ? 640 : Math.round((640 * cardW) / cardH);
      const ch = cardW >= cardH ? Math.round((640 * cardH) / cardW) : 640;
      const n = cols * rows;
      for (let i = 0; i < n; i++) {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const slot = new THREE.Group();
        slot.position.set((cx - (cols - 1) / 2) * (cardW + g), ((rows - 1) / 2 - cy) * (cardH + g), 0);
        const tilt = new THREE.Group();
        const flipper = new THREE.Group();
        slot.add(tilt);
        tilt.add(flipper);
        const shadow = new THREE.Mesh(shGeo, shMat);
        shadow.scale.set(cardW * 1.38, cardH * 1.3, 1);
        shadow.position.set(cardW * 0.03, -cardH * 0.05, -0.12);
        shadow.renderOrder = -1;
        slot.add(shadow);
        const faces: [Face, Face] = [makeFace(cw, ch), makeFace(cw, ch)];
        for (const f of faces) {
          f.mesh.scale.set(cardW, cardH, 1);
          flipper.add(f.mesh);
        }
        faces[1].mesh.visible = false;
        grid.add(slot);
        const pair = pickPair(frame);
        const word = oldWords[i] ?? nextWord(frame);
        paintFace(faces[0], pair, word, round);
        cards.push({
          slot,
          tilt,
          flipper,
          faces,
          front: 0,
          flip: null,
          tiltX: new Spring(70, 7, 0),
          tiltY: new Spring(70, 7, 0),
          pair,
          word,
          age: Math.random() * 4,
          phase: Math.random() * 10,
        });
      }
    };

    function update(frame: FrameContext) {
      const dt = stepDt(frame);
      const a = frame.audio;
      const p = frame.params;
      bg.copy(frame.palette.c.bg);
      const bgL = bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722;
      shMat.opacity = Math.max(0, (bgL - 0.35) * 0.45);
      layout(frame);

      /* what's being sung: a new line deals its words across the grid */
      const lyr = currentLyric(a.time);
      const lk = lyr ? `L${lyr.i}` : '';
      if (lk && lk !== lyricKey) {
        queue = cleanWords(lyr!.text).slice(0, cards.length);
        cards.forEach((c, i) => {
          if (i < queue.length || !c.flip) startFlip(frame, c, i * 0.07, 0.45);
        });
      }
      lyricKey = lk;

      /* sections deal new colour pairings; drops flip everything */
      const sec = sectionIndex(frame);
      if (sec >= 0 && sec !== lastSection) {
        if (lastSection !== -2) {
          deal++;
          cards.forEach((c, i) => startFlip(frame, c, i * 0.06, 0.55));
        }
        lastSection = sec;
      }
      if (isDrop(frame)) {
        deal++;
        punch = 1;
        cards.forEach((c, i) => startFlip(frame, c, (i % 3) * 0.03, 0.38));
      }

      /* the beat flips a card or two (stalest first) */
      const beat = a.playing ? a.beatCount : Math.floor(frame.time * 1.5);
      if (beat !== lastBeat) {
        lastBeat = beat;
        flipBudget += num(p, 'flips', 1);
        while (flipBudget >= 1) {
          flipBudget -= 1;
          const idle = cards.filter((c) => !c.flip).sort((x, y) => y.age - x.age);
          if (!idle.length) break;
          const pick = idle[Math.min(idle.length - 1, Math.floor(Math.random() * Math.min(3, idle.length)))];
          startFlip(frame, pick, 0, a.bpm > 0 ? Math.min(0.55, Math.max(0.3, 60 / a.bpm)) : 0.5);
        }
      }
      if (a.snareHit && cards.length) {
        const c = cards[Math.floor(Math.random() * cards.length)];
        const s = num(p, 'skew', 0.7);
        c.tiltY.vel += (Math.random() < 0.5 ? -1 : 1) * 9 * s;
        c.tiltX.vel += (Math.random() - 0.5) * 5 * s;
      }

      /* animate */
      punch = approach(punch, 0, 3, dt);
      const tiltAmt = num(p, 'tilt', 0.4);
      const bounce = num(p, 'bounce', 0.5);
      const t = frame.time;
      for (const c of cards) {
        c.age += dt;
        // idle: cards lean a little in perspective, swaying with the bar
        const ix = Math.sin(t * 0.6 + c.phase) * 0.12 * tiltAmt + a.sway * 0.05 * tiltAmt;
        const iy = Math.sin(t * 0.45 + c.phase * 1.7) * 0.18 * tiltAmt;
        c.tilt.rotation.set(c.tiltX.step(ix, dt), c.tiltY.step(iy, dt), 0);
        const sc = 1 + a.kick * 0.045 * bounce;
        c.slot.scale.set(sc, sc * (1 + a.kick * 0.02 * bounce), 1);
        if (c.flip) {
          const f = c.flip;
          if (f.delay > 0) f.delay -= dt;
          else {
            f.t = Math.min(1, f.t + dt / f.dur);
            q.setFromAxisAngle(f.axis, easeInOutBack(f.t) * Math.PI);
            c.flipper.quaternion.copy(q);
            // shade the face as it turns edge-on
            tmpV.set(0, 0, 1).applyQuaternion(c.flipper.quaternion);
            const shade = 0.55 + 0.45 * Math.abs(tmpV.z);
            for (const fc of c.faces) fc.mat.color.setScalar(shade);
            if (f.t >= 1) {
              // settle: the new face becomes the front, flipper back to rest
              const old = c.faces[c.front];
              old.mesh.visible = false;
              c.front = (1 - c.front) as 0 | 1;
              c.faces[c.front].mesh.quaternion.identity();
              c.flipper.quaternion.identity();
              for (const fc of c.faces) fc.mat.color.setScalar(1);
              c.flip = null;
            }
          }
        }
      }
      // the drop: a punch toward the camera
      grid.position.z = punch * 1.2;
      grid.rotation.z = Math.sin(punch * Math.PI) * 0.05;
    }

    return {
      render(frame, target) {
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          camera.updateProjectionMatrix();
        }
        update(frame);
        frame.renderer.setRenderTarget(target);
        frame.renderer.render(scene, camera);
      },
      dispose() {
        disposeCards();
        shTex.dispose();
        shMat.dispose();
        shGeo.dispose();
      },
    };
  },
};
