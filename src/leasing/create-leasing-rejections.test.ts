import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { type EventMap } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, flush, settledOrPending } from "./test-create-leasing.js";
import { QueueTimeoutError } from "./index.js";

describe("createLeasing: lease.rejected names its request", () => {
  type Reason = Exclude<EventMap["lease.rejected"]["reason"], `admission-${string}`>;
  type Rejection = EventMap["lease.rejected"];
  type Harness = Awaited<ReturnType<typeof createHarness>>;

  interface Outcome {
    readonly harness: Harness;
    readonly requester: string;
    readonly requestId?: string | undefined;
  }

  const holder = { ownerId: "holder", requesterId: "holder" };

  async function admittedId(harness: Harness, requesterId: string): Promise<string | undefined> {
    return harness.registry.leaseRequests().find((record) => record.requesterId === requesterId)
      ?.id;
  }

  /** why: One case per reason in `EventMap`, so a reason added there without a case fails typecheck. */
  const cases: Record<Reason, (() => Promise<Outcome>) | "gateway"> = {
    timeout: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      const timedOut = harness.engine.request(request, {
        ownerId: "late",
        requesterId: "late",
        timeoutMs: 10,
      });
      await flush();
      harness.clock.advance(10);
      await settledOrPending(timedOut);
      return { harness, requestId: await admittedId(harness, "late"), requester: "late" };
    },
    "no-wait": async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      await settledOrPending(
        harness.engine.request(request, { noWait: true, ownerId: "now", requesterId: "now" }),
      );
      return { harness, requestId: await admittedId(harness, "now"), requester: "now" };
    },
    "unresolvable-spec": async () => {
      const harness = await createHarness();
      await settledOrPending(
        harness.engine.request(
          { ...request, osVersion: "1.0" },
          { ownerId: "odd", requesterId: "odd" },
        ),
      );
      return { harness, requestId: await admittedId(harness, "odd"), requester: "odd" };
    },
    "no-worker": "gateway",
    "worker-failed": "gateway",
    "already-leased": async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      await settledOrPending(harness.engine.request(request, holder));
      return { harness, requester: "holder" };
    },
    "lease-id-taken": async () => {
      const harness = await createHarness({
        limits: {
          android: { maxDevices: 2, maxRunning: 2 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 4,
        },
      });
      await harness.engine.request(request, { ...holder, leaseId: "myid" });
      await settledOrPending(
        harness.engine.request(request, {
          leaseId: "myid",
          ownerId: "clash",
          requesterId: "clash",
        }),
      );
      return { harness, requester: "clash" };
    },
    "lease-ended": async () => {
      const harness = await createHarness();
      await harness.engine.request(request, { ...holder, leaseId: "myid" });
      await harness.engine.release("myid", "explicit");
      await settledOrPending(
        harness.engine.request(request, {
          leaseId: "myid",
          ownerId: "again",
          requesterId: "again",
        }),
      );
      return { harness, requester: "again" };
    },
    "boot-timeout": async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      driver.failOn("makeReady", 1, new Error("boot failed"));
      const harness = await createHarness({ driver });
      await settledOrPending(
        harness.engine.request(request, { ownerId: "slow", requesterId: "slow" }),
      );
      return { harness, requestId: await admittedId(harness, "slow"), requester: "slow" };
    },
    killed: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      const queued = harness.engine.request(request, { ownerId: "next", requesterId: "next" });
      void queued.catch(() => undefined);
      await flush();
      await harness.engine.nuke(false);
      return { harness, requestId: await admittedId(harness, "next"), requester: "next" };
    },
    updating: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      void harness.engine
        .request(request, { ownerId: "next", requesterId: "next" })
        .catch(() => undefined);
      await flush();
      await harness.engine.leasing.holdForUpdate();
      return { harness, requestId: await admittedId(harness, "next"), requester: "next" };
    },
    cancelled: async () => {
      const harness = await createHarness();
      await harness.engine.request(request, holder);
      void harness.engine
        .request(request, { ownerId: "next", requesterId: "next" })
        .catch(() => undefined);
      await flush();
      await harness.engine.cancelPending("next");
      return { harness, requestId: await admittedId(harness, "next"), requester: "next" };
    },
    "daemon-restarted": async () => {
      const before = await createHarness();
      await before.engine.request(request, holder);
      void before.engine
        .request(request, { ownerId: "agent", requesterId: "agent" })
        .catch(() => undefined);
      await expect.poll(() => admittedId(before, "agent")).toEqual(expect.stringMatching(/^req_/));
      const requestId = await admittedId(before, "agent");
      const harness = await createHarness({ state: before.state });
      await harness.engine.convergeRunningCapacity();
      return { harness, requestId, requester: "agent" };
    },
  };

  const workerReasons = (Object.keys(cases) as Reason[]).filter(
    (reason) => cases[reason] !== "gateway",
  );

  it.each(workerReasons)(
    "includes the request id and the requester when it rejects with %s",
    async (reason) => {
      const run = cases[reason];
      if (run === "gateway") throw new Error(`${reason} is the gateway's`);

      const { harness, requestId, requester } = await run();

      const rejections = harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => event.payload as Rejection)
        .filter((payload) => payload.reason === reason);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        requestId: requestId ?? expect.stringMatching(/^req_/),
        requester,
      });
    },
  );
});

describe("createLeasing queue timeout and failure storage", () => {
  const android = {
    physical: false,
    model: "Pixel 9",
    osVersion: "35",
    platform: "android",
  } as const;

  it("emits lease.rejected for a timed-out waiter under the wait queue's module, then lets the request behind it through", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const droid = new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" });
    const harness = await createHarness({ driver: ios, drivers: [ios, droid] });
    await harness.engine.request(request, { ownerId: "holder", requesterId: "holder" });
    const blocking = harness.engine.request(request, {
      ownerId: "head",
      requesterId: "head",
      timeoutMs: 10,
    });
    const behind = harness.engine.request(android, { ownerId: "behind", requesterId: "behind" });
    await flush();
    // why: The android request could be served now, but it waits behind the iOS one at the head.
    expect(await settledOrPending(behind)).toBe("still pending");

    harness.clock.advance(10);

    expect(await settledOrPending(blocking)).toBeInstanceOf(QueueTimeoutError);
    expect(await settledOrPending(behind)).toMatchObject({ lease: { requesterId: "behind" } });
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.rejected")
        .map((event) => ({
          module: event.module,
          reason: (event.payload as { reason: string }).reason,
        })),
    ).toEqual([{ module: "wait-queue", reason: "timeout" }]);
  });

  it("stores a failed request as INTERNAL with the error's own message when no classifier was given", async () => {
    const harness = await createHarness();

    await expect(
      harness.engine.request(android, { ownerId: "agent", requesterId: "agent" }),
    ).rejects.toThrow("No driver registered for platform: android");

    expect(harness.registry.leaseRequests()).toMatchObject([
      {
        failure: { code: "INTERNAL", message: "No driver registered for platform: android" },
        state: "failed",
      },
    ]);
  });
});
