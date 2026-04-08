#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as docx from "docx";
import mammoth from "mammoth";

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, PageBreak, SectionType, Header, Footer, PageNumber,
  LevelFormat, ImageRun, BorderStyle, ShadingType, convertInchesToTwip
} = docx;

const execFileAsync = promisify(execFile);

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const inlineSegmentSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional()
});

const contentElementSchema = z.object({
  type: z.enum(["heading", "paragraph", "definedTerm", "citation", "table", "list", "pageBreak"]),
  // heading
  level: z.number().int().min(1).max(4).optional(),
  text: z.union([z.string(), z.array(inlineSegmentSchema)]).optional(),
  numbering: z.enum(["legal", "none"]).optional(),
  // paragraph
  numbered: z.boolean().optional(),
  indentLevel: z.number().int().min(0).max(8).optional(),
  alignment: z.enum(["left", "center", "right", "justified"]).optional(),
  // definedTerm
  term: z.string().optional(),
  definition: z.string().optional(),
  // citation
  caseName: z.string().optional(),
  neutralCitation: z.string().optional(),
  pinpoint: z.string().optional(),
  parenthetical: z.string().optional(),
  // table
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  headerShading: z.string().optional(),
  // list
  items: z.array(z.string()).optional()
});

const metadataSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  subject: z.string().optional(),
  matterReference: z.string().optional()
}).optional();

const pageSetupSchema = z.object({
  orientation: z.enum(["portrait", "landscape"]).optional(),
  margins: z.object({
    top: z.number().optional(),
    right: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional()
  }).optional(),
  headerText: z.string().optional(),
  footerText: z.string().optional(),
  confidentiality: z.string().optional()
}).optional();

const stylesSchema = z.object({
  font: z.string().optional(),
  fontSize: z.number().optional(),
  lineSpacing: z.number().optional()
}).optional();

// ── Helpers ──────────────────────────────────────────────────────────────────

const HEADING_LEVEL_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4
};

const ALIGNMENT_MAP = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justified: AlignmentType.JUSTIFIED
};

function buildTextRuns(text, defaults) {
  if (typeof text === "string") {
    return [new TextRun({ text, font: defaults.font, size: defaults.fontSize })];
  }
  return text.map((seg) => new TextRun({
    text: seg.text,
    bold: seg.bold,
    italic: seg.italic,
    underline: seg.underline ? { type: "single" } : undefined,
    font: defaults.font,
    size: defaults.fontSize
  }));
}

function buildLegalNumbering() {
  return {
    config: [
      {
        reference: "legal-numbering",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.5) } } } },
          { level: 1, format: LevelFormat.DECIMAL, text: "%1.%2", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(1.0), hanging: convertInchesToTwip(0.5) } } } },
          { level: 2, format: LevelFormat.DECIMAL, text: "%1.%2.%3", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(1.5), hanging: convertInchesToTwip(0.5) } } } },
          { level: 3, format: LevelFormat.DECIMAL, text: "%1.%2.%3.%4", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(2.0), hanging: convertInchesToTwip(0.5) } } } }
        ]
      }
    ]
  };
}

function buildHeader(pageSetup) {
  const children = [];
  if (pageSetup?.confidentiality) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: pageSetup.confidentiality, bold: true, size: 20 })]
    }));
  }
  if (pageSetup?.headerText) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: pageSetup.headerText, size: 18 })]
    }));
  }
  return children.length > 0 ? new Header({ children }) : undefined;
}

function buildFooter(pageSetup) {
  const children = [];
  const footerRuns = [];
  if (pageSetup?.footerText) {
    footerRuns.push(new TextRun({ text: pageSetup.footerText + "  |  ", size: 18 }));
  }
  footerRuns.push(
    new TextRun({ text: "Page ", size: 18 }),
    new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
    new TextRun({ text: " of ", size: 18 }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 })
  );
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: footerRuns }));
  return new Footer({ children });
}

