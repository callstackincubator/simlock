import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import { importSpecifiers, srcDir, stripComments } from "../test-support/imports.js";

const SQLITE_LOADERS = /(?:require|getBuiltinModule)\s*\(\s*["'](?:node:)?sqlite["']/;

describe("the sqlite port", () => {
  it("is the only file under src/ that names node:sqlite", () => {
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(100);

    const naming = files
      .filter((file) => {
        const source = stripComments(readFileSync(file, "utf8"));
        return (
          importSpecifiers(source).some(
            (specifier) => specifier === "node:sqlite" || specifier === "sqlite",
          ) || SQLITE_LOADERS.test(source)
        );
      })
      .map((file) => posix.relative(srcDir, file));

    expect(naming).toEqual(["ports/sqlite.ts"]);
  });
});
