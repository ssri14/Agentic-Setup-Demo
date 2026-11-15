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
  /** `title`, when given, answers the chat-title call so it does not consume the reporter's queue. */
  constructor(private script: Partial<Record<ModelRole | 'title', Reply[]>>, private delayMs = 0) {}
  async complete(role: ModelRole, messages: ChatMessage[], options: { signal?: AbortSignal } = {}): Promise<Completion> {
    this.calls.push({ role, messages });
    if (this.delayMs) await new Promise((r, j) => { const t = setTimeout(r, this.delayMs); options.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    const titleCall = role === 'reporter' && messages[0].content.startsWith('Write a short title') && this.script.title;
    const queue = titleCall ? this.script.title! : this.script[role] ?? (role === 'checker' ? [acceptAllClaims] : []);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error(`no scripted reply for ${role}`);
    return { content: typeof next === 'function' ? next(messages) : next, provider: 'lan', model: 'scripted', duration_ms: 1 };
  }
}

/** Default claim checker: every claim supported. */
const acceptAllClaims: Reply = (m) => JSON.stringify({ claims: [...m[1].content.matchAll(/^(C\d+): /gm)].map((x) => ({ id: x[1], verdict: 'supported', explanation: 'stated by the quote' })), next: 'accept' });
/** The content lines of one evidence item as shown in a prompt. */
const evidenceLines = (prompt: string, id: string) => { const m = prompt.match(new RegExp(`^${id} \\[[^\\n]*\\n((?:  .*\\n?)*)`, 'm')); return m ? m[1].split('\n').map((l) => l.trim()).filter(Boolean) : []; };
/** Adds one claim per cited evidence item, quoting that item's first content line. */
const withClaims = (json: string): Reply => (m) => {
  const r = JSON.parse(json);
  const ids = [...new Set<string>(r.conclusion.match(/E\d+/g) ?? [])];
  r.claims = ids.map((id, i) => ({ id: `C${i + 1}`, text: `fact ${i + 1} of the conclusion`, evidence: [id], quote: (evidenceLines(m[1].content, id)[0] ?? '').slice(0, 120) })).filter((c) => c.quote);
  return JSON.stringify(r);
};

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
const reportJson = JSON.stringify({ conclusion: 'BM-RUN-0010 lost 50 source samples between 322 and 346.5 s [E4]; this is acquisition loss, not delayed delivery [E2].',
  confidence: 'high', confidence_reason: 'Direct sample-index gap and matching counter', evidence: ['E4', 'E2', 'E99'], rejected_alternatives: [{ hypothesis: 'Delivery delay', reason: 'no backfilled rows' }], uncertainties: [] });
const report = withClaims(reportJson);
const reportFor = (m: ChatMessage[]) => withClaims(reportJson)(m) as string;
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
      reporter: [(m) => (m[0].content.startsWith('Write a short title') ? JSON.stringify({ title: '"Source sample loss in BM-RUN-0010."' }) : reportFor(m))] });
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
    const model = new ScriptedModel({ planner: [plan1], verifier: [verifyContinue], reporter: [(m) => { expect(m[1].content).toContain('tool-call budget (2) reached'); return reportFor(m); }] });
    const run = await runner(model, { ...DEFAULT_BUDGETS, maxToolCalls: 2 }).start(chat, user, mission, 'Budget test');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const r = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!.report as { limits: string[]; confidence: string; confidence_reason: string };
    expect(r.limits.join(' ')).toContain('tool-call budget (2) reached');
    expect(r.confidence).toBe('medium');                                   // a budget cut still caps confidence
    expect(r.confidence_reason).toContain('the investigation was cut short (tool-call budget (2) reached)');
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
    expect(events.filter((e) => e.type === 'node_entered').map((e) => (e.payload as { node: string }).node)).toEqual(['intake', 'plan', 'recover', 'plan', 'execute', 'verify', 'report', 'check']);
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
      reporter: [(m) => { expect(m[1].content).toContain('the recovery model failed'); return reportFor(m); }] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost samples?');
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    expect((await decisions(run.id))[0]).toMatchObject({ action: 'finish', route: 'report', fallback: true });
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    const r = answer.report as { limits: string[]; workflow: string[] };
    expect(r.workflow[0]).toMatch(/^S1.1 list_runs: injected fault/);       // a workflow note, not an investigation limit
    expect(r.limits).toEqual([]);
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

