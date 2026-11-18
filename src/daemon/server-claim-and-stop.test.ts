import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CryptoTokenSecrets,
  MemoryFilesystem,
  NodeFilesystem,
  NodeIpcTransport,
} from "../ports/index.js";
import type { DaemonServer } from "./server.js";
import { DaemonEndpointHost } from "./connection-host.js";
import {
  adminAuth,
  createClient,
  createHarness,
  hello,
  leaseIdOf,
  runningDaemons,
  stopTestDaemons,
  temporaryDirectories,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer", () => {
  it("recovers a stale socket file and refuses a second live daemon before running any device work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-stale-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    await new NodeFilesystem().writeFileAtomic(socketPath, "stale");
    const first = await createHarness({ socketPath });
    let convergeCalls = 0;
    const second = await createHarness({
      converge: () => {
        convergeCalls += 1;
        return Promise.resolve();
      },
      socketPath,
      start: false,
    });

    await expect(second.daemon.start()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
    });
    expect(convergeCalls).toBe(0);
    await second.daemon.stop("failed-start");
    const client = await createClient(socketPath);
    await hello(client);
    await client.close();
    const firstDaemon: DaemonServer = first.daemon;
    expect(firstDaemon.socketPath).toBe(socketPath);
  });

  // why: review finding S1: `AdminSecretManager`'s own doc (`src/auth`) asserts "a daemon
  // that loses the start race never calls `persist()` at all ... so the file an
  // already-running daemon wrote is never touched by the loser" -- untested anywhere before
  // this. Mirrors the "recovers a stale socket file" test above (two harnesses racing for the
  // same socket path), but gives each its own real `AdminSecretManager` over its own
  // `MemoryFilesystem` so this can assert on the filesystem directly, rather than trusting a
  // stub. In production both instances would target the *same* real `admin.token` path (see
  // `main.ts`); separate filesystems here isolate what each instance actually did, without that
  // shared path letting a wrongly-invoked `remove()` on the loser silently clean up after a
  // wrongly-invoked `persist()` and mask the very bug this test exists to catch.
  it("never touches admin.token on the daemon instance that loses the start race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-stale-admin-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    await new NodeFilesystem().writeFileAtomic(socketPath, "stale");

    const secrets = new CryptoTokenSecrets();
    const winnerFilesystem = new MemoryFilesystem();
    await createHarness({
      adminSecret: (await adminAuth(winnerFilesystem, secrets)).adminSecret,
      socketPath,
    });
    await expect(winnerFilesystem.readFile("/admin.token")).resolves.toContain("\n");

    const loserFilesystem = new MemoryFilesystem();
    const second = await createHarness({
      adminSecret: (await adminAuth(loserFilesystem, secrets)).adminSecret,
      socketPath,
      start: false,
    });
    await expect(second.daemon.start()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
    });
    await expect(loserFilesystem.readFile("/admin.token")).rejects.toThrow();

    await second.daemon.stop("failed-start");
    const client = await createClient(socketPath);
    await hello(client);
    await client.close();
  });

  it.each([false, true])(
    "preserves the replacement daemon's admin credential and still releases the endpoint when it starts as the old endpoint is released (credential removal fails: %s)",
    async (removalFails) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-admin-restart-"));
      temporaryDirectories.push(directory);
      const socketPath = join(directory, "daemon.sock");
      const filesystem = new MemoryFilesystem();
      const secrets = new CryptoTokenSecrets();
      const oldSecret = await adminAuth(filesystem, secrets);
      const replacementSecret = await adminAuth(filesystem, secrets);
      const replacement = await createHarness({
        adminSecret: replacementSecret.adminSecret,
        socketPath,
        start: false,
      });
      const host = new DaemonEndpointHost({
        connector: new NodeIpcTransport(),
        endpoint: socketPath,
        filesystem: new NodeFilesystem(),
        listenerFactory: new NodeIpcTransport(),
      });
      let replacementToken: string | undefined;
      const old = await createHarness({
        adminSecret: oldSecret.adminSecret,
        host: {
          endpoint: socketPath,
          start: (accept) => host.start(accept),
          async stop() {
            await host.stop();
            // why: endpoint release lets a new process start before the old stop resumes.
            await replacement.daemon.start();
            replacementToken = await filesystem.readFile("/admin.token");
            await expect(
              replacementSecret.resolveHelloRole({ credential: replacementToken.trim() }),
            ).resolves.toBe("admin");
          },
        },
        socketPath,
      });
      await expect(
        oldSecret.resolveHelloRole({
          credential: (await filesystem.readFile("/admin.token")).trim(),
        }),
      ).resolves.toBe("admin");

      if (removalFails) {
        vi.spyOn(filesystem, "rm").mockRejectedValueOnce(new Error("EACCES"));
        await expect(old.daemon.stop("restart")).rejects.toThrow("EACCES");
        // why: the failed stop is settled; teardown must not stop it again.
        runningDaemons.splice(runningDaemons.indexOf(old.daemon), 1);
      } else {
        await old.daemon.stop("restart");
      }

      // why: the replacement could only start because the old stop released the endpoint.
      expect(replacementToken).toBeDefined();
      await expect(filesystem.readFile("/admin.token")).resolves.toBe(replacementToken);
    },
  );

  it("gracefully stops without touching leases, persisting them with their deadlines", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    await expect(client.request("daemon.stop", {})).resolves.toMatchObject({ ok: true });

    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    expect(harness.state.database.prepare("SELECT id FROM leases").all()).toEqual([
      { id: leaseId },
    ]);
    expect(harness.eventBus.replay().map((event) => event.event)).toContain("daemon.stopping");
    expect(harness.eventBus.replay().map((event) => event.event)).not.toContain("lease.released");
  });
});
