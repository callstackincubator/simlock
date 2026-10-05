import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

/** The installed, available iOS runtimes' versions, as real simctl reports them. */
async function installedRuntimes(): Promise<string[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const parsed = JSON.parse(stdout) as {
    runtimes: { version: string; isAvailable: boolean; platform?: string }[];
  };
  return parsed.runtimes
    .filter((runtime) => runtime.isAvailable && (runtime.platform ?? "iOS") === "iOS")
    .map((runtime) => runtime.version);
}

/** The major number of a dotted version. */
function major(version: string): number {
  return Number.parseInt(version, 10);
}

// This lane needs the real simctl toolchain, hence darwin-only. It never installs a runtime:
// the RUNTIME_MISSING lines below run with --allow-download and must still not download.
describe.skipIf(process.platform !== "darwin")(
  "iOS --os ranges (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "fails --os '<=17' at once with RUNTIME_MISSING with and without --allow-download when nothing older than 18 is installed, grants --os '>=18' a device on 18.0 or newer, and refuses --os '^18' with BAD_REQUEST",
      { timeout: 600_000 },
      async () => {
        await sweepStaleDeviceSets();
        const runtimes = await installedRuntimes();
        expect(
          runtimes.filter((version) => major(version) < 18),
          "this lane needs a host with nothing older than iOS 18 installed",
        ).toEqual([]);
        expect(
          runtimes.filter((version) => major(version) >= 18).length,
          "this lane needs at least one installed iOS runtime of 18 or newer",
        ).toBeGreaterThan(0);

        const env = await withDaemon({ driver: "real" });

        for (const extra of [[], ["--allow-download"]]) {
          const missing = await env.cli(
            ["lease", "--platform", "ios", "--os", "<=17", "--agent-id", "os-range", ...extra],
            { timeout: 60_000 },
          );
          expect(missing.code, `expected RUNTIME_MISSING (exit 12): ${missing.stderr}`).toBe(12);
          expect(missing.error?.code).toBe("RUNTIME_MISSING");
        }

        const malformed = await env.cli([
          "lease",
          "--platform",
          "ios",
          "--os",
          "^18",
          "--agent-id",
          "os-range",
        ]);
        expect(malformed.code, malformed.stderr).not.toBe(0);
        expect(malformed.error?.code).toBe("BAD_REQUEST");

        const granted = await env.cli(
          ["lease", "--platform", "ios", "--os", ">=18", "--agent-id", "os-range", "--detach"],
          { timeout: 300_000 },
        );
        expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
        const grant = granted.json as {
          device: { spec: { osVersion: string } };
          lease: { id: string };
        };
        expect(major(grant.device.spec.osVersion)).toBeGreaterThanOrEqual(18);

        await env.cli(["release", grant.lease.id]);
        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );
  },
);
