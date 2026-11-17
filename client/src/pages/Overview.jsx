import { useNavigate } from 'react-router-dom';
import { useApi, useQueryState, fmtNum, fmtAmd, fmtPct, useSession } from '../lib.jsx';
import { PageHead, Card, Tile, Async, Seg, Info } from '../ui.jsx';
import { RangeFilters, rangeDefaults, MODEL_HELP } from '../filters.jsx';
import { HBars } from '../charts.jsx';

export default function Overview() {
  const [q, setQ] = useQueryState({ ...rangeDefaults('lq'), view: 'period' });
  const s = useSession();
  const qs = `from=${q.from}&to=${q.to}&model=${q.model}&view=${q.view}`;
  const state = useApi(`/analytics/overview?${qs}`, [qs]);
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Which channel brings students who enroll, finish and get hired?"
        sub="Cost per enrolled student and per hired graduate for every channel, joined from website, social, ads, email, events, Navigator CRM, Core Engine and Alumni Tracker.">
        <a className="btn" href={`/api/analytics/export/overview?${qs}`}>Export CSV</a>
        <button className="btn" onClick={() => window.print()}>Print / PDF</button>
      </PageHead>
      <RangeFilters q={q} setQ={setQ}>
        <span className="row small" style={{ gap: 6 }}><span className="muted">View</span>
          <Seg label="View" value={q.view} onChange={(v) => setQ({ view: v })} options={[['period', 'Period'], ['cohort', 'Cohort']]} />
          <Info text="Period: what happened in these dates. Cohort: outcomes of the people whose first touch was in these months, so cost and outcomes belong to the same people." />
        </span>
      </RangeFilters>
      <Async state={state}>{(d) => (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <Tile label="Newsletter subscribers" value={fmtNum(d.tiles.subscribers)} sub="Active, with newsletter consent" />
            <Tile label="Newsletter click rate" value={fmtPct(d.tiles.newsletter_click_rate)} sub={`Opens ${fmtPct(d.tiles.newsletter_open_rate_estimated, 0)} (estimated) · last 3 issues`} help={d.definitions.open_rate} />
            <Tile label="New leads" value={fmtNum(d.tiles.new_leads)} sub={`${q.from} – ${q.to}`} help={d.definitions.lead} />
            <Tile label="Enrolled from them" value={fmtNum(d.tiles.enrolled_from_new_leads)} sub="So far; later enrollments still count" help={d.definitions.enrolled} />
          </div>
          <Card title={q.view === 'cohort' ? 'Outcomes and cost by channel, cohort view' : 'Outcomes and cost by channel'}
            sub={`${MODEL_HELP[q.model]}${d.maturing ? ' Cohorts younger than 12 months are still maturing: hires will keep arriving.' : ''}`}>
            <div className="table-wrap">
              <table className="t">
                <thead><tr>
                  <th>Channel</th><th className="num">Leads</th><th className="num">Enrolled</th><th className="num">Hired</th><th className="num">Spend</th>
                  <th className="num">Cost per lead</th><th className="num" style={{ minWidth: 200 }}>Cost per enrolled student</th>
                  {q.view === 'cohort' && <th className="num">Cost per hired graduate</th>}
                </tr></thead>
                <tbody>
                  {d.channels.map((c) => {
                    const maxCpe = Math.max(...d.channels.map((x) => (typeof x.cost_per_enrolled === 'number' ? x.cost_per_enrolled : 0)), 1);
                    return (
                      <tr key={c.channel_id} className="clickable" onClick={() => nav(`/channels/${c.channel_id}?from=${q.from}&to=${q.to}&model=${q.model}`)}>
                        <td><a href={`/channels/${c.channel_id}`} onClick={(e) => e.preventDefault()}>{c.channel}</a></td>
                        <td className="num">{fmtNum(c.leads)}</td><td className="num">{fmtNum(c.enrolled)}</td><td className="num">{fmtNum(c.hired)}</td>
                        <td className="num">{c.spend ? fmtAmd(c.spend) : <span className="faint">no spend</span>}</td>
                        <td className="num">{c.spend ? fmtAmd(c.cost_per_lead) : '—'}</td>
                        <td className="num">
                          {!c.spend ? <span className="faint">no ad spend</span> : c.cost_per_enrolled == null ? '—' : (
                            <div className="bar-cell"><span>{fmtAmd(c.cost_per_enrolled)}</span><span className="bar" style={{ width: `${Math.max(2, (c.cost_per_enrolled / maxCpe) * 90)}px` }} /></div>
                          )}
                        </td>
                        {q.view === 'cohort' && <td className="num">{c.spend ? fmtAmd(c.cost_per_hired) : '—'}{c.maturing && c.cost_per_hired != null && <span className="badge warn" style={{ marginLeft: 6 }}>maturing</span>}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr>
                  <td>All channels</td><td className="num">{fmtNum(d.totals.leads)}</td><td className="num">{fmtNum(d.totals.enrolled)}</td><td className="num">{fmtNum(d.totals.hired)}</td>
                  <td className="num">{fmtAmd(d.totals.spend)}</td><td className="num">{fmtAmd(d.totals.cost_per_lead)}</td><td className="num">{fmtAmd(d.totals.cost_per_enrolled)}</td>
                  {q.view === 'cohort' && <td />}
                </tr></tfoot>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Credited counts can be fractional under the position-based model. Spend is in AMD, prorated by days; foreign-currency costs use the Central Bank of Armenia rate on the spend date.
              {s.aggregateOnly && ' Counts under 3 are hidden in the aggregate view.'}
            </p>
          </Card>
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <Card title="Enrolled students by channel" sub="Credited by the selected model">
              <HBars rows={d.channels.filter((c) => c.enrolled || c.leads)} labelKey="channel" valueKey="enrolled" title="Enrolled students by channel" />
            </Card>
            <Card title="Can we trust these numbers?">
              <dl className="kv">
                <dt>Attributed enrollments (M1)</dt><dd>{fmtPct(d.coverage.rate, 0)} of {fmtNum(d.coverage.enrolled)} enrolled students have a known first-touch channel <span className="faint">(target 90%)</span></dd>
                <dt>Unattributed</dt><dd>{fmtNum(d.unattributed.leads)} leads, {fmtNum(d.unattributed.enrolled)} enrolled</dd>
                <dt>Self-reported check</dt><dd>{d.self_reported.rate == null ? 'No answers yet' : `${fmtPct(d.self_reported.rate, 0)} of ${d.self_reported.total} applicants named the same channel as tracked first touch`}</dd>
                <dt>Model</dt><dd>Every number on this page uses <b>{q.model.replace('_', ' ')}</b>. Models are never mixed in one number.</dd>
              </dl>
              <div className="callout small" style={{ marginTop: 12 }}>Attribution shows association, not cause and effect. Compare first and last touch before moving budget, and check the Cohorts view for hires.</div>
            </Card>
          </div>
        </>
      )}</Async>
    </>
  );
}
