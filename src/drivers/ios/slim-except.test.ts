import { describe, expect, it, vi } from "vitest";

import { KeptCategoriesError } from "../../core/index.js";
import { FakeClock, ScriptedProcessRunner } from "../../ports/index.js";
import { SLIM_CATEGORIES, slimSignature, type SlimmedFact, type SlimSkippedFact } from "./index.js";
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
  readonly readback: string | { readonly code: number; readonly stderr: string };
  readonly writeFails?: boolean;
}) {
  const filesystem = new FaultyFilesystem();
  await plantManagedDevice(filesystem);
  if (options.writeFails === true) filesystem.failing = "writeFileAtomic";
  const calls = slimBootCalls(slim18_5.udid, "");
  const readbackCall =
    typeof options.readback === "string"
      ? { match: calls[3]!.match, result: { code: 0, stderr: "", stdout: options.readback } }
      : {
          match: calls[3]!.match,
          result: { code: options.readback.code, stderr: options.readback.stderr, stdout: "" },
        };
  const runner = new ScriptedProcessRunner([...calls.slice(0, 3), readbackCall]);
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
  const outcome = await driver
    .makeReady(
      { address: slim18_5.udid, deviceId: slim18_5.udid, driverData: slim18_5 },
      { except: options.except, mode: "slim", purpose: "prepare" },
    )
    .then(
      (result) => ({ result }) as const,
      (error: unknown) => ({ error }) as const,
    );
  const file = overridesPath(slim18_5.udid);
  const written = (await filesystem.exists(file))
    ? parseOverrides(await filesystem.readFile(file))
    : undefined;
  return { onSlimSkipped, onSlimmed, outcome, written };
}

describe("IosSimctlDriver makeReady with an except list", () => {
  const allNames = SLIM_CATEGORIES.map((category) => category.name);

  it("boots a slim device with an except list and grants only when every kept label reads back enabled", async () => {
    const wanted = expectedWrite(allNames, ["store", "other"]);
    const kept = readbackOf(wanted);
    const firstKept = [...labelsOf(["store", "other"])].sort()[0]!;
    const keptDisabled = readbackOf(new Map([...wanted, [firstKept, true]]));

    const granted = await bootWithExcept({ except: ["store", "other"], readback: kept });
    expect(granted.written).toEqual(Object.fromEntries(wanted));
    expect(granted.written?.["com.apple.amsaccountsd"]).toBe(false);
    expect(granted.written?.["com.apple.passd"]).toBe(false);
    expect(granted.outcome).toEqual({ result: expect.objectContaining({ mode: "slim" }) });
    expect(granted.onSlimSkipped).not.toHaveBeenCalled();

    const refusals = [
      {
        name: "a kept label reads back disabled",
        run: { except: ["store", "other"], readback: keptDisabled },
        message: `1 kept labels are not enabled; first: ${firstKept}`,
      },
      {
        name: "the overrides write fails",
        run: { except: ["store", "other"], readback: kept, writeFails: true },
        message: "could not write the launchd overrides file: disk full",
      },
      {
        name: "the readback fails",
        run: { except: ["store", "other"], readback: { code: 1, stderr: "boom\n" } },
        message: "could not read back the launchd overrides: exit 1: boom",
      },
    ];
    const nonKept = [...labelsOf(["widgets"])].find((label) => wanted.get(label) === true)!;
    const mismatched = await bootWithExcept({
      except: ["store", "other"],
      readback: readbackOf(new Map([...wanted, [nonKept, false]])),
    });
    expect(mismatched.outcome).toEqual({ result: expect.objectContaining({ mode: "full" }) });
    expect(mismatched.onSlimmed).not.toHaveBeenCalled();

    const wholeSet = await bootWithExcept({
      categories: ["store"],
      except: ["store"],
      readback: readbackOf(expectedWrite(["store"], ["store"])),
    });
    expect(wholeSet.written).toEqual(Object.fromEntries(expectedWrite([], [])));
    expect(wholeSet.outcome).toEqual({ result: expect.objectContaining({ mode: "full" }) });
    expect(wholeSet.onSlimmed).not.toHaveBeenCalled();

    const sharedLabel = expectedWrite(["store", "icloud"], ["store"]);
    const shared = await bootWithExcept({
      categories: ["store", "icloud"],
      except: ["store"],
      readback: readbackOf(sharedLabel),
    });
    const icloud = SLIM_CATEGORIES.filter((category) => category.name === "icloud");
    expect(shared.written?.["com.apple.amsaccountsd"]).toBe(false);
    expect(shared.written).toEqual(Object.fromEntries(sharedLabel));
    expect(shared.outcome).toEqual({ result: expect.objectContaining({ mode: "slim" }) });
    expect(shared.onSlimmed).toHaveBeenCalledWith(
      expect.objectContaining({
        categories: ["icloud"],
        labelCount: [...sharedLabel.values()].filter(Boolean).length,
        signature: slimSignature(icloud),
      }),
    );

    for (const refusal of refusals) {
      const { outcome, onSlimmed } = await bootWithExcept(refusal.run);
      expect(outcome, refusal.name).toEqual({ error: new KeptCategoriesError(refusal.message) });
      expect(onSlimmed, refusal.name).not.toHaveBeenCalled();
    }
  });
});
