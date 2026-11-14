import { useEffect, useState } from 'react';

/** A small line chart of the numeric columns of a telemetry CSV artifact, against mission time. */
export default function MiniChart({ artifactId }: { artifactId: string }) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/artifacts/${artifactId}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))).then((text) => {
      const [head, ...lines] = text.trim().split('\n');
      const cols = head.split(',');
      setRows(lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]))));
    }).catch((e) => setError(e.message));
  }, [artifactId]);
  if (error) return <div className="muted small">Chart unavailable: {error}</div>;
  if (!rows?.length) return null;
  const x = 'mission_elapsed_s' in rows[0] ? 'mission_elapsed_s' : 't_s' in rows[0] ? 't_s' : null;
  if (!x) return null;
  const series = Object.keys(rows[0]).filter((c) => c !== x && c !== 'sample_index' && rows.every((r) => r[c] === '' || !Number.isNaN(Number(r[c])))).slice(0, 4);
  if (!series.length) return null;
  const W = 520, H = 170, L = 40, R = 10, T = 10, B = 24;
  const xs = rows.map((r) => Number(r[x]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const colors = ['#2f6fde', '#d1453b', '#1f9d6b', '#b7791f'];
  return (
    <div className="minichart">
      {series.map((c, k) => {
        const ys = rows.map((r) => Number(r[c]));
        const y0 = Math.min(...ys), y1 = Math.max(...ys) === y0 ? y0 + 1 : Math.max(...ys);
        const px = (v: number) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R);
        const py = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
        let d = '', prev = -Infinity;
        rows.forEach((r, i) => { const xv = Number(r[x]); d += `${xv - prev > 1.01 ? 'M' : 'L'}${px(xv).toFixed(1)},${py(ys[i]).toFixed(1)}`; prev = xv; });
        return (
          <svg key={c} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${c} over time`}>
            <text x={L} y={T + 2} fontSize="11" fill="currentColor" opacity=".7">{c}</text>
            <text x={L - 4} y={T + 8} fontSize="10" textAnchor="end" fill="currentColor" opacity=".6">{+y1.toFixed(3)}</text>
            <text x={L - 4} y={H - B} fontSize="10" textAnchor="end" fill="currentColor" opacity=".6">{+y0.toFixed(3)}</text>
            <text x={L} y={H - 6} fontSize="10" fill="currentColor" opacity=".6">{x0} s</text>
            <text x={W - R} y={H - 6} fontSize="10" textAnchor="end" fill="currentColor" opacity=".6">{x1} s</text>
            <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="currentColor" opacity=".2" />
            <path d={d} fill="none" stroke={colors[k]} strokeWidth="1.6" />
          </svg>
        );
      })}
      <div className="muted small">Breaks in a line are missing samples.</div>
    </div>
  );
}
