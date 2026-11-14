/**
 * Narrow, read-only access to the mission stores. Each method maps to one fixed query shape;
 * nothing here accepts model-written SQL or Cypher. Tests substitute in-memory fakes.
 */
import { readFileSync } from 'node:fs';
import type { Db, Document, MongoClient } from 'mongodb';
import neo4j, { type Driver } from 'neo4j-driver';

export interface FindOptions { projection?: Document; sort?: Record<string, 1 | -1>; limit?: number }
export interface MissionMongo { find(collection: string, filter: Document, options?: FindOptions): Promise<Document[]> }

export interface SectionLink { relationship: string; section_id: string; label: string; title: string; score?: number | null; keywords?: string[] | null }
export interface EntityNeighbours {
  entity: { name: string; mission: string } | null;
  sections: { section_id: string; label: string; title: string; mentions: number }[];
  related: { name: string; shared_chunks: number }[];
}
export interface Graph {
  sectionLinks(sectionId: string): Promise<SectionLink[]>;
  entityNeighbours(mission: string, name: string, documentIds: string[], limit: number): Promise<EntityNeighbours>;
}

export interface VectorHit { chunk_id: string; section_id: string; document_id: string; page: number; kind: string; score: number }
export interface Vectors { query(collection: string, vector: number[], documentIds: string[], kinds: string[] | null, limit: number): Promise<VectorHit[]> }

export interface Embedding { model: string; revision: string; dimensions: number; vectors: number[][] }
export interface Embedder { embed(texts: string[]): Promise<Embedding> }

export type SqlValue = string | number | boolean | null;
export interface TimeSeries { query(database: string, sql: string, params: Record<string, SqlValue>): Promise<Record<string, SqlValue>[]> }

export interface SandboxResult {
  stdout: string; stdout_truncated?: boolean; error: string | null; duration_ms?: number;
  tables: { name: string; rows_total: number; csv: string }[]; charts: { name: string; png_base64: string }[];
}
export interface Sandbox { run(code: string, inputs: Record<string, string>): Promise<SandboxResult> }

export interface Sources {
  mongo(databaseName: string): MissionMongo;
  graph: Graph;
  vectors: Vectors;
  embedder: Embedder;
  timeseries: TimeSeries;
  sandbox: Sandbox;
}

// ---------------- Real implementations ----------------

export class MongoSource {
  constructor(private client: MongoClient) {}
  mongo(databaseName: string): MissionMongo {
    const db: Db = this.client.db(databaseName);
    return {
      find: (collection, filter, options = {}) => {
        let cursor = db.collection(collection).find(filter, options.projection ? { projection: options.projection } : {});
        if (options.sort) cursor = cursor.sort(options.sort);
        return cursor.limit(Math.min(options.limit ?? 1000, 5000)).toArray();
      },
    };
  }
}

