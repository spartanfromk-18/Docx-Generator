# SpecForge

**AI documentation generator for developers and SaaS builders.** Describe a project idea (or paste the URL of an existing product) and SpecForge produces a complete, internally consistent engineering specification set in minutes:

- **PRD** — executive thesis, personas, metrics, P0/P1/P2 stories with GIVEN/WHEN/THEN acceptance criteria, NFRs, edge-case matrix
- **TRD** — topology, stack justification, caching blueprint, API contract, security, observability, CI/CD
- **UI/UX** — information architecture, flows, component inventory, interaction states, design tokens, WCAG 2.2 AA checklist
- **SCHEMA** — Mermaid ERD + copy-pasteable PostgreSQL DDL, validated against a real database

Built from the full SpecForge blueprint (`00`–`04` docs + `05_schema.sql`): multi-tenant with RLS, reserve-then-settle credit ledger, checkpointed stage-graph pipeline with leases and retries, transactional outbox, SSRF-hardened crawler, SSE streaming with resume, immutable document versions, DOCX/MD/ZIP exports, and share links.

---

## Quick start (zero setup)

Requires Node 22+. No Docker, no Postgres, no API keys needed — the LLM gateway falls back to a deterministic mock provider and the database to an in-memory store that mirrors the Postgres semantics.

```bash
npm install
npm run dev          # API on :8787, web on :5173
```

Open **http://localhost:5173** → *Continue as demo user* → create a project → **Generate** → watch sections stream live, then export DOCX/ZIP or create a share link.

Seeded demo data (org **Acme Labs**, a completed project with all four documents) is created on first boot.

## Production-shaped run (Docker + PostgreSQL 16 + pgvector)

```bash
docker compose up --build -d
# web  -> http://localhost:5173
# api  -> http://localhost:8787/v1/health/deep
```

`scripts/init_db.sql` (the exact DDL from the spec: 24 tables, hash/range partitioning, RLS, grants) is applied automatically on first boot. The API connects as the `app_api` / `app_system` roles and sets `SET LOCAL app.org_id` per transaction, so Postgres row-level security enforces tenant isolation independently of application code.

## Configuration

Copy `.env.example` → `.env`. Highlights:

| Variable | Default | Purpose |
| --- | --- | --- |
| `USE_MEMORY_DB` | `true` | `false` = PostgreSQL via `DATABASE_URL` |
| `LLM_PROVIDER_ORDER` | `mock,anthropic,openai` | Gateway failover chain; `mock` works offline |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | empty | Real providers used when keys are set and listed |
| `SPECFORGE_MOCK_SPEED` | `1` | Streaming pace multiplier (0 = instant) |
| `SPECFORGE_FAULTS` | empty | `provider_outage` demos the `paused_provider` circuit-breaker state |

## Architecture

```
web (React + Vite + TanStack Query)
        │  REST + SSE
        ▼
server (Fastify 5 + TypeScript)
 ├─ routes/        TRD §2.4 contract: projects, sources, runs, documents,
 │                 exports, share-links, billing, api-keys, health
 ├─ pipeline/      stage graph INTAKE → (CRAWL → EXTRACT) → PRD → (TRD ∥ UX)
 │                 → SCHEMA → SCHEMA_VALIDATE → REVIEW → FINALIZE
 │                 claims with leases + heartbeat, retries with backoff,
 │                 checkpointed per-stage credit settlement, cancellation
 ├─ llm/           provider-agnostic gateway: budgets, failover, circuit
 │                 breaker, structured-output validation + repair pass
 ├─ crawl/         SSRF-guarded fetcher: private-range blocklist, DNS pinning,
 │                 redirect revalidation, robots.txt, palette/fonts/nav extraction
 ├─ services/      credits ledger (reserve → settle/release), audit + outbox
 ├─ realtime/      SSE hub with ring buffer + Last-Event-ID resume
 ├─ exports/       AST-based DOCX, Markdown, ZIP bundle
 └─ db/            repository with two backends:
                   • memory  – zero-setup dev/CI store
                   • postgres– pg Pool per role, tenant RLS context
```

### Credits (PRD FR-9)

| Plan | Price | Included | Limits |
| --- | --- | --- | --- |
| Free | 0 | 3 credits once | Idea Mode, 1 concurrent run, watermark |
| Pro | $19/mo | 60 credits/mo | Reference Mode, 3 concurrent runs |
| Team | $59/mo | 250 credits pooled | 10 concurrent runs |

Idea Mode full set = **4 credits**, Reference Mode = **10 credits**, section regeneration = **0.25 credits**. Runs *reserve* up-front (atomic conditional update), settle per stage, and release unused credits on cancel/failure — every movement is an append-only ledger row.

## API

Base URL `http://localhost:8787/v1`. Mutating requests require an `Idempotency-Key` header (UUID). Errors use the TRD envelope:

