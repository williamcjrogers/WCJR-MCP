/**
 * MSAL-based token provider for Microsoft 365.
 * Reads a serialized token cache (written after device code flow) and provides getAccessToken().
 */

import { PublicClientApplication } from "@azure/msal-node";
import fs from "node:fs/promises";
import path from "node:path";

const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Calendars.ReadWrite",
  "https://graph.microsoft.com/User.Read",
  "offline_access"
];

/**
 * Create a getAccessToken function using a serialized token cache file.
 * @param { { clientId: string, tenantId: string, tokenCachePath: string } } options
 * @returns { Promise<() => Promise<string>> }
 */
export async function createTokenProvider(options) {
  const { clientId, tenantId, tokenCachePath } = options;
  const msalConfig = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      knownAuthorities: [`https://login.microsoftonline.com/${tenantId}`]
    },
    cache: {
      cacheLocation: "memory"
    }
  };

  const app = new PublicClientApplication(msalConfig);
  if (typeof app.initialize === "function") {
    await app.initialize();
  }

  try {
    const raw = await fs.readFile(tokenCachePath, "utf-8");
    const cache = JSON.parse(raw);
    if (cache.Account && cache.RefreshToken) {
      const deserialized = await app.getTokenCache().deserialize(raw);
      // MSAL doesn't expose deserialize on the cache in all versions; alternative: use refresh token manually
      // For simplicity we'll try to use the in-memory cache if the file has the right structure
      const accounts = await app.getTokenCache().getAllAccounts();
      if (accounts.length === 0 && cache.RefreshToken) {
        const refreshToken = Object.values(cache.RefreshToken)[0]?.secret;
        if (refreshToken) {
          return createRefreshTokenProvider(clientId, tenantId, refreshToken);
        }
      }
      if (accounts.length > 0) {
        return () =>
          app.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] }).then((r) => r.accessToken);
      }
    }
  } catch {
    // No cache or invalid
  }

  throw new Error(
    "No valid token cache. Run device code flow first and save the token cache to " + tokenCachePath
  );
}

/**
 * Create getAccessToken using a raw refresh token (OAuth2 refresh_token grant).
 */
export function createRefreshTokenProvider(clientId, tenantId, refreshToken) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  let cached = { accessToken: null, expiresOn: 0 };
  let currentRefreshToken = refreshToken;

  return async function getAccessToken() {
    if (cached.accessToken && Date.now() < cached.expiresOn - 60 * 1000) {
      return cached.accessToken;
    }
    const body = new URLSearchParams({
      client_id: clientId,
      refresh_token: currentRefreshToken,
      grant_type: "refresh_token",
      scope: SCOPES.join(" ")
    });
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    cached = {
      accessToken: data.access_token,
      expiresOn: Date.now() + (data.expires_in ?? 3600) * 1000
    };
    if (data.refresh_token) {
      currentRefreshToken = data.refresh_token;
    }
    return cached.accessToken;
  };
}

/**
 * Create getAccessToken from a config file that contains refreshToken (or token cache path).
 * @param { string } configPath
 * @returns { Promise<() => Promise<string>> }
 */
export async function createTokenProviderFromConfig(configPath) {
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw);
  const { clientId, tenantId, refreshToken, encryptedRefreshToken, tokenCachePath } = config;
  if (!clientId || !tenantId) {
    throw new Error("Config must include clientId and tenantId");
  }
  const runtimeRefreshToken =
    process.env.WCJR_MAIL_REFRESH_TOKEN?.trim() ||
    refreshToken ||
    "";
  if (runtimeRefreshToken) {
    return createRefreshTokenProvider(clientId, tenantId, runtimeRefreshToken);
  }
  if (encryptedRefreshToken) {
    throw new Error(
      "Config contains an encrypted refresh token. Start the server via the desktop app so it can inject WCJR_MAIL_REFRESH_TOKEN."
    );
  }
  if (tokenCachePath) {
    return createTokenProvider({ clientId, tenantId, tokenCachePath: path.resolve(path.dirname(configPath), tokenCachePath) });
  }
  throw new Error("Config must include refreshToken or tokenCachePath");
}

/**
 * Resolve the refresh token for a single account entry.
 * Checks env var WCJR_MAIL_RT_{NAME} first, then plaintext refreshToken field.
 */
function resolveAccountRefreshToken(acctConfig, accountName) {
  const envKey = `WCJR_MAIL_RT_${accountName.toUpperCase()}`;
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  if (typeof acctConfig.refreshToken === "string" && acctConfig.refreshToken.trim()) {
    return acctConfig.refreshToken.trim();
  }
  return "";
}

/**
 * Create a map of { accountName -> getAccessToken } from a multi-account config file.
 * Handles both old (single-account) and new (multi-account) config formats.
 * @param { string } configPath
 * @returns { Promise<{ providers: Record<string, () => Promise<string>>, defaultAccount: string, accounts: Record<string, { label: string }> }> }
 */
export async function createTokenProvidersFromConfig(configPath) {
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Old format: single account with top-level clientId
  if (config.clientId) {
    const provider = await createSingleProviderFromAccount(config, "default", configPath);
    return {
      providers: { default: provider },
      defaultAccount: "default",
      accounts: { default: { label: "Default" } }
    };
  }

  // New format: multi-account
  const providers = {};
  const accountsMeta = {};
  for (const [name, acct] of Object.entries(config.accounts ?? {})) {
    try {
      providers[name] = await createSingleProviderFromAccount(acct, name, configPath);
      accountsMeta[name] = { label: acct.label ?? name };
    } catch (err) {
      // Log but don't block other accounts from loading
      console.error(`[mail-calendar] Failed to initialise account "${name}": ${err.message}`);
      accountsMeta[name] = { label: acct.label ?? name, error: err.message };
    }
  }
  const defaultAccount = config.defaultAccount ?? Object.keys(providers)[0] ?? "default";
  return { providers, defaultAccount, accounts: accountsMeta };
}

/**
 * Build a token provider for a single account entry.
 */
async function createSingleProviderFromAccount(acctConfig, accountName, configPath) {
  const { clientId, tenantId, encryptedRefreshToken, tokenCachePath } = acctConfig;
  if (!clientId || !tenantId) {
    throw new Error(`Account "${accountName}" must include clientId and tenantId`);
  }

  // 1. Check runtime env var (injected by desktop app) or plaintext refreshToken
  const refreshToken = resolveAccountRefreshToken(acctConfig, accountName);
  if (refreshToken) {
    return createRefreshTokenProvider(clientId, tenantId, refreshToken);
  }

  // 2. Legacy single-account env var (backward compat for old format)
  if (accountName === "default") {
    const legacy = process.env.WCJR_MAIL_REFRESH_TOKEN?.trim();
    if (legacy) {
      return createRefreshTokenProvider(clientId, tenantId, legacy);
    }
  }

  // 3. Encrypted token requires desktop app injection
  if (encryptedRefreshToken) {
    throw new Error(
      `Account "${accountName}" has an encrypted refresh token. Start the server via the desktop app so it can inject WCJR_MAIL_RT_${accountName.toUpperCase()}.`
    );
  }

  // 4. Token cache file
  if (tokenCachePath) {
    return createTokenProvider({ clientId, tenantId, tokenCachePath: path.resolve(path.dirname(configPath), tokenCachePath) });
  }

  throw new Error(`Account "${accountName}" must include refreshToken or tokenCachePath`);
}
