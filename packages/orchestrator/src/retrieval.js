function flattenToolResult(result) {
  if (!result?.content?.length) {
    return "";
  }

  return result.content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "resource") {
        return item.resource?.text ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function shorten(text, maxChars = 4000) {
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function clampMaxChars(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(50000, Math.max(500, parsed));
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "from",
  "have",
  "into",
  "just",
  "need",
  "please",
  "should",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your"
]);

const DOCUMENT_FILE_PATTERN = /\.(docx?|pdf|txt|md|rtf|html?)$/i;

function tokenizePrompt(prompt) {
  return [...new Set(
    String(prompt ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9:/._\\-]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token))
  )].slice(0, 8);
}

function extractSearchHint(prompt) {
  const quotedSearch =
    String(prompt).match(/search(?: for)? ["“]([^"”]+)["”]/i) ??
    String(prompt).match(/find (?:mentions of |references to )["“]([^"”]+)["”]/i);

  return quotedSearch?.[1]?.trim() ?? null;
}

function extractUrlHints(prompt) {
  return [...String(prompt ?? "").matchAll(/https?:\/\/[^\s)]+/gi)]
    .map((match) => match[0])
    .slice(0, 3);
}

function extractPathHints(prompt) {
  const seen = new Set();
  const patterns = [
    /`([^`]+)`/g,
    /"([A-Za-z]:\\[^"]+)"/g,
    /'([A-Za-z]:\\[^']+)'/g,
    /([A-Za-z]:\\[^\s"'`]+)/g,
    /([.]{1,2}[\\/][^\s"'`]+)/g,
    /((?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)\b/g,
    /(?:^|[\s(])([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),])/g
  ];

  for (const pattern of patterns) {
    for (const match of String(prompt ?? "").matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        seen.add(candidate);
      }
    }
  }

  const ordered = [...seen];
  const filtered = ordered.filter((candidate) => {
    const normalizedCandidate = candidate.replace(/\\/g, "/").toLowerCase();
    if (
      /[\\/]/.test(candidate) &&
      ordered.some(
        (other) =>
          other !== candidate &&
          other.replace(/\\/g, "/").toLowerCase().startsWith(`${normalizedCandidate} `)
      )
    ) {
      return false;
    }
    if (/[\\/]/.test(candidate)) {
      return true;
    }
    const lowerCandidate = candidate.toLowerCase();
    return !ordered.some(
      (other) =>
        other !== candidate &&
        /[\\/]/.test(other) &&
        other.replace(/\\/g, "/").toLowerCase().endsWith(`/${lowerCandidate}`)
    );
  });

  return filtered.slice(0, 4);
}

function extractMaxCharsHint(prompt, fallback = 50000) {
  const patterns = [
    /"maxChars"\s*:\s*(\d{3,6})/i,
    /'maxChars'\s*:\s*(\d{3,6})/i,
    /\bmaxChars\b\s*[:=]?\s*(\d{3,6})/i,
    /\bup to\s+(\d{3,6})\s+chars?\b/i
  ];

  for (const pattern of patterns) {
    const match = String(prompt ?? "").match(pattern);
    if (match?.[1]) {
      return clampMaxChars(match[1], fallback);
    }
  }

  return fallback;
}

function joinCandidatePath(basePath, entryName) {
  const separator = String(basePath ?? "").includes("\\") ? "\\" : "/";
  return `${String(basePath ?? "").replace(/[\\/]+$/, "")}${separator}${entryName}`;
}

function extractFilePathsFromDirectoryListing(basePath, listingText) {
  // filesystem-mcp list_directory format (since 2026-04-11):
  //   FILE <mtime-iso> <size> <name>
  //   DIR  -           -      <name>
  // Legacy format was `FILE <name>`. Handle both: strip the FILE prefix and,
  // if the remainder has 3+ whitespace-separated tokens, drop the first two
  // (mtime + size) and keep the rest as the filename.
  return String(listingText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^FILE\s+/i.test(line))
    .map((line) => {
      const rest = line.replace(/^FILE\s+/i, "").trim();
      const tokens = rest.split(/\s+/);
      if (tokens.length >= 3) {
        // New format: mtime, size, name (name may contain spaces, so rejoin)
        return tokens.slice(2).join(" ").trim();
      }
      return rest;
    })
    .filter((name) => DOCUMENT_FILE_PATTERN.test(name))
    .map((name) => joinCandidatePath(basePath, name))
    .slice(0, 8);
}

