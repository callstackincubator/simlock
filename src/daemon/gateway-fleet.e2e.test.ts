/**
 * ADR 0005 §35's one e2e test: "two fake-driver workers and a gateway in one process tree and
 * leases through the gateway". A real gateway daemon and two real worker daemons (each with a
 * `FakeDriver` instead of real simulator tooling), joined over a real WebSocket uplink on
 * loopback -- not the in-memory uplink port `service.test.ts`/`worker-link.test.ts` script,
 * because the point of *this* test is that the whole stack (uplink listener, worker's own
 * `GatewayUplink`, the fleet queue, routing, and `device.exec` forwarding) works together, not
 * any one piece of it in isolation.
 *
 * Two workers, not one, and with disjoint catalogs (`knownModels`): the smoke test this is meant
 * to catch is "the gateway leased a device on the *wrong* machine", which one worker cannot
 * exercise (see `fleet-coordinator.test.ts`'s own two-worker tests for the pass-over and
 * dispatch-race cases this file does not re-prove).
 *
 * A fixed port, matching `main.test.ts`'s own real-HTTP tests (`describe("startDaemon HTTP
 * gateway bind failure")`) rather than a dynamically-chosen one: the worker's `gateway.url` has
 * to be known before that worker's daemon is constructed, and this codebase's other real-socket
 * tests already accept a fixed port's small collision risk over that chicken-and-egg problem.
 *
 * Traps doc: this suite starts real child processes (`device.exec`'s target) and real sockets,
 * so it can flake under CPU contention alongside an unrelated file's own suite -- re-run this
 * file alone before treating a failure here as a real regression.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/index.js";
import type { Filesystem } from "../ports/index.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

const GATEWAY_PORT = 48173;
const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;
/** Distinct from `GATEWAY_PORT` above so this file's second suite never races the first test's
 * own listener through TIME_WAIT on the same port. */
const RESTART_GATEWAY_PORT = 48174;
const RESTART_GATEWAY_URL = `ws://127.0.0.1:${RESTART_GATEWAY_PORT}`;

function adminSession(): DispatchSession {
  return { manageEventSubscription: () => undefined, principal: "test-operator", role: "admin" };
}

function agentSession(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => undefined,
    principal: "fleet-agent-1",
    role: "agent",
    ...overrides,
  };
}

