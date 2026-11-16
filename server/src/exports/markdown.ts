/**
 * Markdown → typed AST (TRD 2.2 export pipeline). DOCX is rendered from this
 * AST, never from string-templated XML (S9).
 */

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "table"; rows: string[][] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" };

export interface DocumentAst {
  title: string;
  blocks: Block[];
}

export function parseMarkdown(md: string, fallbackTitle = "Document"): DocumentAst {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let title = fallbackTitle;
  let i = 0;

  const flushTable = (rows: string[][]): void => {
    if (rows.length > 0) blocks.push({ type: "table", rows });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ type: "code", lang: lang || "text", code: buf.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      if (heading[1].length === 1 && blocks.length === 0) {
        title = heading[2].trim();
      } else {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      }
      i += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        // skip separator rows like ---|---
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(cells);
        i += 1;
      }
      flushTable(rows);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: buf.join(" ").trim() });
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // paragraph: consume until blank line
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```") && !/^\s*\|/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      buf.push(lines[i].trim());
      i += 1;
    }
    if (buf.length > 0) blocks.push({ type: "para", text: buf.join(" ") });
  }

  return { title, blocks };
}

/** Render AST back to clean markdown (used for .md exports and full-document content). */
export function astToMarkdown(ast: DocumentAst): string {
  const out: string[] = [`# ${ast.title}`, ""];
  for (const b of ast.blocks) {
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(b.level + 1)} ${b.text}`, "");
        break;
      case "para":
        out.push(b.text, "");
        break;
      case "code":
        out.push("```" + b.lang, b.code, "```", "");
        break;
      case "table":
        out.push(`| ${b.rows[0]?.join(" | ") ?? ""} |`);
        out.push(`| ${b.rows[0]?.map(() => "---").join(" | ") ?? ""} |`);
        for (const row of b.rows.slice(1)) out.push(`| ${row.join(" | ")} |`);
        out.push("");
        break;
      case "list":
        for (const item of b.items) out.push(b.ordered ? `1. ${item}` : `- ${item}`);
        out.push("");
        break;
      case "quote":
        out.push(`> ${b.text}`, "");
        break;
      case "hr":
        out.push("---", "");
        break;
    }
  }
  return out.join("\n");
}

/** Concatenate sections into one markdown document. */
export function sectionsToMarkdown(title: string, sections: { heading: string; body_md: string }[]): string {
  return [`# ${title}`, "", ...sections.map((s) => `## ${s.heading}\n\n${s.body_md}\n`)].join("\n");
}
