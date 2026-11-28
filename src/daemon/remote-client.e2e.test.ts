import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectSimlock } from "../client/index.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import {
  NodeFilesystem,
  NoopLogger,
  SystemClock,
  FakeDirectoryAccessReader,
} from "../ports/index.js";
import { startOnFreePort } from "../test-support/loopback-port.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";
import { removeDirectory } from "../test-support/remove-directory.js";

const admin: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
};

describe("the typed client over a worker's session path", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)));
  });

  it("connectSimlock with a URL and a token reaches a worker with fake drivers over its real session path: it leases, renews, releases and hears lease-lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-remote-"));
    directories.push(directory);
    const { port, started } = await startOnFreePort(async (port) =>
      startDaemon({
        hostLoadProbe: null,
        directoryAccess: new FakeDirectoryAccessReader({
          entries: [],
          user: "S-1-5-21-1-2-3-1001",
        }),
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [new FakeDriver({ clock: new SystemClock(), platform: "android" })],
        filesystem: new NodeFilesystem(),
        logger: new NoopLogger(),
        version: "1.0.0-e2e",
      }),
    );
    daemons.push(started);
    const agent = await started.dispatch("token.create", { label: "remote", role: "agent" }, admin);

    const client = await connectSimlock({
      token: agent.secret,
      url: `http://127.0.0.1:${String(port)}`,
    });

    const url = `http://127.0.0.1:${String(port)}`;
    const other = await connectSimlock({ token: agent.secret, url });
    await expect(client.identity()).resolves.toMatchObject({
      principal: agent.token.id,
      role: "agent",
      via: "token",
    });

    const ask = { model: "Pixel-A", platform: "android" as const };
    const first = await client.requestLease(ask);
    await expect(client.renewLease({ leaseId: first.lease.id })).resolves.toMatchObject({
      id: first.lease.id,
    });
    await client.releaseLease({ leaseId: first.lease.id });
    await expect(client.listLeases()).resolves.toMatchObject({ leases: [] });

    const lost = vi.fn();
    client.onLeaseLost(lost);
    const second = await client.requestLease(ask);
    await other.releaseLease({ leaseId: second.lease.id });
    await vi.waitFor(() =>
      expect(lost).toHaveBeenCalledWith(expect.objectContaining({ leaseId: second.lease.id })),
    );
    await other.close();
    await client.close();
  });
});
