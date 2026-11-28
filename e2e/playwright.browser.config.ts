import { defineConfig } from "@playwright/test";

import { baseConfig, webVaultServer } from "./playwright.base";

export default defineConfig({
  ...baseConfig,
  testDir: "./tests/browser",
  // Logs into the web vault's server, so it must be running too.
  webServer: process.env.E2E_TLS_SPKI ? undefined : webVaultServer,
});
