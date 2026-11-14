/**
 * The agent: a LangGraph control loop around model-written plans.
 *
 *   intake → plan → execute → verify ─┬→ execute   (continue with the plan)
 *              ↑                       ├→ plan      (replan)
 *              └──── clarify ←─────────┼→ clarify   (ask the user; interrupts the run)
 *                                      └→ report → END
 *
 *   Any failure — a tool task, or the planner or verifier model — goes to RECOVER instead, whose model picks:
 *   retry (with a per-task budget, optionally with corrected arguments), continue without the failed task,
 *   revise the plan, ask the user, or finish with a partial answer. If the recovery model itself fails,
 *   the run finishes with what it has; if the reporter fails, a partial answer is built without a model.
 *
 * The graph fixes only this loop. Which steps, tools, arguments and how many rounds are decided by the
 * planner, verifier and recovery models for each question. Every node records events for the live view and replay.
 */
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { Mission, Store, User } from '../store/types.js';
import { ToolError, runTool, type ArtifactRef, type Evidence, type ToolResult } from '../tools/registry.js';
import type { Sources } from '../tools/sources.js';
import { trim } from '../tools/util.js';
import type { EventSink } from './events.js';
import { completeJson, type ChatMessage, type ChatModel, type ModelRole } from './llm.js';
import { analystMessages, missionBlock, plannerMessages, recoveryMessages, reporterMessages, toolCatalog, verifierMessages, type MissionContext } from './prompts.js';
import { AnalystOutput, PlanOutput, ReportOutput, VerifyOutput, recoverSchema, type ReportOutput as ReportValue } from './schemas.js';

export interface Budgets { maxToolCalls: number; maxRevisions: number; maxLlmCalls: number; maxSeconds: number; maxClarifications: number; parallelTasks: number; maxRetries: number; maxRecoveries: number }
export const DEFAULT_BUDGETS: Budgets = { maxToolCalls: 48, maxRevisions: 5, maxLlmCalls: 100, maxSeconds: 900, maxClarifications: 1, parallelTasks: 3, maxRetries: 2, maxRecoveries: 10 };

/** Budgets from the environment (AGENT_MAX_TOOL_CALLS, AGENT_MAX_REVISIONS, AGENT_MAX_MODEL_CALLS, AGENT_MAX_MINUTES), else the defaults. */
export function budgetsFromEnv(env = process.env): Budgets {
  const n = (key: string, fallback: number) => { const v = Number(env[key]); return Number.isFinite(v) && v > 0 ? v : fallback; };
  return { ...DEFAULT_BUDGETS, maxToolCalls: n('AGENT_MAX_TOOL_CALLS', DEFAULT_BUDGETS.maxToolCalls), maxRevisions: n('AGENT_MAX_REVISIONS', DEFAULT_BUDGETS.maxRevisions),
    maxLlmCalls: n('AGENT_MAX_MODEL_CALLS', DEFAULT_BUDGETS.maxLlmCalls), maxSeconds: Math.round(n('AGENT_MAX_MINUTES', DEFAULT_BUDGETS.maxSeconds / 60) * 60), maxRetries: n('AGENT_MAX_RETRIES', DEFAULT_BUDGETS.maxRetries) };
}

export type TaskStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'skipped';
export interface TaskState { id: string; step: string; tool: string; args: Record<string, unknown>; purpose: string; status: TaskStatus; version: number; summary?: string; error?: string; evidence: string[]; artifacts: ArtifactRef[]; code?: string }
export interface StepState { id: string; title: string; depends_on: string[]; tasks: string[]; version: number }
export interface PlanVersion { version: number; objective: string; rationale: string; reason?: string; steps: string[] }
export interface HypothesisState { id: string; statement: string; confirm_if: string; refute_if: string; status: string; confidence: string; rule?: string | null; note?: string; evidence_for: string[]; evidence_against: string[] }
export interface EvidenceItem extends Evidence { id: string; task: string; snippet: string; artifact?: string }
export interface Counters { toolCalls: number; llmCalls: number; revisions: number; clarifications: number; recoveries: number }
/** What failed and must be recovered from: tool tasks in execute, or the planner or verifier model. */
export interface Failure { node: 'execute' | 'plan' | 'verify'; tasks: string[]; error: string }
/** Simulated failures a superuser switches on for demonstrations (Admin → Models → Fault injection). */
export interface Faults { tool: string | null; toolFailures: number; plannerFailures: number }
export interface Clarification { question: string; options: string[]; answer?: string }
export type Route = 'execute' | 'verify' | 'plan' | 'clarify' | 'report' | 'recover';

const last = <T>() => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => undefined as unknown as T });

export const AgentState = Annotation.Root({
  question: last<string>(),
  history: last<string>(),
  missionText: last<string>(),
  plans: last<PlanVersion[]>(),
  steps: last<Record<string, StepState>>(),
  tasks: last<Record<string, TaskState>>(),
  hypotheses: last<HypothesisState[]>(),
  evidence: last<EvidenceItem[]>(),
  observations: last<{ task: string; text: string }[]>(),
  counters: last<Counters>(),
  route: last<Route>(),
  reason: last<string>(),
  clarification: last<Clarification | null>(),
  limits: last<string[]>(),
  failure: last<Failure | null>(),
  retries: last<Record<string, number>>(),
});
export type State = typeof AgentState.State;

export interface AgentContext {
  store: Store; sources: Sources; model: ChatModel; sink: EventSink; mission: Mission; user: User;
  budgets: Budgets; startedAt: number; signal: AbortSignal; runId: string; chatId: string;
  clarificationAsked?: boolean;
  faults?: Faults;
  onFinished?(status: 'complete' | 'failed', view: unknown, totals: Record<string, number>): Promise<void>;
}

export class StoppedError extends Error { constructor() { super('Stopped by the user'); } }
export class BudgetError extends Error {}

// ---------------- helpers ----------------

