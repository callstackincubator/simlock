import { describe, expect, it } from "vitest";
import { request, createHarness, seedReady } from "./test-create-leasing.js";

describe("createLeasing: a baseline is a pool key", () => {
  type Harness = Awaited<ReturnType<typeof createHarness>>;
  const plain = { ...request, physical: false } as const;
  const copyOf = (name: string, version: number) =>
    ({ ...plain, baseline: { name, version } }) as const;
  const named = { baseline: "checkout", platform: "ios" } as const;

  // why: the engine reads a baseline from `baselines` and copies the source the driver holds, so a row and a saved source stand in for an operator's save.
  async function saveBaseline(harness: Harness, name: string, version: number): Promise<void> {
    const driverDevice = await harness.driver.provision(plain);
    const ready = await harness.driver.makeReady(driverDevice, {
      mode: "full",
      purpose: "prepare",
    });
    const saved = await harness.driver.saveSource({ ...ready, physical: false });
    harness.state.database
      .prepare(
        `INSERT INTO baselines
           (name, version, platform, model, os_version, mode, saved_at, source_id)
         VALUES (?, ?, 'ios', 'iPhone 16', '26.5', 'full', '2026-11-03T00:00:00.000Z', ?)`,
      )
      .run(name, version, saved.sourceId);
  }

  it.each([
    {
      label: "an idle baseline device and a plain request",
      idle: copyOf("checkout", 1),
      ask: request,
      granted: undefined,
      reused: false,
    },
    {
      label: "an idle plain device and a request naming a baseline",
      idle: plain,
      ask: named,
      granted: { name: "checkout", version: 2 },
      reused: false,
    },
    {
      label: "an idle device of another baseline",
      idle: copyOf("login", 2),
      ask: named,
      granted: { name: "checkout", version: 2 },
      reused: false,
    },
    {
      label: "an idle device of an older version",
      idle: copyOf("checkout", 1),
      ask: named,
      granted: { name: "checkout", version: 2 },
      reused: false,
    },
    {
      label: "an idle device of the baseline's current version (control)",
      idle: copyOf("checkout", 2),
      ask: named,
      granted: { name: "checkout", version: 2 },
      reused: true,
    },
  ])("never grants a device across pools: $label", async ({ ask, granted, idle, reused }) => {
    const harness = await createHarness();
    await saveBaseline(harness, "checkout", 1);
    await saveBaseline(harness, "checkout", 2);
    await saveBaseline(harness, "login", 1);
    const device = await seedReady(harness, idle);

    const grant = await harness.engine.request(ask, { ownerId: "o", requesterId: "r" });

    expect(grant.device.id === device.id).toBe(reused);
    expect(grant.device.spec.baseline).toEqual(granted);
  });
});
