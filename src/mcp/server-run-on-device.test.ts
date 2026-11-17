import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { SimlockError } from "../client/index.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { call, connectedServer, text, waitFor } from "./test-server.js";

describe("MCP run_on_device", () => {
  it("returns the command's stdout, stderr and exit code, run on the session's lease", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const cases = [
        {
          input: { args: ["listapps", "booted"], tool: "simctl" },
          chunks: [{ chunk: "com.x\n", stream: "stdout" as const }],
          exitCode: 0,
          expected: { exitCode: 0, stderr: "", stdout: "com.x\n", truncated: false },
        },
        {
          input: { args: ["install", "/b/App.app"], tool: "simctl" },
          chunks: [{ chunk: "no such file", stream: "stderr" as const }],
          exitCode: 3,
          expected: { exitCode: 3, stderr: "no such file", stdout: "", truncated: false },
        },
        {
          input: { args: ["shell", "cat"], stdin: "hello", tool: "adb" },
          chunks: [],
          exitCode: 0,
          expected: { exitCode: 0, stderr: "", stdout: "", truncated: false },
        },
      ];
      for (const entry of cases) {
        client.execImpl = (_input, options) => {
          for (const chunk of entry.chunks) options.onOutput?.(chunk);
          return Promise.resolve({ exitCode: entry.exitCode });
        };
        const result = await call(mcpClient, "run_on_device", entry.input);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(entry.expected);
        expect(client.calls.filter((c) => c.method === "exec").at(-1)?.input).toEqual({
          ...entry.input,
          leaseId: "lease-1",
        });
      }
    } finally {
      await close();
    }
  });
});

describe("MCP run_on_device output cap", () => {
  it("keeps the last 32768 characters of each stream and sets truncated when either lost any", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const cap = 32_768;
      const cases = [
        {
          chunks: [
            { chunk: "a".repeat(cap), stream: "stdout" as const },
            { chunk: "tail", stream: "stdout" as const },
          ],
          expected: {
            stderr: "",
            stdout: "a".repeat(cap - 4) + "tail",
            truncated: true,
          },
        },
        {
          chunks: [
            { chunk: "out", stream: "stdout" as const },
            { chunk: "b".repeat(cap + 1), stream: "stderr" as const },
          ],
          expected: { stderr: "b".repeat(cap), stdout: "out", truncated: true },
        },
        {
          chunks: [{ chunk: "c".repeat(cap), stream: "stdout" as const }],
          expected: { stderr: "", stdout: "c".repeat(cap), truncated: false },
        },
      ];
      for (const entry of cases) {
        client.execImpl = (_input, options) => {
          for (const chunk of entry.chunks) options.onOutput?.(chunk);
          return Promise.resolve({ exitCode: 0 });
        };
        const result = await call(mcpClient, "run_on_device", { args: [], tool: "adb" });
        expect(result.structuredContent).toEqual({ exitCode: 0, ...entry.expected });
      }
    } finally {
      await close();
    }
  });
});

describe("MCP run_on_device without a lease", () => {
  it("answers NO_LEASE with no daemon call when the session holds no lease", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    client.execImpl = () => Promise.resolve({ exitCode: 0 });
    const { mcpClient, close } = await connectedServer(client);
    const noLease = {
      code: "NO_LEASE",
      message: "This MCP session holds no lease. Call lease_simulator first.",
    };
    const run = () => call(mcpClient, "run_on_device", { args: [], tool: "simctl" });
    try {
      const never = await run();
      expect(never.isError).toBe(true);
      expect(JSON.parse(text(never))).toEqual(noLease);

      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      expect((await run()).isError).not.toBe(true);

      await call(mcpClient, "release_simulator", { leaseId: "lease-1" });
      expect(JSON.parse(text(await run()))).toEqual(noLease);

      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      expect((await run()).isError).not.toBe(true);
      client.emitLeaseLost({ deviceId: "SIM-1", leaseId: "lease-1", reason: "expired" });
      expect(JSON.parse(text(await run()))).toEqual(noLease);

      expect(client.calls.filter((entry) => entry.method === "exec")).toHaveLength(2);
    } finally {
      await close();
    }
  });
});

describe("MCP run_on_device daemon errors", () => {
  it("comes back as isError with the daemon's code and message", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    const { mcpClient, close } = await connectedServer(client);
    try {
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const refusal = new SimlockError(
        "PASSTHROUGH_REFUSED",
        "domain",
        "Refusing `simctl boot booted`: it names device booted.",
        { tool: "simctl" },
      );
      const cases = [
        refusal,
        new SimlockError("UNKNOWN_PASSTHROUGH_TOOL", "domain", "No driver wraps rm.", {
          tool: "rm",
        }),
        new SimlockError("EXEC_TIMEOUT", "domain", "The command ran past its time limit.", {}),
      ];
      for (const error of cases) {
        client.execImpl = () => Promise.reject(error);
        const result = await call(mcpClient, "run_on_device", { args: [], tool: "simctl" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(text(result))).toEqual({ code: error.code, message: error.message });
      }
    } finally {
      await close();
    }
  });
});

