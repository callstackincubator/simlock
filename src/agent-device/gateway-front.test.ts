import { describe, expect, it, vi } from "vitest";
import {
  runningDaemons,
  secrets,
  principals,
  notAvailable,
  noWorker,
  holderCannot,
  missingMessage,
  phoneSerial,
  gatewayMaxTtlMs,
  workerCeilingMs,
  adminSession,
  sessionFor,
  setUp,
  viewOf,
  turn,
  advance,
  send,
  rpcBody,
  envelopeOf,
  hex,
  allocate,
  grantedOnGateway,
  release,
  command,
  workerLeases,
  fleetLeases,
  tenantOf,
  grantedDevice,
  tapDispatch,
  interceptRelay,
  relayFailsWith,
  allocatesReceived,
  first,
  restarted,
} from "./test-gateway.js";
import { listedByGateway, listedNames, picksTheDevice } from "./test-gateway-front.js";

describe("the agent-device front, through a gateway", { timeout: 60_000 }, () => {
  it("with capabilities.agent-device.command set on a gateway, the gateway logs that it ignores it and starts; with capabilities.agent-device.leaseTtlCapMs above lease.maxTtlMs on a gateway, the gateway fails to start, as a worker does", async () => {
    const rig = await setUp({ command: "agent-device-elsewhere", workers: [] });

    expect((await send(rig, "/health")).status).toBe(200);
    expect(
      rig.logs.records.some(
        (record) =>
          record.level === "warn" &&
          record.message ===
            'Ignoring "capabilities.agent-device.command": it configures a worker, and this daemon runs in gateway mode.',
      ),
    ).toBe(true);

    await expect(setUp({ leaseTtlCapMs: gatewayMaxTtlMs + 1, workers: [] })).rejects.toThrow(
      /capabilities\.agent-device\.leaseTtlCapMs/,
    );
  });

  it("with no capabilities.agent-device section on the gateway, /health, /rpc, upload/preflight, artifacts/<id> and a diagnostics URL each answer 404", async () => {
    const rig = await setUp({ agentDevice: "unset" });

    const answers = await Promise.all([
      send(rig, "/health"),
      send(rig, "/rpc", { body: rpcBody("agent_device.command", { command: "snapshot" }) }),
      send(rig, "/upload/preflight", { body: "{}" }),
      send(rig, "/artifacts/a.png"),
      send(rig, "/sessions/tok_one:s1/requests/r1/diagnostics"),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404]);
  });

  it("/health answers the proxy's health when a worker is capable, and the notAvailable reply naming `no worker connected to this gateway can serve agent-device`, with status 200, when none is; when the relay to the capable worker fails, it answers the notAvailable reply with status 200", async () => {
    const capable = await setUp();
    const health = await send(capable, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });

    const none = await setUp({ workers: [{ capability: "off", label: "off" }] });
    const empty = await send(none, "/health");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain(`${notAvailable}${noWorker}`);

    relayFailsWith(capable, "WORKER_UNREACHABLE", "Worker is not reachable");
    const failed = await send(capable, "/health");
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain(`${notAvailable}Worker is not reachable`);
  });

  it("with the only capable worker drained, allocate answers `refused by simlock: No worker in the fleet can currently serve this request`, while a command on a lease it already holds still works", async () => {
    const rig = await setUp();
    const member = first(rig);
    await grantedOnGateway(rig, 1);
    const view = await viewOf(rig, member.label);
    await rig.gateway.dispatch("worker.drain", { workerId: view?.id ?? "" }, adminSession);
    await vi.waitFor(async () => expect((await viewOf(rig, member.label))?.drained).toBe(true));

    const refused = await allocate(rig, 2);

    expect(refused.status).toBe(400);
    const refusalAnswer = await envelopeOf(refused);
    expect(refusalAnswer.error?.message).toBe(
      "refused by simlock: No worker in the fleet can currently serve this request",
    );
    expect(refusalAnswer.error?.data).toMatchObject({
      details: { reason: "SIMLOCK_UNAVAILABLE" },
      retriable: true,
    });
    const before = member.fake.rpcRequests("agent_device.command").length;
    const held = await envelopeOf(await command(rig, "snapshot", 1));
    expect(held.result).toMatchObject({ command: "snapshot", ok: true });
    expect(member.fake.rpcRequests("agent_device.command").length).toBe(before + 1);
  });

  it("with every worker that can serve agent-device drained, an allocate for a phone answers `refused by simlock: No worker in the fleet can currently serve this request`, as a drained fleet answers a plain lease, and nothing is leased", async () => {
    const rig = await setUp({
      workers: [{ label: "sim" }, { label: "phone", phone: true, platform: "android" }],
    });
    const phone = { physical: true, platform: "android" };
    await grantedOnGateway(rig, 1);
    await grantedOnGateway(rig, 2, phone);
    await release(rig, 1);
    await release(rig, 2);
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    for (const member of rig.members) {
      const view = await viewOf(rig, member.label);
      await rig.gateway.dispatch("worker.drain", { workerId: view?.id ?? "" }, adminSession);
      await vi.waitFor(async () => expect((await viewOf(rig, member.label))?.drained).toBe(true));
    }

    const physical = await envelopeOf(await allocate(rig, 4, phone));

    expect(physical.error?.message).toBe(
      "refused by simlock: No worker in the fleet can currently serve this request",
    );
    expect(await fleetLeases(rig)).toEqual([]);
  });

  it("a worker that disconnected does not count as capable", async () => {
    const rig = await setUp();
    const original = first(rig);
    expect((await send(rig, "/health")).status).toBe(200);
    const stopped = await original.daemon;
    await stopped.stop("test");
    runningDaemons.splice(runningDaemons.indexOf(stopped), 1);
    await vi.waitFor(async () =>
      expect((await viewOf(rig, original.label))?.connection).toBe("disconnected"),
    );

    const answer = await send(rig, "/health");

    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain(`${notAvailable}${noWorker}`);
  });

  it("a worker whose view says `available` but whose catalog was not read yet does not count as capable", async () => {
    const rig = await setUp();
    const original = first(rig);
    const stopped = await original.daemon;
    await stopped.stop("test");
    runningDaemons.splice(runningDaemons.indexOf(stopped), 1);
    await vi.waitFor(async () =>
      expect((await viewOf(rig, original.label))?.connection).toBe("disconnected"),
    );

    const restarted = await rig.addWorker({ ...original.spec, slowCatalog: true }, original);
    void restarted.daemon;
    await vi.waitFor(
      async () => {
        const view = await viewOf(rig, original.label);
        expect(view?.connection).toBe("connected");
        expect(view?.capabilities?.[0]?.state).toBe("available");
        expect(view?.catalogReadAt).toBeUndefined();
      },
      { timeout: 10_000 },
    );

    const unread = await send(rig, "/health");
    expect(await unread.text()).toContain(`${notAvailable}${noWorker}`);

    await advance(rig, 9_000, 1_000);
    await vi.waitFor(async () => expect((await send(rig, "/health")).status).toBe(200), {
      timeout: 10_000,
    });
    await expect
      .poll(
        async () => ((await (await send(rig, "/health")).json()) as { service?: string }).service,
      )
      .toBe("agent-device-proxy");
  });

  it("allocate through the gateway makes a simlock lease on the capable worker, owned by the token's principal, whose id and gateway requester are the CLI's lease id, and its `lease.request` carries `requires: [\"agent-device\"]`", async () => {
    const rig = await setUp();
    const tap = tapDispatch(rig.gateway);

    await grantedOnGateway(rig, 1);

    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(1);
    expect(await fleetLeases(rig)).toMatchObject([
      {
        id: hex(1),
        ownerId: principals.one,
        requesterId: hex(1),
        worker: { label: first(rig).label },
      },
    ]);
    expect(await workerLeases(first(rig))).toHaveLength(1);
    const request = tap.inputs.find((entry) => entry.operation === "lease.request");
    expect(request?.input).toMatchObject({ requesterId: hex(1), requires: ["agent-device"] });
  });

  it('through a gateway a physical allocate reaches the worker\'s phone daemon with `requires: ["agent-device"]`, a later command and `devices` follow, the reply carries `device.physical: true`, a phone daemon that is down answers `agent-device is not available on this simlock: phone daemon: <message>` with no lease, and after a gateway restart the live phone lease is adopted', async () => {
    const down = await setUp({ workers: [{ label: "w1", phone: true, platform: "android" }] });
    first(down).phone.setUnavailable("down");

    const refused = await envelopeOf(
      await allocate(down, 1, { physical: true, platform: "android" }),
    );

    expect(refused.error?.message).toBe(`${notAvailable}phone daemon: down`);
    expect(await fleetLeases(down)).toEqual([]);

    const rig = await setUp({ workers: [{ label: "w1", phone: true, platform: "android" }] });
    const member = first(rig);
    const tap = tapDispatch(rig.gateway);
    const answer = await envelopeOf(
      await allocate(rig, 1, { physical: true, platform: "android" }),
    );

    expect(answer.result).toMatchObject({
      data: { lease: { device: { model: "Pixel 8", osVersion: "15", physical: true } } },
    });
    const request = tap.inputs.find((entry) => entry.operation === "lease.request");
    expect(request?.input).toMatchObject({ physical: true, requires: ["agent-device"] });
    expect(member.phone.rpcRequests("agent_device.lease.allocate")).toHaveLength(1);
    expect(member.fake.rpcRequests("agent_device.lease.allocate")).toEqual([]);
    await listedByGateway(rig, 1);
    const reached = () => member.phone.rpcRequests("agent_device.command").length;
    expect((await envelopeOf(await command(rig, "snapshot", 1))).error).toBeUndefined();
    expect(reached()).toBe(1);
    member.phone.listDevices([{ id: phoneSerial, name: "the phone" }]);
    expect(await listedNames(await command(rig, "devices", undefined))).toEqual(["the phone"]);

    await restarted(rig, member, 1);
    const beforeBoot = reached();
    expect((await envelopeOf(await command(rig, "boot", 1))).result).toMatchObject({
      ok: true,
      data: { id: phoneSerial, kind: "device" },
    });
    expect(reached()).toBe(beforeBoot);
    expect((await envelopeOf(await command(rig, "snapshot", 1))).error).toBeUndefined();
    expect(member.fake.rpcRequests("agent_device.command")).toEqual([]);
    expect(reached()).toBe(3);
    const own = await envelopeOf(
      await command(rig, "snapshot", 1, {}, { flags: { serial: phoneSerial } }),
    );
    expect(own.error).toBeUndefined();
    expect(reached()).toBe(4);
    const other = await envelopeOf(
      await command(rig, "snapshot", 1, {}, { flags: { serial: "emulator-5554" } }),
    );
    expect(other.error?.message).toBe(picksTheDevice);
    expect(reached()).toBe(4);
  });

  it('allocate through the gateway with `osVersion` ">=18" or a `deviceBaseline` reaches the lease request with it and `requires: ["agent-device"]`, and the reply carries `data.lease.device` with the granted `deviceMode` (with `baseline` for the baseline); an unknown `deviceBaseline` answers `refused by simlock:`', async () => {
    const rig = await setUp();
    const tap = tapDispatch(rig.gateway);
    const worker = await first(rig).daemon;
    const held = await worker.dispatch(
      "lease.request",
      { platform: "ios" },
      sessionFor(principals.one),
    );
    await worker.dispatch(
      "baseline.save",
      { leaseId: held.lease.id, name: "logged-in" },
      adminSession,
    );
    await expect
      .poll(async () =>
        (await rig.gateway.dispatch("baseline.list", {}, adminSession)).baselines.map(
          (entry) => entry.name,
        ),
      )
      .toEqual(["logged-in"]);

    const answer = await envelopeOf(await allocate(rig, 1, { osVersion: ">=18" }));
    const based = await envelopeOf(await allocate(rig, 2, { deviceBaseline: "logged-in" }));
    const unknown = await envelopeOf(await allocate(rig, 3, { deviceBaseline: "no-such" }));

    const requests = tap.inputs.filter((entry) => entry.operation === "lease.request");
    expect(requests[0]?.input).toMatchObject({ osVersion: ">=18", requires: ["agent-device"] });
    expect(requests[1]?.input).toMatchObject({ baseline: "logged-in", requires: ["agent-device"] });
    const leaseOf = (reply: typeof answer) =>
      (reply.result as { data: { lease: Record<string, unknown> } }).data.lease;
    expect(leaseOf(answer)["device"]).toMatchObject({ deviceMode: "full", osVersion: "26.5" });
    expect(leaseOf(based)["device"]).toMatchObject({ baseline: { name: "logged-in", version: 1 } });
    expect(unknown.error?.message).toContain("refused by simlock: ");
  });

  it("allocate on a worker, directly, sends no `requires`, as today", async () => {
    const rig = await setUp({ workers: [{ direct: true, label: "w1" }] });
    const member = first(rig);
    const tap = tapDispatch(await member.daemon);

    await grantedOnGateway(member, 1, {}, { token: secrets.direct });

    const request = tap.inputs.find((entry) => entry.operation === "lease.request");
    expect(request).toBeDefined();
    expect(request?.input).not.toHaveProperty("requires");
  });

  it("with two workers, one capable, every allocate over 5 tries lands on the capable one", async () => {
    const rig = await setUp({
      workers: [
        { capability: "off", label: "plain" },
        { capability: "available", label: "capable" },
      ],
    });

    const labels: (string | undefined)[] = [];
    for (let n = 1; n <= 5; n += 1) {
      await grantedOnGateway(rig, n);
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(1);
      labels.push((await fleetLeases(rig))[0]?.worker?.label);
      expect((await envelopeOf(await release(rig, n))).result).toMatchObject({ ok: true });
      await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
    }

    expect(labels).toEqual(Array.from({ length: 5 }, () => "capable"));
  });

  it("the allocate the worker's agent-device daemon receives names the granted device, carries `ttlMs` equal to that worker's ceiling, and has tenant `gw.<gateway instance id>.<principal>.<lease id>`", async () => {
    const rig = await setUp();
    const member = first(rig);

    await grantedOnGateway(rig, 1);

    const received = allocatesReceived(member, 1);
    expect(received).toHaveLength(1);
    const device = await grantedDevice(member);
    expect(received[0]?.params).toMatchObject({ ttlMs: workerCeilingMs, udid: device.address });
    expect(received[0]?.tenant).toBe(await tenantOf(member, 1));
  });

  it("allocate with no capable worker answers the notAvailable reply, and nothing is leased", async () => {
    const rig = await setUp({ workers: [{ capability: "off", label: "off" }] });
    const member = first(rig);

    const answer = await allocate(rig, 1);

    expect(answer.status).toBe(503);
    expect((await envelopeOf(answer)).error).toMatchObject({
      message: `${notAvailable}${noWorker}`,
      data: { details: { reason: "SIMLOCK_UNAVAILABLE" }, retriable: true },
    });
    expect(await fleetLeases(rig)).toEqual([]);
    expect(await workerLeases(member)).toEqual([]);
    expect(member.fake.requests).toEqual([]);
  });

  it("allocate `--platform ios` when the capable workers have Android only is refused `refused: ios is not available on this simlock`", async () => {
    const rig = await setUp({ workers: [{ label: "droid", platform: "android" }] });
    await grantedOnGateway(rig, 1, { platform: "android" });
    await release(rig, 1);

    const answer = await envelopeOf(await allocate(rig, 2));

    expect(answer.error?.message).toBe("refused: ios is not available on this simlock");
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);
  });

  it("allocate when only an incapable worker knows the model answers `refused by simlock: No worker connected to this gateway can serve agent-device for this request`, and nothing is leased", async () => {
    const rig = await setUp({
      workers: [
        { label: "capable", model: "iPhone 16" },
        { capability: "off", label: "plain", model: "iPhone 17 Pro" },
      ],
    });
    await grantedOnGateway(rig, 1, { device: "iPhone 16" });
    await release(rig, 1);
    await expect.poll(async () => (await fleetLeases(rig)).length).toBe(0);

    const answer = await envelopeOf(await allocate(rig, 2, { device: "iPhone 17 Pro" }));

    expect(answer.error?.message).toBe(`refused by simlock: ${missingMessage}`);
    expect(await fleetLeases(rig)).toEqual([]);
    for (const member of rig.members) expect(await workerLeases(member)).toEqual([]);
  });

  it("allocate whose lease's worker stops being capable between the grant and the forward releases the simlock lease and answers the notAvailable reply naming `the worker holding this lease cannot serve agent-device`", async () => {
    const rig = await setUp();
    const member = first(rig);
    const tap = tapDispatch(rig.gateway);
    tap.afterNext("lease.request", () => turn(rig, member, "unavailable"));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toMatchObject({
      message: `${notAvailable}${holderCannot}`,
      data: { details: { reason: "SIMLOCK_UNAVAILABLE" }, retriable: true },
    });
    await expect.poll(async () => (await workerLeases(member)).length).toBe(0);
    expect(await fleetLeases(rig)).toEqual([]);
    expect(allocatesReceived(member)).toEqual([]);
  });

  it("allocate relayed to a worker whose own agent-device went down while the gateway's view still said `available` answers the notAvailable reply with the worker's reason, and the simlock lease is released", async () => {
    const rig = await setUp();
    const member = first(rig);
    interceptRelay(rig, () => member.fake.setUnavailable("agent-device crashed"));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error?.message).toBe(`${notAvailable}agent-device crashed`);
    await expect.poll(async () => (await workerLeases(member)).length).toBe(0);
    expect(await fleetLeases(rig)).toEqual([]);
  });
});
