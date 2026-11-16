import { rng, seedFrom, titleCase } from "../util.js";
import type { StageName } from "../types.js";

/**
 * Deterministic offline generator. Produces structured documents that satisfy
 * the same Zod schemas real providers must satisfy, so the full pipeline
 * (streaming, versions, review, exports) works with zero API keys.
 * Output quality mirrors the blueprint's own documents (tables, GIVEN/WHEN/THEN,
 * Mermaid diagrams, copy-pasteable DDL).
 */

export interface MockExtraction {
  host: string;
  palette: { hex: string; role: string; usage_share: number }[];
  fonts: { family: string; weights: number[]; usage_share: number }[];
  navigation: { label: string; href: string; depth: number }[];
  a11y: { critical: number; serious: number; moderate: number };
  flows: { name: string; steps: string[] }[];
}

export interface MockContext {
  runId: string;
  idea: string;
  redactedIdea: string;
  entities: string[];
  glossary: { canonical: Record<string, string>; entities: { name: string; definition: string }[] };
  language: string;
  intake: Record<string, string>;
  extraction: MockExtraction | null;
  docTitle: string;
}

export interface MockDoc {
  title: string;
  sections: { heading: string; body_md: string }[];
}

const FENCE = "```";
const r2 = (n: number) => Math.round(n * 100) / 100;

export function sqlIdentifier(entity: string): string {
  return entity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/__+/g, "_")
    .slice(0, 40) || "item";
}

export function mockGenerate(stage: StageName, ctx: MockContext, _attempt: number): unknown {
  switch (stage) {
    case "PRD":
      return prdDoc(ctx);
    case "TRD":
      return trdDoc(ctx);
    case "UX":
      return uixDoc(ctx);
    case "SCHEMA":
      return schemaDoc(ctx);
    default:
      throw new Error(`stage ${stage} does not use mock generation`);
  }
}

/** ===== PRD ===== */

