import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Mission, Store, User } from './store/types.js';
import type { Sources } from './tools/sources.js';
import { TOOLS, ToolError, describeTools, runTool } from './tools/registry.js';
import { FAULTS_KEY, type AgentRunner, type FaultSettings } from './agent/runner.js';
import { subscribe } from './agent/events.js';
import { MODEL_ROLES, defaultSettings, type ModelSettings, type ProviderConfig } from './agent/llm.js';
import type { RunEvent } from './store/types.js';

export interface AgentServices { runner: AgentRunner; providers: ProviderConfig[] }
export const MODEL_SETTINGS_KEY = 'model_settings';
export async function currentModelSettings(store: Store, providers: ProviderConfig[]): Promise<ModelSettings | null> {
  const saved = await store.settings.get<ModelSettings>(MODEL_SETTINGS_KEY);
  const fallback = defaultSettings(providers);
  if (!saved || !fallback) return fallback;
  // Drop roles whose provider is no longer configured.
  // The checker defaults to the verifier's choice in settings saved before it existed.
  const pick = (r: keyof ModelSettings) => saved[r] ?? (r === 'checker' ? saved.verifier : undefined);
  return Object.fromEntries(MODEL_ROLES.map((r) => { const s = pick(r); return [r, s && providers.some((p) => p.id === s.provider) ? s : fallback[r]]; })) as ModelSettings;
}
import {
  LOCK_DURATION_MS, LOCK_THRESHOLD, LOCK_WINDOW_MS, SESSION_COOKIE, dummyPasswordHash, hashPassword,
  newToken, passwordProblem, tokenHash, verifyPassword,
} from './auth.js';

declare module 'fastify' {
  interface FastifyRequest { user?: User; sessionHash?: string; csrfToken?: string }
}

const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/;
const now = () => new Date().toISOString();

export const publicUser = (u: User) => ({
  id: u.id, username: u.username, displayName: u.displayName, role: u.role, missions: u.missions,
  disabled: u.disabled, mustChangePassword: u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null,
  locked: Boolean(u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()),
});

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return (result as { data: T }).data;
}

/** Ensures the superuser named in the environment exists. Never changes an existing account. */
export async function bootstrapSuperuser(store: Store, config: Config, log: (msg: string) => void) {
  if (!config.adminUser || !config.adminPassword) {
    if ((await store.users.countActiveSuperusers()) === 0) log('No superuser exists and AGENT_ADMIN_USER/AGENT_ADMIN_PASSWORD are not set.');
    return;
  }
  const username = config.adminUser.toLowerCase();
  if (await store.users.byUsername(username)) return;
  if (!USERNAME.test(username)) throw new Error('AGENT_ADMIN_USER must be 3-32 characters: a-z first, then a-z 0-9 . _ -');
  await store.users.insert({
    username, displayName: 'Administrator', role: 'superuser', missions: [], disabled: false,
    mustChangePassword: true, passwordHash: await hashPassword(config.adminPassword), failedLogins: [], createdAt: now(),
  });
  log(`Created superuser ${username}; the password must be changed at first login.`);
}

