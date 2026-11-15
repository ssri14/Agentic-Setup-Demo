import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type RunEvent } from './api';
import Modal from './Modal';
import { Plan } from './PlanList';
import { PlanDag } from './PlanDag';
import { category, foldTo, frameEvents, type GraphNode, type LaneAction, type ReplayState } from './replay';

// ---------- Agent graph ----------
const NODE_POS: Record<GraphNode, { x: number; y: number; label: string; w?: number }> = {
  start: { x: 170, y: 22, label: 'Start' }, intake: { x: 170, y: 74, label: 'Intake' }, plan: { x: 170, y: 144, label: 'Plan' },
  execute: { x: 170, y: 224, label: 'Execute tools' }, verify: { x: 170, y: 304, label: 'Verify' }, clarify: { x: 46, y: 224, label: 'Ask user', w: 80 },
  recover: { x: 330, y: 264, label: 'Recover', w: 84 },
  report: { x: 170, y: 384, label: 'Report (draft)' }, check: { x: 170, y: 456, label: 'Check claims' }, end: { x: 170, y: 520, label: 'End' },
};
const EDGES: { id: string; d: string; lx: number; ly: number }[] = [
  { id: 'start->intake', d: 'M170 30V52', lx: 182, ly: 44 },
  { id: 'intake->plan', d: 'M170 94V122', lx: 182, ly: 112 },
  { id: 'plan->execute', d: 'M170 164V202', lx: 182, ly: 186 },
  { id: 'execute->verify', d: 'M170 244V282', lx: 182, ly: 266 },
  { id: 'verify->report', d: 'M170 324V362', lx: 182, ly: 346 },
  { id: 'report->check', d: 'M170 404V434', lx: 182, ly: 422 },
  { id: 'check->end', d: 'M170 476V510', lx: 182, ly: 496 },
  { id: 'check->report', d: 'M230 450C256 450 256 392 232 392', lx: 252, ly: 428 },
  { id: 'check->plan', d: 'M230 462H392V140H232', lx: 382, ly: 300 },
  { id: 'report->end', d: 'M110 392C78 420 82 500 160 516', lx: 80, ly: 470 },
  { id: 'execute->execute', d: 'M204 204C212 186 236 190 230 210', lx: 230, ly: 192 },
  { id: 'verify->execute', d: 'M230 296C246 296 248 236 232 236', lx: 238, ly: 262 },
  { id: 'verify->plan', d: 'M230 314C266 314 266 152 232 152', lx: 258, ly: 186 },
  { id: 'plan->clarify', d: 'M110 152C70 152 50 170 46 202', lx: 62, ly: 168 },
  { id: 'verify->clarify', d: 'M110 304C66 304 46 280 46 246', lx: 58, ly: 286 },
  { id: 'clarify->plan', d: 'M70 202C80 160 92 140 108 138', lx: 90, ly: 186 },
  { id: 'plan->report', d: 'M110 140H92V378H108', lx: 84, ly: 330 },
  { id: 'execute->report', d: 'M110 230H100V390H108', lx: 104, ly: 356 },
  // recovery
  { id: 'execute->recover', d: 'M230 220C262 220 270 252 286 254', lx: 262, ly: 230 },
  { id: 'recover->execute', d: 'M288 272C266 272 262 244 234 242', lx: 272, ly: 282 },
  { id: 'plan->recover', d: 'M230 138C300 138 330 180 330 240', lx: 318, ly: 176 },
  { id: 'recover->plan', d: 'M346 242C350 150 300 130 232 132', lx: 352, ly: 160 },
  { id: 'verify->recover', d: 'M230 310C294 310 320 300 324 288', lx: 300, ly: 318 },
  { id: 'recover->verify', d: 'M340 286C340 326 290 322 232 320', lx: 340, ly: 330 },
  { id: 'recover->report', d: 'M334 286C340 370 290 386 232 386', lx: 322, ly: 372 },
  { id: 'recover->clarify', d: 'M330 242C330 214 300 196 270 196C200 196 120 196 86 210', lx: 296, ly: 192 },
];

