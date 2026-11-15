# Changelog

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
