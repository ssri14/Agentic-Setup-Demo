import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, bootstrapSuperuser } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { MemoryStore } from '../server/src/store/memory.js';

const missions = [
  { id: 'brahmastra', name: 'Brahmastra', description: 'First mission', mongoDatabase: 'brahmastra', influxDatabase: 'brahmastra', qdrantCollection: 'document_chunks', telemetrySchema: 'brahmastra-rc1' },
  { id: 'trishul', name: 'Trishul', description: 'Second mission', mongoDatabase: 'mission_trishul', influxDatabase: 'mission_trishul', qdrantCollection: 'trishul_chunks', telemetrySchema: null },
];
const ADMIN_PW = 'initial-admin-pass-1';
const NEW_ADMIN_PW = 'changed-super-pass-2';

let store: MemoryStore;
let app: FastifyInstance;

interface Session { cookie: string; csrf: string }

async function login(username: string, password: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  return { cookie, csrf: res.json().csrfToken };
}
const call = (s: Session | null, method: string, url: string, payload?: unknown, csrf = true) =>
  app.inject({ method: method as 'GET', url, payload: payload as object,
    headers: { ...(s ? { cookie: s.cookie } : {}), ...(s && csrf ? { 'x-csrf-token': s.csrf } : {}) } });

async function readyAdmin(): Promise<Session> {
  const first = await login('admin', ADMIN_PW);
  expect((await call(first, 'POST', '/api/auth/password', { current: ADMIN_PW, next: NEW_ADMIN_PW })).statusCode).toBe(200);
  return login('admin', NEW_ADMIN_PW);
}

async function createUser(admin: Session, username: string, grants: string[], password = 'first-login-pass-123') {
  const res = await call(admin, 'POST', '/api/admin/users', { username, displayName: username.toUpperCase(), password, missions: grants });
  expect(res.statusCode, res.body).toBe(201);
  const userPw = 'my-own-secret-pass-9';
  const s = await login(username, password);
  expect((await call(s, 'POST', '/api/auth/password', { current: password, next: userPw })).statusCode).toBe(200);
  return { session: await login(username, userPw), id: res.json().id as string, password: userPw };
}

beforeEach(async () => {
  store = new MemoryStore(missions, { brahmastra: { documents: 1, telemetryRuns: 24 } });
  const config = { ...loadConfig({}), adminUser: 'admin', adminPassword: ADMIN_PW, clientDir: '/nonexistent' };
  app = await buildApp(store, config);
  await bootstrapSuperuser(store, config, () => {});
});