function prdDoc(ctx: MockContext): MockDoc {
  const r = rng(seedFrom(ctx.idea + "prd"));
  const ents = ctx.entities;
  const main = ents[0] ?? "Project";
  const product = ctx.docTitle;
  const personas = [
    { name: "Maya — solo founder", ctx: "Builds alone on a tight budget", job: `Launch ${main.toLowerCase()} without hiring`, success: "Complete spec set in one sitting" },
    { name: "Arjun — staff engineer", ctx: "Owns architecture at a 60-person company", job: "Review-ready TRD with scale and security rigour", success: "Schema is merge-ready" },
    { name: "Priya — agency PM", ctx: "Pitches across 5 time zones", job: "Scope work the same day as discovery", success: "Scope document delivered same-day" },
    { name: "Leo — bootcamp graduate", ctx: "Building a portfolio project", job: "Learn what real specs look like", success: "Uses output as a learning template" },
  ];

  const sections: MockDoc["sections"] = [];

  if (ctx.extraction) {
    const e = ctx.extraction;
    sections.push({
      heading: "Existing Product Analysis",
      body_md: [
        `Grounded in a crawl of **${e.host}** (${e.navigation.length} navigation items mapped).`,
        "",
        "| Aspect | Finding | Confidence |",
        "| --- | --- | --- |",
        `| Visual identity | ${e.palette.slice(0, 3).map((p) => p.hex).join(", ")} with ${e.fonts[0]?.family ?? "system font"} typography | observed |`,
        `| Core navigation | ${e.navigation.slice(0, 5).map((n) => n.label).join(" → ") || "single-page site"} | observed |`,
        `| Accessibility baseline | ${e.a11y.critical} critical, ${e.a11y.serious} serious automated findings | observed |`,
        `| Primary flows | ${e.flows.map((f) => f.name).join(", ") || "sign-up and content consumption"} | inferred |`,
        "",
        "Requirements reverse-engineered from the live product are labelled **observed**; gaps and improvements this project should add are labelled **recommended**.",
      ].join("\n"),
    });
  }

  sections.push(
    {
      heading: "Executive Thesis",
      body_md:
        `${product} is built on a simple observation: ${firstSentence(ctx.idea)} ` +
        `Today this workflow is manual, inconsistent, and loses context between the people who specify work and the people who execute it. ` +
        `${product} treats ${ents.slice(0, 3).join(", ").toLowerCase()} as first-class, connected objects with one canonical glossary, so that every artifact produced downstream — specifications, designs, and the database schema — stays internally consistent. ` +
        `The wedge is speed: a user should reach a reviewable, complete result in minutes, not days, and that result must be good enough to hand to engineers or AI coding agents without embarrassment.`,
    },
    {
      heading: "Personas",
      body_md:
        "| Persona | Context | Job to be done | Success looks like |\n| --- | --- | --- | --- |\n" +
        personas.map((p) => `| ${p.name} | ${p.ctx} | ${p.job} | ${p.success} |`).join("\n"),
    },
    {
      heading: "Success Metrics",
      body_md:
        "| Metric | Definition | Launch (day 90) | Month 12 |\n| --- | --- | --- | --- |\n" +
        "| North Star: Completed Runs per Week | Runs reaching `reviewed` with an export or share within 7 days | 2,000 | 60,000 |\n" +
        "| Activation rate | New verified users starting a run within 10 minutes | 55% | 65% |\n" +
        "| Time to first value | Median run start → first rendered section | under 6 s | under 4 s |\n" +
        "| Run completion rate | `reviewed` / started (excluding user cancels) | 97% | 99% |\n" +
        "| Free→Pro conversion | Upgrades within 30 days | 3.0% | 5.5% |",
    },
    {
      heading: "Functional Requirements (P0)",
      body_md: p0Requirements(ctx, ents, r),
    },
    {
      heading: "Non-Functional Requirements",
      body_md:
        "| Area | Target | Measurement |\n| --- | --- | --- |\n" +
        "| API availability | 99.95% monthly | Synthetic probe every 30 s from 3 regions |\n" +
        "| Read latency | p95 120 ms / p99 300 ms | Server-side histograms |\n" +
        "| First streamed token | p95 3 s / p99 6 s | Client + server timestamps |\n" +
        "| Full run (Idea Mode) | p95 150 s | Run timestamps |\n" +
        "| Accessibility | WCAG 2.2 AA on all P0 flows | axe-core in CI + manual pass |\n" +
        "| Durability | Zero lost committed run state | Multi-AZ storage, PITR |",
    },
    {
      heading: "Edge-Case Matrix",
      body_md:
        "| Scenario | Deterministic handling | User-visible result |\n| --- | --- | --- |\n" +
        "| Double submit | Idempotency-Key replays the original response | One run, one charge |\n" +
        "| Insufficient credits | `402` with exact shortfall before anything is reserved | Top-up dialog with numbers |\n" +
        "| Provider outage | Failover, then pause with automatic resume | Banner: resume is automatic |\n" +
        "| Invalid structured output | One repair pass, then section failed | Retry-this-section control |\n" +
        "| User cancels mid-run | Unused reservation released within 60 s | Completed sections remain readable |\n" +
        "| Concurrent edits | Optimistic concurrency on `base_version_no` | 409 with merge dialog |\n" +
        "| Sensitive data pasted | Regex + entropy scan redacts before the LLM call | Notice listing redactions |",
    },
    {
      heading: "Scope Boundaries",
      body_md:
        "Out of scope at launch:\n\n" +
        "- Generating or deploying application source code (specifications only)\n" +
        "- Legal, regulatory, or financial advice\n" +
        "- Crawling pages behind authentication\n" +
        "- Bypassing robots.txt, CAPTCHAs, or paywalls\n" +
        "- Real-time multi-cursor collaborative editing\n\n" +
        `In scope: the full specification set for ${ents.slice(0, 4).join(", ")} with cross-document consistency review.`,
    },
    {
      heading: "Glossary",
      body_md:
        "| Term | Definition |\n| --- | --- |\n" +
        ctx.glossary.entities.map((e) => `| ${e.name} | ${e.definition} |`).join("\n"),
    },
  );

  return { title: `PRD — ${product}`, sections };
}

function firstSentence(text: string): string {
  const s = text.trim().split(/(?<=[.!?])\s/)[0] ?? text;
  return s.length > 220 ? s.slice(0, 217) + "…" : s;
}

