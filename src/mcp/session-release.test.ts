import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { RELEASE_TIMEOUT_MS } from "../lease-policy/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { McpSession } from "./session.js";
import { flushMicrotasks } from "./test-session.js";

describe("McpSession", () => {
  it("releases the session's lease explicitly on close, before closing the connection", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await session.close();

    expect(client.calls.map((call) => call.method)).toEqual(["requestLease", "releaseLease"]);
    expect(client.calls.at(-1)?.input).toEqual({ leaseId: "lease-1" });
    expect(client.closeCalls).toBe(1);
    expect(clock.pendingTimerCount, "the renew timer must not outlive the session").toBe(0);
  });

  it("closes cleanly even when the farewell release fails", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("UNKNOWN_LEASE", "domain", "gone", { leaseId: "lease-1" }));
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await expect(session.close()).resolves.toBeUndefined();
    expect(client.closeCalls).toBe(1);
  });

  it("does not release on close when the lease was already released by a tool call", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await session.release({ leaseId: "lease-1" });
    expect(clock.pendingTimerCount).toBe(0);

    await session.close();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(1);
  });

  it("still sends its own release when a tool call's release is already in flight", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    const pending: Array<(result: { leaseId: string }) => void> = [];
    client.releaseLeaseImpl = () =>
      new Promise<{ leaseId: string }>((resolve) => {
        pending.push(resolve);
      });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    // why: `close()` does not queue behind the tool-call serializer, so it can land while a
    // `release_simulator` call is still waiting on the daemon. It waits for that call, then
    // sends its own release anyway: deferring to the in-flight one would mean no release at
    // all if the wire died first, and a duplicate only costs an `UNKNOWN_LEASE` it swallows.
    const releasing = session.release({ leaseId: "lease-1" });
    await flushMicrotasks();
    const closing = session.close();
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(1);

    pending[0]?.({ leaseId: "lease-1" }); // the tool call's own release is answered
    await expect(releasing).resolves.toMatchObject({ leaseId: "lease-1", released: true });
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toHaveLength(2);

    pending[1]?.({ leaseId: "lease-1" });
    await closing;
    expect(client.closeCalls).toBe(1);
    expect(clock.pendingTimerCount, "no bound outlives the close").toBe(0);
  });

  it("spends one shutdown budget in total, not one per step", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.listLeasesImpl = () => new Promise(() => {});
    client.releaseLeaseImpl = () => new Promise(() => {});
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    void session.status().catch(() => undefined); // in flight, never answered
    await flushMicrotasks();

    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await flushMicrotasks();

    // why: A budget per step -- one for the in-flight call, then one more for the lease -- would
    // leave `simlock mcp` sitting here for a multiple of this after stdin EOF.
    clock.advance(RELEASE_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(closed).toBe(false);

    clock.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(client.closeCalls, "the wire closes when the budget is spent").toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("stops releasing when the shutdown budget runs out, rather than calling a closed client", async () => {
    // why: `awaitWithin` stops *waiting*; it cannot stop the loop it was waiting on. Without a
    // check the abandoned loop would carry on down the remaining leases against the client the
    // `finally` has already closed -- one rejection per lease, after the session was over.
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    let granted = 0;
    client.requestLeaseImpl = () => {
      granted += 1;
      return Promise.resolve(sampleGrant({ leaseId: `lease-${String(granted)}` }));
    };
    let answerFirstRelease!: (result: { leaseId: string }) => void;
    client.releaseLeaseImpl = (input) =>
      input.leaseId === "lease-1"
        ? new Promise((resolve) => {
            answerFirstRelease = resolve;
          })
        : Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    const closing = session.close();
    await flushMicrotasks();
    clock.advance(RELEASE_TIMEOUT_MS);
    await closing;
    expect(client.closeCalls).toBe(1);

    answerFirstRelease({ leaseId: "lease-1" });
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([
      { input: { leaseId: "lease-1" }, method: "releaseLease" },
    ]);
  });

  it("releases a grant that lands after the session closed, and arms no timer for it", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    let answerGrant!: (grant: ReturnType<typeof sampleGrant>) => void;
    client.requestLeaseImpl = () =>
      new Promise((resolve) => {
        answerGrant = resolve;
      });
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });

    const leasing = session.lease({ model: "iPhone 17 Pro", platform: "ios" });
    await flushMicrotasks();
    const closing = session.close();
    await flushMicrotasks();

    answerGrant(sampleGrant({ leaseId: "lease-1" }));
    await expect(leasing).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await closing;

    expect(client.calls.filter((call) => call.method === "releaseLease")).toEqual([
      { input: { leaseId: "lease-1" }, method: "releaseLease" },
    ]);
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);
    expect(clock.pendingTimerCount, "a closed session must leave no timer behind").toBe(0);
  });

  it("stops renewing before it asks to release, so a renew cannot overtake the answer", async () => {
    // why: ADR 0003 §8: `onLeaseLost` never fires for a release this same client asked for. A timer
    // left armed across an in-flight release breaks that -- the renew lands after
    // `Registry#beginRelease` has dropped the record, comes back UNKNOWN_LEASE, and renewal
    // reports the agent's own release to it as a lost device. Ordering hides it on a unix
    // socket; a gateway hop (ADR 0003 §12) would not.
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    let answerRelease!: (result: { leaseId: string }) => void;
    client.releaseLeaseImpl = () =>
      new Promise((resolve) => {
        answerRelease = resolve;
      });
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

    const releasing = session.release({ leaseId: "lease-1" });
    await flushMicrotasks();

    // why: The daemon has the release and has not answered yet. This is exactly the window a renew
    // would land in -- and there is no timer left to send one.
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);

    answerRelease({ leaseId: "lease-1" });
    await expect(releasing).resolves.toEqual({ leaseId: "lease-1", released: true });
    expect(notices, "the agent asked for this; it is not news of a lost device").toEqual([]);

    await session.close();
  });

  it("does not put the timer back for a lease that was lost while the release was in flight", async () => {
    // why: A failed release usually means the session still holds the device, so the timer goes
    // back. Not here: the daemon ended this lease (an expiry, an operator) while the release
    // was on the wire, so there is nothing left to renew and the retry would run a ladder
    // against a record that no longer exists.
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    let failRelease!: (error: unknown) => void;
    client.releaseLeaseImpl = () =>
      new Promise((_resolve, reject) => {
        failRelease = reject;
      });
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    const notices: unknown[] = [];
    session.onLeaseLost((notice) => notices.push(notice));
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    const releasing = session.release({ leaseId: "lease-1" });
    await flushMicrotasks();
    client.emitLeaseLost({ deviceId: "device-1", leaseId: "lease-1", reason: "expired" });

    // why: Transient on its face -- the daemon may serve the next one -- but the lease it was about
    // is gone regardless.
    failRelease(new SimlockError("INTERNAL", "domain", "could not release", {}));
    await expect(releasing).rejects.toMatchObject({ code: "INTERNAL" });

    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);
    expect(notices).toEqual([{ deviceId: "device-1", leaseId: "lease-1", reason: "expired" }]);

    await session.close();
  });

  it("leaves the timer stopped when the release fails because the lease is already gone", async () => {
    // why: The other side of restarting a stopped timer: an UNKNOWN_LEASE means there is nothing
    // left to renew, so putting the timer back would only produce the same answer on a ladder
    // until the deadline -- and announce it as a lease lost.
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = () =>
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

    await expect(session.release({ leaseId: "lease-1" })).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });

    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    await flushMicrotasks();
    expect(client.calls.filter((call) => call.method === "renewLease")).toEqual([]);
    expect(notices).toEqual([]);

    await session.close();
  });

  it("keeps renewing when a release fails, because the session still holds the device", async () => {
    const clock = new FakeClock(0);
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "lease-1" }));
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("INTERNAL", "domain", "could not release", {}));
    let renewals = 0;
    client.renewLeaseImpl = (input) => {
      renewals += 1;
      return Promise.resolve({
        deviceId: "device-1",
        grantedAt: 0,
        id: input.leaseId,
        ownerId: "mcp-test",
        requesterId: "mcp-test",
        lastRenewedAt: 0,
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: clock.now() + 12_000,
      });
    };
    const session = new McpSession({
      clock,
      connect: async () => client,
      connectForRenew: async () => client,
    });
    await session.lease({ model: "iPhone 17 Pro", platform: "ios" });

    await expect(session.release({ leaseId: "lease-1" })).rejects.toMatchObject({
      code: "INTERNAL",
    });

    // why: The daemon still has the lease, so the timer that keeps it must still be running --
    // otherwise the device is reclaimed at the deadline under a session that was told its
    // release failed.
    clock.advance(4_115);
    await flushMicrotasks();
    expect(renewals).toBe(1);
    await session.close();
  });
});
