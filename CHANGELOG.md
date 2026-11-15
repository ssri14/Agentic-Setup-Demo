# Changelog

## 1.0.6 — 2026-11-15

For "What was pwr_bus_level_pu in BM-RUN-0001 at exactly 100 seconds?" the agent retrieved 0.856 and the verifier and checker found it supported, but the answer showed "Citation not matched" and MEDIUM. Cause (`server/src/agent/graph.ts`, claim check): telemetry evidence was checked against text containing only the tool summary and channel statistics, never the sample records, so no claim about a recorded value could be matched; the unmatched citation then capped confidence. Event evidence had the same gap. The planner, prompts, ingestion and data are unchanged.

- **Evidence-type-aware validation.** `telemetry_window` and `events_window` now attach the records behind their evidence (kept out of tool data, observations and stored reports). Claims citing them are checked against the records: run, time, channel or field and value for telemetry; run, time, subsystem and type for events. No quotation is required. Tables keep row/column/value checks; prose keeps exact quotations. Models also see the sampled values in the evidence text.
- **Wrong values are never accepted.** A different recorded value (or enum state, subsystem, event type) at the stated time is a deterministic contradiction, whatever the checker says. Every number in a claim must match its support to the stated precision and within 0.5 % (0.866 or 0.87 for 0.8664, not 0.9). A claim whose numbers or names do not appear in its cited evidence is "not established".
- **Formatting versus facts.** A citation whose wording differs while the facts are in the cited evidence and the checker found it supported is reported under *Citation notes*; it no longer lowers confidence or adds a note to the conclusion. Contradicted and unestablished claims still lower confidence to low.
- 13 new tests (87 in total): valid and invalid claims for prose, tables, telemetry samples and events on the real BM-RUN-0010 records and SEC-03 text, and the observed query end to end (correct value: high; wrong value: contradicted, low).

## 1.0.5 — 2026-11-15

In the HLT run the planner added `run_analysis` over `@S1.2` (a `read_section` result) to "produce the final evidence-based answer"; it failed with "input @S1.2 has no CSV result", and that failure lowered an answer whose claims were all verified to MEDIUM. Evidence verification is unchanged.

- **Type-safe references.** Plans are validated for tool compatibility before anything runs: `run_analysis` inputs must be tasks that return CSV (`get_table`, `telemetry_window`, `events_window`, `run_analysis`); `read_section` references must be tasks that return document results. References into earlier plan versions are checked too. An incompatible plan goes back to the planner with the reason, so nothing fails at run time.
- **Tool selection.** The planner is told that document questions are answered from the document tools, that `run_analysis` is for computations over CSV data the tool summaries cannot answer, and not to plan steps that only produce, summarise or verify the answer.
- **Confidence versus workflow failures.** Budget limits still cap confidence at medium. Failed or abandoned steps (tool errors the recovery stops at or skips) are now *workflow notes*: reported with the answer under their own heading, and no longer lowering the confidence of an answer whose claims are verified.
- **Specific hypotheses.** The planner states hypotheses that name the exact entities, values, runs or times, so one row, passage or measurement can confirm or refute each.
- 4 new tests (74 in total), including the telemetry investigation plan with `run_analysis`, which is accepted unchanged.

## 1.0.4 — 2026-11-15

After 1.0.2 the HLT answer was correct but reported LOW confidence with "Not verified against the evidence: HLT depends on the PWR, THM, ENV, and ACT subsystems (no supporting quote)". Cause, confirmed on the recorded text: the evidence was a search passage in which PyMuPDF keeps the SEC-03 table one cell per line, one row per block. Only "a | b | c" tables were turned into labelled rows, so the reporter's quote "HLT … Depends on PWR, THM, ENV, ACT" (header before the row, value after it) failed the strict in-order match, and that failure overruled the checker's "supported".

