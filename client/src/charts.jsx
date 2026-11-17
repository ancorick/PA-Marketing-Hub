// Charts: one y-axis, thin marks, recessive grid, crosshair/hover tooltips,
// legend + direct labels for <= 4 series, and a table view for every chart.
import { useEffect, useRef, useState } from 'react';
import { fmtNum } from './lib.jsx';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n; const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = []; for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}
const compact = (v) => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : fmtNum(v));

function TableView({ rows, xKey, xFormat, series, format }) {
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>{xKey}</th>{series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r[xKey]}><td>{xFormat(r[xKey])}</td>{series.map((s) => <td key={s.key} className="num">{format(r[s.key])}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

/** rows: [{x, a, b}], series: [{key, label}] (max 3, same unit) */
export function LineChart({ rows, xKey, series, height = 220, format = fmtNum, xFormat = (x) => x, title }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const pad = { l: 44, r: series.length <= 4 ? 96 : 16, t: 10, b: 26 };
  const iw = w - pad.l - pad.r; const ih = height - pad.t - pad.b;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1);
  const X = (i) => pad.l + (rows.length <= 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const Y = (v) => pad.t + ih - ((Number(v) || 0) / top) * ih;
  const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 70)));
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * w;
    const i = Math.round(((x - pad.l) / iw) * (rows.length - 1));
    setHover(Math.max(0, Math.min(rows.length - 1, i)));
  };
  // Direct labels at the line ends, nudged apart to avoid collisions.
  const ends = series.map((s, k) => ({ k, y: Y(rows.at(-1)?.[s.key]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  // Keep labels inside the plot: if the stack runs past the baseline, push it back up.
  const floor = pad.t + ih - 4;
  for (let i = ends.length - 1; i >= 0; i--) {
    const limit = i === ends.length - 1 ? floor : ends[i + 1].y - 14;
    if (ends[i].y > limit) ends[i].y = limit;
  }
  const endY = Object.fromEntries(ends.map((e) => [e.k, e.y]));
  return (
    <div className="chart" ref={ref}>
      <div className="row between" style={{ marginBottom: 6 }}>
        {series.length > 1 ? <div className="legend">{series.map((s, k) => <span key={s.key}><i style={{ background: SERIES[k] }} />{s.label}</span>)}</div> : <span />}
        <button className="btn sm ghost no-print" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {table ? <TableView rows={rows} xKey={xKey} xFormat={xFormat} series={series} format={format} /> : (
        <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={title || series.map((s) => s.label).join(', ')} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <g key={t}><line x1={pad.l} x2={pad.l + iw} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" /><text x={pad.l - 8} y={Y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)">{compact(t)}</text></g>)}
          {rows.map((r, i) => (i % every === 0 || i === rows.length - 1) && <text key={i} x={X(i)} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{xFormat(r[xKey])}</text>)}
          {series.map((s, k) => (
            <g key={s.key}>
              <path d={rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r[s.key]).toFixed(1)}`).join('')} fill="none" stroke={SERIES[k]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {series.length <= 4 && rows.length > 0 && <text x={pad.l + iw + 8} y={endY[k] + 4} fontSize="11.5" fill="var(--ink-2)">{s.label}</text>}
            </g>
          ))}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--rule-strong)" />
              {series.map((s, k) => <circle key={s.key} cx={X(hover)} cy={Y(rows[hover][s.key])} r="4.5" fill={SERIES[k]} stroke="var(--surface)" strokeWidth="2" />)}
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" />
        </svg>
      )}
      {!table && hover != null && (
        <div className="tip" style={{ left: X(hover) > w - 200 ? X(hover) - 190 : X(hover) + 12, top: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{xFormat(rows[hover][xKey])}</div>
          {series.map((s, k) => <div key={s.key} className="row" style={{ gap: 6 }}><span className="dot" style={{ color: SERIES[k] }} />{s.label}: <b>{format(rows[hover][s.key])}</b></div>)}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for one measure across items (funnel stages, channels). */
export function HBars({ rows, labelKey, valueKey, format = fmtNum, title, note, funnel = false }) {
  const [hover, setHover] = useState(null);
  const vals = rows.map((r) => (typeof r[valueKey] === 'number' ? r[valueKey] : 0));
  const max = Math.max(1, ...vals);
  return (
    <div className="chart" role="list" aria-label={title}>
      {rows.map((r, i) => {
        const v = r[valueKey];
        const pct = typeof v === 'number' ? (v / max) * 100 : 0;
        const prev = funnel && i > 0 && typeof rows[i - 1][valueKey] === 'number' && rows[i - 1][valueKey] > 0 && typeof v === 'number' ? v / rows[i - 1][valueKey] : null;
        return (
          <div key={r[labelKey]} role="listitem" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', gap: 10, alignItems: 'center', padding: '5px 0' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className="small">{(() => { const s = String(r[labelKey]).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); })()}</div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 4, height: 14 }}>
              <div style={{ width: `${Math.max(pct, v ? 1 : 0)}%`, height: 14, borderRadius: '0 4px 4px 0', background: 'var(--series-1)', opacity: hover == null || hover === i ? 1 : 0.55 }} />
            </div>
            <div className="num small"><b>{format(v)}</b>{prev != null && <span className="faint"> · {(prev * 100).toFixed(0)}%</span>}</div>
          </div>
        );
      })}
      {note && <div className="hint">{note}</div>}
    </div>
  );
}

/** Vertical bars for one measure over time. */
export function Bars({ rows, xKey, valueKey, label, format = fmtNum, xFormat = (x) => x, height = 180 }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const iw = w - pad.l - pad.r; const ih = height - pad.t - pad.b;
  const ticks = niceTicks(Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0)));
  const top = ticks.at(-1);
  const bw = iw / Math.max(1, rows.length);
  const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 60)));
  return (
    <div className="chart" ref={ref}>
      <div className="row between" style={{ marginBottom: 6 }}><span className="small muted">{label}</span><button className="btn sm ghost no-print" onClick={() => setTable((t) => !t)}>{table ? 'Chart' : 'Table'}</button></div>
      {table ? <TableView rows={rows} xKey={xKey} xFormat={xFormat} series={[{ key: valueKey, label }]} format={format} /> : (
        <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <g key={t}><line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih - (t / top) * ih} y2={pad.t + ih - (t / top) * ih} stroke="var(--grid)" /><text x={pad.l - 8} y={pad.t + ih - (t / top) * ih + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)">{compact(t)}</text></g>)}
          {rows.map((r, i) => {
            const v = Number(r[valueKey]) || 0; const h = (v / top) * ih;
            const x = pad.l + i * bw + 1; const width = Math.max(1, bw - 2);
            return (
              <g key={r[xKey]} onMouseEnter={() => setHover(i)}>
                <rect x={x - 1} y={pad.t} width={bw} height={ih} fill="transparent" />
                <path d={`M${x},${pad.t + ih}V${pad.t + ih - h + Math.min(4, h)}q0,-${Math.min(4, h)} ${Math.min(4, width / 2)},-${Math.min(4, h)}H${x + width - Math.min(4, width / 2)}q${Math.min(4, width / 2)},0 ${Math.min(4, width / 2)},${Math.min(4, h)}V${pad.t + ih}Z`}
                  fill="var(--series-1)" opacity={hover == null || hover === i ? 1 : 0.55} />
                {(i % every === 0) && <text x={x + width / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{xFormat(r[xKey])}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {!table && hover != null && <div className="tip" style={{ left: Math.min(w - 160, pad.l + hover * bw + 10), top: 20 }}><b>{xFormat(rows[hover][xKey])}</b><div>{label}: <b>{format(rows[hover][valueKey])}</b></div></div>}
    </div>
  );
}
