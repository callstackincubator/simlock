import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // strictTags (default in vitest 4.1) rejects any tag not declared here or on a
    // project. Declared once at the root so both projects inherit the vocabulary.
    tags: [{ name: "slow" }, { name: "ios" }, { name: "android" }],
    projects: [
      {
        test: {
          name: "unit",
          // `ui/` holds the console's own unit tests: plain functions, no browser. The browser
          // lane is Playwright's (`pnpm test:console`).
          include: ["src/**/*.test.ts", "ui/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          setupFiles: ["e2e/helpers/setup.ts"],
          // Each flow gets its own temp SIMLOCK_HOME, so its config, state, socket and log
          // are its own and files can run side by side. Four workers keep a CI runner's
          // cores free for the daemons each flow spawns.
          fileParallelism: true,
          maxWorkers: 4,
          // Individual slow real-SDK flows (tagged "slow") set their own longer
          // per-test timeout -- a hang in the fast fake-driver lane should fail in
          // ~2 minutes, not stall CI for ten.
          testTimeout: 120_000,
          // Teardown is a hook: stopping the daemon and waiting its process out can take ~35s,
          // and a real-SDK flow's teardown then empties its iOS device set (up to 45s more).
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
