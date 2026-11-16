export function Button({ variant = "primary", size = "md", loading = false, disabled, children, className = "", ...rest }) {
  const cls = ["btn", `btn-${variant}`, `btn-${size}`, loading ? "is-loading" : "", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      <span className="btn-label">{children}</span>
    </button>
  );
}
