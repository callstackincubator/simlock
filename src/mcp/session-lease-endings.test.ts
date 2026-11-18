import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant, startingStatus } from "./test-support.js";
import { McpSession } from "./session.js";
import { flushMicrotasks } from "./test-session.js";

describe("McpSession", () => {
  it("reports a lease the daemon says is gone as lease-lost, and releases nothing on close", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.renewLeaseImpl = () =>
      Promise.reject(
        new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lease-1" }),
      );
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    // why: A lease that expired while this session was idle may never produce a push -- the
    // renewal's own answer is what tells the agent.
    clock.advance(4_115);
    await flushMicrotasks();
    expect(notices).toEqual([
      { deviceId: "device-1", leaseId: "lease-1", reason: "renew-rejected" },
    ]);
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([]);
    expect(client.calls.filter((call) => call.method === "renewLease")).toHaveLength(1);
  });

  it("reports a lease it could not keep alive as lost, and releases nothing for it on close", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    // why: Never terminal, never successful: the ladder retries until `sampleGrant`'s own 12_345
    // deadline passes and renewal gives up.
    client.renewLeaseImpl = () =>
      Promise.reject(new SimlockError("INTERNAL", "domain", "could not persist", {}));
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(4_115);
    await flushMicrotasks();
    clock.advance(20_000); // the retry lands past the deadline
    await flushMicrotasks();

    expect(notices).toEqual([{ deviceId: "device-1", leaseId: "lease-1", reason: "renew-failed" }]);
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(
      client.calls.filter((call) => call.method === "releaseLease"),
      "a lease that expired is not the session's to release",
    ).toEqual([]);
  });

  it("announces one ending once, even when the renewal and the daemon both report it", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.renewLeaseImpl = () =>
      Promise.reject(
        new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", { leaseId: "lease-1" }),
      );
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    clock.advance(4_115);
    await flushMicrotasks();
    // why: The daemon's own push for the same lease arrives a moment later; an agent must not read
    // that as a second device lost.
    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });

    expect(notices).toEqual([
      { deviceId: "device-1", leaseId: "lease-1", reason: "renew-rejected" },
    ]);

    await session.close();
  });

  it("stops renewing a lease that ended elsewhere", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });

    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([]);
  });

  it("remembers the endings it announced up to a cap, dropping the oldest first", async () => {
    // why: The dedupe memory of a long-lived session cannot grow without bound. It is a fixed
    // window over the most recent endings, which is where duplicates actually live: a
    // renewal's answer and the daemon's push about one lease arrive moments apart, never
    // dozens of leases later.
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    client.getStatusImpl = () => Promise.resolve(startingStatus());
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.listDevices({}); // wires the push relays up
    const notices: Array<{ leaseId: string }> = [];
    session.onLeaseLost((notice) => notices.push(notice));

    // why: One past the cap, so the very first id has been dropped by the end of it.
    const announced = 65;
    for (let index = 0; index < announced; index += 1) {
      client.emitLeaseLost({
        deviceId: "device-1",
        leaseId: `lease-${String(index)}`,
        reason: "expired",
      });
    }
    expect(notices).toHaveLength(announced);

    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-64", reason: "expired" });
    expect(notices).toHaveLength(announced);

    // why: The oldest has aged out of the window, so its duplicate -- if one ever came, long after
    // everything else -- would be announced again. That is the trade the cap makes.
    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-0", reason: "expired" });
    expect(notices).toHaveLength(announced + 1);
    expect(notices.at(-1)?.leaseId).toBe("lease-0");

    await session.close();
  });

  it("relays the client's lease-lost, device-unhealthy, and device-recovered pushes to session listeners", async () => {
    const client = new FakeSimlockClient();
    client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    client.getStatusImpl = () => Promise.resolve(startingStatus());
    const session = new McpSession({
      clock: new FakeClock(),
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.listDevices({}); // forces the client to connect and wire up push relays

    const leaseLost: unknown[] = [];
    const deviceHealth: unknown[] = [];
    session.onLeaseLost((notice) => leaseLost.push(notice));
    session.onDeviceHealth((notice) => deviceHealth.push(notice));

    client.emitLeaseLost({ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" });
    client.emitDeviceUnhealthy({ deviceId: "SIM-1", leaseId: "lease-1" });
    client.emitDeviceRecovered({ attempts: 2, deviceId: "SIM-1", leaseId: "lease-1" });

    expect(leaseLost).toEqual([{ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" }]);
    expect(deviceHealth).toEqual([
      { deviceId: "SIM-1", kind: "unhealthy", leaseId: "lease-1", reason: "crashed" },
      { attempts: 2, deviceId: "SIM-1", kind: "recovered", leaseId: "lease-1" },
    ]);
  });
});
