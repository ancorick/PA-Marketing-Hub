import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, SessionCtx, useAction } from './lib.jsx';
import { t } from './i18n.js';
import { Icon, Loading } from './ui.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import { ChannelDetail, CampaignDetail } from './pages/Detail.jsx';
import Cohorts from './pages/Cohorts.jsx';
import Costs from './pages/Costs.jsx';
import Links from './pages/Links.jsx';
import DataHealth from './pages/DataHealth.jsx';
import { Contacts, ContactDetail } from './pages/Contacts.jsx';
import ImportPage from './pages/Import.jsx';
import Duplicates from './pages/Duplicates.jsx';
import { Segments, SegmentEditor } from './pages/Segments.jsx';
import AudienceHealth from './pages/AudienceHealth.jsx';
import { Sends, SendEditor } from './pages/Sends.jsx';
import { Issues, IssueEditor } from './pages/Newsletter.jsx';
import Events from './pages/Events.jsx';
import EmailSettings from './pages/EmailSettings.jsx';
import Outbox from './pages/Outbox.jsx';
import Admin from './pages/Admin.jsx';
import Alerts from './pages/Alerts.jsx';

const NAV = [
  { group: 'grpMeasure', items: [
    ['/', 'overview', Icon.overview, 'dashboard.view'], ['/cohorts', 'cohorts', Icon.chart, 'dashboard.view'], ['/costs', 'costs', Icon.coin, 'dashboard.view'],
    ['/links', 'links', Icon.link, 'dashboard.view'], ['/health', 'health', Icon.heart, 'dashboard.view'],
  ] },
  { group: 'grpReach', items: [
    ['/audience', 'contacts', Icon.people, 'contacts.view'], ['/segments', 'segments', Icon.layers, 'dashboard.view'], ['/audience/health', 'audienceStats', Icon.shield, 'dashboard.view'],
    ['/events', 'events', Icon.event, 'dashboard.view'],
  ] },
  { group: 'grpSend', items: [
    ['/newsletter', 'newsletter', Icon.news, 'dashboard.view'], ['/campaigns', 'campaigns', Icon.mail, 'dashboard.view'], ['/outbox', 'outbox', Icon.inbox, 'contacts.view'],
  ] },
  { group: 'grpSettings', items: [
    ['/email', 'emailSettings', Icon.gear, 'dashboard.view'], ['/alerts', 'alerts', Icon.bell, null], ['/admin', 'admin', Icon.shield, 'audit.view'],
  ] },
];

export default function App() {
  const [session, setSession] = useState(undefined);
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [run] = useAction();

  const refresh = useCallback(() => api('/auth/me').then(setSession).catch(() => setSession(null)), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const h = () => setSession(null); window.addEventListener('mh:signed-out', h); return () => window.removeEventListener('mh:signed-out', h); }, []);
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => { const id = setInterval(() => { if (session) refresh(); }, 30000); return () => clearInterval(id); }, [session, refresh]);

  if (session === undefined) return <Loading what="Starting Marketing Hub" />;
  if (!session) return <Login onSignedIn={() => { refresh(); nav(loc.pathname === '/login' ? '/' : loc.pathname); }} />;

  const lang = session.user.ui_language || 'en';
  const can = (p) => !p || session.permissions.includes(p);
  const setLang = async (l) => { await api('/auth/me', { method: 'PATCH', body: { ui_language: l } }); refresh(); };
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }); setSession(null); nav('/'); };
  const killOff = () => run(() => api('/email/killswitch', { method: 'POST', body: { on: false } }).then(refresh), 'Sending resumed');

  return (
    <SessionCtx.Provider value={{ ...session, refresh, lang }}>
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
          <div className="brand"><div className="brand-mark" aria-hidden="true">MH</div><div>Marketing Hub<small>Picsart Academy</small></div></div>
          {NAV.map((g) => {
            const items = g.items.filter(([, , , p]) => can(p));
            if (!items.length) return null;
            return (
              <nav key={g.group} className="nav-group nav" aria-label={t(lang, g.group)}>
                <div className="nav-label">{t(lang, g.group)}</div>
                {items.map(([to, key, icon]) => (
                  <NavLink key={to} to={to} end={to === '/' || to === '/audience'}>{icon}<span>{t(lang, key)}</span>
                    {key === 'alerts' && session.openAlerts > 0 && <span className="badge warn" style={{ marginLeft: 'auto' }}>{session.openAlerts}</span>}
                  </NavLink>
                ))}
              </nav>
            );
          })}
          <div className="sidebar-foot">
            <div style={{ fontWeight: 600 }}>{session.user.name}</div>
            <div className="faint">{session.user.email} · {session.user.role}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => setLang(lang === 'en' ? 'hy' : 'en')}>{lang === 'en' ? 'Հայերեն' : 'English'}</button>
              <button className="btn sm ghost" onClick={signOut}>{t(lang, 'signOut')}</button>
            </div>
          </div>
        </aside>
        <div className="main">
          {session.killSwitch && (
            <div className="killbar" role="alert">{t(lang, 'killOn')}
              {can('killswitch') && <button className="btn sm" onClick={killOff}>Resume sending</button>}
            </div>
          )}
          <div className="topbar">
            <button className="btn sm menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Open menu">☰</button>
            {session.aggregateOnly && <span className="badge info" title="Leadership sees aggregates only; counts under 3 are hidden">Aggregate view</span>}
            <div className="spacer" />
            <a className="btn sm ghost" href="/signup" target="_blank" rel="noreferrer">Public sign-up form ↗</a>
            <a className="btn sm ghost" href="/archive" target="_blank" rel="noreferrer">Newsletter archive ↗</a>
          </div>
          <main className="content" id="main">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/channels/:id" element={<ChannelDetail />} />
              <Route path="/campaign-stats/:id" element={<CampaignDetail />} />
              <Route path="/cohorts" element={<Cohorts />} />
              <Route path="/costs" element={<Costs />} />
              <Route path="/links" element={<Links />} />
              <Route path="/health" element={<DataHealth />} />
              <Route path="/audience" element={<Contacts />} />
              <Route path="/audience/contacts/:id" element={<ContactDetail />} />
              <Route path="/audience/import" element={<ImportPage />} />
              <Route path="/audience/duplicates" element={<Duplicates />} />
              <Route path="/audience/health" element={<AudienceHealth />} />
              <Route path="/segments" element={<Segments />} />
              <Route path="/segments/:id" element={<SegmentEditor />} />
              <Route path="/campaigns" element={<Sends />} />
              <Route path="/campaigns/:id" element={<SendEditor />} />
              <Route path="/newsletter" element={<Issues />} />
              <Route path="/newsletter/:id" element={<IssueEditor />} />
              <Route path="/events" element={<Events />} />
              <Route path="/email" element={<EmailSettings />} />
              <Route path="/outbox" element={<Outbox />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<div className="empty">Page not found. <a href="/">Go to the overview</a></div>} />
            </Routes>
          </main>
        </div>
      </div>
    </SessionCtx.Provider>
  );
}
