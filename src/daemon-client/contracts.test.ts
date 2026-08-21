import { describe, expect, it } from "vitest";

import {
  parseRawCatalog,
  parseRawDeviceRecovered,
  parseRawDeviceUnhealthy,
  parseRawLeaseGrant,
  parseRawLeaseHeartbeatAck,
} from "./contracts.js";

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

const catalog = {
  platforms: [
    { defaultRuntime: "26.5", models: ["iPhone 16"], platform: "ios", runtimes: ["18.4", "26.5"] },
    { defaultRuntime: undefined, models: ["Pixel 8"], platform: "android", runtimes: [] },
  ],
};

describe("parseRawCatalog", () => {
  it("parses catalog entries shared by daemon frontends", () => {
    expect(parseRawCatalog(catalog)).toEqual(catalog);
  });

  it.each([
    [{ platforms: [{ ...catalog.platforms[0], platform: "web" }] }],
    [{ platforms: [{ ...catalog.platforms[0], models: [42] }] }],
    [{ platforms: [{ ...catalog.platforms[0], runtimes: "26.5" }] }],
    [{ platforms: [{ ...catalog.platforms[0], defaultRuntime: 5 }] }],
    [{ platforms: "not-an-array" }],
    [null],
  ])("rejects malformed daemon payloads", (value) => {
    expect(() => parseRawCatalog(value)).toThrow("Daemon returned an invalid device catalog");
  });
});

describe("parseRawLeaseHeartbeatAck", () => {
  it("parses the slid deadlines from a heartbeat ack", () => {
    const ack = { leases: [{ leaseId: "lse_1", ttlDeadline: 5_000 }] };
    expect(parseRawLeaseHeartbeatAck(ack)).toEqual(ack);
  });

  it("parses an empty leases list", () => {
    expect(parseRawLeaseHeartbeatAck({ leases: [] })).toEqual({ leases: [] });
  });

  it.each([
    [{ leases: "not-an-array" }],
    [{ leases: [{ leaseId: 1, ttlDeadline: 5_000 }] }],
    [{ leases: [{ leaseId: "lse_1", ttlDeadline: "5000" }] }],
    [{}],
    [null],
  ])("rejects malformed heartbeat acks", (value) => {
    expect(() => parseRawLeaseHeartbeatAck(value)).toThrow("Daemon sent an invalid heartbeat ack");
  });
});

describe("parseRawDeviceUnhealthy", () => {
  it("parses the device-unhealthy push notified to a lease's holding connection", () => {
    const notice = { deviceId: "ABCD", leaseId: "lse_9f2c", reason: "crashed" };
    expect(parseRawDeviceUnhealthy(notice)).toEqual(notice);
  });

  it.each([
    [{ deviceId: 42, leaseId: "lse_9f2c", reason: "crashed" }],
    [{ deviceId: "ABCD", leaseId: 9, reason: "crashed" }],
    [{ deviceId: "ABCD", leaseId: "lse_9f2c", reason: 1 }],
    [{ deviceId: "ABCD", leaseId: "lse_9f2c" }],
    [null],
  ])("rejects malformed device-unhealthy notifications", (value) => {
    expect(() => parseRawDeviceUnhealthy(value)).toThrow(
      "Daemon sent an invalid device-unhealthy notification",
    );
  });
});

describe("parseRawDeviceRecovered", () => {
  it("parses the device-recovered push notified to a lease's holding connection", () => {
    const notice = { attempts: 2, deviceId: "ABCD", leaseId: "lse_9f2c" };
    expect(parseRawDeviceRecovered(notice)).toEqual(notice);
  });

  it.each([
    [{ attempts: "2", deviceId: "ABCD", leaseId: "lse_9f2c" }],
    [{ attempts: 2, deviceId: 42, leaseId: "lse_9f2c" }],
    [{ attempts: 2, deviceId: "ABCD", leaseId: 9 }],
    [{ deviceId: "ABCD", leaseId: "lse_9f2c" }],
    [null],
  ])("rejects malformed device-recovered notifications", (value) => {
    expect(() => parseRawDeviceRecovered(value)).toThrow(
      "Daemon sent an invalid device-recovered notification",
    );
  });
});