function p0Requirements(ctx: MockContext, ents: string[], r: () => number): string {
  const given = (s: string) => `GIVEN ${s}`;
  const rows: string[] = [];
  const features = ctx.intake["must_have_features"]
    ? ctx.intake["must_have_features"].split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const base = [
    ["Account and organization signup", "a new visitor with an unverified email", "they complete signup", "an account and a personal organization are created; runs unlock after email verification"],
    ["Core creation flow", "a signed-in editor", `they create a new ${ents[0]?.toLowerCase() ?? "item"}`, "the item is created in the user's organization and appears immediately in the list"],
    ["Structured intake", "a user starting from a blank state", "they use the guided flow", "every option is skippable and results still meet the quality bar"],
  ];
  for (const [name, g, w, t] of base) {
    rows.push(`**FR-${rows.length + 1} ${name}**\n- ${given(g)} WHEN ${w} THEN ${t}.`);
  }
  for (const ent of ents.slice(0, 4)) {
    rows.push(
      `**FR-${rows.length + 1} Manage ${ent}s**\n` +
        `- ${given(`an organization with at least one ${ent.toLowerCase()}`)} WHEN the user opens the ${ent.toLowerCase()} list THEN items are listed newest-first with keyset pagination and tenant-scoped access.\n` +
        `- ${given(`a ${ent.toLowerCase()} the user can edit`)} WHEN a concurrent edit conflicts THEN the API returns 409 with the current server state and no silent overwrite.`,
    );
  }
  features.slice(0, 3).forEach((f) => {
    rows.push(
      `**FR-${rows.length + 1} ${titleCase(f)}**\n` +
        `- ${given("a verified user with sufficient credits")} WHEN they invoke "${f}" THEN the flow completes with an auditable record and idempotent retries.\n` +
        `- ${given(`a user without access`)} WHEN they attempt "${f}" THEN they receive 403 and no partial state is created.`,
    );
  });
  rows.push(
    `**FR-${rows.length + 1} Billing and credits**\n` +
      `- ${given("a user with 3 credits")} WHEN they start a run costing more THEN the API returns 402 with the exact shortfall and nothing is reserved.\n` +
      `- ${given("a completed stage")} WHEN settlement runs THEN exactly one ledger row of type \`settle\` is written per (run, stage, attempt).`,
  );
  return rows.join("\n\n");
}

/** ===== TRD ===== */

