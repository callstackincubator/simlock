import { describe, expect, it, vi } from "vitest";

import { LinkChannelError } from "../link/index.js";
import type { LinkChannel, LinkChannelErrorReason, LinkConnection } from "../link/index.js";
import { FakeClock, type Clock } from "../ports/index.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import { completeHello, ScriptedConnection } from "../simlock-client/test-support.js";
import type { SentFrame } from "../simlock-client/test-support.js";
import type { WorkerDirectory } from "./fleet-ports.js";
import { GatewayRelay, type TwoWayRelay } from "./index.js";
import type { GatewayWorkerClient } from "./worker-client.js";

const WORKER_ID = "wrk_a";
const KIB = 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeChannel implements LinkChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly written: Uint8Array[] = [];
  readonly credit = 0;
  writableClosed = false;
  aborted = false;
  abortReason: string | undefined;
  #readController!: ReadableStreamDefaultController<Uint8Array>;
  #writeController!: WritableStreamDefaultController;

  constructor(readonly id: string) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#readController = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      close: () => {
        this.writableClosed = true;
      },
      start: (controller) => {
        this.#writeController = controller;
      },
      write: (chunk) => {
        this.written.push(chunk);
      },
    });
  }

  whenCredit(): Promise<void> {
    return Promise.resolve();
  }

  abort(reason?: string): void {
    this.aborted = true;
    this.abortReason = reason;
    try {
      this.#readController.error(new LinkChannelError("aborted"));
    } catch {
      // why: the readable had already ended or failed.
    }
  }

  feed(bytes: Uint8Array): void {
    this.#readController.enqueue(bytes);
  }

  end(): void {
    this.#readController.close();
  }

  fail(reason: LinkChannelErrorReason): void {
    try {
      this.#readController.error(new LinkChannelError(reason));
    } catch {
      // why: already ended.
    }
    try {
      this.#writeController.error(new LinkChannelError(reason));
    } catch {
      // why: already closed.
    }
  }

  // why: the real channel errors its writable at once on a peer's STOP (src/link/channel.ts onStop → #failOutgoing).
  stopWriting(): void {
    this.#writeController.error(new LinkChannelError("stopped"));
  }

  failWritable(reason: LinkChannelErrorReason): void {
    this.#writeController.error(new LinkChannelError(reason));
  }
}

class FakeLink extends ScriptedConnection implements LinkConnection {
  readonly channels: FakeChannel[] = [];
  holdOpen = false;

  openChannel(options: { readonly signal: AbortSignal }): Promise<LinkChannel> {
    if (this.holdOpen) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(options.signal.reason as Error);
        if (options.signal.aborted) fail();
        else options.signal.addEventListener("abort", fail, { once: true });
      });
    }
    const channel = new FakeChannel(`chan-${String(this.channels.length + 1)}`);
    this.channels.push(channel);
    return Promise.resolve(channel);
  }

  acceptChannel(id: string): LinkChannel {
    throw new Error(`the gateway accepts no channel: ${id}`);
  }
}

async function setup(
  options: {
    readonly deadlineMs?: number;
    readonly holdOpen?: boolean;
    readonly idleMs?: number;
    readonly clock?: Clock;
  } = {},
) {
  const connection = new FakeLink();
  connection.holdOpen = options.holdOpen ?? false;
  const connecting = connectSimlockClient({ connection, credential: "secret" }, true);
  await vi.waitFor(() => expect(connection.lastSentOf("hello")).toBeDefined());
  completeHello(connection, { role: "admin" });
  const client = (await connecting) as GatewayWorkerClient;
  const directory: WorkerDirectory = {
    target: (workerId) =>
      workerId === WORKER_ID
        ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
        : undefined,
  };
  return {
    connection,
    relay: new GatewayRelay({
      directory,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
  };
}

function call(
  body?: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): { request: Request; target: string; tenant: string } {
  return {
    request: new Request("http://gateway.test:4321/agent-device/rpc", {
      method: body === undefined ? "GET" : "PUT",
      ...(body === undefined ? {} : { body, duplex: "half" }),
      ...(signal === undefined ? {} : { signal }),
    } as RequestInit),
    target: "echo",
    tenant: "gw:g1:alice",
  };
}

async function sentFrame(connection: ScriptedConnection, type: string): Promise<SentFrame> {
  await vi.waitFor(() => expect(connection.lastSentOf(type)).toBeDefined());
  return connection.lastSentOf(type) as SentFrame;
}

async function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ state: "fulfilled" as const, value }),
    (error: unknown) => ({
      code: (error as { code?: unknown } | null)?.code,
      message: error instanceof Error ? error.message : String(error),
      state: "rejected" as const,
    }),
  );
}

