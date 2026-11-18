import { describe, expect, it, vi } from "vitest";

import { KeptCategoriesError } from "../../core/index.js";
import { FakeClock, ScriptedProcessRunner, type Logger } from "../../ports/index.js";
import type { IosDriverConfig } from "./definition.js";
import { SLIM_CATEGORIES, type SlimmedFact, type SlimSkippedFact } from "./index.js";
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
// why: spelled out, not imported: the labels simslim never disables (ADR 0060 §1).
const neverDisabled = ["com.apple.assistantd", "com.apple.gamed", "com.apple.sharingd"];

/** why: What launchd prints once the worker's categories and the named services are off. */
function disabledReadback(
  categories: readonly string[],
  off: readonly string[],
  on: readonly string[] = [],
): Record<string, string> {
  const labels = SLIM_CATEGORIES.filter((category) => categories.includes(category.name))
    .flatMap((category) => category.labels)
    .filter((label) => !neverDisabled.includes(label) && !on.includes(label));
  return Object.fromEntries([...labels, ...off].map((label) => [label, "disabled"]));
}

async function plantOverrides(
  filesystem: FaultyFilesystem,
  options: { readonly plist?: Readonly<Record<string, boolean>>; readonly record?: string },
): Promise<void> {
  const planted = [
    [overridesPath(slim18_5.udid), options.plist && overridesPlist(options.plist)],
    [recordPath(slim18_5.udid), options.record],
  ] as const;
  for (const [path, contents] of planted) {
    if (contents === undefined) continue;
    await filesystem.mkdirp(overridesFolder(slim18_5.udid));
    await filesystem.writeFileAtomic(path, contents);
  }
  filesystem.writes.length = 0;
}

async function readJson(filesystem: FaultyFilesystem, path: string): Promise<unknown> {
  return (await filesystem.exists(path)) ? JSON.parse(await filesystem.readFile(path)) : undefined;
}

async function boot(options: {
  readonly slim: Omit<IosDriverConfig["slim"], "bootTimeoutMs">;
  readonly readback?: Readonly<Record<string, string>>;
  readonly readbackFails?: boolean;
  readonly except?: readonly string[];
  readonly plist?: Readonly<Record<string, boolean>>;
  readonly record?: string;
  readonly failing?: FaultyFilesystem["failing"];
}) {
  const filesystem = new FaultyFilesystem();
  await plantManagedDevice(filesystem);
  await plantOverrides(filesystem, options);
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
      result:
        options.readbackFails === true
          ? { code: 1, stderr: "boom\n", stdout: "" }
          : { code: 0, stderr: "", stdout: printDisabled(options.readback ?? {}) },
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
  const written: Readonly<Record<string, boolean>> = (await filesystem.exists(file))
    ? parseOverrides(await filesystem.readFile(file))
    : {};
  const record = await readJson(filesystem, recordPath(slim18_5.udid));
  return { filesystem, onSlimSkipped, onSlimmed, outcome, record, warn, written };
}