describe("gateway fleet smoke (ADR 0005 §35)", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function startGateway(): Promise<DaemonServer> {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-gateway-"));
    directories.push(directory);
    const daemon = await startDaemon({
      configOverrides: {
        mode: "gateway",
        http: { enabled: true, host: "127.0.0.1", port: GATEWAY_PORT },
      },
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    return daemon;
  }

  /**
   * #119: a gateway that can be stopped and started again *as the same gateway* -- the same
   * `SIMLOCK_HOME` directory and the same `Filesystem` instance backing it, which is what
   * `instance.json`/`tokens.json`/`workers.json` actually persisting across the restart depends
   * on (ADR §30, §8a). `startGateway` above deliberately hands each call a fresh
   * `MemoryFilesystem`, which is right for a test that starts one gateway once; this one needs
   * the state to survive the restart it is about to perform.
   */
  async function startRestartableGateway(): Promise<{
    daemon: DaemonServer;
    filesystem: Filesystem;
    directory: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-gateway-restart-"));
    directories.push(directory);
    const filesystem = new MemoryFilesystem();
    const daemon = await startDaemon({
      configOverrides: {
        mode: "gateway",
        http: { enabled: true, host: "127.0.0.1", port: RESTART_GATEWAY_PORT },
      },
      dataDirectory: directory,
      filesystem,
      logger: new NoopLogger(),
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    return { daemon, filesystem, directory };
  }

  async function startWorker(options: {
    readonly label: string;
    readonly model: string;
    readonly token: string;
    readonly stdout: string;
    readonly gatewayUrl?: string;
  }): Promise<DaemonServer> {
    const directory = await mkdtemp(join(tmpdir(), `simlock-e2e-${options.label}-`));
    directories.push(directory);
    const daemon = await startDaemon({
      configOverrides: {
        gateway: {
          url: options.gatewayUrl ?? GATEWAY_URL,
          token: options.token,
          label: options.label,
        },
      },
      dataDirectory: directory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          // A real command, so `device.exec` proves a real child process actually ran on
          // *this* worker: it prints which worker answered and exits with a distinguishing
          // code, both asserted below.
          passthrough: () => ({
            args: [
              "-e",
              `process.stdout.write(${JSON.stringify(options.stdout)}); process.exit(7);`,
            ],
            command: process.execPath,
            env: {},
          }),
          passthroughTool: "adb",
          clock: new SystemClock(),
          knownModels: [options.model],
          platform: "android",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    return daemon;
  }

  it("leases a device on the right worker and execs a real command against it through the gateway", async () => {
    const gateway = await startGateway();
    const { secret: tokenA } = await gateway.dispatch(
      "token.create",
      { role: "worker", label: "worker-a" },
      adminSession(),
    );
    const { secret: tokenB } = await gateway.dispatch(
      "token.create",
      { role: "worker", label: "worker-b" },
      adminSession(),
    );

    await startWorker({
      label: "worker-a",
      model: "Pixel-A",
      token: tokenA,
      stdout: "hello-from-a",
    });
    await startWorker({
      label: "worker-b",
      model: "Pixel-B",
      token: tokenB,
      stdout: "hello-from-b",
    });

    // Both uplinks dial on their own schedule outside `startDaemon`'s own returned promise
    // (`main.ts` fires `gatewayUplink.start()` without awaiting it) -- wait for the gateway to
    // actually see both before leasing.
    await vi.waitFor(async () => {
      const { workers } = await gateway.dispatch("worker.list", {}, adminSession());
      expect(workers.filter((worker) => worker.connection === "connected")).toHaveLength(2);
    });

    const grant = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-B", platform: "android", noWait: true },
      agentSession(),
    );

    // ADR §16: the gateway lease id names its worker -- and the worker actually chosen must be
    // the one that could serve "Pixel-B" (worker-a's catalog only knows "Pixel-A").
    expect(grant.lease.worker?.label).toBe("worker-b");
    expect(grant.lease.id.startsWith(`${grant.lease.worker?.id}.`)).toBe(true);

    const chunks: string[] = [];
    const result = await gateway.dispatch(
      "device.exec",
      { args: [], leaseId: grant.lease.id, tool: "adb" },
      agentSession({
        onOutput: (_stream, chunk) => {
          chunks.push(chunk);
        },
      }),
    );

    // The real child process worker-b's own `FakeDriver` builds actually ran, on that worker,
    // reached through the gateway's proxy -- not worker-a's, and not simulated.
    expect(result.exitCode).toBe(7);
    expect(chunks.join("")).toBe("hello-from-b");

    await gateway.dispatch("lease.release", { leaseId: grant.lease.id }, agentSession());
  }, 30_000);

  /**
   * #119's own flagship: drain semantics, `WORKER_UNREACHABLE`-shaped exclusion, and reconnect
   * rebuild, proved together over real processes and a real WebSocket restart -- not the
   * scripted uplink `fleet-coordinator.test.ts` and `dispatcher.test.ts` already cover each
   * piece of in isolation (including §27a's ownership round trip, pinned there too). What only
   * this shape of test can catch: the gateway's own persisted state (`instance.json`,
   * `tokens.json`, `workers.json`) actually surviving a real `stop()`/`startDaemon()` cycle, and
   * a real worker's own `GatewayUplink` actually redialling and reconnecting on its own backoff
   * once the new process is listening again.
   */
  it("drains one worker, kills it, restarts the gateway, and proves the surviving worker's lease outlives the restart with renewing resumed (ADR §9/§27a/§30, #119)", async () => {
    const { daemon: firstGateway, filesystem, directory } = await startRestartableGateway();
    const { secret: tokenA } = await firstGateway.dispatch(
      "token.create",
      { role: "worker", label: "worker-a" },
      adminSession(),
    );
    const { secret: tokenB } = await firstGateway.dispatch(
      "token.create",
      { role: "worker", label: "worker-b" },
      adminSession(),
    );

    await startWorker({
      label: "worker-a",
      model: "Pixel-A",
      token: tokenA,
      stdout: "hello-from-a",
      gatewayUrl: RESTART_GATEWAY_URL,
    });
    const workerB = await startWorker({
      label: "worker-b",
      model: "Pixel-B",
      token: tokenB,
      stdout: "hello-from-b",
      gatewayUrl: RESTART_GATEWAY_URL,
    });

    await vi.waitFor(async () => {
      const { workers } = await firstGateway.dispatch("worker.list", {}, adminSession());
      expect(workers.filter((worker) => worker.connection === "connected")).toHaveLength(2);
    });
    const beforeDrain = (await firstGateway.dispatch("worker.list", {}, adminSession())).workers;
    const workerBId = beforeDrain.find((worker) => worker.label === "worker-b")?.id;
    if (workerBId === undefined) throw new Error("worker-b never connected");

    // Lease worker-a's own device -- the fleet client below must still be able to renew this
    // exact lease after everything that follows.
    const grant = await firstGateway.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android", noWait: true },
      agentSession({ principal: "fleet-owner" }),
    );
    expect(grant.lease.worker?.label).toBe("worker-a");

    // Drain worker-b (ADR §9). It holds no lease of its own here; the point of draining it is
    // that the drain has to survive everything below, not just this call.
    await firstGateway.dispatch("worker.drain", { workerId: workerBId }, adminSession());
    await vi.waitFor(async () => {
      const { workers } = await firstGateway.dispatch("worker.list", {}, adminSession());
      expect(workers.find((worker) => worker.id === workerBId)?.drained).toBe(true);
    });
    // No new dispatch reaches a drained worker: a request only worker-b could serve queues
    // rather than landing on it -- proven over the real uplink, not a scripted directory.
    await expect(
      firstGateway.dispatch(
        "lease.request",
        { model: "Pixel-B", platform: "android", noWait: true },
        agentSession({ principal: "someone-else" }),
      ),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });

    // Kill worker-b outright: an operator taking a drained machine down for maintenance.
    await workerB.stop("test");
    daemons.splice(daemons.indexOf(workerB), 1);

    // Restart the gateway. Everything it held only in memory -- worker views, the lease index,
    // the fleet queue -- is gone (ADR §30); only what it persisted survives, because this reuses
    // the *same* directory and the *same* `Filesystem` instance rather than fabricating a fresh
    // gateway that merely happens to listen on the same port.
    await firstGateway.stop("test");
    daemons.splice(daemons.indexOf(firstGateway), 1);
    const restartedGateway = await startDaemon({
      configOverrides: {
        mode: "gateway",
        http: { enabled: true, host: "127.0.0.1", port: RESTART_GATEWAY_PORT },
      },
      dataDirectory: directory,
      filesystem,
      logger: new NoopLogger(),
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(restartedGateway);

    // worker-a's own uplink was never touched -- it keeps redialling on its own backoff and
    // finds the restarted gateway listening again on the same port.
    await vi.waitFor(
      async () => {
        const { workers } = await restartedGateway.dispatch("worker.list", {}, adminSession());
        expect(
          workers.some(
            (worker) => worker.label === "worker-a" && worker.connection === "connected",
          ),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );

    // The lease survives the restart (ADR §30) and renewing resumes for its original requester
    // once the reconnect rebuild has run -- retried because the rebuild races the reconnect
    // itself becoming visible above.
    const renewed = await vi.waitFor(
      () =>
        restartedGateway.dispatch(
          "lease.renew",
          { leaseId: grant.lease.id },
          agentSession({ principal: "fleet-owner" }),
        ),
      { timeout: 15_000 },
    );
    expect(renewed.ttlDeadline).toBeGreaterThan(grant.lease.ttlDeadline);

    // ...and refused for anyone else (ADR §27a, pinned end to end across a real restart): the
    // owner this gateway forwarded before it died is what the rebuilt lease authorizes against,
    // not whichever principal happens to ask first.
    await expect(
      restartedGateway.dispatch(
        "lease.renew",
        { leaseId: grant.lease.id },
        agentSession({ principal: "an-impostor" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await restartedGateway.dispatch(
      "lease.release",
      { leaseId: grant.lease.id },
      agentSession({ principal: "fleet-owner" }),
    );
  }, 40_000);
});
