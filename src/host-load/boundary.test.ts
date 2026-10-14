import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importSpecifiers,
  isUnder,
  normalizeSpecifier,
  srcDir,
  stripComments,
} from "../test-support/imports.js";

const hostLoadDir = "host-load";

describe("host load module boundary", () => {
  it("has no file outside src/host-load/ importing a file inside it other than index.ts", () => {
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(100);
    expect(existsSync(join(srcDir, hostLoadDir, "index.ts"))).toBe(true);

    const leaks = files
      .filter((file) => !isUnder(posix.relative(srcDir, file), hostLoadDir))
      .flatMap((file) =>
        importSpecifiers(stripComments(readFileSync(file, "utf8")))
          .map((specifier) => ({
            file: posix.relative(srcDir, file),
            normalized: normalizeSpecifier(posix.dirname(file), specifier),
            specifier,
          }))
          .filter(
            ({ normalized }) =>
              isUnder(normalized, hostLoadDir) && normalized !== `${hostLoadDir}/index.js`,
          ),
      );

    expect(leaks.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});