describe('claim check (document evidence interpretation)', () => {
  // The SEC-04 dictionary page heading "HLT, DAQ, COM and SUP" lists subsystems; it says nothing about dependencies.
  // The SEC-03 group D table row states: HLT depends on PWR, THM, ENV, ACT.
  const question = 'What is the purpose of the Health Aggregation (HLT) subsystem, and which subsystems does it depend on?';
  const hltPlan = JSON.stringify({ objective: 'Find HLT purpose and dependencies', hypotheses: [{ id: 'H1', statement: 'The subsystem reference states HLT dependencies' }],
    steps: [{ id: 'S1', title: 'Read the documents', tasks: [
      { id: 'S1.1', tool: 'search_documents', args: { query: 'hlt_overall_state hlt_warning_count telemetry dictionary', limit: 2 }, purpose: 'HLT channels' },
      { id: 'S1.2', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'HLT row of the subsystem reference' }] }] });
  const verified = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', evidence_for: ['E3'], note: 'table row' }], next: 'report', reason: 'answered' });
  /** E-number of the first evidence whose prompt content contains the text. */
  const idWith = (prompt: string, text: string) => [...prompt.matchAll(/^(E\d+) \[/gm)].map((x) => x[1]).find((id) => evidenceLines(prompt, id).some((l) => l.includes(text)))!;
  const wrongDraft: Reply = (m) => {
    const heading = idWith(m[1].content, 'HLT, DAQ, COM and SUP');
    return JSON.stringify({ conclusion: `HLT aggregates subsystem health and depends on DAQ, COM and SUP [${heading}].`, confidence: 'high', confidence_reason: 'documented', evidence: [heading],
      claims: [{ id: 'C1', text: 'HLT depends on DAQ, COM and SUP', evidence: [heading], quote: 'HLT, DAQ, COM and SUP' }] });
  };
  const rightDraft: Reply = (m) => {
    expect(m[1].content).toContain('Your previous draft failed the claim check');
    const row = idWith(m[1].content, 'Observation responsibility = Collated warnings and degraded-health classifications; Depends on = PWR, THM, ENV, ACT');
    return JSON.stringify({ conclusion: `HLT (Health Aggregation) collates warnings and degraded-health classifications; it depends on PWR, THM, ENV and ACT [${row}].`, confidence: 'high', confidence_reason: 'table row', evidence: [row],
      claims: [{ id: 'C1', text: 'HLT depends on PWR, THM, ENV and ACT', evidence: [row], quote: 'ID = HLT; Subsystem = Health Aggregation; … Depends on = PWR, THM, ENV, ACT' },
        { id: 'C2', text: 'HLT collates warnings and degraded-health classifications', evidence: [row], quote: 'Collated warnings and degraded-health classifications' }] });
  };
  /** A checker that does what the prompt asks: C1 about dependencies is contradicted by the table row it is shown. */
  const strictChecker: Reply = (m) => {
    const prompt = m[1].content;
    const ids = [...prompt.matchAll(/^(C\d+): (.*)$/gm)];
    return JSON.stringify({ claims: ids.map(([, id, text]) => {
      const wrong = /DAQ, COM and SUP/.test(text);
      const row = prompt.match(/(E\d+): Row \d+: ID = HLT;[^\n]*Depends on = PWR, THM, ENV, ACT/);
      return wrong ? { id, verdict: 'contradicted', explanation: 'the heading lists subsystems; the table row states the dependencies', contradicting: [{ evidence: row![1], quote: 'Depends on = PWR, THM, ENV, ACT' }] }
        : { id, verdict: 'supported', explanation: 'stated by the row' };
    }), next: ids.some(([, , text]) => /DAQ, COM and SUP/.test(text)) ? 'rewrite' : 'accept', guidance: 'use the SEC-03 group D row' });
  };

  it('shows tables to the models as labelled rows, with the row next to the claim', async () => {
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [hltPlan], verifier: [verified], reporter: [wrongDraft, rightDraft], checker: [strictChecker] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const checkPrompt = model.calls.find((c) => c.role === 'checker')!.messages[1].content;
    expect(checkPrompt).toContain('quote found in');                                     // the heading is really in the passage...
    expect(checkPrompt).toMatch(/lines in the evidence that mention the same identifiers:[\s\S]*Row 1: ID = HLT; Subsystem = Health Aggregation;[^\n]*Depends on = PWR, THM, ENV, ACT/);
    const reporterPrompt = model.calls.find((c) => c.role === 'reporter' && !c.messages[0].content.startsWith('Write a short title'))!.messages[1].content;
    expect(reporterPrompt).toMatch(/Row 1: ID = HLT;[^\n]*Depends on = PWR, THM, ENV, ACT/);   // no 220-character fragment
  });

  it('rejects "HLT depends on DAQ, COM and SUP" and publishes the corrected answer (regression)', async () => {
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [hltPlan], verifier: [verified], reporter: [wrongDraft, rightDraft], checker: [strictChecker] });
    const run = await runner(model).start(chat, user, mission, question);
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const events = await store.events.list(run.id);
    const checks = events.filter((e) => e.type === 'claim_check').map((e) => e.payload as { round: number; claims: { id: string; verdict: string }[] });
    expect(checks[0].claims).toEqual([expect.objectContaining({ id: 'C1', verdict: 'contradicted' })]);
    expect(checks[1].claims.map((c) => c.verdict), JSON.stringify(checks[1].claims)).toEqual(['supported', 'supported']);
    expect(events.find((e) => e.type === 'decision' && (e.payload as { by: string }).by === 'check')!.payload).toMatchObject({ action: 'rewrite', route: 'report' });
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    expect(answer.text).toContain('PWR, THM, ENV and ACT');
    expect(answer.text).not.toContain('DAQ, COM and SUP');
    const r = answer.report as { confidence: string; checks: { supported: number; total: number; rounds: number } };
    expect(r.confidence).toBe('high');
    expect(r.checks).toMatchObject({ supported: 2, total: 2, rounds: 2 });
  });

  it('caps confidence and flags the claim when it still cannot be verified', async () => {
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [hltPlan], verifier: [verified], reporter: [wrongDraft], checker: [strictChecker] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    const r = answer.report as { confidence: string; confidence_reason: string; uncertainties: string[]; checks: { rounds: number } };
    expect(r.checks.rounds).toBe(3);                                      // two rewrites, then published as unverified
    expect(r.confidence).toBe('low');
    expect(r.confidence_reason).toMatch(/lowered from high: 1 claim\(s\) contradicted by the evidence/);
    expect(answer.text).toMatch(/Not verified against the evidence:\*\* HLT depends on DAQ, COM and SUP \(contradicted by E\d+\)/);
  });

  it('reports a mis-worded quotation as a provenance note, without lowering confidence, when the facts are in the evidence', async () => {
    const reworded: Reply = (m) => { const row = idWith(m[1].content, 'Depends on = PWR, THM, ENV, ACT');
      return JSON.stringify({ conclusion: `HLT depends on PWR, THM, ENV and ACT [${row}].`, confidence: 'high', confidence_reason: 'from the table', evidence: [row],
        claims: [{ id: 'C1', text: 'The dependency list is given for HLT', evidence: [row], quote: 'HLT relies on four subsystems' }] }); };
    const model = new ScriptedModel({ title: ['{"title":"HLT"}'], planner: [hltPlan], verifier: [verified], reporter: [reworded] });   // checker: supported
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
    const r = answer.report as { confidence: string; provenance: string[]; claims: { verdict: string }[]; uncertainties: string[] };
    expect(r.claims[0].verdict).toBe('validation_error');
    expect(r.confidence).toBe('high');                                     // confidence follows the factual verdicts
    expect(r.provenance).toEqual([expect.stringContaining('C1 "The dependency list is given for HLT": the checker found it supported by E')]);
    expect(answer.text).not.toContain('Citation not matched');
    expect(r.uncertainties).toEqual([]);
  });

  it('treats a claim whose names are not in the cited evidence as not established, whatever the checker says', async () => {
    const invented: Reply = (m) => { const row = idWith(m[1].content, 'Depends on = PWR, THM, ENV, ACT');
      return JSON.stringify({ conclusion: `HLT depends on GNC [${row}].`, confidence: 'high', confidence_reason: 'from the table', evidence: [row],
        claims: [{ id: 'C1', text: 'HLT depends on GNC', evidence: [row], quote: 'HLT depends on GNC' }] }); };
    const model = new ScriptedModel({ title: ['{"title":"HLT"}'], planner: [hltPlan], verifier: [verified], reporter: [invented] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const first = (await store.events.list(run.id)).find((e) => e.type === 'claim_check')!.payload as { claims: { verdict: string; explanation: string }[] };
    expect(first.claims[0]).toMatchObject({ verdict: 'insufficient', explanation: expect.stringContaining('GNC does not appear in') });
    expect(((await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!.report as { confidence: string }).confidence).toBe('low');
  });

  it('ignores a contradiction whose quote is not in the evidence', async () => {
    const lyingChecker: Reply = (m) => JSON.stringify({ claims: [...m[1].content.matchAll(/^(C\d+): /gm)].map((x) => ({ id: x[1], verdict: 'contradicted', explanation: 'made up', contradicting: [{ evidence: 'E1', quote: 'HLT depends on nothing at all' }] })), next: 'rewrite' });
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [hltPlan], verifier: [verified], reporter: [(m) => rightDraft([m[0], { role: 'user', content: `${m[1].content}\nYour previous draft failed the claim check` }])], checker: [lyingChecker] });
    const run = await runner(model).start(chat, user, mission, question);
    await settle(run.id);
    const first = (await store.events.list(run.id)).find((e) => e.type === 'claim_check')!.payload as { claims: { verdict: string }[] };
    expect(first.claims.map((c) => c.verdict)).toEqual(['insufficient', 'insufficient']);  // demoted, never "contradicted" on invented text
  });

  it('goes back to planning when the checker asks for more retrieval', async () => {
    const onlyHeading = JSON.stringify({ objective: 'Search', hypotheses: [{ id: 'H1', statement: 'HLT dependencies are documented' }],
      steps: [{ id: 'S1', title: 'Search', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'hlt_overall_state hlt_warning_count telemetry dictionary', limit: 1 }, purpose: 'HLT' }] }] });
    const fetchTable = JSON.stringify({ objective: 'Read the subsystem reference row', steps: [{ id: 'S2', title: 'Table', tasks: [{ id: 'S2.1', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'HLT row' }] }] });
    const investigate: Reply = (m) => JSON.stringify({ claims: [...m[1].content.matchAll(/^(C\d+): /gm)].map((x) => ({ id: x[1], verdict: 'unsupported', explanation: 'a heading is not a dependency' })), next: 'investigate', guidance: 'fetch the SEC-03 subsystem reference table row for HLT' });
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [onlyHeading, (m) => { expect(m[1].content).toContain('fetch the SEC-03 subsystem reference table row'); return fetchTable; }],
      verifier: [verified], reporter: [wrongDraft, rightDraft], checker: [investigate, strictChecker] });
    const run = await runner(model).start(chat, user, mission, question);
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const nodes = (await store.events.list(run.id)).filter((e) => e.type === 'node_entered').map((e) => (e.payload as { node: string }).node);
    expect(nodes).toEqual(['intake', 'plan', 'execute', 'verify', 'report', 'check', 'plan', 'execute', 'verify', 'report', 'check']);
    expect((done.view as { plans: unknown[] }).plans).toHaveLength(2);
  });

  it('does not let the verifier report past pending tasks while a hypothesis is undecided', async () => {
    const twoSteps = JSON.stringify({ objective: 'Find HLT dependencies', hypotheses: [{ id: 'H1', statement: 'HLT dependencies are documented' }],
      steps: [{ id: 'S1', title: 'Search', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'hlt_overall_state hlt_warning_count telemetry dictionary', limit: 1 }, purpose: 'HLT' }] },
        { id: 'S2', title: 'Table', depends_on: ['S1'], tasks: [{ id: 'S2.1', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'HLT row' }] }] });
    const tooEarly = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'insufficient', confidence: 'low', note: 'only a heading so far' }], next: 'report', reason: 'good enough' });
    const model = new ScriptedModel({ title: ['{"title":"HLT purpose and dependencies"}'], planner: [twoSteps], verifier: [tooEarly, verified], reporter: [(m) => rightDraft([m[0], { role: 'user', content: `${m[1].content}\nYour previous draft failed the claim check` }])] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const decisions = (await store.events.list(run.id)).filter((e) => e.type === 'decision').map((e) => e.payload as { route: string; reason: string });
    expect(decisions[0]).toMatchObject({ route: 'execute', reason: expect.stringContaining('guard: 1 planned task(s) still pending while H1 is undecided') });
    const results = (await store.events.list(run.id)).filter((e) => e.type === 'tool_result').map((e) => (e.payload as { tool: string }).tool);
    expect(results).toEqual(['search_documents', 'get_table']);
  });
});