function trdDoc(ctx: MockContext): MockDoc {
  const ents = ctx.entities;
  const product = ctx.docTitle;
  // API contract covers every glossary entity so the deterministic
  // consistency review (PRD FR-14) passes by construction.
  const apiRows: string[][] = [];
  for (const ent of ents.slice(0, 5)) {
    const t = sqlIdentifier(ent);
    apiRows.push(["POST", `/v1/${t}`, `${t}:write`, "60/min", "Required", t]);
    apiRows.push(["GET", `/v1/${t}?cursor=`, `${t}:read`, "General", "Safe", t]);
    apiRows.push(["GET", `/v1/${t}/{id}`, `${t}:read`, "General", "Safe", t]);
    apiRows.push(["PATCH", `/v1/${t}/{id}`, `${t}:write`, "General", "Required", t]);
  }

  return {
    title: `TRD — ${product}`,
    sections: [
      {
        heading: "System Topology",
        body_md:
          `Request path: browser → CDN/WAF → API gateway → stateless services → data tier. Every tier between the gateway and the database is stateless and scales horizontally.\n\n` +
          `${FENCE}mermaid\nflowchart LR\n  C[Browser] --> CDN[CDN + WAF]\n  CDN --> GW[API Gateway]\n  GW --> API[API pods]\n  GW --> SSE[Realtime SSE tier]\n  API --> PB[(PgBouncer)]\n  API --> V[(Valkey)]\n  SSE --> V\n  API --> Q[[Queues]]\n  Q --> W[Stage workers]\n  Q --> CW[Crawl workers]\n  W --> PB\n  CW --> PX[Egress proxy]\n  PB --> DB[(PostgreSQL 16)]\n  W --> LLM[LLM gateway]\n${FENCE}\n\n` +
          `The crawler is the only component that touches untrusted sites, and it reaches them only through the egress proxy.`,
      },
      {
        heading: "Stack Decisions",
        body_md:
          "| Layer | Choice | Why this choice | Rejected alternatives |\n| --- | --- | --- | --- |\n" +
          "| API | Node.js 22 + Fastify 5 + TypeScript | Schema-first validation shared with the frontend; 2× Express JSON throughput | NestJS (DI overhead), Go (slower iteration) |\n" +
          "| Database | PostgreSQL 16 + PgBouncer | Relational integrity for ledgers, RLS, partitioning | DynamoDB (no joins/RLS), MongoDB (weaker multi-row transactions) |\n" +
          "| Cache | Valkey 8 | Sub-ms reads, Lua limiters, Streams for fan-out | Memcached (no atomics/streams) |\n" +
          "| Queues | SQS + DLQ | Zero-ops throughput, native DLQ, visibility timeout fits long LLM jobs | Kafka (overkill at this rate), RabbitMQ (HA burden) |\n" +
          "| Workflow | Checkpointed stage graph in Postgres | Transactional with ledger writes; Temporal is the P2 path | Temporal now (extra platform) |\n" +
          "| LLM | Provider-agnostic gateway | One enforcement point for budgets, failover, validation | Direct SDK calls (no budget control) |",
      },
      {
        heading: "Caching Blueprint",
        body_md:
          "| Layer | What | TTL | Invalidation |\n| --- | --- | --- | --- |\n" +
          "| CDN | Static assets, public share pages | 1 y / 60 s | Surrogate-key purge |\n" +
          "| L1 in-process | Feature flags, templates, JWKS | 10 s + jitter | TTL only |\n" +
          "| L2 Valkey | Summaries, permission decisions, run snapshots | 60 s / 5 s | Write-through on state change |\n" +
          "| Idempotency | Response replays | 24 h | Expiry; persisted for durability |\n\n" +
          "Stampede protection: single-flight lock `SET NX PX 5000`; callers wait ≤250 ms then serve stale. Negative caching 5 s. Cache keys carry the org id prefix. Credit balances and entitlements are **never** served from cache.",
      },
      {
        heading: "API Contract",
        body_md:
          "JSON over HTTPS. Mutating requests require `Idempotency-Key`. Unknown properties rejected.\n\n" +
          "| Method | Path | Scope | Rate limit | Idempotent | Resource |\n| --- | --- | --- | --- | --- | --- |\n" +
          apiRows.map((r) => `| ${r[0]} | \`${r[1]}\` | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5].split(":")[0]} |`).join("\n") +
          "\n\nErrors use the envelope `{error:{code,message,details,request_id,retryable}}` with the status catalogue from the error-code table (400/401/402/403/404/409/413/422/429/503).",
      },
      {
        heading: "Security",
        body_md:
          "- **Tenancy**: every query carries `org_id`; Postgres RLS with `SET LOCAL app.org_id` enforces it independently of application code; cross-tenant ids return 404.\n" +
          "- **AuthN**: OIDC with PKCE; RS256 JWTs, 15-minute access tokens, rotating refresh tokens; API keys stored as SHA-256 hashes with the `sf_live_<prefix>_<secret>` format.\n" +
          "- **SSRF**: crawler egress only through a validating proxy; private ranges, loopback, link-local, CGNAT, and metadata addresses blocked; DNS pinned per connection; redirects re-validated (max 5).\n" +
          "- **Untrusted content**: crawled text enters prompts only as delimited data through a tool-less extraction call with strict JSON validation; `injection_suspected` is recorded when hostile instructions are detected.\n" +
          "- **Cost control**: per-run hard caps on input/output tokens and repair attempts; daily spend breaker halts free-tier traffic at 100%.\n" +
          "- **Secrets**: redaction scan before any LLM call; logs never contain idea text or crawled content.",
      },
      {
        heading: "Observability",
        body_md:
          "- OpenTelemetry traces propagate through HTTP, queue attributes, and outbox payloads so a run is one trace end to end. 100% of errors and slow runs sampled.\n" +
          "- Span attributes: org_id (hashed), run_id, stage, attempt, provider, model, tokens_in/out, credit_cost, cache_hit.\n" +
          "- RED metrics per route; queue depth and age; worker lease expirations; DB connections and replica lag; LLM tokens per minute and breaker state; credits reserved-vs-settled drift must be 0 after 10 minutes of quiescence.\n" +
          "- SLO alerts use multi-window burn rates; pages: DLQ depth, ledger drift, breaker open 5 min, outbox oldest pending > 60 s.",
      },
      {
        heading: "CI/CD and Rollout",
        body_md:
          "- PR gate: lint, typecheck, unit tests, OpenAPI diff, contract tests, integration tests on ephemeral Postgres (including a cross-tenant 404 suite), SAST, dependency audit, container scan, secret scan, axe-core a11y tests.\n" +
          "- Migrations: expand-contract only, `lock_timeout=3s`, batched backfills.\n" +
          "- Rollout: canary 5%→25%→50%→100% with automatic abort on error-rate or p95 regression; workers drain with SIGTERM and release leases.\n" +
          "- DR: warm standby region, cross-region S3 replication, PITR 14 days, quarterly game days.",
      },
    ],
  };
}

