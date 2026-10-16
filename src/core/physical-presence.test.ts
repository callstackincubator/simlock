import { describe, expect, it, vi } from "vitest";

import type { Driver, PresentPhysical } from "./driver.js";
import * as presenceModule from "./physical-presence.js";
import { readPhysicalPresence, readPhysicalPresenceDetail } from "./physical-presence.js";

const latestPresence = (driverDeviceId: string): unknown =>
  (presenceModule as unknown as Record<string, (id: string) => unknown>)["latestPresence"]?.(
    driverDeviceId,
  );

function driverAnswering(answer: readonly PresentPhysical[]) {
  return { listPresentPhysical: vi.fn(async () => answer) } satisfies Pick<
    Driver,
    "listPresentPhysical"
  >;
}

describe("readPhysicalPresence", () => {
  it("answers each entry's present flag, and an ID with no entry not present", async () => {
    const driver = driverAnswering([
      { driverDeviceId: "A", present: true },
      { driverDeviceId: "B", present: false },
    ]);

    const presence = await readPhysicalPresence(driver, ["A", "B", "C"]);

    expect(presence.get("A")).toBe(true);
    expect(presence.get("B")).toBe(false);
    expect(presence.get("C")).toBe(false);
    expect([...presence.keys()].sort()).toEqual(["A", "B", "C"]);
  });

  it("leaves out an entry for an ID it was not asked about", () => {
    const driver = driverAnswering([
      { driverDeviceId: "A", present: true },
      { driverDeviceId: "Z", present: true },
    ]);

    return expect(
      readPhysicalPresence(driver, ["A"]).then((presence) => [...presence]),
    ).resolves.toEqual([["A", true]]);
  });

  it("asks the driver only for the IDs it is given", async () => {
    const driver = driverAnswering([{ driverDeviceId: "A", present: true }]);

    await readPhysicalPresence(driver, ["A", "B"]);

    expect(driver.listPresentPhysical).toHaveBeenCalledTimes(1);
    expect(driver.listPresentPhysical).toHaveBeenCalledWith(["A", "B"]);
  });

  it("rejects when the driver rejects", async () => {
    const failure = new Error("usbmuxd went away");
    const driver = { listPresentPhysical: vi.fn().mockRejectedValue(failure) };

    await expect(readPhysicalPresence(driver, ["A"])).rejects.toBe(failure);
  });
});

describe("readPhysicalPresenceDetail", () => {
  it("answers a present device's OS version when the entry carries one, and no osVersion key when it does not", async () => {
    const driver = driverAnswering([
      { driverDeviceId: "A", osVersion: "18.5", present: true },
      { driverDeviceId: "B", present: true },
    ]);

    const detail = await readPhysicalPresenceDetail(driver, ["A", "B"]);

    expect(detail.get("A")).toStrictEqual({ osVersion: "18.5", present: true });
    expect(detail.get("B")).toStrictEqual({ present: true });
  });

  it("answers the reason an entry gives for a device that is not present, and not-present when it gives none", async () => {
    const driver = driverAnswering([
      { driverDeviceId: "A", present: false, reason: "locked" },
      { driverDeviceId: "B", present: false },
    ]);

    const detail = await readPhysicalPresenceDetail(driver, ["A", "B", "C"]);

    expect(detail.get("A")).toStrictEqual({ present: false, reason: "locked" });
    expect(detail.get("B")).toStrictEqual({ present: false, reason: "not-present" });
    expect(detail.get("C")).toStrictEqual({ present: false, reason: "not-present" });
  });
});

describe("the latest presence read of a device", () => {
  it("is { present: true } after a present read, and { present: false, reason } with the read's reason after a not-present one", async () => {
    const driver = driverAnswering([
      { driverDeviceId: "LATEST-A", osVersion: "18.5", present: true },
      { driverDeviceId: "LATEST-B", present: false, reason: "locked" },
      { driverDeviceId: "LATEST-C", present: false },
    ]);

    await readPhysicalPresenceDetail(driver, ["LATEST-A", "LATEST-B", "LATEST-C", "LATEST-D"]);

    expect(latestPresence("LATEST-A")).toStrictEqual({ present: true });
    expect(latestPresence("LATEST-B")).toStrictEqual({ present: false, reason: "locked" });
    expect(latestPresence("LATEST-C")).toStrictEqual({ present: false, reason: "not-present" });
    expect(latestPresence("LATEST-D")).toStrictEqual({ present: false, reason: "not-present" });
  });

  it("is none before the device's first read, and a read that rejects leaves it as it was", async () => {
    expect(latestPresence("LATEST-E")).toBeUndefined();
    await readPhysicalPresence(
      driverAnswering([{ driverDeviceId: "LATEST-E", present: false, reason: "untrusted" }]),
      ["LATEST-E"],
    );
    expect(latestPresence("LATEST-E")).toStrictEqual({ present: false, reason: "untrusted" });

    const failing = { listPresentPhysical: vi.fn().mockRejectedValue(new Error("usbmuxd")) };
    await expect(readPhysicalPresence(failing, ["LATEST-E"])).rejects.toThrow("usbmuxd");
    await expect(readPhysicalPresenceDetail(failing, ["LATEST-E"])).rejects.toThrow("usbmuxd");

    expect(latestPresence("LATEST-E")).toStrictEqual({ present: false, reason: "untrusted" });
  });

  it("is changed the same way by the boolean read a grant makes, with the read's reason", async () => {
    await readPhysicalPresence(driverAnswering([{ driverDeviceId: "LATEST-F", present: true }]), [
      "LATEST-F",
    ]);
    expect(latestPresence("LATEST-F")).toStrictEqual({ present: true });

    await readPhysicalPresence(
      driverAnswering([{ driverDeviceId: "LATEST-F", present: false, reason: "locked" }]),
      ["LATEST-F"],
    );

    expect(latestPresence("LATEST-F")).toStrictEqual({ present: false, reason: "locked" });
  });
});
