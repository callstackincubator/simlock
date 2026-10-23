import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "./filesystem.js";
import {
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from "./process-runner.js";
import {
  LaunchdServiceManager,
  productionServiceManager,
  SystemdServiceManager,
  serviceDefinition,
  ServiceFailedError,
  type ServiceDefinition,
} from "./service-manager.js";

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

// why: the test must read the plist the way launchd does, as typed XML, so it does not depend on
// the order or the spacing the adapter happens to write.
function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>|([^<]+)/g)].filter(
    (token) => token[4] === undefined || token[4].trim() !== "",
  );
  let index = tokens.findIndex((token) => token[2] === "plist") + 1;
  const text = (): string => {
    const value = tokens[index]?.[4] ?? "";
    index += 1;
    return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  };
  const list = (): PlistValue[] => {
    const items: PlistValue[] = [];
    while (tokens[index]?.[1] !== "/") items.push(value());
    index += 1;
    return items;
  };
  const dict = (): { [key: string]: PlistValue } => {
    const entries: { [key: string]: PlistValue } = {};
    while (tokens[index]?.[1] !== "/") {
      index += 1;
      const key = text();
      index += 1;
      entries[key] = value();
    }
    index += 1;
    return entries;
  };
  const scalar = (tag: string | undefined): PlistValue => {
    const content = tokens[index]?.[1] === "/" ? "" : text();
    index += 1;
    return tag === "integer" ? Number(content) : content;
  };
  const value = (): PlistValue => {
    const tag = tokens[index]?.[2];
    index += 1;
    const keywords: Record<string, () => PlistValue> = {
      true: () => true,
      false: () => false,
      array: list,
      dict,
    };
    return (keywords[tag ?? ""] ?? (() => scalar(tag)))();
  };
  return value();
}

const home = "/Users/me";
const root = "/Users/me/.simlock";

function definitionFor(role: "worker" | "gateway", env: NodeJS.ProcessEnv = {}): ServiceDefinition {
  return serviceDefinition({
    role,
    root,
    dataDirectory: role === "gateway" ? `${root}/gateway` : root,
    home,
    nodePath: "/opt/node/bin/node",
    mainPath: "/opt/simlock/dist/daemon/main.js",
    env,
  });
}

async function installed(
  definition: ServiceDefinition,
  filesystem = new MemoryFilesystem(),
): Promise<{
  readonly plist: { [key: string]: PlistValue };
  readonly filesystem: MemoryFilesystem;
}> {
  const runner = new ScriptedProcessRunner([
    {
      match: { command: "launchctl", args: ["bootout", /.*/] },
      result: { code: 113, stdout: "", stderr: "" },
    },
    {
      match: { command: "launchctl", args: ["bootstrap", /^gui\/\d+$/, definition.path] },
      result: { code: 0, stdout: "", stderr: "" },
    },
  ]);
  await new LaunchdServiceManager({ runner, filesystem, uid: 501 }).install(definition);
  expect(await filesystem.exists(definition.path), "the plist exists").toBe(true);
  const plist = parsePlist(await filesystem.readFile(definition.path));
  return { plist: plist as { [key: string]: PlistValue }, filesystem };
}

