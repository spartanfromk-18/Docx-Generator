/** API-key management: create (secret shown once), list, revoke. */
import type { FastifyInstance } from "fastify";
import { repo } from "../db/repo-holder.js";
import { createApiKeySchema } from "../schemas.js";
import { parseBody, requireAuth, requireRole } from "./helpers.js";
import { notFound } from "../errors.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { randomHex, sha256Hex, uuidv7, nowIso } from "../util.js";

export function registerApiKeyRoutes(app: FastifyInstance): void {
  app.post("/v1/api-keys", async (request, reply) => {
    const auth = await requireAuth(request);
    requireRole(auth, "admin");
    const body = parseBody(createApiKeySchema, request.body);
    const prefix = randomHex(8);
    const secret = `sk${randomHex(16)}`;
    const key = await repo.insertApiKey({
      id: uuidv7(),
      org_id: auth.orgId,
      created_by: auth.userId,
      name: body.name,
      prefix,
      secret_hash: sha256Hex(secret),
      scopes: body.scopes,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "api_key.created",
        resource_type: "api_key",
        resource_id: key.id,
        metadata: { name: body.name, scopes: body.scopes },
      }),
    ]);
    reply.code(201).send({
      id: key.id,
      name: key.name,
      prefix,
      scopes: key.scopes,
      key: `sf_live_${prefix}_${secret}`, // shown exactly once
      created_at: key.created_at,
    });
  });

  app.get("/v1/api-keys", async (request) => {
    const auth = await requireAuth(request);
    const keys = await repo.listApiKeys(auth.orgId);
    return {
      items: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    };
  });

  app.delete("/v1/api-keys/:id", async (request) => {
    const auth = await requireAuth(request);
    requireRole(auth, "admin");
    const { id } = request.params as { id: string };
    const ok = await repo.revokeApiKey(auth.orgId, id);
    if (!ok) throw notFound("API key not found or already revoked.");
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "api_key.revoked",
        resource_type: "api_key",
        resource_id: id,
      }),
    ]);
    return { id, revoked: true };
  });
}
