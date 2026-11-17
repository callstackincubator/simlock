import { describe, expect, it, vi } from "vitest";

import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import { promiseState } from "../test-support/promise-state.js";
import { flushMicrotasks } from "./test-client.js";
import { FakeClock, FakeWebSocketClientConnector, WebSocketRefusedError } from "../ports/index.js";

const HELLO_REPLY = {
  daemonProtocolRange: { max: 3, min: 3 },
  principal: "tok_1",
  protocolVersion: 3,
  role: "agent",
  version: "1.0.0",
};

type Peer = FakeWebSocketClientConnector["connections"][number]["peer"];

function say(peer: Peer, frame: unknown): void {
  peer.receive(new TextEncoder().encode(JSON.stringify(frame)));
}

// why: the farm's side of the session path: waits for the client's first text line, then answers its `hello` as a farm does.
async function answerHello(
  farm: FakeWebSocketClientConnector,
  index: number,
  role: "agent" | "admin",
): Promise<void> {
  await vi.waitFor(() => expect(farm.connections[index]?.peer.sentText).toHaveLength(1));
  const peer = (farm.connections[index] as (typeof farm.connections)[number]).peer;
  const hello = JSON.parse(peer.sentText[0] as string) as { id: number };
  say(peer, { id: hello.id, ok: true, payload: { ...HELLO_REPLY, role } });
}

