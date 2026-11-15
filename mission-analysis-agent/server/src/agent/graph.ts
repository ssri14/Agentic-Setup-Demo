/**
 * The agent: a LangGraph control loop around model-written plans.
 *
 *   intake → plan → execute → verify ─┬→ execute   (continue with the plan)
 *              ↑                       ├→ plan      (replan)
 *              └──── clarify ←─────────┼→ clarify   (ask the user; interrupts the run)
 *                                      └→ report → END
 *
 *   REPORT only drafts the answer: every factual claim with the evidence it rests on and the exact words quoted.
 *   CHECK verifies each quote against the evidence text, then asks the checker model whether any evidence
 *   contradicts a claim. Problems go back to REPORT (rewrite from the evidence in hand) or to PLAN (retrieve more),
 *   at most twice; the final confidence is capped by what the check could verify.
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
import { MAX_CONTENT, compareSupport, identifiers, plain, cellFound, labelTables, locateSupport, numbersSupported, quoteFound, recordSupport, recordsContent, relatedLines, tableContent, type RecordRow } from './evidence.js';
import { analystMessages, checkerMessages, missionBlock, plannerMessages, recoveryMessages, reporterMessages, toolCatalog, verifierMessages, type MissionContext } from './prompts.js';
import { AnalystOutput, CheckOutput, PlanOutput, ReportOutput, TASK_REF, VerifyOutput, planSchema, recoverSchema, taskRefs, type Claim, type ReportOutput as ReportValue } from './schemas.js';

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
/** snippet: a short excerpt for the UI. content: the full text the models read and quotes are checked against. */
export interface EvidenceItem extends Evidence { id: string; task: string; snippet: string; content?: string; artifact?: string; records?: RecordRow[] }
/**
 * supported: the evidence establishes the claim (checker) and its support was located in the cited text.
 * contradicted: evidence explicitly disagrees, with the contradicting words verified in the evidence.
 * insufficient: the evidence does not establish the claim.
 * validation_error: the checker judged it supported, but its quote or cell could not be matched in the cited text
 *   (a formatting or extraction problem, never treated as a contradiction).
 * unchecked: support located, but the checker model was unavailable.
 */
export type ClaimVerdict = 'supported' | 'contradicted' | 'insufficient' | 'validation_error' | 'unchecked';
export type SupportMatch = 'record' | 'quote' | 'cell' | 'located' | null;
export interface CheckedClaim extends Claim { verdict: ClaimVerdict; matched: SupportMatch; support: string | null; quote_found: boolean; explanation: string; contradicting: { evidence: string; quote: string }[] }
export interface Counters { toolCalls: number; llmCalls: number; revisions: number; clarifications: number; recoveries: number }
/** What failed and must be recovered from: tool tasks in execute, or the planner or verifier model. */
export interface Failure { node: 'execute' | 'plan' | 'verify'; tasks: string[]; error: string }
/** Simulated failures a superuser switches on for demonstrations (Admin → Models → Fault injection). */
export interface Faults { tool: string | null; toolFailures: number; plannerFailures: number }
export interface Clarification { question: string; options: string[]; answer?: string }
export type Route = 'execute' | 'verify' | 'plan' | 'clarify' | 'report' | 'recover' | 'check' | 'done';

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
  /** Failed or abandoned workflow steps. Reported with the answer; they do not lower confidence when the claims are verified. */
  workflow: last<string[]>(),
  failure: last<Failure | null>(),
  retries: last<Record<string, number>>(),
  draft: last<ReportValue | null>(),
  checkRounds: last<number>(),
  checkFeedback: last<string | null>(),
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

/** One line per item: enough to choose what to look at (recovery decisions). */
const evidenceIndex = (items: EvidenceItem[]) => items.map((e) => `${e.id} [${e.kind}] ${e.label} (from ${e.task}): ${trim(e.snippet, 220)}`).join('\n');

/**
 * The evidence the verifier, reporter and checker reason over: each item's full content (tables as labelled rows),
 * within a character budget. Items named in `first` are kept whole first, then the newest; the rest are shortened.
 */
