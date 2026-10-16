import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = "e2e/fixtures/appduct";
const README = `${FIXTURES}/README.md`;

interface Tracked {
  /** why: path relative to `e2e/fixtures/appduct/`. */
  path: string;
  mode: string;
}

function trackedFixtures(): Tracked[] {
  return execFileSync("git", ["ls-files", "-s", "-z", FIXTURES], {
    cwd: REPO_ROOT,
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [meta = "", path = ""] = entry.split("\t");
      return { mode: meta.split(" ")[0] ?? "", path: path.slice(FIXTURES.length + 1) };
    });
}

function readme(): string {
  return readFileSync(join(REPO_ROOT, README), "utf8");
}

/** why: the rows of the only table under `## Files`: path and SHA-256, cells trimmed, backticks removed. */
function readmeTable(): Array<{ path: string; sha256: string }> {
  const section = readme().split(/^## Files\s*$/m)[1] ?? "";
  const body = section.split(/^## /m)[0] ?? "";
  return body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 2 && !/^-+$/.test(cells[0] ?? "") && cells[0] !== "File")
    .map(([path = "", sha256 = ""]) => ({
      path: path.replace(/^`|`$/g, ""),
      sha256: sha256.replace(/^`|`$/g, ""),
    }));
}

describe("Appduct fixture apps", () => {
  it("lists every tracked file under e2e/fixtures/appduct/ except the README in the README's table, with the SHA-256 of the file on disk", () => {
    const files = trackedFixtures()
      .map((file) => file.path)
      .filter((path) => path !== "README.md");
    const table = readmeTable();

    expect(files.length).toBeGreaterThan(0);
    expect(table.map((row) => row.path).sort()).toEqual(expect.arrayContaining(files.sort()));
    for (const row of table.filter((entry) => files.includes(entry.path))) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      const onDisk = createHash("sha256")
        .update(readFileSync(join(REPO_ROOT, FIXTURES, row.path)))
        .digest("hex");
      expect(onDisk, row.path).toBe(row.sha256);
    }
  });

  it("tracks ios/AppductPlayground.app/Info.plist, ios/AppductPlayground.app/AppductPlayground and android/AppductPlayground.apk under exactly those names", () => {
    const paths = trackedFixtures().map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "ios/AppductPlayground.app/Info.plist",
        "ios/AppductPlayground.app/AppductPlayground",
        "android/AppductPlayground.apk",
      ]),
    );
  });

  it("lists no file in the README's table that git does not track under e2e/fixtures/appduct/", () => {
    const tracked = trackedFixtures().map((file) => file.path);
    const table = readmeTable();

    expect(table.length).toBeGreaterThan(0);
    expect(table.map((row) => row.path).filter((path) => !tracked.includes(path))).toEqual([]);
  });

  it("tracks the iOS executable ios/AppductPlayground.app/AppductPlayground with mode 100755", () => {
    const executable = trackedFixtures().find(
      (file) => file.path === "ios/AppductPlayground.app/AppductPlayground",
    );

    expect(executable?.mode).toBe("100755");
  });

  it("has a Repo: line naming https://github.com/callstackincubator/appduct and a Commit: line with 40 lowercase hex digits", () => {
    const text = readme();

    expect(text).toMatch(/^Repo: https:\/\/github\.com\/callstackincubator\/appduct$/m);
    expect(text).toMatch(/^Commit: `[0-9a-f]{40}`$/m);
  });
});
