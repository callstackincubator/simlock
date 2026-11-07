import { describe, expect, it } from "vitest";

import { FakeDriver } from "../core/testing.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeSqliteOpener,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { FakeAgentDevice, FakeAgentDeviceHealth } from "./testing.js";
import { AgentDeviceSupervisor } from "./host/agent-device-supervisor.js";
import { SupervisorAgentDeviceUpstream } from "./host/upstream.js";
import {
  phoneSerial,
  setUpWithPhone,
  advance,
  release,
  liveStates,
  grantedDevice,
  track,
  listed,
  type DispatchTap,
  tapDispatch,
  runningCommand,
  simlockPicks,
  idOf,
  batch,
} from "./test-edge.js";
import {
  secrets,
  principals,
  notAvailable,
  agentTokenOnly,
  queueTimeoutMessage,
  defaultTtlMs,
  maxTtlMs,
  scope,
  adminSession,
  sessionFor,
  type Envelope,
  type Rig,
  androidDriver,
  taggedAndroidDriver,
  sleep,
  setUp,
  type SendOptions,
  send,
  rpcBody,
  rpc,
  bodyOf,
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
  simlockMessage,
  refusal,
  runCommand,
  forwarded,
  refused,
} from "./test-support.js";

// why: Fallow reads a `rig` binding's type only from an annotation in this file, not from an imported
// setUp's return type, so a `rig` whose test calls a FakeAgentDevice member only these tests use is
// annotated `Rig`; without it Fallow reports the member as never referenced.

async function unavailableSupervisor(version: string, reason: "wrong-version" | "start-failed") {
  const clock = new FakeClock(1_000_000);
  const filesystem = new MemoryFilesystem();
  const home = "/home/simlock/.simlock";
  const root = "/opt/ad/node_modules/agent-device";
  const cli = `${root}/bin/agent-device.mjs`;
  const entry = `${root}/dist/src/internal/daemon.js`;
  await filesystem.mkdirp(home);
  await filesystem.mkdirp("/usr/local/bin");
  await filesystem.mkdirp(`${root}/bin`);
  await filesystem.mkdirp(`${root}/dist/src/internal`);
  await filesystem.writeFileAtomic(cli, "#!/usr/bin/env node\n");
  filesystem.defineAttributes(cli, { mode: 0o755 });
  await filesystem.writeFileAtomic(`${root}/package.json`, '{"name":"agent-device"}');
  await filesystem.writeFileAtomic(entry, "");
  filesystem.defineSymlink("/usr/local/bin/agent-device", cli);
  const runner = new ScriptedProcessRunner([
    {
      match: { args: [cli, "--version"], command: "/opt/node/bin/node" },
      result: { code: 0, stderr: "", stdout: `${version}\n` },
    },
  ]);
  const supervisor = new AgentDeviceSupervisor({
    baseEnvironment: { HOME: "/home/operator", PATH: "/usr/local/bin:/usr/bin" },
    clock,
    config: { command: "agent-device" },
    driverEnvironment: {},
    filesystem,
    healthProbe: new FakeAgentDeviceHealth(),
    home,
    hostPlatform: "linux",
    leaseMaxTtlMs: 1_800_000,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    nodePath: "/opt/node/bin/node",
    nodeVersion: "22.14.0",
    platforms: ["ios", "android"],
    processRunner: runner,
    processSupervisor: new FakeProcessSupervisor([]),
    role: "simulators",
    tcpProbe: new FakeTcpProbe(),
  });
  await supervisor.start();
  expect(supervisor.availability()).toMatchObject({ state: "unavailable", reason });
  return new SupervisorAgentDeviceUpstream(supervisor);
}

const phoneModels = {
  defaultModels: { phone: ["iPhone 16"] },
  modelClasses: { "iPhone 16": "phone" },
} as const;

function allocatePhone(rig: Rig, n: number, extra: Record<string, unknown> = {}) {
  return allocate(rig, n, { platform: "android", ...extra, physical: true });
}

async function waiting(
  rig: Rig,
): Promise<readonly { readonly id: string; readonly requesterId: string }[]> {
  return (await rig.daemon.dispatch("list.get", { kind: "requests" }, adminSession)) as never;
}

const endedMessage = "lease ended by simlock; run disconnect, then open";

function heartbeat(
  rig: Rig,
  n: number,
  extra: Record<string, unknown> = {},
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.heartbeat", { ...scope, leaseId: hex(n), ...extra }, options);
}

function heartbeatsReceived(rig: Rig): number {
  return rig.fake.rpcRequests("agent_device.lease.heartbeat").length;
}

function expectEndedBySimlock(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: {
      code: "UNAUTHORIZED",
      details: { reason: "LEASE_ENDED_BY_HOST" },
      message: endedMessage,
      retriable: false,
    },
  });
}

function expectLeaseGone(answer: Envelope, reason: string): void {
  expect(answer.error).toMatchObject({
    data: { code: "UNAUTHORIZED", details: { reason } },
  });
}

async function deadlineOf(rig: Rig, n: number): Promise<number | undefined> {
  return (await leases(rig)).find((lease) => lease.id === hex(n))?.ttlDeadline;
}

function frontCalls(tap: DispatchTap): readonly string[] {
  return tap.operations.filter((name) => name === "lease.renew" || name === "lease.list");
}

