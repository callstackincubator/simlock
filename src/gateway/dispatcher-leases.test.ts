import { describe, expect, it } from "vitest";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, GATEWAY_HOST, harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher", () => {
  it("lists the fleet's leases and devices, each naming its worker", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", {
      devices: [deviceFixture("dev_1", "leased")],
      leases: [leaseFixture("lease_1", "dev_1")],
    });

    await expect(dispatcher.dispatch("lease.list", {}, session())).resolves.toEqual({
      leases: [expect.objectContaining({ id: "lease_1", workerId: "wrk_1" })],
    });
    await expect(dispatcher.dispatch("list.get", { kind: "devices" }, session())).resolves.toEqual([
      expect.objectContaining({ id: "dev_1", workerId: "wrk_1" }),
    ]);
    // why: Cleanup rules are a machine's own configuration, and a gateway runs no reaper.
    await expect(dispatcher.dispatch("list.get", { kind: "rules" }, session())).resolves.toEqual(
      [],
    );
  });

  it("lease.get reads one lease by its gateway id for its owner or an admin, a worker's own local lease for an admin only, and answers UNKNOWN_LEASE otherwise", async () => {
    const { dispatcher, leaseIndex, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const issued = {
      ...leaseFixture("lease_1", "dev_1"),
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
    };
    const local = { ...leaseFixture("local_1", "dev_2"), ownerId: "worker-agent" };
    workers.refresh("wrk_1", { leases: [issued, local] });
    const owner = session({ principal: "agent-1", role: "agent" });
    const stranger = session({ principal: "agent-2", role: "agent" });
    const get = (leaseId: string, who: ReturnType<typeof session>) =>
      dispatcher.dispatch("lease.get", { leaseId }, who);

    await expect(get("wrk_1.lease_1", owner)).resolves.toEqual({
      lease: expect.objectContaining({ id: "wrk_1.lease_1", workerId: "wrk_1" }),
    });
    await expect(get("wrk_1.lease_1", session())).resolves.toMatchObject({
      lease: { id: "wrk_1.lease_1" },
    });
    await expect(get("local_1", session())).resolves.toMatchObject({
      lease: { id: "local_1", workerId: "wrk_1" },
    });
    const unknown = { code: "UNKNOWN_LEASE", details: { leaseId: expect.any(String) } };
    await expect(get("wrk_1.lease_1", stranger)).rejects.toMatchObject(unknown);
    await expect(get("local_1", stranger)).rejects.toMatchObject(unknown);
    await expect(get("wrk_1.lease_nope", session())).rejects.toMatchObject(unknown);
    await expect(get("lease_1", session())).rejects.toMatchObject(unknown);
    // why: an index entry can outlive its worker view, or the view its lease.
    for (const [workerId, workerLeaseId] of [
      ["wrk_gone", "lease_9"],
      ["wrk_1", "lease_gone"],
    ] as const) {
      leaseIndex.add({
        gatewayLeaseId: `${workerId}.${workerLeaseId}`,
        grantedAt: 1,
        ownerId: "agent-1",
        requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
        workerId,
        workerLeaseId,
      });
      await expect(get(`${workerId}.${workerLeaseId}`, session())).rejects.toMatchObject(unknown);
      await expect(get(`${workerId}.${workerLeaseId}`, owner)).rejects.toMatchObject(unknown);
    }
  });

  it("names the worker's own lease id as workerLeaseId on the leases of lease.list, lease.get and list.get kind=leases, never on status.get", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const issued = (id: string, chosen: boolean) => ({
      ...leaseFixture(id, `dev_${id}`),
      idChosenByRequester: chosen,
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
    });
    workers.refresh("wrk_1", {
      leases: [
        issued("lse_42", false),
        issued("my-lease", true),
        leaseFixture("local_1", "dev_local"),
      ],
    });
    const expected = [
      { id: "wrk_1.lse_42", workerLeaseId: "lse_42" },
      { id: "my-lease", workerLeaseId: "my-lease" },
      { id: "local_1", workerLeaseId: "local_1" },
    ];
    const pick = (leases: readonly { id: string; workerLeaseId?: string | undefined }[]) =>
      leases.map(({ id, workerLeaseId }) => ({ id, workerLeaseId }));

    const listed = await dispatcher.dispatch("lease.list", {}, session());
    expect(pick(listed.leases)).toEqual(expected);
    const fleet = await dispatcher.dispatch("list.get", { kind: "leases" }, session());
    expect(pick(fleet as never)).toEqual(expected);
    const owned = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "agent-1", role: "agent" }),
    );
    expect(pick(owned.leases)).toEqual(expected.slice(0, 2));
    for (const { id, workerLeaseId } of expected) {
      const { lease } = await dispatcher.dispatch("lease.get", { leaseId: id }, session());
      expect(lease).toMatchObject({ id, workerLeaseId });
    }
    const status = await dispatcher.dispatch("status.get", {}, session());
    expect((status.leases ?? []).map((lease) => Object.keys(lease))).toEqual(
      expected.map(() => expect.not.arrayContaining(["workerLeaseId"])),
    );
  });

  it.each([
    ["an agent", session({ principal: "agent-1", role: "agent" })],
    ["an admin", session({ principal: "claude-code:1", role: "admin" })],
  ])(
    "lease.list lists the lease to %s that asked for it as soon as lease.request answers, before the worker's own lease event has refreshed the view",
    async (_who, asker) => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        devices: [deviceFixture("dev_1")],
        downloads: { policy: "on-request" },
        health: "running",
        leases: [],
        queueDepth: 0,
      });
      const workerLease = {
        ...grantFixture().lease,
        ownerId: asker.principal,
        requesterId: `${GATEWAY_REQUESTER_PREFIX}${asker.principal}`,
      };
      client.requestLeaseQueue.push({ grant: grantFixture({ lease: workerLease }), kind: "grant" });
      // why: the worker lists the lease once the gateway reads its view again; the read its `lease.granted` push starts has not landed.
      directory.onRefresh.set("wrk_1", async () => {
        await new Promise((resolve) => setImmediate(resolve));
        workers.refresh("wrk_1", {
          devices: [deviceFixture("dev_1", "leased")],
          leases: [workerLease],
        });
      });

      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17", platform: "ios" },
        asker,
      );
      const { leases } = await dispatcher.dispatch("lease.list", {}, asker);

      expect((grant as { lease: { id: string } }).lease.id).toBe("wrk_1.lse_1");
      expect(leases.map(({ id, requesterId }) => ({ id, requesterId }))).toEqual([
        { id: "wrk_1.lse_1", requesterId: asker.principal },
      ]);
    },
  );

  it("lists no device or lease for a worker that is starting, whether the session is an admin or the owner of a lease the gateway indexed on it, and answers worker.list with the view as it is", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const lease = {
      ...leaseFixture("lease_1", "dev_1"),
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
    };
    workers.refresh("wrk_1", {
      devices: [deviceFixture("dev_1", "leased")],
      health: "running",
      leases: [lease],
    });
    const owner = session({ principal: "agent-1", role: "agent" });
    await expect(dispatcher.dispatch("lease.list", {}, owner)).resolves.toEqual({
      leases: [expect.objectContaining({ id: "wrk_1.lease_1" })],
    });

    workers.refresh("wrk_1", { health: "starting", host: GATEWAY_HOST });

    await expect(dispatcher.dispatch("lease.list", {}, session())).resolves.toEqual({
      leases: [],
    });
    await expect(dispatcher.dispatch("lease.list", {}, owner)).resolves.toEqual({ leases: [] });
    await expect(dispatcher.dispatch("list.get", { kind: "devices" }, session())).resolves.toEqual(
      [],
    );
    const { workers: views } = await dispatcher.dispatch("worker.list", {}, session());
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ health: "starting", host: GATEWAY_HOST, id: "wrk_1" });
    expect(Object.keys(views[0] ?? {})).not.toContain("leases");
  });

  it("inbox.get answers the items the fleet's views, leases, waiting requests and tokens make", async () => {
    const holders = async (options: Parameters<typeof harness>[0]) => {
      const { clock, dispatcher, workers } = harness(options);
      workers.connected("wrk_1", "mac-mini-1", "0.3.0");
      workers.refresh("wrk_1", {
        devices: [deviceFixture("dev_1", "leased")],
        health: "running",
        leases: [{ ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 121_000 }],
        waiting: [
          {
            createdAt: 500,
            id: "req_1",
            requesterId: "agent-2",
            spec: { model: "iPhone 17", platform: "ios" },
            stage: "starting",
          },
        ],
      });
      workers.connected("wrk_2", "mac-mini-2", "0.3.0");
      workers.disconnected("wrk_2");
      clock.advance(60_000);
      const { items } = await dispatcher.dispatch("inbox.get", {}, session());
      return items;
    };

    const named = await holders({ tokenRecords: [{ id: "agent-1", label: "ci-runner" }] });

    expect(named).toEqual([
      expect.objectContaining({ condition: "disconnected", key: "wrk_2/disconnected" }),
      expect.objectContaining({ condition: "waiting", key: "request/req_1/waiting" }),
      expect.objectContaining({
        condition: "ending",
        key: "lease/lease_1/ending",
        lease: expect.objectContaining({ holder: "ci-runner", model: "iPhone 17" }),
      }),
    ]);
    const unnamed = await holders({ withoutTokens: true });
    expect(unnamed).toContainEqual(
      expect.objectContaining({ lease: expect.objectContaining({ holder: "agent-1" }) }),
    );
  });

  it("lists each of an owner's gateway-issued leases under its own record, and none whose worker has no view", async () => {
    const { dispatcher, leaseIndex, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const owned = (id: string, deviceId: string) => ({
      ...leaseFixture(id, deviceId),
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
      ttlMs: id === "lease_1" ? 111 : 222,
    });
    workers.refresh("wrk_1", { leases: [owned("lease_1", "dev_1"), owned("lease_2", "dev_2")] });
    // why: An entry for a worker the gateway holds no view of, as a race with a removal leaves it.
    leaseIndex.add({
      gatewayLeaseId: "wrk_gone.lease_9",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_gone",
      workerLeaseId: "lease_9",
    });

    const { leases } = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "agent-1", role: "agent" }),
    );

    expect(leases.map(({ id, ttlMs }) => ({ id, ttlMs }))).toEqual([
      { id: "wrk_1.lease_1", ttlMs: 111 },
      { id: "wrk_1.lease_2", ttlMs: 222 },
    ]);
  });

  it("shows a non-admin session none of a worker's own local leases", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "someone", role: "agent" })),
    ).resolves.toEqual({ leases: [] });
  });

  it("does not let a gateway session's raw principal match a worker's own local lease owner of the same name", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "agent-1", role: "agent" })),
    ).resolves.toEqual({ leases: [] });
  });

  it("sees a gateway-issued lease rebuilt from a worker's view, rewritten to its gateway id", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", undefined);
    const lease = {
      ...leaseFixture("lease_1", "dev_1"),
      ownerId: "agent-1",
      requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1`,
    };
    workers.refresh("wrk_1", { leases: [lease] });

    await expect(
      dispatcher.dispatch("lease.list", {}, session({ principal: "agent-1", role: "agent" })),
    ).resolves.toEqual({
      leases: [
        expect.objectContaining({
          id: "wrk_1.lease_1",
          requesterId: "agent-1",
          worker: { id: "wrk_1", label: "mac-mini-1" },
        }),
      ],
    });
  });

  it("status.get: an agent sees only the fleet leases and fleet requests it owns, one that owns none sees empty lists, admin sees all", async () => {
    const { coordinator, directory, dispatcher, workers } = harness();
    directory.add("wrk_1", new ScriptedWorkerClient());
    const capacity = statusFixture().capacity;
    const issued = (id: string, deviceId: string, ownerId: string) => ({
      ...leaseFixture(id, deviceId),
      ownerId,
      requesterId: `${GATEWAY_REQUESTER_PREFIX}${ownerId}`,
    });
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } },
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      health: "running",
      // why: lease_3 is the worker's own local lease, owned by a local "agent-1" this gateway never issued to.
      leases: [
        issued("lease_1", "dev_1", "agent-1"),
        issued("lease_2", "dev_2", "agent-2"),
        leaseFixture("lease_3", "dev_3"),
      ],
      queueDepth: 0,
    });
    const wait = (ownerId: string, requesterId: string) =>
      void coordinator
        .request(
          { model: "iPhone 17", platform: "ios" },
          { allowDownload: false, noWait: false, ownerId, requesterId },
        )
        .catch(() => undefined);
    wait("agent-1", "fleet-a");
    wait("agent-3", "fleet-b");
    await expect.poll(() => coordinator.queueDepth).toBe(2);

    const cases = [
      [
        "admin",
        { principal: "operator-1", role: "admin" },
        ["wrk_1.lease_1", "wrk_1.lease_2", "lease_3"],
        ["fleet-a", "fleet-b"],
      ],
      [
        "an agent with a lease and a waiting request",
        { principal: "agent-1", role: "agent" },
        ["wrk_1.lease_1"],
        ["fleet-a"],
      ],
      [
        "an agent with a lease only",
        { principal: "agent-2", role: "agent" },
        ["wrk_1.lease_2"],
        [],
      ],
      [
        "an agent with a waiting request only",
        { principal: "agent-3", role: "agent" },
        [],
        ["fleet-b"],
      ],
      ["an agent that owns nothing", { principal: "nobody", role: "agent" }, [], []],
    ] as const;
    const seen = await Promise.all(
      cases.map(async ([name, who]) => {
        const status = await dispatcher.dispatch("status.get", {}, session(who));
        return {
          leases: status.leases?.map((lease) => lease.id),
          name,
          waiting: status.waiting?.map((request) => request.requesterId),
        };
      }),
    );

    expect(seen).toEqual(cases.map(([name, , leases, waiting]) => ({ leases, name, waiting })));

    // why: `workers[]` repeats each worker's own leases and waiting requests, so an agent must not read them there.
    const held = (status: Awaited<ReturnType<typeof dispatcher.dispatch<"status.get">>>) =>
      (status.workers ?? []).flatMap((worker) => [
        ...(worker.leases ?? []).map((lease) => lease.id),
        ...(worker.waiting ?? []).map((request) => request.requesterId),
      ]);
    expect(
      held(
        await dispatcher.dispatch(
          "status.get",
          {},
          session({ principal: "operator-1", role: "admin" }),
        ),
      ),
    ).not.toEqual([]);
    for (const principal of ["agent-1", "agent-2", "nobody"]) {
      expect(
        held(await dispatcher.dispatch("status.get", {}, session({ principal, role: "agent" }))),
        principal,
      ).toEqual([]);
    }
  });
});
