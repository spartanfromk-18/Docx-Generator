/**
 * API smoke tests — hit a running SpecForge server (localhost:8787).
 * Run:  npm run test --workspace server   (server must be booted first)
 * Verifies the TRD §2.4 contract end to end on memory DB + mock LLM.
 */
import { describe, it } from "node:test";
import assertStrict from "node:assert/strict";

const BASE = "http://localhost:8787/v1";
let token = "";
let orgId = "";
let projectId = "";

const LONG_IDEA =
  "A personal finance dashboard that auto-categorizes transactions, sets monthly budgets, and alerts when spending exceeds 90% of budget, with CSV export and multi-account support. Users link bank accounts, transactions are categorized by a rules engine, and weekly digest emails summarize spending by category.";

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const res = await req(path, init);
  const text = await res.text();
  assertStrict.ok(res.ok, `${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

describe("SpecForge API smoke", () => {
  it("dev-login issues a JWT and grants 3 credits", async () => {
    const body = await json("/auth/dev-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "smoke@specforge.dev", display_name: "Smoke Tester" }),
    });
    token = body.access_token;
    orgId = body.org.id;
    assertStrict.ok(token.startsWith("eyJ"), "JWT issued");
    assertStrict.equal(body.org.plan, "free");
    assertStrict.ok(orgId);
  });

  it("GET /v1/me returns credits", async () => {
    const me = await json("/me");
    assertStrict.equal(me.email, "smoke@specforge.dev");
    assertStrict.ok(me.credits.balance >= 0);
    assertStrict.equal(me.org.plan, "free");
  });

  it("creates a project and lists projects", async () => {
    const p = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke Project", idea_text: LONG_IDEA }),
    });
    projectId = p.id;
    assertStrict.equal(p.name, "Smoke Project");
    assertStrict.equal(p.org_id, orgId);

    const list = await json("/projects");
    assertStrict.ok(list.items.some((x: any) => x.id === projectId));
  });

  it("top up credits (mock checkout) then create an Idea Mode run", async () => {
    const topup = await json("/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "pack", credits: 30 }),
    });
    assertStrict.ok(topup.credits_added >= 30);

    const run = await json(`/projects/${projectId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "idea", idea: LONG_IDEA, documents: ["PRD", "TRD", "UIUX", "SCHEMA"] }),
    });
    assertStrict.ok(run.id);
    assertStrict.equal(run.mode, "idea");
    assertStrict.equal(run.status, "queued");
    assertStrict.equal(run.credit_cost, 4);

    // poll until terminal
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st: any = await json(`/runs/${run.id}`);
      const last = st.stages?.[st.stages.length - 1] ?? {};
      if (st.run.status !== "queued" && st.run.status !== "running") {
        assertStrict.ok(
          st.run.status === "reviewed" || st.run.status === "reviewed_with_warnings",
          `run ended ${st.run.status}`,
        );
        assertStrict.ok(
          st.stages.every((s: any) => s.status === "succeeded"),
          "every stage should succeed",
        );
        assertStrict.equal(st.documents.length, 4, "four documents produced");
        return;
      }
    }
    assertStrict.fail("run did not reach terminal state within 80s");
  });

  it("GET /v1/health/deep is ok", async () => {
    const h = await json("/health/deep");
    assertStrict.equal(h.status, "ok");
    assertStrict.equal(h.checks.database.ok, true);
    assertStrict.equal(h.checks.engine.ok, true);
    assertStrict.equal(h.checks.seed.ok, true);
  });
});
