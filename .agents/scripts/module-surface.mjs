#!/usr/bin/env node
// `node .agents/scripts/module-surface.mjs [<dir>]`: prints the surface of every module in the
// checkout at <dir> (default the working directory), one sorted line per export of each tracked
// `src/**/index.ts`: `<path> <name>: <its declaration>`, as the checkout's own `tsc` emits it
// into a scratch folder (comments dropped, whitespace squashed). A re-export is followed to the
// file that declares the name, so two checkouts with the same lines export the same names with
// the same declarations, wherever the code behind them lives. A name a declaration only refers
// to is compared by its spelling, not its shape. `refactor-check.mjs` compares the lines at a
// refactor's two ends (delivery rule 18). Exit 2 when tsc emits no declarations.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// why: tsc starts every top-level statement of a .d.ts at the start of a line, with a keyword,
// and indents the rest of it or closes it with `}`.
const STATEMENT =
  /^(?:export|import|declare|interface|type|function|class|abstract|const|let|var|enum|namespace|module)\b/;

const dir = resolve(process.argv[2] ?? ".");
const out = mkdtempSync(join(tmpdir(), "module-surface-"));
try {
  const indexes = execFileSync("git", ["ls-files", "src/**/index.ts", "src/index.ts"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p !== "");
  // why: a type error elsewhere does not stop tsc emitting declarations, and the surface is
  // what it emits; the commit hook and CI judge the errors.
  spawnSync(
    join(dir, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.json", "--emitDeclarationOnly", "--removeComments", "--outDir", out],
    { cwd: dir, stdio: "ignore" },
  );
  const lines = [];
  for (const path of indexes) {
    const dts = join(out, relative("src", path).replace(/\.ts$/, ".d.ts"));
    if (!existsSync(dts)) {
      console.error(`module-surface: tsc emitted no declarations for ${path}`);
      process.exit(2);
    }
    for (const [name, text] of exportsOf(dts, new Set())) lines.push(`${path} ${name}: ${text}`);
  }
  console.log([...new Set(lines)].sort().join("\n"));
} finally {
  rmSync(out, { recursive: true, force: true });
}

// why: a name is followed through every re-export to the statements that declare it, so a move
// changes no line.
function exportsOf(file, seen) {
  const found = new Map();
  if (seen.has(file)) return found;
  seen.add(file);
  const statements = statementsOf(readFileSync(file, "utf8"));
  const add = (name, text) => found.set(name, [found.get(name), text].filter(Boolean).join(" "));
  for (const s of statements) {
    for (const [name, text] of exportedBy(s, { file, statements, seen })) add(name, text);
  }
  return found;
}

// why: one statement exports through a star, a list or its own declaration.
function exportedBy(s, at) {
  const star = /^export \* from ["']([^"']+)["']$/.exec(s);
  if (star !== null) return [...exportsOf(target(at.file, star[1]), at.seen)];
  const starAs = /^export \* as (\w+) from ["']([^"']+)["']$/.exec(s);
  if (starAs !== null) {
    const inner = [...exportsOf(target(at.file, starAs[2]), new Set())].map(
      ([n, t]) => `${n}: ${t}`,
    );
    return [[starAs[1], `namespace { ${inner.sort().join("; ")} }`]];
  }
  const list = /^export (?:type )?\{([^}]*)\}(?: from ["']([^"']+)["'])?$/.exec(s);
  if (list !== null)
    return names(list[1]).map(([local, alias]) => [alias, listed(at, local, list[2])]);
  const name = s.startsWith("export ") ? declaredName(s) : null;
  return name === null ? [] : [[name, squash(s.replace(/^export (?:default )?(?:declare )?/, ""))]];
}

function listed(at, local, from) {
  const text =
    from === undefined
      ? localDeclaration(at.file, at.statements, local, at.seen)
      : exportsOf(target(at.file, from), new Set()).get(local);
  return text ?? `unresolved ${local}`;
}

// why: `a, type b as c` names a local `b` exported as `c`.
function names(list) {
  return list
    .split(",")
    .map((x) => /^(?:type )?(\S+)(?: as (\S+))?$/.exec(x.trim()))
    .filter((m) => m !== null)
    .map(([, local, alias]) => [local, alias ?? local]);
}

// why: `export { a }` names a declaration of the same file, or an import of one from another.
function localDeclaration(file, statements, name, seen) {
  const own = statements.filter((s) => !s.startsWith("export ") && declaredName(s) === name);
  if (own.length > 0) return own.map((s) => squash(s.replace(/^declare /, ""))).join(" ");
  for (const s of statements) {
    const imported = /^import (?:type )?\{([^}]*)\} from ["']([^"']+)["'];?$/.exec(s);
    if (imported === null) continue;
    const hit = names(imported[1]).find(([, as]) => as === name);
    if (hit !== undefined) return exportsOf(target(file, imported[2]), new Set(seen)).get(hit[0]);
  }
  return undefined;
}

function declaredName(s) {
  const m =
    /^(?:export )?(?:default )?(?:declare )?(?:abstract )?(?:function|class|interface|type|enum|namespace|module|const|let|var) (\w+)/.exec(
      s,
    );
  if (m !== null) return m[1];
  return /^export default\b/.test(s) ? "default" : null;
}

function target(from, specifier) {
  const base = join(dirname(from), specifier.replace(/\.js$/, ""));
  return [`${base}.d.ts`, join(base, "index.d.ts")].find(existsSync) ?? `${base}.d.ts`;
}

function squash(s) {
  return s.replace(/\s+/g, " ").trim();
}

function statementsOf(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (STATEMENT.test(line) || out.length === 0) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out.map((s) => squash(s).replace(/;$/, "")).filter((s) => s !== "");
}