describe("LaunchdServiceManager (#830)", () => {
  it("launchd reads the plist install wrote: arguments, saved variables, service keys and log paths", async () => {
    const saved = {
      SIMLOCK_DRIVERS_MODULE: "/x/drivers.js",
      PATH: "/usr/bin:/opt/bin&sbin:/odd<dir>",
      ANDROID_HOME: "/sdk",
      ANDROID_SDK_ROOT: "/sdk",
      ANDROID_AVD_HOME: "/avd",
      ANDROID_USER_HOME: "/auser",
      ANDROID_PREFS_ROOT: "/aprefs",
      ANDROID_SDK_HOME: "/ahome",
      JAVA_HOME: "/jdk",
      DEVELOPER_DIR: "/Xcode/Developer",
    };
    const cases = [
      {
        label: "worker, every saved variable set, secrets present in the shell",
        role: "worker" as const,
        env: { ...saved, SIMLOCK_ADMIN_TOKEN: "secret", SIMLOCK_AGENT_ID: "agent" },
        arguments: ["/opt/node/bin/node", "/opt/simlock/dist/daemon/main.js"],
        variables: { SIMLOCK_HOME: root, ...saved },
        logPath: `${root}/daemon.log`,
      },
      {
        label: "gateway, no variable set",
        role: "gateway" as const,
        env: {},
        arguments: ["/opt/node/bin/node", "/opt/simlock/dist/daemon/main.js", "--gateway"],
        variables: { SIMLOCK_HOME: root },
        logPath: `${root}/gateway/daemon.log`,
      },
    ];

    for (const testCase of cases) {
      const definition = definitionFor(testCase.role, testCase.env);
      const { plist, filesystem } = await installed(definition);
      const raw = await filesystem.readFile(definition.path);
      if (testCase.role === "worker") {
        expect(raw, `${testCase.label}: XML-escaped`).toContain(
          "/usr/bin:/opt/bin&amp;sbin:/odd&lt;dir&gt;",
        );
      }
      expect(plist, testCase.label).toEqual({
        Label: definition.name,
        ProgramArguments: testCase.arguments,
        EnvironmentVariables: testCase.variables,
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        AbandonProcessGroup: true,
        ExitTimeOut: 300,
        StandardOutPath: testCase.logPath,
        StandardErrorPath: testCase.logPath,
      });
    }
  });

  it("install creates daemon.log at 0600 in a data directory it creates owner-only when they are missing, and keeps a log that exists", async () => {
    // why: a directory the memory filesystem creates without a mode is already 0700, so the
    // mode install asks for is read from the call it makes, not from the directory.
    class RecordingFilesystem extends MemoryFilesystem {
      readonly directories: Array<{ path: string; mode: number | undefined }> = [];
      override async mkdirp(path: string, options?: { readonly mode?: number }): Promise<void> {
        this.directories.push({ path, mode: options?.mode });
        await super.mkdirp(path, options);
      }
    }
    const definition = definitionFor("worker");
    const recording = new RecordingFilesystem();
    const created = await installed(definition, recording);
    expect((await created.filesystem.stat(definition.logPath)).mode).toBe(0o600);
    expect(recording.directories).toContainEqual({ path: root, mode: 0o700 });

    const existing = new MemoryFilesystem();
    await existing.mkdirp(root);
    await existing.writeFileAtomic(definition.logPath, "earlier line\n", { mode: 0o640 });
    await installed(definition, existing);
    expect(await existing.readFile(definition.logPath)).toBe("earlier line\n");
    expect((await existing.stat(definition.logPath)).mode).toBe(0o640);
  });

  it("daemon install on an installed service rewrites the plist and loads it again", async () => {
    const cases = [
      { label: "same paths", nodePath: "/opt/node/bin/node" },
      { label: "a changed Node path", nodePath: "/opt/node-24/bin/node" },
    ];
    for (const testCase of cases) {
      const filesystem = new MemoryFilesystem();
      const first = definitionFor("worker");
      await installed(first, filesystem);
      const second = { ...first, command: testCase.nodePath };
      const runner = new ScriptedProcessRunner([
        { match: { command: "launchctl", args: ["bootout", `gui/501/${first.name}`] } },
        { match: { command: "launchctl", args: ["bootstrap", "gui/501", first.path] } },
      ]);

      await new LaunchdServiceManager({ runner, filesystem, uid: 501 }).install(second);

      expect(
        runner.calls.map((call) => call.args.slice(0, 2)),
        testCase.label,
      ).toEqual([
        ["bootout", `gui/501/${first.name}`],
        ["bootstrap", "gui/501"],
      ]);
      const plist = parsePlist(await filesystem.readFile(first.path)) as {
        ProgramArguments: string[];
      };
      expect(plist.ProgramArguments[0], testCase.label).toBe(testCase.nodePath);
    }
  });

  it("uninstall unloads the service and deletes its plist, and a service that was not loaded is no error", async () => {
    for (const bootoutCode of [0, 113]) {
      const filesystem = new MemoryFilesystem();
      const definition = definitionFor("worker");
      await installed(definition, filesystem);
      const runner = new ScriptedProcessRunner([
        {
          match: { command: "launchctl", args: ["bootout", `gui/501/${definition.name}`] },
          result: { code: bootoutCode, stdout: "", stderr: "" },
        },
      ]);

      await new LaunchdServiceManager({ runner, filesystem, uid: 501 }).uninstall(definition);

      expect(runner.calls[0]?.options.timeoutMs, `code ${String(bootoutCode)}`).toBe(10_000);
      expect(await filesystem.exists(definition.path), `code ${String(bootoutCode)}`).toBe(false);
    }
  });

  it("state answers not-installed without asking launchd, broken before not-loaded, else installed or not-loaded by launchctl print", async () => {
    const definition = definitionFor("worker");
    const nodePath = definition.command;
    const mainPath = definition.args[0] ?? "";
    const plutil = {
      command: "plutil",
      args: ["-convert", "json", "-o", "-", definition.path],
    };
    const printed = { command: "launchctl", args: ["print", `gui/501/${definition.name}`] };
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const programArguments = ok(JSON.stringify({ ProgramArguments: [nodePath, mainPath] }));
    const cases = [
      {
        label: "no plist",
        present: [],
        plist: false,
        script: [],
        state: { state: "not-installed" },
      },
      {
        label: "Node path gone",
        present: [mainPath],
        plist: true,
        script: [{ match: plutil, result: programArguments }],
        state: { state: "broken", path: definition.path, missing: [nodePath] },
      },
      {
        label: "both paths gone, launchd not asked",
        present: [],
        plist: true,
        script: [{ match: plutil, result: programArguments }],
        state: { state: "broken", path: definition.path, missing: [nodePath, mainPath] },
      },
      {
        label: "whole and loaded",
        present: [nodePath, mainPath],
        plist: true,
        script: [
          { match: plutil, result: programArguments },
          { match: printed, result: ok("") },
        ],
        state: { state: "installed", path: definition.path },
      },
      {
        label: "whole, launchd has not loaded it",
        present: [nodePath, mainPath],
        plist: true,
        script: [
          { match: plutil, result: programArguments },
          { match: printed, result: { code: 113, stdout: "", stderr: "Could not find service" } },
        ],
        state: { state: "not-loaded", path: definition.path },
      },
    ];
    for (const testCase of cases) {
      const filesystem = new MemoryFilesystem();
      for (const present of testCase.present) {
        await filesystem.mkdirp(dirname(present));
        await filesystem.writeFileAtomic(present, "");
      }
      if (testCase.plist) {
        await filesystem.mkdirp(dirname(definition.path));
        await filesystem.writeFileAtomic(definition.path, "<plist/>");
      }
      const runner = new ScriptedProcessRunner(testCase.script);

      const state = await new LaunchdServiceManager({ runner, filesystem, uid: 501 }).state(
        definition,
      );

      expect(state, testCase.label).toEqual(testCase.state);
      expect(runner.calls.length, testCase.label).toBe(testCase.script.length);
      for (const call of runner.calls) expect(call.options.timeoutMs, testCase.label).toBe(10_000);
    }
  });

  it("state fails with SERVICE_FAILED when plutil cannot read the plist", async () => {
    const definition = definitionFor("worker");
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(dirname(definition.path));
    await filesystem.writeFileAtomic(definition.path, "not a plist");
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "plutil", args: ["-convert", "json", "-o", "-", definition.path] },
        result: { code: 1, stdout: "", stderr: "Unexpected character n\nsecond line" },
      },
    ]);

    const state = new LaunchdServiceManager({ runner, filesystem, uid: 501 }).state(definition);

    await expect(state).rejects.toBeInstanceOf(ServiceFailedError);
    await expect(state).rejects.toThrow(
      `plutil -convert json -o - ${definition.path} failed: Unexpected character n`,
    );
  });

  it("install stops on a daemon.log error that is not 'already exists'", async () => {
    class DeniedLogFilesystem extends MemoryFilesystem {
      override async writeFileExclusive(): Promise<void> {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
    }
    const definition = definitionFor("worker");
    const runner = new ScriptedProcessRunner([
      { match: { command: "launchctl", args: ["bootout", /.*/] } },
    ]);

    const install = new LaunchdServiceManager({
      runner,
      filesystem: new DeniedLogFilesystem(),
      uid: 501,
    }).install(definition);

    await expect(install).rejects.toThrow("denied");
  });

  it("productionServiceManager is the launchd adapter on macOS, the systemd adapter on Linux and nothing elsewhere", () => {
    const dependencies = {
      runner: new ScriptedProcessRunner([]),
      filesystem: new MemoryFilesystem(),
      uid: 501,
    };
    expect(productionServiceManager("darwin", dependencies)).toBeInstanceOf(LaunchdServiceManager);
    expect(productionServiceManager("linux", dependencies)).toBeInstanceOf(SystemdServiceManager);
    expect(productionServiceManager("win32", dependencies)).toBeUndefined();
  });

  it("start kickstarts the loaded service", async () => {
    const definition = definitionFor("worker");
    const runner = new ScriptedProcessRunner([
      {
        match: { command: "launchctl", args: ["kickstart", `gui/501/${definition.name}`] },
        result: { code: 0, stdout: "", stderr: "" },
      },
    ]);

    await new LaunchdServiceManager({ runner, filesystem: new MemoryFilesystem(), uid: 501 }).start(
      definition,
    );

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.options.timeoutMs).toBe(10_000);
  });
});

