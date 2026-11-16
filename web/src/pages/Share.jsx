import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Badge } from "../components/Badge.jsx";
import { Button } from "../components/Button.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { renderMermaid } from "../components/MermaidRender.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";

/** Public read-only shared document at /s/:token with password unlock. */
export function Share() {
  const { token } = useParams();
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState(null);

  const share = useQuery({
    queryKey: ["share", token, unlocked],
    queryFn: async () => {
      try {
        return await api.get(`/v1/s/${token}`, { auth: false, etag: false });
      } catch (err) {
        if (err.status === 401) throw Object.assign(err, { passwordRequired: true });
        throw err;
      }
    },
    retry: false,
  });

  const unlock = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/v1/s/${token}/unlock`, { password }, { auth: false });
      setUnlocked(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const needsPassword = share.error?.passwordRequired || share.error?.code === "PASSWORD_REQUIRED";

  return (
    <div className="app-shell">
      <div className="share-hero">
        <div className="row spread wrap gap-12" style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div className="row gap-8">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <strong>SpecForge shared document</strong>
            <Badge tone="neutral">read-only</Badge>
          </div>
          <a href="/" className="btn btn-ghost btn-sm">Powered by SpecForge</a>
        </div>
      </div>

      <div className="share-body">
        {share.isLoading ? (
          <SkeletonCard />
        ) : needsPassword && !unlocked ? (
          <div className="card auth-card" style={{ margin: "var(--space-12) auto" }}>
            <h2>This link is password protected</h2>
            <form onSubmit={unlock} className="col gap-12">
              <div className="field">
                <label htmlFor="sharepass">Password</label>
                <input id="sharepass" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
              </div>
              {error ? <p className="field-error" role="alert">{error}</p> : null}
              <Button type="submit">Unlock document</Button>
            </form>
          </div>
        ) : share.isError ? (
          <div className="empty-state">
            <h3>{share.error.code === "LINK_EXPIRED" ? "This link has expired" : "Link unavailable"}</h3>
            <p className="muted">{share.error.message}</p>
          </div>
        ) : share.data ? (
          <article>
            <div className="row gap-8 wrap" style={{ marginBottom: "var(--space-4)" }}>
              <Badge tone="brand">{share.data.doc_type}</Badge>
              <Badge>v{share.data.version_no}</Badge>
              <span className="muted" style={{ fontSize: 13 }}>shared {new Date(share.data.shared_at).toLocaleDateString()}</span>
            </div>
            <h1 style={{ fontSize: 26 }}>{share.data.title}</h1>
            <Markdown source={share.data.sections.map((s) => `## ${s.heading}\n\n${s.body_md}`).join("\n\n")} renderMermaid={renderMermaid} />
          </article>
        ) : null}
      </div>
    </div>
  );
}
