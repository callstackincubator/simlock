import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { SimlockError } from "../contract/index.js";
import {
  FakeClock,
  FakeHttpJsonClient,
  FakeParentWatch,
  FakeTcpListenerFactory,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
  MemoryFilesystem,
} from "../ports/index.js";
import type { SimlockAdminClient } from "../simlock-client/client.js";
import { runCli, type CliEnvironment } from "./index.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("CLI: simlock lease while it connects", () => {
  it.each([
    { trigger: "SIGINT", act: (signals: EventEmitter) => signals.emit("SIGINT") },
    { trigger: "SIGTERM", act: (signals: EventEmitter) => signals.emit("SIGTERM") },
    {
      trigger: "the exit of the --bind-pid process",
      act: (_signals: EventEmitter, parentWatch: FakeParentWatch) => parentWatch.exit(9876),
    },
  ])("sends no lease request and exits 0 on $trigger while it connects", async ({ act }) => {
    let stdout = "";
    let stderr = "";
    const signals = new EventEmitter();
    const parentWatch = new FakeParentWatch();
    let sentRequests = 0;
    const cancelled = () =>
      new SimlockError("CANCELLED", "domain", "Lease request was cancelled", {});
    const client = {
      onLeaseLost: () => () => {},
      onDeviceUnhealthy: () => () => {},
      onDeviceRecovered: () => () => {},
      onConnectionLost: () => () => {},
      close: async () => {},
      // why: The client's documented abort (ADR 0003 §10): a signal aborted before the call
      // rejects CANCELLED with nothing sent; any other call puts the request on the wire, where
      // only a later `lease.cancel` can reach it.
      requestLease: (_input: unknown, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted === true) return Promise.reject(cancelled());
        sentRequests += 1;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(cancelled()));
        });
      },
    } as unknown as SimlockAdminClient;
    let connected!: () => void;
    const connecting = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let connectStarted = false;
    const environment: CliEnvironment = {
      clock: new FakeClock(0),
      configPath: "/simlock/config.json",
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      requesterId: "test-requester",
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
      filesystem: new MemoryFilesystem(),
      connectAdmin: async () => {
        connectStarted = true;
        await connecting;
        return client;
      },
      connectExistingAdmin: async () => client,
      daemonEndpointPresent: async () => false,
      readAdminTokenFile: async () => undefined,
      sleep: async () => {},
      readConfigFile: async () => ({}),
      writeConfigFile: async () => {},
      validateConfig: async () => {},
      readLogFile: async () => "",
      readEventHistory: async () => [],
      signals: signals as unknown as CliEnvironment["signals"],
      parentWatch,
      parentPid: 4321,
      stderr: { write: (value: string) => (stderr += value) },
      stdout: { write: (value: string) => (stdout += value) },
      confirm: async () => true,
      webSocket: new FakeWebSocketClientConnector(),
      httpJson: new FakeHttpJsonClient(),
      tcpListeners: new FakeTcpListenerFactory(),
      tcpStreams: new FakeTcpStreamConnector(),
    };
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "9876"],
      environment,
    );
    await vi.waitFor(() => expect(connectStarted).toBe(true));

    act(signals, parentWatch);
    await settle();
    connected();

    const code = await run;
    expect(stderr).not.toContain("error");
    expect(code).toBe(0);
    expect(sentRequests).toBe(0);
    expect(stdout).toBe("");
  });
});