async function renewMessage(rig: Rig, leaseId: string, ttlMs: number): Promise<string> {
  try {
    await rig.daemon.dispatch("lease.renew", { leaseId, ttlMs }, sessionFor(principals.one));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("simlock accepted a renewal the test expected it to refuse");
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("with capabilities.agent-device.enabled false, and unset on a gateway-mode daemon, /v1/agent-device/health answers 404, as today", async () => {
    const enabled = await setUp();
    expect((await send(enabled, "/health")).status).toBe(200);

    const off = await setUp({ enabled: false });
    expect((await send(off, "/health")).status).toBe(404);

    const gateway = await setUp({ enabled: "unset", gatewayMode: true });
    expect((await send(gateway, "/health")).status).toBe(404);
  });

  it("/v1/agent-device/rpc with no simlock token answers 401, with a worker join token 403, and with an operator token 403 `refused: agent-device through simlock needs an agent token`; the agent-device daemon receives nothing", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const received = rig.fake.requests.length;

    expect((await command(rig, "snapshot", undefined, { token: null })).status).toBe(401);
    expect((await command(rig, "snapshot", undefined, { token: secrets.worker })).status).toBe(403);
    const operator = await command(rig, "snapshot", undefined, { token: secrets.operator });
    expect(operator.status).toBe(403);
    expect(await operator.text()).toContain(agentTokenOnly);

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("/v1/agent-device/health with a simlock token answers the proxy's health, with the agent-device daemon's health under `upstream`", async () => {
    const rig = await setUp();

    const response = await send(rig, "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });
  });

  it("with capabilities.agent-device.enabled true and agent-device unavailable, /health, /rpc and an upload each answer `agent-device is not available on this simlock: <reason>`, nothing is leased, and POST /v1/lease-requests still grants a device", async () => {
    const rig = await setUp();
    const reason = "found 0.20.3, need 0.21.28 or later";
    rig.fake.setUnavailable(reason);

    const health = await send(rig, "/health");
    const rpcAnswer = await allocate(rig, 1);
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(health.status).toBe(200);
    expect(rpcAnswer.status).toBe(503);
    expect(upload.status).toBe(503);
    expect(await health.text()).toContain(`${notAvailable}${reason}`);
    const rpcError = (await envelopeOf(rpcAnswer)).error;
    expect(rpcError?.message).toBe(`${notAvailable}${reason}`);
    expect(rpcError?.data).toMatchObject({
      details: { reason: "SIMLOCK_UNAVAILABLE" },
      retriable: false,
    });
    for (const [version, reason, retriable] of [
      ["0.20.3", "wrong-version", false],
      ["0.21.28", "start-failed", true],
    ] as const) {
      const supervisorUpstream = await unavailableSupervisor(version, reason);
      const supervised = await setUp({ supervisorUpstream });
      const answer = await allocate(supervised, 2);
      expect(answer.status).toBe(503);
      expect((await envelopeOf(answer)).error?.data).toMatchObject({
        details: { reason: "SIMLOCK_UNAVAILABLE" },
        retriable,
      });
    }
    expect(await upload.text()).toContain(`${notAvailable}${reason}`);
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.requests).toEqual([]);

    const granted = await fetch(`${rig.origin}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", platform: "ios" }),
      headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(granted.status).toBe(201);
  });

  it("after the agent-device daemon restarts with a new base URL, token and generation, the next request reaches the new daemon", async () => {
    const rig: Rig = await setUp();
    expect(await bodyOf(await send(rig, "/health"))).toMatchObject({
      upstream: { service: "agent-device-daemon" },
    });
    const before = rig.fake.requests.length;

    rig.fake.restart();
    const response = await send(rig, "/health");

    expect(await bodyOf(response)).toMatchObject({ upstream: { service: "agent-device-daemon" } });
    expect(rig.fake.requests.length).toBeGreaterThan(before);
  });

  it("commands sent with two simlock tokens reach the agent-device daemon as two tenants, each its token's principal, though the client named another tenant", async () => {
    const rig = await setUp();
    const named = { meta: { tenantId: "someone-else" }, tenantId: "someone-else" };

    await command(rig, "snapshot", undefined, { token: secrets.one }, named);
    await command(rig, "snapshot", undefined, { token: secrets.two }, named);

    expect(rig.fake.rpcRequests("agent_device.command").map((request) => request.tenant)).toEqual([
      principals.one,
      principals.two,
    ]);
  });

  it("allocate `--platform ios` makes a simlock lease whose ID and requester are the CLI's lease ID, owned by the token's principal, and the lease request names no osVersion, mode, imageTag or physical device", async () => {
    const rig = await setUp();

    const answer = await allocate(rig, 1);

    expect((await envelopeOf(answer)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toMatchObject([
      { id: hex(1), ownerId: principals.one, requesterId: hex(1) },
    ]);
    expect(await requestedSpecs(rig, hex(1))).toEqual([{ platform: "ios" }]);

    const bare = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });
    const refused = await allocate(bare, 2);
    expect((await envelopeOf(refused)).error?.message).toContain("refused by simlock: ");
    expect(bare.driver.calls.map((call) => call.operation)).not.toContain("installComponent");
  });

  it('allocate with `osVersion` "26.0", ">=18 <27" or, on Android, "34" makes a lease request that carries it as typed', async () => {
    const rig = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: ["18.4", "26.0", "27.0"],
          clock,
          defaultModels: { phone: ["iPhone 16"] },
          knownModels: ["iPhone 16"],
          modelClasses: { "iPhone 16": "phone" },
          platform: "ios",
        }),
        new FakeDriver({
          availableOsVersions: ["34", "35"],
          clock,
          defaultModels: { phone: ["Pixel 8"] },
          knownModels: ["Pixel 8"],
          modelClasses: { "Pixel 8": "phone" },
          platform: "android",
        }),
      ],
      maxRunning: 8,
    });

    await granted(rig, 1, { osVersion: "26.0" });
    await granted(rig, 2, { osVersion: ">=18 <27" });
    await granted(rig, 3, { osVersion: "34", platform: "android" });

    expect(await requestedSpecs(rig, hex(1))).toEqual([{ osVersion: "26.0", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([{ osVersion: ">=18 <27", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ osVersion: "34", platform: "android" }]);
  });

  it('allocate on Android with `imageTag` "google_apis_playstore", with and without `osVersion`, makes a lease request that carries it', async () => {
    const rig = await setUp({ drivers: (clock) => [taggedAndroidDriver(clock)], maxRunning: 8 });
    const android = { platform: "android" };

    await granted(rig, 1, { ...android, imageTag: "google_apis_playstore" });
    await granted(rig, 2, { ...android, imageTag: "google_apis_playstore", osVersion: "33" });

    expect(await requestedSpecs(rig, hex(1))).toEqual([
      { imageTag: "google_apis_playstore", platform: "android" },
    ]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([
      { imageTag: "google_apis_playstore", osVersion: "33", platform: "android" },
    ]);
  });

  it("the allocate the agent-device daemon receives carries neither `osVersion` nor `imageTag`, whether the CLI sent one or both", async () => {
    const rig = await setUp({ drivers: (clock) => [taggedAndroidDriver(clock)], maxRunning: 8 });
    const android = { platform: "android" };

    await granted(rig, 1, { ...android, osVersion: "34" });
    await granted(rig, 2, { ...android, imageTag: "google_apis_playstore" });
    await granted(rig, 3, { ...android, imageTag: "google_apis_playstore", osVersion: "33" });

    for (const n of [1, 2, 3]) {
      const received = receivedAllocate(rig, n);
      expect(received).not.toHaveProperty("osVersion");
      expect(received).not.toHaveProperty("imageTag");
    }
  });

  it("the relayed allocate reply carries `data.lease.device` as `{ model, osVersion, deviceMode, physical: false, udid or serial }`, `deviceMode` being the mode the device reports, on iOS and on Android without a tag, and with `imageTag` on Android with one, the daemon's `deviceKey` and `data.device` unchanged", async () => {
    const rig: Rig = await setUp({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: ["18.4", "26.0", "27.0"],
          clock,
          defaultModels: { phone: ["iPhone 16"] },
          knownModels: ["iPhone 16"],
          mode: "slim",
          modelClasses: { "iPhone 16": "phone" },
          platform: "ios",
        }),
        taggedAndroidDriver(clock),
      ],
      maxRunning: 8,
    });
    const cases = [
      [
        1,
        { osVersion: ">=18 <27" },
        { deviceMode: "slim", model: "iPhone 16", osVersion: "26.0", physical: false },
      ],
      [2, {}, { deviceMode: "slim", model: "iPhone 16", osVersion: "27.0", physical: false }],
      [
        3,
        { imageTag: "google_apis_playstore", platform: "android" },
        {
          deviceMode: "full",
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          osVersion: "34",
          physical: false,
        },
      ],
      [
        4,
        { platform: "android" },
        { deviceMode: "full", model: "Pixel 8", osVersion: "35", physical: false },
      ],
    ] as const;

    for (const [n, extra, device] of cases) {
      rig.fake.nameDeviceKeyInNextReply(`key-${n}`);
      rig.fake.nameDeviceInNextReply({});
      const result = (await envelopeOf(await allocate(rig, n, extra, {}))).result as {
        data: { device: unknown; lease: Record<string, unknown> };
      };
      expect(result.data.lease["device"]).toEqual({
        ...device,
        ["platform" in extra && extra.platform === "android" ? "serial" : "udid"]: idOf(rig, n),
      });
      expect(idOf(rig, n)).not.toBe("undefined");
      expect(result.data.lease["deviceKey"]).toBe(`key-${n}`);
      expect(result.data.device).toMatchObject({ id: expect.any(String) });
    }
  });

  it('allocate with `osVersion` "^18", with `imageTag` on iOS (with a model and without) or with an OS the driver lacks answers `refused by simlock:` with simlock\'s own message and leaves no lease; under `downloads.policy: always` the missing OS is installed for a named model and still refused without one', async () => {
    const rig = await setUp();
    const refusals: readonly Record<string, unknown>[] = [
      { osVersion: "^18" },
      { device: "iPhone 17 Pro", imageTag: "default" },
      { imageTag: "default" },
      { osVersion: "26.1" },
    ];

    for (const [index, extra] of refusals.entries()) {
      const expected = await simlockMessage(rig, {
        leaseId: hex(90 + index),
        platform: "ios",
        ...(typeof extra["device"] === "string" ? { model: extra["device"] } : {}),
        ...(extra["imageTag"] === undefined ? {} : { imageTag: extra["imageTag"] }),
        ...(extra["osVersion"] === undefined ? {} : { osVersion: extra["osVersion"] }),
      });
      const answer = await envelopeOf(await allocate(rig, index + 1, extra));
      expect(answer.error?.message).toBe(`refused by simlock: ${expected}`);
    }
    expect(await leases(rig)).toEqual([]);
    expect(rig.driver.calls.map((call) => call.operation)).not.toContain("installComponent");

    const always = await setUp({ downloads: "always" });
    const installs = () =>
      always.driver.calls.filter((call) => call.operation === "installComponent").length;
    const bare = await envelopeOf(await allocate(always, 1, { osVersion: "26.1" }));
    expect(bare.error?.message).toContain("refused by simlock: ");
    expect(installs()).toBe(0);
    const named = await envelopeOf(
      await allocate(always, 2, { device: "iPhone 17 Pro", osVersion: "26.1" }),
    );
    expect(named.result).toMatchObject({ ok: true });
    expect(installs()).toBe(1);
  });

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
      ["starting", "phone daemon: starting"],
      ["adb not found", "phone daemon: adb not found"],
    ] as const;
    for (const [reason, message] of down) {
      const rig = await setUpWithPhone({ maxRunning: 4 });
      rig.phone.setUnavailable(reason);

      const answer = await envelopeOf(await allocatePhone(rig, 1));

      expect(answer.error).toMatchObject(refusal(`${notAvailable}${message}`, "COMMAND_FAILED"));
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

  it("after a phone lease ends, an allocate that reuses its lease id for a virtual device reaches the simulator daemon", async () => {
    const rig = await setUpWithPhone();
    await granted(rig, 1, { physical: true, platform: "android" });
    await release(rig, 1);
    await expect.poll(() => listed(rig)).toEqual([]);

    await granted(rig, 1, { platform: "android" });

    expect(allocatesReceived(rig, 1)).toHaveLength(1);
    expect(rig.phone.rpcRequests("agent_device.lease.allocate")).toHaveLength(1);
  });

  it("allocate with `physical: false` and `physical: null` are granted", async () => {
    const rig = await setUp({ maxRunning: 8 });

    await granted(rig, 2, { physical: false });
    await granted(rig, 3, { physical: null });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2), hex(3)]);
  });

  it('allocate with an unmapped `target`, "watch" or "", alone or beside `device: "iPhone 17 Pro"`, answers `refused: unknown --target <value>; use mobile, tv or desktop` and leaves no lease', async () => {
    const rig = await setUp();
    const cases = [
      [{ target: "watch" }, "watch"],
      [{ target: "" }, ""],
      [{ device: "iPhone 17 Pro", target: "watch" }, "watch"],
    ] as const;

    for (const [index, [extra, value]] of cases.entries()) {
      const answer = await envelopeOf(await allocate(rig, index + 1, extra));

      expect(answer.error).toMatchObject(
        refusal(`refused: unknown --target ${value}; use mobile, tv or desktop`),
      );
    }
    expect(await leases(rig)).toEqual([]);
    expect(allocatesReceived(rig)).toEqual([]);
  });

  it("the simlock lease's TTL is the CLI's `ttlMs`, 5 s when the CLI sent less, and `lease.defaultTtlMs` when it sent none; the allocate the agent-device daemon receives carries `ttlMs` equal to the ceiling in each case", async () => {
    const rig = await setUp();

    await granted(rig, 1, { ttlMs: 120_000 });
    await granted(rig, 2, { ttlMs: 1_000 });
    await granted(rig, 3, { ttlMs: undefined });

    const byId = new Map((await leases(rig)).map((lease) => [lease.id, lease.ttlMs]));
    expect(byId.get(hex(1))).toBe(120_000);
    expect(byId.get(hex(2))).toBe(5_000);
    expect(byId.get(hex(3))).toBe(defaultTtlMs);
    expect(allocatesReceived(rig).map((request) => request.params?.["ttlMs"])).toEqual([
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
      rig.fake.leaseMaxTtlMs,
    ]);
  });

  it('allocate `--target mobile`, `tv` and `desktop` ask simlock for class `phone`, `tv` and `desktop`; allocate `--device "iPhone 17 Pro"`, alone and with `--target tv`, asks for that model and no class', async () => {
    const rig = await setUp({ maxRunning: 8 });

    await granted(rig, 1, { target: "mobile" });
    await granted(rig, 2, { target: "tv" });
    await granted(rig, 3, { target: "desktop" });
    await granted(rig, 4, { device: "iPhone 17 Pro" });
    await granted(rig, 5, { device: "iPhone 17 Pro", target: "tv" });

    expect(await requestedSpecs(rig, hex(1))).toEqual([{ class: "phone", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([{ class: "tv", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ class: "desktop", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(4))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
    expect(await requestedSpecs(rig, hex(5))).toEqual([
      { model: "iPhone 17 Pro", platform: "ios" },
    ]);
  });

  it("an allocate whose `ttlMs` is above `lease.maxTtlMs` answers `refused by simlock:` with simlock's `BAD_REQUEST` message and leaves no simlock lease; one with `ttlMs: null` gets `lease.defaultTtlMs`", async () => {
    const rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1, { ttlMs: null }))).result).toMatchObject({
      ok: true,
    });
    expect((await leases(rig)).map((lease) => lease.ttlMs)).toEqual([defaultTtlMs]);

    const over = maxTtlMs + 1;
    const expected = await simlockMessage(rig, { leaseId: hex(9), platform: "ios", ttlMs: over });
    const answer = await envelopeOf(await allocate(rig, 2, { ttlMs: over }));

    expect(answer.error?.message).toBe(`refused by simlock: ${expected}`);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it('allocate `--device "My test phone"` answers `refused by simlock:` with simlock\'s message, and leaves no simlock lease', async () => {
    const rig = await setUp();
    expect(
      (await envelopeOf(await allocate(rig, 1, { device: "iPhone 17 Pro" }))).result,
    ).toMatchObject({ ok: true });
    const expected = await simlockMessage(rig, {
      leaseId: hex(9),
      model: "My test phone",
      platform: "ios",
    });

    const answer = await envelopeOf(await allocate(rig, 2, { device: "My test phone" }));

    expect(answer.error).toMatchObject(refusal(`refused by simlock: ${expected}`));
    expect(answer.error?.data).toMatchObject({
      details: { reason: "REFUSED_BY_SIMLOCK" },
      retriable: false,
    });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  describe("each input refused before simlock", () => {
    const tooOld = "refused: this agent-device is too old for simlock; upgrade it";
    const ttlRefusal = "refused: ttlMs must be a positive number of milliseconds";
    const plainOnly = "refused: simlock leases only plain devices";
    const lifecycle = "refused: send lease calls as lease RPCs";
    const cases: readonly {
      readonly title: string;
      readonly message: string;
      readonly method?: string;
      readonly params: (n: number) => Record<string, unknown>;
    }[] = [
      {
        message: "refused: only iOS and Android",
        params: (n) => allocateParams(n, { platform: "macos" }),
        title: "--platform macos",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { udid: "ABC" }),
        title: "--udid",
      },
      {
        message: "refused: simlock picks the device",
        params: (n) => allocateParams(n, { serial: "emulator-5554" }),
        title: "--serial",
      },
      {
        message: "refused: name --platform ios or android",
        params: (n) => allocateParams(n, { platform: undefined }),
        title: "no platform",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: undefined }),
        title: "no lease ID",
      },
      {
        message: tooOld,
        params: (n) => allocateParams(n, { leaseId: hex(n).toUpperCase().replace(/[0-9]/g, "A") }),
        title: "a lease ID that is not 32 lowercase hex",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: "abc" }),
        title: 'a ttlMs of "abc"',
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: -1 }),
        title: "a ttlMs of -1",
      },
      {
        message: ttlRefusal,
        params: (n) => allocateParams(n, { ttlMs: 0 }),
        title: "a ttlMs of 0",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { backend: "cloud" }),
        title: "backend",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { backend: "android-instance" }),
        title: "the Android backend on an iOS allocate",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { providerName: "x" }),
        title: "a provider* key",
      },
      {
        message: plainOnly,
        params: (n) => allocateParams(n, { leaseProvider: "aws" }),
        title: 'leaseProvider: "aws"',
      },
      ...["agent_device.command", "agent-device.command"].flatMap((method) =>
        ["lease_allocate", "lease_heartbeat", "lease_release"].map((name) => ({
          message: lifecycle,
          method,
          params: (n: number) => ({ command: name, meta: { leaseId: hex(n) } }),
          title: `${method} carrying ${name}`,
        })),
      ),
    ];

    it.each(cases)(
      "$title answers its message, simlock stores no lease request, and the agent-device daemon receives nothing",
      async ({ message, method, params }) => {
        const rig = await setUp();
        const accepted = await allocate(rig, 1);
        expect((await envelopeOf(accepted)).result).toMatchObject({ ok: true });
        const heldBefore = (await leases(rig)).map((lease) => lease.id);
        const receivedBefore = rig.fake.requests.length;

        const answer = await rpc(rig, method ?? "agent_device.lease.allocate", params(2));

        expect((await envelopeOf(answer)).error).toMatchObject(refusal(message));
        expect(await requestedSpecs(rig, hex(2))).toEqual([]);
        expect(await waiting(rig)).toEqual([]);
        expect((await leases(rig)).map((lease) => lease.id)).toEqual(heldBefore);
        expect(rig.fake.requests).toHaveLength(receivedBefore);
      },
    );
  });

  it("an allocate in the shape connect proxy sends, with backend ios-instance, is granted and keeps the backend toward the agent-device daemon", async () => {
    const rig = await setUp();

    const answer = await envelopeOf(
      await allocate(rig, 1, {
        backend: "ios-instance",
        runId: "proxy-1",
        session: "adc-1",
        tenantId: "proxy",
      }),
    );

    expect(answer.result).toMatchObject({ ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(allocatesReceived(rig, 1).map((received) => received.params?.["backend"])).toEqual([
      "ios-instance",
    ]);
  });

  it("allocate and release sent as `agent-device.lease.allocate` and `agent-device.lease.release` act exactly as the `agent_device.lease.*` spelling", async () => {
    const rig = await setUp();

    const allocated = await rpc(rig, "agent-device.lease.allocate", allocateParams(1));

    expect((await envelopeOf(allocated)).result).toMatchObject({ ok: true });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const released = await rpc(rig, "agent-device.lease.release", { ...scope, leaseId: hex(1) });

    expect((await envelopeOf(released)).result).toMatchObject({ ok: true });
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
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

  it("an allocate still waiting 330 s after the front admitted it answers `timed out waiting for a device; nothing was leased`, and simlock's queue is empty", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: maxTtlMs }, { token: secrets.two });
    const second = track(allocate(rig, 2));
    await expect.poll(async () => (await waiting(rig)).length).toBe(1);

    await advance(rig, 329_000);
    expect(second.done()).toBe(false);
    await advance(rig, 1_000);
    const answer = await envelopeOf(await second.promise);

    expect(answer.error).toMatchObject(refusal(queueTimeoutMessage, "COMMAND_FAILED"));
    expect(answer.error?.data).toMatchObject({
      details: { reason: "NO_DEVICE_IN_TIME" },
      retriable: true,
    });
    expect(await waiting(rig)).toEqual([]);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("an agent-device allocate that answers an error, and a grant that names no device address, release the simlock lease, and the CLI gets the error", async () => {
    const rig: Rig = await setUp();
    rig.fake.failNextAllocate({
      code: "NO_DEVICE",
      message: "no such device",
      details: { reason: "AGENT_DEVICE_REASON" },
    });

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toEqual({
      code: -32000,
      data: {
        code: "NO_DEVICE",
        message: "no such device",
        details: { reason: "AGENT_DEVICE_REASON" },
      },
      message: "no such device",
    });
    await expect.poll(async () => (await leases(rig)).length).toBe(0);

    class NoAddressDriver extends FakeDriver {
      override async makeReady(...arguments_: Parameters<FakeDriver["makeReady"]>) {
        const ready = await super.makeReady(...arguments_);
        return { ...ready, address: undefined as unknown as string };
      }
    }
    const bare = await setUp({
      drivers: (clock) => [
        new NoAddressDriver({
          ...phoneModels,
          availableOsVersions: ["26.5"],
          clock,
          knownModels: ["iPhone 16"],
          platform: "ios",
        }),
      ],
    });

    const noAddress = await envelopeOf(await allocate(bare, 2));

    expect(noAddress.error?.data).toMatchObject({
      code: "COMMAND_FAILED",
      details: { reason: "SIMLOCK_FAILED" },
      retriable: false,
    });
    await expect.poll(async () => (await leases(bare)).length).toBe(0);
    expect(allocatesReceived(bare, 2)).toEqual([]);
  });

  it("an agent-device allocate with no usable reply (an unreachable daemon, a non-JSON body) releases the simlock lease and answers `COMMAND_FAILED`; when agent-device answers the follow-up release with a scope error, the simlock lease stays until its TTL, and when it answers `LEASE_NOT_FOUND`, the simlock lease is released", async () => {
    const rig: Rig = await setUp();
    expect((await envelopeOf(await allocate(rig, 1))).result).toMatchObject({ ok: true });
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await allocate(rig, 2));
    rig.fake.setUnreachable(false);

    expect(unreachable.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    const notJson = await envelopeOf(await allocate(rig, 3));

    expect(notJson.error?.data?.code).toBe("COMMAND_FAILED");
    await expect.poll(async () => (await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "UNAUTHORIZED", message: "lease scope mismatch" });
    const kept = await envelopeOf(await allocate(rig, 4, { ttlMs: 60_000 }));

    expect(kept.error?.data?.code).toBe("COMMAND_FAILED");
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(4));
    await advance(rig, 61_000);
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(4));

    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");
    rig.fake.failNextRelease({ code: "LEASE_NOT_FOUND", message: "no such lease" });
    const gone = await envelopeOf(await allocate(rig, 5, { ttlMs: 60_000 }));

    expect(gone.error?.data?.code).toBe("COMMAND_FAILED");
    await expect
      .poll(async () => (await leases(rig)).map((lease) => lease.id))
      .not.toContain(hex(5));
  });

  it("the follow-up release after an allocate with no usable reply carries the allocate's runId, leaseProvider and clientId and not its deviceKey", async () => {
    const rig: Rig = await setUp();
    rig.fake.answerNextAllocateWith("<html>bad gateway</html>");

    const answer = await envelopeOf(await allocate(rig, 1, { deviceKey: "saved-device" }));

    expect(answer.error?.data?.code).toBe("COMMAND_FAILED");
    const params = rig.fake.rpcRequests("agent_device.lease.release")[0]?.params;
    expect(params).toMatchObject({ ...scope, leaseId: hex(1) });
    expect(params).not.toHaveProperty("deviceKey");
  });

  it("a lease whose allocate reply names device key `ios:mobile:<id>` keeps it: a command naming that lease with that `deviceKey` reaches agent-device", async () => {
    const rig: Rig = await setUp();
    const key = "ios:mobile:00008110-001A2B3C4D5E";
    rig.fake.nameDeviceKeyInNextReply(key);
    await granted(rig, 1);

    await forwarded(rig, () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: key } }));
  });

  it("an allocate reply whose lease `deviceKey` is over 128 characters still succeeds and keeps the lease, with the device key left unset: no release is sent and a command naming the lease with a `deviceKey` is refused", async () => {
    const rig: Rig = await setUp();
    rig.fake.nameDeviceKeyInNextReply("x".repeat(129));

    const answer = await envelopeOf(await allocate(rig, 1));

    expect(answer.error).toBeUndefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(0);
    expect((await leases(rig)).map((lease) => lease.id)).toContain(hex(1));
    await refused(
      rig,
      () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "x".repeat(129) } }),
      simlockPicks,
    );
  });

  it("a CLI that hangs up while agent-device makes its lease leaves neither lease: the agent-device lease is released with the reply's scope, then the simlock lease; when that release fails, the simlock lease stays until its TTL", async () => {
    const rig: Rig = await setUp();
    rig.fake.holdAllocate();
    rig.fake.nameDeviceKeyInNextReply("device-key-1");
    const hangUp = new AbortController();
    const first = track(allocate(rig, 1, {}, { signal: hangUp.signal }));
    await sleep(50);
    expect(first.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 1).length).toBe(1);

    hangUp.abort();
    await first.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();

    await expect.poll(async () => (await leases(rig)).length).toBe(0);
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject({
      ...scope,
      deviceKey: "device-key-1",
    });

    rig.fake.holdAllocate();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "release failed" });
    const abort = new AbortController();
    const second = track(allocate(rig, 2, { ttlMs: 60_000 }, { signal: abort.signal }));
    await sleep(50);
    expect(second.done()).toBe(false);
    await expect.poll(() => allocatesReceived(rig, 2).length).toBe(1);
    abort.abort();
    await second.promise.catch(() => undefined);
    await sleep(50);
    rig.fake.letAllocateGo();
    await expect.poll(() => rig.fake.rpcRequests("agent_device.lease.release").length).toBe(2);

    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(2)]);
    await advance(rig, 61_000);
    await expect.poll(async () => (await leases(rig)).length).toBe(0);
  });

  it("release goes to the agent-device daemon first, then frees the simlock lease and the device; a release after `close`, which already freed the simlock lease, reaches the daemon with no lease held and is answered `released: false`", async () => {
    const rig = await setUp();
    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = (await leases(rig)).map((lease) => lease.id);
    };
    await granted(rig, 1);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(heldAtDaemonRelease).toEqual([hex(1)]);
    expect(await leases(rig)).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);

    await granted(rig, 2);
    await command(rig, "close", 2);
    await expect.poll(async () => leases(rig)).toEqual([]);
    const afterClose = await envelopeOf(await release(rig, 2));

    expect(afterClose.result).toMatchObject({ ok: true, released: false });
    expect(heldAtDaemonRelease).toEqual([]);
    expect(await leases(rig)).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
  });

  it("a runner allocates with retainOnClose, closes, and its lease stays until release", async () => {
    const cases = [
      (rig: Rig) => command(rig, "close", 1),
      (rig: Rig) => command(rig, "close", 1, {}, { positionals: ["com.example.app"] }),
      (rig: Rig) => batch(rig, 1, [{ command: "snapshot" }, { command: "close" }]),
    ];
    for (const close of cases) {
      const rig: Rig = await setUp();
      expect(
        (await envelopeOf(await allocate(rig, 1, { retainOnClose: true }))).result,
      ).toMatchObject({ ok: true, data: { lease: { retainOnClose: true } } });
      expect((await envelopeOf(await close(rig))).result).toMatchObject({ ok: true });
      expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
      expect((await envelopeOf(await heartbeat(rig, 1))).result).toMatchObject({ ok: true });
      expect((await envelopeOf(await command(rig, "snapshot", 1))).result).toMatchObject({
        ok: true,
      });
      expect((await envelopeOf(await release(rig, 1))).result).toMatchObject({
        ok: true,
        released: true,
      });
      expect(await leases(rig)).toEqual([]);
      await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
    }
  });

  const ended = [{ leaseId: hex(1), outcome: "released" }];
  it.each([
    [
      "a `close` that succeeds, in `data`",
      { result: { data: { endedLeases: ended } } },
      (rig: Rig) => command(rig, "close", 1),
    ],
    [
      "a `close` that fails, in `error.details`",
      { error: { data: { details: { endedLeases: ended } } } },
      (rig: Rig) => {
        rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "close failed" });
        return command(rig, "close", 1);
      },
    ],
    [
      "a `batch` with a close step, in `data` beside `results`",
      { result: { data: { endedLeases: ended, results: [] } } },
      (rig: Rig) => batch(rig, 1, [{ command: "snapshot" }, { command: "close" }]),
    ],
  ] as const)(
    "%s: a command that ends the agent-device lease and names it in `endedLeases` releases the simlock lease and frees the device though the CLI sends no release, and a later heartbeat answers `LEASE_NOT_FOUND`",
    async (_case, reply, send) => {
      const rig = await setUp();
      await granted(rig, 1);

      expect(await envelopeOf(await send(rig))).toMatchObject(reply);
      await expect.poll(async () => listed(rig)).toEqual([]);
      await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
      expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    },
  );

  // why: agent-device 0.21.28 streams a reply when the CLI runs without --json; the JSON-RPC answer is the `response` of a `type: "response"` line, not the line itself.
  it("a close streamed in agent-device's own line shape releases the simlock lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const chunks = [
      `${JSON.stringify({ event: { kind: "command", message: "Closing" }, type: "progress" })}\n`,
      `${JSON.stringify({
        response: {
          id: "x",
          jsonrpc: "2.0",
          result: { data: { endedLeases: ended, session: "t:adc-1" }, ok: true },
        },
        type: "response",
      })}\n`,
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(rig, "close", 1);

    expect(await streamed.text()).toBe(chunks.join(""));
    await expect.poll(async () => listed(rig), { timeout: 3_000 }).toEqual([]);
    await expect.poll(async () => liveStates(rig)).toEqual(["ready"]);
  });

  it("a release the agent-device daemon fails keeps the simlock lease and answers the daemon's error", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon could not release" });

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon could not release",
    });
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a release from a second token naming the first token's lease ID leaves the first token's simlock lease in place", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.error).toBeDefined();
    expect(rig.fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    rig.fake.letAnyTenantRelease();
    const crossed = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(crossed.result).toMatchObject({ ok: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1)]);
  });

  it("a command's reply, a streamed progress body included, reaches the CLI unchanged, and a CLI that hangs up during it aborts the request the agent-device daemon was answering", async () => {
    const rig = await setUp();
    const chunks = [
      '{"type":"progress","event":{"kind":"command","message":"one"}}\n',
      '{"type":"progress","event":{"kind":"command","message":"two"}}\n',
      '{"type":"response","response":{"jsonrpc":"2.0","id":"x","result":{"ok":true,"data":{}}}}\n',
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(
      rig,
      "install",
      undefined,
      {},
      { meta: { uploadedArtifactId: "art-1" } },
    );

    expect(await streamed.text()).toBe(chunks.join(""));

    const plain = await envelopeOf(await command(rig, "snapshot", undefined));
    expect(plain.result).toMatchObject({ command: "snapshot", ok: true });

    rig.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "snapshot", undefined, { signal: hangUp.signal }));
    await sleep(50);
    expect(held.done()).toBe(false);
    await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(3);
    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect.poll(() => rig.fake.abortedCommands).toEqual(["snapshot"]);
  });

  it("an upload preflight answers a ticket URL under `/v1/agent-device/upload/direct/` on simlock's own origin, carrying the agent's own simlock token, and a `PUT` to it reaches the agent-device daemon", async () => {
    const rig = await setUp();

    const preflight = await send(rig, "/upload/preflight", { body: "{}" });
    expect(preflight.status).toBe(200);
    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;

    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const carried = Object.entries(ticket.headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(carried?.[1]).toBe(`Bearer ${secrets.one}`);

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: ticket.headers,
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(rig.fake.uploads).toEqual(["artifact bytes"]);
  });

  it("on a worker, an upload preflight and an artifact download follow the `x-agent-device-lease-id` header to the daemon of the lease it names, go to the simulator daemon with no header, and a header naming a lease routes by the lease id whichever token sends it, and a malformed header is refused `the x-agent-device-lease-id header is not a lease id`", async () => {
    const rig = await setUpWithPhone();
    await granted(rig, 1, { physical: true, platform: "android" });
    await granted(rig, 2, { platform: "android" });
    const named = (n: number) => ({ "x-agent-device-lease-id": hex(n) });
    const malformed = { "x-agent-device-lease-id": "NOT-A-LEASE-ID".repeat(4) };
    const reaching = (fake: FakeAgentDevice, path: string) =>
      fake.requests.filter((request) => request.path === path).length;
    const routes = [
      ["/upload/preflight", { body: "{}" }],
      ["/artifacts/a1", {}],
    ] as const;
    const cases = [
      [named(1), secrets.one, "phone"],
      [named(2), secrets.one, "simulators"],
      [{}, secrets.one, "simulators"],
      [named(1), secrets.two, "phone"],
      [malformed, secrets.one, "refused"],
    ] as const;

    for (const [path, body] of routes) {
      for (const [headers, token, reaches] of cases) {
        const [phoneBefore, simulatorsBefore] = [
          reaching(rig.phone, path),
          reaching(rig.fake, path),
        ];

        const answer = await send(rig, path, { ...body, headers, token });

        expect([
          reaching(rig.phone, path) - phoneBefore,
          reaching(rig.fake, path) - simulatorsBefore,
        ]).toEqual([reaches === "phone" ? 1 : 0, reaches === "simulators" ? 1 : 0]);
        if (reaches === "refused") {
          expect(answer.status).toBe(400);
          expect(await answer.text()).toContain(
            "the x-agent-device-lease-id header is not a lease id",
          );
        }
      }
    }
  });

  it("an `/rpc` body over 1 MiB, one that is not JSON, a JSON array, and an object with no `method` are each refused with their message and `id: null`, also while agent-device is unavailable, and neither simlock nor the agent-device daemon sees them", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const oneMiB = 1024 * 1024;
    const bodies: readonly [string, string][] = [
      [
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "agent_device.command",
          params: { pad: "x".repeat(oneMiB) },
        }),
        "refused: request body over 1 MiB",
      ],
      ["{ not json", "refused: send one JSON-RPC request"],
      ["[]", "refused: send one JSON-RPC request"],
      [JSON.stringify({ id: 3, jsonrpc: "2.0" }), "refused: send one JSON-RPC request"],
    ];

    for (const unavailable of [false, true]) {
      rig.fake.setUnavailable(unavailable ? "starting" : undefined);
      const receivedBefore = rig.fake.requests.length;
      for (const [body, message] of bodies) {
        const answer = await envelopeOf(await send(rig, "/rpc", { body }));
        expect(answer).toMatchObject({ error: refusal(message), id: null, jsonrpc: "2.0" });
      }
      expect(rig.fake.requests).toHaveLength(receivedBefore);
    }
    expect(await waiting(rig)).toEqual([]);
    expect(await leases(rig)).toEqual([]);
  });

  it("a heartbeat reaches the agent-device daemon before simlock, carrying `ttlMs` equal to the ceiling, and once it answers, the simlock lease's deadline is now plus the CLI's `ttlMs`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const allocated = await deadlineOf(rig, 1);
    let deadlineAtDaemon: number | undefined;
    rig.fake.onHeartbeat = async () => {
      deadlineAtDaemon = await deadlineOf(rig, 1);
    };
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 120_000 }, { token: secrets.one }),
    );

    expect(answer.result).toMatchObject({ ok: true });
    expect(deadlineAtDaemon).toBe(allocated);
    expect(rig.fake.rpcRequests("agent_device.lease.heartbeat")[0]?.params).toMatchObject({
      ...scope,
      leaseId: hex(1),
      ttlMs: rig.fake.leaseMaxTtlMs,
    });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
  });

  it.each([
    { cap: undefined, expected: 300_000, row: "300000 with no cap", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "300000 with cap 10000", sent: 300_000 },
    { cap: 600_000, expected: 300_000, row: "300000 with cap 600000", sent: 300_000 },
    { cap: 10_000, expected: 10_000, row: "none with cap 10000", sent: undefined },
    { cap: undefined, expected: defaultTtlMs, row: "none with no cap", sent: undefined },
    { cap: undefined, expected: 5_000, row: "1 with no cap", sent: 1 },
  ])(
    "a CLI `ttlMs` of $row gives the simlock lease, its heartbeat renewal and its renewal interval a TTL of $expected ms",
    async ({ cap, expected, sent }) => {
      const rig = await setUp(cap === undefined ? {} : { leaseTtlCapMs: cap });
      const ttl = expected as number;
      await granted(rig, 1, { ttlMs: sent });
      expect((await leases(rig))[0]?.ttlMs).toBe(ttl);
      await advance(rig, 1_000);

      const answer = await envelopeOf(
        await heartbeat(rig, 1, sent === undefined ? {} : { ttlMs: sent }),
      );

      expect(answer.result).toMatchObject({ ok: true });
      expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + ttl);
      const settled = await deadlineOf(rig, 1);
      await runningCommand(rig, 1);
      await advance(rig, Math.floor(ttl / 3) - 700, 500);
      expect(await deadlineOf(rig, 1)).toBe(settled);
      await advance(rig, 1_400, 500);
      const renewed = (await deadlineOf(rig, 1)) as number;
      expect(renewed).toBeGreaterThan(settled as number);
      expect(renewed - (settled as number)).toBeLessThanOrEqual(ttl / 3 + 700);
    },
    60_000,
  );

  it("a heartbeat with a longer `ttlMs` than the allocate's moves the deadline to now plus that TTL, and a following heartbeat with no `ttlMs` renews with it too", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 300_000 });

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    await advance(rig, 20_000);

    await heartbeat(rig, 1);

    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 300_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(300_000);
  });

  it("after the agent's own `simlock lease renew` with a longer TTL, a heartbeat and a running command's renewals leave that later deadline in place", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await rig.daemon.dispatch(
      "lease.renew",
      { leaseId: hex(1), ttlMs: 900_000 },
      sessionFor(principals.one),
    );
    const later = await deadlineOf(rig, 1);
    expect(later).toBe(rig.clock.now() + 900_000);
    await advance(rig, 5_000);

    await heartbeat(rig, 1, { ttlMs: 120_000 });

    expect(await deadlineOf(rig, 1)).toBe(later);
    const running = await runningCommand(rig, 1);
    await advance(rig, 130_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(later);
    rig.fake.releaseCommand();
    await running.promise;
    await expect.poll(() => running.done()).toBe(true);
    expect(await deadlineOf(rig, 1)).toBe(later);
  });

  it("a heartbeat the agent-device daemon cannot answer returns that error and leaves the simlock lease's deadline where it was", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    rig.fake.failNextHeartbeat({ code: "COMMAND_FAILED", message: "daemon is busy" });

    const failed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon is busy",
    });
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(unreachable.error).toBeDefined();
    expect(unreachable.result).toBeUndefined();
    expect(await deadlineOf(rig, 1)).toBe(before);

    rig.fake.setUnreachable(false);
    await heartbeat(rig, 1, { ttlMs: 60_000 });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("with no cap set, a heartbeat whose `ttlMs` is above `lease.maxTtlMs` answers `COMMAND_FAILED` with simlock's `BAD_REQUEST` message and leaves the deadline where it was, and a following heartbeat with a valid `ttlMs` renews the lease", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);
    const message = await renewMessage(rig, hex(1), maxTtlMs + 1);

    const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs: maxTtlMs + 1 }));

    expect(refused.error).toMatchObject({ data: { code: "COMMAND_FAILED" }, message });
    expect(await deadlineOf(rig, 1)).toBe(before);

    const renewed = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 120_000 }));

    expect(renewed.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 120_000);
    expect((await leases(rig))[0]?.ttlMs).toBe(120_000);
  });

  it("a heartbeat for a lease the agent released through the front answers `LEASE_NOT_FOUND`, and a following allocate gets a new lease", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await release(rig, 1);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectLeaseGone(answer, "LEASE_NOT_FOUND");
    expect(await listed(rig)).toEqual([]);

    await granted(rig, 2);

    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("one TTL after the agent's release, a heartbeat for that lease answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    await release(rig, 1);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
    await advance(rig, 61_000, 5_000);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
  });

  it.each([
    [
      "`simlock release --all`",
      5_000,
      async (rig: Rig) => {
        await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      },
    ],
    [
      "expiry",
      5_000,
      async (rig: Rig) => {
        await advance(rig, 6_000);
      },
    ],
    [
      "the device is lost",
      600_000,
      async (rig: Rig) => {
        rig.driver.setManagedReality({ devices: [], processes: [] });
        await advance(rig, 120_000, 10_000);
      },
    ],
  ])(
    "after %s, a heartbeat for the lease answers `LEASE_ENDED_BY_HOST` with the message and reason, and makes no new simlock lease",
    async (_cause, ttl, end) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: ttl });
      await end(rig);
      await expect.poll(() => listed(rig)).toEqual([]);

      const answer = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 5_000 }));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it.each(["LEASE_NOT_FOUND", "LEASE_EXPIRED", "LEASE_REVOKED"] as const)(
    "a heartbeat the agent-device daemon answers `%s`, for a lease simlock holds and the agent did not release, releases the simlock lease and answers `LEASE_ENDED_BY_HOST`",
    async (reason) => {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      rig.fake.loseLease(hex(1), reason);
      expect(await listed(rig)).toEqual([hex(1)]);

      const answer = await envelopeOf(await heartbeat(rig, 1));

      expectEndedBySimlock(answer);
      expect(await listed(rig)).toEqual([]);
    },
  );

  it("a heartbeat naming a lease ID the front map lacks, which simlock holds for this token's principal: when agent-device answers a lease-gone reason, the simlock lease is released; when agent-device still holds the lease, it is released with the heartbeat's scope first, then the simlock lease; when agent-device is unreachable, neither lease is touched; each answers as in the table", async () => {
    const first = await setUp();
    await granted(first, 1);
    await granted(first, 2);
    await granted(first, 3);
    const rig: Rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1), hex(2), hex(3)]);

    rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([hex(2), hex(3)]);

    let heldAtDaemonRelease: readonly string[] = [];
    rig.fake.onRelease = async () => {
      heldAtDaemonRelease = await listed(rig);
    };
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heldAtDaemonRelease).toEqual([hex(2), hex(3)]);
    expect(rig.fake.rpcRequests("agent_device.lease.release")[0]?.params).toMatchObject(scope);
    expect(rig.fake.leases.has(hex(2))).toBe(false);
    expect(await listed(rig)).toEqual([hex(3)]);

    const before = await deadlineOf(rig, 3);
    await advance(rig, 10_000);
    rig.fake.setUnreachable(true);
    const unreachable = await envelopeOf(await heartbeat(rig, 3));
    rig.fake.setUnreachable(false);

    expect(unreachable.error).toBeDefined();
    expect(unreachable.error?.data?.code).not.toBe("UNAUTHORIZED");
    expect(await listed(rig)).toEqual([hex(3)]);
    expect(await deadlineOf(rig, 3)).toBe(before);
    expect(rig.fake.leases.has(hex(3))).toBe(true);
  });

  it("a heartbeat from a second token naming the first token's lease ID answers `LEASE_ENDED_BY_HOST`, and the first token's lease is neither released nor renewed", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 60_000 });
    const before = await deadlineOf(rig, 1);
    await advance(rig, 10_000);

    const answer = await envelopeOf(
      await heartbeat(rig, 1, { ttlMs: 60_000 }, { token: secrets.two }),
    );

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBe(before);
    expect(rig.fake.leases.has(hex(1))).toBe(true);

    const own = await envelopeOf(await heartbeat(rig, 1, { ttlMs: 60_000 }));

    expect(own.result).toMatchObject({ ok: true });
    expect(await deadlineOf(rig, 1)).toBe(rig.clock.now() + 60_000);
  });

  it("a heartbeat naming a lease ID the front map lacks, when the agent-device daemon fails to release its lease, answers that error and leaves the simlock lease in place", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    rig.fake.failNextRelease({ code: "COMMAND_FAILED", message: "daemon cannot release" });

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "daemon cannot release",
    });
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("a heartbeat for a lease the agent-device daemon lost, when simlock cannot release its lease, answers `COMMAND_FAILED` with simlock's message and marks nothing, and the next heartbeat releases it and answers `LEASE_ENDED_BY_HOST`", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.loseLease(hex(1), "LEASE_EXPIRED");
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const failed = await envelopeOf(await heartbeat(rig, 1));

    expect(failed.error).toMatchObject({
      data: { code: "COMMAND_FAILED" },
      message: "simlock could not do that",
    });
    expect(await listed(rig)).toEqual([hex(1)]);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([]);
  });

  it.each([0, -5, "soon", true])(
    "a heartbeat with a `ttlMs` of %j is refused with `ttlMs must be a positive number of milliseconds`, and neither daemon is reached",
    async (ttlMs) => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      const before = await deadlineOf(rig, 1);
      const received = heartbeatsReceived(rig);
      await advance(rig, 10_000);

      const refused = await envelopeOf(await heartbeat(rig, 1, { ttlMs }));

      expect(refused.error).toMatchObject(
        refusal("refused: ttlMs must be a positive number of milliseconds"),
      );
      expect(heartbeatsReceived(rig)).toBe(received);
      expect(await deadlineOf(rig, 1)).toBe(before);
    },
  );

  it("after a heartbeat answered `LEASE_ENDED_BY_HOST` because simlock ended the lease, the next heartbeat answers it again and the agent-device daemon receives nothing for it", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const received = rig.fake.requests.length;

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("a lease released through the front while a command runs stays ended by the agent: a renewal that fires between the simlock release and the end of the agent's release, and the command's final renewal, mark nothing, and the next heartbeat still answers `LEASE_NOT_FOUND`", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    tap.afterNext("lease.release", async () => {
      await advance(rig, 12_000, 4_000);
    });

    rig.fake.answerReleaseWhileCommandsRun();

    const released = await envelopeOf(await release(rig, 1));
    rig.fake.releaseCommand();
    await running.promise;

    expect(released.result).toMatchObject({ ok: true, released: true });
    expect(await listed(rig)).toEqual([]);
    expectLeaseGone(await envelopeOf(await heartbeat(rig, 1)), "LEASE_NOT_FOUND");
  });

  it("after `simlock release --all`, the agent's release answers success, a heartbeat for the old ID then answers `LEASE_ENDED_BY_HOST` (ended by simlock, not `LEASE_NOT_FOUND`), and the next allocate gets a new lease; an entry found unlisted by another allocate's check answers its next heartbeat `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const released = await envelopeOf(await release(rig, 1));

    expect(released.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);

    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 125_000, 25_000);
    await granted(rig, 3);
    const received = heartbeatsReceived(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 2)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("after `simlock release --all` and the agent's release, a heartbeat answers `LEASE_ENDED_BY_HOST` without reaching the agent-device daemon, and a running command's renewals stop", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const received = rig.fake.requests.length;
    const tap = tapDispatch(rig);

    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    await advance(rig, 120_000, 10_000);

    expect(rig.fake.requests).toHaveLength(received);
    rig.fake.releaseCommand();
    expect(tap.operations).not.toContain("lease.list");
    expect(tap.operations).not.toContain("lease.renew");
  });

  it("a release for a lease simlock ended answers the agent-device daemon's reply as a success, and the agent-device lease is released", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    const tap = tapDispatch(rig);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: false });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(tap.operations).not.toContain("lease.release");
  });

  it("while a command for the lease runs longer than its TTL, the simlock lease is renewed every TTL/3 and does not expire", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    const tap = tapDispatch(rig);
    const deadlines: (number | undefined)[] = [];

    for (let tick = 0; tick < 9; tick += 1) {
      await advance(rig, 10_000, 5_000);
      deadlines.push(await deadlineOf(rig, 1));
    }

    expect(deadlines.every((deadline) => deadline !== undefined)).toBe(true);
    expect(deadlines.at(-1)).toBeGreaterThan(rig.clock.now());
    expect(new Set(deadlines).size).toBeGreaterThan(5);
    const checks = tap.operations.filter((name) => name === "lease.list").length;
    expect(checks).toBeGreaterThanOrEqual(8);
    expect(checks).toBeLessThanOrEqual(9);
  });

  it("a command that runs on past `lease.maxTtlMs` stops counting as running: its renewals stop, and the lease is no longer kept", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1);

    await advance(rig, maxTtlMs + 400_000, 100_000);
    const calls = frontCalls(tap).length;
    await advance(rig, 1_000_000, 100_000);

    expect(calls).toBeGreaterThan(0);
    expect(frontCalls(tap)).toHaveLength(calls);
    expect(await listed(rig)).toEqual([]);
  }, 60_000);

  it("when the command ends, the lease is renewed once more, and its deadline does not move again over the next TTL", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const running = await runningCommand(rig, 1);
    await advance(rig, 25_000, 5_000);
    rig.fake.releaseCommand();
    await running.promise;

    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a command agent-device answers with a 5xx reaches the CLI unchanged", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.failNextCommandWithStatus(500, "snapshot runner crashed");

    const response = await command(rig, "snapshot", 1);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot runner crashed");
  });

  it("a command that fails, and one whose CLI hangs up, stop the renewals the same way", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    rig.fake.failNextCommand({ code: "COMMAND_FAILED", message: "the command failed" });
    const failing = await runningCommand(rig, 1);
    await advance(rig, 15_000, 5_000);
    rig.fake.releaseCommand();
    const failure = await envelopeOf(await failing.promise);
    expect(failure.error).toMatchObject({ message: "the command failed" });
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const afterFailure = await deadlineOf(rig, 1);

    const hangUp = new AbortController();
    const hanging = await runningCommand(rig, 2, { signal: hangUp.signal });
    await advance(rig, 15_000, 5_000);
    hangUp.abort();
    await hanging.promise.catch(() => undefined);
    await expect.poll(() => deadlineOf(rig, 2)).toBe(rig.clock.now() + 30_000);
    const afterHangUp = await deadlineOf(rig, 2);

    await advance(rig, 14_000, 2_000);
    expect(await deadlineOf(rig, 1)).toBe(afterFailure);
    expect(await deadlineOf(rig, 2)).toBe(afterHangUp);
  });

  it("with two overlapping commands on one lease, renewals go on until the second one ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const firstHangUp = new AbortController();
    await runningCommand(rig, 1, { signal: firstHangUp.signal });
    const second = await runningCommand(rig, 1);
    await advance(rig, 20_000, 5_000);
    firstHangUp.abort();

    await advance(rig, 40_000, 5_000);

    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
    rig.fake.releaseCommand();
    await second.promise;
    await expect.poll(() => deadlineOf(rig, 1)).toBe(rig.clock.now() + 30_000);
    const final = await deadlineOf(rig, 1);
    await advance(rig, 29_000, 5_000);
    expect(await deadlineOf(rig, 1)).toBe(final);
  });

  it("a renewal that fails because simlock ended the lease mid-command stops the renewals, and the command's reply still reaches the CLI; a renewal refused for another reason is tried again at the next tick", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    const running = await runningCommand(rig, 1);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await advance(rig, 15_000, 5_000);
    const calls = frontCalls(tap).length;

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toHaveLength(calls);
    rig.fake.releaseCommand();
    const reply = await envelopeOf(await running.promise);
    expect(reply.result).toMatchObject({ command: "snapshot", ok: true });
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));

    await granted(rig, 2, { ttlMs: 30_000 });
    const started = await deadlineOf(rig, 2);
    await runningCommand(rig, 2);
    tap.rejectNext("lease.renew");
    await advance(rig, 11_000, 1_000);
    expect(await deadlineOf(rig, 2)).toBe(started);

    await advance(rig, 10_000, 1_000);

    expect(await deadlineOf(rig, 2)).toBeGreaterThan(started as number);
  });

  it('an agent release whose `lease.release` simlock refuses with another error clears "release in progress": the simlock lease stays, and a later renewal that finds it gone marks it ended by simlock', async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.release");

    const refused = await envelopeOf(await release(rig, 1));

    expect(refused.result).toMatchObject({ ok: true });
    expect(await listed(rig)).toEqual([hex(1)]);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    const received = heartbeatsReceived(rig);
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(heartbeatsReceived(rig)).toBe(received);
  });

  it("a heartbeat lowering the TTL from 300 s to 5 s while a command runs re-arms the renewals, and the lease does not expire before the command ends", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 300_000 });
    await runningCommand(rig, 1);
    await advance(rig, 1_000);

    await heartbeat(rig, 1, { ttlMs: 5_000 });

    await advance(rig, 360_000, 2_000);
    expect(await listed(rig)).toEqual([hex(1)]);
    expect(await deadlineOf(rig, 1)).toBeGreaterThan(rig.clock.now());
  }, 60_000);

  it("a command naming a lease ID the front map does not hold for its token, or the lease of an ended entry, starts no renewals", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await granted(rig, 2, { ttlMs: 30_000 });
    await release(rig, 2);
    const tap = tapDispatch(rig);
    await runningCommand(rig, 1, { token: secrets.two });
    await runningCommand(rig, 2);

    await advance(rig, 40_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release through the front while a command runs stops that lease's renewals", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 5_000, 5_000);
    rig.fake.answerReleaseWhileCommandsRun();
    await release(rig, 1);
    const tap = tapDispatch(rig);

    await advance(rig, 60_000, 5_000);

    expect(frontCalls(tap)).toEqual([]);
    rig.fake.releaseCommand();
  });

  it("a lease whose CLI stops sending heartbeats expires one TTL after its last heartbeat, and its device can be leased again", async () => {
    const rig = await setUp({ maxRunning: 1 });
    await granted(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 10_000, 5_000);
    await heartbeat(rig, 1, { ttlMs: 30_000 });
    await advance(rig, 29_000, 5_000);
    expect(await listed(rig)).toEqual([hex(1)]);

    await advance(rig, 3_000, 1_000);

    expect(await listed(rig)).toEqual([]);
    await granted(rig, 2);
    expect(await listed(rig)).toEqual([hex(2)]);
  });

  it("after the agent-device daemon restarts, the next heartbeat answers `LEASE_ENDED_BY_HOST` and releases the simlock lease", async () => {
    const rig: Rig = await setUp();
    await granted(rig, 1);
    rig.fake.restart();

    const answer = await envelopeOf(await heartbeat(rig, 1));

    expectEndedBySimlock(answer);
    expect(await listed(rig)).toEqual([]);
  });

  it("on a worker, after a simlock restart, a command for the old lease is not adopted and the next heartbeat answers `LEASE_ENDED_BY_HOST`, as today", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await runCommand(rig, "snapshot", 1));
    // why: a worker has no map entry for the old lease and adopts nothing, so the command is forwarded as before and the heartbeat still ends the lease.
    expect(answer.error).toBeUndefined();
    expectEndedBySimlock(await envelopeOf(await heartbeat(rig, 1)));
    expect(await listed(rig)).toEqual([]);
  });

  it("after the same restart (same `FakeDriver`, lease still listed), a release for a lease made before the restart answers the agent-device daemon's reply as a success and releases that simlock lease", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig = await first.restart();
    expect(await listed(rig)).toEqual([hex(1)]);

    const answer = await envelopeOf(await release(rig, 1));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([]);
  });

  it("a release with no map entry from a second token, naming the first token's lease ID, answers the agent-device daemon's reply and leaves the first token's simlock lease in place", async () => {
    const first = await setUp();
    await granted(first, 1);
    const rig: Rig = await first.restart();
    rig.fake.letAnyTenantRelease();

    const answer = await envelopeOf(await release(rig, 1, { token: secrets.two }));

    expect(answer.result).toMatchObject({ ok: true, released: true });
    expect(rig.fake.leases.has(hex(1))).toBe(false);
    expect(await listed(rig)).toEqual([hex(1)]);
  });

  it("stopping the daemon while a command runs renews nothing once the stop began: the lease's deadline, read after a restart on the same data directory and the same `FakeDriver` (the lease still listed), is the one it had before the stop", async () => {
    const rig = await setUp();
    await granted(rig, 1, { ttlMs: 30_000 });
    await runningCommand(rig, 1);
    await advance(rig, 12_000, 4_000);
    const before = await deadlineOf(rig, 1);
    const tap = tapDispatch(rig);

    const stopping = rig.daemon.stop("test");
    await advance(rig, 3_000, 1_000).catch(() => undefined);
    await stopping;
    expect(frontCalls(tap)).toEqual([]);
    const restarted = await rig.restart();

    expect(await listed(restarted)).toEqual([hex(1)]);
    expect(await deadlineOf(restarted, 1)).toBe(before);
  });

  it("`config.get` returns `capabilities.agent-device.leaseTtlCapMs` when it is set, and no `agentDevice` key", async () => {
    const rig = await setUp({ leaseTtlCapMs: 10_000 });

    const config = (await rig.daemon.dispatch("config.get", {}, adminSession)) as {
      readonly capabilities: Record<string, { readonly leaseTtlCapMs?: number }>;
    };

    expect(config.capabilities["agent-device"]?.leaseTtlCapMs).toBe(10_000);
    expect(config).not.toHaveProperty("agentDevice");
  });
});

