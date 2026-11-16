import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { useAuth } from "../lib/auth.jsx";
import { useToast } from "../components/Toast.jsx";

/** One-click demo login + custom email magic-link simulator (development). */
export function Login() {
  const { devLogin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const doLogin = async (loginEmail, displayName) => {
    setLoading(true);
    setError(null);
    try {
      await devLogin(loginEmail, displayName);
      toast.success("Welcome to SpecForge");
      navigate("/app", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="card auth-card">
        <h1>Sign in to SpecForge</h1>
        <p className="muted">The demo environment uses a development login — no passwords, no external identity provider.</p>

        <Button
          size="lg"
          className="row"
          style={{ width: "100%", justifyContent: "center" }}
          loading={loading}
          onClick={() => doLogin("demo@specforge.dev", "Dana Demo")}
        >
          ⚡ One-click Demo Login (pre-seeded data)
        </Button>

        <div className="divider">or create your own workspace</div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) doLogin(email.trim(), name.trim() || undefined);
          }}
        >
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              className="input"
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <span className="field-hint">A personal organization is created automatically; email is auto-verified in dev.</span>
          </div>
          <div className="field">
            <label htmlFor="name">Display name <span className="muted">(optional)</span></label>
            <input id="name" className="input" type="text" placeholder="Dana Demo" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <Button type="submit" variant="primary" loading={loading} style={{ width: "100%", justifyContent: "center" }}>
            Continue with email
          </Button>
        </form>

        <p className="muted" style={{ fontSize: 13, marginTop: "var(--space-4)", marginBottom: 0 }}>
          New accounts get 3 free credits — enough for a full Idea Mode run is 4, so top up with the free starter pack in Billing.{" "}
          <Link to="/pricing">See pricing</Link>
        </p>
      </div>
    </div>
  );
}
