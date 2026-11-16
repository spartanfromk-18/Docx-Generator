import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { Button } from "../components/Button.jsx";
import { Badge, StatusBadge } from "../components/Badge.jsx";
import { CreditMeter } from "../components/CreditMeter.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/** Project dashboard: search, status badges, credit meter, quick actions. */
export function Projects() {
  const { credits, refreshCredits } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const projects = useQuery({
    queryKey: ["projects", search],
    queryFn: () => api.get(`/v1/projects?limit=40${search ? `&q=${encodeURIComponent(search)}` : ""}`),
  });

  const createDemo = useMutation({
    mutationFn: () =>
      api.post("/v1/projects", {
        name: `Playground ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        description: "Quick playground project created from the dashboard.",
        idea_text:
          "A booking tool for community sports halls: admins publish time slots, teams reserve and pay online, and no-shows trigger automated waitlist promotion.",
      }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project created — start a run from its page");
      navigate(`/app/projects/${project.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id) => api.del(`/v1/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.info("Project archived");
    },
    onError: (err) => toast.error(err.message),
  });

  const items = useMemo(() => projects.data?.items ?? [], [projects.data]);

  return (
    <div className="page">
      <div className="projects-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>Projects</h1>
          <p className="muted" style={{ margin: 0 }}>Every project holds its reference sources, runs and generated documents.</p>
        </div>
        <div className="row gap-12">
          {credits ? <CreditMeter balance={credits.balance} reserved={credits.reserved} /> : null}
          <Link to="/app/new" className="btn btn-primary">+ New project</Link>
        </div>
      </div>

      <div className="row gap-8" style={{ marginBottom: "var(--space-4)" }}>
        <input
          className="input search-input"
          type="search"
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search projects"
        />
        <Button variant="ghost" size="sm" loading={createDemo.isPending} onClick={() => createDemo.mutate()}>
          + Quick playground project
        </Button>
      </div>

      {projects.isLoading ? (
        <div className="projects-grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>No projects yet</h3>
          <p>Create your first project and turn an idea into a full spec suite.</p>
          <Link to="/app/new" className="btn btn-primary">Create your first project</Link>
        </div>
      ) : (
        <div className="projects-grid">
          {items.map((project) => (
            <div key={project.id} className="card card-hover project-card">
              <Link to={`/app/projects/${project.id}`} className="project-name">
                {project.name}
              </Link>
              <p className="project-desc">{project.description ?? project.idea_text ?? "No description yet."}</p>
              <div className="project-meta">
                <Badge>{project.documents_count ?? 0} docs</Badge>
                {project.latest_run ? (
                  <>
                    <StatusBadge status={project.latest_run.status} />
                    <span>{new Date(project.latest_run.created_at).toLocaleDateString()}</span>
                  </>
                ) : (
                  <Badge tone="neutral">no runs</Badge>
                )}
              </div>
              <div className="row gap-8" style={{ marginTop: "var(--space-2)" }}>
                <Link to={`/app/projects/${project.id}`} className="btn btn-sm">Open</Link>
                <Link to={`/app/projects/${project.id}/new-run`} className="btn btn-sm btn-ghost">Run</Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Archive "${project.name}"? Documents are kept; the project is hidden.`)) {
                      remove.mutate(project.id);
                    }
                  }}
                >
                  Archive
                </Button>
                <span className="grow" />
                {credits ? <CreditMeter compact balance={credits.balance} reserved={credits.reserved} /> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
