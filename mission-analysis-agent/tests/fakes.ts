/** In-memory stand-ins for the mission stores, loaded from real Brahmastra extraction and telemetry files. */
import { readFileSync } from 'node:fs';
import { Query } from 'mingo';
import type { Document } from 'mongodb';
import type { EntityNeighbours, FindOptions, MissionMongo, SandboxResult, SectionLink, Sources, SqlValue, VectorHit } from '../server/src/tools/sources.js';

const dir = new URL('./fixtures/brahmastra/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

export const extraction = JSON.parse(read('extraction.json'));
export const DOC_ID: string = extraction.document._id;
const schema = JSON.parse(read('telemetry_schema.json'));
const manifest10 = JSON.parse(read('BM-RUN-0010_run_manifest.json'));
const manifest01 = JSON.parse(read('BM-RUN-0001_run_manifest.json'));

function parseCsv(text: string): Record<string, SqlValue>[] {
  const [header, ...lines] = text.trim().split('\n');
  const cols = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => {
    const value: SqlValue = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) && !/^[A-Z]/.test(v) ? Number(v) : v;
    return [cols[i], value];
  })));
}
const telemetry10 = parseCsv(read('BM-RUN-0010_telemetry.csv'));
const events10 = read('BM-RUN-0010_events.jsonl').trim().split('\n').map((l) => JSON.parse(l));

export function fakeMongoData(): Record<string, Document[]> {
  return {
    documents: [
      { ...extraction.document, status: 'complete', updated_at: '2026-11-14T11:15:00Z' },
      // An older native-only revision of the same source: the tools must prefer the enriched one.
      { ...extraction.document, _id: 'native-revision', extraction_status: 'native_only', status: 'complete', updated_at: '2026-11-14T11:08:00Z' },
    ],
    sections: extraction.sections,
    chunks: extraction.chunks,
    assets: extraction.assets,
    configuration: [{ _id: 'embedding', model: 'test-model', revision: 'rev-1', dimensions: 3 }],
    telemetry_channels: schema.channels.map((c: Document) => ({ _id: c.id, ...c })),
    telemetry_runs: [
      { _id: 'dataset-10', run_id: 'BM-RUN-0010', manifest: manifest10, status: 'complete', counts: { telemetry: manifest10.observed_samples, mission_events: manifest10.event_count }, updated_at: '2026-11-14T11:10:00Z' },
      { _id: 'dataset-01', run_id: 'BM-RUN-0001', manifest: manifest01, status: 'complete', counts: { telemetry: 1800, mission_events: 20 }, updated_at: '2026-11-14T11:10:00Z' },
    ],
  };
}

function mongo(data: Record<string, Document[]>): MissionMongo {
  return {
    async find(collection: string, filter: Document, options: FindOptions = {}) {
      let rows = new Query(filter).find<Document>(data[collection] ?? []).all() as Document[];
      if (options.sort) {
        const keys = Object.entries(options.sort);
        rows = [...rows].sort((a, b) => { for (const [k, dirn] of keys) { if (a[k] < b[k]) return -dirn; if (a[k] > b[k]) return dirn; } return 0; });
      }
      rows = rows.slice(0, options.limit ?? 1000);
      if (options.projection) {
        const include = Object.entries(options.projection).filter(([, v]) => v).map(([k]) => k);
        const exclude = Object.entries(options.projection).filter(([, v]) => !v).map(([k]) => k);
        rows = rows.map((r) => include.length ? Object.fromEntries(['_id', ...include].filter((k) => k in r).map((k) => [k, r[k]]))
          : Object.fromEntries(Object.entries(r).filter(([k]) => !exclude.includes(k))));
      }
      return structuredClone(rows);
    },
  };
}

export interface FakeLog { sql: { sql: string; params: Record<string, SqlValue> }[]; sandbox: { code: string; inputs: Record<string, string> }[]; vectorFilters: { documentIds: string[]; kinds: string[] | null }[] }

