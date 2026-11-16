/**
 * Mermaid diagram renderer.
 *
 * The mermaid ESM bundle is lazy-loaded from the jsDelivr CDN on first use
 * (it is intentionally not an npm dependency to keep the app bundle small).
 * Rendering happens with securityLevel:'strict', so mermaid sanitizes the
 * output; injecting that sanitized SVG via dangerouslySetInnerHTML is safe.
 */
import React, { useEffect, useRef, useState } from 'react';
import { InlineAlert, Spinner } from './ui.jsx';

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mod = await import(
        /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
      );
      const mermaid = mod.default ?? mod;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
      });
      return mermaid;
    })().catch((err) => {
      mermaidPromise = null; // allow a retry on next mount
      throw err;
    });
  }
  return mermaidPromise;
}

let renderSequence = 0;

export function Mermaid({ code }) {
  const [result, setResult] = useState({ status: 'loading', svg: '', error: null });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const uid = `mermaid-${++renderSequence}-${Math.random().toString(36).slice(2, 8)}`;
    setResult({ status: 'loading', svg: '', error: null });

    loadMermaid()
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(uid, String(code ?? ''));
        if (mountedRef.current) setResult({ status: 'ready', svg, error: null });
      })
      .catch((err) => {
        if (mountedRef.current) setResult({ status: 'error', svg: '', error: err });
      });

    return () => {
      mountedRef.current = false;
    };
  }, [code]);

  if (result.status === 'loading') {
    return (
      <div className="mermaid-box" role="status" aria-label="Rendering diagram">
        <Spinner size={16} />
        <span className="small muted">Rendering diagram…</span>
      </div>
    );
  }

  if (result.status === 'error') {
    return (
      <div className="mermaid-box mermaid-error">
        <InlineAlert tone="danger" title="Diagram failed to render">
          The mermaid source could not be parsed. The raw source is shown below.
        </InlineAlert>
        <pre className="mermaid-source">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid-box mermaid-ready"
      // mermaid sanitizes SVG output under securityLevel:'strict'.
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}

export default Mermaid;
