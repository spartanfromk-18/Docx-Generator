/** Document routes: read (ETag), versions, new version (optimistic lock), section regeneration. */
import type { FastifyInstance } from "fastify";
import { createVersionSchema, regenerateSectionSchema } from "../schemas.js";
import type { RouteDeps } from "./deps.js";
import { parseBody, requireAuth, requireRole, sendWithEtag } from "./helpers.js";
import { notFound, conflict, unprocessable, paymentRequired } from "../errors.js";
import { SECTION_REGEN_COST } from "../services/credits.js";
import { writeAudit, auditEntry } from "../services/audit.js";
import { InsufficientCredits } from "../db/repo.js";
import { DOC_OUTPUT_SCHEMA, buildMockContext } from "../pipeline/stages.js";
import { uuidv7 } from "../util.js";

export function registerDocumentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate, hub, runner, gateway } = deps;
  app.get("/v1/documents/:id", async (request, reply) => {
    const auth = await requireAuth(deps, request);
    const { id } = request.params as { id: string };
    const document = await repo.getDocument(auth.orgId, id);
    if (!document) throw notFound("Document not found.");
    const result = await repo.getDocumentVersion(auth.orgId, id, "current");
    if (!result) throw notFound("Document has no versions.");
    sendWithEtag(reply, { document, version: result.version, sections: result.sections });
  });

  app.get("/v1/documents/:id/versions", async (request) => {
    const auth = await requireAuth(deps, request);
    const { id } = request.params as { id: string };
    const document = await repo.getDocument(auth.orgId, id);
    if (!document) throw notFound("Document not found.");
    const versions = await repo.listVersions(auth.orgId, id);
    return { items: versions };
  });

  app.get("/v1/documents/:id/versions/:n", async (request) => {
    const auth = await requireAuth(deps, request);
    const { id, n } = request.params as { id: string; n: string };
    const document = await repo.getDocument(auth.orgId, id);
    if (!document) throw notFound("Document not found.");
    const versionNo = n === "current" ? ("current" as const) : Number(n);
    if (versionNo !== "current" && (!Number.isInteger(versionNo) || versionNo < 1)) {
      throw unprocessable("BAD_VERSION", "Version number must be a positive integer or 'current'.");
    }
    const result = await repo.getDocumentVersion(auth.orgId, id, versionNo);
    if (!result) throw notFound("Version not found.");
    return { document, version: result.version, sections: result.sections };
  });

  app.post("/v1/documents/:id/versions", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const body = parseBody(createVersionSchema, request.body);
    const document = await repo.getDocument(auth.orgId, id);
    if (!document) throw notFound("Document not found.");

    const edits = new Map(body.sections.map((s) => [s.id, s.body_md]));
    const outcome = await repo.createNewVersion(auth.orgId, id, body.base_version_no, edits, {
      changeNote: body.change_note ?? "Edited via UI",
      authorId: auth.userId,
      authorType: "user",
    });
    if (outcome === "CONFLICT") {
      throw conflict("VERSION_CONFLICT", "The document changed since you loaded it; reload and reapply your edits.", {
        base_version_no: body.base_version_no,
      });
    }
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: auth.via === "api_key" ? "api_key" : "user",
        action: "document.version_created",
        resource_type: "document",
        resource_id: id,
        metadata: { version_no: outcome.version.version_no, sections: body.sections.length },
      }),
    ]);
    return { document, version: outcome.version, sections: outcome.sections };
  });

  app.post("/v1/documents/:id/sections/:sid/regenerate", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id, sid } = request.params as { id: string; sid: string };
    const body = parseBody(regenerateSectionSchema, request.body);

    // Charge 0.25 credits up front; refunded if generation fails.
    try {
      await repo.reserveCredits(auth.orgId, SECTION_REGEN_COST);
    } catch (err) {
      if (err instanceof InsufficientCredits) {
        throw paymentRequired("INSUFFICIENT_CREDITS", err.message, {
          required: err.required,
          available: err.available,
          cost: SECTION_REGEN_COST,
        });
      }
      throw err;
    }

    const found = await repo.getSectionWithDocument(auth.orgId, sid);
    if (!found || found.document.id !== id) {
      await repo.releaseCredits(auth.orgId, null, SECTION_REGEN_COST, `regen-refund:${sid}:${Date.now()}`);
      throw notFound("Section not found in this document.");
    }

    try {
      const project = await repo.getProject(auth.orgId, found.document.project_id);
      const document_ = found.document;
      // Deterministic regeneration through the gateway mock path (schema-validated).
      const docType = document_.doc_type === "CUSTOM" ? "PRD" : document_.doc_type;
      const stage = docType === "UIUX" ? "UX" : docType;
      const instruction = body.instruction ?? "Improve this section: sharper specifics, measurable criteria, consistent terminology.";
      const mockRun = {
        id: uuidv7(),
        org_id: auth.orgId,
        project_id: document_.project_id,
        source_id: null,
        created_by: auth.userId,
        mode: "idea" as const,
        status: "running" as const,
        input: {
          idea: `Rewrite the section "${found.section.heading}" of ${document_.title}. Instruction: ${instruction}`,
          redacted_idea: `Rewrite the section "${found.section.heading}" of ${document_.title}. Instruction: ${instruction}`,
          intake: {},
          redactions: [],
          documents: [docType],
        },
        language: "en",
        doc_types: [docType],
        glossary: {
          canonical: {},
          entities: [{ name: project?.name ?? "Project", definition: `The subject project of ${document_.title}.` }],
        },
        credit_cost: SECTION_REGEN_COST,
        credits_reserved: SECTION_REGEN_COST,
        credits_settled: 0,
        max_input_tokens: 20_000,
        max_output_tokens: 12_000,
        max_repair_attempts: 1,
        tokens_in: 0,
        tokens_out: 0,
        llm_calls: 0,
        injection_suspected: false,
        cancel_requested_at: null,
        error_code: null,
        started_at: null,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        consistency: null,
      };
      const regenerated = await gateway.generateStructured({
        run: mockRun,
        stage,
        schema: DOC_OUTPUT_SCHEMA,
        mock: buildMockContext(mockRun, null),
        prompt: {
          system: "You rewrite a single specification section. Respond with JSON {\"title\": string, \"sections\": [{\"heading\": string, \"body_md\": string}]} containing exactly one section.",
          user: `Rewrite the section "${found.section.heading}" of the ${docType} document "${document_.title}". Instruction: ${instruction}`,
          maxTokens: 2000,
        },
        json: true,
      });
      const newBody = regenerated.data.sections[0]?.body_md ?? found.section.body_md;

      const outcome = await repo.createNewVersion(auth.orgId, id, found.version.version_no, new Map([[found.section.id, newBody]]), {
        changeNote: `AI regeneration of “${found.section.heading}” (${SECTION_REGEN_COST} credits)`,
        authorId: auth.userId,
        authorType: "ai",
        model: regenerated.model,
        ledger: { amount: SECTION_REGEN_COST, ledger_key: `regen:${found.section.id}:${Date.now()}` },
      });
      if (outcome === "CONFLICT") {
        await repo.releaseCredits(auth.orgId, null, SECTION_REGEN_COST, `regen-refund:${sid}:${Date.now()}`);
        throw conflict("VERSION_CONFLICT", "The document changed during regeneration; credits were refunded.");
      }
      hub.publish(document_.run_id ?? document_.id, "section.completed", {
        document: docType,
        section_id: found.section.id,
        heading: found.section.heading,
        regenerated: true,
      });
      await writeAudit(repo, [
        auditEntry({
          org_id: auth.orgId,
          actor_user_id: auth.userId,
          actor_type: "user",
          action: "document.section_regenerated",
          resource_type: "document",
          resource_id: id,
          metadata: { section_id: sid, cost: SECTION_REGEN_COST },
        }),
      ]);
      return {
        section: outcome.sections.find((s) => s.id === found.section.id) ?? outcome.sections[0],
        version_no: outcome.version.version_no,
        credits_charged: SECTION_REGEN_COST,
      };
    } catch (err) {
      if ((err as Error).name === "ApiError") throw err; // conflict path already refunded
      await repo.releaseCredits(auth.orgId, null, SECTION_REGEN_COST, `regen-refund:${sid}:${Date.now()}`);
      throw err;
    }
  });
}