function buildContentElements(content, defaults, definedTerms, headingTree) {
  const paragraphs = [];

  for (const el of content) {
    switch (el.type) {
      case "heading": {
        const headingLevel = el.level || 1;
        const para = new Paragraph({
          heading: HEADING_LEVEL_MAP[headingLevel],
          children: buildTextRuns(el.text || "", defaults),
          ...(el.numbering === "legal" ? { numbering: { reference: "legal-numbering", level: headingLevel - 1 } } : {})
        });
        paragraphs.push(para);
        headingTree.push({ level: headingLevel, text: typeof el.text === "string" ? el.text : el.text.map((s) => s.text).join("") });
        break;
      }

      case "paragraph": {
        const para = new Paragraph({
          children: buildTextRuns(el.text || "", defaults),
          alignment: el.alignment ? ALIGNMENT_MAP[el.alignment] : undefined,
          indent: el.indentLevel ? { left: convertInchesToTwip(0.5 * el.indentLevel) } : undefined
        });
        paragraphs.push(para);
        break;
      }

      case "definedTerm": {
        if (el.term) definedTerms.add(el.term);
        const para = new Paragraph({
          children: [
            new TextRun({ text: `"${el.term}"`, bold: true, font: defaults.font, size: defaults.fontSize }),
            new TextRun({ text: ` means ${el.definition || ""}`, font: defaults.font, size: defaults.fontSize })
          ]
        });
        paragraphs.push(para);
        break;
      }

      case "citation": {
        const runs = [];
        if (el.caseName) runs.push(new TextRun({ text: el.caseName, italics: true, font: defaults.font, size: defaults.fontSize }));
        if (el.neutralCitation) runs.push(new TextRun({ text: ` [${el.neutralCitation}]`, font: defaults.font, size: defaults.fontSize }));
        if (el.pinpoint) runs.push(new TextRun({ text: `, ${el.pinpoint}`, font: defaults.font, size: defaults.fontSize }));
        if (el.parenthetical) runs.push(new TextRun({ text: ` (${el.parenthetical})`, font: defaults.font, size: defaults.fontSize }));
        paragraphs.push(new Paragraph({ children: runs }));
        break;
      }

      case "table": {
        const tableRows = [];
        if (el.headers) {
          tableRows.push(new TableRow({
            children: el.headers.map((h) => new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, font: defaults.font, size: defaults.fontSize })] })],
              width: { size: Math.floor(100 / el.headers.length), type: WidthType.PERCENTAGE },
              shading: el.headerShading ? { fill: el.headerShading, type: ShadingType.CLEAR } : undefined
            }))
          }));
        }
        if (el.rows) {
          for (const row of el.rows) {
            tableRows.push(new TableRow({
              children: row.map((cell) => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: cell, font: defaults.font, size: defaults.fontSize })] })],
                width: { size: Math.floor(100 / row.length), type: WidthType.PERCENTAGE }
              }))
            }));
          }
        }
        if (tableRows.length > 0) {
          paragraphs.push(new Table({ rows: tableRows }));
        }
        break;
      }

      case "list": {
        const indent = el.indentLevel || 0;
        if (el.items) {
          for (const item of el.items) {
            paragraphs.push(new Paragraph({
              children: [
                new TextRun({ text: `\u2022  ${item}`, font: defaults.font, size: defaults.fontSize })
              ],
              indent: { left: convertInchesToTwip(0.5 * (indent + 1)) }
            }));
          }
        }
        break;
      }

      case "pageBreak": {
        paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      }
    }
  }

  return paragraphs;
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "wcjr-docx-engine",
  version: "0.1.0"
});

// ── Tool 1: create_document ──────────────────────────────────────────────────