function buildSearchPhrase(prompt, tokens) {
  const explicit = extractSearchHint(prompt);
  if (explicit) {
    return explicit;
  }
  if (tokens.length > 0) {
    return tokens.slice(0, 4).join(" ");
  }
  return cleanText(prompt).slice(0, 120);
}

function scoreText(tokens, ...parts) {
  const haystack = parts.join(" ").toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${result.source}:${result.locator ?? result.title ?? result.snippet.slice(0, 80)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function renderResult(result, index, maxChars = 1800) {
  const title = result.title ? `${result.title}` : result.locator;
  const locator = result.locator && result.locator !== title ? ` | ${result.locator}` : "";
  return [
    `${index + 1}. [${result.source}] ${title}${locator}`,
    shorten(result.snippet, maxChars)
  ]
    .filter(Boolean)
    .join("\n");
}

function getRetrievalRenderLimit({ prompt, taskType, results }) {
  const explicitPaths = extractPathHints(prompt);
  const requestedMaxChars = extractMaxCharsHint(
    prompt,
    explicitPaths.length > 0 ? 30000 : 8000
  );

  if (taskType === "documents") {
    if (explicitPaths.length > 0 && results.length <= 3) {
      return requestedMaxChars;
    }
    return Math.max(4000, Math.min(requestedMaxChars, 10000));
  }

  if (taskType === "communication" && results.some((result) => result.source === "outlook_attachment")) {
    return Math.max(4000, Math.min(requestedMaxChars, 12000));
  }

  return 1800;
}

function pickLookeenServer(serverContexts = []) {
  return serverContexts.find(
    (server) =>
      (server.name ?? "").toLowerCase().includes("lookeen") ||
      (server.tools ?? []).includes("get_text") && (server.tools ?? []).includes("search")
  );
}

function buildLookeenQuery(prompt, searchPhrase) {
  const base = cleanText(searchPhrase);
  if (!base) {
    return "";
  }
  if (/\battach(?:ed|ment|ments)\b/i.test(prompt)) {
    return `${base} type:attachment`;
  }
  if (/\b(email|emails|mail|message|messages|inbox)\b/i.test(prompt)) {
    return `${base} type:mail`;
  }
  if (/\b(calendar|meeting|meetings|appointment|appointments|event|events)\b/i.test(prompt)) {
    return `${base} type:calendar`;
  }
  if (/\b(file|files|document|documents|contract|agreement|pdf|docx)\b/i.test(prompt)) {
    return `${base} type:file`;
  }
  return base;
}

function looksLikeLookeenErrorText(text) {
  return /^(?:Backend error:|Unable to load text\b)/i.test(cleanText(text));
}

function extractLookeenDocuments(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.documents)) {
    return payload.documents;
  }
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.value)) {
    return payload.value;
  }
  return [];
}

function promptLooksLikeCalendarRequest(prompt) {
  return /\b(calendar|schedule|meeting|meetings|event|events|appointments?)\b/i.test(prompt);
}

function getCalendarRange(prompt) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (/\btomorrow\b/i.test(prompt)) {
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 1);
  } else if (/\btoday\b/i.test(prompt)) {
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 1);
  } else {
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 7);
  }
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

async function collectMemoryResults({ memoryItems, promptTokens }) {
  return (memoryItems ?? [])
    .map((memory) => ({
      source: "memory",
      title: memory.category ?? "memory",
      locator: memory.id ?? memory.content?.slice(0, 40) ?? "memory",
      snippet: cleanText(memory.content),
      score: scoreText(promptTokens, memory.content, memory.category, ...(memory.tags ?? []))
    }))
    .filter((item) => item.snippet);
}

