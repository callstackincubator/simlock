import { defineConfig } from "vitest/config";

// The unit project alone, for Stryker (`pnpm mutate`). The e2e project needs a build and a
// running daemon per mutant, which is far too slow to mutate against.
export default defineConfig({
  test: {
    tags: [{ name: "slow" }, { name: "ios" }, { name: "android" }],
    include: ["src/**/*.test.ts", "ui/**/*.test.{ts,tsx}"],
    // Stryker runs every test file in one worker thread, where two tests fail though they pass
    // in the normal suite. Left out so neither aborts every mutation run:
    // - "...when a chunk's delivery never resolves" fails after other files have run in the same
    //   worker (an order dependence still to fix);
    // - "...on the browser's clock face" sets process.env.TZ, which a worker thread ignores.
    testNamePattern:
      /^(?!.*(when a chunk's delivery never resolves|on the browser's clock face)).*$/,
    testTimeout: 60_000,
  },
});
