import { describe, expect, it } from "vitest";

import { FakeTcpListenerFactory, FakeWebSocketClientConnector } from "../../ports/index.js";
import { CloudAdbRelay } from "./cloud-relay.js";

function setup() {
  const listeners = new FakeTcpListenerFactory();
  const webSockets = new FakeWebSocketClientConnector();
  const relay = new CloudAdbRelay({
    api: {
      adbUrl: (id) => `wss://api.example.com/v1/leases/${id}/adb`,
      authorizationHeaders: () => ({ authorization: "Bearer adc_secret" }),
    },
    listeners,
    webSockets,
  });
  return { relay, listeners, webSockets };
}

// why: the relay is a decomposed Android driver part; its fake byte peers force disconnect and concurrent-transport ordering independently of adb.
describe("CloudAdbRelay", () => {
  it("reopens a saved bridge port and refuses that port when another process holds it", async () => {
    const { relay, listeners } = setup();
    listeners.busy.add(15555);
    const occupied = relay.open("lease_one", 15555);
    await expect(occupied).rejects.toThrow("Could not open the AgentDeviceCloud ADB bridge");
    expect(listeners.listeners).toEqual([]);
    listeners.busy.delete(15555);
    const first = await relay.open("lease_one", 15555);
    expect(first.serial).toBe("127.0.0.1:15555");
    await first.close();
    const reopened = await relay.open("lease_one", 15555);
    expect(reopened.serial).toBe("127.0.0.1:15555");
    await reopened.close();
  });

  it("forwards binary ADB bytes through one authenticated upstream and closes both sides", async () => {
    const { relay, listeners, webSockets } = setup();
    const connection = await relay.open("lease_one");
    expect(connection.serial).toBe("127.0.0.1:49152");
    const reopened = relay.open("lease_one");
    await expect(reopened).rejects.toThrow("already has an ADB bridge");
    const listener = listeners.listeners[0]!;
    expect(listener.address).toBe("127.0.0.1");
    const tcp = listener.connect();
    await Promise.resolve();
    const upstream = webSockets.connections[0]!;
    expect(upstream.url).toBe("wss://api.example.com/v1/leases/lease_one/adb");
    expect(upstream.options.headers).toEqual({ authorization: "Bearer adc_secret" });
    const outgoing = new Uint8Array([1, 2, 3]);
    tcp.send(outgoing);
    await Promise.resolve();
    const incoming = new Uint8Array([4, 5, 6]);
    upstream.peer.receive(incoming);
    await Promise.resolve();
    expect(upstream.peer.sent).toEqual([outgoing]);
    expect(tcp.written).toEqual([incoming]);
    const duplicate = listener.connect();
    expect(duplicate.closed).toBe(true);
    expect(webSockets.connections).toHaveLength(1);
    upstream.peer.dropped(1006, "lost");
    await connection.close();
    expect(tcp.closed).toBe(true);
    expect(upstream.peer.terminated).toBe(true);
    expect(listener.closed).toBe(true);
  });

  it("closes TCP when the upgrade fails and closes an in-flight upstream when the bridge stops", async () => {
    const { relay, listeners, webSockets } = setup();
    const connection = await relay.open("lease_one");
    const listener = listeners.listeners[0]!;
    webSockets.failure = new Error("upgrade refused");
    const failed = listener.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(failed.closed).toBe(true);
    webSockets.failure = undefined;
    const tcp = listener.connect();
    const closing = connection.close();
    await closing;
    expect(tcp.closed).toBe(true);
    expect(webSockets.connections[0]!.peer.terminated).toBe(true);
    await connection.close();
  });
});
