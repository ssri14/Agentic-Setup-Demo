import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRunner } from '../server/src/agent/runner.js';
import { DEFAULT_BUDGETS } from '../server/src/agent/graph.js';
import type { ChatMessage, ChatModel, Completion, ModelRole } from '../server/src/agent/llm.js';
import { MemoryStore } from '../server/src/store/memory.js';
import type { Chat, Mission, User } from '../server/src/store/types.js';
import { fakeSources, type FakeLog } from './fakes.js';
import { foldTo, frameEvents } from '../client/src/replay.js';
import type { RunEvent } from '../client/src/api.js';

const mission: Mission = { id: 'brahmastra', name: 'Brahmastra', description: 'Fictional mission.', mongoDatabase: 'brahmastra', influxDatabase: 'brahmastra', qdrantCollection: 'document_chunks', telemetrySchema: 'brahmastra-rc1' };
const user = { id: 'u1', username: 'analyst', role: 'user', missions: ['brahmastra'] } as User;

type Reply = string | ((messages: ChatMessage[]) => string);
class ScriptedModel implements ChatModel {
  calls: { role: ModelRole; messages: ChatMessage[] }[] = [];
  constructor(private script: Partial<Record<ModelRole, Reply[]>>, private delayMs = 0) {}
  async complete(role: ModelRole, messages: ChatMessage[], options: { signal?: AbortSignal } = {}): Promise<Completion> {
    this.calls.push({ role, messages });
    if (this.delayMs) await new Promise((r, j) => { const t = setTimeout(r, this.delayMs); options.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    const queue = this.script[role] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error(`no scripted reply for ${role}`);
    return { content: typeof next === 'function' ? next(messages) : next, provider: 'lan', model: 'scripted', duration_ms: 1 };
  }
}

const plan1 = JSON.stringify({
  objective: 'Find runs with missing source samples and characterise the loss',
  hypotheses: [{ id: 'H1', statement: 'BM-RUN-0010 lost samples at the source', confirm_if: 'sample index gaps and DAQ missing counter rises', refute_if: 'samples present but delayed' },
    { id: 'H2', statement: 'The loss is a delivery delay only', confirm_if: 'BACKFILLED rows', refute_if: 'no rows at all for the gap' }],
  steps: [
    { id: 'S1', title: 'Find affected runs', depends_on: [], tasks: [{ id: 'S1.1', tool: 'list_runs', args: {}, purpose: 'runs with missing samples' },
      { id: 'S1.2', tool: 'search_documents', args: { query: 'missing source samples versus delayed delivery', limit: 3 }, purpose: 'the documented rule' }] },
    { id: 'S2', title: 'Inspect the dropout', depends_on: ['S1'], tasks: [{ id: 'S2.1', tool: 'telemetry_window', args: { run_id: 'BM-RUN-0010', channels: ['daq_missing_samples', 'pwr_margin_pu'], start: 300, end: 360 }, purpose: 'gap and counter' }] },
    { id: 'S3', title: 'Quantify', depends_on: ['S2'], tasks: [{ id: 'S3.1', tool: 'run_analysis', args: { inputs: ['@S2.1'], goal: 'Find where sample indices jump and report the counter before and after' }, purpose: 'measure the gap' }] },
  ],
});
const verifyContinue = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'insufficient', confidence: 'low', evidence_for: [], note: 'need telemetry' }], next: 'continue', reason: 'telemetry still to read' });
const verifyReport = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', rule: 'R05', evidence_for: ['E4'], note: 'gap of 50 samples' },
  { hypothesis: 'H2', status: 'refuted', confidence: 'high', evidence_against: ['E4'], note: 'rows absent, not backfilled' }], next: 'report', reason: 'question answered' });
const report = JSON.stringify({ conclusion: 'BM-RUN-0010 lost 50 source samples between 322 and 346.5 s [E4]; this is acquisition loss, not delayed delivery [E2].',
  confidence: 'high', confidence_reason: 'Direct sample-index gap and matching counter', evidence: ['E4', 'E2', 'E99'], rejected_alternatives: [{ hypothesis: 'Delivery delay', reason: 'no backfilled rows' }], uncertainties: [] });
const analyst = JSON.stringify({ code: "df = load_input('S2_1')\nprint(len(df))", explanation: 'count rows' });

let store: MemoryStore;
let log: FakeLog;
let chat: Chat;

