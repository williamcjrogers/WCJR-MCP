# Five-gap expansion plan for wcjr-mcp-assistant

The monorepo gains local inference, a second messaging channel, workflow automation, vastly broader MCP tool reach, and semantic document retrieval — all deployable on the HP Z4 G5 with a single `docker compose up`. Every code block below is ESM JavaScript that slots into the existing provider-adapter and MCP-hub patterns. The unified docker-compose at the end ties all infrastructure services together.

---

## Gap 1 — Ollama turns the RTX A4000 into a local model provider

Ollama exposes a fully OpenAI-compatible endpoint at `http://localhost:11434/v1/chat/completions` that accepts streaming, `tools`, and `tool_choice` in the same delta-chunk format the monorepo's `openaiCompatibleStream()` already consumes. The health-check endpoint is a plain `GET /` returning the string `Ollama is running`. Because the adapter interface only requires `listModels(apiKey)` and `stream(…)`, wiring Ollama in is roughly 60 lines.

### Which models to pull for 16 GB VRAM

The RTX A4000's **16 GB GDDR6** comfortably holds any Q4_K_M-quantised model up to ~14 B parameters with room for KV cache at 8 K context. Enable Flash Attention with `OLLAMA_FLASH_ATTENTION=1` for an extra 5–10 % headroom.

| Role | Model | VRAM | Tool calling | Notes |
|---|---|---|---|---|
| General purpose | `qwen3:14b` | ~12 GB | ✅ excellent | Best instruction-following at this tier, thinking mode toggle |
| Coding | `qwen2.5-coder:14b` | ~8.5 GB | ✅ | HumanEval leader in this class |
| Reasoning | `deepseek-r1:14b` | ~8.8 GB | ⚠️ limited | Explicit chain-of-thought; not tagged "tools" officially |
| Fast routing / classification | `qwen2.5:1.5b` | ~1.5 GB | ✅ | Smallest model with reliable tool calling |
| Embeddings | `nomic-embed-text` | ~0.3 GB | n/a | 768-dim, 8 K context, Apache 2.0 |

```bash
# Pull all five models
ollama pull qwen3:14b
ollama pull qwen2.5-coder:14b
ollama pull deepseek-r1:14b
ollama pull qwen2.5:1.5b
ollama pull nomic-embed-text
```

### Windows environment setup

Set these as user-level environment variables (Settings → Environment Variables), then restart the Ollama tray app:

```
OLLAMA_HOST=0.0.0.0
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_KEEP_ALIVE=30m
OLLAMA_ORIGINS=*
```

`OLLAMA_HOST=0.0.0.0` makes the server reachable from Docker containers via `host.docker.internal:11434`. The CORS wildcard lets the Electron renderer and n8n containers call it without preflight rejections.

### Provider adapter — `packages/providers/ollama.js`

```js
// packages/providers/ollama.js
import { openaiCompatibleStream } from '../shared/openai-compat.js';

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

/** Health check — resolves true when Ollama is responding. */
export async function checkHealth(signal) {
  try {
    const res = await fetch(`${BASE}/`, { signal });
    const text = await res.text();
    return text.includes('Ollama is running');
  } catch {
    return false;
  }
}

export async function listModels() {
  const res = await fetch(`${BASE}/v1/models`);
  const { data } = await res.json();
  return data.map(m => ({ id: m.id, name: m.id, provider: 'ollama' }));
}

export async function stream({ model, messages, tools, onChunk, signal }) {
  return openaiCompatibleStream({
    baseURL: `${BASE}/v1`,
    apiKey: 'ollama',                 // required by SDK, ignored by Ollama
    model,
    messages,
    tools,
    onChunk,
    signal,
  });
}
```

### Embedding helper — `packages/providers/ollama-embed.js`

