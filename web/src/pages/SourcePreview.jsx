import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Button } from "../components/Button.jsx";
import { Badge } from "../components/Badge.jsx";
import { Spinner } from "../components/Spinner.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/** Reference crawl preview: page grid, palette swatches, fonts, nav tree, skipped URLs. */
export function SourcePreview() {
  const { projectId, sourceId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);

  const source = useQuery({
    queryKey: ["source", sourceId],
    queryFn: () => api.get(`/v1/sources/${sourceId}`),
    refetchInterval: (q) => (q.state.data?.source?.status === "crawling" ? 2000 : false),
  });

  const confirm = useMutation({
    mutationFn: () => api.post(`/v1/sources/${sourceId}/confirm`, {}),
    onSuccess: () => {
      setConfirmed(true);
      qc.invalidateQueries({ queryKey: ["source", sourceId] });
      toast.success("Preview confirmed — you can launch the Reference Mode run");
    },
    onError: (err) => toast.error(err.message),
  });

  const data = source.data;
  const src = data?.source;
  const pages = data?.pages ?? [];
  const extraction = data?.extraction;
  const palette = extraction?.tokens?.palette ?? [];
  const fonts = extraction?.tokens?.fonts ?? [];
  const navigation = extraction?.information_arch?.navigation ?? [];
  const skipped = pages.filter((p) => p.state === "skipped" || p.skip_reason);

  if (source.isLoading) {
    return (
      <div className="page">
        <SkeletonCard />
      </div>
    );
  }
  if (!src) {
    return (
      <div className="page">
        <div className="empty-state">Source not found. <Link to="/app">Back to dashboard</Link></div>
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div className="row spread wrap gap-12" style={{ marginBottom: "var(--space-5)" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Crawl preview</h1>
          <p className="muted" style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 14 }}>{src.url}</p>
        </div>
        <div className="row gap-8">
          <Badge tone={src.status === "confirmed" ? "success" : src.status === "preview_ready" ? "info" : "warning"}>{src.status.replace(/_/g, " ")}</Badge>
          <Link to={`/app/projects/${projectId}`} className="btn btn-ghost">← Project</Link>
        </div>
      </div>

      {src.status === "crawling" ? (
        <div className="hint-banner row gap-8">
          <Spinner size={14} /> Crawling in progress… this preview updates automatically.
        </div>
      ) : null}

      <div className="col gap-16">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Pages ({pages.length})</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {src.stats?.pages_captured ?? pages.filter((p) => p.state === "captured").length} captured · depth ≤ 2
            </span>
          </div>
          <div style={{ padding: "var(--space-4)" }}>
            {pages.length === 0 ? (
              <div className="empty-state">No pages captured yet.</div>
            ) : (
              <div className="page-grid">
                {pages.map((page) => (
                  <div key={page.id} className="page-thumb">
                    <div
                      style={{
                        height: 90,
                        background: "linear-gradient(135deg, var(--color-surface), var(--color-border))",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--color-text-secondary)",
                        fontSize: 12,
                      }}
                      aria-hidden="true"
                    >
                      {page.http_status ? `HTTP ${page.http_status}` : "page"}
                    </div>
                    <div className="page-thumb-bar">
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{page.title ?? "(untitled)"}</strong>
                      <span className="page-thumb-url" title={page.url}>{page.url}</span>
                      <span className="row gap-4">
                        <Badge>depth {page.depth}</Badge>
                        <Badge tone={page.state === "captured" ? "success" : "warning"}>{page.state}</Badge>
                        {page.template_cluster ? <Badge tone="info">{page.template_cluster}</Badge> : null}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {skipped.length > 0 ? (
          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Skipped URLs ({skipped.length})</span>
            </div>
            <div style={{ padding: "var(--space-4)" }} className="col gap-8">
              {skipped.map((p) => (
                <div key={p.id} className="row gap-8" style={{ fontSize: 13.5 }}>
                  <span className="skip-reason">{p.skip_reason ?? "SKIPPED"}</span>
                  <span className="mono muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.url}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Extracted design tokens</span>
            {extraction?.model ? <Badge tone="info">via {extraction.model}</Badge> : null}
          </div>
          <div style={{ padding: "var(--space-4)" }} className="col gap-16">
            {palette.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 15 }}>Color palette</h3>
                <div className="swatch-grid">
                  {palette.map((swatch) => (
                    <div key={swatch.hex} className="swatch" title={`${swatch.role} — ${Math.round(swatch.usage_share * 100)}% usage`}>
                      <span className="swatch-color" style={{ background: swatch.hex }} aria-hidden="true" />
                      <span className="mono">{swatch.hex}</span>
                      <Badge>{swatch.role}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Palette appears here once extraction completes.</p>
            )}
            {fonts.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 15 }}>Detected fonts</h3>
                <div className="row gap-8 wrap">
                  {fonts.map((font) => (
                    <span key={font.family} className="swatch" style={{ fontFamily: font.family }}>
                      {font.family} <span className="muted" style={{ fontSize: 12 }}>w{font.weights?.join("/")}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {navigation.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 15 }}>Navigation tree</h3>
                <ul style={{ margin: 0, paddingLeft: 18, columns: 2, fontSize: 14 }}>
                  {navigation.slice(0, 24).map((nav, i) => (
                    <li key={`${nav.label}-${i}`}>
                      {nav.label} <span className="muted mono" style={{ fontSize: 12 }}>{nav.href}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {extraction?.injection_suspected ? (
              <div className="warning-panel" style={{ marginBottom: 0 }}>
                ⚠ Prompt-injection patterns were detected in the crawled content and stripped before generation.
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="confirm-bar">
        <span className="muted" style={{ fontSize: 14 }}>
          {src.status === "confirmed" || confirmed
            ? "✓ Confirmed — Reference Mode runs will reuse this extraction for 6 hours."
            : "Confirm this preview to enable Reference Mode runs for this source."}
        </span>
        <span className="grow" />
        {(src.status === "preview_ready" || src.status === "confirmed") && !confirmed ? (
          <Button loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirm preview</Button>
        ) : null}
        {confirmed || src.status === "confirmed" ? (
          <Button onClick={() => navigate(`/app/projects/${projectId}/new-run`)}>Continue to run →</Button>
        ) : null}
      </div>
    </div>
  );
}
