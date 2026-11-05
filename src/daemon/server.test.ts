import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import {
  type DriverRejection,
  PassthroughRefusedError,
  RuntimeMissingError,
} from "../core/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeFilesystem,
  NodeIpcTransport,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { DaemonEndpointHost } from "./connection-host.js";
import {
  BlockingConnection,
  ControllableStreamingRunner,
  SingleConnectionHost,
  adminAuth,
  createClient,
  createHarness,
  flush,
  hello,
  leaseIdOf,
  passthroughDriver,
  passthroughFake,
  rejectionNaming,
  runningDaemons,
  stopTestDaemons,
  temporaryDirectories,
  testConfig,
  waitFor,
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
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await holder.close();

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: { devices: [{ state: "leased" }], leases: [{ id: leaseId }] },
    });

    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    // why: a virtual device that ended a lease is deleted, never granted again (ADR 0061).
    await expect.poll(() => harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      payload: { devices: [{ state: "deleted" }] },
    });
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

    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
    await expect.poll(() => harness.registry.snapshot.devices[0]?.state).toBe("deleted");
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
    expect(harness.registry.snapshot.leases.map((lease) => lease.requesterId)).toEqual(["holder"]);

    harness.clock.advance(40);
    await expect(queuedGrant).resolves.toMatchObject({ ok: true });
    await expect
      .poll(() => harness.registry.snapshot.leases.map((lease) => lease.requesterId))
      .toEqual(["waiter"]);
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

  it("answers status.get with the capacity, answers list.get, config.get, cleanup.run and events.replay as ok, pushes subscribed events, and renews and releases a lease", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        capacity: {
          global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: {
            limit: 1,
            maxRunning: 1,
            overLimit: false,
            reserved: 0,
            running: 0,
            used: 0,
            warm: 0,
          },
        },
      },
    });
    await expect(client.request("list.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("config.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("cleanup.run", { dryRun: true })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.replay", { sinceTs: 0 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.subscribe", {})).resolves.toMatchObject({ ok: true });
    harness.eventBus.emit(
      "disk.pressure-detected",
      { freeBytes: 1, threshold: testConfig().diskPressure.freeBytesThreshold },
      "test",
    );
    await expect(client.nextFrame((frame) => frame.push === "event")).resolves.toMatchObject({
      push: "event",
    });
    await expect(client.request("events.unsubscribe", {})).resolves.toMatchObject({ ok: true });

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = (grant.payload as { readonly lease: { readonly id: string } }).lease.id;
    await expect(client.request("lease.renew", { leaseId, ttlMs: 120_000 })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(client.request("lease.release", { leaseId })).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("routes usage.get to the dispatcher with the window the frame carries", async () => {
    const harness = await createHarness({ withHistory: true });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const answer = await client.request("usage.get", { from: 0, to: 3_600_000 });

    expect(answer).toMatchObject({
      ok: true,
      payload: { totals: { requests: 0 }, window: { from: 0, to: 3_600_000 } },
    });
  });

  it("serves the device catalog, omitting platforms with no registered driver", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("catalog.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        platforms: [{ defaultRuntime: "26.5", models: [], platform: "ios", runtimes: ["26.5"] }],
      },
    });
    await expect(client.request("catalog.get", { platform: "ios" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [{ platform: "ios" }] },
    });
    await expect(client.request("catalog.get", { platform: "android" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [] },
    });
    await expect(client.request("catalog.get", { platform: "foo" })).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
      ok: false,
    });
  });

  it("resolves a passthrough to its driver's command without running it here", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughFake({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: (args) => ({
        args: ["simctl", "--set", "/root", ...args],
        command: "xcrun",
        env: {},
      }),
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["list", "devices"], tool: "simctl" }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { args: ["simctl", "--set", "/root", "list", "devices"], command: "xcrun" },
    });
  });

  it("gives a refused verb its own code, so the CLI can render it as a usage error", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughFake({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: () => {
        throw new PassthroughRefusedError("simctl", "Refusing it; use `simlock release` instead.");
      },
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["delete", "ABCD"], tool: "simctl" }),
    ).resolves.toMatchObject({
      error: { code: "PASSTHROUGH_REFUSED", message: expect.stringContaining("simlock release") },
      ok: false,
    });
  });

  it.each([[{ args: "list", tool: "simctl" }], [{ args: ["list"] }]])(
    "rejects a malformed passthrough payload: %s",
    async (payload) => {
      const harness = await createHarness();
      const client = await createClient(harness.socketPath);
      await hello(client);

      await expect(client.request("driver.passthrough", payload)).resolves.toMatchObject({
        error: { code: "BAD_REQUEST" },
        ok: false,
      });
    },
  );

  it("distinguishes an unknown passthrough tool from a malformed payload", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["devices"], tool: "adb" }),
    ).resolves.toMatchObject({
      error: { code: "UNKNOWN_PASSTHROUGH_TOOL" },
      ok: false,
    });
  });

  it("pushes device.exec output frames keyed by the request id, then replies with the exit code", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughFake({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: (args: readonly string[]) => ({
        args: ["--set", "/root", ...args],
        command: "simctl",
        env: {},
      }),
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    const harness = await createHarness({
      clock,
      driver,
      processRunner: new ScriptedProcessRunner([
        {
          chunks: [
            { chunk: "booted", stream: "stdout" },
            { chunk: "a warning", stream: "stderr" },
          ],
          match: { args: ["--set", "/root", "list", "devices"], command: "simctl" },
          result: { code: 6, stderr: "", stdout: "" },
        },
      ]),
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });

    const response = await client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId: leaseIdOf(grant), tool: "simctl" },
      "exec-frame",
    );

    expect(response).toMatchObject({ ok: true, payload: { exitCode: 6 } });
    expect(client.frames().filter((frame) => frame.push === "output")).toEqual([
      { payload: { chunk: "booted", requestId: "exec-frame", stream: "stdout" }, push: "output" },
      {
        payload: { chunk: "a warning", requestId: "exec-frame", stream: "stderr" },
        push: "output",
      },
    ]);

    // why: ADR 0005 §19a: `started` reaches the socket exactly once, keyed by the same frame id.
    // Round 5 review: this send site could be deleted with the entire suite green, because
    // nothing asserted the frame ever reached a socket at all.
    //
    // Deliberately not asserted here: that it precedes the first `output`. It does in
    // production -- the dispatcher calls `onStarted` synchronously after the spawn returns, and
    // a real child's chunks arrive later from `data` events -- but `ScriptedProcessRunner`
    // delivers its scripted chunks synchronously *inside* `runCommand`, so this harness sees
    // them first and cannot distinguish the two orderings. Claiming the ordering here would be a
    // title outrunning its body; `client.test.ts`'s wire test pins it where it is observable.
    expect(client.frames().filter((frame) => frame.push === "started")).toEqual([
      { payload: { requestId: "exec-frame" }, push: "started" },
    ]);
  });

  it("pushes component.install progress frames keyed by the request id, then replies with the outcome", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      installProgress: [50],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request(
      "component.install",
      { platform: "ios", version: "27.0" },
      "install-frame",
    );

    expect(response).toMatchObject({
      ok: true,
      payload: { component: "27.0", outcome: "installed", platform: "ios", version: "27.0" },
    });
    expect(client.frames().filter((frame) => frame.push === "component-progress")).toEqual([
      {
        payload: { progress: { stage: "downloading" }, requestId: "install-frame" },
        push: "component-progress",
      },
      {
        payload: { progress: { fraction: 0.5, stage: "downloading" }, requestId: "install-frame" },
        push: "component-progress",
      },
      {
        payload: { progress: { fraction: 1, stage: "downloading" }, requestId: "install-frame" },
        push: "component-progress",
      },
    ]);
  });

  it("answers device.add and device.remove over the socket from the daemon's enrollment", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      clock,
      physicalDevices: [
        { apps: ["a"], ids: ["UDID-1"], model: "iPhone 15 Pro", osVersion: "18.4" },
      ],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver, includeEnrollment: true });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const added = await client.request("device.add", { id: "UDID-1", platform: "ios" }, "add-1");
    const removed = await client.request("device.remove", { id: "UDID-1" }, "remove-1");

    expect(added).toMatchObject({
      ok: true,
      payload: { appCount: 1, driverDeviceId: "UDID-1", platform: "ios", reenrolled: false },
    });
    expect(removed).toMatchObject({
      ok: true,
      payload: { driverDeviceId: "UDID-1", id: "dev_1" },
    });
  });

  it("routes two commands on one connection by frame id, and pushes to no other connection", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughDriver(clock);
    const harness = await createHarness({
      clock,
      driver,
      processRunner: new ScriptedProcessRunner([
        {
          chunks: [{ chunk: "first-command", stream: "stdout" }],
          match: { args: ["--set", "/root", "list", "devices"], command: "simctl" },
        },
        {
          chunks: [{ chunk: "second-command", stream: "stdout" }],
          match: { args: ["--set", "/root", "list", "runtimes"], command: "simctl" },
        },
      ]),
    });
    const client = await createClient(harness.socketPath);
    const observer = await createClient(harness.socketPath);
    await hello(client);
    await hello(observer);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    const first = client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      "exec-a",
    );
    const second = client.request(
      "device.exec",
      { args: ["list", "runtimes"], leaseId, tool: "simctl" },
      "exec-b",
    );
    await Promise.all([first, second]);

    expect(
      client
        .frames()
        .filter((frame) => frame.push === "output")
        .map((frame) => frame.payload),
    ).toEqual([
      { chunk: "first-command", requestId: "exec-a", stream: "stdout" },
      { chunk: "second-command", requestId: "exec-b", stream: "stdout" },
    ]);
    expect(observer.frames().filter((frame) => frame.push === "output")).toEqual([]);
  });

  it("stops pushing when the connection dies, and lets the command finish anyway", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughDriver(clock);
    const runner = new ControllableStreamingRunner();
    const harness = await createHarness({ clock, driver, processRunner: runner });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const grant = await client.request("lease.request", {
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    });

    void client.request(
      "device.exec",
      { args: ["list", "devices"], leaseId: leaseIdOf(grant), tool: "simctl" },
      "exec-dropped",
    );
    await waitFor(() => runner.handle !== undefined);
    const firstPush = client.nextFrame((frame) => frame.push === "output");
    runner.handle?.emit("stdout", "before-the-drop");
    expect(await firstPush).toMatchObject({
      payload: { chunk: "before-the-drop", requestId: "exec-dropped" },
      push: "output",
    });

    await client.close();
    await flush();
    runner.handle?.emit("stdout", "after-the-drop");
    runner.handle?.finish(0);
    await flush();
    expect(runner.handle?.settled).toBe(true);

    const survivor = await createClient(harness.socketPath);
    await hello(survivor);
    await expect(survivor.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await survivor.close();
  });

  it("keeps #pushOutput's promise unresolved while a frame is still going out, resolving it once the write drains", async () => {
    // why: ADR 0005 §19e on this transport: `#pushOutput`'s returned promise is what
    // `device.exec` hands the process runner as a chunk's delivery, and it is that promise --
    // not anything this test can observe about a real stream -- staying unresolved while a
    // client's socket has not drained that would eventually stop the command at its pipe.
    // `ControllableStreamingRunner` is a fake with no stream of its own to stop reading (its
    // `emit` calls `onChunk` directly), so this proves only the promise half of the contract;
    // `ports/process-runner.test.ts`'s `NodeProcessRunner` suite is where a real pipe is
    // actually paused. Driven through a connection whose `write` this test settles by hand --
    // a real socket would need megabytes to fill a kernel buffer, which is the same property
    // tested by luck.
    const clock = new FakeClock(1_000);
    const driver = passthroughDriver(clock);
    const runner = new ControllableStreamingRunner();
    const connection = new BlockingConnection();
    const harness = await createHarness({
      clock,
      driver,
      host: new SingleConnectionHost(connection),
      processRunner: runner,
    });
    expect(harness.daemon.health).toBeDefined();

    await connection.request(
      { clientVersion: "test", protocolVersion: DAEMON_PROTOCOL_VERSION },
      "hello",
    );
    const grant = await connection.request(
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      "lease.request",
    );
    connection.releaseAll();

    void connection.request(
      { args: ["list", "devices"], leaseId: leaseIdOf(grant), tool: "simctl" },
      "device.exec",
      "exec-slow",
    );
    await waitFor(() => runner.handle !== undefined);

    connection.block();
    let firstDelivered = false;
    void Promise.resolve(runner.handle?.emit("stdout", "first")).then(() => {
      firstDelivered = true;
    });
    await flush();
    expect(firstDelivered).toBe(false);

    connection.releaseAll();
    await flush();
    expect(firstDelivered).toBe(true);

    runner.handle?.finish(0);
    await flush();
  });

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
    expect(first.daemon.socketPath).toBe(socketPath);
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

  it("pushes a lease-lost notification to the holding connection when its lease's TTL backstop expires", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.clock.advance(60_000);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);

    await holder.close();
    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({ ok: true });
    await observer.close();
  });

  it("pushes a lease-lost notification to the actual holding connection when another connection force-releases its lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    const releaser = await createClient(harness.socketPath);
    await Promise.all([hello(holder), hello(releaser)]);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);

    await expect(releaser.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "explicit" },
      push: "lease-lost",
    });

    await expect(holder.request("lease.release", { leaseId })).resolves.toMatchObject({
      error: { code: "UNKNOWN_LEASE" },
      ok: false,
    });
    await holder.close();
    await releaser.close();
  });

  it("drops a lease-lost push to a connection whose peer has hung up instead of leaving its failed write unhandled", async () => {
    const connection = new BlockingConnection();
    const harness = await createHarness({ host: new SingleConnectionHost(connection) });
    await connection.request(
      { clientVersion: "test", protocolVersion: DAEMON_PROTOCOL_VERSION },
      "hello",
    );
    const grant = await connection.request(
      { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
      "lease.request",
    );
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      connection.hangUp();
      await harness.engine.release(leaseIdOf(grant), "explicit");
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.frames.filter((frame) => frame.push === "lease-lost")).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  type EventBus = Awaited<ReturnType<typeof createHarness>>["eventBus"];

  it.each([
    [
      "lease-lost",
      (eventBus: EventBus) => {
        eventBus.emit(
          "lease.expired",
          { deviceId: "device-x", leaseId: "lease-x", ownerId: "test-process" },
          "test",
        );
        eventBus.emit(
          "lease.released",
          { deviceId: "device-y", leaseId: "lease-y", ownerId: "test-process", reason: "killed" },
          "test",
        );
      },
    ],
    [
      "device-unhealthy/device-recovered",
      (eventBus: EventBus) => {
        eventBus.emit(
          "device.crash-detected",
          { deviceId: "device-x", leaseId: "lease-x", observed: "stopped", platform: "ios" },
          "test",
        );
        eventBus.emit(
          "device.recovered",
          {
            attempts: 1,
            deviceId: "device-x",
            duration: 1_000,
            leaseId: "lease-x",
            platform: "ios",
          },
          "test",
        );
      },
    ],
  ])(
    "ignores %s facts for leases with no currently connected holder without breaking the daemon",
    async (_name, emitFacts) => {
      const harness = await createHarness();
      emitFacts(harness.eventBus);

      const client = await createClient(harness.socketPath);
      await hello(client);
      await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });
      await client.close();
    },
  );

  it("pushes a device-unhealthy notification on device.crash-detected without releasing the lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.eventBus.emit(
      "device.crash-detected",
      { deviceId: deviceId as string, leaseId, observed: "stopped", platform: "ios" },
      "test",
    );
    await expect(
      holder.nextFrame((frame) => frame.push === "device-unhealthy"),
    ).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "crashed" },
      push: "device-unhealthy",
    });

    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    await holder.request("lease.release", { leaseId });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await holder.close();
  });

  it("pushes a device-recovered notification on device.recovered without releasing the lease", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.eventBus.emit(
      "device.recovered",
      {
        attempts: 2,
        deviceId: deviceId as string,
        duration: 30_000,
        leaseId,
        platform: "ios",
      },
      "test",
    );
    await expect(
      holder.nextFrame((frame) => frame.push === "device-recovered"),
    ).resolves.toMatchObject({
      payload: { attempts: 2, deviceId, leaseId },
      push: "device-recovered",
    });

    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);
    await holder.request("lease.release", { leaseId });
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await holder.close();
  });

  it("pushes a lease-lost notification carrying reason device-lost when a leased device could not be recovered", async () => {
    const harness = await createHarness();
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "holder",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = harness.registry.snapshot.leases.find(
      (lease) => lease.id === leaseId,
    )?.deviceId;

    harness.eventBus.emit(
      "lease.released",
      { deviceId: deviceId as string, leaseId, ownerId: "test-process", reason: "device-lost" },
      "test",
    );
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { deviceId, leaseId, reason: "device-lost" },
      push: "lease-lost",
    });
  });
});

