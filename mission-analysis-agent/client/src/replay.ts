/** Rebuilds what the replay shows at any position by folding the run's events from the start, so stepping back is exact. */
import type { RunEvent } from './api';
import { applyEvent, initialLive, type LiveState } from './liveRun';

export const GRAPH_NODES = ['start', 'intake', 'plan', 'execute', 'verify', 'recover', 'clarify', 'report', 'check', 'end'] as const;
/** The five routes of the recovery lane; the verifier's own decisions light the matching ones (replan → revise, report → finish). */
export type LaneAction = 'retry' | 'skip' | 'revise' | 'clarify' | 'finish';
export type GraphNode = (typeof GRAPH_NODES)[number];

export interface ReplayState extends LiveState {
  current: GraphNode;
  visited: GraphNode[];
  edges: Record<string, number>;
  lastEdge: string | null;
  snapshot: Record<string, unknown> | null;
  context: { sections: string[]; runs: string[]; subsystems: string[]; hasTelemetry: boolean } | null;
  usedHistory: boolean;
  clarifications: { question: string; answer?: string }[];
  verdicts: Record<string, { status: string; confidence: string; rule: string | null; note: string }>;
  decision: { by: 'verify' | 'recover' | 'check'; action: LaneAction | null; route: string; requested: string; reason: string; seq: number; fallback: boolean } | null;
  decisions: Record<string, number>;
  deciding: 'verify' | 'recover' | 'check' | null;
  failure: { node: string; tasks: string[]; error: string } | null;
  lastModelCall: RunEvent | null;
}

export type Category = 'llm' | 'tool' | 'verify' | 'decision' | 'plan' | 'clarify' | 'fail' | 'run' | 'other';
export function category(type: string, payload: Record<string, unknown> = {}): Category {
  if (type === 'node_failed' || (type === 'tool_result' && payload.ok === false) || (type === 'task_status' && payload.status === 'failed') || (type === 'llm_call' && payload.injected)) return 'fail';
  if (type === 'llm_call') return 'llm';
  if (type === 'tool_called' || type === 'tool_result' || type === 'task_status') return 'tool';
  if (type === 'verification' || type === 'hypothesis_updated') return 'verify';
  if (type === 'decision' || type === 'budget_warning') return 'decision';
  if (type === 'plan_created' || type === 'plan_revised') return 'plan';
  if (type.startsWith('clarification')) return 'clarify';
  if (type === 'claim_check') return (payload.claims as { verdict: string }[] | undefined)?.some((c) => c.verdict === 'contradicted' || c.verdict === 'unsupported') ? 'fail' : 'verify';
  if (type === 'run_started' || type === 'run_finished') return 'run';
  return 'other';
}

/** Events the replay steps through: everything except the bookkeeping snapshots. */
export const frameEvents = (events: RunEvent[]) => events.filter((e) => e.type !== 'state_snapshot');

const nodeOf = (n: string): GraphNode => ((GRAPH_NODES as readonly string[]).includes(n) ? (n as GraphNode) : 'start');

export function foldTo(events: RunEvent[], uptoSeq: number): ReplayState {
  let s: ReplayState = { ...initialLive(), current: 'start', visited: ['start'], edges: {}, lastEdge: null, snapshot: null, context: null, usedHistory: false, clarifications: [], verdicts: {}, decision: null, decisions: {}, deciding: null, failure: null, lastModelCall: null };
  for (const e of events) {
    if (e.seq > uptoSeq) break;
    s = { ...s, ...applyEvent(s, e) } as ReplayState;
    const p = e.payload ?? {};
    let to: GraphNode | null = null;
    if (e.type === 'node_entered') to = nodeOf(String(p.node));
    if (e.type === 'run_finished') to = 'end';
    if (to) {
      const edge = `${s.current}->${to}`;
      s = { ...s, current: to, visited: s.visited.includes(to) ? s.visited : [...s.visited, to], edges: { ...s.edges, [edge]: (s.edges[edge] ?? 0) + 1 }, lastEdge: edge };
    }
    if (e.type === 'state_snapshot') s = { ...s, snapshot: p };
    if (e.type === 'context_loaded') s = { ...s, context: p as ReplayState['context'] };
    if (e.type === 'run_started') s = { ...s, usedHistory: Boolean(p.history) };
    if (e.type === 'clarification_asked') s = { ...s, clarifications: [...s.clarifications, { question: String(p.question) }] };
    if (e.type === 'clarification_answered') s = { ...s, clarifications: s.clarifications.map((c, i, a) => (i === a.length - 1 ? { ...c, answer: String(p.answer) } : c)) };
    if (e.type === 'decision') {
      const route = String(p.route), by = p.by === 'recover' ? 'recover' as const : p.by === 'check' ? 'check' as const : 'verify' as const;
      const action = (by === 'recover' ? String(p.action) : by === 'check' ? (p.action === 'revise' ? 'revise' : null) : ({ plan: 'revise', clarify: 'clarify', report: 'finish' } as Record<string, string>)[route] ?? null) as LaneAction | null;
      s = { ...s, decision: { by, action, route, requested: String(p.requested ?? route), reason: String(p.reason ?? ''), seq: e.seq, fallback: Boolean(p.fallback) },
        decisions: action ? { ...s.decisions, [action]: (s.decisions[action] ?? 0) + 1 } : s.decisions };
    }
    if (e.type === 'node_entered') s = { ...s, deciding: p.node === 'verify' || p.node === 'recover' || p.node === 'check' ? (p.node as 'verify' | 'recover' | 'check') : null };
    if (e.type === 'node_entered' && p.node === 'recover') s = { ...s, failure: ((s.snapshot as { failure?: ReplayState['failure'] } | null)?.failure) ?? s.failure };
    if (e.type === 'node_failed') s = { ...s, failure: { node: String(p.node), tasks: [], error: String(p.error) } };
    if (e.type === 'decision' || e.type === 'run_finished') s = { ...s, deciding: null };
    if (e.type === 'llm_call') s = { ...s, lastModelCall: e };
    if (e.type === 'verification') s = { ...s, verdicts: { ...s.verdicts, [String(p.hypothesis)]: { status: String(p.status), confidence: String(p.confidence), rule: (p.rule as string) ?? null, note: String(p.note ?? '') } } };
  }
  return s;
}
