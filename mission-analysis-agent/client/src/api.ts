export interface User {
  id: string; username: string; displayName: string; role: 'superuser' | 'user'; missions: string[];
  disabled: boolean; mustChangePassword: boolean; createdAt: string; lastLoginAt: string | null; locked: boolean;
}
export interface Mission { id: string; name: string; description: string; hasTelemetry: boolean }
export interface Chat { id: string; mission: string; title: string; createdAt: string; updatedAt: string }
export interface AdminMission extends Mission { mongoDatabase: string; documents: number | null; telemetryRuns: number | null; users: number }

let csrf = '';
export const setCsrf = (token: string | undefined) => { csrf = token ?? ''; };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export function generatePassword() {
  const words = ['amber', 'cobalt', 'delta', 'ember', 'falcon', 'granite', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen', 'meridian', 'nimbus', 'orbit', 'quartz', 'raven', 'sierra', 'tundra', 'vector', 'zephyr'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${pick()}-${crypto.getRandomValues(new Uint32Array(1))[0] % 90 + 10}`;
}

// ---- Conversations ----
export type TaskStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'skipped';
export interface PlanTask { id: string; tool: string; purpose: string; status: TaskStatus; summary: string | null; error: string | null }
export interface PlanStep { id: string; title: string; depends_on?: string[]; tasks: PlanTask[] }
export interface PlanView { version: number; objective: string; reason: string | null; steps: PlanStep[] }
export interface HypothesisView { id: string; statement: string; status: string; confidence: string }
export interface RunView { plans: PlanView[]; hypotheses: HypothesisView[] }
export interface EvidenceItem { id: string; kind: string; ref: string; label: string; page?: number; section?: string; run_id?: string; start?: number; end?: number; task: string; snippet: string; artifact?: string }
export interface Report {
  conclusion: string; confidence: 'high' | 'medium' | 'low'; confidence_reason: string; evidence: EvidenceItem[];
  rejected_alternatives: { hypothesis: string; reason: string }[]; uncertainties: string[]; limits: string[];
  claims?: CheckedClaim[]; checks?: { rounds: number; checker: 'ok' | 'failed' | 'skipped'; supported: number; total: number };
}
/** 'unsupported' appears in answers saved by 1.0.2–1.0.3 and means 'insufficient'. */
export type ClaimVerdict = 'supported' | 'contradicted' | 'insufficient' | 'validation_error' | 'unchecked' | 'unsupported';
export interface CheckedClaim { id: string; text: string; evidence: string[]; quote: string; cell?: { row: string; column: string; value: string } | null; verdict: ClaimVerdict;
  matched?: 'quote' | 'cell' | 'located' | null; support?: string | null; quote_found: boolean; explanation: string; contradicting: { evidence: string; quote: string }[] }
export const VERDICT_LABEL: Record<ClaimVerdict, string> = { supported: 'supported', contradicted: 'contradicted', insufficient: 'not established', unsupported: 'not established', validation_error: 'citation not matched', unchecked: 'not cross-checked' };
export const verdictMark = (v: ClaimVerdict) => (v === 'supported' ? '✓' : v === 'validation_error' || v === 'unchecked' ? '?' : '✗');
/** How a claim cites its evidence, for display. */
export const citationText = (c: CheckedClaim) => (c.cell ? `${c.cell.row} · ${c.cell.column} = ${c.cell.value}` : c.quote ? `“${c.quote}”` : '');
export interface Message { id: string; chatId: string; role: 'user' | 'assistant'; text: string; runId?: string; report?: Report | null; createdAt: string }
export interface RunInfo { id: string; status: 'running' | 'waiting' | 'complete' | 'failed' | 'stopped' | 'interrupted'; question: string; createdAt: string; finishedAt?: string; error?: string; view?: RunView; totals?: Record<string, number>; models?: Record<string, string> }
export interface RunEvent { runId: string; seq: number; at: string; node: string; type: string; summary: string; payload: Record<string, unknown> }
