import { useMemo } from "react";
import { CopyButton } from "./CopyButton.jsx";

/**
 * Safe React-element Markdown renderer — no dangerouslySetInnerHTML anywhere.
 * Supports: headings, paragraphs, ordered/unordered lists, tables, fenced code
 * (with CopyButton), inline code, bold, italic, blockquotes, hr, and Mermaid fences
 * (delegated to MermaidRender by the caller passing renderMermaid).
 */

function inline(text, keyBase) {
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
    else if (m[4] !== undefined) nodes.push(<em key={`${keyBase}-i${i}`}>{m[4]}</em>);
    else if (m[6] !== undefined) nodes.push(<code key={`${keyBase}-c${i}`} className="inline-code">{m[6]}</code>);
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Table({ header, rows }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{inline(h, `th${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {header.map((_, ci) => (
                <td key={ci}>{inline(row[ci] ?? "", `td${ri}-${ci}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeFence({ lang, code, renderMermaid }) {
  if ((lang === "mermaid" || lang === "mmd") && renderMermaid) {
    return renderMermaid(code);
  }
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        <CopyButton value={code} label="Copy" />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function parseMarkdownBlocks(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lang, code: code.join("\n") });
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = Math.min(4, (line.match(/^#+/) ?? ["#"])[0].length);
      blocks.push({ kind: "heading", level, text: line.replace(/^#{1,4}\s+/, "").trim() });
      i += 1;
      continue;
    }
    if (/^\|.*\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const text = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        text.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: text.join(" ") });
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(```|#{1,4}\s|\||>\s?|\s*[-*]\s|\s*\d+[.)]\s|\s*---+\s*$)/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

export function Markdown({ source, renderMermaid }) {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, idx) => {
        const key = `blk${idx}`;
        switch (b.kind) {
          case "heading": {
            const Tag = `h${Math.min(6, b.level + 1)}`;
            return <Tag key={key} className={`md-h md-h${b.level}`}>{inline(b.text, key)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{inline(b.text, key)}</p>;
          case "list":
            return b.ordered ? (
              <ol key={key}>{b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ol>
            ) : (
              <ul key={key}>{b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ul>
            );
          case "table":
            return <Table key={key} header={b.header} rows={b.rows} />;
          case "code":
            return <CodeFence key={key} lang={b.lang} code={b.code} renderMermaid={renderMermaid} />;
          case "quote":
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>;
          case "hr":
            return <hr key={key} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
