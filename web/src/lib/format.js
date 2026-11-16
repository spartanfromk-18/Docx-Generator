/**
 * Formatting helpers shared across the app.
 */

export function formatCredits(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '0';
  const rounded = Math.round(num * 100) / 100;
  const isInteger = Math.abs(rounded - Math.round(rounded)) < 1e-9;
  return isInteger ? String(Math.round(rounded)) : rounded.toFixed(2);
}

export function formatRelative(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (abs < 45_000) return 'just now';
  let span;
  if (abs < HOUR) span = `${Math.max(1, Math.round(abs / MINUTE))}m`;
  else if (abs < DAY) span = `${Math.round(abs / HOUR)}h`;
  else if (abs < 7 * DAY) span = `${Math.round(abs / DAY)}d`;
  else {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return future ? `in ${span}` : `${span} ago`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds ?? 0)));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function humanizeStatus(status) {
  return String(status)
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

const STATUS_ICONS = {
  queued: { icon: '⏳', label: 'Queued' },
  running: { icon: '▶', label: 'Running' },
  generating: { icon: '▶', label: 'Generating' },
  retry_wait: { icon: '⟳', label: 'Retrying' },
  succeeded: { icon: '✓', label: 'Succeeded' },
  done: { icon: '✓', label: 'Done' },
  failed: { icon: '✕', label: 'Failed' },
  cancelled: { icon: '⊘', label: 'Cancelled' },
  reviewed: { icon: '✓', label: 'Reviewed' },
  reviewed_with_warnings: { icon: '⚠', label: 'Warnings' },
  paused_provider: { icon: '⏸', label: 'Paused' },
  crawling: { icon: '⟳', label: 'Crawling' },
  preview_ready: { icon: '◈', label: 'Ready' },
  confirmed: { icon: '✓', label: 'Confirmed' },
  auth_wall: { icon: '🔒', label: 'Auth wall' },
  ready: { icon: '⤓', label: 'Ready' },
  captured: { icon: '✓', label: 'Captured' },
  partial: { icon: '⚠', label: 'Partial' },
  skipped: { icon: '✕', label: 'Skipped' },
};

export function statusIcon(status) {
  if (!status) return { icon: '•', label: '—' };
  const key = String(status).toLowerCase();
  return STATUS_ICONS[key] ?? { icon: '•', label: humanizeStatus(key) };
}

const STATUS_TONES = {
  succeeded: 'success',
  done: 'success',
  reviewed: 'success',
  confirmed: 'success',
  ready: 'success',
  captured: 'success',
  retry_wait: 'warning',
  reviewed_with_warnings: 'warning',
  paused_provider: 'warning',
  partial: 'warning',
  auth_wall: 'warning',
  failed: 'danger',
  cancelled: 'danger',
};

export function statusTone(status) {
  if (!status) return 'neutral';
  return STATUS_TONES[String(status).toLowerCase()] ?? 'neutral';
}
