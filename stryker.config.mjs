// Mutation testing for `pnpm mutate`, which passes the changed lines as --mutate.
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.mutate.config.ts" },
  coverageAnalysis: "perTest",
  // Unit tests spawn processes and watch timers; more runners than this starve them.
  concurrency: 4,
  reporters: ["json", "progress"],
  jsonReporter: { fileName: ".stryker-tmp/report/mutation.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  incremental: false,
  // Stryker rewrites tsconfig.json through the TypeScript JS API, which TypeScript 7 does not ship.
  // Vitest needs no rewrite (no extends or references point outside the sandbox), so name a
  // file that does not exist and the rewrite is skipped.
  tsconfigFile: "tsconfig.stryker-skip.json",
};
