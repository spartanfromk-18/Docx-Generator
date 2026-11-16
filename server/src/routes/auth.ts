/** Auth routes: dev-login, refresh, org switch, me, JWKS. */
import type { FastifyInstance } from "fastify";
import { getJwks, signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/keys.js";
import { scopesForRole } from "../auth/guards.js";
import { devLoginSchema, refreshSchema, switchOrgSchema } from "../schemas.js";
import { parseBody, requireAuth } from "./helpers.js";
import { forbidden, unauthorized, notFound } from "../errors.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { uuidv7, nowIso, hostOf } from "../util.js";
import type { RouteDeps } from "./deps.js";

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate } = deps;
  /**
   * Development login — auto-verifies email (risk_score 0) and grants the 3-credit
   * free tier exactly once (ledger key `free:<user_id>`).
   */
  app.post("/v1/auth/dev-login", async (request, reply) => {
    const body = parseBody(devLoginSchema, request.body);
    const devLoginEnabled = process.env.NODE_ENV !== "production" || process.env.SPECFORGE_ENABLE_DEV_LOGIN === "1";
    if (!devLoginEnabled) throw forbidden("DEV_LOGIN_DISABLED", "Development login is disabled in production.");

    // Brute-force guard: 5 attempts per (ip, email) per 10 minutes.
    const emailHash = Buffer.from(body.email).toString("base64url").slice(0, 16);
    rate.guardResult(reply, limiter.login(request.ip, emailHash), 30);

    let user = await repo.findUserByEmail(body.email);
    if (!user) {
      user = await repo.insertUser({
        id: uuidv7(),
        email: body.email,
        email_verified_at: nowIso(),
        display_name: body.display_name ?? body.email.split("@")[0],
        idp_subject: `dev:${body.email}`,
        locale: "en",
        risk_score: 0,
        free_credits_granted_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      });
    }
    let orgs = await repo.listOrgsForUser(user.id);
    if (orgs.length === 0) {
      const base = body.display_name ? `${body.display_name}'s Workspace` : `${user.email.split("@")[0]}-workspace`;
      let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "workspace";
      if (await repo.findOrgBySlug(slug)) slug = `${slug}-${user.id.slice(0, 6)}`;
      const org = await repo.createOrgWithOwner(
        { id: uuidv7(), name: base, slug, plan: "free", data_region: "us", is_personal: true },
        user.id,
      );
      orgs = [{ org, role: "owner" }];
    }
    const { org, role } = orgs[0];

    // Exactly-once free signup grant (3 credits) — the ledger key enforces uniqueness.
    const fresh = await repo.findUserById(user.id);
    if (fresh && !fresh.free_credits_granted_at) {
      const granted = await repo.grantCredits(org.id, 3, `free:${user.id}`, { reason: "signup_grant", user_id: user.id });
      if (granted) await repo.updateRunSystem(`noop-${user.id}`, {}).catch(() => undefined);
    }

    const scopes = scopesForRole(role);
    const { token: accessToken } = await signAccessToken({ sub: user.id, org: org.id, role, plan: org.plan, scope: scopes.join(" "), email: user.email });
    const refreshToken = await signRefreshToken(user.id, org.id);
    await writeAudit(repo, [
      auditEntry({
        org_id: org.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "auth.dev_login",
        resource_type: "user",
        resource_id: user.id,
        ip: request.ip,
        user_agent: request.headers["user-agent"] ?? null,
        metadata: { host: hostOf(request.headers.host ?? "") },
      }),
    ]);

    reply.code(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 900,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      org: { id: org.id, name: org.name, slug: org.slug, plan: org.plan, role },
      orgs: orgs.map((o) => ({ id: o.org.id, name: o.org.name, slug: o.org.slug, plan: o.org.plan, role: o.role })),
    });
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const body = parseBody(refreshSchema, request.body);
    const claims = await verifyRefreshToken(body.refresh_token);
    const user = await repo.findUserById(claims.sub);
    if (!user || user.deleted_at) throw unauthorized("USER_NOT_FOUND", "User no longer exists.");
    let orgs = await repo.listOrgsForUser(user.id);
    if (orgs.length === 0) throw notFound("User has no organizations.");
    const current = orgs.find((o) => o.org.id === claims.org) ?? orgs[0];
    const scopes = scopesForRole(current.role);
    const { token: accessToken } = await signAccessToken({
      sub: user.id,
      org: current.org.id,
      role: current.role,
      plan: current.org.plan,
      scope: scopes.join(" "),
      email: user.email,
    });
    const refreshToken = await signRefreshToken(user.id, current.org.id);
    reply.send({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 900,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      org: { id: current.org.id, name: current.org.name, slug: current.org.slug, plan: current.org.plan, role: current.role },
      orgs: orgs.map((o) => ({ id: o.org.id, name: o.org.name, slug: o.org.slug, plan: o.org.plan, role: o.role })),
    });
  });

  app.post("/v1/auth/switch-org", async (request, reply) => {
    const auth = await requireAuth(deps, request);
    if (!auth.userId) throw unauthorized("USER_REQUIRED", "Organization switching requires user authentication.");
    const body = parseBody(switchOrgSchema, request.body);
    const membership = await repo.findMembership(body.org_id, auth.userId);
    if (!membership) throw forbidden("NOT_A_MEMBER", "You are not a member of that organization.");
    const org = await repo.findOrgById(body.org_id);
    if (!org || org.deleted_at) throw notFound("Organization not found.");
    const user = await repo.findUserById(auth.userId);
    if (!user) throw unauthorized();
    const orgs = await repo.listOrgsForUser(user.id);
    const scopes = scopesForRole(membership.role);
    const { token: accessToken } = await signAccessToken({
      sub: user.id,
      org: org.id,
      role: membership.role,
      plan: org.plan,
      scope: scopes.join(" "),
      email: user.email,
    });
    const refreshToken = await signRefreshToken(user.id, org.id);
    reply.send({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 900,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      org: { id: org.id, name: org.name, slug: org.slug, plan: org.plan, role: membership.role },
      orgs: orgs.map((o) => ({ id: o.org.id, name: o.org.name, slug: o.org.slug, plan: o.org.plan, role: o.role })),
    });
  });

  app.get("/v1/me", async (request, reply) => {
    const auth = await requireAuth(deps, request);
    if (!auth.userId) {
      reply.send({
        id: null,
        email: null,
        org: { id: auth.orgId, plan: auth.plan, role: auth.role },
        scopes: auth.scopes,
        via: auth.via,
      });
      return;
    }
    const user = await repo.findUserById(auth.userId);
    if (!user) throw unauthorized();
    const orgs = await repo.listOrgsForUser(user.id);
    const current = orgs.find((o) => o.org.id === auth.orgId);
    const account = await repo.getCreditAccount(auth.orgId);
    reply.send({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      locale: user.locale,
      risk_score: user.risk_score,
      created_at: user.created_at,
      org: current ? { id: current.org.id, name: current.org.name, slug: current.org.slug, plan: current.org.plan, role: current.role } : null,
      orgs: orgs.map((o) => ({ id: o.org.id, name: o.org.name, slug: o.org.slug, plan: o.org.plan, role: o.role })),
      credits: {
        balance: account.balance,
        reserved: account.reserved,
        available: Math.round((account.balance - account.reserved) * 100) / 100,
      },
      scopes: auth.scopes,
      via: auth.via,
    });
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(await getJwks());
  });
}
