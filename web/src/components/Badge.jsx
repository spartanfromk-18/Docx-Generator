const TONES = {
  neutral: "badge",
  success: "badge badge-success",
  warning: "badge badge-warning",
  danger: "badge badge-danger",
  info: "badge badge-info",
  brand: "badge badge-brand",
};

export function Badge({ tone = "neutral", children, title, className = "" }) {
  return (
    <span className={`${TONES[tone] ?? TONES.neutral} ${className}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONES = {
  queued: "neutral",
  running: "info",
  generating: "info",
  succeeded: "success",
  done: "success",
  reviewed: "success",
  reviewed_with_warnings: "warning",
  retry_wait: "warning",
  failed: "danger",
  cancelled: "neutral",
  skipped: "neutral",
  paused_provider: "warning",
};

export function statusTone(status) {
  return STATUS_TONES[status] ?? "neutral";
}

export function StatusBadge({ status }) {
  return <Badge tone={statusTone(status)}>{String(status ?? "unknown").replace(/_/g, " ")}</Badge>;
}
