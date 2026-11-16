import { describe, expect, it } from "vitest";
import type { VirtualDevice, WaitingDemand } from "../domain.js";
import { WARM_POOL_TICK_MS } from "./converger.js";
import { device, harness, minute, neverLeased, now, waiter } from "./test-fixtures.js";
import { iphone17, kind, ofKind, held, flush } from "./test-converger.js";

// why: the warm pool is a decomposed module (ADR 0063 section 2); these tests drive its converger part directly.
describe("warm pool targets", () => {
  it("with a target and no device, makes one creation under an ownerless boot claim and a provisioning reservation, and releases the claim once the device is ready", async () => {
    const rig = harness([], { targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.provisionCalls[0]?.spec).toEqual(kind);
    expect(rig.provisionCalls[0]?.claim).toEqual({ kind: "boot" });
    expect(rig.provisionReservations).toHaveLength(1);
    expect(rig.claims.isClaimed("new-1")).toBe(false);
    expect(rig.state.devices.map((item) => item.state)).toEqual(["ready"]);
    expect(rig.kick).toHaveBeenCalled();
  });

  it("runs a waiting-request creation under an ownerless boot claim and a provisioning reservation, releases the claim once ready, kicks, and on a throw logs once and holds the spec back a minute", async () => {
    const behind = { ...kind, model: "iPhone 16" };
    const waiting = [waiter({ ...kind, model: "iPhone 15" }, true), waiter(behind)];
    const ok = harness([], { maxConcurrentBoots: 2, waiting: () => waiting });

    await ok.pool.pass();
    await ok.pool.settle();

    expect(ok.provisionCalls).toHaveLength(1);
    expect(ok.provisionCalls[0]?.spec).toEqual(behind);
    expect(ok.provisionCalls[0]?.claim).toEqual({ kind: "boot" });
    expect(ok.provisionReservations).toHaveLength(1);
    expect(ok.claims.isClaimed("new-1")).toBe(false);
    expect(ok.kick).toHaveBeenCalled();

    const failing = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      waiting: () => waiting,
    });
    await failing.pool.pass();
    await failing.pool.settle();
    failing.clock.advance(WARM_POOL_TICK_MS);
    await failing.pool.settle();

    expect(failing.provisionCalls).toHaveLength(1);
    const warnings = failing.sink.records.filter(
      (record) => record.message === "warm pool creation of a device failed",
    );
    expect(warnings).toHaveLength(1);
    failing.clock.advance(minute);
    await failing.pool.settle();
    expect(failing.provisionCalls).toHaveLength(2);
  });

  it("boots a shut-down device of the target's kind before creating one, and counts the target filled", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.provisionCalls).toEqual([]);
    expect(rig.reservations[0]?.claimedAtBoot).toBe(true);
    expect(rig.claims.isClaimed("shut")).toBe(false);
  });

  it("creates nothing when the target's count of devices is ready, and never shuts a device down for it", async () => {
    const rig = harness([ofKind("a", "ready"), ofKind("b", "ready")], {
      limit: 2,
      targets: [{ ...iphone17, count: 2 }],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.shutdownCalls).toEqual([]);
    expect(rig.bootCalls).toEqual([]);
  });

  it("shuts a never-leased device no target counts down with the warm-pool initiator once it has been ready past idle.shutdownAfterMs", async () => {
    const rig = harness([{ ...ofKind("extra", "ready"), readyAt: now - 11 * minute }]);

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["extra"]);
    expect(rig.shutdownArgs).toEqual([["warm-pool", "cleanup"]]);
  });

  it.each([
    {
      kind: "pool off",
      devices: [device("refused", "ready", 5_000, "android"), device("listed", "ready", 1_000)],
      options: { enabled: false, refusedPlatforms: ["android"] as const },
      expected: ["listed"],
    },
    {
      kind: "over budget",
      // why: the capacity fake counts every device including the refused one, so a limit of 1
      // leaves the budget over whether or not the pool can act on the refused device.
      devices: [device("refused", "ready", 5_000, "android"), device("listed", "ready", 1_000)],
      options: { limit: 1, refusedPlatforms: ["android"] as const },
      expected: ["listed"],
    },
    {
      kind: "never leased and idle",
      devices: [neverLeased("refused", "android"), neverLeased("listed", "ios")],
      options: { refusedPlatforms: ["android"] as const },
      expected: ["listed"],
    },
  ])(
    "proposes no shutdown for a refused platform's device, whatever the reason ($kind)",
    async ({ devices, options, expected }) => {
      const rig = harness(devices, options);

      await rig.pool.pass();
      await rig.pool.settle();

      expect(rig.shutdownCalls).toEqual(expected);
    },
  );

  it("runs the target creations one after the other with maxConcurrentBoots 1, the second starting only after the first is ready", async () => {
    const first = held();
    const second = held();
    const gates = [first, second];
    const rig = harness([], {
      provision: async (_spec, attempt) => gates[attempt - 1]?.gate,
      targets: [{ ...iphone17, count: 2 }],
    });

    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    // A further pass while the first is still running starts no second one.
    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    first.finish();
    await flush();
    expect(rig.provisionCalls).toHaveLength(2);
    second.finish();
    await rig.pool.settle();
    expect(rig.state.devices.map((item) => item.state)).toEqual(["ready", "ready"]);
  });

  it("runs two creations at once with maxConcurrentBoots 2 and not a third", async () => {
    const gate = held();
    const rig = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => gate.gate,
      targets: [{ ...iphone17, count: 3 }],
    });

    await rig.pool.pass();
    await flush();

    expect(rig.provisionCalls).toHaveLength(2);
    gate.finish();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
  });

  it("runs waiting-request boots beside the pass, three at once under maxConcurrentBoots 3, and counts them in the next pass's inFlight", async () => {
    const gate = held();
    const shutDown = ["a", "b", "c", "d"].map((id) => device(id, "shutdown", 20 * minute));
    const rig = harness(shutDown, {
      boot: async (target) => {
        await gate.gate;
        const ready = { ...target, state: "ready" as const };
        rig.state.devices = rig.state.devices.map((item) => (item.id === target.id ? ready : item));
        return ready;
      },
      maxConcurrentBoots: 3,
      waiting: () => shutDown.map((item) => waiter(item.spec)),
    });

    const first = rig.pool.pass();
    await flush();
    expect(rig.bootCalls).toEqual(["a", "b", "c"]);

    const second = rig.pool.pass();
    await flush();
    expect(rig.bootCalls).toEqual(["a", "b", "c"]);

    gate.finish();
    await Promise.all([first, second]);
    await rig.pool.settle();
    expect(rig.bootCalls).toContain("d");
  });

  it("builds onItsWay with one entry per on-its-way device and one per creation flight not yet registered, never two for one creation and never one short", async () => {
    const x = device("shut-x", "shutdown", 20 * minute).spec;
    const head = waiter({ ...kind, model: "iPad Pro" }, true);
    const x2 = waiter(x);
    const x3 = waiter(x);
    const x4 = waiter(x);
    const run = async (
      devices: readonly VirtualDevice[],
      first: readonly WaitingDemand[],
      provisioning?: Promise<void>,
      registers = false,
      owner?: string,
    ) => {
      let waiting: readonly WaitingDemand[] = first;
      const gate = held();
      const rig = harness(devices, {
        boot: async () => gate.gate.then(() => undefined),
        maxConcurrentBoots: 10,
        provision: async () => gate.gate,
        ...(provisioning === undefined ? {} : { provisioning }),
        waiting: () => waiting,
      });
      const counts = () => [rig.bootCalls.length, rig.provisionCalls.length];
      if (owner !== undefined) rig.claims.tryClaim("shut-x", "boot", owner);
      void rig.pool.pass();
      await flush();
      const started = counts();
      if (registers) {
        gate.finish();
        await flush();
      }
      void rig.pool.pass();
      await flush();
      const again = counts();
      waiting = [...first, x4];
      void rig.pool.pass();
      await flush();
      return { again, later: counts(), started };
    };

    const unregistered = await run([], [head, x2]);
    expect(unregistered).toEqual({ again: [0, 1], later: [0, 2], started: [0, 1] });

    const registered = await run([], [head, x2], new Promise<void>(() => undefined), true);
    expect(registered).toEqual({ again: [0, 1], later: [0, 2], started: [0, 1] });

    const bootAndCreation = await run([device("shut-x", "shutdown", 20 * minute)], [head, x2, x3]);
    expect(bootAndCreation).toEqual({ again: [1, 1], later: [1, 2], started: [1, 1] });

    const owned = await run(
      [device("shut-x", "shutdown", 20 * minute)],
      [head, x2],
      undefined,
      false,
      "an-agent",
    );
    expect(owned).toEqual({ again: [0, 1], later: [0, 2], started: [0, 1] });
  });

  it("does not return from a pass for a creation it started, and settle waits for it", async () => {
    const gate = held();
    const rig = harness([], { provision: async () => gate.gate, targets: [iphone17] });

    await rig.pool.pass();
    let settled = false;
    const settling = rig.pool.settle().then(() => {
      settled = true;
    });
    await flush();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(settled).toBe(false);
    gate.finish();
    await settling;
    expect(settled).toBe(true);
  });

  it("makes one creation attempt per allowed attempt when it fails: none on the passes between, one a minute after the first, the next two minutes after that", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });
    rig.pool.start();

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    // Passes triggered by events and ticks within the minute change nothing.
    rig.eventBus.emit("device.shutdown", { deviceId: "d", initiator: "test" }, "test");
    await rig.pool.settle();
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    rig.clock.advance(minute - WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);

    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
    rig.pool.dispose();
  });

  it("arms a timer for the next allowed attempt, so a pass runs when it is due with no event and no tick", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    // `start()` was never called: no tick and no subscription, only the retry timer is armed.
    rig.clock.advance(minute);
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(2);
  });

  it("reports the target short with boot-failed between tries, and logs it once", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    await rig.pool.pass();
    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ count: 1, ready: 0, short: "boot-failed" }),
    ]);
    const shortLines = rig.sink.records.filter(
      (record) => record.message === "a warm pool target is short",
    );
    expect(shortLines).toHaveLength(1);
    expect(shortLines[0]?.fields).toMatchObject({
      short: "boot-failed",
      target: "ios iPhone 17 26.0",
    });
    const failure = rig.sink.records.filter(
      (record) => record.message === "warm pool creation of a device failed",
    );
    expect(failure).toHaveLength(1);
    expect(failure[0]?.fields).toMatchObject({ model: "iPhone 17", step: "provision" });
    expect(String(failure[0]?.fields?.["error"])).toContain("the runtime would not boot");
  });

  it("holds a failed boot of a shut-down device of the kind back for a minute, then boots it again", async () => {
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => {
        throw new Error("simulator did not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut"]);

    rig.clock.advance(minute - 1);
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut"]);
    rig.clock.advance(1);
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut", "shut"]);
  });

  it("clears the schedule when a creation succeeds, so a later failure waits one minute again", async () => {
    let failing = true;
    const rig = harness([], {
      provision: async () => {
        if (failing) throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
    failing = false;
    rig.clock.advance(2 * minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
    expect(rig.state.devices).toHaveLength(1);

    // The device is leased: the target is short again, and now fails once more.
    failing = true;
    rig.lease("new-3");
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(4);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(5);
  });

  it("reports a target naming a runtime that is not installed as runtime-missing and creates nothing", async () => {
    const rig = harness([], {
      resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
      targets: [{ ...iphone17, osVersion: "27.0" }],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([
      {
        booting: 0,
        configuredCount: 1,
        count: 1,
        kind: {
          mode: "full",
          model: "iPhone 17",
          osVersion: "27.0",
          platform: "ios",
        },
        message: "iOS 27.0 is not installed",
        origin: "configured",
        ready: 0,
        short: "runtime-missing",
        target: "ios iPhone 17 27.0",
      },
    ]);
  });

  it.each([
    ["no-driver", "there is no android driver"],
    ["unknown-model", "Unknown ios model: iPhone 99"],
    ["unresolvable", "the simulator service is down"],
  ] as const)(
    "reports a target the resolver answers %s for, with its message",
    async (refusal, message) => {
      const rig = harness([], { resolve: () => ({ message, refusal }), targets: [iphone17] });

      await rig.pool.pass();

      expect(rig.pool.targets()).toEqual([expect.objectContaining({ message, short: refusal })]);
      expect(rig.provisionCalls).toEqual([]);
    },
  );

  it("resolves every target again each pass, so a runtime installed since takes effect without a restart", async () => {
    let installed = false;
    const rig = harness([], {
      resolve: () =>
        installed
          ? { spec: kind }
          : { message: "not installed", refusal: "runtime-missing" as const },
      targets: [iphone17],
    });
    await rig.pool.pass();
    expect(rig.provisionCalls).toEqual([]);

    installed = true;
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.resolveCalls.length).toBeGreaterThanOrEqual(2);
    expect(rig.provisionCalls).toHaveLength(1);
  });

  it("resolves a target as the request it is: platform, exact model, and the OS and mode it names", async () => {
    const rig = harness([], {
      targets: [
        {
          count: 1,
          mode: "slim",
          model: "iPhone 16",
          osVersion: ">=18",
          platform: "ios",
        },
        { count: 1, model: "Pixel 9", platform: "android" },
      ],
    });

    await rig.pool.pass();

    expect(rig.resolveCalls).toStrictEqual([
      { mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
      { model: "Pixel 9", platform: "android" },
    ]);
  });

  it("creates two devices for two targets resolving to one spec, one after the other, as one target of the summed count", async () => {
    const first = held();
    const second = held();
    const rig = harness([], {
      provision: async (_spec, attempt) => [first, second][attempt - 1]?.gate,
      resolve: () => ({ spec: kind }),
      targets: [iphone17, { ...iphone17, osVersion: ">=26" }],
    });

    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);
    first.finish();
    await flush();
    expect(rig.provisionCalls).toHaveLength(2);
    second.finish();
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(2);
    expect(rig.pool.targets()).toHaveLength(1);
    expect(rig.pool.targets()[0]).toMatchObject({ count: 2, ready: 2 });
  });

  it("does nothing for a target while an operator reset holds acquisition closed", async () => {
    const rig = harness([], { maintenance: () => true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
  });

  it("creates nothing for a target the capacity strategy refuses, and reports why", async () => {
    const rig = harness([], { refuseProvision: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "device-limit" })]);
  });

  it("creates nothing, and reports no failure, when the budget refuses the reservation after the policy allowed the creation", async () => {
    const rig = harness([], { refuseReservation: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.sink.records.filter((record) => record.level === "error")).toEqual([]);
    // A declined creation asks for no pass of its own: the same view would propose it again.
    expect(rig.resolveCalls).toHaveLength(1);
    // Not a failure: the target is not held back, and the next pass tries it again.
    await rig.pool.pass();
    expect(rig.resolveCalls).toHaveLength(2);
    expect(rig.pool.targets()[0]?.short).toBeUndefined();
  });

  it("boots nothing, and asks for no pass of its own, when the device's boot claim is refused", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { refuseClaim: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.reservations.every((reservation) => reservation.released === 1)).toBe(true);
  });

  it("asks for no pass of its own when the lifecycle declines a target's boot", async () => {
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => undefined,
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.kick).not.toHaveBeenCalled();
  });
});