describe("DaemonServer driver rejections", () => {
  it("publishes one event per platform that refused to start, after the daemon is up", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
          platform: "ios",
          reason: "wrong-instance",
          summary: "Refusing the ios device root /Devices: it belongs to another instance",
        },
        {
          event: "driver.adb-server-rejected",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });

    const events = harness.eventBus.replay();
    const rejected = events.filter(
      (event) =>
        event.event === "driver.root-rejected" || event.event === "driver.adb-server-rejected",
    );
    expect(rejected).toEqual([
      expect.objectContaining({
        event: "driver.root-rejected",
        module: "daemon",
        payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
      }),
      expect.objectContaining({
        event: "driver.adb-server-rejected",
        module: "daemon",
        payload: { port: 5038, reason: "occupied" },
      }),
    ]);
    const started = events.find((event) => event.event === "daemon.started");
    for (const event of rejected) expect(started?.seq).toBeLessThan(event.seq);
  });

  it("names the refusal when a lease asks for a platform whose driver did not start", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.adb-server-rejected",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toContain("port 5038 is held by an adb server we do not own");
  });

  it("leaves an ordinary missing platform unexplained, having nothing to explain", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "symlink", root: "/Devices" },
          platform: "ios",
          reason: "symlink",
          summary: "Refusing the ios device root /Devices: it is a symlink",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toBe("No driver registered for platform: android");
  });

  it.each([
    {
      name: "adb",
      rejection: {
        event: "driver.adb-server-rejected",
        payload: { port: 5038, reason: "occupied" },
        platform: "android",
        reason: "occupied",
        summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
      },
      tools: ["adb"],
      request: { args: ["devices"], tool: "adb" },
      text: "port 5038 is held by an adb server we do not own",
    },
    {
      name: "devicectl",
      rejection: {
        event: "driver.root-rejected",
        payload: { platform: "ios", reason: "symlink", root: "/Devices" },
        platform: "ios",
        reason: "symlink",
        summary: "Refusing the ios device root /Devices: it is a symlink",
      },
      tools: ["simctl", "devicectl"],
      request: { args: ["list", "devices"], tool: "devicectl" },
      text: "Refusing the ios device root /Devices: it is a symlink",
    },
  ] as const)(
    "names the refusal when a $name passthrough asks for the tool whose driver did not start",
    async ({ rejection, request, text, tools }) => {
      const harness = await createHarness({
        driverRejections: [rejectionNaming(rejection, tools)],
      });
      const client = await createClient(harness.socketPath);
      await hello(client);

      const response = await client.request("driver.passthrough", {
        args: [...request.args],
        tool: request.tool,
      });

      expect(response.error?.code).toBe("UNKNOWN_PASSTHROUGH_TOOL");
      expect(response.error?.message).toContain(text);
    },
  );

  it("leaves an unknown passthrough tool unexplained when no driver claimed it", async () => {
    const harness = await createHarness({
      driverRejections: [
        rejectionNaming(
          {
            event: "driver.root-rejected",
            payload: { platform: "ios", reason: "symlink", root: "/Devices" },
            platform: "ios",
            reason: "symlink",
            summary: "Refusing the ios device root /Devices: it is a symlink",
          },
          ["simctl", "devicectl"],
        ),
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("driver.passthrough", {
      args: ["devices"],
      tool: "adb",
    });

    expect(response.error?.message).toBe("No driver provides a adb passthrough");
  });

  it("refuses at compile time to pair an event with another event's payload", () => {
    const rejection: DriverRejection = {
      event: "driver.adb-server-rejected",
      // @ts-expect-error -- `port` is a number on the wire (docs/internal/EVENTS.md).
      payload: { port: "5038", reason: "occupied" },
      platform: "android",
      reason: "occupied",
      summary: "Refusing the Android driver: port 5038 is occupied",
    };

    expect(rejection.event).toBe("driver.adb-server-rejected");
  });

  it("publishes nothing when every driver started", async () => {
    const harness = await createHarness();

    expect(harness.eventBus.replay().filter((event) => event.event.startsWith("driver."))).toEqual(
      [],
    );
  });
});

describe("DaemonServer lease liveness (ADR 0004)", () => {
  it("keeps a lease alive only while something renews it, and expires it when nothing does", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { ttlDeadline: number } }).lease.ttlDeadline).toBe(1_040);

    let expectedDeadline = 1_040;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      harness.clock.advance(10);
      expectedDeadline = harness.clock.now() + 40;
      await expect(holder.request("lease.renew", { leaseId })).resolves.toMatchObject({
        ok: true,
        payload: { id: leaseId, ttlDeadline: expectedDeadline, ttlMs: 40 },
      });
    }
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: leaseId }]);

    harness.clock.advance(40);
    await expect.poll(() => harness.registry.snapshot.leases).toEqual([]);
    await expect(holder.nextFrame((frame) => frame.push === "lease-lost")).resolves.toMatchObject({
      payload: { leaseId, reason: "expired" },
      push: "lease-lost",
    });
    await holder.close();
  });

  it("no longer answers lease.heartbeat at all", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("lease.heartbeat", { nonce: 1 })).resolves.toMatchObject({
      error: { code: "UNKNOWN_REQUEST" },
      ok: false,
    });
    await client.close();
  });

  it("answers worker.list with this daemon's instance id and the version its hello reports", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    const greeting = await client.request("hello", {
      clientVersion: "test",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    expect(greeting).toMatchObject({ ok: true, payload: { version: "test" } });

    await expect(client.request("worker.list", {})).resolves.toMatchObject({
      ok: true,
      payload: { workers: [{ id: "instance-test", version: "test" }] },
    });
    await client.close();
  });

  it("re-reads worker.list's kept catalog once this daemon's bus reports a component installed", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const catalogReads = vi.spyOn(harness.driver, "listCatalog");

    await client.request("worker.list", {});
    await client.request("worker.list", {});
    expect(catalogReads).toHaveBeenCalledTimes(1);

    harness.eventBus.emit(
      "component.installed",
      {
        alreadyPresent: false,
        componentId: "27.0",
        durationMs: 1,
        platform: "ios",
        version: "27.0",
      },
      "test",
    );
    await client.request("worker.list", {});

    expect(catalogReads).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("disposes the worker's dispatcher, ending its bus subscriptions, when the daemon stops", async () => {
    const live = new Map<string, number>();
    const subscribe = EventBus.prototype.subscribe;
    const spy = vi.spyOn(EventBus.prototype, "subscribe").mockImplementation(function (
      this: EventBus,
      event,
      handler,
    ) {
      const unsubscribe = subscribe.call(this, event, handler);
      live.set(event, (live.get(event) ?? 0) + 1);
      let ended = false;
      return () => {
        if (!ended) live.set(event, (live.get(event) ?? 0) - 1);
        ended = true;
        unsubscribe();
      };
    });
    try {
      const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
      expect(live.get("component.installed")).toBeGreaterThan(0);

      await harness.daemon.stop("test");

      expect(live.get("component.installed")).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers worker.install-component and worker.update with UNSUPPORTED_IN_WORKER_MODE: a worker has no workers to install on or update", async () => {
    const harness = await createHarness({ resolveRole: { resolve: () => "admin" } });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("worker.install-component", {
        platform: "android",
        version: "35",
        workers: "all",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "UNSUPPORTED_IN_WORKER_MODE",
        details: { operation: "worker.install-component" },
      },
      ok: false,
    });
    await expect(client.request("worker.update", { workerId: "wrk_1" })).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_IN_WORKER_MODE", details: { operation: "worker.update" } },
      ok: false,
    });
    await client.close();
  });

  it("keeps a lease across a daemon restart and restores its timer from the persisted deadline", async () => {
    const leaseOverrides = { defaultTtlMs: 40 };
    const first = await createHarness({ lease: leaseOverrides });
    const holder = await createClient(first.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    const deviceId = (grant.payload as { device: { id: string } }).device.id;

    first.clock.advance(10);
    await expect(holder.request("lease.renew", { leaseId })).resolves.toMatchObject({
      ok: true,
      payload: { ttlDeadline: 1_050 },
    });

    const second = await createHarness({
      clock: new FakeClock(1_010),
      driver: first.driver,
      lease: leaseOverrides,
      state: first.state,
    });
    await second.engine.convergeRunningCapacity();

    expect(second.registry.snapshot.leases).toMatchObject([{ id: leaseId, ttlDeadline: 1_050 }]);
    expect(second.registry.snapshot.devices).toMatchObject([{ id: deviceId, state: "leased" }]);

    second.clock.advance(30);
    await expect.poll(() => second.registry.snapshot.leases).toHaveLength(1);
    second.clock.advance(10);
    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect.poll(() => second.registry.snapshot.devices[0]?.state).toBe("deleted");
    await holder.close();
  });

  it("expires a lease whose deadline passed while no daemon was running, as soon as one is", async () => {
    const leaseOverrides = { defaultTtlMs: 40 };
    const first = await createHarness({ lease: leaseOverrides });
    const holder = await createClient(first.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const deviceId = (grant.payload as { device: { id: string } }).device.id;
    await holder.close();

    const second = await createHarness({
      clock: new FakeClock(2_000),
      driver: first.driver,
      lease: leaseOverrides,
      state: first.state,
    });
    await second.engine.convergeRunningCapacity();

    await expect.poll(() => second.registry.snapshot.leases).toEqual([]);
    await expect
      .poll(() => second.registry.snapshot.devices)
      .toMatchObject([{ id: deviceId, state: "deleted" }]);
  });

  it("surfaces the stored lastRenewedAt and ttlMs in status and list --leases", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 40 } });
    const holder = await createClient(harness.socketPath);
    await hello(holder);
    const grant = await holder.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = leaseIdOf(grant);
    expect((grant.payload as { lease: { lastRenewedAt: number } }).lease.lastRenewedAt).toBe(1_000);

    harness.clock.advance(10);
    await holder.request("lease.renew", { leaseId });

    await expect(holder.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { leases: [{ id: leaseId, lastRenewedAt: 1_010, ttlMs: 40 }] },
    });
    await expect(holder.request("list.get", { kind: "leases" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: leaseId, lastRenewedAt: 1_010, ttlMs: 40 }],
    });
    await holder.close();
  });
});