const elapsed = (ctx: AgentContext) => Math.round((Date.now() - ctx.startedAt) / 1000);
const ZERO_COUNTERS: Counters = { toolCalls: 0, llmCalls: 0, revisions: 0, clarifications: 0, recoveries: 0 };
const pendingTasks = (s: State) => Object.values(s.tasks ?? {}).filter((t) => t.status === 'pending');

export function buildView(s: Pick<State, 'plans' | 'steps' | 'tasks' | 'hypotheses'>) {
  return {
    plans: (s.plans ?? []).map((p) => ({ version: p.version, objective: p.objective, reason: p.reason ?? null,
      steps: p.steps.map((id) => { const st = s.steps[id]; return { id, title: st.title, depends_on: st.depends_on,
        tasks: st.tasks.map((tid) => { const t = s.tasks[tid]; return { id: tid, tool: t.tool, purpose: t.purpose, status: t.status, summary: t.summary ?? null, error: t.error ?? null }; }) }; }) })),
    hypotheses: (s.hypotheses ?? []).map((h) => ({ id: h.id, statement: h.statement, status: h.status, confidence: h.confidence })),
  };
}

function snapshot(s: State, ctx: AgentContext, counters: Counters) {
  const tasks = Object.values(s.tasks ?? {});
  const byStatus = (st: string) => (s.hypotheses ?? []).filter((h) => h.status === st).length;
  return {
    plan_version: s.plans?.length ?? 0,
    tasks: { total: tasks.length, succeeded: tasks.filter((t) => t.status === 'succeeded').length, failed: tasks.filter((t) => t.status === 'failed').length,
      pending: tasks.filter((t) => t.status === 'pending').length, skipped: tasks.filter((t) => t.status === 'skipped').length },
    hypotheses: { supported: byStatus('supported'), refuted: byStatus('refuted'), conflicting: byStatus('conflicting'), insufficient: byStatus('insufficient'), untested: byStatus('untested') },
    evidence: s.evidence?.length ?? 0,
    budget: { tool_calls: counters.toolCalls, max_tool_calls: ctx.budgets.maxToolCalls, llm_calls: counters.llmCalls, revisions: counters.revisions, recoveries: counters.recoveries ?? 0, elapsed_s: elapsed(ctx) },
    retries: s.retries ?? {},
    failure: s.failure ?? null,
  };
}

async function callModel<S extends Parameters<typeof completeJson>[2]>(ctx: AgentContext, node: string, role: ModelRole, schema: S, messages: ChatMessage[], counters: Counters, maxTokens = 4096) {
  if (counters.llmCalls >= ctx.budgets.maxLlmCalls) throw new BudgetError(`model call budget (${ctx.budgets.maxLlmCalls}) used up`);
  if (role === 'planner' && ctx.faults && ctx.faults.plannerFailures > 0) {
    ctx.faults.plannerFailures--;
    counters.llmCalls++;
    const error = 'injected fault: the model provider returned HTTP 503 Service Unavailable (simulated for the demo)';
    await ctx.sink.emit(node, 'llm_call', `${role}: ${error}`, { role, attempt: 1, ok: false, error, provider: 'fault-injection', model: '-', duration_ms: 0, injected: true });
    throw new Error(error);
  }
  return completeJson(ctx.model, role, schema, messages, {
    onAttempt: async ({ attempt, messages: sent, completion, error, ok }) => {
      counters.llmCalls++;
      const prompt = await ctx.sink.blob(JSON.stringify(sent));
      const response = completion ? await ctx.sink.blob(completion.content) : null;
      await ctx.sink.emit(node, 'llm_call', `${role}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${ok ? 'valid output' : `invalid output: ${trim(error ?? '', 120)}`}`,
        { role, attempt, ok, error: error ?? null, provider: completion?.provider, model: completion?.model, duration_ms: completion?.duration_ms,
          usage: completion?.usage ?? null, prompt_blob: prompt, response_blob: response, response_preview: completion ? trim(completion.content, 600) : null });
    },
  }, { maxTokens, signal: ctx.signal });
}

const hypothesesText = (hs: HypothesisState[]) => hs.map((h) => `${h.id} [${h.status}${h.status !== 'untested' ? `, ${h.confidence}` : ''}] ${h.statement}${h.confirm_if ? `\n   confirm if: ${h.confirm_if}` : ''}${h.refute_if ? `\n   refute if: ${h.refute_if}` : ''}${h.note ? `\n   verifier: ${h.note}` : ''}`).join('\n');

function planText(s: State) {
  return (s.plans ?? []).map((p) => `Plan v${p.version}: ${p.objective}\n` + p.steps.map((id) => {
    const st = s.steps[id];
    return `${id} ${st.title}${st.depends_on.length ? ` (after ${st.depends_on.join(', ')})` : ''}\n` + st.tasks.map((tid) => {
      const t = s.tasks[tid];
      return `  ${tid} ${t.tool} ${JSON.stringify(t.args)} — ${t.purpose} [${t.status}${t.summary ? `: ${trim(t.summary, 160)}` : ''}${t.error ? `: ${trim(t.error, 160)}` : ''}]`;
    }).join('\n');
  }).join('\n')).join('\n\n');
}

function observationsText(s: State, maxChars = 16000) {
  const parts: string[] = [];
  let used = 0;
  for (const o of [...(s.observations ?? [])].reverse()) {     // newest first, so the latest results survive truncation
    if (used + o.text.length > maxChars) { parts.push(`[${o.task}] (older result omitted for length)`); continue; }
    parts.push(o.text); used += o.text.length;
  }
  return parts.reverse().join('\n\n');
}

const evidenceText = (items: EvidenceItem[]) => items.map((e) => `${e.id} [${e.kind}] ${e.label} (from ${e.task}): ${trim(e.snippet, 220)}`).join('\n');