const linuxHome = "/home/me";
const linuxRoot = "/home/me/.simlock";

function systemdDefinition(
  role: "worker" | "gateway",
  env: NodeJS.ProcessEnv = {},
): ServiceDefinition {
  return serviceDefinition({
    manager: "systemd",
    role,
    root: linuxRoot,
    dataDirectory: role === "gateway" ? `${linuxRoot}/gateway` : linuxRoot,
    home: linuxHome,
    nodePath: "/usr/bin/node",
    mainPath: "/opt/simlock/dist/daemon/main.js",
    env,
  });
}

type Unit = Record<string, Record<string, string[]>>;

// why: the test reads the unit the way systemd does, as sections of keys that may repeat, so it
// does not depend on the order or the spacing the adapter writes.
function parseUnit(text: string): Unit {
  const unit: Unit = {};
  let section = "";
  for (const line of text.split("\n")) {
    const header = /^\[(\w+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      unit[section] = {};
    } else if (line.includes("=") && section !== "") {
      const [key = "", ...rest] = line.split("=");
      (unit[section]![key] ??= []).push(rest.join("="));
    }
  }
  return unit;
}

const bus = "Failed to connect to bus: No medium found";
const systemctl = (...args: string[]) => ({ command: "systemctl", args: ["--user", ...args] });
const reply = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

class MissingSystemctlRunner implements ProcessRunner {
  readonly calls: string[] = [];
  async run(
    command: string,
    args: readonly string[],
    _options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    this.calls.push([command, ...args].join(" "));
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
  }
  spawn(): never {
    throw new Error("unused");
  }
  spawnStreaming(): never {
    throw new Error("unused");
  }
}

describe("SystemdServiceManager (#832)", () => {
  const definition = systemdDefinition("worker");
  const unit = `${definition.name}.service`;

  async function put(filesystem: MemoryFilesystem, path: string, text = ""): Promise<void> {
    await filesystem.mkdirp(dirname(path));
    await filesystem.writeFileAtomic(path, text);
  }

  async function checkUnitText(): Promise<void> {
    const saved = { PATH: "/usr/bin:/opt/bin", ANDROID_HOME: "/sdk", JAVA_HOME: "/jdk" };
    const textCases = [
      {
        label: "worker, saved variables set, secrets in the shell",
        role: "worker" as const,
        env: { ...saved, SIMLOCK_ADMIN_TOKEN: "secret" },
        execStart: "/usr/bin/node /opt/simlock/dist/daemon/main.js",
        environment: [
          `"SIMLOCK_HOME=${linuxRoot}"`,
          '"PATH=/usr/bin:/opt/bin"',
          '"ANDROID_HOME=/sdk"',
          '"JAVA_HOME=/jdk"',
        ],
        log: `append:${linuxRoot}/daemon.log`,
      },
      {
        label: "gateway, no variable set",
        role: "gateway" as const,
        env: {},
        execStart: "/usr/bin/node /opt/simlock/dist/daemon/main.js --gateway",
        environment: [`"SIMLOCK_HOME=${linuxRoot}"`],
        log: `append:${linuxRoot}/gateway/daemon.log`,
      },
    ];
    for (const testCase of textCases) {
      const definition = systemdDefinition(testCase.role, testCase.env);
      const filesystem = new MemoryFilesystem();
      const runner = new ScriptedProcessRunner([
        { match: systemctl("daemon-reload"), result: reply(0) },
        { match: systemctl("enable", "--now", `${definition.name}.service`), result: reply(0) },
      ]);

      await new SystemdServiceManager({ runner, filesystem }).install(definition);

      expect(await filesystem.exists(definition.path), `${testCase.label}: unit exists`).toBe(true);
      expect(parseUnit(await filesystem.readFile(definition.path)), testCase.label).toEqual({
        Unit: { Description: [`simlock ${testCase.role} daemon`], StartLimitIntervalSec: ["0"] },
        Service: {
          ExecStart: [testCase.execStart],
          Environment: testCase.environment,
          Restart: ["on-failure"],
          RestartSec: ["10"],
          KillMode: ["process"],
          TimeoutStopSec: ["300"],
          StandardOutput: [testCase.log],
          StandardError: [testCase.log],
        },
        Install: { WantedBy: ["default.target"] },
      });
      expect(
        runner.calls.map((call) => call.args.join(" ")),
        testCase.label,
      ).toEqual(["--user daemon-reload", `--user enable --now ${definition.name}.service`]);
      for (const call of runner.calls) expect(call.options.timeoutMs, testCase.label).toBe(10_000);
      expect((await filesystem.stat(definition.logPath)).mode, testCase.label).toBe(0o600);
    }
  }

  function checkUnitPath(): void {
    const name = systemdDefinition("worker").name;
    const pathCases = [
      { xdg: "/xdg/config", path: `/xdg/config/systemd/user/${name}.service` },
      { xdg: "relative/config", path: `${linuxHome}/.config/systemd/user/${name}.service` },
      { xdg: undefined, path: `${linuxHome}/.config/systemd/user/${name}.service` },
    ];
    for (const testCase of pathCases) {
      const env = testCase.xdg === undefined ? {} : { XDG_CONFIG_HOME: testCase.xdg };
      expect(systemdDefinition("worker", env).path, String(testCase.xdg)).toBe(testCase.path);
    }
  }

  async function checkStart(): Promise<void> {
    const started = new ScriptedProcessRunner([
      { match: systemctl("start", unit), result: reply(0) },
    ]);
    await new SystemdServiceManager({ runner: started, filesystem: new MemoryFilesystem() }).start(
      definition,
    );
    expect(started.calls[0]?.options.timeoutMs).toBe(10_000);
    const refused = new SystemdServiceManager({
      runner: new ScriptedProcessRunner([
        { match: systemctl("start", unit), result: reply(1, "", "Unit not found.\nsecond") },
      ]),
      filesystem: new MemoryFilesystem(),
    }).start(definition);
    await expect(refused).rejects.toBeInstanceOf(ServiceFailedError);
    await expect(refused).rejects.toThrow(`systemctl --user start ${unit} failed: Unit not found.`);
  }

  async function checkInstallFailures(): Promise<void> {
    const failures = [
      {
        label: "no user bus",
        runner: new ScriptedProcessRunner([
          { match: systemctl("daemon-reload"), result: reply(1, "", `${bus}\nmore`) },
        ]),
        message: `systemctl --user daemon-reload failed: ${bus}`,
      },
      {
        label: "enable refused",
        runner: new ScriptedProcessRunner([
          { match: systemctl("daemon-reload"), result: reply(0) },
          { match: systemctl("enable", "--now", unit), result: reply(1, "", "Boom") },
        ]),
        message: `systemctl --user enable --now ${unit} failed: Boom`,
      },
      {
        label: "systemctl missing",
        runner: new MissingSystemctlRunner(),
        message: "systemctl --user daemon-reload failed: spawn systemctl ENOENT",
      },
    ];
    for (const testCase of failures) {
      const filesystem = new MemoryFilesystem();
      const install = new SystemdServiceManager({ runner: testCase.runner, filesystem }).install(
        definition,
      );
      await expect(install, testCase.label).rejects.toBeInstanceOf(ServiceFailedError);
      await expect(install, testCase.label).rejects.toThrow(testCase.message);
      expect(await filesystem.exists(definition.path), testCase.label).toBe(false);
    }
  }

  async function checkStates(): Promise<void> {
    const node = definition.command;
    const main = definition.args[0] ?? "";
    const isEnabled = (result: ReturnType<typeof reply>) => ({
      match: systemctl("is-enabled", unit),
      result,
    });
    const unitText = (execStart: string) => `[Service]\nExecStart=${execStart}\n`;
    const stateCases = [
      {
        label: "no unit file",
        present: [],
        text: undefined,
        script: [],
        state: { state: "not-installed" },
      },
      {
        label: "Node path gone",
        present: [main],
        text: unitText(`${node} ${main}`),
        script: [],
        state: { state: "broken", path: definition.path, missing: [node] },
      },
      {
        label: "both paths gone",
        present: [],
        text: unitText(`${node} ${main}`),
        script: [],
        state: { state: "broken", path: definition.path, missing: [node, main] },
      },
      {
        label: "no readable ExecStart",
        present: [node, main],
        text: "[Service]\nRestart=on-failure\n",
        script: [],
        state: { state: "broken", path: definition.path, missing: [definition.path] },
      },
      {
        label: "enabled",
        present: [node, main],
        text: unitText(`${node} ${main}`),
        script: [isEnabled(reply(0, "enabled\n"))],
        state: { state: "installed", path: definition.path },
      },
      {
        label: "disabled",
        present: [node, main],
        text: unitText(`${node} ${main}`),
        script: [isEnabled(reply(1, "disabled\n"))],
        state: { state: "not-loaded", path: definition.path },
      },
      {
        label: "no user bus",
        present: [node, main],
        text: unitText(`${node} ${main}`),
        script: [isEnabled(reply(1, "", bus))],
        state: { state: "not-loaded", path: definition.path },
      },
    ];
    const filesystem = new MemoryFilesystem();
    for (const path of [node, main]) await put(filesystem, path);
    await put(filesystem, definition.path, unitText(`${node} ${main}`));
    const missing = new MissingSystemctlRunner();
    expect(
      await new SystemdServiceManager({ runner: missing, filesystem }).state(definition),
      "systemctl missing",
    ).toEqual({ state: "not-loaded", path: definition.path });
    for (const testCase of stateCases) {
      const filesystem = new MemoryFilesystem();
      for (const present of testCase.present) await put(filesystem, present);
      if (testCase.text !== undefined) await put(filesystem, definition.path, testCase.text);
      const runner = new ScriptedProcessRunner(testCase.script);

      const state = await new SystemdServiceManager({ runner, filesystem }).state(definition);

      expect(state, testCase.label).toEqual(testCase.state);
      expect(runner.calls.length, testCase.label).toBe(testCase.script.length);
      for (const call of runner.calls) expect(call.options.timeoutMs, testCase.label).toBe(10_000);
    }
  }

  async function checkUninstall(): Promise<void> {
    const removal = new MemoryFilesystem();
    await put(removal, definition.path, "[Service]\n");
    const removeRunner = new ScriptedProcessRunner([
      { match: systemctl("disable", "--now", unit), result: reply(0) },
      { match: systemctl("daemon-reload"), result: reply(0) },
    ]);
    await new SystemdServiceManager({ runner: removeRunner, filesystem: removal }).uninstall(
      definition,
    );
    expect(removeRunner.calls.map((call) => call.args.join(" "))).toEqual([
      `--user disable --now ${unit}`,
      "--user daemon-reload",
    ]);
    expect(await removal.exists(definition.path)).toBe(false);

    const kept = new MemoryFilesystem();
    await put(kept, definition.path, "[Service]\n");
    const refusal = new SystemdServiceManager({
      runner: new ScriptedProcessRunner([
        { match: systemctl("disable", "--now", unit), result: reply(1, "", "Nope") },
      ]),
      filesystem: kept,
    }).uninstall(definition);
    await expect(refusal).rejects.toBeInstanceOf(ServiceFailedError);
    await expect(refusal).rejects.toThrow(`systemctl --user disable --now ${unit} failed: Nope`);
    expect(await kept.exists(definition.path)).toBe(true);

    const reloadFails = new MemoryFilesystem();
    await put(reloadFails, definition.path, "[Service]\nExecStart=a b\n");
    const reload = new SystemdServiceManager({
      runner: new ScriptedProcessRunner([
        { match: systemctl("disable", "--now", unit), result: reply(0) },
        { match: systemctl("daemon-reload"), result: reply(1, "", "Reload refused") },
      ]),
      filesystem: reloadFails,
    }).uninstall(definition);
    await expect(reload).rejects.toThrow(`systemctl --user daemon-reload failed: Reload refused`);
    expect(await reloadFails.readFile(definition.path)).toBe("[Service]\nExecStart=a b\n");

    const stuck = new MemoryFilesystem();
    await put(stuck, definition.path, "[Service]\n");
    const timeout = new SystemdServiceManager({
      runner: new ScriptedProcessRunner([
        {
          match: systemctl("disable", "--now", unit),
          result: { code: null, stdout: "", stderr: "" },
        },
      ]),
      filesystem: stuck,
    }).uninstall(definition);
    await expect(timeout).rejects.toBeInstanceOf(ServiceFailedError);
    await expect(timeout).rejects.toThrow(
      `systemctl --user disable --now ${unit} did not finish within 10 s`,
    );
    expect(await stuck.exists(definition.path)).toBe(true);
  }

  it("an operator on Linux installs, starts and removes a systemd user unit", async () => {
    await checkUnitText();
    checkUnitPath();
    await checkStart();
    await checkInstallFailures();
    await checkStates();
    await checkUninstall();
  });
});
