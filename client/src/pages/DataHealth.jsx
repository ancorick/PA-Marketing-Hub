import { useState } from 'react';
import { api, useApi, useAction, useCan, fmtDateTime, fmtNum } from '../lib.jsx';
import { PageHead, Card, Async, Status } from '../ui.jsx';

export default function DataHealth() {
  const can = useCan();
  const state = useApi('/analytics/health');
  const channels = useApi('/channels');
  const [run, busy] = useAction();
  const [map, setMap] = useState({});
  const act = async (fn, ok) => { if (await run(fn, ok)) state.reload(); };
  return (
    <>
      <PageHead title="Data health" sub="Every source shows its last successful pull, row counts and errors. Raw responses are kept unchanged, so any number can be rebuilt after a taxonomy or logic change.">
        {can('integrations.manage') && <button className="btn primary" disabled={busy} onClick={() => act(() => api('/analytics/pipeline/run', { method: 'POST', body: {} }), 'Pipeline finished')}>Run all sources now</button>}
      </PageHead>
      <Async state={state}>{(d) => (
        <>
          <Card title="Sources">
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Source</th><th>Type</th><th>Freshness</th><th>Last success</th><th>Last run</th><th className="num">Rows</th><th className="num">Raw pages</th>{can('integrations.manage') && <th>Actions</th>}</tr></thead>
              <tbody>{d.sources.map((s) => (
                <tr key={s.key}>
                  <td><b>{s.label}</b><div className="faint small">{s.frequency}</div></td>
                  <td><span className="badge">{s.kind}</span></td>
                  <td>{s.freshness_hours == null ? <Status value="missing">no data</Status> : <Status value={s.fresh ? 'success' : 'warning'}>{s.freshness_hours < 1 ? '< 1 h' : `${fmtNum(s.freshness_hours)} h`}</Status>}<div className="faint small">target {s.target_hours} h</div></td>
                  <td className="small nowrap">{fmtDateTime(s.last_success)}</td>
                  <td className="small">{s.last_run ? <><Status value={s.last_run.status} />{s.consecutive_failures >= 2 && <div className="err small">Failed {s.consecutive_failures}× in a row — admin alerted</div>}{s.last_run.error && <div className="err small">{s.last_run.error}</div>}</> : s.kind === 'stream' ? <span className="faint">webhook stream{s.errors ? ` · ${s.errors} errors` : ''}</span> : '—'}</td>
                  <td className="num">{fmtNum(s.rows_last)}</td><td className="num">{s.raw_records != null ? fmtNum(s.raw_records) : '—'}</td>
                  {can('integrations.manage') && <td className="nowrap">{s.kind !== 'stream' && <>
                    <button className="btn sm" disabled={busy} onClick={() => act(() => api('/analytics/pipeline/run', { method: 'POST', body: { source: s.key } }), `${s.label}: pulled`)}>Re-run</button>{' '}
                    <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api('/analytics/pipeline/replay', { method: 'POST', body: { source: s.key } }), 'Rebuilt from raw data')}>Replay raw</button>{' '}
                    <button className="btn sm ghost" disabled={busy} title="Demo: make the next pulls fail to see the alert" onClick={() => act(() => api('/analytics/pipeline/simulate-failure', { method: 'POST', body: { source: s.key, on: !s.simulate_failure } }), s.simulate_failure ? 'Failure simulation off' : 'Next pulls will fail')}>{s.simulate_failure ? 'Stop failing' : 'Simulate failure'}</button>
                  </>}</td>}
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
          <Card title="Unmapped values" sub={`Campaign tags the taxonomy does not know yet. They are shown here, never hidden in "other". ${d.unmatched_touchpoints} touchpoints wait for a mapping.`}>
            {d.unmapped.length ? (
              <table className="t"><thead><tr><th>utm_source / utm_medium</th><th>Seen in</th><th className="num">Count</th><th>First seen</th><th>Map to channel</th></tr></thead>
                <tbody>{d.unmapped.map((u) => (
                  <tr key={u.id}><td className="mono">{u.value}</td><td>{u.source}</td><td className="num">{u.count}</td><td className="small">{fmtDateTime(u.first_seen_at)}</td>
                    <td>{u.resolved_channel_id ? <Status value="success">{u.resolved_name}</Status> : can('costs.edit') ? (
                      <span className="row"><select className="i inline" aria-label={`Channel for ${u.value}`} value={map[u.id] || ''} onChange={(e) => setMap({ ...map, [u.id]: e.target.value })}><option value="">Choose…</option>{(channels.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        <button className="btn sm" disabled={!map[u.id] || busy} onClick={() => act(() => api(`/analytics/unmapped/${u.id}/resolve`, { method: 'POST', body: { channel_id: Number(map[u.id]) } }), 'Mapped; attribution recomputed')}>Map</button></span>
                    ) : <span className="faint">waiting</span>}</td></tr>
                ))}</tbody></table>
            ) : <div className="empty">Every tag maps to a channel.</div>}
          </Card>
        </>
      )}</Async>
    </>
  );
}
