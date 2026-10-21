import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "./filesystem.js";
import { ScriptedProcessRunner } from "./process-runner.js";
import {
  LaunchdServiceManager,
  productionServiceManager,
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

  it("install creates daemon.log at 0600 when it is missing and keeps one that exists", async () => {
    const definition = definitionFor("worker");
    const created = await installed(definition);
    expect((await created.filesystem.stat(definition.logPath)).mode).toBe(0o600);

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

  it("productionServiceManager is the launchd adapter on macOS and nothing elsewhere", () => {
    const dependencies = {
      runner: new ScriptedProcessRunner([]),
      filesystem: new MemoryFilesystem(),
      uid: 501,
    };
    expect(productionServiceManager("darwin", dependencies)).toBeInstanceOf(LaunchdServiceManager);
    expect(productionServiceManager("linux", dependencies)).toBeUndefined();
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
