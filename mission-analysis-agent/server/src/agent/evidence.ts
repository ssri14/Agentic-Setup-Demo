/**
 * Evidence content as the models see it, and deterministic checks against it.
 *
 * - Tables (structured tables and pipe-table text) are rendered as self-describing rows,
 *   "Row 1: ID = HLT; Subsystem = Health Aggregation; …; Depends on = PWR, THM, ENV, ACT",
 *   so a value is never read without its column, and a heading is never mistaken for a row.
 * - quoteFound() checks that a claim's quoted words really occur in the evidence it cites.
 * - relatedLines() finds lines anywhere in the evidence that mention the same identifiers as a claim,
 *   so the checker sees the row that states a fact next to the claim about it.
 */

export const MAX_CONTENT = 4000;

export function labelRows(columns: string[], rows: string[][]): string[] {
  return rows.map((r, i) => `Row ${i + 1}: ${columns.map((c, j) => `${(c || `column ${j + 1}`).trim()} = ${String(r[j] ?? '').trim()}`).join('; ')}`);
}

/** Rewrites runs of "a | b | c" lines (a header and rows with the same number of cells) as labelled rows. */
export function labelPipeTables(text: string): string {
  const lines = text.split('\n');
  const cells = (l: string) => l.split('|').map((x) => x.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].includes(' | ')) {
      const header = cells(lines[i]);
      const rows: string[][] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].includes(' | ') && cells(lines[j]).length === header.length) rows.push(cells(lines[j++]));
      if (rows.length) { out.push(`[table] columns: ${header.join(' | ')}`, ...labelRows(header, rows)); i = j; continue; }
    }
    out.push(lines[i++]);
  }
  return out.join('\n');
}

/**
 * Rewrites tables that PDF text extraction keeps one cell per line, one row per block:
 *   "ID\nSubsystem\nDepends on\n\nHLT\nHealth Aggregation\nPWR, THM, ENV, ACT\n\nSTG\n…"
 * A header block of 2–8 short lines followed by blocks with the same number of lines becomes labelled rows.
 */
export function labelBlockTables(text: string): string {
  const blocks = text.split(/\n[ \t]*\n/);
  const lines = (b: string) => b.split('\n').map((l) => l.trim()).filter(Boolean);
  // Column names are short labels: not sentences, not identifiers like channel names, not page running headers.
  const headerLike = (cells: string[]) => cells.length >= 2 && cells.length <= 8
    && cells.every((c) => c.length <= 40 && !/[.:;]$/.test(c) && !c.includes(' | ') && !/\s{2,}/.test(c) && !/[a-z0-9]_[a-z0-9]/i.test(c) && !/^\d/.test(c));
  const out: string[] = [];
  for (let i = 0; i < blocks.length;) {
    const header = lines(blocks[i]);
    if (headerLike(header)) {
      const rows: string[][] = [];
      let j = i + 1;
      while (j < blocks.length && lines(blocks[j]).length === header.length && lines(blocks[j]).every((c) => c.length <= 160)) rows.push(lines(blocks[j++]));
      if (rows.length >= (header.length === 2 ? 2 : 1)) { out.push([`[table] columns: ${header.join(' | ')}`, ...labelRows(header, rows)].join('\n')); i = j; continue; }
    }
    out.push(blocks[i++]);
  }
  return out.join('\n\n');
}

/** Both table layouts that PDF text can carry: one cell per line, and "a | b | c" lines. */
export const labelTables = (text: string) => labelPipeTables(labelBlockTables(text));

/** A table fact a claim can cite instead of a quote: the row's key, the column and the value in that cell. */
export interface CellRef { row: string; column: string; value: string }

const listTokens = (s: string) => new Set(norm(s).split(' ').filter((w) => w && !['and', 'or', 'the', 'subsystem', 'subsystems'].includes(w)));

/**
 * The labelled row in the content that states the cell, or null. The row matches when one of its cells equals the key;
 * the column by name; the value when its items equal the cell's or are a subset of them ("PWR and THM" ⊂ "PWR, THM, ENV, ACT").
 */
