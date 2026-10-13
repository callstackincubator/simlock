import { describe, expect, it, vi } from "vitest";

import { connectSimlockClient } from "../simlock-client/client.js";
import { completeHello, ScriptedConnection } from "../simlock-client/test-support.js";
import type { SentFrame } from "../simlock-client/test-support.js";
import type { WorkerDirectory } from "./fleet-ports.js";
import { GatewayRelay } from "./relay.js";
import type { GatewayWorkerClient } from "./worker-client.js";

const WORKER_ID = "wrk_a";
const KIB = 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setup() {
  const connection = new ScriptedConnection();
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
  return { connection, relay: new GatewayRelay({ directory }) };
}

function call(body?: ReadableStream<Uint8Array>) {
  return {
    request: new Request("http://gateway.test:4321/agent-device/rpc", {
      method: body === undefined ? "GET" : "PUT",
      ...(body === undefined ? {} : { body, duplex: "half" }),
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

  it("fails the relay with INTERNAL naming the worker, and sends relay.cancel, on a relay-head whose header value `Headers` refuses", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");

    connection.push("relay-head", {
      headers: [["x-note", "\u20ac"]],
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

  it("fails the relay with INTERNAL naming the worker, and sends relay.cancel, on a relay-chunk that is not base64", async () => {
    const { connection, relay } = await setup();
    const pending = relay.relay(WORKER_ID, call());
    const request = await sentFrame(connection, "relay.request");
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    const response = await pending;

    connection.push("relay-chunk", { chunk: "not base64 !!", requestId: request.id });

    const read = await outcome(
      response.body?.getReader().read() ?? Promise.reject(new Error("no body")),
    );
    expect(read).toEqual({
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

    const read = await outcome(
      response.body?.getReader().read() ?? Promise.reject(new Error("no body")),
    );
    expect(read).toMatchObject({ message: "worker side exploded", state: "rejected" });
  });

  it("reads DAEMON_STOPPING from a worker as a lost uplink: WORKER_UNREACHABLE", async () => {
    const { connection, relay } = await setup();
    const pending = outcome(relay.relay(WORKER_ID, call()));
    const request = await sentFrame(connection, "relay.request");

    connection.fail(request.id, "DAEMON_STOPPING", "The daemon is stopping");

    expect(await pending).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
  });

  it("sends the request body as relay.body calls with at most 4 sent and not yet answered", async () => {
    const { connection, relay } = await setup();
    let piece = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        piece += 1;
        controller.enqueue(new Uint8Array(256 * KIB).fill(piece));
        if (piece === 10) controller.close();
      },
    });
    const pending = relay.relay(WORKER_ID, call(body));
    const request = await sentFrame(connection, "relay.request");
    const bodyFrames = () => connection.sent.filter((frame) => frame.type === "relay.body");

    await vi.waitFor(() => expect(bodyFrames().length).toBeGreaterThanOrEqual(4));
    await sleep(100);
    const firstWindow = bodyFrames().length;
    let answered = 0;
    let maxUnanswered = 0;
    const isEnd = (frame: SentFrame) => (frame.payload as { end?: boolean }).end === true;
    while (!(bodyFrames().some(isEnd) && answered === bodyFrames().length) && answered < 40) {
      maxUnanswered = Math.max(maxUnanswered, bodyFrames().length - answered);
      const next = bodyFrames()[answered];
      if (next !== undefined) {
        connection.reply(next.id, {});
        answered += 1;
      }
      await sleep(30);
    }
    connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
    connection.reply(request.id, {});
    await pending;

    expect(firstWindow).toBe(4);
    expect(maxUnanswered).toBeLessThanOrEqual(4);
    expect(bodyFrames().length).toBe(11);
  }, 30_000);
});
