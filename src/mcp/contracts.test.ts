import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../contract/index.js";
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

  it("rejects requesterId, mode, and ttlMs -- those are the session's job, not the caller's", () => {
    for (const extra of [{ requesterId: "someone-else" }, { mode: "detached" }, { ttlMs: 1_000 }]) {
      expect(() =>
        leaseSimulatorInputSchema.parse({ model: "iPhone 17 Pro", platform: "ios", ...extra }),
      ).toThrow();
    }
  });

  it("is the same schema the contract validates lease.request input against, minus those fields", () => {
    const full = OPERATIONS["lease.request"].input.innerType();
    expect(Object.keys(leaseSimulatorInputSchema.shape).sort()).toEqual(
      Object.keys(full.shape)
        .filter((key) => !["mode", "requesterId", "ttlMs"].includes(key))
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
        state: "leased",
      },
      environment: {},
      lease: {
        deviceId: "device-1",
        grantedAt: 0,
        id: "lease-1",
        mode: "held",
        ownerId: "mcp:1",
        requesterId: "mcp:1",
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