- **Structure-aware evidence.** One-cell-per-line tables in passages and sections are recognised and rendered as labelled rows (headers that look like page running headers, identifiers or data rows are not taken as column names).
- **Table-cell citations.** A claim may cite `"cell": {"row": "HLT", "column": "Depends on", "value": "PWR, THM, ENV, ACT"}`, verified against the row's key, the column and the cell's items (a subset such as "PWR and THM" matches; other values do not).
- **No stitched quotations.** Quote fragments must lie in one table row or one paragraph; the reporter is told to quote one contiguous span or cite the cell.
- **Reworded claims located.** When the wording differs, the evidence line that carries the claim is located instead: a table row only if the claim's subject is that row's key; a sentence only if it says more than a list of names. Located support counts only together with the checker's "supported".
- **Separate verdicts.** supported / contradicted / insufficient (not established) / validation_error (citation not matched) / unchecked. A matching failure is never treated as a contradiction: it caps confidence at medium with the claim named, while contradicted or unestablished claims lower it to low. Each case is listed separately in the answer.
- **Verifier output hardening.** A hypothesis named by its statement or as "H2: statement" is mapped to its id deterministically instead of failing validation.
- 15 new tests (70 in total): correct tables, incorrect relationships, misleading headings and malformed quotations on the real SEC-03/SEC-04 text, and the recorded HLT run (exact quotation, cell citation, reworded quotation) answering with high confidence in one round.

## 1.0.3 — 2026-11-15

- **Fix: references between dependent tool calls.** The planner wrote `read_section {"section": "@S1.1"}` ("read the section the search found"), in the same step as the search. References were supported only in `run_analysis` inputs, so the literal "@S1.1" failed ("No section @S1.1") and the run stopped early with lowered confidence.
  - `read_section` now accepts `"section": "@S1.1"`, resolved when it runs to the section of that task's best result (a `reference_resolved` event records the value and the evidence it came from).
  - A task waits for every task it references, even one in its own step; it is skipped if they failed; a reference that yields nothing fails with a clear message.
  - A reference in any other argument, or to a task that runs later, is rejected when the plan is validated, so the planner corrects the plan instead of failing at run time. The tool catalog states where references are allowed.
- 4 new tests (55 in total).

## 1.0.2 — 2026-11-15

Fixes an evidence-interpretation failure: asked which subsystems HLT depends on, the agent answered "DAQ, COM and SUP" (the heading of a telemetry-dictionary page) with high confidence, although the SEC-03 table row it had retrieved says PWR, THM, ENV, ACT; it repeated the error when challenged.

- **Full evidence for the models.** The verifier, reporter and checker now read each evidence item's full content instead of a 220-character fragment. Tables (structured and pipe-text) are shown as labelled rows, "Row 1: ID = HLT; … Depends on = PWR, THM, ENV, ACT", with all rows rather than the first four.
- **Claims with quotes.** The reporter lists every factual claim with its evidence and the exact words that state it.
- **Claim check.** A new graph step, *Check claims*, verifies every quote against the evidence text, then asks a checker model (a new, configurable role; defaults to the verifier's model) whether any evidence contradicts a claim. It shows the checker the lines elsewhere in the evidence that mention the same identifiers. A contradiction counts only if its own quote is in the evidence.
- **Contradictions loop back.** Problems send the draft back to the reporter with the findings, or to the planner when more retrieval is needed; at most two correction rounds.
- **Calibrated confidence.** *High* only when every claim is verified, nothing is contradicted, no limit was hit and no hypothesis is conflicting; otherwise capped, with the reason. Claims that still fail are flagged in the answer.
- **No silent bypass.** The verifier cannot report while planned tasks are pending and a hypothesis is undecided; tasks left unrun are marked skipped.
- **Follow-ups re-check.** Earlier answers are not evidence; a challenged answer is investigated again.
- Prompts: relationships (depends on, owner, threshold, cause) only from the row or sentence that states them; never from headings, captions or lists of names.
- UI: claim list on the answer card; *Check claims* node, claim-check events and decisions in the replay; live notes.
- Tests: 7 new (51 in total), including the HLT question as a regression test on the real document text.

## 1.0.1 — 2026-11-15

- **Fix (agent UI):** long single-line content, such as a plan's objective in the collapsed plan header, could stretch the conversation far beyond the window and wrap the answer text at that width. The conversation's grid tracks can now shrink below their content; long unbroken strings wrap; wide code blocks and tables scroll inside the answer.

## 1.0.0 — 2026-11-14

- First release: telemetry generator, ingestion stack and dashboard, Mission Analysis Agent with plan / execute / verify / recover / replan and replay, guides, multi-architecture images.
