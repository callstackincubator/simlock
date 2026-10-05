import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  importsOf,
  isUnder,
  normalizeSpecifier,
  sourceFilesRecursive,
  srcDir,
  stripComments,
} from "../test-support/imports.js";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const daemonDir = join(srcDir, "daemon");

/**
 * ADR 0005 §33: "`src/gateway/` imports nothing from `drivers`, and from `core` only the
 * platform-agnostic queue and bus modules it reuses; never the registry, capacity, or lifecycle
 * modules (enforced like `src/contract/boundary.test.ts`)."
 *
 * `drivers`, `http`, `cli`, and `mcp` stay wholesale forbidden -- `src/http` for the same reason
 * as always (`GatewayTokenStore` is a structural interface precisely so the token store need not
 * be imported). `core` is *not* in this list any more: #118 is the "later PR adding
 * `core/wait-queue.js`" the old comment here predicted, and it has to say so explicitly rather
 * than silently widening the boundary -- see `ALLOWED_CORE_IMPORTS` below, checked the same way
 * `ALLOWED_DAEMON_IMPORTS` already was.
 *
 * Named as top-level directories under `src/`, matched against a specifier normalised relative
 * to `src/` (see `normalizeSpecifier`) rather than against the raw text of the specifier -- a
 * literal `"../core"` prefix check (C2) only catches an import written from a file directly
 * under `src/gateway/`; a nested module (`src/gateway/routing/policy.ts`, which #118 adds)
 * reaches core as `"../../core/registry.js"`, which does not start with `"../core"`, so the
 * check silently stopped applying to exactly the files a subdirectory newly reaches.
 */
const FORBIDDEN_IMPORT_DIRS = ["drivers", "http", "cli", "mcp"];

/**
 * The only `src/daemon` module the gateway may import: the transport-facing dispatch contract
 * (`DispatchSession`, `DispatchError`, `runDispatch`). It is core-free by construction -- see
 * the second test below, which asserts exactly that, so this allowance cannot become a back
 * door into the worker's engine. Written normalised (relative to `src/`) for the same reason as
 * `FORBIDDEN_IMPORT_DIRS` above.
 */
const ALLOWED_DAEMON_IMPORTS = ["daemon/dispatch.js"];

/**
 * #118's fleet queue and its ownership check reuse `core`'s platform-agnostic FIFO
 * (`wait-queue.js`) and short critical-section serializer (`serialized-decision.js`) rather than
 * forking either -- ADR 0005 §33's "only the platform-agnostic queue and bus modules it reuses".
 * `domain.js` and `driver.js` are here too, explicitly, as the doc comment on the old
 * (now-removed) blanket `core` entry above asked the PR that widened this list to do: they are
 * `wait-queue.js`'s own transitive *type* imports (`DeviceRecord`/`LeaseRecord`/`DeviceSpec` and
 * `DeviceRequest`), which the fleet queue and coordinator need to name the same shapes wait-queue
 * itself is typed against rather than redeclaring them. `usage/index.js` is `usage.get`'s one
 * answerer (ADR 0016 §1, §6): the same reader serves a worker and a gateway, so the window rounding
 * and the memo exist once. It imports the bus, the contract and the pure figures module, nothing of
 * the registry, capacity or lifecycle engine. Neither module is the registry, capacity,
 * or lifecycle engine §33 keeps off limits -- `domain.js` is pure data shapes and a spec-equality
 * predicate, `driver.js` is interface declarations only. `catalog-match.js` is the one place a
 * request's model or class is read against a catalog (ADR 0015 §8; architecture rule 10): pure
 * functions over a catalog entry, so the gateway matches exactly as a worker does.
 */
const ALLOWED_CORE_IMPORTS = [
  "core/wait-queue.js",
  "core/lease-request-book.js",
  "core/serialized-decision.js",
  "core/domain.js",
  "core/driver.js",
  "core/catalog-match.js",
  "core/usage/index.js",
];

