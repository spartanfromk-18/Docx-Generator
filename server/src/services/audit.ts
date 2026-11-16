import type { Repo } from "../db/repo.js";
import type { AuditRow, OutboxEventRow } from "../types.js";
import { nowIso, uuidv7 } from "../util.js";

/**
 * Transactional audit + outbox writer (TRD D4). In Postgres mode these rows are
 * written inside the caller's transaction via the repo; in memory mode the repo
 * appends synchronously. Outbox rows are marked published by the dev relay.
 */

export function outboxEvent(
  partial: Omit<OutboxEventRow, "id" | "status" | "attempts" | "published_at" | "created_at" | "available_at" | "trace_context"> & {
    available_at?: string;
    trace_context?: string | null;
  },
): Omit<OutboxEventRow, "status" | "attempts" | "published_at"> {
  return {
    id: uuidv7(),
    org_id: partial.org_id,
    aggregate_type: partial.aggregate_type,
    aggregate_id: partial.aggregate_id,
    event_type: partial.event_type,
    payload: partial.payload,
    trace_context: partial.trace_context ?? null,
    available_at: partial.available_at ?? nowIso(),
    created_at: nowIso(),
  };
}

/** Tolerant audit entry builder — optional fields default to null/empty (TRD D4). */
export function auditEntry(
  partial: Partial<Omit<AuditRow, "id" | "created_at">> & Pick<AuditRow, "org_id" | "actor_type" | "action" | "resource_type">,
): Omit<AuditRow, "id"> {
  return {
    org_id: partial.org_id,
    actor_user_id: partial.actor_user_id ?? null,
    actor_type: partial.actor_type,
    action: partial.action,
    resource_type: partial.resource_type,
    resource_id: partial.resource_id ?? null,
    ip: partial.ip ?? null,
    user_agent: partial.user_agent ?? null,
    metadata: partial.metadata ?? {},
    created_at: nowIso(),
  };
}

export async function writeAudit(repo: Repo, entries: Omit<AuditRow, "id">[]): Promise<void> {
  if (entries.length === 0) return;
  await repo.writeAudit(entries);
}

export async function emitEvents(repo: Repo, events: Omit<OutboxEventRow, "status" | "attempts" | "published_at">[]): Promise<void> {
  if (events.length === 0) return;
  await repo.emitOutbox(events);
}
