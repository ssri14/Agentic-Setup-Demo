/**
 * OpenAI-compatible chat completions for three providers (LAN server, OpenRouter, Groq), with
 * per-role model selection and validated JSON output. Prompts and responses are recorded as run blobs.
 */
import type { z } from 'zod';

export type ProviderId = 'lan' | 'openrouter' | 'groq';
export type ModelRole = 'planner' | 'verifier' | 'analyst' | 'reporter' | 'checker';
export const MODEL_ROLES: ModelRole[] = ['planner', 'verifier', 'analyst', 'reporter', 'checker'];

export interface ProviderConfig { id: ProviderId; label: string; baseUrl: string; apiKey?: string; defaultModel: string; hosted: boolean }
export interface RoleSetting { provider: ProviderId; model: string }
export type ModelSettings = Record<ModelRole, RoleSetting>;
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Completion { content: string; provider: ProviderId; model: string; duration_ms: number; usage?: { prompt_tokens?: number; completion_tokens?: number } }

export function providersFromEnv(env = process.env): ProviderConfig[] {
  const list: ProviderConfig[] = [];
  if (env.LLM_BASE_URL) list.push({ id: 'lan', label: 'LAN model server', baseUrl: env.LLM_BASE_URL.replace(/\/$/, ''), apiKey: env.LLM_API_KEY || undefined, defaultModel: env.LLM_MODEL ?? 'openai/gpt-oss-120b', hosted: false });
  if (env.OPENROUTER_API_KEY) list.push({ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY, defaultModel: env.OPENROUTER_MODEL ?? 'openai/gpt-oss-120b', hosted: true });
  if (env.GROQ_API_KEY) list.push({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: env.GROQ_API_KEY, defaultModel: env.GROQ_MODEL ?? 'openai/gpt-oss-120b', hosted: true });
  return list;
}

export function defaultSettings(providers: ProviderConfig[]): ModelSettings | null {
  const first = providers[0];
  if (!first) return null;
  return Object.fromEntries(MODEL_ROLES.map((r) => [r, { provider: first.id, model: first.defaultModel }])) as ModelSettings;
}

export interface ChatModel { complete(role: ModelRole, messages: ChatMessage[], options?: { json?: boolean; maxTokens?: number; signal?: AbortSignal }): Promise<Completion> }

export class OpenAICompatibleModel implements ChatModel {
  private noJsonMode = new Set<string>();
  constructor(private providers: ProviderConfig[], private settings: () => Promise<ModelSettings | null>, private timeoutMs = 180_000) {}

  async complete(role: ModelRole, messages: ChatMessage[], options: { json?: boolean; maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    const settings = await this.settings();
    if (!settings) throw new Error('No language model is configured. Set LLM_BASE_URL, OPENROUTER_API_KEY or GROQ_API_KEY.');
    const choice = settings[role] ?? settings.verifier;     // settings saved before the checker role existed
    const provider = this.providers.find((p) => p.id === choice.provider);
    if (!provider) throw new Error(`Model provider ${choice.provider} for the ${role} is not configured`);
    const key = `${provider.id}:${choice.model}`;
    const body: Record<string, unknown> = { model: choice.model, messages, temperature: 0.2, max_tokens: options.maxTokens ?? 4096 };
    if (options.json && !this.noJsonMode.has(key)) body.response_format = { type: 'json_object' };
    const started = performance.now();
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          ...(provider.id === 'openrouter' ? { 'X-Title': 'Mission Analysis Agent' } : {}) },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const cause = (error as { cause?: { code?: string } }).cause;
      throw new Error(`Cannot reach ${provider.label} (${new URL(provider.baseUrl).host}): ${cause?.code ?? (error as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 400 && body.response_format && /response_format|json/i.test(text)) {
      this.noJsonMode.add(key);              // This model/server does not support JSON mode; prompt-only JSON instead.
      return this.complete(role, messages, options);
    }
    if (!res.ok) throw new Error(`${provider.label} returned ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const content: string = data.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error(`${provider.label} returned an empty response${data.choices?.[0]?.finish_reason ? ` (finish_reason: ${data.choices[0].finish_reason})` : ''}`);
    return { content, provider: provider.id, model: data.model ?? choice.model, duration_ms: Math.round(performance.now() - started), usage: data.usage };
  }
}

/** Extract the JSON object from a model reply that may carry code fences or a preamble. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new SyntaxError('No JSON object found in the reply');
}

export interface JsonCallHooks { onAttempt?(info: { attempt: number; messages: ChatMessage[]; completion?: Completion; error?: string; ok: boolean }): Promise<void> | void }

/** Ask for JSON, validate it, and on failure show the model its error (at most three attempts). */
export async function completeJson<S extends z.ZodType>(model: ChatModel, role: ModelRole, schema: S, messages: ChatMessage[],
  hooks: JsonCallHooks = {}, options: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<{ value: z.output<S>; completion: Completion; attempts: number }> {
  const conversation = [...messages];
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const completion = await model.complete(role, conversation, { json: true, ...options });
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(completion.content));
      if (parsed.success) {
        await hooks.onAttempt?.({ attempt, messages: conversation, completion, ok: true });
        return { value: parsed.data, completion, attempts: attempt };
      }
      problem = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    } catch (error) { problem = `Invalid JSON: ${(error as Error).message}`; }
    lastError = problem;
    await hooks.onAttempt?.({ attempt, messages: conversation, completion, error: problem, ok: false });
    conversation.push({ role: 'assistant', content: completion.content },
      { role: 'user', content: `Your reply did not match the required JSON format: ${problem}\nReturn the complete corrected JSON object only.` });
  }
  throw new Error(`The ${role} model did not return valid JSON after 3 attempts: ${lastError}`);
}
