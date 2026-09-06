import { describe, expect, it, vi } from "vitest";

import {
  createConnectionPair,
  FakeClock,
  MemoryUplinkTransport,
  UplinkError,
  type IpcConnection,
  type UplinkConnector,
  type UplinkDialOptions,
} from "../ports/index.js";
import { GatewayUplink } from "./gateway-uplink.js";

/** A connector a test drives by hand: every dial is recorded, and each one either hands back a
 * connection or fails with the scripted error. */
class ScriptedConnector implements UplinkConnector {
  readonly dials: UplinkDialOptions[] = [];
  readonly connections: IpcConnection[] = [];
  #outcomes: Array<"connect" | UplinkError> = [];

  script(...outcomes: Array<"connect" | UplinkError>): void {
    this.#outcomes.push(...outcomes);
  }

  async connect(options: UplinkDialOptions): Promise<IpcConnection> {
    this.dials.push(options);
    const outcome = this.#outcomes.shift() ?? "connect";
    if (outcome !== "connect") throw outcome;
    const [workerEnd, gatewayEnd] = createConnectionPair();
    this.connections.push(gatewayEnd);
    return workerEnd;
  }
}

function uplink(
  connector: UplinkConnector,
  overrides: Partial<ConstructorParameters<typeof GatewayUplink>[0]> = {},
) {
  const clock = new FakeClock(1_000);
  const accepted: IpcConnection[] = [];
  const link = new GatewayUplink({
    accept: (connection) => accepted.push(connection),
    clock,
    connector,
    // Pinned so the delays a test asserts are the schedule, not a coin flip. The real default
    // is Math.random; jitter itself is asserted separately below.
    random: () => 1,
    token: "join-secret",
    url: "ws://gateway.test/v1/uplink",
    workerId: "wrk_1",
    ...overrides,
  });
  return { accepted, clock, link };
}

describe("GatewayUplink", () => {
  it("dials on start and hands the connection to the daemon", async () => {
    const connector = new ScriptedConnector();
    const { accepted, link } = uplink(connector);

    link.start();
    await vi.waitFor(() => expect(accepted).toHaveLength(1));

    expect(connector.dials).toEqual([
      {
        token: "join-secret",
        url: "ws://gateway.test/v1/uplink",
        workerId: "wrk_1",
      },
    ]);
    await link.stop();
  });

  it("sends the label when the worker configured one", async () => {
    const connector = new ScriptedConnector();
    const { link } = uplink(connector, { label: "mac-mini-1" });

    link.start();
    await vi.waitFor(() => expect(connector.dials).toHaveLength(1));

    expect(connector.dials[0]?.label).toBe("mac-mini-1");
    await link.stop();
  });

  it("reconnects after the gateway drops the uplink", async () => {
    const connector = new ScriptedConnector();
    const { accepted, clock, link } = uplink(connector);
    link.start();
    await vi.waitFor(() => expect(accepted).toHaveLength(1));

    // The gateway's end goes away -- a restart, a network drop, a revoked token being cut off.
    await connector.connections[0]?.close();
    clock.advance(1_000);
    await vi.waitFor(() => expect(accepted).toHaveLength(2));

    await link.stop();
  });

  it("backs off exponentially and stops growing at the cap", async () => {
    const connector = new ScriptedConnector();
    const unreachable = () => new UplinkError("unreachable", "no gateway");
    connector.script(unreachable(), unreachable(), unreachable(), unreachable(), unreachable());
    const { clock, link } = uplink(connector, {
      backoff: { initialMs: 1_000, maxMs: 4_000, multiplier: 2 },
    });

    link.start();
    await vi.waitFor(() => expect(connector.dials).toHaveLength(1));

    // 1s, then 2s, then 4s, then the cap holds at 4s. Each `advance` is one millisecond short
    // of the next delay first, to prove the retry is actually scheduled rather than eager.
    for (const delayMs of [1_000, 2_000, 4_000, 4_000]) {
      const before = connector.dials.length;
      clock.advance(delayMs - 1);
      expect(connector.dials).toHaveLength(before);
      clock.advance(1);
      await vi.waitFor(() => expect(connector.dials).toHaveLength(before + 1));
    }

    await link.stop();
  });

  it("keeps retrying at the cap when the gateway rejects the join token (ADR 0005 §8)", async () => {
    const connector = new ScriptedConnector();
    const rejected = () => new UplinkError("rejected", "revoked");
    connector.script(rejected(), rejected(), rejected(), rejected(), rejected(), rejected());
    const { clock, link } = uplink(connector, {
      backoff: { initialMs: 1_000, maxMs: 2_000, multiplier: 2 },
    });

    link.start();
    await vi.waitFor(() => expect(connector.dials).toHaveLength(1));
    // A revoked token is not a reason to give up: an operator may mint a new one at any time,
    // and a worker that stopped dialling would need a restart nobody would think to perform.
    for (let index = 0; index < 4; index += 1) {
      const before = connector.dials.length;
      clock.advance(2_000);
      await vi.waitFor(() => expect(connector.dials.length).toBeGreaterThan(before));
    }

    await link.stop();
  });

  it("jitters the delay across the lower half of the window", async () => {
    const connector = new ScriptedConnector();
    connector.script(new UplinkError("unreachable", "no gateway"));
    const { clock, link } = uplink(connector, {
      backoff: { initialMs: 1_000, maxMs: 1_000, multiplier: 2 },
      // Smallest possible jitter: half the window.
      random: () => 0,
    });

    link.start();
    await vi.waitFor(() => expect(connector.dials).toHaveLength(1));
    clock.advance(499);
    expect(connector.dials).toHaveLength(1);
    clock.advance(1);
    await vi.waitFor(() => expect(connector.dials).toHaveLength(2));

    await link.stop();
  });

  it("stops dialling and closes the uplink on stop", async () => {
    const connector = new ScriptedConnector();
    const { accepted, clock, link } = uplink(connector);
    link.start();
    await vi.waitFor(() => expect(accepted).toHaveLength(1));

    await link.stop();

    expect(accepted[0]?.closed).toBe(true);
    // Neither the closed connection nor the passage of time redials after a stop.
    clock.advance(60_000);
    expect(connector.dials).toHaveLength(1);
  });

  it("closes a connection that lands after a stop rather than serving it", async () => {
    let release: ((connection: IpcConnection) => void) | undefined;
    const pending = new Promise<IpcConnection>((resolve) => {
      release = resolve;
    });
    const connector: UplinkConnector = { connect: async () => pending };
    const { accepted, link } = uplink(connector);

    link.start();
    await link.stop();
    const [workerEnd] = createConnectionPair();
    release?.(workerEnd);
    await vi.waitFor(() => expect(workerEnd.closed).toBe(true));

    expect(accepted).toEqual([]);
  });

  it("works against the in-memory transport end to end", async () => {
    const transport = new MemoryUplinkTransport();
    const accepted: string[] = [];
    await transport.listen({
      accept: (uplinkConnection) => accepted.push(uplinkConnection.workerId),
      authenticate: async (token) => token === "join-secret",
    });
    const { link } = uplink(transport);

    link.start();
    await vi.waitFor(() => expect(accepted).toEqual(["wrk_1"]));

    await link.stop();
  });
});
