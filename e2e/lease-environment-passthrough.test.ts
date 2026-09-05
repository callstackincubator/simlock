import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FAKE_LEASE_ENVIRONMENT } from "./fake-driver/fake-driver.js";
import { withDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

/**
 * The half of containment that faces the lease holder. Everything a Simlock device lives
 * in -- an iOS device set Xcode does not read, an adb server the user's `adb` does not talk
 * to -- is also invisible to the agent that just leased it, so a grant that did not carry
 * the scoping, and wrappers that did not inject it, would hand out an unreachable device.
 */
describe("reaching a leased device", () => {
  /**
   * The propagation proof. Nothing here sets `leaseEnvironment`, so the grant carries the fake
   * driver's own defaults -- values chosen to be impossible to produce by accident anywhere
   * downstream. Finding them verbatim in the CLI's JSON means the map made it from the driver,
   * through the core (which forwards it without reading a key), through the contract's output
   * validation at the daemon boundary, over the socket, and out of the CLI's renderer.
   *
   * Asserting `toEqual` rather than `toMatchObject` on purpose: an extra key appearing from
   * somewhere would mean a layer is contributing to a map only drivers are allowed to build.
   */
  it("carries the driver's own environment through every layer, untouched", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--agent-id",
      "env-tracer-agent",
      "--detach",
    ]);
    expect(lease.code).toBe(0);
    const grant = lease.json as { lease: string; environment: Record<string, string> };
    expect(grant.environment).toEqual(FAKE_LEASE_ENVIRONMENT.ios);

    // ... and the same values survive the shell round trip the wrappers exist for, including
    // the deliberately awkward one.
    const exported = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--agent-id",
      "env-tracer-export-agent",
      "--detach",
      "--export-env",
    ]);
    expect(exported.code).toBe(0);
    const evaluated = await execFileAsync("/bin/sh", [
      "-c",
      `${exported.stdout}printf %s "$SIMLOCK_FAKE_AWKWARD"`,
    ]);
    expect(evaluated.stdout).toBe(FAKE_LEASE_ENVIRONMENT.ios["SIMLOCK_FAKE_AWKWARD"]);

    await env.cli(["release", grant.lease]);
  });

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
    // Released rather than left to the TTL: this flow is about the grant, and leaving a
    // lease outstanding would make it share a failure mode with the shutdown flow that
    // covers that case deliberately (`daemon lifecycle & recovery`).
    const exportedGrant = JSON.parse((await env.cli(["status", "--json"])).stdout) as {
      readonly leases: readonly { readonly id: string }[];
    };
    for (const lease of exportedGrant.leases) {
      await env.cli(["release", lease.id]);
    }
  });

  /**
   * Both wrappers, because they are two different drivers answering the same operation and
   * the CLI knows the names but nothing else: which flag scopes the tool, and what its
   * environment has to carry, are the driver's to decide (architecture rule 2).
   *
   * `platform` is the load-bearing half. The daemon *returning* an environment in the
   * resolved command proves nothing on its own -- what the lease holder needs is for it to
   * reach the tool's own process, which only a real spawn can show. `argv` proves the
   * scoping, `platform` proves the injection, and the exit code proves the CLI reports the
   * tool's own result rather than its own.
   */
  it.each([
    ["adb", "android", ["shell", "input", "tap", "100", "200"]],
    ["simctl", "ios", ["list", "devices"]],
  ])(
    "scopes a %s passthrough to its driver's root and injects its environment",
    async (tool, platform, args) => {
      const env = await withDaemon();

      const passthrough = await env.cli([tool, ...args], {
        env: { SIMLOCK_FAKE_PASSTHROUGH_EXIT: "7" },
      });

      // The tool's own exit code, not the CLI's: a wrapper that swallowed it would make
      // `simlock adb shell ...` useless in a script.
      expect(passthrough.code).toBe(7);
      expect(JSON.parse(passthrough.stdout)).toEqual({
        argv: [`/fake/${platform}`, ...args],
        platform,
      });
    },
  );

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
