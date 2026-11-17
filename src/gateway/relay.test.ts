import { describe, expect, it, vi } from "vitest";
import { LinkChannelError } from "../link/index.js";
import { FakeClock } from "../ports/index.js";
import {
  WORKER_ID,
  KIB,
  sleep,
  FakeLink,
  setup,
  call,
  sentFrame,
  outcome,
  relayIdOf,
  readFailure,
  openedChannel,
  openTwoWay,
} from "./test-relay.js";

describe("GatewayRelay on a byte channel", () => {
  it("with http.proxyAuth.header configured, relays neither that header nor cookie, keeps authorization and x-agent-device-token dropped, and passes other headers", async () => {
    const { connection, relay } = await setup({ proxyAuthHeader: "CF-Access-JWT-Assertion" });
    const request = new Request("http://gateway.test:4321/agent-device/rpc", {
      headers: {
        authorization: "Bearer slk_agent",
        "cf-access-jwt-assertion": "person.jwt.signed-by-proxy",
        cookie: "CF_Authorization=person.jwt.signed-by-proxy",
        "x-agent-device-token": "token",
        "x-note": "kept",
      },
    });
    void relay
      .relay(WORKER_ID, { request, target: "echo", tenant: "gw:g1:alice" })
      .catch(() => undefined);
    const frame = await sentFrame(connection, "relay.request");
    expect((frame.payload as { headers: [string, string][] }).headers).toEqual([
      ["x-note", "kept"],
    ]);
  });

  it("opens a channel, names it in relay.request, closes its writable at once for a GET, and sends no relay.body", async () => {
    const { connection, relay } = await setup();

    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    await vi.waitFor(() => expect(channel.writableClosed).toBe(true));
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    connection.reply(request.id, {});
    channel.end();
    await pending;

    expect((request.payload as { channel?: unknown }).channel).toBe(channel.id);
    expect(connection.sent.filter((frame) => frame.type === "relay.body")).toEqual([]);
  });

  it("writes the caller's request body into the channel's writable, byte for byte, and then closes it", async () => {
    const { connection, relay } = await setup();
    let piece = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        piece += 1;
        controller.enqueue(new Uint8Array(64 * KIB).fill(piece));
        if (piece === 4) controller.close();
      },
    });

    const pending = relay.relay(WORKER_ID, call(body));
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    await vi.waitFor(() => expect(channel.writableClosed).toBe(true));
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    connection.reply(request.id, {});
    channel.end();
    await pending;

    const written = Buffer.concat(channel.written);
    expect(written.length).toBe(4 * 64 * KIB);
    expect([written[0], written[64 * KIB], written[3 * 64 * KIB]]).toEqual([1, 2, 4]);
  });

  it("settles the call on a {} answer but ends the caller's body only at the channel's end", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;
    const reader = response.body?.getReader();

    connection.reply(request.id, {});
    channel.feed(new TextEncoder().encode("late bytes"));
    const first = await reader?.read();
    const beforeEnd = await Promise.race([
      reader?.read().then(() => "settled"),
      sleep(150).then(() => "still open"),
    ]);
    channel.end();
    const last = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toBe("late bytes");
    expect(beforeEnd).toBe("still open");
    expect(last?.done).toBe(true);
  });

  it("cancels the caller's request body, clears its deadline timer at the head and its idle timer when the channel ends", async () => {
    const deadlineMs = 123_456;
    const idleMs = 234_567;
    const handles: unknown[] = [];
    const idleHandles: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      const handle = realSetTimeout(handler, delay);
      if (delay === deadlineMs) handles.push(handle);
      if (delay === idleMs) idleHandles.push(handle);
      return handle;
    }) as unknown as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: () => new Promise<void>(() => undefined),
    });
    try {
      const { connection, relay } = await setup({ deadlineMs, idleMs });
      const pending = relay.relay(WORKER_ID, call(body));
      const request = await sentFrame(connection, "relay.request");
      const channel = await openedChannel(connection);
      connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
      const response = await pending;
      const deadlineClearedAtHead = clearSpy.mock.calls.some(([handle]) => handle === handles[0]);
      const idleClearedAtHead = clearSpy.mock.calls.some(
        ([handle]) => handle === idleHandles.at(-1),
      );
      const reader = response.body?.getReader();

      channel.end();
      const last = await reader?.read();

      expect(last?.done).toBe(true);
      await vi.waitFor(() => expect(cancelled).toBe(true));
      expect(handles).toHaveLength(1);
      expect(deadlineClearedAtHead).toBe(true);
      expect(idleHandles.length).toBeGreaterThan(0);
      expect(idleClearedAtHead).toBe(false);
      expect(clearSpy).toHaveBeenCalledWith(idleHandles.at(-1));
    } finally {
      setTimeoutSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("errors the caller's body saying the worker ended the response early when the channel is aborted by the peer after the {} answer", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;
    connection.reply(request.id, {});
    await sleep(20);

    channel.fail("aborted");
    const read = await readFailure(response);

    expect(read).toEqual({
      code: "INTERNAL",
      message: `worker ${WORKER_ID} ended the relayed response early`,
      state: "rejected",
    });
  });

  it("errors the caller's body with the idle message when the worker answers {} and never ends the channel", async () => {
    const { connection, relay } = await setup({ deadlineMs: 2_000, idleMs: 100 });
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;
    connection.reply(request.id, {});

    const read = await readFailure(response);

    expect(read).toMatchObject({
      message: `worker ${WORKER_ID} sent nothing on the relayed response for 100 ms`,
      state: "rejected",
    });
  });

  it.each([
    {
      name: "a worker failure before the head",
      run: (connection: FakeLink, id: number | string) =>
        connection.fail(id, "INTERNAL", "worker side exploded"),
    },
    { name: "no answer by the deadline", run: () => undefined },
  ])("aborts its channel when the exchange ends on $name", async ({ run }) => {
    const { connection, relay } = await setup({ deadlineMs: 150 });
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    run(connection, request.id);
    await pending;

    expect(channel.aborted).toBe(true);
  });

  it("aborts its channel, and sends relay.cancel, when the caller cancels the body stream", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;

    await response.body?.cancel(new Error("caller left"));

    const cancel = await sentFrame(connection, "relay.cancel");
    expect(relayIdOf(cancel)).toBe(relayIdOf(request));
    expect(channel.aborted).toBe(true);
  });

  it("aborts its channel when the caller's signal aborts before the head", async () => {
    const { connection, relay } = await setup();
    const controller = new AbortController();
    const pending = outcome(relay.relay(WORKER_ID, call(undefined, controller.signal)));
    await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    controller.abort(new Error("caller left before the head"));
    const failure = await pending;

    expect(failure).toMatchObject({ message: "caller left before the head", state: "rejected" });
    expect(channel.aborted).toBe(true);
  });

  it("stops reading the caller's body once the channel's writable errors stopped", async () => {
    const { connection, relay } = await setup();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        await sleep(5);
        controller.enqueue(new Uint8Array(16 * KIB));
        if (pulls >= 200) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = relay.relay(WORKER_ID, call(body));
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    await vi.waitFor(() => expect(channel.written.length).toBeGreaterThan(0));

    channel.failWritable("stopped");
    connection.push("relay-head", { headers: [], requestId: request.id, status: 401 });
    connection.reply(request.id, {});
    await pending;
    await sleep(100);
    const pullsAfter = pulls;
    await sleep(100);

    expect(cancelled).toBe(true);
    expect(pulls).toBe(pullsAfter);
    expect(pulls).toBeLessThan(200);
  });

  it("counts the wait for a channel against the deadline, sends no relay.request while it waits, and fails WORKER_UNREACHABLE with the deadline message", async () => {
    const { connection, relay } = await setup({ deadlineMs: 100, holdOpen: true });

    const failure = await outcome(relay.relay(WORKER_ID, call()));

    expect(failure).toEqual({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not finish the relayed request within 100 ms`,
      state: "rejected",
    });
    expect(connection.sent.filter((frame) => frame.type === "relay.request")).toEqual([]);
  });

  it("cuts a file upload only after 330 s with no byte from the caller, counts its head deadline from the body's end, and keeps the 330 s deadline for any other relay or for an upload the worker stopped reading", async () => {
    const BOUND = 330_000;
    const upload = { name: "fixture.tar", silenceMs: BOUND };
    async function start(options: { upload?: typeof upload; holdOpen?: boolean } = {}) {
      const clock = new FakeClock();
      const { connection, relay } = await setup({
        clock,
        deadlineMs: BOUND,
        ...(options.holdOpen === true ? { holdOpen: true } : {}),
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
        },
      });
      // why: a relay that cut the upload too early cancelled this body, and the assertions below must name that, not a closed controller.
      const feed = {
        close: () => {
          try {
            controller.close();
          } catch {
            // why: the relay already cancelled the body.
          }
        },
        enqueue: (chunk: Uint8Array) => {
          try {
            controller.enqueue(chunk);
          } catch {
            // why: the relay already cancelled the body.
          }
        },
      };
      let result: Awaited<ReturnType<typeof outcome<Response>>> | undefined;
      void outcome(
        relay.relay(WORKER_ID, {
          ...call(body),
          ...(options.upload === undefined ? {} : { upload: options.upload }),
        }),
      ).then((settled) => {
        result = settled;
      });
      const pass = async (ms: number) => {
        clock.advance(ms);
        await sleep(20);
        return result;
      };
      return {
        clock,
        connection,
        feed,
        pass,
        request: () => connection.lastSentOf("relay.request"),
      };
    }
    const stalled = {
      code: "UPLOAD_STALLED",
      message: "No bytes of fixture.tar arrived for 330 s",
      state: "rejected",
    };
    const unreachable = {
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not finish the relayed request within ${String(BOUND)} ms`,
      state: "rejected",
    };

    const flowing = await start({ upload });
    await sentFrame(flowing.connection, "relay.request");
    flowing.feed.enqueue(new Uint8Array(KIB));
    const flowingAt300 = await flowing.pass(300_000);
    flowing.feed.enqueue(new Uint8Array(KIB));
    const flowingAt600 = await flowing.pass(300_000);
    flowing.feed.close();
    await sleep(20);
    const beforeHeadDeadline = await flowing.pass(BOUND - 1);
    const atHeadDeadline = await flowing.pass(1);

    const silent = await start({ upload });
    await sentFrame(silent.connection, "relay.request");
    silent.feed.enqueue(new Uint8Array(KIB));
    await sleep(20);
    const beforeSilenceBound = await silent.pass(BOUND - 1);
    const atSilenceBound = await silent.pass(1);

    const opening = await start({ holdOpen: true, upload });
    const beforeOpenDeadline = await opening.pass(BOUND - 1);
    const atOpenDeadline = await opening.pass(1);

    const other = await start();
    await sentFrame(other.connection, "relay.request");
    other.feed.enqueue(new Uint8Array(KIB));
    await other.pass(300_000);
    other.feed.enqueue(new Uint8Array(KIB));
    const otherBeforeDeadline = await other.pass(BOUND - 300_000 - 1);
    const otherAtDeadline = await other.pass(1);

    const stopped = await start({ upload });
    await sentFrame(stopped.connection, "relay.request");
    const stoppedChannel = await openedChannel(stopped.connection);
    stopped.feed.enqueue(new Uint8Array(KIB));
    await vi.waitFor(() => expect(stoppedChannel.written.length).toBeGreaterThan(0));
    stoppedChannel.failWritable("stopped");
    stopped.feed.enqueue(new Uint8Array(KIB));
    await sleep(20);
    const stoppedBeforeDeadline = await stopped.pass(BOUND - 1);
    const stoppedAtDeadline = await stopped.pass(1);

    const refused = await start({ upload });
    const refusal = await sentFrame(refused.connection, "relay.request");
    await refused.pass(100_000);
    refused.connection.push("relay-head", { headers: [], requestId: refusal.id, status: 413 });
    await sleep(20);
    // why: the silence bound would fire at 330 s; the response body's own idle bound runs to 430 s.
    const afterRefusal = await refused.pass(BOUND - 100_000 + 1);

    expect([flowingAt300, flowingAt600, beforeHeadDeadline]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(atHeadDeadline).toEqual(unreachable);
    expect(beforeSilenceBound).toBeUndefined();
    expect(atSilenceBound).toEqual(stalled);
    expect(silent.connection.lastSentOf("relay.cancel")).toBeDefined();
    expect(beforeOpenDeadline).toBeUndefined();
    expect(atOpenDeadline).toEqual(unreachable);
    expect(otherBeforeDeadline).toBeUndefined();
    expect(otherAtDeadline).toEqual(unreachable);
    expect(stoppedBeforeDeadline).toBeUndefined();
    expect(stoppedAtDeadline).toEqual(unreachable);
    expect(afterRefusal).toMatchObject({ state: "fulfilled" });
    expect(refused.connection.lastSentOf("relay.cancel")).toBeUndefined();
  });

  it("fails at once with the abort reason, and sends no relay.request, when the caller aborts while it waits for a channel", async () => {
    const { connection, relay } = await setup({ holdOpen: true });
    const controller = new AbortController();
    const pending = outcome(relay.relay(WORKER_ID, call(undefined, controller.signal)));
    await sleep(50);

    controller.abort(new Error("caller left while waiting"));
    const failure = await pending;

    expect(failure).toMatchObject({ message: "caller left while waiting", state: "rejected" });
    expect(connection.sent.filter((frame) => frame.type === "relay.request")).toEqual([]);
  });
});

