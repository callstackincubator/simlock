import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/real-proxy",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/real-proxy/global-setup.ts",
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["github"], ["list"]],
  timeout: 60_000,
  workers: 1,
  use: { actionTimeout: 15_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
