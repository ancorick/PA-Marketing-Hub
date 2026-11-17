import { useEffect, useState } from 'react';
import { api, useApi, useAction, useCan, useSession, fmtNum, fmtPct, fmtDateTime, readFileText } from '../lib.jsx';
import { PageHead, Card, Async, Status, Field, Confirm, Modal, Tile } from '../ui.jsx';

function Domain({ d, can, reload }) {
  const [run, busy] = useAction();
  const act = async (path, body, ok) => { if (await run(() => api(`/email/domains/${d.id}/${path}`, { method: 'POST', body }), ok)) reload(); };
  const next = { none: 'quarantine', quarantine: 'reject' }[d.dmarc_policy];
  return (
    <Card title={d.domain} sub={`${d.stream} stream · From: ${d.from_name} <${d.from_address}> · tracking ${d.tracking_domain}${d.verification_mode === 'simulated' ? ' · demo: simulated DNS' : ''}`}
      actions={<>{d.authenticated ? <Status value="verified">Authenticated</Status> : <Status value="missing">Sends blocked</Status>}
        {can('integrations.manage') && <><button className="btn sm" disabled={busy} onClick={() => act('verify', {}, 'DNS checked')}>Check DNS now</button><button className="btn sm ghost" disabled={busy} onClick={() => act('rotate-dkim', {}, 'New DKIM selector; publish the new record')}>Rotate DKIM</button></>}</>}>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Record</th><th>Type</th><th>Host</th><th>Value</th><th>Status</th></tr></thead>
        <tbody>{d.records.map((r) => (
          <tr key={r.kind}><td><b>{r.kind}</b><div className="faint small" style={{ maxWidth: 260 }}>{r.note}</div></td><td>{r.type}</td><td className="mono small">{r.host}</td><td className="mono small" style={{ maxWidth: 380, overflowWrap: 'anywhere' }}>{r.value}</td>
            <td><Status value={d[`${r.kind.toLowerCase()}_status`]} /></td></tr>
        ))}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 12, gap: 18 }}>
        <span>DMARC policy: <b>p={d.dmarc_policy}</b>{next && can('integrations.manage') && <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => act('dmarc-policy', { policy: next }, `Policy moved to ${next}`)}>Move to {next}</button>}</span>
        <span>Warm-up: {d.warmup.started ? (d.warmup.done ? <span className="badge good">complete</span> : <>day {d.warmup.day} of {d.warmup.totalDays} · cap {fmtNum(d.warmup.cap)}/day · {fmtNum(d.warmup.sentToday)} sent today</>) : <span className="badge warn">starts when the domain verifies</span>}</span>
        <span className="faint small">Last check {fmtDateTime(d.last_check)}</span>
      </div>
    </Card>
  );
}

