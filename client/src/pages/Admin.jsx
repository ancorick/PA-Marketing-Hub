import { useState } from 'react';
import { api, useApi, useAction, useCan, fmtDateTime } from '../lib.jsx';
import { PageHead, Card, Async, Field, Modal, Tabs, Confirm } from '../ui.jsx';

const ROLES = ['viewer', 'editor', 'manager', 'admin', 'leadership'];

export default function Admin() {
  const can = useCan();
  const tabs = [can('users.manage') && ['users', 'Users & roles'], can('integrations.manage') && ['integrations', 'Integrations & keys'], can('audit.view') && ['audit', 'Activity log'], can('audit.view') && ['exports', 'Export log']].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0]);
  return (
    <>
      <PageHead title="Admin" sub="Every permission-sensitive action (export, manual consent change, send, key change) is written to the activity log with actor, time and reason." />
      <Tabs value={tab} onChange={setTab} options={tabs} />
      {tab === 'users' && <Users />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'audit' && <Audit />}
      {tab === 'exports' && <Exports />}
    </>
  );
}

function Users() {
  const users = useApi('/admin/users');
  const perms = useApi('/admin/permissions');
  const [run, busy] = useAction();
  const [add, setAdd] = useState(null);
  const patch = async (id, body, ok) => { if (await run(() => api(`/admin/users/${id}`, { method: 'PATCH', body }), ok)) users.reload(); };
  return (
    <>
      <Card title="Users" actions={<button className="btn primary" onClick={() => setAdd({ email: '', name: '', role: 'editor', password: '' })}>Add user</button>}>
        <Async state={users}>{(rows) => (
          <table className="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
              <td><select className="i inline" aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => patch(u.id, { role: e.target.value }, 'Role changed')}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
              <td>{u.active ? <span className="badge good">active</span> : <span className="badge">disabled</span>}</td>
              <td><button className="btn sm ghost" disabled={busy} onClick={() => patch(u.id, { active: !u.active }, u.active ? 'Disabled' : 'Enabled')}>{u.active ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table>
        )}</Async>
      </Card>
      <Card title="Permission matrix (PRD 4.3)">
        <Async state={perms}>{(p) => (
          <div className="table-wrap"><table className="t"><thead><tr><th>Capability</th>{ROLES.map((r) => <th key={r}>{r}</th>)}</tr></thead>
            <tbody>{Object.entries(p).map(([k, roles]) => <tr key={k}><td className="mono small">{k}</td>{ROLES.map((r) => <td key={r}>{roles.includes(r) ? '✓' : <span className="faint">—</span>}</td>)}</tr>)}</tbody></table></div>
        )}</Async>
      </Card>
      {add && <Modal title="Add user" onClose={() => setAdd(null)} footer={<><button className="btn" onClick={() => setAdd(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api('/admin/users', { method: 'POST', body: add }), 'User added')) { setAdd(null); users.reload(); } }}>Add</button></>}>
        <Field label="Name" id="u-n"><input id="u-n" className="i" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
        <Field label="Email" id="u-e"><input id="u-e" className="i" type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></Field>
        <Field label="Role" id="u-r"><select id="u-r" className="i" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Initial password (10+ characters)" id="u-p"><input id="u-p" className="i" type="password" value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} /></Field>
      </Modal>}
    </>
  );
}

