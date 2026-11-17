import { defineConfig, devices } from "@playwright/test";

// why: `pnpm console:screenshots` runs `e2e/console/screenshots.ts` on its own, so the browser lane
// (`playwright.config.ts`, `*.spec.ts`) never writes pictures.
export default defineConfig({
  testDir: "e2e/console",
  testMatch: "screenshots.ts",
  reporter: "list",
  timeout: 600_000,
  workers: 1,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
