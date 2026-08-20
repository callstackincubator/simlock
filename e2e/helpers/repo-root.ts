import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root, derived from this file's own location rather than
 * `process.cwd()` -- so the suite doesn't depend on the directory vitest happened
 * to be invoked from. This file lives at `e2e/helpers/repo-root.ts`, two levels
 * below the root.
 */
export const REPO_ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "../..");
