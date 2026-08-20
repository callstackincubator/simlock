import { existsSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./repo-root.js";

// Fails fast with an actionable message instead of a confusing ENOENT from the first
// spawned `node dist/cli/main.js` if someone runs `vitest run --project e2e` directly
// without going through `pnpm run test:e2e` (which builds first).
const requiredBuildOutputs = [
  "dist/cli/main.js",
  "dist/daemon/main.js",
  "dist/mcp/main.js",
  "dist/e2e/index.js",
];

for (const relativePath of requiredBuildOutputs) {
  if (!existsSync(join(REPO_ROOT, relativePath))) {
    throw new Error(
      `e2e setup: missing build output ${relativePath}. Run \`pnpm run build && pnpm run build:e2e\` ` +
        "(or use `pnpm run test:e2e`, which does this for you) before running the e2e project.",
    );
  }
}
