import { describe, expect, it } from "vitest";
import { PassthroughRefusedError, ScreenUnavailableError } from "../../core/index.js";
import { FakeTcpProbe, FakeTcpStreamConnector } from "../../ports/index.js";
import { AndroidDriver } from "./index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import type { ScreenTarget } from "./screen/index.js";
import {
  sdk,
  adb,
  PHONE,
  VERSION_REPLY_41,
  VERSION_REPLY_40,
  PHYSICAL,
  PHYSICAL_SPEC,
  PhoneAdb,
  world,
  androidFilesystem,
  defaultServerSends,
  NO_DEVICE,
  passthroughOf,
  rejectionOf,
} from "./test-physical-handler.js";

const EMULATOR_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

const VIRTUAL_SPEC = {
  model: "Pixel 8",
  osVersion: "34",
  physical: false,
  platform: "android",
} as never;

const REFUSED_SUBCOMMANDS = [
  "kill-server",
  "start-server",
  "server",
  "nodaemon",
  "connect",
  "disconnect",
  "pair",
  "reconnect",
  "tcpip",
  "usb",
  "detach",
  "reboot-bootloader",
];

const REFUSED_REBOOT_TARGETS = [
  "bootloader",
  "sideload",
  "sideload-auto-reboot",
  "recovery",
  "fastboot",
];

const REFUSED_LEADING_FLAGS = [
  "-s",
  "-t",
  "-d",
  "-e",
  "-P",
  "-H",
  "-L",
  "--one-device",
  "--reply-fd",
];

