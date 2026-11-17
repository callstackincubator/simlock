import { describe, expect, it, vi } from "vitest";

import { FakeClock, ScriptedProcessRunner, type Logger } from "../../ports/index.js";
import type { IosDriverConfig } from "./definition.js";
import type { SlimmedFact, SlimSkippedFact } from "./index.js";
import {
  createSlimDriver,
  driverData,
  FaultyFilesystem,
  overridesFolder,
  overridesPath,
  overridesPlist,
  parseOverrides,
  plantManagedDevice,
  printDisabled,
  recordPath,
  slimBootCalls,
} from "./test-slim.js";

const slim18_5 = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };
const diagnosticd = "com.apple.diagnosticd";

async function boot(options: {
  readonly slim: Omit<IosDriverConfig["slim"], "bootTimeoutMs">;
  readonly readback?: Readonly<Record<string, string>>;
  readonly except?: readonly string[];
  readonly plist?: Readonly<Record<string, boolean>>;
  readonly record?: string;
  readonly failing?: FaultyFilesystem["failing"];
}) {
  const filesystem = new FaultyFilesystem();
  await plantManagedDevice(filesystem);
  if (options.plist !== undefined || options.record !== undefined) {
    await filesystem.mkdirp(overridesFolder(slim18_5.udid));
  }
  if (options.plist !== undefined) {
    await filesystem.writeFileAtomic(overridesPath(slim18_5.udid), overridesPlist(options.plist));
  }
  if (options.record !== undefined) {
    await filesystem.writeFileAtomic(recordPath(slim18_5.udid), options.record);
  }
  filesystem.writes.length = 0;
  if (options.failing !== undefined) filesystem.failing = options.failing;
  const warn = vi.fn<(message: string) => void>();
  const logger: Logger = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn,
    child: () => logger,
  };
  const calls = slimBootCalls(slim18_5.udid, "");
  const runner = new ScriptedProcessRunner([
    ...calls.slice(0, 3),
    {
      match: calls[3]!.match,
      result: { code: 0, stderr: "", stdout: printDisabled(options.readback ?? {}) },
    },
  ]);
  const onSlimmed = vi.fn<(fact: SlimmedFact) => void>();
  const onSlimSkipped = vi.fn<(fact: SlimSkippedFact) => void>();
  const driver = await createSlimDriver(
    runner,
    filesystem,
    { bootTimeoutMs: 300_000, ...options.slim },
    onSlimmed,
    onSlimSkipped,
    false,
    new FakeClock(),
    logger,
  );
  const outcome = await driver
    .makeReady(
      { address: slim18_5.udid, deviceId: slim18_5.udid, driverData: slim18_5 },
      { except: options.except ?? [], mode: "slim", purpose: "prepare" },
    )
    .then(
      (result) => ({ result }) as const,
      (error: unknown) => ({ error }) as const,
    );
  const file = overridesPath(slim18_5.udid);
  const written = (await filesystem.exists(file))
    ? parseOverrides(await filesystem.readFile(file))
    : undefined;
  const record = (await filesystem.exists(recordPath(slim18_5.udid)))
    ? (JSON.parse(await filesystem.readFile(recordPath(slim18_5.udid))) as unknown)
    : undefined;
  return { filesystem, onSlimSkipped, onSlimmed, outcome, record, warn, written };
}

describe("IosSimctlDriver makeReady with include and exclude names", () => {
  it("grants the mode the readback shows for the named services", async () => {
    const excludeOnly = await boot({
      slim: { categories: [], exclude: [diagnosticd] },
      readback: { [diagnosticd]: "disabled" },
    });
    expect(excludeOnly.written?.[diagnosticd]).toBe(true);
    expect(excludeOnly.outcome).toEqual({ result: expect.objectContaining({ mode: "slim" }) });
    expect(excludeOnly.onSlimmed).toHaveBeenCalledWith(
      expect.objectContaining({ categories: [], labelCount: 1 }),
    );
  });
});

describe("IosSimctlDriver makeReady writes the managed labels of a slim device", () => {
  const apsd = "com.apple.apsd";
  const passd = "com.apple.passd";
  const gamed = "com.apple.gamed";

  it("writes each managed label as the precedence of the named services says, and keeps the record of the names", async () => {
    const included = await boot({ slim: { include: [apsd] } });
    expect(included.written?.[apsd]).toBe(false);
    expect(included.written?.[passd]).toBe(true);

    const excluded = await boot({ slim: { exclude: [diagnosticd, gamed] } });
    expect(excluded.written?.[diagnosticd]).toBe(true);
    expect(excluded.written?.[gamed]).toBe(true);
    expect(excluded.record).toEqual([diagnosticd, gamed]);
    expect(excluded.filesystem.modes.record).toBe(0o644);

    const kept = await boot({ slim: { exclude: [apsd] }, except: ["store"] });
    expect(kept.written?.[apsd]).toBe(false);

    const unmanaged = await boot({ slim: {}, plist: { "com.example.unmanaged": true } });
    expect(unmanaged.written?.["com.example.unmanaged"]).toBe(true);
    expect(unmanaged.written?.[passd]).toBe(true);

    const dropped = await boot({
      slim: { exclude: [gamed] },
      plist: { [diagnosticd]: true },
      record: JSON.stringify([diagnosticd, gamed]),
    });
    expect(dropped.written?.[diagnosticd]).toBe(false);
    expect(dropped.written?.[gamed]).toBe(true);
    expect(dropped.record).toEqual([gamed]);

    const none = await boot({ slim: { exclude: [gamed] } });
    expect(none.warn).not.toHaveBeenCalled();
    expect(none.record).toEqual([gamed]);

    const unreadable = await boot({
      slim: { exclude: [gamed] },
      plist: { [diagnosticd]: true },
      record: "{not a list",
    });
    expect(unreadable.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the record of named services"),
    );
    expect(unreadable.written?.[diagnosticd]).toBe(true);
    expect(unreadable.record).toEqual([gamed]);

    const wrongShape = await boot({
      slim: { exclude: [gamed] },
      record: JSON.stringify([1, 2]),
    });
    expect(wrongShape.warn).toHaveBeenCalledTimes(1);

    const unchanged = await boot({
      slim: { exclude: [gamed] },
      plist: { [gamed]: true },
      record: JSON.stringify([gamed]),
    });
    expect(unchanged.filesystem.writes).toContain(overridesPath(slim18_5.udid));
    expect(unchanged.filesystem.writes).not.toContain(recordPath(slim18_5.udid));

    const emptyNeverWritten = await boot({ slim: {} });
    expect(emptyNeverWritten.record).toBeUndefined();
    expect(emptyNeverWritten.warn).not.toHaveBeenCalled();
  });

  it("counts a failed record write as a failed overrides write", async () => {
    const failed = await boot({
      slim: { categories: [], exclude: [diagnosticd] },
      readback: { [diagnosticd]: "disabled" },
      failing: "writeRecord",
    });
    expect(failed.outcome).toEqual({ result: expect.objectContaining({ mode: "slim" }) });
    expect(failed.onSlimSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "could not write the launchd overrides file: disk full",
        reason: "apply-failed",
      }),
    );
    expect(failed.onSlimmed).not.toHaveBeenCalled();
  });
});