export default function EmailSettings() {
  const can = useCan();
  const session = useSession();
  const domains = useApi('/email/domains');
  const dmarc = useApi('/email/dmarc');
  const guard = useApi('/email/guardrails');
  const seeds = useApi(can('campaigns.edit') ? '/email/seed-list' : null);
  const [run, busy] = useAction();
  const [kill, setKill] = useState(false);
  const [g, setG] = useState(null);
  const [newDomain, setNewDomain] = useState(null);
  const [seed, setSeed] = useState('');
  const [check, setCheck] = useState({ email: '', result: null });
  useEffect(() => { if (guard.data) setG(guard.data); }, [guard.data]);
  return (
    <>
      <PageHead title="Email settings" sub="All marketing email leaves through the email service provider on an authenticated subdomain of the Academy's domain. Sends are blocked while SPF, DKIM or DMARC fail.">
        {can('killswitch') && (session.killSwitch
          ? <button className="btn" onClick={async () => { if (await run(() => api('/email/killswitch', { method: 'POST', body: { on: false } }), 'Sending resumed')) session.refresh(); }}>Resume all sending</button>
          : <button className="btn danger solid" onClick={() => setKill(true)}>Kill switch: pause all sending</button>)}
        {can('integrations.manage') && <button className="btn" onClick={() => setNewDomain({ domain: '', from_name: 'Picsart Academy', verification_mode: 'dns', stream: 'marketing' })}>Add domain</button>}
      </PageHead>
      <Async state={domains}>{(rows) => <div className="stack">{rows.map((d) => <Domain key={d.id} d={d} can={can} reload={domains.reload} />)}</div>}</Async>
      <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <Card title="DMARC aggregate reports" sub="Pass rate of SPF/DKIM alignment (metric M6, target 99%)" actions={can('integrations.manage') && <label className="btn sm">Upload XML<input type="file" accept=".xml" hidden onChange={async (e) => { const f = e.target.files[0]; if (f && await run(async () => api('/email/dmarc', { method: 'POST', body: { xml: await readFileText(f) } }), 'Report parsed')) dmarc.reload(); }} /></label>}>
          <Async state={dmarc}>{(d) => d.total ? (
            <>
              <div className="grid grid-2"><Tile label="Alignment pass rate" value={fmtPct(d.passRate)} /><Tile label="Messages reported" value={fmtNum(d.total)} /></div>
              <table className="t" style={{ marginTop: 12 }}><thead><tr><th>Source IP</th><th className="num">Pass</th><th className="num">Fail</th></tr></thead>
                <tbody>{d.sources.map((s) => <tr key={s.source_ip}><td className="mono">{s.source_ip}</td><td className="num">{fmtNum(s.pass)}</td><td className="num">{s.fail ? <span className="err">{fmtNum(s.fail)}</span> : 0}</td></tr>)}</tbody></table>
            </>
          ) : <div className="empty">No reports yet. Mailbox providers send them to the rua address in the DMARC record; upload one here.</div>}</Async>
        </Card>
        <Card title="Guardrails" sub="A send pauses automatically and alerts the manager when a threshold is crossed">
          {g && (
            <>
              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="Hard bounce limit (first 1,000)" id="g1"><input id="g1" className="i" type="number" step="0.01" disabled={!can('integrations.manage')} value={g.guardrails.hard_bounce_rate} onChange={(e) => setG({ ...g, guardrails: { ...g.guardrails, hard_bounce_rate: Number(e.target.value) } })} /></Field>
                <Field label="Complaint limit" id="g2"><input id="g2" className="i" type="number" step="0.001" disabled={!can('integrations.manage')} value={g.guardrails.complaint_rate} onChange={(e) => setG({ ...g, guardrails: { ...g.guardrails, complaint_rate: Number(e.target.value) } })} /></Field>
                <Field label="Import first-send bounce limit" id="g3"><input id="g3" className="i" type="number" step="0.01" disabled={!can('integrations.manage')} value={g.guardrails.import_first_send_bounce_rate} onChange={(e) => setG({ ...g, guardrails: { ...g.guardrails, import_first_send_bounce_rate: Number(e.target.value) } })} /></Field>
                <Field label="Sunset after (months without engagement)" id="g4"><input id="g4" className="i" type="number" disabled={!can('integrations.manage')} value={g.sunset_months} onChange={(e) => setG({ ...g, sunset_months: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Warm-up daily caps" id="g5" hint="Daily send caps for a new domain, starting with the most engaged contacts"><input id="g5" className="i mono" disabled={!can('integrations.manage')} value={g.warmup_caps.join(', ')} onChange={(e) => setG({ ...g, warmup_caps: e.target.value.split(',').map((x) => Number(x.trim())).filter(Boolean) })} /></Field>
              {can('integrations.manage') && <div className="row"><button className="btn" disabled={busy} onClick={() => run(() => api('/email/guardrails', { method: 'PUT', body: g }), 'Guardrails saved')}>Save</button>
                <button className="btn ghost" disabled={busy} title="Demo: simulates a provider account warning" onClick={() => run(() => api('/email/simulate-warning', { method: 'POST', body: {} }), 'Provider warning simulated; active sends paused')}>Simulate provider warning</button></div>}
              {can('send.approve') && <div className="row" style={{ marginTop: 10 }}><button className="btn ghost" disabled={busy} onClick={async () => { const r = await run(() => api('/email/sunset', { method: 'POST', body: {} })); if (r) alert(`Re-engagement: ${r.reengage} contacts${r.draftSendId ? ` (draft send #${r.draftSendId} created for approval)` : ''}; moved to sunset: ${r.sunset}`); }}>Run sunset policy now</button></div>}
            </>
          )}
        </Card>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
        {can('campaigns.edit') && (
          <Card title="Seed list" sub="Test sends go here (desktop, mobile and dark mode inboxes)">
            <Async state={seeds}>{(rows) => <ul className="list-plain">{rows.map((s) => <li key={s.email} className="row between"><span>{s.email}</span><button className="btn sm ghost" onClick={async () => { await run(() => api(`/email/seed-list/${encodeURIComponent(s.email)}`, { method: 'DELETE' })); seeds.reload(); }}>Remove</button></li>)}</ul>}</Async>
            <form className="row" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/email/seed-list', { method: 'POST', body: { email: seed } }), 'Added')) { setSeed(''); seeds.reload(); } }}>
              <input className="i" type="email" aria-label="Seed address" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="qa@example.com" style={{ flex: 1 }} /><button className="btn">Add</button>
            </form>
          </Card>
        )}
        <Card title="Check an address" sub="Syntax, mail records of the domain, disposable domains">
          <form className="row" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api('/email/validate', { method: 'POST', body: { email: check.email } })); if (r) setCheck({ ...check, result: r }); }}>
            <input className="i" aria-label="Email address" value={check.email} onChange={(e) => setCheck({ email: e.target.value, result: null })} placeholder="name@domain" style={{ flex: 1 }} /><button className="btn">Check</button>
          </form>
          {check.result && <div className={`callout ${check.result.ok ? 'good' : 'bad'}`} style={{ marginTop: 10 }}>{check.result.ok ? `Looks deliverable${check.result.mx === 'unknown' || check.result.mx === 'timeout' ? ' (mail records could not be checked from here)' : ''}` : check.result.reason}</div>}
        </Card>
      </div>
      {kill && <Confirm title="Pause all sending?" danger confirmLabel="Pause everything" busy={busy} onClose={() => setKill(false)}
        text="Every campaign and newsletter stops within one tick of the send worker (about 5 seconds). Nothing is lost; resume when ready. The action is logged."
        onConfirm={async () => { if (await run(() => api('/email/killswitch', { method: 'POST', body: { on: true } }), 'All sending paused')) { setKill(false); session.refresh(); } }} />}
      {newDomain && (
        <Modal title="Add a sending domain" onClose={() => setNewDomain(null)} footer={<><button className="btn" onClick={() => setNewDomain(null)}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api('/email/domains', { method: 'POST', body: newDomain }), 'Domain added; publish the DNS records')) { setNewDomain(null); domains.reload(); } }}>Add</button></>}>
          <Field label="Subdomain" id="nd" hint="Use a dedicated subdomain, e.g. news.academy-domain.am"><input id="nd" className="i" value={newDomain.domain} onChange={(e) => setNewDomain({ ...newDomain, domain: e.target.value })} /></Field>
          <Field label="From name" id="nf"><input id="nf" className="i" value={newDomain.from_name} onChange={(e) => setNewDomain({ ...newDomain, from_name: e.target.value })} /></Field>
          <Field label="Stream" id="ns"><select id="ns" className="i" value={newDomain.stream} onChange={(e) => setNewDomain({ ...newDomain, stream: e.target.value })}><option value="marketing">marketing</option><option value="transactional">transactional</option></select></Field>
          <label className="check"><input type="checkbox" checked={newDomain.verification_mode === 'simulated'} onChange={(e) => setNewDomain({ ...newDomain, verification_mode: e.target.checked ? 'simulated' : 'dns' })} /> Demo mode: simulate DNS verification</label>
        </Modal>
      )}
    </>
  );
}
