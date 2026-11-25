import { describe, expect, it } from "vitest";

import {
  deferred,
  dryRemove,
  flush,
  iphoneSpec,
  minute,
  ownIos,
  quick,
  reserved,
  settledResult,
  settlerRig,
} from "./test-rig.js";

describe("seed settler: reservation and claim", () => {
  it("holds a creation reservation and a component claim for the whole run, on every exit, and one reservation across an operator's make and settle", async () => {
    const exits = {
      aborted: (rig: Awaited<ReturnType<typeof settlerRig>>) => {
        rig.ios.settleSeed = (_id, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        return () => rig.settler.stop();
      },
      settled: (rig: Awaited<ReturnType<typeof settlerRig>>) => {
        const end = deferred<ReturnType<typeof settledResult>>();
        rig.ios.settleSeed = () => end.promise;
        return async () => end.resolve(settledResult("seed"));
      },
      throws: (rig: Awaited<ReturnType<typeof settlerRig>>) => {
        const end = deferred<ReturnType<typeof settledResult>>();
        rig.ios.settleSeed = () => end.promise;
        return async () => end.reject(new Error("the simulator would not boot"));
      },
    };
    for (const [name, arrange] of Object.entries(exits)) {
      const rig = await settlerRig();
      await ownIos(rig);
      rig.ios.sources = [quick("seed", 3)];
      const end = arrange(rig);
      await rig.started();
      await rig.advance(5 * minute);
      expect(rig.ios.settles, `${name}: started`).toHaveLength(1);
      expect(reserved(rig), `${name}: a creation reservation is held`).toBe(1);
      await expect(
        dryRemove(rig),
        `${name}: the runtime cannot be removed meanwhile`,
      ).rejects.toMatchObject({
        name: "ComponentInUseError",
      });

      await end();
      await flush();
      expect(reserved(rig), `${name}: the reservation is released`).toBe(0);
      await expect(dryRemove(rig), `${name}: the claim is released`).resolves.toMatchObject({
        outcome: "would-remove",
      });
    }

    const operator = await settlerRig();
    const made = deferred<{ sourceId: string; settled: false; leases: number }>();
    const settling = deferred<ReturnType<typeof settledResult>>();
    operator.ios.ensureSeed = () => made.promise;
    operator.ios.settleSeed = () => settling.promise;
    await operator.started();
    const asked = operator.settler.settle(iphoneSpec, { onProgress: () => undefined });
    await flush();
    expect(operator.ios.ensures, "the make").toHaveLength(1);
    expect(reserved(operator), "held for the make").toBe(1);
    made.resolve({ leases: 0, settled: false, sourceId: "made" });
    await flush();
    expect(operator.ios.settles.map((call) => call.sourceId)).toEqual(["made"]);
    expect(reserved(operator), "one reservation across the make and the settle").toBe(1);
    settling.resolve(settledResult("made"));
    await expect(asked).resolves.toMatchObject({ outcome: "settled", sourceId: "made-settled" });
    expect(reserved(operator)).toBe(0);
  });
});
