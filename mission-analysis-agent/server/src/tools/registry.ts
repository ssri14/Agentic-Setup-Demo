/**
 * The mission-scoped tools. Every tool:
 *  - validates its arguments with a Zod schema (the same schema is shown to the model later),
 *  - reads only the mission it is bound to, through the fixed query shapes in sources.ts,
 *  - returns a compact result, evidence references the answer can cite, and CSV artifacts for analysis.
 */
import { z } from 'zod';
import type { Document } from 'mongodb';
import type { Artifact, Mission, Store, User } from '../store/types.js';
import type { Sources } from './sources.js';
import { counts, gridToCsv, safeName, sampleGaps, summarize, toCsv, trim } from './util.js';

export type EvidenceKind = 'passage' | 'section' | 'table' | 'figure' | 'channel' | 'run' | 'telemetry' | 'events' | 'analysis' | 'entity';
export interface Evidence { kind: EvidenceKind; ref: string; label: string; page?: number; section?: string; run_id?: string; start?: number; end?: number }
export interface ArtifactRef { id: string; name: string; kind: Artifact['kind']; rows?: number; columns?: string[] }
export interface ToolResult { summary: string; data: unknown; evidence: Evidence[]; artifacts: ArtifactRef[] }
export interface ToolContext { mission: Mission; user: User; store: Store; sources: Sources }

export class ToolError extends Error {}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  example: z.input<S>;
  needsTelemetry?: boolean;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}
const tool = <S extends z.ZodType>(def: ToolDef<S>) => def;

const KINDS = {
  text: ['native_text', 'vlm_transcription'],
  table: ['native_table', 'vlm_table'],
  figure: ['vlm_description', 'vlm_visual_candidate', 'vlm_figure_reference'],
} as const;
const TABLE_ASSETS = ['native_table', 'vlm_table'];
const FIGURE_ASSETS = ['vlm_figure', 'vlm_visual_candidate', 'vlm_figure_reference'];

// ---------- shared lookups ----------

interface DocRevision { _id: string; name: string; source_sha256: string; extraction_status: string; updated_at?: Date | string }

/** The revision of each source document the agent should read: VLM-enriched if complete, else the newest complete one. */
async function activeDocuments(ctx: ToolContext): Promise<DocRevision[]> {
  const docs = (await ctx.sources.mongo(ctx.mission.mongoDatabase).find('documents', { status: 'complete' },
    { projection: { _id: 1, name: 1, source_sha256: 1, extraction_status: 1, updated_at: 1 } })) as unknown as DocRevision[];
  const bySource = new Map<string, DocRevision>();
  const rank = (d: DocRevision) => [d.extraction_status === 'enriched' ? 1 : 0, Date.parse(String(d.updated_at ?? 0)) || 0];
  for (const d of docs) {
    const best = bySource.get(d.source_sha256);
    const [a1, a2] = rank(d), [b1, b2] = best ? rank(best) : [-1, -1];
    if (!best || a1 > b1 || (a1 === b1 && a2 > b2)) bySource.set(d.source_sha256, d);
  }
  const active = [...bySource.values()];
  if (!active.length) throw new ToolError(`Mission ${ctx.mission.id} has no completely ingested documents yet`);
  return active;
}

async function sectionsById(ctx: ToolContext, ids: string[]) {
  const rows = await ctx.sources.mongo(ctx.mission.mongoDatabase).find('sections', { _id: { $in: [...new Set(ids)] } });
  return new Map(rows.map((s) => [String(s._id), s]));
}

const docName = (docs: DocRevision[], id: string) => docs.find((d) => d._id === id)?.name ?? id.slice(0, 10);

async function saveCsv(ctx: ToolContext, tool: string, name: string, csv: string, columns: string[], rows: number): Promise<ArtifactRef> {
  const a = await ctx.store.artifacts.insert({ userId: ctx.user.id, mission: ctx.mission.id, name: safeName(name), kind: 'csv', content: csv,
    rows, columns, tool, createdAt: new Date().toISOString() });
  return { id: a.id, name: a.name, kind: 'csv', rows, columns };
}

interface RunRecord { _id: string; run_id: string; manifest: Document; counts?: { telemetry: number; mission_events: number }; updated_at?: unknown }

