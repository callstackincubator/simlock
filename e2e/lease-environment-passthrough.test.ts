import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

/**
 * The half of containment that faces the lease holder. Everything a Simlock device lives
 * in -- an iOS device set Xcode does not read, an adb server the user's `adb` does not talk
 * to -- is also invisible to the agent that just leased it, so a grant that did not carry
 * the scoping, and wrappers that did not inject it, would hand out an unreachable device.
 */
describe("reaching a leased device", () => {
  it("carries the driver's environment on the grant, as JSON and as shell exports", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        knownModels: ["iPhone 16"],
        availableOsVersions: ["18.4"],
        // A device root is a configurable path: the quote and the space are the two
        // characters a naive `--export-env` corrupts.
        leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/Users/o'brien/My Sims/devices/ios" },
      },
    });

    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--agent-id",
      "env-json-agent",
      "--detach",
    ]);
    expect(lease.code).toBe(0);
    const grant = lease.json as { lease: string; environment: Record<string, string> };
    expect(grant.environment).toEqual({
      SIMLOCK_IOS_DEVICE_SET: "/Users/o'brien/My Sims/devices/ios",
    });
    await env.cli(["release", grant.lease]);

    const exported = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--agent-id",
      "env-export-agent",
      "--detach",
      "--export-env",
    ]);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toBe(
      "export SIMLOCK_IOS_DEVICE_SET='/Users/o'\\''brien/My Sims/devices/ios'\n",
    );
    // The assertion that matters is a real shell's, not a string comparison: what
    // `eval "$(simlock lease ... --export-env)"` puts in the environment has to be the
    // path byte for byte, quote and space included.
    const evaluated = await execFileAsync("/bin/sh", [
      "-c",
      `${exported.stdout}printf %s "$SIMLOCK_IOS_DEVICE_SET"`,
    ]);
    expect(evaluated.stdout).toBe("/Users/o'brien/My Sims/devices/ios");
  });

  it("scopes a passthrough to the driver's root and returns the tool's own exit code", async () => {
    const env = await withDaemon();

    const passthrough = await env.cli(["adb", "shell", "input", "tap", "100", "200"], {
      env: { SIMLOCK_FAKE_PASSTHROUGH_EXIT: "7" },
    });

    expect(passthrough.code).toBe(7);
    expect(JSON.parse(passthrough.stdout)).toEqual([
      "/fake/android",
      "shell",
      "input",
      "tap",
      "100",
      "200",
    ]);
  });

  it.each([
    [["simctl", "delete", "ABCD"], "simctl delete"],
    [["adb", "kill-server"], "adb kill-server"],
    [["adb", "-s", "emulator-5586", "emu", "kill"], "adb emu kill"],
  ])("refuses %s with a usage error naming what to run instead", async (args, refused) => {
    const env = await withDaemon();

    const refusal = await env.cli(args);

    expect(refusal.code).toBe(2);
    expect(refusal.error?.code).toBe("USAGE");
    expect(refusal.error?.message).toContain(refused);
    expect(refusal.error?.message).toContain("simlock release");
    expect(refusal.stdout).toBe("");
  });
});