```js
// packages/providers/ollama-embed.js
const BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export async function embed(texts, model = 'nomic-embed-text') {
  const input = Array.isArray(texts) ? texts : [texts];
  const res = await fetch(`${BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  const data = await res.json();
  return data.embeddings;            // Array of 768-dim float arrays
}
```

### Register in the provider registry

```js
// packages/providers/index.js  — add to existing map
import * as ollama from './ollama.js';
providers.set('ollama', ollama);
```

The tool loop already iterates `onChunk` deltas and accumulates `tool_calls` — no changes needed there as long as the model is one of the reliable tool-calling models (**qwen3**, **qwen2.5**, **mistral/ministral**, **phi-4-mini**). Avoid routing tool-heavy plans to deepseek-r1 since it is not officially tagged for tool calling.

---

## Gap 2 — WAHA bridges WhatsApp alongside Telegram

WAHA (WhatsApp HTTP API) wraps the WhatsApp Web protocol behind a clean REST surface. The **NOWEB** engine uses raw WebSocket connections to WhatsApp servers (no Chromium), drawing a fraction of the CPU of the browser-based engines and scaling to 500+ sessions per container.

### Docker service

```yaml
# Added to docker-compose.yml
waha:
  image: devlikeapro/waha:noweb
  container_name: waha
  restart: unless-stopped
  ports:
    - "3000:3000"
  environment:
    WHATSAPP_DEFAULT_ENGINE: NOWEB
    WAHA_API_KEY: "${WAHA_API_KEY}"
    WHATSAPP_HOOK_URL: "http://host.docker.internal:${APP_PORT}/api/whatsapp/webhook"
    WHATSAPP_HOOK_EVENTS: "message,session.status"
    WHATSAPP_HOOK_HMAC_KEY: "${WAHA_HMAC_SECRET}"
    WHATSAPP_DOWNLOAD_MEDIA: "true"
    WAHA_RESTART_ALL_SESSIONS: "True"
    WAHA_DASHBOARD_USERNAME: "${WAHA_DASH_USER}"
    WAHA_DASHBOARD_PASSWORD: "${WAHA_DASH_PASS}"
  volumes:
    - ./data/waha-sessions:/app/.sessions
    - ./data/waha-media:/app/.media
  healthcheck:
    test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
```

### Session bootstrap — `packages/bridges/whatsapp/session.js`

```js
// packages/bridges/whatsapp/session.js
const WAHA = process.env.WAHA_URL ?? 'http://localhost:3000';
const API_KEY = process.env.WAHA_API_KEY;
const headers = { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY };

