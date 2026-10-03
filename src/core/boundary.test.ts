import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importsOf, isUnder, sourceFilesRecursive } from "../test-support/imports.js";

const coreDir = dirname(fileURLToPath(import.meta.url));

/** Node built-ins the core reaches only through a port (architecture rule 9): the filesystem
 * through `Filesystem`, processes through `ProcessRunner`. Each also forbids its subpaths
 * (`fs/promises`), with or without the `node:` prefix. */
const FORBIDDEN_BUILTINS = ["fs", "child_process"];

function forbiddenBuiltin(normalized: string): boolean {
  const bare = normalized.startsWith("node:") ? normalized.slice("node:".length) : normalized;
  return FORBIDDEN_BUILTINS.some((builtin) => isUnder(bare, builtin));
}

/**
 * Architecture rules 1 and 2: the core is platform-agnostic, so it never imports a driver --
 * platform behaviour reaches it only through the `Driver` interface, wired in by the daemon --
 * and it never shells out. Rule 9: it touches the filesystem and spawns processes only through
 * the ports injected at startup, never `fs` or `child_process` directly.
 *
 * Every file under `src/core/`, subdirectories included, and every import form (static, re-export,
 * side-effect, dynamic), each resolved against the file that wrote it.
 */
describe("core module boundary", () => {
  const sourceFiles = sourceFilesRecursive(coreDir);

  it("found the core's own source files, including those in subdirectories", () => {
    expect(sourceFiles.some((path) => path.startsWith(`${coreDir}/capacity/`))).toBe(true);
  });

  it("imports no driver module, and neither fs nor child_process", () => {
    const violations = importsOf(sourceFiles).filter(
      ({ normalized }) => isUnder(normalized, "drivers") || forbiddenBuiltin(normalized),
    );

    expect(violations.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});
