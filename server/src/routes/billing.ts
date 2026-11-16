/** Billing routes: credit balance + ledger, mock checkout, mock Stripe webhook. */
import type { FastifyInstance } from "fastify";
import { checkoutSchema, stripeWebhookSchema } from "../schemas.js";
import type { Repo } from "../db/repo.js";
import type { RouteDeps } from "./deps.js";
import { parseBody, requireAuth, requireRole } from "./helpers.js";
import { CREDIT_PACKS, PLANS } from "../services/credits.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { uuidv7, nowIso } from "../util.js";

/** Mock checkout completion — mirrors what the Stripe webhook handler grants. */
async function applyPurchase(repo: Repo, orgId: string, kind: "plan" | "pack", plan?: string, credits?: number): Promise<{ creditsAdded: number; newPlan?: string }> {
  if (kind === "plan" && (plan === "pro" || plan === "team")) {
    const info = PLANS[plan];
    const existing = await repo.getSubscription(orgId);
    await repo.upsertSubscription({
      id: existing?.id ?? uuidv7(),
      org_id: orgId,
      stripe_customer_id: existing?.stripe_customer_id ?? `cus_mock_${orgId.slice(0, 8)}`,
      stripe_subscription_id: `sub_mock_${Date.now()}`,
      plan,
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancel_at_period_end: false,
      last_event_at: nowIso(),
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    });
    await repo.updateOrgPlan(orgId, plan);
    await repo.grantCredits(orgId, info.monthlyCredits, `plan:${plan}:${orgId}:${Date.now()}`, { reason: "plan_purchase", plan });
    return { creditsAdded: info.monthlyCredits, newPlan: plan };
  }
  const pack = CREDIT_PACKS.find((p) => p.credits === credits) ?? CREDIT_PACKS[0];
  await repo.grantCredits(orgId, pack.credits, `pack:${pack.credits}:${orgId}:${Date.now()}`, { reason: "credit_pack" });
  return { creditsAdded: pack.credits };
}

export function registerBillingRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate, hub, runner, gateway } = deps;
  app.get("/v1/billing/credits", async (request) => {
    const auth = await requireAuth(deps, request);
    const account = await repo.getCreditAccount(auth.orgId);
    const ledger = await repo.listLedger(auth.orgId, 50);
    const subscription = await repo.getSubscription(auth.orgId);
    const plans = Object.entries(PLANS).map(([id, p]) => ({
      id,
      label: p.label,
      priceUsd: p.priceUsd,
      monthlyCredits: p.monthlyCredits,
      concurrentRuns: p.concurrentRuns,
      maxPages: p.maxPages,
    }));
    return {
      balance: account.balance,
      reserved: account.reserved,
      available: Math.round((account.balance - account.reserved) * 100) / 100,
      plans,
      packs: CREDIT_PACKS,
      subscription,
      ledger,
    };
  });

  app.post("/v1/billing/checkout", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "admin");
    const body = parseBody(checkoutSchema, request.body);
    const result = await applyPurchase(repo, auth.orgId, body.kind, body.plan, body.credits);
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "billing.checkout",
        resource_type: "org",
        resource_id: auth.orgId,
        metadata: { kind: body.kind, plan: body.plan ?? null, credits: body.credits ?? null, ...result },
      }),
    ]);
    const account = await repo.getCreditAccount(auth.orgId);
    return {
      status: "completed",
      credits_added: result.creditsAdded,
      new_plan: result.newPlan ?? null,
      balance: account.balance,
      reserved: account.reserved,
      note: "Mock checkout — in production this creates a Stripe Checkout Session and the webhook grants credits.",
    };
  });

  /**
   * Mock Stripe webhook. Verifies the signature header only when STRIPE_WEBHOOK_SECRET
   * is configured (HMAC-SHA256 over `${timestamp}.${payload}`); deduplicates by event id.
   */
  app.post("/v1/webhooks/stripe", async (request, reply) => {
    const payload = request.body;
    const parsed = stripeWebhookSchema.safeParse(payload);
    if (!parsed.success) {
      reply.code(400).send({ received: false, error: "invalid payload" });
      return;
    }
    const event = parsed.data;

    if (env_stripeSecret()) {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") {
        reply.code(400).send({ received: false, error: "missing signature" });
        return;
      }
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=") as [string, string]));
      const expected = createHmac("sha256", env_stripeSecret()!).update(`${parts.t ?? ""}.${JSON.stringify(payload)}`).digest("hex");
      const provided = parts.v1 ?? "";
      if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        reply.code(400).send({ received: false, error: "invalid signature" });
        return;
      }
    }

    const webhookId = uuidv7();
    const inserted = await repo.insertWebhookEvent({
      id: webhookId,
      provider: "stripe",
      provider_event_id: event.id,
      event_type: event.type,
      payload: (event.data?.object ?? {}) as Record<string, unknown>,
      status: "received",
      attempts: 0,
      error: null,
      received_at: nowIso(),
      processed_at: null,
    });
    if (!inserted) {
      reply.code(200).send({ received: true, duplicate: true });
      return;
    }

    const obj = (event.data?.object ?? {}) as { client_reference_id?: string; plan?: string; credits?: number; kind?: string };
    const orgId = obj.client_reference_id;
    if (orgId && event.type === "checkout.session.completed") {
      const kind = obj.kind === "pack" ? "pack" : "plan";
      await applyPurchase(repo, orgId, kind, obj.plan, obj.credits);
    }
    await repo.updateWebhookEvent(webhookId, { status: "processed", processed_at: nowIso(), attempts: 1 });
    reply.code(200).send({ received: true });
  });
}

function env_stripeSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}
