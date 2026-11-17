import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, useAction, useCan, fmtAmd, fmtDate } from '../lib.jsx';
import { PageHead, Card, Async, Field, Modal } from '../ui.jsx';

export default function Links() {
  const can = useCan();
  const channels = useApi('/channels');
  const campaigns = useApi('/campaigns');
  const links = useApi('/links');
  const [run, busy] = useAction();
  const [b, setB] = useState({ url: 'https://', campaign_id: '', content: '' });
  const [result, setResult] = useState(null);
  const [edit, setEdit] = useState(null);
  const [filter, setFilter] = useState('');

  const build = async (e) => {
    e.preventDefault();
    const r = await run(() => api('/links', { method: 'POST', body: { ...b, campaign_id: Number(b.campaign_id) } }), 'Tracked link created');
    if (r) { setResult(r); links.reload(); }
  };
  const save = async () => {
    const body = { ...edit, channel_id: Number(edit.channel_id), budget_amd: edit.budget_amd ? Number(edit.budget_amd) : null };
    if (await run(() => api(edit.id ? `/campaigns/${edit.id}` : '/campaigns', { method: edit.id ? 'PUT' : 'POST', body }), 'Campaign saved')) { setEdit(null); campaigns.reload(); }
  };
  const copy = (t) => navigator.clipboard?.writeText(t);
  return (
    <>
      <PageHead title="Campaigns & links" sub="One channel taxonomy for everything. The link builder adds utm parameters from it, so nobody types campaign tags by hand.">
        {can('campaigns.edit') && <button className="btn primary" onClick={() => setEdit({ name: '', channel_id: '', utm_campaign: '', start_date: '', end_date: '', budget_amd: '', is_recruitment: true })}>New campaign</button>}
      </PageHead>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Link builder" sub="Tagged URL plus a short link that counts clicks">
          <form onSubmit={build}>
            <Field label="Destination URL" id="lb-u"><input id="lb-u" className="i" type="url" value={b.url} onChange={(e) => setB({ ...b, url: e.target.value })} required /></Field>
            <Field label="Campaign" id="lb-c"><select id="lb-c" className="i" value={b.campaign_id} onChange={(e) => setB({ ...b, campaign_id: e.target.value })} required>
              <option value="">Choose…</option>{(campaigns.data || []).map((c) => <option key={c.id} value={c.id}>{c.channel_name} · {c.name}</option>)}</select></Field>
            <Field label="Content (optional)" id="lb-ct" hint="Tells two links in the same campaign apart, e.g. story_ad or bio_link"><input id="lb-ct" className="i" value={b.content} onChange={(e) => setB({ ...b, content: e.target.value })} /></Field>
            <button className="btn primary" disabled={busy || !can('campaigns.edit')}>Create tracked link</button>
          </form>
          {result && (
            <div className="stack" style={{ marginTop: 14 }}>
              <div><label className="f">Tagged URL</label><div className="code-box">{result.tagged}</div><button className="btn sm" style={{ marginTop: 6 }} onClick={() => copy(result.tagged)}>Copy</button></div>
              <div><label className="f">Short link</label><div className="code-box">{result.short}</div><button className="btn sm" style={{ marginTop: 6 }} onClick={() => copy(result.short)}>Copy</button></div>
            </div>
          )}
        </Card>
        <Card title="Channel taxonomy" sub="utm_source / utm_medium per channel. Unknown pairs go to Data health for mapping.">
          <Async state={channels}>{(rows) => (
            <table className="t"><thead><tr><th>Channel</th><th>Group</th><th>Default tags</th></tr></thead>
              <tbody>{rows.map((c) => <tr key={c.id}><td><Link to={`/channels/${c.id}`}>{c.name}</Link></td><td><span className="badge">{c.grp}</span></td><td className="mono small">{c.utm_source} / {c.utm_medium}</td></tr>)}</tbody></table>
          )}</Async>
        </Card>
      </div>
      <Card title="Campaigns" actions={<input className="i inline" placeholder="Filter…" aria-label="Filter campaigns" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        <Async state={campaigns}>{(rows) => (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Campaign</th><th>Channel</th><th>utm_campaign</th><th>Dates</th><th className="num">Budget</th><th /></tr></thead>
            <tbody>{rows.filter((c) => !filter || `${c.name} ${c.utm_campaign} ${c.channel_name}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 150).map((c) => (
              <tr key={c.id}><td><Link to={`/campaign-stats/${c.id}`}>{c.name}</Link></td><td>{c.channel_name}</td><td className="mono small">{c.utm_campaign}</td>
                <td className="small nowrap">{c.start_date ? fmtDate(c.start_date) : '—'}{c.end_date ? ` – ${fmtDate(c.end_date)}` : ''}</td><td className="num">{c.budget_amd ? fmtAmd(c.budget_amd) : '—'}</td>
                <td>{can('campaigns.edit') && <button className="btn sm ghost" onClick={() => setEdit({ ...c, is_recruitment: !!c.is_recruitment })}>Edit</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}</Async>
      </Card>
      <Card title="Recent short links">
        <Async state={links}>{(rows) => rows.length ? (
          <table className="t"><thead><tr><th>Short link</th><th>Campaign</th><th>Destination</th><th className="num">Clicks</th></tr></thead>
            <tbody>{rows.map((l) => <tr key={l.code}><td className="mono small">{l.short}</td><td>{l.campaign_name}</td><td className="small" style={{ overflowWrap: 'anywhere', maxWidth: 420 }}>{l.url}</td><td className="num">{l.hits}</td></tr>)}</tbody></table>
        ) : <div className="empty">No links yet.</div>}</Async>
      </Card>
      {edit && (
        <Modal title={edit.id ? 'Edit campaign' : 'New campaign'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
          <Field label="Name" id="e-n"><input id="e-n" className="i" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Channel" id="e-c"><select id="e-c" className="i" value={edit.channel_id} onChange={(e) => setEdit({ ...edit, channel_id: e.target.value })}><option value="">Choose…</option>{(channels.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="utm_campaign" id="e-u" hint="Lowercase letters, digits, _ and -"><input id="e-u" className="i mono" value={edit.utm_campaign} onChange={(e) => setEdit({ ...edit, utm_campaign: e.target.value })} /></Field>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Start" id="e-s"><input id="e-s" className="i" type="date" value={edit.start_date || ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} /></Field>
            <Field label="End" id="e-e"><input id="e-e" className="i" type="date" value={edit.end_date || ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} /></Field>
          </div>
          <Field label="Budget (AMD)" id="e-b"><input id="e-b" className="i" type="number" value={edit.budget_amd || ''} onChange={(e) => setEdit({ ...edit, budget_amd: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={edit.is_recruitment} onChange={(e) => setEdit({ ...edit, is_recruitment: e.target.checked })} /> Recruitment campaign</label>
        </Modal>
      )}
    </>
  );
}
