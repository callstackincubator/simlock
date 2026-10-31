import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { FakeDeviceTcp, FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
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

interface OpenedSocket {
  // why: 101 for an upgrade that was accepted, else the status the refusal answered.
  readonly status: number;
  // why: the error code of a refusal's JSON body, when it has one.
  readonly code: string | undefined;
  readonly messages: Buffer[];
  readonly socket: WebSocket;
}

const sockets: WebSocket[] = [];

async function openTunnel(url: string, token: string | undefined): Promise<OpenedSocket> {
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
  return { ...outcome, messages, socket };
}

function hello(devicePort: number): Buffer {
  const body = Buffer.from(JSON.stringify({ tunnels: [{ devicePort, kind: "reverse" }] }));
  return Buffer.concat([Buffer.from([0x01, 0, 0, 0, 0]), body]);
}

describe("a lease's tunnel socket", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function standalone(enabled: boolean) {
    const port = await freeLoopbackPort();
    const path = await mkdtemp(join(tmpdir(), "simlock-e2e-tunnel-"));
    directories.push(path);
    const daemon = await startDaemon({
      configOverrides: {
        capabilities: { tunnel: { enabled } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: path,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          deviceTcp: new FakeDeviceTcp(),
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    const make = (label: string, role: "agent" | "operator") =>
      daemon.dispatch("token.create", { label, role }, admin);
    const holder = await make("holder", "agent");
    const operator = await make("op", "operator");
    const other = await make("other", "agent");
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal: holder.token.id },
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    return {
      holder: holder.secret,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/tunnel`,
      url: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/tunnel`,
    };
  }

  async function expectReady(url: string, token: string, devicePort: number): Promise<void> {
    const opened = await openTunnel(url, token);
    expect(opened.status).toBe(101);
    opened.socket.send(hello(devicePort));
    await vi.waitFor(() => expect(opened.messages).toHaveLength(1), { timeout: 10_000 });
    expect(opened.messages[0]?.[0]).toBe(0x81);
    expect(JSON.parse(opened.messages[0]?.subarray(5).toString("utf8") ?? "")).toEqual({
      tunnels: [{ devicePort, kind: "reverse" }],
    });
  }

  it(
    "opens WS /v1/leases/{id}/tunnel on a lone worker for the holder and an operator, and refuses the rest",
    { timeout: 60_000 },
    async () => {
      const on = await standalone(true);
      await expectReady(on.url(), on.holder, 5173);
      await expectReady(on.url(), on.operator, 5174);
      const unknown = { code: "UNKNOWN_LEASE", status: 404 };
      for (const refused of [
        await openTunnel(on.url(), on.other),
        await openTunnel(on.url("L-unknown"), on.holder),
      ]) {
        expect({ code: refused.code, status: refused.status }).toEqual(unknown);
      }
      const plain = await fetch(on.plainUrl(), {
        headers: { authorization: `Bearer ${on.holder}` },
      });
      expect(plain.status).toBe(426);

      const off = await standalone(false);
      const disabled = await openTunnel(off.url(), off.holder);
      expect({ code: disabled.code, status: disabled.status }).toEqual({
        code: undefined,
        status: 404,
      });
    },
  );
});