export async function buildApp(store: Store, config: Config, sources?: Sources, agent?: AgentServices): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' }, trustProxy: false, bodyLimit: 1_000_000 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.status(500).send({ error: 'Internal error' });
  });

  const idleMs = config.sessionIdleMinutes * 60_000;

  // Resolve the session cookie on every API request; CSRF header required for state-changing calls.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const hashValue = tokenHash(token);
      const session = await store.sessions.byTokenHash(hashValue);
      if (session && Date.now() - Date.parse(session.lastSeenAt) < idleMs) {
        const user = await store.users.byId(session.userId);
        if (user && !user.disabled) {
          req.user = user;
          req.sessionHash = hashValue;
          req.csrfToken = session.csrfToken;
          if (Date.now() - Date.parse(session.lastSeenAt) > 60_000) await store.sessions.touch(hashValue, now());
        }
      } else if (session) {
        await store.sessions.delete(hashValue);
      }
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe && req.user && req.url !== '/api/auth/login' && req.headers['x-csrf-token'] !== req.csrfToken) {
      fail(403, 'Missing or invalid CSRF token');
    }
  });

  const requireUser = (req: FastifyRequest, allowPasswordChange = false): User => {
    if (!req.user) fail(401, 'Sign in required');
    if (req.user!.mustChangePassword && !allowPasswordChange) fail(403, 'Password change required');
    return req.user!;
  };
  const requireSuperuser = (req: FastifyRequest): User => {
    const user = requireUser(req);
    if (user.role !== 'superuser') fail(403, 'Superuser only');
    return user;
  };
  const visibleMissions = async (user: User): Promise<Mission[]> => {
    const all = await store.missions.list();
    return user.role === 'superuser' ? all : all.filter((m) => user.missions.includes(m.id));
  };
  const requireMission = async (user: User, missionId: string): Promise<Mission> => {
    const mission = (await visibleMissions(user)).find((m) => m.id === missionId);
    if (!mission) fail(404, 'Mission not found or not granted');
    return mission!;
  };
  const setSessionCookie = (reply: FastifyReply, token: string) => reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/', maxAge: Math.floor(idleMs / 1000),
  });

  // ---- Auth ----
  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
    const user = await store.users.byUsername(body.username.trim().toLowerCase());
    const generic = () => fail(401, 'Incorrect username or password');
    if (!user) { await verifyPassword(await dummyPasswordHash(), body.password); return generic(); }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) fail(423, 'Too many failed attempts. Try again in a few minutes.');
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      const recent = [...user.failedLogins, now()].filter((t) => Date.now() - Date.parse(t) < LOCK_WINDOW_MS);
      const locked = recent.length >= LOCK_THRESHOLD;
      await store.users.update(user.id, { failedLogins: locked ? [] : recent, lockedUntil: locked ? new Date(Date.now() + LOCK_DURATION_MS).toISOString() : user.lockedUntil });
      return generic();
    }
    if (user.disabled) fail(403, 'This account is disabled');
    await store.users.update(user.id, { failedLogins: [], lockedUntil: undefined, lastLoginAt: now() });
    const token = newToken();
    const csrfToken = newToken();
    await store.sessions.insert({ tokenHash: tokenHash(token), userId: user.id, csrfToken, createdAt: now(), lastSeenAt: now() });
    setSessionCookie(reply, token);
    return { user: publicUser({ ...user, lastLoginAt: now() }), csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionHash) await store.sessions.delete(req.sessionHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const user = requireUser(req, true);
    return { user: publicUser(user), csrfToken: req.csrfToken };
  });

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req, true);
    const body = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
    if (!(await verifyPassword(user.passwordHash, body.current))) fail(400, 'Current password is incorrect');
    const problem = passwordProblem(body.next, user.username);
    if (problem) fail(400, problem);
    if (body.next === body.current) fail(400, 'Choose a password different from the current one');
    await store.users.update(user.id, { passwordHash: await hashPassword(body.next), mustChangePassword: false });
    await store.sessions.deleteForUser(user.id, req.sessionHash);  // sign out other devices
    return { ok: true };
  });

  // ---- Missions and chats (the agent itself arrives in a later phase) ----
  app.get('/api/missions', async (req) => {
    const user = requireUser(req);
    return (await visibleMissions(user)).map(({ id, name, description, telemetrySchema }) => ({ id, name, description, hasTelemetry: Boolean(telemetrySchema) }));
  });

  app.get<{ Params: { mission: string } }>('/api/missions/:mission/chats', async (req) => {
    const user = requireUser(req);
    await requireMission(user, req.params.mission);
    return store.chats.list(user.id, req.params.mission);
  });

  app.post<{ Params: { mission: string } }>('/api/missions/:mission/chats', async (req, reply) => {
    const user = requireUser(req);
    await requireMission(user, req.params.mission);
    const body = parse(z.object({ title: z.string().trim().min(1).max(120).optional() }), req.body ?? {});
    const chat = await store.chats.insert({ userId: user.id, mission: req.params.mission, title: body.title ?? 'New chat', createdAt: now(), updatedAt: now() });
    return reply.status(201).send(chat);
  });

  const ownChat = async (user: User, id: string) => {
    const chat = await store.chats.byId(id);
    if (!chat || chat.userId !== user.id) fail(404, 'Chat not found');
    await requireMission(user, chat!.mission);
    return chat!;
  };

  app.patch<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    const user = requireUser(req);
    const chat = await ownChat(user, req.params.id);
    const body = parse(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    await store.chats.update(chat.id, { title: body.title, updatedAt: now() });
    return { ...chat, title: body.title };
  });

  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    const user = requireUser(req);
    const chat = await ownChat(user, req.params.id);
    await store.deleteChatData(chat.id);
    await store.chats.delete(chat.id);
    return { ok: true };
  });

  // ---- Administration (superuser only) ----
  const missionIds = async (ids: string[]) => {
    const known = new Set((await store.missions.list()).map((m) => m.id));
    const unknown = ids.filter((m) => !known.has(m));
    if (unknown.length) fail(400, `Unknown missions: ${unknown.join(', ')}`);
    return [...new Set(ids)];
  };

  app.get('/api/admin/users', async (req) => {
    requireSuperuser(req);
    return (await store.users.list()).map(publicUser);
  });

  app.post('/api/admin/users', async (req, reply) => {
    requireSuperuser(req);
    const body = parse(z.object({
      username: z.string().trim().toLowerCase().regex(USERNAME, 'username must be 3-32 characters: a-z first, then a-z 0-9 . _ -'),
      displayName: z.string().trim().min(1).max(80),
      password: z.string(),
      role: z.enum(['superuser', 'user']).default('user'),
      missions: z.array(z.string()).max(100).default([]),
    }), req.body);
    const problem = passwordProblem(body.password, body.username);
    if (problem) fail(400, problem);
    if (await store.users.byUsername(body.username)) fail(409, `User ${body.username} already exists`);
    const user = await store.users.insert({
      username: body.username, displayName: body.displayName, role: body.role, missions: await missionIds(body.missions),
      disabled: false, mustChangePassword: true, passwordHash: await hashPassword(body.password), failedLogins: [], createdAt: now(),
    });
    return reply.status(201).send(publicUser(user));
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const admin = requireSuperuser(req);
    const body = parse(z.object({
      displayName: z.string().trim().min(1).max(80).optional(),
      role: z.enum(['superuser', 'user']).optional(),
      missions: z.array(z.string()).max(100).optional(),
      disabled: z.boolean().optional(),
      unlock: z.boolean().optional(),
    }), req.body);
    const target = await store.users.byId(req.params.id);
    if (!target) fail(404, 'User not found');
    const removesSuperuser = target!.role === 'superuser' && !target!.disabled && (body.role === 'user' || body.disabled === true);
    if (target!.id === admin.id && (body.role === 'user' || body.disabled === true)) fail(400, 'You cannot demote or disable your own account');
    if (removesSuperuser && (await store.users.countActiveSuperusers()) <= 1) fail(400, 'At least one active superuser must remain');
    const updated = await store.users.update(target!.id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.missions !== undefined ? { missions: await missionIds(body.missions) } : {}),
      ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      ...(body.unlock ? { lockedUntil: undefined, failedLogins: [] } : {}),
    });
    if (body.disabled) await store.sessions.deleteForUser(target!.id);
    return publicUser(updated!);
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/password', async (req) => {
    requireSuperuser(req);
    const body = parse(z.object({ password: z.string() }), req.body);
    const target = await store.users.byId(req.params.id);
    if (!target) fail(404, 'User not found');
    const problem = passwordProblem(body.password, target!.username);
    if (problem) fail(400, problem);
    await store.users.update(target!.id, { passwordHash: await hashPassword(body.password), mustChangePassword: true, lockedUntil: undefined, failedLogins: [] });
    await store.sessions.deleteForUser(target!.id);
    return { ok: true };
  });

  app.get('/api/admin/missions', async (req) => {
    requireSuperuser(req);
    const [missions, users] = await Promise.all([store.missions.list(), store.users.list()]);
    return Promise.all(missions.map(async (m) => {
      const counts = await store.missions.counts(m).catch(() => ({ documents: null, telemetryRuns: null }));
      return { id: m.id, name: m.name, description: m.description, mongoDatabase: m.mongoDatabase, hasTelemetry: Boolean(m.telemetrySchema),
        ...counts, users: users.filter((u) => u.role === 'superuser' || u.missions.includes(m.id)).length };
    }));
  });

  // ---- Mission tools (superuser test bench now; the agent calls the same registry later) ----
  app.get('/api/tools', async (req) => {
    requireSuperuser(req);
    return describeTools();
  });

  app.post<{ Params: { name: string } }>('/api/tools/:name/run', async (req) => {
    const user = requireSuperuser(req);
    if (!sources) fail(503, 'Mission data sources are not configured');
    const body = parse(z.object({ mission: z.string().min(1).max(40), args: z.record(z.string(), z.unknown()).default({}) }), req.body);
    const mission = await requireMission(user, body.mission);
    try {
      const { records: _records, ...result } = await runTool(req.params.name, body.args, { mission, user, store, sources: sources! });   // records are for claim checks only
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, error: error.message };
      const message = (error as Error).message ?? String(error);
      app.log.warn({ tool: req.params.name, error: message }, 'tool failed');
      return { ok: false, error: `${req.params.name} failed: ${message}` };
    }
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const user = requireUser(req);
    const artifact = await store.artifacts.byId(req.params.id);
    if (!artifact || artifact.userId !== user.id) fail(404, 'Artifact not found');
    await requireMission(user, artifact!.mission);
    if (artifact!.kind === 'png') return reply.type('image/png').send(Buffer.from(artifact!.content, 'base64'));
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${artifact!.name}.csv"`).send(artifact!.content);
  });

  // ---- Conversations with the agent ----
  const ownRun = async (user: User, id: string) => {
    const run = await store.runs.byId(id);
    if (!run || run.userId !== user.id) fail(404, 'Run not found');
    await requireMission(user, run!.mission);
    return run!;
  };

  app.get<{ Params: { id: string } }>('/api/chats/:id/messages', async (req) => {
    const user = requireUser(req);
    const chat = await ownChat(user, req.params.id);
    const [messages, runs] = await Promise.all([store.messages.list(chat.id), store.runs.listForChat(chat.id)]);
    return { chat, messages, runs: runs.map(({ id, status, question, createdAt, finishedAt, error, view, totals, models }) => ({ id, status, question, createdAt, finishedAt, error, view, totals, models })) };
  });

  app.post<{ Params: { id: string } }>('/api/chats/:id/messages', async (req, reply) => {
    const user = requireUser(req);
    if (!agent) fail(503, 'The agent is not configured on this server');
    const chat = await ownChat(user, req.params.id);
    const body = parse(z.object({ text: z.string().trim().min(3, 'Ask a question of at least 3 characters').max(2000) }), req.body);
    const mission = await requireMission(user, chat.mission);
    const run = await agent!.runner.start(chat, user, mission, body.text);
    return reply.status(202).send({ run: { id: run.id, status: run.status } });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', async (req) => {
    const user = requireUser(req);
    const run = await ownRun(user, req.params.id);
    return { run: { id: run.id, status: run.status, question: run.question, createdAt: run.createdAt, finishedAt: run.finishedAt, totals: run.totals, models: run.models },
      events: await store.events.list(run.id, Number(req.query.after ?? 0)) };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/stream', async (req, reply) => {
    const user = requireUser(req);
    const run = await ownRun(user, req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let lastSeq = Number(req.query.after ?? req.headers['last-event-id'] ?? 0) || 0;
    let closed = false, backfilled = false;
    const queued: RunEvent[] = [];
    const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); res.end(); };
    const send = (e: RunEvent) => {
      if (closed || e.seq <= lastSeq) return;
      lastSeq = e.seq;
      res.write(`id: ${e.seq}\nevent: run\ndata: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'run_finished') { res.write('event: end\ndata: {}\n\n'); close(); }
    };
    const unsubscribe = subscribe(run.id, (e) => (backfilled ? send(e) : queued.push(e)));
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.raw.on('close', close);
    for (const e of await store.events.list(run.id, lastSeq)) send(e);
    backfilled = true;
    for (const e of queued.sort((a, b) => a.seq - b.seq)) send(e);
    const fresh = await store.runs.byId(run.id);
    if (!closed && fresh && !['running', 'waiting'].includes(fresh.status)) { res.write('event: end\ndata: {}\n\n'); close(); }
  });

  app.get<{ Params: { id: string; blob: string } }>('/api/runs/:id/blobs/:blob', async (req, reply) => {
    const user = requireUser(req);
    const run = await ownRun(user, req.params.id);
    const blob = await store.blobs.byId(req.params.blob);
    if (!blob || blob.runId !== run.id) fail(404, 'Not found');
    return reply.type('text/plain; charset=utf-8').send(blob!.content);
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/answer', async (req) => {
    const user = requireUser(req);
    if (!agent) fail(503, 'The agent is not configured on this server');
    const run = await ownRun(user, req.params.id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
    await store.messages.insert({ chatId: run.chatId, role: 'user', text: body.text, runId: run.id, createdAt: new Date().toISOString() });
    await agent!.runner.answer(run.id, body.text);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req) => {
    const user = requireUser(req);
    if (!agent) fail(503, 'The agent is not configured on this server');
    const run = await ownRun(user, req.params.id);
    return { stopped: await agent!.runner.stop(run.id) };
  });

  // ---- Model settings (superuser) ----
  app.get('/api/settings/models', async (req) => {
    requireSuperuser(req);
    const providers = agent?.providers ?? [];
    return { roles: MODEL_ROLES, providers: providers.map(({ id, label, defaultModel, hosted }) => ({ id, label, defaultModel, hosted })),
      settings: await currentModelSettings(store, providers) };
  });

  app.put('/api/settings/models', async (req) => {
    requireSuperuser(req);
    const providers = agent?.providers ?? [];
    const role = z.object({ provider: z.enum(['lan', 'openrouter', 'groq']), model: z.string().trim().min(2).max(120) });
    const body = parse(z.object(Object.fromEntries(MODEL_ROLES.map((r) => [r, role])) as Record<string, typeof role>), req.body) as ModelSettings;
    for (const r of MODEL_ROLES) if (!providers.some((p) => p.id === body[r].provider)) fail(400, `Provider ${body[r].provider} is not configured on the server`);
    await store.settings.set(MODEL_SETTINGS_KEY, body);
    return { settings: body };
  });

  // Fault injection: simulated failures for demonstrating the recovery suite (applies to each new run while enabled).
  app.get('/api/settings/faults', async (req) => {
    requireSuperuser(req);
    return { tools: TOOLS.map((t) => t.name), settings: (await store.settings.get<FaultSettings>(FAULTS_KEY)) ?? { enabled: false, tool: null, toolFailures: 1, plannerFailures: 0 } };
  });
  app.put('/api/settings/faults', async (req) => {
    requireSuperuser(req);
    const body = parse(z.object({ enabled: z.boolean(), tool: z.enum(TOOLS.map((t) => t.name) as [string, ...string[]]).nullable(),
      toolFailures: z.number().int().min(0).max(5), plannerFailures: z.number().int().min(0).max(3) }), req.body) as FaultSettings;
    await store.settings.set(FAULTS_KEY, body);
    return { settings: body };
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ---- Built web client ----
  if (existsSync(config.clientDir)) {
    await app.register(fastifyStatic, { root: config.clientDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
