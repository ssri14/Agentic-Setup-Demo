import { randomUUID } from 'node:crypto';
import type { Artifact, Chat, Message, Mission, MissionCounts, Run, RunEvent, RunStatus, Session, Store, User } from './types.js';

/** In-memory Store with the same semantics as MongoStore, for tests and local previews. */
export class MemoryStore implements Store {
  usersById = new Map<string, User>();
  sessionsByHash = new Map<string, Session>();
  chatsById = new Map<string, Chat>();
  artifactsById = new Map<string, Artifact>();
  messagesById = new Map<string, Message>();
  runsById = new Map<string, Run>();
  eventList: RunEvent[] = [];
  blobsById = new Map<string, { id: string; runId: string; content: string }>();
  settingsByKey = new Map<string, unknown>();
  constructor(public registry: Mission[] = [], public missionCounts: Record<string, MissionCounts> = {}) {}

  async init() {}
  async close() {}

  users = {
    byUsername: async (username: string) => structuredClone([...this.usersById.values()].find((u) => u.username === username) ?? null),
    byId: async (id: string) => structuredClone(this.usersById.get(id) ?? null),
    list: async () => [...this.usersById.values()].sort((a, b) => a.username.localeCompare(b.username)).map((u) => structuredClone(u)),
    insert: async (user: Omit<User, 'id'>) => {
      if ([...this.usersById.values()].some((u) => u.username === user.username)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
      const created = { ...structuredClone(user), id: randomUUID().replaceAll('-', '').slice(0, 24) };
      this.usersById.set(created.id, created);
      return structuredClone(created);
    },
    update: async (id: string, patch: Partial<Omit<User, 'id' | 'username'>>) => {
      const user = this.usersById.get(id);
      if (!user) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (user as unknown as Record<string, unknown>)[k];
        else (user as unknown as Record<string, unknown>)[k] = structuredClone(v);
      }
      return structuredClone(user);
    },
    countActiveSuperusers: async () => [...this.usersById.values()].filter((u) => u.role === 'superuser' && !u.disabled).length,
  };

  sessions = {
    insert: async (s: Session) => { this.sessionsByHash.set(s.tokenHash, structuredClone(s)); },
    byTokenHash: async (h: string) => structuredClone(this.sessionsByHash.get(h) ?? null),
    touch: async (h: string, at: string) => { const s = this.sessionsByHash.get(h); if (s) s.lastSeenAt = at; },
    delete: async (h: string) => { this.sessionsByHash.delete(h); },
    deleteForUser: async (userId: string, except?: string) => {
      for (const [h, s] of this.sessionsByHash) if (s.userId === userId && h !== except) this.sessionsByHash.delete(h);
    },
  };

  chats = {
    list: async (userId: string, mission: string) => [...this.chatsById.values()]
      .filter((c) => c.userId === userId && c.mission === mission)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => structuredClone(c)),
    byId: async (id: string) => structuredClone(this.chatsById.get(id) ?? null),
    insert: async (chat: Omit<Chat, 'id'>) => {
      const created = { ...structuredClone(chat), id: randomUUID().replaceAll('-', '').slice(0, 24) };
      this.chatsById.set(created.id, created);
      return structuredClone(created);
    },
    update: async (id: string, patch: Partial<Pick<Chat, 'title' | 'updatedAt'>>) => {
      const chat = this.chatsById.get(id);
      if (chat) Object.assign(chat, patch);
    },
    delete: async (id: string) => { this.chatsById.delete(id); },
  };

  private newId = () => randomUUID().replaceAll('-', '').slice(0, 24);

  messages = {
    insert: async (m: Omit<Message, 'id'>) => { const c = { ...structuredClone(m), id: this.newId() }; this.messagesById.set(c.id, c); return structuredClone(c); },
    list: async (chatId: string) => [...this.messagesById.values()].filter((m) => m.chatId === chatId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => structuredClone(m)),
  };

  runs = {
    insert: async (r: Omit<Run, 'id'>) => { const c = { ...structuredClone(r), id: this.newId() }; this.runsById.set(c.id, c); return structuredClone(c); },
    byId: async (id: string) => structuredClone(this.runsById.get(id) ?? null),
    update: async (id: string, patch: Partial<Omit<Run, 'id'>>) => { const r = this.runsById.get(id); if (r) Object.assign(r, structuredClone(patch)); },
    listForChat: async (chatId: string) => [...this.runsById.values()].filter((r) => r.chatId === chatId).map((r) => structuredClone(r)),
    markUnfinished: async (status: RunStatus, error: string) => {
      let n = 0;
      for (const r of this.runsById.values()) if (r.status === 'running' || r.status === 'waiting') { Object.assign(r, { status, error }); n++; }
      return n;
    },
  };

  events = {
    insert: async (e: RunEvent) => { this.eventList.push(structuredClone(e)); },
    list: async (runId: string, afterSeq = 0) => this.eventList.filter((e) => e.runId === runId && e.seq > afterSeq).sort((a, b) => a.seq - b.seq).map((e) => structuredClone(e)),
  };

  blobs = {
    insert: async (runId: string, content: string) => { const id = this.newId(); this.blobsById.set(id, { id, runId, content }); return id; },
    byId: async (id: string) => structuredClone(this.blobsById.get(id) ?? null),
  };

  settings = {
    get: async <T>(key: string) => (structuredClone(this.settingsByKey.get(key)) as T) ?? null,
    set: async <T>(key: string, value: T) => { this.settingsByKey.set(key, structuredClone(value)); },
  };

  async deleteChatData(chatId: string) {
    const runIds = new Set([...this.runsById.values()].filter((r) => r.chatId === chatId).map((r) => r.id));
    for (const [id, m] of this.messagesById) if (m.chatId === chatId) this.messagesById.delete(id);
    for (const id of runIds) this.runsById.delete(id);
    this.eventList = this.eventList.filter((e) => !runIds.has(e.runId));
    for (const [id, b] of this.blobsById) if (runIds.has(b.runId)) this.blobsById.delete(id);
  }

  artifacts = {
    insert: async (a: Omit<Artifact, 'id'>) => {
      const created = { ...structuredClone(a), id: randomUUID().replaceAll('-', '').slice(0, 24) };
      this.artifactsById.set(created.id, created);
      return structuredClone(created);
    },
    byId: async (id: string) => structuredClone(this.artifactsById.get(id) ?? null),
  };

  missions = {
    list: async () => structuredClone(this.registry),
    counts: async (m: Mission) => this.missionCounts[m.id] ?? { documents: 0, telemetryRuns: 0 },
  };
}
