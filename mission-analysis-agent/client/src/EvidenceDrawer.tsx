import type { EvidenceItem } from './api';
import MiniChart from './MiniChart';

export default function EvidenceDrawer({ item, onClose }: { item: EvidenceItem | null; onClose: () => void }) {
  if (!item) return null;
  const where = [item.section, item.page ? `page ${item.page}` : null, item.run_id ? `${item.run_id} ${item.start}–${item.end} s` : null].filter(Boolean).join(' · ');
  return (
    <aside className="drawer" role="dialog" aria-label={`Evidence ${item.id}`}>
      <div className="drawer-head"><div><div className="drawer-id">{item.id} · {item.kind}</div><h3>{item.label}</h3>{where && <div className="muted small">{where}</div>}</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="drawer-body">
        {(item.kind === 'telemetry' || item.kind === 'events') && item.artifact && <MiniChart artifactId={item.artifact} />}
        {item.kind === 'analysis' && item.artifact && <img className="drawer-img" src={`/api/artifacts/${item.artifact}`} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
        <pre className="snippet">{item.snippet || 'No preview available.'}</pre>
        {item.artifact && <a className="small" href={`/api/artifacts/${item.artifact}`}>Download the data</a>}
        <div className="muted small">Collected by task {item.task}{item.kind === 'table' || item.kind === 'figure' ? '. VLM content is unreviewed model output.' : '.'}</div>
      </div>
    </aside>
  );
}
