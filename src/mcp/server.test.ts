import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { SimlockError } from "../client/index.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { McpSession } from "./session.js";
import { createMcpServer } from "./server.js";

describe("MCP server (smoke)", () => {
  it("advertises exactly the lease, catalog, and status tools, and walks lease -> list -> status -> release", async () => {
    const client = new FakeSimlockClient();
    const grant = sampleGrant();
    client.requestLeaseImpl = () => Promise.resolve(grant);
    client.getCatalogImpl = () =>
      Promise.resolve({
        platforms: [
          {
            defaultRuntime: "26.5",
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
      });
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    let listed = false;
    client.listLeasesImpl = () => {
      const wasListed = listed;
      listed = true;
      return Promise.resolve({
        leases: wasListed
          ? []
          : [
              {
                deviceId: grant.device.id,
                grantedAt: grant.lease.grantedAt,
                id: grant.lease.id,
                mode: grant.lease.mode,
                ownerId: grant.lease.ownerId,
                requesterId: grant.lease.requesterId,
                ttlDeadline: grant.lease.ttlDeadline,
              },
            ],
      });
    };
    const { mcpClient, close } = await connectedServer(client);
    try {
      const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "lease_simulator",
        "list_devices",
        "release_simulator",
        "lease_status",
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toEqual(expect.any(Object));
        expect(tool.outputSchema).toEqual(expect.any(Object));
      }

      const lease = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);
      expect(lease.structuredContent).toMatchObject({ lease: { id: "lease-1", mode: "held" } });

      const devices = await call(mcpClient, "list_devices", {});
      expect(devices.isError).not.toBe(true);
      expect(devices.structuredContent).toEqual({
        platforms: [
          {
            defaultRuntime: "26.5",
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
      });

      const status = await call(mcpClient, "lease_status", {});
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ held: true, id: "lease-1" });

      const release = await call(mcpClient, "release_simulator", { leaseId: "lease-1" });
      expect(release.isError).not.toBe(true);
      expect(release.structuredContent).toEqual({ leaseId: "lease-1", released: true });

      const afterRelease = await call(mcpClient, "lease_status", {});
      expect(afterRelease.structuredContent).toEqual({ held: false });
    } finally {
      await close();
    }
  });

  it("surfaces a daemon FORBIDDEN as-is when releasing a lease this session does not own -- no client-side pre-check", async () => {
    const client = new FakeSimlockClient();
    client.releaseLeaseImpl = () =>
      Promise.reject(new SimlockError("FORBIDDEN", "protocol", "not your lease", {}));
    const { mcpClient, close } = await connectedServer(client);
    try {
      const result = await call(mcpClient, "release_simulator", { leaseId: "not-mine" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result))).toEqual({ code: "FORBIDDEN", message: "not your lease" });
    } finally {
      await close();
    }
  });

  it("sanitizes an unexpected error without leaking its message", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.reject(new Error("/private/secret-stack-path"));
    const { mcpClient, close } = await connectedServer(client);
    try {
      const result = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result))).toEqual({
        code: "INTERNAL",
        message: "Simlock could not complete the request",
      });
      expect(text(result)).not.toContain("private");
    } finally {
      await close();
    }
  });

  it("rejects invalid tool arguments through the registered schema before touching the client", async () => {
    const client = new FakeSimlockClient();
    const { mcpClient, close } = await connectedServer(client);
    try {
      const result = await call(mcpClient, "lease_simulator", { model: "", platform: "desktop" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Input validation error");
      expect(client.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("relays a lease-lost push as an MCP logging notification (MCP-only relay)", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      const notifications: unknown[] = [];
      mcpClient.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        notifications.push(notification.params);
      });

      const lease = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);

      client.emitLeaseLost({ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" });
      await expect
        .poll(() => notifications)
        .toEqual([
          {
            data: {
              deviceId: "SIM-1",
              leaseId: "lease-1",
              message: "Simlock lease ended; this session no longer holds the device.",
              reason: "expired",
            },
            level: "warning",
            logger: "simlock",
          },
        ]);
    } finally {
      await close();
    }
  });

  it("relays device-unhealthy and device-recovered pushes as MCP logging notifications (MCP-only relay)", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      const notifications: unknown[] = [];
      mcpClient.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        notifications.push(notification.params);
      });

      const lease = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);

      client.emitDeviceUnhealthy({ deviceId: "SIM-1", leaseId: "lease-1" });
      client.emitDeviceRecovered({ attempts: 2, deviceId: "SIM-1", leaseId: "lease-1" });
      await expect.poll(() => notifications).toHaveLength(2);

      expect(notifications).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ deviceId: "SIM-1", leaseId: "lease-1" }),
          level: "warning",
        }),
        expect.objectContaining({
          data: expect.objectContaining({ attempts: 2, deviceId: "SIM-1", leaseId: "lease-1" }),
          level: "info",
        }),
      ]);
    } finally {
      await close();
    }
  });

  it("relays queued/provisioning/booting/reclaiming progress as notifications/progress when a token is supplied (MCP-only relay)", async () => {
    const client = new FakeSimlockClient();
    let onProgress: ((progress: unknown) => void) | undefined;
    let resolveGrant!: (grant: ReturnType<typeof sampleGrant>) => void;
    const grantPromise = new Promise<ReturnType<typeof sampleGrant>>((resolve) => {
      resolveGrant = resolve;
    });
    client.requestLeaseImpl = (_input, options) => {
      onProgress = options.onProgress as ((progress: unknown) => void) | undefined;
      return grantPromise;
    };
    const { mcpClient, close } = await connectedServer(client);
    try {
      const progressEvents: unknown[] = [];
      const leaseCall = mcpClient.request(
        {
          method: "tools/call",
          params: {
            arguments: { model: "iPhone 17 Pro", platform: "ios" },
            name: "lease_simulator",
          },
        },
        CallToolResultSchema,
        { onprogress: (progress) => progressEvents.push(progress) },
      );
      await waitFor(() => onProgress !== undefined);

      onProgress!({ queuePosition: 2, stage: "queued" });
      onProgress!({ etaMs: 9_000, stage: "provisioning" });
      onProgress!({ etaMs: 4_000, stage: "booting" });
      onProgress!({ etaMs: 1_000, stage: "reclaiming" });
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

      resolveGrant(sampleGrant());
      const lease = await leaseCall;
      expect(lease.isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("emits nothing when the client supplied no progress token (MCP-only relay)", async () => {
    const client = new FakeSimlockClient();
    let onProgress: ((progress: unknown) => void) | undefined;
    client.requestLeaseImpl = (_input, options) => {
      onProgress = options.onProgress as ((progress: unknown) => void) | undefined;
      return Promise.resolve(sampleGrant());
    };
    const { mcpClient, close } = await connectedServer(client);
    try {
      const progressEvents: unknown[] = [];
      mcpClient.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        progressEvents.push(notification.params);
      });

      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      expect(onProgress).toBeUndefined();
      expect(progressEvents).toEqual([]);
    } finally {
      await close();
    }
  });
});

async function connectedServer(client: FakeSimlockClient) {
  const session = new McpSession({ clock: new FakeClock(), connect: async () => client });
  const server = createMcpServer(session);
  const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return {
    close: async () => {
      await Promise.all([mcpClient.close(), server.close(), session.close()]);
    },
    mcpClient,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}