export function evidenceText(items: EvidenceItem[], maxChars = 24000, first: string[] = []): string {
  const num = (id: string) => Number(id.slice(1));
  const order = [...items].sort((a, b) => Number(first.includes(b.id)) - Number(first.includes(a.id)) || num(b.id) - num(a.id));
  const blocks = new Map<string, string>();
  let used = 0;
  for (const e of order) {
    const head = `${e.id} [${e.kind}] ${e.label} (from ${e.task})`;
    const body = e.content ?? e.snippet;
    let text = `${head}\n${body.split('\n').map((l) => `  ${l}`).join('\n')}`;
    if (used + text.length > maxChars) text = `${head}: ${trim(body.replace(/\s+/g, ' '), 200)} (shortened)`;
    used += text.length;
    blocks.set(e.id, text);
  }
  return items.map((e) => blocks.get(e.id)).join('\n\n');
}

/** The full text of one evidence item, for the models and for quote checks. */
function contentFor(e: Evidence, result: ToolResult): string {
  const d = result.data as Record<string, unknown>;
  try {
    if ((e.kind === 'telemetry' || e.kind === 'events') && result.records) {
      const gaps = (d.source_gaps as unknown[] | undefined)?.length ? `\nsource gaps: ${JSON.stringify(d.source_gaps)}` : '';
      return recordsContent(`${result.summary}${gaps}`, result.records as RecordRow[]).slice(0, 12000);
    }
    switch (e.kind) {
      case 'passage': return labelTables(String((d.passages as { chunk_id: string; text: string }[]).find((p) => p.chunk_id === e.ref)?.text ?? '')).slice(0, MAX_CONTENT);
      case 'table': {
        const t = (d.tables as { asset_id: string; title: string | null; section: string | null; page: number; source: string; columns: string[]; rows: string[][]; rows_total: number }[]).find((x) => String(x.asset_id) === e.ref);
        return t ? tableContent(t).slice(0, MAX_CONTENT) : '';
      }
      case 'section': return d.content ? labelTables((d.content as { text: string }[]).map((c) => c.text).join('\n')).slice(0, MAX_CONTENT) : result.summary;
      default: return snippetFor(e, result);
    }
  } catch { return snippetFor(e, result); }
}

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
      args: t.tool === 'run_analysis' ? { ...t.args, inputs: (t.args.inputs as string[]).map((r) => (taskMap.has(r.slice(1)) ? `@${taskMap.get(r.slice(1))}` : r)) }
        : t.tool === 'read_section' && typeof t.args.section === 'string' && TASK_REF.test(t.args.section) && taskMap.has(t.args.section.slice(1)) ? { ...t.args, section: `@${taskMap.get(t.args.section.slice(1))}` }
        : t.args })),
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
    evidence: [...new Set(tested.flatMap((h) => h.evidence_for))].slice(0, 20), rejected_alternatives: [], uncertainties: [...s.limits], claims: [],
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
    const next: Partial<State> = { missionText: missionBlock(context), counters, route: 'plan', plans: [], steps: {}, tasks: {}, hypotheses: [], evidence: [], observations: [], limits: [], workflow: [], clarification: null };
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
      ({ value } = await callModel(ctx, 'plan', 'planner', planSchema(Object.fromEntries(Object.values(s.tasks ?? {}).map((t) => [t.id, t.tool]))), plannerMessages({
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
      if (task.tool === 'read_section' && typeof task.args.section === 'string' && TASK_REF.test(task.args.section)) {
        const ref = task.args.section.slice(1);
        const found = [...evidencePool, ...s.evidence].filter((e) => e.task === ref).find((e) => e.section);
        if (!found) throw new ToolError(`${ref} found no section to read (${s.tasks[ref] ? `it ${s.tasks[ref].status === 'succeeded' ? 'returned no document results' : s.tasks[ref].status}` : 'no such task'})`);
        args = { ...task.args, section: found.section };
        await ctx.sink.emit('execute', 'reference_resolved', `${task.id}: @${ref} → ${found.section} (from ${found.id} ${found.label})`, { task: task.id, ref, field: 'section', value: found.section, evidence: found.id });
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
      const item: EvidenceItem = { ...e, id: `E${evidencePool.length + 1}`, task: task.id, snippet: trim(snippetFor(e, r), 900), content: contentFor(e, r),
        ...((e.kind === 'telemetry' || e.kind === 'events') && r.records ? { records: r.records as RecordRow[] } : {}),
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
    // A task whose referenced task failed or was skipped cannot run: skip it rather than fail it.
    for (const t of Object.values(tasks).filter((x) => x.status === 'pending' && taskRefs(x).length)) {
      const bad = taskRefs(t).map((r) => tasks[r]).find((src) => src && (src.status === 'failed' || src.status === 'skipped'));
      if (bad) {
        tasks[t.id] = { ...t, status: 'skipped', summary: `input ${bad.id} ${bad.status}` };
        await ctx.sink.emit('execute', 'task_status', `${t.id} skipped (input ${bad.id} ${bad.status})`, { task: t.id, step: t.step, status: 'skipped', summary: tasks[t.id].summary });
      }
    }
    const pending = Object.values(tasks).filter((t) => t.status === 'pending');
    // Ready: its step's dependencies are finished, and so is every task it references (even one in its own step).
    const done = (id: string) => !tasks[id] || !['pending', 'executing'].includes(tasks[id].status);
    const ready = pending.filter((t) => s.steps[t.step].depends_on.every((d) => !s.steps[d] || finished(d)) && taskRefs(t).every(done));
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
        observations: observationsText(s, 12000), evidence: evidenceText(s.evidence, 24000),
        budget: `${counters.toolCalls}/${ctx.budgets.maxToolCalls} tool calls, ${counters.revisions}/${ctx.budgets.maxRevisions} plan revisions, ${elapsed(ctx)}/${ctx.budgets.maxSeconds} s`,
        clarificationAvailable: counters.clarifications < ctx.budgets.maxClarifications,
      }), counters, 3000));
    } catch (error) { return nodeFailed('verify', s, counters, error); }
    const known = new Set(s.evidence.map((e) => e.id));
    // Models sometimes name a hypothesis by "H1: statement" or by its statement: map those to the id deterministically.
    const hypothesisId = (raw: string) => {
      const m = raw.trim().match(/^H\d+\b/i) ?? raw.match(/\bH(\d+)\b/);
      if (m) return m[0].toUpperCase().startsWith('H') ? m[0].toUpperCase() : `H${m[1]}`;
      const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return s.hypotheses.find((h) => n(h.statement) === n(raw) || (n(raw).length > 20 && (n(h.statement).includes(n(raw)) || n(raw).includes(n(h.statement)))))?.id ?? raw;
    };
    for (const v of value.verdicts) v.hypothesis = hypothesisId(v.hypothesis);
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
    // Planned tasks are not skipped while the question is still open: reporting early needs every hypothesis decided.
    const undecided = hypotheses.filter((h) => ['untested', 'insufficient', 'conflicting'].includes(h.status));
    if (route === 'report' && value.next === 'report' && pending && undecided.length) {
      route = 'execute';
      reason = `${reason} (guard: ${pendingTasks(s).length} planned task(s) still pending while ${undecided.map((h) => h.id).join(', ')} ${undecided.length > 1 ? 'are' : 'is'} undecided; continuing the plan)`;
    }
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
    const partial = (why: string) => [...(s.workflow ?? []), `${f.node === 'execute' ? '' : `${where} failed: `}${trim(f.error.replace(/\n/g, '; '), 200)} — the investigation stopped there: ${why}`];

    const limit = outOfBudget(counters) ?? (counters.recoveries >= ctx.budgets.maxRecoveries ? `recovery budget (${ctx.budgets.maxRecoveries}) used up` : null);
    if (limit) return decide('finish', 'finish', 'report', limit, { limits: [...s.limits, limit], workflow: partial(limit) }, { guard: true });
    counters.recoveries++;

    const taskTools = Object.fromEntries(f.tasks.map((id) => [id, tasks[id].tool]));
    let d: { action: string; reason: string; corrected_args: Record<string, Record<string, unknown>>; clarification?: { question: string; options: string[] } | null };
    try {
      ({ value: d } = await callModel(ctx, 'recover', 'verifier', recoverSchema(taskTools), recoveryMessages({
        mission: s.missionText, question: s.question, catalog: toolCatalog(Boolean(ctx.mission.telemetrySchema)),
        failure: f.node === 'execute'
          ? f.tasks.map((id) => { const t = tasks[id]; return `${id} ${t.tool} ${t.tool === 'run_analysis' ? `goal="${t.args.goal}"` : JSON.stringify(t.args)} — ${t.purpose}\n  error: ${t.error}\n  retries left: ${left(id)}`; }).join('\n')
          : `The ${f.node === 'plan' ? 'planner' : 'verifier'} model call failed: ${f.error}\n  retries left: ${left(f.node)}`,
        failedNode: f.node, plan: planText(s), observations: observationsText(s, 8000), evidence: evidenceIndex(s.evidence),
        budget: `${counters.toolCalls}/${ctx.budgets.maxToolCalls} tool calls, ${counters.revisions}/${ctx.budgets.maxRevisions} plan revisions, ${elapsed(ctx)}/${ctx.budgets.maxSeconds} s`,
        revisionAvailable: counters.revisions < ctx.budgets.maxRevisions,
        clarificationAvailable: counters.clarifications < ctx.budgets.maxClarifications,
        pendingTasks: pendingTasks(s).length,
      }), counters, 2500));
    } catch (error) {
      if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
      const why = `the recovery model failed (${trim((error as Error).message, 160)}); answering with the evidence gathered so far`;
      return decide('finish', 'finish', 'report', why, { workflow: partial(why) }, { fallback: true });
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
      default: return decide(d.action, 'finish', 'report', reason, { workflow: partial(reason) }, more);
    }
  }

  const hypothesesForReport = (s: State) => s.hypotheses.map((h) => `${h.id} [${h.status}, ${h.confidence}${h.rule ? `, ${h.rule}` : ''}] ${h.statement}${h.note ? ` — ${h.note}` : ''}${h.evidence_for.length ? ` (for: ${h.evidence_for.join(', ')})` : ''}${h.evidence_against.length ? ` (against: ${h.evidence_against.join(', ')})` : ''}`).join('\n');
  const citedByVerdicts = (s: State) => [...new Set(s.hypotheses.flatMap((h) => [...h.evidence_for, ...h.evidence_against]))];

  /** Drafts the answer with its claims. The draft is published only after CHECK. */
  async function report(s: State): Promise<Partial<State>> {
    const counters = await enter('report', s);
    let value: ReportValue;
    try {
      ({ value } = await callModel(ctx, 'report', 'reporter', ReportOutput, reporterMessages({
        mission: s.missionText, question: s.question, hypotheses: hypothesesForReport(s),
        observations: observationsText(s, 10000), evidence: evidenceText(s.evidence, 26000, citedByVerdicts(s)), limits: s.limits.join('; '), workflow: (s.workflow ?? []).join('; '),
        feedback: s.checkFeedback && s.draft ? { previous: s.draft.conclusion, problems: s.checkFeedback } : undefined,
      }), counters, 5000));
    } catch (error) {
      if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
      // Last line of recovery: a partial answer assembled without a model, from what the run established.
      const message = (error as Error).message;
      await ctx.sink.emit('report', 'node_failed', `Reporter failed: ${trim(message, 150)}; building a partial answer without it`, { node: 'report', error: message });
      const limits = [...s.limits, `the reporter model failed (${trim(message, 160)}); this partial answer was assembled from the verified state`];
      return finalize({ ...s, limits } as State, counters, partialReport({ ...s, limits } as State), [], { checker: 'skipped' });
    }
    await ctx.sink.emit('report', 'answer_drafted', `Draft answer with ${value.claims.length} claim(s), ${value.confidence} confidence`,
      { claims: value.claims, confidence: value.confidence, conclusion: value.conclusion, round: (s.checkRounds ?? 0) + 1 });
    const next: Partial<State> = { counters, draft: value, route: 'check' };
    await leave('report', { ...s, ...next } as State, counters);
    return next;
  }

  /** Checks every claim of the draft against the evidence text; sends problems back, or publishes the answer. */
  async function checkClaims(s: State): Promise<Partial<State>> {
    const counters = await enter('check', s);
    const draft = s.draft!;
    const pool = new Map(s.evidence.map((e) => [e.id, e]));
    const contentOf = (id: string) => { const e = pool.get(id); return e ? (e.content ?? e.snippet) : ''; };
    const round = (s.checkRounds ?? 0) + 1;

    // 1. Deterministic: find the claim's support in the cited evidence text, by exact quote, by table cell,
    //    or (when the wording differs) by locating the row or sentence that carries all its identifiers.
    type Det = { cited: string[]; matched: SupportMatch; in: string | null; support: string | null; mismatch?: { evidence: string; line: string; detail: string }; absent?: string; unparsed?: string; numbers?: string[] };
    const det = draft.claims.map((c): Det => {
      const cited = c.evidence.filter((id) => pool.has(id));
      // Several runs (a comparison, or values side by side): joined across all cited records by run ID and exact time.
      const sets = cited.filter((id) => pool.get(id)!.records?.length).map((id) => { const e = pool.get(id)!; return { evidence: id, records: e.records!, start: e.start as number | undefined, end: e.end as number | undefined }; });
      const cmp = sets.length ? compareSupport(c.text, sets) : null;
      if (cmp) {
        const ids = sets.map((s) => s.evidence).join(', ');
        if (cmp.status === 'match') return { cited, matched: 'record', in: ids, support: cmp.line };
        if (cmp.status === 'mismatch') return { cited, matched: null, in: null, support: null, mismatch: { evidence: sets[0].evidence, line: cmp.line, detail: cmp.detail } };
        if (cmp.status === 'absent') return { cited, matched: null, in: null, support: null, absent: `${ids}: ${cmp.detail}` };
        return { cited, matched: null, in: null, support: null, unparsed: `${ids}: ${cmp.detail}` };
      }
      // Structured records (telemetry samples, events): run, time, channel or field, and value; no quotation needed.
      for (const id of cited) {
        const e = pool.get(id)!;
        if (!e.records) continue;
        const r = recordSupport(c.text, e.records, { start: e.start as number | undefined, end: e.end as number | undefined });
        if (r?.status === 'match') return { cited, matched: 'record', in: id, support: r.line };
        if (r?.status === 'mismatch') return { cited, matched: null, in: null, support: null, mismatch: { evidence: id, line: r.line, detail: r.detail } };
        if (r?.status === 'absent') return { cited, matched: null, in: null, support: null, absent: `${id}: ${r.detail}` };
        // About a record, but not mechanically checkable: no text match may stand in for the record check.
        if (r?.status === 'unparsed') return { cited, matched: null, in: null, support: null, unparsed: `${id}: ${r.detail}` };
      }
      // Text: an exact quote or table cell, and every number the claim states must be in that support.
      for (const id of cited) {
        if (c.quote && quoteFound(c.quote, contentOf(id))) {
          const n = numbersSupported(c.text, c.quote);
          if (n.ok) return { cited, matched: 'quote', in: id, support: c.quote };
        }
        const row = c.cell ? cellFound(c.cell, contentOf(id)) : null;
        if (row && numbersSupported(c.text, row).ok) return { cited, matched: 'cell', in: id, support: row };
      }
      for (const id of cited) {
        const line = locateSupport(c.text, contentOf(id));
        if (line && numbersSupported(c.text, line).ok) return { cited, matched: 'located', in: id, support: line };
      }
      // Nothing matched: are the claim's stated numbers and identifiers in the cited evidence at all?
      const all = plain(cited.map(contentOf).join('\n'));
      const missing = [...numbersSupported(c.text, all).missing,
        ...identifiers(c.text).filter((id) => !new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/-/g, '\\-')}([^A-Za-z0-9_]|$)`).test(all))];
      return { cited, matched: null, in: null, support: null, numbers: missing };
    });

    // 2. The checker model: does the evidence, read in full, state each claim, or contradict it?
    let model: CheckOutput | null = null, checkerError: string | null = null;
    const limit = outOfBudget(counters);
    if (draft.claims.length && !limit) {
      const items = s.evidence.map((e) => ({ id: e.id, content: e.content ?? e.snippet }));
      const claimsText = draft.claims.map((c, i) => {
        const d = det[i];
        const cited = c.cell ? `cell: row "${c.cell.row}", column "${c.cell.column}", value "${c.cell.value}"` : `quote: "${c.quote}"`;
        const status = !d.cited.length ? 'cites no evidence from this run'
          : d.matched === 'record' ? `record found in ${d.in}: ${d.support}` : d.mismatch ? `RECORD DIFFERS in ${d.mismatch.evidence}: ${d.mismatch.detail}` : d.absent ? `NO RECORD: ${d.absent}` : d.unparsed ? `RECORD CHECK NOT POSSIBLE: ${d.unparsed}`
          : d.matched === 'quote' ? `quote found in ${d.in}` : d.matched === 'cell' ? `cell found in ${d.in}: ${d.support}`
          : d.matched === 'located' ? `exact wording not found; the line of ${d.in} that mentions all its identifiers is: ${d.support}` : `SUPPORT NOT FOUND in ${d.cited.join(', ')}`;
        const related = relatedLines(c.text, items);
        return `${c.id}: ${c.text}\n  cites: ${c.evidence.join(', ') || 'none'} · ${cited} · ${status}` +
          (related.length ? `\n  lines in the evidence that mention the same identifiers:\n${related.map((l) => `    ${l}`).join('\n')}` : '');
      }).join('\n\n');
      try {
        ({ value: model } = await callModel(ctx, 'check', 'checker', CheckOutput, checkerMessages({
          question: s.question, claims: claimsText, evidence: evidenceText(s.evidence, 26000, [...new Set(draft.claims.flatMap((c) => c.evidence))]),
          revisionAvailable: counters.revisions < ctx.budgets.maxRevisions,
        }), counters, 3000));
      } catch (error) {
        if (error instanceof StoppedError || ctx.signal.aborted) throw new StoppedError();
        checkerError = (error as Error).message;
      }
    }

    // 3. Reconcile. A contradiction needs its own words verified in the evidence; a support that cannot be matched
    //    to the text is a validation error, not a contradiction; "located" support counts only with the checker's agreement.
    const results: CheckedClaim[] = draft.claims.map((c, i) => {
      const d = det[i];
      const m = model?.claims.find((x) => x.id === c.id);
      const contradicting = (m?.contradicting ?? []).filter((x) => pool.has(x.evidence) && quoteFound(x.quote, contentOf(x.evidence)));
      let verdict: ClaimVerdict, explanation = m?.explanation ?? '';
      const exact = d.matched === 'quote' || d.matched === 'cell' || d.matched === 'record';
      // Structured records decide on their own: a different recorded value is a contradiction whatever the checker says.
      if (d.mismatch) { verdict = 'contradicted'; explanation = `${d.mismatch.detail}${explanation ? `; checker: ${explanation}` : ''}`; contradicting.unshift({ evidence: d.mismatch.evidence, quote: d.mismatch.line }); }
      else if (d.absent) { verdict = 'insufficient'; explanation = d.absent; }
      // A matching record proves the values it checked; the rest of the claim's wording needs the checker's agreement.
      else if (d.matched === 'record' && m?.verdict === 'supported') { verdict = 'supported'; explanation = explanation || 'the record states it'; }
      else if (d.matched === 'record' && !m) { verdict = 'unchecked'; explanation = 'the record carries the stated values; the claim checker was not available for the rest of the claim'; }
      // The checker disputes or cannot establish the claim although the record matches: report the disagreement,
      // never "contradicted" next to a record that matches.
      else if (d.matched === 'record') { verdict = 'insufficient'; explanation = `the record ${d.in} carries the stated values (${d.support}), but the checker ${m!.verdict === 'contradicted' ? 'disputes' : 'could not establish'} the rest of the claim: ${explanation}`; }
      // About a record but not mechanically checkable: never supported on the checker's word alone.
      else if (d.unparsed) {
        if (m?.verdict === 'contradicted' && contradicting.length) verdict = 'contradicted';
        else { verdict = 'insufficient'; explanation = `could not be checked against the record (${d.unparsed})${explanation ? `; checker: ${explanation}` : ''}`; }
      }
      else if (m?.verdict === 'contradicted' && contradicting.length) verdict = 'contradicted';
      else if (d.numbers?.length && m?.verdict !== 'contradicted') { verdict = 'insufficient'; explanation = `${d.numbers.join(', ')} ${d.numbers.length > 1 ? 'do' : 'does'} not appear in ${d.cited.join(', ')}${explanation ? `; checker: ${explanation}` : ''}`; }
      else if (!d.cited.length) { verdict = 'insufficient'; explanation = `cites no evidence gathered in this run${explanation ? `; ${explanation}` : ''}`; }
      else if (!m) {
        if (exact) { verdict = 'unchecked'; explanation = explanation || 'support found in the evidence; the claim checker was not available'; }
        else { verdict = 'validation_error'; explanation = `its stated facts are in ${d.cited.join(', ')}, but its quotation could not be matched, and the claim checker was not available`; }
      }
      else if (m.verdict === 'supported') {
        if (d.matched) { verdict = 'supported'; if (d.matched === 'located') explanation = `${explanation} (quotation reworded; matched to the source line instead)`.trim(); }
        else { verdict = 'validation_error'; explanation = `the checker found it supported by ${d.cited.join(', ')}, where its values and names appear, but its quotation does not match the source text${explanation ? `; ${explanation}` : ''}`; }
      }
      else if (m.verdict === 'contradicted') { verdict = 'insufficient'; explanation = `${explanation} (the contradicting text the checker quoted is not in the evidence)`; }
      else verdict = 'insufficient';
      return { ...c, verdict, matched: d.matched, support: d.support, quote_found: d.matched === 'quote', explanation, contradicting };
    });
    const bad = results.filter((r) => r.verdict === 'contradicted' || r.verdict === 'insufficient' || r.verdict === 'validation_error');
    const ok = results.filter((r) => r.verdict === 'supported').length;
    const count = (v: ClaimVerdict) => results.filter((r) => r.verdict === v).length;
    const summary = !results.length ? 'No claims to check' : `${ok} of ${results.length} claims supported${bad.length ? ['contradicted', 'insufficient', 'validation_error'].map((v) => (count(v as ClaimVerdict) ? `, ${count(v as ClaimVerdict)} ${v.replace('_', ' ')}` : '')).join('') : ''}`;
    await ctx.sink.emit('check', 'claim_check', `Round ${round}: ${summary}`, { round, claims: results, next: model?.next ?? null, guidance: model?.guidance ?? '', checker_error: checkerError });

    // 4. Send problems back while rounds and budgets allow.
    if (bad.length && round < 3 && !limit) {
      const problems = bad.map((r) => `${r.id} "${r.text}" — ${r.verdict.replace('_', ' ')}: ${r.explanation}${r.contradicting.length ? ` The evidence says: ${r.contradicting.map((x) => `${x.evidence} "${x.quote}"`).join('; ')}` : ''}${/field = value/.test(r.explanation) ? ' Restate it as field = value at mission_elapsed_s = t, one value per field.' : r.verdict === 'validation_error' ? ' Fix the citation: quote one contiguous span exactly as written, or for a table fact give "cell": {"row", "column", "value"}.' : ''}`).join('\n') + (model?.guidance ? `\nChecker guidance: ${model.guidance}` : '');
      const investigate = model?.next === 'investigate' && counters.revisions < ctx.budgets.maxRevisions && bad.some((r) => r.verdict !== 'validation_error');
      const route: Route = investigate ? 'plan' : 'report';
      const reason = `Claim check found ${bad.length} problem(s) in the draft answer:\n${problems}`;
      await ctx.sink.emit('check', 'decision', `${investigate ? 'investigate further' : 'rewrite the answer'}: ${trim(problems, 150)}`,
        { by: 'check', action: investigate ? 'revise' : 'rewrite', requested: model?.next ?? 'rewrite', route, reason });
      const next: Partial<State> = { counters, route, reason, checkRounds: round, checkFeedback: problems };
      await leave('check', { ...s, ...next } as State, counters);
      return next;
    }
    return finalize(s, counters, draft, results, { checker: model ? 'ok' : checkerError ? 'failed' : 'skipped', rounds: round, limit });
  }

  /** Publishes the answer with confidence capped by what the claim check established. */
  async function finalize(s: State, counters: Counters, draft: ReportValue, results: CheckedClaim[],
    info: { checker: 'ok' | 'failed' | 'skipped'; rounds?: number; limit?: string | null }): Promise<Partial<State>> {
    const rank = { low: 0, medium: 1, high: 2 } as const;
    let cap: keyof typeof rank = 'high';
    const why: string[] = [];
    const lower = (to: keyof typeof rank, reason: string) => { if (rank[to] < rank[cap]) cap = to; why.push(reason); };
    const bad = results.filter((r) => r.verdict === 'contradicted' || r.verdict === 'insufficient');
    const unmatched = results.filter((r) => r.verdict === 'validation_error');
    if (!results.length) lower('low', 'no claim in the answer could be tied to quoted evidence');
    const contradicted = bad.filter((r) => r.verdict === 'contradicted').length, insufficient = bad.length - contradicted;
    if (contradicted) lower('low', `${contradicted} claim(s) contradicted by the evidence`);
    if (insufficient) lower('low', `${insufficient} claim(s) not established by the evidence`);
    // A citation whose wording does not match, while the facts it states are in the cited evidence, is a provenance
    // note: reported with the answer, without lowering confidence. Wrong or missing facts are 'insufficient' instead.
    if (results.some((r) => r.verdict === 'unchecked' || (r.verdict === 'validation_error' && info.checker !== 'ok'))) lower('medium', 'claims were not cross-checked because the claim checker was unavailable');
    // Budget limits cut the investigation short, so they cap confidence. Failed workflow steps do not:
    // they are reported separately, and the claim check decides whether the answer itself is supported.
    const limits = [...new Set([...s.limits, ...(info.limit ? [info.limit] : [])])];
    if (limits.length) lower('medium', `the investigation was cut short (${limits.join('; ')})`);
    const workflow = [...(s.workflow ?? [])];
    if (s.hypotheses.some((h) => h.status === 'conflicting')) lower('medium', 'a hypothesis still has conflicting evidence');
    const confidence = rank[draft.confidence] <= rank[cap] ? draft.confidence : cap;
    const lowered = confidence !== draft.confidence;

    // Planned tasks that never ran are marked, not silently dropped.
    const tasks = { ...s.tasks };
    for (const t of pendingTasks(s)) {
      tasks[t.id] = { ...t, status: 'skipped', summary: 'not run: the answer was reached without it' };
      await ctx.sink.emit('report', 'task_status', `${t.id} skipped (answered without it)`, { task: t.id, step: t.step, status: 'skipped', summary: tasks[t.id].summary });
    }
    const finalState = { ...s, tasks } as State;

    const known = new Map(s.evidence.map((e) => [e.id, e]));
    const notes = [
      bad.length ? `> **Not verified against the evidence:** ${bad.map((r) => `${r.text} (${r.verdict === 'contradicted' ? `contradicted by ${r.contradicting.map((x) => x.evidence).join(', ')}` : 'not established by the cited evidence'})`).join('; ')}` : '',
    ].filter(Boolean);
    const conclusion = notes.length ? `${draft.conclusion}\n\n${notes.join('\n>\n')}` : draft.conclusion;
    const cited = [...new Set([...draft.evidence, ...results.flatMap((r) => [...r.evidence, ...r.contradicting.map((x) => x.evidence)]), ...(conclusion.match(/E\d+/g) ?? [])])].filter((id) => known.has(id));
    const report = {
      ...draft, conclusion, confidence,
      confidence_reason: lowered ? `${draft.confidence_reason} — lowered from ${draft.confidence}: ${why.join('; ')}` : draft.confidence_reason,
      uncertainties: [...draft.uncertainties, ...bad.map((r) => `${r.verdict === 'contradicted' ? 'Contradicted' : 'Unverified'} claim: ${r.text}`)],
      provenance: unmatched.map((r) => `${r.id} "${r.text}": ${r.explanation}`),
      evidence: cited.map((id) => { const { content: _content, records: _records, ...rest } = known.get(id)!; return rest; }),
      workflow, claims: results, checks: { rounds: info.rounds ?? 0, checker: info.checker, supported: results.filter((r) => r.verdict === 'supported').length, total: results.length },
      limits,
    };
    const view = buildView(finalState);
    const totals = { tool_calls: counters.toolCalls, llm_calls: counters.llmCalls, revisions: counters.revisions, recoveries: counters.recoveries ?? 0, plan_versions: s.plans.length,
      evidence: s.evidence.length, check_rounds: info.rounds ?? 0, elapsed_s: elapsed(ctx) };
    await ctx.store.messages.insert({ chatId: ctx.chatId, role: 'assistant', text: conclusion, runId: ctx.runId, report, createdAt: new Date().toISOString() });
    await ctx.sink.emit('report', 'run_finished', `Answered with ${confidence} confidence${lowered ? ` (lowered from ${draft.confidence})` : ''}`, { status: 'complete', report, totals, view });
    await ctx.onFinished?.('complete', view, totals);
    return { counters, tasks, route: 'done' };
  }

  const routeTo = (s: State) => (s.route === 'done' ? END : s.route === 'execute' ? 'execute' : s.route === 'verify' ? 'verify' : s.route === 'clarify' ? 'clarify' : s.route === 'report' ? 'report' : s.route === 'recover' ? 'recover' : s.route === 'check' ? 'check' : 'plan');

  return new StateGraph(AgentState)
    .addNode('intake', intake)
    .addNode('plan', plan)
    .addNode('execute', execute)
    .addNode('verify', verify)
    .addNode('clarify', clarify)
    .addNode('recover', recover)
    .addNode('report', report)
    .addNode('check', checkClaims)
    .addEdge(START, 'intake')
    .addEdge('intake', 'plan')
    .addConditionalEdges('plan', routeTo, ['execute', 'clarify', 'report', 'recover'])
    .addConditionalEdges('execute', routeTo, ['execute', 'verify', 'report', 'recover'])
    .addConditionalEdges('verify', routeTo, ['execute', 'plan', 'clarify', 'report', 'recover'])
    .addConditionalEdges('recover', routeTo, ['execute', 'verify', 'plan', 'clarify', 'report'])
    .addEdge('clarify', 'plan')
    .addConditionalEdges('report', routeTo, ['check', END])
    .addConditionalEdges('check', routeTo, ['report', 'plan', END])
    .compile({ checkpointer: new MemorySaver() });
}

export { Command };
