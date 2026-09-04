import { describe, expect, it } from "vitest";

import {
  parseRawCatalog,
  parseRawDeviceRecovered,
  parseRawDeviceUnhealthy,
  parseRawLeaseGrant,
  parseRawLeaseHeartbeatAck,
  parseRawPassthroughCommand,
} from "./contracts.js";

const leaseGrant = {
  device: {
    driverDeviceId: "ABCD",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
  },
  environment: { SIMLOCK_IOS_DEVICE_SET: "/home/agent/.simlock/devices/ios" },
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

  it("reads a grant from a daemon too old to send an environment as having none", () => {
    const { environment: _omitted, ...withoutEnvironment } = leaseGrant;

    expect(parseRawLeaseGrant(withoutEnvironment).environment).toEqual({});
  });

  it.each([["not-an-object"], [42], [null], [["SIMLOCK_IOS_DEVICE_SET"]]])(
    "reads a malformed environment as having none rather than failing the grant: %s",
    (environment) => {
      expect(parseRawLeaseGrant({ ...leaseGrant, environment }).environment).toEqual({});
    },
  );

  it("keeps the string entries of an environment carrying non-string values", () => {
    const environment = { ANDROID_ADB_SERVER_PORT: "5038", broken: 5038 };

    expect(parseRawLeaseGrant({ ...leaseGrant, environment }).environment).toEqual({
      ANDROID_ADB_SERVER_PORT: "5038",
    });
  });
});

describe("parseRawPassthroughCommand", () => {
  it("parses the command a driver resolved for a passthrough", () => {
    const command = {
      args: ["-P", "5038", "shell", "getprop"],
      command: "/sdk/platform-tools/adb",
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    };

    expect(parseRawPassthroughCommand(command)).toEqual(command);
  });

  it("defaults a missing environment to none rather than failing", () => {
    expect(parseRawPassthroughCommand({ args: ["list", "devices"], command: "xcrun" }).env).toEqual(
      {},
    );
  });

  it.each([
    [{ args: [], command: "" }],
    [{ args: ["shell", 42], command: "adb" }],
    [{ args: "shell", command: "adb" }],
    [{ command: "adb" }],
    [null],
  ])("rejects a command that could not be spawned as given", (value) => {
    expect(() => parseRawPassthroughCommand(value)).toThrow(
      "Daemon returned an invalid passthrough command",
    );
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