describe("IosSimctlDriver makeReady with include and exclude names", () => {
  const apsd = "com.apple.apsd";
  const everyCategory = SLIM_CATEGORIES.map((category) => category.name);
  const slimMode = { result: expect.objectContaining({ mode: "slim" }) };
  const fullMode = { result: expect.objectContaining({ mode: "full" }) };

  it("grants the mode the readback shows for the named services", async () => {
    const excludeOnly = await boot({
      slim: { categories: [], exclude: [diagnosticd] },
      readback: { [diagnosticd]: "disabled" },
    });
    expect(excludeOnly.written[diagnosticd]).toBe(true);
    expect(excludeOnly.outcome).toEqual(slimMode);
    expect(excludeOnly.onSlimmed).toHaveBeenCalledWith(
      expect.objectContaining({ categories: [], labelCount: 1 }),
    );

    const all = disabledReadback(everyCategory, [diagnosticd]);
    const asWritten = await boot({ slim: { exclude: [diagnosticd] }, readback: all });
    expect(asWritten.outcome).toEqual(slimMode);
    expect(asWritten.onSlimmed).toHaveBeenCalledWith(
      expect.objectContaining({ categories: everyCategory, labelCount: Object.keys(all).length }),
    );

    const excludeEnabled = await boot({
      slim: { exclude: [diagnosticd] },
      readback: { ...all, [diagnosticd]: "enabled" },
    });
    expect(excludeEnabled.outcome).toEqual(fullMode);
    expect(excludeEnabled.onSlimmed).not.toHaveBeenCalled();
    expect(excludeEnabled.onSlimSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining(
          `managed labels did not read back as written at boot; first: ${diagnosticd}`,
        ),
      }),
    );

    const includeDisabled = await boot({
      slim: { include: [apsd] },
      readback: disabledReadback(everyCategory, []),
    });
    expect(includeDisabled.outcome).toEqual(fullMode);
    expect(includeDisabled.onSlimmed).not.toHaveBeenCalled();

    const readbackFails = await boot({ slim: { exclude: [diagnosticd] }, readbackFails: true });
    expect(readbackFails.outcome).toEqual(slimMode);
    expect(readbackFails.onSlimSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "could not read back the launchd overrides: exit 1: boom",
      }),
    );

    const nothingOff = await boot({
      slim: {
        categories: ["store"],
        include: SLIM_CATEGORIES.find((c) => c.name === "store")!.labels,
      },
    });
    expect(nothingOff.outcome).toEqual(fullMode);
    expect(nothingOff.onSlimmed).not.toHaveBeenCalled();

    const exceptCoversSet = await boot({ slim: { categories: ["store"] }, except: ["store"] });
    expect(exceptCoversSet.outcome).toEqual(fullMode);
    expect(exceptCoversSet.onSlimmed).not.toHaveBeenCalled();

    const noCategories = await boot({ slim: { categories: [] } });
    expect(noCategories.outcome).toEqual(fullMode);
    expect(noCategories.written).toEqual({});
    expect(noCategories.onSlimSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "apply-failed" }),
    );

    const noCategoriesCases = [
      { slim: { categories: [], include: [apsd] } },
      {
        slim: { categories: [] },
        plist: { [diagnosticd]: true },
        record: JSON.stringify([diagnosticd]),
      },
      { slim: { categories: [], include: [apsd] }, readbackFails: true },
      { slim: { categories: [], include: [apsd] }, failing: "writeRecord" as const },
    ];
    for (const options of noCategoriesCases) {
      const result = await boot(options);
      expect(result.outcome).toEqual(fullMode);
      expect(result.onSlimSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "apply-failed" }),
      );
      expect(result.onSlimmed).not.toHaveBeenCalled();
    }

    const unconfiguredWriteFails = await boot({
      slim: { categories: [] },
      plist: { [diagnosticd]: true },
      record: JSON.stringify([diagnosticd]),
      failing: "writeFileAtomic",
    });
    expect(unconfiguredWriteFails.outcome).toEqual(fullMode);
    expect(unconfiguredWriteFails.onSlimSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringMatching(/none of the configured.*could not write the launchd/),
      }),
    );

    const nothingOffUnreadable = await boot({
      slim: {
        categories: ["store"],
        include: SLIM_CATEGORIES.find((c) => c.name === "store")!.labels,
      },
      readbackFails: true,
    });
    expect(nothingOffUnreadable.outcome).toEqual(fullMode);
  });

  it("fails a lease's boot only on its kept categories", async () => {
    const storeLabels = SLIM_CATEGORIES.find((category) => category.name === "store")!.labels;
    const keptLabel = storeLabels[0]!;
    const base = disabledReadback(everyCategory, [diagnosticd], storeLabels);
    const slim = { exclude: [diagnosticd] };

    const kept = await boot({ slim, except: ["store"], readback: base });
    expect(kept.outcome).toEqual(slimMode);

    const keptDisabled = await boot({
      slim,
      except: ["store"],
      readback: { ...base, [keptLabel]: "disabled" },
    });
    expect(keptDisabled.outcome).toEqual({
      error: new KeptCategoriesError(`1 kept labels are not enabled; first: ${keptLabel}`),
    });

    const excludeEnabled = await boot({
      slim,
      except: ["store"],
      readback: { ...base, [diagnosticd]: "enabled" },
    });
    expect(excludeEnabled.outcome).toEqual(fullMode);
  });
});

describe("IosSimctlDriver makeReady writes the managed labels of a slim device", () => {
  const apsd = "com.apple.apsd";
  const passd = "com.apple.passd";
  const gamed = "com.apple.gamed";

  it("writes each managed label as the precedence of the named services says, and keeps the record of the names", async () => {
    const included = await boot({ slim: { include: [apsd] } });
    expect(included.written[apsd]).toBe(false);
    expect(included.written[passd]).toBe(true);

    const excluded = await boot({ slim: { exclude: [diagnosticd, gamed] } });
    expect(excluded.written[diagnosticd]).toBe(true);
    expect(excluded.written[gamed]).toBe(true);
    expect(excluded.record).toEqual([diagnosticd, gamed]);
    expect(excluded.filesystem.modes.record).toBe(0o644);

    const kept = await boot({ slim: { exclude: [apsd] }, except: ["store"] });
    expect(kept.written[apsd]).toBe(false);

    const unmanaged = await boot({ slim: {}, plist: { "com.example.unmanaged": true } });
    expect(unmanaged.written["com.example.unmanaged"]).toBe(true);
    expect(unmanaged.written[passd]).toBe(true);

    const dropped = await boot({
      slim: { exclude: [gamed] },
      plist: { [diagnosticd]: true },
      record: JSON.stringify([diagnosticd, gamed]),
    });
    expect(dropped.written[diagnosticd]).toBe(false);
    expect(dropped.written[gamed]).toBe(true);
    expect(dropped.record).toEqual([gamed]);
    expect(dropped.filesystem.writes).toEqual([
      overridesPath(slim18_5.udid),
      recordPath(slim18_5.udid),
    ]);

    const droppedWithNoCategory = await boot({
      slim: { categories: [] },
      plist: { [diagnosticd]: true },
      record: JSON.stringify([diagnosticd]),
    });
    expect(droppedWithNoCategory.written[diagnosticd]).toBe(false);
    expect(droppedWithNoCategory.record).toEqual([]);

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
    expect(unreadable.written[diagnosticd]).toBe(true);
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
