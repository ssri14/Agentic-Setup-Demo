import { useState } from 'react';
import type { HypothesisView, PlanStep, PlanView, TaskStatus } from './api';

const LABEL: Record<TaskStatus, string> = { pending: 'pending', executing: 'executing', succeeded: 'succeeded', failed: 'failed', skipped: 'skipped' };

export function stepStatus(step: PlanStep): TaskStatus {
  const s = step.tasks.map((t) => t.status);
  if (s.includes('executing')) return 'executing';
  if (s.every((x) => x === 'skipped')) return 'skipped';
  if (s.some((x) => x === 'pending')) return s.some((x) => x !== 'pending') ? 'executing' : 'pending';
  if (s.every((x) => x === 'failed' || x === 'skipped')) return 'failed';
  return 'succeeded';
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status s-${status}`}>{status === 'executing' && <i className="spin" />}{LABEL[status]}</span>;
}

export function Plan({ plan }: { plan: PlanView }) {
  return (
    <ol className="plan-steps">
      {plan.steps.map((step) => (
        <li key={step.id} className={`plan-step st-${stepStatus(step)}`}>
          <div className="step-line"><span className="step-id">{step.id}</span><span className="step-title">{step.title}</span><StatusBadge status={stepStatus(step)} /></div>
          <ul className="plan-tasks">
            {step.tasks.map((t) => (
              <li key={t.id} className={`plan-task t-${t.status}`}>
                <div className="task-line"><span className="task-id">{t.id}</span><code className="tool">{t.tool}</code><span className="task-purpose">{t.purpose}</span><StatusBadge status={t.status} /></div>
                {(t.summary || t.error) && (t.status !== 'pending' || t.summary?.startsWith('retry')) && <div className={t.error ? 'task-note err' : 'task-note'}>{t.error ?? t.summary}</div>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function PlanList({ plans, hypotheses, collapsed: startCollapsed = false }: { plans: PlanView[]; hypotheses: HypothesisView[]; collapsed?: boolean }) {
  const [open, setOpen] = useState(!startCollapsed);
  const latest = plans.at(-1);
  if (!latest) return null;
  const counts = latest.steps.flatMap((s) => s.tasks).reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {} as Record<string, number>);
  return (
    <div className="plan-block">
      <button className="plan-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="plan-title">Plan v{latest.version}</span>
        <span className="plan-objective">{latest.objective}</span>
        <span className="plan-counts">{counts.succeeded ?? 0}/{latest.steps.reduce((n, s) => n + s.tasks.length, 0)} tasks{counts.failed ? ` · ${counts.failed} failed` : ''}</span>
      </button>
      {open && (
        <div className="plan-body">
          {plans.slice(0, -1).reverse().map((p) => (
            <details key={p.version} className="old-plan">
              <summary>Plan v{p.version} (replaced{plans[p.version]?.reason ? `: ${plans[p.version].reason}` : ''})</summary>
              <Plan plan={p} />
            </details>
          ))}
          {latest.reason && <div className="replan-reason">Replanned: {latest.reason}</div>}
          {!!hypotheses.length && (
            <div className="hypotheses">
              {hypotheses.map((h) => (
                <div key={h.id} className={`hyp h-${h.status}`} title={h.statement}>
                  <b>{h.id}</b> <span className="hyp-text">{h.statement}</span> <span className="hyp-status">{h.status}{h.status !== 'untested' ? ` · ${h.confidence}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <Plan plan={latest} />
        </div>
      )}
    </div>
  );
}
