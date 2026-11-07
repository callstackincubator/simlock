import { describe, expect, it } from "vitest";

import {
  devicePath,
  type FleetAddress,
  fleetAddress,
  inboxPath,
  itemIdFrom,
  itemPath,
  streamPath,
} from "./paths";

describe("an item's page path", () => {
  it("carries any id, a slash or a space included, and reads it back whole", () => {
    for (const id of ["wrk_1", "wrk 1/dev_2/quarantined", "a%b"]) {
      expect(itemIdFrom("/inbox", itemPath("/inbox", id)), id).toBe(id);
    }
  });

  it("ends an Inbox address in a slash when the key holds a dot, and not otherwise", () => {
    expect(inboxPath("lease/lse_1.gw/ending")).toBe("/inbox/lease%2Flse_1.gw%2Fending/");
    expect(inboxPath("wrk_1/drained")).toBe("/inbox/wrk_1%2Fdrained");
    expect(itemIdFrom("/inbox", inboxPath("lease/lse_1.gw/ending"))).toBe("lease/lse_1.gw/ending");
  });

  it("round-trips an id with a slash for /fleet, /queue and /activity", () => {
    for (const section of ["/fleet", "/queue", "/activity"] as const) {
      expect(itemPath(section, "a/b c"), section).toBe(`${section}/a%2Fb%20c`);
      expect(itemIdFrom(section, itemPath(section, "a/b c")), section).toBe("a/b c");
    }
  });

  it("names no item on the section's own page or on another section's", () => {
    expect(itemIdFrom("/activity", "/activity")).toBeUndefined();
    expect(itemIdFrom("/activity", "/activity/")).toBeUndefined();
    expect(itemIdFrom("/activity", "/activityx/1")).toBeUndefined();
    expect(itemIdFrom("/activity", "/leases/1")).toBeUndefined();
  });

  it("keeps a malformed escape as it was typed", () => {
    expect(itemIdFrom("/activity", "/activity/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("a worker's page and its device drawer", () => {
  it("name the worker and the device by their own encoded ids, a slash inside either included", () => {
    expect(fleetAddress("/fleet")).toEqual({});
    expect(fleetAddress("/fleet/wrk_1")).toEqual({ workerId: "wrk_1" });
    expect(fleetAddress("/fleet/wrk_1/")).toEqual({ workerId: "wrk_1" });
    expect(fleetAddress(devicePath("wrk 1", "dev/1"))).toEqual({
      deviceId: "dev/1",
      workerId: "wrk 1",
    });
    expect(fleetAddress(devicePath("a/b", "c"))).toEqual({ deviceId: "c", workerId: "a/b" });
    expect(fleetAddress("/leases/wrk_1")).toEqual({});
    expect(fleetAddress("/fleet/%E0%A4%A/dev_1")).toEqual({
      deviceId: "dev_1",
      workerId: "%E0%A4%A",
    });
  });
});

describe("a device's streaming page", () => {
  it("follows either a device address and retains both opaque ids, marking the streaming page alone", () => {
    const cases: readonly {
      readonly address: string;
      readonly case: string;
      readonly wants: FleetAddress;
    }[] = [
      {
        address: devicePath("wrk_1", "dev_1"),
        case: "the drawer address keeps its old reading",
        wants: { deviceId: "dev_1", workerId: "wrk_1" },
      },
      {
        address: streamPath("wrk_1", "dev_1"),
        case: "the streaming address names both ids",
        wants: { deviceId: "dev_1", streaming: true, workerId: "wrk_1" },
      },
      {
        address: streamPath("mac-studio-01.local", "iPhone 16.dev"),
        case: "a dot in either id",
        wants: { deviceId: "iPhone 16.dev", streaming: true, workerId: "mac-studio-01.local" },
      },
      {
        address: streamPath("wrk 1", "dev/1"),
        case: "a slash in either id",
        wants: { deviceId: "dev/1", streaming: true, workerId: "wrk 1" },
      },
      {
        address: streamPath("a%b", "100%"),
        case: "a percent sign in either id",
        wants: { deviceId: "100%", streaming: true, workerId: "a%b" },
      },
      {
        address: "/fleet/%E0%A4%A/devices/%E0%A4%B/",
        case: "a malformed escape in either id",
        wants: { deviceId: "%E0%A4%B", streaming: true, workerId: "%E0%A4%A" },
      },
      {
        address: "/fleet/devices/dev_1/",
        case: "`devices` as the worker's id, so nothing marks a stream",
        wants: { deviceId: "dev_1", workerId: "devices" },
      },
      {
        address: "/fleet/wrk_1/devices",
        case: "no device id after the marker",
        wants: { deviceId: "devices", workerId: "wrk_1" },
      },
      {
        address: "/fleet/wrk_1/devices/dev_1/extra",
        case: "an extra segment past the device id",
        wants: { deviceId: "devices", workerId: "wrk_1" },
      },
    ];

    for (const { address, case: name, wants } of cases) {
      expect(fleetAddress(address), `${name}: ${address}`).toEqual(wants);
    }

    for (const { device, worker } of [
      { device: "dev_1", worker: "wrk_1" },
      { device: "iPhone 16.dev", worker: "mac-studio-01.local" },
      { device: "dev/1", worker: "wrk 1" },
      { device: "100%", worker: "a%b" },
    ]) {
      expect(streamPath(worker, device), worker).toBe(
        `/fleet/${encodeURIComponent(worker)}/devices/${encodeURIComponent(device)}/`,
      );
    }
  });
});
