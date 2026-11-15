import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DriverCrashError, OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type Logger,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase, plantReadySeed } from "./testing.js";
import { deviceRoot, driverData, instanceId, sourcesRoot } from "./test-slim.js";

const listFixture = readFileSync(new URL("./fixtures/simctl-list.json", import.meta.url), "utf8");
const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const logsRoot = "/home/Library/Logs/CoreSimulator";
const seedUdid = "00000000-0000-0000-0000-0000000000AA";
const usedUdid = "00000000-0000-0000-0000-0000000000BB";
const copyUdid = driverData.udid;

/** why: a device set of another depth than the sources folder, as long as it, so an escaped path swapped into it changes length. */
const deepRoot = "/home/.simlock/a/b/c/devices-d";

/** why: the clock moves when a file is read, so the swap's logged time is what the clock measured. */
class SlowReadFilesystem extends MemoryFilesystem {
  constructor(private readonly clock: FakeClock) {
    super();
  }

  override async readBytes(path: string): Promise<Uint8Array> {
    this.clock.advance(7);
    return super.readBytes(path);
  }
}

class LineLogger implements Logger {
  readonly lines: string[] = [];

  debug(message: string): void {
    this.lines.push(message);
  }
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

interface Rig {
  readonly filesystem: MemoryFilesystem;
  readonly logger: LineLogger;
  provision(): Promise<unknown>;
}

async function rigWith(
  root: string,
  files: readonly { readonly relativePath: string; readonly kind: "link" | "file" }[],
  plant: (filesystem: MemoryFilesystem, copy: string) => Promise<void>,
): Promise<Rig> {
  const clock = new FakeClock();
  const filesystem = new SlowReadFilesystem(clock);
  const logger = new LineLogger();
  await filesystem.mkdirp(`${root}/${copyUdid}`);
  await filesystem.writeFileAtomic(
    `${root}/${OWNED_ROOT_MARKER_FILE}`,
    JSON.stringify({ instanceId, owner: "simlock", platform: "ios", schemaVersion: 1 }),
  );
  await plant(filesystem, `${root}/${copyUdid}`);
  const database = plantReadySeed(await memorySourceDatabase(), {
    deviceTypeId: driverData.deviceTypeId,
    files,
    runtimeId: driverData.runtimeId,
    udid: seedUdid,
  });
  const runner = new ScriptedProcessRunner([
    {
      match: {
        args: ["simctl", "--set", root, "list", "-j", "devicetypes", "runtimes"],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: listFixture },
    },
    {
      match: {
        args: ["simctl", "--set", sourcesRoot, "clone", seedUdid, driverData.name, root],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: `${copyUdid}\n` },
    },
    { match: { args: ["simctl", "--set", root, "delete", copyUdid], command: "xcrun" } },
  ]);
  const driver = await IosSimctlDriver.create({
    clock,
    database,
    driverConfig: { deviceRoot: root },
    filesystem,
    idGenerator: { generate: () => "device-1" },
    instanceId,
    logger,
    logsRoot,
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
  await driver.resolveSpec(spec);
  return { filesystem, logger, provision: () => driver.provision(spec) };
}

describe("a lease's copy before its first boot", () => {
  it("swaps every recorded foreign folder for its own, length unchanged, and logs how long it took", async () => {
    const copy = `${deviceRoot}/${copyUdid}`;
    const rig = await rigWith(
      deviceRoot,
      [
        { kind: "link", relativePath: "data/Library/Logs" },
        { kind: "file", relativePath: "data/prefs.bin" },
        { kind: "file", relativePath: "data/Media/state.json" },
      ],
      async (fs) => {
        await fs.mkdirp(`${copy}/data/Library`);
        await fs.mkdirp(`${copy}/data/Media`);
        fs.defineSymlink(`${copy}/data/Library/Logs`, `${logsRoot}/${seedUdid}`);
        await fs.writeFileAtomic(
          `${copy}/data/prefs.bin`,
          `\u0001bplist\u0000${sourcesRoot}/${seedUdid}/data\u0002`,
        );
        await fs.writeFileAtomic(
          `${copy}/data/Media/state.json`,
          `{"from":"${deviceRoot}/${usedUdid}/data"}`,
        );
        await fs.writeFileAtomic(`${copy}/data/unrecorded.txt`, `${sourcesRoot}/${seedUdid}`);
      },
    );

    await rig.provision();

    expect(await rig.filesystem.readlink(`${copy}/data/Library/Logs`), "a link").toBe(
      `${logsRoot}/${copyUdid}`,
    );
    expect(await rig.filesystem.readFile(`${copy}/data/prefs.bin`), "a binary file").toBe(
      `\u0001bplist\u0000${deviceRoot}/${copyUdid}/data\u0002`,
    );
    expect(
      await rig.filesystem.readFile(`${copy}/data/Media/state.json`),
      "a saved-from folder",
    ).toBe(`{"from":"${deviceRoot}/${copyUdid}/data"}`);
    expect(
      await rig.filesystem.readFile(`${copy}/data/unrecorded.txt`),
      "only recorded files",
    ).toBe(`${sourcesRoot}/${seedUdid}`);
    expect(rig.logger.lines).toContain(`swapped 2 files and 1 links in 14 ms for ${copyUdid}`);
  });

  it("refuses a file whose swap would change its length", async () => {
    const copy = `${deepRoot}/${copyUdid}`;
    const escaped = (root: string, udid: string): string =>
      `${root}/${udid}`.replaceAll("/", "\\/");
    const rig = await rigWith(
      deepRoot,
      [{ kind: "file", relativePath: "data/escaped.json" }],
      async (fs) => {
        await fs.mkdirp(`${copy}/data`);
        await fs.writeFileAtomic(
          `${copy}/data/escaped.json`,
          `"${escaped(sourcesRoot, seedUdid)}"`,
        );
      },
    );

    const failed = await rig.provision().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(DriverCrashError);
    expect((failed as Error).message).toContain("data/escaped.json");
  });
});