/** Expose the API resource list for review (also parsed from the rendered table). */
export function trdResources(ctx: MockContext): string[] {
  return ctx.entities.slice(0, 4).map(sqlIdentifier);
}

/** ===== UI/UX ===== */

function uixDoc(ctx: MockContext): MockDoc {
  const ents = ctx.entities;
  const product = ctx.docTitle;
  const palette = ctx.extraction?.palette ?? DEFAULT_PALETTE;
  const fonts = ctx.extraction?.fonts ?? [{ family: "Inter", weights: [400, 500, 600, 700], usage_share: 0.95 }];
  const label = ctx.extraction ? "observed" : "recommended";
  const bindings = ents.slice(0, 4).map(sqlIdentifier);

  return {
    title: `UI/UX Specification — ${product}`,
    sections: [
      {
        heading: "Information Architecture",
        body_md:
          "Sitemap (authenticated shell under `/app`):\n\n" +
          "- `/` Marketing landing (static)\n" +
          "- `/pricing` Plans and credit packs\n" +
          "- `/login` Passwordless entry\n" +
          `- \`/app\` → dashboard listing ${ents.slice(0, 2).join(" and ").toLowerCase()}\n` +
          `- \`/app/${sqlIdentifier(ents[0] ?? "items")}/new\` Guided creation flow\n` +
          `- \`/app/${sqlIdentifier(ents[0] ?? "items")}/:id\` Detail with inline editing\n` +
          "- `/app/billing` Credits, plan, invoices\n" +
          "- `/app/settings` Profile, members, API keys\n\n" +
          "Navigation is two levels deep maximum; every screen is reachable within two clicks of the dashboard.",
      },
      {
        heading: "User Flows",
        body_md:
          `${FENCE}mermaid\nstateDiagram-v2\n  [*] --> Composing\n  Composing --> Validating: submit\n  Validating --> Composing: validation error\n  Validating --> Running: accepted\n  Running --> Reviewing: stages complete\n  Reviewing --> [*]: export or share\n${FENCE}\n\n` +
          "Primary flow: intake → validation → live run with progressive rendering → review → export/share. Failure paths keep completed content readable and offer targeted retry.",
      },
      {
        heading: "Component Inventory",
        body_md:
          "| Level | Components |\n| --- | --- |\n" +
          "| Atoms | Button, IconButton, TextInput, Textarea, Checkbox, Select, Badge, Chip, Spinner, Skeleton, ProgressBar, Tooltip, Avatar, Divider |\n" +
          "| Molecules | FormField, " + ents.slice(0, 2).map((e) => `${e}Card`).join(", ") + ", StatusPill, ConfirmDialog, CopyButton, EmptyStateBlock |\n" +
          "| Organisms | TopBar, SideNav, FilterBar, " + ents.slice(0, 3).map((e) => `${e}Panel`).join(", ") + ", ActivityFeed, ExportDialog |\n\n" +
          `Data bindings: ${bindings.map((b) => `\`${b}\``).join(", ")}. Every data-bound surface is tenant-scoped by the organization context.\n\n` +
          `All components have keyboard support and visible focus; hit targets are at least 24×24 px (44 px on touch).`,
      },
      {
        heading: "Interaction States",
        body_md:
          "| Surface | Empty | Loading | Partial error | Full error | Offline |\n| --- | --- | --- | --- | --- | --- |\n" +
          `| ${ents[0] ?? "Item"} list | Illustration + primary CTA | 6 card skeletons | Failed card shows Retry | Error panel with request id | Cached list + banner |\n` +
          "| Detail view | \"No content yet\" | Heading + line skeletons | Section-level boundary | 404 page | Read-only banner |\n" +
          "| Forms | Prefilled from context | Submit disabled | Inline errors linked by aria-describedby | Error summary on submit | Mutations blocked with reason |\n" +
          "| Background sync | — | — | Toast with Retry | Banner + reconnect | Draft saved locally |",
      },
      {
        heading: "Design Tokens",
        body_md:
          `Palette (${label}):\n\n` +
          "| Swatch | Hex | Role | Usage |\n| --- | --- | --- | --- |\n" +
          palette.slice(0, 6).map((p) => `| ${p.hex} | \`${p.hex}\` | ${p.role} | ${Math.round(p.usage_share * 100)}% |`).join("\n") +
          "\n\nTypography (" + label + "):\n\n" +
          "| Family | Weights | Usage share |\n| --- | --- | --- |\n" +
          fonts.map((f) => `| ${f.family} | ${f.weights.join(", ")} | ${Math.round(f.usage_share * 100)}% |`).join("\n") +
          "\n\nType scale: 12/16, 14/20, 16/24 (body, never below 16 px for reading), 20/28, 24/32, 30/38. Spacing on a 4 px base; radii 6/10/16; motion 120/200/320 ms with `cubic-bezier(.2,0,0,1)`; reduced-motion replaces shimmer with static placeholders.",
      },
      {
        heading: "Accessibility (WCAG 2.2 AA)",
        body_md:
          "| Criterion | How it is met |\n| --- | --- |\n" +
          "| 1.4.3/1.4.11 Contrast | Text ≥4.5:1, UI ≥3:1 in both themes; ratios unit-tested in CI |\n" +
          "| 2.1.1/2.1.2 Keyboard | All functions keyboard-operable; focus traps only in dialogs with Esc exit |\n" +
          "| 2.4.7 Focus visible | 2 px ring with 2 px offset, never removed |\n" +
          "| 2.4.11 Focus not obscured | scroll-padding equals sticky header height |\n" +
          "| 2.5.8 Target size | ≥24×24 px minimum, 44 px on touch |\n" +
          "| 3.3.1 Errors identified | Inline errors linked with aria-describedby; summary on submit |\n" +
          "| 4.1.3 Status messages | aria-live polite for progress and toasts; assertive for errors |\n\n" +
          (ctx.extraction
            ? `Automated findings on the reference site: ${ctx.extraction.a11y.critical} critical, ${ctx.extraction.a11y.serious} serious, ${ctx.extraction.a11y.moderate} moderate — all must be addressed or consciously accepted in this rebuild.`
            : "axe-core runs in CI on every route and state; manual screen-reader pass on P0 flows each release."),
      },
    ],
  };
}