export async function ensureSession(name = 'default') {
  // Check if session exists and is WORKING
  const res = await fetch(`${WAHA}/api/sessions/${name}`, { headers });
  if (res.ok) {
    const session = await res.json();
    if (session.status === 'WORKING') return session;
  }

  // Create or restart the session
  await fetch(`${WAHA}/api/sessions/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      config: {
        webhooks: [{
          url: process.env.WHATSAPP_WEBHOOK_URL,
          events: ['message', 'session.status'],
          hmac: { key: process.env.WAHA_HMAC_SECRET },
          retries: { policy: 'constant', delaySeconds: 2, attempts: 15 },
        }],
      },
    }),
  });
}

export async function getQrCode(name = 'default') {
  const res = await fetch(`${WAHA}/api/${name}/auth/qr`, { headers });
  return res;   // image/png body — pipe to Electron renderer for display
}
```

### Sending messages — `packages/bridges/whatsapp/send.js`

```js
// packages/bridges/whatsapp/send.js
const WAHA = process.env.WAHA_URL ?? 'http://localhost:3000';
const headers = { 'Content-Type': 'application/json', 'X-Api-Key': process.env.WAHA_API_KEY };

export async function sendText(chatId, text, session = 'default') {
  return fetch(`${WAHA}/api/sendText`, {
    method: 'POST', headers,
    body: JSON.stringify({ session, chatId, text }),
  });
}

export async function sendFile(chatId, url, filename, mimetype, caption, session = 'default') {
  return fetch(`${WAHA}/api/sendFile`, {
    method: 'POST', headers,
    body: JSON.stringify({
      session, chatId, caption,
      file: { url, filename, mimetype },
    }),
  });
}
```

### Incoming webhook handler — `packages/bridges/whatsapp/webhook.js`

```js
// packages/bridges/whatsapp/webhook.js
import crypto from 'node:crypto';

export function verifyHmac(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function handleWebhook(req, res, { onMessage, onStatus }) {
  const sig = req.headers['x-webhook-hmac'];
  if (!verifyHmac(req.rawBody, sig, process.env.WAHA_HMAC_SECRET)) {
    return res.status(401).end();
  }

  const { event, payload, session } = req.body;

  if (event === 'message' && !payload.fromMe) {
    const msg = {
      id: payload.id,
      from: payload.from.replace('@c.us', ''),
      text: payload.body,
      hasMedia: payload.hasMedia,
      mediaUrl: payload.media?.url ?? null,
      timestamp: payload.timestamp,
    };
    onMessage(msg, session);
  }

  if (event === 'session.status') {
    onStatus(payload, session);
  }

  res.status(200).json({ ok: true });
}
```

Voice messages arrive with `hasMedia: true` and `mimetype: "audio/ogg; codecs=opus"`. Download the audio from the `media.url` using the API key header, then pipe to Whisper or another STT service for transcription before feeding into the conversation store.

**chatId format**: international number without `+`, suffixed with `@c.us` — e.g. `12125551234@c.us`.

---

## Gap 3 — n8n adds proactive scheduling and workflow orchestration

n8n provides the cron engine, webhook receiver, and visual workflow builder the monorepo lacks. Its **AI Agent** node runs a full ReAct loop against Ollama or Claude, and its **MCP Client Tool** node lets any n8n workflow call the monorepo's own MCP tools. The inverse path — the **MCP Server Trigger** — exposes n8n workflows as callable MCP tools the assistant can invoke.

### Docker services

```yaml
# Added to docker-compose.yml
postgres:
  image: postgres:16
  restart: always
  environment:
    POSTGRES_USER: "${PG_USER}"
    POSTGRES_PASSWORD: "${PG_PASS}"
    POSTGRES_DB: n8n
  volumes:
    - ./data/postgres:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${PG_USER} -d n8n"]
    interval: 5s
    timeout: 5s
    retries: 10

redis:
  image: redis:7-alpine
  restart: always
  volumes:
    - ./data/redis:/data
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 5s
    retries: 10

n8n:
  image: docker.n8n.io/n8nio/n8n:1.123.28
  restart: always
  ports:
    - "5678:5678"
  environment:
    DB_TYPE: postgresdb
    DB_POSTGRESDB_HOST: postgres
    DB_POSTGRESDB_PORT: 5432
    DB_POSTGRESDB_DATABASE: n8n
    DB_POSTGRESDB_USER: "${PG_USER}"
    DB_POSTGRESDB_PASSWORD: "${PG_PASS}"
    N8N_ENCRYPTION_KEY: "${N8N_ENCRYPTION_KEY}"
    EXECUTIONS_MODE: queue
    QUEUE_BULL_REDIS_HOST: redis
    QUEUE_BULL_REDIS_PORT: 6379
    WEBHOOK_URL: "http://host.docker.internal:5678/"
    GENERIC_TIMEZONE: "${TZ}"
  extra_hosts:
    - "host.docker.internal:host-gateway"
  volumes:
    - ./data/n8n:/home/node/.n8n
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }

n8n-worker:
  image: docker.n8n.io/n8nio/n8n:1.123.28
  restart: always
  command: worker
  environment:
    DB_TYPE: postgresdb
    DB_POSTGRESDB_HOST: postgres
    DB_POSTGRESDB_PORT: 5432
    DB_POSTGRESDB_DATABASE: n8n
    DB_POSTGRESDB_USER: "${PG_USER}"
    DB_POSTGRESDB_PASSWORD: "${PG_PASS}"
    N8N_ENCRYPTION_KEY: "${N8N_ENCRYPTION_KEY}"
    EXECUTIONS_MODE: queue
    QUEUE_BULL_REDIS_HOST: redis
    QUEUE_BULL_REDIS_PORT: 6379
    N8N_DISABLE_ACTIVE_WORKFLOWS: "true"
    QUEUE_HEALTH_CHECK_ACTIVE: "true"
  extra_hosts:
    - "host.docker.internal:host-gateway"
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }
```

Queue mode gives roughly **7× throughput** over the default single-process mode and keeps the UI responsive while workers churn through scheduled jobs. Scale workers with `docker compose up -d --scale n8n-worker=3`.

### Connecting n8n's AI Agent to Ollama

Inside n8n's visual editor, create an AI Agent node and attach an **Ollama Chat Model** sub-node. Set the credential's Base URL to `http://host.docker.internal:11434` and the model to `qwen3:14b`. Attach MCP Client Tool sub-nodes pointing at the monorepo's MCP hub (running on stdio or HTTP) so the agent can invoke file ops, shell exec, or any other registered tool.

### Connecting n8n's AI Agent to Claude

Add an **Anthropic Chat Model** sub-node. Enter the API key from `console.anthropic.com` and select `claude-sonnet-4-20250514` (or the latest model). The agent automatically formats messages in Anthropic's protocol.

### MCP Client Tool node — consuming the monorepo's MCP tools

The n8n MCP Client Tool node connects to any MCP server over SSE or Streamable HTTP. Point it at the monorepo's HTTP MCP endpoint (e.g., `http://host.docker.internal:${MCP_PORT}/mcp`) and set auth to Bearer with the policy-engine token. The AI Agent then discovers and calls every tool the monorepo exposes.

### MCP Server Trigger — exposing n8n workflows as MCP tools

Add an **MCP Server Trigger** node as the workflow entry point. Connect downstream n8n nodes (Schedule Trigger, HTTP Request, Code). Activate the workflow to get a production URL like `https://n8n.local/mcp/abc123`. Register that URL in the monorepo's MCP hub config:

```json
{
  "id": "n8n-workflows",
  "transport": "streamable-http",
  "url": "http://localhost:5678/mcp/abc123",
  "auth": { "type": "bearer", "token": "${N8N_MCP_TOKEN}" }
}
```

### n8n triggering the Electron app

Add an **HTTP Request** node at the end of any n8n workflow:

- **Method**: POST  
- **URL**: `http://host.docker.internal:${APP_PORT}/api/n8n/trigger`  
- **Body**: `{ "action": "notify", "title": "Daily brief ready", "payload": { … } }`

In the Electron app, the Express listener routes this to the renderer via `mainWindow.webContents.send('n8n-trigger', body)`.

### Key n8n workflow recipes

| Workflow | Trigger | What it does |
|---|---|---|
| Daily brief | Schedule Trigger, 07:00 cron | Queries M365 calendar, summarises via Ollama, sends to Telegram + WhatsApp |
| Document watcher | Webhook (SharePoint webhook) | Ingests new docs into Qdrant RAG, notifies user |
| Proactive reminders | Schedule Trigger, every 15 min | Checks task store for upcoming deadlines, sends push if threshold crossed |
| Invoice processor | Webhook (email forward) | Extracts data with Claude, creates QuickBooks entry via MCP |

---

## Gap 4 — Maximum MCP connector coverage

The MCP ecosystem now exceeds **12,000 servers** across npm, PyPI, and hosted endpoints. The table below lists the highest-quality production-ready servers per category, with exact package names and transport types. All stdio servers integrate with the monorepo's existing MCP hub connection manager using `npx` or direct `node` execution; HTTP servers connect via the hub's HTTP/SSE client.

### Tier 1 — Official first-party servers (vendor-maintained)

| Service | Package / Endpoint | Transport | Auth |
|---|---|---|---|
| **GitHub** | `https://api.githubcopilot.com/mcp/` | HTTP | PAT (Bearer) |
| **Notion** | `https://mcp.notion.com/mcp` | HTTP | OAuth 2.0 |
| **Slack** | `https://mcp.slack.com` | HTTP | OAuth |
| **Stripe** | `@stripe/mcp` (npm) or `https://mcp.stripe.com` | stdio / HTTP | Secret key / OAuth |
| **Supabase** | `https://mcp.supabase.com/mcp` | HTTP | OAuth |
| **Neon** | `https://mcp.neon.tech/mcp` | HTTP | OAuth / API key |
| **Cloudflare** | `https://mcp.cloudflare.com/mcp` | HTTP | OAuth |
| **Vercel** | `https://mcp.vercel.com` | HTTP | OAuth |
| **MongoDB** | `mongodb-mcp-server` (npm) | stdio | Connection string |
| **Redis** | `redis/mcp-redis` (GitHub) | stdio | Connection string |
| **Asana** | `https://mcp.asana.com/sse` | HTTP/SSE | OAuth |
| **Figma** | Figma Dev Mode MCP | stdio | Access token |
| **Playwright** | `@playwright/mcp` (npm) | stdio | None |
| **Home Assistant** | Built-in at `/api/mcp` | HTTP | OAuth / HA token |
| **AWS** | AWS MCP Server (Preview) | stdio/HTTP | IAM |
| **Sentry** | `@sentry/mcp-server-sentry` | stdio/HTTP | Auth token |
| **Docker** | Docker MCP Toolkit | stdio | Daemon access |

### Tier 2 — High-quality community and reference servers

| Service | Package | Transport | Auth |
|---|---|---|---|
| **Brave Search** | `@brave/brave-search-mcp-server` | stdio | API key |
| **Tavily** | `tavily-mcp` (npm) or `https://mcp.tavily.com/mcp` | stdio / HTTP | API key |
| **Exa** | `exa-mcp-server` (npm) | stdio | API key |
| **Context7** | `@upstash/context7-mcp` | stdio | None (free) |
| **Firecrawl** | `firecrawl-mcp` (npm) | stdio / HTTP | API key |
| **Filesystem** | `@modelcontextprotocol/server-filesystem` | stdio | None |
| **Memory** | `@modelcontextprotocol/server-memory` | stdio | None |
| **Fetch** | `@modelcontextprotocol/server-fetch` | stdio | None |
| **Kubernetes** | `mcp-server-kubernetes` (npm) | stdio | kubeconfig |
| **Linear** | `@tacticlaunch/mcp-linear` | stdio | API key |
| **Todoist** | `todoist-mcp` (npm) | stdio | API key |
| **Jira** | `@orengrinker/jira-mcp-server` | stdio | API token |
| **Qdrant** | `mcp-server-qdrant` (uvx/pip) | stdio | None |
| **Hugging Face** | `huggingface-mcp-server` | HTTP | HF token |

### Security warning

**52.8 % of scored MCP servers rate 2/5 or below** on security. The official PostgreSQL and SQLite reference servers have known SQL injection vulnerabilities and are archived. Always prefer the vendor-first-party servers listed in Tier 1. Scope API keys to minimum privileges and start with read-only configurations.

### Hub config pattern for adding a new server

```json
// packages/mcp-hub/servers.json — add entries
{
  "servers": [
    {
      "id": "brave-search",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server"],
      "env": { "BRAVE_API_KEY": "${BRAVE_API_KEY}" }
    },
    {
      "id": "notion",
      "transport": "streamable-http",
      "url": "https://mcp.notion.com/mcp",
      "auth": { "type": "oauth", "clientId": "${NOTION_CLIENT_ID}" }
    },
    {
      "id": "github",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "type": "bearer", "token": "${GITHUB_PAT}" }
    },
    {
      "id": "context7",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    {
      "id": "stripe",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@stripe/mcp"],
      "env": { "STRIPE_SECRET_KEY": "${STRIPE_KEY}" }
    },
    {
      "id": "mongodb",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server"],
      "env": { "MDB_MCP_CONNECTION_STRING": "${MONGO_URI}" }
    },
    {
      "id": "playwright",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    },
    {
      "id": "qdrant-rag",
      "transport": "stdio",
      "command": "node",
      "args": ["packages/mcp-servers/qdrant-rag/index.js"],
      "env": { "QDRANT_URL": "http://localhost:6333" }
    }
  ]
}
```

---

## Gap 5 — Qdrant RAG with local Ollama embeddings

The combination of Qdrant (vector store), nomic-embed-text (768-dim embeddings via Ollama), and a thin MCP server creates a fully local, zero-API-cost RAG pipeline. Document chunks stay on-premises — critical for legal and business content.

### Docker service

```yaml
# Added to docker-compose.yml
qdrant:
  image: qdrant/qdrant:latest
  container_name: qdrant
  restart: unless-stopped
  ports:
    - "6333:6333"
    - "6334:6334"
  volumes:
    - ./data/qdrant-storage:/qdrant/storage:z
    - ./data/qdrant-snapshots:/qdrant/snapshots:z
  environment:
    QDRANT__LOG_LEVEL: INFO
  healthcheck:
    test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:6333/healthz || exit 1"]
    interval: 30s
    timeout: 10s
    retries: 3
```

### Install the JS client

```bash
npm install @qdrant/js-client-rest    # v1.17.0
```

### Core RAG module — `packages/rag/index.js`

```js
// packages/rag/index.js
import { QdrantClient } from '@qdrant/js-client-rest';
import { embed } from '../providers/ollama-embed.js';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const VECTOR_SIZE = 768;

const qdrant = new QdrantClient({ url: QDRANT_URL });

export async function ensureCollection(name) {
  const { collections } = await qdrant.getCollections();
  if (collections.some(c => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
  });
  await qdrant.createPayloadIndex(name, {
    field_name: 'source',
    field_schema: 'keyword',
  });
  await qdrant.createPayloadIndex(name, {
    field_name: 'documentType',
    field_schema: 'keyword',
  });
}

export async function ingest(collection, chunks) {
  const texts = chunks.map(c => c.text);
  const embeddings = await embed(texts);

  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: embeddings[i],
    payload: {
      text: chunk.text,
      source: chunk.source,
      section: chunk.section ?? '',
      page: chunk.page ?? 0,
      documentType: chunk.documentType ?? 'general',
      chunkIndex: chunk.chunkIndex ?? i,
    },
  }));

  // Batch upsert in groups of 100
  for (let i = 0; i < points.length; i += 100) {
    await qdrant.upsert(collection, {
      wait: true,
      points: points.slice(i, i + 100),
    });
  }
  return points.length;
}

export async function search(collection, query, { limit = 5, filter } = {}) {
  const [queryVector] = await embed(query);
  const result = await qdrant.query(collection, {
    query: queryVector,
    limit,
    with_payload: true,
    ...(filter && { filter }),
  });

  return result.points.map(p => ({
    score: p.score,
    text: p.payload.text,
    source: p.payload.source,
    section: p.payload.section,
    page: p.payload.page,
  }));
}

export async function deleteBySource(collection, source) {
  await qdrant.delete(collection, {
    filter: { must: [{ key: 'source', match: { value: source } }] },
  });
}
```

### Document chunker — `packages/rag/chunker.js`

For legal and business documents, **section-aware recursive splitting** at **~400–512 tokens** with **10–15 % overlap** yields the best retrieval precision. Preserve clause boundaries as atomic units.

```js
// packages/rag/chunker.js
import { randomUUID } from 'node:crypto';

const DEFAULT_CHUNK_SIZE = 1800;     // ~450 tokens at 4 chars/token
const DEFAULT_OVERLAP = 200;          // ~50 tokens overlap

const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

export function chunkDocument(text, meta = {}, opts = {}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const chunks = recursiveSplit(text, chunkSize, overlap, SEPARATORS);

  return chunks.map((chunk, i) => ({
    id: randomUUID(),
    text: chunk,
    chunkIndex: i,
    source: meta.source ?? 'unknown',
    section: meta.section ?? '',
    page: meta.page ?? 0,
    documentType: meta.documentType ?? 'general',
  }));
}

function recursiveSplit(text, size, overlap, separators) {
  if (text.length <= size) return [text.trim()].filter(Boolean);

  const sep = separators.find(s => text.includes(s)) ?? '';
  const parts = text.split(sep);
  const chunks = [];
  let current = '';

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length > size && current) {
      chunks.push(current.trim());
      // Overlap: keep the tail of the previous chunk
      const tail = current.slice(-overlap);
      current = tail + sep + part;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
```

### Exposing RAG as an MCP server — `packages/mcp-servers/qdrant-rag/index.js`

This follows the monorepo's existing MCP server pattern using `@modelcontextprotocol/sdk`:

```js
// packages/mcp-servers/qdrant-rag/index.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureCollection, ingest, search, deleteBySource } from '../../rag/index.js';
import { chunkDocument } from '../../rag/chunker.js';

const server = new Server(
  { name: 'qdrant-rag', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'rag_search',
      description: 'Search documents by semantic similarity. Returns the top matching chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          collection: { type: 'string', default: 'documents' },
          limit: { type: 'number', default: 5 },
        },
        required: ['query'],
      },
    },
    {
      name: 'rag_ingest',
      description: 'Ingest a text document into the RAG vector store.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Full document text' },
          source: { type: 'string', description: 'Document filename or identifier' },
          collection: { type: 'string', default: 'documents' },
          documentType: { type: 'string', default: 'general' },
        },
        required: ['text', 'source'],
      },
    },
    {
      name: 'rag_delete',
      description: 'Delete all chunks for a given source document.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          collection: { type: 'string', default: 'documents' },
        },
        required: ['source'],
      },
    },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  const collection = args.collection ?? 'documents';

  await ensureCollection(collection);

  if (name === 'rag_search') {
    const results = await search(collection, args.query, { limit: args.limit ?? 5 });
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }

  if (name === 'rag_ingest') {
    const chunks = chunkDocument(args.text, {
      source: args.source,
      documentType: args.documentType ?? 'general',
    });
    const count = await ingest(collection, chunks);
    return {
      content: [{ type: 'text', text: `Ingested ${count} chunks from "${args.source}"` }],
    };
  }

  if (name === 'rag_delete') {
    await deleteBySource(collection, args.source);
    return {
      content: [{ type: 'text', text: `Deleted all chunks for "${args.source}"` }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

Register this server in the MCP hub config as shown in Gap 4 above under `qdrant-rag`.

---

## The Lookeen MCP question — no server exists

After thorough research, **Lookeen Desktop Search has no MCP server, no public API, no CLI, and no developer SDK** as of April 2026. The path `C:\Program Files\Lookeen\Desktop` does not match any documented Lookeen installation path (the actual default is `C:\Program Files (x86)\Axonic\Lookeen`). Lookeen is a closed proprietary application built on Apache Lucene with a .NET Outlook add-in.

For desktop-wide file and email search via MCP, use these alternatives instead:

- **`@modelcontextprotocol/server-filesystem`** for local file search and reading
- **The monorepo's existing Microsoft 365 Graph API** for Outlook email/calendar search  
- **The Qdrant RAG pipeline from Gap 5** to ingest and semantically search any local documents
- **`@playwright/mcp`** for browser-based search automation if needed

If a future Lookeen version adds MCP support, the stdio config entry would follow this pattern in the hub's `servers.json`:

```json
{
  "id": "lookeen",
  "transport": "stdio",
  "command": "C:\\Program Files (x86)\\Axonic\\Lookeen\\lookeen-mcp.exe",
  "args": ["--stdio"]
}
```

---

## Unified docker-compose.yml

```yaml
version: "3.8"

volumes:
  pg_data:
  redis_data:
  qdrant_storage:
  qdrant_snapshots:
  n8n_data:
  waha_sessions:
  waha_media:

services:
  # --- PostgreSQL (shared by n8n) ---
  postgres:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_USER: "${PG_USER}"
      POSTGRES_PASSWORD: "${PG_PASS}"
      POSTGRES_DB: n8n
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PG_USER} -d n8n"]
      interval: 5s
      timeout: 5s
      retries: 10

  # --- Redis (n8n queue mode) ---
  redis:
    image: redis:7-alpine
    restart: always
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  # --- Qdrant vector database ---
  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_storage:/qdrant/storage:z
      - qdrant_snapshots:/qdrant/snapshots:z
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:6333/healthz || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3

  # --- WAHA (WhatsApp bridge) ---
  waha:
    image: devlikeapro/waha:noweb
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      WHATSAPP_DEFAULT_ENGINE: NOWEB
      WAHA_API_KEY: "${WAHA_API_KEY}"
      WHATSAPP_HOOK_URL: "http://host.docker.internal:${APP_PORT}/api/whatsapp/webhook"
      WHATSAPP_HOOK_EVENTS: "message,session.status"
      WHATSAPP_HOOK_HMAC_KEY: "${WAHA_HMAC_SECRET}"
      WHATSAPP_DOWNLOAD_MEDIA: "true"
      WAHA_RESTART_ALL_SESSIONS: "True"
    volumes:
      - waha_sessions:/app/.sessions
      - waha_media:/app/.media
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # --- n8n main (queue mode) ---
  n8n:
    image: docker.n8n.io/n8nio/n8n:1.123.28
    restart: always
    ports:
      - "5678:5678"
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_PORT: "5432"
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: "${PG_USER}"
      DB_POSTGRESDB_PASSWORD: "${PG_PASS}"
      N8N_ENCRYPTION_KEY: "${N8N_ENCRYPTION_KEY}"
      EXECUTIONS_MODE: queue
      QUEUE_BULL_REDIS_HOST: redis
      QUEUE_BULL_REDIS_PORT: "6379"
      WEBHOOK_URL: "http://host.docker.internal:5678/"
      GENERIC_TIMEZONE: "${TZ}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  # --- n8n worker ---
  n8n-worker:
    image: docker.n8n.io/n8nio/n8n:1.123.28
    restart: always
    command: worker
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_PORT: "5432"
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: "${PG_USER}"
      DB_POSTGRESDB_PASSWORD: "${PG_PASS}"
      N8N_ENCRYPTION_KEY: "${N8N_ENCRYPTION_KEY}"
      EXECUTIONS_MODE: queue
      QUEUE_BULL_REDIS_HOST: redis
      QUEUE_BULL_REDIS_PORT: "6379"
      N8N_DISABLE_ACTIVE_WORKFLOWS: "true"
      QUEUE_HEALTH_CHECK_ACTIVE: "true"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
```

### Corresponding `.env` file

```env
# PostgreSQL
PG_USER=n8n_admin
PG_PASS=<generate-strong-password>

# n8n
N8N_ENCRYPTION_KEY=<generate-32-char-random-string>
TZ=America/New_York

# WAHA
WAHA_API_KEY=<generate-uuid>
WAHA_HMAC_SECRET=<generate-uuid>

# App
APP_PORT=4000

# Ollama (runs on Windows host, not in Docker)
OLLAMA_BASE_URL=http://host.docker.internal:11434

# Qdrant
QDRANT_URL=http://qdrant:6333

# MCP server API keys
BRAVE_API_KEY=
GITHUB_PAT=
STRIPE_KEY=
NOTION_CLIENT_ID=
```

---

## Startup sequence and verification

```bash
# 1. Start Ollama on Windows host (tray app or service)
ollama serve

# 2. Pull models
ollama pull qwen3:14b && ollama pull qwen2.5:1.5b && ollama pull nomic-embed-text

# 3. Verify Ollama health
curl http://localhost:11434/
# → "Ollama is running"

# 4. Start all Docker services
docker compose up -d

# 5. Verify each service
curl http://localhost:6333/healthz          # Qdrant → {"title":"qdrant - vectorass engine","version":"1.17.x"}
curl http://localhost:3000/health           # WAHA  → 200 OK
curl http://localhost:5678/healthz          # n8n   → {"status":"ok"}

# 6. Install JS dependencies
npm install @qdrant/js-client-rest @stripe/mcp

# 7. Create WAHA session (scan QR on first run)
curl -X POST http://localhost:3000/api/sessions/ \
  -H "X-Api-Key: ${WAHA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name":"default"}'

# 8. Open WAHA dashboard to scan QR
# → http://localhost:3000/dashboard
```

## Conclusion — what changes architecturally

These five additions transform the monorepo from a cloud-dependent multi-provider assistant into a **hybrid local-cloud platform**. Ollama handles cost-free inference and embeddings, Qdrant stores document intelligence locally, WAHA doubles the messaging surface area, n8n replaces manual cron scripts with visual, auditable workflows, and the expanded MCP catalog gives the assistant reach into 30+ external services without custom integration code. The entire local stack — Ollama, Qdrant, WAHA, n8n, PostgreSQL, Redis — runs comfortably within the Z4 G5's 128 GB RAM and benefits from the RTX A4000 for model inference. Every piece communicates through the patterns the monorepo already defines: the provider adapter interface, the MCP hub, and the webhook bridge layer.