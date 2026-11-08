import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // strictTags (default in vitest 4.1) rejects any tag not declared here or on a
    // project. Declared once at the root so both projects inherit the vocabulary.
    tags: [
      { name: "slow" },
      { name: "ios" },
      { name: "android" },
      { name: "physical" },
      { name: "physical-manual" },
    ],
    projects: [
      {
        test: {
          name: "unit",
          // why: `ui/` holds the console's own unit tests: plain functions and static markup, no DOM.
          // Pages in a DOM are the `ui-dom` project's; the browser lane is Playwright's.
          include: ["src/**/*.test.ts", "ui/**/*.test.{ts,tsx}"],
          // why: the timing files measure throughput and latency of GiB transfers: they run one
          // at a time (`pnpm test:timing`) so another file's load cannot move a number.
          exclude: ["**/node_modules/**", "src/**/*.timing.test.ts", "ui/**/*.dom.test.tsx"],
          // why: the script tests under src/ spawn node, git and a fake gh per case; under a full
          // parallel run the default five seconds times three of them out (lint-rules, claim,
          // mutate) while each passes alone in under a second. A hang still fails within 20 s.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "ui-dom",
          // why: a page drawn into a DOM, driven the way a person drives it, over a route table of
          // answers (`ui/src/test/console.tsx`). No daemon and no browser engine.
          include: ["ui/**/*.dom.test.tsx"],
          environment: "happy-dom",
          // why: the console's default desktop viewport (Playwright's 1280 px), the width the
          // sidebar opens wide from.
          environmentOptions: { happyDOM: { height: 720, width: 1280 } },
          setupFiles: ["ui/src/test/setup.ts"],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "timing",
          include: ["src/**/*.timing.test.ts"],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 120_000,
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
