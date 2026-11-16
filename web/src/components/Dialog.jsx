import { useEffect, useRef } from "react";

/** Accessible modal dialog: focus trap, Esc close, backdrop click, aria-modal. */
export function Dialog({ open, onClose, title, children, footer, width = 480 }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const node = ref.current;
    const focusables = () => node?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusables()?.[0]?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      if (e.key === "Tab") {
        const list = [...(focusables() ?? [])];
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={{ maxWidth: width }}>
        <div className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
