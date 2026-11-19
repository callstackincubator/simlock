import { describe, expect, it, vi } from "vitest";

import {
  expectSettled,
  flush,
  leaseReservation,
  minute,
  newDevicesPaused,
  none,
  quick,
  settlerRig,
  THRESHOLD,
  warmingPaused,
} from "./test-rig.js";

describe("seed settler: which seed it settles and when", () => {
  it("settles the most-leased quick seed in the background when the worker is quiet", async () => {
    const order = await settlerRig();
    order.ios.sources = [quick("few", 2), quick("many", 5), quick("also-many", 5)];
    await order.started();
    await order.advance(5 * minute);
    expectSettled(order, ["many"], "the most leased");
    const skipped = await settlerRig();
    skipped.ios.sources = [
      quick("unused", 0),
      quick("settled", 4, { settled: true }),
      quick("stale", 4, { staleReason: "the runtime changed" }),
      quick("orphan", 4, { orphan: true }),
      { ...quick("baseline", 4), kind: "baseline" },
      quick("real", 1),
    ];
    await skipped.started();
    await skipped.advance(5 * minute);
    expectSettled(skipped, ["real"], "only the quick seed a lease used");
    const noVerb = await settlerRig({ androidWithoutVerb: true });
    noVerb.android.sources = [quick("android-seed", 9)];
    await noVerb.started();
    await noVerb.advance(5 * minute);
    expectSettled(noVerb, [], "no verb");
    expect(noVerb.android.listCalls).toBe(0);
  });

  it("settles only when no boot is under way, none ended in the last 5 minutes, memory pressure is none and disk is at the threshold", async () => {
    const boot = await settlerRig();
    boot.ios.sources = [quick("seed", 3)];
    await boot.started();
    const reservation = leaseReservation(boot);
    await boot.advance(5 * minute);
    expectSettled(boot, [], "a reservation under way");
    reservation.release();
    await boot.advance(5 * minute - 1_000);
    expectSettled(boot, [], "released 4 min 59 s ago");
    await boot.advance(1_000);
    expectSettled(boot, ["seed"], "released 5 min ago");
    const brief = await settlerRig();
    brief.ios.sources = [quick("seed", 3)];
    await brief.started();
    await brief.advance(minute);
    leaseReservation(brief).release();
    await brief.advance(4 * minute);
    expectSettled(brief, [], "the check at 5 min is 4 min after the release");
    await brief.advance(minute);
    expectSettled(brief, ["seed"], "the next check");
    const pressure = await settlerRig({ pressure: warmingPaused });
    pressure.ios.sources = [quick("seed", 3)];
    await pressure.started();
    await pressure.advance(5 * minute);
    pressure.pressure.reading(newDevicesPaused);
    await flush();
    expectSettled(pressure, [], "warming-paused and new-devices-paused");
    pressure.pressure.reading(none);
    await flush();
    expectSettled(pressure, ["seed"], "pressure back to none");
    const disk = await settlerRig({ freeBytes: THRESHOLD - 1 });
    disk.ios.sources = [quick("seed", 3)];
    await disk.started();
    await disk.advance(5 * minute);
    expectSettled(disk, [], "one byte under");
    expect(disk.ios.listCalls, "a shut gate lists nothing").toBe(0);
    disk.disk.freeBytes = THRESHOLD;
    await disk.advance(5 * minute);
    expectSettled(disk, ["seed"], "at the threshold");
  });

  it("goes on checking after a refused reservation and after a listSources that throws or never answers", async () => {
    const refused = await settlerRig();
    refused.ios.sources = [quick("seed", 3)];
    const reserve = vi
      .spyOn(refused.capacity, "tryReserveProvisioning")
      .mockReturnValueOnce({ ok: false, reason: "ram-budget" });
    await refused.started();
    await refused.advance(5 * minute);
    expectSettled(refused, [], "the reservation was refused");
    expect(reserve).toHaveBeenCalledTimes(1);
    await refused.advance(5 * minute);
    expectSettled(refused, ["seed"], "the next check");

    const throws = await settlerRig();
    throws.ios.sources = [quick("seed", 3)];
    throws.ios.listSources = async () => {
      throw new Error("simctl is gone");
    };
    await throws.started();
    await throws.advance(5 * minute);
    expect(
      throws.logs().map(({ level, fields }) => ({ level, fields: JSON.stringify(fields) })),
      "the failure is logged",
    ).toContainEqual({ fields: expect.stringContaining("simctl is gone"), level: "warn" });
    delete throws.ios.listSources;
    await throws.advance(5 * minute);
    expectSettled(throws, ["seed"], "the next check");

    const hangs = await settlerRig();
    hangs.ios.sources = [quick("seed", 3)];
    hangs.ios.listSources = () => new Promise(() => undefined);
    await hangs.started();
    await hangs.advance(5 * minute);
    await hangs.advance(minute - 1);
    expect(hangs.logs(), "a read under 60 s is still waited for").toEqual([]);
    await hangs.advance(1);
    expect(hangs.logs().map(({ level }) => level)).toEqual(["warn"]);
    delete hangs.ios.listSources;
    await hangs.advance(5 * minute);
    expectSettled(hangs, ["seed"], "the next check");
  });
});
