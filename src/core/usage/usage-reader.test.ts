import { describe, expect, it } from "vitest";

import type { EventEnvelope, EventName } from "../../bus/index.js";
import { tokenLabelMap, UsageReader, type UsageHistory } from "./usage-reader.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 10 * HOUR;

function requested(
  timestamp: number,
  requester: string,
  requestId = `req_${timestamp}`,
): EventEnvelope {
  return {
    event: "lease.requested",
    id: `evt_${requestId}`,
    module: "test",
    payload: { requestId, requestSpec: { platform: "ios" }, requester, waitPolicy: "wait" },
    seq: timestamp,
    timestamp,
  } as unknown as EventEnvelope;
}

/** A history that records what it was asked for and answers what the test sets. */
function history(events: readonly EventEnvelope[] = [], oldestTs: number | undefined = undefined) {
  const state = {
    asked: [] as { sinceTs: number; carry: readonly EventName[] }[],
    events,
    newest: "evt_1" as string | undefined,
    oldestTs,
  };
  const source: UsageHistory = {
    latestId: () => state.newest,
    read: async (input) => {
      state.asked.push(input);
      return { events: state.events, oldestTs: state.oldestTs, requestedBefore: new Set<string>() };
    },
  };
  return { source, state };
}

function reader(
  source: UsageHistory,
  extra: Partial<ConstructorParameters<typeof UsageReader>[0]> = {},
) {
  const calls = { labels: 0 };
  const usage = new UsageReader({
    history: source,
    tokenLabels: async () => {
      calls.labels += 1;
      return tokenLabelMap([{ id: "tok_a", label: "ci-bot" }, { id: "tok_plain" }]);
    },
    workers: () => [{ id: "self" }],
    ...extra,
  });
  return { calls, usage };
}

const answer = (result: Awaited<ReturnType<UsageReader["get"]>>) => {
  if (!("usage" in result)) throw new Error("expected an answer");
  return result.usage;
};