describe("DaemonServer decorations", () => {
  it("surfaces a derived transitionAgeMs for a mid-transition device in status and list --devices", async () => {
    const harness = await createHarness();
    const device = await harness.registry.registerDevice({
      driverData: { fakeDeviceId: "driver_provisioning" },
      driverDeviceId: "driver_provisioning",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    harness.clock.advance(5_000);

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { devices: [{ id: device.id, transitionAgeMs: 5_000 }] },
    });
    await expect(observer.request("list.get", { kind: "devices" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: device.id, transitionAgeMs: 5_000 }],
    });
    await observer.close();
  });

  describe("operational logging", () => {
    it("drains the backgrounded reclaims before disposing, on a graceful stop", async () => {
      const order: string[] = [];
      let finishSettle!: () => void;
      const settling = new Promise<void>((resolve) => {
        finishSettle = resolve;
      });
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle-start");
          await settling;
          order.push("settle-end");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      const grant = await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await holder.request("lease.release", { leaseId: leaseIdOf(grant) });
      expect(harness.registry.snapshot.leases).toHaveLength(0);

      const stopping = harness.daemon.stop("test-drain");
      await expect.poll(() => order).toEqual(["settle-start"]);

      finishSettle();
      await stopping;
      // why: Disposal last: a reclaim that settles into a purge failure arms a quarantine
      // retry timer, and cancelling before the drain would strand it armed.
      expect(order).toEqual(["settle-start", "settle-end", "dispose"]);
    });

    it("starts the physical-device watcher with the daemon and disposes it on stop before draining settle", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        physicalDeviceWatcher: {
          dispose: () => {
            order.push("watcher-dispose");
          },
          start: () => {
            order.push("watcher-start");
          },
        },
        settle: async () => {
          order.push("settle");
        },
      });

      await harness.daemon.stop("test-watcher");

      expect(order).toEqual(["watcher-start", "watcher-dispose", "settle"]);
    });

    it("waits for an asynchronous disposal before reporting the daemon stopped", async () => {
      let disposed = false;
      let finishDispose!: () => void;
      const disposing = new Promise<void>((resolve) => {
        finishDispose = resolve;
      });
      const harness = await createHarness({
        dispose: async () => {
          await disposing;
          disposed = true;
        },
      });

      const stopping = harness.daemon.stop("test-async-dispose");
      await expect.poll(() => disposed).toBe(false);

      // why: A driver's release is asynchronous -- Android's reaps the adb server it started --
      // and a stop that returned before it finished would report a shutdown that had not
      // happened, leaving the next daemon to find the port still held.
      finishDispose();
      await stopping;
      expect(disposed).toBe(true);
    });

    it("stops an auxiliary frontend before releasing held leases and draining settle", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle");
        },
        stopAuxiliary: async () => {
          order.push("stopAuxiliary");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await harness.daemon.stop("test-stop-auxiliary");

      expect(order).toEqual(["stopAuxiliary", "settle", "dispose"]);
      expect(harness.registry.snapshot.leases).toHaveLength(1);
    });

    it("calls beginStop once, before stopAuxiliary, when a stop is asked for", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        beginStop: () => {
          order.push("beginStop");
        },
        stopAuxiliary: async () => {
          order.push("stopAuxiliary");
        },
      });

      await harness.daemon.stop("test-begin-stop");
      await harness.daemon.stop("again");

      expect(order).toEqual(["beginStop", "stopAuxiliary"]);
    });
  });
});

