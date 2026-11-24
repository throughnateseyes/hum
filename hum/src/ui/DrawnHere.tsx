/**
 * The drawings standing in the video that is on (PartShot.drawn): what they are about, each with the shots
 * it stands in and what it does there. A shot is a click away, and a drawing can be moved or taken out of
 * one. The Drawings section of the Video tab (Drawings.tsx) shows it.
 */
import { audioEngine } from '../audio/engine';
import { useDrawingsHere } from '../draw/hooks';
import { cancelJob, retryJob, useDrawJobs, type DrawJob } from '../draw/jobs';
import { drawingNow } from '../draw/session';
import type { DrawingAsset } from '../draw/types';
import { DRAWN_PUTS, type DrawnPut, type DrawnShot } from '../inside/drawnIds';
import { shotOfPart } from '../shot/partShots';
import { setPartsShot } from '../state/partEdit';
import { partNames, validPlan } from '../state/plan';
import { useStudio, type StudioState } from '../state/store';
import { X } from './Icons';

export const PUT_NAMES: Record<DrawnPut, string> = { ground: 'On the ground', between: 'Behind people', far: 'Far off', wall: 'Along a wall' };

interface Placed {
  i: number;
  at: number;
  name: string;
  drawn: DrawnShot;
}

/** every shot of the video with a drawing in it, in order */
export function placedIn(s: StudioState): Placed[] {
  const a = s.analysis;
  if (!a || !validPlan(s.plan, a)) return [];
  const names = partNames(a);
  return a.sections.flatMap((sec, i) => {
    const shot = shotOfPart(i, s);
    return shot?.drawn && shot.style === 'inside' ? [{ i, at: sec.start, name: names[i], drawn: shot.drawn }] : [];
  });
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function DrawnHere({ thumb }: { thumb: (d: DrawingAsset) => React.ReactNode }) {
  const plan = useStudio((s) => s.plan);
  useStudio((s) => s.partShot);
  useStudio((s) => s.analysis);
  const here = useDrawingsHere();
  const jobs = useDrawJobs((s) => s.jobs);
  const placed = placedIn(useStudio.getState());
  if (!placed.length) return null;
  const groups = new Map<string, { asset: DrawingAsset | null; job?: DrawJob; name: string; shots: Placed[] }>();
  for (const p of placed) {
    const asset = drawingNow(p.drawn.id, here);
    const key = asset?.id ?? p.drawn.id;
    const g = groups.get(key);
    if (g) g.shots.push(p);
    else groups.set(key, { asset, job: jobs.find((j) => j.as === p.drawn.id || (asset && j.from === asset.id)), name: asset?.name ?? plan?.art?.drawings.find((d) => d.id === p.drawn.id)?.name ?? 'Drawing', shots: [p] });
  }
  return (
    <div className="dr-here">
      <span className="label">In this video</span>
      {plan?.art?.thread && <p className="field-note">{plan.art.thread}</p>}
      {[...groups.entries()].map(([id, g]) => (
        <div key={id} className="dr-used">
          <span className="dr-pic">{g.asset ? thumb(g.asset) : <span className="dr-state">{g.job && g.job.state !== 'failed' && <span className="spin" />}</span>}</span>
          <div className="dr-grow">
            <b>{g.name}</b>
            {!g.asset && <State job={g.job} />}
            {g.shots.map((p) => (
              <Shot key={p.i} p={p} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function State({ job }: { job?: DrawJob }) {
  if (!job) return <p className="dr-busy">Not drawn, so these shots are without it.</p>;
  if (job.state === 'failed')
    return (
      <p className="dr-busy">
        {job.error}
        <button type="button" className="dr-link" onClick={() => retryJob(job.id)}>
          Try again
        </button>
      </p>
    );
  return (
    <p className="dr-busy">
      {job.state === 'waiting' ? 'Waiting to be drawn' : 'Being drawn'}
      <button type="button" className="dr-link" onClick={() => cancelJob(job.id)}>
        Don’t draw it
      </button>
    </p>
  );
}

function Shot({ p }: { p: Placed }) {
  return (
    <div className="dr-shot">
      <button type="button" className="dr-go" onClick={() => audioEngine.seek(p.at + 0.02)} title={`Go to ${p.name}`}>
        <span className="dr-time">{clock(p.at)}</span>
        <span>{p.drawn.why || p.name}</span>
      </button>
      <select className="dr-put" aria-label={`Where it stands at ${clock(p.at)}`} value={p.drawn.put} onChange={(e) => setPartsShot([p.i], { drawn: { ...p.drawn, put: e.target.value as DrawnPut } })}>
        {DRAWN_PUTS.map((x) => (
          <option key={x} value={x}>
            {PUT_NAMES[x]}
          </option>
        ))}
      </select>
      <button type="button" className="dr-out" onClick={() => setPartsShot([p.i], { drawn: null })} aria-label={`Take it out of the shot at ${clock(p.at)}`} title="Take it out of this shot">
        <X width={11} height={11} aria-hidden />
      </button>
    </div>
  );
}
