import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blankSource } from "../test-support/source-text.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// why: the file that tests which probe a daemon builds; each start there picks its probe on purpose, and one leaves it out to prove the production default.
const PROBE_TESTS = "src/daemon/main-host-load.test.ts";

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function repoPath(path: string): string {
  return relative(repoRoot, path).split("\\").join("/");
}

function closing(code: string, open: number): number {
  const pair = code[open] === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++;
    else if (code[i] === pair && --depth === 0) return i;
  }
  return code.length;
}

interface Source {
  readonly code: string;
  readonly imported: readonly Source[];
}

function load(path: string): Source {
  const text = readFileSync(path, "utf8");
  const specifiers = [...blankSource(text).matchAll(/from\s*["'](\.{1,2}\/[^"']+)\.js["']/g)];
  return {
    code: blankSource(text, { strings: true }),
    get imported() {
      return specifiers
        .map((specifier) => join(dirname(path), `${specifier[1]}.ts`))
        .filter((imported) => existsSync(imported))
        .map((imported) => ({
          code: blankSource(readFileSync(imported, "utf8"), { strings: true }),
          imported: [],
        }));
    },
  };
}

// why: a start whose options are built elsewhere (`startDaemon(options())`, `startDaemon(prepared.startOptions)`) names the option where that name is declared: the nearest declaration before the call in its file, else one in a file it imports.
function declarationNames(
  option: RegExp,
  code: string,
  name: string,
  before: number,
): boolean | undefined {
  const declarations = [
    ...code.matchAll(new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`, "g")),
  ];
  const declared = declarations.filter((match) => match.index < before).at(-1) ?? declarations[0];
  if (declared === undefined) return undefined;
  const body = code.indexOf("{", declared.index);
  return option.test(code.slice(body, closing(code, body)));
}

function names(option: RegExp, source: Source, argument: string, at: number): boolean {
  if (option.test(argument)) return true;
  const name = /^\s*([\w$.]+)/.exec(argument)?.[1]?.split(".").at(-1);
  if (name === undefined) return false;
  return (
    declarationNames(option, source.code, name, at) ??
    source.imported.some(
      (imported) => declarationNames(option, imported.code, name, Infinity) === true,
    )
  );
}

function startsWithout(option: RegExp, path: string): string[] {
  const text = readFileSync(path, "utf8");
  if (
    !/import\s*\{[^}]*\bstartDaemon\b[^}]*\}\s*from\s*["'][./]*(?:daemon\/)?main\.js["']/.test(
      blankSource(text),
    )
  ) {
    return [];
  }
  const source = load(path);
  return [...source.code.matchAll(/\bstartDaemon\s*\(/g)].flatMap((call) => {
    const open = call.index + call[0].length - 1;
    const argument = source.code.slice(open + 1, closing(source.code, open));
    if (names(option, source, argument, call.index)) return [];
    return [`${repoPath(path)}:${String(source.code.slice(0, call.index).split("\n").length)}`];
  });
}

describe("daemons started by tests under src/", () => {
  const files = () => ["src", "packages"].flatMap((root) => typeScriptFiles(join(repoRoot, root)));

  it("pass a hostLoadProbe, so none builds the production probe and reads this host's memory", () => {
    const found = files()
      .filter((path) => repoPath(path) !== "src/daemon/main.ts" && repoPath(path) !== PROBE_TESTS)
      .flatMap((path) => startsWithout(/\bhostLoadProbe\b/, path));

    expect(found).toEqual([]);
  });

  it("pass a directoryAccess reader, so none starts PowerShell on Windows to read its data directory's ACL", () => {
    const found = files()
      .filter((path) => repoPath(path) !== "src/daemon/main.ts")
      .flatMap((path) => startsWithout(/\bdirectoryAccess\b/, path));

    expect(found).toEqual([]);
  });
});