describe('bootstrap and passwords', () => {
  it('creates the superuser once, and requires a password change before anything else', async () => {
    await bootstrapSuperuser(store, { ...loadConfig({}), adminUser: 'admin', adminPassword: 'other-password-xyz' }, () => {});
    expect((await store.users.list()).length).toBe(1);
    const s = await login('admin', ADMIN_PW);
    const me = await call(s, 'GET', '/api/me');
    expect(me.json().user.mustChangePassword).toBe(true);
    expect((await call(s, 'GET', '/api/missions')).statusCode).toBe(403);
    expect((await call(s, 'POST', '/api/auth/password', { current: ADMIN_PW, next: 'short' })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/auth/password', { current: 'wrong', next: NEW_ADMIN_PW })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/auth/password', { current: ADMIN_PW, next: NEW_ADMIN_PW })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/missions')).json().map((m: { id: string }) => m.id)).toEqual(['brahmastra', 'trishul']);
  });

  it('stores only an argon2id hash', async () => {
    const [admin] = await store.users.list();
    expect(admin.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(admin)).not.toContain(ADMIN_PW);
  });
});

describe('sessions and CSRF', () => {
  it('rejects unauthenticated calls and state changes without the CSRF header', async () => {
    expect((await call(null, 'GET', '/api/me')).statusCode).toBe(401);
    const admin = await readyAdmin();
    expect((await call(admin, 'POST', '/api/missions/brahmastra/chats', {}, false)).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/missions/brahmastra/chats', {})).statusCode).toBe(201);
  });

  it('logs out and expires idle sessions', async () => {
    const admin = await readyAdmin();
    expect((await call(admin, 'POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/me')).statusCode).toBe(401);
    const again = await login('admin', NEW_ADMIN_PW);
    for (const s of store.sessionsByHash.values()) s.lastSeenAt = new Date(Date.now() - 9 * 3600_000).toISOString();
    expect((await call(again, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('locks an account after five failures and lets the superuser unlock it', async () => {
    const admin = await readyAdmin();
    const { id, password } = await createUser(admin, 'analyst', ['brahmastra']);
    for (let i = 0; i < 5; i++) {
      expect((await call(null, 'POST', '/api/auth/login', { username: 'analyst', password: 'wrong-password' })).statusCode).toBe(401);
    }
    expect((await call(null, 'POST', '/api/auth/login', { username: 'analyst', password })).statusCode).toBe(423);
    expect((await call(admin, 'PATCH', `/api/admin/users/${id}`, { unlock: true })).statusCode).toBe(200);
    await login('analyst', password);
  });

  it('gives the same answer for unknown users and wrong passwords', async () => {
    const a = await call(null, 'POST', '/api/auth/login', { username: 'nobody', password: 'whatever-123' });
    const b = await call(null, 'POST', '/api/auth/login', { username: 'admin', password: 'whatever-123' });
    expect([a.statusCode, a.json()]).toEqual([b.statusCode, b.json()]);
  });
});

describe('mission grants', () => {
  it('shows a user only granted missions and their own chats', async () => {
    const admin = await readyAdmin();
    const { session: analyst } = await createUser(admin, 'analyst', ['brahmastra']);
    const { session: other } = await createUser(admin, 'other', ['brahmastra', 'trishul']);
    expect((await call(analyst, 'GET', '/api/missions')).json().map((m: { id: string }) => m.id)).toEqual(['brahmastra']);
    expect((await call(analyst, 'GET', '/api/missions/trishul/chats')).statusCode).toBe(404);
    expect((await call(analyst, 'POST', '/api/missions/trishul/chats', {})).statusCode).toBe(404);
    const chat = (await call(analyst, 'POST', '/api/missions/brahmastra/chats', { title: 'Dropout runs' })).json();
    expect((await call(other, 'GET', '/api/missions/brahmastra/chats')).json()).toEqual([]);
    expect((await call(other, 'PATCH', `/api/chats/${chat.id}`, { title: 'mine now' })).statusCode).toBe(404);
    expect((await call(other, 'DELETE', `/api/chats/${chat.id}`)).statusCode).toBe(404);
    expect((await call(analyst, 'PATCH', `/api/chats/${chat.id}`, { title: 'Renamed' })).json().title).toBe('Renamed');
    expect((await call(analyst, 'GET', '/api/missions/brahmastra/chats')).json().map((c: { title: string }) => c.title)).toEqual(['Renamed']);
  });

  it('hides a revoked mission and its chats without deleting them', async () => {
    const admin = await readyAdmin();
    const { session: analyst, id } = await createUser(admin, 'analyst', ['brahmastra']);
    await call(analyst, 'POST', '/api/missions/brahmastra/chats', {});
    await call(admin, 'PATCH', `/api/admin/users/${id}`, { missions: [] });
    expect((await call(analyst, 'GET', '/api/missions')).json()).toEqual([]);
    expect((await call(analyst, 'GET', '/api/missions/brahmastra/chats')).statusCode).toBe(404);
    expect(store.chatsById.size).toBe(1);
  });
});

describe('administration', () => {
  it('is closed to ordinary users', async () => {
    const admin = await readyAdmin();
    const { session: analyst } = await createUser(admin, 'analyst', ['brahmastra']);
    for (const [method, url] of [['GET', '/api/admin/users'], ['GET', '/api/admin/missions'], ['POST', '/api/admin/users']]) {
      expect((await call(analyst, method, url, { username: 'x' })).statusCode).toBe(403);
    }
  });

  it('validates new users and grants', async () => {
    const admin = await readyAdmin();
    const bad = [
      { username: 'Bad Name', displayName: 'x', password: 'long-enough-pass' },
      { username: 'valid', displayName: 'x', password: 'short' },
      { username: 'valid', displayName: 'x', password: 'contains-valid-name' },
      { username: 'valid', displayName: 'x', password: 'long-enough-pass', missions: ['unknown'] },
    ];
    for (const payload of bad) expect((await call(admin, 'POST', '/api/admin/users', payload)).statusCode).toBe(400);
    await createUser(admin, 'analyst', ['brahmastra']);
    expect((await call(admin, 'POST', '/api/admin/users', { username: 'analyst', displayName: 'x', password: 'long-enough-pass' })).statusCode).toBe(409);
  });

  it('keeps at least one superuser and disables accounts immediately', async () => {
    const admin = await readyAdmin();
    const adminId = (await call(admin, 'GET', '/api/me')).json().user.id;
    expect((await call(admin, 'PATCH', `/api/admin/users/${adminId}`, { disabled: true })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/admin/users/${adminId}`, { role: 'user' })).statusCode).toBe(400);
    const { session: analyst, id } = await createUser(admin, 'analyst', ['brahmastra']);
    expect((await call(admin, 'PATCH', `/api/admin/users/${id}`, { disabled: true })).statusCode).toBe(200);
    expect((await call(analyst, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'analyst', password: 'my-own-secret-pass-9' })).statusCode).toBe(403);
  });

  it('resets a password, forcing a change and signing the user out', async () => {
    const admin = await readyAdmin();
    const { session: analyst, id } = await createUser(admin, 'analyst', ['brahmastra']);
    expect((await call(admin, 'POST', `/api/admin/users/${id}/password`, { password: 'temporary-pass-77' })).statusCode).toBe(200);
    expect((await call(analyst, 'GET', '/api/me')).statusCode).toBe(401);
    const s = await login('analyst', 'temporary-pass-77');
    expect((await call(s, 'GET', '/api/me')).json().user.mustChangePassword).toBe(true);
  });

  it('lists missions with counts and the number of users who can see them', async () => {
    const admin = await readyAdmin();
    await createUser(admin, 'analyst', ['brahmastra']);
    const rows = (await call(admin, 'GET', '/api/admin/missions')).json();
    expect(rows.find((r: { id: string }) => r.id === 'brahmastra')).toMatchObject({ documents: 1, telemetryRuns: 24, users: 2 });
    expect(rows.find((r: { id: string }) => r.id === 'trishul')).toMatchObject({ users: 1 });
  });
});
