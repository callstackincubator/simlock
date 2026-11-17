import { describe, expect, it } from "vitest";
import { PassthroughRefusedError } from "../../core/index.js";
import {
  FakeTcpListenerFactory,
  FakeTcpProbe,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  ProcessSpawnError,
  ScriptedProcessRunner,
  type StreamingProcessHandle,
} from "../../ports/index.js";
import { AndroidDriver } from "./index.js";
import { emulatorHelpListing } from "./testing.js";
import {
  sdk,
  adb,
  avdDirectory,
  PHONE,
  VERSION_REPLY_41,
  VERSION_REPLY_40,
  ADB_VERSION_41,
  PHYSICAL,
  PHYSICAL_SPEC,
  OK,
  FAILED,
  TIMED_OUT,
  PhoneAdb,
  world,
  androidFilesystem,
  restOf,
  isDevicesListing,
  isGetprop,
  isUserRead,
  isPackageList,
  defaultServerSends,
  passthroughOf,
  rejectionOf,
} from "./test-physical-handler.js";

const HOST_VERSION = "000chost:version";

const ADB_VERSION_40 = "Android Debug Bridge version 1.0.40\nVersion 34.0.0-9570255\n";

class SplitRunner implements ProcessRunner {
  constructor(
    private readonly phone: PhoneAdb,
    private readonly emulator: ScriptedProcessRunner,
  ) {}

  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return this.#isPhone(args)
      ? this.phone.run(command, args, options)
      : this.emulator.run(command, args, options);
  }

  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle {
    return this.#isPhone(args)
      ? this.phone.spawn(command, args, options)
      : this.emulator.spawn(command, args, options);
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    return this.emulator.spawnStreaming(command, args, options);
  }

  #isPhone(args: readonly string[]): boolean {
    return args[0] === "version" || (args[0] === "-P" && args[1] === "5037");
  }
}

function econnrefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5037"), { code: "ECONNREFUSED" });
}

function isUninstall(rest: readonly string[]): boolean {
  return rest.includes("uninstall");
}

function isRuleCommand(rest: readonly string[]): boolean {
  return rest[2] === "reverse" || rest[2] === "forward";
}

function hostVersionSends(probe: FakeTcpProbe) {
  return defaultServerSends(probe).filter((send) => send.payload === HOST_VERSION);
}

async function advisoriesOf(
  driver: AndroidDriver,
): Promise<readonly { readonly code: string; readonly message: string }[]> {
  return driver.advisories();
}

/** why: a refusal test starts from the same input accepted, so it cannot pass for another reason. */
async function expectReclaimAccepted(): Promise<void> {
  const accepted = await world();
  await expect(accepted.driver.reclaim(PHYSICAL, { clean: "standard" })).resolves.toMatchObject({
    strategy: "uninstall",
  });
}

const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;

function sdkTool(name: "avdmanager" | "sdkmanager"): string {
  return `${sdk}/cmdline-tools/latest/bin/${name}`;
}

function scripted(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return { match: { args, command }, result: { code: 0, stderr: "", stdout } };
}

