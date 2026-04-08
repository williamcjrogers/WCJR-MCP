import path from "node:path";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format an ISO date string as DD Month YYYY.
 * @param {string} isoDate - ISO 8601 date string.
 * @returns {string} Formatted date or the original string if parsing fails.
 */
export function formatDateDDMonthYYYY(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return String(isoDate);
    const day = d.getDate();
    const month = MONTHS[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  } catch {
    return String(isoDate);
  }
}

/**
 * Format a citation string from a Qdrant chunk payload.
 * @param {object} payload - Chunk payload with source, documentType, email fields, etc.
 * @returns {string} Formatted citation in square brackets.
 */
export function formatCitation(payload) {
  const type = (payload.documentType ?? "").toLowerCase();
  const filename = path.basename(payload.source ?? "unknown");

  if (type === "email" || type === "msg" || type === "eml") {
    const date = formatDateDDMonthYYYY(payload.emailDate);
    const from = payload.emailFrom || "Unknown";
    const to = payload.emailTo || "Unknown";
    const subject = payload.emailSubject || "(no subject)";
    return `[Email: ${from} to ${to}, ${date}, Subject: "${subject}"]`;
  }

  if (type === "contract" || type === "docx" || type === "pdf") {
    const loc = payload.headingPath || payload.section || "";
    const page = payload.page ? `, p.${payload.page}` : "";
    return `[${filename}${loc ? ", " + loc : ""}${page}]`;
  }

  if (type === "drawing") {
    return `[Drawing: ${filename}]`;
  }

  if (type === "xlsx" || type === "valuation") {
    const sheet = payload.section ? `, Sheet: ${payload.section}` : "";
    return `[${filename}${sheet}]`;
  }

  const page = payload.page ? `, p.${payload.page}` : "";
  return `[${filename}${page}]`;
}
