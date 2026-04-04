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
