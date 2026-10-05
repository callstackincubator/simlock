import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importsOf,
  isUnder,
  sourceFilesRecursive,
  srcDir,
  stripComments,
} from "../test-support/imports.js";

const daemonDir = join(srcDir, "daemon");

/**
 * What the gateway, the daemon, core, drivers and the contract may import is enforced by
 * `pnpm lint` (`.oxlintrc.json`, ADR 0018 §4), one file's imports at a time. What stays here
 * follows imports further than lint can.
 */
describe("the one daemon module the gateway imports", () => {
  it("is itself free of core", () => {
    for (const { normalized } of importsOf([join(daemonDir, "dispatch.ts")])) {
      expect(isUnder(normalized, "core")).toBe(false);
      expect(isUnder(normalized, "drivers")).toBe(false);
      expect(isUnder(normalized, "http")).toBe(false);
    }
  });
});

describe("the relay is the bus's only republisher", () => {
  // ADR 0014 §2: `republish` carries a worker's id and timestamp, so it is not a second way to
  // state a fact. Counted over every non-test source file, `src/bus` included.
  it("only the gateway's worker link calls republish", () => {
    const callers = sourceFilesRecursive(srcDir)
      .filter((file) => /\.republish\s*[<(]/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(srcDir, file));

    expect(callers).toEqual(["gateway/worker-link.ts"]);
  });
});
