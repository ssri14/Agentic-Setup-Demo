import { useEffect, useMemo, useState } from 'react';
import { api, type AdminMission } from './api';

interface ToolInfo { name: string; description: string; needsTelemetry: boolean; parameters: Record<string, unknown>; example: Record<string, unknown> }
interface Evidence { kind: string; ref: string; label: string; page?: number }
interface ArtifactRef { id: string; name: string; kind: 'csv' | 'png'; rows?: number; columns?: string[] }
interface Result { ok: boolean; error?: string; summary?: string; data?: unknown; evidence?: Evidence[]; artifacts?: ArtifactRef[]; duration_ms?: number }

export default function ToolBench({ missions }: { missions: AdminMission[] }) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [selected, setSelected] = useState('search_documents');
  const [mission, setMission] = useState(missions[0]?.id ?? '');
  const [argsText, setArgsText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<ArtifactRef[]>([]);
  const [showSchema, setShowSchema] = useState(false);

  useEffect(() => { api<ToolInfo[]>('GET', '/api/tools').then(setTools).catch((e) => setResult({ ok: false, error: e.message })); }, []);
  useEffect(() => { if (!mission && missions[0]) setMission(missions[0].id); }, [missions, mission]);
  const tool = useMemo(() => tools.find((t) => t.name === selected), [tools, selected]);
  useEffect(() => {
    if (!tool) return;
    const example = { ...tool.example };
    if (tool.name === 'run_analysis') {
      const csv = recent.filter((a) => a.kind === 'csv');
      example.inputs = csv.length ? [csv[0].id] : ['<run telemetry_window first, then use its artifact>'];
      if (csv.length) example.code = `df = load_input('${csv[0].name}')\nprint(df.describe())`;
    }
    setArgsText(JSON.stringify(example, null, 2));
    setResult(null);
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const missionInfo = missions.find((m) => m.id === mission);
  const unavailable = tool?.needsTelemetry && missionInfo && !missionInfo.hasTelemetry;

  const run = async () => {
    let args: unknown;
    try { args = JSON.parse(argsText || '{}'); } catch (e) { return setResult({ ok: false, error: `Arguments are not valid JSON: ${(e as Error).message}` }); }
    setBusy(true); setResult(null);
    try {
      const r = await api<Result>('POST', `/api/tools/${selected}/run`, { mission, args });
      setResult(r);
      if (r.artifacts?.length) setRecent((prev) => [...r.artifacts!, ...prev].slice(0, 12));
    } catch (e) { setResult({ ok: false, error: (e as Error).message }); } finally { setBusy(false); }
  };

  const useAsInput = (a: ArtifactRef) => {
    try {
      const args = JSON.parse(argsText || '{}');
      if (selected !== 'run_analysis') { setSelected('run_analysis'); return; }
      const inputs: string[] = (args.inputs ?? []).filter((x: string) => !x.startsWith('<'));
      if (!inputs.includes(a.id)) inputs.push(a.id);
      setArgsText(JSON.stringify({ ...args, inputs }, null, 2));
    } catch { /* leave invalid JSON for the user to fix */ }
  };

  return (
    <div className="bench">
      <aside className="card bench-list">
        {tools.map((t) => (
          <button key={t.name} className={t.name === selected ? 'bench-tool active' : 'bench-tool'} onClick={() => setSelected(t.name)}>
            <span className="mono">{t.name}</span>
            {t.needsTelemetry && <span className="tag-small">telemetry</span>}
          </button>
        ))}
      </aside>
      <section className="bench-main">
        {tool && (
          <div className="card bench-form">
            <div className="bench-head">
              <h3 className="mono">{tool.name}</h3>
              <label className="inline">Mission
                <select value={mission} onChange={(e) => setMission(e.target.value)}>
                  {missions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
            <p className="muted">{tool.description}</p>
            <label>Arguments (JSON)
              <textarea className="mono args" spellCheck={false} value={argsText} onChange={(e) => setArgsText(e.target.value)}
                rows={Math.min(14, Math.max(4, argsText.split('\n').length + 1))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }} />
            </label>
            <div className="bench-actions">
              <button className="linkish" onClick={() => setShowSchema((s) => !s)}>{showSchema ? 'Hide' : 'Show'} parameter schema</button>
              <button className="btn" onClick={() => tool && setArgsText(JSON.stringify(tool.example, null, 2))}>Reset to example</button>
              <button className="btn primary" disabled={busy || !mission || Boolean(unavailable)} onClick={run}>{busy ? 'Running…' : 'Run tool'}</button>
            </div>
            {unavailable && <p className="hint">This mission has no telemetry, so this tool is not available for it.</p>}
            {showSchema && <pre className="json small-pre">{JSON.stringify(tool.parameters, null, 2)}</pre>}
          </div>
        )}

        {result && (
          <div className={result.ok ? 'card bench-result' : 'card bench-result failed'}>
            <div className="result-head">
              <span className={result.ok ? 'badge ok' : 'badge warn'}>{result.ok ? 'OK' : 'Error'}</span>
              <span className="result-summary">{result.ok ? result.summary : result.error}</span>
              {result.duration_ms !== undefined && <span className="muted mono">{result.duration_ms} ms</span>}
            </div>
            {!!result.evidence?.length && (
              <div className="result-row"><span className="row-label">Evidence</span>
                <div>{result.evidence.map((e, i) => <span key={i} className={`ev ev-${e.kind}`} title={e.ref}>{e.label}</span>)}</div></div>
            )}
            {!!result.artifacts?.length && (
              <div className="result-row"><span className="row-label">Artifacts</span>
                <div className="artifact-list">{result.artifacts.map((a) => (
                  <div key={a.id} className="artifact">
                    {a.kind === 'png'
                      ? <img src={`/api/artifacts/${a.id}`} alt={a.name} />
                      : <><a href={`/api/artifacts/${a.id}`} className="mono">{a.name}.csv</a><span className="muted small"> {a.rows} rows · {a.columns?.length} columns</span>
                          <button className="linkish small" onClick={() => useAsInput(a)}>{selected === 'run_analysis' ? 'add as input' : 'analyse…'}</button></>}
                  </div>
                ))}</div></div>
            )}
            {result.ok && <details open><summary>Result data</summary><pre className="json">{JSON.stringify(result.data, null, 2)}</pre></details>}
          </div>
        )}

        {!!recent.length && selected === 'run_analysis' && (
          <div className="card recent">
            <div className="row-label">CSV results from this session</div>
            {recent.filter((a) => a.kind === 'csv').map((a) => (
              <button key={a.id} className="chip-btn" onClick={() => useAsInput(a)} title={a.id}>{a.name} <span className="muted">({a.rows} rows)</span></button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