describe('task references between dependent tool calls', () => {
  const question = 'What is the purpose of HLT and which subsystems does it depend on? Cite the section.';
  const title = ['{"title":"HLT purpose"}'];
  const verified = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'section text' }], next: 'report', reason: 'answered' });
  const plan = (second: Record<string, unknown>) => JSON.stringify({ objective: 'Find and read the HLT section', hypotheses: [{ id: 'H1', statement: 'The documents describe HLT' }],
    steps: [{ id: 'S1', title: 'Find and read', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'hlt_overall_state hlt_warning_count telemetry dictionary', limit: 2 }, purpose: 'find HLT' }, second] }] });
  const events = async (runId: string) => store.events.list(runId);

  it('resolves read_section "@S1.1" to the section of the search result, after the search, in the same step', async () => {
    const model = new ScriptedModel({ title, planner: [plan({ id: 'S1.2', tool: 'read_section', args: { section: '@S1.1' }, purpose: 'read the section the search found' })], verifier: [verified], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    const done = await settle(run.id);
    expect(done.status, done.error).toBe('complete');
    const ev = await events(run.id);
    expect(ev.find((e) => e.type === 'reference_resolved')!.payload).toMatchObject({ task: 'S1.2', ref: 'S1.1', field: 'section', value: 'SEC-04' });
    const calls = ev.filter((e) => e.type === 'tool_called').map((e) => e.payload as { task: string; args: { section?: string } });
    expect(calls.map((c) => c.task)).toEqual(['S1.1', 'S1.2']);
    expect(calls[1].args.section).toBe('SEC-04');
    const results = ev.filter((e) => e.type === 'tool_result').map((e) => e.payload as { task: string; ok: boolean });
    expect(results).toEqual([expect.objectContaining({ task: 'S1.1', ok: true }), expect.objectContaining({ task: 'S1.2', ok: true })]);
    expect(ev.some((e) => e.type === 'node_entered' && (e.payload as { node: string }).node === 'recover')).toBe(false);
  });

  it('rejects a reference in any other argument at planning time, so the planner fixes the plan', async () => {
    const bad = plan({ id: 'S1.2', tool: 'get_table', args: { contains: '@S1.1' }, purpose: 'table of what the search found' });
    const good = plan({ id: 'S1.2', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'HLT row' });
    const model = new ScriptedModel({ title, planner: [bad, good], verifier: [verified], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const retry = model.calls.filter((c) => c.role === 'planner')[1].messages.at(-1)!.content;
    expect(retry).toContain('get_table.contains cannot take a task reference like "@S1.1"');
  });

  it('rejects a reference to a task that runs later', async () => {
    const forward = JSON.stringify({ objective: 'Read then search', steps: [{ id: 'S1', title: 'x', tasks: [
      { id: 'S1.1', tool: 'read_section', args: { section: '@S1.2' }, purpose: 'read' }, { id: 'S1.2', tool: 'search_documents', args: { query: 'HLT' }, purpose: 'find' }] }] });
    const model = new ScriptedModel({ title, planner: [forward, plan({ id: 'S1.2', tool: 'read_section', args: { section: '@S1.1' }, purpose: 'read' })], verifier: [verified], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    expect(model.calls.filter((c) => c.role === 'planner')[1].messages.at(-1)!.content).toContain('S1.1 refers to @S1.2, which does not run before it');
  });

  it('fails clearly when the referenced task found nothing', async () => {
    const nothing = JSON.stringify({ objective: 'Search for something absent', hypotheses: [{ id: 'H1', statement: 'The documents describe it' }], steps: [
      { id: 'S1', title: 'Search', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'zzzzqq xxxxyy' }, purpose: 'find' }, { id: 'S1.2', tool: 'read_section', args: { section: '@S1.1' }, purpose: 'read' }] }] });
    const skip = JSON.stringify({ action: 'skip', reason: 'nothing to read' });
    const model = new ScriptedModel({ title, planner: [nothing], verifier: [(m) => (m[0].content.includes('You are the RECOVERY') ? skip : verified)], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const failed = (await events(run.id)).find((e) => e.type === 'tool_result' && (e.payload as { task: string }).task === 'S1.2')!.payload as { ok: boolean; error: string };
    expect(failed).toMatchObject({ ok: false, error: 'S1.1 found no section to read (it returned no document results)' });
  });
});

describe('claim validation reconciled with the verifier (recorded HLT run)', () => {
  const question = 'What is the purpose of the Health Aggregation (HLT) subsystem in Brahmastra, and which other subsystems does it depend on? Cite the relevant section of the technical reference.';
  const title = ['{"title":"HLT overview"}'];
  const plan = JSON.stringify({ objective: 'Identify the purpose of HLT and the subsystems it depends on', hypotheses: [
    { id: 'H1', statement: 'SEC-03 states the purpose of HLT' }, { id: 'H2', statement: 'SEC-03 lists the subsystems HLT depends on' }],
    steps: [{ id: 'S1', title: 'Find the section describing HLT', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'Health stage safety status consolidates subsystem warnings', limit: 1 }, purpose: 'HLT section' }] }] });
  // The verifier named the hypotheses by their statements, not by H1/H2 (as observed in the run).
  const verifier = JSON.stringify({ verdicts: [
    { hypothesis: 'SEC-03 states the purpose of HLT', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'HLT consolidates subsystem warnings' },
    { hypothesis: 'H2: SEC-03 lists the subsystems HLT depends on', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'Depends on = PWR, THM, ENV, ACT' }], next: 'report', reason: 'answered' });
  const draft = (claim: Record<string, unknown>) => JSON.stringify({ conclusion: 'HLT consolidates subsystem warnings into a single health classification and depends on PWR, THM, ENV and ACT [E1].',
    confidence: 'high', confidence_reason: 'The SEC-03 table and paragraph state both', evidence: ['E1'], claims: [
      { id: 'C1', text: 'HLT consolidates subsystem warnings into the health classifications', evidence: ['E1'], quote: 'HLT consolidates subsystem warnings into the canonical NOMINAL, WARNING, DEGRADED and UNKNOWN' }, claim] });

  for (const [label, claim] of [
    ['the exact quotation from the run', { id: 'C2', text: 'HLT depends on the PWR, THM, ENV, and ACT subsystems.', evidence: ['E1'], quote: 'HLT … Depends on PWR, THM, ENV, ACT' }],
    ['a table-cell citation', { id: 'C2', text: 'HLT depends on PWR, THM, ENV and ACT', evidence: ['E1'], quote: '', cell: { row: 'HLT', column: 'Depends on', value: 'PWR, THM, ENV, ACT' } }],
    ['a reworded quotation', { id: 'C2', text: 'HLT depends on the PWR, THM, ENV, and ACT subsystems.', evidence: ['E1'], quote: 'HLT depends on PWR, THM, ENV and ACT' }],
  ] as const) {
    it(`verifies the dependency claim from ${label} and answers with high confidence in one round`, async () => {
      const model = new ScriptedModel({ title, planner: [plan], verifier: [verifier], reporter: [draft(claim)] });
      const run = await runner(model).start(chat, user, mission, question);
      const done = await settle(run.id);
      expect(done.status, done.error).toBe('complete');
      const answer = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
      const r = answer.report as { confidence: string; claims: { verdict: string; matched: string; support: string }[]; checks: { rounds: number } };
      expect(r.claims.map((c) => c.verdict)).toEqual(['supported', 'supported']);
      expect(r.claims[1].support).toBeTruthy();
      expect(r.checks.rounds).toBe(1);
      expect(r.confidence).toBe('high');
      expect(answer.text).not.toContain('Not verified');
      const hyp = (done.view as { hypotheses: { id: string; status: string }[] }).hypotheses;
      expect(hyp.map((h) => h.status)).toEqual(['supported', 'supported']);           // statements mapped to H1, H2
      expect(model.calls.filter((c) => c.role === 'verifier')).toHaveLength(1);          // no retry for the naming
    });
  }

  it('still rejects the wrong dependency when the checker contradicts it with real text', async () => {
    const contradict: Reply = (m) => JSON.stringify({ claims: [...m[1].content.matchAll(/^(C\d+): (.*)$/gm)].map(([, id, text]) => /DAQ/.test(text)
      ? { id, verdict: 'contradicted', explanation: 'the row says otherwise', contradicting: [{ evidence: 'E1', quote: 'Depends on = PWR, THM, ENV, ACT' }] } : { id, verdict: 'supported', explanation: 'ok' }), next: 'rewrite' });
    const wrong = draft({ id: 'C2', text: 'HLT depends on DAQ, COM and SUP', evidence: ['E1'], quote: 'HLT … DAQ' });
    const model = new ScriptedModel({ title, planner: [plan], verifier: [verifier], reporter: [wrong], checker: [contradict] });
    const run = await runner(model).start(chat, user, mission, question);
    await settle(run.id);
    const r = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!.report as { confidence: string; claims: { verdict: string }[] };
    expect(r.claims[1].verdict).toBe('contradicted');
    expect(r.confidence).toBe('low');
  });
});

