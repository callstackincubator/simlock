import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  readonly scripts: Readonly<Record<string, string>>;
};

function script(name: string): string {
  const command = packageJson.scripts[name];
  if (command === undefined) throw new Error(`package.json has no script "${name}"`);
  return command;
}

function tagsFilter(command: string): string | undefined {
  const found = /--tags-filter(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
  return found?.[1] ?? found?.[2] ?? found?.[3];
}

/** why: vitest evaluates tags-filter expressions at run time; this mirrors its `!`, `&&`, `||` and parentheses so the lanes can be checked without running it. */
function selects(filter: string | undefined, tags: readonly string[]): boolean {
  if (filter === undefined) return true;
  const tokens = filter.match(/&&|\|\||!|\(|\)|[^\s&|!()]+/g) ?? [];
  let position = 0;

  function parseOr(): boolean {
    let value = parseAnd();
    while (tokens[position] === "||") {
      position += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  function parseAnd(): boolean {
    let value = parseNot();
    while (tokens[position] === "&&") {
      position += 1;
      const right = parseNot();
      value = value && right;
    }
    return value;
  }

  function parseNot(): boolean {
    const token = tokens[position];
    position += 1;
    if (token === "!") return !parseNot();
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position] !== ")") throw new Error(`unbalanced parentheses in "${filter}"`);
      position += 1;
      return inner;
    }
    if (token === undefined || token === ")" || token === "&&" || token === "||") {
      throw new Error(`unexpected "${token ?? "end"}" in "${filter}"`);
    }
    return tags.includes(token);
  }

  const result = parseOr();
  if (position !== tokens.length) throw new Error(`trailing tokens in "${filter}"`);
  return result;
}

const FAST = [] as const;
const SLOW_IOS = ["slow", "ios"] as const;
const PHYSICAL = ["slow", "ios", "physical"] as const;
const PHYSICAL_MANUAL = ["slow", "ios", "physical-manual"] as const;

describe("tags-filter evaluator", () => {
  it("selects a tag only when the filter names it without a leading !", () => {
    expect(selects("physical", ["physical"])).toBe(true);
    expect(selects("physical", ["slow"])).toBe(false);
    expect(selects("!physical", ["physical"])).toBe(false);
    expect(selects("!physical", ["slow"])).toBe(true);
    expect(selects("!a && !b", ["b"])).toBe(false);
    expect(selects("!a && !b", ["c"])).toBe(true);
    expect(selects("a || b", ["b"])).toBe(true);
    expect(selects(undefined, ["anything"])).toBe(true);
  });
});

