import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  createClient,
  createHarness,
  flush,
  hello,
  leaseIdOf,
  stopTestDaemons,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer", () => {
  it("keeps a lease when its client connection closes, and ends it at its own deadline", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);

    await holder.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    expect(grant.ok).toBe(true);
    const leaseId = leaseIdOf(grant);
    await holder.close();

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: { devices: [{ state: "leased" }], leases: [{ id: leaseId }] },
    });

    harness.clock.advance(40);
    // why: a virtual device that ended a lease is deleted, never granted again (ADR 0061).
    await expect
      .poll(async () => (await observer.request("status.get", {})).payload)
      .toMatchObject({ leases: [], devices: [{ state: "deleted" }] });
    await observer.close();
  });

  it("releases on an explicit lease.release, which is what a holder does on its way out", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    await expect(
      holder.request("lease.release", { leaseId: leaseIdOf(grant) }),
    ).resolves.toMatchObject({ ok: true });

    await expect
      .poll(async () => (await holder.request("status.get", {})).payload)
      .toMatchObject({ leases: [], devices: [{ state: "deleted" }] });
    await holder.close();
  });

  it("requires a compatible hello before serving requests", async () => {
    const harness = await createHarness();
    const missingHello = await createClient(harness.socketPath);

    await expect(missingHello.request("status.get", {})).resolves.toMatchObject({
      error: { code: "HANDSHAKE_REQUIRED" },
      ok: false,
    });
    await missingHello.close();

    const wrongVersion = await createClient(harness.socketPath);
    await expect(
      wrongVersion.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION + 1,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        details: {
          client: { min: DAEMON_PROTOCOL_VERSION + 1, max: DAEMON_PROTOCOL_VERSION + 1 },
          daemon: PROTOCOL_VERSION_RANGE,
        },
      },
      ok: false,
    });
  });

  it.each([
    [1, "speaks a wire this daemon cannot serve"],
    [17, "cannot parse a starting status.get answer"],
    [18, "cannot parse config.get's warmPool.targets"],
    [20, "cannot send lease.request's leaseId or read a lease's idChosenByRequester"],
    [21, "cannot send lease.request's fleetRequestId"],
    [24, "cannot send lease.request's physical or read physicalQueueDepth"],
    [26, "cannot read a physical device's presence"],
    [27, "cannot read config.get's lease.maxPerRequester"],
    [28, "cannot read config.get's lease.endWaitMs"],
    [29, "cannot read config.get's agentDevice"],
    [30, "cannot read the agent-device-unavailable finding in doctor.run"],
    [
      32,
      "cannot read status.get's capabilities, send lease.request's requires, or call relay.request",
    ],
    [33, "cannot send relay.request's channel, or read a relayed body from its byte channel"],
    [34, "cannot read status.get's load block"],
    [35, "cannot read a worker view's load"],
    [36, "cannot read the module-unavailable finding in doctor.run"],
    [37, "cannot read config.get's capabilities"],
    [38, "cannot read agent-device's section under config.get's capabilities"],
    [46, "cannot call identity.get"],
    [47, "cannot read config.get's http.proxyAuth"],
    [48, "cannot read config.get's gateway.alerts"],
    [51, "cannot page events.replay with beforeId or limit"],
    [75, "cannot read config.get's drivers"],
  ])(
    "answers PROTOCOL_VERSION_UNSUPPORTED, naming the daemon's protocol range, to a client on protocol %i, which %s",
    async (version) => {
      const harness = await createHarness();
      const previous = await createClient(harness.socketPath);

      await expect(
        previous.request("hello", { clientVersion: "test", protocolVersion: version }),
      ).resolves.toMatchObject({
        error: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          details: { client: { min: version, max: version }, daemon: PROTOCOL_VERSION_RANGE },
        },
        ok: false,
      });
    },
  );

  it("grants the queued client when the holder's lease expires, not when it disconnects", async () => {
    // why: A log sink rather than a sleep: "the waiter stays queued" is a negative assertion, and
    // the only honest way to make one is to wait for the daemon to have actually processed
    // the close first. `Connection closed` is that receipt.
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      lease: { defaultTtlMs: 40 },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), level: "debug", sink }),
    });
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await hello(holder);
    await hello(waiter);
    await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    const queuedGrant = waiter.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    await expect
      .poll(() => harness.eventBus.replay().some((event) => event.event === "lease.queued"))
      .toBe(true);

    await holder.close();
    await expect
      .poll(() => sink.records.some((record) => record.message === "Connection closed"))
      .toBe(true);
    const observer = await createClient(harness.socketPath);
    await hello(observer);
    const holders = async () =>
      (
        (await observer.request("status.get", {})).payload as {
          readonly leases: readonly { readonly requesterId: string }[];
        }
      ).leases.map((lease) => lease.requesterId);
    expect(await holders()).toEqual(["holder"]);

    harness.clock.advance(40);
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await expect.poll(holders).toEqual(["waiter"]);
    await observer.close();
  });

  it("keeps lease progress on its requesting connection", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const waiter = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(waiter)]);
    const holderGrant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    const queuedGrant = waiter.request("lease.request", {
      requesterId: "waiter",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    await expect(waiter.nextFrame((frame) => frame.push === "progress")).resolves.toMatchObject({
      payload: { progress: { queuePosition: 1, stage: "queued" } },
      push: "progress",
    });

    expect(
      holder
        .frames()
        .filter(
          (frame) =>
            frame.push === "progress" &&
            (frame.payload as { readonly progress?: { readonly stage?: unknown } } | undefined)
              ?.progress?.stage === "queued",
        ),
    ).toEqual([]);
    await holder.request("lease.release", { leaseId: leaseIdOf(holderGrant) });
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await holder.close();
    await waiter.close();
  });

  it("multiplexes interleaved request ids on concurrent connections", async () => {
    const harness = await createHarness();
    const first = await createClient(harness.socketPath);
    const second = await createClient(harness.socketPath);
    await Promise.all([hello(first), hello(second)]);

    const [firstResponse, firstConfig, secondResponse] = await Promise.all([
      first.request("status.get", {}, "first-status"),
      first.request("config.get", {}, "first-config"),
      second.request("config.get", {}, "second-config"),
    ]);

    expect(firstResponse).toMatchObject({ id: "first-status", ok: true });
    expect(firstConfig).toMatchObject({ id: "first-config", ok: true });
    expect(secondResponse).toMatchObject({ id: "second-config", ok: true });
  });

  it("pushes driver-estimated progress while a slow lease acquisition is pending", async () => {
    const harness = await createHarness({
      estimateMs: { boot: 30, provision: 60 },
      latencyMs: { makeReady: 10, provision: 10 },
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    let requestSettled = false;
    const grant = client
      .request("lease.request", {
        requesterId: "agent-1",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      })
      .then((response) => {
        requestSettled = true;
        return response;
      });

    await expect(
      client.nextFrame((frame) => frame.push === "progress" && frame.payload !== undefined),
    ).resolves.toMatchObject({
      payload: { progress: { etaMs: 60, stage: "provisioning" } },
      push: "progress",
    });
    expect(requestSettled).toBe(false);
    harness.clock.advance(10);
    await flush();
    harness.clock.advance(10);

    await expect(grant).resolves.toMatchObject({ ok: true });
  });

  it("buffers torn frames and recovers from a garbage line", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);

    client.send('{"id":"hello","type":"hel');
    client.send(
      `lo","payload":{"clientVersion":"test","protocolVersion":${DAEMON_PROTOCOL_VERSION}}}\n`,
    );
    await expect(client.nextFrame((frame) => frame.id === "hello")).resolves.toMatchObject({
      ok: true,
    });

    client.send("not json\n");
    await expect(client.nextFrame((frame) => frame.id === null)).resolves.toMatchObject({
      error: { code: "BAD_FRAME" },
      ok: false,
    });
    await expect(client.request("status.get", {}, "after-garbage")).resolves.toMatchObject({
      id: "after-garbage",
      ok: true,
    });
  });
});
