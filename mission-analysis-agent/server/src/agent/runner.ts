/** Starts, resumes and stops agent runs; one LangGraph thread per run, kept in memory while it is active. */
import type { Chat, Mission, Run, Store, User } from '../store/types.js';
import type { Sources } from '../tools/sources.js';
import { trim } from '../tools/util.js';
import { EventSink } from './events.js';
import { Command, DEFAULT_BUDGETS, StoppedError, buildAgent, type AgentContext, type Budgets, type Faults } from './graph.js';

export const FAULTS_KEY = 'fault_injection';
export interface FaultSettings extends Faults { enabled: boolean }
import { completeJson, type ChatModel, type ModelSettings } from './llm.js';
import { z } from 'zod';

interface Active { ctx: AgentContext; graph: ReturnType<typeof buildAgent>; abort: AbortController; busy: boolean }

export class AgentRunner {
  private active = new Map<string, Active>();
  constructor(private store: Store, private sources: Sources, private model: ChatModel,
    private settings: () => Promise<ModelSettings | null>, private budgets: Budgets = DEFAULT_BUDGETS) {}

  isActive(runId: string) { return this.active.has(runId); }

  private async history(chatId: string): Promise<string> {
    const messages = await this.store.messages.list(chatId);
    const turns: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') {
        const answer = messages.slice(i + 1).find((x) => x.role === 'assistant' && x.runId === m.runId);
        turns.push(`Q: ${trim(m.text, 300)}\nA: ${answer ? trim(answer.text, 700) : '(no answer)'}`);
      }
    }
    return turns.slice(-3).join('\n\n');
  }

  async start(chat: Chat, user: User, mission: Mission, question: string): Promise<Run> {
    if ((await this.store.runs.listForChat(chat.id)).some((r) => r.status === 'running' || r.status === 'waiting')) {
      throw Object.assign(new Error('This chat already has a question in progress'), { statusCode: 409 });
    }
    const history = await this.history(chat.id);
    const settings = await this.settings();
    const now = new Date().toISOString();
    const run = await this.store.runs.insert({ chatId: chat.id, userId: user.id, mission: mission.id, question, status: 'running', createdAt: now,
      models: settings ? Object.fromEntries(Object.entries(settings).map(([role, s]) => [role, `${s.provider}:${s.model}`])) : {} });
    await this.store.messages.insert({ chatId: chat.id, role: 'user', text: question, runId: run.id, createdAt: now });
    if ((await this.store.messages.list(chat.id)).filter((m) => m.role === 'user').length === 1) {
      await this.store.chats.update(chat.id, { title: trim(question.replace(/\s+/g, ' '), 70), updatedAt: now });
      void this.nameChat(chat.id, question);
    } else {
      await this.store.chats.update(chat.id, { updatedAt: now });
    }
    const abort = new AbortController();
    const faults = await this.store.settings.get<FaultSettings>(FAULTS_KEY);
    const sink = new EventSink(this.store, run.id);
    const ctx: AgentContext = { store: this.store, sources: this.sources, model: this.model, sink, mission, user, budgets: this.budgets,
      startedAt: Date.now(), signal: abort.signal, runId: run.id, chatId: chat.id,
      faults: faults?.enabled ? { tool: faults.tool, toolFailures: faults.toolFailures, plannerFailures: faults.plannerFailures } : undefined,
      onFinished: async (status, view, totals) => { await this.store.runs.update(run.id, { status, view, totals, finishedAt: new Date().toISOString() }); } };
    const graph = buildAgent(ctx);
    this.active.set(run.id, { ctx, graph, abort, busy: false });
    await sink.emit('start', 'run_started', trim(question, 200), { question, mission: mission.id, models: run.models, budgets: this.budgets, history: Boolean(history), faults: ctx.faults ?? null });
    void this.drive(run.id, { question, history });
    return run;
  }

  /** A short model-written title for the chat list; the truncated question stays if this fails. */
  private async nameChat(chatId: string, question: string) {
    try {
      const { value } = await completeJson(this.model, 'reporter', z.object({ title: z.string().trim().min(3).max(60) }), [
        { role: 'system', content: 'Write a short title (3 to 7 words) for a chat that starts with the question below. Name the subject and any run, subsystem or channel it is about. No quotes, no trailing period. Return JSON only: {"title": str}' },
        { role: 'user', content: question },
      ], {}, { maxTokens: 400 });
      const title = value.title.replace(/^["'“”]+|["'“”.]+$/g, '').trim();
      if (title.length >= 3) await this.store.chats.update(chatId, { title });
    } catch { /* keep the truncated question */ }
  }

  async answer(runId: string, answer: string) {
    const a = this.active.get(runId);
    const run = await this.store.runs.byId(runId);
    if (!a || run?.status !== 'waiting') throw Object.assign(new Error('This run is not waiting for an answer'), { statusCode: 409 });
    await this.store.runs.update(runId, { status: 'running' });
    void this.drive(runId, new Command({ resume: answer }));
  }

  async stop(runId: string) {
    const a = this.active.get(runId);
    if (!a) return false;
    a.abort.abort();
    if (!a.busy) await this.finish(runId, 'stopped', 'Stopped by the user');
    return true;
  }

  private async drive(runId: string, input: unknown) {
    const a = this.active.get(runId)!;
    a.busy = true;
    const config = { configurable: { thread_id: runId }, recursionLimit: 120 };
    try {
      await a.graph.invoke(input as never, config);
      const state = await a.graph.getState(config);
      if (state.next.length) {                       // interrupted: waiting for the user's clarification
        await this.store.runs.update(runId, { status: 'waiting' });
        a.busy = false;
        return;
      }
      this.active.delete(runId);
    } catch (error) {
      const stopped = error instanceof StoppedError || a.abort.signal.aborted;
      await this.finish(runId, stopped ? 'stopped' : 'failed', stopped ? 'Stopped by the user' : (error as Error).message);
    } finally { a.busy = false; }
  }

  private async finish(runId: string, status: 'stopped' | 'failed', message: string) {
    const a = this.active.get(runId);
    this.active.delete(runId);
    const run = await this.store.runs.byId(runId);
    if (!run || ['complete', 'failed', 'stopped'].includes(run.status)) return;
    await this.store.runs.update(runId, { status, error: message, finishedAt: new Date().toISOString() });
    await this.store.messages.insert({ chatId: run.chatId, role: 'assistant', text: status === 'stopped' ? 'Stopped before an answer was reached.' : `The investigation failed: ${message}`,
      runId, report: null, createdAt: new Date().toISOString() });
    await a?.ctx.sink.emit('end', 'run_finished', status === 'stopped' ? 'Stopped by the user' : `Failed: ${trim(message, 200)}`, { status, error: message });
  }
}
