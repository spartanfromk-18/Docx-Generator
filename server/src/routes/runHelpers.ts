/** Shared run-route helpers. */
import { uuidv7, nowIso } from "../util.js";
import type { StageName, StageRow } from "../types.js";

/** A fresh queued stage row for run creation. */
export function plannedStageRow(orgId: string, runId: string, stage: StageName): StageRow {
  const now = nowIso();
  return {
    id: uuidv7(),
    org_id: orgId,
    run_id: runId,
    stage,
    status: "queued",
    attempt: 0,
    lease_owner: null,
    lease_expires_at: null,
    next_attempt_at: null,
    tokens_in: 0,
    tokens_out: 0,
    credits_settled: 0,
    provider: null,
    model: null,
    error_code: null,
    error_detail: null,
    output_ref: {},
    queued_at: now,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
}
