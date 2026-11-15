/** Claim validation against the real Mission Document text (SEC-03 p.11, SEC-04 p.16 as extracted by PyMuPDF). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellFound, labelTables, locateSupport, numbersIn, numbersSupported, quoteFound, recordSupport } from '../server/src/agent/evidence.js';

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

// ---------------- structured records: telemetry samples and events (real BM-RUN-0010 data) ----------------
const csvRows = (text: string) => { const [head, ...lines] = text.trim().split('\n'); const cols = head.split(','); return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]))); };
const run10 = csvRows(readFileSync(new URL('./fixtures/brahmastra/BM-RUN-0010_telemetry.csv', import.meta.url), 'utf8'))
  .map((r) => ({ run_id: 'BM-RUN-0010', mission_elapsed_s: Number(r.mission_elapsed_s), sample_index: Number(r.sample_index), delivery_state: r.delivery_state,
    pwr_bus_level_pu: Number(r.pwr_bus_level_pu), pwr_margin_pu: Number(r.pwr_margin_pu), thm_core_temp_pu: Number(r.thm_core_temp_pu), daq_missing_samples: Number(r.daq_missing_samples), stg_state: r.stg_state }));
const samples = (start: number, end: number) => run10.filter((r) => r.mission_elapsed_s >= start && r.mission_elapsed_s < end);
const events10 = readFileSync(new URL('./fixtures/brahmastra/BM-RUN-0010_events.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .map((e) => ({ run_id: 'BM-RUN-0010', event_seq: e.event_seq, mission_elapsed_s: e.mission_elapsed_s, subsystem_id: e.subsystem_id, type: e.type, message: e.message, receipt_delay_s: 0 }));

describe('numbers in claims', () => {
  it('reads stated values, not digits inside identifiers, references or timestamps', () => {
    expect(numbersIn('pwr_bus_level_pu = 0.856 pu at mission_elapsed_s = 100 in run BM-RUN-0001 (SEC-03 p.11, E1, R04)')).toEqual(['0.856', '100']);
    expect(numbersIn('received at 2026-01-01T00:05:47.000Z')).toEqual([]);
  });
  it('compares to the precision stated', () => {
    expect(numbersSupported('value 0.866', 'Record: pwr_bus_level_pu = 0.8664').ok).toBe(true);
    expect(numbersSupported('value 0.87', 'Record: pwr_bus_level_pu = 0.8664').ok).toBe(true);
    expect(numbersSupported('value 0.9', 'Record: pwr_bus_level_pu = 0.8664').ok).toBe(false);
  });
});

describe('telemetry records', () => {
  const w = samples(100, 101);
  const at = (claim: string) => recordSupport(claim, w, { start: 100, end: 101 });
  it('accepts the observed claim form, and other phrasings, without any quotation', () => {
    expect(at('pwr_bus_level_pu = 0.866 pu at mission_elapsed_s = 100 in run BM-RUN-0010')).toMatchObject({ status: 'match', line: expect.stringContaining('mission_elapsed_s = 100; sample_index = 200') });
    expect(at('At 100 s in BM-RUN-0010, pwr_bus_level_pu was 0.8664')?.status).toBe('match');
    expect(at('pwr_bus_level_pu was 0.867 at 100.5 seconds')?.status).toBe('match');
  });
  it('rejects a wrong value at the stated time, citing the record', () => {
    expect(at('pwr_bus_level_pu = 0.9 pu at mission_elapsed_s = 100 in run BM-RUN-0010')).toEqual({ status: 'mismatch', line: expect.stringContaining('pwr_bus_level_pu = 0.8664'), detail: 'at 100 s the record has pwr_bus_level_pu = 0.8664, not 0.9' });
    expect(at('pwr_bus_level_pu was 0.8664 at 100.5 s')?.status).toBe('mismatch');          // right value, wrong time
  });
  it('rejects a wrong enum state and reports a time with no record', () => {
    expect(recordSupport('At 347 s stg_state was PENDING', samples(340, 350))?.status).toBe('mismatch');
    expect(recordSupport('At 347 s stg_state was CONFIRMED', samples(340, 350))?.status).toBe('match');
    expect(recordSupport('pwr_bus_level_pu was 0.86 at 330 s', samples(320, 350), { start: 320, end: 350 })).toEqual({ status: 'absent', detail: 'no record at exactly 330 s in this window' });
  });
  it('leaves aggregates, absences and other runs to the other checks', () => {
    expect(at('The maximum of pwr_bus_level_pu was 0.8671')).toBeNull();
    expect(recordSupport('BM-RUN-0010 has no samples between 322 and 346.5 s', samples(320, 350))).toBeNull();
    expect(at('pwr_bus_level_pu = 0.856 at 100 s in BM-RUN-0001')).toBeNull();
  });
});

describe('event records', () => {
  it('accepts an event by type, subsystem and time', () => {
    expect(recordSupport('DAQ_CAPTURE_RESUMED was raised by DAQ at 347 s in BM-RUN-0010', events10)).toMatchObject({ status: 'match', line: expect.stringContaining('event_seq = 11') });
    expect(recordSupport('STG reported STG_STATE_CONFIRMED at 340 s', events10)?.status).toBe('match');
  });
  it('rejects a wrong time, subsystem or type', () => {
    expect(recordSupport('DAQ_CAPTURE_RESUMED was raised at 330 s', events10, { start: 0, end: 900 })).toMatchObject({ status: 'absent' });
    expect(recordSupport('STG raised DAQ_CAPTURE_RESUMED at 347 s', events10)?.status).toBe('mismatch');
    expect(recordSupport('DAQ reported STG_STATE_CONFIRMED at 340 s', events10)?.status).toBe('mismatch');
  });
});

// Counterexamples from the independent review of 1.0.6 (F01-F04): formatting must not change a verdict, and a
// plausible but wrong assertion must not be accepted.
describe('review F01: identifier typography', () => {
  const observed = [{ run_id: 'BM-RUN-0001', mission_elapsed_s: 100, sample_index: 200, delivery_state: 'DELIVERED', pwr_bus_level_pu: 0.856 }];
  const variants = ['BM-RUN-0001', 'BM\u2011RUN\u20110001', 'BM\u2013RUN\u20130001', 'BM\u2212RUN\u22120001', 'bm-run-0001', 'Bm-Run-0001'];
  it('extracts no measurement from a run id, whatever its dashes or case', () => {
    for (const id of variants) expect(numbersIn(`At mission_elapsed_s = 100\u202Fs in run ${id}, pwr_bus_level_pu = 0.856.`), id).toEqual(['100', '0.856']);
  });
  it('accepts the observed claim in every variant, and rejects a wrong value in every variant', () => {
    for (const id of variants) {
      expect(recordSupport(`At mission_elapsed_s = 100\u202Fs in run ${id}, pwr_bus_level_pu = 0.856.`, observed), id).toMatchObject({ status: 'match' });
      expect(recordSupport(`At mission_elapsed_s = 100 s in run ${id}, pwr_bus_level_pu = 0.865.`, observed), id)
        .toMatchObject({ status: 'mismatch', detail: 'at 100 s the record has pwr_bus_level_pu = 0.856, not 0.865' });
    }
  });
  it('still leaves a claim about another run to other checks, in any case', () => {
    expect(recordSupport('pwr_bus_level_pu = 0.856 at 100 s in bm-run-0002', observed)).toBeNull();
  });
});

describe('review F02: values bound to their own channels', () => {
  const w = samples(100, 101);       // at 100 s: pwr_margin_pu 0.7485, thm_core_temp_pu 0.4567
  it('accepts each value against its own channel', () => {
    expect(recordSupport('At 100 s, pwr_margin_pu = 0.7485 and thm_core_temp_pu = 0.4567', w)?.status).toBe('match');
    expect(recordSupport('At 100 s thm_core_temp_pu was 0.457 while pwr_margin_pu was 0.749', w)?.status).toBe('match');
  });
  it('rejects swapped values, naming the channel that differs', () => {
    expect(recordSupport('At 100 s, pwr_margin_pu = 0.4567 and thm_core_temp_pu = 0.7485', w))
      .toMatchObject({ status: 'mismatch', detail: 'at 100 s the record has pwr_margin_pu = 0.7485, not 0.4567; thm_core_temp_pu = 0.4567, not 0.7485' });
    expect(recordSupport('At 100 s, pwr_margin_pu = 0.7485 and thm_core_temp_pu = 0.7485', w)?.status).toBe('mismatch');
  });
  it('does not guess a binding it cannot read', () => {
    expect(recordSupport('At 100 s pwr_margin_pu and thm_core_temp_pu were 0.7485 and 0.4567 respectively', w)?.status).toBe('unparsed');
    expect(recordSupport('At 100 s pwr_margin_pu and thm_core_temp_pu were 0.4567 and 0.7485 respectively', w)?.status).toBe('unparsed');
    expect(recordSupport('At 100 s the value was 0.7485', w)?.status).toBe('unparsed');       // several channels, none named
  });
});

describe('review F03: exact sample times', () => {
  const w = samples(100, 101);       // samples at 100 and 100.5 s only
  it('never proves a time with a sample at another time', () => {
    expect(recordSupport('pwr_bus_level_pu was 0.8671 at exactly 101 s', w, { start: 100, end: 102 })).toEqual({ status: 'absent', detail: 'no record at exactly 101 s in this window' });
    expect(recordSupport('pwr_bus_level_pu was 0.8671 at exactly 101 s', w)?.status).not.toBe('match');
    expect(recordSupport('pwr_bus_level_pu was 0.8671 at 100 s', w)).toMatchObject({ status: 'mismatch', detail: 'at 100 s the record has pwr_bus_level_pu = 0.8664, not 0.8671' });
    expect(recordSupport('pwr_bus_level_pu was 0.8671 at 100.5 s', w)?.status).toBe('match');
  });
});

describe('review F04: event messages', () => {
  it('accepts a quoted message only when the record carries it', () => {
    expect(recordSupport('At 347 s DAQ raised DAQ_CAPTURE_RESUMED: "Source capture resumed; cumulative missing samples 50"', events10)?.status).toBe('match');
    expect(recordSupport('At 347 s DAQ raised DAQ_CAPTURE_RESUMED with message "Capture halted after buffer overflow"', events10))
      .toMatchObject({ status: 'mismatch', detail: expect.stringContaining('message "Source capture resumed; cumulative missing samples 50"') });
  });
  it('does not certify an unquoted description of the message', () => {
    expect(recordSupport('At 347 s DAQ raised DAQ_CAPTURE_RESUMED with a message saying the buffer overflowed', events10)?.status).toBe('unparsed');
  });
  it('checks an event sequence number against the record', () => {
    expect(recordSupport('DAQ_CAPTURE_RESUMED at 347 s was event_seq 11', events10)?.status).toBe('match');
    expect(recordSupport('DAQ_CAPTURE_RESUMED at 347 s was event_seq 12', events10)?.status).toBe('mismatch');
  });
});

describe('numbers in prose and tables', () => {
  it('does not accept a located line or a cell whose numbers differ from the claim', () => {
    const rows = labelTables('Phase\nNominal interval [start,end) s\nPurpose\n\nP3\n280-400\nStage transition window');
    expect(numbersSupported('P3 runs from 280 to 400 s', rows).ok).toBe(true);
    expect(numbersSupported('P3 runs from 280 to 420 s', rows)).toEqual({ ok: false, missing: ['420'] });
  });
});