function relayIdOf(frame: SentFrame): unknown {
  return (frame.payload as { relayId?: unknown }).relayId;
}

async function readFailure(response: Response) {
  return outcome(response.body?.getReader().read() ?? Promise.reject(new Error("no body")));
}

async function readAll(response: Response) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  let bytes = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) return { bytes, state: "ended" as const };
      bytes += step.value.length;
    }
  } catch (error: unknown) {
    return {
      bytes,
      code: (error as { code?: unknown } | null)?.code,
      message: error instanceof Error ? error.message : String(error),
      state: "failed" as const,
    };
  }
}

async function openedChannel(connection: FakeLink): Promise<FakeChannel> {
  await vi.waitFor(() => expect(connection.channels).toHaveLength(1));
  return connection.channels[0] as FakeChannel;
}

async function openTwoWay(signal?: AbortSignal) {
  const clock = new FakeClock();
  const { connection, relay } = await setup({ clock });
  const pending = relay.relayTwoWay(WORKER_ID, call(undefined, signal));
  const request = await sentFrame(connection, "relay.request");
  const channel = await openedChannel(connection);
  connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
  const opened = (await pending) as TwoWayRelay;
  return {
    channel,
    clock,
    connection,
    reader: opened.readable.getReader(),
    writer: opened.writable.getWriter(),
  };
}

