import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { DispatchError } from "../daemon/dispatch.js";
import { FakeClock, NodeSqliteOpener } from "../ports/index.js";
import { FakeAgentDevice } from "./testing.js";
import {
  heartbeat,
  phoneSerial,
  setUpWithPhone,
  advance,
  release,
  grantedDevice,
  track,
  listed,
  tapDispatch,
  idOf,
} from "./test-edge.js";
import {
  secrets,
  notAvailable,
  queueTimeoutMessage,
  maxTtlMs,
  adminSession,
  type Rig,
  androidDriver,
  sleep,
  setUp,
  send,
  rpcBody,
  envelopeOf,
  hex,
  allocateParams,
  allocate,
  granted,
  command,
  leases,
  requestedSpecs,
  receivedAllocate,
  allocatesReceived,
  refusal,
  runCommand,
} from "./test-support.js";
import { waiting, phoneModels, expectEndedBySimlock } from "./test-edge-front.js";

function allocatePhone(rig: Rig, n: number, extra: Record<string, unknown> = {}) {
  return allocate(rig, n, { platform: "android", ...extra, physical: true });
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("allocate with `physical: true` leases an enrolled phone through the phone daemon, and the reply names the device with `physical: true` (`false` for a virtual one)", async () => {
    const cases = [
      {
        address: { serial: "R58Y61A60HN" },
        asked: { platform: "android" },
        extra: { platform: "android" },
        id: "R58Y61A60HN",
        phone: { class: "phone", model: "Pixel 8", osVersion: "15" },
        platform: "android",
      },
      {
        address: { udid: "00008030-000270803C28802E" },
        asked: { model: "iPhone 15 Pro", platform: "ios" },
        extra: { device: "iPhone 15 Pro" },
        id: "00008030-000270803C28802E",
        phone: { class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" },
        platform: "ios",
      },
      {
        address: { udid: "00008030-000270803C28802E" },
        asked: { osVersion: ">=18", platform: "ios" },
        extra: { osVersion: ">=18" },
        id: "00008030-000270803C28802E",
        phone: { class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" },
        platform: "ios",
      },
    ] as const;
    for (const { address, asked, extra, id, phone, platform } of cases) {
      const rig = await setUp({
        drivers: (clock) => [
          new FakeDriver({
            availableOsVersions: ["35"],
            clock,
            knownModels: [phone.model],
            physicalDevices: [{ ids: [id], ...phone }],
            platform,
          }),
        ],
      });
      await rig.daemon.dispatch("device.add", { id, platform }, adminSession);
      rig.driver.setPhysicalPresence(id, true);
      const answer = await envelopeOf(
        await allocate(rig, 1, { platform, ...extra, physical: true }),
      );
      expect(answer.result).toMatchObject({
        data: {
          lease: {
            device: { ...address, model: phone.model, osVersion: phone.osVersion, physical: true },
          },
        },
        ok: true,
      });
      expect(answer.result).not.toHaveProperty("data.lease.device.deviceMode");
      expect(await requestedSpecs(rig, hex(1))).toMatchObject([{ ...asked, physical: true }]);
      expect(rig.phone.rpcRequests("agent_device.lease.allocate")).toMatchObject([
        { params: { leaseId: hex(1), ...address } },
      ]);
      // why: agent-device's daemon refuses any spec key it receives, so `physical` stays with simlock.
      expect(rig.phone.rpcRequests("agent_device.lease.allocate")[0]?.params).not.toHaveProperty(
        "physical",
      );
      expect(allocatesReceived(rig)).toEqual([]);
      if (platform === "ios") {
        // why: a physical iPhone has no `device.rotate`, so its `orientation auto` must reach agent-device, not be refused as an unknown name.
        await command(rig, "orientation", 1, {}, { positionals: ["auto"] });
        expect(rig.phone.rpcRequests("agent_device.command")).toMatchObject([
          { params: { command: "orientation", positionals: ["auto"] } },
        ]);
      }
    }
  });

  it("allocate with `physical: true` that simlock refuses (an `imageTag`, a model no enrolled phone has, an OS range none fits) answers `refused by simlock: <message>` and leaves no lease", async () => {
    const rig = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: ["35"],
          clock,
          knownModels: ["Pixel 8"],
          physicalDevices: [
            { class: "phone", ids: ["R58Y61A60HN"], model: "Pixel 8", osVersion: "15" },
          ],
          platform: "android",
        }),
      ],
    });
    await rig.daemon.dispatch(
      "device.add",
      { id: "R58Y61A60HN", platform: "android" },
      adminSession,
    );
    rig.driver.setPhysicalPresence("R58Y61A60HN", true);
    const cases = [
      [{ imageTag: "default" }, "imageTag: `imageTag` has no meaning for a physical device"],
      [{ device: "Pixel 9" }, "no enrolled physical device can match android model Pixel 9"],
      [
        { osVersion: ">=16" },
        "no enrolled physical device can match android class phone os in the requested range",
      ],
    ] as const;

    for (const [index, [extra, message]] of cases.entries()) {
      const answer = await envelopeOf(
        await allocate(rig, index + 1, { platform: "android", ...extra, physical: true }),
      );

      expect(answer.error).toMatchObject(refusal(`refused by simlock: ${message}`));
    }
    expect(await leases(rig)).toEqual([]);
    expect(rig.phone.rpcRequests("agent_device.lease.allocate")).toEqual([]);
  });

  it("allocate with `physical: true` while the phone daemon is not running answers `agent-device is not available on this simlock: phone daemon: <message>` and releases the lease; a virtual allocate is granted, a command on a live phone lease answers the same, and with the simulator daemon down a physical allocate answers the simulator daemon's reason", async () => {
    const down = [
      ["starting", "phone daemon: starting", true],
      ["adb not found", "phone daemon: adb not found", false],
    ] as const;
    for (const [reason, message, retriable] of down) {
      const rig = await setUpWithPhone({ maxRunning: 4 });
      rig.phone.setUnavailable(reason, retriable);

      const answer = await envelopeOf(await allocatePhone(rig, 1));

      expect(answer.error).toMatchObject(refusal(`${notAvailable}${message}`, "COMMAND_FAILED"));
      expect(answer.error?.data).toMatchObject({
        details: { reason: "SIMLOCK_UNAVAILABLE" },
        retriable,
      });
      await expect.poll(() => listed(rig)).toEqual([]);
      await granted(rig, 2, { platform: "android" });
      expect(await listed(rig)).toEqual([hex(2)]);
    }

    const live = await setUpWithPhone();
    await granted(live, 1, { platform: "android", physical: true });
    live.phone.setUnavailable("starting");
    const liveCommand = await envelopeOf(await command(live, "snapshot", 1));
    expect(liveCommand.error).toMatchObject(
      refusal(`${notAvailable}phone daemon: starting`, "COMMAND_FAILED"),
    );
    const beforeRules = await envelopeOf(
      await runCommand(live, "snapshot", 1, { flags: { serial: "emulator-9999" } }),
    );
    expect(beforeRules.error).toMatchObject(
      refusal(`${notAvailable}phone daemon: starting`, "COMMAND_FAILED"),
    );

    const simulatorsDown = await setUpWithPhone();
    simulatorsDown.fake.setUnavailable("found 0.20.3");
    const simulatorsDownAnswer = await envelopeOf(await allocatePhone(simulatorsDown, 1));
    expect(simulatorsDownAnswer.error).toMatchObject(
      refusal(`${notAvailable}found 0.20.3`, "COMMAND_FAILED"),
    );
    expect(await listed(simulatorsDown)).toEqual([]);
  });

  it("a command, a heartbeat, a release and a `devices` naming a phone lease reach the phone daemon, those naming a simulator lease reach the simulator daemon, and `devices` with one lease of each answers both devices, each from its daemon", async () => {
    const rig = await setUpWithPhone();
    await granted(rig, 1, { physical: true, platform: "android" });
    await granted(rig, 2, { platform: "android" });
    rig.phone.listDevices([{ id: phoneSerial }, { id: "emulator-5600" }]);
    rig.fake.listDevices([{ id: idOf(rig, 2) }, { id: "emulator-5601" }]);
    const reached = (fake: FakeAgentDevice, method: string) => fake.rpcRequests(method).length;
    const calls = [
      ["agent_device.command", (n: number) => command(rig, "snapshot", n)],
      ["agent_device.lease.heartbeat", (n: number) => heartbeat(rig, n)],
      ["agent_device.lease.release", (n: number) => release(rig, n)],
    ] as const;

    for (const [method, send] of calls) {
      const [phoneBefore, simulatorBefore] = [
        reached(rig.phone, method),
        reached(rig.fake, method),
      ];
      await send(1);
      expect([reached(rig.phone, method), reached(rig.fake, method)]).toEqual([
        phoneBefore + 1,
        simulatorBefore,
      ]);
      await send(2);
      expect([reached(rig.phone, method), reached(rig.fake, method)]).toEqual([
        phoneBefore + 1,
        simulatorBefore + 1,
      ]);
    }

    await granted(rig, 3, { physical: true, platform: "android" });
    await granted(rig, 4, { platform: "android" });
    rig.fake.listDevices([{ id: idOf(rig, 4) }, { id: "emulator-5601" }]);
    const answer = await envelopeOf(await runCommand(rig, "devices", undefined));
    const data = answer.result?.["data"] as { devices: { id: string }[] } | undefined;
    expect(data?.devices.map((device) => device.id).sort()).toEqual(
      [phoneSerial, idOf(rig, 4)].sort(),
    );
  });

  it("a client that sends the instance headers of the health it read, as the agent-device CLI does, is granted a phone and its later calls on that phone lease reach the phone daemon", async () => {
    const rig = await setUpWithPhone();
    const health = (await (await send(rig, "/health")).json()) as { instanceId: string };
    const pinned = {
      headers: {
        "x-agent-device-instance": health.instanceId,
        "x-agent-device-upstream-instance": "upstream-from-health",
      },
    };

    const allocated = await envelopeOf(
      await allocate(rig, 1, { physical: true, platform: "android" }, pinned),
    );
    const later = await envelopeOf(await command(rig, "snapshot", 1, pinned));
    const beat = await envelopeOf(await heartbeat(rig, 1, {}, pinned));

    expect(allocated.result).toMatchObject({ ok: true });
    expect(later.error).toBeUndefined();
    expect(beat.error).toBeUndefined();
    expect(rig.phone.rpcRequests("agent_device.command")).toHaveLength(1);
    expect(rig.phone.rpcRequests("agent_device.lease.heartbeat")).toHaveLength(1);
  });

  it("when simlock ends a phone lease (presence lost, an operator's release of all) the release reaches the phone daemon, not the simulator daemon, and the agent's next heartbeat answers ended by simlock", async () => {
    const endings = [
      async (rig: Rig) => {
        rig.driver.setPhysicalPresence(phoneSerial, false);
        await advance(rig, 120_000);
      },
      async (rig: Rig) => {
        await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      },
    ];
    for (const end of endings) {
      const rig = await setUpWithPhone();
      await granted(rig, 1, { physical: true, platform: "android" });

      await end(rig);

      await expect.poll(() => listed(rig)).toEqual([]);
      await expect.poll(() => rig.phone.rpcRequests("agent_device.lease.release")).toHaveLength(1);
      expect(rig.fake.rpcRequests("agent_device.lease.release")).toEqual([]);
      expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    }
  });

  it("a virtual allocate whose address is also its driver id reaches the simulator daemon, not the phone daemon", async () => {
    const rig = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          addressIsDeviceId: true,
          availableOsVersions: ["35"],
          clock,
          defaultModels: { phone: ["Pixel 8"] },
          knownModels: ["Pixel 8"],
          modelClasses: { "Pixel 8": "phone" },
          physicalDevices: [
            { class: "phone", ids: [phoneSerial], model: "Pixel 8", osVersion: "15" },
          ],
          platform: "android",
        }),
      ],
    });
    await rig.daemon.dispatch("device.add", { id: phoneSerial, platform: "android" }, adminSession);
    rig.driver.setPhysicalPresence(phoneSerial, true);

    await granted(rig, 1, { platform: "android" });

    expect(rig.fake.rpcRequests("agent_device.lease.allocate")).toMatchObject([
      { params: { leaseId: hex(1), serial: expect.stringMatching(/^fake-android-/) } },
    ]);
    expect(rig.phone.rpcRequests("agent_device.lease.allocate")).toEqual([]);
  });

  it("after a phone lease ends and its lease id has left the ended-id window, an allocate that reuses it for a virtual device reaches the simulator daemon", async () => {
    const rig = await setUpWithPhone();
    await granted(rig, 1, { physical: true, platform: "android" });
    await release(rig, 1);
    await expect.poll(() => listed(rig)).toEqual([]);
    rig.clock.advance(25 * 60 * 60_000);

    await granted(rig, 1, { platform: "android" });

    expect(allocatesReceived(rig, 1)).toHaveLength(1);
    expect(rig.phone.rpcRequests("agent_device.lease.allocate")).toHaveLength(1);
  });

  it("after the grant, the allocate the agent-device daemon receives names the granted device's address by `udid` on iOS and by `serial` on Android (the emulator serial, not the AVD name), and carries no `device`, `deviceKey` or `target`; the CLI gets the daemon's reply with the same lease ID", async () => {
    const ios = await setUp();
    const iosAnswer = await envelopeOf(
      await allocate(ios, 1, { device: "iPhone 17 Pro", deviceKey: "saved", target: "mobile" }),
    );
    const iosDevice = await grantedDevice(ios);
    const iosParams = receivedAllocate(ios, 1);

    expect(iosAnswer.result).toMatchObject({ data: { lease: { leaseId: hex(1) } }, ok: true });
    expect(iosParams["udid"]).toBe(iosDevice.address);
    expect(iosParams).not.toHaveProperty("serial");
    for (const dropped of ["device", "deviceKey", "target"]) {
      expect(iosParams).not.toHaveProperty(dropped);
    }

    const android = await setUp({ drivers: (clock) => [androidDriver(clock)] });
    const androidAnswer = await envelopeOf(
      await allocate(android, 2, { device: "Pixel 8", platform: "android" }),
    );
    const androidDevice = await grantedDevice(android);
    const androidParams = receivedAllocate(android, 2);

    expect(androidAnswer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    expect(androidParams["serial"]).toBe(androidDevice.address);
    expect(androidParams["serial"]).not.toBe(androidDevice.driverDeviceId);
    expect(androidParams).not.toHaveProperty("udid");
  });

  it("with every matching device leased, allocate waits, and is granted and answered once that device is released and reclaimed", async () => {
    const rig = await setUp({ maxRunning: 1 });
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });

    const second = track(allocate(rig, 2, {}, { token: secrets.two }));
    await expect
      .poll(async () => (await waiting(rig)).map((request) => request.requesterId))
      .toEqual([hex(2)]);
    expect(second.done()).toBe(false);

    await release(rig, 1);
    const answer = await envelopeOf(await second.promise);

    expect(answer.result).toMatchObject({ data: { lease: { leaseId: hex(2) } }, ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
  });

  it("a CLI that hangs up while its allocate waits, and one that hangs up before simlock admitted the request, leave simlock's queue, and neither request is granted when a device frees", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1);
    const hangUp = new AbortController();
    const second = track(allocate(rig, 2, {}, { signal: hangUp.signal, token: secrets.two }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    hangUp.abort();
    await second.promise.catch(() => undefined);
    await expect.poll(async () => (await waiting(rig)).length).toBe(0);
    await release(rig, 1);
    await sleep(50);

    expect(await leases(rig)).toEqual([]);
    expect(allocatesReceived(rig, 2)).toEqual([]);

    const slow = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      slowStart: true,
    });
    const early = new AbortController();
    const parked = track(
      fetch(`${slow.origin}/v1/agent-device/rpc`, {
        body: rpcBody("agent_device.lease.allocate", allocateParams(3)),
        headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
        method: "POST",
        signal: early.signal,
      }),
    );
    await sleep(100);
    expect(parked.done()).toBe(false);
    early.abort();
    await parked.promise.catch(() => undefined);
    await sleep(50);
    slow.clock.advance(30_000);
    const ready = { ...slow, daemon: await slow.started };
    await sleep(100);

    expect(await leases(ready)).toEqual([]);
    expect(await requestedSpecs(ready, hex(3))).toEqual([]);
    expect(allocatesReceived(ready, 3)).toEqual([]);
  });

  it("a CLI that hangs up after device work started for it gets no agent-device lease: the grant that lands later is released at once and never reaches the agent-device daemon; when that device work fails and the request goes back to the queue, it is never granted", async () => {
    const slowDevice = (clock: FakeClock) => [
      new FakeDriver({
        ...phoneModels,
        availableOsVersions: ["26.5"],
        clock,
        knownModels: ["iPhone 16"],
        latencyMs: { makeReady: 10_000 },
        platform: "ios",
      }),
    ];
    const rig = await setUp({ drivers: slowDevice });
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect
      .poll(() => rig.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await advance(rig, 12_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    expect(allocatesReceived(rig, 1)).toEqual([]);
    // why: the released device is deleted and the pool boots another on the fake clock, which the daemon's stop waits for.
    await advance(rig, 12_000);

    const failing = await setUp({ drivers: slowDevice });
    failing.driver.failOn("makeReady", 1, new Error("boot failed"));
    const abort = new AbortController();
    const second = track(allocate(failing, 2, {}, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect
      .poll(() => failing.driver.calls.some((call) => call.operation === "makeReady"))
      .toBe(true);
    abort.abort();
    await second.promise.catch(() => undefined);

    await advance(failing, 15_000);

    await expect.poll(async () => (await waiting(failing)).length).toBe(0);
    expect(await leases(failing)).toEqual([]);
    expect(allocatesReceived(failing, 2)).toEqual([]);
  });

  it("`DELETE /v1/lease-requests/:id` for the front's waiting request answers the allocate `refused by simlock:` with simlock's message, and nothing is leased", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);
    const [request] = await waiting(rig);

    const cancelled = await fetch(`${rig.origin}/v1/lease-requests/${request?.id}`, {
      headers: { authorization: `Bearer ${secrets.one}` },
      method: "DELETE",
    });
    const answer = await envelopeOf(await second.promise);

    expect(cancelled.status).toBe(204);
    expect(answer.error?.message).toMatch(/^refused by simlock: .+/);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(await waiting(rig)).toEqual([]);
  });

  it("stopping the daemon while an allocate waits ends with no simlock lease, and the lease request it waited on is cancelled, not open, in state.db", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, {}, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await rig.daemon.stop("test");
    await second.promise.catch(() => undefined);

    const database = await new NodeSqliteOpener().open(rig.stateDbPath, { readOnly: true });
    try {
      const leaseIds = database.prepare("SELECT id FROM leases").all();
      const requests = database.prepare("SELECT lease_id, state FROM lease_requests").all();
      expect(second.done()).toBe(true);
      expect(leaseIds).toEqual([{ id: hex(1) }]);
      expect(requests.filter((row) => row.lease_id === hex(2))).toEqual([
        expect.objectContaining({ state: "cancelled" }),
      ]);
      expect(requests.some((row) => row.state === "open")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("an allocate still waiting 330 s answers `timed out waiting for a device; nothing was leased`, and lease request failures carry their retry classification", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: maxTtlMs }, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await advance(rig, 329_000);
    expect(second.done()).toBe(false);
    await advance(rig, 1_000);
    expect(second.done()).toBe(true);
    const answer = await envelopeOf(await second.promise);

    expect(answer.error).toMatchObject(refusal(queueTimeoutMessage, "COMMAND_FAILED"));
    expect(answer.error?.data).toMatchObject({
      details: { reason: "NO_DEVICE_IN_TIME" },
      retriable: true,
    });
    expect(await waiting(rig)).toEqual([]);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    const tap = tapDispatch(rig);
    for (const [code, reason] of [
      ["NO_CAPACITY", "SIMLOCK_UNAVAILABLE"],
      ["DAEMON_STOPPING", "SIMLOCK_UNAVAILABLE"],
      ["DAEMON_CONNECTION_LOST", "SIMLOCK_UNAVAILABLE"],
      ["WORKER_UNREACHABLE", "WORKER_UNREACHABLE"],
      ["INVALID_ARGS", "REFUSED_BY_SIMLOCK"],
    ] as const) {
      tap.rejectNext("lease.request", new DispatchError(code, `failure ${code}`));
      const response = await allocate(rig, 3);
      expect(response.status).toBe(400);
      expect((await envelopeOf(response)).error).toMatchObject({
        message: `refused by simlock: failure ${code}`,
        data: { code: "INVALID_ARGS", details: { reason }, retriable: code !== "INVALID_ARGS" },
      });
    }
  });
});
