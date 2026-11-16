import { describe, expect, it } from "vitest";
import type { TargetResolution } from "../domain.js";
import { device, harness, minute, now } from "./test-fixtures.js";
import { iphone17, kind, ofKind, held, flush } from "./test-converger.js";

describe("warm pool targets", () => {
  it("reports and logs nothing before its first pass", () => {
    const rig = harness([ofKind("ready", "ready")], { targets: [iphone17] });

    expect(rig.pool.targets()).toEqual([]);
    expect(rig.sink.records).toEqual([]);
  });

  it("resolves the targets itself when asked which devices they keep before any pass has run", async () => {
    const rig = harness([ofKind("ready", "ready")], { targets: [iphone17] });

    expect([...(await rig.pool.targeted())]).toEqual(["ready"]);
    expect(rig.resolveCalls).toHaveLength(1);
    // Resolved once: a later ask reads what is there, and a pass resolves again on its own.
    await rig.pool.targeted();
    expect(rig.resolveCalls).toHaveLength(1);
  });

  it("stops acting on the rest of a pass's proposals once a drain begins", async () => {
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          void rig?.pool.drain();
          return { ...target, state: "shutdown" };
        },
      },
    );

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("resolves no target, reports none and names no device with warmPool disabled", async () => {
    const rig = harness([ofKind("ready", "ready")], {
      enabled: false,
      resolve: () => ({ message: "not installed", refusal: "runtime-missing" }),
      targets: [iphone17],
    });

    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([]);
    expect([...(await rig.pool.targeted())]).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
    expect(
      rig.sink.records.filter((record) => record.message === "a warm pool target is short"),
    ).toEqual([]);
  });

  it("keeps a target's last resolved spec when one pass cannot resolve it, and drops it for a settled refusal", async () => {
    let answer: TargetResolution = { spec: kind };
    const stale = { ...ofKind("stale", "ready"), readyAt: now - 11 * minute };
    const rig = harness([stale], { resolve: () => answer, targets: [{ ...iphone17, count: 2 }] });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.shutdownCalls).toEqual([]);
    expect(rig.provisionCalls).toHaveLength(1);
    rig.lease("new-1");

    // The target is one short, but the spec it may no longer have plans no creation for it.
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.shutdownCalls).toEqual([]);
    expect([...(await rig.pool.targeted())]).toEqual(["stale"]);
    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ message: "simctl timed out", ready: 1, short: "unresolvable" }),
    ]);
    const line = rig.sink.records.filter(
      (record) => record.message === "a warm pool target is short",
    );
    expect(line[0]?.fields).toMatchObject({ ready: 1, short: "unresolvable" });

    answer = { message: "gone", refusal: "runtime-missing" };
    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual(["stale"]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "runtime-missing" })]);

    // The spec it once had is gone with a settled refusal: a later failed read has none to keep.
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    rig.state.devices = rig.state.devices.map((item) =>
      item.id === "stale" ? { ...item, state: "ready" as const } : item,
    );
    await rig.pool.pass();
    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ ready: 0, short: "unresolvable" }),
    ]);
    expect([...(await rig.pool.targeted())]).toEqual([]);
  });

  it("starts nothing once closed, before it drains", async () => {
    const rig = harness([], { targets: [iphone17] });

    rig.pool.close();
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
  });

  it("does not count a claimed device as ready in the report of a target it cannot resolve", async () => {
    let answer: TargetResolution = { spec: kind };
    const rig = harness([ofKind("busy", "ready")], { resolve: () => answer, targets: [iphone17] });
    await rig.pool.pass();
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ ready: 1 })]);

    rig.claims.tryClaim("busy", "eviction");
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ ready: 0, short: "unresolvable" }),
    ]);
  });

  it("starts nothing new once draining, though a creation that was running ends", async () => {
    const gate = held();
    const rig = harness([], {
      provision: async () => gate.gate,
      targets: [{ ...iphone17, count: 3 }],
    });
    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    const draining = rig.pool.drain();
    gate.finish();
    await draining;
    const resolved = rig.resolveCalls.length;
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.resolveCalls).toHaveLength(resolved);

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.state.devices).toHaveLength(1);
    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("logs a boot or creation that throws outside the driver, holds the target back and asks for no immediate retry", async () => {
    const rig = harness([], { reserveThrows: true, targets: [iphone17] });

    await rig.pool.pass();
    // Bounded by turns, not by settle: a pool that retried at once would never settle.
    await flush();

    expect(rig.reserveAttempts.count).toBe(1);
    const errors = rig.sink.records.filter((record) => record.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fields: { step: "flight" },
      message: "a warm pool boot or creation failed",
    });
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "boot-failed" })]);
    expect(rig.clock.pendingTimerCount).toBe(1);
  });

  it("reports ram-budget and boots nothing when the capacity strategy refuses the shut-down device's boot", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { refuseBoot: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "ram-budget" })]);
  });

  it("counts a creation still running toward its target, so a second pass starts no second one even with room for two boots", async () => {
    const gate = held();
    const rig = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => gate.gate,
      targets: [iphone17],
    });

    await rig.pool.pass();
    await flush();
    await rig.pool.pass();
    await flush();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.sink.records.filter((record) => record.level === "error")).toEqual([]);
    gate.finish();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
  });

  it("asks for no pass and arms no timer once disposed, for a creation that ends afterwards", async () => {
    const gate = held();
    const rig = harness([], { provision: async () => gate.gate, targets: [iphone17] });
    await rig.pool.pass();
    await flush();

    rig.pool.dispose();
    gate.fail(new Error("the runtime would not boot"));
    await flush();

    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("cancels the retry timer on dispose, and arms none when a pass that was running ends after it", async () => {
    let hold: Promise<void> | undefined;
    const rig = harness([], {
      provision: async () => {
        throw new Error("no luck");
      },
      resolve: async (request) => {
        await hold;
        return {
          spec: {
            physical: false,
            model: request.model ?? "",
            osVersion: "26.0",
            platform: request.platform,
          },
        };
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.clock.pendingTimerCount).toBe(1);

    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = rig.pool.pass();
    rig.pool.dispose();
    expect(rig.clock.pendingTimerCount).toBe(0);
    release();
    await running;

    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("keeps one retry timer however many passes run while a target is held back", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();

    await rig.pool.pass();
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.clock.pendingTimerCount).toBe(1);
  });

  it("arms the timer for a second held-back target when the first one's retry succeeds, so no tick is needed", async () => {
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness([], {
      provision: async (spec, attempt) => {
        // Attempt 1 (iPhone 17) fails at once, attempt 2 (iPhone 16) fails ten seconds later,
        // attempt 3 (iPhone 17 again) succeeds, attempt 4 (iPhone 16 again) is the one under test.
        if (attempt === 2) rig?.clock.advance(10_000);
        if (attempt <= 2) throw new Error(`no luck for ${spec.model}`);
      },
      targets: [iphone17, { ...iphone17, model: "iPhone 16" }],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual(["iPhone 17", "iPhone 16"]);

    // iPhone 17 may be tried at 60s and succeeds; iPhone 16 failed ten seconds later.
    rig.clock.advance(50_000);
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual([
      "iPhone 17",
      "iPhone 16",
      "iPhone 17",
    ]);

    rig.clock.advance(10_000);
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual([
      "iPhone 17",
      "iPhone 16",
      "iPhone 17",
      "iPhone 16",
    ]);
  });

  it("clears the schedule when a boot of a shut-down device succeeds, so a later failure waits one minute again", async () => {
    let bootAttempts = 0;
    let creating = false;
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness([ofKind("shut", "shutdown")], {
      boot: async (target) => {
        bootAttempts += 1;
        if (bootAttempts === 1) throw new Error("simulator did not boot");
        const ready = { ...target, state: "ready" as const };
        if (rig !== undefined) rig.state.devices = [ready];
        return ready;
      },
      provision: async () => {
        if (creating) throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(bootAttempts).toBe(1);

    // The boot is retried after a minute and succeeds.
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(bootAttempts).toBe(2);

    // The device is then leased, the target is short again, and a creation fails: one minute
    // later it is tried again, not two.
    creating = true;
    rig.lease("shut");
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
  });
});