async function resolveRun(ctx: ToolContext, runId: string): Promise<RunRecord> {
  const runs = (await ctx.sources.mongo(ctx.mission.mongoDatabase).find('telemetry_runs', { run_id: runId, status: 'complete' },
    { sort: { updated_at: -1 }, limit: 1 })) as unknown as RunRecord[];
  if (!runs.length) throw new ToolError(`Run ${runId} is not ingested for mission ${ctx.mission.id}; call list_runs for valid IDs`);
  return runs[0];
}

async function channelIds(ctx: ToolContext): Promise<Set<string>> {
  const rows = await ctx.sources.mongo(ctx.mission.mongoDatabase).find('telemetry_channels', {}, { projection: { _id: 1 } });
  return new Set(rows.map((r) => String(r._id)));
}

function tableRows(asset: Document): string[][] {
  if (asset.kind === 'vlm_table') return [asset.columns ?? [], ...(asset.rows ?? [])].filter((r: string[]) => r.length);
  return ((asset.cells ?? []) as (string | null)[][]).map((r) => r.map((c) => (c ?? '').replace(/\s+/g, ' ').trim()));
}

// ---------- the ten tools ----------

const searchDocuments = tool({
  name: 'search_documents',
  description: 'Semantic search over the mission documents. Returns the best-matching passages with section, page, kind and score. Use specific technical wording; filter by kind to find tables or figure descriptions.',
  schema: z.object({
    query: z.string().trim().min(3).max(500),
    limit: z.number().int().min(1).max(10).default(5),
    kinds: z.array(z.enum(['text', 'table', 'figure'])).min(1).optional(),
  }),
  example: { query: 'How are missing source samples distinguished from delayed delivery?', limit: 5 },
  async run(args, ctx) {
    const docs = await activeDocuments(ctx);
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const [profile] = await db.find('configuration', { _id: 'embedding' });
    const embedding = await ctx.sources.embedder.embed([args.query]);
    if (profile && (profile.model !== embedding.model || profile.revision !== embedding.revision)) {
      throw new ToolError(`Embedding service uses ${embedding.model}@${embedding.revision.slice(0, 8)}, but this mission was indexed with ${profile.model}@${String(profile.revision).slice(0, 8)}`);
    }
    const kinds = args.kinds ? args.kinds.flatMap((k) => [...KINDS[k]]) : null;
    const hits = await ctx.sources.vectors.query(ctx.mission.qdrantCollection, embedding.vectors[0], docs.map((d) => d._id), kinds, args.limit);
    const chunks = new Map((await db.find('chunks', { _id: { $in: hits.map((h) => h.chunk_id) } }, { projection: { entities: 0, source_blocks: 0 } }))
      .map((c) => [String(c._id), c]));
    const sections = await sectionsById(ctx, hits.map((h) => h.section_id));
    const passages = hits.filter((h) => chunks.has(h.chunk_id)).map((h) => {
      const c = chunks.get(h.chunk_id)!, s = sections.get(h.section_id);
      return { chunk_id: h.chunk_id, score: Math.round(h.score * 1000) / 1000, document: docName(docs, h.document_id),
        section: s?.label ?? null, section_title: s?.title ?? null, page: c.page, kind: c.kind, text: trim(String(c.text), 1200) };
    });
    return {
      summary: passages.length ? `${passages.length} passages; best ${passages[0].section} p.${passages[0].page} (score ${passages[0].score})` : 'No matching passages',
      data: { query: args.query, passages },
      evidence: passages.map((p) => ({ kind: 'passage' as const, ref: p.chunk_id, label: `${p.section ?? 'Document'} · p.${p.page}`, page: p.page, section: p.section ?? undefined })),
      artifacts: [],
    };
  },
});

