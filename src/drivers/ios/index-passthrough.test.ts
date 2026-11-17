import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, describe } from "vitest";
import { PassthroughRefusedError } from "../../core/index.js";
import {
  ScriptedProcessRunner,
  SystemClock,
  NodeFilesystem,
  NodeProcessRunner,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { deviceRoot } from "./test-slim.js";
import {
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  prepareFull,
  scopedRunners,
  simctlPassthrough,
} from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver", () => {
  it("scopes a simctl passthrough to the device set the way its own calls are scoped", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(simctlPassthrough(driver, ["install", "booted", "./MyApp.app"])).resolves.toEqual({
      args: ["simctl", "--set", deviceRoot, "install", "booted", "./MyApp.app"],
      command: "xcrun",
      env: {},
    });
  });

  it("fills a simctl device verb's missing device with the lease's UDID", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));
    const udid = "6F1D2A8C-3B4E-4F7A-9C2D-8E5B1A7F3C90";
    const simulator = { address: "", deviceId: udid, driverData: {}, physical: false } as const;
    const scoped = ["simctl", "--set", deviceRoot];
    const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
      [
        ["install", "/b/App.app"],
        ["install", udid, "/b/App.app"],
      ],
      [
        ["launch", "--console", "com.x"],
        ["launch", "--console", udid, "com.x"],
      ],
      [
        ["launch", "-a", "arm64", "com.x"],
        ["launch", "-a", "arm64", udid, "com.x"],
      ],
      [
        ["spawn", "-s", "launchctl", "list"],
        ["spawn", "-s", udid, "launchctl", "list"],
      ],
      [
        ["io", "screenshot", "/tmp/s.png"],
        ["io", udid, "screenshot", "/tmp/s.png"],
      ],
      [
        ["install", udid, "/b/App.app"],
        ["install", udid, "/b/App.app"],
      ],
      [
        ["install", udid.toLowerCase(), "/b/App.app"],
        ["install", udid.toLowerCase(), "/b/App.app"],
      ],
      [
        ["list", "devices"],
        ["list", "devices"],
      ],
      [
        ["runtime", "list"],
        ["runtime", "list"],
      ],
    ];

    for (const [args, expected] of cases) {
      await expect(
        driver.passthrough("simctl", simulator, args, { hasTerminal: false, platform: "ios" }),
      ).resolves.toEqual({ args: [...scoped, ...expected], command: "xcrun", env: {} });
    }
  });

  it("refuses a simctl command that names another device, or that runs on another platform", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));
    const udid = "6F1D2A8C-3B4E-4F7A-9C2D-8E5B1A7F3C90";
    const other = "0A1B2C3D-0000-4000-8000-123456789ABC";
    const simulator = { address: "", deviceId: udid, driverData: {}, physical: false } as const;
    const refusal = (command: string, named: string) =>
      `Refusing \`simctl ${command}\`: it names device ${named}, and this lease holds ${udid}. Leave the device out; Simlock fills it in.`;
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["install", other, "/b/App.app"], refusal(`install ${other} /b/App.app`, other)],
      [["install", "booted", "/b/App.app"], refusal("install booted /b/App.app", "booted")],
      [
        ["launch", "--console", "booted", "com.x"],
        refusal("launch --console booted com.x", "booted"),
      ],
    ];

    for (const [args, message] of cases) {
      await expect(
        driver.passthrough("simctl", simulator, args, { hasTerminal: false, platform: "ios" }),
      ).rejects.toMatchObject({ message, tool: "simctl" });
    }
    await expect(
      driver.passthrough("simctl", simulator, ["install", "/b/App.app"], {
        hasTerminal: false,
        platform: "android",
      }),
    ).rejects.toMatchObject({
      message:
        "Refusing `simctl`: it only serves an iOS simulator, and this lease is on the android platform.",
      tool: "simctl",
    });
  });

  it.each([["create"], ["erase"], ["delete"]])(
    "refuses to proxy %s, naming the command that reclaims a device properly",
    async (verb) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      await expect(simctlPassthrough(driver, [verb, "ABCD"])).rejects.toThrow(
        PassthroughRefusedError,
      );
      await expect(simctlPassthrough(driver, [verb, "ABCD"])).rejects.toThrow(/simlock release/);
      await expect(simctlPassthrough(driver, [verb, "ABCD"])).rejects.toThrow(/simlock cleanup/);
    },
  );

  it("finds the refused verb past a leading flag rather than only in first position", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(simctlPassthrough(driver, ["--verbose", "delete", "ABCD"])).rejects.toThrow(
      PassthroughRefusedError,
    );
  });

  it("proxies a refused word that is an argument rather than the subcommand", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect((await simctlPassthrough(driver, ["spawn", "booted", "log", "erase"])).args).toContain(
      "erase",
    );
  });

  it.each([
    [["--profiles", "/tmp", "erase", "all"]],
    [["--set", "/tmp", "delete", "all"]],
    [["--set=/tmp", "create", "sim"]],
  ])(
    "refuses a caller-supplied scoping flag rather than reading its value as the subcommand: %j",
    async (args) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      // why: The bug this pins was not the flag itself: the flag's separated value was found as
      // the subcommand, so the refused verb behind it was never seen, and the wrapper
      // answered with `--set <simlockRoot>` prepended -- Simlock handing over the very path
      // that contains every other agent's devices.
      await expect(simctlPassthrough(driver, args)).rejects.toThrow(PassthroughRefusedError);
      await expect(simctlPassthrough(driver, args)).rejects.toThrow(
        /supplies the device set itself/,
      );
    },
  );

  it("refuses any unrecognized flag ahead of the subcommand, rather than skipping over it as presumed harmless", async () => {
    // why: Round 4, F6: structurally the same escape round 3 closed on the Android side
    // (`--reply-fd 9 -H attacker.example`). Before this fix, an unrecognized `-...` token was
    // treated as a no-value flag and the scan continued to the next argument -- so a
    // caller-supplied global's *value* was read as the subcommand, and the real
    // `--set`/`--profiles` behind it was never seen by `#assertProxyable` at all: this exact
    // line used to stop the scan at `/tmp` (mistaken for the subcommand), so the trailing
    // `--set /evil` was never scanned for refusal and rode through to `xcrun simctl` unchecked.
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(
      simctlPassthrough(driver, ["-x", "/tmp", "--set", "/evil", "boot", "UDID"]),
    ).rejects.toThrow(PassthroughRefusedError);
  });

  it("refuses to shut down every device in the set at once", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(simctlPassthrough(driver, ["shutdown", "all"])).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(simctlPassthrough(driver, ["shutdown", "all"])).rejects.toThrow(/simlock release/);
  });

  it("still proxies shutting a single device down by udid", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect((await simctlPassthrough(driver, ["shutdown", "ABCD"])).args).toEqual([
      "simctl",
      "--set",
      deviceRoot,
      "shutdown",
      "ABCD",
    ]);
  });

  it("refuses to delete a runtime shared with Xcode and other tools", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(simctlPassthrough(driver, ["runtime", "delete", "26.5"])).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(simctlPassthrough(driver, ["runtime", "delete", "26.5"])).rejects.toThrow(
      /shared with Xcode and other tools/,
    );
    await expect(simctlPassthrough(driver, ["runtime", "delete", "26.5"])).rejects.toThrow(
      /through Xcode/,
    );
  });

  it("does not say in the runtime delete refusal that iOS runtimes cannot be downloaded", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    let message = "";
    try {
      await simctlPassthrough(driver, ["runtime", "delete", "26.5"]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/shared with Xcode/);
    expect(message).not.toMatch(/download|install/i);
  });

  it("points the runtime delete refusal at simlock component remove", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(simctlPassthrough(driver, ["runtime", "delete", "26.5"])).rejects.toThrow(
      /use `simlock component remove ios <version>`/,
    );
  });

  it("still proxies the runtime operations that only read", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect((await simctlPassthrough(driver, ["runtime", "list"])).args).toEqual([
      "simctl",
      "--set",
      deviceRoot,
      "runtime",
      "list",
    ]);
  });

  it.skipIf(process.env.SIMLOCK_LIVE_IOS !== "1")(
    "runs a provision-to-destroy smoke test against simctl",
    async () => {
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new SystemClock(),
        driverConfig: {},
        filesystem: new NodeFilesystem(),
        idGenerator: { generate: () => `test-${process.pid}` },
        instanceId: `live-${process.pid}`,
        processRunner: new NodeProcessRunner(),
        simlockHome: join(tmpdir(), `simlock-live-ios-${process.pid}`),
      });
      let device: Awaited<ReturnType<IosSimctlDriver["provision"]>> | undefined;

      try {
        const liveSpec = await driver.resolveSpec({ model: "iPhone 17 Pro", platform: "ios" });
        device = await driver.provision(liveSpec);
        await driver.makeReady(device, prepareFull);
      } finally {
        if (device !== undefined) {
          await driver.destroy(device);
        }
      }
    },
    150_000,
  );
});
