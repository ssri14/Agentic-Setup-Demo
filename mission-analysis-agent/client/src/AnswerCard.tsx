import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VERDICT_LABEL, citationText, verdictMark, type EvidenceItem, type Report, type RunInfo } from './api';

const KIND: Record<string, string> = { passage: 'Passage', section: 'Section', table: 'Table', figure: 'Figure', channel: 'Channel', telemetry: 'Telemetry', events: 'Events', analysis: 'Analysis', entity: 'Graph', run: 'Run' };

export default function AnswerCard({ report, run, onEvidence, onReplay }: { report: Report; run?: RunInfo; onEvidence: (e: EvidenceItem) => void; onReplay?: () => void }) {
  const [copied, setCopied] = useState(false);
  const byId = useMemo(() => new Map(report.evidence.map((e) => [e.id, e])), [report]);
  // Inline citations like [E3] become links the renderer turns into evidence chips.
  const markdown = report.conclusion.replace(/\[(E\d+(?:\s*,\s*E\d+)*)\]/g, (_m, ids: string) => ids.split(/\s*,\s*/).map((id) => `[${id}](#evidence-${id})`).join(' '));
  const copy = async () => { await navigator.clipboard.writeText(report.conclusion); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const totals = run?.totals;
  return (
    <div className="answer">
      <div className="answer-head">
        <span className={`confidence c-${report.confidence}`}>{report.confidence} confidence</span>
        <span className="muted small">{report.confidence_reason}</span>
      </div>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => {
            const id = href?.startsWith('#evidence-') ? href.slice(10) : null;
            const ev = id ? byId.get(id) : undefined;
            if (id) return ev ? <button className="cite" onClick={() => onEvidence(ev)} title={ev.label}>{id}</button> : <span className="cite missing">{id}</span>;
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}>{markdown}</ReactMarkdown>
      </div>
      {!!report.evidence.length && (
        <div className="evidence-row">
          {report.evidence.map((e) => (
            <button key={e.id} className={`evchip k-${e.kind}`} onClick={() => onEvidence(e)} title={e.snippet.slice(0, 200)}>
              <b>{e.id}</b> {KIND[e.kind] ?? e.kind} · {e.label}
            </button>
          ))}
        </div>
      )}
      {!!report.claims?.length && (
        <details className={`answer-more claims-box${report.claims.every((c) => c.verdict === 'supported') ? ' all-ok' : ' some-bad'}`}>
          <summary>{report.claims.every((c) => c.verdict === 'supported')
            ? `All ${report.claims.length} claims checked against the evidence`
            : `${report.claims.filter((c) => c.verdict === 'supported').length} of ${report.claims.length} claims verified against the evidence`}
            {report.checks && report.checks.rounds > 1 ? ` · checked in ${report.checks.rounds} rounds` : ''}</summary>
          <ul className="claims">{report.claims.map((c) => (
            <li key={c.id} className={`claim v-${c.verdict}`}>
              <span className="claim-mark">{verdictMark(c.verdict)}</span>
              <div><div>{c.text} {c.evidence.map((id) => <span key={id} className="ev">{id}</span>)}</div>
                {citationText(c) && <div className="claim-quote">{citationText(c)}</div>}
                {c.matched === 'located' && c.support && <div className="claim-quote">matched to: {c.support}</div>}
                {c.verdict !== 'supported' && <div className="claim-why">{VERDICT_LABEL[c.verdict]}: {c.explanation}{c.contradicting.map((x) => ` ${x.evidence} says “${x.quote}”.`).join('')}</div>}</div>
            </li>))}</ul>
        </details>
      )}
      {!!report.rejected_alternatives.length && (
        <details className="answer-more"><summary>Rejected alternatives ({report.rejected_alternatives.length})</summary>
          <ul>{report.rejected_alternatives.map((r, i) => <li key={i}><b>{r.hypothesis}</b> — {r.reason}</li>)}</ul></details>
      )}
      {!!(report.uncertainties.length || report.limits?.length) && (
        <details className="answer-more"><summary>Open uncertainties ({report.uncertainties.length + (report.limits?.length ?? 0)})</summary>
          <ul>{report.uncertainties.map((u, i) => <li key={i}>{u}</li>)}{report.limits?.map((l, i) => <li key={`l${i}`} className="limit">Investigation limit: {l}</li>)}</ul></details>
      )}
      {!!report.provenance?.length && (
        <details className="answer-more workflow-notes"><summary>Citation notes ({report.provenance.length})</summary>
          <p className="muted small">Claims whose quotation is not worded as in the source, although the facts they state are in the cited evidence. They do not change the confidence.</p>
          <ul>{report.provenance.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
      {!!report.workflow?.length && (
        <details className="answer-more workflow-notes"><summary>Workflow notes ({report.workflow.length})</summary>
          <p className="muted small">Steps that failed or were stopped during the investigation. They do not change the verified claims above.</p>
          <ul>{report.workflow.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
      <div className="answer-foot">
        <button className="btn small replay-btn" onClick={onReplay} disabled={!onReplay}>▶ Replay graph</button>
        <button className="btn small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        {totals && <span className="muted small">{totals.tool_calls} tool calls · {totals.plan_versions} plan version{totals.plan_versions === 1 ? '' : 's'} · {totals.llm_calls} model calls · {totals.elapsed_s} s</span>}
      </div>
    </div>
  );
}
