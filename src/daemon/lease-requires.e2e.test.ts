import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentDeviceModuleWith, FakeAgentDevice } from "../agent-device/testing.js";
import { FakeDriver } from "../core/testing.js";
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

function agent(principal: string): DispatchSession {
  return { manageEventSubscription: () => undefined, via: "socket", principal, role: "agent" };
}

type CapabilityState = "available" | "off" | "unavailable";

interface Member {
  readonly label: string;
  readonly daemon: DaemonServer;
  readonly fake: FakeAgentDevice;
}

const MISSING_MESSAGE =
  "No worker connected to this gateway can serve agent-device for this request";

describe("lease.request requires, through a gateway", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function startGateway() {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-requires-gateway-"));
    directories.push(directory);
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      optionalModules: [agentDeviceModuleWith({})],
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    return { gateway, port };
  }

  async function startWorker(
    fleet: { readonly gateway: DaemonServer; readonly port: number },
    options: {
      readonly label: string;
      readonly capability: CapabilityState;
      readonly model?: string;
      readonly maxRunning?: number;
    },
  ): Promise<Member> {
    const token = (
      await fleet.gateway.dispatch("token.create", { label: options.label, role: "worker" }, admin)
    ).secret;
    const directory = await mkdtemp(join(tmpdir(), `simlock-e2e-requires-${options.label}-`));
    directories.push(directory);
    const fake = new FakeAgentDevice();
    if (options.capability === "unavailable") fake.setUnavailable("down");
    const daemon = await startDaemon({
      configOverrides: {
        capabilities: { "agent-device": { enabled: options.capability !== "off" } },
        capacity: { config: { maxRunning: options.maxRunning ?? 2 }, strategy: "fixed" },
        gateway: {
          label: options.label,
          token,
          url: `ws://127.0.0.1:${String(fleet.port)}`,
        },
      },
      dataDirectory: directory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          knownModels: [options.model ?? "Pixel-A"],
          platform: "android",
        }),
      ],
      optionalModules: [agentDeviceModuleWith({ upstream: fake })],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(directory, "state.json"),
      version: "1.0.0-e2e",
    } as Parameters<typeof startDaemon>[0]);
    daemons.push(daemon);
    return { daemon, fake, label: options.label };
  }

  async function viewOf(gateway: DaemonServer, label: string) {
    const { workers } = await gateway.dispatch("worker.list", {}, admin);
    return workers.find((worker) => worker.label === label);
  }

  async function untilRead(gateway: DaemonServer, member: Member, model = "Pixel-A") {
    await vi.waitFor(
      async () => {
        const view = await viewOf(gateway, member.label);
        expect(view?.connection).toBe("connected");
        expect(view?.capacity).toBeDefined();
        expect(view?.capabilities).toBeDefined();
        expect(view?.catalog?.some((entry) => entry.models.includes(model))).toBe(true);
      },
      { timeout: 10_000 },
    );
  }

  async function turn(gateway: DaemonServer, member: Member, state: "available" | "unavailable") {
    member.fake.setUnavailable(state === "available" ? undefined : "down");
    await vi.waitFor(
      async () => {
        // why: a refused request is a lease event on the worker, which makes the gateway read it again.
        await member.daemon
          .dispatch(
            "lease.request",
            { model: "Nope", noWait: true, platform: "android" },
            agent("poke"),
          )
          .catch(() => undefined);
        const view = await viewOf(gateway, member.label);
        expect(view?.capabilities?.[0]?.state).toBe(state);
      },
      { timeout: 10_000 },
    );
  }

  async function byId(gateway: DaemonServer, first: Member, second: Member) {
    const [one, two] = await Promise.all([
      viewOf(gateway, first.label),
      viewOf(gateway, second.label),
    ]);
    return (one?.id ?? "") < (two?.id ?? "") ? [first, second] : [second, first];
  }

  const lease = (gateway: DaemonServer, principal: string, extra: Record<string, unknown> = {}) =>
    gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android", requires: ["agent-device"], ...extra },
      agent(principal),
    );

  const settle = <T>(promise: Promise<T>) => {
    const outcome: { settled: boolean } = { settled: false };
    void promise.then(
      () => {
        outcome.settled = true;
      },
      () => {
        outcome.settled = true;
      },
    );
    return outcome;
  };

  const settledWithin = async (outcome: { settled: boolean }, timeout = 5_000) =>
    vi.waitFor(() => expect(outcome.settled).toBe(true), { timeout });

  const rejectedEvents = async (gateway: DaemonServer) =>
    (await gateway.dispatch("events.replay", {}, admin)).filter(
      (entry: { event: string }) => entry.event === "lease.rejected",
    ) as Array<{ payload: { reason: string } }>;

  it("through the gateway, a request with requires: [agent-device] is granted on the worker that has it available, never on the one without, over 10 requests", async () => {
    const fleet = await startGateway();
    const alpha = await startWorker(fleet, { capability: "available", label: "worker-a" });
    const beta = await startWorker(fleet, { capability: "available", label: "worker-b" });
    await untilRead(fleet.gateway, alpha);
    await untilRead(fleet.gateway, beta);
    const [lower, higher] = await byId(fleet.gateway, alpha, beta);
    await turn(fleet.gateway, lower!, "unavailable");

    const labels: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const grant = await lease(fleet.gateway, `agent-${String(index)}`);
      labels.push(grant.lease.worker?.label ?? "none");
      await fleet.gateway.dispatch(
        "lease.release",
        { leaseId: grant.lease.id },
        agent(`agent-${String(index)}`),
      );
    }

    expect(labels).toEqual(Array.from({ length: 10 }, () => higher!.label));
  }, 60_000);

  it("through the gateway, when the only capable worker's matching devices are all leased, the request waits and is granted there once one is released", async () => {
    const fleet = await startGateway();
    const capable = await startWorker(fleet, {
      capability: "available",
      label: "worker-a",
      maxRunning: 1,
    });
    const lacking = await startWorker(fleet, { capability: "off", label: "worker-b" });
    await untilRead(fleet.gateway, capable);
    await untilRead(fleet.gateway, lacking);
    const holder = await lease(fleet.gateway, "holder");
    expect(holder.lease.worker?.label).toBe("worker-a");

    const waiting = lease(fleet.gateway, "waiter");
    const outcome = settle(waiting);
    await vi.waitFor(
      async () => {
        expect((await fleet.gateway.dispatch("status.get", {}, admin)).waiting).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(outcome.settled).toBe(false);
    await fleet.gateway.dispatch("lease.release", { leaseId: holder.lease.id }, agent("holder"));

    await settledWithin(outcome);
    expect((await waiting).lease.worker?.label).toBe("worker-a");
  }, 60_000);

  it("through the gateway, with no worker listing it available, the request fails at once with CAPABILITY_MISSING, message `No worker connected to this gateway can serve agent-device for this request`, details.capabilities [agent-device], and lease.rejected carries reason unresolvable-spec", async () => {
    const fleet = await startGateway();
    const off = await startWorker(fleet, { capability: "off", label: "worker-a" });
    await untilRead(fleet.gateway, off);

    await expect(lease(fleet.gateway, "agent-1")).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      message: MISSING_MESSAGE,
    });

    expect((await rejectedEvents(fleet.gateway)).map((event) => event.payload.reason)).toEqual([
      "unresolvable-spec",
    ]);
  }, 60_000);

  it("through the gateway, when only a worker without the capability knows the model, the request fails at once with CAPABILITY_MISSING", async () => {
    const fleet = await startGateway();
    const capable = await startWorker(fleet, {
      capability: "available",
      label: "worker-a",
      model: "Pixel-A",
    });
    const lacking = await startWorker(fleet, {
      capability: "off",
      label: "worker-b",
      model: "Pixel-B",
    });
    await untilRead(fleet.gateway, capable);
    await untilRead(fleet.gateway, lacking, "Pixel-B");

    await expect(lease(fleet.gateway, "agent-1", { model: "Pixel-B" })).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
    });
  }, 60_000);

  it("through the gateway, a request for an unknown model when no worker has the capability fails with UNKNOWN_MODEL, as today", async () => {
    const fleet = await startGateway();
    const off = await startWorker(fleet, { capability: "off", label: "worker-a" });
    await untilRead(fleet.gateway, off);

    await expect(lease(fleet.gateway, "agent-1", { model: "Nope" })).rejects.toMatchObject({
      code: "UNKNOWN_MODEL",
    });
  }, 60_000);

  it("through the gateway, with no connected worker at all, a request with requires fails with NO_CAPACITY, as today", async () => {
    const fleet = await startGateway();

    await expect(lease(fleet.gateway, "agent-1")).rejects.toMatchObject({ code: "NO_CAPACITY" });
  }, 60_000);

  it("through the gateway, a request waiting for the only capable worker fails with CAPABILITY_MISSING at the next pass after that worker's view says unavailable", async () => {
    const fleet = await startGateway();
    const capable = await startWorker(fleet, {
      capability: "available",
      label: "worker-a",
      maxRunning: 1,
    });
    await untilRead(fleet.gateway, capable);
    const holder = await lease(fleet.gateway, "holder");
    const waiting = lease(fleet.gateway, "waiter");
    const outcome = settle(waiting);
    await vi.waitFor(
      async () => {
        expect((await fleet.gateway.dispatch("status.get", {}, admin)).waiting).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(outcome.settled).toBe(false);

    await turn(fleet.gateway, capable, "unavailable");

    await settledWithin(outcome);
    await expect(waiting).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: MISSING_MESSAGE,
    });
    await fleet.gateway.dispatch("lease.release", { leaseId: holder.lease.id }, agent("holder"));
  }, 60_000);

  it("through the gateway, a request waiting for a busy capable worker is granted on a second worker once that worker's capability turns available and it has a free device", async () => {
    const fleet = await startGateway();
    const busy = await startWorker(fleet, {
      capability: "available",
      label: "worker-a",
      maxRunning: 1,
    });
    const second = await startWorker(fleet, { capability: "unavailable", label: "worker-b" });
    await untilRead(fleet.gateway, busy);
    await untilRead(fleet.gateway, second);
    await lease(fleet.gateway, "holder");
    const waiting = lease(fleet.gateway, "waiter");
    const outcome = settle(waiting);
    await vi.waitFor(
      async () => {
        expect((await fleet.gateway.dispatch("status.get", {}, admin)).waiting).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(outcome.settled).toBe(false);

    await turn(fleet.gateway, second, "available");

    await settledWithin(outcome);
    expect((await waiting).lease.worker?.label).toBe("worker-b");
  }, 60_000);

  it("through the gateway, a worker whose view says available but whose own check answers CAPABILITY_MISSING is skipped, and the request is granted on the next capable worker; with no next worker, the caller gets that CAPABILITY_MISSING", async () => {
    const fleet = await startGateway();
    const alpha = await startWorker(fleet, { capability: "available", label: "worker-a" });
    const beta = await startWorker(fleet, { capability: "available", label: "worker-b" });
    await untilRead(fleet.gateway, alpha);
    await untilRead(fleet.gateway, beta);
    const [lower, higher] = await byId(fleet.gateway, alpha, beta);
    // why: nothing makes the gateway read the worker again before the request, so its view still says available.
    lower!.fake.setUnavailable("down");

    const grant = await lease(fleet.gateway, "agent-1");
    expect(grant.lease.worker?.label).toBe(higher!.label);
    await fleet.gateway.dispatch("lease.release", { leaseId: grant.lease.id }, agent("agent-1"));

    higher!.fake.setUnavailable("down");
    await expect(lease(fleet.gateway, "agent-2")).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: "This worker cannot serve agent-device",
    });
  }, 60_000);

  it("through the gateway, requires: [agent-device, x-other] when no worker lists x-other fails with details.capabilities [agent-device, x-other] and a message naming agent-device, x-other", async () => {
    const fleet = await startGateway();
    const capable = await startWorker(fleet, { capability: "available", label: "worker-a" });
    await untilRead(fleet.gateway, capable);
    const grant = await lease(fleet.gateway, "agent-0");
    await fleet.gateway.dispatch("lease.release", { leaseId: grant.lease.id }, agent("agent-0"));

    await expect(
      lease(fleet.gateway, "agent-1", { requires: ["agent-device", "x-other"] }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device", "x-other"] },
      message: expect.stringContaining("agent-device, x-other"),
    });
  }, 60_000);

  it.each([
    ["absent", {}],
    ["[]", { requires: [] }],
  ])(
    "through the gateway, a request with requires %s is routed as today and its lease.requested requestSpec has no requires",
    async (_label, extra) => {
      const fleet = await startGateway();
      const off = await startWorker(fleet, { capability: "off", label: "worker-a" });
      await untilRead(fleet.gateway, off);

      const grant = await fleet.gateway.dispatch(
        "lease.request",
        { model: "Pixel-A", platform: "android", ...extra },
        agent("agent-1"),
      );

      expect(grant.lease.worker?.label).toBe("worker-a");
      const requested = (await fleet.gateway.dispatch("events.replay", {}, admin)).find(
        (entry: { event: string }) => entry.event === "lease.requested",
      ) as { payload: { requestSpec: unknown } };
      expect(requested.payload.requestSpec).toEqual({ model: "Pixel-A", platform: "android" });
    },
    60_000,
  );
});