export class Neo4jGraph implements Graph {
  private driver: Driver;
  constructor(uri: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', password), { disableLosslessIntegers: true });
  }
  private async read<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.executeRead((tx) => tx.run(query, params));
      return result.records.map((r) => r.toObject() as T);
    } finally { await session.close(); }
  }
  async sectionLinks(sectionId: string): Promise<SectionLink[]> {
    const [links, refsOut, refsIn] = await Promise.all([
      this.read<SectionLink>(`MATCH (s:Section {id:$id})-[r:NEXT|PREVIOUS|RELATED_KEYWORD|RELATED_SEMANTIC]->(o:Section)
        RETURN type(r) AS relationship, o.id AS section_id, o.label AS label, o.title AS title, r.score AS score, r.keywords AS keywords
        ORDER BY relationship, score DESC`, { id: sectionId }),
      this.read<SectionLink>(`MATCH (s:Section {id:$id})-[:HAS_CHUNK]->(:Chunk)-[:REFERS_TO]->(o:Section)
        RETURN DISTINCT 'REFERS_TO' AS relationship, o.id AS section_id, o.label AS label, o.title AS title`, { id: sectionId }),
      this.read<SectionLink>(`MATCH (o:Section)-[:HAS_CHUNK]->(:Chunk)-[:REFERS_TO]->(s:Section {id:$id})
        RETURN DISTINCT 'REFERRED_BY' AS relationship, o.id AS section_id, o.label AS label, o.title AS title`, { id: sectionId }),
    ]);
    return [...links, ...refsOut, ...refsIn];
  }
  async entityNeighbours(mission: string, name: string, documentIds: string[], limit: number): Promise<EntityNeighbours> {
    const [entity] = await this.read<{ name: string; mission: string }>(
      'MATCH (e:Entity {mission:$mission}) WHERE toLower(e.name) = toLower($name) RETURN e.name AS name, e.mission AS mission LIMIT 1', { mission, name });
    if (!entity) return { entity: null, sections: [], related: [] };
    const params = { mission, name: entity.name, docs: documentIds, limit: neo4j.int(limit) };
    const [sections, related] = await Promise.all([
      this.read<EntityNeighbours['sections'][number]>(`MATCH (e:Entity {mission:$mission, name:$name})<-[:MENTIONS]-(c:Chunk)<-[:HAS_CHUNK]-(s:Section)
        WHERE c.document_id IN $docs RETURN s.id AS section_id, s.label AS label, s.title AS title, count(c) AS mentions
        ORDER BY mentions DESC, label LIMIT $limit`, params),
      this.read<EntityNeighbours['related'][number]>(`MATCH (e:Entity {mission:$mission, name:$name})<-[:MENTIONS]-(c:Chunk)-[:MENTIONS]->(o:Entity)
        WHERE c.document_id IN $docs AND o <> e RETURN o.name AS name, count(c) AS shared_chunks
        ORDER BY shared_chunks DESC, name LIMIT $limit`, params),
    ]);
    return { entity, sections, related };
  }
  close() { return this.driver.close(); }
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Name the service and the network-level reason, instead of the bare "fetch failed".
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = (error as Error).name === 'TimeoutError' ? `no reply within ${timeoutMs / 1000} s`
      : cause?.code === 'ECONNREFUSED' ? 'connection refused (is the service running?)'
      : cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN' ? 'host name not found (is the service running and on the same Docker network?)'
      : cause?.code === 'UND_ERR_SOCKET' || cause?.code === 'ECONNRESET' ? 'the service closed the connection without replying (check its logs)'
      : cause?.message ?? (error as Error).message;
    throw new Error(`cannot reach ${new URL(url).host}: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try { const parsed = JSON.parse(text); message = parsed.error ?? parsed.detail ?? parsed.status?.error ?? message; } catch { /* plain text */ }
    throw new Error(`${new URL(url).host} returned ${res.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
  return JSON.parse(text) as T;
}

export class QdrantVectors implements Vectors {
  constructor(private baseUrl: string) {}
  async query(collection: string, vector: number[], documentIds: string[], kinds: string[] | null, limit: number) {
    const must: Document[] = [{ key: 'document_id', match: { any: documentIds } }];
    if (kinds) must.push({ key: 'kind', match: { any: kinds } });
    const r = await postJson<{ result: { points: { score: number; payload: Document }[] } }>(
      `${this.baseUrl}/collections/${encodeURIComponent(collection)}/points/query`,
      { query: vector, filter: { must }, limit, with_payload: true });
    return r.result.points.map((p) => ({ chunk_id: p.payload.chunk_id, section_id: p.payload.section_id, document_id: p.payload.document_id,
      page: p.payload.page, kind: p.payload.kind, score: p.score }));
  }
}

export class HttpEmbedder implements Embedder {
  constructor(private url: string) {}
  embed(texts: string[]) { return postJson<Embedding>(this.url, { texts }, {}, 120_000); }
}

export class InfluxTimeSeries implements TimeSeries {
  constructor(private baseUrl: string, private tokenFile: string, private tokenValue?: string) {}
  async query(database: string, sql: string, params: Record<string, SqlValue>) {
    const token = this.tokenValue || (JSON.parse(readFileSync(this.tokenFile, 'utf8')).token as string);
    return postJson<Record<string, SqlValue>[]>(`${this.baseUrl}/api/v3/query_sql`, { db: database, q: sql, format: 'json', params },
      { Authorization: `Bearer ${token}` }, 60_000);
  }
}

export class HttpSandbox implements Sandbox {
  constructor(private baseUrl: string) {}
  run(code: string, inputs: Record<string, string>) { return postJson<SandboxResult>(`${this.baseUrl}/run`, { code, inputs }, {}, 60_000); }
}
