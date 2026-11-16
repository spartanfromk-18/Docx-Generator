/** Project routes with keyset pagination and ETag support. */
import type { FastifyInstance } from "fastify";
import { repo } from "../db/repo-holder.js";
import { createProjectSchema, updateProjectSchema, listProjectsQuery } from "../schemas.js";
import { parseBody, parseQuery, requireAuth, requireRole, sendWithEtag } from "./helpers.js";
import { notFound } from "../errors.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { uuidv7 } from "../util.js";

export function registerProjectRoutes(app: FastifyInstance): void {
  app.post("/v1/projects", async (request, reply) => {
    const auth = await requireAuth(request);
    requireRole(auth, "editor");
    const body = parseBody(createProjectSchema, request.body);
    const project = await repo.insertProject({
      id: uuidv7(),
      org_id: auth.orgId,
      created_by: auth.userId,
      name: body.name,
      description: body.description ?? null,
      idea_text: body.idea_text ?? null,
      language: body.language,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: auth.via === "api_key" ? "api_key" : "user",
        action: "project.created",
        resource_type: "project",
        resource_id: project.id,
        ip: request.ip,
        user_agent: request.headers["user-agent"] ?? null,
        metadata: { name: project.name },
      }),
    ]);
    reply.code(201).send(project);
  });

  app.get("/v1/projects", async (request) => {
    const auth = await requireAuth(request);
    const query = parseQuery(listProjectsQuery, request);
    const { items, nextCursor } = await repo.listProjects(auth.orgId, {
      q: query.q,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    const summaries = await repo.projectSummaries(
      auth.orgId,
      items.map((p) => p.id),
    );
    return {
      items: items.map((p) => ({
        ...p,
        documents_count: summaries.get(p.id)?.documents_count ?? 0,
        latest_run: summaries.get(p.id)?.latest_run ?? null,
      })),
      next_cursor: nextCursor,
    };
  });

  app.get("/v1/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    const { id } = request.params as { id: string };
    const project = await repo.getProject(auth.orgId, id);
    if (!project) throw notFound("Project not found.");
    const documents = await repo.listDocumentsByProject(auth.orgId, id);
    const runs = await repo.listRunsByProject(auth.orgId, id, 10);
    const sources = await repo.listSourcesByProject(auth.orgId, id);
    sendWithEtag(reply, { project, documents, runs, sources });
  });

  app.patch("/v1/projects/:id", async (request) => {
    const auth = await requireAuth(request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const body = parseBody(updateProjectSchema, request.body);
    const updated = await repo.updateProject(auth.orgId, id, body);
    if (!updated) throw notFound("Project not found.");
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: auth.via === "api_key" ? "api_key" : "user",
        action: "project.updated",
        resource_type: "project",
        resource_id: id,
        metadata: { fields: Object.keys(body) },
      }),
    ]);
    return updated;
  });

  app.delete("/v1/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    requireRole(auth, "admin");
    const { id } = request.params as { id: string };
    const ok = await repo.softDeleteProject(auth.orgId, id);
    if (!ok) throw notFound("Project not found.");
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "project.deleted",
        resource_type: "project",
        resource_id: id,
      }),
    ]);
    reply.code(204).send();
  });
}
