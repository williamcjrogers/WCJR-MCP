#!/usr/bin/env node

/**
 * Browser / web operations MCP server. Fallback when no native API is available.
 * Fetches page content; can be extended with Playwright for JS-rendered pages and screenshots.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

function stripHtml(html, maxChars = 50000) {
  if (!html || typeof html !== "string") return "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n[truncated]";
}

function isBlockedIpv4(host) {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
  );
}

function isBlockedIpv6(host) {
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export function isBlockedAddress(host = "") {
  if (!host) {
    return true;
  }
  const normalized = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal"
  ) {
    return true;
  }
  const ipType = net.isIP(normalized);
  if (ipType === 4) {
    return isBlockedIpv4(normalized);
  }
  if (ipType === 6) {
    return isBlockedIpv6(normalized);
  }
  return false;
}

export async function assertSafeFetchUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedAddress(hostname)) {
    throw new Error(`Blocked internal address: ${hostname}`);
  }

  try {
    const lookups = await dns.lookup(hostname, { all: true, verbatim: true });
    if (lookups.some((entry) => isBlockedAddress(entry.address))) {
      throw new Error(`Blocked internal address: ${hostname}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /Blocked internal address/i.test(error.message)
    ) {
      throw error;
    }
    // If DNS lookup fails, allow fetch to surface the normal network error.
  }
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

export async function fetchWithSafeRedirects(
  url,
  { fetchImpl = fetch, maxRedirects = 5, ...options } = {}
) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafeFetchUrl(currentUrl);
    const response = await fetchImpl(currentUrl, {
      ...options,
      redirect: "manual"
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    if (redirectCount === maxRedirects) {
      throw new Error(`Too many redirects for ${url}`);
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects for ${url}`);
}

const server = new McpServer({
  name: "wcjr-browser-ops",
  version: "0.1.0"
});

server.registerTool(
  "fetch_page_content",
  {
    description: "Fetch a URL and return its text content (HTML stripped). Use when no native API exists. Does not execute JavaScript.",
    inputSchema: {
      url: z.string().url().describe("Full URL to fetch."),
      maxChars: z.number().int().min(1000).max(100000).optional().default(30000)
    }
  },
  async ({ url, maxChars }) => {
    try {
      const res = await fetchWithSafeRedirects(url, {
        headers: { "User-Agent": "WCJR-Assistant/1.0 (Desktop operations assistant)" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `HTTP ${res.status}: ${url}` }]
        };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const html = await res.text();
      const text = contentType.includes("json")
        ? html.slice(0, maxChars)
        : stripHtml(html, maxChars);
      return {
        content: [{ type: "text", text: `URL: ${url}\n\n${text}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to fetch ${url}: ${err.message ?? String(err)}` }]
      };
    }
  }
);

server.registerTool(
  "fetch_page_raw",
  {
    description: "Fetch a URL and return raw response text (e.g. JSON or HTML).",
    inputSchema: {
      url: z.string().url(),
      maxChars: z.number().int().min(1000).max(100000).optional().default(20000)
    }
  },
  async ({ url, maxChars }) => {
    try {
      const res = await fetchWithSafeRedirects(url, {
        headers: { "User-Agent": "WCJR-Assistant/1.0" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `HTTP ${res.status}: ${url}` }]
        };
      }
      const text = await res.text();
      const out = text.length <= maxChars ? text : text.slice(0, maxChars) + "\n[truncated]";
      return {
        content: [{ type: "text", text: `URL: ${url}\n\n${out}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed: ${err.message ?? String(err)}` }]
      };
    }
  }
);

export async function startBrowserOpsServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  await startBrowserOpsServer();
}
