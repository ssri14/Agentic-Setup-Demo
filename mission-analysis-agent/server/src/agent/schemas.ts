/** The JSON contracts the models must follow. Tool arguments are validated against each tool's own schema. */
import { z } from 'zod';
import { TOOLS } from '../tools/registry.js';

export const AGENT_TOOL_NAMES = TOOLS.map((t) => t.name);

/** In plans, run_analysis names its inputs by task reference ("@S2.1"); its code is written when inputs exist. */
export const AnalysisTaskArgs = z.object({
  inputs: z.array(z.string().regex(/^@S\d+\.\d+$/, 'inputs refer to earlier tasks as "@S<step>.<task>"')).min(1).max(6),
  goal: z.string().min(10).max(800),
});

/** A whole-string reference to another task's output: "@S1.1". */
export const TASK_REF = /^@S\d+\.\d+$/;
/**
 * Where a task may point at another task's output:
 * - run_analysis inputs: the CSV results of those tasks;
 * - read_section.section: the section of that task's best result (e.g. the top passage of a search).
 */
export function taskRefs(task: { tool: string; args: Record<string, unknown> }): string[] {
  if (task.tool === 'run_analysis') return ((task.args.inputs as string[]) ?? []).filter((r) => TASK_REF.test(r)).map((r) => r.slice(1));
  if (task.tool === 'read_section' && typeof task.args.section === 'string' && TASK_REF.test(task.args.section)) return [task.args.section.slice(1)];
  return [];
}
const REF_ANYWHERE = /@S\d+\.\d+/;
const mentionsRef = (v: unknown): boolean => (typeof v === 'string' ? REF_ANYWHERE.test(v) : Array.isArray(v) ? v.some(mentionsRef) : false);

const Task = z.object({
  id: z.string().regex(/^S\d+\.\d+$/, 'task ids look like "S1.1"'),
  tool: z.enum(AGENT_TOOL_NAMES as [string, ...string[]]),
  args: z.record(z.string(), z.unknown()).default({}),
  purpose: z.string().min(3).max(300),
});

const Step = z.object({
  id: z.string().regex(/^S\d+$/, 'step ids look like "S1"'),
  title: z.string().min(3).max(120),
  depends_on: z.array(z.string().regex(/^S\d+$/)).default([]),
  tasks: z.array(Task).min(1).max(6),
});

export const Hypothesis = z.object({
  id: z.string().regex(/^H\d+$/, 'hypothesis ids look like "H1"'),
  statement: z.string().min(5).max(400),
  confirm_if: z.string().max(400).default(''),
  refute_if: z.string().max(400).default(''),
});

const Clarification = z.object({ question: z.string().min(5).max(400), options: z.array(z.string().min(1).max(120)).max(5).default([]) });

export const PlanOutput = z.object({
  objective: z.string().min(5).max(400),
  rationale: z.string().max(1200).default(''),
  hypotheses: z.array(Hypothesis).max(6).default([]),
  steps: z.array(Step).max(8).default([]),
  clarification: Clarification.nullish(),
}).superRefine((plan, ctx) => {
  if (!plan.steps.length && !plan.clarification) ctx.addIssue({ code: 'custom', message: 'Give at least one step, or a clarification question', path: ['steps'] });
  const taskIds = new Set<string>();
  const order = plan.steps.flatMap((s) => s.tasks.map((t) => t.id));
  plan.steps.forEach((step, si) => step.tasks.forEach((task, ti) => {
    // Task references: only where they can be resolved, and only to tasks that run before this one.
    const refs = taskRefs(task);
    for (const [key, value] of Object.entries(task.args)) {
      const allowed = (task.tool === 'run_analysis' && key === 'inputs') || (task.tool === 'read_section' && key === 'section' && refs.length);
      if (!allowed && mentionsRef(value)) {
        ctx.addIssue({ code: 'custom', path: ['steps', si, 'tasks', ti, 'args', key],
          message: `${task.tool}.${key} cannot take a task reference like "@S1.1": references work only in run_analysis "inputs" and read_section "section". Give a literal value, or leave this lookup for a later plan revision when the earlier result is known.` });
      }
    }
    for (const ref of refs) {
      const at = order.indexOf(ref);
      if (ref === task.id || (at >= 0 && at > order.indexOf(task.id))) {
        ctx.addIssue({ code: 'custom', path: ['steps', si, 'tasks', ti, 'args'], message: `${task.id} refers to @${ref}, which does not run before it; reference an earlier task` });
      }
    }
    if (!task.id.startsWith(`${step.id}.`)) ctx.addIssue({ code: 'custom', message: `task ${task.id} must be numbered under its step ${step.id}`, path: ['steps', si, 'tasks', ti, 'id'] });
    if (taskIds.has(task.id)) ctx.addIssue({ code: 'custom', message: `duplicate task id ${task.id}`, path: ['steps', si, 'tasks', ti, 'id'] });
    taskIds.add(task.id);
    const schema = task.tool === 'run_analysis' ? AnalysisTaskArgs : TOOLS.find((t) => t.name === task.tool)!.schema;
    const result = (schema as z.ZodType).safeParse(task.args);
    if (!result.success) {
      ctx.addIssue({ code: 'custom', path: ['steps', si, 'tasks', ti, 'args'],
        message: `${task.tool} arguments invalid: ${result.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}` });
    }
  }));
});
export type PlanOutput = z.output<typeof PlanOutput>;

