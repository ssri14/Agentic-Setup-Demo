import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, bootstrapSuperuser } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { MemoryStore } from '../server/src/store/memory.js';
import { TOOLS, describeTools, runTool, type ToolContext } from '../server/src/tools/registry.js';
import type { Mission, User } from '../server/src/store/types.js';
import { DOC_ID, fakeSources, type FakeLog } from './fakes.js';

const brahmastra: Mission = { id: 'brahmastra', name: 'Brahmastra', description: '', mongoDatabase: 'brahmastra', influxDatabase: 'brahmastra', qdrantCollection: 'document_chunks', telemetrySchema: 'brahmastra-rc1' };
const trishul: Mission = { id: 'trishul', name: 'Trishul', description: '', mongoDatabase: 'mission_trishul', influxDatabase: 'mission_trishul', qdrantCollection: 'trishul_chunks', telemetrySchema: null };
const user = { id: 'u1', username: 'analyst' } as User;

let store: MemoryStore;
let ctx: ToolContext;
let log: FakeLog;

beforeEach(() => {
  store = new MemoryStore([brahmastra, trishul]);
  const fake = fakeSources();
  log = fake.log;
  ctx = { mission: brahmastra, user, store, sources: fake.sources };
});

const run = (name: string, args: unknown, c = ctx) => runTool(name, args, c);

describe('registry', () => {
  it('has the ten planned tools, each with a JSON schema and an example that validates', async () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['search_documents', 'read_section', 'get_table', 'get_figure', 'lookup_channels',
      'list_runs', 'telemetry_window', 'events_window', 'run_analysis', 'graph_neighbours']);
    for (const t of describeTools()) {
      expect(t.parameters).toMatchObject({ type: 'object' });
      if (t.name !== 'run_analysis') expect(TOOLS.find((x) => x.name === t.name)!.schema.safeParse(t.example).success, t.name).toBe(true);
    }
  });

  it('rejects invalid arguments with a readable message, and telemetry tools on missions without telemetry', async () => {
    await expect(run('telemetry_window', { run_id: 'BM-RUN-0010', channels: [] })).rejects.toThrow(/channels/);
    await expect(run('get_table', {})).rejects.toThrow(/page, asset_id or contains/);
    await expect(run('nope', {})).rejects.toThrow(/Unknown tool/);
    await expect(run('list_runs', {}, { ...ctx, mission: trishul })).rejects.toThrow(/no telemetry/);
  });
});

describe('document tools', () => {
  it('search_documents searches only the enriched revision and resolves sections and pages', async () => {
    const r = await run('search_documents', { query: 'missing source samples delayed delivery backfilled' });
    expect(log.vectorFilters[0].documentIds).toEqual([DOC_ID]);
    const passages = (r.data as { passages: { section: string; page: number; text: string }[] }).passages;
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].section).toMatch(/^SEC-\d{2}$/);
    expect(r.evidence[0]).toMatchObject({ kind: 'passage', page: passages[0].page });
  });

  it('search_documents filters by kind and refuses a mismatched embedding model', async () => {
    await run('search_documents', { query: 'telemetry dictionary channel owner', kinds: ['table'] });
    expect(log.vectorFilters[0].kinds).toEqual(['native_table', 'vlm_table']);
    const bad = fakeSources({ embedder: { embed: async () => ({ model: 'other', revision: 'x', dimensions: 3, vectors: [[1, 0, 0]] }) } });
    await expect(run('search_documents', { query: 'anything at all' }, { ...ctx, sources: bad.sources })).rejects.toThrow(/indexed with test-model/);
  });

  it('read_section returns ordered content and graph links', async () => {
    const r = await run('read_section', { section: 'sec-04' });
    const d = r.data as { section: { label: string; pages: number[] }; content: unknown[]; previous: { label: string }; next: { label: string } };
    expect(d.section).toMatchObject({ label: 'SEC-04', pages: [14, 19] });
    expect(d.content.length).toBeGreaterThan(0);
    expect([d.previous.label, d.next.label]).toEqual(['SEC-03', 'SEC-05']);
    await expect(run('read_section', { section: 'SEC-99' })).rejects.toThrow(/Sections: FRONT/);
  });

  it('get_table finds the dictionary rows for a channel and saves CSV artifacts', async () => {
    const r = await run('get_table', { contains: 'daq_missing_samples', source: 'vlm', max_tables: 2 });
    const tables = (r.data as { tables: { source: string; columns: string[]; rows: string[][]; review_status: string }[] }).tables;
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]).toMatchObject({ source: 'vlm', review_status: 'unreviewed_model_output' });
    expect(tables[0].rows.flat()).toContain('daq_missing_samples');
    const artifact = await store.artifacts.byId(r.artifacts[0].id);
    expect(artifact?.content).toContain('daq_missing_samples');
  });

  it('get_figure distinguishes the anchored figure from references to it', async () => {
    const r = await run('get_figure', { figure_id: 'fig-01' });
    const figures = (r.data as { figures: { role: string; page: number }[] }).figures;
    expect(figures[0].role).toBe('figure (caption-anchored)');
    expect(figures.some((f) => f.role === 'reference to the figure')).toBe(true);
  });

  it('graph_neighbours finds sections and co-mentioned entities, case-insensitively', async () => {
    const r = await run('graph_neighbours', { entity: 'daq', limit: 5 });
    const d = r.data as { entity: { name: string }; sections: { label: string }[]; related: { name: string }[] };
    expect(d.entity.name).toBe('DAQ');
    expect(d.sections.length).toBeGreaterThan(0);
    expect(d.related.length).toBeGreaterThan(0);
    await expect(run('graph_neighbours', { entity: 'not_an_entity' })).rejects.toThrow(/No entity/);
  });
});

