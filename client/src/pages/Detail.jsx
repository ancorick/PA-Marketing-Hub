import { Link, useParams } from 'react-router-dom';
import { useApi, useQueryState, fmtNum, fmtAmd, fmtMonth } from '../lib.jsx';
import { PageHead, Card, Tile, Async } from '../ui.jsx';
import { RangeFilters, rangeDefaults } from '../filters.jsx';
import { HBars, LineChart, Bars } from '../charts.jsx';

export function ChannelDetail() {
  const { id } = useParams();
  const [q, setQ] = useQueryState(rangeDefaults('lq'));
  const qs = `from=${q.from}&to=${q.to}&model=${q.model}`;
  const state = useApi(`/analytics/channels/${id}?${qs}`, [qs, id]);
  return (
    <Async state={state}>{(d) => (
      <>
        <PageHead title={d.channel.name} sub={<><Link to={`/?${qs}`}>← Overview</Link> · Funnel from lead to hired, campaigns inside the channel and a 12-month trend.</>} />
        <RangeFilters q={q} setQ={setQ} />
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Tile label="Spend" value={d.spend ? fmtAmd(d.spend) : 'No spend'} />
          <Tile label="Leads" value={fmtNum(d.funnel[0].value)} />
          <Tile label="Cost per lead" value={d.spend ? fmtAmd(d.cost_per_lead) : '—'} />
          <Tile label="Cost per enrolled student" value={d.spend ? fmtAmd(d.cost_per_enrolled) : '—'} />
        </div>
        <div className="grid grid-2">
          <Card title="Funnel" sub="Credited outcomes in the period; % is conversion from the previous stage">
            <HBars funnel rows={d.funnel} labelKey="stage" valueKey="value" title="Funnel" note="Outcomes in the period can belong to people whose earlier stages happened before it, so stages are not a strict cohort. Use Cohorts for that." />
          </Card>
          <Card title="Leads and enrolled students, last 12 months">
            <LineChart rows={d.trend} xKey="month" xFormat={fmtMonth} series={[{ key: 'leads', label: 'Leads' }, { key: 'enrolled', label: 'Enrolled' }]} title="Leads and enrolled students per month" />
          </Card>
        </div>
        <Card title="Spend per month" className="" >
          <Bars rows={d.trend} xKey="month" valueKey="spend" label="Spend (AMD)" format={fmtAmd} xFormat={fmtMonth} />
        </Card>
        <Card title="Campaigns" sub="Campaigns with spend or outcomes in the period">
          {d.campaigns.length ? (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Campaign</th><th>utm_campaign</th><th className="num">Spend</th><th className="num">Leads</th><th className="num">Applied</th><th className="num">Enrolled</th><th className="num">Hired</th><th className="num">Cost per lead</th><th className="num">Cost per enrolled</th></tr></thead>
              <tbody>{d.campaigns.map((c) => (
                <tr key={c.id}><td><Link to={`/campaign-stats/${c.id}?${qs}`}>{c.name}</Link></td><td className="mono faint">{c.utm_campaign}</td><td className="num">{fmtAmd(c.spend)}</td>
                  <td className="num">{fmtNum(c.leads)}</td><td className="num">{fmtNum(c.applied)}</td><td className="num">{fmtNum(c.enrolled)}</td><td className="num">{fmtNum(c.hired)}</td>
                  <td className="num">{c.spend ? fmtAmd(c.cost_per_lead) : '—'}</td><td className="num">{c.spend ? fmtAmd(c.cost_per_enrolled) : '—'}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <div className="empty">No campaign activity in this period.</div>}
        </Card>
      </>
    )}</Async>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const [q, setQ] = useQueryState(rangeDefaults('12m'));
  const qs = `from=${q.from}&to=${q.to}&model=${q.model}`;
  const state = useApi(`/analytics/campaigns/${id}?${qs}`, [qs, id]);
  return (
    <Async state={state}>{(d) => (
      <>
        <PageHead title={d.campaign.name} sub={<><Link to={`/channels/${d.campaign.channel_id}?${qs}`}>← {d.campaign.channel_name}</Link> · <span className="mono">{d.campaign.utm_campaign}</span></>} />
        <RangeFilters q={q} setQ={setQ} />
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Tile label="Spend" value={fmtAmd(d.spend)} />
          <Tile label="Cost per lead" value={fmtAmd(d.cost_per_lead)} />
          <Tile label="Cost per enrolled student" value={fmtAmd(d.cost_per_enrolled)} />
          <Tile label="Cost per hired graduate" value={fmtAmd(d.cost_per_hired)} sub="Hires lag spend by months" />
        </div>
        <div className="grid grid-2">
          <Card title="Funnel"><HBars funnel rows={d.funnel} labelKey="stage" valueKey="value" title="Campaign funnel" /></Card>
          <Card title="Tracked links">
            {d.links.length ? <ul className="list-plain">{d.links.map((l) => <li key={l.code}><div className="mono small" style={{ overflowWrap: 'anywhere' }}>{l.url}</div><div className="faint small">/l/{l.code} · {l.hits} clicks</div></li>)}</ul>
              : <div className="empty">No short links yet. Create one in <Link to="/links">Campaigns &amp; links</Link>.</div>}
          </Card>
        </div>
      </>
    )}</Async>
  );
}
