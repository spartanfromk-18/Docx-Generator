/**
 * SpecForge API server — Fastify 5 entrypoint.
 * Zero-config boot: memory DB + mock LLM provider unless env vars say otherwise.
 *
 * `createApp()` builds and wires the full application (repo, engine, gateway,
 * hub, guards, limiter, idempotency, every route) and returns the app plus its
 * dependencies. It does NOT listen or seed — callers (including tests) control
 * the listen port and lifecycle. `main()` is the direct-run entrypoint.
 */
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";
import { createRepo } from "./db/repo.js";
import { registerErrorHandling } from "./errors.js";
import { makeGuards } from "./auth/guards.js";
import { RateLimiter, makeRateLimitHooks } from "./middleware/rateLimit.js";
import { registerIdempotency } from "./middleware/idempotency.js";
import { LLMGateway } from "./llm/gateway.js";
import { EventHub } from "./realtime/hub.js";
import { Engine } from "./pipeline/engine.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/orgs.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerShareRoutes } from "./routes/share.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerHealthRoutes } from "./routes/health.js";
import { seed } from "./seed.js";

export interface AppDeps {
  app: Fastify.FastifyInstance;
  repo: Awaited<ReturnType<typeof createRepo>>;
  engine: Engine;
  hub: EventHub;
}

/** Build and wire the full application without listening or seeding. */
export async function createApp(): Promise<AppDeps> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cors, {
    origin: env.corsOrigin.length > 0 ? env.corsOrigin : true,
    credentials: true,
    exposedHeaders: ["ETag", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
  });

  const repo = await createRepo();
  const hub = new EventHub();
  hub.startHeartbeat(15_000);
  const gateway = new LLMGateway();
  const engine = new Engine({ repo, hub, gateway });
  engine.start();

  const guards = makeGuards(repo);
  const limiter = new RateLimiter();
  const rate = makeRateLimitHooks(limiter);
  const runner = new PipelineRunner({ repo, hub, gateway });

  registerErrorHandling(app);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/health")) return;
    rate.generalByRequest(request, reply);
  });
  registerIdempotency(app, repo);

  const deps = { repo, guards, limiter, rate, hub, engine, runner, gateway };

  registerAuthRoutes(app, deps);
  registerOrgRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerExportRoutes(app, deps);
  registerShareRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerApiKeyRoutes(app, deps);
  registerHealthRoutes(app, { repo, hub, engine, startedAt: Date.now() });

  return { app, repo, engine, hub };
}

async function main(): Promise<void> {
  const { app, repo, engine, hub } = await createApp();

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received — shutting down`);
    await engine.stop().catch(() => undefined);
    hub.stopHeartbeat();
    await app.close().catch(() => undefined);
    await repo.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (err) {
    console.error("[boot] failed to start:", err);
    process.exit(1);
  }

  const health = await repo.health();
  console.log(`[boot] SpecForge API ready — http://localhost:${env.port} (db: ${repo.kind}, ${health.ok ? "healthy" : health.detail})`);
  console.log(`[boot] Web (dev): http://localhost:5173 · Demo login: demo@specforge.dev`);

  try {
    const result = await seed(repo);
    if (result.seeded) console.log("[seed] Seeded demo org 'specforge-demo' with a completed project (demo@specforge.dev).");
  } catch (err) {
    console.warn("[seed] seed skipped:", (err as Error).message);
  }
}

// Only run the server when this file is executed directly, not when imported
// (e.g. by the smoke test, which starts the app itself on port 0).
const isDirectExecution = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (isDirectExecution) {
  void main();
}
