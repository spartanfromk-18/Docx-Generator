import type { FastifyReply, FastifyRequest } from "fastify";
import { tooManyRequests } from "../errors.js";
import type { Plan } from "../types.js";

/**
 * TRD 2.3 rate limiting: token bucket (general API, SSE) and sliding-window
 * (run creation, source submit, login). Headers: RateLimit-Limit/Remaining/Reset.
 */

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(public capacity: number, public refillPerSec: number) {
    this.tokens = capacity;
  }
  take(cost = 1): { allowed: boolean; remaining: number; resetSec: number } {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), resetSec: 0 };
    }
    return { allowed: false, remaining: Math.floor(this.tokens), resetSec: Math.ceil((cost - this.tokens) / this.refillPerSec) };
  }
}

class SlidingWindow {
  private hits: number[] = [];
  constructor(public limit: number, public windowMs: number) {}
  hit(): { allowed: boolean; remaining: number; resetSec: number } {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0];
      return { allowed: false, remaining: 0, resetSec: Math.ceil((this.windowMs - (now - oldest)) / 1000) };
    }
    this.hits.push(now);
    return { allowed: true, remaining: this.limit - this.hits.length, resetSec: 0 };
  }
}

const PLAN_LIMITS: Record<Plan, { perMin: number; burst: number }> = {
  free: { perMin: 60, burst: 20 },
  pro: { perMin: 300, burst: 100 },
  team: { perMin: 900, burst: 300 },
  enterprise: { perMin: 900, burst: 300 },
};

const RUN_LIMITS: Record<Plan, number> = { free: 3, pro: 30, team: 120, enterprise: 120 };
const SOURCE_LIMITS: Record<Plan, number> = { free: 0, pro: 10, team: 40, enterprise: 40 };

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private windows = new Map<string, SlidingWindow>();

  private bucket(key: string, capacity: number, refillPerSec: number): TokenBucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(capacity, refillPerSec);
      this.buckets.set(key, b);
    }
    return b;
  }
  private window(key: string, limit: number, windowMs: number): SlidingWindow {
    let w = this.windows.get(key);
    if (!w) {
      w = new SlidingWindow(limit, windowMs);
      this.windows.set(key, w);
    }
    return w;
  }

  general(plan: Plan, subject: string) {
    const { perMin, burst } = PLAN_LIMITS[plan];
    return this.bucket(`general:${subject}`, burst, perMin / 60).take();
  }
  runCreation(plan: Plan, orgId: string) {
    return this.window(`runs:${orgId}`, RUN_LIMITS[plan], 3600_000).hit();
  }
  sourceSubmit(plan: Plan, orgId: string) {
    const limit = SOURCE_LIMITS[plan];
    return this.window(`sources:${orgId}`, limit, 3600_000).hit();
  }
  sourcePerHost(orgId: string, host: string) {
    return this.window(`host:${orgId}:${host}`, 2, 3600_000).hit();
  }
  sseConnect(subject: string) {
    return this.bucket(`sse:${subject}`, 30, 0.5).take();
  }
  login(ip: string, emailHash: string) {
    return this.window(`login:${ip}:${emailHash}`, 5, 600_000).hit();
  }
}

function applyHeaders(reply: FastifyReply, result: { remaining: number; resetSec: number }, limitPerMin: number): void {
  reply.header("RateLimit-Limit", String(limitPerMin));
  reply.header("RateLimit-Remaining", String(result.remaining));
  reply.header("RateLimit-Reset", String(result.resetSec));
}

interface AuthedRequest extends FastifyRequest {
  auth?: { orgId: string; userId: string | null; plan: Plan };
}

export function makeRateLimitHooks(limiter: RateLimiter) {
  /** General API limiter — attach with addHook('onRequest') after auth for authed routes. */
  function generalByRequest(request: AuthedRequest, reply: FastifyReply): void {
    const auth = request.auth;
    const subject = auth?.userId ?? (request.headers["x-forwarded-for"] as string) ?? request.ip;
    const plan = auth?.plan ?? "free";
    const res = limiter.general(plan, subject);
    applyHeaders(reply, res, PLAN_LIMITS[plan].perMin);
    if (!res.allowed) {
      throw tooManyRequests("RATE_LIMITED", "Too many requests.", res.resetSec, {
        retry_after_sec: res.resetSec,
      });
    }
  }

  function guardResult(
    reply: FastifyReply,
    result: { allowed: boolean; remaining: number; resetSec: number },
    limitPerMin: number,
    code: "RATE_LIMITED" | "CONCURRENCY_LIMIT" = "RATE_LIMITED",
  ): void {
    applyHeaders(reply, result, limitPerMin);
    if (!result.allowed) {
      throw tooManyRequests(code, "Rate limit exceeded for this operation.", result.resetSec, {
        retry_after_sec: result.resetSec,
      });
    }
  }

  return { generalByRequest, guardResult, limiter };
}
