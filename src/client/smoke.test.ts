/**
 * ADR 0003 §12: "one smoke test per frontend (CLI, MCP, HTTP, client)". This walks
 * `connectSimlock` end to end against a scripted connection: handshake, one full lease
 * lifecycle (request -> grant -> release), and clean disconnect. It deliberately does not
 * re-walk every operation -- `src/simlock-client/client.test.ts` already covers push routing,
 * abort, and error mapping in depth; this file only proves the frontend wiring holds together.
 */
import { describe, expect, it } from "vitest";

import { completeHello, ScriptedConnection } from "../simlock-client/test-support.js";
import { connectSimlock } from "./index.js";

describe("simlock/client smoke test", () => {
  it("connects, requests a lease, and releases it", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlock({ connection, principal: "agent-smoke" });
    await Promise.resolve();
    completeHello(connection, { role: "agent" });
    const client = await connectPromise;
    expect(client.role).toBe("agent");

    const leasePromise = client.requestLease({ model: "iPhone 17", platform: "ios" });
    await Promise.resolve();
    const requestFrame = connection.lastSentOf("lease.request")!;
    connection.reply(requestFrame.id, {
      device: {
        createdAt: 0,
        driverData: null,
        driverDeviceId: "sim-1",
        id: "device_1",
        spec: { model: "iPhone 17", osVersion: "18.0", platform: "ios" },
        state: "leased",
      },
      lease: {
        deviceId: "device_1",
        grantedAt: 0,
        id: "lease_1",
        ownerId: "agent-smoke",
        requesterId: "agent-smoke",
        ttlDeadline: 1_000,
      },
      timing: {
        estimatedBootMs: 1,
        estimatedProvisionMs: 1,
        estimatedReadyMs: 1,
        estimatedReclaimMs: 1,
      },
    });
    const grant = await leasePromise;
    expect(grant.lease.id).toBe("lease_1");

    const releasePromise = client.releaseLease({ leaseId: grant.lease.id });
    await Promise.resolve();
    const releaseFrame = connection.lastSentOf("lease.release")!;
    connection.reply(releaseFrame.id, { leaseId: "lease_1" });
    await expect(releasePromise).resolves.toEqual({ leaseId: "lease_1" });

    await client.close();
    expect(connection.closed).toBe(true);
  });
});
