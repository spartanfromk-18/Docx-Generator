import { PipelineRunner } from "./runner.js";
import { STAGE_DEFS, STAGE_ORDER } from "./stages.js";
import type { Repo } from "../db/repo.js";
import type { EventHub } from "../realtime/hub.js";
import type { LLMGateway } from "../llm/gateway.js";
import type { StageName } from "../types.js";

/**
 * In-process scheduler implementing the checkpointed stage graph (TRD 2.2).
 * Multi-worker safety comes from the atomic claim in the repository
 * (conditional UPDATE with lease), so this engine can run in several processes
 * against the same database; SQS/KEDA is the production trigger.
 */

export interface EngineDeps {
  repo: Repo;
  hub: EventHub;
  gateway: LLMGateway;
}

export class Engine {
  private runner: PipelineRunner;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private inflight = new Set<string>();
  private gcTimer: NodeJS.Timeout | null = null;
  stopped = false;

  constructor(private deps: EngineDeps) {
    this.runner = new PipelineRunner(deps);
  }

  start(intervalMs = 400): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.gcTimer = setInterval(() => {
      this.deps.hub.gc();
    }, 30_000);
    this.gcTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.timer = null;
    // Drain in-flight stages
    const deadline = Date.now() + 10_000;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  stats(): { inflight: number; ticking: boolean } {
    return { inflight: this.inflight.size, ticking: this.ticking };
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const runIds = await this.deps.repo.listOpenRunIds();
      for (const runId of runIds) {
        await this.pumpRun(runId);
      }
    } catch (err) {
      // Engine never crashes the process on a transient repository error.
      console.error("[engine] tick error:", err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  private async pumpRun(runId: string): Promise<void> {
    const { repo } = this.deps;
    const run = await repo.getRunSystem(runId);
    if (!run) return;

    // Cancellation is checked here (not-yet-claimed stages) and inside the
    // runner (between LLM calls / page navigations) per TRD.
    if (run.cancel_requested_at && !["reviewed", "reviewed_with_warnings", "failed", "cancelled"].includes(run.status)) {
      await this.runner.cancelNow(run.org_id, runId);
      return;
    }

    const stages = await repo.listStagesSystem(runId);
    const byName = new Map(stages.map((s) => [s.stage, s]));
    const now = Date.now();

    const isSatisfied = (name: StageName): boolean => {
      const def = STAGE_DEFS[name];
      return def.dependsOn.every((dep) => {
        const ds = byName.get(dep);
        return ds && (ds.status === "succeeded" || ds.status === "skipped");
      });
    };

    for (const name of STAGE_ORDER) {
      const def = STAGE_DEFS[name];
      if (!run.doc_types.some((d) => docStage(d) === name) && !["INTAKE_VALIDATE", "SCHEMA_VALIDATE", "REVIEW", "FINALIZE"].includes(name)) {
        continue; // stage not planned for this run
      }
      if (run.mode === "idea" && (name === "CRAWL_FAST" || name === "EXTRACT")) continue;

      const s = byName.get(name);
      if (!s) continue;
      const key = `${runId}:${name}`;
      if (this.inflight.has(key)) continue;
      if (!["queued", "retry_wait"].includes(s.status)) continue;
      if (s.status === "retry_wait" && (!s.next_attempt_at || new Date(s.next_attempt_at).getTime() > now)) continue;
      if (s.lease_owner && s.lease_expires_at && new Date(s.lease_expires_at).getTime() > now) continue; // another worker owns it
      if (!isSatisfied(name)) continue;

      this.inflight.add(key);
      void this.runner
        .runStage(run.org_id, runId, name)
        .catch((err) => console.error(`[engine] stage ${name} crashed:`, err))
        .finally(() => this.inflight.delete(key));
    }
  }
}

function docStage(d: string): string {
  switch (d) {
    case "PRD": return "PRD";
    case "TRD": return "TRD";
    case "UIUX": return "UX";
    case "SCHEMA": return "SCHEMA";
    default: return "PRD";
  }
}
