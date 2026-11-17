import { useApi, fmtNum, fmtPct, fmtMonth, LANG_LABEL } from '../lib.jsx';
import { PageHead, Card, Tile, Async } from '../ui.jsx';
import { Bars, LineChart } from '../charts.jsx';

export default function AudienceHealth() {
  const state = useApi('/analytics/audience');
  return (
    <>
      <PageHead title="Audience health" sub="Growth, consent coverage, duplicates and list hygiene: the metrics M3 and M4 from the PRD." />
      <Async state={state}>{(d) => (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <Tile label="Contacts" value={fmtNum(d.total)} />
            <Tile label="Consent recorded (newsletter)" value={fmtPct(d.consent.coverage, 0)} sub={`${fmtNum(d.consent.granted)} granted · ${fmtNum(d.consent.unknown)} unknown`} />
            <Tile label="M4 · recipients with consent record" value={fmtPct(d.m4_recipients_with_consent, 1)} sub="Last 90 days · target 100%" />
            <Tile label="M3 · duplicate rate" value={fmtPct(d.m3_duplicate_rate, 2)} sub="Same normalized email · target under 1%" />
          </div>
          <div className="grid grid-2">
            <Card title="New contacts per month"><Bars rows={d.growth} xKey="month" valueKey="n" label="New contacts" xFormat={fmtMonth} /></Card>
            <Card title="Leaving the list per month" sub="Suppressions recorded"><LineChart rows={d.unsubs} xKey="month" xFormat={fmtMonth} series={[{ key: 'unsubscribed', label: 'Unsubscribed' }, { key: 'bounced', label: 'Bounced' }, { key: 'complaints', label: 'Complaints' }]} /></Card>
          </div>
          <div className="grid grid-3" style={{ marginTop: 16 }}>
            <Card title="By lifecycle type"><table className="t"><tbody>{d.byType.map((r) => <tr key={r.type}><td>{r.type}</td><td className="num">{fmtNum(r.n)}</td></tr>)}</tbody></table></Card>
            <Card title="By language"><table className="t"><tbody>{d.byLang.map((r) => <tr key={r.language}><td>{LANG_LABEL[r.language]}</td><td className="num">{fmtNum(r.n)}</td></tr>)}</tbody></table></Card>
            <Card title="Largest segments"><table className="t"><tbody>{d.segments.slice(0, 8).map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{fmtNum(s.last_count)}</td></tr>)}</tbody></table></Card>
          </div>
        </>
      )}</Async>
    </>
  );
}
