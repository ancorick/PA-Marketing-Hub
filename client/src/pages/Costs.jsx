import { useState } from 'react';
import { api, useApi, useAction, useCan, fmtAmd, fmtNum, fmtDate, isoDay, readFileText } from '../lib.jsx';
import { PageHead, Card, Async, Field, Seg, Confirm } from '../ui.jsx';

export default function Costs() {
  const can = useCan();
  const [source, setSource] = useState('');
  const costs = useApi(`/costs${source ? `?source=${source}` : ''}`, [source]);
  const channels = useApi('/channels');
  const campaigns = useApi('/campaigns');
  const fx = useApi('/fx');
  const [run, busy] = useAction();
  const [form, setForm] = useState({ channel_id: '', campaign_id: '', date_from: isoDay(Date.now() - 30 * 864e5), date_to: isoDay(Date.now()), amount: '', currency: 'AMD', note: '' });
  const [rate, setRate] = useState({ currency: 'USD', date: isoDay(Date.now()), rate: '' });
  const [csv, setCsv] = useState({ platform: 'meta', text: '' });
  const [del, setDel] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = async (e) => {
    e.preventDefault();
    if (await run(() => api('/costs', { method: 'POST', body: { ...form, channel_id: Number(form.channel_id), campaign_id: form.campaign_id ? Number(form.campaign_id) : null } }), 'Cost added')) {
      setForm((f) => ({ ...f, amount: '', note: '' })); costs.reload();
    }
  };
  const campOpts = (campaigns.data || []).filter((c) => !form.channel_id || String(c.channel_id) === String(form.channel_id));
  return (
    <>
      <PageHead title="Costs" sub="Ad spend arrives from the ad platform APIs. Enter everything else here: agency fees, printed materials, sponsorships, venue costs. All costs are stored in AMD; other currencies convert at the Central Bank of Armenia rate on the spend date and keep the original amount." />
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        {can('costs.edit') && (
          <Card title="Add a manual cost">
            <form onSubmit={add}>
              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="Channel" id="c-ch"><select id="c-ch" className="i" value={form.channel_id} onChange={set('channel_id')} required><option value="">Choose…</option>{(channels.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                <Field label="Campaign (optional)" id="c-ca"><select id="c-ca" className="i" value={form.campaign_id} onChange={set('campaign_id')}><option value="">Whole channel</option>{campOpts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                <Field label="From" id="c-f"><input id="c-f" className="i" type="date" value={form.date_from} onChange={set('date_from')} required /></Field>
                <Field label="To" id="c-t"><input id="c-t" className="i" type="date" value={form.date_to} onChange={set('date_to')} required /></Field>
                <Field label="Amount" id="c-a"><input id="c-a" className="i" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required /></Field>
                <Field label="Currency" id="c-cu"><select id="c-cu" className="i" value={form.currency} onChange={set('currency')}>{['AMD', 'USD', 'EUR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
              </div>
              <Field label="Note" id="c-n"><input id="c-n" className="i" value={form.note} onChange={set('note')} placeholder="e.g. Printed flyers for the December open day" /></Field>
              <button className="btn primary" disabled={busy}>Add cost</button>
            </form>
          </Card>
        )}
        <Card title="Exchange rates" sub="Used for costs in foreign currencies. Demo values are approximate; load official CBA rates in production.">
          <Async state={fx}>{(rows) => {
            const latest = Object.values(rows.reduce((a, r) => { if (!a[r.currency]) a[r.currency] = r; return a; }, {}));
            return <div className="row" style={{ marginBottom: 12 }}>{latest.map((r) => <span key={r.currency} className="badge info">1 {r.currency} = {fmtNum(r.rate_amd, 2)} AMD · {fmtDate(r.date)}</span>)}</div>;
          }}</Async>
          {can('costs.edit') && (
            <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/fx', { method: 'POST', body: rate }), 'Rate saved')) fx.reload(); }}>
              <select className="i inline" aria-label="Currency" value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value })}>{['USD', 'EUR', 'RUB', 'GBP'].map((c) => <option key={c}>{c}</option>)}</select>
              <input className="i inline" aria-label="Date" type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} />
              <input className="i inline" aria-label="Rate in AMD" type="number" step="0.01" placeholder="AMD" value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} required style={{ width: 110 }} />
              <button className="btn" disabled={busy}>Save rate</button>
            </form>
          )}
          {can('costs.edit') && (
            <div style={{ marginTop: 18 }}>
              <h3>Ad report CSV (fallback while API access is pending)</h3>
              <p className="small muted">Columns: date, utm_campaign, spend, currency, impressions, clicks, leads.</p>
              <div className="row">
                <Seg label="Platform" value={csv.platform} onChange={(v) => setCsv({ ...csv, platform: v })} options={[['meta', 'Meta Ads'], ['google', 'Google Ads']]} />
                <input type="file" accept=".csv,text/csv" aria-label="Ad report CSV" onChange={async (e) => { const f = e.target.files[0]; if (f) setCsv({ ...csv, text: await readFileText(f) }); }} />
                <button className="btn" disabled={!csv.text || busy} onClick={async () => { if (await run(() => api('/ads/csv', { method: 'POST', body: { platform: csv.platform, csv: csv.text } }), 'Ad report imported')) costs.reload(); }}>Import</button>
              </div>
            </div>
          )}
        </Card>
      </div>
      <Card title="Cost entries" actions={<Seg label="Source" value={source} onChange={setSource} options={[['', 'All'], ['api', 'Ad APIs'], ['manual', 'Manual'], ['event_hub', 'Event Hub'], ['csv', 'CSV']]} />}>
        <Async state={costs}>{(rows) => (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Dates</th><th>Channel</th><th>Campaign</th><th className="num">Amount (AMD)</th><th className="num">Original</th><th>Source</th><th>Note</th><th /></tr></thead>
            <tbody>{rows.slice(0, 200).map((c) => (
              <tr key={c.id}>
                <td className="nowrap">{c.date_from === c.date_to ? fmtDate(c.date_from) : `${fmtDate(c.date_from)} – ${fmtDate(c.date_to)}`}</td>
                <td>{c.channel_name}</td><td className="small">{c.campaign_name || <span className="faint">—</span>}</td>
                <td className="num">{fmtAmd(c.amount_amd)}</td>
                <td className="num small faint">{c.original_currency !== 'AMD' ? `${fmtNum(c.original_amount, 2)} ${c.original_currency} @ ${c.fx_rate}` : ''}</td>
                <td><span className="badge">{c.source}</span></td><td className="small">{c.note}</td>
                <td>{c.source === 'manual' && can('costs.edit') && <button className="btn sm ghost danger" onClick={() => setDel(c)}>Delete</button>}</td>
              </tr>
            ))}</tbody>
          </table>{rows.length > 200 && <p className="hint">Showing 200 of {rows.length}.</p>}</div>
        )}</Async>
      </Card>
      {del && <Confirm title="Delete this cost?" danger confirmLabel="Delete" busy={busy} onClose={() => setDel(null)}
        text={`${fmtAmd(del.amount_amd)} on ${del.channel_name} (${del.note || 'no note'}) will be removed and every cost-per figure that uses it will change.`}
        onConfirm={async () => { if (await run(() => api(`/costs/${del.id}`, { method: 'DELETE' }), 'Cost deleted')) { setDel(null); costs.reload(); } }} />}
    </>
  );
}
