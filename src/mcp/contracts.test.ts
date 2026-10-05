import { describe, expect, it } from "vitest";

import { leaseRequestFields } from "../contract/index.js";
import {
  leaseSimulatorInputSchema,
  leaseSimulatorOutputSchema,
  leaseStatusOutputSchema,
  releaseSimulatorInputSchema,
  releaseSimulatorOutputSchema,
} from "./contracts.js";

describe("MCP contracts", () => {
  it("accepts a minimal lease input and omits the session-controlled fields", () => {
    expect(leaseSimulatorInputSchema.parse({ model: "iPhone 17 Pro", platform: "ios" })).toEqual({
      model: "iPhone 17 Pro",
      platform: "ios",
    });
  });

  it("rejects requesterId -- the session's identity is not the caller's to name", () => {
    expect(() =>
      leaseSimulatorInputSchema.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        requesterId: "someone-else",
      }),
    ).toThrow();
  });

  it("accepts a device mode", () => {
    expect(
      leaseSimulatorInputSchema.parse({ model: "iPhone 17 Pro", mode: "slim", platform: "ios" }),
    ).toEqual({ model: "iPhone 17 Pro", mode: "slim", platform: "ios" });
  });

  it.each([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "detached" }],
  ])("rejects %s", (_label, extra) => {
    expect(
      leaseSimulatorInputSchema.safeParse({ model: "iPhone 17 Pro", platform: "ios", ...extra })
        .success,
    ).toBe(false);
  });

  it("accepts ttlMs, which ADR 0004 allows on every lease request", () => {
    expect(
      leaseSimulatorInputSchema.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        ttlMs: 1_000,
      }),
    ).toEqual({ model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 });
  });

  it("is the same schema the contract validates lease.request input against, minus requesterId", () => {
    expect(Object.keys(leaseSimulatorInputSchema.innerType().shape).sort()).toEqual(
      Object.keys(leaseRequestFields.shape)
        .filter((key) => key !== "requesterId")
        .sort(),
    );
  });

  it("validates a lease grant, release, and lease-status shape using contract field names", () => {
    const grant = leaseSimulatorOutputSchema.parse({
      device: {
        createdAt: 0,
        driverData: null,
        driverDeviceId: "SIM-1",
        id: "device-1",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        mode: "full",
        state: "leased",
      },
      environment: {},
      lease: {
        deviceId: "device-1",
        grantedAt: 0,
        id: "lease-1",
        lastRenewedAt: 0,
        ownerId: "mcp:1",
        requesterId: "mcp:1",
        ttlMs: 60_000,
        ttlDeadline: 61_000,
      },
      timing: {
        estimatedBootMs: 20,
        estimatedProvisionMs: 10,
        estimatedReadyMs: 30,
        estimatedReclaimMs: 0,
      },
    });
    expect(grant.lease.id).toBe("lease-1");

    expect(releaseSimulatorInputSchema.parse({ leaseId: "lease-1" })).toEqual({
      leaseId: "lease-1",
    });
    expect(releaseSimulatorOutputSchema.parse({ leaseId: "lease-1", released: true })).toEqual({
      leaseId: "lease-1",
      released: true,
    });

    expect(leaseStatusOutputSchema.parse({ held: false })).toEqual({ held: false });
  });
});
