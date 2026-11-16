/** Shared route helpers: validation, auth bridge, ETag/304. */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import type { RouteDeps } from "./deps.js";
import type { AuthContext, Role } from "../types.js";
import { createHash } from "node:crypto";

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const res = schema.safeParse(body ?? {});
  if (!res.success) {
    throw badRequest("VALIDATION_FAILED", "Request body failed validation.", {
      fields: res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return res.data;
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  return parseBody(schema, request.query);
}

/**
 * Authenticate the request (Bearer JWT or API key) and attach request.auth.
 * Also accepts ?access_token= for EventSource (SSE cannot send headers).
 */
export async function requireAuth(deps: RouteDeps, request: FastifyRequest): Promise<AuthContext> {
  if (!request.auth && typeof request.query === "object" && request.query !== null) {
    const qs = request.query as { access_token?: string };
    if (qs.access_token && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${qs.access_token}`;
    }
  }
  return deps.guards.authenticate(request);
}

const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/** Synchronous role gate on an already-resolved AuthContext. */
export function requireRole(ctx: AuthContext, min: Role): void {
  if (ROLE_RANK[ctx.role] < ROLE_RANK[min]) {
    throw forbidden("ROLE_REQUIRED", `This action requires the ${min} role (you have ${ctx.role}).`);
  }
}

/** Scope gate for API-key callers (JWT users carry their role's scopes). */
export function requireScope(ctx: AuthContext, scope: string): void {
  if (ctx.via === "jwt") return;
  if (!ctx.scopes.includes(scope)) {
    throw forbidden("SCOPE_REQUIRED", `This action requires the ${scope} scope.`);
  }
}

/** SHA-256 strong ETag for GET payloads + 304 short-circuit. */
export function sendWithEtag(reply: FastifyReply, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const ifNoneMatch = extraHeaders["if-none-match"] ?? (reply.request.headers["if-none-match"] as string | undefined);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (k !== "if-none-match") reply.header(k, v);
  }
  reply.header("ETag", etag);
  reply.header("Cache-Control", "private, no-cache");
  if (ifNoneMatch && ifNoneMatch === etag) {
    reply.code(304).send();
    return;
  }
  reply.send(payload);
}
