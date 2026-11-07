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
    const star = /^export \* from ["']([^"']+)["'];?$/.exec(s);
    const starAs = /^export \* as (\w+) from ["']([^"']+)["'];?$/.exec(s);
    const list = /^export (?:type )?\{([^}]*)\}(?: from ["']([^"']+)["'])?;?$/.exec(s);
    if (star !== null) {
      for (const [n, t] of exportsOf(target(file, star[1]), seen)) add(n, t);
    } else if (starAs !== null) {
      const inner = [...exportsOf(target(file, starAs[2]), new Set())].map(
        ([n, t]) => `${n}: ${t}`,
      );
      add(starAs[1], `namespace { ${inner.sort().join("; ")} }`);
    } else if (list !== null) {
      for (const item of list[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        const [, local, alias] = /^(?:type )?(\S+)(?: as (\S+))?$/.exec(item) ?? [];
        if (local === undefined) continue;
        const text =
          list[2] === undefined
            ? localDeclaration(file, statements, local, seen)
            : exportsOf(target(file, list[2]), new Set()).get(local);
        add(alias ?? local, text ?? `unresolved ${local}`);
      }
    } else if (s.startsWith("export ")) {
      const name = declaredName(s);
      if (name !== null) add(name, squash(s.replace(/^export (?:default )?(?:declare )?/, "")));
    }
  }
  return found;
}

// why: `export { a }` names a declaration of the same file, or an import of one from another.
function localDeclaration(file, statements, name, seen) {
  const own = statements.filter((s) => !s.startsWith("export ") && declaredName(s) === name);
  if (own.length > 0) return own.map((s) => squash(s.replace(/^declare /, ""))).join(" ");
  for (const s of statements) {
    const imported = /^import (?:type )?\{([^}]*)\} from ["']([^"']+)["'];?$/.exec(s);
    if (imported === null) continue;
    for (const item of imported[1].split(",").map((x) => x.trim())) {
      const [, from, as] = /^(?:type )?(\S+)(?: as (\S+))?$/.exec(item) ?? [];
      if ((as ?? from) === name)
        return exportsOf(target(file, imported[2]), new Set(seen)).get(from);
    }
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

// why: a statement ends at a `;` at depth 0, or at a `}` back at depth 0 that ends its line, as
// an interface, a class or a namespace does; `export { a } from` ends at its `;`.
function statementsOf(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("{([<".includes(c) && !(c === "<" && text[i + 1] === "=")) depth++;
    else if ("})]".includes(c) || (c === ">" && text[i - 1] !== "="))
      depth = Math.max(0, depth - 1);
    const rest = text.slice(i + 1);
    const block = c === "}" && /^[ \t]*(?:\r?\n|$)/.test(rest) && !/^\s*[|&.[]/.test(rest);
    const ends = depth === 0 && (c === ";" || block);
    if (ends) {
      const s = squash(text.slice(start, i + 1));
      if (s !== "" && s !== ";") out.push(s.replace(/;$/, ""));
      start = i + 1;
    }
  }
  const tail = squash(text.slice(start));
  if (tail !== "") out.push(tail);
  return out;
}