function Integrations() {
  const info = useApi('/admin/integration-info');
  const keys = useApi('/admin/api-keys');
  const secrets = useApi('/admin/secrets');
  const [run, busy] = useAction();
  const [newKey, setNewKey] = useState(null);
  const [secret, setSecret] = useState({ name: '', value: '' });
  const [revoke, setRevoke] = useState(null);
  return (
    <>
      <Async state={info}>{(d) => (
        <Card title="Endpoints" sub="Signed webhooks; messages older than 5 minutes or with a bad signature are rejected">
          <dl className="kv">
            <dt>Email adapter</dt><dd><span className="badge">{d.esp_adapter}</span></dd>
            <dt>ESP webhook</dt><dd className="mono small">{d.esp_webhook_url}</dd>
            <dt>Event Hub webhook</dt><dd className="mono small">{d.event_hub_webhook_url}</dd>
            <dt>Event Hub sandbox</dt><dd className="mono small">{d.event_hub_sandbox_url} <span className="faint">(validates, writes nothing)</span></dd>
            <dt>Contract</dt><dd>v{d.contract_version}: {d.event_types.join(', ')}</dd>
            <dt>Signature</dt><dd className="small">{d.signature}</dd>
            <dt>Command Center API</dt><dd className="mono small">{d.command_center_url} <span className="faint">(X-Api-Key, aggregates only)</span></dd>
            <dt>AI writing assist</dt><dd>{d.ai_assist ? <span className="badge good">on</span> : <span className="badge">off: set ANTHROPIC_API_KEY</span>}</dd>
            <dt>Slack alerts</dt><dd>{d.slack ? <span className="badge good">on</span> : <span className="badge">off: set MH_SLACK_WEBHOOK_URL</span>}</dd>
          </dl>
        </Card>
      )}</Async>
      <Card title="API keys" actions={<span className="row"><button className="btn sm" disabled={busy} onClick={async () => setNewKey(await run(() => api('/admin/api-keys', { method: 'POST', body: { scope: 'command_center', name: 'Command Center' } })))}>New Command Center key</button>
        <button className="btn sm" disabled={busy} onClick={async () => setNewKey(await run(() => api('/admin/api-keys', { method: 'POST', body: { scope: 'event_hub', name: 'Event Hub' } })))}>New Event Hub key</button></span>}>
        {newKey && <div className="callout warn" style={{ marginBottom: 12 }}>Copy this key now; it is shown only once:<div className="code-box" style={{ marginTop: 6 }}>{newKey.key}</div></div>}
        <Async state={keys}>{(rows) => <table className="t"><thead><tr><th>Name</th><th>Prefix</th><th>Scope</th><th>Created</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono">{k.prefix}…</td><td>{k.scope}</td><td className="small">{fmtDateTime(k.created_at)}</td><td>{k.revoked_at ? <span className="badge">revoked</span> : <span className="badge good">active</span>}</td>
            <td>{!k.revoked_at && <button className="btn sm ghost danger" onClick={() => setRevoke(k)}>Revoke</button>}</td></tr>)}</tbody></table>}</Async>
      </Card>
      <Card title="Integration credentials" sub="Stored encrypted (AES-256-GCM). Rotating a credential needs no code change.">
        <Async state={secrets}>{(rows) => rows.length ? <table className="t"><thead><tr><th>Name</th><th>Value</th><th>Updated</th></tr></thead><tbody>{rows.map((s) => <tr key={s.name}><td className="mono">{s.name}</td><td className="mono">{s.preview}</td><td className="small">{fmtDateTime(s.updated_at)}</td></tr>)}</tbody></table> : <div className="empty">No stored credentials yet.</div>}</Async>
        <form className="row" style={{ marginTop: 12 }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => api(`/admin/secrets/${secret.name}`, { method: 'PUT', body: { value: secret.value } }), 'Credential saved')) { setSecret({ name: '', value: '' }); secrets.reload(); } }}>
          <select className="i inline" aria-label="Credential" value={secret.name} onChange={(e) => setSecret({ ...secret, name: e.target.value })} required><option value="">Choose…</option>{['esp_api_key', 'smtp_user', 'smtp_pass', 'ga4_service_account', 'meta_access_token', 'google_ads_developer_token', 'google_ads_refresh_token'].map((n) => <option key={n}>{n}</option>)}</select>
          <input className="i inline" type="password" aria-label="Value" placeholder="New value" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} required />
          <button className="btn" disabled={busy}>Save / rotate</button>
        </form>
      </Card>
      {revoke && <Confirm title="Revoke API key?" danger confirmLabel="Revoke" busy={busy} onClose={() => setRevoke(null)} text={`${revoke.name} (${revoke.prefix}…) stops working immediately.`}
        onConfirm={async () => { if (await run(() => api(`/admin/api-keys/${revoke.id}`, { method: 'DELETE' }), 'Revoked')) { setRevoke(null); keys.reload(); } }} />}
    </>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const state = useApi(`/admin/audit?limit=300${action ? `&action=${action}` : ''}`, [action]);
  return (
    <Card title="Activity log" actions={<select className="i inline" aria-label="Filter" value={action} onChange={(e) => setAction(e.target.value)}>
      <option value="">All actions</option>{['send', 'newsletter', 'consent', 'contact', 'segment', 'killswitch', 'domain', 'apikey', 'secret', 'user', 'auth', 'pipeline', 'cost'].map((a) => <option key={a}>{a}</option>)}</select>}>
      <Async state={state}>{(rows) => <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td className="small nowrap">{fmtDateTime(r.created_at)}</td><td className="small">{r.actor_label}</td><td className="mono small">{r.action}</td><td className="small">{r.entity ? `${r.entity} #${r.entity_id}` : ''}</td>
          <td className="small" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>{r.reason && <div>Reason: {r.reason}</div>}{r.meta && <span className="faint mono">{JSON.stringify(r.meta).slice(0, 220)}</span>}</td></tr>)}</tbody></table></div>}</Async>
    </Card>
  );
}

function Exports() {
  const state = useApi('/exports');
  return (
    <Card title="Export log" sub="Every export of personal data: who, when, what, how many rows">
      <Async state={state}>{(rows) => rows.length ? <table className="t"><thead><tr><th>When</th><th>Who</th><th>What</th><th className="num">Rows</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td className="small">{fmtDateTime(r.created_at)}</td><td>{r.user_name}</td><td>{r.what}{r.segment_id ? ` #${r.segment_id}` : ''}</td><td className="num">{r.row_count}</td></tr>)}</tbody></table>
        : <div className="empty">No exports yet.</div>}</Async>
    </Card>
  );
}