beforeEach(async () => {
  store = new MemoryStore([mission]);
  const fake = fakeSources();
  log = fake.log;
  chat = await store.chats.insert({ userId: user.id, mission: 'brahmastra', title: 'New chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  sources = fake.sources;
});
let sources: ReturnType<typeof fakeSources>['sources'];

const runner = (model: ChatModel, budgets = DEFAULT_BUDGETS) => new AgentRunner(store, sources, model, async () => null, budgets);
async function settle(runId: string, until: string[] = ['complete', 'failed', 'stopped'], timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const run = await store.runs.byId(runId);
    if (run && until.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run did not reach ${until.join('/')}: ${(await store.runs.byId(runId))?.status}`);
}
const types = async (runId: string) => (await store.events.list(runId)).map((e) => e.type);

describe('agent', () => {
  it('plans, executes in dependency order, analyses, verifies and reports with evidence', async () => {
    const model = new ScriptedModel({ planner: [plan1], verifier: [verifyContinue, verifyContinue, verifyReport], analyst: [analyst],
      reporter: [(m) => (m[0].content.startsWith('Write a short title') ? JSON.stringify({ title: '"Source sample loss in BM-RUN-0010."' }) : report)] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost source samples, and was it delivery delay?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');

    const events = await store.events.list(run.id);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const t = events.map((e) => e.type);
    expect(t[0]).toBe('run_started');
    expect(t).toContain('plan_created');
    expect(t.at(-1)).toBe('run_finished');
    // S2.1 must not start before both S1 tasks finished.
    const order = events.filter((e) => e.type === 'task_status' && (e.payload as { status: string }).status === 'executing').map((e) => (e.payload as { task: string }).task);
    expect(order.indexOf('S2.1')).toBeGreaterThan(Math.max(order.indexOf('S1.1'), order.indexOf('S1.2')));
    expect(order.at(-1)).toBe('S3.1');
    // The analyst's code read the telemetry window by task name.
    expect(Object.keys(log.sandbox[0].inputs)).toEqual(['S2_1']);
    expect(model.calls.find((c) => c.role === 'analyst')!.messages[1].content).toContain('input "S2_1"');

    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    const r = answer.report as { evidence: { id: string; kind: string }[]; confidence: string };
    expect(r.confidence).toBe('high');
    expect(r.evidence.map((e) => e.id).sort()).toEqual(['E2', 'E4']);   // E99 does not exist and is dropped
    expect(done.view).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.chats.byId(chat.id))!.title).toBe('Source sample loss in BM-RUN-0010');
    expect(['Which runs lost source samples, and was it delivery delay?', 'Source sample loss in BM-RUN-0010']).toContain((await store.chats.byId(chat.id))!.title);
    const verdict = events.find((e) => e.type === 'verification' && (e.payload as { status: string }).status === 'supported')!;
    expect(verdict.payload).toMatchObject({ hypothesis: 'H1', rule: 'R05' });
  });

  it('replans: supersedes pending tasks and numbers new steps after the old ones', async () => {
    const revised = (messages: ChatMessage[]) => {
      expect(messages[1].content).toContain('This is a REVISION');
      expect(messages[1].content).toContain('Number new steps from S4');
      return JSON.stringify({ objective: 'Check the event log instead', hypotheses: [{ id: 'H1', statement: 'BM-RUN-0010 lost samples at the source' }],
        steps: [{ id: 'S4', title: 'Events', tasks: [{ id: 'S4.1', tool: 'events_window', args: { run_id: 'BM-RUN-0010', subsystem: 'DAQ' }, purpose: 'DAQ events' }] }] });
    };
    const replan = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'conflicting', confidence: 'low', note: 'search contradicts' }], next: 'replan', reason: 'need the event log' });
    const model = new ScriptedModel({ planner: [plan1, revised], verifier: [replan, verifyReport], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Explain the dropout in BM-RUN-0010');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const events = await store.events.list(run.id);
    expect(events.filter((e) => e.type === 'plan_revised')).toHaveLength(1);
    const skipped = events.filter((e) => e.type === 'task_status' && (e.payload as { status: string }).status === 'skipped').map((e) => (e.payload as { task: string }).task);
    expect(skipped).toEqual(['S2.1', 'S3.1']);
    expect(events.some((e) => e.type === 'task_status' && (e.payload as { task: string; status: string }).task === 'S4.1' && (e.payload as { status: string }).status === 'succeeded')).toBe(true);
    expect((done.view as { plans: unknown[] }).plans).toHaveLength(2);
    // The replay folds the same events into the graph path, both plan versions and the final node.
    const ev = events as unknown as RunEvent[];
    const end = foldTo(ev, ev.at(-1)!.seq);
    expect(end.current).toBe('end');
    expect(end.edges['verify->plan']).toBe(1);
    expect(end.edges['intake->plan']).toBe(1);
    expect(end.plans.map((p) => p.version)).toEqual([1, 2]);
    expect(end.snapshot).toBeTruthy();
    expect(end.context?.hasTelemetry).toBe(true);
    // Stepping back is exact: halfway through, the replan has not happened yet.
    const frames = frameEvents(ev);
    const firstRevision = frames.findIndex((e) => e.type === 'plan_revised');
    const before = foldTo(ev, frames[firstRevision - 1].seq);
    expect(before.plans).toHaveLength(1);
    expect(before.current).toBe('plan');   // the graph is already back in Plan, the new version not yet out
    expect(frames.every((e) => e.type !== 'state_snapshot')).toBe(true);
  });

  it('asks the user to clarify, waits, then resumes with the answer', async () => {
    const clarify = JSON.stringify({ objective: 'Unclear', steps: [], clarification: { question: 'Which run do you mean?', options: ['BM-RUN-0001', 'BM-RUN-0010'] } });
    const afterAnswer = (messages: ChatMessage[]) => {
      expect(messages[1].content).toContain('The user clarified: Which run do you mean? → BM-RUN-0010');
      return JSON.stringify({ objective: 'Inspect BM-RUN-0010', steps: [{ id: 'S1', title: 'Runs', tasks: [{ id: 'S1.1', tool: 'list_runs', args: {}, purpose: 'check' }] }] });
    };
    const model = new ScriptedModel({ planner: [clarify, afterAnswer], verifier: [verifyReport], reporter: [report] });
    const r = runner(model);
    const run = await r.start(chat, user, mission, 'What happened in that run?');
    await settle(run.id, ['waiting']);
    expect(await types(run.id)).toContain('clarification_asked');
    await r.answer(run.id, 'BM-RUN-0010');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const t = await types(run.id);
    expect(t.filter((x) => x === 'clarification_asked')).toHaveLength(1);
    expect(t).toContain('clarification_answered');
  });

  it('shows the model its validation errors and accepts the corrected plan', async () => {
    const badArgs = JSON.stringify({ objective: 'List the runs', steps: [{ id: 'S1', title: 'Bad', tasks: [{ id: 'S1.1', tool: 'telemetry_window', args: { run_id: 'BM-RUN-0010', channels: [] }, purpose: 'check it' }] }] });
    const fixed = JSON.stringify({ objective: 'List the runs', steps: [{ id: 'S1', title: 'Runs', tasks: [{ id: 'S1.1', tool: 'list_runs', args: {}, purpose: 'check it' }] }] });
    const model = new ScriptedModel({ planner: ['not json at all', badArgs, fixed], verifier: [verifyReport], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'List the runs');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const plannerCalls = model.calls.filter((c) => c.role === 'planner');
    expect(plannerCalls).toHaveLength(3);
    expect(plannerCalls[2].messages.at(-1)!.content).toMatch(/telemetry_window arguments invalid/);
    const llm = (await store.events.list(run.id)).filter((e) => e.type === 'llm_call' && (e.payload as { role: string }).role === 'planner');
    expect(llm.map((e) => (e.payload as { ok: boolean }).ok)).toEqual([false, false, true]);
  });

  it('stops a running investigation', async () => {
    const model = new ScriptedModel({ planner: [plan1], verifier: [verifyContinue], reporter: [report] }, 150);
    const r = runner(model);
    const run = await r.start(chat, user, mission, 'Slow question');
    await new Promise((res) => setTimeout(res, 50));
    await r.stop(run.id);
    const done = await settle(run.id);
    expect(done.status).toBe('stopped');
    expect((await types(run.id)).at(-1)).toBe('run_finished');
    expect((await store.messages.list(chat.id)).at(-1)!.text).toMatch(/Stopped/);
  });

  it('reports with a stated limit when the tool budget runs out', async () => {
    const model = new ScriptedModel({ planner: [plan1], verifier: [verifyContinue], reporter: [(m) => { expect(m[1].content).toContain('tool-call budget (2) reached'); return report; }] });
    const run = await runner(model, { ...DEFAULT_BUDGETS, maxToolCalls: 2 }).start(chat, user, mission, 'Budget test');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const r = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!.report as { limits: string[] };
    expect(r.limits.join(' ')).toContain('tool-call budget (2) reached');
  });

  it('refuses a second question while one is in progress', async () => {
    const model = new ScriptedModel({ planner: [plan1], verifier: [verifyContinue], reporter: [report] }, 200);
    const r = runner(model);
    const run = await r.start(chat, user, mission, 'First');
    await expect(r.start(chat, user, mission, 'Second')).rejects.toThrow(/in progress/);
    await r.stop(run.id);
    await settle(run.id);
  });
});

describe('recovery', () => {
  const isRecovery = (m: ChatMessage[]) => m[0].content.includes('You are the RECOVERY');
  /** The verifier role answers both verification and recovery prompts; route each to its own script. */
  const verifierRouter = (recoveries: string[], verifies: string[]) => (m: ChatMessage[]) => {
    const q = isRecovery(m) ? recoveries : verifies;
    return q.length > 1 ? q.shift()! : q[0];
  };
  const decisions = async (runId: string) => (await store.events.list(runId)).filter((e) => e.type === 'decision').map((e) => e.payload as { by: string; action?: string; route: string; requested: string; fallback?: boolean });
  const runsPlan = JSON.stringify({ objective: 'List the runs', hypotheses: [{ id: 'H1', statement: 'BM-RUN-0010 lost samples at the source' }],
    steps: [{ id: 'S1', title: 'Runs', tasks: [{ id: 'S1.1', tool: 'list_runs', args: {}, purpose: 'runs with missing samples' }] }] });

  it('retries a failed tool after an injected fault, and the retry succeeds', async () => {
    await store.settings.set('fault_injection', { enabled: true, tool: 'list_runs', toolFailures: 1, plannerFailures: 0 });
    const model = new ScriptedModel({ planner: [runsPlan], verifier: [verifierRouter([JSON.stringify({ action: 'retry', reason: 'a timeout is transient' })], [verifyReport])], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const statuses = (await store.events.list(run.id)).filter((e) => e.type === 'task_status').map((e) => (e.payload as { status: string }).status);
    expect(statuses).toEqual(['executing', 'failed', 'pending', 'executing', 'succeeded']);
    expect(await decisions(run.id)).toEqual([expect.objectContaining({ by: 'recover', action: 'retry', route: 'execute' }), expect.objectContaining({ by: 'verify', route: 'report' })]);
    const recoveryPrompt = model.calls.find((c) => c.role === 'verifier' && isRecovery(c.messages))!.messages[1].content;
    expect(recoveryPrompt).toContain('injected fault: list_runs timed out');
    expect(recoveryPrompt).toContain('retries left: 2');
    const ev = (await store.events.list(run.id)) as unknown as RunEvent[];
    const end = foldTo(ev, ev.at(-1)!.seq);
    expect(end.edges['execute->recover']).toBe(1);
    expect(end.edges['recover->execute']).toBe(1);
    expect(end.decisions).toMatchObject({ retry: 1, finish: 1 });
    const atRecovery = foldTo(ev, ev.find((e) => e.type === 'node_entered' && (e.payload as { node: string }).node === 'recover')!.seq);
    expect(atRecovery.deciding).toBe('recover');
    expect(atRecovery.failure).toMatchObject({ node: 'execute', tasks: ['S1.1'] });
  });

  it('retries with corrected arguments checked against the tool schema', async () => {
    const plan = JSON.stringify({ objective: 'Read telemetry', steps: [{ id: 'S1', title: 'Window', tasks: [{ id: 'S1.1', tool: 'telemetry_window', args: { run_id: 'BM-RUN-0010', channels: ['daq_missing_sample'], start: 300, end: 360 }, purpose: 'counter' }] }] });
    const badFix = JSON.stringify({ action: 'retry', reason: 'fix the channel', corrected_args: { 'S1.1': { run_id: 'BM-RUN-0010', channels: [] } } });
    const goodFix = JSON.stringify({ action: 'retry', reason: 'the channel id was misspelled', corrected_args: { 'S1.1': { run_id: 'BM-RUN-0010', channels: ['daq_missing_samples'], start: 300, end: 360 } } });
    const model = new ScriptedModel({ planner: [plan], verifier: [verifierRouter([badFix, goodFix], [verifyReport])], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Missing-sample counter in BM-RUN-0010');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const events = await store.events.list(run.id);
    const results = events.filter((e) => e.type === 'tool_result').map((e) => e.payload as { ok: boolean; error?: string });
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining('Unknown channels: daq_missing_sample') });
    expect(results[1]).toMatchObject({ ok: true });
    const calls = model.calls.filter((c) => c.role === 'verifier' && isRecovery(c.messages));
    expect(calls).toHaveLength(2);                        // the invalid correction was sent back to the model
    expect(calls[1].messages.at(-1)!.content).toMatch(/telemetry_window arguments invalid/);
    expect(events.find((e) => e.type === 'task_status' && (e.payload as { status: string }).status === 'pending')!.summary).toContain('with corrected arguments');
  });

  it('recovers from a failed planner by retrying it', async () => {
    await store.settings.set('fault_injection', { enabled: true, tool: null, toolFailures: 0, plannerFailures: 1 });
    const model = new ScriptedModel({ planner: [runsPlan], verifier: [verifierRouter([JSON.stringify({ action: 'retry', reason: 'HTTP 503 is transient' })], [verifyReport])], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const events = await store.events.list(run.id);
    expect(events.find((e) => e.type === 'node_failed')!.payload).toMatchObject({ node: 'plan' });
    expect((await decisions(run.id))[0]).toMatchObject({ by: 'recover', action: 'retry', route: 'plan' });
    expect(events.filter((e) => e.type === 'node_entered').map((e) => (e.payload as { node: string }).node)).toEqual(['intake', 'plan', 'recover', 'plan', 'execute', 'verify', 'report']);
  });

  it('continues without a failed task when the recovery model says so', async () => {
    const plan = JSON.stringify({ objective: 'Read and list', steps: [{ id: 'S1', title: 'Read', tasks: [{ id: 'S1.1', tool: 'read_section', args: { section: 'SEC-99' }, purpose: 'check it' }, { id: 'S1.2', tool: 'list_runs', args: {}, purpose: 'check it' }] }] });
    const model = new ScriptedModel({ planner: [plan], verifier: [verifierRouter([JSON.stringify({ action: 'skip', reason: 'the run list alone answers it' })], [verifyReport])], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Read section 99');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    expect((await decisions(run.id))[0]).toMatchObject({ action: 'skip', route: 'verify' });
    const verifyCall = model.calls.find((c) => c.role === 'verifier' && !isRecovery(c.messages))!;
    expect(verifyCall.messages[1].content).toContain('[S1.1] read_section({"section":"SEC-99"}) FAILED');
  });

  it('turns a retry into a plan revision once the retry budget is used up', async () => {
    await store.settings.set('fault_injection', { enabled: true, tool: 'list_runs', toolFailures: 5, plannerFailures: 0 });
    const revised = JSON.stringify({ objective: 'Search instead', steps: [{ id: 'S2', title: 'Search', tasks: [{ id: 'S2.1', tool: 'search_documents', args: { query: 'missing samples' }, purpose: 'rule' }] }] });
    const model = new ScriptedModel({ planner: [runsPlan, revised], verifier: [verifierRouter([JSON.stringify({ action: 'retry', reason: 'try again' })], [verifyReport])], reporter: [report] });
    const run = await runner(model, { ...DEFAULT_BUDGETS, maxRetries: 1 }).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const d = await decisions(run.id);
    expect(d[0]).toMatchObject({ action: 'retry', route: 'execute' });
    expect(d[1]).toMatchObject({ requested: 'retry', action: 'revise', route: 'plan' });
    expect((done.view as { plans: unknown[] }).plans).toHaveLength(2);
  });

  it('finishes with a partial answer when the recovery model itself fails', async () => {
    await store.settings.set('fault_injection', { enabled: true, tool: 'list_runs', toolFailures: 1, plannerFailures: 0 });
    const model = new ScriptedModel({ planner: [runsPlan], verifier: [verifierRouter(['not json'], [verifyReport])],
      reporter: [(m) => { expect(m[1].content).toContain('the recovery model failed'); return report; }] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    expect((await decisions(run.id))[0]).toMatchObject({ action: 'finish', route: 'report', fallback: true });
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    expect((answer.report as { limits: string[] }).limits[0]).toMatch(/stopped after a failure in S1.1/);
  });

  it('builds a partial answer without a model when the reporter fails', async () => {
    const model = new ScriptedModel({ planner: [runsPlan], verifier: [verifyReport], reporter: ['nope'] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    expect(answer.text).toMatch(/A full answer could not be written/);
    expect(answer.text).toContain('H1 BM-RUN-0010 lost samples at the source: supported (high)');
    expect((answer.report as { confidence: string }).confidence).toBe('low');
  });
});
