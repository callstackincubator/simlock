import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "stale-refs.sh",
);

/**
 * A repo with a `base` branch holding `before`, and HEAD on a branch holding `after` on top of it. A file
 * mapped to null is deleted; a [from, to] pair under `moves` is moved with `git mv` first.
 */
function repo(
  before: Record<string, string>,
  after: Record<string, string | null>,
  moves: readonly (readonly [string, string])[] = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), "stale-refs-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  const write = (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(dir, path));
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git("init", "-q", "-b", "base");
  write(before);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  for (const [from, to] of moves) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    git("mv", from, to);
  }
  write(after);
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  return dir;
}

function sweep(dir: string): string {
  return execFileSync("sh", [SCRIPT, "base", "HEAD"], { cwd: dir, encoding: "utf8" });
}

/** The hit lines printed under the header that starts with `header`. */
function hitsUnder(output: string, header: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("  "));
  return lines.slice(start + 1, end === -1 ? undefined : end).map((l) => l.trim());
}

describe("stale-refs.sh", () => {
  it("lists every line that still names a moved file, but not the ADRs that record history", () => {
    const dir = repo(
      {
        "src/core/wait-queue.ts": "export const queue = 1;\n",
        "src/gateway/queue.ts": "// A thin composition over `src/core/wait-queue.ts`.\n",
        "docs/internal/adr/0001-queue.md": "The queue lives in core/wait-queue.\n",
      },
      {},
      [["src/core/wait-queue.ts", "src/leasing/wait-queue.ts"]],
    );

    const output = sweep(dir);

    expect(output).toContain(
      "path core/wait-queue (src/core/wait-queue.ts, moved to src/leasing/wait-queue.ts)",
    );
    expect(hitsUnder(output, "path core/wait-queue")).toEqual([
      "src/gateway/queue.ts:1:// A thin composition over `src/core/wait-queue.ts`.",
    ]);
  });

  it("lists mentions of a code name whose declaration is gone, and not of names still declared or plain words", () => {
    const dir = repo(
      {
        "src/engine.ts":
          "export class LeaseEngine {}\nexport class Startup {}\nconst timers = 1;\n",
        "src/other.ts": "export class Startup {}\n",
        "docs/ARCH.md": "LeaseEngine owns timers. Startup runs first. LeaseEngineX is another.\n",
      },
      { "src/engine.ts": "export class Engine {}\n" },
    );

    const output = sweep(dir);

    expect(hitsUnder(output, "name LeaseEngine (declaration removed)")).toEqual([
      "docs/ARCH.md:1:LeaseEngine owns timers. Startup runs first. LeaseEngineX is another.",
    ]);
    expect(output).not.toContain("name Startup");
    expect(output).not.toContain("name timers");
  });

  it("lists docs that name a quoted string no code file has any more, and not one code still uses", () => {
    const dir = repo(
      {
        "src/events.ts": 'emit("lease.expired");\nemit("lease.granted");\n',
        "src/grant.ts": 'emit("lease.granted");\n',
        "docs/EVENTS.md": "| `lease.expired` | ... |\n| `lease.granted` | ... |\n",
      },
      { "src/events.ts": "emit();\n" },
    );

    const output = sweep(dir);

    expect(hitsUnder(output, "string lease.expired (no code file has it)")).toEqual([
      "docs/EVENTS.md:1:| `lease.expired` | ... |",
    ]);
    expect(output).not.toContain("lease.granted");
  });

  it("prints nothing when nothing the branch removed is still named", () => {
    const dir = repo({ "src/a.ts": "export class Old {}\n" }, { "src/a.ts": null });

    expect(sweep(dir)).toBe("");
  });
});
