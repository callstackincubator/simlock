import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blankSource } from "../test-support/source-text.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// why: each option names a port whose production adapter reads this host when the daemon starts: the load probe reads its memory, the directory-access reader runs `powershell.exe` on Windows before the daemon serves (#1932). `exempt` is the file that tests which adapter a daemon builds; each start there picks one on purpose, and one leaves it out to prove the production default.
const HOST_READERS = [
  { option: "hostLoadProbe", exempt: "src/daemon/main-host-load.test.ts" },
  { option: "directoryAccess", exempt: undefined },
] as const;

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
function declarationNamesOption(
  code: string,
  name: string,
  before: number,
  option: string,
): boolean | undefined {
  const declarations = [
    ...code.matchAll(new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`, "g")),
  ];
  const declared = declarations.filter((match) => match.index < before).at(-1) ?? declarations[0];
  if (declared === undefined) return undefined;
  const body = code.indexOf("{", declared.index);
  return new RegExp(`\\b${option}\\b`).test(code.slice(body, closing(code, body)));
}

function namesOption(source: Source, argument: string, at: number, option: string): boolean {
  if (new RegExp(`\\b${option}\\b`).test(argument)) return true;
  const name = /^\s*([\w$.]+)/.exec(argument)?.[1]?.split(".").at(-1);
  if (name === undefined) return false;
  return (
    declarationNamesOption(source.code, name, at, option) ??
    source.imported.some(
      (imported) => declarationNamesOption(imported.code, name, Infinity, option) === true,
    )
  );
}

function startsWithout(path: string, option: string): string[] {
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
    if (namesOption(source, argument, call.index, option)) return [];
    return [`${repoPath(path)}:${String(source.code.slice(0, call.index).split("\n").length)}`];
  });
}

describe("daemons started by tests under src/", () => {
  it.each(HOST_READERS)(
    "pass $option, so none builds the production adapter that reads this host",
    ({ option, exempt }) => {
      const files = ["src", "packages"].flatMap((root) => typeScriptFiles(join(repoRoot, root)));
      const found = files
        .filter((path) => repoPath(path) !== "src/daemon/main.ts" && repoPath(path) !== exempt)
        .flatMap((path) => startsWithout(path, option));

      expect(found).toEqual([]);
    },
  );
});
