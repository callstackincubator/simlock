import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const consoleDoc = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "CONSOLE.md");

function openItBlocks(markdown: string): string[][] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith("Open it")) ?? "";
  return [...section.matchAll(/```\n([\s\S]*?)```/g)].map((match) =>
    (match[1] ?? "").trimEnd().split("\n"),
  );
}

describe("the console doc's Open it section", () => {
  it("shows a Daemon: <health> (<mode>) block with a Console line under Open it", () => {
    const blocks = openItBlocks(readFileSync(consoleDoc, "utf8"));

    // why: simlock status opens with `Daemon: <health> (<mode>)`, not the `Daemon running`
    // line that only simlock daemon start prints.
    const status = blocks.find((lines) =>
      /^Daemon: \S+ \((worker|gateway)\)$/.test(lines[0] ?? ""),
    );

    expect(status).toBeDefined();
    expect(status?.slice(1).some((line) => line.startsWith("Console: "))).toBe(true);
  });
});
