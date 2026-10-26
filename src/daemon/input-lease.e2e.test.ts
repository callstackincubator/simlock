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

const UNAVAILABLE_CONFIG = {
  height: 1,
  inputUnavailable: true,
  orientation: "portrait",
  width: 1,
};

interface OpenedSocket {
  // why: 101 for an upgrade that was accepted, else the status the refusal answered.
  readonly status: number;
  // why: the error code of a refusal's JSON body, when it has one.
  readonly code: string | undefined;
  readonly messages: Buffer[];
}

async function openInput(url: string, token: string | undefined): Promise<OpenedSocket> {
  const socket = new WebSocket(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  const messages: Buffer[] = [];
  socket.on("message", (data) => messages.push(data as Buffer));
  const outcome = await new Promise<{ status: number; code: string | undefined }>(
    (resolve, reject) => {
      socket.once("open", () => resolve({ code: undefined, status: 101 }));
      socket.once("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        response.on("end", () => {
          let code: string | undefined;
          try {
            code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
          } catch {
            code = undefined;
          }
          resolve({ code, status: response.statusCode ?? 0 });
        });
      });
      socket.once("error", reject);
    },
  );
  return { ...outcome, messages };
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

  async function directory(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `simlock-e2e-input-${name}-`));
    directories.push(path);
    return path;
  }

  function driver(): FakeDriver {
    return new FakeDriver({
      availableOsVersions: ["18.0"],
      clock: new SystemClock(),
      knownModels: ["Pixel-A"],
      platform: "android",
    });
  }

  async function tokens(daemon: DaemonServer) {
    const make = (label: string, role: "agent" | "operator") =>
      daemon.dispatch("token.create", { label, role }, admin);
    return {
      holder: await make("holder", "agent"),
      operator: await make("op", "operator"),
      other: await make("other", "agent"),
    };
  }

  async function lease(daemon: DaemonServer, principal: string): Promise<string> {
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal },
    );
    return (granted as { lease: { id: string } }).lease.id;
  }

  async function fleet(options: { readonly gatewayInput: boolean; readonly workerInput: boolean }) {
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: options.gatewayInput } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: await directory("gateway"),
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      role: "gateway",
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const token = (await gateway.dispatch("token.create", { label: "w", role: "worker" }, admin))
      .secret;
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: options.workerInput } },
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: await directory("worker"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver()],
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
    const { holder, operator, other } = await tokens(gateway);
    const leaseId = await lease(gateway, holder.token.id);
    await vi.waitFor(
      () => gateway.dispatch("lease.get", { leaseId }, { ...agent, principal: holder.token.id }),
      { timeout: 10_000 },
    );
    return {
      holder: holder.secret,
      inputUrl: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
    };
  }

  async function standalone() {
    const port = await freeLoopbackPort();
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: true } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: await directory("standalone"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver()],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(worker);
    const { holder, operator, other } = await tokens(worker);
    const leaseId = await lease(worker, holder.token.id);
    return {
      holder: holder.secret,
      inputUrl: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
    };
  }

  async function expectAdmitted(url: string, token: string): Promise<void> {
    const opened = await openInput(url, token);
    expect(opened.status).toBe(101);
    await vi.waitFor(() => expect(opened.messages).toHaveLength(2), { timeout: 10_000 });
    expect([...(opened.messages[0] ?? [])]).toEqual([0x83]);
    expect(opened.messages[1]?.[0]).toBe(0x82);
    expect(JSON.parse(opened.messages[1]?.subarray(1).toString("utf8") ?? "")).toEqual(
      UNAVAILABLE_CONFIG,
    );
  }

  async function expectRefused(
    url: string,
    token: string | undefined,
    refusal: { readonly status: number; readonly code: string | undefined },
  ): Promise<void> {
    const opened = await openInput(url, token);
    expect({ code: opened.code, status: opened.status }).toEqual(refusal);
    expect(opened.messages).toEqual([]);
  }

  it(
    "opens WS /v1/leases/{id}/input and gets 0x83 then 0x82, or a refused upgrade",
    { timeout: 60_000 },
    async () => {
      const through = await fleet({ gatewayInput: true, workerInput: true });
      await expectAdmitted(through.inputUrl(), through.holder);
      await expectAdmitted(through.inputUrl(), through.operator);
      const unknown = { code: "UNKNOWN_LEASE", status: 404 };
      await expectRefused(through.inputUrl(), through.other, unknown);
      await expectRefused(through.inputUrl("L-unknown"), through.holder, unknown);
      await expectRefused(through.inputUrl(), undefined, { code: "UNAUTHENTICATED", status: 401 });
      const plain = await fetch(through.plainUrl(), {
        headers: { authorization: `Bearer ${through.holder}` },
      });
      expect(plain.status).toBe(426);

      const direct = await standalone();
      await expectAdmitted(direct.inputUrl(), direct.holder);
      await expectAdmitted(direct.inputUrl(), direct.operator);
      await expectRefused(direct.inputUrl(), direct.other, unknown);
      await expectRefused(direct.inputUrl(), undefined, { code: "UNAUTHENTICATED", status: 401 });

      const gatewayOff = await fleet({ gatewayInput: false, workerInput: true });
      await expectRefused(gatewayOff.inputUrl(), gatewayOff.holder, {
        code: undefined,
        status: 404,
      });

      const workerOff = await fleet({ gatewayInput: true, workerInput: false });
      await expectRefused(workerOff.inputUrl(), workerOff.holder, {
        code: "INPUT_UNAVAILABLE",
        status: 503,
      });
    },
  );
});
