import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import XLSX from "xlsx";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".eml",
  ".ics",
  ".json",
  ".log",
  ".md",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const HTML_EXTENSIONS = new Set([
  ".htm",
  ".html"
]);

const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

function normalizeWhitespace(text) {
  return String(text ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`,
    truncated: true
  };
}

function stripMarkup(text) {
  return String(text ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]{2,}/g, " ");
}

export function guessDocumentKind(fileName = "", contentType = "") {
  const extension = path.extname(fileName).toLowerCase();
  const type = String(contentType ?? "").toLowerCase();

  if (extension === ".pst" || type.includes("vnd.ms-outlook-pst")) {
    return "pst";
  }
  if (extension === ".msg" || type.includes("vnd.ms-outlook")) {
    return "msg";
  }
  if (extension === ".xlsx" || extension === ".xls" || type.includes("spreadsheetml") || type.includes("ms-excel")) {
    return "xlsx";
  }
  if (extension === ".docx" || type.includes("wordprocessingml")) {
    return "docx";
  }
  if (extension === ".pdf" || type.includes("pdf")) {
    return "pdf";
  }
  if (IMAGE_EXTENSIONS.has(extension) || type.startsWith("image/")) {
    return "image";
  }
  if (HTML_EXTENSIONS.has(extension) || type.includes("html")) {
    return "html";
  }
  if (
    TEXT_EXTENSIONS.has(extension) ||
    type.startsWith("text/") ||
    type.includes("message/rfc822") ||
    type.includes("json") ||
    type.includes("xml")
  ) {
    return "text";
  }
  return "unknown";
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

async function extractPdf(buffer) {
  const result = await pdfParse(buffer);
  return result.text ?? "";
}

async function extractImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng");
  return result?.data?.text ?? "";
}

async function extractXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }
  }
  return sheets.join("\n\n");
}

async function extractHtml(buffer) {
  return stripMarkup(buffer.toString("utf-8"));
}

async function extractPst(buffer) {
  const { PSTFile } = await import("pst-extractor");
  const tmpPath = path.join(os.tmpdir(), `wcjr-pst-${Date.now()}-${Math.random().toString(36).slice(2)}.pst`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const pstFile = new PSTFile(tmpPath);
    const emails = [];

    function processFolder(folder) {
      if (folder.hasSubfolders) {
        const children = folder.getSubFolders();
        for (const child of children) {
          processFolder(child);
        }
      }
      if (folder.contentCount > 0) {
        let email = folder.getNextChild();
        while (email !== null) {
          const parts = [];
          if (email.senderName) parts.push(`From: ${email.senderName}`);
          if (email.displayTo) parts.push(`To: ${email.displayTo}`);
          if (email.messageDeliveryTime) parts.push(`Date: ${email.messageDeliveryTime}`);
          if (email.subject) parts.push(`Subject: ${email.subject}`);
          if (email.body) parts.push(`\n${email.body}`);
          if (parts.length) emails.push(parts.join("\n"));
          email = folder.getNextChild();
        }
      }
    }

    processFolder(pstFile.getRootFolder());
    return emails.join("\n\n---\n\n");
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
  }
}

async function extractMsg(buffer) {
  const { default: MsgReader } = await import("msgreader");
  const reader = new MsgReader(new Uint8Array(buffer));
  const data = reader.getFileData();

  if (data.error) {
    throw new Error(`MSG parse error: ${data.error}`);
  }

  const parts = [];
  if (data.senderName || data.senderEmail) {
    parts.push(`From: ${data.senderName || ""}${data.senderEmail ? ` <${data.senderEmail}>` : ""}`);
  }
  if (data.recipients && data.recipients.length) {
    parts.push(`To: ${data.recipients.map(r => r.name || r.email || "").join(", ")}`);
  }
  if (data.headers) {
    const dateMatch = String(data.headers).match(/Date:\s*(.+)/i);
    if (dateMatch) parts.push(`Date: ${dateMatch[1].trim()}`);
  }
  if (data.subject) parts.push(`Subject: ${data.subject}`);
  if (data.body) parts.push(`\n${data.body}`);

  return parts.join("\n") || "";
}

export async function extractDocumentText({
  buffer,
  fileName = "",
  contentType = "",
  maxChars = 500000
}) {
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const kind = guessDocumentKind(fileName, contentType);
  const warnings = [];

  try {
    let rawText = "";
    let method = null;

    switch (kind) {
      case "text":
        rawText = inputBuffer.toString("utf-8");
        method = "utf8";
        break;
      case "xlsx":
        rawText = await extractXlsx(inputBuffer);
        method = "xlsx";
        break;
      case "docx":
        rawText = await extractDocx(inputBuffer);
        method = "mammoth";
        break;
      case "pdf":
        rawText = await extractPdf(inputBuffer);
        method = "pdf-parse";
        break;
      case "image":
        rawText = await extractImage(inputBuffer);
        method = "tesseract";
        break;
      case "html":
        rawText = await extractHtml(inputBuffer);
        method = "html-strip";
        break;
      case "pst":
        rawText = await extractPst(inputBuffer);
        method = "pst-extractor";
        break;
      case "msg":
        rawText = await extractMsg(inputBuffer);
        method = "msgreader";
        break;
      default:
        warnings.push("Unsupported file type for structured extraction.");
        break;
    }

    const normalizedText = normalizeWhitespace(rawText);
    if (!normalizedText) {
      warnings.push("No readable text extracted.");
    }
    const truncated = truncateText(normalizedText, maxChars);
    return {
      kind,
      method,
      text: truncated.text ?? "",
      truncated: truncated.truncated,
      warnings
    };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return {
      kind,
      method: null,
      text: "",
      truncated: false,
      warnings
    };
  }
}

export async function extractDocumentStructured({
  buffer,
  fileName = "",
  contentType = "",
  maxChars = 500000
}) {
  const kind = guessDocumentKind(fileName, contentType);

  if (kind === "docx") {
    const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    const warnings = [];

    try {
      const htmlResult = await mammoth.convertToHtml({ buffer: inputBuffer });
      const html = htmlResult.value ?? "";

      // Extract headings
      const headings = [];
      const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
      let match;
      while ((match = headingRegex.exec(html)) !== null) {
        headings.push({
          level: parseInt(match[1], 10),
          text: stripMarkup(match[2]).trim()
        });
      }

      // Extract tables
      const tables = [];
      const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
      while ((match = tableRegex.exec(html)) !== null) {
        const tableHtml = match[1];
        const rows = [];
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
          const cells = [];
          const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
          let cellMatch;
          while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            cells.push(stripMarkup(cellMatch[1]).trim());
          }
          if (cells.length) rows.push(cells);
        }
        if (rows.length) tables.push(rows);
      }

      // Also get plain text for the text field
      const rawResult = await mammoth.extractRawText({ buffer: inputBuffer });
      const rawText = normalizeWhitespace(rawResult.value ?? "");
      const truncated = truncateText(rawText, maxChars);

      if (htmlResult.messages && htmlResult.messages.length) {
        for (const msg of htmlResult.messages) {
          warnings.push(msg.message);
        }
      }

      return {
        kind,
        method: "mammoth-structured",
        text: truncated.text ?? "",
        truncated: truncated.truncated,
        structure: { headings, tables },
        warnings
      };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return {
        kind,
        method: null,
        text: "",
        truncated: false,
        structure: null,
        warnings
      };
    }
  }

  // Non-DOCX: fall back to plain extraction
  const result = await extractDocumentText({ buffer, fileName, contentType, maxChars });
  return { ...result, structure: null };
}

/**
 * Strip RE:/FW:/Fwd: prefixes from a subject and produce a simple hash for threading.
 * @param {string} subject
 * @returns {{ normalised: string, threadId: string }}
 */
export function normaliseSubjectForThreading(subject) {
  const normalised = String(subject ?? "")
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/gi, "")
    .trim();
  const threadId = createHash("sha256").update(normalised.toLowerCase()).digest("hex").slice(0, 16);
  return { normalised, threadId };
}

/**
 * Extract structured email metadata from .msg or .eml files.
 * @param {{ buffer: Buffer, fileName: string }} params
 * @returns {Promise<{ from: string, to: string, cc: string, date: string, subject: string, body: string, threadId: string } | null>}
 */
export async function extractEmailMetadata({ buffer, fileName }) {
  const ext = path.extname(fileName ?? "").toLowerCase();
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);

  if (ext === ".msg") {
    const { default: MsgReader } = await import("msgreader");
    const reader = new MsgReader(new Uint8Array(inputBuffer));
    const data = reader.getFileData();
    if (data.error) throw new Error(`MSG parse error: ${data.error}`);

    const from = [data.senderName, data.senderEmail ? `<${data.senderEmail}>` : ""]
      .filter(Boolean).join(" ");
    const to = (data.recipients ?? [])
      .filter((r) => !r.recipType || r.recipType === 1)
      .map((r) => r.name || r.email || "")
      .join(", ");
    const cc = (data.recipients ?? [])
      .filter((r) => r.recipType === 2)
      .map((r) => r.name || r.email || "")
      .join(", ");

    let date = "";
    if (data.headers) {
      const dateMatch = String(data.headers).match(/Date:\s*(.+)/i);
      if (dateMatch) date = dateMatch[1].trim();
    }

    const subject = data.subject ?? "";
    const body = data.body ?? "";
    const { threadId } = normaliseSubjectForThreading(subject);

    return { from, to, cc, date, subject, body, threadId };
  }

  if (ext === ".eml") {
    const raw = inputBuffer.toString("utf-8");

    // Split headers from body at first double newline
    const headerBodySplit = raw.indexOf("\n\n");
    const headerBlock = headerBodySplit >= 0 ? raw.slice(0, headerBodySplit) : raw;
    const body = headerBodySplit >= 0 ? raw.slice(headerBodySplit + 2).trim() : "";

    // Unfold continuation lines (RFC 2822)
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");

    const getHeader = (name) => {
      const match = unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
      return match ? match[1].trim() : "";
    };

    const from = getHeader("From");
    const to = getHeader("To");
    const cc = getHeader("Cc");
    const date = getHeader("Date");
    const subject = getHeader("Subject");
    const { threadId } = normaliseSubjectForThreading(subject);

    return { from, to, cc, date, subject, body, threadId };
  }

  return null;
}