/** What each tool's result can feed into another task. */
export const PRODUCES_CSV = new Set(['get_table', 'telemetry_window', 'events_window', 'run_analysis']);
export const PRODUCES_SECTION = new Set(['search_documents', 'read_section', 'get_table', 'get_figure', 'lookup_channels', 'graph_neighbours']);
const RETURNS: Record<string, string> = {
  search_documents: 'document passages', read_section: 'the text of a document section', get_figure: 'figure descriptions', lookup_channels: 'channel definitions',
  graph_neighbours: 'knowledge-graph links', list_runs: 'a list of runs', get_table: 'a table (CSV)', telemetry_window: 'telemetry samples (CSV)', events_window: 'events (CSV)', run_analysis: 'analysis tables (CSV)',
};

/**
 * The plan contract plus type checks on task references: run_analysis inputs must be tasks that return CSV,
 * read_section references must be tasks that return document results. `earlier` maps tasks of previous plan
 * versions to their tools, so revisions can reference completed work.
 */
export function planSchema(earlier: Record<string, string> = {}) {
  return PlanOutput.superRefine((plan, ctx) => {
    const tools: Record<string, string> = { ...earlier };
    for (const step of plan.steps) for (const t of step.tasks) tools[t.id] = t.tool;
    plan.steps.forEach((step, si) => step.tasks.forEach((task, ti) => {
      for (const ref of taskRefs(task)) {
        const source = tools[ref];
        const path = ['steps', si, 'tasks', ti, 'args'];
        if (!source) { ctx.addIssue({ code: 'custom', path, message: `${task.id} refers to @${ref}, which is not a task of this plan or of an earlier one` }); continue; }
        if (task.tool === 'run_analysis' && !PRODUCES_CSV.has(source)) {
          ctx.addIssue({ code: 'custom', path, message: `${task.id} run_analysis cannot take @${ref}: ${source} returns ${RETURNS[source] ?? 'no table'}, not CSV. run_analysis only analyses CSV results of get_table, telemetry_window, events_window or run_analysis. Document text needs no analysis task: the verifier and reporter read it directly.` });
        }
        if (task.tool === 'read_section' && !PRODUCES_SECTION.has(source)) {
          ctx.addIssue({ code: 'custom', path, message: `${task.id} read_section cannot take @${ref}: ${source} returns ${RETURNS[source] ?? 'no document result'}, which has no document section` });
        }
      }
    }));
  });
}

export const VerdictStatus = z.enum(['supported', 'refuted', 'conflicting', 'insufficient', 'untested']);
export const Confidence = z.enum(['high', 'medium', 'low']);