describe('telemetry tools', () => {
  it('lookup_channels lists a subsystem with its documented table rows', async () => {
    const r = await run('lookup_channels', { subsystem: 'daq' });
    const channels = (r.data as { channels: { channel: string; owner: string; documented: unknown[] }[] }).channels;
    expect(channels.map((c) => c.channel)).toEqual(['daq_buffer_pct', 'daq_missing_samples', 'daq_quality_pu', 'daq_rate_hz']);
    expect(channels.some((c) => c.documented.length > 0)).toBe(true);
    const unknown = await run('lookup_channels', { channels: ['pwr_margin_pu', 'made_up'] });
    expect((unknown.data as { unknown: string[] }).unknown).toEqual(['made_up']);
  });

  it('list_runs reports missing samples', async () => {
    const r = await run('list_runs', {});
    expect(r.summary).toMatch(/BM-RUN-0010/);
    const run10 = (r.data as { runs: { run_id: string; missing_samples: number }[] }).runs.find((x) => x.run_id === 'BM-RUN-0010');
    expect(run10?.missing_samples).toBe(50);
  });

  it('telemetry_window builds a parameterised query, finds the source gap and saves the window', async () => {
    const r = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['daq_missing_samples', 'pwr_margin_pu'], start: 0, end: 900 });
    const q = log.sql[0];
    expect(q.sql).toMatch(/"daq_missing_samples", "pwr_margin_pu"/);
    expect(q.sql).not.toMatch(/BM-RUN/);
    expect(q.params).toMatchObject({ dataset: 'dataset-10', start: 0, end: 900 });
    const d = r.data as { samples: number; source_gaps: { missing_samples: number }[]; channels: Record<string, { max: number }> };
    expect(d.samples).toBe(1750);
    expect(d.source_gaps.reduce((a, g) => a + g.missing_samples, 0)).toBe(50);
    expect(d.channels.daq_missing_samples.max).toBe(50);
    expect(r.artifacts[0]).toMatchObject({ kind: 'csv', rows: 1750 });
  });

  it('telemetry_window reports source gaps that run past either edge of the window', async () => {
    const tail = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], start: 280, end: 340 });
    const gaps = (tail.data as { source_gaps: { from_s: number; to_s: number; missing_samples: number; note?: string }[] }).source_gaps;
    expect(gaps).toEqual([{ from_s: 322, to_s: 339.5, missing_samples: 36, note: 'continues past the window' }]);
    const head = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], start: 330, end: 360 });
    expect((head.data as { source_gaps: { note?: string; missing_samples: number }[] }).source_gaps[0]).toMatchObject({ note: 'starts before the window', missing_samples: 34 });
    const inside = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], start: 300, end: 360 });
    expect((inside.data as { source_gaps: unknown[] }).source_gaps).toEqual([{ from_s: 322, to_s: 346.5, missing_samples: 50 }]);
  });

  it('telemetry_window refuses unknown channels and runs, so no free text reaches SQL', async () => {
    await expect(run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu" FROM x; --'] })).rejects.toThrow(/Unknown channels/);
    await expect(run('telemetry_window', { run_id: 'BM-RUN-9999', channels: ['pwr_margin_pu'] })).rejects.toThrow(/not ingested/);
    expect(log.sql).toHaveLength(0);
  });

  it('events_window filters by subsystem and reports receipt delays', async () => {
    const all = await run('events_window', { run_id: 'BM-RUN-0010' });
    expect((all.data as { count: number }).count).toBe(21);
    const seq = await run('events_window', { run_id: 'BM-RUN-0010', subsystem: 'seq' });
    const events = (seq.data as { events: { subsystem: string }[] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.subsystem === 'SEQ')).toBe(true);
  });
});

