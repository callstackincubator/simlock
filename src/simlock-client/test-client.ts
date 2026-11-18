import type { LeaseGrant } from "./types.js";

export async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

export function sampleGrant(
  overrides: { readonly leaseId?: string; readonly deviceId?: string } = {},
): LeaseGrant {
  const leaseId = overrides.leaseId ?? "lease_1";
  const deviceId = overrides.deviceId ?? "device_1";
  return {
    device: {
      physical: false,
      driverDeviceId: "sim-1",
      id: deviceId,
      spec: { physical: false, model: "iPhone 17", osVersion: "18.0", platform: "ios" },
      mode: "full",
    },
    environment: {},
    lease: {
      deviceId,
      grantedAt: 0,
      id: leaseId,
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlMs: 1_000,
      ttlDeadline: 1_000,
    },
    timing: {
      estimatedBootMs: 1,
      estimatedProvisionMs: 1,
      estimatedReadyMs: 1,
      estimatedReclaimMs: 1,
    },
  };
}
