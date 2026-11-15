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

/** True when the quote (fragments separated by "..." or "…" must appear in order) occurs in the content. */
export function quoteFound(quote: string, content: string): boolean {
  const parts = quote.split(/\.{3}|…/).map(norm).filter((p) => p.length >= 3);
  if (!parts.length) return false;
  for (const hay of [norm(content), norm(valuesOnly(content))]) {
    let from = 0, ok = true;
    for (const p of parts) {
      const i = hay.indexOf(p, from);
      if (i < 0) { ok = false; break; }
      from = i + p.length;
    }
    if (ok) return true;
  }
  return false;
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