describe('run_analysis', () => {
  it('passes the user\'s own CSV artifacts by name and stores tables and charts', async () => {
    const window = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], start: 0, end: 60 });
    const r = await run('run_analysis', { code: "df = load_input('BM-RUN-0010_0-60s')\nprint(len(df))", inputs: [window.artifacts[0].id] });
    expect(Object.keys(log.sandbox[0].inputs)).toEqual(['BM-RUN-0010_0-60s']);
    expect(log.sandbox[0].inputs['BM-RUN-0010_0-60s'].split('\n')[0]).toBe('mission_elapsed_s,sample_index,delivery_state,pwr_margin_pu');
    expect(r.artifacts.map((a) => a.kind)).toEqual(['csv', 'png']);
  });

  it('refuses artifacts that belong to another user or mission', async () => {
    const window = await run('telemetry_window', { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], start: 0, end: 10 });
    const other = { ...ctx, user: { id: 'u2', username: 'other' } as User };
    await expect(run('run_analysis', { code: 'print(1)', inputs: [window.artifacts[0].id] }, other)).rejects.toThrow(/not found/);
  });
});

describe('HTTP routes', () => {
  let app: FastifyInstance;
  const ADMIN = 'bench-pass-12345';
  beforeEach(async () => {
    const config = { ...loadConfig({}), adminUser: 'admin', adminPassword: ADMIN, clientDir: '/nonexistent' };
    app = await buildApp(store, config, fakeSources().sources);
    await bootstrapSuperuser(store, config, () => {});
    const [admin] = await store.users.list();
    await store.users.update(admin.id, { mustChangePassword: false });
  });
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ADMIN } });
    return { cookie: String(res.headers['set-cookie']).split(';')[0], csrf: res.json().csrfToken as string };
  };

  it('lets the superuser list and run tools, returning tool errors as results', async () => {
    const s = await login();
    const headers = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const list = await app.inject({ method: 'GET', url: '/api/tools', headers });
    expect(list.json()).toHaveLength(10);
    const ok = await app.inject({ method: 'POST', url: '/api/tools/list_runs/run', headers, payload: { mission: 'brahmastra', args: {} } });
    expect(ok.json()).toMatchObject({ ok: true });
    expect(ok.json().duration_ms).toBeTypeOf('number');
    const bad = await app.inject({ method: 'POST', url: '/api/tools/read_section/run', headers, payload: { mission: 'brahmastra', args: { section: 'SEC-99' } } });
    expect(bad.json()).toMatchObject({ ok: false });
    const csv = await app.inject({ method: 'POST', url: '/api/tools/telemetry_window/run', headers, payload: { mission: 'brahmastra', args: { run_id: 'BM-RUN-0010', channels: ['pwr_margin_pu'], end: 5 } } });
    const download = await app.inject({ method: 'GET', url: `/api/artifacts/${csv.json().artifacts[0].id}`, headers });
    expect(download.headers['content-type']).toMatch(/text\/csv/);
    expect(download.body.split('\n')[0]).toBe('mission_elapsed_s,sample_index,delivery_state,pwr_margin_pu');
  });
});
