import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Button } from "../components/Button.jsx";
import { Badge, StatusBadge } from "../components/Badge.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/** Project detail: runs, documents, reference sources + launch-run entry. */
export function ProjectDetail() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [idea, setIdea] = useState("");

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.get(`/v1/projects/${projectId}`),
  });

  const quickRun = useMutation({
    mutationFn: () => {
      const data = project.data;
      const ideaText = idea.trim() || data?.project?.idea_text || data?.project?.description || "";
      if (!ideaText || ideaText.length < 20) throw new Error("Add an idea of at least 20 characters first.");
      return api.post(`/v1/projects/${projectId}/runs`, {
        mode: "idea",
        idea: ideaText,
        documents: ["PRD", "TRD", "UIUX", "SCHEMA"],
        intake: {},
      });
    },
    onSuccess: (run) => {
      toast.success("Run queued — opening live monitor");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      navigate(`/app/runs/${run.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  if (project.isLoading) {
    return (
      <div className="page">
        <SkeletonCard />
      </div>
    );
  }
  if (!project.data?.project) {
    return (
      <div className="page">
        <div className="empty-state">Project not found. <Link to="/app">Back to dashboard</Link></div>
      </div>
    );
  }

  const { project: p, documents = [], runs = [], sources = [] } = project.data;

  return (
    <div className="page page-wide">
      <div className="row spread wrap gap-12" style={{ marginBottom: "var(--space-5)" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{p.name}</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 720 }}>{p.description ?? p.idea_text ?? "No description."}</p>
        </div>
        <div className="row gap-8">
          <Link to={`/app/projects/${projectId}/new-run`} className="btn btn-primary">🚀 New run (full wizard)</Link>
          <Link to="/app" className="btn btn-ghost">← Dashboard</Link>
        </div>
      </div>

      {sources.length > 0 ? (
        <section className="panel" style={{ marginBottom: "var(--space-5)" }}>
          <div className="panel-head">
            <span className="panel-title">Reference sources</span>
          </div>
          <div style={{ padding: "var(--space-3) var(--space-4)" }} className="col gap-8">
            {sources.map((source) => (
              <div key={source.id} className="row gap-8 wrap" style={{ fontSize: 14 }}>
                <StatusBadge status={source.status} />
                <code className="mono muted" style={{ fontSize: 13 }}>{source.url}</code>
                <span className="grow" />
                <Link to={`/app/projects/${projectId}/sources/${source.id}`} className="btn btn-sm btn-ghost">Preview</Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="col gap-16">
        <section>
          <h2 style={{ fontSize: 18 }}>Runs</h2>
          {runs.length === 0 ? (
            <div className="empty-state">
              <p style={{ marginBottom: "var(--space-3)" }}>No runs yet. Launch one below — Idea Mode costs 4 credits.</p>
              <div className="row gap-8" style={{ justifyContent: "center" }}>
                <input
                  className="input"
                  style={{ maxWidth: 420 }}
                  placeholder={p.idea_text ? "Use the project idea, or type a new one…" : "Describe the product in a sentence or two…"}
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                />
                <Button loading={quickRun.isPending} onClick={() => quickRun.mutate()}>Quick Idea Mode run</Button>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>Credits</th>
                    <th>Started</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="mono">{run.id.slice(0, 8)}</td>
                      <td><Badge>{run.mode}</Badge></td>
                      <td><StatusBadge status={run.status} /></td>
                      <td className="mono">{Number(run.credits_settled).toFixed(2)}/{Number(run.credit_cost).toFixed(2)}</td>
                      <td>{new Date(run.created_at).toLocaleString()}</td>
                      <td>
                        <Link to={`/app/runs/${run.id}`} className="btn btn-sm">Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 18 }}>Documents</h2>
          {documents.length === 0 ? (
            <p className="muted">Documents appear here as runs complete their stages.</p>
          ) : (
            <div className="projects-grid">
              {documents.map((document_) => (
                <div key={document_.id} className="card card-hover project-card">
                  <div className="row gap-8">
                    <Badge tone="brand">{document_.doc_type}</Badge>
                    <Badge>v{document_.latest_version_no}</Badge>
                  </div>
                  <Link to={`/app/documents/${document_.id}`} className="project-name">{document_.title}</Link>
                  <div className="project-meta">
                    <span>updated {new Date(document_.updated_at).toLocaleString()}</span>
                  </div>
                  <div className="row gap-8">
                    <Link to={`/app/documents/${document_.id}`} className="btn btn-sm">Open</Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          const res = await api.post(`/v1/documents/${document_.id}/exports`, { format: "docx" });
                          await api.download(`/v1/exports/${res.id}`);
                        } catch (err) {
                          toast.error(err.message);
                        }
                      }}
                    >
                      ↓ .docx
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
