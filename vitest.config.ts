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
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          setupFiles: ["e2e/helpers/setup.ts"],
          // The daemon owns real OS resources (sockets, spawned processes); running
          // flows concurrently would make failures nondeterministic and hard to
          // attribute to the right flow.
          fileParallelism: false,
          // Individual slow real-SDK flows (tagged "slow") set their own longer
          // per-test timeout -- a hang in the fast fake-driver lane should fail in
          // ~2 minutes, not stall CI for ten.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