/** UX data bindings for the deterministic review (also parsed from the rendered doc). */
export function uixBindings(ctx: MockContext): string[] {
  return ctx.entities.slice(0, 4).map(sqlIdentifier);
}

const DEFAULT_PALETTE = [
  { hex: "#1F3A5F", role: "primary", usage_share: 0.24 },
  { hex: "#1D4ED8", role: "link", usage_share: 0.06 },
  { hex: "#0F7B4D", role: "success", usage_share: 0.04 },
  { hex: "#B42318", role: "danger", usage_share: 0.03 },
  { hex: "#111827", role: "text", usage_share: 0.31 },
  { hex: "#F7F8FA", role: "surface", usage_share: 0.32 },
];

/** ===== SCHEMA ===== */

function schemaDoc(ctx: MockContext): MockDoc {
  const ents = ctx.entities.slice(0, 5);
  const tables = ents.map(sqlIdentifier);
  const ddl = buildDdl(ents.map((e) => titleCase(e)));
  const erd = buildErd(ents.map((e) => titleCase(e)));

  return {
    title: `Database Schema — ${ctx.docTitle}`,
    sections: [
      {
        heading: "Entity-Relationship Diagram",
        body_md:
          `${FENCE}mermaid\nerDiagram\n` +
          erd +
          `${FENCE}\n\n` +
          "Every table carries `org_id` with a composite foreign key to `organizations`, enabling row-level security and hash-partition pruning. Primary keys are UUIDv7 (time-ordered).",
      },
      {
        heading: "PostgreSQL DDL",
        body_md:
          `${FENCE}sql\n` +
          ddl +
          `${FENCE}`,
      },
      {
        heading: "Indexing Strategy",
        body_md:
          tables
            .map(
              (t) =>
                `- \`ix_${t}_org_updated\` on (${t}.org_id, ${t}.updated_at DESC) — keyset list queries; partial \`WHERE deleted_at IS NULL\` where soft delete applies.`,
            )
            .join("\n") +
          "\n\n- Hot lookups use unique indexes on natural keys; all composite indexes are ordered to match their query predicate exactly.\n- Large append-only tables (events, audit) are range-partitioned monthly so retention is a partition detach, not a mass delete.",
      },
      {
        heading: "Row-Level Security and Policies",
        body_md:
          `${FENCE}sql\nALTER TABLE ${tables[0]} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${tables[0]} FORCE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON ${tables[0]}\n  USING (org_id = current_org())\n  WITH CHECK (org_id = current_org());\n\n-- The application sets the tenant context at the start of every transaction:\n-- SET LOCAL app.org_id = '<uuid>';\n${FENCE}\n\n` +
          "The application connects as a non-bypass role, so tenant isolation is enforced by the database even if application code is wrong. Soft-deleted rows are excluded by partial indexes and filtered reads; hard purge happens after a 30-day window.",
      },
    ],
  };
}

