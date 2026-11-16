/**
 * Authenticated app shell: skip link, sticky topbar (brand, nav, org
 * switcher, credit meter, user menu), <main id="main"> outlet, footer.
 */
import React, { useEffect } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useMe } from '../lib/auth.jsx';
import { CreditMeter, FullPageSpinner, cx } from './ui.jsx';

const NAV_ITEMS = [
  { to: '/app/projects', label: 'Projects' },
  { to: '/app/projects/new', label: 'New project' },
  { to: '/app/billing', label: 'Billing' },
  { to: '/app/settings', label: 'Settings' },
];

export default function Layout() {
  const { ready, user, org, memberships, switchOrg, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const meQuery = useMe();
  const credits = meQuery.data?.credits ?? meQuery.data ?? null;

  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true });
  }, [ready, user, navigate]);

  if (!ready) {
    return (
      <div className="app-shell">
        <FullPageSpinner label="Starting session" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const currentOrgId = org?.id ?? memberships?.[0]?.org?.id ?? '';
  const currentRole = memberships?.find((m) => m.org?.id === currentOrgId)?.role ?? 'member';

  const handleSwitchOrg = async (event) => {
    const orgId = event.target.value;
    if (!orgId || orgId === currentOrgId) return;
    try {
      await switchOrg(orgId);
      queryClient.clear(); // everything is org-scoped
      navigate('/app/projects');
    } catch {
      /* switch-org errors surface via the API layer; stay put */
    }
  };

  const handleLogout = () => {
    logout();
    queryClient.clear();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/app/projects" className="brand" aria-label="SpecForge home">
            <span className="brand-mark" aria-hidden="true">
              ◆
            </span>
            <span className="brand-name">SpecForge</span>
          </Link>
          <nav className="topbar-nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/app/projects'}
                className={({ isActive }) => cx('nav-link', isActive && 'active')}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-right">
            {memberships?.length > 1 ? (
              <label className="org-switch">
                <span className="visually-hidden">Switch organization</span>
                <select className="select org-select" value={currentOrgId} onChange={handleSwitchOrg}>
                  {memberships.map((m) => (
                    <option key={m.org?.id ?? m.org?.name} value={m.org?.id}>
                      {m.org?.name ?? 'Organization'}
                    </option>
                  ))}
                </select>
              </label>
            ) : org?.name ? (
              <span className="org-name" title={`Role: ${currentRole}`}>
                {org.name}
              </span>
            ) : null}
            <CreditMeter
              balance={credits?.balance}
              reserved={credits?.reserved}
              cap={credits?.monthly_cap ?? credits?.cap}
              loading={meQuery.isPending}
            />
            <span className="topbar-user" title={user.email}>
              {user.email}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        <div className="container footer-inner">
          <span className="muted small">SpecForge — from idea to production-grade specs.</span>
          <nav className="footer-links" aria-label="Help">
            <Link to="/pricing">Pricing</Link>
            <a href="mailto:support@specforge.dev">Support</a>
            <Link to="/app/settings">Keyboard shortcuts</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
