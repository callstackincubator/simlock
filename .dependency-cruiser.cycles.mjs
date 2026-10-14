// why: tests may build another component through its testing.ts (ADR 0018 §3), which is a cycle by design, so the cycle check runs on production files alone, in a pass of its own (ADR 0027).
import base from "./.dependency-cruiser.mjs";

export default {
  forbidden: [
    {
      name: "no-cycle-between-components",
      comment: "two components never import each other, directly or through a third",
      severity: "error",
      scope: "folder",
      from: { path: "^src/" },
      to: { circular: true },
    },
  ],
  options: {
    ...base.options,
    exclude: { path: "(\\.test\\.tsx?|/test-[^/]+\\.tsx?|/testing\\.ts)$" },
  },
};
