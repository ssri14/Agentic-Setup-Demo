/** Folds the run's event stream into what the chat shows while the agent works. */
import type { HypothesisView, PlanView, RunEvent, TaskStatus } from './api';

export interface LiveState {
  stage: string; plans: PlanView[]; hypotheses: HypothesisView[]; clarification: { question: string; options: string[] } | null;
  finished: boolean; status?: string; error?: string; lastSeq: number; startedAt?: string; notes: string[];
}
export const initialLive = (): LiveState => ({ stage: 'Starting…', plans: [], hypotheses: [], clarification: null, finished: false, lastSeq: 0, notes: [] });

const STAGES: Record<string, string> = { intake: 'Reading the mission context', plan: 'Planning the investigation', execute: 'Running tools', verify: 'Verifying the evidence', report: 'Writing the answer', check: 'Checking each claim against the evidence', clarify: 'Waiting for your answer', recover: 'Recovering from a failure' };
const RECOVERY: Record<string, string> = { retry: 'retry', skip: 'continue without the failed task', revise: 'revise the plan', clarify: 'ask you', finish: 'answer with what it has' };
const ROLE: Record<string, string> = { planner: 'Planner', verifier: 'Verifier', analyst: 'Analyst writing code', reporter: 'Reporter' };

function setTask(plans: PlanView[], taskId: string, patch: { status: TaskStatus; summary?: string | null; error?: string | null }) {
  return plans.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) })) }));
}

export function applyEvent(state: LiveState, e: RunEvent): LiveState {
  if (e.seq <= state.lastSeq) return state;
  const s: LiveState = { ...state, lastSeq: e.seq };
  const p = e.payload ?? {};
  switch (e.type) {
    case 'run_started': return { ...s, startedAt: e.at };
    case 'node_entered': return { ...s, stage: STAGES[String(p.node)] ?? String(p.node) };
    case 'llm_call': return p.ok ? s : { ...s, stage: `${ROLE[String(p.role)] ?? p.role}: correcting its output` };
    case 'plan_created':
    case 'plan_revised': return { ...s, plans: [...s.plans, { ...(p.plan as PlanView), reason: (p.reason as string) ?? null }], hypotheses: (p.hypotheses as HypothesisView[]) ?? s.hypotheses, stage: e.type === 'plan_revised' ? 'Plan revised' : 'Plan ready' };
    case 'task_status': return { ...s, plans: setTask(s.plans, String(p.task), { status: p.status as TaskStatus, summary: (p.summary as string) ?? null, error: (p.error as string) ?? null }) };
    case 'tool_called': return { ...s, stage: `${p.task} · ${p.tool}` };
    case 'hypothesis_updated': {
      const h = { id: String(p.id), statement: String(p.statement), status: String(p.status), confidence: String(p.confidence) };
      const exists = s.hypotheses.some((x) => x.id === h.id);
      return { ...s, hypotheses: exists ? s.hypotheses.map((x) => (x.id === h.id ? h : x)) : [...s.hypotheses, h] };
    }
    case 'verification': return { ...s, stage: `Verified ${p.hypothesis}: ${p.status}` };
    case 'claim_check': {
      const claims = (p.claims as { verdict: string }[]) ?? [];
      const bad = claims.filter((c) => c.verdict === 'contradicted' || c.verdict === 'unsupported').length;
      return bad ? { ...s, stage: e.summary, notes: [...s.notes, `✗ Claim check: ${e.summary.replace(/^Round \d+: /, '')}; correcting the answer`] } : { ...s, stage: e.summary };
    }
    case 'node_failed': return { ...s, stage: e.summary, notes: [...s.notes, `⚠ ${e.summary}`] };
    case 'decision':
      if (p.by === 'check') return { ...s, stage: p.route === 'plan' ? 'Investigating further after the claim check' : 'Rewriting the answer from the evidence' };
      if (p.by === 'recover') return { ...s, stage: `Recovery: ${RECOVERY[String(p.action)] ?? p.action}`, notes: [...s.notes, `↻ Recovery chose to ${RECOVERY[String(p.action)] ?? p.action}: ${p.reason}`] };
      return { ...s, stage: p.route === 'execute' ? 'Continuing with the plan' : p.route === 'plan' ? `Replanning: ${p.reason}` : p.route === 'report' ? 'Enough evidence; writing the answer' : 'Needs your input' };
    case 'budget_warning': return { ...s, notes: [...s.notes, e.summary] };
    case 'clarification_asked': return { ...s, clarification: { question: String(p.question), options: (p.options as string[]) ?? [] }, stage: STAGES.clarify };
    case 'clarification_answered': return { ...s, clarification: null, stage: 'Replanning with your answer' };
    case 'run_finished': return { ...s, finished: true, status: String(p.status), error: p.error as string | undefined };
    default: return s;
  }
}
