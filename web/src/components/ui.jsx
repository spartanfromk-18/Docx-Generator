/**
 * Shared UI primitives: buttons, badges, toasts, dialogs, error states.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { formatCredits, statusIcon, statusTone } from '../lib/format.js';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  className,
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', loading && 'is-loading', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : null}
      <span className="btn-label">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

// Icon + label are always rendered together so status is never conveyed by
// color alone.
export function Badge({ status, tone, label, children, className }) {
  const resolvedTone = tone ?? (status ? statusTone(status) : 'neutral');
  const iconInfo = status ? statusIcon(status) : null;
  const text = children ?? label ?? iconInfo?.label ?? status;
  return (
    <span className={cx('badge', `badge-${resolvedTone}`, className)}>
      {iconInfo ? (
        <>
          <span className="badge-icon" aria-hidden="true">
            {iconInfo.icon}
          </span>
          <span>{text}</span>
        </>
      ) : (
        <span>{text}</span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Spinner / Skeleton                                                  */
/* ------------------------------------------------------------------ */

export function Spinner({ size = 18, label = 'Loading' }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label} />;
}

export function FullPageSpinner({ label = 'Loading' }) {
  return (
    <div className="fullpage-spinner" role="status" aria-label={label}>
      <Spinner size={28} label={label} />
    </div>
  );
}