const readSection = tool({
  name: 'read_section',
  description: 'Read a whole section in reading order (by label such as "SEC-04", or by section_id from a search), with its previous and next sections, the sections it refers to or is referred by, and related sections.',
  schema: z.object({ section: z.string().trim().min(2).max(80), max_chars: z.number().int().min(1000).max(12000).default(6000) }),
  example: { section: 'SEC-04', max_chars: 6000 },
  async run(args, ctx) {
    const docs = await activeDocuments(ctx);
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const key = args.section.toUpperCase().startsWith('SEC-') ? args.section.toUpperCase() : args.section;
    const [section] = await db.find('sections', { document_id: { $in: docs.map((d) => d._id) }, $or: [{ label: key }, { _id: args.section }] }, { limit: 1 });
    if (!section) {
      const labels = (await db.find('sections', { document_id: { $in: docs.map((d) => d._id) } }, { projection: { label: 1, title: 1 }, sort: { ordinal: 1 } }))
        .map((s) => `${s.label} ${s.title}`);
      throw new ToolError(`No section ${args.section}. Sections: ${labels.join('; ')}`);
    }
    const chunks = await db.find('chunks', { section_id: section._id }, { projection: { text: 1, page: 1, kind: 1, ordinal: 1 }, sort: { ordinal: 1 } });
    let used = 0;
    const parts: { page: number; kind: string; text: string }[] = [];
    for (const c of chunks) {
      if (used >= args.max_chars) break;
      const text = trim(String(c.text), args.max_chars - used);
      used += text.length;
      parts.push({ page: c.page, kind: c.kind, text });
    }
    const links = await ctx.sources.graph.sectionLinks(String(section._id));
    const pick = (rel: string) => links.filter((l) => l.relationship === rel).map((l) => ({ section_id: l.section_id, label: l.label, title: l.title,
      ...(l.score != null ? { score: Math.round(l.score * 1000) / 1000 } : {}), ...(l.keywords ? { shared_terms: l.keywords.slice(0, 6) } : {}) }));
    return {
      summary: `${section.label} ${section.title}: pages ${section.page_start}-${section.page_end}, ${chunks.length} chunks${parts.length < chunks.length ? `, first ${parts.length} shown` : ''}`,
      data: {
        section: { section_id: section._id, label: section.label, title: section.title, pages: [section.page_start, section.page_end], document: docName(docs, section.document_id) },
        content: parts, truncated: parts.length < chunks.length || used >= args.max_chars,
        previous: pick('PREVIOUS')[0] ?? null, next: pick('NEXT')[0] ?? null,
        refers_to: pick('REFERS_TO'), referred_by: pick('REFERRED_BY'),
        related_semantic: pick('RELATED_SEMANTIC'), related_keyword: pick('RELATED_KEYWORD'),
      },
      evidence: [{ kind: 'section', ref: String(section._id), label: `${section.label} ${section.title}`, page: section.page_start, section: section.label }],
      artifacts: [],
    };
  },
});

