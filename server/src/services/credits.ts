import type { DocType, StageName } from "../types.js";

/**
 * PRD FR-9 credit economics.
 * Idea Mode full set = 4.00 credits, Reference Mode = 10.00 credits,
 * single section regeneration = 0.25 credits. Runs reserve up-front and
 * settle per stage; unused reservation is released on cancel/failure.
 */

export const STAGE_COSTS: Record<StageName, number> = {
  INTAKE_VALIDATE: 0.1,
  CRAWL_FAST: 4.0,
  EXTRACT: 2.0,
  PRD: 0.8,
  TRD: 0.8,
  UX: 0.8,
  SCHEMA: 0.9,
  SCHEMA_VALIDATE: 0.0,
  REVIEW: 0.4,
  FINALIZE: 0.2,
};

export const SECTION_REGEN_COST = 0.25;

export const DOC_STAGE: Record<DocType, StageName> = {
  PRD: "PRD",
  TRD: "TRD",
  UIUX: "UX",
  SCHEMA: "SCHEMA",
  CUSTOM: "PRD", // custom templates ride the PRD stage
};

export const PLANS = {
  free: { label: "Free", priceUsd: 0, monthlyCredits: 3, concurrentRuns: 1, maxPages: 0 },
  pro: { label: "Pro", priceUsd: 19, monthlyCredits: 60, concurrentRuns: 3, maxPages: 25 },
  team: { label: "Team", priceUsd: 59, monthlyCredits: 250, concurrentRuns: 10, maxPages: 50 },
  enterprise: { label: "Enterprise", priceUsd: 0, monthlyCredits: 0, concurrentRuns: 10, maxPages: 50 },
} as const;

export const CONCURRENT_RUN_LIMITS: Record<string, number> = {
  free: PLANS.free.concurrentRuns,
  pro: PLANS.pro.concurrentRuns,
  team: PLANS.team.concurrentRuns,
  enterprise: PLANS.enterprise.concurrentRuns,
};

export const CREDIT_PACKS = [{ credits: 30, priceUsd: 10 }] as const;

/** Planned stages for a run; cost = sum of their costs. */
export function plannedStages(mode: "idea" | "reference", docTypes: DocType[]): StageName[] {
  const stages: StageName[] = ["INTAKE_VALIDATE"];
  if (mode === "reference") stages.push("CRAWL_FAST", "EXTRACT");
  const docStages = docTypes.map((d) => DOC_STAGE[d]);
  const ordered: StageName[] = [];
  for (const s of ["PRD", "TRD", "UX", "SCHEMA"] as StageName[]) {
    if (docStages.includes(s)) ordered.push(s);
  }
  stages.push(...ordered, "SCHEMA_VALIDATE", "REVIEW", "FINALIZE");
  return stages;
}

export function runCost(mode: "idea" | "reference", docTypes: DocType[]): number {
  const total = plannedStages(mode, docTypes).reduce((sum, s) => sum + STAGE_COSTS[s], 0);
  return Math.round(total * 100) / 100;
}

export function formatCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
