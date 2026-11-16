import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="page" style={{ textAlign: "center", paddingTop: "var(--space-16)" }}>
      <h1 style={{ fontSize: 64, marginBottom: 0 }}>404</h1>
      <h2 style={{ fontWeight: 500 }}>This page wandered off the spec</h2>
      <p className="muted">The route you followed doesn't exist — the document may have been archived or the link mistyped.</p>
      <div className="row gap-8" style={{ justifyContent: "center" }}>
        <Link to="/app" className="btn btn-primary">Back to dashboard</Link>
        <Link to="/" className="btn btn-ghost">Go home</Link>
      </div>
    </div>
  );
}
