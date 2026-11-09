import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type CommandNode, COMMANDS } from "./tree.js";

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "website/src/content/docs/docs/reference/cli.mdx",
);

function paths(nodes: readonly CommandNode[], parent = ""): string[] {
  return nodes.flatMap((node) => {
    const path = `${parent}${node.name}`;
    return [path, ...paths(node.children ?? [], `${path} `)];
  });
}

// why: the command tree in tree.ts is the one list of what `simlock` accepts, and index.ts does
// not hand it out; this reads it as data, a catalog check, not a test of the router.
describe("the website's CLI reference", () => {
  it("names every command and subcommand of the command tree as `simlock <command>`", () => {
    const page = readFileSync(PAGE, "utf8");
    const all = paths(COMMANDS);

    expect(all).toEqual(expect.arrayContaining(["lease renew", "daemon install", "alerts test"]));
    expect(all.filter((path) => !new RegExp(`simlock ${path}(?![\\w-])`).test(page))).toEqual([]);
  });

  it("gives `USAGE` (exit 2) as the code a refused `simlock simctl` or `simlock adb` command prints", () => {
    const page = readFileSync(PAGE, "utf8");
    const refusal = (command: string): string | undefined =>
      page
        .split(/^## /m)
        .find((section) => section.startsWith(`simlock ${command}\n`))
        ?.split("\n")
        .find((line) => line.includes("Simlock refuses"))
        ?.match(/Simlock refuses .*?, with `[A-Z_]+` \(exit \d+\)/)?.[0];

    expect(
      ["simctl", "adb"].map((command) => ({
        command,
        code: refusal(command)
          ?.match(/, with `([A-Z_]+)` \(exit (\d+)\)$/)
          ?.slice(1),
      })),
    ).toEqual([
      { command: "simctl", code: ["USAGE", "2"] },
      { command: "adb", code: ["USAGE", "2"] },
    ]);
  });
});
