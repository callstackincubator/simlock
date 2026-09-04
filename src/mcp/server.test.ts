import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";
import {
  leaseSimulatorOutputSchema,
  leaseStatusOutputSchema,
  listDevicesOutputSchema,
  releaseSimulatorOutputSchema,
} from "./contracts.js";
import { McpSession } from "./session.js";
import { createMcpServer } from "./server.js";

const grant = {
  device: {
    driverDeviceId: "SIM-1",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" as const },
  },
  lease: { id: "lease-1", mode: "held" as const, ttlDeadline: 12_345 },
  timing: {
    estimatedBootMs: 3,
    estimatedProvisionMs: 2,
    estimatedReclaimMs: 1,
    estimatedReadyMs: 6,
  },
};

const catalog = {
  platforms: [
    {
      defaultRuntime: "26.5",
      models: ["iPhone 17 Pro"],
      platform: "ios" as const,
      runtimes: ["26.5"],
    },
  ],
};

describe("MCP server", () => {
  it("advertises exactly the lease, catalog, and status tools and returns dual schema-valid results", async () => {
    const connection = new StubConnection([grant, catalog, { leaseId: "lease-1" }]);
    const { client, close } = await connectedServer(connection);
    try {
      const listed = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "lease_simulator",
        "list_devices",
        "release_simulator",
        "lease_status",
      ]);
      for (const tool of listed.tools) {
        expect(tool.title).toEqual(expect.any(String));
        expect(tool.description).toEqual(expect.any(String));
        expect(tool.inputSchema).toEqual(expect.any(Object));
        expect(tool.outputSchema).toEqual(expect.any(Object));
      }

      const noLease = await call(client, "lease_status", {});
      expect(noLease.isError).not.toBe(true);
      leaseStatusOutputSchema.parse(noLease.structuredContent);
      expect(noLease.structuredContent).toEqual({ held: false });

      const lease = await call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);
      leaseSimulatorOutputSchema.parse(lease.structuredContent);
      expect(lease.structuredContent).toMatchObject({ lease_id: "lease-1", mode: "held" });
      expect(JSON.parse(text(lease))).toEqual(lease.structuredContent);

      const devices = await call(client, "list_devices", {});
      expect(devices.isError).not.toBe(true);
      listDevicesOutputSchema.parse(devices.structuredContent);
      expect(devices.structuredContent).toEqual({
        platforms: [
          {
            default_runtime: "26.5",
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
      });
      expect(JSON.parse(text(devices))).toEqual(devices.structuredContent);

      const held = await call(client, "lease_status", {});
      expect(held.isError).not.toBe(true);
      leaseStatusOutputSchema.parse(held.structuredContent);
      expect(held.structuredContent).toEqual({
        device: "iPhone 17 Pro",
        device_id: "SIM-1",
        expires_at_ms: 12_345,
        held: true,
        lease_id: "lease-1",
        os: "26.5",
        platform: "ios",
        state: "leased",
      });

      const release = await call(client, "release_simulator", { lease_id: "lease-1" });
      expect(release.isError).not.toBe(true);
      releaseSimulatorOutputSchema.parse(release.structuredContent);
      expect(release.structuredContent).toEqual({ lease_id: "lease-1", released: true });
      expect(JSON.parse(text(release))).toEqual(release.structuredContent);

      const afterRelease = await call(client, "lease_status", {});
      expect(afterRelease.structuredContent).toEqual({ held: false });
    } finally {
      await close();
    }
  });

  it("relays a daemon lease-lost push as an MCP logging notification and forgets the lease", async () => {
    const connection = new StubConnection([grant]);
    const { client, close, session } = await connectedServer(connection);
    try {
      const notifications: unknown[] = [];
      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        notifications.push(notification.params);
      });

      const lease = await call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);

      connection.pushLeaseLost({ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" });
      await expect
        .poll(() => notifications)
        .toEqual([
          {
            data: {
              device_id: "SIM-1",
              lease_id: "lease-1",
              message: "Simlock lease ended; this session no longer holds the device.",
              reason: "expired",
            },
            level: "warning",
            logger: "simlock",
          },
        ]);

      expect(session.status()).toEqual({ held: false });
      const releaseAfterLost = await call(client, "release_simulator", { lease_id: "lease-1" });
      expect(releaseAfterLost.isError).toBe(true);
      expect(JSON.parse(text(releaseAfterLost))).toEqual({
        code: "LEASE_NOT_OWNED",
        message: "This session does not own that lease",
      });
    } finally {
      await close();
    }
  });

  it("relays device-unhealthy and device-recovered pushes as MCP logging notifications, keeping the lease held", async () => {
    const connection = new StubConnection([grant]);
    const { client, close, session } = await connectedServer(connection);
    try {
      const notifications: unknown[] = [];
      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        notifications.push(notification.params);
      });

      const lease = await call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);

      connection.pushDeviceUnhealthy({ deviceId: "SIM-1", leaseId: "lease-1", reason: "crashed" });
      connection.pushDeviceRecovered({ attempts: 2, deviceId: "SIM-1", leaseId: "lease-1" });
      await expect.poll(() => notifications).toHaveLength(2);

      expect(notifications).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            device_id: "SIM-1",
            lease_id: "lease-1",
            reason: "crashed",
          }),
          level: "warning",
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            attempts: 2,
            device_id: "SIM-1",
            lease_id: "lease-1",
          }),
          level: "info",
        }),
      ]);

      // The lease is still owned: unlike a lease-lost push, device health notices never
      // clear it.
      expect(session.status()).toMatchObject({ held: true, lease_id: "lease-1" });
    } finally {
      await close();
    }
  });

  it("relays queued/provisioning/booting/reclaiming progress as notifications/progress when a token is supplied", async () => {
    const deferredGrant = deferredResponse();
    const connection = new StubConnection([deferredGrant.promise]);
    const { client, close } = await connectedServer(connection);
    try {
      const progressEvents: unknown[] = [];
      const leaseCall = client.request(
        {
          method: "tools/call",
          params: {
            arguments: { device: "iPhone 17 Pro", platform: "ios" },
            name: "lease_simulator",
          },
        },
        CallToolResultSchema,
        { onprogress: (progress) => progressEvents.push(progress) },
      );
      await waitFor(() => connection.calls.length === 1);

      connection.pushProgress({ queuePosition: 2, stage: "queued" });
      connection.pushProgress({ etaMs: 9_000, stage: "provisioning" });
      connection.pushProgress({ etaMs: 4_000, stage: "booting" });
      connection.pushProgress({ etaMs: 1_000, stage: "reclaiming" });
      await waitFor(() => progressEvents.length === 4);

      expect(progressEvents).toEqual([
        expect.objectContaining({ message: "Queued behind 2 other requests" }),
        expect.objectContaining({ message: "Provisioning device (~9s remaining)" }),
        expect.objectContaining({ message: "Booting device (~4s remaining)" }),
        expect.objectContaining({ message: "Reclaiming device (~1s remaining)" }),
      ]);
      const values = progressEvents.map((event) => (event as { progress: number }).progress);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(new Set(values).size).toBe(values.length);

      deferredGrant.resolve(grant);
      const lease = await leaseCall;
      expect(lease.isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("emits nothing when the client supplied no progress token", async () => {
    const deferredGrant = deferredResponse();
    const connection = new StubConnection([deferredGrant.promise]);
    const { client, close } = await connectedServer(connection);
    try {
      const progressEvents: unknown[] = [];
      client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        progressEvents.push(notification.params);
      });

      const leaseCall = call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      await waitFor(() => connection.calls.length === 1);

      connection.pushProgress({ queuePosition: 1, stage: "queued" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(progressEvents).toEqual([]);

      deferredGrant.resolve(grant);
      await leaseCall;
      expect(progressEvents).toEqual([]);
    } finally {
      await close();
    }
  });

  it("forwards the platform filter for list_devices and never triggers a lease request", async () => {
    const connection = new StubConnection([catalog]);
    const { client, close } = await connectedServer(connection);
    try {
      const devices = await call(client, "list_devices", { platform: "ios" });
      expect(devices.isError).not.toBe(true);
      expect(connection.calls).toEqual([{ payload: { platform: "ios" }, type: "catalog.get" }]);
    } finally {
      await close();
    }
  });

  it("returns stable, sanitized errors without invalid structured output", async () => {
    const connection = new StubConnection([
      new DaemonClientError("NO_CAPACITY", "No matching devices are available"),
      new Error("/private/secret-stack-path"),
    ]);
    const { client, close } = await connectedServer(connection);
    try {
      const expected = await call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(expected).toMatchObject({ isError: true });
      expect(JSON.parse(text(expected))).toEqual({
        code: "NO_CAPACITY",
        message: "No matching devices are available",
      });
      expect(expected.structuredContent).toBeUndefined();

      const unexpected = await call(client, "lease_simulator", {
        device: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(JSON.parse(text(unexpected))).toEqual({
        code: "INTERNAL",
        message: "Simlock could not complete the request",
      });
      expect(text(unexpected)).not.toContain("private");
    } finally {
      await close();
    }
  });

  it("rejects invalid tool arguments through the registered schema", async () => {
    const { client, close } = await connectedServer(new StubConnection([]));
    try {
      const result = await call(client, "lease_simulator", { device: "", platform: "desktop" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Input validation error");
    } finally {
      await close();
    }
  });
});

async function connectedServer(connection: StubConnection) {
  const session = new McpSession({ connect: async () => connection, requesterId: "mcp-test" });
  const server = createMcpServer(session);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close(), session.close()]);
    },
    session,
  };
}

function call(client: Client, name: string, arguments_: Record<string, unknown>) {
  return client.request(
    { method: "tools/call", params: { arguments: arguments_, name } },
    CallToolResultSchema,
  );
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) throw new Error("Expected text result");
  return first.text;
}

function deferredResponse(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}

class StubConnection implements DaemonConnection {
  closeCalls = 0;
  readonly calls: Array<{ readonly payload: unknown; readonly type: string }> = [];
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  constructor(private readonly responses: unknown[]) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(): () => void {
    return () => undefined;
  }
  pushLeaseLost(payload: {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly reason: string;
  }): void {
    for (const listener of this.#listeners) listener("lease-lost", payload);
  }

  /** Wraps the given stage payload under `{requestId, progress}` -- ADR 0003 §8's push
   * correlation shape -- so callers can keep passing the bare stage object. */
  pushProgress(payload: unknown): void {
    for (const listener of this.#listeners)
      listener("progress", { progress: payload, requestId: "test-request" });
  }

  pushDeviceUnhealthy(payload: unknown): void {
    for (const listener of this.#listeners) listener("device-unhealthy", payload);
  }

  pushDeviceRecovered(payload: unknown): void {
    for (const listener of this.#listeners) listener("device-recovered", payload);
  }
  async request(type: string, payload: unknown): Promise<unknown> {
    this.calls.push({ payload, type });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }
}
