import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import type { DaemonConnection } from "../daemon-client/protocol.js";
import { startMcpStdio, type McpTransport } from "./main.js";

describe("MCP stdio lifecycle", () => {
  it.each(["transport", "SIGINT", "SIGTERM"])("closes once on %s", async (cause) => {
    const transport = new FakeTransport();
    const server = new FakeServer();
    const signals = new FakeSignals();
    const runner = await startMcpStdio({
      createServer: () => server as unknown as McpServer,
      createTransport: () => transport,
      signals,
    });

    if (cause === "transport") transport.onclose?.();
    else signals.emit(cause);
    await runner.finished;
    await runner.shutdown();

    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
    expect(signals.listeners.size).toBe(0);
  });

  // Regression for a real reentrancy bug: the SDK's transport.close() can invoke
  // `onclose` *synchronously*, inside the same call stack `shutdown()` is already
  // running in (via `server.close()` -> `transport.close()`). A `shutdownPromise ??=
  // (async () => {...})()` guard alone does not close that window -- the assignment
  // to `shutdownPromise` only happens after the async IIFE returns a promise, so a
  // synchronous re-entrant call still sees it as `undefined` and recurses. Left
  // unfixed this recurses until the stack overflows (observed via a real MCP client
  // round trip through @modelcontextprotocol/sdk's stdio transport).
  it("does not recurse when the transport's close() synchronously re-triggers onclose", async () => {
    const transport = new SynchronouslyReentrantTransport();
    const server = new FakeServer();
    const runner = await startMcpStdio({
      createServer: () => server as unknown as McpServer,
      createTransport: () => transport,
      signals: new FakeSignals(),
    });

    // This must not throw RangeError: Maximum call stack size exceeded.
    transport.onclose?.();
    await runner.finished;

    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });

  it("cleans up after startup failure", async () => {
    const transport = new FakeTransport();
    const server = new FakeServer(new Error("startup failed"));
    await expect(
      startMcpStdio({
        createServer: () => server as unknown as McpServer,
        createTransport: () => transport,
      }),
    ).rejects.toThrow("startup failed");
    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });

  it("closes the lease-owning session when its transport ends", async () => {
    const connection = new LeaseConnection();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runner = await startMcpStdio({
      connect: async () => connection,
      createTransport: () => serverTransport,
      requesterId: "mcp-test",
      signals: new FakeSignals(),
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    await client.request(
      {
        method: "tools/call",
        params: { arguments: { device: "iPhone", platform: "ios" }, name: "lease_simulator" },
      },
      CallToolResultSchema,
    );

    serverTransport.onclose?.();
    await runner.finished;
    expect(connection.closeCalls).toBe(1);
    await client.close();
  });

  it("sources the requester id from SIMLOCK_AGENT_ID when none is given explicitly", async () => {
    const connection = new LeaseConnection();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runner = await startMcpStdio({
      connect: async () => connection,
      createTransport: () => serverTransport,
      env: { SIMLOCK_AGENT_ID: "agent-from-env" },
      signals: new FakeSignals(),
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    await client.request(
      {
        method: "tools/call",
        params: { arguments: { device: "iPhone", platform: "ios" }, name: "lease_simulator" },
      },
      CallToolResultSchema,
    );

    expect(connection.lastRequesterId).toBe("agent-from-env");
    await runner.shutdown();
    await client.close();
  });

  it("prefers an explicit requesterId over SIMLOCK_AGENT_ID", async () => {
    const connection = new LeaseConnection();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runner = await startMcpStdio({
      connect: async () => connection,
      createTransport: () => serverTransport,
      env: { SIMLOCK_AGENT_ID: "agent-from-env" },
      requesterId: "explicit-agent",
      signals: new FakeSignals(),
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    await client.request(
      {
        method: "tools/call",
        params: { arguments: { device: "iPhone", platform: "ios" }, name: "lease_simulator" },
      },
      CallToolResultSchema,
    );

    expect(connection.lastRequesterId).toBe("explicit-agent");
    await runner.shutdown();
    await client.close();
  });

  it("closes once when stdin reaches EOF", async () => {
    const transport = new FakeTransport();
    const server = new FakeServer();
    const stdin = new FakeStdin();
    const runner = await startMcpStdio({
      createServer: () => server as unknown as McpServer,
      createTransport: () => transport,
      stdin,
    });

    stdin.end();
    await runner.finished;
    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
    expect(stdin.listener).toBeUndefined();
  });

  it("finishes when the transport closes during server connection", async () => {
    const transport = new FakeTransport();
    const server = new FakeServer(undefined, () => transport.onclose?.());
    const runner = await startMcpStdio({
      createServer: () => server as unknown as McpServer,
      createTransport: () => transport,
    });

    await runner.finished;
    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });

  it("does not connect when stdin had already ended", async () => {
    const transport = new FakeTransport();
    const server = new FakeServer();
    const stdin = new FakeStdin(true);
    const runner = await startMcpStdio({
      createServer: () => server as unknown as McpServer,
      createTransport: () => transport,
      stdin,
    });

    await runner.finished;
    expect(server.connectCalls).toBe(0);
    expect(server.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
  });
});

class FakeServer {
  closeCalls = 0;
  connectCalls = 0;
  private transport: McpTransport | undefined;
  constructor(
    private readonly connectError?: Error,
    private readonly duringConnect?: () => void,
  ) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.transport?.close();
  }
  async connect(transport: McpTransport): Promise<void> {
    this.connectCalls += 1;
    this.transport = transport;
    this.duringConnect?.();
    if (this.connectError !== undefined) throw this.connectError;
  }
}

class FakeTransport implements McpTransport {
  closeCalls = 0;
  onclose?: () => void;
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/**
 * Mirrors the real @modelcontextprotocol/sdk stdio transport's observed shutdown
 * behaviour: `close()` invokes `onclose` synchronously (before its own first await),
 * from inside the same call stack a caller's `await transport.close()` is in.
 */
class SynchronouslyReentrantTransport implements McpTransport {
  closeCalls = 0;
  onclose?: () => void;
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

class FakeSignals {
  readonly listeners = new Map<string, () => void>();
  on(signal: string, listener: () => void): void {
    this.listeners.set(signal, listener);
  }
  off(signal: string): void {
    this.listeners.delete(signal);
  }
  emit(signal: string): void {
    this.listeners.get(signal)?.();
  }
}

class LeaseConnection implements DaemonConnection {
  closeCalls = 0;
  lastRequesterId: unknown;
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  onPush(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }
  async request(_type: string, payload: unknown): Promise<unknown> {
    this.lastRequesterId = (payload as { readonly requesterId?: unknown }).requesterId;
    return {
      device: {
        driverDeviceId: "SIM-1",
        spec: { model: "iPhone", osVersion: "26", platform: "ios" },
      },
      lease: { id: "lease-1", mode: "held", ttlDeadline: 10 },
      timing: {
        estimatedBootMs: 1,
        estimatedProvisionMs: 1,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 2,
      },
    };
  }
}

class FakeStdin {
  listener: (() => void) | undefined;
  constructor(readonly readableEnded = false) {}
  off(): void {
    this.listener = undefined;
  }
  once(_event: "end", listener: () => void): void {
    this.listener = listener;
  }
  end(): void {
    this.listener?.();
  }
}