describe("GatewayRelay on a byte channel", () => {
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

describe("GatewayRelay bounding the head and the body", () => {
  it.each([
    { bound: "the deadline", deadlineMs: 100, idleMs: 10_000 },
    { bound: "the idle bound", deadlineMs: 10_000, idleMs: 100 },
  ])(
    "keeps relaying a body whose bytes keep coming past $bound, and ends it at the channel's end",
    async ({ deadlineMs, idleMs }) => {
      const { connection, relay } = await setup({ deadlineMs, idleMs });
      const pending = relay.relay(WORKER_ID, call());
      const request = await sentFrame(connection, "relay.request");
      const channel = await openedChannel(connection);
      connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
      const response = await pending;
      connection.reply(request.id, {});

      const reading = readAll(response);
      for (let piece = 0; piece < 12 && !channel.aborted; piece += 1) {
        await sleep(30);
        if (!channel.aborted) channel.feed(new Uint8Array(KIB));
      }
      if (!channel.aborted) channel.end();

      expect(await reading).toEqual({ bytes: 12 * KIB, state: "ended" });
    },
  );

  it("ends a body that sends nothing for the idle bound with WORKER_UNREACHABLE, sends relay.cancel and aborts its channel", async () => {
    const { connection, relay } = await setup({ deadlineMs: 10_000, idleMs: 100 });
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;
    connection.reply(request.id, {});

    channel.feed(new Uint8Array(KIB));
    const result = await Promise.race([
      readAll(response),
      sleep(2_000).then(() => ({ state: "still open" as const })),
    ]);

    expect(result).toEqual({
      bytes: KIB,
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} sent nothing on the relayed response for 100 ms`,
      state: "failed",
    });
    const cancel = await sentFrame(connection, "relay.cancel");
    expect(relayIdOf(cancel)).toBe(relayIdOf(request));
    expect(channel.aborted).toBe(true);
  });

  it("fails a relay whose head never arrives at the deadline, not at the shorter idle bound", async () => {
    const { connection, relay } = await setup({ deadlineMs: 150, idleMs: 50 });
    const pending = outcome(relay.relay(WORKER_ID, call()));
    await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    const failure = await pending;

    expect(failure).toEqual({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not finish the relayed request within 150 ms`,
      state: "rejected",
    });
    expect(channel.aborted).toBe(true);
  });

  it("ends a two-way relay with WORKER_UNREACHABLE after 15 s with no byte from the worker, however much the gateway writes, and keeps it open while bytes come or the worker's direction is ended", async () => {
    const silent = await openTwoWay();
    await silent.writer.write(new Uint8Array(8));
    silent.clock.advance(10_000);
    await silent.writer.write(new Uint8Array(8));
    silent.clock.advance(4_999);
    const openAt14 = silent.channel.aborted;
    silent.clock.advance(1);
    const abortedAt15 = silent.channel.aborted;
    const silentRead = outcome(silent.reader.read());
    const writeFailure = outcome(silent.writer.write(new Uint8Array(1)));

    const chatty = await openTwoWay();
    const steps: number[] = [];
    for (let at = 0; at < 12; at += 1) {
      chatty.clock.advance(5_000);
      chatty.channel.feed(new Uint8Array(1));
      steps.push((await chatty.reader.read()).value?.length ?? 0);
    }
    const chattyAborted = chatty.channel.aborted;

    const ended = await openTwoWay();
    ended.channel.end();
    const endStep = await ended.reader.read();
    ended.clock.advance(60_000);
    await ended.writer.write(new Uint8Array(3));

    const slowReader = await openTwoWay();
    slowReader.channel.feed(new Uint8Array(70 * KIB));
    await vi.waitFor(() => expect(slowReader.clock.pendingTimerCount).toBe(0));
    slowReader.clock.advance(60_000);
    const slowAborted = slowReader.channel.aborted;
    const slowStep = await slowReader.reader.read();
    slowReader.clock.advance(15_000);
    const slowFailure = await outcome(slowReader.reader.read());

    const message = `worker ${WORKER_ID} sent nothing on the relayed response for 15000 ms`;
    expect(openAt14).toBe(false);
    expect(abortedAt15).toBe(true);
    expect(await silentRead).toMatchObject({
      code: "WORKER_UNREACHABLE",
      message,
      state: "rejected",
    });
    expect(await writeFailure).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(silent.channel.aborted).toBe(true);
    expect(silent.connection.lastSentOf("relay.cancel")).toBeDefined();
    expect(steps).toEqual(Array.from({ length: 12 }, () => 1));
    expect(chattyAborted).toBe(false);
    expect(endStep.done).toBe(true);
    expect(ended.channel.aborted).toBe(false);
    expect(ended.channel.written.map((chunk) => chunk.length)).toEqual([3]);
    expect(slowAborted).toBe(false);
    expect(slowStep.value?.length).toBe(70 * KIB);
    expect(slowFailure).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
  });
});

describe("GatewayRelay mapping a channel failure", () => {
  const before: readonly {
    readonly reason: LinkChannelErrorReason;
    readonly code: string;
    readonly message: string;
  }[] = [
    {
      code: "INTERNAL",
      message: `worker ${WORKER_ID} sent an invalid relay response`,
      reason: "invalid",
    },
    {
      code: "INTERNAL",
      message: `worker ${WORKER_ID} did not read the relayed request body for 60 s`,
      reason: "stalled",
    },
    {
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not take the relayed request within 30 s`,
      reason: "not-accepted",
    },
  ];

  it.each(before)(
    "fails $reason before the head with $code and the message the table names",
    async ({ code, message, reason }) => {
      const { connection, relay } = await setup();
      const pending = outcome(relay.relay(WORKER_ID, call()));
      await sentFrame(connection, "relay.request");
      const channel = await openedChannel(connection);

      channel.fail(reason);

      expect(await pending).toEqual({ code, message, state: "rejected" });
    },
  );

  it("fails closed before the head with WORKER_UNREACHABLE", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    channel.fail("closed");

    expect(await pending).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
  });

  it("lets the relay.request answer decide when the peer aborts before the head", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    channel.fail("aborted");
    connection.fail(request.id, "INTERNAL", "worker side exploded");

    expect(await pending).toEqual({
      code: "INTERNAL",
      message: "worker side exploded",
      state: "rejected",
    });
  });

  it("fails with the deadline error when the peer aborts before the head and no answer comes", async () => {
    const { connection, relay } = await setup({ deadlineMs: 150 });
    const pending = outcome(relay.relay(WORKER_ID, call()));
    await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);

    channel.fail("aborted");

    expect(await pending).toEqual({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not finish the relayed request within 150 ms`,
      state: "rejected",
    });
  });

  const after: readonly {
    readonly name: string;
    readonly run: (connection: FakeLink, channel: FakeChannel, id: number | string) => void;
    readonly expected: Record<string, unknown>;
  }[] = [
    {
      expected: {
        message: `worker ${WORKER_ID} sent an invalid relay response`,
        state: "rejected",
      },
      name: "invalid",
      run: (_connection, channel) => channel.fail("invalid"),
    },
    {
      expected: { code: "WORKER_UNREACHABLE", state: "rejected" },
      name: "closed",
      run: (_connection, channel) => channel.fail("closed"),
    },
    {
      expected: { message: expect.stringMatching(/fell behind for 60 s/), state: "rejected" },
      name: "stalled",
      run: (_connection, channel) => channel.fail("stalled"),
    },
    {
      expected: { message: "worker side exploded", state: "rejected" },
      name: "aborted by the peer, with a failed relay.request answer",
      run: (connection, channel, id) => {
        channel.fail("aborted");
        connection.fail(id, "INTERNAL", "worker side exploded");
      },
    },
    {
      expected: {
        message: `worker ${WORKER_ID} ended the relayed response early`,
        state: "rejected",
      },
      name: "aborted by the peer, with a relay.request that settles without an error",
      run: (connection, channel, id) => {
        channel.fail("aborted");
        connection.reply(id, {});
      },
    },
  ];

  it.each(after)("errors the caller's body for $name after the head", async ({ expected, run }) => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    const channel = await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;

    run(connection, channel, request.id);
    const read = await readFailure(response);

    expect(read).toMatchObject(expected);
  });
});

