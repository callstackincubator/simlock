import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPERATIONS } from "./operations.js";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");

/** Every fenced JSON block in `markdown` whose top level is exactly `{ "workers": [...] }`. */
function workerListSamples(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => {
      try {
        return JSON.parse(match[1] ?? "") as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(
      (value): value is { workers: unknown } =>
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        "workers" in value,
    );
}

describe("worker list samples in the docs", () => {
  it.each(["HTTP-API.md", "CLI.md"])("%s's samples parse as worker.list's output", (file) => {
    const samples = workerListSamples(readFileSync(join(docsDir, file), "utf8"));

    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      // Parsing drops fields the contract does not have, so comparing to the input also
      // catches a sample that carries one.
      expect(OPERATIONS["worker.list"].output.parse(sample)).toEqual(sample);
    }
  });
});
