import { useEffect, useRef } from 'react';

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {children && <div className="row no-print">{children}</div>}
    </div>
  );
}

export function Card({ title, sub, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>{title && <h2>{title}</h2>}{sub && <div className="small muted">{sub}</div>}</div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tile({ label, value, sub, help }) {
  return (
    <div className="tile">
      <div className="label">{label}{help && <Info text={help} />}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Info({ text }) {
  return <span className="faint" title={text} aria-label={text} role="img" style={{ cursor: 'help' }}>ⓘ</span>;
}

export function Loading({ what = 'Loading' }) { return <div className="empty" role="status">{what}…</div>; }
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return <div className="callout bad" role="alert">{error.status === 403 ? 'Your role cannot see this page.' : error.message}{onRetry && error.status !== 403 && <> · <button className="btn sm" onClick={onRetry}>Retry</button></>}</div>;
}
export function Empty({ children }) { return <div className="empty">{children}</div>; }

export function Async({ state, children, what }) {
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading what={what} />;
  return children(state.data);
}

const STATUS_TONE = {
  draft: '', approved: 'info', scheduled: 'info', sending: 'warn', paused: 'bad', sent: 'good', cancelled: '',
  collecting: '', in_review: 'warn', active: 'good', pending: 'warn', unsubscribed: '', bounced: 'bad', complained: 'bad', erased: '',
  granted: 'good', withdrawn: 'bad', unknown: '', verified: 'good', missing: 'bad', mismatch: 'warn', unverified: 'warn', success: 'good', failed: 'bad', running: 'info',
  delivered: 'good', bounced_hard: 'bad', bounced_soft: 'warn', queued: '', failed_delivery: 'bad', critical: 'bad', warning: 'warn', info: 'info',
};
export function Status({ value, children }) {
  return <span className={`badge ${STATUS_TONE[value] ?? ''}`}>{children ?? String(value ?? '—').replace(/_/g, ' ')}</span>;
}

export function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function Tabs({ value, options, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([v, l]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function Field({ label, hint, children, id }) {
  return <div className="field"><label className="f" htmlFor={id}>{label}</label>{children}{hint && <div className="hint">{hint}</div>}</div>;
}

export function Modal({ title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
        {footer && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  );
}

// Destructive confirmation: says exactly what will happen, including how many people (13.7).
export function Confirm({ title, text, confirmLabel = 'Confirm', danger, onConfirm, onClose, busy, children }) {
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
    </>}>
      <p className="muted">{text}</p>
      {children}
    </Modal>
  );
}

export function Checks({ result }) {
  if (!result) return null;
  return (
    <ul className="list-plain">
      {result.checks.map((c) => (
        <li key={c.key} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <span className={`badge ${c.ok ? 'good' : c.severity === 'warning' ? 'warn' : 'bad'}`} style={{ minWidth: 54, justifyContent: 'center' }}>{c.ok ? 'OK' : c.severity === 'warning' ? 'Warn' : 'Fix'}</span>
          <span>{c.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function EmailPreview({ html, mobile }) {
  // srcdoc + empty sandbox: the email renders, but no scripts and no navigation.
  return <iframe title="Email preview" className={`preview-frame ${mobile ? 'mobile' : ''}`} sandbox="" srcDoc={html || ''} />;
}

export const Icon = {
  overview: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>,
  chart: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 14h12M4 11V7M8 11V3M12 11V8" strokeLinecap="round" /></svg>,
  people: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6" cy="5" r="2.5" /><path d="M1.5 14c.5-3 2.3-4.5 4.5-4.5S10 11 10.5 14M11 3a2.3 2.3 0 010 4.4M12.5 9.7c1.2.6 2 1.9 2.2 4.3" strokeLinecap="round" /></svg>,
  mail: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M2 4l6 5 6-5" /></svg>,
  news: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5" /><path d="M5 5h6M5 8h6M5 11h3" strokeLinecap="round" /></svg>,
  event: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5 1.5v3M11 1.5v3" strokeLinecap="round" /></svg>,
  gear: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.3" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" /></svg>,
  shield: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4z" /></svg>,
  bell: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 11V7a4 4 0 018 0v4l1.5 1.5h-11zM6.5 14h3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  link: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.8 2.8 0 014 4L11 8.5M9 11.5l-1.3 1.3a2.8 2.8 0 01-4-4L5 7.5" strokeLinecap="round" /></svg>,
  coin: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><path d="M10 6c-.4-.8-1.1-1.2-2-1.2-1.2 0-2 .6-2 1.5 0 2 4 1 4 3 0 .9-.9 1.6-2 1.6-1 0-1.7-.5-2-1.3M8 3.5v1.3M8 11v1.4" strokeLinecap="round" /></svg>,
  heart: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 8h3l1.5-3 2.5 6 1.5-3h4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  inbox: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 9l1.5-6h9L14 9v4H2zM2 9h3.5l1 2h3l1-2H14" strokeLinejoin="round" /></svg>,
  layers: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" strokeLinejoin="round" /></svg>,
};
