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
  claim = plain(claim); content = plain(content);
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

/**
 * Typographic dashes and spaces as ASCII. Models often write "BM‑RUN‑0001" with non-breaking hyphens (U+2011) and
 * "100 s" with a narrow no-break space; every comparison below works on this form.
 */
export function plain(s: string): string {
  return s.normalize('NFKC').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-').replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ');
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
  text = plain(text);
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

// Identifiers whose digits are not measurements: BM-RUN-0001 (any case, any dash once plain), SEC-03, R04, P3, E1, S2.1, p.11.
const ID_SPAN = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+\b|\b[A-Za-z]+\d+(?:\.\d+)*\b|\bp\.\s?\d+\b/g;
const blank = (m: string) => ' '.repeat(m.length);

/**
 * The claim with timestamps, identifiers and channel names blanked out, positions preserved, so that the numbers
 * left are stated quantities and can be related to the channel names before them.
 */
function measurementText(text: string): string {
  return plain(text)
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, blank)
    .replace(ID_SPAN, blank)
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, blank);
}

/** Stated numbers with their positions. Integers with leading zeros (0001) are identifier digits, never values. */
function numberSpans(text: string): { n: string; at: number }[] {
  return [...measurementText(text).matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w])/g)]
    .filter((m) => !/^-?0\d+$/.test(m[0]))
    .map((m) => ({ n: m[0], at: m.index! }));
}