describe("GatewayRelay against a worker that breaks the protocol", () => {
  it("fails the relay with INTERNAL naming the worker, and sends relay.cancel, on a relay-head with status 101", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");

    connection.push("relay-head", { headers: [], requestId: request.id, status: 101 });

    expect(await pending).toEqual({
      code: "INTERNAL",
      message: `worker ${WORKER_ID} sent an invalid relay response`,
      state: "rejected",
    });
    const cancel = await sentFrame(connection, "relay.cancel");
    expect(relayIdOf(cancel)).toBe(relayIdOf(request));
  });

  it("errors the caller's body with INTERNAL naming the worker, and sends relay.cancel, on a second relay-head", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    await openedChannel(connection);
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;

    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const read = await readFailure(response);

    expect(read).toEqual({
      code: "INTERNAL",
      message: `worker ${WORKER_ID} sent an invalid relay response`,
      state: "rejected",
    });
    const cancel = await sentFrame(connection, "relay.cancel");
    expect(relayIdOf(cancel)).toBe(relayIdOf(request));
  });

  it("fails the relay with INTERNAL naming the worker, and sends relay.cancel, on a relay-head whose header value `Headers` refuses", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");

    connection.push("relay-head", {
      headers: [["x-note", "€"]],
      requestId: request.id,
      status: 200,
    });

    expect(await pending).toEqual({
      code: "INTERNAL",
      message: `worker ${WORKER_ID} sent an invalid relay response`,
      state: "rejected",
    });
    const cancel = await sentFrame(connection, "relay.cancel");
    expect(relayIdOf(cancel)).toBe(relayIdOf(request));
  });

  it.each([
    { answer: {}, name: "{} with no head" },
    { answer: { cancelled: true }, name: "{ cancelled: true } when no cancel was sent" },
  ])(
    "fails the relay with INTERNAL saying the worker ended it without a response when relay.request answers $name",
    async ({ answer }) => {
      const { connection, relay } = await setup();
      const pending = outcome(relay.relay(WORKER_ID, call()));
      const request = await sentFrame(connection, "relay.request");

      connection.reply(request.id, answer);

      expect(await pending).toEqual({
        code: "INTERNAL",
        message: `worker ${WORKER_ID} ended the relay without a response`,
        state: "rejected",
      });
    },
  );

  it("errors the caller's body stream with the worker's message on an INTERNAL after the head", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;

    connection.fail(request.id, "INTERNAL", "worker side exploded");

    const read = await readFailure(response);
    expect(read).toMatchObject({ message: "worker side exploded", state: "rejected" });
  });

  it("reads DAEMON_STOPPING from a worker as a lost uplink: WORKER_UNREACHABLE", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");

    connection.fail(request.id, "DAEMON_STOPPING", "The daemon is stopping");

    expect(await pending).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
  });

  it("drops every hop-by-hop and framing header of a worker's relay head, in any case, and keeps an ordinary header, on the response it hands the caller", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    await openedChannel(connection);

    connection.push("relay-head", {
      headers: [
        ["connection", "close"],
        ["Content-Length", "5"],
        ["keep-alive", "timeout=5"],
        ["proxy-authenticate", "Basic realm=worker"],
        ["proxy-authorization", "Basic worker-secret"],
        ["te", "trailers"],
        ["Te", "custom-checksum"],
        ["trailer", "X-Note"],
        ["TRANSFER-ENCODING", "chunked"],
        ["upgrade", "h2c"],
        ["x-kept", "yes"],
      ],
      requestId: request.id,
      status: 200,
    });
    const response = await pending;

    expect([...response.headers.entries()]).toEqual([["x-kept", "yes"]]);
  });
});
