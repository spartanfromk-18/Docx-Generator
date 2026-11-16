import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { badRequest, conflict, unprocessable } from "../errors.js";
import type { Repo } from "../db/repo.js";
import { nowIso, uuidv7, sha256Hex } from "../util.js";

/**
 * TRD 2.4 / PRD edge-case matrix: mutating endpoints require Idempotency-Key.
 * (org, key, request hash) is stored for 24 h; the original response is replayed.
 * A different payload with the same key returns 422 IDEMPOTENCY_KEY_REUSED.
 */

const EXEMPT = [/^\/v1\/auth\//, /^\/v1\/webhooks\//, /^\/v1\/s\//];

export function registerIdempotency(app: FastifyInstance, repo: Repo): void {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    if (!["POST", "PATCH", "DELETE"].includes(method)) return;
    const url = request.routeOptions?.url ?? request.url.split("?")[0];
    if (!url.startsWith("/v1") || EXEMPT.some((re) => re.test(url))) return;
    // SSE/stream routes are safe-method only; webhooks are exempt above.
    if (!request.auth) return; // auth guard runs before this via route-level preHandler ordering

    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 64) {
      throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "Mutating requests require an Idempotency-Key header (8-64 chars).");
    }
    if (!request.auth) return; // auth guard runs before this via route-level preHandler ordering
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const requestHash = sha256Hex(rawBody);

    const existing = await repo.getIdempotency(request.auth.orgId, key);
    if (existing && existing.state === "completed") {
      if (existing.request_hash !== requestHash) {
        throw unprocessable("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different payload.");
      }
      reply.code(existing.response_status ?? 200).send(existing.response_body);
      return;
    }
    if (existing && existing.state === "in_progress") {
      if (existing.request_hash !== requestHash) {
        throw unprocessable("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different payload.");
      }
      throw conflict("IDEMPOTENCY_KEY_IN_PROGRESS", "An identical request is still in progress. Retry shortly.");
    }
    const inserted = await repo.insertIdempotencyInProgress({
      id: uuidv7(),
      org_id: request.auth.orgId,
      idem_key: key,
      method,
      path: url,
      request_hash: requestHash,
      state: "in_progress",
      response_status: null,
      response_body: null,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    if (!inserted) {
      throw conflict("IDEMPOTENCY_KEY_IN_PROGRESS", "An identical request is still in progress. Retry shortly.");
    }

    // Capture the final response for replay.
    const captured: { status: number; body: unknown } = { status: reply.statusCode, body: null };
    const origCode = reply.code.bind(reply);
    const origSend = reply.send.bind(reply);
    reply.code = (statusCode: number) => {
      captured.status = statusCode;
      return origCode(statusCode);
    };
    reply.send = (payload?: unknown) => {
      captured.body = payload;
      if (request.auth) {
        const orgId = request.auth.orgId;
        const status = captured.status;
        const body = captured.body;
        setImmediate(() => {
          void repo.completeIdempotency(orgId, key, status, body).catch(() => {});
        });
      }
      return origSend(payload);
    };
  });
}
