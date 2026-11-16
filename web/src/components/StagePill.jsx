import { statusTone, Badge } from "./Badge.jsx";

const STAGE_LABELS = {
  INTAKE_VALIDATE: "Intake",
  CRAWL_FAST: "Crawl",
  EXTRACT: "Extract",
  PRD: "PRD",
  TRD: "TRD",
  UX: "UI/UX",
  SCHEMA: "Schema",
  SCHEMA_VALIDATE: "Validate",
  REVIEW: "Review",
  FINALIZE: "Finalize",
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage;
}

export const STAGE_ORDER = ["INTAKE_VALIDATE", "CRAWL_FAST", "EXTRACT", "PRD", "TRD", "UX", "SCHEMA", "SCHEMA_VALIDATE", "REVIEW", "FINALIZE"];

export function StagePill({ stage, status, attempt, credits, compact }) {
  const tone = statusTone(status);
  return (
    <span className={`stage-pill stage-${tone}`} data-stage={stage} title={`${stageLabel(stage)} — ${status}${attempt ? ` (attempt ${attempt})` : ""}`}>
      <span className="stage-dot" aria-hidden="true" />
      {!compact && <span className="stage-name">{stageLabel(stage)}</span>}
      {credits ? <span className="stage-credits">{credits}</span> : null}
      <Badge tone={tone} className="sr-only">{status}</Badge>
    </span>
  );
}
