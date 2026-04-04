/**
 * MSAL Node does not expose `refresh_token` on AuthenticationResult; it only stores RT in the token cache.
 * @param { import("@azure/msal-node").PublicClientApplication } pca
 * @param { import("@azure/msal-common").AuthenticationResult | null } result
 * @returns { string | null }
 */
function extractRefreshTokenFromCache(pca, result) {
  if (result && typeof result.refreshToken === "string" && result.refreshToken.length > 0) {
    return result.refreshToken;
  }
  let cache;
  try {
    cache = JSON.parse(pca.getTokenCache().serialize());
  } catch {
    return null;
  }
  const rt = cache?.RefreshToken;
  if (!rt || typeof rt !== "object") return null;
  for (const entity of Object.values(rt)) {
    if (entity && typeof entity.secret === "string" && entity.secret.length > 0) {
      return entity.secret;
    }
  }
  return null;
}

/**
 * Run device code flow for Microsoft 365. Used by the desktop app to obtain a refresh token.
 * @param { { clientId: string, tenantId: string, onMessage?: (message: string) => void } } options
 * @returns { Promise<{ refreshToken: string }> }
 */
export async function runDeviceCodeFlow(options) {
  const { PublicClientApplication } = await import("@azure/msal-node");
  const { clientId, tenantId, onMessage } = options;

  const app = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      knownAuthorities: [`https://login.microsoftonline.com/${tenantId}`]
    }
  });
  // MSAL Node v3+ exposes initialize(); v2.x does not — never call unconditionally.
  if (typeof app.initialize === "function") {
    await app.initialize();
  }

  const scopes = [
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.Send",
    "https://graph.microsoft.com/Calendars.ReadWrite",
    "https://graph.microsoft.com/User.Read",
    "offline_access"
  ];

  const request = {
    scopes,
    deviceCodeCallback: (response) => {
      const msg = response.message ?? "Visit https://microsoft.com/devicelogin and enter the code.";
      onMessage?.(msg);
    }
  };

  const result = await app.acquireTokenByDeviceCode(request);
  const refreshToken = extractRefreshTokenFromCache(app, result);
  if (!refreshToken) {
    throw new Error(
      "No refresh token after sign-in. Ensure the app registration allows public client flows, " +
        "delegated permissions include offline_access (and admin consent if required), then try again."
    );
  }
  return { refreshToken };
}
