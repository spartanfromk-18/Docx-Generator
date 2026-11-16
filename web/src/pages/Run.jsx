import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiClientError } from "../lib/api.js";
import { useRunStream } from "../hooks/useRunStream.js";
import { Button } from "../components/Button.jsx";
import { Badge, StatusBadge } from "../components/Badge.jsx";
import { StagePill, stageLabel } from "../components/StagePill.jsx";
import { SectionPill } from "../components/SectionPill.jsx";
import { ConnectionBanner } from "../components/ConnectionBanner.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { renderMermaid } from "../components/MermaidRender.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/** Three-pane live execution view: stage rail · document outline · streaming reader. */
export function Run() {
  const { runId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [activeDoc, setActiveDoc] = useState(null);
  const [activeSection, setActiveSection] = useState(0);
  const [autoscroll, setAutoscroll] = useState(true);
  const readerRef = useRef(null);

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get(`/v1/runs/${runId}`),
    refetchInterval: (q) => {
      const status = q.state.data?.run?.status;
      return ["queued", "running", "paused_provider", "retry_wait"].includes(status) ? 2500 : false;
    },
  });

  const run = runQuery.data?.run;
  const stages = runQuery.data?.stages ?? [];
  const documents = runQuery.data?.documents ?? [];

  const { connected, reconnecting, events, paused, setPaused, elapsedMs } = useRunStream(runId, {
    enabled: Boolean(runId) && ["queued", "running", "paused_provider"].includes(run?.status ?? "queued"),
  });

  // Merge streamed sections into a live view keyed by doc_type → sections.
  const liveSections = useMemo(() => {
    const map = new Map();
    for (const ev of events) {
      if (ev.type === "section" && ev.data?.doc_type) {
        const key = ev.data.doc_type;
        const list = map.get(key) ?? [];
        const heading = ev.data.heading ?? `Section ${list.length + 1}`;
        const existingIdx = list.findIndex((s) => s.heading === heading);
        const section = { heading, body_md: ev.data.body_md ?? "", ordinal: ev.data.ordinal ?? existingIdx };
        if (existingIdx >= 0) list[existingIdx] = section;
        else list.push(section);
        map.set(key, list);
      }
    }
    return map;
  }, [events]);

  const terminal = run && ["reviewed", "reviewed_with_warnings", "failed", "cancelled"].includes(run.status);
  const stageStatus = new Map(stages.map((s) => [s.stage, s]));

  // Pick the active document: first doc with live content, else first of the run.
  useEffect(() => {
    if (!activeDoc) {
      const firstWithContent = [...liveSections.keys()][0];
      setActiveDoc(firstWithContent ?? documents[0]?.doc_type ?? "PRD");
    }
  }, [liveSections, documents, activeDoc]);

  // Auto-scroll reader as new content arrives.
  useEffect(() => {
    if (autoscroll && !paused && readerRef.current && !terminal) {
      readerRef.current.scrollTop = readerRef.current.scrollHeight;
    }
  }, [events.length, autoscroll, paused, terminal]);

  const cancel = useMutation({
    mutationFn: () => api.post(`/v1/runs/${runId}/cancel`, {}),
    onSuccess: () => {
      toast.info("Cancellation requested — unused credits are being released");
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const retryStage = useMutation({
    mutationFn: (stage) => api.post(`/v1/runs/${runId}/stages/${stage}/retry`, {}),
    onSuccess: () => {
      toast.success("Stage requeued — the engine will pick it up");
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : String(err.message)),
  });

  if (runQuery.isLoading) {
    return (
      <div className="page page-wide">
        <SkeletonCard />
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <div className="empty-state">Run not found. <Link to="/app">Back to dashboard</Link></div>
      </div>
    );
  }

  const docsForOutline = (run.doc_types ?? ["PRD", "TRD", "UIUX", "SCHEMA"]).map((t) => ({
    docType: t,
    sections: liveSections.get(t) ?? [],
  }));
  const currentDoc = docsForOutline.find((d) => d.docType === activeDoc) ?? docsForOutline[0];
  const currentSection = currentDoc?.sections[activeSection] ?? currentDoc?.sections[0];
  const failedStage = stages.find((s) => s.status === "failed");
  const timeHints = elapsedMs > 60_000;

  return (
    <div className="page page-wide">
      <div className="row spread wrap gap-12" style={{ marginBottom: "var(--space-4)" }}>
        <div className="row gap-12 wrap">
          <h1 style={{ margin: 0, fontSize: 22 }}>Run {run.id.slice(0, 8)}</h1>
          <StatusBadge status={run.status} />
          <Badge tone="neutral">{run.mode === "reference" ? "Reference Mode" : "Idea Mode"}</Badge>
          <span className="elapsed" title="Elapsed time">{formatElapsed(elapsedMs)}</span>
        </div>
        <div className="row gap-8">
          <button
            type="button"
            className={`preview-tab ${autoscroll ? "active" : ""}`}
            onClick={() => setAutoscroll((v) => !v)}
            aria-pressed={autoscroll}
          >
            {autoscroll ? "⏸ Auto-scroll on" : "▶ Auto-scroll off"}
          </button>
          <button type="button" className={`preview-tab ${paused ? "active" : ""}`} onClick={() => setPaused(!paused)} aria-pressed={paused}>
            {paused ? "▶ Resume stream" : "⏸ Pause stream"}
          </button>
          {!terminal ? (
            <Button variant="danger" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel run
            </Button>
          ) : (
            <Link className="btn btn-sm" to={`/app/projects/${run.project_id}`}>Open project →</Link>
          )}
        </div>
      </div>

      <ConnectionBanner reconnecting={reconnecting} connected={connected || terminal} />
      {run.status === "paused_provider" ? (
        <div className="conn-banner conn-warning" role="status">
          ⏸ Provider outage — the run will resume automatically when the circuit breaker cools down (≤ 30 s). Reserved credits are held, not spent.
        </div>
      ) : null}
      {timeHints && !terminal ? (
        <div className="hint-banner row spread wrap">
          <span>⏱ Long runs: document stages stream section-by-section; TRD and UX generate in parallel. This is normal for full suites.</span>
        </div>
      ) : null}
      {failedStage ? (
        <div className="warning-panel row spread wrap" style={{ alignItems: "center" }}>
          <div>
            <strong>Stage {stageLabel(failedStage.stage)} failed</strong>
            {failedStage.error_code ? <Badge tone="danger">{failedStage.error_code}</Badge> : null}
            {failedStage.error_detail ? <div className="muted" style={{ fontSize: 13 }}>{failedStage.error_detail}</div> : null}
          </div>
          <Button size="sm" loading={retryStage.isPending} onClick={() => retryStage.mutate(failedStage.stage)}>
            Retry stage
          </Button>
        </div>
      ) : null}

      <div className="run-layout">
        <aside className="run-rail" aria-label="Stage progress">
          {stages.map((stage) => (
            <div key={stage.id} className={`run-rail-item ${failedStage?.id === stage.id ? "active" : ""}`} title={stage.error_detail ?? ""}>
              <StagePill stage={stage.stage} status={stage.status} attempt={stage.attempt > 1 ? stage.attempt : undefined} credits={stage.credits_settled || undefined} compact />
              <span className="outline-title">{stageLabel(stage.stage)}</span>
              {stage.status === "succeeded" ? <span className="muted" style={{ fontSize: 12 }}>✓</span> : null}
            </div>
          ))}
        </aside>

        <aside className="run-outline-col">
          <div className="outline" aria-label="Document outline">
            {docsForOutline.map((doc) => (
              <div key={doc.docType}>
                <button type="button" className={`outline-item ${activeDoc === doc.docType ? "active" : ""}`} onClick={() => { setActiveDoc(doc.docType); setActiveSection(0); }}>
                  <strong>{docLabel(doc.docType)}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{doc.sections.length > 0 ? `${doc.sections.length} §` : "…"}</span>
                </button>
                {activeDoc === doc.docType
                  ? doc.sections.map((section, idx) => (
                      <button
                        key={`${section.heading}-${idx}`}
                        type="button"
                        className={`outline-item ${activeSection === idx ? "active" : ""}`}
                        style={{ paddingLeft: 22 }}
                        onClick={() => setActiveSection(idx)}
                      >
                        <SectionPill status="done" />
                        <span className="outline-title">{section.heading}</span>
                      </button>
                    ))
                  : null}
              </div>
            ))}
          </div>
        </aside>

        <main className="panel reader" ref={readerRef} style={{ maxHeight: "calc(100vh - 190px)", overflowY: "auto" }}>
          <div className="panel-head sticky" style={{ position: "sticky", top: 0, zIndex: 1 }}>
            <span className="panel-title">{docLabel(currentDoc?.docType)} — live reader</span>
            <span className="autoscroll-note">{terminal ? "Run complete" : connected ? "● live" : reconnecting ? "◌ reconnecting" : "— offline"}</span>
          </div>
          <div style={{ padding: "var(--space-4)" }}>
            {currentSection ? (
              <article className="reader-section">
                <div className="reader-section-head">
                  <h3>{currentSection.heading}</h3>
                  <SectionPill status="done" ordinal={activeSection + 1} />
                </div>
                <Markdown source={currentSection.body_md} renderMermaid={renderMermaid} />
              </article>
            ) : (
              <div className="empty-state">
                <Spinner label="Waiting for the first section…" />
                <p className="muted" style={{ marginTop: "var(--space-3)" }}>
                  Sections appear here as stages produce them. {stageStatus.get("INTAKE_VALIDATE")?.status === "running" ? "Intake validation is running…" : "Queued stages start shortly."}
                </p>
              </div>
            )}
            {terminal && documents.length > 0 ? (
              <div className="row gap-8" style={{ marginTop: "var(--space-4)" }}>
                <Link to={`/app/documents/${documents[0].id}`} className="btn btn-primary">Open the finished document →</Link>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.post(`/v1/runs/${run.id}/bundle`, { formats: ["docx", "md"] }, {});
                      toast.success("Bundle ready — check the project page or exports");
                    } catch (err) {
                      toast.error(err.message);
                    }
                  }}
                >
                  Download full bundle
                </Button>
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function docLabel(docType) {
  return { PRD: "PRD", TRD: "TRD", UIUX: "UI/UX Spec", SCHEMA: "Database Schema", CUSTOM: "Document" }[docType] ?? docType;
}
