import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayRelay,
  type GatewayWorkerClient,
  type TwoWayRelay,
  type WorkerDirectory,
} from "../gateway/index.js";
import { linkPair, TYPE } from "../link/testing.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import type { RelayTarget, TwoWayRelayTarget } from "./relay.js";
import type { DaemonServer } from "./server.js";
import {
  aborted,
  cleanUp,
  patternBytes,
  readParts,
  settleWithin,
  sleep,
  startWorker,
  type WorkerFixture,
} from "./test-relay-support.js";
import { WORKER_ID, buildCall, spyOn } from "./test-relay-gateway.js";

const poll = <T>(read: () => T | Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

describe("a gateway relaying to a worker", { timeout: 15_000 }, () => {
  const daemons: DaemonServer[] = [];

  const directories: string[] = [];

  let behavior: RelayTarget = () => Promise.resolve(new Response("ok"));

  const targetCalls: {
    url: string;
    method: string;
    headers: Headers;
    tenant: string;
    leaseId: string | undefined;
  }[] = [];

  let twoWayBehavior: TwoWayRelayTarget = () =>
    Promise.resolve(new Response(null, { status: 200 }));

  const twoWayTarget: TwoWayRelayTarget = (request, tenant, leaseId, pipe) =>
    twoWayBehavior(request, tenant, leaseId, pipe);

  const target: RelayTarget = (request, tenant, leaseId) => {
    targetCalls.push({
      headers: request.headers,
      leaseId,
      method: request.method,
      tenant,
      url: request.url,
    });
    return behavior(request, tenant, leaseId);
  };

  afterEach(async () => {
    behavior = () => Promise.resolve(new Response("ok"));
    twoWayBehavior = () => Promise.resolve(new Response(null, { status: 200 }));
    targetCalls.length = 0;
    await cleanUp(daemons, directories);
  });

  async function startPair(
    options: { readonly deadlineMs?: number; readonly idleMs?: number } = {},
  ) {
    const fixture: WorkerFixture = await startWorker(
      directories,
      daemons,
      { "agent-device": target, echo: target },
      { relayTwoWayTargets: { echo: twoWayTarget } },
    );
    const pair = linkPair();
    const gatewayEnd = pair.gatewayEnd;
    fixture.worker.acceptUplink(pair.worker);
    const connected = (await connectSimlockClient(
      { connection: pair.gateway, principal: "gw:test" },
      true,
    )) as GatewayWorkerClient;
    const { client, spy } = spyOn(connected);
    const directory: WorkerDirectory = {
      target: (workerId) =>
        workerId === WORKER_ID
          ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
          : undefined,
    };
    const makeRelay = (
      relayOptions: { readonly deadlineMs?: number; readonly idleMs?: number } = {},
    ) =>
      new GatewayRelay({
        directory,
        ...(relayOptions.deadlineMs === undefined ? {} : { deadlineMs: relayOptions.deadlineMs }),
        ...(relayOptions.idleMs === undefined ? {} : { idleMs: relayOptions.idleMs }),
      });
    const relay = makeRelay(options);
    const opened = () => pair.gatewayTap.binaries(TYPE.OPEN).length;
    return { fixture, gatewayEnd, makeRelay, opened, pair, relay, spy };
  }

  it("aborting the caller's request signal before the head comes fails the call; after it, it errors the caller's body stream; either way the target's request signal aborts and relay.request answers { cancelled: true } with no push after the cancel", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const before = await startPair();
    const controller = new AbortController();
    const pendingBefore = before.relay.relay(WORKER_ID, buildCall({ signal: controller.signal }));
    const settledBefore = settleWithin(pendingBefore);
    await poll(() => signal !== undefined).toBe(true);
    controller.abort(new Error("caller left before the head"));
    const failure = await settledBefore;
    await poll(() => signal?.aborted).toBe(true);
    await poll(() =>
      before.spy.events.filter((event) => event.startsWith("request-answered")),
    ).toEqual(['request-answered:{"cancelled":true}']);

    signal = undefined;
    behavior = (request) => {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(streamController) {
              await sleep(10);
              streamController.enqueue(patternBytes(512, 1));
            },
          }),
        ),
      );
    };
    const after = await startPair();
    const secondController = new AbortController();
    const response = await after.relay.relay(
      WORKER_ID,
      buildCall({ signal: secondController.signal }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    secondController.abort(new Error("caller left after the head"));
    const bodyFailure = await settleWithin(
      (async () => {
        for (;;) {
          const step = await reader?.read();
          if (step === undefined || step.done) return;
        }
      })(),
    );
    await poll(() => signal?.aborted).toBe(true);
    await poll(() =>
      after.spy.events.filter((event) => event.startsWith("request-answered")),
    ).toEqual(['request-answered:{"cancelled":true}']);
    await sleep(150);
    const eventsAfterCancel = after.spy.events.slice(
      after.spy.events.indexOf("cancel-answered") + 1,
    );

    expect(failure).toMatchObject({ message: "caller left before the head", state: "rejected" });
    expect(bodyFailure).toMatchObject({ message: "caller left after the head", state: "rejected" });
    expect(after.spy.events).toContain("cancel-answered");
    expect(eventsAfterCancel.filter((event) => event.startsWith("push:"))).toEqual([]);
  }, 30_000);

  it("a caller's request body that errors mid-upload aborts the target's request signal", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await readParts(request.body).catch(() => undefined);
      await aborted(request.signal);
      return new Response("late");
    };
    const { relay } = await startPair();
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(patternBytes(1024, 8));
        else controller.error(new Error("upload broke"));
      },
    });

    const outcome = await settleWithin(relay.relay(WORKER_ID, buildCall({ body, method: "PUT" })));

    expect(outcome).toMatchObject({ message: "upload broke", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("a target that never answers is cancelled after a 200 ms deadline, and the caller gets WORKER_UNREACHABLE with message `worker <id> did not finish the relayed request within 200 ms`; one that stalls after its head, under a 10 s deadline and a 200 ms idle bound, gets its body stream errored with WORKER_UNREACHABLE `worker <id> sent nothing on the relayed response for 200 ms`", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const never = await startPair({ deadlineMs: 200 });
    const noHead = await settleWithin(never.relay.relay(WORKER_ID, buildCall({})));
    await poll(() => signal?.aborted).toBe(true);

    behavior = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        ),
      );
    const stalling = await startPair({ deadlineMs: 10_000, idleMs: 200 });
    const response = await stalling.relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    await reader?.read();
    const stalled = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")));

    const message = `worker ${WORKER_ID} did not finish the relayed request within 200 ms`;
    expect(noHead).toMatchObject({ code: "WORKER_UNREACHABLE", message, state: "rejected" });
    expect(stalled).toMatchObject({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} sent nothing on the relayed response for 200 ms`,
      state: "rejected",
    });
  }, 30_000);

  it("closing the uplink mid-relay fails the caller with WORKER_UNREACHABLE, or errors its body stream after the head, and aborts the target's request signal", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const before = await startPair();
    const noHead = settleWithin(before.relay.relay(WORKER_ID, buildCall({})));
    await poll(() => signal !== undefined).toBe(true);
    await before.pair.gatewayEnd.close();
    const noHeadOutcome = await noHead;
    await poll(() => signal?.aborted).toBe(true);

    signal = undefined;
    behavior = (request) => {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        ),
      );
    };
    const after = await startPair();
    const response = await after.relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    await reader?.read();
    await after.pair.gatewayEnd.close();
    const bodyOutcome = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")));

    expect(noHeadOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(bodyOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("closing the uplink ends every two-way relay: the gateway side gets WORKER_UNREACHABLE and the target's signal aborts", async () => {
    const signals: AbortSignal[] = [];
    twoWayBehavior = (_request, _tenant, _leaseId, pipe) => {
      signals.push(pipe.signal);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const { gatewayEnd, relay } = await startPair();
    const open = async () => {
      const opened = (await relay.relayTwoWay(WORKER_ID, buildCall({}))) as TwoWayRelay;
      return { reader: opened.readable.getReader(), writer: opened.writable.getWriter() };
    };
    const first = await open();
    const second = await open();
    await poll(() => signals.map((signal) => signal.aborted)).toEqual([false, false]);

    await gatewayEnd.close();
    const outcomes = await Promise.all([
      settleWithin(first.reader.read()),
      settleWithin(first.writer.write(new Uint8Array(1))),
      settleWithin(second.reader.read()),
      settleWithin(second.writer.write(new Uint8Array(1))),
    ]);

    for (const settled of outcomes) {
      expect(settled).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    }
    await poll(() => signals.map((signal) => signal.aborted)).toEqual([true, true]);
  }, 30_000);
});
