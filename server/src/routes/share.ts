/** Share-link routes: create, revoke, and the public read-only viewer. */
import type { FastifyInstance } from "fastify";
import { createShareLinkSchema, shareUnlockSchema } from "../schemas.js";
import type { RouteDeps } from "./deps.js";
import { parseBody, requireAuth, requireRole } from "./helpers.js";
import { notFound, unprocessable, unauthorized } from "../errors.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { randomToken, sha256Hex, uuidv7, nowIso, safeEqual } from "../util.js";

/** In-memory unlock sessions for password-protected links (dev-grade). */
const UNLOCKED = new Set<string>();

export function registerShareRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate, hub, runner, gateway } = deps;
  app.post("/v1/documents/:id/share-links", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const body = parseBody(createShareLinkSchema, request.body);
    const document = await repo.getDocument(auth.orgId, id);
    if (!document) throw notFound("Document not found.");

    const token = randomToken(32);
    const row = await repo.insertShareLink({
      id: uuidv7(),
      org_id: auth.orgId,
      document_id: id,
      created_by: auth.userId,
      token_hash: sha256Hex(token),
      password_hash: body.password ? sha256Hex(body.password) : null,
      expires_at: new Date(Date.now() + body.expires_in_days * 24 * 3600 * 1000).toISOString(),
      revoked_at: null,
      view_count: 0,
      last_viewed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "share_link.created",
        resource_type: "document",
        resource_id: id,
        metadata: { expires_in_days: body.expires_in_days, password_protected: Boolean(body.password) },
      }),
    ]);
    return {
      id: row.id,
      url: `/v1/s/${token}`,
      token,
      expires_at: row.expires_at,
      password_protected: Boolean(body.password),
    };
  });

  app.delete("/v1/share-links/:id", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const ok = await repo.revokeShareLink(auth.orgId, id);
    if (!ok) throw notFound("Share link not found or already revoked.");
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "share_link.revoked",
        resource_type: "share_link",
        resource_id: id,
      }),
    ]);
    return { id, revoked: true };
  });

  // Public read-only document viewer. No auth; the token in the path IS the capability.
  app.get("/v1/s/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    if (token.length < 20 || token.length > 128) throw notFound("Share link not found.");
    const found = await repo.findShareLinkByTokenHash(sha256Hex(token));
    if (!found) throw notFound("Share link not found.");
    const { link, document } = found;
    if (new Date(link.expires_at).getTime() < Date.now()) {
      throw unprocessable("LINK_EXPIRED", "This share link has expired.");
    }

    if (link.password_hash && !UNLOCKED.has(sha256Hex(token))) {
      reply.code(401).send({
        error: {
          code: "PASSWORD_REQUIRED",
          message: "This share link is password protected.",
          details: { unlock_endpoint: `/v1/s/${token}/unlock` },
          request_id: request.id,
        },
      });
      return;
    }

    const version = await repo.getDocumentVersion(link.org_id, document.id, "current");
    await repo.touchShareView(link.org_id, link.id);
    if (!version) throw notFound("Document content unavailable.");
    return {
      title: document.title,
      doc_type: document.doc_type,
      version_no: version.version.version_no,
      sections: version.sections.map((s) => ({ heading: s.heading, body_md: s.body_md })),
      shared_at: link.created_at,
    };
  });

  app.post("/v1/s/:token/unlock", async (request) => {
    const { token } = request.params as { token: string };
    const body = parseBody(shareUnlockSchema, request.body);
    const found = await repo.findShareLinkByTokenHash(sha256Hex(token));
    if (!found) throw notFound("Share link not found.");
    if (!found.link.password_hash) return { unlocked: true };
    if (!safeEqual(sha256Hex(body.password), found.link.password_hash)) {
      throw unauthorized("WRONG_PASSWORD", "Incorrect password for this share link.");
    }
    UNLOCKED.add(sha256Hex(token));
    setTimeout(() => UNLOCKED.delete(sha256Hex(token)), 24 * 3600 * 1000).unref?.();
    return { unlocked: true };
  });
}
