import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { testConfig } from "../core/testing.js";
import { FleetLeaseIndex, GatewayOwnerRoutedFacts } from "../gateway/index.js";
import {
  FakeClock,
  NodeFilesystem,
  NodeIpcTransport,
  NoopLogger,
  resolveDaemonSocketPath,
} from "../ports/index.js";
import { DaemonEndpointHost } from "./connection-host.js";
import type { ContractDispatcher } from "./dispatch.js";
import { DaemonServer } from "./server.js";
import {
  createClient,
  helloAs,
  runningDaemons,
  stopTestDaemons,
  temporaryDirectories,
} from "./test-server.js";

afterEach(stopTestDaemons);

/** why: a gateway daemon whose dispatcher answers `lease.release-run` as the fleet does: each matching index entry is released on its worker, which relays `lease.released`. */
async function gatewayHarness() {
  const directory = await mkdtemp(join(tmpdir(), "simlock-gateway-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const leaseIndex = new FleetLeaseIndex("gw:instance-1:");
  const dispatcher = {
    dispatch: async (
      operation: string,
      input: unknown,
      session: { role: string; principal: string },
    ) => {
      const relayRelease = (entry: ReturnType<typeof leaseIndex.all>[number]) =>
        eventBus.emit(
          "lease.released",
          {
            deviceId: "dev_1",
            leaseId: entry.workerLeaseId,
            ownerId: entry.ownerId,
            reason: "explicit",
            workerId: entry.workerId,
          } as never,
          "lease-lifecycle",
        );
      if (operation === "lease.release") {
        const { leaseId } = input as { leaseId: string };
        const held = leaseIndex.resolve(leaseId);
        if (held !== undefined) relayRelease(held);
        return { leaseId };
      }
      const { runId } = input as { runId: string };
      const released = leaseIndex
        .all()
        .filter(
          (entry) =>
            entry.runId === runId &&
            (session.role === "admin" || entry.ownerId === session.principal),
        );
      released.forEach(relayRelease);
      return { leaseIds: released.map((entry) => entry.gatewayLeaseId), requestIds: [] };
    },
  } as unknown as ContractDispatcher;
  const socketPath = resolveDaemonSocketPath(directory);
  const daemon = new DaemonServer({
    clock,
    config: testConfig({}, "gateway"),
    defaultRequesterId: "test-process",
    dispatcher,
    eventBus,
    host: new DaemonEndpointHost({
      connector: new NodeIpcTransport(),
      endpoint: socketPath,
      filesystem: new NodeFilesystem(),
      listenerFactory: new NodeIpcTransport(),
    }),
    leaseSnapshot: () =>
      leaseIndex.all().map((entry) => ({
        id: entry.gatewayLeaseId,
        ownerId: entry.ownerId,
        ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      })),
    logger: new NoopLogger(),
    ownerRoutedFacts: new GatewayOwnerRoutedFacts(eventBus, leaseIndex),
    resolveRole: { resolve: (payload) => (payload.principal === "operator" ? "admin" : "agent") },
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  const entry = (ownerId: string, runId: string) => {
    const gatewayLeaseId = `wrk_1.${ownerId}-${runId}`;
    leaseIndex.add({
      gatewayLeaseId,
      grantedAt: 1,
      ownerId,
      requesterId: ownerId,
      runId,
      workerId: "wrk_1",
      workerLeaseId: `${ownerId}-${runId}`,
    });
    return gatewayLeaseId;
  };
  return { entry, socketPath };
}

describe("DaemonServer on a gateway", () => {
  it("pushes no lease-lost to the connection that asked for lease.release-run, and one to the owner's other connections", async () => {
    const { entry, socketPath } = await gatewayHarness();
    const connect = async (principal: string) => {
      const client = await createClient(socketPath);
      await helloAs(client, principal);
      return client;
    };
    const alice = await connect("alice");
    const aliceElsewhere = await connect("alice");
    const bob = await connect("bob");
    const operator = await connect("operator");
    const first = entry("alice", "nightly-7");
    const otherRun = entry("alice", "nightly-8");
    const bobs = entry("bob", "nightly-7");

    await expect(alice.request("lease.release-run", { runId: "nightly-7" })).resolves.toMatchObject(
      { ok: true, payload: { leaseIds: [first] } },
    );
    await expect(
      aliceElsewhere.nextFrame((frame) => frame.push === "lease-lost"),
    ).resolves.toMatchObject({ payload: { leaseId: first, reason: "explicit" } });

    await expect(
      operator.request("lease.release-run", { runId: "nightly-7" }),
    ).resolves.toMatchObject({ ok: true, payload: { leaseIds: [bobs] } });
    await expect(bob.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId: bobs, reason: "explicit" },
    });

    await expect(
      aliceElsewhere.request("lease.release", { leaseId: otherRun }),
    ).resolves.toMatchObject({ ok: true });
    await expect(alice.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId: otherRun },
    });
    await Promise.all([alice, aliceElsewhere, bob, operator].map((client) => client.close()));
  });
});
