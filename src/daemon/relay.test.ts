import { describe, expect, it, vi } from "vitest";

import { LinkChannelError, type LinkChannel } from "../link/index.js";

import type { Logger } from "../ports/index.js";
import { linkPair } from "../link/testing.js";
import {
  RelayConnection,
  type RelayPush,
  type RelayTarget,
  type TwoWayPipe,
  type TwoWayRelayTarget,
} from "./relay.js";
import { gate, relayInput, settleWithin } from "./test-relay-support.js";

const logger: Logger = {
  child: () => logger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

type Input = Parameters<RelayConnection["request"]>[0];

async function acceptedChannel() {
  const pair = linkPair();
  const opened = await pair.gateway.openChannel({ signal: new AbortController().signal });
  return pair.worker.acceptChannel(opened.id);
}

describe("a worker's relay connection", () => {
  it("answers { cancelled: true } and never runs the target for a request that arrives after the connection closed", async () => {
    let ran = false;
    const target: RelayTarget = () => {
      ran = true;
      return Promise.resolve(new Response("late"));
    };
    const relays = new RelayConnection({ echo: target }, logger);
    const push: RelayPush = { head: () => Promise.resolve() };

    relays.abortAll();
    const outcome = await settleWithin(
      relays.request(relayInput() as Input, push, await acceptedChannel()),
    );

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(ran).toBe(false);
  });

  it("answers { cancelled: true } and cancels the target's body when relay.cancel lands while the head is being written", async () => {
    let bodyCancelled = false;
    const target: RelayTarget = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              bodyCancelled = true;
            },
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
      );
    const relays = new RelayConnection({ echo: target }, logger);
    const input = relayInput() as Input;
    const push: RelayPush = {
      head: () => {
        relays.cancel(input.relayId);
        return Promise.resolve();
      },
    };

    const outcome = await settleWithin(relays.request(input, push, await acceptedChannel()));

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(bodyCancelled).toBe(true);
  });

  it("runs the target once and fails the second of two same-id requests BAD_REQUEST while the first waits for credit", async () => {
    let runs = 0;
    const target: RelayTarget = () => {
      runs += 1;
      return Promise.resolve(new Response("ok"));
    };
    const relays = new RelayConnection({ echo: target }, logger);
    const push: RelayPush = { head: () => Promise.resolve() };
    const input = relayInput() as Input;
    const held = await acceptedChannel();
    const credit = gate();
    const first = relays.request(
      input,
      push,
      Object.assign(Object.create(held) as LinkChannel, { whenCredit: () => credit.promise }),
    );
    const second = await settleWithin(relays.request({ ...input }, push, await acceptedChannel()));
    credit.open();
    await settleWithin(first);

    expect(second).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    expect(runs).toBe(1);
  });

  it("aborts the target's request, aborts the channel and answers { cancelled: true } when the channel fails stalled", async () => {
    let signal: AbortSignal | undefined;
    const target: RelayTarget = (request) => {
      signal = request.signal;
      return request.arrayBuffer().then(() => new Response("never"));
    };
    const relays = new RelayConnection({ echo: target }, logger);
    const push: RelayPush = { head: () => Promise.resolve() };
    const held = await acceptedChannel();
    let aborts = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull: () => Promise.reject(new LinkChannelError("stalled")),
    });
    const channel = Object.assign(Object.create(held) as LinkChannel, {
      abort: () => {
        aborts += 1;
      },
      readable: failing,
      whenCredit: () => Promise.resolve(),
    });

    const outcome = await settleWithin(
      relays.request(relayInput({ hasBody: true, method: "PUT" }) as Input, push, channel),
    );

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(aborts).toBeGreaterThan(0);
  });

  it("answers a two-way request only once both directions have ended, and { cancelled: true } when it is cancelled before", async () => {
    const pair = linkPair();
    const pipes: TwoWayPipe[] = [];
    const target: TwoWayRelayTarget = (_request, _tenant, _leaseId, pipe) => {
      pipes.push(pipe);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const relays = new RelayConnection({}, logger, { echo: target });
    let heads = 0;
    const push: RelayPush = {
      head: () => {
        heads += 1;
        return Promise.resolve();
      },
    };
    const start = async (input: Input) => {
      const opened = await pair.gateway.openChannel({ signal: new AbortController().signal });
      return {
        gateway: opened,
        result: relays.request(input, push, pair.worker.acceptChannel(opened.id)),
      };
    };

    const both = await start(relayInput({ twoWay: true }) as Input);
    await vi.waitFor(() => expect(pipes).toHaveLength(1));
    const pipe = pipes[0] as TwoWayPipe;
    await both.gateway.writable.getWriter().close();
    const drained = pipe.readable.getReader();
    while (!(await drained.read()).done) {
      // why: the target reads the gateway's direction to its end.
    }
    const afterRead = await settleWithin(both.result, 50);
    await pipe.writable.getWriter().close();
    const afterWrite = await settleWithin(both.result);

    const writeFirst = await start(relayInput({ twoWay: true }) as Input);
    await vi.waitFor(() => expect(pipes).toHaveLength(2));
    const second = pipes[1] as TwoWayPipe;
    await second.writable.getWriter().close();
    const afterWriteFirst = await settleWithin(writeFirst.result, 50);
    await writeFirst.gateway.writable.getWriter().close();
    const drainedSecond = second.readable.getReader();
    while (!(await drainedSecond.read()).done) {
      // why: the target reads the gateway's direction to its end.
    }
    const afterReadLast = await settleWithin(writeFirst.result);

    const input = relayInput({ twoWay: true }) as Input;
    const cancelled = await start(input);
    await vi.waitFor(() => expect(heads).toBe(3));
    relays.cancel(input.relayId);
    const afterCancel = await settleWithin(cancelled.result);

    expect(afterRead).toEqual({ state: "pending" });
    expect(afterWrite).toEqual({ state: "fulfilled", value: {} });
    expect(afterWriteFirst).toEqual({ state: "pending" });
    expect(afterReadLast).toEqual({ state: "fulfilled", value: {} });
    expect(afterCancel).toEqual({ state: "fulfilled", value: { cancelled: true } });
  });

  it("aborts the channel, so the gateway's readable errors, when a two-way target aborts its writable", async () => {
    const pair = linkPair();
    const target: TwoWayRelayTarget = (_request, _tenant, _leaseId, pipe) => {
      void pipe.writable.abort(new Error("target broke")).catch(() => undefined);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const relays = new RelayConnection({}, logger, { echo: target });
    const push: RelayPush = { head: () => Promise.resolve() };
    const opened = await pair.gateway.openChannel({ signal: new AbortController().signal });
    void relays
      .request(relayInput({ twoWay: true }) as Input, push, pair.worker.acceptChannel(opened.id))
      .catch(() => undefined);

    const read = await settleWithin(opened.readable.getReader().read());

    expect(read.state).toBe("rejected");
  });
});