describe("FakeAgentDevice as agent-device behaves", () => {
  const udid = "00000000-0000-0000-0000-000000000001";

  function call(
    fake: FakeAgentDevice,
    method: string,
    params: Record<string, unknown>,
    tenant: string | null = "tok_a",
  ): Promise<Response> {
    return fake.fetch(
      new Request(`${fake.baseUrl}/rpc`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        headers: {
          authorization: `Bearer ${fake.token}`,
          "content-type": "application/json",
          ...(tenant === null ? {} : { "x-agent-device-tenant": tenant }),
        },
        method: "POST",
      }),
    );
  }

  const allocation = (n: number, extra: Record<string, unknown> = {}) => ({
    ...scope,
    deviceKey: "key-1",
    leaseId: hex(n),
    platform: "ios",
    udid,
    ...extra,
  });

  it("refuses a release missing the tenant, the run ID, the lease provider, the client ID or the device key with LEASE_SCOPE_REQUIRED, and one with a different client ID with LEASE_SCOPE_MISMATCH, as agent-device does", async () => {
    const fake = new FakeAgentDevice();
    await call(fake, "agent_device.lease.allocate", allocation(1));
    const full = { ...allocation(1), tenantId: "tok_a" };
    delete (full as Record<string, unknown>)["platform"];
    delete (full as Record<string, unknown>)["udid"];

    const accepted = (await (
      await call(fake, "agent_device.lease.release", full)
    ).json()) as Envelope;
    expect(accepted.result).toMatchObject({ released: true });
    await call(fake, "agent_device.lease.allocate", allocation(1));

    const reasonOf = async (params: Record<string, unknown>, tenant: string | null = "tok_a") => {
      const answer = (await (
        await call(fake, "agent_device.lease.release", params, tenant)
      ).json()) as {
        readonly error?: { readonly data?: { readonly details?: { readonly reason?: string } } };
      };
      return answer.error?.data?.details?.reason;
    };
    const { tenantId: _tenantId, ...untenanted } = full;
    expect(await reasonOf(untenanted, null)).toBe("LEASE_SCOPE_REQUIRED");
    for (const missing of ["runId", "leaseProvider", "clientId", "deviceKey"]) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[missing];
      expect(await reasonOf(partial), missing).toBe("LEASE_SCOPE_REQUIRED");
    }
    expect(await reasonOf({ ...full, clientId: "client-2" })).toBe("LEASE_SCOPE_MISMATCH");
  });

  it("answers an allocate for a device a live lease holds with DEVICE_IN_USE, and a release of a lease with a held command only after the command is let go", async () => {
    const fake = new FakeAgentDevice();
    const codeOf = async (response: Response) =>
      ((await response.json()) as Envelope).error?.data?.code;
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(1))),
    ).toBeUndefined();
    expect(
      await codeOf(
        await call(fake, "agent_device.lease.allocate", allocation(2, { udid: "other-device" })),
      ),
    ).toBeUndefined();

    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );

    fake.holdCommand();
    const running = track(
      call(fake, "agent_device.command", { command: "snapshot", meta: { leaseId: hex(1) } }),
    );
    await sleep(20);
    const full = { ...allocation(1), tenantId: "tok_a" };
    const releasing = track(call(fake, "agent_device.lease.release", full));
    await sleep(50);

    expect(releasing.done()).toBe(false);
    expect(await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3)))).toBe(
      "DEVICE_IN_USE",
    );
    fake.releaseCommand();
    await running.promise;
    expect(((await (await releasing.promise).json()) as Envelope).result).toMatchObject({
      released: true,
    });
    expect(
      await codeOf(await call(fake, "agent_device.lease.allocate", allocation(3))),
    ).toBeUndefined();
  });
});

