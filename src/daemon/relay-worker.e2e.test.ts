import { afterEach, describe, expect, it } from "vitest";

import { creditEnvelope } from "../link/testing.js";
import type { DaemonServer } from "./server.js";
import type { RelayTarget } from "./relay.js";
import {
  adminSession,
  aborted,
  cleanUp,
  gate,
  MIB,
  openRelay,
  openUplink,
  patternBytes,
  patternDigest,
  digestOf,
  patternStream,
  readParts,
  relayInput,
  settleWithin,
  sleep,
  startWorker,
  type Uplink,
  type WorkerFixture,
} from "./test-relay-support.js";

const poll = <T>(read: () => T | Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

describe("a worker's relay targets over its uplink", { timeout: 15_000 }, () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  let behavior: RelayTarget = () => Promise.resolve(new Response("ok"));
  let fixture: WorkerFixture;
  let uplink: Uplink;

  async function start(): Promise<void> {
    const target: RelayTarget = (request, tenant, leaseId) => behavior(request, tenant, leaseId);
    fixture = await startWorker(directories, daemons, { "agent-device": target, echo: target });
    uplink = await openUplink(fixture.worker);
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

  it("sends a 20 MiB response body on the channel byte for byte, then ends it, and answers relay.request {}", async () => {
    behavior = () => Promise.resolve(new Response(patternStream(20 * MIB, 7)));
    await start();

    const relay = await openRelay(uplink, relayInput());
    const body = await relay.body(30_000);
    const outcome = await settleWithin(relay.result, 30_000);

    expect(outcome).toEqual({ state: "fulfilled", value: {} });
    expect(relay.heads).toHaveLength(1);
    expect(body.state === "fulfilled" ? digestOf([body.value]) : body.state).toBe(
      patternDigest(20 * MIB, 7),
    );
  }, 60_000);

  it("hands the target a 2 MiB request body read from the channel, byte for byte", async () => {
    let received = "";
    let length = 0;
    behavior = async (request) => {
      const parts = await readParts(request.body);
      received = digestOf(parts);
      length = parts.reduce((total, part) => total + part.length, 0);
      return new Response("got it");
    };
    await start();

    const relay = await openRelay(uplink, relayInput({ hasBody: true, method: "PUT" }), {
      upload: patternBytes(2 * MIB, 3),
    });
    const outcome = await settleWithin(relay.result);

    expect(outcome).toEqual({ state: "fulfilled", value: {} });
    expect(length).toBe(2 * MIB);
    expect(received).toBe(digestOf([patternBytes(2 * MIB, 3)]));
  });

  it("answers an empty upload (0 bytes) and a GET with the target's response on the channel", async () => {
    let seen = -1;
    behavior = async (request) => {
      seen = (await request.arrayBuffer()).byteLength;
      return new Response("fine");
    };
    await start();

    const empty = await openRelay(uplink, relayInput({ hasBody: true, method: "PUT" }), {
      upload: new Uint8Array(0),
    });
    const emptyBody = await empty.body();
    const get = await openRelay(uplink, relayInput());
    const getBody = await get.body();

    expect(seen).toBe(0);
    expect(emptyBody.state === "fulfilled" ? Buffer.from(emptyBody.value).toString() : "").toBe(
      "fine",
    );
    expect(getBody.state === "fulfilled" ? Buffer.from(getBody.value).toString() : "").toBe("fine");
  });

  it("sends no response bytes for a 204, 205 or 304 answer or a HEAD answer, and ends the channel", async () => {
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
    const seen: { status: number | undefined; bytes: number | string; result: unknown }[] = [];

    for (const entry of cases) {
      behavior = () => Promise.resolve(new Response(entry.body, { status: entry.status }));
      const relay = await openRelay(uplink, relayInput({ method: entry.method }));
      const body = await relay.body();
      const outcome = await settleWithin(relay.result);
      seen.push({
        bytes: body.state === "fulfilled" ? body.value.length : body.state,
        result: outcome,
        status: relay.heads[0]?.status,
      });
    }

    expect(seen).toEqual(
      cases.map((entry) => ({
        bytes: 0,
        result: { state: "fulfilled", value: {} },
        status: entry.status,
      })),
    );
  });

  it("aborts the target's request on relay.cancel, answers relay.request { cancelled: true }, and aborts the channel", async () => {
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
    const relay = await openRelay(uplink, relayInput());
    await poll(() => relay.heads.length).toBe(1);

    const cancelled = await settleWithin(
      uplink.wire.call("relay.cancel", { relayId: relay.relayId }),
    );
    const result = await settleWithin(relay.result);
    const read = await relay.readError();

    expect(cancelled).toEqual({ state: "fulfilled", value: {} });
    expect(result).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(read).toEqual({ ended: false, reason: "aborted" });
  });

  it("answers relay.request { cancelled: true } to a cancel that comes before the target answers, and aborts the channel", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const relay = await openRelay(uplink, relayInput());
    await poll(() => signal !== undefined).toBe(true);

    await uplink.wire.call("relay.cancel", { relayId: relay.relayId });
    const result = await settleWithin(relay.result);
    const read = await relay.readError();

    expect(result).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(relay.heads).toEqual([]);
    expect(read).toEqual({ ended: false, reason: "aborted" });
  });

  it("aborts the target's request when the connection the relay came on closes", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const second = await openUplink(fixture.worker);
    const relay = await openRelay(second, relayInput());
    await poll(() => signal !== undefined).toBe(true);

    await second.pair.gatewayEnd.close();

    await poll(() => signal?.aborted).toBe(true);
    await settleWithin(relay.result, 200);
  });

  it("aborts the target's request and answers { cancelled: true } when the gateway aborts the channel", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const relay = await openRelay(uplink, relayInput(), { keepOpen: true });
    await poll(() => signal !== undefined).toBe(true);

    relay.channel.abort("caller left");
    const result = await settleWithin(relay.result);

    expect(signal?.aborted).toBe(true);
    expect(result).toEqual({ state: "fulfilled", value: { cancelled: true } });
  });

  it("fails relay.request BAD_REQUEST and aborts the target's request when the gateway breaks a link rule on the relay's channel", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    await start();
    const relay = await openRelay(uplink, relayInput(), { keepOpen: true });
    await poll(() => signal !== undefined).toBe(true);

    // why: the first channel the gateway end opens is number 2; a CREDIT of 0 breaks the link's rule.
    await uplink.pair.gatewayEnd.writeBinary(creditEnvelope(2, 0));
    const result = await settleWithin(relay.result);

    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
  });

  it("answers relay.request and relay.cancel FORBIDDEN from an admin session that is not the gateway's uplink", async () => {
    await start();
    const attempts = [
      ["relay.request", relayInput({ channel: "chan-1" })],
      ["relay.cancel", { relayId: "relay-x" }],
    ] as const;
    const codes: unknown[] = [];

    for (const [operation, input] of attempts) {
      const outcome = await settleWithin(callAsAdmin(operation, input));
      codes.push(outcome.state === "rejected" ? outcome.code : outcome.state);
    }

    expect(codes).toEqual(["FORBIDDEN", "FORBIDDEN"]);
  });

  it("fails a relay.request that reuses an active relayId with BAD_REQUEST and its channel errored aborted, leaves the first relay running, and answers {} to a relay.cancel for an unknown relay id", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const input = relayInput();
    const first = await openRelay(uplink, input);
    await poll(async () => (await settleWithin(first.result, 20)).state).toBe("pending");

    const second = await openRelay(uplink, { ...input });
    const reused = await settleWithin(second.result);
    const unknownCancel = await settleWithin(
      uplink.wire.call("relay.cancel", { relayId: "relay-unknown" }),
    );
    const reusedEnd = await second.readError();
    release.open();

    expect(reused).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    expect(reusedEnd).toEqual({ ended: false, reason: "aborted" });
    expect(unknownCancel).toEqual({ state: "fulfilled", value: {} });
    expect(await settleWithin(first.result)).toEqual({ state: "fulfilled", value: {} });
  });

  it.each([
    { channelName: "never-opened-by-gateway", name: "a channel the gateway never opened" },
    { channelName: "", name: "an empty channel" },
    { channelName: "c".repeat(33), name: "a 33-character channel" },
    { channelName: "bad channel!", name: "a channel with a character outside [A-Za-z0-9-]" },
    { channelName: null, name: "no channel" },
  ])(
    "fails a relay.request naming $name with BAD_REQUEST, and one naming a channel the gateway opened succeeds",
    async ({ channelName }) => {
      await start();

      const accepted = await openRelay(uplink, relayInput());
      const acceptedOutcome = await settleWithin(accepted.result);
      const refused = await openRelay(uplink, relayInput(), { channelName });
      const refusedOutcome = await settleWithin(refused.result);

      expect(acceptedOutcome).toEqual({ state: "fulfilled", value: {} });
      expect(refusedOutcome).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    },
  );

  it("fails a relay.request naming a channel an earlier relay.request already accepted with BAD_REQUEST", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const first = await openRelay(uplink, relayInput(), { keepOpen: true });
    await poll(async () => (await settleWithin(first.result, 20)).state).toBe("pending");

    const again = await openRelay(uplink, relayInput(), { channelName: first.channel.id });
    const outcome = await settleWithin(again.result);
    release.open();

    expect(outcome).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
    first.channel.abort("done");
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

      const within = await settleWithin((await openRelay(uplink, relayInput(atLimit))).result);
      const past = await settleWithin((await openRelay(uplink, relayInput(pastLimit))).result);

      expect(within).toEqual({ state: "fulfilled", value: {} });
      expect(past).toMatchObject({ code: "BAD_REQUEST", state: "rejected" });
      // why: with the schema bound deleted `new Request` would refuse it too, with this message.
      expect((past as { message?: string }).message).not.toContain("cannot be built");
    },
  );

  const failures: readonly {
    readonly name: string;
    readonly target?: RelayTarget;
    readonly input?: Record<string, unknown>;
    readonly code: string;
  }[] = [
    { code: "BAD_REQUEST", input: { method: "TRACE" }, name: "fails on its schema" },
    { code: "RELAY_TARGET_MISSING", input: { target: "nobody" }, name: "names a missing target" },
    {
      code: "INTERNAL",
      name: "meets a target error",
      target: () => Promise.reject(new Error("target exploded")),
    },
    {
      code: "INTERNAL",
      name: "meets target headers out of bounds",
      target: () =>
        Promise.resolve(
          new Response("ok", {
            headers: Array.from(
              { length: 101 },
              (_unused, index) => [`x-h-${String(index)}`, "v"] as [string, string],
            ),
          }),
        ),
    },
    {
      code: "INTERNAL",
      name: "has a response body that fails after the head",
      target: () => {
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
      },
    },
  ];

  it.each(failures)(
    "a relay.request that $name leaves the gateway's end of its channel errored aborted, while an accepted one ends it cleanly",
    async ({ code, input, target }) => {
      await start();
      const good = await openRelay(uplink, relayInput());
      const goodEnd = await good.readError();
      behavior = target ?? behavior;

      const failing = await openRelay(uplink, relayInput(input ?? {}));
      const outcome = await settleWithin(failing.result);
      const end = await failing.readError();

      expect(goodEnd).toEqual({ ended: true });
      expect(outcome).toMatchObject({ code, state: "rejected" });
      expect(end).toEqual({ ended: false, reason: "aborted" });
    },
  );

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

    const outcome = await settleWithin((await openRelay(uplink, relayInput())).result);

    expect(outcome).toMatchObject({ code: "INTERNAL", state: "rejected" });
    expect(fixture.logger.problems()).toContain("at most 100 headers, got");
  });

  it("fails the call with INTERNAL and logs the message when a target throws", async () => {
    behavior = () => Promise.reject(new Error("target exploded: reason-4471"));
    await start();

    const outcome = await settleWithin((await openRelay(uplink, relayInput())).result);

    expect(outcome).toMatchObject({ code: "INTERNAL", state: "rejected" });
    expect(fixture.logger.problems()).toContain("target exploded: reason-4471");
  });

  it("stops the request direction when the target answers without reading its 20 MiB upload, so the gateway's writer errors stopped", async () => {
    behavior = () => Promise.resolve(new Response("nope", { status: 401 }));
    await start();
    const relay = await openRelay(uplink, relayInput({ hasBody: true, method: "PUT" }), {
      keepOpen: true,
    });
    const writer = relay.channel.writable.getWriter();
    const pushed = (async () => {
      try {
        for (let offset = 0; offset < 20 * MIB; offset += MIB) {
          await writer.write(patternBytes(MIB, 4, offset));
        }
        await writer.close();
        return "wrote everything";
      } catch (error: unknown) {
        return (error as { reason?: string }).reason ?? String(error);
      }
    })();

    const outcome = await settleWithin(pushed, 10_000);
    const result = await settleWithin(relay.result);

    expect(result).toEqual({ state: "fulfilled", value: {} });
    expect(outcome).toEqual({ state: "fulfilled", value: "stopped" });
  });

  it("errors a request body the target reads after it answered, rather than ending it as if the upload were complete", async () => {
    let held: Request | undefined;
    behavior = (request) => {
      held = request;
      return Promise.resolve(new Response("nope", { status: 401 }));
    };
    await start();
    const relay = await openRelay(uplink, relayInput({ hasBody: true, method: "PUT" }), {
      keepOpen: true,
    });
    const result = await settleWithin(relay.result);

    const late = held === undefined ? undefined : await settleWithin(held.text());

    expect(result).toEqual({ state: "fulfilled", value: {} });
    expect(late).toMatchObject({ state: "rejected" });
  });

  it("stops a hasBody false relay's request direction at once, so bytes the gateway still writes error its writer stopped", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    await start();
    const relay = await openRelay(uplink, relayInput({ hasBody: false }), { keepOpen: true });
    const writer = relay.channel.writable.getWriter();
    const pushed = (async () => {
      try {
        for (let offset = 0; offset < 8 * MIB; offset += MIB) {
          await writer.write(patternBytes(MIB, 4, offset));
        }
        return "wrote everything";
      } catch (error: unknown) {
        return (error as { reason?: string }).reason ?? String(error);
      }
    })();

    const outcome = await settleWithin(pushed, 10_000);
    release.open();

    expect(outcome).toEqual({ state: "fulfilled", value: "stopped" });
  });
});
