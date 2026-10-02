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
  it("counts each device by its mode, refuses the crossing device in either mode, and goes over when a slim pass fails", async () => {
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
    // full devices or four slim ones fill it exactly, whatever machine runs this.
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

        // Slim: four fit under the same budget, the fifth is refused.
        const slimGrants: Grant[] = [];
        for (const agent of ["slim-1", "slim-2", "slim-3", "slim-4"]) {
          slimGrants.push(await granted(env, agent, "slim"));
        }
        expect(slimGrants.map((grant) => grant.device.mode)).toEqual([
          "slim",
          "slim",
          "slim",
          "slim",
        ]);
        expect((await ramBudget(env)).usedBytes).toBe(limitBytes);
        const crossingSlim = await lease(env, "slim-5", "slim");
        expect(crossingSlim.code).toBe(11);
        expect(crossingSlim.error).toMatchObject({ code: "NO_CAPACITY" });
        await releaseAll(env, slimGrants);

        // `--mode slim` on an OS that cannot be slimmed is a full device, counted as one up
        // front: with a quarter left it is refused, where a slimmable OS still fits.
        const mixed = [
          await granted(env, "mixed-full", "full"),
          await granted(env, "mixed-slim", "slim"),
        ];
        const unslimmable = await lease(env, "unslimmable", "slim", UNSLIMMABLE);
        expect(unslimmable.code).toBe(11);
        expect(unslimmable.error).toMatchObject({ code: "NO_CAPACITY" });
        mixed.push(await granted(env, "slimmable", "slim"));
        await releaseAll(env, mixed);

        // A failed slim pass: planned at a quarter, the device fits; it comes up full, keeps
        // its lease, and the budget is over its limit.
        const slimGrantsBefore: Grant[] = [];
        for (const agent of ["before-1", "before-2", "before-3"]) {
          slimGrantsBefore.push(await granted(env, agent, "slim"));
        }
        await env.driverScript.merge({ ios: { slimPassFails: true } });
        const failed = await granted(env, "failed-slim", "slim");
        expect(failed.device.mode).toBe("full");

        expect(await ramBudget(env)).toEqual({
          limitBytes,
          overLimit: true,
          usedBytes: 3 * slim + full,
        });
        const leases = await env.cli(["list", "--leases"]);
        expect((leases.json as { id: string }[]).map((item) => item.id)).toContain(failed.lease.id);
        const human = await env.cli(["status"]);
        expect(human.stdout).toMatch(/RAM budget: .* used \(over limit\)/);
      },
    );
  });
});
