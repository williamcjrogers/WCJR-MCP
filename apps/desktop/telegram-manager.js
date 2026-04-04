function normalizeWhitespace(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function shortenInline(text, maxChars = 280) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function cleanTelegramManagerText(text) {
  return String(text ?? "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const IGNORE_LINE_PATTERNS = [
  /^i reviewed the specialist outputs/i,
  /^here'?s the concise final synthesis/i,
  /^what i need from you/i,
  /^core conclusion$/i,
  /^main evidence/i,
  /^what i can conclude/i,
  /^what i cannot/i,
  /^workflow completed across/i,
  /^task status:/i,
  /^source result:/i,
  /^user request:/i,
  /^the folder contained \d+ documents?:?$/i,
  /^there (?:were|are) \d+ documents?:?$/i
];

const BAD_REPLY_PATTERNS = [
  /specialist outputs/i,
  /concise final synthesis/i,
  /what i need from you/i,
  /upload the files/i,
  /email them to the connected mailbox/i,
  /i can[’']?t access the local path/i,
  /review the legal contents yet/i,
  /plain-english summary of each agreement/i
];

function shouldIgnoreHighlight(line) {
  return (
    IGNORE_LINE_PATTERNS.some((pattern) => pattern.test(line)) ||
    /\.(docx?|pdf|txt|md|rtf|html?)$/i.test(line)
  );
}

export function extractTelegramHighlights(text, maxItems = 3) {
  const cleaned = cleanTelegramManagerText(text);
  if (!cleaned) {
    return [];
  }

  const lines = cleaned
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/^[-*]\s+/, "")
        .replace(/^[0-9]+\.\s+/, "")
        .trim()
    )
    .filter((line) => line && !shouldIgnoreHighlight(line));

  const highlights = [];
  for (const line of lines) {
    const parts = line
      .split(/(?<=[.!?])\s+/)
      .map((part) => shortenInline(part, 220))
      .filter((part) => part && !shouldIgnoreHighlight(part));
    for (const part of parts) {
      highlights.push(part);
      if (highlights.length >= maxItems) {
        return highlights;
      }
    }
  }

  return highlights.slice(0, maxItems);
}

function isDocumentReviewRequest(requestText = "", summaryText = "") {
  const text = `${requestText}\n${summaryText}`;
  return /\b(agreement|agreements|contract|contracts|docx|pdf|redline|renewal|termination|review the documents|review the agreements)\b/i.test(text);
}

function isCodeRequest(requestText = "", summaryText = "") {
  const text = `${requestText}\n${summaryText}`;
  return /\b(code|repo|repository|test|tests|bug|fix|refactor|build)\b/i.test(text);
}

function isCommunicationRequest(requestText = "", summaryText = "") {
  const text = `${requestText}\n${summaryText}`;
  return /\b(email|mail|calendar|meeting|reply|draft)\b/i.test(text);
}

function extractDocumentCount(text = "") {
  const match =
    String(text ?? "").match(/\b(?:contained|contains|found|reviewed)\s+(\d+)\s+(?:documents?|files?)\b/i) ??
    String(text ?? "").match(/\bthere (?:were|are)\s+(\d+)\s+(?:documents?|files?)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function buildOutcome(requestText = "", summaryText = "") {
  const docCount = extractDocumentCount(summaryText);

  if (isDocumentReviewRequest(requestText, summaryText)) {
    if (docCount && Number.isFinite(docCount)) {
      return `Update: The ${docCount} document${docCount === 1 ? "" : "s"} have been reviewed and analysed, and a synthesised summary is ready.`;
    }
    return "Update: The documents have been reviewed and analysed, and a synthesised summary is ready.";
  }

  if (isCodeRequest(requestText, summaryText)) {
    return "Update: The code task has been completed and the result is ready for review.";
  }

  if (isCommunicationRequest(requestText, summaryText)) {
    return "Update: The communication task has been completed and the output is ready.";
  }

  return "Update: The task has been completed and the result is ready.";
}

function buildMainPoint(requestText = "", summaryText = "") {
  const highlights = extractTelegramHighlights(summaryText, 6);
  const outcome = normalizeWhitespace(buildOutcome(requestText, summaryText).replace(/^Update:\s*/i, ""));

  for (const highlight of highlights) {
    const normalized = normalizeWhitespace(highlight);
    if (!normalized) {
      continue;
    }
    if (normalized.toLowerCase() === outcome.toLowerCase()) {
      continue;
    }
    if (/^(outcome|what matters|next step):/i.test(normalized)) {
      continue;
    }
    if (BAD_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
      continue;
    }
    return `Main point: ${shortenInline(normalized, 220)}`;
  }

  return "";
}

function buildNextStep(requestText = "", summaryText = "") {
  if (isDocumentReviewRequest(requestText, summaryText)) {
    return "Next step: tell me whether you want the key risks, a document-by-document summary, a comparison, or draft amendments.";
  }

  if (isCodeRequest(requestText, summaryText)) {
    return "Next step: tell me whether you want the exact changes, the test result, or the next implementation pass.";
  }

  if (isCommunicationRequest(requestText, summaryText)) {
    return "Next step: tell me whether you want the draft, the main points only, or a follow-up prepared.";
  }

  return "Next step: tell me whether you want the detail, the main risks, or the next pass.";
}

function shouldIncludeMainPoint(requestText = "", summaryText = "") {
  if (isDocumentReviewRequest(requestText, summaryText)) {
    return false;
  }

  if (isCodeRequest(requestText, summaryText)) {
    return false;
  }

  if (isCommunicationRequest(requestText, summaryText)) {
    return false;
  }

  return true;
}

export function isUsableTelegramManagerReply(text) {
  const cleaned = cleanTelegramManagerText(text);
  if (!cleaned) {
    return false;
  }
  if (cleaned.length > 500) {
    return false;
  }
  if (/^\s*[-*]\s+/m.test(cleaned) || /^\s*\d+\.\s+/m.test(cleaned)) {
    return false;
  }
  if (cleaned.split(/\n+/).length > 4) {
    return false;
  }
  return !BAD_REPLY_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function buildTelegramManagerFallback({ requestText, summary }) {
  if (summary?.pendingApproval) {
    return [
      "Update: I have a plan ready, but execution has not started yet.",
      "Blocker: this run is waiting for approval in the desktop app.",
      "Next step: approve it in the app and I will carry it through."
    ].join("\n\n");
  }

  if (summary?.error) {
    return [
      "Update: I hit a blocker and could not finish the task cleanly.",
      `Blocker: ${shortenInline(summary.error, 320) || "Unknown error."}`,
      "Next step: adjust the request or retry after clearing the blocker."
    ].join("\n\n");
  }

  const summaryText = cleanTelegramManagerText(summary?.content ?? "");
  const outcome = buildOutcome(requestText, summaryText);
  const mainPoint = buildMainPoint(requestText, summaryText);
  const nextStep = buildNextStep(requestText, summaryText);

  return [
    outcome,
    shouldIncludeMainPoint(requestText, summaryText) ? mainPoint : "",
    nextStep
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildTelegramManagerText({ requestText, summary }) {
  return buildTelegramManagerFallback({ requestText, summary });
}
