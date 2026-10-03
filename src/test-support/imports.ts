/**
 * Test-only (excluded from the build): the one import scanner every module-boundary test uses.
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

/** The repository's `src/` directory: the root normalized specifiers are relative to. */
export const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Strips block and line comments so a specifier that appears only in prose (a doc comment
 * naming a forbidden import) is never mistaken for a real one. Good enough for this repo's
 * source, which never puts `//` inside an import specifier string. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Every module specifier a static `import ... from "…"`, a bare side-effect `import "…"`, a
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

/**
 * A relative import specifier, resolved against the directory of the file that wrote it and
 * expressed relative to `root` (`src/` unless a test scans another tree) -- e.g.
 * `"../../core/registry.js"` from `src/gateway/routing/policy.ts` becomes `"core/registry.js"`,
 * exactly like `"../core/registry.js"` from `src/gateway/policy.ts` and `"./../core/registry.js"`
 * from anywhere directly under `src/gateway/` do. A non-relative specifier (an npm package, a
 * `node:` built-in) is returned unchanged: it can never resolve inside `root`.
 */
export function normalizeSpecifier(fileDir: string, specifier: string, root = srcDir): string {
  if (!specifier.startsWith(".")) return specifier;
  return posix.relative(root, posix.normalize(posix.join(fileDir, specifier)));
}

/** Whether a normalized specifier names a module inside the top-level directory `dir` of the
 * scanned root -- `dir` itself (an import of its barrel, `"core"` with no further path) or
 * anything under it. */
export function isUnder(normalized: string, dir: string): boolean {
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

/** Every `.ts` file under `dir`, subdirectories included, except test files. */
export function sourceFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

export interface ModuleImport {
  /** The importing file, relative to the scanned root. */
  readonly file: string;
  readonly specifier: string;
  /** `specifier` as `normalizeSpecifier` resolves it. */
  readonly normalized: string;
}

/** Every import each of `files` makes, comments stripped and specifiers normalized against
 * `root`. */
export function importsOf(files: readonly string[], root = srcDir): ModuleImport[] {
  return files.flatMap((filePath) =>
    importSpecifiers(stripComments(readFileSync(filePath, "utf8"))).map((specifier) => ({
      file: posix.relative(root, filePath),
      normalized: normalizeSpecifier(dirname(filePath), specifier, root),
      specifier,
    })),
  );
}
