import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "../agent-device/testing.js";
import { FakeHostInfo, MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

const admin: DispatchSession = {
  manageEventSubscription: () => undefined,
  principal: "test-operator",
  role: "admin",
};

describe("a worker's capabilities through a gateway", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function startFleet(options: {
    readonly enabled?: boolean;
    readonly fake: FakeAgentDevice;
  }) {
    const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-caps-gateway-"));
    directories.push(gatewayDirectory);
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      dataDirectory: gatewayDirectory,
      filesystem: new MemoryFilesystem(),
      hostInfo: new FakeHostInfo({ arch: "x64", os: "Linux", osVersion: "6.8.0" }),
      logger: new NoopLogger(),
      optionalModules: [agentDeviceModuleWith({})],
      statePath: join(gatewayDirectory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const { secret } = await gateway.dispatch(
      "token.create",
      { label: "worker-a", role: "worker" },
      admin,
    );
    const workerDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-caps-worker-"));
    directories.push(workerDirectory);
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { "agent-device": { enabled: options.enabled ?? true } },
        gateway: { label: "worker-a", token: secret, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: workerDirectory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
      optionalModules: [agentDeviceModuleWith({ upstream: options.fake })],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(workerDirectory, "state.json"),
      version: "1.0.0-e2e",
    } as Parameters<typeof startDaemon>[0]);
    daemons.push(worker);
    await vi.waitFor(
      async () => {
        const { workers } = await gateway.dispatch("worker.list", {}, admin);
        expect(workers.some((view) => view.connection === "connected" && view.capacity)).toBe(true);
      },
      { timeout: 10_000 },
    );
    return { gateway, worker };
  }

  it("the gateway's status.get workers entry and worker.list entry carry the worker's capabilities; the gateway's own top-level status.get has no capabilities", async () => {
    const { gateway } = await startFleet({ fake: new FakeAgentDevice() });
    const expected = [{ name: "agent-device", state: "available" }];

    const status = await gateway.dispatch("status.get", {}, admin);
    const { workers } = await gateway.dispatch("worker.list", {}, admin);

    expect(status.workers?.[0]?.capabilities).toEqual(expected);
    expect(workers[0]?.capabilities).toEqual(expected);
    expect(status).not.toHaveProperty("capabilities");
  }, 30_000);

  it("the gateway's worker.list shows a worker whose agent-device is starting as unavailable with reason starting", async () => {
    const fake = new FakeAgentDevice();
    fake.setUnavailable("starting");
    const { gateway } = await startFleet({ fake });

    const { workers } = await gateway.dispatch("worker.list", {}, admin);

    expect(workers[0]?.capabilities).toEqual([
      { name: "agent-device", reason: "starting", state: "unavailable" },
    ]);
  }, 30_000);

  it("the gateway's worker.list shows a worker with capabilities.agent-device.enabled false as off", async () => {
    const { gateway } = await startFleet({ enabled: false, fake: new FakeAgentDevice() });

    const { workers } = await gateway.dispatch("worker.list", {}, admin);

    expect(workers[0]?.capabilities).toEqual([{ name: "agent-device", state: "off" }]);
  }, 30_000);

  it("a disconnected worker's view keeps the list it last read", async () => {
    const { gateway, worker } = await startFleet({ fake: new FakeAgentDevice() });
    await vi.waitFor(async () => {
      const { workers } = await gateway.dispatch("worker.list", {}, admin);
      expect(workers[0]?.capabilities).toEqual([{ name: "agent-device", state: "available" }]);
    });

    await worker.stop("test");
    daemons.splice(daemons.indexOf(worker), 1);

    await vi.waitFor(async () => {
      const { workers } = await gateway.dispatch("worker.list", {}, admin);
      expect(workers[0]?.connection).toBe("disconnected");
    });
    const { workers } = await gateway.dispatch("worker.list", {}, admin);
    expect(workers[0]?.capabilities).toEqual([{ name: "agent-device", state: "available" }]);
  }, 30_000);
});