function snippetFor(e: Evidence, result: ToolResult): string {
  const d = result.data as Record<string, unknown>;
  try {
    switch (e.kind) {
      case 'passage': return String((d.passages as { chunk_id: string; text: string }[]).find((p) => p.chunk_id === e.ref)?.text ?? '');
      case 'table': { const t = (d.tables as { asset_id: string; columns: string[]; rows: string[][] }[]).find((x) => String(x.asset_id) === e.ref); return t ? [t.columns.join(' | '), ...t.rows.slice(0, 4).map((r) => r.join(' | '))].join('\n') : ''; }
      case 'figure': { const f = (d.figures as { asset_id: string; caption: string; description: string }[]).find((x) => String(x.asset_id) === e.ref); return f ? `${f.caption}. ${f.description}` : ''; }
      case 'section': return d.content ? (d.content as { text: string }[]).map((c) => c.text).join(' ').slice(0, 600) : result.summary;
      case 'channel': { const c = (d.channels as { channel: string; documented: { fields: Record<string, string> }[]; owner: string; storage_type: string }[]).find((x) => x.channel === e.ref); return c ? `${c.channel} (${c.owner}, ${c.storage_type}) ${c.documented.map((x) => Object.values(x.fields).join(' | ')).join(' / ')}` : ''; }
      case 'telemetry': return `${result.summary}. ${JSON.stringify(d.channels).slice(0, 400)}${(d.source_gaps as unknown[])?.length ? ` gaps: ${JSON.stringify(d.source_gaps)}` : ''}`;
      case 'analysis': return String(d.stdout ?? '').slice(0, 600);
      case 'run': return (d.runs as { run_id: string; observed_samples: number; expected_samples: number; events: number }[]).map((r) => `${r.run_id}: ${r.observed_samples}/${r.expected_samples} samples, ${r.events} events`).join('\n');
      default: return result.summary;
    }
  } catch { return result.summary; }
}

function observationFor(task: TaskState, result: ToolResult, evidence: EvidenceItem[]) {
  const args = task.tool === 'run_analysis' ? `goal="${trim(String(task.args.goal), 120)}"` : trim(JSON.stringify(task.args), 200);
  let data: string;
  if (task.tool === 'run_analysis') {
    const d = result.data as { stdout: string; error: string | null; tables: { name: string; preview_csv: string }[] };
    data = `stdout:\n${trim(d.stdout ?? '', 2500)}${d.error ? `\nerror: ${d.error}` : ''}${(d.tables ?? []).map((t) => `\ntable ${t.name}:\n${trim(t.preview_csv, 600)}`).join('')}`;
  } else {
    data = trim(JSON.stringify(result.data), 2800);
  }
  return `[${task.id}] ${task.tool}(${args}) → ${result.summary}\n${data}${evidence.length ? `\nEvidence: ${evidence.map((e) => `${e.id} = ${e.label}`).join('; ')}` : ''}${result.artifacts.length ? `\nCSV results: ${result.artifacts.filter((a) => a.kind === 'csv').map((a) => `${a.name} (${a.rows} rows; columns ${a.columns?.join(', ')})`).join('; ')}` : ''}`;
}

/** Give plan items globally unique IDs; map references to ids defined in this plan, keep references to earlier tasks. */
function renumber(plan: PlanOutput, nextStep: number) {
  const stepMap = new Map<string, string>(), taskMap = new Map<string, string>();
  plan.steps.forEach((step, i) => {
    const id = `S${nextStep + i}`;
    stepMap.set(step.id, id);
    step.tasks.forEach((t, k) => taskMap.set(t.id, `${id}.${k + 1}`));
  });
  return plan.steps.map((step) => ({
    id: stepMap.get(step.id)!, title: step.title,
    depends_on: step.depends_on.map((d) => stepMap.get(d) ?? d),
    tasks: step.tasks.map((t) => ({ ...t, id: taskMap.get(t.id)!,
      args: t.tool === 'run_analysis' ? { ...t.args, inputs: (t.args.inputs as string[]).map((r) => (taskMap.has(r.slice(1)) ? `@${taskMap.get(r.slice(1))}` : r)) } : t.args })),
  }));
}

/** A partial answer without a model: what each hypothesis came to, on the evidence the verifier cited. */
function partialReport(s: State): ReportValue {
  const tested = s.hypotheses.filter((h) => h.status !== 'untested');
  const lines = tested.map((h) => `- ${h.id} ${h.statement}: ${h.status} (${h.confidence})${h.evidence_for.length ? ` [${h.evidence_for.join(', ')}]` : ''}${h.note ? ` — ${h.note}` : ''}`);
  const done = Object.values(s.tasks ?? {}).filter((t) => t.status === 'succeeded');
  return {
    conclusion: `A full answer could not be written. What the investigation established before it stopped:\n\n${lines.length ? lines.join('\n') : '- No hypothesis could be tested.'}\n\nCompleted tasks: ${done.map((t) => `${t.id} (${t.summary ?? t.tool})`).join('; ') || 'none'}.`,
    confidence: 'low', confidence_reason: 'Partial answer built without the reporter model',
    evidence: [...new Set(tested.flatMap((h) => h.evidence_for))].slice(0, 20), rejected_alternatives: [], uncertainties: [...s.limits],
  };
}

// ---------------- nodes ----------------

