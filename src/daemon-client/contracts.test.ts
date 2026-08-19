import { describe, expect, it } from "vitest";

import { parseRawLeaseGrant } from "./contracts.js";

const leaseGrant = {
  device: {
    driverDeviceId: "ABCD",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
  },
  lease: { id: "lse_9f2c", mode: "held", ttlDeadline: 61_000 },
  timing: {
    estimatedBootMs: 20,
    estimatedProvisionMs: 10,
    estimatedReclaimMs: 0,
    estimatedReadyMs: 30,
  },
};

describe("parseRawLeaseGrant", () => {
  it("parses the lease fields shared by daemon frontends", () => {
    expect(parseRawLeaseGrant(leaseGrant)).toEqual(leaseGrant);
  });

  it.each([
    [{ ...leaseGrant, device: { ...leaseGrant.device, driverDeviceId: 42 } }],
    [
      {
        ...leaseGrant,
        device: { ...leaseGrant.device, spec: { ...leaseGrant.device.spec, platform: "web" } },
      },
    ],
    [{ ...leaseGrant, lease: { ...leaseGrant.lease, mode: "forever" } }],
    [{ ...leaseGrant, lease: { id: "lse_9f2c", mode: "held" } }],
    [{ ...leaseGrant, timing: { ...leaseGrant.timing, estimatedReadyMs: "30" } }],
    [null],
  ])("rejects malformed daemon payloads", (value) => {
    expect(() => parseRawLeaseGrant(value)).toThrow("Daemon returned an invalid lease grant");
  });
});
