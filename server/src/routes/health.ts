/** Deep health check: DB, engine, LLM providers, hub, seed presence. */
import type { FastifyInstance } from "fastify";
import { buildProviderChain } from "../llm/providers.js";
import { env } from "../env.js";
import { DEMO_EMAIL } from "../seed.js";
import type { HealthDeps } from "./deps.js";

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/v1/health/deep", async (_request, reply) => {
    const { repo, hub, engine, startedAt } = deps;
    const checks: Record<string, { ok: boolean; detail: string; latency_ms?: number }> = {};

    const dbStart = Date.now();
    const dbHealth = await repo.health();
    checks.database = { ...dbHealth, latency_ms: Date.now() - dbStart };

    const engineStats = engine.stats();
    checks.engine = { ok: !engine.stopped, detail: `running, ${engineStats.inflight} in flight, up ${Math.round((Date.now() - startedAt) / 1000)}s` };

    const chain = buildProviderChain([...env.llmProviderOrder]);
    checks.llm = {
      ok: chain.length > 0,
      detail: chain.map((p) => p.name).join(", ") || "none configured",
    };

    const hubStats = hub.stats();
    checks.realtime = { ok: true, detail: `${hubStats.streams} stream(s), ${hubStats.subscribers} subscriber(s), ${hubStats.bufferedEvents} buffered` };

    const seedProbe = await repo.findUserByEmail(DEMO_EMAIL);
    checks.seed = { ok: Boolean(seedProbe), detail: seedProbe ? "demo data present" : "seed data missing" };

    const ok = Object.values(checks).every((c) => c.ok);
    reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      uptime_sec: Math.round(process.uptime()),
      version: "1.0.0",
      mode: { db: repo.kind, llm: chain[0]?.name ?? "none", node_env: env.nodeEnv },
      checks,
      ts: new Date().toISOString(),
    });
  });
}
