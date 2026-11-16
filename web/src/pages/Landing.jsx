import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { MermaidRender, renderMermaid } from "../components/MermaidRender.jsx";
import { useAuth } from "../lib/auth.jsx";

const SAMPLES = {
  PRD: `# PRD — Northwind Field Ops

## Executive Thesis
Northwind Field Ops collapses dispatch, checklists and evidence capture into one offline-first workspace. Today coordinators juggle spreadsheets and WhatsApp threads; the result is missed SLAs and untraceable hand-offs.

## Success Metrics
| Metric | Definition | Baseline | Target |
| --- | --- | --- | --- |
| Time-to-first-draft | Idea → PRD v1 | 3–5 days | < 10 minutes |
| Review acceptance | Docs accepted without restructuring | n/a | ≥ 70% |

## Functional Requirements
### FR-1 — Dispatch board
**GIVEN** a coordinator with the editor role **WHEN** they open the board **THEN** jobs are grouped by status and reachable in one click.

### FR-2 — Evidence capture
**GIVEN** a technician offline **WHEN** they attach photos **THEN** uploads queue and sync within 60 s of connectivity.`,
  TRD: `# TRD — Northwind Field Ops

## System Topology
\`\`\`mermaid
flowchart LR
  M[Mobile PWA] --> API[Fastify API]
  API --> Q[[Job queue]]
  Q --> W[Workers]
  API --> PG[(PostgreSQL 16 + RLS)]
\`\`\`

## API Contract
| Endpoint | Purpose | Auth | Notes |
| --- | --- | --- | --- |
| \`POST /v1/jobs\` | Create job | JWT / API key | Idempotency-Key required |
| \`GET /v1/jobs?cursor=\` | Keyset list | JWT | Stable ordering |

## Security
- RLS with \`SET LOCAL app.org_id\` — tenant isolation enforced by the database.
- SSRF blocklist + DNS re-pinning for the crawler.`,
  UX: `# UI/UX Specification — Northwind Field Ops

## Design Tokens
| Swatch | Token | Role | Usage |
| --- | --- | --- | --- |
| ■ \`#1F3A5F\` | --color-primary | primary | 24% |
| ■ \`#F7F8FA\` | --color-surface | surface | 32% |

## User Flows
1. Coordinator creates a job from the dispatch board.
2. Technician receives it offline; checklists render progressively.
3. Evidence syncs when connectivity returns; SLA timers resume.`,
  SCHEMA: `# Database Schema — Northwind Field Ops

## Entity-Relationship Diagram
\`\`\`mermaid
erDiagram
  organizations ||--o{ jobs : "owns"
  jobs ||--o{ job_events : "records"
\`\`\`

## PostgreSQL DDL
\`\`\`sql
CREATE TABLE jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_jobs_org ON jobs (org_id, created_at DESC);
\`\`\``,
};

const FEATURES = [
  { icon: "⚡", title: "Live streamed generation", text: "Watch sections render as the pipeline produces them — SSE with lossless reconnect via Last-Event-ID." },
  { icon: "🧭", title: "Guided six-step intake", text: "Audience, problem, must-haves, scale, stack and compliance — every step skippable, output still meets the quality bar." },
  { icon: "🔍", title: "Reference Mode", text: "Point at a product URL: SSRF-guarded crawl extracts palette, typography, IA and components into the spec." },
  { icon: "🧪", title: "Consistency review", text: "Cross-checks glossary, API resources, UX bindings and schema tables; targeted repair, honest warnings." },
  { icon: "📄", title: "Real exports", text: "AST-built .docx, clean Markdown with Mermaid, and a full-run ZIP bundle — no string-templated documents." },
  { icon: "🛡️", title: "Production posture", text: "RLS tenancy, idempotent mutations, credit reservations settled exactly-once, rate limits and audit log." },
];

export function Landing() {
  const [tab, setTab] = useState("PRD");
  const { isAuthed } = useAuth();
  return (
    <div className="page">
      <section className="hero">
        <h1 className="hero-title">Turn one paragraph into a production-grade spec suite</h1>
        <p className="hero-sub">
          SpecForge generates an internally consistent PRD, TRD, UI/UX specification and database schema —
          streamed live, versioned, reviewable, and exportable.
        </p>
        <div className="hero-cta">
          {isAuthed ? (
            <Link to="/app" className="btn btn-primary btn-lg">Open dashboard</Link>
          ) : (
            <Link to="/login" className="btn btn-primary btn-lg">Start with the demo — 3 free credits</Link>
          )}
          <Link to="/pricing" className="btn btn-lg">See pricing</Link>
        </div>
      </section>

      <section aria-label="Sample output">
        <div className="preview-tabs" role="tablist">
          {Object.keys(SAMPLES).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`preview-tab ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
            >
              {key === "UX" ? "UI/UX" : key}
            </button>
          ))}
        </div>
        <div className="panel preview-panel" role="tabpanel">
          <div className="panel-head">
            <span className="panel-title">Sample {tab === "UX" ? "UI/UX" : tab} output</span>
            <span className="muted" style={{ fontSize: 13 }}>generated in ~40 s in the demo</span>
          </div>
          <div style={{ padding: "var(--space-4)" }}>
            <Markdown source={SAMPLES[tab]} renderMermaid={renderMermaid} />
          </div>
        </div>
      </section>

      <section className="feature-grid" aria-label="Architecture highlights">
        {FEATURES.map((f) => (
          <div key={f.title} className="card feature-card">
            <div className="feature-icon" aria-hidden="true">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginTop: "var(--space-8)", textAlign: "center" }}>
        <h2>Ready in three steps</h2>
        <p className="muted">Compose the idea → confirm the cost preview → watch the live run. Regenerate any single section for 0.25 credits.</p>
        <MermaidRender
          caption="The SpecForge stage graph"
          code={`flowchart LR
  I[Intake] --> C[Crawl + Extract] --> P[PRD]
  P --> T[TRD] & U[UI/UX]
  T & U --> S[Schema]
  S --> V[Validate] --> R[Review] --> F[Finalize]`}
        />
      </section>
    </div>
  );
}
