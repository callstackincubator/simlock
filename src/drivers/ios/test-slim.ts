import { expect, vi, type Mock } from "vitest";

import {
  OWNED_ROOT_MARKER_FILE,
  type DriverDevice,
  type OwnedRootMarker,
} from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type Filesystem,
} from "../../ports/index.js";
import { IosSimctlDriver, type SlimmedFact, type SlimSkippedFact } from "./index.js";
import { memorySourceDatabase } from "./testing.js";

// why: the slim boot's fixtures, shared by the driver's two test files (index.test.ts is at its size limit).

export const deviceRoot = "/Devices";

export const instanceId = "instance-1";

export const driverData = {
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  name: "simlock-device-1",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  udid: "00000000-0000-0000-0000-000000000001",
} as const;

export const dataPath = `${deviceRoot}/${driverData.udid}/data`;

export function simctlArgs(...args: readonly string[]): string[] {
  return ["simctl", "--set", deviceRoot, ...args];
}

export function simctl(...args: readonly string[]): {
  readonly command: string;
  readonly args: string[];
} {
  return { args: simctlArgs(...args), command: "xcrun" };
}

/**
 * why: Bounded on purpose. An unexpected invocation makes `ScriptedProcessRunner.spawn` throw
 * synchronously, `#invokeSimctl` turns that into a `DriverCrashError`, and the call this
 * is waiting for never arrives -- an unbounded spin then hangs the whole suite instead of
 * reporting which argv the driver actually produced.
 */
export async function waitForCalls(runner: ScriptedProcessRunner, count: number): Promise<void> {
  for (let tick = 0; tick < 1_000 && runner.calls.length < count; tick += 1) {
    await Promise.resolve();
  }

  expect(
    runner.calls.map((call) => call.args),
    `simctl never reached ${String(count)} calls`,
  ).toHaveLength(count);
}

/**
 * why: Plants a managed device in the root the way a real one arrives: inside a root Simlock
 * already owns and marked as such.
 *
 * A bare `mkdirp(dataPath)` describes a state that cannot occur -- `ensureOwnedRoot` creates
 * a root empty and marks it in the same publish, so a root holding a device always carries
 * the marker. Without it the fixture is a non-empty unmarked root, which the driver is
 * required to refuse (ADR 0001, decision 2), and every test built on it fails at `create`
 * for a reason that has nothing to do with what it set out to prove.
 */
export async function plantManagedDevice(filesystem: Filesystem): Promise<void> {
  const marker: OwnedRootMarker = {
    instanceId,
    owner: "simlock",
    platform: "ios",
    schemaVersion: 1,
  };
  await filesystem.mkdirp(deviceRoot);
  await filesystem.writeFileAtomic(
    `${deviceRoot}/${OWNED_ROOT_MARKER_FILE}`,
    JSON.stringify(marker),
  );
  await filesystem.mkdirp(dataPath);
}

export async function createSlimDriver(
  runner: ScriptedProcessRunner,
  filesystem: Filesystem,
  slim: {
    readonly categories?: readonly string[];
    readonly bootTimeoutMs: number;
  },
  onSlimmed?: (fact: SlimmedFact) => void,
  onSlimSkipped?: (fact: SlimSkippedFact) => void,
  slimByDefault = false,
  clock = new FakeClock(),
): Promise<IosSimctlDriver> {
  return await IosSimctlDriver.create({
    database: await memorySourceDatabase(),
    driverConfig: { deviceRoot },
    instanceId,
    simlockHome: "/home/.simlock",
    clock,
    filesystem,
    idGenerator: { generate: () => "device-1" },
    ...(onSlimmed === undefined ? {} : { onSlimmed }),
    ...(onSlimSkipped === undefined ? {} : { onSlimSkipped }),
    launchdOverridesRoot: overridesRoot,
    processRunner: runner,
    config: { slim },
    slimByDefault,
  });
}

export const overridesRoot = "/private/var/tmp";

export function overridesFolder(udid: string): string {
  return `${overridesRoot}/com.apple.CoreSimulator.SimDevice.${udid}`;
}

export function overridesPath(udid: string): string {
  return `${overridesFolder(udid)}/disabled.plist`;
}