async function collectLookeenResults({
  server,
  mcpHub,
  prompt,
  searchPhrase,
  promptTokens,
  emitStatus,
  toolActivity
}) {
  if (!server?.name || !(server.tools ?? []).includes("search")) {
    return [];
  }

  emitStatus?.("Searching indexed files...");
  try {
    const lookeenQuery = buildLookeenQuery(prompt, searchPhrase);
    if (!lookeenQuery) {
      return [];
    }
    const searchResult = await mcpHub.callTool(server.name, "search", {
      query: lookeenQuery
    });
    toolActivity.push({
      server: server.name,
      tool: "search",
      detail: lookeenQuery
    });
    const searchText = flattenToolResult(searchResult);
    if (searchResult?.isError || looksLikeLookeenErrorText(searchText)) {
      toolActivity.push({
        server: server.name,
        tool: "search",
        detail: cleanText(searchText) || "Lookeen search failed.",
        status: "error"
      });
      return [];
    }
    const payload = safeJsonParse(searchText);
    const items = extractLookeenDocuments(payload);

    const ranked = items
      .map((item) => ({
        uri: item.uri ?? item.id ?? item.documentUri ?? item.path ?? null,
        title: item.name ?? item.title ?? item.subject ?? item.preview ?? item.path ?? item.uri ?? "Lookeen result",
        locator: item.path ?? item.uri ?? item.id ?? null,
        score: scoreText(
          promptTokens,
          item.name,
          item.title,
          item.subject,
          item.preview,
          item.path,
          item.uri,
          item.itemType,
          item.mimeType,
          item.from?.name,
          item.from?.email,
          ...(item.to ?? []).map((entry) => entry?.name ?? entry?.email ?? ""),
          ...(item.attachmentNames ?? [])
        ),
        snippet: cleanText(item.preview ?? item.snippet ?? item.body ?? item.path ?? "")
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const results = [];
    for (const item of ranked) {
      if (!item.uri || !(server.tools ?? []).includes("get_text")) {
        results.push({ source: "lookeen", ...item });
        continue;
      }

      try {
        const textResult = await mcpHub.callTool(server.name, "get_text", { uri: item.uri });
        toolActivity.push({
          server: server.name,
          tool: "get_text",
          detail: item.uri
        });
        const extractedText = cleanText(flattenToolResult(textResult));
        if (!extractedText || textResult?.isError || looksLikeLookeenErrorText(extractedText)) {
          results.push({ source: "lookeen", ...item });
          continue;
        }
        results.push({
          source: "lookeen",
          title: item.title,
          locator: item.locator ?? item.uri,
          snippet: extractedText,
          score: item.score + 2
        });
      } catch (error) {
        toolActivity.push({
          server: server.name,
          tool: "get_text",
          detail: `${item.uri} (${error instanceof Error ? error.message : String(error)})`,
          status: "error"
        });
        results.push({ source: "lookeen", ...item });
      }
    }
    return results.filter((item) => item.snippet);
  } catch (error) {
    toolActivity.push({
      server: server.name,
      tool: "search",
      detail: error instanceof Error ? error.message : String(error),
      status: "error"
    });
    return [];
  }
}

async function collectFilesystemResults({
  server,
  mcpHub,
  prompt,
  promptTokens,
  searchPhrase,
  emitStatus,
  toolActivity
}) {
  if (!server?.name) {
    return [];
  }

  const results = [];
  const explicitPaths = extractPathHints(prompt);
  const documentMaxChars = extractMaxCharsHint(
    prompt,
    explicitPaths.length > 0 ? 50000 : 12000
  );
  const candidatePaths = new Set(explicitPaths);
  const fileNameQueries = [...new Set(
    [searchPhrase, ...promptTokens.slice(0, 3)]
      .map((query) => cleanText(query))
      .filter((query) => query && query.length >= 2)
  )].slice(0, 4);

  if (explicitPaths.length > 0 && (server.tools ?? []).includes("list_directory")) {
    emitStatus?.("Looking in the folder you mentioned...");
    for (const explicitPath of explicitPaths) {
      try {
        const listResult = await mcpHub.callTool(server.name, "list_directory", {
          path: explicitPath
        });
        toolActivity.push({
          server: server.name,
          tool: "list_directory",
          detail: explicitPath
        });
        const listedPaths = extractFilePathsFromDirectoryListing(
          explicitPath,
          flattenToolResult(listResult)
        );
        if (listedPaths.length > 0) {
          candidatePaths.delete(explicitPath);
          for (const filePath of listedPaths) {
            candidatePaths.add(filePath);
          }
        }
      } catch (err) {
        // If the explicit path is a file or list_directory is not applicable, fall through
        // and let extract_document_text attempt direct extraction on the original path.
        console.warn(
          `[retrieval] list_directory fallthrough for '${explicitPath}': ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }
  }

  if (explicitPaths.length === 0 && (server.tools ?? []).includes("search_text_in_files") && searchPhrase) {
    emitStatus?.("Scanning local files for context...");
    try {
      const searchResult = await mcpHub.callTool(server.name, "search_text_in_files", {
        query: searchPhrase,
        maxResults: 6
      });
      toolActivity.push({
        server: server.name,
        tool: "search_text_in_files",
        detail: searchPhrase
      });
      const text = flattenToolResult(searchResult);
      for (const match of text.matchAll(/^\d+\.\s+(.+)$/gm)) {
        candidatePaths.add(match[1].trim());
      }
    } catch (error) {
      toolActivity.push({
        server: server.name,
        tool: "search_text_in_files",
        detail: error instanceof Error ? error.message : String(error),
        status: "error"
      });
    }
  }

  if (candidatePaths.size === 0 && (server.tools ?? []).includes("find_files_by_name")) {
    for (const query of fileNameQueries) {
      try {
        const findResult = await mcpHub.callTool(server.name, "find_files_by_name", {
          query,
          maxResults: 5
        });
        toolActivity.push({
          server: server.name,
          tool: "find_files_by_name",
          detail: query
        });
        const payload = safeJsonParse(flattenToolResult(findResult));
        for (const match of payload?.matches ?? []) {
          if (match?.path) {
            candidatePaths.add(match.path);
          }
        }
      } catch (error) {
        toolActivity.push({
          server: server.name,
          tool: "find_files_by_name",
          detail: `${query} (${error instanceof Error ? error.message : String(error)})`,
          status: "error"
        });
      }
    }
  }

  const paths = [...candidatePaths].slice(0, 6);
  if ((server.tools ?? []).includes("extract_document_text")) {
    emitStatus?.("Reading document contents...");
    for (const filePath of paths) {
      try {
        const extractResult = await mcpHub.callTool(server.name, "extract_document_text", {
          path: filePath,
          maxChars: documentMaxChars
        });
        toolActivity.push({
          server: server.name,
          tool: "extract_document_text",
          detail: filePath
        });
        const payload = safeJsonParse(flattenToolResult(extractResult));
        const text = cleanText(payload?.text ?? "");
        if (!text) {
          continue;
        }
        results.push({
          source: "filesystem",
          title: filePath.split(/[\\/]/).pop() ?? filePath,
          locator: payload?.path ?? filePath,
          snippet: text,
          score: scoreText(promptTokens, filePath, text) + 1
        });
      } catch (error) {
        toolActivity.push({
          server: server.name,
          tool: "extract_document_text",
          detail: `${filePath} (${error instanceof Error ? error.message : String(error)})`,
          status: "error"
        });
      }
    }
  }

  return results;
}

function parseMessageText(text) {
  const cleaned = cleanText(text);
  const [headerBlock, ...bodyParts] = cleaned.split("\n\n");
  const body = bodyParts.join("\n\n");
  const headers = Object.fromEntries(
    headerBlock
      .split("\n")
      .map((line) => {
        const [key, ...rest] = line.split(":");
        return [key?.trim().toLowerCase(), rest.join(":").trim()];
      })
      .filter(([key, value]) => key && value)
  );
  return {
    subject: headers.subject ?? "",
    from: headers.from ?? "",
    body
  };
}

async function collectMailResults({
  server,
  mcpHub,
  prompt,
  promptTokens,
  searchPhrase,
  emitStatus,
  toolActivity
}) {
  if (!server?.name) {
    return [];
  }

  const results = [];
  const mailMaxChars = extractMaxCharsHint(prompt, 30000);

  if ((server.tools ?? []).includes("search_messages") && searchPhrase) {
    emitStatus?.("Searching your mailbox...");
    try {
      const searchResult = await mcpHub.callTool(server.name, "search_messages", {
        query: searchPhrase,
        top: 6
      });
      toolActivity.push({
        server: server.name,
        tool: "search_messages",
        detail: searchPhrase
      });
      const payload = safeJsonParse(flattenToolResult(searchResult));
      const messages = (payload?.messages ?? [])
        .map((message) => ({
          ...message,
          score: scoreText(promptTokens, message.subject, message.from, message.snippet)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      for (const message of messages) {
        try {
          const fullMessage = await mcpHub.callTool(server.name, "get_message", {
            messageId: message.id,
            maxChars: mailMaxChars
          });
          toolActivity.push({
            server: server.name,
            tool: "get_message",
            detail: message.id
          });
          const parsed = parseMessageText(flattenToolResult(fullMessage));
          results.push({
            source: "outlook",
            title: parsed.subject || message.subject || "Mail message",
            locator: message.id,
            snippet: cleanText(parsed.body || message.snippet || ""),
            score: message.score + 1
          });

          if (message.hasAttachments && (server.tools ?? []).includes("list_message_attachments")) {
            const attachmentsResult = await mcpHub.callTool(server.name, "list_message_attachments", {
              messageId: message.id
            });
            toolActivity.push({
              server: server.name,
              tool: "list_message_attachments",
              detail: message.id
            });
            const attachmentsPayload = safeJsonParse(flattenToolResult(attachmentsResult));
            const attachments = (attachmentsPayload?.attachments ?? [])
              .map((attachment) => ({
                ...attachment,
                messageId: message.id,
                score: scoreText(promptTokens, attachment.name, attachment.contentType) + 1
              }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 2);

            for (const attachment of attachments) {
              if (!(server.tools ?? []).includes("get_message_attachment_text")) {
                continue;
              }
              try {
                const attachmentText = await mcpHub.callTool(server.name, "get_message_attachment_text", {
                  messageId: message.id,
                  attachmentId: attachment.id,
                  maxChars: Math.max(12000, Math.min(mailMaxChars, 50000))
                });
                toolActivity.push({
                  server: server.name,
                  tool: "get_message_attachment_text",
                  detail: attachment.name
                });
                const attachmentPayload = safeJsonParse(flattenToolResult(attachmentText));
                const text = cleanText(attachmentPayload?.text ?? "");
                if (!text) {
                  continue;
                }
                results.push({
                  source: "outlook_attachment",
                  title: attachment.name,
                  locator: `${message.id}:${attachment.id}`,
                  snippet: text,
                  score: attachment.score + 2
                });
              } catch (error) {
                toolActivity.push({
                  server: server.name,
                  tool: "get_message_attachment_text",
                  detail: `${attachment.name} (${error instanceof Error ? error.message : String(error)})`,
                  status: "error"
                });
              }
            }
          }
        } catch (error) {
          toolActivity.push({
            server: server.name,
            tool: "get_message",
            detail: `${message.id} (${error instanceof Error ? error.message : String(error)})`,
            status: "error"
          });
        }
      }
    } catch (error) {
      toolActivity.push({
        server: server.name,
        tool: "search_messages",
        detail: error instanceof Error ? error.message : String(error),
        status: "error"
      });
    }
  }

  if (promptLooksLikeCalendarRequest(prompt) && (server.tools ?? []).includes("list_calendar_events")) {
    const range = getCalendarRange(prompt);
    try {
      const calendarResult = await mcpHub.callTool(server.name, "list_calendar_events", range);
      toolActivity.push({
        server: server.name,
        tool: "list_calendar_events",
        detail: `${range.start} -> ${range.end}`
      });
      const text = cleanText(flattenToolResult(calendarResult));
      if (text && !text.startsWith("No events")) {
        results.push({
          source: "calendar",
          title: "Calendar events",
          locator: `${range.start} -> ${range.end}`,
          snippet: text,
          score: scoreText(promptTokens, text) + 1
        });
      }
    } catch (error) {
      toolActivity.push({
        server: server.name,
        tool: "list_calendar_events",
        detail: error instanceof Error ? error.message : String(error),
        status: "error"
      });
    }
  }

  return results;
}

async function collectRagResults({ server, mcpHub, prompt, emitStatus, toolActivity }) {
  // Qdrant-backed RAG. `useRag` is produced by getRetrievalStrategy but was
  // previously never consumed, so the only way to hit the vector index was
  // for the model to voluntarily call the RAG tool. We now auto-inject the
  // top-k chunks for disputes-style profiles before the first turn.
  if (!server?.name) return [];
  const tools = server.tools ?? [];
  const hasKnowledge = tools.includes("knowledge_query");
  const hasRagSearch = tools.includes("rag_search");
  if (!hasKnowledge && !hasRagSearch) return [];

  emitStatus?.("Searching case knowledge base...");
  const toolName = hasKnowledge ? "knowledge_query" : "rag_search";
  try {
    const result = await mcpHub.callTool(server.name, toolName, {
      query: prompt,
      limit: 8
    });
    toolActivity.push({ server: server.name, tool: toolName, detail: `k=8` });
    const flattened = flattenToolResult(result);
    const entries = extractRagEntries(flattened, prompt);
    return entries.slice(0, 8).map((entry, index) => ({
      source: "rag",
      title: entry.title ?? `Knowledge chunk ${index + 1}`,
      locator: entry.locator ?? entry.source ?? `rag:${index}`,
      snippet: cleanText(entry.snippet ?? entry.content ?? ""),
      score: typeof entry.score === "number" ? entry.score : 1 - index * 0.05
    }));
  } catch (error) {
    toolActivity.push({
      server: server.name,
      tool: toolName,
      detail: error instanceof Error ? error.message : String(error),
      status: "error"
    });
    return [];
  }
}

function extractRagEntries(flattened, prompt) {
  if (!flattened) return [];
  // Common shapes the RAG MCP returns: JSON string of `{ results: [...] }`,
  // or a plain text blob. Try JSON first.
  try {
    const parsed = JSON.parse(flattened);
    const candidates =
      Array.isArray(parsed?.results) ? parsed.results
      : Array.isArray(parsed?.hits) ? parsed.hits
      : Array.isArray(parsed) ? parsed
      : [];
    return candidates.map((entry) => ({
      title: entry?.title ?? entry?.source ?? entry?.payload?.source,
      locator: entry?.source ?? entry?.payload?.source ?? entry?.id,
      snippet: entry?.snippet ?? entry?.text ?? entry?.content ?? entry?.payload?.text,
      score: entry?.score ?? entry?.relevance ?? null
    }));
  } catch {
    // Plain-text fallback: treat the whole blob as a single snippet.
    const text = String(flattened).trim();
    if (!text) return [];
    return [
      {
        title: `RAG result for "${prompt.slice(0, 60)}"`,
        locator: null,
        snippet: text,
        score: 0.5
      }
    ];
  }
}

async function collectBrowserResults({ server, mcpHub, urlHints, toolActivity }) {
  if (!server?.name || !(server.tools ?? []).includes("fetch_page_content")) {
    return [];
  }

  const results = [];
  for (const url of urlHints.slice(0, 2)) {
    try {
      const result = await mcpHub.callTool(server.name, "fetch_page_content", {
        url,
        maxChars: 6000
      });
      toolActivity.push({
        server: server.name,
        tool: "fetch_page_content",
        detail: url
      });
      results.push({
        source: "browser",
        title: url,
        locator: url,
        snippet: cleanText(flattenToolResult(result)),
        score: 1
      });
    } catch (error) {
      toolActivity.push({
        server: server.name,
        tool: "fetch_page_content",
        detail: `${url} (${error instanceof Error ? error.message : String(error)})`,
        status: "error"
      });
    }
  }
  return results;
}

export function shouldUseRetrievalContext(prompt, taskType) {
  if (["documents", "research", "communication", "project_mgmt", "data_analysis"].includes(taskType)) {
    return true;
  }
  return /\b(find|search|review|summari|compare|agreement|document|email|attachment|contract|source|folder|file|calendar|meeting|screenshot|image|ocr)\b/i.test(prompt);
}

export async function buildRetrievalContext({
  prompt,
  taskType,
  serverContexts,
  mcpHub,
  emitStatus,
  memoryItems = [],
  strategy = {}
}) {
  if (!shouldUseRetrievalContext(prompt, taskType)) {
    return {
      toolActivity: [],
      contextSections: [],
      retrievalResults: []
    };
  }

  const promptTokens = tokenizePrompt(prompt);
  const searchPhrase = buildSearchPhrase(prompt, promptTokens);
  const urlHints = extractUrlHints(prompt);
  const toolActivity = [];
  const explicitPaths = extractPathHints(prompt);
  const hasExplicitFile = explicitPaths.some((p) => /\.\w{1,8}$/.test(p));

  const filesystemServer = serverContexts.find((server) => server.kind === "builtin-filesystem");
  const mailServer = serverContexts.find((server) => server.kind === "builtin-mail-calendar");
  const browserServer = serverContexts.find((server) => server.kind === "builtin-browser-ops");
  const ragServer = serverContexts.find((server) => server.kind === "builtin-qdrant-rag");
  const lookeenServer = pickLookeenServer(serverContexts);

  // Smart retrieval: only run collectors appropriate for the task
  const useFilesystem = strategy.useFilesystem !== false;
  const useMail = strategy.useMail === true;
  const useWeb = strategy.useWeb === true;
  const useRag = strategy.useRag === true;
  const useLookeen = strategy.useLookeen === true;

  const collectors = [
    collectMemoryResults({ memoryItems, promptTokens })
  ];

  if (useFilesystem || hasExplicitFile) {
    collectors.push(collectFilesystemResults({ server: filesystemServer, mcpHub, prompt, promptTokens, searchPhrase, emitStatus, toolActivity }));
  }
  if (useMail && !hasExplicitFile) {
    collectors.push(collectMailResults({ server: mailServer, mcpHub, prompt, promptTokens, searchPhrase, emitStatus, toolActivity }));
  }
  if (useWeb && !hasExplicitFile) {
    collectors.push(collectBrowserResults({ server: browserServer, mcpHub, urlHints, toolActivity }));
  }
  if (useRag) {
    collectors.push(collectRagResults({ server: ragServer, mcpHub, prompt, emitStatus, toolActivity }));
  }
  if (useLookeen && !hasExplicitFile) {
    collectors.push(collectLookeenResults({ server: lookeenServer, mcpHub, prompt, searchPhrase, promptTokens, emitStatus, toolActivity }));
  }

  const results = dedupeResults(
    (await Promise.all(collectors))
      .flat()
      .filter((item) => item?.snippet)
      .sort((a, b) => b.score - a.score)
  ).slice(0, 6);

  if (results.length === 0) {
    return {
      toolActivity,
      contextSections: [],
      retrievalResults: []
    };
  }

  return {
    toolActivity,
    retrievalResults: results,
    contextSections: [
      (() => {
        const renderLimit = getRetrievalRenderLimit({ prompt, taskType, results });
        return [
          "Brokered retrieval evidence:",
          ...results.map((result, index) => renderResult(result, index, renderLimit))
        ].join("\n\n");
      })()
    ]
  };
}
