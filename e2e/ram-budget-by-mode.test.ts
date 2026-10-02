import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

type TestEnv = Awaited<ReturnType<typeof withDaemon>>;

interface RamBudget {
  readonly limitBytes: number;
  readonly usedBytes: number;
  readonly overLimit: boolean;
}

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: { readonly id: string; readonly mode: "slim" | "full" };
}

const SLIMMABLE = "26.0";
const UNSLIMMABLE = "18.4";

async function ramBudget(env: TestEnv): Promise<RamBudget> {
  const result = await env.cli(["status", "--json"]);
  if (result.code !== 0) throw new Error(`simlock status failed: ${result.stderr}`);
  const budget = (result.json as { capacity: { ramBudget?: RamBudget } }).capacity.ramBudget;
  if (budget === undefined) throw new Error("status reported no RAM budget");
  return budget;
}

function lease(env: TestEnv, agentId: string, mode: "slim" | "full", os = SLIMMABLE) {
  return env.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    os,
    "--mode",
    mode,
    "--agent-id",
    agentId,
    "--no-wait",
    "--detach",
  ]);
}

async function granted(env: TestEnv, agentId: string, mode: "slim" | "full", os = SLIMMABLE) {
  const result = await lease(env, agentId, mode, os);
  if (result.code !== 0) throw new Error(`lease ${agentId} failed: ${result.stderr}`);
  return result.json as Grant;
}

/** Releases every grant and waits for its fresh device to be deleted, emptying the budget. */
async function releaseAll(env: TestEnv, grants: readonly Grant[]): Promise<void> {
  for (const grant of grants) {
    const released = await env.cli(["release", grant.lease.id]);
    expect(released.code).toBe(0);
  }
  await waitFor(async () => (await ramBudget(env)).usedBytes === 0, {
    label: "every released device is deleted",
  });
}

describe("RAM budget by device mode", () => {
  it("counts each device by its mode once booted, needs full-size room for every new one, and goes over after a restart with larger sizes", async () => {
    const env = await withDaemon({
      // Fresh devices are deleted on release, so each pass below starts from an empty budget.
      configOverrides: { lease: { identity: { ios: "fresh" } } },
      driverScript: {
        ios: {
          availableOsVersions: [UNSLIMMABLE, SLIMMABLE],
          knownModels: ["iPhone 16"],
          slimmableOsVersions: [SLIMMABLE],
        },
      },
    });
    // The limit is the host's RAM minus the reserve; the sizes are cut from it so that two
    // full devices fill it exactly, whatever machine runs this. Every new device needs a
    // full device's room, so three slim ones fit: the third takes the last half.
    const { limitBytes } = await ramBudget(env);
    const full = limitBytes / 2;
    const slim = limitBytes / 4;

    await env.withConfig(
      { ramBudget: { iosBytesPerDevice: full, iosSlimBytesPerDevice: slim } },
      async () => {
        // Full: two fit, the third crosses the limit and is refused.
        const fullGrants = [
          await granted(env, "full-1", "full"),
          await granted(env, "full-2", "full"),
        ];
        const crossingFull = await lease(env, "full-3", "full");
        expect(crossingFull.code).toBe(11);
        expect(crossingFull.error).toMatchObject({ code: "NO_CAPACITY" });
        await releaseAll(env, fullGrants);

        // Slim: three fit under the same budget, the fourth is refused.
        const slimGrants: Grant[] = [];
        for (const agent of ["slim-1", "slim-2", "slim-3"]) {
          slimGrants.push(await granted(env, agent, "slim"));
        }
        expect(slimGrants.map((grant) => grant.device.mode)).toEqual(["slim", "slim", "slim"]);
        expect((await ramBudget(env)).usedBytes).toBe(3 * slim);
        const crossingSlim = await lease(env, "slim-4", "slim");
        expect(crossingSlim.code).toBe(11);
        expect(crossingSlim.error).toMatchObject({ code: "NO_CAPACITY" });
        await releaseAll(env, slimGrants);

        // `--mode slim` on an OS that cannot be slimmed is a full device: it counts at the full
        // size once booted, so a second one no longer fits.
        const mixed = [
          await granted(env, "slimmable", "slim"),
          await granted(env, "unslimmable", "slim", UNSLIMMABLE),
        ];
        expect(mixed[1]?.device.mode).toBe("full");
        expect((await ramBudget(env)).usedBytes).toBe(slim + full);
        const secondUnslimmable = await lease(env, "unslimmable-2", "slim", UNSLIMMABLE);
        expect(secondUnslimmable.code).toBe(11);
        expect(secondUnslimmable.error).toMatchObject({ code: "NO_CAPACITY" });
        await releaseAll(env, mixed);

        // A failed slim pass: the device comes up full, keeps its lease, and counts as full.
        const slimGrantsBefore = [
          await granted(env, "before-1", "slim"),
          await granted(env, "before-2", "slim"),
        ];
        await env.driverScript.merge({ ios: { slimPassFails: true } });
        const failed = await granted(env, "failed-slim", "slim");
        expect(failed.device.mode).toBe("full");
        expect(await ramBudget(env)).toEqual({
          limitBytes,
          overLimit: false,
          usedBytes: 2 * slim + full,
        });
        const leases = await env.cli(["list", "--leases"]);
        expect((leases.json as { id: string }[]).map((item) => item.id)).toEqual(
          expect.arrayContaining([...slimGrantsBefore, failed].map((grant) => grant.lease.id)),
        );

        // Restarted with slim devices sized as full ones, the same three devices use 3/2 of
        // the limit.
        await env.withConfig({ ramBudget: { iosSlimBytesPerDevice: full } }, async () => {
          expect(await ramBudget(env)).toEqual({
            limitBytes,
            overLimit: true,
            usedBytes: 3 * full,
          });
          const human = await env.cli(["status"]);
          expect(human.stdout).toMatch(/RAM budget: .* used \(over limit\)/);
        });
      },
    );
  });
});
