import { describe, expect, it } from "vitest";
import {
  catalogFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher", () => {
  describe("lease lifecycle and device.exec (#118)", () => {
    it("forwards lease.request through the fleet coordinator and answers UNKNOWN_LEASE for renew/release/exec against an id it never issued", async () => {
      const { clock, dispatcher } = harness();

      await expect(
        dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17", noWait: true, platform: "ios" },
          session({ role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "NO_CAPACITY" });

      const ghostCalls = [
        ["lease.renew", { leaseId: "wrk_ghost.lease_1" }],
        ["lease.release", { leaseId: "wrk_ghost.lease_1" }],
        ["device.exec", { args: [], leaseId: "wrk_ghost.lease_1", tool: "adb" }],
      ] as const;
      // why: inside the gateway's first minute a generated id may belong to a worker yet to report, which answers WORKER_UNREACHABLE.
      clock.advance(59_999);
      for (const [operation, input] of ghostCalls) {
        await expect(
          dispatcher.dispatch(operation, input, session({ role: "agent" })),
        ).rejects.toMatchObject({ code: "WORKER_UNREACHABLE" });
      }
      clock.advance(1);
      for (const [operation, input] of ghostCalls) {
        await expect(
          dispatcher.dispatch(operation, input, session({ role: "agent" })),
        ).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });
      }
    });

    it("refuses a lease.request that names no requesterId when the session principal has a control character", async () => {
      const { dispatcher } = harness();

      await expect(
        dispatcher.dispatch(
          "lease.request",
          { model: "iPhone 17", noWait: true, platform: "ios" },
          session({ principal: "a\u001b[2Jb", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it.each([
      ["with noWait: true", { noWait: true }],
      ["without noWait", {}],
    ])(
      "refuses a lease.request carrying fleetRequestId with FORBIDDEN from every session, even the uplink, %s",
      async (_label, extra) => {
        const { dispatcher } = harness();
        const input = { fleetRequestId: "req_gw1", model: "iPhone 17", platform: "ios", ...extra };

        for (const refused of [
          session({ role: "agent" }),
          session({ role: "admin" }),
          session({ isGatewayUplink: true, role: "admin" }),
        ]) {
          await expect(dispatcher.dispatch("lease.request", input, refused)).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("fleetRequestId"),
          });
        }
      },
    );

    it("answers not-found for lease.cancel and an empty result for lease.release-all with nothing queued or leased", async () => {
      const { dispatcher } = harness();

      await expect(
        dispatcher.dispatch("lease.cancel", {}, session({ role: "agent" })),
      ).resolves.toEqual({ result: "not-found" });
      await expect(dispatcher.dispatch("lease.release-all", {}, session())).resolves.toEqual({
        leaseIds: [],
      });
    });

    // why: ADR §27a's whole point: the owner a rebuilt lease authorizes against has to be the real
    // principal the worker round-tripped back, not this gateway's own uplink principal -- and it
    // has to work on an index built purely by `rebuildFromWorker` (a reconnect), never through
    // `coordinator.request` in this process. This is the one place a naive "derive ownerId from
    // the connection" implementation and a correct one visibly disagree.
    it("authorizes lease.renew for the original requester and forbids everyone else, on a lease rebuilt after reconnect", async () => {
      const { dispatcher, directory, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", {
        leases: [
          {
            ...leaseFixture("lease_1", "dev_1"),
            ownerId: "alice-principal",
            requesterId: `${GATEWAY_REQUESTER_PREFIX}alice`,
          },
        ],
      });
      const gatewayLeaseId = "wrk_1.lease_1";
      client.renewLeaseQueue.push({
        kind: "ok",
        record: {
          ...leaseFixture("lease_1", "dev_1"),
          ownerId: "alice-principal",
          ttlMs: 1_800_000,
        },
      });

      await expect(
        dispatcher.dispatch(
          "lease.renew",
          { leaseId: gatewayLeaseId },
          session({ principal: "alice-principal", role: "agent" }),
        ),
      ).resolves.toMatchObject({ id: gatewayLeaseId, requesterId: "alice" });

      await expect(
        dispatcher.dispatch(
          "lease.renew",
          { leaseId: gatewayLeaseId },
          session({ principal: "mallory-principal", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it.each([
      ["mode slim", { mode: "slim" as const }],
      ["no mode", {}],
    ])("forwards a lease.request with %s to the worker as it arrived", async (_label, mode) => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17", noWait: true, platform: "ios", ...mode },
        session({ role: "agent" }),
      );

      if ("mode" in mode) expect(client.lastRequestLeaseInput).toMatchObject(mode);
      else expect(client.lastRequestLeaseInput).not.toHaveProperty("mode");
    });

    it.each([
      ["a class", { class: "phone", platform: "ios" }],
      ["neither a model nor a class", { platform: "ios" }],
      ["a class and an OS range", { class: "phone", osVersion: ">=18", platform: "ios" }],
      ["a model and an OS range", { model: "iPhone 17", osVersion: ">=18", platform: "ios" }],
      [
        "a model and an exact osVersion",
        { model: "iPhone 17", osVersion: "26.0", platform: "ios" },
      ],
    ] as const)(
      "serves a lease.request naming %s through a worker that fits, forwarding it as it arrived",
      async (_label, input) => {
        const { directory, dispatcher, workers } = harness();
        const client = new ScriptedWorkerClient();
        directory.add("wrk_1", client);
        workers.connected("wrk_1", undefined, "0.3.0");
        workers.refresh("wrk_1", {
          capacity: statusFixture().capacity,
          health: "running",
          queueDepth: 0,
          catalog: catalogFixture([
            {
              modelClasses: { "iPhone 17": "phone" } as const,
              models: ["iPhone 17"],
              platform: "ios",
              runtimes: ["26.0"],
            },
          ]).platforms,
          downloads: { policy: "on-request" },
        });
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

        await dispatcher.dispatch(
          "lease.request",
          { ...input, noWait: true },
          session({ role: "agent" }),
        );

        expect(client.lastRequestLeaseInput).toMatchObject(input);
        if (!("model" in input)) expect(client.lastRequestLeaseInput).not.toHaveProperty("model");
      },
    );

    it("forwards a lease.request's image tag and baseline to the worker unchanged", async () => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        baselines: [
          {
            imageTag: "google_apis_playstore",
            mode: "full",
            model: "Pixel 8",
            name: "checkout",
            osVersion: "34",
            platform: "android",
            savedAt: "2026-11-02T13:10:00Z",
            version: 1,
          },
        ],
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([
          {
            images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" }],
            models: ["Pixel 8"],
            platform: "android",
            runtimes: ["34"],
          },
        ]).platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      await dispatcher.dispatch(
        "lease.request",
        {
          baseline: "checkout",
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          noWait: true,
          platform: "android",
        },
        session({ role: "agent" }),
      );

      expect(client.lastRequestLeaseInput).toMatchObject({
        baseline: "checkout",
        imageTag: "google_apis_playstore",
      });
    });

    it("forwards a lease.request's leaseId to the worker, and answers the grant under that ID with no worker in front of it", async () => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({
        grant: grantFixture({
          lease: { ...grantFixture().lease, id: "ad-7f3a", idChosenByRequester: true },
        }),
        kind: "grant",
      });

      const grant = await dispatcher.dispatch(
        "lease.request",
        { leaseId: "ad-7f3a", model: "iPhone 17", noWait: true, platform: "ios" },
        session({ role: "agent" }),
      );

      expect(client.lastRequestLeaseInput).toMatchObject({ leaseId: "ad-7f3a" });
      expect(grant.lease).toMatchObject({ id: "ad-7f3a", idChosenByRequester: true });
    });

    it("forwards device.exec to the worker that holds the lease, gated on the caller owning it", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      client.execQueue.push({ exitCode: 3, kind: "ok" });

      await expect(
        dispatcher.dispatch(
          "device.exec",
          { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
          session({ principal: "agent-1", role: "agent" }),
        ),
      ).resolves.toEqual({ exitCode: 3 });

      await expect(
        dispatcher.dispatch(
          "device.exec",
          { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
          session({ principal: "someone-else", role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a device.exec whose stdin is longer than 8,388,608 characters with BAD_REQUEST and forwards nothing to the worker, and forwards one at 8,388,608", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      const exec = (stdin: string) =>
        dispatcher.dispatch(
          "device.exec",
          { args: ["spawn", "booted", "untar"], leaseId: grant.lease.id, stdin, tool: "simctl" },
          session({ principal: "agent-1", role: "agent" }),
        );
      const forwarded = () => client.calls.filter((call) => call.startsWith("device.exec:"));

      client.execQueue.push({ exitCode: 0, kind: "ok" });
      await expect(exec("A".repeat(8_388_608))).resolves.toEqual({ exitCode: 0 });
      expect(forwarded()).toHaveLength(1);

      await expect(exec("A".repeat(8_388_609))).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(forwarded()).toHaveLength(1);
    });

    it("forwards a device.exec's stdinFile to the lease's worker under the same name, and nothing when it is omitted", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      const exec = (extra: { stdinFile?: string }) => {
        client.execQueue.push({ exitCode: 0, kind: "ok" });
        return dispatcher.dispatch(
          "device.exec",
          { args: ["spawn", "booted", "untar"], leaseId: grant.lease.id, tool: "simctl", ...extra },
          session({ principal: "agent-1", role: "agent" }),
        );
      };

      await exec({ stdinFile: "fixture.tar" });
      await exec({});

      expect(client.execInputs.map((forwarded) => forwarded.stdinFile)).toEqual([
        "fixture.tar",
        undefined,
      ]);
      expect("stdinFile" in (client.execInputs[1] ?? {})).toBe(false);
    });

    it("calls onStarted for a silent device.exec from the worker's own started push (ADR §19a/§19b/§19e)", async () => {
      const { coordinator, directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const grant = await coordinator.request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: true, ownerId: "agent-1", requesterId: "agent-1" },
      );
      // why: §19b's own worked example: `simctl install <path>` never writes anything while it runs,
      // and the worker here never answers at all -- but it does say the process exists, which is
      // the fact a transport needs to commit its 200. No clock is advanced below: this asserts
      // the relay, not a timer.
      client.execQueue.push({ kind: "hang", started: true });

      let started = false;
      void dispatcher.dispatch(
        "device.exec",
        { args: ["install", "/path/to.app"], leaseId: grant.lease.id, tool: "simctl" },
        session({
          onStarted: () => {
            started = true;
          },
          principal: "agent-1",
          role: "agent",
        }),
      );
      await expect.poll(() => started).toBe(true);
    });

    it.each([
      { owner: "someone-else", principal: "agent-1", role: "agent" as const },
      { owner: "agent-7", principal: "operator-1", role: "admin" as const },
    ])(
      "lease.request: rejects a $role session naming owner with FORBIDDEN, never silently ignoring it (ADR §27a, H3, H7)",
      async ({ owner, principal, role }) => {
        const { directory, dispatcher, workers } = harness();
        const client = new ScriptedWorkerClient();
        directory.add("wrk_1", client);
        workers.connected("wrk_1", undefined, "0.3.0");
        workers.refresh("wrk_1", {
          capacity: statusFixture().capacity,
          health: "running",
          queueDepth: 0,
          catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
            .platforms,
          downloads: { policy: "on-request" },
        });
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

        await expect(
          dispatcher.dispatch(
            "lease.request",
            { model: "iPhone 17", noWait: true, owner, platform: "ios" },
            session({ principal, role }),
          ),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      },
    );

    it("lease.request: forwards owner as `ownerId` end to end when the session is the gateway's own uplink (ADR §27a, H3) -- exercising the same field the worker's own dispatcher gates, on this dispatcher's shared handler shape", async () => {
      const { directory, dispatcher, leaseIndex, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17", noWait: true, owner: "agent-7", platform: "ios" },
        session({ isGatewayUplink: true, principal: "gw:instance-1", role: "admin" }),
      );

      const gatewayLeaseId = (grant as { lease: { id: string } }).lease.id;
      expect((grant as { lease: { ownerId: string } }).lease.ownerId).toBe("agent-7");
      expect(leaseIndex.ownerId(gatewayLeaseId)).toBe("agent-7");
    });

    it("lease.request: names the stored request to the session and replays it under the same idempotency key, forwarding nothing twice", async () => {
      const { directory, dispatcher, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_1", client);
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", {
        capacity: statusFixture().capacity,
        health: "running",
        queueDepth: 0,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        downloads: { policy: "on-request" },
      });
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const admitted: [string, boolean][] = [];
      const input = { idempotencyKey: "key-1", model: "iPhone 17", platform: "ios" } as const;
      const track = session({
        onRequestAdmitted: (id, replayed) => admitted.push([id, replayed]),
        principal: "agent-1",
        role: "agent",
      });

      const first = await dispatcher.dispatch("lease.request", input, track);
      const repeat = await dispatcher.dispatch("lease.request", input, track);

      expect((repeat as { lease: { id: string } }).lease.id).toBe(
        (first as { lease: { id: string } }).lease.id,
      );
      expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
      expect(admitted).toEqual([
        [expect.stringMatching(/^req_/), false],
        [admitted[0]?.[0], true],
      ]);
    });
  });
});
