import { useState } from 'react';
import { api } from '../lib.jsx';

const DEMO = [
  ['manager@academy.test', 'Marketing manager', 'approves sends, enters costs'],
  ['editor@academy.test', 'Editor', 'segments, newsletter, campaign drafts'],
  ['admin@academy.test', 'Admin', 'domains, keys, users, integrations'],
  ['director@academy.test', 'Leadership', 'aggregates only'],
  ['viewer@academy.test', 'Viewer', 'dashboard only'],
];

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('manager@academy.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/login', { method: 'POST', body: { email, password } }); onSignedIn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <div className="login">
        <div className="brand" style={{ justifyContent: 'center', paddingBottom: 20 }}><div className="brand-mark" aria-hidden="true">MH</div><div>Marketing Hub<small>Picsart Academy</small></div></div>
        <form className="card" onSubmit={submit}>
          <h1 style={{ marginBottom: 6 }}>Sign in</h1>
          <p className="muted small">Staff sign-in. In production this uses the Academy Core Engine account.</p>
          <div className="field"><label className="f" htmlFor="email">Email</label><input id="email" className="i" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
          <div className="field"><label className="f" htmlFor="pw">Password</label><input id="pw" className="i" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
          {error && <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="card small" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Demo accounts · password <code>demo-password-2026</code></div>
          <ul className="list-plain">{DEMO.map(([e, r, d]) => (
            <li key={e} className="row between"><span><b>{r}</b> <span className="faint">· {d}</span></span>
              <button type="button" className="btn sm" onClick={() => { setEmail(e); setPassword('demo-password-2026'); }}>Use</button></li>
          ))}</ul>
        </div>
      </div>
    </div>
  );
}
