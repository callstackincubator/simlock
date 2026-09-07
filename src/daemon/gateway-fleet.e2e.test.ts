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
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

const GATEWAY_PORT = 48173;
const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;

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

  async function startWorker(options: {
    readonly label: string;
    readonly model: string;
    readonly token: string;
    readonly stdout: string;
  }): Promise<DaemonServer> {
    const directory = await mkdtemp(join(tmpdir(), `simlock-e2e-${options.label}-`));
    directories.push(directory);
    const daemon = await startDaemon({
      configOverrides: {
        gateway: { url: GATEWAY_URL, token: options.token, label: options.label },
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
});
