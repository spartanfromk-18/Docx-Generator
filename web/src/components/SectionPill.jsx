import { Badge, statusTone } from "./Badge.jsx";

/** Section status pill used in the document outline and live reader. */
export function SectionPill({ status, ordinal }) {
  return (
    <span className={`section-pill section-${statusTone(status)}`}>
      {ordinal !== undefined ? <span className="section-ordinal">{ordinal}</span> : null}
      <Badge tone={statusTone(status)}>{status === "generating" ? "…" : status === "done" ? "✓" : status}</Badge>
    </span>
  );
}
