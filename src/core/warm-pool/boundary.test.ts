import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importSpecifiers,
  isUnder,
  normalizeSpecifier,
  srcDir,
  stripComments,
} from "../../test-support/imports.js";

const warmPoolDir = "core/warm-pool";

describe("warm pool module boundary", () => {
  it("has no file outside src/core/warm-pool/ importing a file inside it other than index.ts", () => {
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(100);

    const leaks = files
      .filter((file) => !isUnder(posix.relative(srcDir, file), warmPoolDir))
      .flatMap((file) =>
        importSpecifiers(stripComments(readFileSync(file, "utf8")))
          .map((specifier) => ({
            file: posix.relative(srcDir, file),
            normalized: normalizeSpecifier(posix.dirname(file), specifier),
            specifier,
          }))
          .filter(
            ({ normalized }) =>
              isUnder(normalized, warmPoolDir) && normalized !== `${warmPoolDir}/index.js`,
          ),
      );

    expect(leaks.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});