function AgentGraph({ s }: { s: ReplayState }) {
  return (
    <svg viewBox="0 0 400 536" className="agent-graph" role="img" aria-label={`Agent graph, current node ${s.current}`}>
      <defs>
        <marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="g-arrowhead" /></marker>
        <marker id="g-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="g-arrowhead hot" /></marker>
      </defs>
      {EDGES.map((e) => {
        const n = s.edges[e.id] ?? 0, hot = s.lastEdge === e.id;
        return (
          <g key={e.id} className={`g-edge${n ? ' used' : ''}${hot ? ' hot' : ''}`}>
            <path d={e.d} fill="none" markerEnd={`url(#${hot ? 'g-arrow-hot' : 'g-arrow'})`} />
            {n > 0 && <text x={e.lx} y={e.ly} className="g-count">×{n}</text>}
          </g>
        );
      })}
      {(Object.keys(NODE_POS) as GraphNode[]).map((k) => {
        const p = NODE_POS[k], cur = s.current === k, seen = s.visited.includes(k);
        if (k === 'start' || k === 'end') {
          return <g key={k} className={`g-node${cur ? ' current' : ''}${seen ? ' seen' : ''}`}><circle cx={p.x} cy={p.y} r="8" /><text x={p.x + 14} y={p.y + 4} className="g-small">{p.label}</text></g>;
        }
        const w = p.w ?? 120;
        return (
          <g key={k} className={`g-node${k === 'recover' ? ' recover' : ''}${cur ? ' current' : ''}${seen ? ' seen' : ''}`}>
            <rect x={p.x - w / 2} y={p.y - 20} width={w} height="40" rx="9" />
            <text x={p.x} y={p.y + 5} textAnchor="middle">{p.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- Event detail ----------
function Json({ value }: { value: unknown }) { return <pre className="json small-pre">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

function BlobLink({ runId, id, label, auto }: { runId: string; id?: string | null; label: string; auto?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (auto && id) void load(); }, [auto, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!id) return null;
  async function load() {
    const res = await fetch(`/api/runs/${runId}/blobs/${id}`, { credentials: 'same-origin' });
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw);
      setText(Array.isArray(parsed) && parsed[0]?.role ? parsed.map((m: { role: string; content: string }) => `── ${m.role.toUpperCase()} ──\n${m.content}`).join('\n\n') : JSON.stringify(parsed, null, 2));
    } catch { setText(raw); }
  }
  return text === null ? <button className="linkish small" onClick={load}>Show {label}</button> : <><div className="row-label">{label}</div><Json value={text} /></>;
}

function Detail({ e, runId }: { e: RunEvent; runId: string }) {
  const p = e.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (e.type) {
    case 'llm_call': return (<>
      <div className="kv2"><span>Role</span><b>{p.role}</b><span>Model</span><span className="mono">{p.provider}:{p.model}</span><span>Attempt</span><span>{p.attempt}{p.ok ? ' · valid' : ' · rejected'}</span><span>Time</span><span>{p.duration_ms} ms</span></div>
      {p.error && <div className="task-note err">{p.error}</div>}
      {p.response_preview && <><div className="row-label">Response</div><Json value={p.response_preview} /></>}
      <BlobLink runId={runId} id={p.response_blob} label="full response" /> <BlobLink runId={runId} id={p.prompt_blob} label="prompt" />
    </>);
    case 'tool_called': return (<>
      <div className="kv2"><span>Task</span><b>{p.task}</b><span>Tool</span><code className="tool">{p.tool}</code></div>
      {p.args?.code ? <><div className="row-label">Goal</div><p>{p.args.goal}</p><div className="row-label">Code written by the analyst</div><Json value={p.args.code} /></> : <><div className="row-label">Arguments</div><Json value={p.args} /></>}
    </>);
    case 'tool_result': return (<>
      <div className="kv2"><span>Task</span><b>{p.task}</b><span>Tool</span><code className="tool">{p.tool}</code>{p.duration_ms !== undefined && <><span>Time</span><span>{p.duration_ms} ms</span></>}</div>
      {p.ok ? <p className="strong">{p.summary}</p> : <div className="task-note err">{p.error}</div>}
      {!!p.evidence?.length && <><div className="row-label">Evidence</div><div>{p.evidence.map((x: { id: string; label: string }) => <span key={x.id} className="ev">{x.id} · {x.label}</span>)}</div></>}
      {p.data_preview && <><div className="row-label">Result</div><Json value={p.data_preview} /></>}
      <BlobLink runId={runId} id={p.data_blob} label="full result" />
    </>);
    case 'plan_created': case 'plan_revised': return (<>
      <p className="strong">{p.objective}</p>
      {p.reason && <div className="replan-reason">Why: {p.reason}</div>}
      {p.rationale && <p className="muted">{p.rationale}</p>}
      {!!p.hypotheses?.length && <><div className="row-label">Hypotheses</div><ul className="tight">{p.hypotheses.map((h: { id: string; statement: string }) => <li key={h.id}><b>{h.id}</b> {h.statement}</li>)}</ul></>}
    </>);
    case 'verification': return (<>
      <div className={`verdict v-${p.status}`}><b>{p.hypothesis}</b> {p.status} · {p.confidence}{p.rule ? ` · rule ${p.rule}` : ''}</div>
      <p>{p.statement}</p>
      {p.note && <p className="muted">{p.note}</p>}
      <div className="kv2"><span>For</span><span>{p.evidence_for?.join(', ') || '–'}</span><span>Against</span><span>{p.evidence_against?.join(', ') || '–'}</span></div>
    </>);
    case 'decision': if (p.by === 'check') return (<><div className="kv2"><span>Claim check</span><b>{p.action === 'revise' ? 'investigate further (back to Plan)' : 'rewrite the answer (back to Report)'}</b></div><p style={{ whiteSpace: 'pre-wrap' }}>{p.reason}</p></>);
      return p.by === 'recover' ? (<>
      <div className="kv2"><span>Failure in</span><b>{p.failure?.node === 'execute' ? p.failure.tasks.join(', ') : p.failure?.node === 'plan' ? 'the planner' : 'the verifier'}</b>
        <span>Model asked</span><b>{p.requested}</b><span>Action taken</span><b>{p.action}{p.fallback ? ' (fallback: the recovery model failed)' : ''}</b><span>Next node</span><b>{p.route}</b></div>
      {p.note && <div className="task-note">Guard: {p.note}</div>}
      <p>{p.reason}</p>
      {p.failure?.error && <><div className="row-label">Error</div><div className="task-note err">{p.failure.error}</div></>}
      {!!p.corrected?.length && <p className="muted small">Corrected arguments for {p.corrected.join(', ')}.</p>}
    </>) : (<><div className="kv2"><span>Verifier asked</span><b>{p.requested}</b><span>Route taken</span><b>{p.route === 'execute' ? 'continue' : p.route}</b></div><p>{p.reason}</p></>);
    case 'answer_drafted': return (<>
      <div className="kv2"><span>Round</span><b>{p.round}</b><span>Draft confidence</span><b>{p.confidence}</b></div>
      <div className="row-label">Claims to check</div>
      <ul className="tight">{(p.claims ?? []).map((c: { id: string; text: string; evidence: string[]; quote: string }) => <li key={c.id}><b>{c.id}</b> {c.text} <span className="muted">[{c.evidence.join(', ')}] “{c.quote}”</span></li>)}</ul>
    </>);
    case 'claim_check': return (<>
      <div className="kv2"><span>Round</span><b>{p.round}</b><span>Checker</span><b>{p.checker_error ? `unavailable (${p.checker_error})` : p.next ?? '–'}</b></div>
      <ul className="claims">{(p.claims ?? []).map((c: { id: string; text: string; verdict: string; quote: string; quote_found: boolean; explanation: string; contradicting: { evidence: string; quote: string }[]; evidence: string[] }) => (
        <li key={c.id} className={`claim v-${c.verdict}`}><span className="claim-mark">{c.verdict === 'supported' ? '✓' : c.verdict === 'unchecked' ? '•' : '✗'}</span>
          <div><div><b>{c.id}</b> {c.text} <span className="muted">[{c.evidence.join(', ')}]</span></div>
            <div className="claim-quote">“{c.quote}” {c.quote_found ? '· quote found' : '· quote NOT found'}</div>
            <div className={c.verdict === 'supported' ? 'muted small' : 'claim-why'}>{c.verdict}: {c.explanation}{c.contradicting.map((x) => ` ${x.evidence} says “${x.quote}”.`).join('')}</div></div></li>))}</ul>
      {p.guidance && <p className="muted small">Guidance: {p.guidance}</p>}
    </>);
    case 'node_failed': return (<><div className="kv2"><span>Node</span><b>{p.node}</b></div><div className="task-note err">{p.error}</div><p className="muted small">{p.node === 'report' ? 'A partial answer is built without the model.' : 'The failure goes to the recovery node.'}</p></>);
    case 'task_status': return (<><div className="kv2"><span>Task</span><b>{p.task}</b><span>Status</span><b>{p.status}</b></div>{(p.summary || p.error) && <p className={p.error ? 'task-note err' : ''}>{p.error ?? p.summary}</p>}</>);
    case 'hypothesis_updated': return (<><div className="kv2"><span>Hypothesis</span><b>{p.id}</b><span>Status</span><b>{p.status}</b></div><p>{p.statement}</p></>);
    case 'context_loaded': return (<><div className="kv2"><span>Sections</span><span>{p.sections?.length}</span><span>Runs</span><span>{p.runs?.length}</span><span>Subsystems</span><span>{p.subsystems?.join(', ')}</span></div><Json value={p.sections} /></>);
    case 'clarification_asked': return (<><p className="strong">{p.question}</p>{!!p.options?.length && <ul className="tight">{p.options.map((o: string) => <li key={o}>{o}</li>)}</ul>}</>);
    case 'clarification_answered': return <p><b>{p.question}</b><br />→ {p.answer}</p>;
    case 'run_started': return (<><p className="strong">{p.question}</p><div className="row-label">Models</div><Json value={p.models} /><div className="row-label">Budgets</div><Json value={p.budgets} /></>);
    case 'run_finished': return (<><div className="kv2"><span>Status</span><b>{p.status}</b>{p.report && <><span>Confidence</span><b>{p.report.confidence}</b></>}</div>
      {p.report ? <p>{String(p.report.conclusion).slice(0, 900)}</p> : <div className="task-note err">{p.error}</div>}
      {p.totals && <Json value={p.totals} />}</>);
    case 'node_entered': return <p>Entered <b>{p.node}</b> at {p.elapsed_s} s.</p>;
    default: return <Json value={p} />;
  }
}

// ---------- Popup ----------
const SPEEDS = [0.5, 1, 2, 4];

export default function ReplayModal({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [run, setRun] = useState<{ question: string; status: string; totals?: Record<string, number>; models?: Record<string, string> } | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);   // a plan version picked by the viewer
  const [planView, setPlanView] = useState<'graph' | 'list'>('graph');
  const [tab, setTab] = useState<'event' | 'state' | 'context'>('event');
  const [error, setError] = useState('');
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runId) return;
    setEvents([]); setIndex(0); setPlaying(false); setError(''); setPinned(null);
    api<{ run: typeof run; events: RunEvent[] }>('GET', `/api/runs/${runId}/events`)
      .then((r) => { setRun(r.run); setEvents(r.events); setPlaying(true); }).catch((e) => setError(e.message));
  }, [runId]);

  const frames = useMemo(() => frameEvents(events), [events]);
  const current = frames[index];
  const state = useMemo(() => (current ? foldTo(events, current.seq) : null), [events, current]);
  const atEnd = index >= frames.length - 1;

  useEffect(() => {
    if (!playing || atEnd) { if (atEnd) setPlaying(false); return; }
    const t = setTimeout(() => setIndex((i) => Math.min(i + 1, frames.length - 1)), 1000 / speed);
    return () => clearTimeout(t);
  }, [playing, index, speed, atEnd, frames.length]);

  const step = useCallback((d: number) => { setPlaying(false); setIndex((i) => Math.max(0, Math.min(frames.length - 1, i + d))); }, [frames.length]);
  useEffect(() => {
    if (!runId) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => (atEnd ? (setIndex(0), true) : !p)); }
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'Home') { setPlaying(false); setIndex(0); }
      else if (e.key === 'End') { setPlaying(false); setIndex(frames.length - 1); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [runId, step, atEnd, frames.length]);

  const seekFromPointer = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(frames.length - 1, Math.round(((clientX - r.left) / r.width) * (frames.length - 1))));
  };
  const snap = state?.snapshot as { plan_version?: number; tasks?: Record<string, number>; hypotheses?: Record<string, number>; evidence?: number; budget?: Record<string, number> } | null;
  const latestPlan = state?.plans.find((p) => p.version === pinned) ?? state?.plans.at(-1);

  return (
    <Modal open={runId !== null} onClose={onClose} replay>
      <div className="replay">
        <header className="replay-head">
          <div className="replay-q"><span className="replay-tag">Replay</span>{run?.question ?? 'Loading…'}</div>
          {run?.totals && <div className="muted small">{run.totals.tool_calls} tool calls · {run.totals.plan_versions} plan versions · {run.totals.recoveries ?? 0} recoveries · {run.totals.llm_calls} model calls · {run.totals.elapsed_s} s</div>}
          <button className="icon-btn" onClick={onClose} aria-label="Close replay">✕</button>
        </header>
        {error && <div className="banner-error">{error}</div>}
        {state && current && (
          <>
            <div className="replay-panels">
              <section className="rp-panel"><h4>Agent graph</h4><AgentGraph s={state} /><div className="muted small center">{state.stage}</div></section>
              <section className="rp-panel rp-plan">
                <h4>Plan <span className="seg">{(['graph', 'list'] as const).map((v) => <button key={v} className={planView === v ? 'on' : ''} onClick={() => setPlanView(v)}>{v === 'graph' ? 'Graph' : 'List'}</button>)}</span> {latestPlan ? <span className="plan-tabs">{state.plans.map((p) => <button key={p.version} className={p === latestPlan ? 'ptab on' : 'ptab'} title={p === state.plans.at(-1) ? 'Latest version' : 'Show this earlier version'} onClick={() => setPinned(p === state.plans.at(-1) ? null : p.version)}>v{p.version}</button>)}</span> : null}</h4>
                {latestPlan ? (<>
                  <p className="muted small"><b>Version {latestPlan.version}</b>  |  {latestPlan.steps.flatMap((s) => s.tasks).filter((x) => x.status === 'succeeded').length} of {latestPlan.steps.flatMap((s) => s.tasks).length} tasks completed  ·  {latestPlan.objective}</p>
                  {latestPlan !== state.plans.at(-1) && <div className="muted small">Viewing an earlier version. <button className="linkish small" onClick={() => setPinned(null)}>Back to latest</button></div>}
                  {latestPlan.reason && <div className="replan-reason">Replanned: {latestPlan.reason}</div>}
                  {!!state.hypotheses.length && <div className="hypotheses">{state.hypotheses.map((h) => (
                    <div key={h.id} className={`hyp h-${h.status}`}><b>{h.id}</b> <span className="hyp-text">{h.statement}</span> <span className="hyp-status">{h.status}{h.status !== 'untested' ? ` · ${h.confidence}` : ''}</span></div>))}</div>}
                  <div key={latestPlan.version} className="plan-enter">{planView === 'graph'
                    ? <PlanDag plan={latestPlan} run={{
                        deciding: latestPlan === state.plans.at(-1) ? state.deciding : null,
                        decision: latestPlan === state.plans.at(-1) ? state.decision : { by: 'verify', action: 'revise', fallback: false },
                        counts: state.decisions as Partial<Record<LaneAction, number>>,
                        response: state.current === 'end' ? (state.status === 'complete' ? 'succeeded' : 'failed') : state.current === 'report' || state.current === 'check' ? 'executing' : 'pending' }} />
                    : <Plan plan={latestPlan} />}</div>
                </>) : <p className="muted">No plan yet.</p>}
              </section>
              <section className="rp-panel rp-detail">
                <div className="seg detail-tabs">{(['event', 'state', 'context'] as const).map((v) => <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{{ event: 'Event', state: 'See state', context: 'See context' }[v]}</button>)}</div>
                {tab === 'event' && <>
                  <h4><span className={`cat c-${category(current.type, current.payload)}`}>{current.type.replaceAll('_', ' ')}</span> <span className="muted small">#{current.seq} · {current.node}</span></h4>
                  <p className="strong">{current.summary}</p>
                  <Detail key={current.seq} e={current} runId={runId!} />
                </>}
                {tab === 'state' && <>
                  <p className="muted small">The agent's state after event #{current.seq}, rebuilt from the event log.</p>
                  <Json value={{ node: state.current, stage: state.stage, plan_version: state.plans.at(-1)?.version ?? 0, last_decision: state.decision, hypotheses: state.hypotheses, verdicts: state.verdicts, counters: state.snapshot, plan: state.plans.at(-1) ?? null }} />
                </>}
                {tab === 'context' && <>
                  {state.lastModelCall ? <>
                    <p className="muted small">The latest model call up to this point: what the {String(state.lastModelCall.payload.role)} was shown and what it returned.</p>
                    <div className="kv2"><span>Event</span><span>#{state.lastModelCall.seq}</span><span>Role</span><b>{String(state.lastModelCall.payload.role)}</b><span>Model</span><span className="mono">{String(state.lastModelCall.payload.provider)}:{String(state.lastModelCall.payload.model)}</span></div>
                    <BlobLink key={`p${state.lastModelCall.seq}`} runId={runId!} id={state.lastModelCall.payload.prompt_blob as string} label="prompt (system + mission + plan + evidence)" auto />
                    <BlobLink key={`r${state.lastModelCall.seq}`} runId={runId!} id={state.lastModelCall.payload.response_blob as string} label="response" />
                  </> : <p className="muted">No model call yet.</p>}
                  <div className="row-label">Mission context loaded at intake</div>
                  <Json value={state.context ?? 'not loaded yet'} />
                </>}
              </section>
            </div>
            <footer className="replay-foot">
              <div className="controls">
                <button className="btn small" onClick={() => { setPlaying(false); setIndex(0); }} title="Start (Home)">⏮</button>
                <button className="btn small" onClick={() => step(-1)} title="Back (←)">◀</button>
                <button className="btn small primary play" onClick={() => { if (atEnd) { setIndex(0); setPlaying(true); } else setPlaying(!playing); }} title="Play/pause (space)">{playing ? '❚❚ Pause' : atEnd ? '↺ Replay' : '▶ Play'}</button>
                <button className="btn small" onClick={() => step(1)} title="Forward (→)">▶</button>
                <button className="btn small" onClick={() => { setPlaying(false); setIndex(frames.length - 1); }} title="End (End)">⏭</button>
                <span className="speeds">{SPEEDS.map((x) => <button key={x} className={x === speed ? 'speed on' : 'speed'} onClick={() => setSpeed(x)}>{x}×</button>)}</span>
                <span className="muted small push-right-auto">event {index + 1} of {frames.length} · {Math.max(0, Math.round((Date.parse(current.at) - Date.parse(frames[0].at)) / 1000))} s into the run</span>
              </div>
              <div className="scrubber" ref={track} onPointerDown={(e) => { setPlaying(false); setIndex(seekFromPointer(e.clientX)); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
                onPointerMove={(e) => { setHover(seekFromPointer(e.clientX)); if (e.buttons) setIndex(seekFromPointer(e.clientX)); }} onPointerLeave={() => setHover(null)}>
                {frames.map((f, i) => (
                  <span key={f.seq} className={`tick c-${category(f.type, f.payload)}${i <= index ? ' past' : ''}${f.type === 'plan_revised' ? ' flag' : ''}`} style={{ left: `${(i / Math.max(1, frames.length - 1)) * 100}%` }} />
                ))}
                <span className="playhead" style={{ left: `${(index / Math.max(1, frames.length - 1)) * 100}%` }} />
                {hover !== null && frames[hover] && <span className="scrub-tip" style={{ left: `${(hover / Math.max(1, frames.length - 1)) * 100}%` }}>#{frames[hover].seq} {frames[hover].summary}</span>}
              </div>
              <div className="legend">{(['llm', 'tool', 'verify', 'decision', 'plan', 'clarify', 'fail'] as const).map((c) => <span key={c}><i className={`dot c-${c}`} />{{ llm: 'Model call', tool: 'Tool', verify: 'Verification', decision: 'Decision / recovery', plan: 'Plan / replan', clarify: 'Clarification', fail: 'Failure' }[c]}</span>)}</div>
              <div className="summaries">
                <div className="summary-box">
                  <div className="row-label">State</div>
                  {snap ? <div className="kv3">
                    <span>Plan</span><b>v{snap.plan_version ?? 0}</b>
                    <span>Tasks</span><span>{snap.tasks?.succeeded ?? 0} done · {snap.tasks?.pending ?? 0} pending · {snap.tasks?.failed ?? 0} failed · {snap.tasks?.skipped ?? 0} skipped</span>
                    <span>Hypotheses</span><span>{Object.entries(snap.hypotheses ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none yet'}</span>
                    <span>Evidence</span><span>{snap.evidence ?? 0} items</span>
                    <span>Budget</span><span>{snap.budget?.tool_calls}/{snap.budget?.max_tool_calls} tool calls · {snap.budget?.llm_calls} model calls · {snap.budget?.revisions} replans · {snap.budget?.recoveries ?? 0} recoveries · {snap.budget?.elapsed_s} s</span>
                  </div> : <span className="muted small">Starting…</span>}
                </div>
                <div className="summary-box">
                  <div className="row-label">Memory and context</div>
                  <div className="kv3">
                    <span>Mission</span><span>{state.context ? `${state.context.sections.length} sections${state.context.hasTelemetry ? `, ${state.context.runs.length} runs, ${state.context.subsystems.length} subsystems` : ''}` : '–'}</span>
                    <span>Earlier turns</span><span>{state.usedHistory ? 'used (follow-up question)' : 'none'}</span>
                    <span>Clarifications</span><span>{state.clarifications.length ? state.clarifications.map((c) => `${c.question} → ${c.answer ?? '…'}`).join('; ') : 'none'}</span>
                    <span>Standing notes</span><span className="muted">none (memory notes arrive in Phase 5)</span>
                  </div>
                </div>
              </div>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
