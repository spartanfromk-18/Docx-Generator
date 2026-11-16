/** Organization routes. */
import type { FastifyInstance } from "fastify";
import { repo } from "../db/repo-holder.js";
import { createOrgSchema } from "../schemas.js";
import { parseBody, requireAuth } from "./helpers.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { uuidv7 } from "../util.js";

export function registerOrgRoutes(app: FastifyInstance): void {
  app.post("/v1/orgs", async (request) => {
    const auth = await requireAuth(request);
    if (!auth.userId) throw new (await import("../errors.js")).ApiError(401, "USER_REQUIRED", "Create organizations as a signed-in user.");
    const body = parseBody(createOrgSchema, request.body);
    let slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "org";
    if (await repo.findOrgBySlug(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const org = await repo.createOrgWithOwner(
      { id: uuidv7(), name: body.name, slug, plan: "free", data_region: "us", is_personal: false },
      auth.userId,
    );
    await writeAudit(repo, [
      auditEntry({
        org_id: org.id,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "org.created",
        resource_type: "org",
        resource_id: org.id,
        ip: request.ip,
        user_agent: request.headers["user-agent"] ?? null,
        metadata: { slug: org.slug },
      }),
    ]);
    return { id: org.id, name: org.name, slug: org.slug, plan: org.plan, role: "owner" };
  });

  app.get("/v1/orgs", async (request) => {
    const auth = await requireAuth(request);
    if (!auth.userId) return { items: [] };
    const orgs = await repo.listOrgsForUser(auth.userId);
    const members = await Promise.all(orgs.map(async (o) => ({ ...o, members: (await repo.listMembers(o.org.id)).length })));
    return {
      items: members.map((o) => ({
        id: o.org.id,
        name: o.org.name,
        slug: o.org.slug,
        plan: o.org.plan,
        role: o.role,
        members: o.members,
        created_at: o.org.created_at,
      })),
    };
  });

  app.get("/v1/orgs/:id/members", async (request) => {
    const auth = await requireAuth(request);
    const { id } = request.params as { id: string };
    if (id !== auth.orgId) throw new (await import("../errors.js")).ApiError(403, "ORG_MISMATCH", "Organization mismatch.");
    const members = await repo.listMembers(auth.orgId);
    return {
      items: members.map((m) => ({
        id: m.membership.id,
        user_id: m.user.id,
        email: m.user.email,
        display_name: m.user.display_name,
        role: m.membership.role,
        joined_at: m.membership.created_at,
      })),
    };
  });
}
