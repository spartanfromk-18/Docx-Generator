/**
 * Process-wide singletons for the orchestration layer: SSE hub, LLM gateway,
 * rate limiter, pipeline runner and engine. Initialized once by index.ts; every
 * route imports the live `runtime` object (avoids circular imports between
 * routes ↔ pipeline ↔ realtime).
 */
import { EventHub } from "./realtime/hub.js";
import { LLMGateway } from "./llm/gateway.js";
import { RateLimiter, makeRateLimitHooks } from "./middleware/rateLimit.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { Engine } from "./pipeline/engine.js";
import { makeGuards } from "./auth/guards.js";
import { getRepo } from "./db/repo-holder.js";
import type { PipelineRunner as RunnerType } from "./pipeline/runner.js";
import type { Engine as EngineType } from "./pipeline/engine.js";

interface Runtime {
  hub: EventHub;
  gateway: LLMGateway;
  limiter: RateLimiter;
  rateLimitHooks: ReturnType<typeof makeRateLimitHooks>;
  runner: RunnerType;
  engine: EngineType;
  guards: ReturnType<typeof makeGuards>;
}

let instance: Runtime | null = null;

export function initRuntime(): Runtime {
  if (instance) return instance;
  const repo = getRepo();
  const hub = new EventHub();
  const gateway = new LLMGateway();
  const limiter = new RateLimiter();
  const runner = new PipelineRunner({ repo, hub, gateway });
  const engine = new Engine({ repo, hub, gateway });
  instance = {
    hub,
    gateway,
    limiter,
    rateLimitHooks: makeRateLimitHooks(limiter),
    runner,
    engine,
    guards: makeGuards(repo),
  };
  return instance;
}

export function runtime(): Runtime {
  if (!instance) throw new Error("Runtime not initialized — call initRuntime() at startup first.");
  return instance;
}
