import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock, ScriptedProcessRunner } from "../ports/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  BlockingConnection,
  ControllableStreamingRunner,
  SingleConnectionHost,
  createClient,
  createHarness,
  flush,
  hello,
  leaseIdOf,
  passthroughDriver,
  passthroughFake,
  stopTestDaemons,
  waitFor,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer", () => {
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

  it("keeps ConnectionPushes.output's promise unresolved while a frame is still going out, resolving it once the write drains", async () => {
    // why: ADR 0005 §19e on this transport: `ConnectionPushes.output`'s returned promise is
    // what `device.exec` hands the process runner as a chunk's delivery, and it is that promise
    // -- not anything this test can observe about a real stream -- staying unresolved while a
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