export function Skeleton({ width, height = 14, radius, className, style }) {
  return (
    <span
      className={cx('skeleton', className)}
      style={{ width, height, ...(radius ? { borderRadius: radius } : {}), ...style }}
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Stage + section pills                                               */
/* ------------------------------------------------------------------ */

export function StagePill({ label, status = 'queued', attempt, active, onClick, elapsed }) {
  const icon = statusIcon(status);
  const tone = statusTone(status);
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      className={cx('stage-pill', `tone-${tone}`, active && 'active', onClick && 'clickable')}
      onClick={onClick}
    >
      <span className="stage-pill-icon" aria-hidden="true">
        {icon.icon}
      </span>
      <span className="stage-pill-label">{label}</span>
      {elapsed != null ? <span className="stage-pill-elapsed num">{elapsed}</span> : null}
      <span className="stage-pill-status">{icon.label}</span>
      {attempt != null && attempt > 1 ? <span className="stage-pill-attempt">×{attempt}</span> : null}
    </Comp>
  );
}

const SECTION_META = {
  pending: { icon: '○', label: 'Pending', tone: 'neutral' },
  queued: { icon: '○', label: 'Queued', tone: 'neutral' },
  streaming: { icon: '▶', label: 'Streaming', tone: 'info' },
  completed: { icon: '✓', label: 'Done', tone: 'success' },
  done: { icon: '✓', label: 'Done', tone: 'success' },
  failed: { icon: '✕', label: 'Failed', tone: 'danger' },
};

export function SectionStatusPill({ status = 'pending' }) {
  const meta = SECTION_META[String(status).toLowerCase()] ?? SECTION_META.pending;
  return (
    <span className={cx('badge', `badge-${meta.tone}`, 'section-status-pill')}>
      <span className="badge-icon" aria-hidden="true">
        {meta.icon}
      </span>
      <span>{meta.label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* CreditMeter                                                         */
/* ------------------------------------------------------------------ */

export function CreditMeter({ balance = 0, reserved = 0, cap, loading, compact, className }) {
  const available = Math.max(0, Number(balance ?? 0) - Number(reserved ?? 0));
  const pct = cap ? Math.min(100, Math.max(2, Math.round((available / cap) * 100))) : null;
  const title = reserved
    ? `${formatCredits(available)} credits available · ${formatCredits(reserved)} reserved`
    : `${formatCredits(available)} credits available`;
  return (
    <span className={cx('credit-meter', compact && 'compact', className)} title={title}>
      <span className="credit-coin" aria-hidden="true">
        ⬡
      </span>
      <span className="credit-value num">{loading ? '…' : formatCredits(available)}</span>
      <span className="credit-label">credits</span>
      {pct != null ? (
        <span className="meter credit-meter-bar" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* CopyButton                                                          */
/* ------------------------------------------------------------------ */

export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied ✓', small, className }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(text ?? ''));
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(text ?? '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — nothing else to try */
    }
  };

  return (
    <button
      type="button"
      className={cx('btn', 'btn-ghost', small && 'btn-sm', 'copy-btn', copied && 'copied', className)}
      onClick={onCopy}
      aria-live="polite"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children, footer, width }) {
  const dialogRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const el = dialogRef.current;
    if (el) {
      const first = el.querySelector(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === 'Tab' && el) {
        const focusable = [...el.querySelectorAll(FOCUSABLE)];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (restoreRef.current?.focus) restoreRef.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Dialog'}
        ref={dialogRef}
        tabIndex={-1}
        style={width ? { maxWidth: width } : undefined}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

const ToastContext = createContext(null);

export function useToasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used inside <ToastProvider>');
  return ctx;
}

const TOAST_ICONS = { info: 'ⓘ', success: '✓', warning: '⚠', danger: '✕' };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast) => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => [...prev, { id, kind: 'info', ...toast }]);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), 5000)
      );
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx('toast', `toast-${toast.kind ?? 'info'}`)}>
            <span className="toast-icon" aria-hidden="true">
              {TOAST_ICONS[toast.kind ?? 'info'] ?? 'ⓘ'}
            </span>
            <div className="toast-content">
              <div className="toast-title">{toast.title}</div>
              {toast.message ? <div className="toast-message">{toast.message}</div> : null}
              {toast.action ? (
                <div className="toast-action">
                  {toast.action.to ? (
                    <Link to={toast.action.to} className="toast-link" onClick={() => dismiss(toast.id)}>
                      {toast.action.label} →
                    </Link>
                  ) : (
                    <button type="button" className="toast-link" onClick={() => { toast.action.onClick?.(); dismiss(toast.id); }}>
                      {toast.action.label}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Connection banner                                                   */
/* ------------------------------------------------------------------ */

export function ConnectionBanner({ state }) {
  if (state !== 'reconnecting' && state !== 'polling') return null;
  return (
    <div className="connection-banner" role="alert">
      <span aria-hidden="true">⟳</span>{' '}
      {state === 'reconnecting'
        ? 'Connection interrupted — reconnecting…'
        : 'Live stream unavailable — polling for updates every 5 seconds.'}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty / error states                                                */
/* ------------------------------------------------------------------ */

export function EmptyStateBlock({ icon = '◇', title, description, action }) {
  return (
    <div className="empty-state card">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {description ? <p className="muted">{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

const ALERT_ICONS = { info: 'ⓘ', success: '✓', warning: '⚠', danger: '✕' };

export function InlineAlert({ tone = 'info', title, children, className }) {
  return (
    <div className={cx('alert', `alert-${tone}`, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden="true">
        {ALERT_ICONS[tone] ?? 'ⓘ'}
      </span>
      <div className="alert-content">
        {title ? <div className="alert-title">{title}</div> : null}
        {children ? <div className="alert-body">{children}</div> : null}
      </div>
    </div>
  );
}

export function ErrorStatePanel({ error, onRetry }) {
  const code = error?.code ?? 'UNKNOWN';
  const message = error?.message ?? 'Something went wrong while loading this content.';
  return (
    <div className="error-panel card" role="alert">
      <div className="error-panel-icon" aria-hidden="true">
        ⚠
      </div>
      <h3>Couldn’t load this content</h3>
      <p>{message}</p>
      <p className="mono small muted">
        code: {code}
        {error?.requestId ? ` · request_id: ${error.requestId}` : ''}
      </p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Error boundary                                                      */
/* ------------------------------------------------------------------ */

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[SpecForge] Uncaught render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container page">
        <div className="error-panel card" role="alert">
          <div className="error-panel-icon" aria-hidden="true">
            ⚠
          </div>
          <h2>Something went wrong</h2>
          <p className="muted">{String(this.state.error?.message ?? this.state.error)}</p>
          <div className="row">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <Button
              variant="secondary"
              onClick={() => {
                window.location.assign('/app/projects');
              }}
            >
              Go to projects
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
