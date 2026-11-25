/**
 * why: Test-only (excluded from the build): the one import scanner every module-boundary test uses.
 *
 * A boundary test enforces its rule only where it looks (testing rule 4), so the scanning lives
 * here once rather than in each test: three hand-written copies had drifted apart -- one saw only
 * `from "…"`, missing a dynamic `import("…")` and a bare side-effect `import "…"`; one listed a
 * single directory and never a subdirectory; one compared the raw specifier text, so
 * `"./../core/index.js"` passed as "inside this module" and a nested file's longer `"../../core"`
 * matched no `"../core"` prefix.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** why: Strips block and line comments so a specifier that appears only in prose (a doc comment
 * naming a forbidden import) is never mistaken for a real one. Good enough for this repo's
 * source, which never puts `//` inside an import specifier string. */
export function stripComments(source: string): string {
  // why: a block comment leaves its newlines behind, so a report that counts lines in the
  // stripped text names the line the reported code is actually written on.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/\/\/.*$/gm, "");
}

/**
 * why: Every module specifier a static `import ... from "…"`, a bare side-effect `import "…"`, a
 * re-export (`export ... from "…"`), or a dynamic `import("…")` names, in comment-stripped text.
 * Formatter-wrapped multi-line static imports are still caught because the `from "…"` clause
 * always lands on one line; the dynamic form is its own pattern -- without it, a boundary
 * enforced on every static import could be routed around with one `await import("…")`.
 */
export function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/(?:from|import)\s*["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

export function normalizeSpecifier(fileDir: string, specifier: string, root = srcDir): string {
  if (!specifier.startsWith(".")) return specifier;
  return posix.relative(slashed(root), posix.normalize(posix.join(slashed(fileDir), specifier)));
}

// why: a path from `node:path` has `\` on Windows, and the `posix` calls here read only `/`.
function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isUnder(normalized: string, dir: string): boolean {
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

export function sourceFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

export interface ModuleImport {
  readonly file: string;
  readonly specifier: string;
  readonly normalized: string;
}

export function importsOf(files: readonly string[], root = srcDir): ModuleImport[] {
  return files.flatMap((filePath) =>
    importSpecifiers(stripComments(readFileSync(filePath, "utf8"))).map((specifier) => ({
      file: posix.relative(slashed(root), slashed(filePath)),
      normalized: normalizeSpecifier(dirname(filePath), specifier, root),
      specifier,
    })),
  );
}