const getTable = tool({
  name: 'get_table',
  description: 'Fetch document tables as rows: by page, by asset_id from a search result, or by text they contain (a channel name, rule or heading). Native tables are extracted from the PDF; VLM tables are model transcriptions marked unreviewed. Each table is also saved as a CSV artifact for run_analysis.',
  schema: z.object({
    page: z.number().int().min(1).max(10000).optional(),
    asset_id: z.string().min(8).max(80).optional(),
    contains: z.string().trim().min(2).max(100).optional(),
    source: z.enum(['any', 'native', 'vlm']).default('any'),
    max_tables: z.number().int().min(1).max(5).default(3),
  }).refine((a) => a.page || a.asset_id || a.contains, 'Give page, asset_id or contains'),
  example: { contains: 'daq_missing_samples', source: 'vlm', max_tables: 2 },
  async run(args, ctx) {
    const docs = await activeDocuments(ctx);
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const kinds = args.source === 'native' ? ['native_table'] : args.source === 'vlm' ? ['vlm_table'] : TABLE_ASSETS;
    const filter: Document = { document_id: { $in: docs.map((d) => d._id) }, kind: { $in: kinds } };
    if (args.page) filter.page = args.page;
    if (args.asset_id) {
      filter.$or = [{ _id: args.asset_id }];
      const [chunk] = await db.find('chunks', { _id: args.asset_id }, { projection: { asset_id: 1 }, limit: 1 });
      if (chunk?.asset_id) filter.$or.push({ _id: chunk.asset_id });
    }
    let tables = await db.find('assets', filter, { sort: { page: 1 }, limit: 400 });
    // Rank: a cell exactly equal to the search text (a defining row) first, then VLM tables
    // (whole tables) ahead of native fragments, then page order.
    const needle = args.contains?.toLowerCase();
    const score = (t: Document) => {
      if (!needle) return 1;
      const cells = [t.title ?? '', ...tableRows(t).flat()].map((c) => String(c).trim().toLowerCase());
      return cells.includes(needle) ? 2 : cells.some((c) => c.includes(needle)) ? 1 : 0;
    };
    tables = tables.map((t) => ({ t, s: score(t) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (a.t.kind === b.t.kind ? Number(a.t.page) - Number(b.t.page) : a.t.kind === 'vlm_table' ? -1 : 1)).map((x) => x.t);
    const chosen = tables.slice(0, args.max_tables);
    const sections = await sectionsById(ctx, chosen.map((t) => t.section_id));
    const out = [], artifacts: ArtifactRef[] = [];
    for (const t of chosen) {
      const grid = tableRows(t);
      const header = grid[0] ?? [], body = grid.slice(1);
      const section = sections.get(t.section_id)?.label ?? null;
      const name = `table_p${t.page}_${t.kind === 'vlm_table' ? 'vlm' : 'native'}_${String(t._id).slice(0, 6)}`;
      artifacts.push(await saveCsv(ctx, 'get_table', name, gridToCsv(grid), header, body.length));
      out.push({ asset_id: t._id, page: t.page, section, source: t.kind === 'vlm_table' ? 'vlm' : 'native', title: t.title ?? null,
        review_status: t.review_status ?? 'native_extraction', columns: header, rows: body.slice(0, 60), rows_total: body.length,
        ...(body.length > 60 ? { rows_truncated: true } : {}) });
    }
    return {
      summary: out.length ? `${out.length} of ${tables.length} matching tables: ${out.map((t) => `p.${t.page} ${t.source}${t.title ? ` "${trim(t.title, 40)}"` : ''}`).join('; ')}` : 'No matching tables',
      data: { tables: out, matching: tables.length },
      evidence: out.map((t) => ({ kind: 'table' as const, ref: String(t.asset_id), label: `Table p.${t.page}${t.title ? ` · ${trim(String(t.title), 40)}` : ''}`, page: Number(t.page), section: t.section ?? undefined })),
      artifacts,
    };
  },
});

const getFigure = tool({
  name: 'get_figure',
  description: 'Fetch figure captions and VLM descriptions by figure ID (e.g. "FIG-07"), page or text. Figure descriptions are unreviewed model output; caption-anchored figures are the actual figure, references only mention it.',
  schema: z.object({
    figure_id: z.string().trim().regex(/^FIG-\d{2}$/i, 'figure IDs look like FIG-07').optional(),
    page: z.number().int().min(1).max(10000).optional(),
    contains: z.string().trim().min(2).max(100).optional(),
  }).refine((a) => a.figure_id || a.page || a.contains, 'Give figure_id, page or contains'),
  example: { figure_id: 'FIG-03' },
  async run(args, ctx) {
    const docs = await activeDocuments(ctx);
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const filter: Document = { document_id: { $in: docs.map((d) => d._id) }, kind: { $in: FIGURE_ASSETS } };
    if (args.figure_id) filter.figure_id = args.figure_id.toUpperCase();
    if (args.page) filter.page = args.page;
    let figures = await db.find('assets', filter, { sort: { page: 1 }, limit: 200 });
    if (args.contains) {
      const n = args.contains.toLowerCase();
      figures = figures.filter((f) => `${f.figure_id} ${f.caption} ${f.description}`.toLowerCase().includes(n));
    }
    const order = (k: string) => FIGURE_ASSETS.indexOf(k);
    figures.sort((a, b) => order(a.kind) - order(b.kind) || Number(a.page) - Number(b.page));
    const sections = await sectionsById(ctx, figures.map((f) => f.section_id));
    const out = figures.slice(0, 6).map((f) => ({
      asset_id: f._id, figure_id: f.figure_id || null, page: f.page, section: sections.get(f.section_id)?.label ?? null,
      role: f.kind === 'vlm_figure' ? 'figure (caption-anchored)' : f.kind === 'vlm_visual_candidate' ? 'unanchored visual' : 'reference to the figure',
      caption: f.caption, description: trim(String(f.description ?? ''), 1500), review_status: f.review_status, page_image_asset: f.page_asset_id,
    }));
    return {
      summary: out.length ? out.map((f) => `${f.figure_id ?? 'visual'} p.${f.page} (${f.role})`).join('; ') : 'No matching figures',
      data: { figures: out, matching: figures.length },
      evidence: out.map((f) => ({ kind: 'figure' as const, ref: String(f.asset_id), label: `${f.figure_id ?? 'Figure'} · p.${f.page}`, page: Number(f.page), section: f.section ?? undefined })),
      artifacts: [],
    };
  },
});

const lookupChannels = tool({
  name: 'lookup_channels',
  description: 'Look up telemetry channels in the mission dictionary: by exact IDs, by owning subsystem (e.g. "PWR"), or by words in the ID. Adds the document table rows that define each channel (meaning, units, values) where the documents have them.',
  needsTelemetry: true,
  schema: z.object({
    channels: z.array(z.string().trim().min(2).max(64)).max(20).optional(),
    subsystem: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    query: z.string().trim().min(2).max(60).optional(),
  }).refine((a) => a.channels?.length || a.subsystem || a.query, 'Give channels, subsystem or query'),
  example: { subsystem: 'DAQ' },
  async run(args, ctx) {
    const db = ctx.sources.mongo(ctx.mission.mongoDatabase);
    const all = await db.find('telemetry_channels', {}, { sort: { _id: 1 } });
    const words = args.query?.toLowerCase().split(/[\s_]+/).filter(Boolean) ?? [];
    const wanted = all.filter((c) => (args.channels?.includes(String(c._id)) ?? false)
      || (args.subsystem && String(c.owner).toUpperCase() === args.subsystem.toUpperCase())
      || (words.length > 0 && words.every((w) => String(c._id).includes(w))));
    const unknown = (args.channels ?? []).filter((id) => !all.some((c) => c._id === id));
    const docs = await activeDocuments(ctx).catch(() => []);
    const tables = docs.length ? await db.find('assets', { document_id: { $in: docs.map((d) => d._id) }, kind: { $in: TABLE_ASSETS } }, { limit: 500 }) : [];
    const rows = tables.flatMap((t) => { const g = tableRows(t); return g.slice(1).map((r) => ({ header: g[0], row: r, page: t.page, source: t.kind === 'vlm_table' ? 'vlm' : 'native' })); });
    const out = wanted.slice(0, 20).map((c) => {
      const defined = rows.filter((r) => r.row.some((cell) => String(cell).trim() === c._id)).sort((a, b) => (a.source === b.source ? 0 : a.source === 'vlm' ? -1 : 1));
      return { channel: c._id, owner: c.owner, storage_type: c.storage_type, source_reference: c.source_reference ?? null,
        documented: defined.slice(0, 2).map((d) => ({ page: d.page, source: d.source, fields: Object.fromEntries(d.header.map((h, i) => [h || `col${i + 1}`, d.row[i] ?? ''])) })) };
    });
    return {
      summary: `${out.length} channel${out.length === 1 ? '' : 's'}${wanted.length > 20 ? ` (of ${wanted.length})` : ''}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}`,
      data: { channels: out, unknown, dictionary_size: all.length },
      evidence: out.map((c) => ({ kind: 'channel' as const, ref: String(c.channel), label: String(c.channel), page: c.documented[0]?.page })),
      artifacts: [],
    };
  },
});

const listRuns = tool({
  name: 'list_runs',
  description: 'List the ingested telemetry runs with observed versus expected samples, event counts, duration and source time bounds. Use it to find valid run IDs and spot runs with missing samples.',
  needsTelemetry: true,
  schema: z.object({}),
  example: {},
  async run(_args, ctx) {
    const runs = (await ctx.sources.mongo(ctx.mission.mongoDatabase).find('telemetry_runs', { status: 'complete' }, { sort: { run_id: 1, updated_at: -1 } })) as unknown as RunRecord[];
    const latest = new Map<string, RunRecord>();
    for (const r of runs) if (!latest.has(r.run_id)) latest.set(r.run_id, r);
    const out = [...latest.values()].map((r) => ({ run_id: r.run_id, duration_s: r.manifest.duration_s, sampling_hz: r.manifest.sampling_hz,
      expected_samples: r.manifest.expected_samples, observed_samples: r.manifest.observed_samples,
      missing_samples: r.manifest.expected_samples - r.manifest.observed_samples, events: r.manifest.event_count,
      source_time_min: r.manifest.source_time_min, source_time_max: r.manifest.source_time_max }));
    const short = out.filter((r) => r.missing_samples > 0).map((r) => r.run_id);
    return {
      summary: `${out.length} runs${short.length ? `; ${short.length} with missing source samples (${short.join(', ')})` : ''}`,
      data: { runs: out },
      evidence: [{ kind: 'run', ref: `runs:${ctx.mission.id}`, label: `Run list · ${out.length} runs${short.length ? `, ${short.length} short` : ''}` }],
      artifacts: [],
    };
  },
});

const telemetryWindow = tool({
  name: 'telemetry_window',
  description: 'Read selected channels of one run over [start, end) mission-elapsed seconds (at most 1,800 samples). Returns per-channel summaries, value counts for states, delivery states, source sample gaps, a short preview, and the full window as a CSV artifact for run_analysis.',
  needsTelemetry: true,
  schema: z.object({
    run_id: z.string().trim().min(3).max(40),
    channels: z.array(z.string().trim()).min(1).max(12),
    start: z.number().min(0).default(0),
    end: z.number().positive().default(900),
    every_s: z.number().min(0.5).max(60).optional(),
  }).refine((a) => a.end > a.start, 'end must be greater than start'),
  example: { run_id: 'BM-RUN-0001', channels: ['pwr_margin_pu', 'hlt_warning_count', 'daq_missing_samples'], start: 0, end: 120 },
  async run(args, ctx) {
    const run = await resolveRun(ctx, args.run_id);
    const known = await channelIds(ctx);
    const bad = args.channels.filter((c) => !known.has(c));
    if (bad.length) throw new ToolError(`Unknown channels: ${bad.join(', ')}. Use lookup_channels to find valid IDs.`);
    const duration = Number(run.manifest.duration_s ?? 900);
    if (args.start >= duration) throw new ToolError(`start must be below the run duration (${duration} s)`);
    const end = Math.min(args.end, duration);
    const columns = [...new Set(args.channels)];
    // Column names come only from the mission's channel dictionary, never from free text.
    const sql = `SELECT sample_index, mission_elapsed_s, delivery_state, received_time_utc, ${columns.map((c) => `"${c}"`).join(', ')}
      FROM telemetry WHERE dataset_id = $dataset AND time >= $t0 AND time <= $t1
      AND mission_elapsed_s >= $start AND mission_elapsed_s < $end ORDER BY time LIMIT 1800`;
    let rows = await ctx.sources.timeseries.query(ctx.mission.influxDatabase, sql, {
      dataset: run._id, t0: run.manifest.source_time_min, t1: run.manifest.source_time_max, start: args.start, end });
    const hz = Number(run.manifest.sampling_hz ?? 2);
    const gaps = sampleGaps(rows, args.start, end, hz);
    if (args.every_s) rows = rows.filter((r) => Math.abs((Number(r.mission_elapsed_s) / args.every_s!) - Math.round(Number(r.mission_elapsed_s) / args.every_s!)) < 1e-9);
    const expected = Math.round((end - args.start) * hz);
    const channels = Object.fromEntries(columns.map((c) => {
      const values = rows.map((r) => r[c]);
      const numeric = summarize(values);
      return [c, numeric ?? { values: counts(values), first: values[0] ?? null, last: values.at(-1) ?? null }];
    }));
    const csvColumns = ['mission_elapsed_s', 'sample_index', 'delivery_state', ...columns];
    const artifact = await saveCsv(ctx, 'telemetry_window', `${args.run_id}_${args.start}-${end}s`, toCsv(rows, csvColumns), csvColumns, rows.length);
    const preview = [...rows.slice(0, 3), ...(rows.length > 6 ? rows.slice(-3) : rows.slice(3))].map((r) => Object.fromEntries(csvColumns.map((c) => [c, r[c]])));
    return {
      summary: `${args.run_id} ${args.start}-${end} s: ${rows.length} samples${args.every_s ? ` (every ${args.every_s} s)` : ` of ${expected} expected`}${gaps.length ? `, ${gaps.length} source gap${gaps.length > 1 ? 's' : ''}` : ''}`,
      data: { run_id: args.run_id, start: args.start, end, samples: rows.length, expected_samples: expected, source_gaps: gaps,
        delivery_states: counts(rows.map((r) => r.delivery_state)), channels, preview },
      evidence: [{ kind: 'telemetry', ref: `${args.run_id}:${args.start}-${end}:${columns.join(',')}`, label: `${args.run_id} · ${args.start}-${end} s · ${columns.length} channel${columns.length > 1 ? 's' : ''}`, run_id: args.run_id, start: args.start, end }],
      artifacts: [artifact],
    };
  },
});

const eventsWindow = tool({
  name: 'events_window',
  description: 'Read one run\'s event log over [start, end) seconds in source-time order, optionally filtered by subsystem or event types. Shows source versus received time, so delayed reporting is visible. Saved as a CSV artifact.',
  needsTelemetry: true,
  schema: z.object({
    run_id: z.string().trim().min(3).max(40),
    start: z.number().min(0).default(0),
    end: z.number().positive().default(900),
    subsystem: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    types: z.array(z.string().trim().min(2).max(60)).max(10).optional(),
  }).refine((a) => a.end > a.start, 'end must be greater than start'),
  example: { run_id: 'BM-RUN-0001', start: 0, end: 900 },
  async run(args, ctx) {
    const run = await resolveRun(ctx, args.run_id);
    const sql = `SELECT event_seq, mission_elapsed_s, source_time_utc, received_time_utc, subsystem_id, "type", message
      FROM mission_events WHERE dataset_id = $dataset AND time >= $t0 AND time <= $t1
      AND mission_elapsed_s >= $start AND mission_elapsed_s < $end ORDER BY time, event_seq LIMIT 1000`;
    let rows = await ctx.sources.timeseries.query(ctx.mission.influxDatabase, sql, {
      dataset: run._id, t0: run.manifest.source_time_min, t1: run.manifest.source_time_max, start: args.start, end: args.end });
    if (args.subsystem) rows = rows.filter((r) => String(r.subsystem_id).toUpperCase() === args.subsystem!.toUpperCase());
    if (args.types?.length) { const t = new Set(args.types.map((x) => x.toUpperCase())); rows = rows.filter((r) => t.has(String(r.type).toUpperCase())); }
    const events = rows.map((r) => {
      const delay = (Date.parse(String(r.received_time_utc)) - Date.parse(String(r.source_time_utc))) / 1000;
      return { seq: r.event_seq, t_s: r.mission_elapsed_s, subsystem: r.subsystem_id, type: r.type, message: r.message, receipt_delay_s: Math.round(delay * 1000) / 1000 };
    });
    const cols = ['seq', 't_s', 'subsystem', 'type', 'message', 'receipt_delay_s'];
    const artifact = await saveCsv(ctx, 'events_window', `${args.run_id}_events_${args.start}-${args.end}s`, toCsv(events, cols), cols, events.length);
    const delayed = events.filter((e) => e.receipt_delay_s > 1);
    return {
      summary: `${args.run_id}: ${events.length} events in ${args.start}-${args.end} s${delayed.length ? `, ${delayed.length} received more than 1 s late` : ''}`,
      data: { run_id: args.run_id, count: events.length, by_type: counts(events.map((e) => e.type)), events: events.slice(0, 80), events_truncated: events.length > 80 },
      evidence: [{ kind: 'events', ref: `${args.run_id}:events:${args.start}-${args.end}`, label: `${args.run_id} events · ${args.start}-${args.end} s`, run_id: args.run_id, start: args.start, end: args.end }],
      artifacts: [artifact],
    };
  },
});

const runAnalysis = tool({
  name: 'run_analysis',
  description: 'Run Python analysis (pandas, numpy, matplotlib) in an isolated sandbox over CSV artifacts from earlier tools. In the code: df = load_input("<name>"); print(...) for findings; show_table(df, "name"); show_chart(fig, "name"). No files, network or other imports. Inputs are named by artifact name.',
  schema: z.object({
    code: z.string().min(5).max(20000),
    inputs: z.array(z.string().min(8).max(40)).min(1).max(10),
    names: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)).max(10).optional(),
  }).refine((a) => !a.names || a.names.length === a.inputs.length, 'names must match inputs one to one'),
  example: { code: "df = load_input('BM-RUN-0001_0-120s')\nprint(df.describe())", inputs: ['<artifact id from telemetry_window>'] },
  async run(args, ctx) {
    const named: Record<string, string> = {};
    const used: string[] = [];
    for (const [i, id] of args.inputs.entries()) {
      const a = await ctx.store.artifacts.byId(id);
      if (!a || a.userId !== ctx.user.id || a.mission !== ctx.mission.id || a.kind !== 'csv') throw new ToolError(`Artifact ${id} not found among this mission's CSV results`);
      const base = args.names?.[i] ?? a.name;
      let name = base, n = 2;
      while (named[name]) name = `${base}_${n++}`;
      named[name] = a.content;
      used.push(name);
    }
    const result = await ctx.sources.sandbox.run(args.code, named);
    const artifacts: ArtifactRef[] = [];
    for (const t of result.tables ?? []) {
      const header = t.csv.split('\n', 1)[0].split(',');
      artifacts.push(await saveCsv(ctx, 'run_analysis', `analysis_${t.name}`, t.csv, header, t.rows_total));
    }
    for (const c of result.charts ?? []) {
      const a = await ctx.store.artifacts.insert({ userId: ctx.user.id, mission: ctx.mission.id, name: safeName(`chart_${c.name}`), kind: 'png',
        content: c.png_base64, tool: 'run_analysis', createdAt: new Date().toISOString() });
      artifacts.push({ id: a.id, name: a.name, kind: 'png' });
    }
    return {
      summary: result.error ? `Analysis failed: ${trim(result.error, 160)}` : `Analysis ran in ${result.duration_ms ?? '?'} ms; ${result.tables.length} tables, ${result.charts.length} charts`,
      data: { inputs: used, stdout: result.stdout, stdout_truncated: result.stdout_truncated ?? false, error: result.error,
        tables: (result.tables ?? []).map((t) => ({ name: t.name, rows_total: t.rows_total, preview_csv: t.csv.split('\n').slice(0, 21).join('\n') })) },
      evidence: result.error ? [] : [{ kind: 'analysis', ref: artifacts[0]?.id ?? used.join(','), label: `Analysis of ${used.join(', ')}` }],
      artifacts,
    };
  },
});