export function cellFound(cell: CellRef, content: string): string | null {
  const key = norm(cell.row), col = norm(cell.column), want = listTokens(cell.value);
  if (!key || !col || !want.size) return null;
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^Row \d+: (.*)$/);
    if (!m) continue;
    const cells = m[1].split(/;\s+(?=[^;=]{1,60} = )/).map((c) => { const k = c.indexOf(' = '); return k < 0 ? ['', c] : [c.slice(0, k), c.slice(k + 3)]; });
    if (!cells.some(([, v]) => norm(v) === key)) continue;
    const target = cells.find(([k]) => norm(k) === col) ?? cells.find(([k]) => norm(k).includes(col) || (col.includes(norm(k)) && norm(k).length > 2));
    if (!target) continue;
    const have = listTokens(target[1]);
    if ([...want].every((w) => have.has(w))) return line.trim();
  }
  return null;
}

/**
 * When a quote does not match character for character, find the line of the cited evidence that carries the claim:
 * a labelled row or a sentence mentioning every identifier of the claim (at least two). Used only alongside
 * the checker's own "supported" verdict, never on its own.
 */
export function locateSupport(claim: string, content: string): string | null {
  const ids = identifiers(claim);
  if (ids.length < 2) return null;
  const has = (line: string, id: string) => new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[-]/g, '\\-')}([^A-Za-z0-9_]|$)`).test(line);
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const row = line.match(/^Row \d+: (.*)$/);
    if (row) {
      // A table row supports a claim only about its own subject: the row's key (first cell) must be the claim's
      // first identifier, and every other identifier must appear in the row's other cells.
      const cells = row[1].split(/;\s+(?=[^;=]{1,60} = )/).map((c) => c.slice(c.indexOf(' = ') + 3));
      if (norm(cells[0] ?? '') !== norm(ids[0])) continue;
      const rest = cells.slice(1).join(' ; ');
      if (ids.slice(1).every((id) => has(rest, id))) return line;
      continue;
    }
    // A sentence must say something besides the names: a heading or list such as "HLT, DAQ, COM and SUP" states no relationship.
    const says = (x: string) => norm(x).split(' ').filter((w) => !ids.some((id) => norm(id) === w) && !['and', 'or', 'the', 'of', 'to', 'a'].includes(w) && /[a-z]{3,}/.test(w)).length >= 3;
    const sentence = line.split(/(?<=[.!?])\s+/).find((x) => x.length > 3 && ids.every((id) => has(x, id)) && says(x));
    if (sentence) return sentence.trim();
  }
  return null;
}

export function tableContent(t: { title?: string | null; section?: string | null; page?: number; source?: string; columns: string[]; rows: string[][]; rows_total?: number }): string {
  const head = `[table${t.title ? ` "${t.title}"` : ''}${t.section ? `, ${t.section}` : ''}${t.page ? `, p.${t.page}` : ''}${t.source ? `, ${t.source}` : ''}] columns: ${t.columns.join(' | ')}`;
  const more = t.rows_total && t.rows_total > t.rows.length ? `\n(${t.rows_total - t.rows.length} more rows not shown)` : '';
  return [head, ...labelRows(t.columns, t.rows)].join('\n') + more;
}

/** Lower-case, unify quotes and dashes, keep letters, digits and a few joiners, collapse whitespace. */
export function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^a-z0-9_.%+\-]+/g, ' ')
    .replace(/(^|\s)[.\-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** The same text with "Column = " labels removed, so a quote of the raw row ("HLT | … | PWR, THM, ENV, ACT") still matches. */
const valuesOnly = (content: string) => content.replace(/(^|;\s*|Row \d+:\s*)[^=;\n]{1,60}? = /g, '$1');

/**
 * True when the quote occurs in the content. A single span may be anywhere. Fragments joined by "..." or "…" must
 * appear in order within one paragraph or one table row: words stitched from different rows, headings or paragraphs do not match.
 */
export function quoteFound(quote: string, content: string): boolean {
  const parts = quote.split(/\.{3}|…/).map(norm).filter((p) => p.length >= 3);
  if (!parts.length) return false;
  if (parts.length === 1) return [content, valuesOnly(content)].some((h) => norm(h).includes(parts[0]));
  const inOrder = (hay: string) => {
    let from = 0;
    for (const p of parts) { const i = hay.indexOf(p, from); if (i < 0) return false; from = i + p.length; }
    return true;
  };
  const units = content.split(/\n[ \t]*\n/).flatMap((par) => {
    const lines = par.split('\n');
    return lines.some((l) => /^Row \d+: /.test(l.trim())) ? lines : [par];
  });
  return units.some((u) => inOrder(norm(u)) || inOrder(norm(valuesOnly(u))));
}

const STOP = new Set(['THE', 'AND', 'FOR', 'NOT', 'ALL', 'ANY', 'ARE', 'BUT', 'ITS', 'HAS', 'WAS', 'ONE', 'TWO', 'PDF', 'ID', 'OK', 'NO', 'OR', 'IF', 'IS', 'IT', 'OF', 'ON', 'TO', 'IN', 'AT', 'BY', 'AN', 'AS', 'BE', 'UTC']);

/** Identifiers a claim is about: subsystem codes, channel names, section/figure/run/rule IDs. */
export function identifiers(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b(?:SEC|FIG|BM-RUN)-\d+\b|\bR\d{2}\b|\bP\d[A-Z]?\b|\b[A-Z][A-Z0-9]{1,5}\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    if (!STOP.has(m[0])) ids.add(m[0]);
  }
  return [...ids];
}

/** Lines of evidence content that mention the claim's identifiers; rows mentioning several of them first. */
export function relatedLines(claim: string, items: { id: string; content: string }[], max = 10): string[] {
  const ids = identifiers(claim);
  if (!ids.length) return [];
  const re = ids.map((id) => new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[-]/g, '\\-')}([^A-Za-z0-9_]|$)`));
  const scored: { line: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const e of items) {
    for (const raw of e.content.split('\n')) {
      const line = raw.trim();
      if (line.length < 4 || line.length > 600) continue;
      const hits = re.filter((r) => r.test(line)).length;
      if (!hits) continue;
      const key = `${e.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({ line: `${e.id}: ${line}`, score: hits * 2 + (line.startsWith('Row ') ? 1 : 0) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.line);
}

// ---------------- numbers and structured records ----------------

/** Numbers stated in a claim, excluding digits that belong to identifiers, references, dates and citations. */
export function numbersIn(text: string): string[] {
  const stripped = text
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, ' ')                                    // timestamps
    .replace(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b|\b[A-Z]+\d+(?:\.\d+)*\b|\bp\.\s?\d+\b/g, ' ')   // BM-RUN-0001, SEC-03, R04, P3, E1, S2.1, p.11
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');                                  // channel names
  return [...stripped.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w])/g)].map((m) => m[0]);
}

/**
 * A stated number equals a recorded value when it is the recorded value rounded to the stated precision
 * and within 0.5 % of it: 0.866 and 0.87 for 0.8664, but not 0.9.
 */
export function numEq(stated: string, recorded: unknown): boolean {
  const a = Number(stated), b = Number(recorded);
  if (!Number.isFinite(a) || !Number.isFinite(b) || recorded === '' || recorded === null) return false;
  if (Math.abs(a - b) < 1e-9) return true;
  const decimals = stated.includes('.') ? stated.split('.')[1].length : 0;
  return Math.abs(Number(b.toFixed(decimals)) - a) < 1e-9 && Math.abs(a - b) <= 0.005 * Math.abs(b);
}

/** Every number the claim states appears in the text (to the claim's precision). */
export function numbersSupported(claim: string, support: string): { ok: boolean; missing: string[] } {
  const have = numbersIn(support);
  const missing = numbersIn(claim).filter((n) => !have.some((h) => numEq(n, h)));
  return { ok: !missing.length, missing };
}

export type RecordRow = Record<string, unknown>;
const RECORD_META = new Set(['run_id', 'sample_index', 'event_seq', 'message', 'receipt_delay_s', 'received_time_utc', 'source_time_utc']);

export const recordLine = (r: RecordRow) => `Record: ${Object.entries(r).map(([k, v]) => `${k} = ${v ?? ''}`).join('; ')}`;

/** Telemetry or event records as labelled lines for the models, first and last ones if there are many. */
export function recordsContent(header: string, records: RecordRow[], max = 60): string {
  const shown = records.length > max ? [...records.slice(0, max / 2), ...records.slice(-max / 2)] : records;
  const lines = shown.map(recordLine);
  if (records.length > max) lines.splice(max / 2, 0, `(${records.length - max} records not shown)`);
  return [header, ...lines].join('\n');
}

export type RecordCheck =
  | { status: 'match'; line: string }
  | { status: 'mismatch'; line: string; detail: string }
  | { status: 'absent'; detail: string }
  | null;

/**
 * Checks a claim about individual records (a telemetry sample or an event) against the records themselves:
 * run, time (mission_elapsed_s), channel or field, and value. Returns null when the claim is not about
 * single records (aggregates, absences, other runs), so other checks apply.
 *  - match: a record at the stated time carries every stated value and every named field value;
 *  - mismatch: the record at the stated time has a different value (a factual contradiction);
 *  - absent: no record at the stated time within the window.
 */
export function recordSupport(claim: string, records: RecordRow[], window?: { start?: number; end?: number }): RecordCheck {
  if (!records.length) return null;
  if (/\b(no|not|missing|absent|without|gaps?|lost|dropouts?|never|none)\b/i.test(claim)) return null;
  const runs = new Set(records.map((r) => String(r.run_id)));
  const claimRuns = claim.match(/\b[A-Z]{2,}-RUN-\d+\b/g) ?? [];
  if (claimRuns.some((r) => !runs.has(r))) return null;

  const keys = Object.keys(records[0]);
  const mentionedKeys = keys.filter((k) => !RECORD_META.has(k) && k !== 'mission_elapsed_s' && new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(claim));
  // Field values the claim names (an event type, a subsystem, an enum state): the record must carry them.
  const tokens = new Set(claim.toUpperCase().match(/[A-Z][A-Z0-9_]*/g) ?? []);
  const textFields = keys.filter((k) => !RECORD_META.has(k) && k !== 'mission_elapsed_s' && records.some((r) => typeof r[k] === 'string' && Number.isNaN(Number(r[k]))));
  const named = textFields.map((k) => ({ k, values: [...new Set(records.map((r) => String(r[k] ?? '').toUpperCase()))].filter((v) => v && tokens.has(v)) })).filter((x) => x.values.length);

  // Times: numbers written as seconds, or given as mission_elapsed_s / t.
  const times = [...claim.matchAll(/(?:mission_elapsed_s|\bt)\s*(?:=|of)\s*(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/gi)].map((m) => m[1] ?? m[2]);
  const counts = [...claim.matchAll(/(\d+)\s+(?:samples?|records?|events?|runs?|rows?|channels?|times)\b/gi)].map((m) => m[1]);
  const values = numbersIn(claim).filter((n) => !times.includes(n) && !counts.includes(n));
  if (!times.length && !mentionedKeys.length && !named.length) return null;
  if (!times.length && values.length) return null;                          // a value without a time: an aggregate, not one record

  const anchored = times.length ? records.filter((r) => times.some((t) => numEq(t, r.mission_elapsed_s))) : records;
  if (times.length && !anchored.length) {
    const inside = times.some((t) => (window?.start === undefined || Number(t) >= window.start) && (window?.end === undefined || Number(t) < window.end));
    return inside ? { status: 'absent', detail: `no record at ${times.join(', ')} s in this window` } : null;
  }
  // A named text field (stg_state, delivery_state) must carry one of the state words the claim states, if it states any.
  const stateWords = [...tokens].filter((w) => /^[A-Z][A-Z_]{2,}$/.test(w) && !(claimRuns as string[]).includes(w) && !keys.some((k) => k.toUpperCase() === w));
  const textMentioned = mentionedKeys.filter((k) => textFields.includes(k));
  const agrees = (r: RecordRow) => named.every(({ k, values: vs }) => vs.includes(String(r[k] ?? '').toUpperCase()))
    && textMentioned.every((k) => !stateWords.length || stateWords.includes(String(r[k] ?? '').toUpperCase()));
  const valueFields = (r: RecordRow) => (mentionedKeys.length ? mentionedKeys : keys.filter((k) => !RECORD_META.has(k) && k !== 'mission_elapsed_s')).map((k) => r[k]);
  const holds = (r: RecordRow) => agrees(r) && values.every((v) => valueFields(r).some((x) => numEq(v, x)));
  const hit = anchored.find(holds);
  if (hit) return { status: 'match', line: recordLine(hit) };
  const at = anchored[0];
  const shown = (mentionedKeys.length ? mentionedKeys : named.map((x) => x.k)).map((k) => `${k} = ${at[k]}`).join(', ');
  const stated = [...values, ...named.flatMap((x) => x.values), ...(textMentioned.length ? stateWords : [])].filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return { status: 'mismatch', line: recordLine(at), detail: `at ${at.mission_elapsed_s} s the record has ${shown || 'other values'}${stated ? `, not ${stated}` : ''}` };
}
