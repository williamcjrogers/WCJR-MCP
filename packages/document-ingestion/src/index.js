import path from "node:path";
import { createRequire } from "node:module";

import mammoth from "mammoth";
import Tesseract from "tesseract.js";

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

async function extractHtml(buffer) {
  return stripMarkup(buffer.toString("utf-8"));
}

export async function extractDocumentText({
  buffer,
  fileName = "",
  contentType = "",
  maxChars = 50000
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