describe('type-safe tool planning', () => {
  const question = 'What is the purpose of the HLT subsystem, and which subsystems does it depend on?';
  const title = ['{"title":"HLT purpose"}'];
  const docsThenAnalysis = JSON.stringify({ objective: 'HLT purpose and dependencies', hypotheses: [{ id: 'H1', statement: 'SEC-03 lists HLT dependencies as PWR, THM, ENV and ACT' }], steps: [
    { id: 'S1', title: 'Read', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'HLT purpose' }, purpose: 'find' }, { id: 'S1.2', tool: 'read_section', args: { section: '@S1.1' }, purpose: 'read' }] },
    { id: 'S2', title: 'Answer', depends_on: ['S1'], tasks: [{ id: 'S2.1', tool: 'run_analysis', args: { inputs: ['@S1.2'], goal: 'Produce the final evidence-based answer' }, purpose: 'answer' }] }] });
  const docsOnly = JSON.stringify({ objective: 'HLT purpose and dependencies', hypotheses: [{ id: 'H1', statement: 'SEC-03 lists HLT dependencies as PWR, THM, ENV and ACT' }], steps: [
    { id: 'S1', title: 'Read', tasks: [{ id: 'S1.1', tool: 'search_documents', args: { query: 'HLT purpose' }, purpose: 'find' }, { id: 'S1.2', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'row' }] }] });
  const verified = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'row' }], next: 'report', reason: 'answered' });

  it('rejects run_analysis over a document section before anything runs; the planner answers from the documents', async () => {
    const model = new ScriptedModel({ title, planner: [docsThenAnalysis, docsOnly], verifier: [verified], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    const retry = model.calls.filter((c) => c.role === 'planner')[1].messages.at(-1)!.content;
    expect(retry).toContain('S2.1 run_analysis cannot take @S1.2: read_section returns the text of a document section, not CSV');
    const tools = (await store.events.list(run.id)).filter((e) => e.type === 'tool_called').map((e) => (e.payload as { tool: string }).tool);
    expect(tools).toEqual(['search_documents', 'get_table']);                // no analysis, no failure
  });

  it('applies the same check to references into an earlier plan version', async () => {
    const replan = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'insufficient', confidence: 'low', note: 'need more' }], next: 'replan', reason: 'analyse it' });
    const badRevision = JSON.stringify({ objective: 'Analyse', steps: [{ id: 'S2', title: 'Analyse', tasks: [{ id: 'S2.1', tool: 'run_analysis', args: { inputs: ['@S1.1'], goal: 'Analyse the search results in detail' }, purpose: 'x' }] }] });
    const goodRevision = JSON.stringify({ objective: 'Table', steps: [{ id: 'S2', title: 'Table', tasks: [{ id: 'S2.1', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'row' }] }] });
    const model = new ScriptedModel({ title, planner: [docsOnly, badRevision, goodRevision], verifier: [replan, verified], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    expect(model.calls.filter((c) => c.role === 'planner')[2].messages.at(-1)!.content).toContain('run_analysis cannot take @S1.1: search_documents returns document passages');
  });

  it('still lets run_analysis use telemetry: the telemetry investigation plan is accepted unchanged', async () => {
    const model = new ScriptedModel({ planner: [plan1], analyst: [analyst], verifier: [verifyContinue, verifyContinue, verifyReport], reporter: [report] });
    const run = await runner(model).start(chat, user, mission, 'Which runs lost source samples?');
    expect((await settle(run.id)).status).toBe('complete');
    expect(model.calls.filter((c) => c.role === 'planner')).toHaveLength(1);
    const analysis = (await store.events.list(run.id)).find((e) => e.type === 'tool_result' && (e.payload as { tool: string }).tool === 'run_analysis')!.payload as { ok: boolean };
    expect(analysis.ok).toBe(true);
  });
});