async function expectPassthroughAccepted(driver: AndroidDriver): Promise<void> {
  const accepted = await passthroughOf(driver, ["shell", "getprop"]);
  expect(accepted.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
}

// why: the physical handler is a part of a decomposed module, so its tests reach it directly.
describe("Android physical handler: passthrough", () => {
  it("resolves passthrough of adb shell getprop on a physical device to adb -P 5037 -s <serial> shell getprop with ANDROID_ADB_SERVER_PORT=5037", async () => {
    const { driver } = await world();

    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(command).toMatchObject({
      args: ["-P", "5037", "-s", PHONE, "shell", "getprop"],
      command: adb,
      env: { ANDROID_ADB_SERVER_PORT: "5037" },
    });
  });

  it.each(REFUSED_LEADING_FLAGS)(
    "refuses the caller argument %s before the subcommand",
    async (flag) => {
      const { driver } = await world();
      await expectPassthroughAccepted(driver);

      const failure = await rejectionOf(passthroughOf(driver, [flag, "x", "shell", "getprop"]));

      expect(failure).toBeInstanceOf(PassthroughRefusedError);
    },
  );

  it.each(REFUSED_SUBCOMMANDS)("refuses %s as the subcommand", async (subcommand) => {
    const { driver } = await world();
    await expectPassthroughAccepted(driver);

    const failure = await rejectionOf(passthroughOf(driver, [subcommand]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it.each(REFUSED_REBOOT_TARGETS)("refuses reboot followed by %s", async (target) => {
    const { driver } = await world();
    expect(await passthroughOf(driver, ["reboot"])).toBeDefined();

    const failure = await rejectionOf(passthroughOf(driver, ["reboot", target]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it("refuses a bare shell with no terminal", async () => {
    const { driver } = await world();
    await expectPassthroughAccepted(driver);

    const failure = await rejectionOf(passthroughOf(driver, ["shell"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it.each([
    ["shell dumpsys usb", ["shell", "dumpsys", "usb"]],
    ["shell echo connect", ["shell", "echo", "connect"]],
    ["reboot", ["reboot"]],
  ])(
    "runs %s: a refused word after the subcommand is an operand, and a plain reboot is not refused",
    async (_name, args) => {
      const { driver } = await world();

      const command = await passthroughOf(driver, args);

      expect(command.args).toEqual(["-P", "5037", "-s", PHONE, ...args]);
    },
  );

  it("is refused with PassthroughRefusedError naming both versions when its check sees another version, and the process runner starts nothing", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
    expect((failure as Error).message).toMatch(/40.*41|41.*40/s);
    expect(runner.commands).toEqual([]);
  });

  it("is refused with PassthroughRefusedError naming which version it cannot read, and the process runner starts nothing", async () => {
    const { driver, runner } = await world({ serverReply: "" });

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
    expect((failure as Error).message).toMatch(
      /the adb server's version on port 5037 is unreadable/,
    );
    expect(runner.commands).toEqual([]);
  });

  it("returns unsetEnv ANDROID_ADB_SERVER_ADDRESS, ADB_SERVER_SOCKET and ANDROID_SERIAL for a physical device, and none with no device", async () => {
    const { driver } = await world();

    const physical = await passthroughOf(driver, ["shell", "getprop"]);
    const none = await passthroughOf(driver, ["shell", "getprop"], NO_DEVICE);

    expect([...(physical.unsetEnv ?? [])].sort()).toEqual([
      "ADB_SERVER_SOCKET",
      "ANDROID_ADB_SERVER_ADDRESS",
      "ANDROID_SERIAL",
    ]);
    expect(none.unsetEnv ?? []).toEqual([]);
  });

  it("with no device, or with an emulator device, still runs on Simlock's own server and sends no host:version", async () => {
    const { driver, probe } = await world();

    const without = await passthroughOf(driver, ["shell", "getprop"], NO_DEVICE);
    const emulator = await passthroughOf(driver, ["shell", "getprop"], EMULATOR_DEVICE);

    expect(without).toEqual({
      args: ["-P", "5038", "shell", "getprop"],
      command: adb,
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    });
    expect(emulator).toEqual(without);
    expect(defaultServerSends(probe)).toEqual([]);
  });
});

describe("Android physical handler: the screen target", () => {
  // why: the target a phone's scrcpy session runs on, built straight from the handler: the capture
  // reaches it only through the driver, and what it must never see is the port or the check.
  async function screenWorld(options: { readonly reply?: string } = {}): Promise<{
    readonly runner: PhoneAdb;
    readonly target: ScreenTarget;
    readonly tcp: FakeTcpStreamConnector;
  }> {
    const runner = new PhoneAdb([]);
    const probe = new FakeTcpProbe([]);
    probe.replyWith(options.reply ?? VERSION_REPLY_41);
    const handler = new AndroidPhysicalHandler({
      adb,
      // why: an env that aims adb elsewhere on purpose — a target that leaked these to a child
      // would reach a server other than the one it just checked.
      baseEnv: {
        ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
        ANDROID_ADB_SERVER_ADDRESS: "10.0.0.5",
        ANDROID_HOME: sdk,
        ANDROID_SERIAL: "SOMEONE-ELSES-PHONE",
      },
      filesystem: await androidFilesystem(),
      isBareShell: () => false,
      processRunner: runner,
      tcpProbe: probe,
    });
    const tcp = new FakeTcpStreamConnector();
    return { runner, target: handler.screenTargetFor(PHYSICAL, tcp), tcp };
  }

  it("sends nothing and refuses with the check's own message when the check is closed, for run, spawn and connect, at a mismatch and an unreadable server", async () => {
    const closed = [
      { message: /speaks protocol 40/, name: "another protocol", reply: VERSION_REPLY_40 },
      { message: /unreadable/, name: "a server it cannot read", reply: "gibberish" },
    ] as const;
    const verbs = [
      {
        call: (target: ScreenTarget) => target.run(["shell", "dumpsys", "power"], 10_000),
        name: "run",
      },
      {
        call: (target: ScreenTarget) => target.spawn(["shell", "app_process"]),
        name: "spawn",
      },
      {
        call: (target: ScreenTarget) => target.connect(5_000),
        name: "connect",
      },
    ] as const;
    for (const refusal of closed) {
      for (const verb of verbs) {
        const world = await screenWorld({ reply: refusal.reply });

        const error = await rejectionOf(verb.call(world.target));

        expect(error, `${refusal.name} via ${verb.name}`).toBeInstanceOf(ScreenUnavailableError);
        expect((error as Error).message, `${refusal.name} via ${verb.name}`).toMatch(
          refusal.message,
        );
        expect(world.runner.commands, `${refusal.name} via ${verb.name}`).toEqual([]);
        expect(world.tcp.connections, `${refusal.name} via ${verb.name}`).toEqual([]);
      }
    }
  });

  it("runs adb -P 5037 with the shared server's env for run and spawn, and connects to 5037, when the check is open", async () => {
    const world = await screenWorld();

    await world.target.run(["shell", "dumpsys", "power"], 10_000);
    await world.target.spawn(["shell", "app_process"]);
    await world.target.connect(4_000);

    expect(world.runner.calls.map((call) => [...call.args])).toEqual([
      ["version"],
      ["-P", "5037", "-s", PHONE, "shell", "dumpsys", "power"],
      ["-P", "5037", "-s", PHONE, "shell", "app_process"],
    ]);
    for (const call of world.runner.commands) {
      expect(call.options.env).toEqual({
        ANDROID_ADB_SERVER_PORT: "5037",
        ANDROID_HOME: sdk,
      });
    }
    expect(world.runner.commands[0]?.options.timeoutMs).toBe(10_000);
    expect(world.tcp.connections.map((connection) => connection.port)).toEqual([5037]);
  });
});

describe("Android physical handler: estimate", () => {
  it("is 90 000 ms for a reclaim of a physical spec at both clean levels, and unchanged for an emulator spec", async () => {
    const { driver } = await world();

    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, PHYSICAL_SPEC)).toBe(
      90_000,
    );
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, PHYSICAL_SPEC)).toBe(90_000);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, VIRTUAL_SPEC)).toBe(6_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, VIRTUAL_SPEC)).toBe(32_000);
  });
});
