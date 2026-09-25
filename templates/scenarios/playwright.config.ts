import { defineConfig } from "@playwright/test";

/**
 * Per-project Playwright config for Pi acceptance scenarios.
 * Edit baseURL and webServer for this app (port, start command).
 * Playwright itself is installed once on the client PC (install-on-client.bat).
 */
export default defineConfig({
  testDir: "./scenarios",
  outputDir: "./test-results",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