export function fakeSources(overrides: Partial<Sources> = {}): { sources: Sources; log: FakeLog; data: Record<string, Document[]> } {
  const data = fakeMongoData();
  const log: FakeLog = { sql: [], sandbox: [], vectorFilters: [] };
  let lastQuery = '';
  const sectionOf = (id: string) => extraction.sections.find((s: Document) => s._id === id);
  const sources: Sources = {
    mongo: () => mongo(data),
    embedder: { async embed(texts) { lastQuery = texts[0]; return { model: 'test-model', revision: 'rev-1', dimensions: 3, vectors: texts.map(() => [1, 0, 0]) }; } },
    vectors: {
      async query(_c, _v, documentIds, kinds, limit): Promise<VectorHit[]> {
        log.vectorFilters.push({ documentIds, kinds });
        const words = lastQuery.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        return extraction.chunks.filter((c: Document) => documentIds.includes(c.document_id) && (!kinds || kinds.includes(c.kind)))
          .map((c: Document) => ({ c, score: words.filter((w) => c.text.toLowerCase().includes(w)).length / Math.max(words.length, 1) }))
          .filter((x: { score: number }) => x.score > 0).sort((a: { score: number }, b: { score: number }) => b.score - a.score).slice(0, limit)
          .map(({ c, score }: { c: Document; score: number }) => ({ chunk_id: c._id, section_id: c.section_id, document_id: c.document_id, page: c.page, kind: c.kind, score }));
      },
    },
    graph: {
      async sectionLinks(sectionId): Promise<SectionLink[]> {
        const s = sectionOf(sectionId);
        const byOrdinal = (o: number) => extraction.sections.find((x: Document) => x.ordinal === o);
        const out: SectionLink[] = [];
        const prev = byOrdinal(s.ordinal - 1), next = byOrdinal(s.ordinal + 1);
        if (prev) out.push({ relationship: 'PREVIOUS', section_id: prev._id, label: prev.label, title: prev.title });
        if (next) out.push({ relationship: 'NEXT', section_id: next._id, label: next.label, title: next.title });
        const text = extraction.chunks.filter((c: Document) => c.section_id === sectionId).map((c: Document) => c.text).join(' ');
        for (const label of new Set<string>(text.match(/SEC-\d{2}/g) ?? [])) {
          const target = extraction.sections.find((x: Document) => x.label === label);
          if (target && target._id !== sectionId) out.push({ relationship: 'REFERS_TO', section_id: target._id, label, title: target.title });
        }
        return out;
      },
      async entityNeighbours(mission, name, documentIds, limit): Promise<EntityNeighbours> {
        const chunks = extraction.chunks.filter((c: Document) => documentIds.includes(c.document_id) && c.entities.some((e: string) => e.toLowerCase() === name.toLowerCase()));
        if (!chunks.length) return { entity: null, sections: [], related: [] };
        const canonical = chunks[0].entities.find((e: string) => e.toLowerCase() === name.toLowerCase());
        const bySection = new Map<string, number>(), related = new Map<string, number>();
        for (const c of chunks) {
          bySection.set(c.section_id, (bySection.get(c.section_id) ?? 0) + 1);
          for (const e of c.entities) if (e !== canonical) related.set(e, (related.get(e) ?? 0) + 1);
        }
        return { entity: { name: canonical, mission },
          sections: [...bySection].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, n]) => ({ section_id: id, label: sectionOf(id).label, title: sectionOf(id).title, mentions: n })),
          related: [...related].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([n, k]) => ({ name: n, shared_chunks: k })) };
      },
    },
    timeseries: {
      async query(_db, sql, params) {
        log.sql.push({ sql, params });
        const table = /FROM (\w+)/.exec(sql)![1];
        const cols = /SELECT ([\s\S]+?)\s+FROM/.exec(sql)![1].split(',').map((c) => c.trim().replaceAll('"', ''));
        if (params.dataset !== 'dataset-10') return [];
        const rows = table === 'telemetry' ? telemetry10 : events10;
        return rows.filter((r: Record<string, SqlValue>) => Number(r.mission_elapsed_s) >= Number(params.start) && Number(r.mission_elapsed_s) < Number(params.end))
          .slice(0, table === 'telemetry' ? 1800 : 1000).map((r: Record<string, SqlValue>) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      },
    },
    sandbox: {
      async run(code, inputs): Promise<SandboxResult> {
        log.sandbox.push({ code, inputs });
        return { stdout: `inputs: ${Object.keys(inputs).join(',')}\n`, error: null, duration_ms: 12,
          tables: [{ name: 'summary', rows_total: 2, csv: 'a,b\n1,2\n3,4\n' }], charts: [{ name: 'trend', png_base64: 'iVBORw0KGgo=' }] };
      },
    },
    ...overrides,
  };
  return { sources, log, data };
}