describe("MCP run_on_device progress", () => {
  it("sends progress at most once per second while output arrives and every 10 s while none does, only with a progress token", async () => {
    const client = new FakeSimlockClient();
    const grant = sampleGrant();
    client.requestLeaseImpl = () =>
      Promise.resolve({
        ...grant,
        lease: { ...grant.lease, ttlDeadline: 3_600_000, ttlMs: 3_600_000 },
      });
    const { clock, mcpClient, close } = await connectedServer(client);
    try {
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const install = ["install", "/b/App.app"];
      const cases = [
        {
          args: install,
          message: "Running simctl install",
          script: [
            { at: 0, chunk: true },
            { at: 400, chunk: true },
            { at: 900, chunk: true },
          ],
          token: true,
          notifications: 1,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [
            { at: 0, chunk: true },
            { at: 1500, chunk: true },
          ],
          token: true,
          notifications: 2,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [{ at: 25_000, chunk: false }],
          token: true,
          notifications: 2,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [
            { at: 0, chunk: true },
            { at: 1000, chunk: true },
          ],
          token: true,
          notifications: 2,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [{ at: 9_999, chunk: false }],
          token: true,
          notifications: 0,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [{ at: 10_000, chunk: false }],
          token: true,
          notifications: 1,
        },
        {
          args: install,
          message: "Running simctl install",
          script: [
            { at: 0, chunk: true },
            { at: 5000, chunk: true },
            { at: 12_000, chunk: false },
          ],
          token: true,
          notifications: 2,
        },
        {
          args: [],
          message: "Running simctl",
          script: [{ at: 0, chunk: true }],
          token: true,
          notifications: 1,
        },
        {
          args: install,
          message: "",
          script: [
            { at: 0, chunk: true },
            { at: 1500, chunk: true },
            { at: 25_000, chunk: false },
          ],
          token: false,
          notifications: 0,
        },
      ];
      for (const entry of cases) {
        let emit: ((chunk: { stream: "stdout"; chunk: string }) => void) | undefined;
        let finish: (() => void) | undefined;
        client.execImpl = (_input, options) =>
          new Promise((resolve) => {
            emit = (chunk) => options.onOutput?.(chunk);
            finish = () => resolve({ exitCode: 0 });
          });
        const events: Array<{
          message?: string | undefined;
          progress: number;
          total?: number | undefined;
        }> = [];
        const unexpected: Error[] = [];
        mcpClient.onerror = (error) => unexpected.push(error);
        const pending = mcpClient.request(
          {
            method: "tools/call",
            params: { arguments: { args: entry.args, tool: "simctl" }, name: "run_on_device" },
          },
          CallToolResultSchema,
          entry.token ? { onprogress: (progress) => events.push(progress) } : undefined,
        );
        await waitFor(() => emit !== undefined);
        let elapsed = 0;
        for (const step of entry.script) {
          clock.advance(step.at - elapsed);
          elapsed = step.at;
          if (step.chunk) emit?.({ chunk: "x", stream: "stdout" });
        }
        finish?.();
        await pending;
        // why: a notification the server sends without a token, or after the call ended, reaches
        // the client as an error for an unknown token.
        clock.advance(30_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unexpected).toEqual([]);
        expect(events.map((event) => event.progress)).toEqual(
          Array.from({ length: entry.notifications }, (_, index) => index + 1),
        );
        for (const event of events) {
          expect(event.message).toBe(entry.message);
          expect(event.total).toBeUndefined();
        }
      }
    } finally {
      await close();
    }
  });
});

describe("MCP run_on_device alongside other tools", () => {
  it("lets lease_status answer while the command is still running", async () => {
    const client = new FakeSimlockClient();
    const grant = sampleGrant();
    client.requestLeaseImpl = () => Promise.resolve(grant);
    client.listLeasesImpl = () =>
      Promise.resolve({
        leases: [{ ...grant.lease, deviceId: grant.device.id }],
      });
    let finish: (() => void) | undefined;
    client.execImpl = () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0 });
      });
    const { mcpClient, close } = await connectedServer(client);
    try {
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const running = call(mcpClient, "run_on_device", { args: [], tool: "simctl" });
      await waitFor(() => finish !== undefined);
      const status = await call(mcpClient, "lease_status", {});
      expect(status.structuredContent).toMatchObject({ held: true, id: "lease-1" });
      finish?.();
      expect((await running).structuredContent).toMatchObject({ exitCode: 0 });
    } finally {
      await close();
    }
  });
});
