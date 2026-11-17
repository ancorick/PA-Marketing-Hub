import { isoDay } from './lib.jsx';
import { Seg } from './ui.jsx';

const DAY = 864e5;
export function presetRange(p) {
  const now = new Date();
  const to = isoDay(now);
  if (p === '30d') return { from: isoDay(now - 30 * DAY), to };
  if (p === '90d') return { from: isoDay(now - 90 * DAY), to };
  if (p === 'ytd') return { from: `${now.getUTCFullYear()}-01-01`, to };
  if (p === 'lq') {
    const q = Math.floor(now.getUTCMonth() / 3); const y = q === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear(); const lq = (q + 3) % 4;
    return { from: isoDay(Date.UTC(y, lq * 3, 1)), to: isoDay(Date.UTC(y, lq * 3 + 3, 0)) };
  }
  if (p === '12m') return { from: isoDay(now - 365 * DAY), to };
  return null;
}
export const MODELS = [['first_touch', 'First touch'], ['last_touch', 'Last touch'], ['position_based', 'Position-based']];
export const MODEL_HELP = {
  first_touch: 'Which channels bring new people in? 100% credit to the first recorded channel in the 365 days before the application.',
  last_touch: 'Which channels close the decision? 100% credit to the last channel before the application date.',
  position_based: 'A balanced view for budget decisions: 40% first, 40% last, 20% split across the middle touches.',
};

/** One row of filters above the charts (dataviz: filters in one row). */
export function RangeFilters({ q, setQ, showModel = true, children }) {
  const onPreset = (p) => { const r = presetRange(p); setQ({ preset: p, ...(r || {}) }); };
  return (
    <div className="card no-print" style={{ padding: 12, marginBottom: 16 }}>
      <div className="row" style={{ gap: 14 }}>
        <Seg label="Date range" value={q.preset} onChange={onPreset} options={[['30d', '30 days'], ['90d', '90 days'], ['lq', 'Last quarter'], ['ytd', 'This year'], ['12m', '12 months'], ['custom', 'Custom']]} />
        {q.preset === 'custom' && (
          <span className="row">
            <input aria-label="From" className="i inline" type="date" value={q.from} onChange={(e) => setQ({ from: e.target.value })} />
            <span className="faint">to</span>
            <input aria-label="To" className="i inline" type="date" value={q.to} onChange={(e) => setQ({ to: e.target.value })} />
          </span>
        )}
        {showModel && (
          <label className="row small" style={{ gap: 6 }} title={MODEL_HELP[q.model]}>
            <span className="muted">Attribution</span>
            <select className="i inline" value={q.model} onChange={(e) => setQ({ model: e.target.value })}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        {children}
      </div>
    </div>
  );
}
export function rangeDefaults(preset = 'lq') { return { preset, ...presetRange(preset), model: 'first_touch' }; }