/** Numbers stated in a claim, excluding digits that belong to identifiers, references, dates and citations. */
export function numbersIn(text: string): string[] {
  return numberSpans(text).map((x) => x.n);
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
/** Other ways a claim names a record field. */
const FIELD_ALIASES: Record<string, RegExp> = {
  event_seq: /\b(?:event_seq|seq(?:uence)?(?:\s+(?:no\.?|number))?|event\s+#)(?![A-Za-z0-9_])/i,
  sample_index: /\b(?:sample_index|sample\s+#)(?![A-Za-z0-9_])/i,
};
/** A time range ("between 322 and 346.5 s", "from 100 to 101 s") describes a window, not one record. */
const RANGE = /\b(?:between|from)\s+-?\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds)?\s*(?:and|to|-)\s*-?\d+/i;

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
  | { status: 'unparsed'; detail: string }
  | null;

/**
 * Checks a claim about individual records (a telemetry sample or an event) against the records themselves.
 * The run and the time are keys: the time must equal a record's mission_elapsed_s exactly (no rounding).
 * Each stated value is bound to the field named before it (pwr_margin_pu = 0.75, thm_core_temp_pu = 0.46) and
 * compared with that field of the same record; named subsystems, event types and states must be that record's.
 * A quoted message must be in the record's message.
 *  - match: the record at the stated time carries every stated (field, value) pair and named value;
 *  - mismatch: it does not (a factual contradiction);
 *  - absent: no record at the stated time within the window;
 *  - unparsed: the claim is about a record but its values cannot be bound to fields one to one, or it describes
 *    a message without quoting it; neither support nor contradiction can be established mechanically;
 *  - null: not a claim about single records (aggregates, absences, other runs): other checks apply.
 */
export function recordSupport(claim: string, records: RecordRow[], window?: { start?: number; end?: number }): RecordCheck {
  if (!records.length) return null;
  const full = plain(claim);
  // Quoted text (an event message) is compared with the message only; it states no values, times or negations.
  const quoted = [...full.matchAll(/["“]([^"“”]{4,})["”]/g)].map((m) => norm(m[1]));
  claim = full.replace(/["“][^"“”]{4,}["”]/g, blank);
  if (/\b(no|not|missing|absent|without|gaps?|lost|dropouts?|never|none)\b/i.test(claim)) return null;
  if (RANGE.test(claim)) return null;
  const runs = new Set(records.map((r) => String(r.run_id).toUpperCase()));
  const claimRuns = (claim.match(/\b[A-Za-z]{2,}-RUN-\d+\b/gi) ?? []).map((r) => r.toUpperCase());
  if (claimRuns.some((r) => !runs.has(r))) return null;

  const keys = Object.keys(records[0]);
  const fieldRe = (k: string) => FIELD_ALIASES[k] ?? new RegExp(`(^|[^A-Za-z0-9_])${k}(?![A-Za-z0-9_])`);
  const valueKeys = keys.filter((k) => k !== 'mission_elapsed_s' && k !== 'run_id' && (!RECORD_META.has(k) || FIELD_ALIASES[k]));
  const byName = channelMentions(claim, valueKeys.filter((k) => !FIELD_ALIASES[k]));
  const mentioned = [
    ...valueKeys.filter((k) => FIELD_ALIASES[k]).map((k) => { const m = fieldRe(k).exec(claim); return m ? { k, at: m.index + m[0].length } : null; }).filter((x): x is { k: string; at: number } => !!x),
    ...[...new Set(byName.map((m) => m.k))].map((k) => ({ k, at: byName.find((m) => m.k === k)!.end })),
  ].sort((a, b) => a.at - b.at);
  const mentionedKeys = mentioned.map((x) => x.k);
  // Field values the claim names (an event type, a subsystem, an enum state): the record must carry them.
  const tokens = new Set(claim.toUpperCase().match(/[A-Z][A-Z0-9_]*/g) ?? []);
  const textFields = keys.filter((k) => !RECORD_META.has(k) && k !== 'mission_elapsed_s' && records.some((r) => typeof r[k] === 'string' && Number.isNaN(Number(r[k]))));
  const named = textFields.map((k) => ({ k, values: [...new Set(records.map((r) => String(r[k] ?? '').toUpperCase()))].filter((v) => v && tokens.has(v)) })).filter((x) => x.values.length);

  // Times (written as seconds, or as mission_elapsed_s / t) and counts are not values.
  const timeSpans = [...claim.matchAll(/(?:mission_elapsed_s|\bt)\s*(?:=|of)\s*(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/gi)]
    .map((m) => ({ n: m[1] ?? m[2], at: m.index! + m[0].indexOf(m[1] ?? m[2]) }));
  const times = timeSpans.map((x) => x.n);
  const countAt = new Set([...claim.matchAll(/(\d+)\s+(?:samples?|records?|events?|runs?|rows?|channels?|times)\b/gi)].map((m) => m.index!));
  const values = numberSpans(claim).filter((x) => !timeSpans.some((t) => t.at === x.at) && !countAt.has(x.at));
  if (!times.length && !mentionedKeys.length && !named.length) return null;
  if (!times.length && values.length) return null;                          // a value without a time: an aggregate, not one record

  // Bind each stated value to the field named before it; a single field takes values on either side of it.
  const pairs: { k: string; v: string }[] = [];
  const numericFields = valueKeys.filter((k) => !RECORD_META.has(k) && records.some((r) => r[k] !== '' && r[k] !== null && Number.isFinite(Number(r[k]))));
  for (const v of values) {
    const before = mentioned.filter((m) => m.at <= v.at).pop();
    const k = before?.k ?? (mentioned.length === 1 ? mentioned[0].k : !mentioned.length && numericFields.length === 1 ? numericFields[0] : null);
    if (!k) return { status: 'unparsed', detail: `cannot tell which field ${v.n} belongs to; state each value as field = value` };
    pairs.push({ k, v: v.n });
  }
  const perKey = new Map<string, number>();
  for (const p of pairs) perKey.set(p.k, (perKey.get(p.k) ?? 0) + 1);
  if ([...perKey.values()].some((n) => n > 1)) return { status: 'unparsed', detail: `several values follow one field name (${[...perKey].filter(([, n]) => n > 1).map(([k]) => k).join(', ')}); state each value as field = value` };

  // A message: quoted text (in double quotes; apostrophes are not quotes) must be in the record's message; an unquoted description of it cannot be checked here.
  const hasMessages = keys.includes('message');
  if (hasMessages && !quoted.length && /\b(message|says?|said|reading|text)\b/i.test(claim)) return { status: 'unparsed', detail: 'describes the event message without quoting it' };

  // Event claims: every code the claim names (subsystem, event type, state) must be a value of these records. An unknown
  // code (an invented event type, a subsystem not in the window) is never ignored: it is a field value we cannot confirm.
  if (keys.includes('type') && keys.includes('subsystem_id')) {
    const known = new Set(records.flatMap((r) => textFields.map((k) => String(r[k] ?? '').toUpperCase())));
    const codes = [...new Set(claim.replace(ID_SPAN, blank).match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g) ?? [])]
      .filter((w) => (w.includes('_') || (w.length >= 2 && w.length <= 6)) && !STOP.has(w) && !keys.some((k) => k.toUpperCase() === w) && !known.has(w));
    if (codes.length) return { status: 'unparsed', detail: `names ${codes.join(', ')}, which ${codes.length > 1 ? 'are' : 'is'} not a subsystem, event type or state in these records` };
  }

  // Several times: each one is a separate assertion, and each must hold on its own record.
  const distinct = [...new Set(times.map(Number))];
  if (distinct.length > 1) {
    const rowsAt = (t: number) => records.filter((r) => Math.abs(t - Number(r.mission_elapsed_s)) < 1e-9);
    const missing = distinct.filter((t) => !rowsAt(t).length);
    if (missing.length) {
      const inside = missing.every((t) => (window?.start === undefined || t >= window.start) && (window?.end === undefined || t < window.end));
      return inside ? { status: 'absent', detail: `no record at exactly ${missing.join(', ')} s in this window` }
        : { status: 'unparsed', detail: `the evidence does not cover ${missing.join(', ')} s` };
    }
    const lines: string[] = [];
    for (const t of distinct) {
      const res = recordSupport(full.replace(/(?:mission_elapsed_s|\bt)\s*(?:=|of)\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds)\b/gi, ' ') + ` at ${t} s`, rowsAt(t), window);
      if (!res || res.status !== 'match') return res ?? { status: 'unparsed', detail: `cannot check the claim at ${t} s` };
      lines.push(res.line);
    }
    return { status: 'match', line: lines.join('\n') };
  }

  const anchored = times.length ? records.filter((r) => times.some((t) => Math.abs(Number(t) - Number(r.mission_elapsed_s)) < 1e-9)) : records;
  if (times.length && !anchored.length) {
    const inside = times.some((t) => (window?.start === undefined || Number(t) >= window.start) && (window?.end === undefined || Number(t) < window.end));
    return inside ? { status: 'absent', detail: `no record at exactly ${times.join(', ')} s in this window` } : null;
  }
  // A named text field (stg_state, delivery_state) must carry one of the state words the claim states, if it states any.
  // States the claim gives: words written in capitals, record values it names in any case, and the word qualifying a
  // state channel ("a degraded overall health state", "stg_state PENDING").
  const textMentioned = mentionedKeys.filter((k) => textFields.includes(k));
  const knownStates = new Set(records.flatMap((r) => textFields.map((k) => String(r[k] ?? '').toUpperCase())).filter(Boolean));
  const adjacent = byName.filter((m) => textFields.includes(m.k)).flatMap((m) => [/([A-Za-z_]+)\s*$/.exec(claim.slice(0, m.start))?.[1], /^\s*(?:=|:|is|was|of)?\s*([A-Za-z_]+)/.exec(claim.slice(m.end))?.[1]])
    .filter((w): w is string => !!w && !ARTICLE.has(w.toLowerCase()) && !CMP_WORDS.has(w.toLowerCase()) && !keys.includes(w) && !/^[a-z]+_[a-z_]+$/.test(w));
  const stateWords = [...new Set([
    ...(claim.replace(ID_SPAN, blank).match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []).filter((w) => !STOP.has(w) && !keys.some((k) => k.toUpperCase() === w)),
    ...(claim.match(/[A-Za-z][A-Za-z_]+/g) ?? []).map((w) => w.toUpperCase()).filter((w) => knownStates.has(w)),
    ...adjacent.map((w) => w.toUpperCase()),
  ])];
  const agrees = (r: RecordRow) => named.every(({ k, values: vs }) => vs.includes(String(r[k] ?? '').toUpperCase()))
    && textMentioned.every((k) => !stateWords.length || stateWords.includes(String(r[k] ?? '').toUpperCase()))
    && (!hasMessages || quoted.every((q) => norm(String(r.message ?? '')).includes(q)));
  const holds = (r: RecordRow) => agrees(r) && pairs.every(({ k, v }) => numEq(v, r[k]));
  const hit = anchored.find(holds);
  if (hit) return { status: 'match', line: recordLine(hit) };
  const at = anchored[0];
  const wrong = [
    ...pairs.filter(({ k, v }) => !numEq(v, at[k])).map(({ k, v }) => `${k} = ${at[k] ?? 'no value'}, not ${v}`),
    ...named.filter(({ k, values: vs }) => !vs.includes(String(at[k] ?? '').toUpperCase())).map(({ k, values: vs }) => `${k} = ${at[k]}, not ${vs.join(' or ')}`),
    ...textMentioned.filter((k) => stateWords.length && !stateWords.includes(String(at[k] ?? '').toUpperCase())).map((k) => `${k} = ${at[k]}, not ${stateWords.join(' or ')}`),
    ...(hasMessages && quoted.some((q) => !norm(String(at.message ?? '')).includes(q)) ? [`message "${at.message}"`] : []),
  ];
  return { status: 'mismatch', line: recordLine(at), detail: `at ${at.mission_elapsed_s} s the record has ${wrong.join('; ') || 'other values'}` };
}

// ---------------- channel names in prose ----------------

/** Expansions of the words in channel IDs (subsystem prefixes and abbreviations), as analysts write them. */
const WORDS: Record<string, string[]> = {
  pwr: ['power', 'pwr'], thm: ['thermal', 'thm'], daq: ['daq', 'acquisition'], hlt: ['health', 'hlt'], clk: ['clock', 'clk'],
  com: ['comms', 'communication', 'communications', 'link', 'com'], sup: ['supervisor', 'sup'], seq: ['sequencer', 'sequence', 'seq'],
  stg: ['stage', 'staging', 'stg'], cfg: ['configuration', 'config', 'cfg'], act: ['actuator', 'act'], env: ['environment', 'environmental', 'env'],
  temp: ['temperature', 'temp'], pct: ['percent', 'percentage', 'pct'],
};
const PREFIXES = new Set(['pwr', 'thm', 'daq', 'hlt', 'clk', 'com', 'sup', 'seq', 'stg', 'cfg', 'act', 'env']);
const UNITS = new Set(['pu', 'ms', 's', 'hz', 'pct']);
const GENERIC = new Set(['state', 'fault', 'mode', 'warning', 'count', 'id', 'ok', 'level', 'rate', 'delta', 'pending']);
const OPTIONAL = new Set(['overall']);

export type ChannelMention = { k: string; start: number; end: number; exact: boolean };

/**
 * Where a claim names each of the given channels: by its ID (pwr_margin_pu) or in words ("power margin",
 * "core temperature", "DAQ quality", "overall health state"). A phrase that fits two channels equally is not a mention.
 */
export function channelMentions(text: string, keys: string[]): ChannelMention[] {
  text = plain(text);
  const out: ChannelMention[] = [];
  for (const k of keys) for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${k}(?![A-Za-z0-9_])`, 'g'))) out.push({ k, start: m.index!, end: m.index! + k.length, exact: true });
  const masked = out.reduce((s, m) => s.slice(0, m.start) + ' '.repeat(m.end - m.start) + s.slice(m.end), text);
  const words = [...masked.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((m) => ({ w: m[0].toLowerCase().replace(/s$/, ''), raw: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length }));
  const fits = (token: string, w: { w: string; raw: string }) => (WORDS[token] ?? [token]).some((x) => x === w.raw || x === w.w);
  const found: (ChannelMention & { n: number })[] = [];
  for (const k of keys) {
    const parts = k.split('_');
    const prefix = PREFIXES.has(parts[0]) ? parts[0] : null;
    const heads = parts.slice(prefix ? 1 : 0).filter((x, i, a) => !(i === a.length - 1 && UNITS.has(x)) && !OPTIONAL.has(x));
    const need = !heads.length || heads.every((h) => GENERIC.has(h)) ? [...(prefix ? [prefix] : []), ...heads] : heads;
    if (!need.length) continue;
    const span = need.length + 2;
    for (let i = 0; i < words.length; i++) {
      const win = words.slice(i, i + span);
      if (!fits(need[0], win[0]) && !need.some((n) => fits(n, win[0])) && !(prefix && fits(prefix, win[0]))) continue;
      const hit = need.map((n) => win.find((w) => fits(n, w)));
      if (hit.some((h) => !h)) continue;
      const used = [...hit, ...(prefix ? [win.find((w) => fits(prefix, w))] : []), ...words.slice(i, i + span).filter((w) => OPTIONAL.has(w.raw))].filter(Boolean) as typeof words;
      const inSpan = used.filter((w) => w.start >= win[0].start);
      let start = Math.min(...inSpan.map((w) => w.start));
      const end = Math.max(...inSpan.map((w) => w.end));
      for (let j = words.findIndex((w) => w.start === start) - 1; j >= 0 && (OPTIONAL.has(words[j].raw) || (prefix && fits(prefix, words[j]))) && words[j + 1].start - words[j].end <= 2; j--) start = words[j].start;
      if (!found.some((f) => f.k === k && f.start <= start && f.end >= end)) found.push({ k, start, end, exact: false, n: inSpan.length });
    }
  }
  // Keep the most specific reading of overlapping phrases; drop ties between different channels.
  for (const f of found) {
    const rivals = found.filter((g) => g !== f && g.start < f.end && f.start < g.end);
    if (rivals.some((g) => g.n > f.n || (g.n === f.n && g.k !== f.k) || (g.k === f.k && g.end - g.start < f.end - f.start))) continue;
    if (!out.some((o) => o.k === f.k && o.start === f.start)) out.push({ k: f.k, start: f.start, end: f.end, exact: false });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------- comparisons across runs ----------------

export type RecordSet = { evidence: string; records: RecordRow[]; start?: number; end?: number };
const CMP: Record<string, '<' | '>' | '=' | null> = {
  lower: '<', smaller: '<', less: '<', below: '<', fewer: '<', reduced: '<',
  higher: '>', greater: '>', larger: '>', more: '>', above: '>', exceeds: '>', elevated: '>',
  worse: null, better: null, improved: null,
  equal: '=', same: '=', identical: '=', unchanged: '=',
};
const DEGREE = '(?:slightly|marginally|much|significantly|considerably|substantially|somewhat|a\\s+bit|far|notably)';
const LINK = new RegExp(`^\\s*(?:(?:of|for|in)\\s+[A-Za-z]{2,}-RUN-\\d+\\s*)?(?:\\([^)]*\\)\\s*)?(?:is|was|are|were|remains?|stays?|runs?|reads?)?\\s*(?:${DEGREE}\\s+)?$`, 'i');
const LEAD = new RegExp(`^\\s*(?:${DEGREE}\\s+)?$`, 'i');
const CMP_WORDS = new Set(['lower', 'smaller', 'less', 'below', 'fewer', 'reduced', 'higher', 'greater', 'larger', 'more', 'above', 'exceeds', 'elevated', 'worse', 'better', 'improved', 'equal', 'same', 'identical', 'unchanged']);
const ARTICLE = new Set(['a', 'an', 'the', 'its', 'their', 'has', 'had', 'have', 'with', 'and', 'or', 'of', 'in', 'at', 'same', 'different', 'identical', 'equal', 'is', 'was', 'shows', 'show', 'showed', 'reports', 'reported', 'by', 'for', 'to', 'than', 'while', 'whereas', 'but']);

/**
 * Checks a claim that names two or more runs (a comparison, or values side by side) against the records of all the
 * evidence it cites, joined by run ID and the exact time. A comparison needs a reference run ("compared with R",
 * "than R", "versus R"); each comparative word (lower, higher, equal ...) is bound to the channel it qualifies, by ID or
 * in words, and checked numerically on the two records, with any "(a vs b)" pair or "by d" difference it states.
 * A state named for a channel ("a degraded overall health state") must be the subject run's recorded state.
 * Runs not in the cited evidence and times without a record are reported; wording that cannot be bound is "unparsed".
 * Returns null when the claim names fewer than two runs.
 */
export function compareSupport(claim: string, sets: RecordSet[]): RecordCheck {
  const full = plain(claim);
  const text = full.replace(/["“][^"“”]{4,}["”]/g, blank);
  const runAt = [...text.matchAll(/\b[A-Za-z]{2,}-RUN-\d+\b/gi)].map((m) => ({ run: m[0].toUpperCase(), start: m.index!, end: m.index! + m[0].length }));
  const runs = [...new Set(runAt.map((r) => r.run))];
  if (runs.length < 2) return null;
  const all = sets.flatMap((s) => s.records.map((r) => ({ r, s })));
  const missingRuns = runs.filter((run) => !all.some((x) => String(x.r.run_id).toUpperCase() === run));
  if (missingRuns.length) return { status: 'absent', detail: `${missingRuns.join(', ')} ${missingRuns.length > 1 ? 'are' : 'is'} not in the cited evidence (${sets.map((s) => s.evidence).join(', ')})` };
  if (/\b(no|not|missing|absent|without|gaps?|lost|dropouts?|never|none)\b/i.test(text) || RANGE.test(text)) return null;

  const timeSpans = [...text.matchAll(/(?:mission_elapsed_s|\bt)\s*(?:=|of)\s*(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/gi)]
    .map((m) => ({ n: Number(m[1] ?? m[2]), at: m.index! + m[0].indexOf(m[1] ?? m[2]) }));
  const times = [...new Set(timeSpans.map((x) => x.n))];
  if (!times.length) return null;                                          // a comparison over a whole run: an aggregate
  if (times.length > 1) return { status: 'unparsed', detail: 'compares runs at different times; state one time for the comparison' };
  const t = times[0];
  const row: Record<string, RecordRow> = {};
  for (const run of runs) {
    const x = all.find((y) => String(y.r.run_id).toUpperCase() === run && Math.abs(Number(y.r.mission_elapsed_s) - t) < 1e-9);
    if (!x) {
      const s = all.find((y) => String(y.r.run_id).toUpperCase() === run)!.s;
      const inside = (s.start === undefined || t >= s.start) && (s.end === undefined || t < s.end);
      return inside ? { status: 'absent', detail: `no record for ${run} at exactly ${t} s in ${s.evidence}` } : { status: 'unparsed', detail: `${s.evidence} does not cover ${t} s for ${run}` };
    }
    row[run] = x.r;
  }
  const keys = [...new Set(runs.flatMap((r) => Object.keys(row[r])))].filter((k) => !RECORD_META.has(k) && k !== 'mission_elapsed_s');
  const mentions = channelMentions(text, keys);
  const enumValues = (k: string) => new Set(all.map((x) => String(x.r[k] ?? '').toUpperCase()).filter((v) => v && Number.isNaN(Number(v))));
  const isEnum = (k: string) => enumValues(k).size > 0;
  const lines = runs.map((r) => recordLine(row[r])).join('\n');
  const wrong: string[] = [];
  const used = new Set<number>(timeSpans.map((x) => x.at));
  const numAt = numberSpans(text);
  const fmt = (run: string, k: string) => `${run} ${k} = ${row[run][k]}`;

  // Subject and reference: the run after "compared with / than / versus / relative to" is the reference.
  const marker = /\b(?:compared\s+(?:with|to)|relative\s+to|versus|vs\.?|than(?:\s+(?:in|for|that\s+of))?|against)\s*$/i;
  const refs = runAt.filter((r) => marker.test(text.slice(Math.max(0, r.start - 40), r.start)));
  const cmpWords = [...text.matchAll(new RegExp(`\\b(${Object.keys(CMP).join('|')})\\b`, 'gi'))].map((m) => ({ w: m[1].toLowerCase(), start: m.index!, end: m.index! + m[1].length }));

  if (cmpWords.length) {
    const refRuns = [...new Set(refs.map((r) => r.run))];
    if (runs.length !== 2 || refRuns.length !== 1) return { status: 'unparsed', detail: 'a comparison must name two runs and which one is the reference ("compared with R", "than R")' };
    const ref = refRuns[0], subj = runs.find((r) => r !== ref)!;
    for (const c of cmpWords) {
      // Bind the comparative to its channel: "<channel> is (slightly) higher", or "(a) lower <channel>".
      const before = mentions.filter((m) => m.end <= c.start).pop();
      const after = mentions.find((m) => m.start >= c.end);
      const k = before && LINK.test(text.slice(before.end, c.start)) ? before.k : after && LEAD.test(text.slice(c.end, after.start)) ? after.k : null;
      if (!k) return { status: 'unparsed', detail: `cannot tell which channel "${c.w}" refers to` };
      const op = CMP[c.w];
      if (!op) return { status: 'unparsed', detail: `"${c.w}" has no numerical direction; say lower or higher` };
      const a = row[subj][k], b = row[ref][k];
      if (isEnum(k)) {
        if (op !== '=') return { status: 'unparsed', detail: `"${c.w}" is not defined for the state channel ${k}` };
        if (String(a) !== String(b)) wrong.push(`${fmt(subj, k)} and ${fmt(ref, k)} are not the same`);
        continue;
      }
      const x = Number(a), y = Number(b);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { wrong.push(`${k} is not recorded for both runs at ${t} s`); continue; }
      const holds = op === '<' ? x < y : op === '>' ? x > y : Math.abs(x - y) < 1e-9;
      if (!holds) wrong.push(`${fmt(subj, k)} is not ${op === '=' ? 'equal to' : `${c.w} than`} ${fmt(ref, k)}`);
      // Stated figures: "(a vs b)" are the subject's and the reference's values; "by d" is their difference.
      const mention = before?.k === k ? before : after!;
      const tail = text.slice(Math.max(c.end, mention.end), Math.max(c.end, mention.end) + 60);
      const pair = /^\s*,?\s*\(\s*(-?\d+(?:\.\d+)?)\s*(?:vs\.?|versus|against|compared\s+(?:with|to))\s*(-?\d+(?:\.\d+)?)\s*\)/i.exec(tail);
      const BY = /^\s*(?:than\s+(?:in\s+|for\s+)?[A-Za-z]{2,}-RUN-\d+\s*,?\s*)?(?:\([^)]*\)\s*)?by\s+(-?\d+(?:\.\d+)?)/i;
      const by = BY.exec(tail) ?? BY.exec(text.slice(c.end, c.end + 60));
      const base = Math.max(c.end, mention.end);
      if (pair) {
        if (!numEq(pair[1], x) || !numEq(pair[2], y)) wrong.push(`${k} is ${x} in ${subj} and ${y} in ${ref}, not ${pair[1]} vs ${pair[2]}`);
        for (const n of numAt) if (n.at >= base && n.at < base + pair[0].length + 1) used.add(n.at);
      }
      if (by) {
        if (!numEq(by[1], Math.abs(x - y))) wrong.push(`the ${k} difference is ${Number(Math.abs(x - y).toFixed(6))}, not ${by[1]}`);
        for (const n of numAt) if (n.n === by[1] && n.at >= c.end && n.at < base + 60) used.add(n.at);
      }
    }
    // States named for the subject: "a degraded overall health state", "hlt_overall_state DEGRADED".
    for (const m of mentions.filter((m) => isEnum(m.k))) {
      const prev = /([A-Za-z_]+)\s*$/.exec(text.slice(0, m.start))?.[1];
      const next = /^\s*(?:=|:|is|was|of)?\s*([A-Z][A-Z_]{2,})\b/.exec(text.slice(m.end))?.[1];
      const pairState = /^\s*\(\s*([A-Za-z_]+)\s*(?:vs\.?|versus)\s*([A-Za-z_]+)\s*\)/i.exec(text.slice(m.end));
      if (pairState) {
        if (String(row[subj][m.k]).toUpperCase() !== pairState[1].toUpperCase() || String(row[ref][m.k]).toUpperCase() !== pairState[2].toUpperCase())
          wrong.push(`${fmt(subj, m.k)} and ${fmt(ref, m.k)}, not ${pairState[1]} vs ${pairState[2]}`);
        continue;
      }
      for (const s of [prev, next].filter((v): v is string => !!v && !ARTICLE.has(v.toLowerCase()) && !CMP[v.toLowerCase()])) {
        if (!enumValues(m.k).has(s.toUpperCase())) return { status: 'unparsed', detail: `"${s}" is not a recorded state of ${m.k}` };
        if (String(row[subj][m.k]).toUpperCase() !== s.toUpperCase()) wrong.push(`${fmt(subj, m.k)}, not ${s.toUpperCase()}`);
      }
    }
    const stray = numAt.filter((n) => !used.has(n.at));
    if (stray.length) return { status: 'unparsed', detail: `cannot tell what ${stray.map((n) => n.n).join(', ')} refer${stray.length > 1 ? '' : 's'} to; give values as (subject vs reference)` };
    return wrong.length ? { status: 'mismatch', line: lines, detail: `at ${t} s ${wrong.join('; ')}` } : { status: 'match', line: lines };
  }

  // No comparison: values side by side. Each run's part of the claim is checked on that run's record.
  const firstRun = runAt[0].start;
  for (let i = 0; i < runAt.length; i++) {
    const seg = text.slice(i === 0 ? 0 : runAt[i].start, i + 1 < runAt.length ? runAt[i + 1].start : text.length);
    if (i === 0 && !numberSpans(seg.slice(firstRun)).length && !channelMentions(seg, keys).length) continue;
    const res = recordSupport(`${seg} at ${t} s`, [row[runAt[i].run]]);
    if (!res) return { status: 'unparsed', detail: `cannot check the part about ${runAt[i].run}` };
    if (res.status === 'unparsed') return res;
    if (res.status === 'mismatch') wrong.push(`${runAt[i].run}: ${res.detail}`);
  }
  return wrong.length ? { status: 'mismatch', line: lines, detail: wrong.join('; ') } : { status: 'match', line: lines };
}
