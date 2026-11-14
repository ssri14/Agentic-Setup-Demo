import { MongoClient, ObjectId, type Db, type WithId, type Document } from 'mongodb';
import type { Artifact, Chat, Message, Mission, MissionCounts, Run, RunEvent, RunStatus, Session, Store, User } from './types.js';

const toUser = (d: WithId<Document>): User => ({ ...(d as unknown as User), id: d._id.toString() });
const toChat = (d: WithId<Document>): Chat => ({ ...(d as unknown as Chat), id: d._id.toString() });
const oid = (id: string) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const strip = <T extends { id?: string }>(value: T) => { const { id: _ignored, ...rest } = value; return rest; };

export class MongoStore implements Store {
  private client: MongoClient;
  private app: Db;
  private registry: Db;

  constructor(uri: string, appDatabase: string, registryDatabase: string) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    this.app = this.client.db(appDatabase);
    this.registry = this.client.db(registryDatabase);
  }

  async init() {
    await this.client.connect();
    await this.app.collection('users').createIndex({ username: 1 }, { unique: true });
    await this.app.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true });
    await this.app.collection('sessions').createIndex({ userId: 1 });
    await this.app.collection('chats').createIndex({ userId: 1, mission: 1, updatedAt: -1 });
    await this.app.collection('artifacts').createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
    await this.app.collection('messages').createIndex({ chatId: 1, createdAt: 1 });
    await this.app.collection('runs').createIndex({ chatId: 1, createdAt: 1 });
    await this.app.collection('run_events').createIndex({ runId: 1, seq: 1 }, { unique: true });
    await this.app.collection('run_blobs').createIndex({ runId: 1 });
  }

  async close() { await this.client.close(); }

  /** The shared driver, for read-only mission data access by the tools. */
  get mongoClient() { return this.client; }

  messages = {
    insert: async (m: Omit<Message, 'id'>) => {
      const r = await this.app.collection('messages').insertOne({ ...m });
      return { ...m, id: r.insertedId.toString() };
    },
    list: async (chatId: string) => (await this.app.collection('messages').find({ chatId }).sort({ createdAt: 1 }).toArray())
      .map((d) => ({ ...(d as unknown as Message), id: d._id.toString() })),
  };

  runs = {
    insert: async (run: Omit<Run, 'id'>) => {
      const r = await this.app.collection('runs').insertOne({ ...run });
      return { ...run, id: r.insertedId.toString() };
    },
    byId: async (id: string) => {
      const key = oid(id);
      const d = key ? await this.app.collection('runs').findOne({ _id: key }) : null;
      return d ? ({ ...(d as unknown as Run), id: d._id.toString() }) : null;
    },
    update: async (id: string, patch: Partial<Omit<Run, 'id'>>) => {
      const key = oid(id);
      if (key) await this.app.collection('runs').updateOne({ _id: key }, { $set: patch });
    },
    listForChat: async (chatId: string) => (await this.app.collection('runs').find({ chatId }).sort({ createdAt: 1 }).toArray())
      .map((d) => ({ ...(d as unknown as Run), id: d._id.toString() })),
    markUnfinished: async (status: RunStatus, error: string) =>
      (await this.app.collection('runs').updateMany({ status: { $in: ['running', 'waiting'] } }, { $set: { status, error, finishedAt: new Date().toISOString() } })).modifiedCount,
  };

  events = {
    insert: async (e: RunEvent) => { await this.app.collection('run_events').insertOne({ ...e }); },
    list: async (runId: string, afterSeq = 0) => (await this.app.collection('run_events').find({ runId, seq: { $gt: afterSeq } }, { projection: { _id: 0 } })
      .sort({ seq: 1 }).toArray()) as unknown as RunEvent[],
  };

  blobs = {
    insert: async (runId: string, content: string) => (await this.app.collection('run_blobs').insertOne({ runId, content })).insertedId.toString(),
    byId: async (id: string) => {
      const key = oid(id);
      const d = key ? await this.app.collection('run_blobs').findOne({ _id: key }) : null;
      return d ? { id, runId: String(d.runId), content: String(d.content) } : null;
    },
  };

  settings = {
    get: async <T>(key: string) => ((await this.app.collection<{ _id: string; value: unknown }>('settings').findOne({ _id: key }))?.value as T) ?? null,
    set: async <T>(key: string, value: T) => { await this.app.collection<{ _id: string; value: unknown }>('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true }); },
  };

  async deleteChatData(chatId: string) {
    const runIds = (await this.app.collection('runs').find({ chatId }, { projection: { _id: 1 } }).toArray()).map((r) => r._id.toString());
    await Promise.all([
      this.app.collection('messages').deleteMany({ chatId }),
      this.app.collection('runs').deleteMany({ chatId }),
      this.app.collection('run_events').deleteMany({ runId: { $in: runIds } }),
      this.app.collection('run_blobs').deleteMany({ runId: { $in: runIds } }),
    ]);
  }

  artifacts = {
    insert: async (artifact: Omit<Artifact, 'id'>) => {
      const result = await this.app.collection('artifacts').insertOne({ ...artifact, createdAt: new Date(artifact.createdAt) });
      return { ...artifact, id: result.insertedId.toString() };
    },
    byId: async (id: string) => {
      const key = oid(id);
      const d = key ? await this.app.collection('artifacts').findOne({ _id: key }) : null;
      return d ? ({ ...(d as unknown as Artifact), id: d._id.toString(), createdAt: new Date(d.createdAt).toISOString() }) : null;
    },
  };

  users = {
    byUsername: async (username: string) => {
      const d = await this.app.collection('users').findOne({ username });
      return d ? toUser(d) : null;
    },
    byId: async (id: string) => {
      const key = oid(id);
      const d = key ? await this.app.collection('users').findOne({ _id: key }) : null;
      return d ? toUser(d) : null;
    },
    list: async () => (await this.app.collection('users').find().sort({ username: 1 }).toArray()).map(toUser),
    insert: async (user: Omit<User, 'id'>) => {
      const result = await this.app.collection('users').insertOne({ ...user });
      return { ...user, id: result.insertedId.toString() };
    },
    update: async (id: string, patch: Partial<Omit<User, 'id' | 'username'>>) => {
      const key = oid(id);
      if (!key) return null;
      const unset = Object.fromEntries(Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => [k, '']));
      const set = Object.fromEntries(Object.entries(strip(patch as User)).filter(([, v]) => v !== undefined));
      const d = await this.app.collection('users').findOneAndUpdate({ _id: key },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after' });
      return d ? toUser(d) : null;
    },
    countActiveSuperusers: async () => this.app.collection('users').countDocuments({ role: 'superuser', disabled: false }),
  };

  sessions = {
    insert: async (session: Session) => { await this.app.collection('sessions').insertOne({ ...session }); },
    byTokenHash: async (tokenHash: string) => {
      const d = await this.app.collection('sessions').findOne({ tokenHash });
      if (!d) return null;
      const { _id, ...rest } = d;
      return rest as unknown as Session;
    },
    touch: async (tokenHash: string, at: string) => { await this.app.collection('sessions').updateOne({ tokenHash }, { $set: { lastSeenAt: at } }); },
    delete: async (tokenHash: string) => { await this.app.collection('sessions').deleteOne({ tokenHash }); },
    deleteForUser: async (userId: string, exceptTokenHash?: string) => {
      await this.app.collection('sessions').deleteMany({ userId, ...(exceptTokenHash ? { tokenHash: { $ne: exceptTokenHash } } : {}) });
    },
  };

  chats = {
    list: async (userId: string, mission: string) =>
      (await this.app.collection('chats').find({ userId, mission }).sort({ updatedAt: -1 }).limit(500).toArray()).map(toChat),
    byId: async (id: string) => {
      const key = oid(id);
      const d = key ? await this.app.collection('chats').findOne({ _id: key }) : null;
      return d ? toChat(d) : null;
    },
    insert: async (chat: Omit<Chat, 'id'>) => {
      const result = await this.app.collection('chats').insertOne({ ...chat });
      return { ...chat, id: result.insertedId.toString() };
    },
    update: async (id: string, patch: Partial<Pick<Chat, 'title' | 'updatedAt'>>) => {
      const key = oid(id);
      if (key) await this.app.collection('chats').updateOne({ _id: key }, { $set: patch });
    },
    delete: async (id: string) => {
      const key = oid(id);
      if (key) await this.app.collection('chats').deleteOne({ _id: key });
    },
  };

  missions = {
    list: async (): Promise<Mission[]> =>
      (await this.registry.collection('missions').find().sort({ _id: 1 }).toArray()).map((d) => ({
        id: String(d._id), name: String(d.name ?? d._id), description: String(d.description ?? ''),
        mongoDatabase: String(d.mongo_database), influxDatabase: String(d.influx_database), qdrantCollection: String(d.qdrant_collection), telemetrySchema: (d.telemetry_schema as string | null) ?? null,
      })),
    counts: async (mission: Mission): Promise<MissionCounts> => {
      const db = this.client.db(mission.mongoDatabase);
      const [documents, telemetryRuns] = await Promise.all([
        db.collection('documents').countDocuments({ status: 'complete' }),
        db.collection('telemetry_runs').countDocuments({ status: 'complete' }),
      ]);
      return { documents, telemetryRuns };
    },
  };
}
