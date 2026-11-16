/** Run routes: create (202 with credit reservation), status, SSE, cancel, retry. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRunSchema } from "../schemas.js";
import type { RouteDeps } from "./deps.js";
import { parseBody, requireAuth, requireRole } from "./helpers.js";
import { notFound, unprocessable, tooManyRequests, badRequest } from "../errors.js";
import { CONCURRENT_RUN_LIMITS, plannedStages, runCost, STAGE_COSTS } from "../services/credits.js";
import { writeAudit, auditEntry, emitEvents, outboxEvent } from "../services/audit.js";
import { plannedStageRow } from "./runHelpers.js";
import { STAGE_ORDER } from "../pipeline/stages.js";
import { InsufficientCredits } from "../db/repo.js";
import { uuidv7, nowIso } from "../util.js";
import type { RunRow, StageName } from "../types.js";

export function registerRunRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repo, limiter, rate, hub, runner, gateway } = deps;
  app.post("/v1/projects/:id/runs", async (request, reply) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const project = await repo.getProject(auth.orgId, id);
    if (!project) throw notFound("Project not found.");
    const body = parseBody(createRunSchema, request.body);

    if (body.mode === "idea" && !body.idea && !project.idea_text) {
      throw unprocessable("IDEA_REQUIRED", "Provide an idea (body.idea) for Idea Mode runs.");
    }
    if (body.mode === "reference") {
      if (!body.source_id) throw unprocessable("SOURCE_REQUIRED", "Reference Mode requires source_id.");
      const source = await repo.getSource(auth.orgId, body.source_id);
      if (!source) throw notFound("Source not found.");
      if (source.status !== "confirmed") {
        throw unprocessable("SOURCE_NOT_CONFIRMED", "Confirm the crawl preview before running Reference Mode.");
      }
    }

    // Sliding-window run creation limit per plan (TRD 2.3).
    rate.guardResult(reply, limiter.runCreation(auth.plan, auth.orgId), 30);

    const active = await repo.countActiveRuns(auth.orgId);
    const cap = CONCURRENT_RUN_LIMITS[auth.plan] ?? 1;
    if (active >= cap) {
      throw tooManyRequests("CONCURRENCY_LIMIT", `The ${auth.plan} plan allows ${cap} concurrent run(s).`, 30, {
        retry_after_sec: 30,
        active_runs: active,
        limit: cap,
      });
    }

    const idea = body.idea ?? project.idea_text ?? "";
    const cost = runCost(body.mode, body.documents);
    const runId = uuidv7();
    const now = nowIso();
    const stageNames = plannedStages(body.mode, body.documents);
    const stages = stageNames.map((stage) => plannedStageRow(auth.orgId, runId, stage));

    const run: RunRow = {
      id: runId,
      org_id: auth.orgId,
      project_id: id,
      source_id: body.source_id ?? null,
      created_by: auth.userId,
      mode: body.mode,
      status: "queued",
      input: {
        idea,
        intake: body.intake,
        documents: body.documents,
      },
      language: body.language,
      doc_types: body.documents,
      glossary: { canonical: {}, entities: [] },
      credit_cost: cost,
      credits_reserved: cost,
      credits_settled: 0,
      max_input_tokens: 120_000,
      max_output_tokens: 80_000,
      max_repair_attempts: 2,
      tokens_in: 0,
      tokens_out: 0,
      llm_calls: 0,
      injection_suspected: false,
      cancel_requested_at: null,
      error_code: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
      consistency: null,
    };

    try {
      await repo.createRunWithReservation(run, stages, cost);
    } catch (err) {
      if (err instanceof InsufficientCredits) {
        throw unprocessable("INSUFFICIENT_CREDITS", err.message, {
          required: err.required,
          available: err.available,
          shortfall: err.shortfall,
        });
      }
      throw err;
    }

    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: auth.via === "api_key" ? "api_key" : "user",
        action: "run.created",
        resource_type: "run",
        resource_id: runId,
        metadata: { mode: body.mode, cost, documents: body.documents },
      }),
    ]);
    await emitEvents(repo, [
      outboxEvent({
        org_id: auth.orgId,
        aggregate_type: "run",
        aggregate_id: runId,
        event_type: "run.created",
        payload: { project_id: id, mode: body.mode, cost },
      }),
    ]);

    reply.code(202).send({
      id: runId,
      status: run.status,
      mode: run.mode,
      credit_cost: cost,
      stages: stages.map((s) => ({ stage: s.stage, status: s.status, cost: STAGE_COSTS[s.stage] })),
      stream: `/v1/runs/${runId}/events`,
    });
  });

  app.get("/v1/runs/:id", async (request) => {
    const auth = await requireAuth(deps, request);
    const { id } = request.params as { id: string };
    const run = await repo.getRun(auth.orgId, id);
    if (!run) throw notFound("Run not found.");
    const stages = await repo.listStages(auth.orgId, id);
    const documents = await repo.listDocumentsByProject(auth.orgId, run.project_id);
    const reviewStage = stages.find((s) => s.stage === "REVIEW");
    const warnings = (reviewStage?.output_ref as { warnings?: string[] } | undefined)?.warnings ?? [];
    return {
      run: { ...run, consistency: { warnings, checked_at: reviewStage?.finished_at ?? run.updated_at } },
      stages,
      documents: documents.filter((d) => d.run_id === id),
    };
  });

  // SSE stream with Last-Event-ID resume from the hub ring buffer.
  app.get("/v1/runs/:id/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAuth(deps, request);
    const { id } = request.params as { id: string };
    const run = await repo.getRun(auth.orgId, id);
    if (!run) throw notFound("Run not found.");

    rate.guardResult(
      reply,
      limiter.sseConnect(auth.userId ?? request.ip),
      30,
      "RATE_LIMITED",
    );

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`retry: 2000\n\n`);

    const lastEventIdHeader = request.headers["last-event-id"];
    const queryLast = (request.query as { last_event_id?: string }).last_event_id;
    const rawId = typeof lastEventIdHeader === "string" ? Number(lastEventIdHeader) : Number(queryLast ?? NaN);
    const lastEventId = Number.isFinite(rawId) ? rawId : null;

    let closed = false;
    const unsubscribe = hub.subscribe(id, lastEventId, (event) => {
      if (closed) return;
      reply.raw.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    const keepalive = setInterval(() => {
      if (!closed) reply.raw.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);
    keepalive.unref?.();

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      reply.raw.end();
    };
    request.raw.on("close", close);
    reply.raw.on("close", close);
    // Terminal runs close shortly after the replay so late subscribers still get it.
    if (["reviewed", "reviewed_with_warnings", "failed", "cancelled"].includes(run.status)) {
      setTimeout(close, 3_000).unref?.();
    }
    await new Promise(() => undefined); // hold open; close() ends the response
  });

  app.post("/v1/runs/:id/cancel", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id } = request.params as { id: string };
    const run = await repo.getRun(auth.orgId, id);
    if (!run) throw notFound("Run not found.");
    if (["reviewed", "reviewed_with_warnings", "failed", "cancelled"].includes(run.status)) {
      throw unprocessable("RUN_FINISHED", `Run already finished as ${run.status}.`);
    }
    await repo.updateRun(auth.orgId, id, { cancel_requested_at: nowIso() });
    await runner.cancelNow(auth.orgId, id);
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "run.cancelled",
        resource_type: "run",
        resource_id: id,
      }),
    ]);
    const updated = await repo.getRun(auth.orgId, id);
    return { id, status: updated?.status ?? "cancelled", credits_released: true };
  });

  app.post("/v1/runs/:id/stages/:stage/retry", async (request) => {
    const auth = await requireAuth(deps, request);
    requireRole(auth, "editor");
    const { id, stage } = request.params as { id: string; stage: string };
    const run = await repo.getRun(auth.orgId, id);
    if (!run) throw notFound("Run not found.");
    if (!STAGE_ORDER.includes(stage as StageName)) {
      throw badRequest("UNKNOWN_STAGE", `Stage ${stage} is not part of the pipeline.`);
    }
    const stages = await repo.listStages(auth.orgId, id);
    const row = stages.find((s) => s.stage === stage);
    if (!row) throw notFound("Stage not found for this run.");
    if (row.status === "running") {
      throw unprocessable("STAGE_RUNNING", "Stage is currently running; cancel the run instead.");
    }
    if (!["failed", "retry_wait", "succeeded"].includes(row.status)) {
      throw unprocessable("STAGE_NOT_RETRYABLE", `Stage in status ${row.status} cannot be retried.`);
    }
    // Requeue the stage and wake the run; the engine re-claims with its own lease.
    await repo.updateRun(auth.orgId, id, {
      status: ["failed", "paused_provider", "cancelled"].includes(run.status) ? "queued" : run.status,
      error_code: null,
      finished_at: null,
      cancel_requested_at: null,
    });
    await repo.failStageAttempt(auth.orgId, id, row.stage, row.attempt, "RETRY_QUEUED", "Manual retry requested.", nowIso(), 0);
    await writeAudit(repo, [
      auditEntry({
        org_id: auth.orgId,
        actor_user_id: auth.userId,
        actor_type: "user",
        action: "run.stage.retry",
        resource_type: "run",
        resource_id: id,
        metadata: { stage },
      }),
    ]);
    return { id, stage, status: "queued", note: "Engine will re-claim the stage on the next scan." };
  });
}
