import { useEffect, useState } from 'react';
import { api, useApi, useDebounced, useSession, fmtDateTime } from '../lib.jsx';
import { PageHead, Card, Async, EmailPreview, Seg } from '../ui.jsx';

export default function Outbox() {
  const session = useSession();
  const [to, setTo] = useState('');
  const q = useDebounced(to);
  const list = useApi(`/email/outbox?limit=100${q ? `&to=${encodeURIComponent(q)}` : ''}`, [q]);
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState(null);
  const [view, setView] = useState('html');
  useEffect(() => { if (sel) api(`/email/outbox/${sel}`).then(setMsg); }, [sel]);
  useEffect(() => { const id = setInterval(() => list.reload(), 5000); return () => clearInterval(id); }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHead title="Dev inbox" sub={session.espAdapter === 'dev'
        ? 'The development email adapter keeps every message here instead of sending it, then simulates the provider\'s signed delivery, open, click, bounce and complaint webhooks. Addresses containing "bounce", "soft" or "complain" trigger those outcomes. Links in these emails work: try the unsubscribe and preferences links.'
        : 'Messages are sent through SMTP; this is a copy of what left.'} />
      <div className="grid grid-2" style={{ gridTemplateColumns: 'minmax(280px, 1fr) 2fr', alignItems: 'start' }}>
        <Card title="Messages" actions={<input className="i inline" aria-label="Filter by recipient" placeholder="Filter by recipient" value={to} onChange={(e) => setTo(e.target.value)} />}>
          <Async state={list}>{(rows) => rows.length ? (
            <ul className="list-plain" style={{ maxHeight: '70vh', overflowY: 'auto' }}>{rows.map((m) => (
              <li key={m.id} className="clickable" onClick={() => setSel(m.id)} style={{ background: sel === m.id ? 'var(--accent-soft)' : undefined, padding: '8px 6px', borderRadius: 6 }}>
                <div style={{ fontWeight: 600 }}>{m.subject}</div><div className="small faint">{m.to_email} · {fmtDateTime(m.created_at)}</div>
              </li>
            ))}</ul>
          ) : <div className="empty">Nothing sent yet. Send a test from a campaign or newsletter.</div>}</Async>
        </Card>
        <Card title={msg ? msg.subject : 'Select a message'} actions={msg && <Seg label="View" value={view} onChange={setView} options={[['html', 'HTML'], ['text', 'Text'], ['headers', 'Headers']]} />}>
          {msg ? (
            <>
              <div className="small muted" style={{ marginBottom: 8 }}>From {msg.from_header} · to {msg.to_email} · {msg.message_id}</div>
              {view === 'html' && <EmailPreview html={msg.html} />}
              {view === 'text' && <pre className="code-box">{msg.text}</pre>}
              {view === 'headers' && <pre className="code-box">{Object.entries(msg.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'}</pre>}
              <p className="hint">The preview is sandboxed. Open links from the plain-text view to try unsubscribe and preferences pages.</p>
            </>
          ) : <div className="empty">Pick a message on the left.</div>}
        </Card>
      </div>
    </>
  );
}