describe("UsageReader", () => {
  it("rounds the window down to the bucket on both sides, so it never ends in the future, and reads the history from its start, with the two step events carried", async () => {
    const { source, state } = history();
    const { usage } = reader(source);

    const result = answer(await usage.get({ from: T0 + 10_000, to: T0 + HOUR + 10_000 }));

    expect(result.window).toEqual({ from: T0, to: T0 + HOUR });
    expect(result.bucketMs).toBe(MINUTE);
    expect(state.asked).toEqual([{ carry: ["capacity.changed", "queue.changed"], sinceTs: T0 }]);
  });

  it("leaves a window that is already on bucket edges as it is", async () => {
    const { source } = history();
    const { usage } = reader(source);

    const result = answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(result.window).toEqual({ from: T0, to: T0 + HOUR });
  });

  it("refuses a window that ends before the oldest held event, with that time, and answers one that ends exactly at it", async () => {
    const { source } = history([], T0 + HOUR + 1);
    const { usage } = reader(source);
    const edge = reader(history([], T0 + HOUR).source).usage;

    await expect(usage.get({ from: T0, to: T0 + HOUR })).resolves.toEqual({
      oldestTs: T0 + HOUR + 1,
    });
    answer(await edge.get({ from: T0, to: T0 + HOUR }));
  });

  it("answers an empty history for any window, as covering all of it", async () => {
    const { usage } = reader(history().source);

    const result = answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(result).toMatchObject({ coversFrom: T0, partial: false });
  });

  it("says the figures are partial when the history it read starts inside the window", async () => {
    const { usage } = reader(history([requested(T0 + 5 * MINUTE, "a")], T0 + 5 * MINUTE).source);

    const result = answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(result).toMatchObject({ coversFrom: T0 + 5 * MINUTE, partial: true });
    expect(result.totals.requests).toBe(1);
  });

  it("keeps its answer while the window and the newest event are the same, and reads again when either changes", async () => {
    const { source, state } = history();
    const { usage } = reader(source);
    const ask = (shift: number) => usage.get({ from: T0 + shift, to: T0 + HOUR + shift });

    const first = await ask(1_000);
    const again = await ask(2_000);
    expect(state.asked).toHaveLength(1);
    expect(answer(again)).toBe(answer(first));

    state.newest = undefined;
    await ask(1_000);
    expect(state.asked).toHaveLength(2);
    state.newest = "evt_9";
    await ask(1_000);
    expect(state.asked).toHaveLength(3);
    await ask(1_000 + MINUTE);
    expect(state.asked).toHaveLength(4);
    // Each end of the window is part of the key.
    await usage.get({ from: T0 + 1_000 + MINUTE, to: T0 + HOUR + 1_000 + 2 * MINUTE });
    expect(state.asked).toHaveLength(5);
  });

  it("does not keep a refusal: a history that has grown to cover the window answers it", async () => {
    const { source, state } = history([], T0 + 2 * HOUR);
    const { usage } = reader(source);

    await expect(usage.get({ from: T0, to: T0 + HOUR })).resolves.toEqual({
      oldestTs: T0 + 2 * HOUR,
    });
    state.oldestTs = T0 - HOUR;
    answer(await usage.get({ from: T0, to: T0 + HOUR }));
    expect(state.asked).toHaveLength(2);
  });

  it("puts the token label beside each requester the token store knows, and no label beside one it does not", async () => {
    const { source } = history([
      requested(T0 + 1_000, "tok_a"),
      requested(T0 + 2_000, "tok_plain"),
      requested(T0 + 3_000, "stranger"),
    ]);
    const { usage } = reader(source);

    const result = answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(Object.fromEntries(result.requesters.map((entry) => [entry.id, entry.label]))).toEqual({
      stranger: undefined,
      tok_a: "ci-bot",
      tok_plain: undefined,
    });
  });

  it("reads no labels when the events name no requester", async () => {
    const { source } = history([
      {
        event: "daemon.stopping",
        id: "evt_x",
        module: "d",
        payload: { reason: "x" },
        seq: 1,
        timestamp: T0 + 1,
      } as EventEnvelope,
    ]);
    const { calls, usage } = reader(source);

    answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(calls.labels).toBe(0);
  });

  it("strips its own prefix before the label lookup on a gateway, and leaves another prefix and a worker's own ids alone", async () => {
    const events = [
      requested(T0 + 1_000, "gw:g1:tok_a"),
      requested(T0 + 2_000, "gw:g2:tok_a"),
      requested(T0 + 3_000, "tok_a"),
    ];
    const gateway = reader(history(events).source, { fleet: { requesterPrefix: "gw:g1:" } });
    const worker = reader(history(events).source);

    const onGateway = answer(await gateway.usage.get({ from: T0, to: T0 + HOUR }));
    const onWorker = answer(await worker.usage.get({ from: T0, to: T0 + HOUR }));

    const labels = (usage: typeof onGateway) =>
      Object.fromEntries(usage.requesters.map((entry) => [entry.id, entry.label]));
    expect(labels(onGateway)).toEqual({
      "gw:g1:tok_a": "ci-bot",
      "gw:g2:tok_a": undefined,
      tok_a: "ci-bot",
    });
    expect(labels(onWorker)).toEqual({
      "gw:g1:tok_a": undefined,
      "gw:g2:tok_a": undefined,
      tok_a: "ci-bot",
    });
  });

  it("counts as the fleet when it is given a prefix: a worker's relayed request is not a request", async () => {
    const relayed = {
      ...requested(T0 + 1_000, "gw:g1:tok_a"),
      payload: {
        requestId: "w_1",
        requestSpec: { platform: "ios" },
        requester: "gw:g1:tok_a",
        waitPolicy: "no-wait",
        workerId: "wrk_1",
      },
    } as unknown as EventEnvelope;
    const events = [requested(T0 + 500, "tok_a", "own_1"), relayed];
    const gateway = reader(history(events).source, { fleet: { requesterPrefix: "gw:g1:" } });
    const worker = reader(history(events).source);

    const onGateway = answer(await gateway.usage.get({ from: T0, to: T0 + HOUR }));
    const onWorker = answer(await worker.usage.get({ from: T0, to: T0 + HOUR }));

    expect(onGateway.totals.requests).toBe(1);
    expect(onWorker.totals.requests).toBe(2);
  });

  it("reports the workers it is given, with their labels, read afresh for each answer", async () => {
    const { source, state } = history();
    let workers = [{ id: "wrk_1", label: "mac" }];
    const { usage } = reader(source, { workers: () => workers });

    const first = answer(await usage.get({ from: T0, to: T0 + HOUR }));
    workers = [
      { id: "wrk_1", label: "mac" },
      { id: "wrk_2", label: "mini" },
    ];
    state.newest = "evt_2";
    const second = answer(await usage.get({ from: T0, to: T0 + HOUR }));

    expect(first.workers.map((worker) => [worker.id, worker.label])).toEqual([["wrk_1", "mac"]]);
    expect(second.workers.map((worker) => worker.id)).toEqual(["wrk_1", "wrk_2"]);
  });
});

describe("tokenLabelMap", () => {
  it("maps each labelled token's id to its label and leaves out one with none", () => {
    expect(tokenLabelMap([{ id: "a", label: "x" }, { id: "b" }, { id: "c", label: "z" }])).toEqual(
      new Map([
        ["a", "x"],
        ["c", "z"],
      ]),
    );
  });
});
