# 5. Guide for users

The Mission Analysis Agent answers questions about a mission by investigating its documents and telemetry, the way an analyst would:

1. It writes a plan, with competing explanations (hypotheses).
2. It runs tools to gather evidence.
3. It checks the evidence against the documented rules.
4. If needed, it changes its plan.
5. Then it answers, citing the evidence for every claim.

You can watch it work, and afterwards replay exactly what it did.

- [Signing in](#signing-in)
- [The screen](#the-screen)
- [Asking a question](#asking-a-question)
- [While it works](#while-it-works)
- [Reading the answer](#reading-the-answer)
- [Replaying an answer](#replaying-an-answer)
- [Follow-up questions](#follow-up-questions)
- [Good questions, and limits](#good-questions-and-limits)

## Signing in

Open the address your administrator gave you (for example http://localhost:8095) and sign in with your username and temporary password. You must choose your own password straight away: at least 10 characters, not containing your username. Change it later from **Change password** in the left panel.

Five wrong passwords within 10 minutes lock the account for 10 minutes; an administrator can unlock it sooner. You are signed out after 8 hours without activity.

## The screen

- **Left panel**
  - the **mission picker**, showing only the missions you have access to;
  - **New chat**;
  - your past chats for the selected mission, grouped by date. Each chat's **⋯** menu offers **Rename** and **Delete**;
  - **Dark theme / Light theme**, **Change password**, **Sign out**.
- **Right side**: the conversation, with the message box at the bottom.

A chat belongs to one mission. Chats are titled automatically from your first question; rename them if you like. Deleting a chat removes its messages and replays.

## Asking a question

Type a question and press **Enter**. **Shift+Enter** starts a new line. A new chat suggests three starter questions:

- *Which runs show missing source samples, and how is that different from delayed delivery?*
- *Summarise the telemetry interpretation rules and where each is defined.*
- *Investigate the warnings in one run and identify the most likely root cause.*

One question runs at a time per chat. **Stop** ends it early; you can then ask again.

## While it works

Under your question, the agent's progress appears live:

- **The current stage**, for example *Planning the investigation*, *S2.1 · telemetry_window*, *Verifying the evidence* or *Recovering from a failure*.
- **The plan as nested bullets.** Each step is a top-level bullet and each tool call a sub-bullet, with a status:

  | Status | Meaning |
  |---|---|
  | **pending** | Waiting to run |
  | **executing** | Running now |
  | **succeeded** | Done; a one-line result appears under it |
  | **failed** | Failed; the error appears under it |
  | **skipped** | No longer needed, or replaced by a revised plan |

  Steps run in dependency order; independent tool calls run in parallel.
- **Hypotheses**, the explanations being tested, with their current verdict.
- **Plan revisions.** When the evidence calls for a different approach, the plan is revised. The new version appears, with the reason, and earlier versions stay folded above it.
- **Notes.** A note appears when a budget is nearly used up, or when something failed and the agent recovered: retried the step, continued without it, revised the plan, or decided to answer with what it has.
- **A question back to you.** If your question is ambiguous (for example, *which run?*), the agent asks once, sometimes offering choices. Answer in the message box and it carries on.

A typical question takes from under a minute to a few minutes, depending on how much evidence it needs.

## Reading the answer

The answer card contains:

- **Conclusion**, with citations like **[E3]**. Every factual claim should rest on an evidence item.
- **Confidence**, *high*, *medium* or *low*, with the reason.
- **Evidence**: the cited items, such as document passages, sections, tables, figures, telemetry windows, run summaries and analyses. Click one to open it in the side drawer. There you see the passage with its page and section, the telemetry window with a small chart, or the analysis output and chart. Items backed by data have a **Download the data** link.
- **Claims checked**: every factual statement of the answer, with the evidence it rests on: either the exact words quoted from it, or, for a table fact, the table cell (row, column, value). Before an answer is shown, each claim is checked twice:
  - **against the source, by type of evidence**:
    - *telemetry*: the run, the exact time (mission_elapsed_s; a sample at 100.5 s never proves a claim about 101 s), and each channel with its own recorded value in that sample, and the sample_index if stated; no quotation is needed. The run id may be written in any case or with any dash. A claim about several times must hold at every one of them; a claim about a range of times ("between 100 and 101 s") is not a single-sample claim;
    - *comparisons across runs* ("Compared with BM-RUN-0001, BM-RUN-0016 at 456 s has a lower power margin"): the records of every cited item are joined by run and exact time; the reference run is the one after "compared with", "than" or "versus"; each comparative (lower, higher, equal) is checked numerically on the channel it qualifies, as are stated pairs "(0.2751 vs 0.7515)" and differences "by 0.4764"; a state named for a run ("a degraded overall health state") must be that run's recorded state. A run that is not in the cited evidence, or a time with no record, leaves the claim not established. Channels may be named by ID or in words ("power margin", "core temperature", "DAQ quality");
    - *events*: the run, the exact time, the subsystem, the event type, the sequence number if stated, and a message only if it is quoted in double quotes (an unquoted description of a message is left to the checker model). A subsystem or event type that is not in the retrieved events is never ignored: the claim is "not established";
    - *tables*: the row, the column and the cell value;
    - *prose*: the exact quoted words. Tables are read row by row, so a quote may not stitch words from different rows or paragraphs, and a heading that lists names never counts as a relationship. If the claim is worded differently, the line of the evidence that states it is located instead.

    Every number the claim states must match the source to the precision stated (0.866 or 0.87 for a recorded 0.8664, never 0.9). A different value at the stated time is a contradiction, whatever the checker model says. When a claim lists several values in a way that cannot be tied to their channels one to one ("x and y were 0.75 and 0.46 respectively"), it is not checked mechanically: the answer is sent back to be restated as channel = value, and if it stays that way the claim is "not established". A matching record proves the values; anything else the claim says (a cause, an interpretation) still needs the checker model's agreement;
  - **by the checker model**: the evidence must establish the claim, and none may contradict it.

  Each claim gets one of these results:

  | Mark | Result | Meaning | Effect on confidence |
  |---|---|---|---|
  | ✓ | supported | The evidence establishes the claim, and the supporting text was found | none |
  | ✗ | contradicted | Some evidence states something incompatible (its words are shown) | lowered to low |
  | ✗ | not established | Nothing in the cited evidence states the claim | lowered to low |
  | ? | citation wording differs | The checker found the claim supported and its values and names are in the cited evidence, but the quotation is not worded as in the source: a provenance note, not a factual problem | none; listed under **Citation notes** |

  A claim that is not ✓ sends the answer back to be rewritten (or, when evidence is missing, back to planning), up to two times. Claims that still fail are never published as findings: the answer then becomes a **partial answer** built only from the verified claims (each with its evidence), or, if none was verified, says that the evidence gathered does not verify an answer. The statements left out are listed under *Open uncertainties* (opened automatically), the red marks stay in the claim list, the confidence reason says exactly why it was lowered, and the full draft remains visible in the replay (step "answer withheld").

  A value of a run at a time ("BM-RUN-0016 pwr_margin_pu = 0.2807 at 360 s") must cite a measurement — telemetry samples, event records or an analysis of them. A channel definition or document text describes a quantity but never establishes its value, so such a claim is "not established" whatever the checker says.
- **Rejected alternatives**: hypotheses the evidence ruled out, and why.
- **Uncertainties**: what the agent could not establish, including any budget it ran out of (for example *tool-call budget reached*). A budget cut lowers confidence to at most medium, because the investigation may have stopped before finding something relevant.
- **Workflow notes**: steps that failed or were stopped along the way (a tool error, a timeout, a step the recovery decided to skip). They are listed for transparency but do not lower confidence on their own: if every claim of the answer is verified, the answer stays high.

How to read an answer critically:

- Confidence is capped by the claim check. *High* requires every claim verified, no unresolved contradiction and no investigation limit; otherwise the reason says why it was lowered.
- A **low** confidence, a long uncertainties list, or an unverified claim means you should check the evidence yourself before relying on it.
- If you think an answer is wrong, say so in a follow-up. The agent treats its earlier answers as claims to re-check against the sources, not as evidence.
- *Partial* answers say so explicitly.

## Replaying an answer

Every finished answer has a **▶ Replay graph** button. A stopped or failed question has a **Replay what happened** link instead. The replay rebuilds the whole investigation from its event log, one event per second.

**Controls**

| Control | Keyboard | Does |
|---|---|---|
| ⏮ / ⏭ | Home / End | Jump to the start or the end |
| ◀ / ▶ | ← / → | One event back or forward (pauses playback) |
| ▶ Play / ❚❚ Pause / ↺ Replay | Space | Play or pause; replay from the start at the end |
| 0.5× 1× 2× 4× | | Playback speed |
| Timeline | | Click or drag to jump; hover to see the event |

Timeline marks are coloured by event type:

- model call
- tool
- verification
- decision / recovery
- plan / replan, marked with a red flag
- clarification
- failure

Stepping back is exact: each position is rebuilt from the start.

**Panels**

1. **Agent graph.** The agent's fixed loop: *Intake → Plan → Execute tools → Verify → Report (draft) → Check claims*, with *Ask user* and *Recover* beside it. A failed claim check shows as Check claims → Report (rewrite) or Check claims → Plan (investigate further).
   - The current node is highlighted, and nodes visited so far are filled.
   - Each arrow shows how many times it was taken. A replan shows as Verify → Plan; a failure shows as an arrow into the red **Recover** node.
2. **Plan.** The plan as it stood at that moment.
   - *Graph* view, the default: step cards laid out by their dependencies. Chains run downward; independent steps sit side by side.
   - Cards are coloured by status: grey waiting, blue active, green done, red failed, dashed skipped. A final **Response** card closes the plan.
   - On the right, dashed links run from every step to the **Recovery decision** hub and its five routes: *Retry failed stage, Continue without it, Revise remaining plan, Ask for clarification, Build final / partial response*. The hub turns amber while a decision is being made, and the route taken turns green, with a count. Links from a failed step turn red.
   - *List* view shows the same plan as nested bullets.
   - The version tabs (v1, v2 …) show earlier plans. The header reads *Version n | x of y tasks completed*.
3. **Details**, in three tabs:
   - **Event**: what happened at this moment.
     - **Model calls**: which model, how long it took, and its response. The full prompt and response can be expanded.
     - **Tool calls**: the arguments, or the Python the analyst wrote; and the result with its evidence.
     - **Verdicts and decisions**: the reasoning.
     - **Failures and recoveries**: the error, the action chosen, and any guard that overruled the model.
   - **See state**: the agent's state at this point: plan, hypotheses and verdicts, latest decision, counters.
   - **See context**: the last prompt a model was given up to this point (what it actually saw), and the mission context loaded at the start.

At the bottom:

- **State**: plan version, tasks done/pending/failed/skipped, hypotheses, evidence count, and budget used (tool calls, model calls, replans, recoveries, time).
- **Memory and context**: the mission context loaded, whether earlier turns of the chat were used, and any clarification.

## Follow-up questions

Ask a follow-up in the same chat, for example *"Now compare it with BM-RUN-0011"*. The agent sees your last three questions and its answers to them, so "it" and "that run" resolve correctly. Start a **New chat** for an unrelated topic.

## Good questions, and limits

**Questions that work well** name what you care about, and ask for comparison, explanation or a check against the rules:

- *Does BM-RUN-0010 show acquisition loss or delayed delivery between 300 and 360 s? Cite the rule.*
- *Which subsystem is the most likely root cause of the warnings in BM-RUN-0016, and which symptoms are only downstream?*
- *List the runs where the reported stage transition disagrees with the independent stage event.*
- *What does the document say `daq_missing_samples` means, and how does its value behave in the dropout runs?*

**Limits to keep in mind**

- **Brahmastra is fictional.** The data is synthetic and non-operational; answers describe this demonstration dataset only.
- **Only the mission's data.** The agent uses only the selected mission's ingested documents and telemetry. It does not browse the web or use other missions' data.
- **Budgets.** Each question has a budget: by default 48 tool calls, 5 plan revisions, 100 model calls and 15 minutes. Very broad questions ("analyse everything") may hit it and return a partial answer. Split them into narrower questions.
- **Model output can be wrong.** That is why every claim cites evidence and every answer can be replayed. Check the evidence for anything important.