server.registerTool(
  "create_document",
  {
    description: "Create a legal-grade .docx document from a flexible content tree with headings, paragraphs, defined terms, citations, tables, lists, and page breaks.",
    inputSchema: {
      outputPath: z.string().describe("Absolute path for the output .docx file."),
      metadata: metadataSchema.describe("Optional document metadata (title, author, subject, matterReference)."),
      pageSetup: pageSetupSchema.describe("Optional page setup (orientation, margins, headerText, footerText, confidentiality)."),
      styles: stylesSchema.describe("Optional style defaults (font, fontSize in half-points, lineSpacing in twips)."),
      content: z.array(contentElementSchema).describe("Array of content elements to render.")
    }
  },
  async ({ outputPath, metadata, pageSetup, styles, content }) => {
    const defaults = {
      font: styles?.font || "Times New Roman",
      fontSize: styles?.fontSize || 24,
      lineSpacing: styles?.lineSpacing || 360
    };

    const definedTerms = new Set();
    const headingTree = [];
    const paragraphs = buildContentElements(content || [], defaults, definedTerms, headingTree);

    const header = buildHeader(pageSetup);
    const footer = buildFooter(pageSetup);

    const margins = pageSetup?.margins || {};
    const sectionProperties = {
      page: {
        margin: {
          top: margins.top || convertInchesToTwip(1),
          right: margins.right || convertInchesToTwip(1),
          bottom: margins.bottom || convertInchesToTwip(1),
          left: margins.left || convertInchesToTwip(1)
        },
        ...(pageSetup?.orientation === "landscape" ? { size: { orientation: "landscape" } } : {})
      }
    };

    const doc = new Document({
      creator: metadata?.author || "WCJR MCP Assistant",
      title: metadata?.title || "",
      subject: metadata?.subject || "",
      description: metadata?.matterReference ? `Matter: ${metadata.matterReference}` : "",
      numbering: buildLegalNumbering(),
      styles: {
        default: {
          document: {
            run: { font: defaults.font, size: defaults.fontSize },
            paragraph: { spacing: { line: defaults.lineSpacing } }
          }
        }
      },
      sections: [
        {
          properties: sectionProperties,
          headers: header ? { default: header } : undefined,
          footers: { default: footer },
          children: paragraphs
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, buffer);

    const result = {
      outputPath: resolvedPath,
      elements: (content || []).length,
      headings: headingTree,
      definedTerms: [...definedTerms]
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool 2: read_document ────────────────────────────────────────────────────

server.registerTool(
  "read_document",
  {
    description: "Read an existing .docx file with structural introspection: extract text, headings, defined terms, citations, and tables.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .docx file."),
      extractStructure: z.boolean().optional().describe("Extract headings and defined terms. Default true."),
      extractTables: z.boolean().optional().describe("Extract tables from HTML output. Default true.")
    }
  },
  async ({ filePath, extractStructure = true, extractTables = true }) => {
    const resolvedPath = path.resolve(filePath);
    const fileBuffer = await fs.readFile(resolvedPath);

    const htmlResult = await mammoth.convertToHtml({ buffer: fileBuffer });
    const textResult = await mammoth.extractRawText({ buffer: fileBuffer });

    const output = {
      text: textResult.value,
      warnings: htmlResult.messages.map((m) => m.message)
    };

    if (extractStructure) {
      // Extract headings from HTML
      const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
      const headings = [];
      let match;
      while ((match = headingRegex.exec(htmlResult.value)) !== null) {
        headings.push({
          level: parseInt(match[1], 10),
          text: match[2].replace(/<[^>]+>/g, "")
        });
      }
      output.headings = headings;

      // Detect defined terms (quoted capitalised terms)
      const termRegex = /\u201c([A-Z][^\u201d]{2,})\u201d|"([A-Z][^"]{2,})"/g;
      const definedTerms = new Set();
      while ((match = termRegex.exec(textResult.value)) !== null) {
        definedTerms.add(match[1] || match[2]);
      }
      output.definedTerms = [...definedTerms];

      // Detect citations (CaseName v CaseName [year] CITATION)
      const citationRegex = /([A-Z][a-zA-Z\s]+)\s+v\s+([A-Z][a-zA-Z\s]+)\s*\[(\d{4})\]\s+([A-Z]+\s+\d+)/g;
      const citations = [];
      while ((match = citationRegex.exec(textResult.value)) !== null) {
        citations.push({
          parties: `${match[1].trim()} v ${match[2].trim()}`,
          year: match[3],
          citation: match[4].trim()
        });
      }
      output.citations = citations;
    }

    if (extractTables) {
      const tableRegex = /<table>([\s\S]*?)<\/table>/gi;
      const tables = [];
      let tableMatch;
      while ((tableMatch = tableRegex.exec(htmlResult.value)) !== null) {
        const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
        const tableRows = [];
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
          const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
          const cells = [];
          let cellMatch;
          while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
          }
          tableRows.push(cells);
        }
        tables.push(tableRows);
      }
      output.tables = tables;
    }

    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
  }
);

// ── Tool 3: update_document ──────────────────────────────────────────────────

