import { describe, expect, it, vi } from "vitest";

import { FakeClock, ScriptedProcessRunner } from "../../ports/index.js";
import type { IosDriverConfig } from "./definition.js";
import type { SlimmedFact, SlimSkippedFact } from "./index.js";
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
const diagnosticd = "com.apple.diagnosticd";

async function boot(options: {
  readonly slim: Omit<IosDriverConfig["slim"], "bootTimeoutMs">;
  readonly readback: Readonly<Record<string, string>>;
  readonly except?: readonly string[];
}) {
  const filesystem = new FaultyFilesystem();
  await plantManagedDevice(filesystem);
  const calls = slimBootCalls(slim18_5.udid, "");
  const runner = new ScriptedProcessRunner([
    ...calls.slice(0, 3),
    {
      match: calls[3]!.match,
      result: { code: 0, stderr: "", stdout: printDisabled(options.readback) },
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
  return { onSlimSkipped, onSlimmed, outcome, written };
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