describe('answer confidence versus workflow failures', () => {
  it('keeps high confidence when the claims are verified and an unrelated step failed; the failure is reported separately', async () => {
    await store.settings.set('fault_injection', { enabled: true, tool: 'events_window', toolFailures: 1, plannerFailures: 0 });
    const plan = JSON.stringify({ objective: 'HLT dependencies, plus HLT events', hypotheses: [{ id: 'H1', statement: 'SEC-03 lists HLT dependencies as PWR, THM, ENV and ACT' }], steps: [
      { id: 'S1', title: 'Read', tasks: [{ id: 'S1.1', tool: 'get_table', args: { contains: 'HLT', max_tables: 1 }, purpose: 'row' },
        { id: 'S1.2', tool: 'events_window', args: { run_id: 'BM-RUN-0010', subsystem: 'HLT' }, purpose: 'optional context' }] }] });
    const verified = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'row' }], next: 'report', reason: 'answered' });
    const finish = JSON.stringify({ action: 'finish', reason: 'the table already answers the question' });
    const answer = JSON.stringify({ conclusion: 'HLT depends on PWR, THM, ENV and ACT [E1].', confidence: 'high', confidence_reason: 'table row', evidence: ['E1'],
      claims: [{ id: 'C1', text: 'HLT depends on PWR, THM, ENV and ACT', evidence: ['E1'], quote: '', cell: { row: 'HLT', column: 'Depends on', value: 'PWR, THM, ENV, ACT' } }] });
    const model = new ScriptedModel({ title: ['{"title":"HLT"}'], planner: [plan], verifier: [(m) => (m[0].content.includes('You are the RECOVERY') ? finish : verified)], reporter: [answer] });
    const run = await runner(model).start(chat, user, mission, 'Which subsystems does HLT depend on?');
    expect((await settle(run.id)).status).toBe('complete');
    const r = (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!.report as { confidence: string; limits: string[]; workflow: string[]; claims: { verdict: string }[] };
    expect(r.claims.map((c) => c.verdict)).toEqual(['supported']);
    expect(r.confidence).toBe('high');
    expect(r.limits).toEqual([]);
    expect(r.workflow).toEqual([expect.stringMatching(/^S1.2 events_window: injected fault: events_window timed out.*the investigation stopped there: the table already answers the question$/)]);
  });
});