describe("GatewayRelay finishing a two-way relay", () => {
  it("sends relay.cancel for a caller abort while a direction is open and none once both directions have ended", async () => {
    const openController = new AbortController();
    const open = await openTwoWay(openController.signal);
    open.channel.end();
    await open.reader.read();
    openController.abort(new Error("caller left"));
    await vi.waitFor(() => expect(open.connection.lastSentOf("relay.cancel")).toBeDefined());

    const doneController = new AbortController();
    const done = await openTwoWay(doneController.signal);
    done.channel.end();
    await done.reader.read();
    await done.writer.close();
    doneController.abort(new Error("caller left late"));
    await sleep(10);

    expect(done.connection.lastSentOf("relay.cancel")).toBeUndefined();
  });
});

describe("GatewayRelay when the worker stops reading a two-way relay", () => {
  it.each([
    {
      how: "a write",
      end: (writer: WritableStreamDefaultWriter<Uint8Array>) => writer.write(new Uint8Array(1)),
      settles: "rejected",
    },
    {
      how: "a close",
      end: (writer: WritableStreamDefaultWriter<Uint8Array>) => writer.close(),
      settles: "fulfilled",
    },
  ])(
    "ends only the gateway's direction on $how after the stop: the worker's bytes still arrive and its end finishes the relay",
    async ({ end, settles }) => {
      const caller = new AbortController();
      const open = await openTwoWay(caller.signal);
      open.channel.stopWriting();

      const ended = await outcome(end(open.writer));
      open.channel.feed(new Uint8Array(2));
      const first = await open.reader.read();
      open.channel.end();
      const last = await open.reader.read();
      caller.abort(new Error("caller left late"));
      await sleep(10);

      expect(ended.state).toBe(settles);
      expect(first.value?.length).toBe(2);
      expect(last.done).toBe(true);
      expect(open.channel.aborted).toBe(false);
      expect(open.connection.lastSentOf("relay.cancel")).toBeUndefined();
    },
  );
});

describe("GatewayRelay when the worker resets a two-way relay's channel", () => {
  it.each([
    {
      how: "a write",
      end: (w: WritableStreamDefaultWriter<Uint8Array>) => w.write(new Uint8Array(1)),
    },
    { how: "a close", end: (w: WritableStreamDefaultWriter<Uint8Array>) => w.close() },
  ])(
    "rejects $how after the reset with the channel's own reason, not the stream's TypeError, and sends no relay.cancel",
    async ({ end }) => {
      const open = await openTwoWay(new AbortController().signal);
      open.channel.fail("aborted");

      const error = await end(open.writer).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      await sleep(10);

      expect(error).toBeInstanceOf(LinkChannelError);
      expect((error as LinkChannelError).reason).toBe("aborted");
      expect(open.connection.lastSentOf("relay.cancel")).toBeUndefined();
    },
  );
});
