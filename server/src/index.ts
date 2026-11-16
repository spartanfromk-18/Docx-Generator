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

async function main(): Promise<void> {
  const startedAt = Date.now();
  const app = Fastify({
    logger: env.nodeEnv === "development"
      ? { level: "info", transport: undefined } // JSON logs (TRD 2.5); pretty only when asked
      : { level: "info" },
    bodyLimit: 1_500_000,
    genReqId: () => cryptoRandomId(),
    requestIdHeader: "x-request-id",
  });

  await app.register(cors, {
    origin: env.corsOrigin,
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  registerErrorHandling(app);
  registerIdempotency(app, repo);

  const deps = { repo, guards, limiter, rate, hub, engine };
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
  registerHealthRoutes(app, { repo, hub, engine, startedAt });

  // Graceful drain: workers finish the current stage or release the lease (TRD 2.5).
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "draining");
    await engine.stop();
    hub.stopHeartbeat();
    await app.close();
    await repo.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (err) {
    app.log.error(err, "failed to start");
    process.exit(1);
  }

  const health = await repo.health();
  app.log.info(`SpecForge API ready — http://localhost:${env.port} (db: ${repo.kind}, ${health.ok ? "healthy" : health.detail})`);
  app.log.info(`Web (dev): http://localhost:5173 · Demo login: demo@specforge.dev`);

  try {
    const result = await seed(repo);
    if (result.seeded) app.log.info("Seeded demo org 'Acme Labs' with a completed project (demo@specforge.dev).");
  } catch (err) {
    app.log.warn({ err }, "seed skipped");
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

void main();
