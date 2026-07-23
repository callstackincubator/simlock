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
});

class FakeServer {
  closeCalls = 0;
  constructor(private readonly connectError?: Error) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  async connect(): Promise<void> {
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
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  onPush(): () => void {
    return () => undefined;
  }
  async request(): Promise<unknown> {
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