describe("Android physical handler: the protocol gate", () => {
  it("sends one host:version to port 5037 with a 5000 ms limit right before every adb command a physical method sends, and nothing else to 5037", async () => {
    const { driver, runner, probe, log } = await world();

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });
    const commandsBeforePassthrough = runner.commands.length;
    const sendsBeforePassthrough = defaultServerSends(probe).length;
    await passthroughOf(driver, ["shell", "getprop"]);

    expect(defaultServerSends(probe).length).toBe(commandsBeforePassthrough + 1);
    expect(defaultServerSends(probe).length).toBe(sendsBeforePassthrough + 1);
    for (const send of defaultServerSends(probe)) {
      expect(send).toMatchObject({ payload: HOST_VERSION, port: 5037, timeoutMs: 5000 });
    }
    const ordered = log.filter(
      (entry) => entry !== `adb:version` && !entry.startsWith("send:5038:"),
    );
    ordered.forEach((entry, index) => {
      if (entry.startsWith("adb:")) {
        expect(ordered[index - 1], `no host:version right before ${entry}`).toBe(
          `send:5037:${HOST_VERSION}`,
        );
      }
    });
  });

  it("estimate and leaseEnvironment on a physical device send nothing to 5037 and start no process", async () => {
    const { driver, runner, probe } = await world();

    driver.estimate({ clean: "standard", operation: "reclaim" }, PHYSICAL_SPEC);
    driver.leaseEnvironment(PHYSICAL);

    expect(defaultServerSends(probe)).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("a server that turns to another protocol after adb devices -l gets no getprop from inspectPhysical, which is refused not-connected naming both versions", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isDevicesListing(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
    expect((inspection as { message: string }).message).toMatch(/40/);
    expect((inspection as { message: string }).message).toMatch(/41/);
    expect(runner.rests.some(isGetprop)).toBe(false);
  });

  it("a server that turns to another protocol after adb devices -l answers that serial not present not-present, with no getprop", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isDevicesListing(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.rests.some(isGetprop)).toBe(false);
  });

  it("a server that turns to another protocol after the first uninstall makes reclaim reject with no second uninstall", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isUninstall(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it("two passthrough calls on a physical device send two host:version: nothing keeps the server's answer", async () => {
    const { driver, probe } = await world();

    await passthroughOf(driver, ["shell", "getprop"]);
    await passthroughOf(driver, ["shell", "getprop"]);

    expect(hostVersionSends(probe)).toHaveLength(2);
  });

  it("after advisories() saw a mismatch, a passthrough whose own check matches returns its command", async () => {
    const { driver, probe } = await world({ serverReply: VERSION_REPLY_40 });
    expect(await advisoriesOf(driver)).toHaveLength(1);
    probe.replyWith(VERSION_REPLY_41);

    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(command.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
  });

  it("after advisories() saw a match, a passthrough whose own check sees another version is refused", async () => {
    const { driver, probe } = await world();
    expect(await advisoriesOf(driver)).toEqual([]);
    probe.replyWith(VERSION_REPLY_40);

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it("no physical method and no passthrough result runs kill-server or start-server, and dispose() sends nothing to 5037", async () => {
    const { driver, runner, probe } = await world();

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });
    const command = await passthroughOf(driver, ["shell", "getprop"]);
    const sendsBefore = defaultServerSends(probe).length;
    await driver.dispose();

    const words = [...runner.calls.map((call) => call.args), command.args].flat();
    expect(words).not.toContain("kill-server");
    expect(words).not.toContain("start-server");
    expect(defaultServerSends(probe).every((send) => send.payload === HOST_VERSION)).toBe(true);
    expect(defaultServerSends(probe).slice(sendsBefore)).toEqual([]);
  });

  it("with a default server of another protocol, no physical method starts a process after adb version: every serial is not present, inspectPhysical is refused naming both protocol numbers, reclaim rejects", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const present = await driver.listPresentPhysical([
      { driverDeviceId: PHONE },
      { driverDeviceId: "SERIAL2" },
    ]);
    const inspection = await driver.inspectPhysical(PHONE);
    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(present).toEqual([
      { driverDeviceId: PHONE, present: false, reason: "not-present" },
      { driverDeviceId: "SERIAL2", present: false, reason: "not-present" },
    ]);
    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
    expect((inspection as { message: string }).message).toMatch(/40.*41|41.*40/s);
    expect(failure).toBeInstanceOf(Error);
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["not a version", "OKAY0004zzzz"],
    ["another status", "FAIL0004oops"],
    ["empty (a timeout)", ""],
    ["short", "OKAY0004"],
  ])(
    "a host:version reply that is %s blocks physical commands like a mismatch",
    async (_name, reply) => {
      const { driver, runner } = await world({ serverReply: reply });

      const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

      expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
      expect(runner.commands).toEqual([]);
    },
  );

  it("a send that rejects with an error other than ECONNREFUSED blocks physical commands like a mismatch", async () => {
    const { driver, runner, probe } = await world();
    probe.failSendsWith(Object.assign(new Error("reset"), { code: "ECONNRESET" }));

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("an adb version with no protocol number blocks physical commands", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("an adb version that exits non-zero blocks physical commands even when it printed a matching number", async () => {
    const { driver, runner } = await world();
    runner.versionCode = 1;

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("a send that rejects with ECONNREFUSED (nothing listens on 5037) lets physical commands run", async () => {
    const { driver, runner, probe } = await world();
    probe.failSendsWith(econnrefused());

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.some(isDevicesListing)).toBe(true);
  });

  it("an adb version with no protocol number blocks physical commands even when send rejects with ECONNREFUSED", async () => {
    const { driver, runner, probe } = await world();
    runner.versionOutput = "adb: not a version\n";
    probe.failSendsWith(econnrefused());

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("inspectPhysical is refused unreadable naming Simlock's adb version when adb version has no protocol number", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
    expect((inspection as { message: string }).message).toContain("Simlock's adb version");
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["is not a version", "OKAY0004zzzz", undefined],
    ["is empty", "", undefined],
    [
      "is a send that rejects with another error",
      "",
      Object.assign(new Error("x"), { code: "EPIPE" }),
    ],
  ])(
    "inspectPhysical is refused unreadable naming the adb server's version on port 5037 when the reply %s",
    async (_name, reply, failure) => {
      const { driver, runner, probe } = await world({ serverReply: reply });
      if (failure !== undefined) probe.failSendsWith(failure);

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect((inspection as { message: string }).message).toContain(
        "the adb server's version on port 5037",
      );
      expect(runner.commands).toEqual([]);
    },
  );

  it("a server that matched again after a mismatch gets commands on the next call, and nothing restarts it", async () => {
    const { driver, runner, probe } = await world({ serverReply: VERSION_REPLY_40 });
    expect(await driver.listPresentPhysical([{ driverDeviceId: PHONE }])).toEqual([
      { driverDeviceId: PHONE, present: false, reason: "not-present" },
    ]);
    probe.replyWith(VERSION_REPLY_41);

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.flat()).not.toContain("kill-server");
    expect(runner.rests.flat()).not.toContain("start-server");
  });

  it("Simlock's adb version runs once across several physical calls", async () => {
    const { driver, runner } = await world();

    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.inspectPhysical(PHONE);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(1);
  });

  it("after a failed adb version, the next call runs adb version again", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    runner.versionOutput = ADB_VERSION_41;

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
  });

  it("after the adb binary's size changes, the next call runs adb version again and uses the new number", async () => {
    const { driver, runner, filesystem } = await world();
    expect(await driver.listPresentPhysical([{ driverDeviceId: PHONE }])).toMatchObject([
      { present: true },
    ]);
    runner.versionOutput = ADB_VERSION_40;
    await filesystem.writeFileAtomic(adb, "a much bigger binary after a platform-tools update");

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });

  it("after the adb binary's modifiedAtMs changes, the next call runs adb version again and uses the new number", async () => {
    const base = await androidFilesystem();
    let modifiedAtMs = 1_000;
    const filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "stat") {
          return async (path: string) => ({ ...(await target.stat(path)), modifiedAtMs });
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const { driver, runner } = await world({ filesystem });
    expect(await driver.listPresentPhysical([{ driverDeviceId: PHONE }])).toMatchObject([
      { present: true },
    ]);
    runner.versionOutput = ADB_VERSION_40;
    modifiedAtMs = 2_000;

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });
});

describe("Android physical handler: the gate on a failing adb version", () => {
  it("says Simlock's version is unreadable, and does not reject, when stat throws", async () => {
    const base = await androidFilesystem();
    let broken = false;
    const filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "stat" && broken) {
          return async () => {
            throw new Error("EACCES");
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const { driver } = await world({ filesystem });
    broken = true;

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });

  it("says Simlock's version is unreadable, and does not reject, when adb version cannot spawn", async () => {
    const { driver, runner } = await world();
    runner.versionFailure = new ProcessSpawnError(adb, ["version"]);

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });
});

describe("Android physical handler: advisories", () => {
  it("returns adb-protocol-mismatch naming both protocol numbers on a mismatch", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/40/);
    expect(advisories[0]?.message).toMatch(/41/);
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["is not a version", "OKAY0004zzzz", undefined],
    ["is empty", "", undefined],
    [
      "is a send that rejects with another error",
      "",
      Object.assign(new Error("x"), { code: "EPIPE" }),
    ],
  ])("says the server's version is unreadable when the reply %s", async (_name, reply, failure) => {
    const { driver, probe } = await world({ serverReply: reply });
    if (failure !== undefined) probe.failSendsWith(failure);

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/the adb server's version on port 5037 is unreadable/);
  });

  it("says Simlock's version is unreadable when adb version has no protocol number, with send rejecting ECONNREFUSED too", async () => {
    const { driver, runner, probe } = await world();
    runner.versionOutput = "adb: not a version\n";
    probe.failSendsWith(econnrefused());

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });

  it("returns nothing on a match", async () => {
    const { driver } = await world();

    expect(await advisoriesOf(driver)).toEqual([]);
  });

  it("returns nothing when send rejects with ECONNREFUSED", async () => {
    const { driver, probe } = await world();
    probe.failSendsWith(econnrefused());

    expect(await advisoriesOf(driver)).toEqual([]);
  });
});

describe("Android physical handler: scope", () => {
  const POISON = {
    ADB_SERVER_SOCKET: "tcp:other:5037",
    ANDROID_ADB_SERVER_ADDRESS: "other-host",
    ANDROID_SERIAL: "someone-elses-phone",
  } as const;

  it("with ANDROID_ADB_SERVER_ADDRESS, ADB_SERVER_SOCKET and ANDROID_SERIAL in the base environment, every physical command runs adb -P 5037 with ANDROID_ADB_SERVER_PORT=5037 and none of the three, and every device command carries -s <serial>", async () => {
    const { driver, runner } = await world({ env: POISON });

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(runner.commands.length).toBeGreaterThan(5);
    for (const call of runner.commands) {
      expect(call.command).toBe(adb);
      expect(call.args.slice(0, 2)).toEqual(["-P", "5037"]);
      expect(call.options.env).toMatchObject({ ANDROID_ADB_SERVER_PORT: "5037" });
      expect(call.options.env).not.toHaveProperty("ANDROID_ADB_SERVER_ADDRESS");
      expect(call.options.env).not.toHaveProperty("ADB_SERVER_SOCKET");
      expect(call.options.env).not.toHaveProperty("ANDROID_SERIAL");
      if (!isDevicesListing(restOf(call))) {
        expect(restOf(call).slice(0, 2)).toEqual(["-s", PHONE]);
      }
    }
  });
});

describe("Android physical handler: reclaim", () => {
  it("uninstalls, for the current user, each package off the enrollment list, uninstalls no listed package, reports listed packages not installed as missingApps, and returns strategy uninstall", async () => {
    const { driver, runner } = await world();
    runner.userOutput = "10\n";

    const result = await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(result).toEqual({
      missingApps: ["com.example.gone"],
      state: "ready",
      strategy: "uninstall",
    });
    expect(runner.rests.filter(isUninstall)).toEqual([
      ["-s", PHONE, "shell", "pm", "uninstall", "--user", "10", "com.example.stray"],
      ["-s", PHONE, "shell", "pm", "uninstall", "--user", "10", "com.example.other"],
    ]);
    expect(runner.installed).toEqual(["com.example.kept"]);
  });

  it("removes no reverse or forward rule of the phone on reclaim, and frees only the loopback ports no rule on it points to", async () => {
    const listeners = new FakeTcpListenerFactory();
    const { driver, runner } = await world({ listeners });
    runner.override((rest) => {
      const body = rest.slice(2).join(" ");
      if (body === "forward --list") {
        return OK(`${PHONE} tcp:18790 tcp:18791\nOTHER tcp:18792 tcp:18793\n`);
      }
      if (body === "reverse --list") return OK("UsbFfs tcp:5173 tcp:47000\n");
      if (body.startsWith("reverse --remove tcp:")) return FAILED;
      return body.startsWith("reverse --no-rebind") ? OK() : undefined;
    });
    for (const port of [5173, 5174]) {
      const kept = await driver.deviceTcp?.reverse(PHYSICAL, port, new AbortController().signal);
      await kept?.close().catch(() => undefined);
    }
    expect(listeners.listeners.map((listener) => listener.closed)).toEqual([false, false]);

    const result = await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(result).toMatchObject({ strategy: "uninstall" });
    expect(listeners.listeners.map((listener) => listener.closed)).toEqual([false, true]);
    expect(
      runner.rests.filter((rest) => rest[2] === "reverse" || rest[2] === "forward").slice(4),
    ).toEqual([["-s", PHONE, "reverse", "--list"]]);
  });

  it("with nothing off the list runs no uninstall", async () => {
    const { driver, runner } = await world();
    runner.installed.splice(0, runner.installed.length, "com.example.kept");

    const result = await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(result).toMatchObject({ strategy: "uninstall" });
    expect(runner.rests.some(isUninstall)).toBe(false);
  });

  it.each([
    ["a shell injection", "0; rm -r /sdcard\n"],
    ["nothing", ""],
    ["seven digits", "1234567\n"],
  ])(
    "rejects, with no pm list packages and no pm uninstall, when am get-current-user prints %s",
    async (_name, printed) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.userOutput = printed;

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isPackageList)).toBe(false);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
  ])(
    "rejects, with no pm list packages and no pm uninstall, when the user id read %s",
    async (_name, result) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.override((rest) => (isUserRead(rest) ? result : undefined));

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isPackageList)).toBe(false);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
  ])(
    "rejects, runs no uninstall and never resolves with an empty list when the first pm list packages %s",
    async (_name, result) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.override((rest) => (isPackageList(rest) ? result : undefined));

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["prints Failure […]", OK("Failure [DELETE_FAILED_INTERNAL_ERROR]\n")],
    ["exits non-zero", FAILED],
    ["has no exit code", TIMED_OUT],
  ])("rejects, and runs no later uninstall, when an uninstall %s", async (_name, result) => {
    const { driver, runner } = await world();
    runner.override((rest) => (isUninstall(rest) ? result : undefined));

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
    ["has a bad line", OK("package:com.example.kept\npackage:\n")],
  ])("rejects when the second listing %s", async (_name, result) => {
    const { driver, runner } = await world();
    let listings = 0;
    runner.override((rest) => {
      if (!isPackageList(rest)) return undefined;
      listings += 1;
      return listings === 2 ? result : undefined;
    });

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(listings).toBe(2);
  });

  it("rejects when the second listing still holds a package off the enrollment list", async () => {
    await expectReclaimAccepted();
    const { driver, runner } = await world();
    let listings = 0;
    runner.override((rest) => {
      if (!isPackageList(rest)) return undefined;
      listings += 1;
      return listings === 2
        ? OK("package:com.example.kept\npackage:com.example.stray\n")
        : undefined;
    });

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
  });

  it.each([
    ["a character outside letters, digits, _ and .", "package:com.example;rm -rf\n"],
    ["a space", "package:com example\n"],
    ["a bare package:", "package:\n"],
    ["no package: prefix", "com.example.stray\n"],
  ])(
    "fails the listing, and runs no uninstall, for a package line with %s",
    async (_name, line) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.packagesOutput = line;

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it("reads a package listing with \\r\\n line ends and blank lines as the same packages as one with \\n and none", async () => {
    const plain = await world();
    plain.runner.installed.splice(0, 3, "com.example.kept", "com.example.stray");
    await plain.driver.reclaim(PHYSICAL, { clean: "standard" });
    const crlf = await world();
    crlf.runner.installed.splice(0, 3, "com.example.kept", "com.example.stray");
    crlf.runner.override((rest) =>
      isPackageList(rest)
        ? OK(crlf.runner.installed.map((name) => `package:${name}\r\n\r\n`).join(""))
        : undefined,
    );

    await crlf.driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(crlf.runner.rests.filter(isUninstall)).toEqual(plain.runner.rests.filter(isUninstall));
    expect(crlf.runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it("passes a 30 000 ms limit with every read, a 60 000 ms limit with every uninstall and a 10 000 ms limit with every rule removal to the process runner", async () => {
    const { driver, runner } = await world({ listeners: new FakeTcpListenerFactory() });
    runner.override((rest) => {
      const body = rest.slice(2).join(" ");
      if (body.startsWith("reverse --remove tcp:")) return FAILED;
      return body.startsWith("reverse --no-rebind") ? OK() : undefined;
    });
    const held = await driver.deviceTcp?.reverse(PHYSICAL, 5173, new AbortController().signal);
    await held?.close().catch(() => undefined);

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });

    const uninstalls = runner.commands.filter((call) => isUninstall(restOf(call)));
    const removals = runner.calls.filter((call) => isRuleCommand(restOf(call)));
    const reads = runner.calls.filter(
      (call) => !isUninstall(restOf(call)) && !isRuleCommand(restOf(call)),
    );
    expect(uninstalls).not.toHaveLength(0);
    expect(removals).not.toHaveLength(0);
    expect(uninstalls.map((call) => call.options.timeoutMs)).toEqual(uninstalls.map(() => 60_000));
    expect(removals.map((call) => call.options.timeoutMs)).toEqual(removals.map(() => 10_000));
    expect(reads.map((call) => call.options.timeoutMs)).toEqual(reads.map(() => 30_000));
  });
});

