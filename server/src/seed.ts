/**
 * Demo seed — a realistic organization, user, completed project and run with the full
 * four-document suite (PRD, TRD, UIUX, SCHEMA), so the app is immediately explorable.
 * Idempotent: seeding twice is a no-op (keyed on the demo user's email).
 *
 * The demo run is executed through the REAL pipeline (PipelineRunner.runStage per
 * stage), so seeding also validates the engine, credit settlement and persistence.
 */
import { EventHub } from "./realtime/hub.js";
import { LLMGateway } from "./llm/gateway.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { plannedStages, runCost } from "./services/credits.js";
import { plannedStageRow } from "./routes/runHelpers.js";
import { uuidv7, nowIso, slugify, extractEntities } from "./util.js";
import type { Repo } from "./db/repo.js";
import type { RunRow } from "./types.js";

export const DEMO_EMAIL = "demo@specforge.dev";
export const DEMO_HINT = "POST /v1/auth/dev-login with any email — demo@specforge.dev is pre-seeded.";

const IDEA_TEXT = [
  "Atlas is a commerce operations platform for mid-market retailers running on Shopify and Amazon.",
  "Merchants struggle to reconcile inventory across channels, forecast demand for promotions,",
  "and keep pricing consistent. Atlas syncs listings, predicts stockouts two weeks ahead,",
  "and auto-adjusts prices within guardrails. The workspace tracks margin impact per SKU,",
  "supports multi-warehouse transfers, and alerts the ops team in Slack when fulfillment SLAs slip,",
  "while finance exports reconcile ledgers nightly so every channel stays audited.",
].join(" ");

const INTAKE = {
  audience: "Mid-market retail operations teams (5–50 people)",
  core_problem: "Inventory and pricing drift across Shopify and Amazon causes stockouts and margin leakage",
  must_have_features: "Channel sync, Demand forecast, Price guardrails, Slack alerts, Multi-warehouse transfers",
  scale_goal: "5,000 SKUs per merchant, 10k DAU platform-wide",
  stack_preference: "Fastify + PostgreSQL + React; Shopify and Amazon APIs",
  compliance_needs: "SOC 2 readiness; PCI SAQ-A via hosted fields",
};

export async function seed(repo: Repo): Promise<{ seeded: boolean; orgId?: string; runId?: string }> {
  const existing = await repo.findUserByEmail(DEMO_EMAIL);
  if (existing) {
    const orgs = await repo.listOrgsForUser(existing.id);
    return { seeded: false, orgId: orgs[0]?.org.id };
  }

  // ===== user + org (pro plan so the demo shows pro rate limits) =====
  const user = await repo.insertUser({
    id: uuidv7(),
    email: DEMO_EMAIL,
    email_verified_at: nowIso(),
    display_name: "Dana Demo",
    idp_subject: `dev:${DEMO_EMAIL}`,
    locale: "en",
    risk_score: 0,
    free_credits_granted_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  });
  const org = await repo.createOrgWithOwner(
    { id: uuidv7(), name: "SpecForge Demo", slug: "specforge-demo", plan: "pro", data_region: "us", is_personal: true },
    user.id,
  );

  // ===== credits: free grant + starter pack (ledger shows the story) =====
  await repo.grantCredits(org.id, 3, `free:${user.id}`, { reason: "signup_grant", user_id: user.id });
  await repo.grantCredits(org.id, 25, `pack:25:${user.id}`, { reason: "credit_pack", note: "Demo starter pack" });

  // ===== project =====
  const projectId = uuidv7();
  const project = await repo.insertProject({
    id: projectId,
    org_id: org.id,
    created_by: user.id,
    name: "Atlas Commerce Replatform",
    description: "Omnichannel inventory, forecasting and pricing operations for mid-market retailers.",
    idea_text: IDEA_TEXT,
    language: "en",
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  });

  // ===== run created through the real reservation path =====
  const runId = uuidv7();
  const docTypes: RunRow["doc_types"] = ["PRD", "TRD", "UIUX", "SCHEMA"];
  const entities = extractEntities(IDEA_TEXT, 6);
  const now = nowIso();
  const cost = runCost("idea", docTypes);
  const stages = plannedStages("idea", docTypes).map((stage) => plannedStageRow(org.id, runId, stage));
  const run: RunRow = {
    id: runId,
    org_id: org.id,
    project_id: projectId,
    source_id: null,
    created_by: user.id,
    mode: "idea",
    status: "queued",
    input: { idea: IDEA_TEXT, intake: INTAKE, documents: docTypes, redactions: [] },
    language: "en",
    doc_types: docTypes,
    glossary: {
      canonical: Object.fromEntries(entities.map((e) => [e.toLowerCase(), slugify(e)])),
      entities: entities.map((name) => ({ name, definition: `${name} — a tenant-scoped commerce object tracked per merchant workspace.` })),
    },
    credit_cost: cost,
    credits_reserved: cost,
    credits_settled: 0,
    max_input_tokens: 120_000,
    max_output_tokens: 80_000,
    max_repair_attempts: 2,
    tokens_in: 0,
    tokens_out: 0,
    llm_calls: 0,
    injection_suspected: false,
    cancel_requested_at: null,
    error_code: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
    consistency: null,
  };
  await repo.createRunWithReservation(run, stages, cost);

  // Execute the pipeline synchronously through the REAL runner (mock provider is fast).
  const runner = new PipelineRunner({ repo, hub: new EventHub(), gateway: new LLMGateway() });
  for (const stage of plannedStages("idea", docTypes)) {
    await runner.runStage(org.id, runId, stage);
  }
  const finished = await repo.getRunSystem(runId);
  if (finished && !["reviewed", "reviewed_with_warnings"].includes(finished.status)) {
    console.warn(`[seed] warning: demo run finished as "${finished.status}"`);
  }

  console.log(`[seed] demo data ready — org=${org.slug} user=${DEMO_EMAIL} project="${project.name}" run=${runId}`);
  return { seeded: true, orgId: org.id, runId };
}

// Standalone execution: npm run seed
const invokedDirectly = process.argv[1] && import.meta.url.replace(/\\/g, "/").endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  const { createRepo } = await import("./db/repo.js");
  const repo = await createRepo();
  const result = await seed(repo);
  console.log(result.seeded ? "[seed] seeded fresh demo data." : "[seed] demo data already present; nothing to do.");
  await repo.close();
  process.exit(0);
}