describe("test lanes (package.json)", () => {
  it("test:e2e:slow excludes physical and physical-manual tests and keeps the other slow ones", () => {
    const filter = tagsFilter(script("test:e2e:slow"));

    expect(selects(filter, SLOW_IOS)).toBe(true);
    expect(selects(filter, PHYSICAL)).toBe(false);
    expect(selects(filter, PHYSICAL_MANUAL)).toBe(false);
  });

  it("test:e2e excludes slow tests, so neither phone file runs in it", () => {
    const filter = tagsFilter(script("test:e2e"));

    expect(selects(filter, FAST)).toBe(true);
    expect(selects(filter, SLOW_IOS)).toBe(false);
    expect(selects(filter, PHYSICAL)).toBe(false);
    expect(selects(filter, PHYSICAL_MANUAL)).toBe(false);
  });

  it("test:e2e:physical selects physical tests and not physical-manual ones, without file parallelism", () => {
    const command = script("test:e2e:physical");
    const filter = tagsFilter(command);

    expect(filter).toBeDefined();
    expect(selects(filter, PHYSICAL)).toBe(true);
    expect(selects(filter, PHYSICAL_MANUAL)).toBe(false);
    expect(selects(filter, SLOW_IOS)).toBe(false);
    expect(command).toContain("--no-file-parallelism");
  });

  it("test:e2e:physical-manual selects physical-manual tests only, without file parallelism", () => {
    const command = script("test:e2e:physical-manual");
    const filter = tagsFilter(command);

    expect(filter).toBeDefined();
    expect(selects(filter, PHYSICAL_MANUAL)).toBe(true);
    expect(selects(filter, PHYSICAL)).toBe(false);
    expect(selects(filter, SLOW_IOS)).toBe(false);
    expect(command).toContain("--no-file-parallelism");
  });

  it("vitest.config.ts declares the physical and physical-manual tags", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");

    expect(config).toMatch(/name:\s*"physical"/);
    expect(config).toMatch(/name:\s*"physical-manual"/);
  });

  it("the `unit` project and the mutation config leave out `*.timing.test.ts`, the `timing` project takes them and runs files one at a time, `pnpm test` runs `test:timing`, and CI's `quality` job needs the `timing` job", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    const mutate = readFileSync(join(REPO_ROOT, "vitest.mutate.config.ts"), "utf8");
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const unitProject = /name:\s*"unit"[\s\S]*?name:\s*"(?:timing|e2e)"/.exec(config)?.[0] ?? "";
    const timingProject = /name:\s*"timing"[\s\S]*?(?:name:\s*"e2e"|$)/.exec(config)?.[0] ?? "";
    const quality = /\n {2}quality:[\s\S]*$/.exec(ci)?.[0] ?? "";

    expect(unitProject).toContain("*.timing.test.ts");
    expect(mutate).toContain("*.timing.test.ts");
    expect(timingProject).toContain("src/**/*.timing.test.ts");
    expect(timingProject).toMatch(/fileParallelism:\s*false/);
    expect(script("test:timing")).toContain("--project timing");
    expect(script("test")).toContain("test:timing");
    expect(quality).toMatch(/needs:\s*\[[^\]]*\btiming\b/);
  });
});

/** why: a job's block is its two-space-indented key and every line up to the next one. */
function ciJobs(ci: string): ReadonlyMap<string, string> {
  const body = /\njobs:\n([\s\S]*)$/.exec(ci)?.[1] ?? "";
  const jobs = new Map<string, string>();
  for (const block of body.split(/\n(?= {2}[a-z][\w-]*:\n)/)) {
    const id = /^ {2}([a-z][\w-]*):\n/.exec(block)?.[1];
    if (id !== undefined) jobs.set(id, block);
  }
  return jobs;
}

function runScript(job: string): string {
  const body = /\n {8}run: \|\n((?: {10}[^\n]*\n?)+)/.exec(job)?.[1] ?? "";
  return body.replace(/^ {10}/gm, "");
}

/** why: Quality and Console each run one script over the results of the jobs they need. */
function verdictOf(job: string, results: string): number | null {
  return spawnSync("bash", ["-c", runScript(job)], {
    env: { PATH: process.env["PATH"] ?? "", RESULTS: results },
  }).status;
}

// why: the lane holds only what needs a real daemon or a real browser engine, about four
// minutes of one runner's two workers, so two shards keep each well inside the job timeout.
const CONSOLE_SHARDS_AT_LEAST = 2;

