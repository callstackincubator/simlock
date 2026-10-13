import { afterEach, describe, expect, it } from "vitest";

import type { DaemonServer } from "./server.js";
import type { RelayTarget } from "./relay.js";
import type { SimlockWire } from "../simlock-client/wire.js";
import {
  adminSession,
  aborted,
  base64Of,
  cleanUp,
  gate,
  KIB,
  MIB,
  openRelay,
  openUplink,
  patternBytes,
  patternDigest,
  digestOf,
  patternStream,
  relayInput,
  settle,
  sleep,
  startWorker,
  type WorkerFixture,
} from "./test-relay-support.js";

const poll = <T>(read: () => T | Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

describe("a worker's relay targets over its uplink", { timeout: 15_000 }, () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  let behavior: RelayTarget = () => Promise.resolve(new Response("ok"));
  let fixture: WorkerFixture;
  let wire: SimlockWire;

  async function start(): Promise<void> {
    const target: RelayTarget = (request, tenant, leaseId) => behavior(request, tenant, leaseId);
    fixture = await startWorker(directories, daemons, { "agent-device": target, echo: target });
    ({ wire } = await openUplink(fixture.worker));
  }

  afterEach(async () => {
    behavior = () => Promise.resolve(new Response("ok"));
    await cleanUp(daemons, directories);
  });

  function callAsAdmin(operation: string, input: unknown): Promise<unknown> {
    const dispatch = fixture.worker.dispatch.bind(fixture.worker) as unknown as (
      operation: string,
      input: unknown,
      session: typeof adminSession,
    ) => Promise<unknown>;
    return dispatch(operation, input, adminSession);
  }

  it("sends a 20 MiB response body in relay-chunk pushes of at most 256 KiB, byte for byte", async () => {
    behavior = () => Promise.resolve(new Response(patternStream(20 * MIB, 7)));
    await start();

    const relay = openRelay(wire, relayInput());
    const outcome = await settle(relay.result, 30_000);

    expect(outcome).toEqual({ state: "fulfilled", value: {} });
    expect(relay.heads).toHaveLength(1);
    const pieces = relay.bytes();
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThanOrEqual(256 * KIB);
    expect(pieces.length).toBeGreaterThanOrEqual(80);
    expect(digestOf(pieces)).toBe(patternDigest(20 * MIB, 7));
  }, 60_000);

  it("sends no relay-chunk for a 204, 205 or 304 answer or a HEAD answer", async () => {
    await start();
    const cases: {
      readonly status: number;
      readonly method: string;
      readonly body: string | null;
    }[] = [
      { body: null, method: "GET", status: 204 },
      { body: null, method: "GET", status: 205 },
      { body: null, method: "GET", status: 304 },
      { body: "not sent for a HEAD", method: "HEAD", status: 200 },
    ];
    const seen: { status: number | undefined; chunks: number; result: unknown }[] = [];

    for (const entry of cases) {
      behavior = () => Promise.resolve(new Response(entry.body, { status: entry.status }));
      const relay = openRelay(wire, relayInput({ method: entry.method }));
      const outcome = await settle(relay.result);
      seen.push({ chunks: relay.chunks.length, result: outcome, status: relay.heads[0]?.status });
    }

    expect(seen).toEqual(
      cases.map((entry) => ({
        chunks: 0,
        result: { state: "fulfilled", value: {} },
        status: entry.status,
      })),
    );
  });

  it("aborts the target's request on relay.cancel, answers relay.request { cancelled: true } and sends no push after the cancel", async () => {
    let signal: AbortSignal | undefined;
    behavior = (request) => {
      signal = request.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await sleep(10);
          controller.enqueue(patternBytes(1024, 3));
        },
      });
      return Promise.resolve(new Response(body));
    };
    await start();
    const relay = openRelay(wire, relayInput());
    await poll(() => relay.chunks.length).toBeGreaterThan(1);

    const cancelled = await settle(wire.call("relay.cancel", { relayId: relay.relayId }));
    const chunksAtCancel = relay.chunks.length;
    const result = await settle(relay.result);
    await sleep(150);

    expect(cancelled).toEqual({ state: "fulfilled", value: {} });
    expect(result).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(relay.chunks.length).toBe(chunksAtCancel);
  });

  it("answers relay.request { cancelled: true } to a cancel that comes before the target answers", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const relay = openRelay(wire, relayInput());
    await poll(() => signal !== undefined).toBe(true);

    await wire.call("relay.cancel", { relayId: relay.relayId });
    const result = await settle(relay.result);

    expect(result).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(relay.heads).toEqual([]);
  });

  it("aborts the target's request when the connection the relay came on closes", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const { wire: second, gatewayEnd } = await openUplink(fixture.worker);
    const relay = openRelay(second, relayInput());
    await poll(() => signal !== undefined).toBe(true);

    await gatewayEnd.close();

    await poll(() => signal?.aborted).toBe(true);
    await settle(relay.result, 200);
  });

  it("answers relay.request, relay.body and relay.cancel FORBIDDEN from an admin session that is not the gateway's uplink", async () => {
    await start();
    const attempts = [
      ["relay.request", relayInput()],
      ["relay.body", { end: true, relayId: "relay-x" }],
      ["relay.cancel", { relayId: "relay-x" }],
    ] as const;
    const codes: unknown[] = [];

    for (const [operation, input] of attempts) {
      const outcome = await settle(callAsAdmin(operation, input));
      codes.push(outcome.state === "rejected" ? outcome.code : outcome.state);
    }

    expect(codes).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
  });

  it("fails a relay.request that reuses an active relayId with BAD_REQUEST, answers {} to a relay.body for an unknown relay id, and {} to a relay.cancel for an unknown relay id", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const input = relayInput();
    const first = openRelay(wire, input);
    await poll(async () => (await settle(first.result, 20)).state).toBe("pending");

    const reused = await settle(wire.call("relay.request", { ...input }));
    const unknownBody = await settle(
      wire.call("relay.body", {
        relayId: "relay-unknown",
        chunk: base64Of(patternBytes(8)),
        seq: 0,
      }),
    );
    const unknownCancel = await settle(wire.call("relay.cancel", { relayId: "relay-unknown" }));
    release.open();

    expect(reused).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    expect(unknownBody).toEqual({ state: "fulfilled", value: {} });
    expect(unknownCancel).toEqual({ state: "fulfilled", value: {} });
    expect(await settle(first.result)).toEqual({ state: "fulfilled", value: {} });
  });

  it.each([
    {
      name: "a seq out of order",
      steps: [{ seq: 1 }],
    },
    {
      name: "a repeated seq",
      steps: [{ seq: 0 }, { seq: 0 }],
    },
    {
      name: "a chunk after end",
      steps: [{ seq: 0 }, { end: true }, { seq: 1 }],
    },
  ])(
    "fails a relay.body with $name with BAD_REQUEST and aborts the target's request",
    async ({ steps }) => {
      let signal: AbortSignal | undefined;
      behavior = async (request) => {
        signal = request.signal;
        await aborted(request.signal);
        return new Response("late");
      };
      await start();
      const relayId = String(relayInput().relayId);
      const relay = openRelay(wire, relayInput({ hasBody: true, method: "PUT", relayId }));
      await poll(() => signal !== undefined).toBe(true);

      const outcomes: unknown[] = [];
      for (const step of steps) {
        const payload =
          "end" in step
            ? { end: true, relayId }
            : { chunk: base64Of(patternBytes(16)), relayId, seq: step.seq };
        const outcome = await settle(wire.call("relay.body", payload));
        outcomes.push(outcome.state === "rejected" ? outcome.code : outcome.state);
      }

      expect(outcomes.slice(0, -1).every((outcome) => outcome === "fulfilled")).toBe(true);
      expect(outcomes.at(-1)).toBe("BAD_REQUEST");
      await poll(() => signal?.aborted).toBe(true);
      await settle(relay.result, 200);
    },
  );

  it("fails any relay.body for a relay opened with hasBody false with BAD_REQUEST and aborts the target's request", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const relay = openRelay(wire, relayInput({ hasBody: false }));
    await poll(() => signal !== undefined).toBe(true);

    const outcome = await settle(
      wire.call("relay.body", {
        chunk: base64Of(patternBytes(16)),
        relayId: relay.relayId,
        seq: 0,
      }),
    );

    expect(outcome).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  });

  const longName = (length: number): string => "x".repeat(length);
  const headers = (count: number): [string, string][] =>
    Array.from({ length: count }, (_unused, index) => [`x-h-${String(index)}`, "v"]);
  const urlOfLength = (length: number): string =>
    `http://gateway.test/${"a".repeat(length - "http://gateway.test/".length)}`;
  const bounds: readonly {
    readonly name: string;
    readonly atLimit: Record<string, unknown>;
    readonly pastLimit: Record<string, unknown>;
  }[] = [
    {
      atLimit: { relayId: longName(64) },
      name: "relayId of 65 characters",
      pastLimit: { relayId: longName(65) },
    },
    {
      atLimit: { target: "agent-device" },
      name: "an upper-case target",
      pastLimit: { target: "Agent-Device" },
    },
    { atLimit: { method: "PATCH" }, name: "an unknown method", pastLimit: { method: "TRACE" } },
    {
      atLimit: { url: "https://gateway.test/a" },
      name: "a relative url",
      pastLimit: { url: "/agent-device/rpc" },
    },
    {
      atLimit: { url: "http://gateway.test/a" },
      name: "a file: url",
      pastLimit: { url: "file:///etc/passwd" },
    },
    {
      atLimit: { url: urlOfLength(4096) },
      name: "a 4097-character url",
      pastLimit: { url: urlOfLength(4097) },
    },
    {
      atLimit: { headers: headers(100) },
      name: "101 headers",
      pastLimit: { headers: headers(101) },
    },
    {
      atLimit: { headers: [[longName(256), "v"]] },
      name: "a header name of 257 characters",
      pastLimit: { headers: [[longName(257), "v"]] },
    },
    {
      atLimit: { headers: [["x-ok", "v"]] },
      name: "a header name with a space",
      pastLimit: { headers: [["x bad", "v"]] },
    },
    {
      atLimit: { headers: [["x-ok", "a b"]] },
      name: "a header value with a newline",
      pastLimit: { headers: [["x-ok", "a\nb"]] },
    },
    {
      atLimit: { headers: [["x-ok", "v".repeat(8192)]] },
      name: "an 8193-character header value",
      pastLimit: { headers: [["x-ok", "v".repeat(8193)]] },
    },
    {
      atLimit: { tenant: longName(300) },
      name: "a 301-character tenant",
      pastLimit: { tenant: longName(301) },
    },
    {
      atLimit: { leaseId: "lease_1" },
      name: "a bad lease id",
      pastLimit: { leaseId: "bad lease!" },
    },
    {
      atLimit: { hasBody: false, method: "GET" },
      name: "GET with hasBody",
      pastLimit: { hasBody: true, method: "GET" },
    },
  ];

  it.each(bounds)(
    "refuses $name with BAD_REQUEST, and passes at its limit",
    async ({ atLimit, pastLimit }) => {
      await start();

      const within = await settle(openRelay(wire, relayInput(atLimit)).result);
      const past = await settle(openRelay(wire, relayInput(pastLimit)).result);

      expect(within).toEqual({ state: "fulfilled", value: {} });
      expect(past).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
      // why: with the schema bound deleted `new Request` would refuse it too, with this message.
      expect((past as { message?: string }).message).not.toContain("cannot be built");
    },
  );

  it("fails a relay.body chunk that is not standard base64, and one that decodes to 262 145 bytes, with BAD_REQUEST", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const relay = openRelay(wire, relayInput({ hasBody: true, method: "PUT" }));
    const send = (seq: number, chunk: string) =>
      settle(wire.call("relay.body", { chunk, relayId: relay.relayId, seq }));

    const atLimit = await send(0, base64Of(patternBytes(262_144)));
    const urlSafe = await send(1, "_-_-");
    const tooLong = await send(1, base64Of(patternBytes(262_145)));
    release.open();

    expect(atLimit).toEqual({ state: "fulfilled", value: {} });
    expect(urlSafe).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    expect(tooLong).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
  });

  it("fails the 17th relay on one connection with BAD_REQUEST", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const sixteen = Array.from({ length: 16 }, () => openRelay(wire, relayInput()));
    await sleep(100);

    const seventeenth = await settle(openRelay(wire, relayInput()).result);
    release.open();

    expect(seventeenth).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    const first = await Promise.all(sixteen.map((relay) => settle(relay.result)));
    expect(first.every((outcome) => outcome.state === "fulfilled")).toBe(true);
  });

  it("fails the call with INTERNAL and logs the bound when a target answers 101 headers", async () => {
    behavior = () =>
      Promise.resolve(
        new Response("ok", {
          headers: Array.from(
            { length: 101 },
            (_unused, index) => [`x-h-${String(index)}`, "v"] as [string, string],
          ),
        }),
      );
    await start();

    const outcome = await settle(openRelay(wire, relayInput()).result);

    expect(outcome).toMatchObject({ code: "INTERNAL", state: "rejected" });
    expect(fixture.logger.problems()).toContain("at most 100 headers, got");
  });

  it("fails the call with INTERNAL and logs the message when a target throws", async () => {
    behavior = () => Promise.reject(new Error("target exploded: reason-4471"));
    await start();

    const outcome = await settle(openRelay(wire, relayInput()).result);

    expect(outcome).toMatchObject({ code: "INTERNAL", state: "rejected" });
    expect(fixture.logger.problems()).toContain("target exploded: reason-4471");
  });

  it("fails the call with INTERNAL after the chunks already sent when a response body errors after the head", async () => {
    behavior = () => {
      let step = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              step += 1;
              if (step === 1) controller.enqueue(new TextEncoder().encode("abc"));
              else controller.error(new Error("body broke"));
            },
          }),
        ),
      );
    };
    await start();

    const relay = openRelay(wire, relayInput());
    const outcome = await settle(relay.result);

    expect(outcome).toMatchObject({ code: "INTERNAL", state: "rejected" });
    expect(relay.heads).toHaveLength(1);
    expect(Buffer.concat(relay.bytes()).toString()).toBe("abc");
  });

  it("never drops a relay.body frame sent right behind its relay.request frame (seq 0 plus end, 50 times)", async () => {
    behavior = async (request) => new Response(String((await request.arrayBuffer()).byteLength));
    await start();
    const outcomes: unknown[] = [];

    for (let round = 0; round < 50; round += 1) {
      const input = relayInput({ hasBody: true, method: "PUT" });
      const relayId = String(input.relayId);
      const relay = openRelay(wire, input);
      const first = wire.call("relay.body", {
        chunk: base64Of(patternBytes(100)),
        relayId,
        seq: 0,
      });
      const end = wire.call("relay.body", { end: true, relayId });
      const [result, firstAnswer, endAnswer] = await Promise.all([
        settle(relay.result, 2_000),
        settle(first),
        settle(end),
      ]);
      outcomes.push({
        body: Buffer.concat(relay.bytes()).toString(),
        end: endAnswer,
        first: firstAnswer,
        result,
      });
    }

    const expected = {
      body: "100",
      end: { state: "fulfilled", value: {} },
      first: { state: "fulfilled", value: {} },
      result: { state: "fulfilled", value: {} },
    };
    expect(outcomes).toEqual(Array.from({ length: 50 }, () => expected));
  }, 60_000);
});
