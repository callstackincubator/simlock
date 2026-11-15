import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT = join(ROOT, ".agents", "scripts", "spec-lint.mjs");

export const SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

export const FOOTER = "*Written by an agent.*";

export const FENCE = "```";

const PARENT = `Request: none

## Behaviours

| Behaviour (invoker, action, what it sees) | Seam | Cases | Task |
| --- | --- | --- | --- |
| An operator's config is read: number or object accepted, bad value refused | \`loadConfig\` | \`2\`; \`{}\`; \`0\` refused | #100 |

${FOOTER}
`;

export function write(name: string, text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "spec-lint-")), name);
  writeFileSync(file, text);
  return file;
}

export function lint(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

export function lintTask(body: string, parent: string | null = PARENT) {
  return lint([
    "100",
    "--body-file",
    write("task.md", body),
    ...(parent === null ? [] : ["--parent-file", write("parent.md", parent)]),
    "--world",
    write("world.json", JSON.stringify({ 100: { parent: 50 } })),
  ]);
}

export const swap = (from: string, to: string) => (body: string) => {
  expect(body).toContain(from);
  return body.replace(from, to);
};

export const task = (line: string, depends: string[] = []) => `### Tests

Seam line.

- ${line}

## Depends on

${depends.map((d) => `- ${d}`).join("\n")}
`;

export const WORLD = {
  200: { labels: ["feature:planned"], subIssues: [101, 102] },
  101: {
    body: task("A worker restarts and keeps the profile: same bytes, new port."),
    labels: ["task:ready"],
  },
  102: {
    body: task("A caller cancels a waiting request by platform: given, absent.", ["#101"]),
    labels: ["task:ready"],
  },
};

export function lintFeature(body: string, world: Record<string, unknown> = WORLD) {
  return lint([
    "200",
    "--feature",
    "--body-file",
    write("feature.md", body),
    "--world",
    write("world.json", JSON.stringify(world)),
  ]);
}