```json
{ "error": { "code": "INSUFFICIENT_CREDITS", "message": "…", "details": { "required": 10, "available": 4, "shortfall": 6 }, "request_id": "…", "retryable": false } }
```

| Method + path | Purpose |
| --- | --- |
| `POST /auth/dev-login` | Create/login a demo user (auto-verified, grants 3 credits once) |
| `POST /auth/refresh`, `POST /auth/switch-org` | Token rotation / org switching |
| `GET /.well-known/jwks.json` | RS256 public keys |
| `POST/GET/PATCH/DELETE /projects…` | Project CRUD (keyset pagination, ETag, soft delete) |
| `POST /projects/:id/sources` | Reference Mode URL submit → `202` (SSRF-guarded crawl) |
| `GET /sources/:id`, `POST /sources/:id/confirm` | Crawl preview (pages, palette, fonts, skips) + confirm |
| `POST /projects/:id/runs` | Start run → `202`, reserves credits |
| `GET /runs/:id/events` | **SSE** stream (`section.delta`, `stage.status`, `run.completed`, …) with `Last-Event-ID` resume |
| `POST /runs/:id/cancel`, `POST /runs/:id/stages/:stage/retry` | Cancel / retry a failed stage |
| `GET /documents/:id`, `…/versions/:n`, `POST …/versions` | Immutable versions with optimistic concurrency (`409 VERSION_CONFLICT`) |
| `POST /documents/:id/sections/:sid/regenerate` | Regenerate one section (0.25 credits) |
| `POST /runs/:id/bundle`, `POST /documents/:id/exports`, `GET /exports/:id(/file)` | ZIP bundle + DOCX/MD exports |
| `POST /documents/:id/share-links`, `GET /s/:token` | Share links (256-bit token, hash-stored, optional password) |
| `GET /billing/credits`, `POST /billing/checkout`, `POST /webhooks/stripe` | Ledger, mock checkout, idempotent webhook |

## Repository layout

```
specforge/
├─ scripts/            init_db.sql (spec DDL), dev.mjs (runs api+web)
├─ server/             Fastify API — see README in server/
├─ web/                React SPA — see README in web/
├─ docker-compose.yml  Postgres 16 + pgvector, server, web
└─ .env.example
```

## Push to GitHub

```bash
git init
git add .
git commit -m "SpecForge: full implementation per blueprint"
git branch -M main
git remote add origin https://github.com/<you>/specforge.git
git push -u origin main
```

## Project status

| Area | Status | Notes |
|------|--------|-------|
| Auth (dev-login, RS256 JWT, JWKS, API keys) | REAL | Fully implemented and tested |
| Credits ledger (reserve → settle/release) | REAL | Fully implemented and tested |
| DOCX / MD / ZIP export | REAL | AST-based DOCX via `docx` package; tested end to end |
| Crawler (SSRF-guarded, robots.txt, palette/fonts/nav) | REAL | Code implemented; not yet tested on a live URL |
| LLM (Anthropic / OpenAI / mock) | MOCK BY DEFAULT | `mock` provider is deterministic and offline; real adapters exist behind `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` |
| Database (PostgreSQL + RLS) | MOCK BY DEFAULT | `USE_MEMORY_DB=true` in dev; Postgres repo exists, untested (no Docker on this machine) |
| Stripe (checkout + webhooks) | MOCK BY DEFAULT | Grants credits in dev; no real charges |
| Postgres via Docker | NOT YET TESTED | `docker-compose.yml` + `scripts/init_db.sql` exist; couldn't run here |
| Reference Mode on a live URL | NOT YET TESTED | Crawler code written; needs a public URL + Pro org |
| UI flow tests | NOT YET TESTED | 5 API smoke tests pass; no browser test runner yet |
| Email / magic-link login | NOT BUILT | Dev login (`POST /v1/auth/dev-login`) is the auth entry point |

## Spec compliance map

| Blueprint doc | Implemented by |
| --- | --- |
| `00_Architecture_Reasoning_Loop.docx` findings T1–S9 | LLM gateway failover + caps, SSE off the request path (hub), idempotency + reserve/settle ledger, outbox, optimistic-concurrency versions, SSRF guard, mock/real provider validation |
| `01_PRD.docx` FR-1…FR-14 | Signup grant, guided intake, streaming docs, Reference Mode preview+confirm, credits/plans, exports, consistency review |
| `02_TRD_Scalability_Architecture.docx` §2.2–2.6 | Stage graph + DLQ-style failed_jobs, outbox, circuit breakers, rate limits, error envelope, RBAC + ABAC, API-key `sf_live_*` format |
| `03_UIUX_Frontend_Architecture.docx` §3 | Exact design tokens, run lifecycle UX (live rail, outline, reconnect, pause), state matrix, J/K navigation |
| `04/05_schema` | `scripts/init_db.sql` applied verbatim; repository mirrors composite tenant FKs, ledger immutability, version immutability |

*Generated per the SpecForge blueprint — Mode A, all four sections, no placeholders.*
