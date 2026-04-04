import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTokenProviderFromConfig } from "./auth-msal.js";

test("createTokenProviderFromConfig rejects encrypted refresh tokens without injected runtime secret", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-mail-auth-"));
  const configPath = path.join(tempDir, "mail-calendar-config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        clientId: "client",
        tenantId: "tenant",
        encryptedRefreshToken: "encrypted"
      },
      null,
      2
    ),
    "utf-8"
  );

  const previous = process.env.WCJR_MAIL_REFRESH_TOKEN;
  delete process.env.WCJR_MAIL_REFRESH_TOKEN;
  await assert.rejects(
    () => createTokenProviderFromConfig(configPath),
    /encrypted refresh token/i
  );
  if (previous === undefined) {
    delete process.env.WCJR_MAIL_REFRESH_TOKEN;
  } else {
    process.env.WCJR_MAIL_REFRESH_TOKEN = previous;
  }
});
