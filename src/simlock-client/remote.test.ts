import { describe, expect, it, vi } from "vitest";

import { connectSimlockAdmin } from "../admin/index.js";
import { connectSimlock } from "../client/index.js";
import { FakeClock, FakeWebSocketClientConnector } from "../ports/index.js";

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
});
