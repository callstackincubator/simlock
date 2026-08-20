import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);
const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk = existsSync(ANDROID_HOME);

async function simctlRuntimeNames(): Promise<string[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const parsed = JSON.parse(stdout) as { runtimes: { name: string }[] };
  return parsed.runtimes.map((runtime) => runtime.name).sort();
}

function androidSystemImages(): string[] {
  const root = join(ANDROID_HOME, "system-images");
  if (!existsSync(root)) return [];
  return readdirSync(root).sort();
}

/**
 * safety.md #4: missing runtimes / system images fail the request unless
 * `--allow-download` was explicitly passed. This flow never passes it, and asserts
 * the installed-runtime inventory is byte-for-byte the same before and after --
 * the strongest evidence available short of an actual network-activity monitor that
 * nothing multi-GB was pulled down as a side effect of any command this suite ran.
 */
describe.skipIf(process.platform !== "darwin")(
  "no-implicit-download invariant",
  { tags: ["slow", "ios", "android"] },
  () => {
    it(
      "leaves installed iOS runtimes and Android system images unchanged across a normal lease/release/doctor/cleanup/nuke cycle",
      { timeout: 300_000 },
      async () => {
        const iosRuntimesBefore = await simctlRuntimeNames();
        const androidImagesBefore = androidSystemImages();

        const env = await withDaemon({ driver: "real" });
        try {
          const catalog = await env.cli(["catalog", "--json"]);
          expect(catalog.code).toBe(0);
          const platforms = (
            catalog.json as { platforms: { platform: string; models: string[] }[] }
          ).platforms;
          const ios = platforms.find((platform) => platform.platform === "ios");

          if (ios !== undefined && ios.models.length > 0) {
            const lease = await env.cli(
              [
                "lease",
                "--platform",
                "ios",
                "--device",
                ios.models[0] as string,
                "--agent-id",
                "no-download",
                "--detach",
              ],
              { timeout: 120_000 },
            );
            expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
            const grant = lease.json as { lease: string };
            await env.cli(["release", grant.lease]);
          }

          await env.cli(["doctor"]);
          await env.cli(["cleanup", "--dry-run"]);
          await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 60_000 });
        } finally {
          // No cleanup beyond nuke above: this flow must never touch anything besides
          // what pitlane itself created and already destroyed.
        }

        const iosRuntimesAfter = await simctlRuntimeNames();
        expect(iosRuntimesAfter).toEqual(iosRuntimesBefore);

        if (hasAndroidSdk) {
          const androidImagesAfter = androidSystemImages();
          expect(androidImagesAfter).toEqual(androidImagesBefore);
        }
      },
    );
  },
);