const downloadLimit = 2_147_483_648;
const tooLargeReply = (size: number) => ({
  code: "INVALID_ARGS",
  error: `the download is ${String(size)} bytes; simlock carries downloads up to 2 GB (2147483648 bytes)`,
  ok: false,
  reason: "REFUSED_BY_SIMLOCK",
  retriable: false,
});

describe(
  "the agent-device front, through the whole worker daemon: downloads over 2 GiB",
  {
    timeout: 120_000,
  },
  () => {
    it("an artifact download whose `content-length` is 2147483649 is answered 413 with simlock's reply; the fake produced 0 bytes and its body was cancelled", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "size", size: downloadLimit + 1 });

      const response = await send(rig, "/artifacts/a1");

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(tooLargeReply(downloadLimit + 1));
      expect(rig.fake.artifactBytesProduced).toBe(0);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
    });

    it("an agent that cancels a 1 GiB download halfway cancels the fake's body", async () => {
      const rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "none", size: 1_073_741_824 });

      const response = await send(rig, "/artifacts/a1");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      while (bytes < 536_870_912) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
      }
      await reader.cancel();

      expect(bytes).toBeGreaterThanOrEqual(536_870_912);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
      expect(rig.fake.artifactBytesProduced).toBeLessThan(1_073_741_824);
    });
  },
);
