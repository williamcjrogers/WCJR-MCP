/**
 * Typed provider errors + shared retry logic.
 *
 * Every provider adapter in this package should:
 *   1. Call `assertApiKey(provider, apiKey)` at the top of each exported
 *      entry point (stream / listModels / embed).
 *   2. Wrap the underlying SDK call in `withRetry(fn)` for retryable classes
 *      (429, 502, 503, ECONNRESET/ETIMEDOUT/ECONNREFUSED).
 *   3. On thrown error, call `classifyProviderError(provider, err, { model })`
 *      and re-throw the typed error so the orchestrator can render a clean
 *      fallback status message instead of a raw JSON dump.
 */

export class ProviderError extends Error {
  constructor({ code, provider, message, model, userMessage, cause }) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.model = model ?? null;
    this.userMessage = userMessage ?? message;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class AuthError extends ProviderError {
  constructor({ provider, message = "API key invalid or expired", cause } = {}) {
    super({
      code: "auth",
      provider,
      message,
      userMessage: `${provider}: ${message}`,
      cause
    });
    this.name = "AuthError";
  }
}

export class QuotaError extends ProviderError {
  constructor({ provider, model, message = "quota exceeded", cause } = {}) {
    super({
      code: "quota",
      provider,
      model,
      message,
      userMessage: `${provider}${model ? ` (${model})` : ""}: ${message} — trying next model`,
      cause
    });
    this.name = "QuotaError";
  }
}

export class RateLimitError extends ProviderError {
  constructor({ provider, model, message = "rate limited", cause, retryAfterMs } = {}) {
    super({
      code: "rate_limit",
      provider,
      model,
      message,
      userMessage: `${provider}${model ? ` (${model})` : ""}: ${message} — trying next model`,
      cause
    });
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class ModelNotFoundError extends ProviderError {
  constructor({ provider, model, message, cause } = {}) {
    const msg = message ?? `model '${model ?? "unknown"}' not available on this endpoint`;
    super({
      code: "model_not_found",
      provider,
      model,
      message: msg,
      userMessage: `${provider}: ${msg} — trying next model`,
      cause
    });
    this.name = "ModelNotFoundError";
  }
}

export class ProviderUnreachableError extends ProviderError {
  constructor({ provider, model, message = "unreachable", cause } = {}) {
    super({
      code: "unreachable",
      provider,
      model,
      message,
      userMessage: `${provider}: ${message} — trying next model`,
      cause
    });
    this.name = "ProviderUnreachableError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor({ provider, model, message = "request timed out", cause } = {}) {
    super({
      code: "timeout",
      provider,
      model,
      message,
      userMessage: `${provider}${model ? ` (${model})` : ""}: ${message} — trying next model`,
      cause
    });
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Throw AuthError if the key is missing, non-string, or blank. Providers that
 * don't require a key (e.g. Ollama on localhost) can call this with a sentinel
 * string like "ollama".
 */
export function assertApiKey(provider, apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new AuthError({
      provider,
      message: "API key not configured"
    });
  }
}

/**
 * Map a low-level SDK error into a typed ProviderError. Pass through typed
 * errors unchanged so wrapping is idempotent.
 */
export function classifyProviderError(provider, err, context = {}) {
  if (err instanceof ProviderError) {
    if (!err.provider) err.provider = provider;
    if (!err.model && context.model) err.model = context.model;
    return err;
  }

  const model = context.model ?? null;
  const status =
    (typeof err?.status === "number" && err.status) ||
    (typeof err?.statusCode === "number" && err.statusCode) ||
    null;
  const code = typeof err?.code === "string" ? err.code : null;
  const rawMessage = err instanceof Error ? err.message : String(err ?? "");
  const lowered = rawMessage.toLowerCase();

  if (status === 401 || status === 403 || /invalid_api_key|unauthorized/.test(lowered)) {
    return new AuthError({ provider, message: "API key invalid or expired", cause: err });
  }

  if (status === 404 || /model.*not.*found|no such model|unsupported.*model/.test(lowered)) {
    return new ModelNotFoundError({ provider, model, cause: err });
  }

  if (status === 429 || /quota|resource_exhausted|rate_limit_exceeded/.test(lowered)) {
    if (/quota|resource_exhausted/.test(lowered)) {
      return new QuotaError({ provider, model, cause: err });
    }
    return new RateLimitError({ provider, model, cause: err });
  }

  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || status === 502 || status === 503) {
    return new ProviderUnreachableError({ provider, model, cause: err });
  }

  if (code === "ABORT_ERR" || /abort/.test(lowered)) {
    return new ProviderTimeoutError({ provider, model, cause: err });
  }

  // Fallback — wrap in ProviderError so the renderer still gets a userMessage.
  const short = rawMessage.length > 200 ? `${rawMessage.slice(0, 200)}…` : rawMessage;
  return new ProviderError({
    code: "unknown",
    provider,
    model,
    message: short || "unknown error",
    userMessage: `${provider}: ${short || "unknown error"} — trying next model`,
    cause: err
  });
}

/**
 * Return true if an error class should trigger a retry inside `withRetry`.
 * ProviderError subclasses expose this via their `.code`; raw SDK errors fall
 * back to HTTP status / errno inspection.
 */
export function isRetryable(err) {
  if (err instanceof ProviderError) {
    return err.code === "rate_limit" || err.code === "unreachable" || err.code === "timeout";
  }
  const status = err?.status ?? err?.statusCode ?? 0;
  if (status === 429 || status === 502 || status === 503) return true;
  const code = String(err?.code ?? "");
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

/**
 * Retry an async function with exponential backoff. Default behaviour:
 * up to 3 attempts, 1s → 2s → 4s between attempts.
 */
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
