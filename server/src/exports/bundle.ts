import archiver from "archiver";
import { markdownToDocxBlob } from "./docx.js";
import { sectionsToMarkdown } from "./markdown.js";
import { extractDdlFromSections } from "../llm/mockContent.js";

/** ZIP bundle per PRD FR-10: DOCX + Markdown per document, schema.sql, diagrams. */

export interface BundleDoc {
  doc_type: string;
  title: string;
  sections: { heading: string; body_md: string }[];
}

async function zipToBuffer(add: (archive: archiver.Archiver) => void): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });
  add(archive);
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** DOCX buffers for each doc, produced outside the zip callback. */
export async function buildDocxBuffers(docs: BundleDoc[], watermark: boolean): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const doc of docs) {
    const md = sectionsToMarkdown(doc.title, doc.sections);
    const note = watermark ? "Made with SpecForge (free plan)" : undefined;
    out.set(doc.doc_type, await markdownToDocxBlob(md, doc.title, note));
  }
  return out;
}

/** Bundle including DOCX files (the full FR-10 shape). */
export async function buildFullRunBundle(
  runId: string,
  docs: BundleDoc[],
  opts: { formats: ("docx" | "md")[]; watermark: boolean },
): Promise<Buffer> {
  const docxBuffers = opts.formats.includes("docx") ? await buildDocxBuffers(docs, opts.watermark) : new Map<string, Buffer>();
  return zipToBuffer((archive) => {
    const manifest: string[] = ["SpecForge bundle", `Run: ${runId}`, `Generated: ${new Date().toISOString()}`, "", "Contents:"];

    let schemaSql: string | null = null;
    const diagrams: { name: string; code: string }[] = [];

    for (const doc of docs) {
      const md = sectionsToMarkdown(doc.title, doc.sections);
      if (opts.formats.includes("md")) {
        archive.append(md, { name: `${doc.doc_type}.md` });
        manifest.push(`- ${doc.doc_type}.md`);
      }
      if (opts.formats.includes("docx")) {
        const buf = docxBuffers.get(doc.doc_type);
        if (buf) {
          archive.append(buf, { name: `${doc.doc_type}.docx` });
          manifest.push(`- ${doc.doc_type}.docx`);
        }
      }
      if (doc.doc_type === "SCHEMA") {
        schemaSql = extractDdlFromSections(doc.sections);
        for (const s of doc.sections) {
          const mermaid = /```mermaid\n([\s\S]*?)```/.exec(s.body_md);
          if (mermaid) diagrams.push({ name: "erd.mmd", code: mermaid[1] });
        }
      }
      if (doc.doc_type === "UIUX") {
        let idx = 1;
        for (const s of doc.sections) {
          const mermaid = /```mermaid\n([\s\S]*?)```/.exec(s.body_md);
          if (mermaid) diagrams.push({ name: `ux_flow_${idx++}.mmd`, code: mermaid[1] });
        }
      }
    }

    if (schemaSql) {
      archive.append(schemaSql, { name: "schema.sql" });
      manifest.push("- schema.sql");
    }
    for (const d of diagrams) {
      archive.append(d.code, { name: `diagrams/${d.name}` });
      manifest.push(`- diagrams/${d.name}`);
    }

    manifest.push("");
    manifest.push("Documents with failed sections contain a visible 'Section failed: retry required' page in their place.");
    if (opts.watermark) {
      manifest.push("");
      manifest.push("Made with SpecForge — upgrade to Pro to remove the watermark.");
    }
    archive.append(manifest.join("\n"), { name: "README.txt" });
  });
}
