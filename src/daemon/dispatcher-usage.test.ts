import { afterEach, describe, expect, it, vi } from "vitest";
import { HOUR, removeUsageRigs, requested, T0, usageRig } from "../history/testing.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

const threads = vi.hoisted(() => ({
  crashOnPost: false,
  posts: [] as unknown[],
  workers: [] as { terminate(): Promise<number> }[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      threads.workers.push(this);
    }

    override postMessage(...args: Parameters<InstanceType<typeof actual.Worker>["postMessage"]>) {
      threads.posts.push(args[0]);
      super.postMessage(...args);
      if (threads.crashOnPost) void this.terminate();
    }
  }
  return { ...actual, Worker: CountingWorker };
});

describe("Dispatcher: usage.get", () => {
  afterEach(removeUsageRigs);

  const admin = session({ role: "admin" });

  async function historyWithRows(options: { readonly gatewayLabel?: string } = {}) {
    const rig = await usageRig();
    rig.emit("lease.requested", requested("R1"));
    const gate = { open: true };
    const eventHistory = {
      replay: (input?: { readonly sinceTs?: number }) => rig.history.replay(input),
      replayPage: (input: { readonly beforeId?: string; readonly limit: number }) =>
        rig.history.replayPage(input),
      status: () => ({ ...rig.history.status(), opened: gate.open && rig.history.status().opened }),
    };
    return { eventHistory, gate, rig, ...options };
  }

  it("the worker handler answers HISTORY_NOT_KEPT with oldestTs and the message naming when the figures start when to is 1 ms before the oldest row, and figures when to is that row's time", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });

    await expect(
      dispatcher.dispatch("usage.get", { from: T0 - 2 * HOUR, to: T0 - 1 }, admin),
    ).rejects.toMatchObject({
      code: "HISTORY_NOT_KEPT",
      details: { oldestTs: T0 },
      message: `The history does not reach back to the end of that window; its figures start at ${new Date(T0).toISOString()}.`,
    });
    await expect(
      dispatcher.dispatch("usage.get", { from: T0 - 2 * HOUR, to: T0 }, admin),
    ).resolves.toMatchObject({ window: { to: T0 } });
  });

  it("the worker handler answers HISTORY_UNAVAILABLE with the message naming daemon.log while history.status().opened is false, after answering figures while it was true", async () => {
    const { eventHistory, gate, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    gate.open = false;
    const before = threads.posts.length;

    await expect(dispatcher.dispatch("usage.get", window, admin)).rejects.toMatchObject({
      code: "HISTORY_UNAVAILABLE",
      message: "The history could not be opened, so no figures can be read; see daemon.log.",
    });
    expect(threads.posts).toHaveLength(before);
  });

  it("the worker handler passes includeLedger to the reader: it lists the window's requests when true, leaves requests out when absent or false, and refuses a non-boolean as BAD_REQUEST", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    const listed = await dispatcher.dispatch(
      "usage.get",
      { ...window, includeLedger: true },
      admin,
    );
    const absent = await dispatcher.dispatch("usage.get", window, admin);
    const off = await dispatcher.dispatch("usage.get", { ...window, includeLedger: false }, admin);

    expect(listed.requests?.map((entry) => entry.requestId)).toEqual(["R1"]);
    expect(absent).not.toHaveProperty("requests");
    expect(off).not.toHaveProperty("requests");
    await expect(
      dispatcher.dispatch("usage.get", { ...window, includeLedger: "yes" } as never, admin),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the worker handler answers one worker entry, itself, with its instance id and gateway.label, or no label when none is set", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const labelled = await buildDispatcher({
      eventHistory,
      gatewayLabel: "lab-a",
      historyPath: rig.historyPath,
    });
    const plain = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };

    const named = await labelled.dispatcher.dispatch("usage.get", window, admin);
    const anonymous = await plain.dispatcher.dispatch("usage.get", window, admin);

    expect(named.workers).toMatchObject([{ id: "instance-1", label: "lab-a", requests: 1 }]);
    expect(anonymous.workers).toHaveLength(1);
    expect(anonymous.workers[0]).toMatchObject({ id: "instance-1", requests: 1 });
    expect(anonymous.workers[0]).not.toHaveProperty("label");
  });

  it("the worker handler labels a requester from the token store, and leaves the label out when the daemon has no token store", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const withStore = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const withoutStore = await buildDispatcher({
      eventHistory,
      historyPath: rig.historyPath,
      withoutTokens: true,
    });
    const { record } = await withStore.tokens.create("agent", "ci-bot");
    rig.emit("lease.requested", requested("R2", { requester: record.id }));
    const window = { from: T0, to: T0 + HOUR };

    const labelled = await withStore.dispatcher.dispatch("usage.get", window, admin);
    const unlabelled = await withoutStore.dispatcher.dispatch("usage.get", window, admin);

    expect(labelled.requesters).toEqual([
      { granted: 0, heldTotalMs: 0, id: "alice", rejected: 0, requests: 1 },
      { granted: 0, heldTotalMs: 0, id: record.id, label: "ci-bot", rejected: 0, requests: 1 },
    ]);
    expect(unlabelled.requesters.map((entry) => entry.id)).toEqual(["alice", record.id]);
    expect(unlabelled.requesters.every((entry) => !("label" in entry))).toBe(true);
  });

  it("usage.get runs two calls for one window as one read on the read thread and gives both its answer, and two windows as two reads", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const call = (from: number, to = from + HOUR) =>
      dispatcher.dispatch("usage.get", { from, to }, admin);
    const readsOf = async (run: () => Promise<unknown>) => {
      const before = threads.posts.length;
      await run();
      return threads.posts.length - before;
    };
    await call(T0);
    const single = await readsOf(() => call(T0));

    const [first, second] = await Promise.all([call(T0), call(T0)]);
    const sameWindow = await readsOf(() => Promise.all([call(T0), call(T0)]));
    const twoWindows = await readsOf(() => Promise.all([call(T0), call(T0 - HOUR)]));
    const otherStart = await readsOf(() => Promise.all([call(T0), call(T0 - HOUR, T0 + HOUR)]));
    const otherEnd = await readsOf(() => Promise.all([call(T0), call(T0, T0 + 2 * HOUR)]));

    expect(single).toBeGreaterThan(0);
    expect(sameWindow).toBe(single);
    expect(twoWindows).toBe(2 * single);
    expect(otherStart).toBe(2 * single);
    expect(otherEnd).toBe(2 * single);
    expect(first).toEqual(second);
    expect(first.totals.requests).toBe(1);
  });

  it("dispose ends the read thread", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    await dispatcher.dispatch("usage.get", { from: T0, to: T0 + HOUR }, admin);
    const thread = threads.workers.at(-1) as unknown as import("node:worker_threads").Worker;
    let exited = false;
    thread.on("exit", () => {
      exited = true;
    });

    dispatcher.dispose();

    await vi.waitFor(() => expect(exited).toBe(true));
  });

  it("usage.get answers INTERNAL to a call in flight when the read thread exits, and answers the next call from a new thread", async () => {
    const { eventHistory, rig } = await historyWithRows();
    const { dispatcher } = await buildDispatcher({ eventHistory, historyPath: rig.historyPath });
    const window = { from: T0, to: T0 + HOUR };
    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    const started = threads.workers.length;
    threads.crashOnPost = true;

    try {
      await expect(dispatcher.dispatch("usage.get", window, admin)).rejects.toMatchObject({
        code: "INTERNAL",
      });
    } finally {
      threads.crashOnPost = false;
    }

    await expect(dispatcher.dispatch("usage.get", window, admin)).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    expect(threads.workers.length).toBe(started + 1);
  });
});
