import { readFileSync } from "node:fs";
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
