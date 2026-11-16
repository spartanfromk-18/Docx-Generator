/** Reference-mode source routes: create (202), preview, confirm. */
import type { FastifyInstance } from "fastify";
import { createSourceSchema } from "../schemas.js";
import type { RouteDeps } from "./deps.js";
import { parseBody, requireAuth, requireRole } from "./helpers.js";
import { notFound, unprocessable, badRequest, ApiError } from "../errors.js";
import { assertPublicUrl } from "../crawl/urlGuard.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { uuidv7, nowIso } from "../util.js";

export function registerSourceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate, hub, runner, gateway } = deps;
  app.post("/v1/projects/:id/sources", async (request, reply) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const project = await repo.getProject(auth.orgId, id);
    if (!project) throw notFound("Project not found.");
    const body = parseBody(createSourceSchema, request.body);

    // SSRF validation happens before any row is written or any fetch is made.
    let guarded;
    try {
      guarded = await assertPublicUrl(body.url);
    } catch (err) {
      if (err instanceof ApiError) throw badRequest(err.code, err.message, err.details);
      throw err;
    }

    // Per-plan + per-host crawl limits (TRD 2.3).
    rate.guardResult(reply, limiter.sourceSubmit(auth.plan, auth.orgId), 10);
    rate.guardResult(reply, limiter.sourcePerHost(auth.orgId, guarded.host), 2);

    const source = await repo.insertSource({
      id: uuidv7(),
      org_id: auth.orgId,
      project_id: id,
      url: guarded.url,
      host: guarded.host,
      status: "crawling",
      failure_code: null,
      attested_by: auth.userId,
      attested_at: nowIso(),
      max_pages: body.max_pages,
      stats: {},
      crawl_started_at: nowIso(),
      crawl_finished_at: null,
      confirmed_at: null,
      reuse_until: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "source.created",
        resource_type: "source",
        resource_id: source.id,
        metadata: { url: source.url, max_pages: source.max_pages, attested: true },
      }),
    ]);
    reply.code(202).send({
      id: source.id,
      status: source.status,
      url: source.url,
      host: source.host,
      max_pages: source.max_pages,
      message: "Crawl queued. Poll GET /v1/sources/:id for the preview.",
    });
  });

  app.get("/v1/sources/:id", async (request) => {
    const auth = await requireAuth(deps, request);
    const { id } = request.params as { id: string };
    const source = await repo.getSource(auth.orgId, id);
    if (!source) throw notFound("Source not found.");
    const pages = await repo.listCrawlPages(auth.orgId, id);
    const extraction = await repo.getDesignExtraction(auth.orgId, id);
    return {
      source,
      pages: pages.map((p) => ({
        id: p.id,
        url: p.url,
        depth: p.depth,
        state: p.state,
        skip_reason: p.skip_reason,
        http_status: p.http_status,
        title: p.title,
        template_cluster: p.template_cluster,
      })),
      extraction,
    };
  });

  app.post("/v1/sources/:id/confirm", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    parseBody((await import("../schemas.js")).confirmSourceSchema, request.body);
    const source = await repo.getSource(auth.orgId, id);
    if (!source) throw notFound("Source not found.");
    if (source.status !== "preview_ready") {
      throw unprocessable("SOURCE_NOT_READY", `Source is ${source.status}; confirm is only possible when preview_ready.`);
    }
    const updated = await repo.updateSource(auth.orgId, id, {
      status: "confirmed",
      confirmed_at: nowIso(),
      reuse_until: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    });
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "source.confirmed",
        resource_type: "source",
        resource_id: id,
        metadata: { host: source.host },
      }),
    ]);
    return updated;
  });
}
