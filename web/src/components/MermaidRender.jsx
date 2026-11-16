import { useEffect, useId, useState } from "react";
import { CopyButton } from "./CopyButton.jsx";

/**
 * Mermaid renderer — mermaid@11 lazy-loaded from a CDN with securityLevel 'strict'.
 * Parse failures fall back to a formatted code block (never a broken UI).
 */

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(
      (mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          fontFamily: "Inter, sans-serif",
        });
        return mermaid;
      },
      (err) => {
        mermaidPromise = null; // allow retry on next mount
        throw err;
      },
    );
  }
  return mermaidPromise;
}

export function MermaidRender({ code, caption }) {
  const reactId = useId();
  const [svg, setSvg] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    loadMermaid()
      .then(async (mermaid) => {
        const { svg: rendered } = await mermaid.render(`mmd-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`, code);
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  return (
    <figure className="mermaid-figure">
      {failed ? (
        <div className="mermaid-fallback">
          <div className="md-code-head">
            <span className="md-code-lang">mermaid (source)</span>
            <CopyButton value={code} label="Copy source" />
          </div>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : svg ? (
        <div className="mermaid-svg" role="img" aria-label={caption || "Diagram"} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="mermaid-loading">Rendering diagram…</div>
      )}
      {caption ? <figcaption className="mermaid-caption">{caption}</figcaption> : null}
    </figure>
  );
}

/** Default renderer used by Markdown code fences. */
export function renderMermaid(code) {
  return <MermaidRender code={code} />;
}