export function overridesPlist(entries: Readonly<Record<string, boolean>>): string {
  const lines = Object.entries(entries).map(
    ([label, off]) => `<key>${label}</key><${String(off)}/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${lines.join("")}</dict></plist>\n`;
}

/** why: Records what is written and fails the one operation a test names, as a full or unwritable store would. */
export class FaultyFilesystem extends MemoryFilesystem {
  readonly writes: string[] = [];
  readonly modes: { folder?: number | undefined; file?: number | undefined } = {};
  failing: "writeFileAtomic" | "mkdirp" | "rm" | "copyFile" | undefined;
  failureMessage = "disk full";

  override async writeFileAtomic(
    path: string,
    contents: string,
    options?: Parameters<MemoryFilesystem["writeFileAtomic"]>[2],
  ): Promise<void> {
    if (this.failing === "writeFileAtomic" && path.endsWith("disabled.plist")) {
      throw new Error(this.failureMessage);
    }
    await super.writeFileAtomic(path, contents, options);
    this.writes.push(path);
    if (path.endsWith("disabled.plist")) this.modes.file = options?.mode;
  }

  override async mkdirp(path: string, options?: Parameters<MemoryFilesystem["mkdirp"]>[1]) {
    if (this.failing === "mkdirp" && path.includes("CoreSimulator.SimDevice")) {
      throw new Error(this.failureMessage);
    }
    await super.mkdirp(path, options);
    if (path.includes("CoreSimulator.SimDevice")) this.modes.folder = options?.mode;
  }

  override async copyFile(from: string, to: string): Promise<void> {
    if (this.failing === "copyFile") throw new Error(this.failureMessage);
    await super.copyFile(from, to);
  }

  override async rm(path: string): Promise<void> {
    if (this.failing === "rm") throw new Error(this.failureMessage);
    await super.rm(path);
  }
}

export function parseOverrides(plist: string): Record<string, boolean> {
  const entries: Record<string, boolean> = {};
  for (const match of plist.matchAll(/<key>([^<]*)<\/key>\s*<(true|false)\/>/g)) {
    entries[match[1] ?? ""] = match[2] === "true";
  }
  return entries;
}

/** why: `launchctl print-disabled system` as launchd prints it: one `"label" => state` line per entry. */
export function printDisabled(entries: Readonly<Record<string, string>>): string {
  const lines = Object.entries(entries).map(([label, state]) => `\t"${label}" => ${state}`);
  return ["disabled services = {", ...lines, "}", ""].join("\n");
}

/** why: The calls of one slim boot: the boot, its wait, the installer poll, then the readback. */
export function slimBootCalls(udid: string, readback: string) {
  return [
    { match: simctl("boot", udid) },
    { match: simctl("bootstatus", udid, "-b") },
    { match: simctl("listapps", udid) },
    {
      match: simctl("spawn", udid, "launchctl", "print-disabled", "system"),
      result: { code: 0, stderr: "", stdout: readback },
    },
  ];
}

export type ReadbackScript =
  | { readonly stdout: string }
  | { readonly code: number; readonly stderr: string }
  | "hangs";

/** why: One slim `prepare` of the 18.5 device, with the readback scripted; the 120 s limit runs on a fake clock. */
export async function prepareSlimWith(
  filesystem: FaultyFilesystem,
  readback: ReadbackScript,
  slimOptions: { readonly categories?: readonly string[]; readonly bootTimeoutMs: number },
): Promise<{
  readonly onSlimSkipped: Mock<(fact: SlimSkippedFact) => void>;
  readonly onSlimmed: Mock<(fact: SlimmedFact) => void>;
  readonly result: DriverDevice;
  readonly runner: ScriptedProcessRunner;
}> {
  const udid = "00000000-0000-0000-0000-000000000001";
  const runtimeId = "com.apple.CoreSimulator.SimRuntime.iOS-18-5";
  const calls = slimBootCalls(udid, "");
  const readbackCall =
    readback === "hangs"
      ? { hangs: true, match: calls[3]!.match }
      : "stdout" in readback
        ? { match: calls[3]!.match, result: { code: 0, stderr: "", stdout: readback.stdout } }
        : {
            match: calls[3]!.match,
            result: { code: readback.code, stderr: readback.stderr, stdout: "" },
          };
  const runner = new ScriptedProcessRunner([...calls.slice(0, 3), readbackCall]);
  const clock = new FakeClock();
  const onSlimmed = vi.fn<(fact: SlimmedFact) => void>();
  const onSlimSkipped = vi.fn<(fact: SlimSkippedFact) => void>();
  const driver = await createSlimDriver(
    runner,
    filesystem,
    slimOptions,
    onSlimmed,
    onSlimSkipped,
    false,
    clock,
  );
  const ready = driver.makeReady(
    { address: udid, deviceId: udid, driverData: { ...driverData, runtimeId } },
    prepareSlim,
  );
  if (readback === "hangs") {
    await waitForCalls(runner, 4);
    clock.advance(120_000);
  }
  return { onSlimSkipped, onSlimmed, result: await ready, runner };
}

export const prepareSlim = { mode: "slim", purpose: "prepare" } as const;

// why: DeviceHub's preferences are edited as an export, a PlistBuddy edit of it and an import back
// through cfprefsd (`defaults`); the export sits in the launchd overrides root.
const deviceHubStaging = "/private/var/tmp/devicehub-preferences.plist";

export function deviceHubEdit(command: string) {
  return [
    { command: "defaults", args: ["export", "com.apple.dt.Devices", deviceHubStaging] },
    { command: "/usr/libexec/PlistBuddy", args: ["-c", command, deviceHubStaging] },
    { command: "defaults", args: ["import", "com.apple.dt.Devices", deviceHubStaging] },
  ];
}
