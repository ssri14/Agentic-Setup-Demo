import { useLayoutEffect, useRef, useState } from 'react';
import type { PlanStep, PlanView, TaskStatus } from './api';
import type { LaneAction } from './replay';
import { stepStatus } from './PlanList';

/**
 * The plan as a dependency graph of step cards with the verifier's decision lane on the right,
 * after the desktop HR agent's Live Plan: dashed links from every step to the decision hub,
 * and from the hub to the four routes it can take; a final response card closes the plan.
 */
type CardStatus = TaskStatus | 'available' | 'active' | 'completed';

const W = 214, GAP_X = 20, GAP_Y = 46, HEAD = 58, ROW = 20, PAD = 12, TOP = 10;
const HUB_W = 186, HUB_H = 58, ACT_W = 184, ACT_H = 54, ACT_GAP = 12, LANE_GAP = 56;
const SHORT: Record<string, string> = { search_documents: 'SEARCH', read_section: 'SECTION', get_table: 'TABLE', get_figure: 'FIGURE', lookup_channels: 'CHANNELS',
  list_runs: 'RUNS', telemetry_window: 'TELEMETRY', events_window: 'EVENTS', run_analysis: 'PYTHON', graph_neighbours: 'GRAPH' };
const LABEL: Record<string, string> = { pending: 'WAITING', executing: 'ACTIVE', succeeded: 'DONE', failed: 'FAILED', skipped: 'SKIPPED', available: 'AVAILABLE', active: 'ACTIVE', completed: 'COMPLETED' };
const ROUTES: { id: LaneAction; title: string; tag: string }[] = [
  { id: 'retry', title: 'Retry failed stage', tag: 'RETRY' },
  { id: 'skip', title: 'Continue without it', tag: 'SKIP' },
  { id: 'revise', title: 'Revise remaining plan', tag: 'REVISE' },
  { id: 'clarify', title: 'Ask for clarification', tag: 'CLARIFY' },
  { id: 'finish', title: 'Build final / partial response', tag: 'FINISH' },
];

export interface DagRunState {
  deciding: 'verify' | 'recover' | null;          // who is deciding right now
  decision: { by: 'verify' | 'recover'; action: LaneAction | null; fallback: boolean } | null;   // the latest decision
  counts: Partial<Record<LaneAction, number>>;
  response: 'pending' | 'executing' | 'succeeded' | 'failed';
}