export function schemaTables(ctx: MockContext): string[] {
  return ctx.entities.slice(0, 5).map(sqlIdentifier);
}

export function buildErd(entities: string[]): string {
  const lines: string[] = [];
  lines.push("  organizations ||--o{ projects : \"owns\"");
  for (let i = 0; i < entities.length; i++) {
    const t = sqlIdentifier(entities[i]);
    const parent = i === 0 ? "projects" : sqlIdentifier(entities[i - 1]);
    lines.push(`  ${parent} ||--o{ ${t} : "has"`);
  }
  for (const e of entities) {
    const t = sqlIdentifier(e);
    lines.push(`  ${t} {`);
    lines.push("    uuid id PK");
    lines.push("    uuid org_id FK");
    lines.push("    text name");
    lines.push("    jsonb metadata");
    lines.push("    timestamptz created_at");
    lines.push("  }");
  }
  return lines.join("\n") + "\n";
}

export function buildDdl(entities: string[]): string {
  const out: string[] = [];
  out.push("-- SpecForge generated schema (PostgreSQL 16)");
  out.push("-- Requires extensions: pgcrypto (uuid generation)");
  out.push("");
  for (const e of entities) {
    const t = sqlIdentifier(e);
    out.push(`CREATE TABLE ${t} (`);
    out.push("  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),");
    out.push("  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,");
    out.push(`  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),`);
    out.push("  status      text NOT NULL DEFAULT 'active',");
    out.push("  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,");
    out.push("  created_at  timestamptz NOT NULL DEFAULT now(),");
    out.push("  updated_at  timestamptz NOT NULL DEFAULT now(),");
    out.push("  deleted_at  timestamptz");
    out.push(");");
    out.push(`CREATE INDEX ix_${t}_org_updated ON ${t} (org_id, updated_at DESC) WHERE deleted_at IS NULL;`);
    out.push("");
  }
  return out.join("\n") + "\n";
}

export function extractDdlFromSections(sections: { heading: string; body_md: string }[]): string | null {
  for (const s of sections) {
    const m = /```sql\n([\s\S]*?)```/.exec(s.body_md);
    if (m) return m[1];
  }
  return null;
}
