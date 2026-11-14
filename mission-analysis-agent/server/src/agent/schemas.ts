/** The JSON contracts the models must follow. Tool arguments are validated against each tool's own schema. */
import { z } from 'zod';
import { TOOLS } from '../tools/registry.js';

export const AGENT_TOOL_NAMES = TOOLS.map((t) => t.name);

/** In plans, run_analysis names its inputs by task reference ("@S2.1"); its code is written when inputs exist. */
export const AnalysisTaskArgs = z.object({
  inputs: z.array(z.string().regex(/^@S\d+\.\d+$/, 'inputs refer to earlier tasks as "@S<step>.<task>"')).min(1).max(6),
  goal: z.string().min(10).max(800),
});

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
  plan.steps.forEach((step, si) => step.tasks.forEach((task, ti) => {
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

export const VerdictStatus = z.enum(['supported', 'refuted', 'conflicting', 'insufficient', 'untested']);
export const Confidence = z.enum(['high', 'medium', 'low']);

export const VerifyOutput = z.object({
  verdicts: z.array(z.object({
    hypothesis: z.string().regex(/^H\d+$/),
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

export const ReportOutput = z.object({
  conclusion: z.string().min(10).max(6000),
  confidence: Confidence,
  confidence_reason: z.string().min(3).max(600),
  evidence: z.array(z.string().regex(/^E\d+$/)).max(20).default([]),
  rejected_alternatives: z.array(z.object({ hypothesis: z.string().max(400), reason: z.string().max(600) })).max(6).default([]),
  uncertainties: z.array(z.string().max(400)).max(8).default([]),
});
export type ReportOutput = z.output<typeof ReportOutput>;

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
