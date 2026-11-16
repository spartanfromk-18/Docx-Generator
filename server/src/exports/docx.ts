import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { parseMarkdown, type DocumentAst } from "./markdown.js";

/**
 * DOCX renderer from the typed AST (TRD S9): no string templating of user
 * content into XML; the docx library serializes a safe object tree.
 */

const FONT_MONO = "Consolas";
const FONT_SANS = "Calibri";

function inlineRuns(text: string, base: { size: number; bold?: boolean }): TextRun[] {
  // Split on **bold** and `code`
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: FONT_SANS, size: base.size, bold: base.bold }));
    const token = m[0];
    if (token.startsWith("**")) {
      runs.push(new TextRun({ text: token.slice(2, -2), font: FONT_SANS, size: base.size, bold: true }));
    } else {
      runs.push(
        new TextRun({
          text: token.slice(1, -1),
          font: FONT_MONO,
          size: Math.max(16, base.size - 2),
          shading: { type: ShadingType.CLEAR, fill: "F2F4F7" },
        }),
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: FONT_SANS, size: base.size, bold: base.bold }));
  return runs.length > 0 ? runs : [new TextRun({ text: "", font: FONT_SANS, size: base.size })];
}

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

function codeParagraphs(code: string): Paragraph[] {
  const lines = code.split("\n");
  return lines.map(
    (line, idx) =>
      new Paragraph({
        children: [new TextRun({ text: line.length ? line : " ", font: FONT_MONO, size: 18 })],
        spacing: { before: idx === 0 ? 120 : 0, after: idx === lines.length - 1 ? 160 : 0, line: 240 },
        shading: { type: ShadingType.CLEAR, fill: "F5F6F8" },
      }),
  );
}

function tableFrom(rows: string[][]): Table {
  const [header, ...body] = rows;
  const mkCell = (text: string, isHeader: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          children: inlineRuns(text, { size: isHeader ? 20 : 19, bold: isHeader }),
        }),
      ],
      shading: isHeader ? { type: ShadingType.CLEAR, fill: "EEF1F5" } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: "D0D5DD" },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: "D0D5DD" },
      left: { style: BorderStyle.SINGLE, size: 2, color: "D0D5DD" },
      right: { style: BorderStyle.SINGLE, size: 2, color: "D0D5DD" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E4E7EC" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E4E7EC" },
    },
    rows: [
      new TableRow({ children: (header ?? []).map((c) => mkCell(c, true)), tableHeader: true }),
      ...body.map((r) => new TableRow({ children: r.map((c) => mkCell(c, false)) })),
    ],
  });
}

export function astToDocxBlob(ast: DocumentAst, footerNote?: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({ text: ast.title, heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
  );

  for (const b of ast.blocks) {
    switch (b.type) {
      case "heading":
        children.push(new Paragraph({ text: b.text, heading: HEADING_MAP[b.level] ?? HeadingLevel.HEADING_3, spacing: { before: 240, after: 120 } }));
        break;
      case "para":
        children.push(new Paragraph({ children: inlineRuns(b.text, { size: 21 }), spacing: { after: 140 } }));
        break;
      case "code":
        children.push(...codeParagraphs(b.code));
        break;
      case "table":
        children.push(tableFrom(b.rows));
        children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        break;
      case "list":
        for (const item of b.items) {
          children.push(
            new Paragraph({
              children: inlineRuns(item, { size: 21 }),
              numbering: b.ordered ? { reference: "sf-ordered", level: 0 } : undefined,
              bullet: b.ordered ? undefined : { level: 0 },
              spacing: { after: 60 },
            }),
          );
        }
        break;
      case "quote":
        children.push(
          new Paragraph({
            children: inlineRuns(b.text, { size: 20 }),
            indent: { left: 480 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: "B4C6E7" } },
            spacing: { after: 140 },
          }),
        );
        break;
      case "hr":
        children.push(new Paragraph({ text: "", border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" } }, spacing: { after: 160 } }));
        break;
    }
  }

  if (footerNote) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: footerNote, font: FONT_SANS, size: 16, italics: true, color: "5A6472" })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 360 },
      }),
    );
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "sf-ordered",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: FONT_SANS, size: 21 } },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

/** Convenience: markdown string → DOCX buffer. */
export function markdownToDocxBlob(md: string, fallbackTitle: string, footerNote?: string): Promise<Buffer> {
  return astToDocxBlob(parseMarkdown(md, fallbackTitle), footerNote);
}