describe("DaemonServer download policy", () => {
  it("grants download permission under the always policy without a per-request flag", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, downloads: { policy: "always" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["26.5"]]);
    await client.close();
  });

  it("still answers a lease request whose download names a component past the progress push's bound, sending no downloading push for it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    // why: the driver, not the request, names the component: a request's exact osVersion is held
    // within the push's bound. Every resolve before the install answers as a missing runtime does.
    for (const callNumber of [1, 2]) {
      driver.failOn(
        "resolveSpec",
        callNumber,
        new RuntimeMissingError("ios", "26.5", { component: "9".repeat(65) }),
      );
    }
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok, JSON.stringify(grant.error)).toBe(true);
    const stages = client
      .frames()
      .filter((frame) => frame.push === "progress")
      .map((frame) => (frame.payload as { progress: { stage: string } }).progress.stage);
    expect(stages).toContain("provisioning");
    expect(stages).not.toContain("downloading");
    await client.close();
  });

  it.each([
    ["asks for it", { allowDownload: true }],
    ["never asked for a download", {}],
  ])(
    "attaches the download-policy suffix and withholds download permission under the never policy even when the request %s",
    async (_name, extra) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
      const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
      const client = await createClient(harness.socketPath);
      await hello(client);

      // why: when the request never asked, the driver's own message still suggests `--allow-download`,
      // which under the never policy can never help, so the suffix must still attach as the
      // correction.
      const response = await client.request("lease.request", {
        ...extra,
        requesterId: "agent-1",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
      expect(response.error?.message).toContain("downloads.policy");
      expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");
      await client.close();
    },
  );

  it("defers to the request's own flag under the default on-request policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");

    const flagged = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(flagged.ok).toBe(true);
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["26.5"]]);
    await client.close();
  });

  it("never attaches the download-policy suffix to an undownloadable RuntimeMissingError, even under the never policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.failOn(
      "resolveSpec",
      1,
      new RuntimeMissingError("ios", "12.0", { downloadable: false }),
    );
    const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "12.0",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });
});

describe("DaemonServer lease request mode", () => {
  it("grants a slim request on a runtime the driver can slim with mode slim", async () => {
    const harness = await createHarness({ slimmableOsVersions: ["26.5"] });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      mode: "slim",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect((grant.payload as { device: { mode: string } }).device.mode).toBe("slim");
    await client.close();
  });

  it.each([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "fast" }],
    ["the lease mode ADR 0004 retired", { mode: "held" }],
  ])("answers a lease.request carrying %s with BAD_REQUEST", async (_label, extra) => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      ...extra,
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "BAD_REQUEST" });
    await client.close();
  });
});