describe("the console lane in CI (.github/workflows/ci.yml)", () => {
  it("runs the console lane over a matrix of at least two Chromium-only shards, and the required `Console` check needs that job and fails when it does not pass", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const jobs = [...ciJobs(ci)];
    const lanes = jobs.filter(([, job]) => job.includes("pnpm test:console"));
    const required = jobs.find(([, job]) => /\n {4}name: Console\n/.test(job));

    expect(lanes.map(([id]) => id)).toHaveLength(1);
    const [laneId, lane] = lanes[0] ?? ["", ""];
    const shards = /\n {8}shard: \[([^\]]*)\]/.exec(lane)?.[1]?.split(",") ?? [];
    expect(shards.length, "shards in the console lane's matrix").toBeGreaterThanOrEqual(
      CONSOLE_SHARDS_AT_LEAST,
    );
    const runs = lane.match(/pnpm test:console[^\n]*/g) ?? [];
    expect(runs, "the lane's Chromium-only command").toHaveLength(1);
    expect(runs[0]).toContain("--project=chromium");
    expect(lane).not.toMatch(/firefox|webkit|macos/i);
    expect(lane).toContain("runs-on: ubuntu-24.04");
    expect(lane, "the shard index comes from the matrix").toMatch(
      /\n {10}SHARD: \$\{\{ matrix\.shard \}\}/,
    );
    for (const run of runs) {
      expect(run, "index from the matrix, count from its length").toMatch(
        new RegExp(`--shard="\\$SHARD/${shards.length}"`),
      );
    }

    expect(required, "a job named Console").toBeDefined();
    const [requiredId, requiredJob] = required ?? ["", ""];
    expect(requiredId).not.toBe(laneId);
    expect(requiredJob).toMatch(new RegExp(`\\n {4}needs: \\[[^\\]]*\\b${laneId}\\b`));
    expect(requiredJob).toMatch(/\n {4}if: (\$\{\{ )?always\(\)/);
    expect(runScript(requiredJob), "the Console job's run script").not.toBe("");
    const verdict = (results: string) => verdictOf(requiredJob, results);
    expect(verdict("success skipped success"), "every need passed or was skipped").toBe(0);
    for (const bad of ["success failure", "cancelled", "skipped failure skipped"]) {
      expect(verdict(bad), `results ${bad}`).toBe(1);
    }
  });
});

// why: one Windows runner spends 11 to 17 minutes in the unit tests, and every other job ends
// within 5.
const WINDOWS_SHARDS_AT_LEAST = 3;

