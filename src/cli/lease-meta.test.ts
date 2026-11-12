import { describe, expect, it } from "vitest";

import type { LeaseGrant } from "../admin/index.js";
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

const grant = {
  device: { id: "device-1", driverDeviceId: "ABCD", mode: "full", physical: false, spec: {} },
  environment: {},
  lease: { id: "lse_meta", ttlDeadline: 61_000, ttlMs: 60_000 },
  timing: {},
} as unknown as LeaseGrant;

function run(argv: readonly string[], sent: unknown[]) {
  let stderr = "";
  const client = {
    close: async () => {},
    onConnectionLost: () => () => {},
    onDeviceRecovered: () => () => {},
    onDeviceUnhealthy: () => () => {},
    onLeaseLost: () => () => {},
    requestLease: async (input: unknown) => {
      sent.push(input);
      return grant;
    },
  } as unknown as SimlockAdminClient;
  const environment: CliEnvironment = {
    clock: new FakeClock(0),
    configPath: "/simlock/config.json",
    confirm: async () => true,
    connectAdmin: async () => client,
    connectExistingAdmin: async () => client,
    daemonEndpointPresent: async () => false,
    daemonHome: { dataDirectory: "/simlock", gatewayPresent: false, role: "worker" },
    filesystem: new MemoryFilesystem(),
    homeDirectory: "/home/operator",
    hostPlatform: "linux",
    httpJson: new FakeHttpJsonClient(),
    parentPid: 4321,
    parentWatch: new FakeParentWatch(),
    readAdminTokenFile: async () => undefined,
    readConfigFile: async () => ({}),
    readEventHistory: async () => [],
    readLogFile: async () => "",
    requesterId: "test-requester",
    runTool: async () => ({ outcome: "not-found" }),
    signals: { on: () => {}, off: () => {} } as unknown as CliEnvironment["signals"],
    sleep: async () => {},
    stderr: { write: (value: string) => (stderr += value) },
    stdout: { write: () => true },
    tcpListeners: new FakeTcpListenerFactory(),
    tcpStreams: new FakeTcpStreamConnector(),
    validateConfig: async () => {},
    webSocket: new FakeWebSocketClientConnector(),
    workingDirectory: "/work/project",
    writeConfigFile: async () => {},
  };
  return runCli(["lease", "--platform", "ios", ...argv], environment).then((code) => ({
    code,
    stderr,
  }));
}

describe("CLI: simlock lease --meta", () => {
  it("a caller's --meta flags become the request's metadata", async () => {
    const cases = [
      {
        argv: ["--meta", "project=checkout-app", "--meta", "role=ci"],
        metadata: { project: "checkout-app", role: "ci" },
      },
      { argv: ["--meta", "query=a=b=c"], metadata: { query: "a=b=c" } },
      { argv: ["--meta", "role=ci", "--meta", "role=dev"], metadata: { role: "dev" } },
      { argv: [], metadata: undefined },
    ] as const;
    for (const { argv, metadata } of cases) {
      const sent: Array<{ metadata?: unknown }> = [];
      const { code } = await run(["--detach", ...argv], sent);
      expect(code, argv.join(" ")).toBe(0);
      expect(sent[0]?.metadata, argv.join(" ")).toEqual(metadata);
    }

    const sent: unknown[] = [];
    const refused = await run(["--meta", "project"], sent);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).error).toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("--meta needs key=value (got project)"),
    });
    expect(sent).toEqual([]);
  });
});