const graphNeighbours = tool({
  name: 'graph_neighbours',
  description: 'Use the knowledge graph to find where an entity (subsystem such as "DAQ", channel such as "pwr_margin_pu", rule such as "R05", or figure such as "FIG-07") is mentioned, by section, and which other entities are mentioned alongside it.',
  schema: z.object({ entity: z.string().trim().min(2).max(64), limit: z.number().int().min(1).max(25).default(10) }),
  example: { entity: 'DAQ', limit: 8 },
  async run(args, ctx) {
    const docs = await activeDocuments(ctx);
    const result = await ctx.sources.graph.entityNeighbours(ctx.mission.id, args.entity, docs.map((d) => d._id), args.limit);
    if (!result.entity) throw new ToolError(`No entity named ${args.entity} in mission ${ctx.mission.id}. Entities are subsystem IDs, channel IDs, rules (R01) and figures (FIG-01).`);
    return {
      summary: `${result.entity.name}: mentioned in ${result.sections.length} sections${result.sections[0] ? `, most in ${result.sections[0].label}` : ''}; often alongside ${result.related.slice(0, 4).map((r) => r.name).join(', ') || 'nothing else'}`,
      data: result,
      evidence: result.sections.slice(0, 5).map((s) => ({ kind: 'section' as const, ref: s.section_id, label: `${s.label} ${s.title}`, section: s.label })),
      artifacts: [],
    };
  },
});

export const TOOLS = [searchDocuments, readSection, getTable, getFigure, lookupChannels, listRuns, telemetryWindow, eventsWindow, runAnalysis, graphNeighbours];
export type AnyTool = (typeof TOOLS)[number];

export function describeTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, needsTelemetry: Boolean(t.needsTelemetry),
    parameters: z.toJSONSchema(t.schema, { io: 'input' }), example: t.example }));
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult & { duration_ms: number }> {
  const t = TOOLS.find((x) => x.name === name) as ToolDef<z.ZodType> | undefined;
  if (!t) throw new ToolError(`Unknown tool ${name}`);
  if (t.needsTelemetry && !ctx.mission.telemetrySchema) throw new ToolError(`Mission ${ctx.mission.id} has no telemetry`);
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  const started = performance.now();
  const result = await t.run(parsed.data, ctx);
  return { ...result, duration_ms: Math.round(performance.now() - started) };
}
