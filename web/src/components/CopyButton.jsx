import { useState } from "react";

/** Copy-to-clipboard with a transient "Copied" state. */
export function CopyButton({ value, label = "Copy", className = "" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "string" ? value : String(value ?? ""));
    } catch {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = typeof value === "string" ? value : String(value ?? "");
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className={`copy-btn ${className}`} onClick={copy} aria-live="polite">
      {copied ? "Copied ✓" : label}
    </button>
  );
}
