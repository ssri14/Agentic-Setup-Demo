/** Persistence interface. MongoStore is used at runtime; MemoryStore backs the tests. */
export type Role = 'superuser' | 'user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  missions: string[];
  disabled: boolean;
  mustChangePassword: boolean;
  passwordHash: string;
  failedLogins: string[];      // ISO timestamps of recent failures
  lockedUntil?: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface Session {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Chat {
  id: string;
  userId: string;
  mission: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Mission {
  id: string;
  name: string;
  description: string;
  mongoDatabase: string;
  influxDatabase: string;
  qdrantCollection: string;
  telemetrySchema: string | null;
}

export interface MissionCounts {
  documents: number;
  telemetryRuns: number;
}

/** A tool output kept for later steps: CSV tables feed run_analysis; charts are shown to the user. */
export interface Artifact {
  id: string;
  userId: string;
  mission: string;
  name: string;
  kind: 'csv' | 'png';
  content: string;            // CSV text, or base64 PNG
  rows?: number;
  columns?: string[];
  tool: string;
  createdAt: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  text: string;
  runId?: string;
  report?: unknown;
  createdAt: string;
}

export type RunStatus = 'running' | 'waiting' | 'complete' | 'failed' | 'stopped' | 'interrupted';
export interface Run {
  id: string;
  chatId: string;
  userId: string;
  mission: string;
  question: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  view?: unknown;             // final plan/hypothesis snapshot for rendering without replaying events
  totals?: Record<string, number>;
  models?: Record<string, string>;
}

export interface RunEvent {
  runId: string;
  seq: number;
  at: string;
  node: string;
  type: string;
  summary: string;
  payload: unknown;
}

export interface Store {
  users: {
    byUsername(username: string): Promise<User | null>;
    byId(id: string): Promise<User | null>;
    list(): Promise<User[]>;
    insert(user: Omit<User, 'id'>): Promise<User>;
    update(id: string, patch: Partial<Omit<User, 'id' | 'username'>>): Promise<User | null>;
    countActiveSuperusers(): Promise<number>;
  };
  sessions: {
    insert(session: Session): Promise<void>;
    byTokenHash(tokenHash: string): Promise<Session | null>;
    touch(tokenHash: string, at: string): Promise<void>;
    delete(tokenHash: string): Promise<void>;
    deleteForUser(userId: string, exceptTokenHash?: string): Promise<void>;
  };
  chats: {
    list(userId: string, mission: string): Promise<Chat[]>;
    byId(id: string): Promise<Chat | null>;
    insert(chat: Omit<Chat, 'id'>): Promise<Chat>;
    update(id: string, patch: Partial<Pick<Chat, 'title' | 'updatedAt'>>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  messages: {
    insert(message: Omit<Message, 'id'>): Promise<Message>;
    list(chatId: string): Promise<Message[]>;
  };
  runs: {
    insert(run: Omit<Run, 'id'>): Promise<Run>;
    byId(id: string): Promise<Run | null>;
    update(id: string, patch: Partial<Omit<Run, 'id'>>): Promise<void>;
    listForChat(chatId: string): Promise<Run[]>;
    markUnfinished(status: RunStatus, error: string): Promise<number>;
  };
  events: {
    insert(event: RunEvent): Promise<void>;
    list(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  };
  blobs: {
    insert(runId: string, content: string): Promise<string>;
    byId(id: string): Promise<{ id: string; runId: string; content: string } | null>;
  };
  settings: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
  };
  deleteChatData(chatId: string): Promise<void>;
  artifacts: {
    insert(artifact: Omit<Artifact, 'id'>): Promise<Artifact>;
    byId(id: string): Promise<Artifact | null>;
  };
  missions: {
    list(): Promise<Mission[]>;
    counts(mission: Mission): Promise<MissionCounts>;
  };
  init(): Promise<void>;
  close(): Promise<void>;
}
