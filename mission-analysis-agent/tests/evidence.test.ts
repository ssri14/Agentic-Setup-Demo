/** Claim validation against the real Mission Document text (SEC-03 p.11, SEC-04 p.16 as extracted by PyMuPDF). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellFound, labelTables, locateSupport, quoteFound } from '../server/src/agent/evidence.js';

const extraction = JSON.parse(readFileSync(new URL('./fixtures/brahmastra/extraction.json', import.meta.url), 'utf8'));
const chunk = (pred: (c: { page: number; kind: string; text: string }) => boolean) => labelTables(extraction.chunks.find(pred).text);
const groupD = chunk((c) => c.page === 11 && c.kind === 'native_text');            // "Subsystem reference / group D", one cell per line
const dictionary = chunk((c) => c.text.includes('HLT, DAQ, COM and SUP'));          // SEC-04 page whose heading lists subsystems

describe('tables in passage text', () => {
  it('turns one-cell-per-line tables into labelled rows', () => {
    expect(groupD).toContain('[table] columns: ID | Subsystem | Observation responsibility | Depends on');
    expect(groupD).toContain('Row 1: ID = HLT; Subsystem = Health Aggregation; Observation responsibility = Collated warnings and degraded-health classifications; Depends on = PWR, THM, ENV, ACT');
    expect(groupD).toContain('Row 2: ID = STG; Subsystem = Stage Event Monitor; Observation responsibility = Observes abstract stage-event status; no mechanism detail; Depends on = SEQ, CLK');
    expect(groupD).toContain('3.10 HLT — Health Aggregation');                        // prose after the table is untouched
  });
  it('does not take page running headers or mid-table rows for column names', () => {
    const headers = extraction.chunks.flatMap((c: { text: string }) => [...labelTables(c.text).matchAll(/\[table\] columns: (.*)/g)].map((m) => m[1]));
    expect(headers.some((h: string) => /ENGINEERING REFERENCE|_/.test(h))).toBe(false);
  });
});

describe('correct table facts', () => {
  it('accepts the quotation recorded in the failing run', () => expect(quoteFound('HLT … Depends on PWR, THM, ENV, ACT', groupD)).toBe(true));
  it('accepts a cell citation, also when the value is worded as a list with "and" or is a subset', () => {
    expect(cellFound({ row: 'HLT', column: 'Depends on', value: 'PWR, THM, ENV, ACT' }, groupD)).toMatch(/^Row 1: ID = HLT;/);
    expect(cellFound({ row: 'HLT', column: 'Depends on', value: 'PWR, THM, ENV and ACT' }, groupD)).toBeTruthy();
    expect(cellFound({ row: 'HLT', column: 'depends on', value: 'PWR and THM' }, groupD)).toBeTruthy();
    expect(cellFound({ row: 'STG', column: 'Depends on', value: 'SEQ, CLK' }, groupD)).toBeTruthy();   // a "; " inside a cell does not split it
  });
  it('locates a reworded claim in its own row', () => {
    expect(locateSupport('HLT depends on the PWR, THM, ENV, and ACT subsystems.', groupD)).toMatch(/^Row 1: ID = HLT;/);
  });
});

describe('incorrect relationships', () => {
  it('rejects a wrong value, row or column in a cell citation', () => {
    expect(cellFound({ row: 'HLT', column: 'Depends on', value: 'DAQ, COM, SUP' }, groupD)).toBeNull();
    expect(cellFound({ row: 'HLT', column: 'Depends on', value: 'PWR, CLK' }, groupD)).toBeNull();
    expect(cellFound({ row: 'STG', column: 'Depends on', value: 'PWR, THM, ENV, ACT' }, groupD)).toBeNull();
    expect(cellFound({ row: 'HLT', column: 'Subsystem', value: 'PWR' }, groupD)).toBeNull();
  });
  it('does not locate a claim in another subject\'s row that merely mentions the same names', () => {
    expect(locateSupport('HLT depends on SUP', groupD)).toBeNull();                 // SAF's row mentions HLT and SUP
    expect(locateSupport('ACT depends on HLT', groupD)).toBeNull();
  });
});

describe('misleading headings', () => {
  it('never treats a list of names as support for a relationship', () => {
    expect(locateSupport('HLT depends on DAQ, COM and SUP', dictionary)).toBeNull();
    expect(cellFound({ row: 'HLT', column: 'Depends on', value: 'DAQ, COM, SUP' }, dictionary)).toBeNull();
  });
});

describe('malformed quotations', () => {
  it('rejects words stitched across table rows', () => {
    expect(quoteFound('HLT … SEQ, CLK', groupD)).toBe(false);
    expect(quoteFound('Health Aggregation … Stage Event Monitor', groupD)).toBe(false);
  });
  it('rejects fragments that are far apart, and words that are not there', () => {
    expect(quoteFound('Health Aggregation … Both must be reconciled', groupD)).toBe(false);
    expect(quoteFound('HLT depends on CLK', groupD)).toBe(false);
  });
  it('accepts fragments of one sentence and tolerates case, punctuation and line breaks', () => {
    expect(quoteFound('HLT consolidates subsystem warnings … classifications', groupD)).toBe(true);
    expect(quoteFound('hlt_warning_count is an observed count; hlt_degraded is a Boolean indicator', groupD)).toBe(true);
    expect(quoteFound('Both must be reconciled with the underlying warning evidence', groupD)).toBe(true);
  });
});
