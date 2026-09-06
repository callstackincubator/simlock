import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const daemonDir = join(dirname(gatewayDir), "daemon");

/**
 * ADR 0005 §33: "`src/gateway/` imports nothing from `drivers`, and from `core` only the
 * platform-agnostic queue and bus modules it reuses; never the registry, capacity, or lifecycle
 * modules (enforced like `src/contract/boundary.test.ts`)."
 *
 * In this PR the gateway reuses nothing from `core` at all -- the fleet queue arrives with #118
 * -- so the allowance is written as an explicit list rather than a blanket "core is fine": a
 * gateway that starts importing `../core/registry.js` should fail here, and a later PR adding
 * `../core/wait-queue.js` should have to say so in this list rather than silently widening the
 * boundary. `src/http` is off limits for the same reason (`GatewayTokenStore` is a structural
 * interface precisely so the token store need not be imported), as are `src/cli`, `src/mcp` and
 * `src/drivers`.
 */
const FORBIDDEN_IMPORT_PREFIXES = ["../core", "../drivers", "../http", "../cli", "../mcp"];

/**
 * The only `src/daemon` module the gateway may import: the transport-facing dispatch contract
 * (`DispatchSession`, `DispatchError`, `runDispatch`). It is core-free by construction -- see
 * the second test below, which asserts exactly that, so this allowance cannot become a back
 * door into the worker's engine.
 */
const ALLOWED_DAEMON_IMPORTS = ["../daemon/dispatch.js"];

describe("gateway module boundary", () => {
  const sourceFiles = readdirSync(gatewayDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  it("found the gateway's own source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)("%s imports no engine module", (fileName) => {
    const contents = readFileSync(join(gatewayDir, fileName), "utf8");

    for (const specifier of importSpecifiers(stripComments(contents))) {
      for (const forbidden of FORBIDDEN_IMPORT_PREFIXES) {
        expect({ fileName, specifier, startsWith: specifier.startsWith(forbidden) }).toEqual({
          fileName,
          specifier,
          startsWith: false,
        });
      }
      if (specifier.startsWith("../daemon")) {
        expect(ALLOWED_DAEMON_IMPORTS).toContain(specifier);
      }
    }
  });

  it("the one daemon module the gateway imports is itself free of core", () => {
    const contents = stripComments(readFileSync(join(daemonDir, "dispatch.ts"), "utf8"));

    for (const specifier of importSpecifiers(contents)) {
      expect(specifier.startsWith("../core")).toBe(false);
      expect(specifier.startsWith("../drivers")).toBe(false);
      expect(specifier.startsWith("../http")).toBe(false);
    }
  });
});

/** Strips block and line comments so a specifier that appears only in prose (a doc comment
 * naming a forbidden import, as several in this module do) is never mistaken for a real one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `from "…"` specifier in the (comment-stripped) text -- catches formatter-wrapped
 * multi-line imports too, since the `from "…"` clause always lands on one line. */
function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const pattern = /from\s*["']([^"']+)["']/g;
  for (const match of contents.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}
