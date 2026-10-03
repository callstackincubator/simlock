import { defineConfig, devices } from "@playwright/test";

/**
 * The web console's browser lane (`pnpm test:console`). Each Playwright worker starts its own
 * daemon on the fake driver with HTTP enabled (see `e2e/console/fixtures.ts`), so it needs the
 * same build the end-to-end suite does, the console's included.
 */
export default defineConfig({
  testDir: "e2e/console",
  testMatch: "*.spec.ts",
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["github"], ["list"]],
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
