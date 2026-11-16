import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** TRD §2.4 error envelope + status catalogue. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> | null = null,
    public retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, message: string, details: Record<string, unknown> | null = null) =>
  new ApiError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Authentication required.") =>
  new ApiError(401, code, message);
export const paymentRequired = (
  code: "INSUFFICIENT_CREDITS" | "PLAN_FEATURE_REQUIRED",
  message: string,
  details: Record<string, unknown> | null = null,
) => new ApiError(402, code, message, details);
export const forbidden = (code = "FORBIDDEN", message = "You do not have access to this resource.") =>
  new ApiError(403, code, message);
export const notFound = (message = "Resource not found.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (code: string, message: string, details: Record<string, unknown> | null = null) =>
  new ApiError(409, code, message, details);
export const payloadTooLarge = (message: string, details: Record<string, unknown> | null = null) =>
  new ApiError(413, "IDEA_TOO_LARGE", message, details);
export const unprocessable = (code: string, message: string, details: Record<string, unknown> | null = null) =>
  new ApiError(422, code, message, details);
export const tooManyRequests = (
  code: "RATE_LIMITED" | "CONCURRENCY_LIMIT",
  message: string,
  retryAfterSec: number,
  details: Record<string, unknown> | null = null,
) => new ApiError(429, code, message, details, true);
export const capacity = (message: string, retryAfterSec: number) =>
  new ApiError(503, "CAPACITY", message, null, true);

export function sendError(request: FastifyRequest, reply: FastifyReply, err: ApiError): void {
  if (err.status === 429 && typeof err.details?.retry_after_sec === "number") {
    reply.header("Retry-After", String(Math.ceil(err.details.retry_after_sec as number)));
  }
  reply.code(err.status).send({
    error: {
      code: err.code,
      message: err.message,
      details: err.details ?? undefined,
      request_id: request.id,
      retryable: err.retryable,
    },
  });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof ApiError) {
      sendError(request, reply, err);
      return;
    }
    const fastifyErr = err as { validation?: unknown; message?: string; statusCode?: number; code?: string };
    // Fastify built-in validation errors (should not happen — we validate with Zod first)
    if (fastifyErr.validation) {
      sendError(
        request,
        reply,
        badRequest("VALIDATION_FAILED", fastifyErr.message ?? "Validation failed.", { fields: fastifyErr.validation }),
      );
      return;
    }
    if (fastifyErr.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      sendError(request, reply, badRequest("VALIDATION_FAILED", "Empty JSON body."));
      return;
    }
    if (fastifyErr.statusCode === 413) {
      sendError(request, reply, payloadTooLarge("Request body too large."));
      return;
    }
    request.log.error({ err }, "unhandled error");
    reply.code(500).send({
      error: {
        code: "INTERNAL",
        message: "Unexpected server error.",
        request_id: request.id,
        retryable: true,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        request_id: request.id,
        retryable: false,
      },
    });
  });
}
