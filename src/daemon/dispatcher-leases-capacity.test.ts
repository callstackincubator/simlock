import { describe, expect, it } from "vitest";
import { type Config } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { classifyError } from "./error-code.js";
import { HOST_SYSTEM, buildDispatcher, flush, gibibyte, session } from "./test-dispatcher.js";

describe("Dispatcher: a noWait lease.request refused for capacity names the check that refused it", () => {
  const sizes = { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte };
  const limits = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 4, maxRunning: 4 },
    maxRunning: 6,
  };
  const ios = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
  const resource = (
    overrides: { limits?: typeof limits; ramBudget?: typeof sizes } = {},
  ): Config["capacity"] => ({
    strategy: "resource",
    config: { limits: overrides.limits ?? limits, ramBudget: overrides.ramBudget ?? sizes },
  });
  const holder = () => session({ principal: "tok_holder" });
  const asker = () => session({ principal: "tok_asker" });
  const refusal = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error("expected the request to be refused");
      },
      (error: unknown) => error,
    );

  it.each([
    {
      name: "the RAM budget",
      reason: "ram-budget",
      capacity: resource({ ramBudget: { ...sizes, iosBytesPerDevice: 30 * gibibyte } }),
      holds: false,
    },
    {
      name: "the device limit",
      reason: "device-limit",
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 1, maxRunning: 4 } } }),
      holds: true,
    },
    {
      name: "the platform running limit",
      reason: "platform-running-limit",
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 4, maxRunning: 1 } } }),
      holds: true,
    },
  ] as const)("rejects NO_CAPACITY with details.capacityReason $reason at $name", async (row) => {
    // why: a host serves a platform only with a driver for it (#1689), so the global limit above the iOS one needs an Android driver.
    const { dispatcher } = await buildDispatcher({
      capacity: row.capacity,
      extraDrivers: [new FakeDriver({ clock: new FakeClock(1_000), platform: "android" })],
    });
    if (row.holds) await dispatcher.dispatch("lease.request", ios, holder());

    await expect(
      dispatcher.dispatch("lease.request", { ...ios, noWait: true }, asker()),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", details: { capacityReason: row.reason } });
  });

  it("rejects NO_CAPACITY with no details for a request behind an earlier one", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: resource({ limits: { ...limits, ios: { maxDevices: 1, maxRunning: 4 } } }),
    });
    await dispatcher.dispatch("lease.request", ios, holder());
    const waiting = dispatcher.dispatch("lease.request", ios, session({ principal: "tok_head" }));
    void waiting.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const error = await refusal(
      dispatcher.dispatch("lease.request", { ...ios, noWait: true }, asker()),
    );

    expect(classifyError(error)).toBe("NO_CAPACITY");
    expect((error as { details?: unknown }).details).toBeUndefined();
  });

  it("answers a replay of the RAM-budget request by its idempotency key with NO_CAPACITY and no details", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: resource({ ramBudget: { ...sizes, iosBytesPerDevice: 30 * gibibyte } }),
    });
    const input = { ...ios, idempotencyKey: "key-1", noWait: true } as const;
    await expect(dispatcher.dispatch("lease.request", input, asker())).rejects.toMatchObject({
      details: { capacityReason: "ram-budget" },
    });

    const replay = await refusal(dispatcher.dispatch("lease.request", input, asker()));

    expect(classifyError(replay)).toBe("NO_CAPACITY");
    expect((replay as { details?: unknown }).details).toBeUndefined();
  });
});

describe("Dispatcher: startup-readiness parking", () => {
  it("answers status.get with host facts while other operations are parked on startup", async () => {
    const { dispatcher } = await buildDispatcher({
      awaitReady: () => new Promise<void>(() => undefined),
      hostFacts: () => ({
        ...HOST_SYSTEM,
        tools: [{ name: "xcode", platform: "ios", version: "16.4" }],
      }),
    });

    let parked = true;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      parked = false;
    });
    const status = (await dispatcher.dispatch("status.get", {}, session())) as {
      readonly host: { readonly os: string; readonly tools: readonly unknown[] };
    };
    await flush();

    expect(parked).toBe(true);
    expect(status.host.os).toBe("macOS");
    expect(status.host.tools).toHaveLength(1);
  });

  it("parks every operation but status.get on awaitReady", async () => {
    let releaseReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { dispatcher } = await buildDispatcher({ awaitReady: () => readyPromise });

    let statusSettled = false;
    void dispatcher.dispatch("status.get", {}, session()).then(() => {
      statusSettled = true;
    });
    await flush();
    expect(statusSettled).toBe(true);

    const parked = {
      "catalog.get": dispatcher.dispatch("catalog.get", {}, session()),
      "lease.request": dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      ),
      "list.get": dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
    };
    const settled = new Set<string>();
    for (const [operation, answer] of Object.entries(parked)) {
      void answer.then(
        () => settled.add(operation),
        () => settled.add(operation),
      );
    }
    await flush();
    expect([...settled]).toEqual([]);

    releaseReady();
    await flush();
    expect([...settled].sort()).toEqual(["catalog.get", "lease.request", "list.get"]);
  });
});
