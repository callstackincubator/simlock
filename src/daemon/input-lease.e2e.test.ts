import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
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
  via: "socket",
  principal: "test-operator",
  role: "admin",
};

const agent: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "agent-1",
  role: "agent",
};

const UNAVAILABLE_CONFIG =
  '{"width":1,"height":1,"orientation":"portrait","inputUnavailable":true}';

interface OpenedSocket {
  // why: 101 for an upgrade that was accepted, else the status the refusal answered.
  readonly status: number;
  readonly messages: Buffer[];
}

async function openInput(url: string, token: string | undefined): Promise<OpenedSocket> {
  const socket = new WebSocket(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  const messages: Buffer[] = [];
  socket.on("message", (data) => messages.push(data as Buffer));
  const status = await new Promise<number>((resolve, reject) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", reject);
  });
  return { messages, status };
}

const sockets: WebSocket[] = [];

describe("a lease's input socket", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function fleet() {
    const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-input-gateway-"));
    directories.push(gatewayDirectory);
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: true } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: gatewayDirectory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      role: "gateway",
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const token = (await gateway.dispatch("token.create", { label: "w", role: "worker" }, admin))
      .secret;
    const workerDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-input-worker-"));
    directories.push(workerDirectory);
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: true } },
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: workerDirectory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(worker);
    await vi.waitFor(
      async () => {
        const { workers } = await gateway.dispatch("worker.list", {}, admin);
        expect(workers[0]?.catalog?.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    const holder = await gateway.dispatch(
      "token.create",
      { label: "holder", role: "agent" },
      admin,
    );
    const owner: DispatchSession = { ...agent, principal: holder.token.id };
    const granted = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      owner,
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    await vi.waitFor(() => gateway.dispatch("lease.get", { leaseId }, owner), { timeout: 10_000 });
    const inputUrl = (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/input`;
    return { holder: holder.secret, inputUrl, leaseId };
  }

  it(
    "opens WS /v1/leases/{id}/input and gets 0x83 then 0x82, or a refused upgrade",
    { timeout: 30_000 },
    async () => {
      const { holder, inputUrl } = await fleet();
      const own = await openInput(inputUrl(), holder);
      expect(own.status).toBe(101);
      await vi.waitFor(() => expect(own.messages).toHaveLength(2), { timeout: 10_000 });
      expect([...(own.messages[0] ?? [])]).toEqual([0x83]);
      expect(own.messages[1]?.[0]).toBe(0x82);
      expect(own.messages[1]?.subarray(1).toString("utf8")).toBe(UNAVAILABLE_CONFIG);
    },
  );
});
