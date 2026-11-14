import { useEffect, useState } from 'react';
import { api } from './api';

interface Provider { id: string; label: string; defaultModel: string; hosted: boolean }
type Settings = Record<string, { provider: string; model: string }>;
const ROLE_TEXT: Record<string, string> = {
  planner: 'Writes and revises the investigation plan', verifier: 'Tests hypotheses after each round, decides what happens next, and chooses how to recover from failures',
  analyst: 'Writes the Python for run_analysis', reporter: 'Writes the final answer from verified findings',
};

interface FaultSettings { enabled: boolean; tool: string | null; toolFailures: number; plannerFailures: number }

/** Simulated failures to demonstrate the recovery suite. */
function FaultInjection() {
  const [tools, setTools] = useState<string[]>([]);
  const [f, setF] = useState<FaultSettings | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { api<{ tools: string[]; settings: FaultSettings }>('GET', '/api/settings/faults').then((r) => { setTools(r.tools); setF(r.settings); }).catch((e) => setNotice(e.message)); }, []);
  if (!f) return notice ? <div className="card pad">{notice}</div> : null;
  const save = async (next: FaultSettings) => {
    setF(next);
    try { await api('PUT', '/api/settings/faults', next); setNotice(next.enabled ? 'On: every new question gets these failures.' : 'Off.'); } catch (e) { setNotice((e as Error).message); }
  };
  return (
    <div className={`card pad faults${f.enabled ? ' armed' : ''}`}>
      <div className="faults-head">
        <div><div className="strong">Fault injection (demonstration)</div>
          <div className="muted small">Make parts of each new investigation fail on purpose, to show the recovery suite: retry, continue without, revise the plan, ask, or answer partially.</div></div>
        <label className="switch"><input type="checkbox" checked={f.enabled} onChange={(e) => save({ ...f, enabled: e.target.checked })} /><span>{f.enabled ? 'On' : 'Off'}</span></label>
      </div>
      <div className="faults-grid">
        <label>Fail the first
          <select value={f.toolFailures} onChange={(e) => save({ ...f, toolFailures: Number(e.target.value) })}>{[0, 1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          call(s) of
          <select value={f.tool ?? ''} onChange={(e) => save({ ...f, tool: e.target.value || null })}><option value="">(no tool)</option>{tools.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <span className="muted small">as a 30 s timeout</span>
        </label>
        <label>Fail the first
          <select value={f.plannerFailures} onChange={(e) => save({ ...f, plannerFailures: Number(e.target.value) })}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          planner call(s) <span className="muted small">as HTTP 503 from the model provider</span>
        </label>
      </div>
      <div className="muted small">Retries per task: 2. Five failures of one tool use up its retries, so the recovery turns into a plan revision or a partial answer. {notice}</div>
    </div>
  );
}

export default function Models() {
  const [roles, setRoles] = useState<string[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    api<{ roles: string[]; providers: Provider[]; settings: Settings | null }>('GET', '/api/settings/models')
      .then((r) => { setRoles(r.roles); setProviders(r.providers); setSettings(r.settings); }).catch((e) => setNotice(e.message));
  }, []);
  if (!providers.length) return <><div className="card pad">No language model is configured on the server. Set <code>LLM_BASE_URL</code> (LAN), <code>OPENROUTER_API_KEY</code> or <code>GROQ_API_KEY</code> in <code>.env</code> and restart <code>agent-web</code>. {notice}</div><FaultInjection /></>;
  if (!settings) return <FaultInjection />;
  const set = (role: string, patch: Partial<{ provider: string; model: string }>) => setSettings({ ...settings, [role]: { ...settings[role], ...patch } });
  const save = async () => {
    try { await api('PUT', '/api/settings/models', settings); setNotice('Saved. New questions use these models.'); } catch (e) { setNotice((e as Error).message); }
  };
  const hosted = roles.some((r) => providers.find((p) => p.id === settings[r].provider)?.hosted);
  return (
    <div className="card pad models">
      <p className="muted">Each agent role can use a different provider and model. The LAN server keeps mission content inside the lab; OpenRouter and Groq send prompts, which include mission content, to a hosted service.</p>
      <table className="table">
        <thead><tr><th>Role</th><th>Provider</th><th>Model</th></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r}>
              <td><div className="strong" style={{ textTransform: 'capitalize' }}>{r}</div><div className="muted small">{ROLE_TEXT[r]}</div></td>
              <td><select value={settings[r].provider} onChange={(e) => set(r, { provider: e.target.value, model: providers.find((p) => p.id === e.target.value)!.defaultModel })}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.hosted ? ' (hosted)' : ''}</option>)}</select></td>
              <td><input className="mono" value={settings[r].model} onChange={(e) => set(r, { model: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {hosted && <div className="note">A hosted provider is selected: mission content leaves the lab for those roles.</div>}
      <div className="row-end">{notice && <span className="muted small push-left">{notice}</span>}<button className="btn primary" onClick={save}>Save</button></div>
      <FaultInjection />
    </div>
  );
}
