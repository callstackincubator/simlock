import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = 150;

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
)
  .split("\0")
  .filter((name) => name.length > 0 && existsSync(join(REPO_ROOT, name)));

const manuals = trackedFiles.filter((name) => /^src\/(?:.+\/)?AGENTS\.md$/.test(name));
const flows = trackedFiles.filter((name) => /^docs\/internal\/flows\/[^/]+\.md$/.test(name));
const MAP = "docs/internal/ARCHITECTURE.md";

const modules = [
  ...new Set(
    trackedFiles
      .filter((name) => /^src\/[^/]+\/.+\.ts$/.test(name))
      .map((name) => name.split("/").slice(0, 2).join("/")),
  ),
];

const PATH_TOKEN = /^[\w@.-]+(?:\/[\w@.-]+)*(?:\.(?:ts|tsx|mjs|js|md)|\/)$/;

function lines(doc: string): string[] {
  return readFileSync(join(REPO_ROOT, doc), "utf8").split("\n");
}

function resolves(doc: string, target: string): boolean {
  return [dirname(doc), ".", "src"].some((base) => existsSync(join(REPO_ROOT, base, target)));
}

function missingPaths(doc: string): string[] {
  return lines(doc).flatMap((text, index) =>
    [...text.matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1] ?? "")
      .filter((token) => PATH_TOKEN.test(token) && !resolves(doc, token))
      .map((token) => `${doc}:${index + 1}: ${token}`),
  );
}

function brokenLinks(doc: string): string[] {
  return lines(doc).flatMap((text, index) =>
    [...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => (match[1] ?? "").replace(/#.*$/, ""))
      .filter((target) => target !== "" && !/^[a-z]+:/.test(target))
      .filter((target) => !existsSync(join(REPO_ROOT, dirname(doc), target)))
      .map((target) => `${doc}:${index + 1}: ${target}`),
  );
}

describe("module manuals, flow docs and the architecture map", () => {
  it("are found, the leasing manual and the startup flow among them", () => {
    expect(manuals).toContain("src/leasing/AGENTS.md");
    expect(flows).toContain("docs/internal/flows/startup.md");
  });

  it("cover every module under src/", () => {
    expect(modules).toEqual(expect.arrayContaining(["src/core", "src/leasing", "src/gateway"]));
    expect(modules.filter((module) => !manuals.includes(`${module}/AGENTS.md`))).toEqual([]);
  });

  it("each manual sits beside a CLAUDE.md that only imports it", () => {
    const offenders = manuals.filter((manual) => {
      const claude = join(REPO_ROOT, dirname(manual), "CLAUDE.md");
      return !existsSync(claude) || readFileSync(claude, "utf8") !== "@AGENTS.md\n";
    });

    expect(offenders).toEqual([]);
  });

  it(`each manual and flow doc fits in ${BUDGET} lines; the map has no budget`, () => {
    const over = [...manuals, ...flows]
      .map((doc) => ({ doc, count: lines(doc).length - 1 }))
      .filter(({ count }) => count > BUDGET)
      .map(({ doc, count }) => `${doc}: ${count}`);

    expect(over).toEqual([]);
  });

  it("name only .ts, .tsx, .mjs, .js and .md files, and directories, that exist", () => {
    expect([...manuals, ...flows, MAP].flatMap(missingPaths)).toEqual([]);
  });

  it("link only to files that exist", () => {
    expect([...manuals, ...flows, MAP].flatMap(brokenLinks)).toEqual([]);
  });

  it("the architecture map links every manual", () => {
    const map = readFileSync(join(REPO_ROOT, MAP), "utf8");
    const linked = [...map.matchAll(/\]\(\.\.\/\.\.\/(src\/[^)#\s]+\/AGENTS\.md)\)/g)].map(
      (match) => match[1],
    );

    expect(manuals.filter((manual) => !linked.includes(manual))).toEqual([]);
  });
});