describe("the typed client over a farm's session path", () => {
  it("connects by URL and token on the session path, refusing a bad URL shape, a token length and options of another transport before it connects", async () => {
    const farm = new FakeWebSocketClientConnector();
    const options = { clock: new FakeClock(), token: "sk_tok", webSocket: farm };

    const agent = connectSimlock({ ...options, url: "https://farm.example/" });
    await answerHello(farm, 0, "agent");
    await expect(agent).resolves.toMatchObject({ role: "agent" });
    expect(farm.connections[0]?.url).toBe("wss://farm.example/v1/session");
    expect(farm.connections[0]?.options.headers).toEqual({ authorization: "Bearer sk_tok" });

    const operator = connectSimlockAdmin({ ...options, url: "http://127.0.0.1:7300" });
    await answerHello(farm, 1, "admin");
    await expect(operator).resolves.toMatchObject({ role: "admin" });
    expect(farm.connections[1]?.url).toBe("ws://127.0.0.1:7300/v1/session");

    const farmUrl = "https://farm.example";
    const refused: [() => Promise<unknown>, RegExp][] = [
      [() => connectSimlock({ ...options, url: "ftp://farm.example" }), /https:\/\//],
      [() => connectSimlock({ ...options, url: "http://farm.example" }), /https:\/\//],
      [() => connectSimlock({ ...options, url: "farm.example" }), /https:\/\//],
      [() => connectSimlock({ ...options, url: `${farmUrl}/${"x".repeat(2048)}` }), /https:\/\//],
      [() => connectSimlock({ ...options, url: `${farmUrl}/v1` }), /origin only/],
      [() => connectSimlock({ ...options, url: `${farmUrl}/?x=1` }), /origin only/],
      [() => connectSimlock({ ...options, url: `${farmUrl}/#top` }), /origin only/],
      [() => connectSimlock({ ...options, token: "x".repeat(4097), url: farmUrl }), /token/],
      [() => connectSimlock({ ...options, token: "", url: farmUrl }), /token/],
      [() => connectSimlock({ url: farmUrl, webSocket: farm }), /token/],
      [
        () => connectSimlock({ ...options, endpoint: "/s.sock", url: farmUrl }),
        /cannot be combined/,
      ],
      [
        () => connectSimlock({ ...options, connection: {} as never, url: farmUrl }),
        /cannot be combined/,
      ],
      [() => connectSimlock({ ...options, ipc: {} as never, url: farmUrl }), /cannot be combined/],
      [
        () => connectSimlockAdmin({ ...options, credential: "c", url: farmUrl }),
        /cannot be combined/,
      ],
    ];
    for (const [attempt, message] of refused) await expect(attempt()).rejects.toThrow(message);
    expect(farm.connections).toHaveLength(2);
  });

  it("fails to connect with a code a program can match: REMOTE_UNREACHABLE, UNAUTHENTICATED or FORBIDDEN", async () => {
    const clock = new FakeClock();
    const url = "https://farm.example";
    const refusals: [string, (farm: FakeWebSocketClientConnector) => void, string][] = [
      [
        "nothing listening",
        (farm) => (farm.failure = new Error("connect ECONNREFUSED")),
        "REMOTE_UNREACHABLE",
      ],
      ["401", (farm) => (farm.failure = new WebSocketRefusedError(401, "{}")), "UNAUTHENTICATED"],
      ["403", (farm) => (farm.failure = new WebSocketRefusedError(403, "{}")), "FORBIDDEN"],
      [
        "404 at the path",
        (farm) => (farm.failure = new WebSocketRefusedError(404, "")),
        "REMOTE_UNREACHABLE",
      ],
      [
        "502 from a proxy",
        (farm) => (farm.failure = new WebSocketRefusedError(502, "Bad Gateway")),
        "REMOTE_UNREACHABLE",
      ],
    ];
    for (const [name, arrange, code] of refusals) {
      const farm = new FakeWebSocketClientConnector();
      arrange(farm);
      await expect(
        connectSimlock({ clock, token: "sk_tok", url, webSocket: farm }),
        name,
      ).rejects.toMatchObject({ code });
    }

    const silent = new FakeWebSocketClientConnector();
    silent.unanswered = true;
    const waiting = connectSimlock({ clock, token: "sk_tok", url, webSocket: silent });
    const state = promiseState(waiting);
    clock.advance(9_999);
    await flushMicrotasks();
    expect(state.state).toBe("pending");
    clock.advance(1);
    await flushMicrotasks();
    expect(state.state).toBe("rejected");
    await expect(waiting).rejects.toMatchObject({ code: "REMOTE_UNREACHABLE" });
  });

  describe("an open session", () => {
    const url = "https://farm.example";

    async function opened() {
      const farm = new FakeWebSocketClientConnector();
      const clock = new FakeClock();
      const connecting = connectSimlock({ clock, token: "sk_tok", url, webSocket: farm });
      await answerHello(farm, 0, "agent");
      const client = await connecting;
      const connection = farm.connections[0] as (typeof farm.connections)[number];
      return { client, clock, options: connection.options, peer: connection.peer };
    }

    function call(peer: Peer, expected: string): number {
      const sent = JSON.parse(peer.sentText.at(-1) as string) as { id: number; type: string };
      expect(sent.type).toBe(expected);
      return sent.id;
    }

    it("carries pushes and a 60 MiB reply as a socket does, and a farm of another protocol version gives a degraded client", async () => {
      const { client, options: farmOptions, peer } = await opened();
      const lost = vi.fn();
      client.onLeaseLost(lost);
      say(peer, {
        payload: { deviceId: "device_1", leaseId: "lease_1", reason: "crashed" },
        push: "lease-lost",
      });
      expect(lost).toHaveBeenCalledWith({
        deviceId: "device_1",
        leaseId: "lease_1",
        reason: "crashed",
      });

      expect(farmOptions.maxPayloadBytes).toBeGreaterThanOrEqual(60 * 1024 * 1024);
      const identity = client.identity();
      await flushMicrotasks();
      const name = "x".repeat(60 * 1024 * 1024);
      say(peer, {
        id: call(peer, "identity.get"),
        ok: true,
        payload: { name, principal: "tok_1", role: "agent", via: "token" },
      });
      await expect(identity).resolves.toMatchObject({ name });

      const farm = new FakeWebSocketClientConnector();
      const connecting = connectSimlock({
        clock: new FakeClock(),
        token: "sk_tok",
        url,
        webSocket: farm,
      });
      await vi.waitFor(() => expect(farm.connections[0]?.peer.sentText).toHaveLength(1));
      const old = (farm.connections[0] as { peer: Peer }).peer;
      say(old, {
        error: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          details: {
            client: { max: 95, min: 89 },
            daemon: { max: 3, min: 3 },
            daemonVersion: "0.1.0",
          },
          message: "no overlap",
        },
        id: call(old, "hello"),
        ok: false,
      });
      const degraded = await connecting;
      await expect(degraded.identity()).rejects.toMatchObject({
        code: "PROTOCOL_VERSION_UNSUPPORTED",
      });
    });

    it("rejects the calls in flight when the connection drops, when the farm is silent for 45 s, and with UNAUTHENTICATED on close 4003", async () => {
      const dropped = await opened();
      const inFlight = dropped.client.identity();
      const inFlightState = promiseState(inFlight);
      await flushMicrotasks();
      dropped.peer.dropped(1006, "");
      await flushMicrotasks();
      expect(inFlightState.state).toBe("rejected");
      await expect(inFlight).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });

      const silent = await opened();
      const waiting = silent.client.identity();
      const waitingState = promiseState(waiting);
      await flushMicrotasks();
      silent.clock.advance(44_999);
      silent.peer.ping();
      silent.clock.advance(44_999);
      await flushMicrotasks();
      expect(silent.peer.terminated).toBe(false);
      silent.clock.advance(1);
      await flushMicrotasks();
      expect(waitingState.state).toBe("rejected");
      await expect(waiting).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
      expect(silent.peer.terminated).toBe(true);

      const revoked = await opened();
      const pending = revoked.client.identity();
      const pendingState = promiseState(pending);
      await flushMicrotasks();
      revoked.peer.dropped(4003, "token revoked");
      await flushMicrotasks();
      expect(pendingState.state).toBe("rejected");
      await expect(pending).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(revoked.client.identity()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });
});