export function buildAgent(ctx: AgentContext) {
  const check = () => { if (ctx.signal.aborted) throw new StoppedError(); };
  const enter = async (node: string, s: State) => { check(); await ctx.sink.emit(node, 'node_entered', node, { node, elapsed_s: elapsed(ctx) }); return { ...ZERO_COUNTERS, ...(s.counters as Partial<Counters> | undefined) }; };
  const leave = async (node: string, s: State, counters: Counters) => ctx.sink.emit(node, 'state_snapshot', `after ${node}`, snapshot(s, ctx, counters));
  const outOfBudget = (c: Counters) => c.toolCalls >= ctx.budgets.maxToolCalls ? `tool-call budget (${ctx.budgets.maxToolCalls}) reached`
    : elapsed(ctx) >= ctx.budgets.maxSeconds ? `time budget (${ctx.budgets.maxSeconds} s) reached` : null;
  /** A model-calling node failed: hand the failure to RECOVER (or report, when a budget ran out). */
  const nodeFailed = async (node: 'plan' | 'verify', s: State, counters: Counters, error: unknown): Promise<Partial<State>> => {
    if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
    const message = (error as Error).message;
    if (error instanceof BudgetError) return { counters, route: 'report', limits: [...s.limits, message] };
    await ctx.sink.emit(node, 'node_failed', `${node === 'plan' ? 'Planner' : 'Verifier'} failed: ${trim(message, 150)}`, { node, error: message });
    const next: Partial<State> = { counters, route: 'recover', failure: { node, tasks: [], error: message } };
    await leave(node, { ...s, ...next } as State, counters);
    return next;
  };

  async function intake(s: State): Promise<Partial<State>> {
    const counters = await enter('intake', s);
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const [docs, runs, channels] = await Promise.all([
      db.find('documents', { status: 'complete' }, { projection: { _id: 1, extraction_status: 1, source_sha256: 1 } }),
      ctx.mission.telemetrySchema ? db.find('telemetry_runs', { status: 'complete' }, { projection: { run_id: 1 }, sort: { run_id: 1 } }) : Promise.resolve([]),
      ctx.mission.telemetrySchema ? db.find('telemetry_channels', {}, { projection: { owner: 1 } }) : Promise.resolve([]),
    ]);
    const preferred = new Map<string, string>();
    for (const d of docs) if (!preferred.has(d.source_sha256) || d.extraction_status === 'enriched') preferred.set(d.source_sha256, String(d._id));
    const sections = preferred.size ? await db.find('sections', { document_id: { $in: [...preferred.values()] } }, { projection: { label: 1, title: 1 }, sort: { ordinal: 1 } }) : [];
    const context: MissionContext = { name: ctx.mission.name, description: ctx.mission.description, hasTelemetry: Boolean(ctx.mission.telemetrySchema),
      sections: sections.map((x) => `${x.label} ${x.title}`), runs: [...new Set(runs.map((r) => String(r.run_id)))],
      subsystems: [...new Set(channels.map((c) => String(c.owner)))].sort() };
    await ctx.sink.emit('intake', 'context_loaded', `${context.sections.length} sections, ${context.runs.length} runs`, context);
    const next: Partial<State> = { missionText: missionBlock(context), counters, route: 'plan', plans: [], steps: {}, tasks: {}, hypotheses: [], evidence: [], observations: [], limits: [], clarification: null };
    await leave('intake', { ...s, ...next } as State, counters);
    return next;
  }

  async function plan(s: State): Promise<Partial<State>> {
    const counters = await enter('plan', s);
    const revision = (s.plans?.length ?? 0) > 0;
    if (revision && counters.revisions >= ctx.budgets.maxRevisions) {
      const limits = [...s.limits, `plan revision budget (${ctx.budgets.maxRevisions}) reached`];
      await ctx.sink.emit('plan', 'budget_warning', limits.at(-1)!, { counter: 'revisions', limit: ctx.budgets.maxRevisions });
      return { counters, route: 'report', limits };
    }
    const nextStep = Object.keys(s.steps ?? {}).length + 1;
    let value: PlanOutput;
    try {
      ({ value } = await callModel(ctx, 'plan', 'planner', PlanOutput, plannerMessages({
        mission: s.missionText, catalog: toolCatalog(Boolean(ctx.mission.telemetrySchema)), question: s.question, history: s.history,
        clarification: s.clarification?.answer ? `${s.clarification.question} → ${s.clarification.answer}` : undefined,
        revision: revision ? { previousPlan: planText(s), observations: observationsText(s, 10000), verdicts: hypothesesText(s.hypotheses), reason: s.reason, nextStep } : undefined,
      }), counters, 6000));
    } catch (error) { return nodeFailed('plan', s, counters, error); }

    if (!value.steps.length && value.clarification) {
      if (counters.clarifications >= ctx.budgets.maxClarifications) {
        const limits = [...s.limits, `the planner asked again for clarification: ${value.clarification.question}`];
        return { counters, route: 'report', limits };
      }
      await leave('plan', s, counters);
      return { counters, route: 'clarify', clarification: { question: value.clarification.question, options: value.clarification.options } };
    }

    const version = (s.plans?.length ?? 0) + 1;
    const tasks = { ...s.tasks }, steps = { ...s.steps };
    const superseded: string[] = [];
    for (const t of Object.values(tasks)) if (t.status === 'pending') { tasks[t.id] = { ...t, status: 'skipped', summary: `superseded by plan v${version}` }; superseded.push(t.id); }
    const newSteps = renumber(value, nextStep);
    for (const st of newSteps) {
      steps[st.id] = { id: st.id, title: st.title, depends_on: st.depends_on, tasks: st.tasks.map((t) => t.id), version };
      for (const t of st.tasks) tasks[t.id] = { id: t.id, step: st.id, tool: t.tool, args: t.args, purpose: t.purpose, status: 'pending', version, evidence: [], artifacts: [] };
    }
    const previous = new Map((s.hypotheses ?? []).map((h) => [h.id, h]));
    const hypotheses: HypothesisState[] = value.hypotheses.map((h) => ({ ...h, status: previous.get(h.id)?.status ?? 'untested', confidence: previous.get(h.id)?.confidence ?? 'low',
      evidence_for: previous.get(h.id)?.evidence_for ?? [], evidence_against: previous.get(h.id)?.evidence_against ?? [], note: previous.get(h.id)?.note, rule: previous.get(h.id)?.rule }));
    const plans = [...(s.plans ?? []), { version, objective: value.objective, rationale: value.rationale, reason: revision ? s.reason : undefined, steps: newSteps.map((x) => x.id) }];
    if (revision) counters.revisions++;
    for (const id of superseded) await ctx.sink.emit('plan', 'task_status', `${id} skipped (superseded)`, { task: id, step: tasks[id].step, status: 'skipped', summary: tasks[id].summary });
    const view = buildView({ plans, steps, tasks, hypotheses });
    await ctx.sink.emit('plan', revision ? 'plan_revised' : 'plan_created', `Plan v${version}: ${newSteps.length} steps, ${newSteps.reduce((n, x) => n + x.tasks.length, 0)} tasks${revision ? ` (${trim(s.reason, 100)})` : ''}`,
      { version, objective: value.objective, rationale: value.rationale, reason: revision ? s.reason : null, plan: view.plans.at(-1), hypotheses: view.hypotheses });
    for (const h of hypotheses) if (!previous.has(h.id)) await ctx.sink.emit('plan', 'hypothesis_updated', `${h.id} proposed: ${trim(h.statement, 120)}`, { ...h });
    const next: Partial<State> = { counters, plans, steps, tasks, hypotheses, route: 'execute' };
    await leave('plan', { ...s, ...next } as State, counters);
    return next;
  }

  async function runOne(s: State, task: TaskState, counters: Counters, evidencePool: EvidenceItem[]): Promise<{ task: TaskState; observation: string; evidence: EvidenceItem[] }> {
    await ctx.sink.emit('execute', 'task_status', `${task.id} executing: ${task.tool}`, { task: task.id, step: task.step, status: 'executing' });
    const toolCtx = { mission: ctx.mission, user: ctx.user, store: ctx.store, sources: ctx.sources };
    let result: ToolResult & { duration_ms: number };
    let args: Record<string, unknown> = task.args;
    try {
      if (ctx.faults?.tool === task.tool && ctx.faults.toolFailures > 0) {
        ctx.faults.toolFailures--;
        await ctx.sink.emit('execute', 'tool_called', `${task.id} ${task.tool}`, { task: task.id, tool: task.tool, args: task.tool === 'run_analysis' ? { goal: task.args.goal, inputs: task.args.inputs } : args });
        counters.toolCalls++;
        throw new ToolError(`injected fault: ${task.tool} timed out after 30 s (simulated outage for the demo)`);
      }
      if (task.tool === 'run_analysis') {
        const ids: string[] = [], names: string[] = [];
        for (const ref of task.args.inputs as string[]) {
          const source = s.tasks[ref.slice(1)];
          const csv = source?.artifacts.filter((a) => a.kind === 'csv') ?? [];
          if (!source || source.status !== 'succeeded' || !csv.length) throw new ToolError(`input ${ref} has no CSV result (task ${source ? source.status : 'not found'})`);
          csv.forEach((a, i) => { ids.push(a.id); names.push(`${ref.slice(1).replace('.', '_')}${i ? `_${i + 1}` : ''}`); });
        }
        const described = await Promise.all(ids.map(async (id, i) => {
          const a = await ctx.store.artifacts.byId(id);
          const lines = a?.content.split('\n') ?? [];
          return `input "${names[i]}" (${a?.rows ?? '?'} rows) from ${a?.tool}:\n${lines.slice(0, 4).join('\n')}`;
        }));
        let code = '', error: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const { value } = await callModel(ctx, 'execute', 'analyst', AnalystOutput,
            analystMessages({ goal: String(task.args.goal), inputs: described.join('\n\n'), previousError: error, previousCode: code || undefined }), counters, 3000);
          code = value.code;
          args = { code, inputs: ids, names };
          await ctx.sink.emit('execute', 'tool_called', `${task.id} run_analysis${attempt > 1 ? ' (corrected code)' : ''}`, { task: task.id, tool: 'run_analysis', args: { goal: task.args.goal, inputs: names, code } });
          counters.toolCalls++;
          result = await runTool('run_analysis', args, toolCtx);
          error = (result.data as { error: string | null }).error ?? undefined;
          if (!error) break;
        }
        task = { ...task, code };
        if (error) throw new ToolError(`analysis code failed: ${error}`);
      } else {
        await ctx.sink.emit('execute', 'tool_called', `${task.id} ${task.tool}`, { task: task.id, tool: task.tool, args });
        counters.toolCalls++;
        result = await runTool(task.tool, args, toolCtx);
      }
    } catch (error) {
      if (ctx.signal.aborted) throw new StoppedError();
      const message = (error as Error).message;
      await ctx.sink.emit('execute', 'tool_result', `${task.id} failed: ${trim(message, 150)}`, { task: task.id, tool: task.tool, ok: false, error: message });
      const failed = { ...task, status: 'failed' as const, error: message };
      await ctx.sink.emit('execute', 'task_status', `${task.id} failed`, { task: task.id, step: task.step, status: 'failed', error: trim(message, 300) });
      return { task: failed, observation: `[${task.id}] ${task.tool}(${trim(JSON.stringify(task.args), 160)}) FAILED: ${message}`, evidence: [] };
    }
    const r = result!;
    const items: EvidenceItem[] = [];
    for (const e of r.evidence) {
      const existing = evidencePool.find((x) => x.kind === e.kind && x.ref === e.ref);
      if (existing) { items.push(existing); continue; }
      const item: EvidenceItem = { ...e, id: `E${evidencePool.length + 1}`, task: task.id, snippet: trim(snippetFor(e, r), 900),
        artifact: r.artifacts.find((a) => a.kind === 'png')?.id ?? r.artifacts.find((a) => a.kind === 'csv')?.id };
      evidencePool.push(item); items.push(item);
    }
    const dataBlob = await ctx.sink.blob(JSON.stringify(r.data));
    await ctx.sink.emit('execute', 'tool_result', `${task.id} ${r.summary}`, { task: task.id, tool: task.tool, ok: true, summary: r.summary, duration_ms: r.duration_ms,
      evidence: items.map((e) => ({ id: e.id, kind: e.kind, label: e.label })), artifacts: r.artifacts, data_blob: dataBlob, data_preview: trim(JSON.stringify(r.data), 1500) });
    const done = { ...task, status: 'succeeded' as const, summary: r.summary, evidence: items.map((e) => e.id), artifacts: r.artifacts };
    await ctx.sink.emit('execute', 'task_status', `${task.id} succeeded`, { task: task.id, step: task.step, status: 'succeeded', summary: r.summary, evidence: done.evidence });
    return { task: done, observation: observationFor(done, r, items), evidence: items };
  }

  async function execute(s: State): Promise<Partial<State>> {
    const counters = await enter('execute', s);
    const tasks = { ...s.tasks };
    const finished = (stepId: string) => (s.steps[stepId]?.tasks ?? []).every((t) => !['pending', 'executing'].includes(tasks[t]?.status));
    // An analysis whose input task failed or was skipped cannot run: skip it rather than fail it.
    for (const t of Object.values(tasks).filter((x) => x.status === 'pending' && x.tool === 'run_analysis')) {
      const bad = (t.args.inputs as string[]).map((r) => tasks[r.slice(1)]).find((src) => src && (src.status === 'failed' || src.status === 'skipped'));
      if (bad) {
        tasks[t.id] = { ...t, status: 'skipped', summary: `input ${bad.id} ${bad.status}` };
        await ctx.sink.emit('execute', 'task_status', `${t.id} skipped (input ${bad.id} ${bad.status})`, { task: t.id, step: t.step, status: 'skipped', summary: tasks[t.id].summary });
      }
    }
    const pending = Object.values(tasks).filter((t) => t.status === 'pending');
    const ready = pending.filter((t) => s.steps[t.step].depends_on.every((d) => !s.steps[d] || finished(d)));
    const limits = [...s.limits];
    if (!ready.length) {
      for (const t of pending) {
        tasks[t.id] = { ...t, status: 'skipped', summary: 'dependencies could not complete' };
        await ctx.sink.emit('execute', 'task_status', `${t.id} skipped`, { task: t.id, step: t.step, status: 'skipped', summary: tasks[t.id].summary });
      }
      return { counters, tasks, route: 'verify' };
    }
    const room = ctx.budgets.maxToolCalls - counters.toolCalls;
    const batch = ready.slice(0, Math.max(0, Math.min(ctx.budgets.parallelTasks, room)));
    if (!batch.length) {
      limits.push(`tool-call budget (${ctx.budgets.maxToolCalls}) reached`);
      await ctx.sink.emit('execute', 'budget_warning', limits.at(-1)!, { counter: 'tool_calls', limit: ctx.budgets.maxToolCalls });
      return { counters, route: 'report', limits };
    }
    const evidencePool = [...s.evidence];
    const outcomes = await Promise.all(batch.map((t) => runOne(s, t, counters, evidencePool)));
    const observations = [...s.observations];
    for (const o of outcomes) { tasks[o.task.id] = o.task; observations.push({ task: o.task.id, text: o.observation }); }
    if (counters.toolCalls >= ctx.budgets.maxToolCalls * 0.8) await ctx.sink.emit('execute', 'budget_warning', `${counters.toolCalls} of ${ctx.budgets.maxToolCalls} tool calls used`, { counter: 'tool_calls', used: counters.toolCalls, limit: ctx.budgets.maxToolCalls });
    // Verify after a step's tasks are all done, not after every single task.
    const stillRunnable = Object.values(tasks).some((t) => t.status === 'pending' && batch.some((b) => b.step === t.step));
    const failedNow = outcomes.filter((o) => o.task.status === 'failed').map((o) => o.task);
    const failure: Failure | null = failedNow.length ? { node: 'execute', tasks: failedNow.map((t) => t.id), error: failedNow.map((t) => `${t.id} ${t.tool}: ${t.error}`).join('\n') } : null;
    const next: Partial<State> = { counters, tasks, evidence: evidencePool, observations, failure, route: failure ? 'recover' : stillRunnable ? 'execute' : 'verify' };
    await leave('execute', { ...s, ...next } as State, counters);
    return next;
  }

  async function verify(s: State): Promise<Partial<State>> {
    const counters = await enter('verify', s);
    const limit = outOfBudget(counters);
    if (limit) return { counters, route: 'report', limits: [...s.limits, limit] };
    let value: VerifyOutput;
    try {
      ({ value } = await callModel(ctx, 'verify', 'verifier', VerifyOutput, verifierMessages({
        mission: s.missionText, question: s.question, hypotheses: hypothesesText(s.hypotheses), plan: planText(s),
        observations: observationsText(s), evidence: evidenceText(s.evidence),
        budget: `${counters.toolCalls}/${ctx.budgets.maxToolCalls} tool calls, ${counters.revisions}/${ctx.budgets.maxRevisions} plan revisions, ${elapsed(ctx)}/${ctx.budgets.maxSeconds} s`,
        clarificationAvailable: counters.clarifications < ctx.budgets.maxClarifications,
      }), counters, 3000));
    } catch (error) { return nodeFailed('verify', s, counters, error); }
    const known = new Set(s.evidence.map((e) => e.id));
    const hypotheses = s.hypotheses.map((h) => {
      const v = value.verdicts.find((x) => x.hypothesis === h.id);
      return v ? { ...h, status: v.status, confidence: v.confidence, rule: v.rule ?? null, note: v.note,
        evidence_for: v.evidence_for.filter((e) => known.has(e)), evidence_against: v.evidence_against.filter((e) => known.has(e)) } : h;
    });
    for (const v of value.verdicts) {
      const h = hypotheses.find((x) => x.id === v.hypothesis);
      if (!h) continue;
      await ctx.sink.emit('verify', 'verification', `${h.id} ${v.status} (${v.confidence})${v.rule ? ` · ${v.rule}` : ''}`,
        { hypothesis: h.id, statement: h.statement, status: v.status, confidence: v.confidence, rule: v.rule ?? null, evidence_for: h.evidence_for, evidence_against: h.evidence_against, note: v.note });
      const before = s.hypotheses.find((x) => x.id === h.id);
      if (before?.status !== h.status) await ctx.sink.emit('verify', 'hypothesis_updated', `${h.id}: ${before?.status ?? 'new'} → ${h.status}`, { ...h });
    }
    const pending = pendingTasks(s).length > 0;
    let route: Route;
    let reason = value.reason;
    if (value.next === 'clarify' && value.clarification && counters.clarifications < ctx.budgets.maxClarifications) route = 'clarify';
    else if (value.next === 'replan' && counters.revisions < ctx.budgets.maxRevisions) route = 'plan';
    else if (value.next === 'report') route = 'report';
    else if (pending) route = 'execute';
    else route = 'report';
    if (value.next === 'replan' && route !== 'plan') reason = `${reason} (no plan revisions left)`;
    await ctx.sink.emit('verify', 'decision', `${route === 'execute' ? 'continue' : route}: ${trim(reason, 160)}`, { by: 'verify', requested: value.next, route, reason });
    const next: Partial<State> = { counters, hypotheses, route, reason, clarification: route === 'clarify' ? { question: value.clarification!.question, options: value.clarification!.options } : s.clarification };
    await leave('verify', { ...s, ...next } as State, counters);
    return next;
  }

  async function clarify(s: State): Promise<Partial<State>> {
    check();
    const counters = { ...s.counters };
    const c = s.clarification!;
    if (!ctx.clarificationAsked) {
      ctx.clarificationAsked = true;
      await ctx.sink.emit('clarify', 'node_entered', 'clarify', { node: 'clarify', elapsed_s: elapsed(ctx) });
      await ctx.sink.emit('clarify', 'clarification_asked', c.question, { question: c.question, options: c.options });
    }
    const answer = interrupt({ question: c.question, options: c.options }) as string;
    counters.clarifications++;
    await ctx.sink.emit('clarify', 'clarification_answered', `Answer: ${trim(answer, 120)}`, { question: c.question, answer });
    return { counters, clarification: { ...c, answer }, reason: `The user clarified "${c.question}": ${answer}`, route: 'plan' };
  }

  async function recover(s: State): Promise<Partial<State>> {
    const counters = await enter('recover', s);
    const f = s.failure ?? { node: 'execute' as const, tasks: [], error: 'unknown failure' };
    const where = f.node === 'execute' ? f.tasks.join(', ') : f.node === 'plan' ? 'the planner' : 'the verifier';
    const tasks = { ...s.tasks }, retries = { ...(s.retries ?? {}) };
    const keys = f.node === 'execute' ? f.tasks : [f.node];
    const left = (k: string) => ctx.budgets.maxRetries - (retries[k] ?? 0);
    const decide = async (requested: string, action: string, route: Route, reason: string, extra: Partial<State> = {}, more: Record<string, unknown> = {}) => {
      await ctx.sink.emit('recover', 'decision', `recovery: ${action}${requested !== action ? ` (asked: ${requested})` : ''} — ${trim(reason, 150)}`,
        { by: 'recover', requested, action, route, reason, failure: f, ...more });
      const next: Partial<State> = { counters, tasks, retries, failure: null, route, reason, ...extra };
      await leave('recover', { ...s, ...next } as State, counters);
      return next;
    };
    const partial = (why: string) => [...s.limits, `stopped after a failure in ${where} (${trim(f.error, 200)}): ${why}`];

    const limit = outOfBudget(counters) ?? (counters.recoveries >= ctx.budgets.maxRecoveries ? `recovery budget (${ctx.budgets.maxRecoveries}) used up` : null);
    if (limit) return decide('finish', 'finish', 'report', limit, { limits: partial(limit) }, { guard: true });
    counters.recoveries++;

    const taskTools = Object.fromEntries(f.tasks.map((id) => [id, tasks[id].tool]));
    let d: { action: string; reason: string; corrected_args: Record<string, Record<string, unknown>>; clarification?: { question: string; options: string[] } | null };
    try {
      ({ value: d } = await callModel(ctx, 'recover', 'verifier', recoverSchema(taskTools), recoveryMessages({
        mission: s.missionText, question: s.question, catalog: toolCatalog(Boolean(ctx.mission.telemetrySchema)),
        failure: f.node === 'execute'
          ? f.tasks.map((id) => { const t = tasks[id]; return `${id} ${t.tool} ${t.tool === 'run_analysis' ? `goal="${t.args.goal}"` : JSON.stringify(t.args)} — ${t.purpose}\n  error: ${t.error}\n  retries left: ${left(id)}`; }).join('\n')
          : `The ${f.node === 'plan' ? 'planner' : 'verifier'} model call failed: ${f.error}\n  retries left: ${left(f.node)}`,
        failedNode: f.node, plan: planText(s), observations: observationsText(s, 8000), evidence: evidenceText(s.evidence),
        budget: `${counters.toolCalls}/${ctx.budgets.maxToolCalls} tool calls, ${counters.revisions}/${ctx.budgets.maxRevisions} plan revisions, ${elapsed(ctx)}/${ctx.budgets.maxSeconds} s`,
        revisionAvailable: counters.revisions < ctx.budgets.maxRevisions,
        clarificationAvailable: counters.clarifications < ctx.budgets.maxClarifications,
        pendingTasks: pendingTasks(s).length,
      }), counters, 2500));
    } catch (error) {
      if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
      const why = `the recovery model failed (${trim((error as Error).message, 160)}); answering with the evidence gathered so far`;
      return decide('finish', 'finish', 'report', why, { limits: partial(why) }, { fallback: true });
    }

    // Guards the model cannot talk its way past.
    let action = d.action, note = '';
    if (action === 'retry' && keys.every((k) => left(k) <= 0)) { note = `retry budget (${ctx.budgets.maxRetries}) used up for ${where}`; action = f.node !== 'plan' && counters.revisions < ctx.budgets.maxRevisions ? 'revise' : 'finish'; }
    if (action === 'skip' && f.node !== 'execute') { note = 'nothing to continue without'; action = f.node === 'verify' ? 'finish' : left('plan') > 0 ? 'retry' : 'finish'; }
    if (action === 'revise' && f.node === 'plan') { action = left('plan') > 0 ? 'retry' : 'finish'; note = 'the planner itself failed: retrying it'; }
    if (action === 'revise' && counters.revisions >= ctx.budgets.maxRevisions) { note = 'no plan revisions left'; action = 'finish'; }
    if (action === 'clarify' && (!d.clarification || counters.clarifications >= ctx.budgets.maxClarifications)) { note = 'no clarification available'; action = 'finish'; }
    const reason = note ? `${d.reason} (${note})` : d.reason;
    const more = { note: note || null, corrected: Object.keys(d.corrected_args ?? {}) };

    switch (action) {
      case 'retry': {
        if (f.node !== 'execute') { retries[f.node] = (retries[f.node] ?? 0) + 1; return decide(d.action, 'retry', f.node, reason, {}, { ...more, attempt: retries[f.node] }); }
        for (const id of f.tasks.filter((k) => left(k) > 0)) {
          retries[id] = (retries[id] ?? 0) + 1;
          const corrected = d.corrected_args?.[id];
          tasks[id] = { ...tasks[id], status: 'pending', error: undefined, args: corrected ? { ...tasks[id].args, ...corrected } : tasks[id].args };
          await ctx.sink.emit('recover', 'task_status', `${id} retry ${retries[id]} of ${ctx.budgets.maxRetries}${corrected ? ' with corrected arguments' : ''}`,
            { task: id, step: tasks[id].step, status: 'pending', summary: `retry ${retries[id]} of ${ctx.budgets.maxRetries}${corrected ? ` with ${JSON.stringify(corrected)}` : ''}`, retry: retries[id] });
        }
        return decide(d.action, 'retry', 'execute', reason, {}, more);
      }
      case 'skip': return decide(d.action, 'skip', pendingTasks({ ...s, tasks } as State).length ? 'execute' : 'verify', reason, {}, more);
      case 'revise': return decide(d.action, 'revise', 'plan', `Recovering from a failure in ${where}: ${reason}`, {}, more);
      case 'clarify': return decide(d.action, 'clarify', 'clarify', reason, { clarification: { question: d.clarification!.question, options: d.clarification!.options } }, more);
      default: return decide(d.action, 'finish', 'report', reason, { limits: partial(reason) }, more);
    }
  }

  async function report(s: State): Promise<Partial<State>> {
    const counters = await enter('report', s);
    let value: ReportValue;
    try {
      ({ value } = await callModel(ctx, 'report', 'reporter', ReportOutput, reporterMessages({
        mission: s.missionText, question: s.question,
        hypotheses: s.hypotheses.map((h) => `${h.id} [${h.status}, ${h.confidence}${h.rule ? `, ${h.rule}` : ''}] ${h.statement}${h.note ? ` — ${h.note}` : ''}${h.evidence_for.length ? ` (for: ${h.evidence_for.join(', ')})` : ''}${h.evidence_against.length ? ` (against: ${h.evidence_against.join(', ')})` : ''}`).join('\n'),
        observations: observationsText(s, 14000), evidence: evidenceText(s.evidence), limits: s.limits.join('; '),
      }), counters, 4000));
    } catch (error) {
      if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
      // Last line of recovery: a partial answer assembled without a model, from what the run established.
      const message = (error as Error).message;
      await ctx.sink.emit('report', 'node_failed', `Reporter failed: ${trim(message, 150)}; building a partial answer without it`, { node: 'report', error: message });
      s = { ...s, limits: [...s.limits, `the reporter model failed (${trim(message, 160)}); this partial answer was assembled from the verified state`] };
      value = partialReport(s);
    }
    const known = new Map(s.evidence.map((e) => [e.id, e]));
    const cited = [...new Set([...value.evidence, ...(value.conclusion.match(/E\d+/g) ?? [])])].filter((id) => known.has(id));
    const report = { ...value, evidence: cited.map((id) => known.get(id)!), limits: s.limits };
    const view = buildView(s);
    const totals = { tool_calls: counters.toolCalls, llm_calls: counters.llmCalls, revisions: counters.revisions, recoveries: counters.recoveries ?? 0, plan_versions: s.plans.length,
      evidence: s.evidence.length, elapsed_s: elapsed(ctx) };
    await ctx.store.messages.insert({ chatId: ctx.chatId, role: 'assistant', text: value.conclusion, runId: ctx.runId, report, createdAt: new Date().toISOString() });
    await ctx.sink.emit('report', 'run_finished', `Answered with ${value.confidence} confidence`, { status: 'complete', report, totals, view });
    await ctx.onFinished?.('complete', view, totals);
    return { counters, route: 'report' };
  }

  const routeTo = (s: State) => (s.route === 'execute' ? 'execute' : s.route === 'verify' ? 'verify' : s.route === 'clarify' ? 'clarify' : s.route === 'report' ? 'report' : s.route === 'recover' ? 'recover' : 'plan');

  return new StateGraph(AgentState)
    .addNode('intake', intake)
    .addNode('plan', plan)
    .addNode('execute', execute)
    .addNode('verify', verify)
    .addNode('clarify', clarify)
    .addNode('recover', recover)
    .addNode('report', report)
    .addEdge(START, 'intake')
    .addEdge('intake', 'plan')
    .addConditionalEdges('plan', routeTo, ['execute', 'clarify', 'report', 'recover'])
    .addConditionalEdges('execute', routeTo, ['execute', 'verify', 'report', 'recover'])
    .addConditionalEdges('verify', routeTo, ['execute', 'plan', 'clarify', 'report', 'recover'])
    .addConditionalEdges('recover', routeTo, ['execute', 'verify', 'plan', 'clarify', 'report'])
    .addEdge('clarify', 'plan')
    .addEdge('report', END)
    .compile({ checkpointer: new MemorySaver() });
}

export { Command };
