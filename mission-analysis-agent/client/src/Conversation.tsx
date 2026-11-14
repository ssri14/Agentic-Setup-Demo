import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, type EvidenceItem, type Message, type RunEvent, type RunInfo } from './api';
import AnswerCard from './AnswerCard';
import EvidenceDrawer from './EvidenceDrawer';
import ReplayModal from './ReplayModal';
import { applyEvent, initialLive, type LiveState } from './liveRun';
import { PlanList } from './PlanList';

function useElapsed(since?: string, running = true) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { if (!running) return; const t = setInterval(tick, 1000); return () => clearInterval(t); }, [running]);
  if (!since) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LiveRun({ run, onFinished }: { run: RunInfo; onFinished: () => void }) {
  const [live, dispatch] = useReducer((s: LiveState, e: RunEvent) => applyEvent(s, e), undefined, initialLive);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const finishedRef = useRef(false);
  useEffect(() => {
    const source = new EventSource(`/api/runs/${run.id}/stream`);
    source.addEventListener('run', (m) => dispatch(JSON.parse((m as MessageEvent).data)));
    source.addEventListener('end', () => { source.close(); if (!finishedRef.current) { finishedRef.current = true; setTimeout(onFinished, 150); } });
    return () => source.close();
  }, [run.id, onFinished]);
  const elapsed = useElapsed(live.startedAt ?? run.createdAt, !live.finished);
  const send = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api('POST', `/api/runs/${run.id}/answer`, { text: text.trim() }); setAnswer(''); } finally { setBusy(false); }
  };
  return (
    <div className="agent-msg live">
      <div className="progress-strip">
        {!live.finished && !live.clarification && <i className="spin" />}
        <span className="stage">{live.stage}</span>
        <span className="muted mono">{elapsed}</span>
        {!live.finished && <button className="btn small" onClick={() => api('POST', `/api/runs/${run.id}/stop`)}>Stop</button>}
      </div>
      {live.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      <PlanList plans={live.plans} hypotheses={live.hypotheses} />
      {live.clarification && (
        <div className="clarify">
          <div className="clarify-q">{live.clarification.question}</div>
          <div className="clarify-options">
            {live.clarification.options.map((o) => <button key={o} className="btn small" disabled={busy} onClick={() => send(o)}>{o}</button>)}
          </div>
          <div className="clarify-input">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Or type your answer" onKeyDown={(e) => { if (e.key === 'Enter') send(answer); }} />
            <button className="btn primary small" disabled={busy || !answer.trim()} onClick={() => send(answer)}>Answer</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Conversation({ chatId, onActivity, register }: { chatId: string; onActivity: () => void; register: (send: (text: string) => Promise<void>, busy: boolean) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [evidence, setEvidence] = useState<EvidenceItem | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ messages: Message[]; runs: RunInfo[] }>('GET', `/api/chats/${chatId}/messages`);
    setMessages(r.messages); setRuns(r.runs);
  }, [chatId]);
  useEffect(() => { setMessages([]); setRuns([]); setEvidence(null); load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, runs.length]);

  const active = runs.some((r) => r.status === 'running' || r.status === 'waiting');
  const send = useCallback(async (text: string) => {
    setError('');
    try { await api('POST', `/api/chats/${chatId}/messages`, { text }); await load(); onActivity(); }
    catch (e) { setError((e as Error).message); }
  }, [chatId, load, onActivity]);
  useEffect(() => { register(send, active); }, [register, send, active]);
  const finished = useCallback(() => { load().then(onActivity).catch(() => {}); }, [load, onActivity]);

  return (
    <>
      <div className="thread">
        {runs.map((run) => {
          const own = messages.filter((m) => m.runId === run.id);
          const answers = own.filter((m) => m.role === 'user').slice(1);
          const reply = own.find((m) => m.role === 'assistant');
          const liveNow = run.status === 'running' || run.status === 'waiting';
          return (
            <div key={run.id} className="turn">
              <div className="user-msg">{run.question}</div>
              {answers.map((a) => <div key={a.id} className="user-msg small-msg">{a.text}</div>)}
              {liveNow ? <LiveRun run={run} onFinished={finished} /> : (
                <div className="agent-msg">
                  {run.view && <PlanList plans={run.view.plans} hypotheses={run.view.hypotheses} collapsed />}
                  {reply?.report ? <AnswerCard report={reply.report} run={run} onEvidence={setEvidence} onReplay={() => setReplay(run.id)} />
                    : <div className={run.status === 'complete' ? '' : 'run-error'}>{reply?.text ?? (run.status === 'interrupted' ? 'This question was interrupted by a server restart. Ask it again.' : run.error ?? '')}{run.status !== 'interrupted' && <button className="linkish small replay-link" onClick={() => setReplay(run.id)}>Replay what happened</button>}</div>}
                </div>
              )}
            </div>
          );
        })}
        {error && <div className="banner-error">{error}</div>}
        <div ref={bottom} />
      </div>
      <EvidenceDrawer item={evidence} onClose={() => setEvidence(null)} />
      <ReplayModal runId={replay} onClose={() => setReplay(null)} />
    </>
  );
}
