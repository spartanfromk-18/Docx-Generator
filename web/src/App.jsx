import { Routes, Route, Link, NavLink, useLocation, Navigate } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CreditMeter } from "./components/CreditMeter.jsx";
import { useAuth } from "./lib/auth.jsx";
import { Spinner } from "./components/Spinner.jsx";

import { Landing } from "./pages/Landing.jsx";
import { Pricing } from "./pages/Pricing.jsx";
import { Login } from "./pages/Login.jsx";
import { Projects } from "./pages/Projects.jsx";
import { ProjectDetail } from "./pages/ProjectDetail.jsx";
import { NewProject } from "./pages/NewProject.jsx";
import { SourcePreview } from "./pages/SourcePreview.jsx";
import { Run } from "./pages/Run.jsx";
import { Document } from "./pages/Document.jsx";
import { Billing } from "./pages/Billing.jsx";
import { Settings } from "./pages/Settings.jsx";
import { Share } from "./pages/Share.jsx";
import { NotFound } from "./pages/NotFound.jsx";

function TopBar() {
  const { isAuthed, user, org, credits, logout } = useAuth();
  return (
    <header className="topbar">
      <Link to="/" className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">✦</span> SpecForge
      </Link>
      {isAuthed ? (
        <nav className="topbar-nav" aria-label="Primary">
          <NavLink to="/app" className={({ isActive }) => `topbar-link ${isActive ? "active" : ""}`}>Projects</NavLink>
          <NavLink to="/app/new" className={({ isActive }) => `topbar-link ${isActive ? "active" : ""}`}>New</NavLink>
          <NavLink to="/app/billing" className={({ isActive }) => `topbar-link ${isActive ? "active" : ""}`}>Billing</NavLink>
          <NavLink to="/app/settings" className={({ isActive }) => `topbar-link ${isActive ? "active" : ""}`}>Settings</NavLink>
        </nav>
      ) : null}
      <span className="topbar-spacer" />
      {isAuthed ? (
        <div className="row gap-12">
          {credits ? <CreditMeter compact balance={credits.balance} reserved={credits.reserved} /> : null}
          <span className="muted" style={{ fontSize: 14 }} title={org?.name}>{user?.display_name ?? user?.email}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
        </div>
      ) : (
        <div className="row gap-8">
          <Link to="/pricing" className="btn btn-ghost btn-sm">Pricing</Link>
          <Link to="/login" className="btn btn-primary btn-sm">Sign in</Link>
        </div>
      )}
    </header>
  );
}

function RequireAuth({ children }) {
  const { isAuthed, ready } = useAuth();
  const location = useLocation();
  if (!ready) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <Spinner label="Restoring session…" />
      </div>
    );
  }
  if (!isAuthed) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

export default function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/app" element={<RequireAuth><Projects /></RequireAuth>} />
          <Route path="/app/new" element={<RequireAuth><NewProject /></RequireAuth>} />
          <Route path="/app/projects/:projectId" element={<RequireAuth><ProjectDetail /></RequireAuth>} />
          <Route path="/app/projects/:projectId/sources/:sourceId" element={<RequireAuth><SourcePreview /></RequireAuth>} />
          <Route path="/app/projects/:projectId/new-run" element={<RequireAuth><NewProject /></RequireAuth>} />
          <Route path="/app/runs/:runId" element={<RequireAuth><Run /></RequireAuth>} />
          <Route path="/app/documents/:documentId" element={<RequireAuth><Document /></RequireAuth>} />
          <Route path="/app/billing" element={<RequireAuth><Billing /></RequireAuth>} />
          <Route path="/app/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/s/:token" element={<Share />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
      <footer className="footer">
        SpecForge — AI specification generation · demo environment (memory DB + mock LLM) ·{" "}
        <Link to="/pricing">pricing</Link>
      </footer>
    </div>
  );
}
