import { describe, expect, it, vi } from "vitest";

import { FakeClock, ScriptedProcessRunner } from "../../ports/index.js";
import { SLIM_CATEGORIES, type SlimmedFact, type SlimSkippedFact } from "./index.js";
import {
  createSlimDriver,
  driverData,
  FaultyFilesystem,
  overridesPath,
  parseOverrides,
  plantManagedDevice,
  printDisabled,
  slimBootCalls,
} from "./test-slim.js";

const slim18_5 = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };
// why: spelled out, not imported: the labels simslim never disables (ADR 0060 §1).
const neverDisabled = ["com.apple.assistantd", "com.apple.gamed", "com.apple.sharingd"];

function labelsOf(names: readonly string[]): ReadonlySet<string> {
  return new Set(
    SLIM_CATEGORIES.filter((category) => names.includes(category.name)).flatMap(
      (category) => category.labels,
    ),
  );
}

/** why: What the driver must write: a label of a slimmed category and of no kept one is off (`true`), every other managed label on. */
function expectedWrite(slimmed: readonly string[], kept: readonly string[]): Map<string, boolean> {
  const off = labelsOf(slimmed);
  const keep = labelsOf(kept);
  const wanted = new Map<string, boolean>();
  for (const category of SLIM_CATEGORIES) {
    for (const label of category.labels) {
      wanted.set(label, off.has(label) && !keep.has(label) && !neverDisabled.includes(label));
    }
  }
  for (const label of neverDisabled) wanted.set(label, false);
  return wanted;
}

function readbackOf(wanted: ReadonlyMap<string, boolean>): string {
  return printDisabled(
    Object.fromEntries([...wanted].map(([label, off]) => [label, off ? "disabled" : "enabled"])),
  );
}

async function bootWithExcept(options: {
  readonly categories?: readonly string[];
  readonly except: readonly string[];
  readonly readback: string;
}) {
  const filesystem = new FaultyFilesystem();
  await plantManagedDevice(filesystem);
  const runner = new ScriptedProcessRunner(slimBootCalls(slim18_5.udid, options.readback));
  const onSlimmed = vi.fn<(fact: SlimmedFact) => void>();
  const onSlimSkipped = vi.fn<(fact: SlimSkippedFact) => void>();
  const driver = await createSlimDriver(
    runner,
    filesystem,
    {
      bootTimeoutMs: 300_000,
      ...(options.categories === undefined ? {} : { categories: options.categories }),
    },
    onSlimmed,
    onSlimSkipped,
    false,
    new FakeClock(),
  );
  const result = await driver.makeReady(
    { address: slim18_5.udid, deviceId: slim18_5.udid, driverData: slim18_5 },
    { except: options.except, mode: "slim", purpose: "prepare" },
  );
  const written = parseOverrides(await filesystem.readFile(overridesPath(slim18_5.udid)));
  return { onSlimSkipped, onSlimmed, result, written };
}

describe("IosSimctlDriver makeReady with an except list", () => {
  it("boots a slim device with an except list and grants only when every kept label reads back enabled", async () => {
    const allNames = SLIM_CATEGORIES.map((category) => category.name);
    const wanted = expectedWrite(allNames, ["store", "other"]);

    const { onSlimSkipped, result, written } = await bootWithExcept({
      except: ["store", "other"],
      readback: readbackOf(wanted),
    });

    expect(written).toEqual(Object.fromEntries(wanted));
    expect(written["com.apple.amsaccountsd"]).toBe(false);
    expect(written["com.apple.passd"]).toBe(false);
    expect(result.mode).toBe("slim");
    expect(onSlimSkipped).not.toHaveBeenCalled();
  });
});
