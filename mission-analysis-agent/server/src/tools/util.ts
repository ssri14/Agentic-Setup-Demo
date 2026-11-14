/** Small helpers shared by the tools: CSV, statistics, text trimming, identifiers. */

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export function gridToCsv(grid: (string | null)[][]): string {
  const cell = (v: string | null) => {
    const s = v ?? '';
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return grid.map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

export const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface NumericSummary { count: number; min: number; max: number; mean: number; first: number; last: number }

export function summarize(values: unknown[]): NumericSummary | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  return { count: nums.length, min: round(Math.min(...nums)), max: round(Math.max(...nums)),
    mean: round(nums.reduce((a, b) => a + b, 0) / nums.length), first: round(nums[0]), last: round(nums.at(-1)!) };
}

export function counts(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) { const k = String(v); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export interface SampleGap { from_s: number; to_s: number; missing_samples: number; note?: string }

/**
 * Samples absent at the source within [start, end): gaps between consecutive sample indices, plus
 * gaps at either edge of the window measured against the expected sampling grid.
 */
export function sampleGaps(rows: { sample_index?: unknown; mission_elapsed_s?: unknown }[], start: number, end: number, hz: number): SampleGap[] {
  const firstExpected = Math.ceil(start * hz - 1e-9), lastExpected = Math.ceil(end * hz - 1e-9) - 1;
  const at = (index: number) => Math.round((index / hz) * 1000) / 1000;
  const indices = rows.map((r) => Number(r.sample_index)).filter(Number.isFinite);
  if (!indices.length) return lastExpected >= firstExpected ? [{ from_s: at(firstExpected), to_s: at(lastExpected), missing_samples: lastExpected - firstExpected + 1, note: 'no samples in the window' }] : [];
  const gaps: SampleGap[] = [];
  if (indices[0] > firstExpected) gaps.push({ from_s: at(firstExpected), to_s: at(indices[0] - 1), missing_samples: indices[0] - firstExpected, note: 'starts before the window' });
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] > 1) gaps.push({ from_s: at(indices[i - 1] + 1), to_s: at(indices[i] - 1), missing_samples: indices[i] - indices[i - 1] - 1 });
  }
  const last = indices.at(-1)!;
  if (last < lastExpected) gaps.push({ from_s: at(last + 1), to_s: at(lastExpected), missing_samples: lastExpected - last, note: 'continues past the window' });
  return gaps;
}

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z]+/, 'x_').slice(0, 60) || 'input';