describe("the Windows unit job in CI (.github/workflows/ci.yml)", () => {
  it("runs `pnpm run test:unit` as `Unit tests (Windows) (<shard>/<shards>)` over a matrix of at least three shards on windows-2025 under bash with a 30 minute limit, `quality` needs it, and text files check out with LF", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const attributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");
    const jobs = ciJobs(ci);
    const windows = jobs.get("windows-unit") ?? "";
    const shards = /\n {8}shard: \[([^\]]*)\]/.exec(windows)?.[1]?.split(",") ?? [];

    expect(windows, "a job `windows-unit`").not.toBe("");
    expect(shards.length, "shards in the Windows job's matrix").toBeGreaterThanOrEqual(
      WINDOWS_SHARDS_AT_LEAST,
    );
    expect(windows).toContain(
      `\n    name: Unit tests (Windows) (\${{ matrix.shard }}/${shards.length})\n`,
    );
    expect(windows).toContain("runs-on: windows-2025");
    expect(windows).toMatch(/\n {6}shell: bash\n|\n {4}defaults:\n {6}run:\n {8}shell: bash\n/);
    expect(windows).toContain("timeout-minutes: 30");
    expect(windows, "one red shard does not cancel the others").toContain("fail-fast: false");
    expect(windows, "the shard index comes from the matrix").toMatch(
      /\n {10}SHARD: \$\{\{ matrix\.shard \}\}/,
    );
    expect(windows, "index from the matrix, count from its length").toContain(
      `run: pnpm run test:unit --shard="$SHARD/${shards.length}"\n`,
    );
    expect(jobs.get("quality")).toMatch(/needs:\s*\[[^\]]*\bwindows-unit\b/);
    expect(attributes.split("\n")).toContain("* text=auto eol=lf");
  });

  it("runs on every push to main, and on a pull request that changes a source, test or script file, a workflow or tool config the unit tests run, or a root build file; one that changes only docs, website pages, agent config, e2e files, the Swift package or a workflow the tests only read skips it; a Changes job that failed runs it; skipped, it leaves `Quality` green, and failed or cancelled it fails `Quality`", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const jobs = ciJobs(ci);
    const windows = jobs.get("windows-unit") ?? "";
    const changes = jobs.get("changes") ?? "";
    const quality = jobs.get("quality") ?? "";
    expect(runScript(changes), "the Changes job's run script").not.toBe("");
    // why: the script reads the changed files from git and writes its answer to a file; here
    // git prints the list under test and the file is printed when the script ends.
    const script = [
      `git() { printf '%s\\n' "$CHANGED"; }`,
      `GITHUB_OUTPUT=$(mktemp)`,
      `trap 'cat "$GITHUB_OUTPUT"; rm -f "$GITHUB_OUTPUT"' EXIT`,
      runScript(changes),
    ].join("\n");
    const answer = (event: string, changed: readonly string[]) => {
      const run = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "",
          GITHUB_EVENT_NAME: event,
          CHANGED: changed.join("\n"),
        },
      });
      return /^windows=(.*)$/m.exec(run.stdout)?.[1];
    };

    expect(windows).toMatch(/\n {4}needs: changes\n/);
    expect(windows).toMatch(
      /\n {4}if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.windows != 'false' \}\}\n/,
    );
    expect(changes).toMatch(/\n {6}windows: \$\{\{ steps\.filter\.outputs\.windows \}\}\n/);
    expect(answer("push", ["docs/internal/DELIVERY.md"]), "a push to main").toBe("true");
    for (const skipped of [
      ["docs/internal/adr/0092-device-tags.md", "docs/internal/adr/README.md"],
      ["website/src/content/docs/docs/reference/cli.mdx", "README.md"],
      ["e2e/console/leases.spec.ts", "e2e/helpers/setup.ts", "playwright.config.ts"],
      [".claude/agents/reviewer.md", ".agents/briefs/build.md", "AGENTS.md"],
      ["vendor/screen-capture/Package.swift", ".github/workflows/website.yml"],
      [".github/labels.json", "CHANGELOG.md"],
    ]) {
      expect(answer("pull_request", skipped), skipped.join(" ")).toBe("false");
    }
    for (const run of [
      "src/leasing/create-leasing.ts",
      "src/leasing/create-leasing.test.ts",
      "ui/src/model/inbox.ts",
      "packages/e2e/src/index.ts",
      "scripts/slow-e2e.sh",
      ".agents/scripts/merge-pr.sh",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.build.json",
      "vitest.config.ts",
      "lefthook.yml",
      ".gitattributes",
      ".oxlintrc.json",
      ".dependency-cruiser.mjs",
      ".dependency-cruiser.cycles.mjs",
      ".dependency-cruiser-known-violations.json",
      ".dependency-cruiser-known-cycles.json",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]) {
      expect(answer("pull_request", ["docs/internal/DELIVERY.md", run]), run).toBe("true");
    }

    expect(quality).toMatch(/\n {4}if: (\$\{\{ )?always\(\)/);
    expect(verdictOf(quality, "success success skipped success"), "skipped").toBe(0);
    for (const bad of ["success success failure success", "success cancelled success"]) {
      expect(verdictOf(quality, bad), `results ${bad}`).toBe(1);
    }
  });
});

describe("the Windows job runs every unit test file", () => {
  it("no list of Windows-skipped files exists, `vitest.config.ts` gives the `unit` project the same excludes on every host, and `testing.md` holds no list exception", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    const testing = readFileSync(join(REPO_ROOT, "docs/internal/agent-rules/testing.md"), "utf8");
    const unitProject = /name:\s*"unit"[\s\S]*?name:\s*"ui-dom"/.exec(config)?.[0] ?? "";

    expect(unitProject).toContain("*.timing.test.ts");
    expect(existsSync(join(REPO_ROOT, "src/test-support/windows-skipped.ts"))).toBe(false);
    expect(unitProject).not.toMatch(/win32|windows|platform/i);
    expect(testing).not.toContain("windows-skipped");
  });
});
