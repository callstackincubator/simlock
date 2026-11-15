import { describe, expect, it, vi } from "vitest";
import { connectSimlockAdmin } from "../admin/index.js";
import { completeHello, ScriptedConnection } from "./test-support.js";
import { flushMicrotasks, sampleGrant } from "./test-client.js";

describe("simlock/admin", () => {
  it("exposes the admin operations and sends daemon.stop like any other request", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const admin = await connectPromise;
    expect(admin.role).toBe("admin");

    const stopPromise = admin.stopDaemon();
    await flushMicrotasks();
    const stopCall = connection.lastSentOf("daemon.stop")!;
    connection.reply(stopCall.id, { stopping: true });
    await expect(stopPromise).resolves.toEqual({ stopping: true });
  });

  it("releaseAllLeases clears every held lease id and connection death afterwards fires no onLeaseLost", async () => {
    const connection = new ScriptedConnection();
    const connectPromise = connectSimlockAdmin({ connection, credential: "operator-secret" });
    await flushMicrotasks();
    completeHello(connection, { role: "admin" });
    const admin = await connectPromise;

    const firstGrant = admin.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    connection.reply(
      connection.lastSentOf("lease.request")!.id,
      sampleGrant({ leaseId: "lease_a" }),
    );
    await firstGrant;

    const secondGrant = admin.requestLease({ model: "iPhone 17", platform: "ios" });
    await flushMicrotasks();
    connection.reply(
      connection.lastSentOf("lease.request")!.id,
      sampleGrant({ leaseId: "lease_b" }),
    );
    await secondGrant;

    const releaseAllPromise = admin.releaseAllLeases();
    await flushMicrotasks();
    const releaseAllCall = connection.lastSentOf("lease.release-all")!;
    connection.reply(releaseAllCall.id, { leaseIds: ["lease_a", "lease_b"] });
    await expect(releaseAllPromise).resolves.toMatchObject({
      leaseIds: ["lease_a", "lease_b"],
    });

    // Both leases are no longer tracked as held -- a later connection death synthesizes no
    // onLeaseLost for either of them.
    const leaseLost = vi.fn();
    admin.onLeaseLost(leaseLost);
    connection.simulateDeath();
    await flushMicrotasks();
    expect(leaseLost).not.toHaveBeenCalled();
  });
});
