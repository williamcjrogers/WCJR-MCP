import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfiguredApp } from "./server.js";

test("resolveConfiguredApp only allows configured aliases", () => {
  const config = {
    apps: {
      outlook: {
        displayName: "Outlook",
        path: "C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE"
      }
    }
  };

  assert.deepEqual(resolveConfiguredApp(config, "outlook"), {
    alias: "outlook",
    displayName: "Outlook",
    path: "C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE"
  });

  assert.throws(
    () => resolveConfiguredApp(config, "C:\\Windows\\System32\\notepad.exe"),
    /configured desktop alias/i
  );
});
