import { describe, expect, it } from "vitest";

import { PassthroughRefusedError } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";

const deviceRoot = "/Devices";
const UDID = "00008110-001A2B3C4D5E";
const APP = "com.example.app";
const BUILD = "/builds/App.app";

const PHYSICAL_DEVICE = {
  address: UDID,
  deviceId: UDID,
  driverData: {},
  enrolledApps: [],
  physical: true,
} as const;

const VIRTUAL_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

type PassthroughDevice = Parameters<IosSimctlDriver["passthrough"]>[1];

function createDriver(runner: ScriptedProcessRunner): Promise<IosSimctlDriver> {
  return IosSimctlDriver.create({
    clock: new FakeClock(),
    driverConfig: { deviceRoot },
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => "device-1" },
    instanceId: "instance-1",
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
}

async function attempt(
  driver: IosSimctlDriver,
  tool: string,
  device: PassthroughDevice,
  args: readonly string[],
): Promise<
  | { readonly resolved: { args: readonly string[]; command: string; envKeys: string[] } }
  | { readonly rejected: unknown }
> {
  try {
    const command = await driver.passthrough(tool, device, args);
    return {
      resolved: {
        args: command.args,
        command: command.command,
        envKeys: Object.keys(command.env),
      },
    };
  } catch (error) {
    return { rejected: error };
  }
}

function runs(args: readonly string[], command = "xcrun") {
  return { resolved: { args, command, envKeys: [] as string[] } };
}

async function expectRefused(options: {
  readonly allowed: readonly string[];
  readonly message?: RegExp;
  readonly refused: readonly string[];
  readonly tool?: string;
}): Promise<void> {
  const tool = options.tool ?? "devicectl";
  const runner = new ScriptedProcessRunner([]);
  const driver = await createDriver(runner);
  const callsBefore = runner.calls.length;

  expect(await attempt(driver, tool, PHYSICAL_DEVICE, options.allowed)).toMatchObject({
    resolved: { command: "xcrun" },
  });
  const outcome = await attempt(driver, tool, PHYSICAL_DEVICE, options.refused);

  expect(outcome).toMatchObject({ rejected: expect.any(PassthroughRefusedError) });
  expect(outcome).toMatchObject({ rejected: { tool } });
  if (options.message !== undefined) {
    expect(outcome).toMatchObject({
      rejected: { message: expect.stringMatching(options.message) },
    });
  }
  expect(runner.calls).toHaveLength(callsBefore);
}

async function resolvesFor(args: readonly string[]) {
  const runner = new ScriptedProcessRunner([]);
  const driver = await createDriver(runner);
  const outcome = await attempt(driver, "devicectl", PHYSICAL_DEVICE, args);
  return { outcome, runner };
}

const ALLOWED_PLAIN = ["device", "info", "details"];

interface CommandSpec {
  readonly words: readonly string[];
  readonly positional: readonly string[];
  readonly valued: readonly (readonly string[])[];
  readonly flags: readonly string[];
}

const COMMON_VALUED = [
  ["-d", "--device"],
  ["-t", "--timeout"],
] as const;
const COMMON_FLAGS = [
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "--omit-deprecated-fields-in-json",
  "-h",
  "--help",
  "--version",
] as const;

const COMMANDS: readonly CommandSpec[] = [
  {
    words: ["device", "install", "app"],
    positional: [BUILD],
    valued: [["--columns"]],
    flags: ["--hide-default-columns", "--hide-headers"],
  },
  { words: ["device", "uninstall", "app"], positional: [APP], valued: [], flags: [] },
  {
    words: ["device", "process", "launch"],
    positional: [APP],
    valued: [
      ["-u", "--user"],
      ["-e", "--environment-variables"],
      ["--working-directory"],
      ["--arch"],
      ["--payload-url"],
      ["--display"],
      ["--launch-persistent-identifier"],
    ],
    flags: ["--start-stopped", "--activate", "--no-activate", "--terminate-existing", "--console"],
  },
  {
    words: ["device", "process", "terminate"],
    positional: [],
    valued: [["-p", "--pid"]],
    flags: ["--kill"],
  },
  {
    words: ["device", "process", "signal"],
    positional: [],
    valued: [
      ["-p", "--pid"],
      ["-s", "--signal"],
    ],
    flags: [],
  },
  {
    words: ["device", "info", "apps"],
    positional: [],
    valued: [["--bundle-id"], ["-s", "--search"], ["--sort-by"], ["--columns"]],
    flags: [
      "--include-app-clips",
      "--no-include-app-clips",
      "--include-removable-apps",
      "--no-include-removable-apps",
      "--include-default-apps",
      "--no-include-default-apps",
      "--include-all-apps",
      "--require-container-access",
      "--include-app-group-identifiers",
      "--include-container-paths",
      "--hide-default-columns",
      "--hide-headers",
    ],
  },
  { words: ["device", "info", "lockState"], positional: [], valued: [], flags: [] },
  { words: ["device", "info", "details"], positional: [], valued: [], flags: [] },
  {
    words: ["device", "info", "processes"],
    positional: [],
    valued: [["-s", "--search"], ["--sort-by"], ["--columns"]],
    flags: ["--hide-default-columns", "--hide-headers"],
  },
];

function isDeviceOption(option: string): boolean {
  return option === "-d" || option === "--device" || option.startsWith("--device=");
}

const OPTION_CASES: readonly (readonly [
  string,
  readonly string[],
  readonly string[],
  readonly string[],
])[] = COMMANDS.flatMap((command) => {
  const valued = [...command.valued, ...COMMON_VALUED];
  const flags = [...command.flags, ...COMMON_FLAGS];
  const forms: (readonly string[])[] = [
    ...valued.flatMap((aliases) =>
      aliases.flatMap((alias) => {
        const separate = [alias, "x"];
        return alias.startsWith("--") ? [separate, [`${alias}=x`]] : [separate];
      }),
    ),
    ...flags.map((flag) => [flag]),
  ];
  return forms.map(
    (form) =>
      [
        `${command.words.join(" ")} takes ${form.join(" ")}`,
        command.words,
        command.positional,
        form,
      ] as const,
  );
});

describe("IosSimctlDriver passthrough", () => {
  it("names simctl and devicectl as its passthrough tools", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.passthroughTools).toEqual(["simctl", "devicectl"]);
  });

  it("returns a promise from passthrough, and rejects a refusal with PassthroughRefusedError", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    const allowed = (() => {
      try {
        return driver.passthrough("devicectl", PHYSICAL_DEVICE, ALLOWED_PLAIN);
      } catch (error) {
        return error;
      }
    })();
    expect(allowed).toBeInstanceOf(Promise);
    await expect(allowed).resolves.toMatchObject({ command: "xcrun" });

    const refused = (() => {
      try {
        return driver.passthrough("devicectl", PHYSICAL_DEVICE, ["device", "reboot"]);
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toBeInstanceOf(PassthroughRefusedError);
  });

  describe("--device insertion", () => {
    it("inserts --device <UDID> right after app for an install, with no env entries", async () => {
      const { outcome, runner } = await resolvesFor(["device", "install", "app", BUILD]);

      expect(outcome).toEqual(
        runs(["devicectl", "device", "install", "app", "--device", UDID, BUILD]),
      );
      expect(runner.calls).toHaveLength(0);
    });

    it("inserts --device <UDID> before the bundle ID of a launch with --console", async () => {
      const { outcome } = await resolvesFor(["device", "process", "launch", APP, "--console"]);

      expect(outcome).toEqual(
        runs(["devicectl", "device", "process", "launch", "--device", UDID, APP, "--console"]),
      );
    });

    it.each([
      ["--device", ["--device", "OTHER"]],
      ["-d", ["-d", "OTHER"]],
      ["--device=", ["--device=OTHER"]],
    ])("passes %s before -- as the caller gave it, naming another device", async (_name, given) => {
      const args = ["device", "process", "launch", ...given, APP];
      const { outcome } = await resolvesFor(args);

      expect(outcome).toEqual(runs(["devicectl", ...args]));
    });

    it("inserts --device <UDID> when the only -d is the app's own, after --", async () => {
      const { outcome } = await resolvesFor(["device", "process", "launch", APP, "--", "-d", "x"]);

      expect(outcome).toEqual(
        runs(["devicectl", "device", "process", "launch", "--device", UDID, APP, "--", "-d", "x"]),
      );
    });
  });

  describe("allowed commands", () => {
    it.each(COMMANDS.map((command) => [command.words.join(" "), command] as const))(
      "runs %s with --device <UDID> inserted after its three words",
      async (_title, command) => {
        const { outcome } = await resolvesFor([...command.words, ...command.positional]);

        expect(outcome).toEqual(
          runs(["devicectl", ...command.words, "--device", UDID, ...command.positional]),
        );
      },
    );

    it.each(OPTION_CASES)("%s", async (_title, words, positional, form) => {
      const { outcome } = await resolvesFor([...words, ...positional, ...form]);

      const head = isDeviceOption(form[0] ?? "") ? [] : ["--device", UDID];
      expect(outcome).toEqual(runs(["devicectl", ...words, ...head, ...positional, ...form]));
    });

    it("runs device process signal with --pid and --signal given as long options", async () => {
      const { outcome } = await resolvesFor([
        "device",
        "process",
        "signal",
        "--pid",
        "12",
        "--signal",
        "SIGTERM",
      ]);

      expect(outcome).toEqual(
        runs([
          "devicectl",
          "device",
          "process",
          "signal",
          "--device",
          UDID,
          "--pid",
          "12",
          "--signal",
          "SIGTERM",
        ]),
      );
    });

    it("runs device process launch with a JSON -e environment value", async () => {
      const args = ["device", "process", "launch", "-e", '{"A":"1"}', APP];
      const { outcome } = await resolvesFor(args);

      expect(outcome).toEqual(
        runs(["devicectl", "device", "process", "launch", "--device", UDID, ...args.slice(3)]),
      );
    });

    it("runs the arguments after -- unchanged, even when they look like options", async () => {
      const after = ["-AppleLanguages", "(en)"];
      const { outcome } = await resolvesFor(["device", "process", "launch", APP, "--", ...after]);

      expect(outcome).toEqual(
        runs(["devicectl", "device", "process", "launch", "--device", UDID, APP, "--", ...after]),
      );
    });

    it("runs --json-output x after -- as the app's own argument", async () => {
      const { outcome } = await resolvesFor([
        "device",
        "process",
        "launch",
        APP,
        "--",
        "--json-output",
        "x",
      ]);

      expect(outcome).toEqual(
        runs([
          "devicectl",
          "device",
          "process",
          "launch",
          "--device",
          UDID,
          APP,
          "--",
          "--json-output",
          "x",
        ]),
      );
    });
  });

  describe("refusals", () => {
    it("refuses -AppleLanguages (en) given before --", async () => {
      await expectRefused({
        allowed: ["device", "process", "launch", APP, "--", "-AppleLanguages", "(en)"],
        refused: ["device", "process", "launch", APP, "-AppleLanguages", "(en)"],
      });
    });

    it.each([
      ["-v"],
      ["-q"],
      ["-t", "5"],
      ["--timeout", "5"],
      ["-j", "-"],
      ["--json-output", "-"],
      ["-l", "x"],
      ["--omit-deprecated-fields-in-json"],
    ])("refuses the global option %s before the command", async (...option) => {
      await expectRefused({
        allowed: ["device", "info", "lockState"],
        refused: [...option, "device", "info", "lockState"],
      });
    });

    it.each([
      ["list devices", ["list", "devices"]],
      ["manage pair", ["manage", "pair"]],
      ["diagnose", ["diagnose"]],
      ["device reboot", ["device", "reboot"]],
      ["device copy from", ["device", "copy", "from"]],
      ["device capture screenshot", ["device", "capture", "screenshot"]],
      ["device pasteboard copy", ["device", "pasteboard", "copy"]],
      ["device pasteboard sync-with-host", ["device", "pasteboard", "sync-with-host"]],
      ["device pairings pair", ["device", "pairings", "pair"]],
      ["device profile validate", ["device", "profile", "validate"]],
    ])("refuses %s as not allowed over exec, with and without --device", async (_title, words) => {
      await expectRefused({
        allowed: ALLOWED_PLAIN,
        message: /not allowed over exec/,
        refused: words,
      });
      await expectRefused({
        allowed: ["device", "info", "details", "--device", UDID],
        message: /not allowed over exec/,
        refused: [...words, "--device", UDID],
      });
    });

    const HOST_PATH_OPTIONS = [
      "--json-output",
      "--json-output=x",
      "-j",
      "-vj",
      "--log-output",
      "-l",
      "--destination",
      "--file",
      "--filter",
    ];

    it.each(HOST_PATH_OPTIONS)("refuses %s right after the command", async (option) => {
      await expectRefused({
        allowed: [...ALLOWED_PLAIN, "--verbose"],
        refused: [...ALLOWED_PLAIN, option, "x"],
      });
    });

    it.each(HOST_PATH_OPTIONS)("refuses %s after the positional argument", async (option) => {
      await expectRefused({
        allowed: ["device", "install", "app", BUILD],
        refused: ["device", "install", "app", BUILD, option, "x"],
      });
    });

    it.each(HOST_PATH_OPTIONS)("refuses %s as another option's value", async (option) => {
      await expectRefused({
        allowed: ["device", "info", "apps", "--search", "kept"],
        refused: ["device", "info", "apps", "--search", option],
      });
    });

    it.each(
      [
        ["device", "info", "apps"],
        ["device", "info", "processes"],
      ].map((words) => [words.join(" "), words] as const),
    )("refuses a --filter predicate on %s", async (_title, words) => {
      await expectRefused({
        allowed: [...words, "--search", "x"],
        refused: [...words, "--filter", "bundleIdentifier == 'com.example.app'"],
      });
    });

    it.each([
      ["an unknown option", ["--foo"]],
      ["a short-option cluster", ["-vq"]],
      ["a short option cluster that ends in a device", ["-qd", UDID]],
      ["a short option with its value attached", [`-d${UDID}`]],
    ])("refuses %s", async (_title, extra) => {
      await expectRefused({
        allowed: ["device", "info", "lockState", "-v"],
        refused: ["device", "info", "lockState", ...extra],
      });
    });

    it.each([
      {
        allowed: ["device", "info", "apps", "--search", "x"],
        refused: ["device", "info", "apps", "--search"],
        title: "a valued option with no value left",
      },
      {
        allowed: ["device", "info", "apps", "--search", "x", "--", "y"],
        refused: ["device", "info", "apps", "--search", "--", "y"],
        title: "a valued option followed by --",
      },
      {
        allowed: ["device", "process", "terminate", "-p", "12"],
        refused: ["device", "process", "terminate", "-p"],
        title: "a valued short option with no value left",
      },
      {
        allowed: ["device", "info", "apps", "--include-all-apps"],
        refused: ["device", "info", "apps", "--include-all-apps=x"],
        title: "a flag with an inline value",
      },
      {
        allowed: ["device", "info", "lockState", "--verbose"],
        refused: ["device", "info", "lockState", "--verbose=1"],
        title: "a common flag with an inline value",
      },
    ])("refuses $title", async ({ allowed, refused }) => {
      await expectRefused({ allowed, message: /not allowed over exec/, refused });
    });

    it("refuses a second positional argument to device uninstall app", async () => {
      await expectRefused({
        allowed: ["device", "uninstall", "app", "a"],
        refused: ["device", "uninstall", "app", "a", "b"],
      });
    });

    it("refuses a second positional argument to device process launch before --", async () => {
      await expectRefused({
        allowed: ["device", "process", "launch", APP],
        refused: ["device", "process", "launch", APP, "extra"],
      });
    });

    it("refuses an option that is on another command's list, not this one's", async () => {
      await expectRefused({
        allowed: ["device", "process", "terminate", "--kill"],
        refused: ["device", "info", "details", "--kill"],
      });
    });

    it("refuses devicectl on a virtual device", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      expect(await attempt(driver, "devicectl", PHYSICAL_DEVICE, ALLOWED_PLAIN)).toMatchObject({
        resolved: { command: "xcrun" },
      });
      const outcome = await attempt(driver, "devicectl", VIRTUAL_DEVICE, ALLOWED_PLAIN);

      expect(outcome).toMatchObject({ rejected: expect.any(PassthroughRefusedError) });
      expect(outcome).toMatchObject({ rejected: { tool: "devicectl" } });
      expect(runner.calls).toHaveLength(0);
    });

    it("refuses devicectl on a physical device whose lease is an Android one, and runs nothing", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      const accepted = await driver.passthrough("devicectl", PHYSICAL_DEVICE, ALLOWED_PLAIN, {
        hasTerminal: false,
        platform: "ios",
      });
      expect(accepted).toMatchObject({ command: "xcrun" });
      const outcome = await driver
        .passthrough("devicectl", PHYSICAL_DEVICE, ALLOWED_PLAIN, {
          hasTerminal: false,
          platform: "android",
        })
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );

      expect(outcome).toBeInstanceOf(PassthroughRefusedError);
      expect(outcome).toMatchObject({
        message:
          "Refusing `devicectl`: it only serves a physical iOS device, and this lease is on the android platform.",
        tool: "devicectl",
      });
      expect(runner.calls).toHaveLength(0);
    });

    it("refuses devicectl on an Android lease whose device record is a simulator naming the android platform, not a simulator", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      const outcome = await driver
        .passthrough("devicectl", VIRTUAL_DEVICE, ALLOWED_PLAIN, {
          hasTerminal: false,
          platform: "android",
        })
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );

      expect(outcome).toBeInstanceOf(PassthroughRefusedError);
      expect(outcome).toMatchObject({
        message:
          "Refusing `devicectl`: it only serves a physical iOS device, and this lease is on the android platform.",
      });
      expect(runner.calls).toHaveLength(0);
    });

    it("refuses devicectl with no device, naming xcrun devicectl", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      expect(await attempt(driver, "devicectl", PHYSICAL_DEVICE, ALLOWED_PLAIN)).toMatchObject({
        resolved: { command: "xcrun" },
      });
      const outcome = await attempt(driver, "devicectl", undefined, ALLOWED_PLAIN);

      expect(outcome).toMatchObject({ rejected: expect.any(PassthroughRefusedError) });
      expect(outcome).toMatchObject({
        rejected: { message: expect.stringContaining("xcrun devicectl"), tool: "devicectl" },
      });
      expect(runner.calls).toHaveLength(0);
    });

    it("refuses simctl on a physical device", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      expect(await attempt(driver, "simctl", VIRTUAL_DEVICE, ["runtime", "list"])).toMatchObject({
        resolved: { command: "xcrun" },
      });
      const outcome = await attempt(driver, "simctl", PHYSICAL_DEVICE, ["runtime", "list"]);

      expect(outcome).toMatchObject({ rejected: expect.any(PassthroughRefusedError) });
      expect(outcome).toMatchObject({ rejected: { tool: "simctl" } });
      expect(runner.calls).toHaveLength(0);
    });
  });

  describe("simctl routing", () => {
    it("refuses a tool it does not wrap, naming that tool, and starts nothing", async () => {
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(runner);

      const outcome = await attempt(driver, "adb", undefined, ["devices"]);

      expect(outcome).toMatchObject({
        rejected: { message: "Refusing `adb`: the iOS driver does not wrap it.", tool: "adb" },
      });
      expect(runner.calls).toEqual([]);
    });

    it.each([
      ["no device", undefined],
      ["a virtual device", VIRTUAL_DEVICE],
    ])("gives today's scoped simctl command for %s", async (_title, device) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      expect(await attempt(driver, "simctl", device, ["runtime", "list"])).toEqual(
        runs(["simctl", "--set", deviceRoot, "runtime", "list"]),
      );
    });

    it.each([
      ["no device", undefined],
      ["a virtual device", VIRTUAL_DEVICE],
    ])("keeps refusing simctl delete for %s", async (_title, device) => {
      const driver = await createDriver(new ScriptedProcessRunner([]));

      const outcome = await attempt(driver, "simctl", device, ["delete", "ABCD"]);

      expect(outcome).toMatchObject({ rejected: expect.any(PassthroughRefusedError) });
      expect(outcome).toMatchObject({
        rejected: { message: expect.stringMatching(/simlock release/) },
      });
    });
  });
});
