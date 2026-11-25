import {
  CallToolResultSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { FakeSimlockClient, sampleGrant, startingStatus } from "./test-support.js";
import { leaseSimulatorInputSchema } from "./contracts.js";
import { call, connectedServer, text, waitFor } from "./test-server.js";

describe("MCP server (smoke)", () => {
  it("advertises exactly the lease, catalog, status, run_on_device and rotate_device tools, and walks lease -> list -> status -> release", async () => {
    const client = new FakeSimlockClient();
    const grant = sampleGrant();
    client.requestLeaseImpl = () => Promise.resolve(grant);
    client.getCatalogImpl = () =>
      Promise.resolve({
        platforms: [
          {
            defaultRuntime: "26.5",
            modelAliases: {},
            classDefaults: {},
            modelClasses: {},
            modelRuntimes: { "iPhone 17 Pro": ["26.5"] },
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
      });
    client.getStatusImpl = () => Promise.resolve(startingStatus());
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
                ownerId: grant.lease.ownerId,
                requesterId: grant.lease.requesterId,
                lastRenewedAt: grant.lease.grantedAt,
                idChosenByRequester: false,
                ttlMs: 60_000,
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
        "run_on_device",
        "rotate_device",
      ]);
      const listDescription = tools.tools.find((tool) => tool.name === "list_devices")?.description;
      expect(listDescription).toContain("modelClasses");
      expect(listDescription).toContain("physicalDevices");
      expect(listDescription).toContain("empty while the daemon is still starting");
      const leaseTool = tools.tools.find((tool) => tool.name === "lease_simulator");
      expect(Object.keys(leaseTool?.inputSchema.properties ?? {}).sort()).toEqual(
        Object.keys(leaseSimulatorInputSchema.shape).sort(),
      );
      expect(Object.keys(leaseTool?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["platform", "model", "class"]),
      );
      const runTool = tools.tools.find((tool) => tool.name === "run_on_device");
      expect(Object.keys(runTool?.inputSchema.properties ?? {}).sort()).toEqual([
        "args",
        "stdin",
        "tool",
      ]);
      const rotateTool = tools.tools.find((tool) => tool.name === "rotate_device");
      expect(Object.keys(rotateTool?.inputSchema.properties ?? {})).toEqual(["orientation"]);
      expect(runTool?.description).toBe(
        "Run one simctl, adb or devicectl command on this session's leased device, on the machine that holds it. Leave the device out: Simlock fills in the lease's UDID or serial, and refuses a command that names another device. File paths are on that machine. Output is text: stdout and stderr each keep their last 32768 characters, and truncated says when any was cut. A non-zero exitCode is the command's own answer, not a tool error. There is no terminal: a bare adb shell is refused, and an interactive command hangs until the time limit (10 minutes by default) stops it.",
      );
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toEqual(expect.any(Object));
        expect(tool.outputSchema).toEqual(expect.any(Object));
      }

      const lease = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
      });
      expect(lease.isError).not.toBe(true);
      expect(lease.structuredContent).toMatchObject({ lease: { id: "lease-1" } });

      const devices = await call(mcpClient, "list_devices", {});
      expect(devices.isError).not.toBe(true);
      expect(devices.structuredContent).toEqual({
        platforms: [
          {
            defaultRuntime: "26.5",
            modelAliases: {},
            classDefaults: {},
            modelClasses: {},
            modelRuntimes: { "iPhone 17 Pro": ["26.5"] },
            models: ["iPhone 17 Pro"],
            platform: "ios",
            runtimes: ["26.5"],
          },
        ],
        physicalDevices: [],
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

  it("the MCP lease tool passes leaseId through", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant({ leaseId: "ad-7f3a" }));
    const { mcpClient, close } = await connectedServer(client);
    try {
      const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
      const leaseTool = tools.tools.find((tool) => tool.name === "lease_simulator");
      expect(Object.keys(leaseTool?.inputSchema.properties ?? {})).toContain("leaseId");

      const lease = await call(mcpClient, "lease_simulator", {
        leaseId: "ad-7f3a",
        model: "iPhone 17 Pro",
        platform: "ios",
      });

      expect(lease.isError).not.toBe(true);
      expect(client.calls[0]).toMatchObject({
        input: { leaseId: "ad-7f3a", model: "iPhone 17 Pro", platform: "ios" },
        method: "requestLease",
      });
    } finally {
      await close();
    }
  });

  it("the lease tool's input schema in tools/list lists noWait and physical, and has no fleetRequestId, no metadata and no runId, and a call naming runId is refused", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
      const leaseTool = tools.tools.find((tool) => tool.name === "lease_simulator");
      const properties = Object.keys(leaseTool?.inputSchema.properties ?? {});

      expect(properties).toContain("noWait");
      expect(properties).not.toContain("fleetRequestId");
      expect(properties).not.toContain("metadata");
      expect(properties).not.toContain("runId");
      expect(properties).toContain("physical");

      const tagged = await call(mcpClient, "lease_simulator", {
        model: "iPhone 17 Pro",
        platform: "ios",
        runId: "123-1",
      });
      expect(tagged.isError).toBe(true);
      expect(client.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("the lease tool lists label and sends the label a call names, and none when it names none", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
      const leaseTool = tools.tools.find((tool) => tool.name === "lease_simulator");
      expect(Object.keys(leaseTool?.inputSchema.properties ?? {})).toContain("label");

      const ask = { model: "iPhone 17 Pro", platform: "ios" } as const;
      expect(
        (await call(mcpClient, "lease_simulator", { ...ask, label: "feature-x" })).isError,
      ).not.toBe(true);
      const sent = client.calls.filter((entry) => entry.method === "requestLease");
      expect(sent[0]?.input).toMatchObject({ label: "feature-x" });
      await call(mcpClient, "release_simulator", { leaseId: "lease-1" });
      expect((await call(mcpClient, "lease_simulator", ask)).isError).not.toBe(true);
      const again = client.calls.filter((entry) => entry.method === "requestLease");
      expect(again[1]?.input).not.toHaveProperty("label");
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

  it.each([
    [
      "lease_simulator",
      { model: "iPhone 17 Pro", platform: "ios" },
      { model: 7, platform: "ios" },
      "requestLease",
    ],
    ["list_devices", {}, { platform: 7 }, "getCatalog", "getStatus"],
    ["release_simulator", { leaseId: "lease-1" }, { leaseId: 7 }, "releaseLease"],
    ["lease_status", {}, undefined, "listLeases"],
  ] as const)(
    "%s reaches the client with a valid input, and a wrong-type input is refused through the registered schema before touching the client",
    async (tool, valid, wrong, ...methods) => {
      const client = new FakeSimlockClient();
      client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
      client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
      client.getStatusImpl = () => Promise.resolve(startingStatus());
      client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
      client.listLeasesImpl = () => Promise.resolve({ leases: [] });
      const { mcpClient, close } = await connectedServer(client);
      try {
        const ok = await call(mcpClient, tool, valid);
        expect(ok.isError).not.toBe(true);
        expect(client.calls.map((entry) => entry.method)).toEqual(methods);

        if (wrong === undefined) return;
        client.calls.length = 0;
        const refused = await call(mcpClient, tool, wrong);
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("Input validation error");
        expect(client.calls).toEqual([]);
      } finally {
        await close();
      }
    },
  );

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

  it("describes the three ways lease_simulator names a device", async () => {
    const { mcpClient, close } = await connectedServer(new FakeSimlockClient());
    try {
      const { tools } = await mcpClient.listTools();

      const description = tools.find((tool) => tool.name === "lease_simulator")?.description;
      expect(description).toContain("`model`");
      expect(description).toContain("`class`");
      expect(description).toContain("neither");
    } finally {
      await close();
    }
  });

  it("refuses a lease_simulator call naming both a class and a model, the message naming both fields, before asking", async () => {
    const client = new FakeSimlockClient();
    const { mcpClient, close } = await connectedServer(client);
    try {
      const result = await call(mcpClient, "lease_simulator", {
        class: "phone",
        model: "iPhone 17 Pro",
        platform: "ios",
      });

      expect(result.isError).toBe(true);
      const refusal = JSON.parse(text(result)) as { code: string; message: string };
      expect(refusal.code).toBe("BAD_REQUEST");
      expect(refusal.message).toContain("`model`");
      expect(refusal.message).toContain("`class`");
      expect(client.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it.each([
    ["a class", { class: "watch", platform: "ios" }],
    ["only a platform", { platform: "android" }],
  ])("passes a lease_simulator call naming %s on with no model", async (_label, args) => {
    const client = new FakeSimlockClient();
    const inputs: unknown[] = [];
    client.requestLeaseImpl = (input) => {
      inputs.push(input);
      return Promise.resolve(sampleGrant());
    };
    const { mcpClient, close } = await connectedServer(client);
    try {
      const result = await call(mcpClient, "lease_simulator", args);

      expect(result.isError).not.toBe(true);
      expect(inputs).toEqual([args]);
    } finally {
      await close();
    }
  });

  it("passes lease_simulator's imageTag and baseline to the lease request, and refuses one outside the allowed characters before asking", async () => {
    const client = new FakeSimlockClient();
    const inputs: unknown[] = [];
    client.requestLeaseImpl = (input) => {
      inputs.push(input);
      return Promise.resolve(sampleGrant());
    };
    const { mcpClient, close } = await connectedServer(client);
    try {
      const call = (imageTag: string, baseline?: string) =>
        mcpClient.request(
          {
            method: "tools/call",
            params: {
              arguments: {
                ...(baseline === undefined ? {} : { baseline }),
                imageTag,
                model: "Pixel 8",
                platform: "android",
              },
              name: "lease_simulator",
            },
          },
          CallToolResultSchema,
        );

      const granted = await call("google_apis_playstore", "checkout");
      const refused = await call("google apis").catch((error: unknown) => error);

      expect(granted.isError).not.toBe(true);
      expect(inputs).toEqual([
        expect.objectContaining({ baseline: "checkout", imageTag: "google_apis_playstore" }),
      ]);
      expect(refused).toSatisfy(
        (result: unknown) =>
          result instanceof Error || (result as { isError?: boolean }).isError === true,
      );
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

  it("relays the downloading stage as a notification naming the component, above queued and below provisioning, and never going down across queued, downloading, provisioning, booting", async () => {
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
            arguments: { allowDownload: true, model: "iPhone 17 Pro", platform: "ios" },
            name: "lease_simulator",
          },
        },
        CallToolResultSchema,
        { onprogress: (progress) => progressEvents.push(progress) },
      );
      await waitFor(() => onProgress !== undefined);

      onProgress!({ queuePosition: 2, stage: "queued" });
      onProgress!({ component: "26.4", stage: "downloading", waiting: true });
      onProgress!({ component: "26.4", stage: "downloading", waiting: false });
      // why: Each stage at its highest value, then the next at its lowest: a stage whose base did not
      // sit above the one before would land at or under it, and be lifted by one.
      onProgress!({ component: "26.4", percent: 100, stage: "downloading", waiting: false });
      onProgress!({ etaMs: 0, stage: "provisioning" });
      onProgress!({ etaMs: 600_000, stage: "booting" });
      await waitFor(() => progressEvents.length === 6);

      expect(progressEvents).toEqual([
        expect.objectContaining({ message: "Queued behind 2 other requests" }),
        expect.objectContaining({
          message: "Waiting for another download before downloading 26.4",
        }),
        expect.objectContaining({ message: "Downloading 26.4" }),
        expect.objectContaining({ message: "Downloading 26.4 (100%)" }),
        expect.objectContaining({ message: expect.stringMatching(/^Provisioning device/) }),
        expect.objectContaining({ message: expect.stringMatching(/^Booting device/) }),
      ]);
      const values = progressEvents.map((event) => (event as { progress: number }).progress);
      const [queued, waiting, started, percent, provisioning, booting] = values as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // why: The reporter lifts a value that would go down to one above the last, so a gap wider than
      // one is the stage's own placement, not that lift.
      expect(waiting - queued).toBeGreaterThan(1);
      expect(percent - started).toBeGreaterThan(1);
      expect(provisioning - percent).toBeGreaterThan(1);
      expect(booting - provisioning).toBeGreaterThan(1);
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