server.registerTool(
  "update_document",
  {
    description: "Modify an existing .docx file. Supports replaceAllText (string substitution), appendContent and prependContent (via read + rebuild workflow advice).",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .docx file to modify."),
      outputPath: z.string().optional().describe("Output path. Defaults to overwriting the input file."),
      operations: z.array(z.object({
        type: z.enum(["appendContent", "prependContent", "replaceAllText"]),
        search: z.string().optional().describe("Text to find (for replaceAllText)."),
        replace: z.string().optional().describe("Replacement text (for replaceAllText)."),
        content: z.array(contentElementSchema).optional().describe("Content elements (for append/prepend).")
      })).describe("Array of operations to apply.")
    }
  },
  async ({ filePath, outputPath, operations }) => {
    const resolvedInput = path.resolve(filePath);
    const resolvedOutput = path.resolve(outputPath || filePath);
    const appliedOps = [];

    for (const op of operations) {
      if (op.type === "replaceAllText") {
        // Read raw text, apply replacements, rebuild a simple document
        const fileBuffer = await fs.readFile(resolvedInput);
        const textResult = await mammoth.extractRawText({ buffer: fileBuffer });
        let text = textResult.value;
        const count = (text.split(op.search || "").length - 1);
        text = text.replaceAll(op.search || "", op.replace || "");

        // Rebuild as a simple document with replaced text
        const doc = new Document({
          sections: [{
            children: text.split("\n").map((line) => new Paragraph({
              children: [new TextRun({ text: line, font: "Times New Roman", size: 24 })]
            }))
          }]
        });
        const buffer = await Packer.toBuffer(doc);
        await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
        await fs.writeFile(resolvedOutput, buffer);
        appliedOps.push({ type: "replaceAllText", search: op.search, replacements: count });
      } else {
        // append/prepend: structural modifications require read + create workflow
        appliedOps.push({
          type: op.type,
          status: "advisory",
          message: "The docx library creates new documents. For structural append/prepend, use read_document to extract content, then create_document with combined content."
        });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ outputPath: resolvedOutput, operations: appliedOps }, null, 2) }] };
  }
);

// ── Tool 4: merge_documents ──────────────────────────────────────────────────

server.registerTool(
  "merge_documents",
  {
    description: "Combine multiple .docx files into a single document with optional section breaks between them.",
    inputSchema: {
      files: z.array(z.string()).min(2).describe("Array of absolute paths to .docx files to merge."),
      outputPath: z.string().describe("Absolute path for the merged output .docx file."),
      sectionBreaks: z.boolean().optional().describe("Insert page/section breaks between documents. Default true.")
    }
  },
  async ({ files, outputPath, sectionBreaks = true }) => {
    const sections = [];

    for (let i = 0; i < files.length; i++) {
      const resolvedFile = path.resolve(files[i]);
      const fileBuffer = await fs.readFile(resolvedFile);
      const htmlResult = await mammoth.convertToHtml({ buffer: fileBuffer });
      const textResult = await mammoth.extractRawText({ buffer: fileBuffer });

      // Build paragraphs from extracted text
      const paragraphs = textResult.value.split("\n").map((line) =>
        new Paragraph({
          children: [new TextRun({ text: line, font: "Times New Roman", size: 24 })]
        })
      );

      const sectionProps = {};
      if (sectionBreaks && i > 0) {
        sectionProps.type = SectionType.NEXT_PAGE;
      }

      sections.push({
        properties: sectionProps,
        children: paragraphs
      });
    }

    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    const resolvedOutput = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(resolvedOutput, buffer);

    const result = {
      outputPath: resolvedOutput,
      mergedFiles: files.length,
      files: files.map((f) => path.resolve(f))
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool 5: export_document ──────────────────────────────────────────────────

server.registerTool(
  "export_document",
  {
    description: "Export a .docx file to PDF using LibreOffice CLI (soffice --headless).",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .docx file to export."),
      outputPath: z.string().describe("Absolute path for the output PDF file.")
    }
  },
  async ({ filePath, outputPath: requestedOutput }) => {
    const resolvedInput = path.resolve(filePath);
    const resolvedOutput = path.resolve(requestedOutput);
    const outDir = path.dirname(resolvedOutput);

    await fs.mkdir(outDir, { recursive: true });

    try {
      await execFileAsync("soffice", [
        "--headless",
        "--convert-to", "pdf",
        "--outdir", outDir,
        resolvedInput
      ], { timeout: 60000 });
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "LibreOffice conversion failed. Ensure soffice is installed and on PATH.",
            details: err.message
          }, null, 2)
        }]
      };
    }

    // LibreOffice names the output based on input filename; rename if needed
    const expectedName = path.basename(resolvedInput, path.extname(resolvedInput)) + ".pdf";
    const expectedPath = path.join(outDir, expectedName);
    if (expectedPath !== resolvedOutput) {
      try {
        await fs.rename(expectedPath, resolvedOutput);
      } catch {
        // If rename fails, the file may already be at the right place
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ outputPath: resolvedOutput, source: resolvedInput }, null, 2)
      }]
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
