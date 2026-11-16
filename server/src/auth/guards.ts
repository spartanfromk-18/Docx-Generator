import type { FastifyReply, FastifyRequest } from "fastify";
import { sha256Hex } from "../util.js";
import { forbidden, paymentRequired, unauthorized } from "../errors.js";
import type { AuthContext, Plan, Role } from "../types.js";
import { verifyAccessToken } from "./keys.js";
import type { Repo } from "../db/repo.js";

/** TRD 2.4/2.6: Bearer JWT or API key (sf_live_<prefix>_<secret>), scopes + roles + plan gates. */

export const READ_SCOPES = ["projects:read", "runs:read", "documents:read", "sources:read", "exports:read", "billing:read"] as const;
export const WRITE_SCOPES = [
  "projects:write", "runs:write", "documents:write", "sources:write",
  "exports:write", "shares:write", "billing:write", "keys:write",
] as const;

export function scopesForRole(role: Role): string[] {
  switch (role) {
    case "owner":
      return [...READ_SCOPES, ...WRITE_SCOPES];
    case "admin":
      return [...READ_SCOPES, ...WRITE_SCOPES].filter((s) => s !== "billing:write");
    case "editor":
      return [...READ_SCOPES, "projects:write", "runs:write", "documents:write", "sources:write", "exports:write", "shares:write", "keys:write"];
    case "viewer":
      return [...READ_SCOPES];
  }
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  // format: sf_live_<prefix>_<secret>
  const m = /^sf_live_([a-z0-9]{8,16})_([A-Za-z0-9]{24,64})$/.exec(raw);
  if (!m) return null;
  return { prefix: m[1], secret: m[2] };
}

export function apiKeySecretHash(secret: string): string {
  return sha256Hex(secret);
}

interface RequestLike extends FastifyRequest {
  auth?: AuthContext;
}

export function makeGuards(repo: Repo) {
  async function authenticate(request: RequestLike): Promise<AuthContext> {
    if (request.auth) return request.auth;
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw unauthorized();

    // --- API key path ---
    if (token.startsWith("sf_live_")) {
      const parsed = parseApiKey(token);
      if (!parsed) throw unauthorized("UNAUTHENTICATED", "Malformed API key.");
      const key = await repo.findApiKeyByPrefix(parsed.prefix);
      if (!key) throw unauthorized("UNAUTHENTICATED", "Unknown API key.");
      const org = await repo.findOrgById(key.org_id);
      if (!org) throw forbidden("FORBIDDEN", "Organization unavailable.");
      // constant-time hash compare
      if (apiKeySecretHash(parsed.secret) !== key.secret_hash) {
        throw unauthorized("UNAUTHENTICATED", "Invalid API key.");
      }
      if (key.expires_at && new Date(key.expires_at) < new Date()) {
        throw unauthorized("TOKEN_EXPIRED", "API key expired.");
      }
      await repo.touchApiKey(key.id);
      request.auth = {
        userId: key.created_by,
        orgId: key.org_id,
        role: "editor",
        plan: org.plan,
        scopes: key.scopes,
        via: "api_key",
        apiKeyId: key.id,
      };
      return request.auth;
    }

    // --- JWT path ---
    const claims = await verifyAccessToken(token);
    const membership = await repo.findMembership(claims.org, claims.sub);
    const org = await repo.findOrgById(claims.org);
    if (!membership || !org) throw forbidden("FORBIDDEN", "Membership not found for organization.");
    const user = await repo.findUserById(claims.sub);
    if (!user || user.deleted_at) throw forbidden("FORBIDDEN", "Account unavailable.");
    request.auth = {
      userId: claims.sub,
      orgId: claims.org,
      role: membership.role,
      plan: org.plan,
      scopes: scopesForRole(membership.role),
      via: "jwt",
      email: user.email,
    };
    return request.auth;
  }

  function requireAuth() {
    return async (request: RequestLike, _reply: FastifyReply) => {
      await authenticate(request);
    };
  }

  function requireScope(...needed: string[]) {
    return async (request: RequestLike, _reply: FastifyReply) => {
      const auth = await authenticate(request);
      const missing = needed.filter((s) => !auth.scopes.includes(s));
      if (missing.length > 0) throw forbidden("FORBIDDEN", `Missing scope: ${missing.join(", ")}`);
    };
  }

  /** ABAC plan gate (Reference Mode requires Pro or above) — 402 per TRD. */
  function requirePlan(...allowed: Plan[]) {
    return async (request: RequestLike, _reply: FastifyReply) => {
      const auth = await authenticate(request);
      if (!allowed.includes(auth.plan)) {
        throw paymentRequired(
          "PLAN_FEATURE_REQUIRED",
          "This feature requires an upgrade.",
          { required_plan: allowed },
        );
      }
    };
  }

  function requireRole(min: Role | "billing") {
    const rank: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };
    return async (request: RequestLike, _reply: FastifyReply) => {
      const auth = await authenticate(request);
      if (min === "billing" ? auth.role !== "owner" : rank[auth.role] < rank[min as Role]) {
        throw forbidden();
      }
    };
  }

  return { authenticate, requireAuth, requireScope, requirePlan, requireRole };
}
