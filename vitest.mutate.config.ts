import { defineConfig } from "vitest/config";

// The unit project alone, for Stryker (`pnpm mutate`). The e2e project needs a build and a
// running daemon per mutant, which is far too slow to mutate against.
export default defineConfig({
  test: {
    tags: [{ name: "slow" }, { name: "ios" }, { name: "android" }],
    include: ["src/**/*.test.ts", "ui/**/*.test.{ts,tsx}"],
    // Stryker runs every test file in a worker thread, and this test sets process.env.TZ, which
    // a worker thread ignores: it is left out so it cannot abort every mutation run.
    testNamePattern: /^(?!.*on the browser's clock face).*$/,
    testTimeout: 60_000,
  },
});