export function PlanDag({ plan, run }: { plan: PlanView; run: DagRunState }) {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const level = (id: string, seen = new Set<string>()): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (byId.get(id)?.depends_on ?? []).filter((d) => byId.has(d));
    const v = deps.length ? 1 + Math.max(...deps.map((d) => level(d, seen))) : 0;
    memo.set(id, v); return v;
  };
  const rows: PlanStep[][] = [];
  for (const s of plan.steps) (rows[level(s.id)] ??= []).push(s);
  const dense = rows.filter(Boolean);
  const height = (s: PlanStep) => HEAD + s.tasks.length * ROW + PAD;
  const perRow = Math.max(1, ...dense.map((r) => r.length));
  const mainW = Math.max(W + 20, perRow * W + (perRow - 1) * GAP_X + 20);
  const pos = new Map<string, { x: number; y: number; h: number }>();
  let y = TOP;
  for (const r of dense) {
    const rowW = r.length * W + (r.length - 1) * GAP_X, x0 = (mainW - rowW) / 2;
    r.forEach((s, i) => pos.set(s.id, { x: x0 + i * (W + GAP_X), y, h: height(s) }));
    y += Math.max(...r.map(height)) + GAP_Y;
  }
  // The response card, after every step nothing else depends on.
  const leaves = plan.steps.filter((s) => !plan.steps.some((o) => o.depends_on?.includes(s.id)));
  const resp = { x: (mainW - W) / 2, y, h: 62 };
  const mainH = resp.y + resp.h + TOP;

  const hub = { x: mainW + LANE_GAP, y: TOP, w: HUB_W, h: HUB_H };
  const acts = ROUTES.map((r, i) => ({ ...r, x: hub.x + 28, y: hub.y + HUB_H + 30 + i * (ACT_H + ACT_GAP) }));
  const width = hub.x + Math.max(HUB_W, 28 + ACT_W) + 8;
  const totalH = Math.max(mainH, acts.at(-1)!.y + ACT_H + TOP);

  const chosen = run.decision?.action ?? null;
  const recovering = run.deciding === 'recover' || (!run.deciding && run.decision?.by === 'recover');
  const hubStatus: CardStatus = run.deciding ? 'active' : chosen ? (run.decision?.fallback ? 'failed' : 'completed') : 'available';
  const actStatus = (r: LaneAction): CardStatus => (run.deciding || chosen !== r ? 'available' : 'completed');
  const failedSteps = new Set(plan.steps.filter((s) => s.tasks.some((t) => t.status === 'failed')).map((s) => s.id));
  const respStatus: CardStatus = run.response;

  // Scale the drawing down to the panel's width (never up).
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 4) / width));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  // Keep whatever is active in view as the replay moves down the plan.
  useLayoutEffect(() => {
    box.current?.querySelector('.dag-card.d-executing, .lane-card.l-active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const curveDown = (x1: number, y1: number, x2: number, y2: number) => { const m = (y1 + y2) / 2; return `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2 - 2}`; };
  const curveSide = (x1: number, y1: number, x2: number, y2: number) => { const m = (x1 + x2) / 2; return `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`; };
  const doneStep = (id: string) => stepStatus(byId.get(id)!) === 'succeeded';

  return (
    <div ref={box} className="dag-fit" style={{ height: totalH * scale }}>
      <div className="dag" style={{ width, height: totalH, transform: `scale(${scale})` }}>
        <svg width={width} height={totalH} className="dag-edges">
          <defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" className="dag-head" /></marker></defs>
          {/* dependencies */}
          {plan.steps.flatMap((s) => (s.depends_on ?? []).filter((d) => pos.has(d)).map((d) => {
            const a = pos.get(d)!, b = pos.get(s.id)!;
            return <path key={`${d}-${s.id}`} d={curveDown(a.x + W / 2, a.y + a.h, b.x + W / 2, b.y)} className={doneStep(d) ? 'dag-edge done' : 'dag-edge'} markerEnd="url(#dag-arrow)" />;
          }))}
          {leaves.map((s) => { const a = pos.get(s.id)!; return <path key={`${s.id}-resp`} d={curveDown(a.x + W / 2, a.y + a.h, resp.x + W / 2, resp.y)} className={doneStep(s.id) ? 'dag-edge done' : 'dag-edge'} markerEnd="url(#dag-arrow)" />; })}
          {/* every step can fall into the verifier's decision */}
          {plan.steps.map((s) => { const a = pos.get(s.id)!; return <path key={`${s.id}-hub`} d={curveSide(a.x + W, a.y + Math.min(a.h / 2, 34), hub.x, hub.y + HUB_H / 2)} className={`lane-edge${failedSteps.has(s.id) ? ' fail' : run.deciding ? ' hot' : ''}`} />; })}
          {acts.map((a) => <path key={a.id} d={`M${hub.x + 14} ${hub.y + HUB_H}C${hub.x + 14} ${a.y + ACT_H / 2} ${a.x - 20} ${a.y + ACT_H / 2} ${a.x} ${a.y + ACT_H / 2}`} className={`lane-edge${!run.deciding && chosen === a.id ? ' chosen' : ''}`} />)}
        </svg>

        {plan.steps.map((s) => {
          const p = pos.get(s.id)!, st = stepStatus(s);
          return (
            <div key={s.id} className={`dag-card d-${st}`} style={{ left: p.x, top: p.y, width: W, height: p.h }} title={`${s.id} ${s.title}\n` + s.tasks.map((t) => `${t.id} ${t.tool}: ${t.purpose}`).join('\n')}>
              <div className="dag-title"><span className="step-id">{s.id}</span> {s.title}</div>
              <div className="dag-state">{s.tasks.length === 1 ? `${SHORT[s.tasks[0].tool] ?? s.tasks[0].tool}  |  ` : ''}{LABEL[st]}</div>
              {s.tasks.map((t) => (
                <div key={t.id} className={`dag-task d-${t.status}`}><i />{t.id}<b>{SHORT[t.tool] ?? t.tool}</b><span>{LABEL[t.status]}</span></div>
              ))}
            </div>
          );
        })}
        <div className={`dag-card d-${respStatus}`} style={{ left: resp.x, top: resp.y, width: W, height: resp.h }}>
          <div className="dag-title">Write the answer with cited evidence</div>
          <div className="dag-state">RESPONSE  |  {LABEL[respStatus]}</div>
        </div>

        <div className={`lane-card hub l-${hubStatus}`} style={{ left: hub.x, top: hub.y, width: HUB_W, height: HUB_H }}>
          <b>{recovering ? 'Recovery decision' : 'Review / recovery decision'}</b><span>{run.deciding === 'recover' ? 'RECOVERY' : run.deciding === 'verify' ? 'VERIFY' : recovering ? 'RECOVERY' : 'DECISION'}  |  {LABEL[hubStatus]}{run.decision?.fallback && !run.deciding ? '  ·  FALLBACK' : ''}</span>
        </div>
        {acts.map((a) => (
          <div key={a.id} className={`lane-card l-${actStatus(a.id)}`} style={{ left: a.x, top: a.y, width: ACT_W, height: ACT_H }}>
            <b>{a.title}</b><span>{a.tag}  |  {LABEL[actStatus(a.id)]}{run.counts[a.id] ? `  ·  ×${run.counts[a.id]}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