describe("Android physical handler: independence from emulator calls", () => {
  it("while a physical adb devices -l hangs, listManaged for emulators resolves", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => (isDevicesListing(rest) ? "hang" : undefined));
    let physicalSettled = false;
    void driver
      .listPresentPhysical([{ driverDeviceId: PHONE }])
      .then(() => (physicalSettled = true));

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([]);
    expect(physicalSettled).toBe(false);
  });

  it("while an emulator call holds the device lock and a PortAllocator port, listPresentPhysical and passthrough on a physical device resolve", async () => {
    const phone = new PhoneAdb();
    // why: the emulator call is the first boot of a seed, made inside `provision`: it holds the seed's lock and a console port while its emulator never answers.
    const emulatorExpectations = [
      scripted(sdkTool("avdmanager"), ["list", "device"], pixelDevices),
      scripted(`${sdk}/emulator/emulator`, ["-version"], "Android emulator version 36.1.9"),
      scripted(sdkTool("avdmanager"), [
        "create",
        "avd",
        "-n",
        "simlock",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      scripted(adb, ["devices"], "List of devices attached\n"),
      scripted(`${sdk}/emulator/emulator`, ["-help"], emulatorHelpListing),
      {
        hangs: true,
        match: {
          args: [/^-avd$/, "simlock", /.*/, /.*/, /.*/, /.*/, /.*/, /.*/, /.*/, /.*/, /.*/],
          command: `${sdk}/emulator/emulator`,
        },
      },
      {
        hangs: true,
        match: {
          args: ["-s", /^emulator-\d+$/, "shell", "getprop", "sys.boot_completed"],
          command: adb,
        },
      },
    ];
    const emulator = new ScriptedProcessRunner(emulatorExpectations);
    const filesystem = await androidFilesystem();
    const seedAvd = `${avdDirectory}/sources/seed_one/simlock.avd`;
    await filesystem.mkdirp(seedAvd);
    await filesystem.writeFileAtomic(`${seedAvd}/config.ini`, "hw.ramSize=2048\n");
    await filesystem.writeFileAtomic(
      `${avdDirectory}/sources/seed_one/simlock.ini`,
      `avd.ini.encoding=UTF-8\npath=${seedAvd}\n`,
    );
    const { driver } = await world({
      filesystem,
      processRunner: () => new SplitRunner(phone, emulator),
      runner: phone,
    });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    let emulatorSettled = false;
    void driver.provision(spec).then(
      () => (emulatorSettled = true),
      () => (emulatorSettled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);
    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(emulatorSettled).toBe(false);
    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(command.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
  });
});
