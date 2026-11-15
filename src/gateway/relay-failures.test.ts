import { describe, expect, it, vi } from "vitest";
import type { LinkChannelErrorReason } from "../link/index.js";
import {
  WORKER_ID,
  KIB,
  sleep,
  FakeChannel,
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