describe('claim check on telemetry records (observed regression)', () => {
  const question = 'What was the value of pwr_bus_level_pu in mission run BM-RUN-0010 at exactly 100 seconds?';
  const plan = JSON.stringify({ objective: 'Value of pwr_bus_level_pu at 100 s in BM-RUN-0010', hypotheses: [{ id: 'H1', statement: 'The BM-RUN-0010 window has a pwr_bus_level_pu sample at 100 s' }],
    steps: [{ id: 'S1', title: 'Samples around 100 s', tasks: [{ id: 'S1.1', tool: 'telemetry_window', args: { run_id: 'BM-RUN-0010', channels: ['pwr_bus_level_pu'], start: 100, end: 101 }, purpose: 'samples' }] }] });
  const verified = JSON.stringify({ verdicts: [{ hypothesis: 'H1', status: 'supported', confidence: 'high', evidence_for: ['E1'], note: 'sample at 100 s' }], next: 'report', reason: 'answered' });
  const answer = (value: string, quote: string) => JSON.stringify({ conclusion: `At 100 s in BM-RUN-0010, pwr_bus_level_pu was ${value} pu [E1].`, confidence: 'high', confidence_reason: 'direct sample', evidence: ['E1'],
    claims: [{ id: 'C1', text: `pwr_bus_level_pu = ${value} pu at mission_elapsed_s = 100 in run BM-RUN-0010`, evidence: ['E1'], quote }] });
  const ask = async (reply: string) => {
    const model = new ScriptedModel({ title: ['{"title":"Simple Query"}'], planner: [plan], verifier: [verified], reporter: [reply] });   // checker: supported
    const run = await runner(model).start(chat, user, mission, question);
    expect((await settle(run.id)).status).toBe('complete');
    return (await store.messages.list(chat.id)).find((m) => m.role === 'assistant')!;
  };

  it('verifies the recorded value from the sample itself, whatever the quotation looks like, and keeps high confidence', async () => {
    const msg = await ask(answer('0.866', 'pwr_bus_level_pu: 0.866 (100 s)'));
    const r = msg.report as { confidence: string; claims: { verdict: string; matched: string; support: string }[]; provenance: string[] };
    expect(r.claims[0]).toMatchObject({ verdict: 'supported', matched: 'record', support: expect.stringContaining('mission_elapsed_s = 100; sample_index = 200; delivery_state = DELIVERED; pwr_bus_level_pu = 0.8664') });
    expect(r.confidence).toBe('high');
    expect(r.provenance).toEqual([]);
    expect(msg.text).not.toContain('Citation not matched');
  });

  it('never accepts a wrong value because it cites the right evidence, even when the checker says supported', async () => {
    const msg = await ask(answer('0.856', 'pwr_bus_level_pu: 0.856 (100 s)'));
    const r = msg.report as { confidence: string; claims: { verdict: string; explanation: string; contradicting: { evidence: string; quote: string }[] }[] };
    expect(r.claims[0]).toMatchObject({ verdict: 'contradicted', explanation: expect.stringContaining('at 100 s the record has pwr_bus_level_pu = 0.8664, not 0.856') });
    expect(r.claims[0].contradicting[0]).toMatchObject({ evidence: 'E1', quote: expect.stringContaining('pwr_bus_level_pu = 0.8664') });
    expect(r.confidence).toBe('low');
  });

  it('shows the models the sampled values in the evidence text', async () => {
    const model = new ScriptedModel({ title: ['{"title":"Simple Query"}'], planner: [plan], verifier: [verified], reporter: [answer('0.866', '')] });
    const run = await runner(model).start(chat, user, mission, question);
    await settle(run.id);
    expect(model.calls.find((c) => c.role === 'verifier')!.messages[1].content).toContain('Record: run_id = BM-RUN-0010; mission_elapsed_s = 100; sample_index = 200; delivery_state = DELIVERED; pwr_bus_level_pu = 0.8664');
  });
});
