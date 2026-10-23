import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import type { DaemonServer } from "../daemon/server.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "./testing.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const LABEL = "agent-device on this Mac";
const adminSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "admin",
  role: "admin",
} as const;

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

interface Rig {
  readonly daemon: DaemonServer;
  readonly filesystem: MemoryFilesystem;
  readonly logs: MemoryLogSink;
  readonly profilePath: string;
  readonly port: number;
}

async function launch(host = "127.0.0.1"): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-local-profile-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const logs = new MemoryLogSink();
  const port = await freeLoopbackPort();
  const daemon = await startDaemon({
    clock,
    configOverrides: {
      capabilities: { "agent-device": { enabled: true } },
      http: { enabled: true, host, port },
    },
    dataDirectory: directory,
    deviceDataTables: fakeDeviceDataTables,
    drivers: [
      new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        defaultModels: { phone: ["iPhone 16"] },
        knownModels: ["iPhone 16"],
        modelClasses: { "iPhone 16": "phone" },
        platform: "ios",
      }),
    ],
    filesystem,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
    optionalModules: [agentDeviceModuleWith({ upstream: new FakeAgentDevice() })],
    version: "1.2.3",
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return {
    daemon,
    filesystem,
    logs,
    port,
    profilePath: join(directory, "agent-device-profile.json"),
  };
}

async function tokens(rig: Rig) {
  return (await rig.daemon.dispatch("token.list", {}, adminSession)).tokens;
}

describe("the local agent-device profile", () => {
  it("is written before HTTP listens, and its token leases for a local agent", async () => {
    const rig = await launch();

    const text = await rig.filesystem.readFile(rig.profilePath);
    const profile = JSON.parse(text) as Record<string, string>;
    expect((await rig.filesystem.stat(rig.profilePath)).mode).toBe(0o600);
    expect(Object.keys(profile)).toEqual([
      "daemonAuthToken",
      "daemonBaseUrl",
      "daemonTransport",
      "leaseProvider",
      "runId",
      "sessionIsolation",
      "tenant",
    ]);
    expect(text).toBe(`${JSON.stringify(profile, null, 2)}\n`);
    expect(profile).toMatchObject({
      daemonBaseUrl: `http://127.0.0.1:${rig.port}/v1/agent-device`,
      daemonTransport: "http",
      leaseProvider: "proxy",
      runId: "simlock-local",
      sessionIsolation: "tenant",
      tenant: "local",
    });
    const labelled = (await tokens(rig)).filter((token) => token.label === LABEL);
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.role).toBe("agent");

    const response = await fetch(`http://127.0.0.1:${rig.port}/v1/agent-device/rpc`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "agent_device.lease.allocate",
        params: {
          clientId: "c",
          leaseId: "1".padStart(32, "0"),
          leaseProvider: "proxy",
          platform: "ios",
          runId: "r",
          ttlMs: 120_000,
        },
      }),
      headers: {
        authorization: `Bearer ${profile.daemonAuthToken}`,
        connection: "close",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(((await response.json()) as { result: unknown }).result).toMatchObject({ ok: true });
    const leases = (await rig.daemon.dispatch(
      "list.get",
      { kind: "leases" },
      adminSession,
    )) as never as {
      ownerId: string;
    }[];
    expect(leases.map((lease) => lease.ownerId)).toEqual([labelled[0]?.id]);
  });
});