describe("gateway module boundary", () => {
  const sourceFiles = sourceFilesRecursive(gatewayDir);

  it("found the gateway's own source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles.map((path) => [path.slice(gatewayDir.length + 1), path] as const))(
    "%s imports no engine module",
    (relativePath, filePath) => {
      for (const { specifier, normalized } of importsOf([filePath])) {
        for (const forbidden of FORBIDDEN_IMPORT_DIRS) {
          expect({
            fileName: relativePath,
            normalized,
            specifier,
            matchesForbiddenDir: isUnder(normalized, forbidden),
          }).toEqual({
            fileName: relativePath,
            normalized,
            specifier,
            matchesForbiddenDir: false,
          });
        }
        if (isUnder(normalized, "daemon")) {
          expect(ALLOWED_DAEMON_IMPORTS).toContain(normalized);
        }
        if (isUnder(normalized, "core")) {
          expect(ALLOWED_CORE_IMPORTS).toContain(normalized);
        }
      }
    },
  );

  it("the one daemon module the gateway imports is itself free of core", () => {
    for (const { normalized } of importsOf([join(daemonDir, "dispatch.ts")])) {
      expect(isUnder(normalized, "core")).toBe(false);
      expect(isUnder(normalized, "drivers")).toBe(false);
      expect(isUnder(normalized, "http")).toBe(false);
    }
  });
});

/**
 * H9 (round 2 review): the reverse direction from the one this file otherwise checks. Before
 * this, `src/daemon/error-code.ts` imported `NoCapacityError` from
 * `src/gateway/fleet-coordinator.js` just to recognize it in an `instanceof` branch, so every
 * worker-mode daemon -- not just gateway mode -- pulled the whole gateway module graph (and
 * `src/admin`'s client) into ordinary startup, with nothing here to notice. `main.ts` is the one
 * legitimate exception: it is the composition root that wires up whichever mode `config.mode`
 * names, and gateway mode's own wiring (`GatewayService`, `FleetLeaseCoordinator`,
 * `GatewayOwnerRoutedFacts`, ...) has to live somewhere that can see both.
 */
describe("daemon module boundary (reverse direction, H9)", () => {
  const daemonSourceFiles = sourceFilesRecursive(daemonDir).filter(
    (path) => path !== join(daemonDir, "main.ts"),
  );

  it("found the daemon's own source files (excluding main.ts, the composition root)", () => {
    expect(daemonSourceFiles.length).toBeGreaterThan(0);
  });

  it.each(daemonSourceFiles.map((path) => [path.slice(daemonDir.length + 1), path] as const))(
    "%s does not import src/gateway",
    (relativePath, filePath) => {
      for (const { normalized } of importsOf([filePath])) {
        expect({
          fileName: relativePath,
          matchesGateway: isUnder(normalized, "gateway"),
          normalized,
        }).toEqual({
          fileName: relativePath,
          matchesGateway: false,
          normalized,
        });
      }
    },
  );
});

describe("gateway module boundary regression fixtures", () => {
  // C2, made concrete: a hypothetical nested module reaching for a forbidden `core` module
  // through a longer relative path. Against the pre-fix `specifier.startsWith("../core")`
  // check, this import passed silently -- `"../../core/registry.js"` does not start with
  // `"../core"` -- even though it reaches exactly the kind of module the boundary exists to
  // keep out. `core/registry.js` is the registry itself, never in `ALLOWED_CORE_IMPORTS` (only
  // `wait-queue.js`/`serialized-decision.js`/`domain.js`/`driver.js` are, per #118) -- so a
  // nested file reaching it is caught the same way the daemon-allowlist gap below is: recognized
  // as `core`, and absent from the allowlist that governs it.
  it("catches a nested module importing core through a longer relative path", () => {
    const nestedDir = join(gatewayDir, "routing");
    const specifier = "../../core/registry.js";
    const normalized = normalizeSpecifier(nestedDir, specifier);

    expect(isUnder(normalized, "core")).toBe(true);
    expect(ALLOWED_CORE_IMPORTS).not.toContain(normalized);
  });

  // And the matching allowlist gap: `"../../daemon/dispatcher.js"` does not start with
  // `"../daemon"` either, so the pre-fix allowlist branch was never entered for a nested file --
  // it would neither pass as allowed nor fail as forbidden, just vanish from the check entirely.
  it("still recognizes a nested module's daemon import as a daemon import to check against the allowlist", () => {
    const nestedDir = join(gatewayDir, "routing");
    const normalized = normalizeSpecifier(nestedDir, "../../daemon/dispatcher.js");

    expect(isUnder(normalized, "daemon")).toBe(true);
    expect(ALLOWED_DAEMON_IMPORTS).not.toContain(normalized);
  });
});

describe("the relay is the bus's only republisher", () => {
  // ADR 0014 §2: `republish` carries a worker's id and timestamp, so it is not a second way to
  // state a fact. Counted over every non-test source file, `src/bus` included.
  it("only the gateway's worker link calls republish", () => {
    const callers = sourceFilesRecursive(srcDir)
      .filter((file) => /\.republish\s*[<(]/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(srcDir, file));

    expect(callers).toEqual(["gateway/worker-link.ts"]);
  });
});
