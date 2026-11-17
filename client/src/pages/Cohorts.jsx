import { useApi, useQueryState, fmtNum, fmtAmd, fmtMonth } from '../lib.jsx';
import { PageHead, Card, Async } from '../ui.jsx';
import { MODELS } from '../filters.jsx';
import { LineChart } from '../charts.jsx';

export default function Cohorts() {
  const [q, setQ] = useQueryState({ model: 'first_touch', channel: '' });
  const channels = useApi('/channels');
  const qs = `model=${q.model}${q.channel ? `&channel=${q.channel}` : ''}`;
  const state = useApi(`/analytics/cohorts?${qs}`, [qs]);
  return (
    <>
      <PageHead title="Cohorts" sub="Outcomes grouped by the month of first touch, so cost and outcomes belong to the same people. Cost per hired graduate is final only for cohorts at least 12 months old.">
        <a className="btn" href={`/api/analytics/export/cohorts?${qs}`}>Export CSV</a>
      </PageHead>
      <div className="card no-print" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row">
          <label className="row small"><span className="muted">Attribution</span><select className="i inline" value={q.model} onChange={(e) => setQ({ model: e.target.value })}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="row small"><span className="muted">Channel</span><select className="i inline" value={q.channel} onChange={(e) => setQ({ channel: e.target.value })}>
            <option value="">All channels</option>{(channels.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
      </div>
      <Async state={state}>{(d) => (
        <>
          <Card title="Leads and enrolled students by cohort month">
            <LineChart rows={[...d.rows].reverse()} xKey="cohort" xFormat={fmtMonth} series={[{ key: 'leads', label: 'Leads' }, { key: 'enrolled', label: 'Enrolled' }, { key: 'hired', label: 'Hired' }]} title="Cohort outcomes" />
          </Card>
          <Card title="Cohort table">
            <div className="table-wrap"><table className="t">
              <thead><tr><th>First-touch month</th><th className="num">Leads</th><th className="num">Applied</th><th className="num">Enrolled</th><th className="num">Completed</th><th className="num">Hired</th><th className="num">Spend</th><th className="num">Cost per enrolled</th><th className="num">Cost per hired</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.cohort}>
                  <td className="nowrap">{fmtMonth(r.cohort)} {r.maturing && <span className="badge warn" title={`${r.age_months} months old; hires are still arriving`}>maturing</span>}</td>
                  <td className="num">{fmtNum(r.leads)}</td><td className="num">{fmtNum(r.applied)}</td><td className="num">{fmtNum(r.enrolled)}</td><td className="num">{fmtNum(r.completed)}</td><td className="num">{fmtNum(r.hired)}</td>
                  <td className="num">{fmtAmd(r.spend)}</td><td className="num">{fmtAmd(r.cost_per_enrolled)}</td>
                  <td className="num">{r.maturing ? <span className="faint" title="Not final until the cohort is 12 months old">{r.cost_per_hired ? `${fmtAmd(r.cost_per_hired)} (so far)` : '—'}</span> : fmtAmd(r.cost_per_hired)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        </>
      )}</Async>
    </>
  );
}