export const VerifyOutput = z.object({
  verdicts: z.array(z.object({
    hypothesis: z.string().min(1).max(600),          // normally "H1"; other forms are mapped to the id by the verify node
    status: VerdictStatus,
    confidence: Confidence,
    rule: z.string().max(40).nullish(),
    evidence_for: z.array(z.string().regex(/^E\d+$/)).max(12).default([]),
    evidence_against: z.array(z.string().regex(/^E\d+$/)).max(12).default([]),
    note: z.string().max(600).default(''),
  })).default([]),
  next: z.enum(['continue', 'replan', 'clarify', 'report']),
  reason: z.string().min(3).max(800),
  clarification: Clarification.nullish(),
});
export type VerifyOutput = z.output<typeof VerifyOutput>;

export const AnalystOutput = z.object({ code: z.string().min(5).max(15000), explanation: z.string().max(600).default('') });

/** One atomic factual statement of the answer, tied to the exact words of the evidence that states it. */
export const Claim = z.object({
  id: z.string().regex(/^C\d+$/),
  text: z.string().min(3).max(500),
  evidence: z.array(z.string().regex(/^E\d+$/)).max(4).default([]),
  quote: z.string().max(500).default(''),
  /** For a table fact: the row's key, the column and the value in that cell, instead of a stitched quotation. */
  cell: z.object({ row: z.string().min(1).max(120), column: z.string().min(1).max(120), value: z.string().min(1).max(300) }).nullish(),
});
export type Claim = z.output<typeof Claim>;

export const ReportOutput = z.object({
  conclusion: z.string().min(10).max(6000),
  confidence: Confidence,
  confidence_reason: z.string().min(3).max(600),
  evidence: z.array(z.string().regex(/^E\d+$/)).max(20).default([]),
  rejected_alternatives: z.array(z.object({ hypothesis: z.string().max(400), reason: z.string().max(600) })).max(6).default([]),
  uncertainties: z.array(z.string().max(400)).max(8).default([]),
  claims: z.array(Claim).max(12).default([]),
});
export type ReportOutput = z.output<typeof ReportOutput>;

/** The claim checker's verdict on each claim of a draft answer. */
export const CheckOutput = z.object({
  claims: z.array(z.object({
    id: z.string().regex(/^C\d+$/),
    verdict: z.enum(['supported', 'contradicted', 'unsupported']),
    explanation: z.string().max(800).default(''),
    contradicting: z.array(z.object({ evidence: z.string().regex(/^E\d+$/), quote: z.string().min(2).max(500) })).max(4).default([]),
  })),
  next: z.enum(['accept', 'rewrite', 'investigate']),
  guidance: z.string().max(800).default(''),
});
export type CheckOutput = z.output<typeof CheckOutput>;

/** The recovery model's decision. Corrected arguments, when given, are checked against the failed task's tool schema. */
export function recoverSchema(taskTools: Record<string, string>) {
  return z.object({
    action: z.enum(['retry', 'skip', 'revise', 'clarify', 'finish']),
    reason: z.string().min(3).max(800),
    corrected_args: z.record(z.string(), z.record(z.string(), z.unknown())).nullish().transform((v) => v ?? {}),
    clarification: Clarification.nullish(),
  }).superRefine((d, ctx) => {
    if (d.action === 'clarify' && !d.clarification) ctx.addIssue({ code: 'custom', message: 'action "clarify" needs a clarification question', path: ['clarification'] });
    for (const [id, args] of Object.entries(d.corrected_args)) {
      const tool = taskTools[id];
      if (!tool) { ctx.addIssue({ code: 'custom', message: `${id} is not a failed task; correct only ${Object.keys(taskTools).join(', ') || 'nothing (no task failed)'}`, path: ['corrected_args', id] }); continue; }
      if (tool === 'run_analysis') { ctx.addIssue({ code: 'custom', message: 'run_analysis arguments cannot be corrected; a retry rewrites its code', path: ['corrected_args', id] }); continue; }
      const full = { ...args };
      const result = (TOOLS.find((t) => t.name === tool)!.schema as z.ZodType).safeParse(full);
      if (!result.success) ctx.addIssue({ code: 'custom', path: ['corrected_args', id], message: `${tool} arguments invalid: ${result.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}` });
    }
  });
}
