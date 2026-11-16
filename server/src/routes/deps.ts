/** Shared route dependencies injected by index.ts (keeps routes testable, no singletons). */
import type { EventHub } from "../realtime/hub.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { Engine } from "../pipeline/engine.js";
import type { RateLimiter, makeRateLimitHooks } from "../middleware/rateLimit.js";
import type { makeGuards } from "../auth/guards.js";
import type { LLMGateway } from "../llm/gateway.js";
import type { Repo } from "../db/repo.js";
import type { AuthContext } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface RouteDeps {
  repo: Repo;
  guards: ReturnType<typeof makeGuards>;
  limiter: RateLimiter;
  rate: ReturnType<typeof makeRateLimitHooks>;
  hub: EventHub;
  engine: Engine;
  runner: PipelineRunner;
  gateway: LLMGateway;
}

export interface HealthDeps {
  repo: Repo;
  hub: EventHub;
  engine: Engine;
  startedAt: number;
}
