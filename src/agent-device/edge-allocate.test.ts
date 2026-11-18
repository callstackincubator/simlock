import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { idOf } from "./test-edge.js";
import {
  principals,
  defaultTtlMs,
  maxTtlMs,
  scope,
  type Rig,
  taggedAndroidDriver,
  setUp,
  rpc,
  envelopeOf,
  hex,
  allocateParams,
  allocate,
  granted,
  leases,
  requestedSpecs,
  receivedAllocate,
  allocatesReceived,
  simlockMessage,
  refusal,
  sessionFor,
} from "./test-support.js";
import { waiting } from "./test-edge-front.js";

describe("the agent-device front, through the whole worker daemon", () => {
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

  it("an allocate's `runId` `123-1` or `simlock-local` is the simlock lease's run id, one outside the rule is forwarded to agent-device and the lease has none, and `lease.release-run` then ends the lease and releases agent-device's", async () => {
    const rig = await setUp();

    await granted(rig, 1, { runId: "123-1" });
    await granted(rig, 2, { runId: "simlock-local" });
    await allocate(rig, 3, { runId: "run 1" });

    const runs = new Map((await leases(rig)).map((lease) => [lease.id, lease.runId]));
    expect([runs.get(hex(1)), runs.get(hex(2))]).toEqual(["123-1", "simlock-local"]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ platform: "ios" }]);
    expect(receivedAllocate(rig, 3)["runId"]).toBe("run 1");

    const ended = await rig.daemon.dispatch(
      "lease.release-run",
      { runId: "123-1" },
      sessionFor(principals.one),
    );

    expect(ended.leaseIds).toEqual([hex(1)]);
    expect((await leases(rig)).map((lease) => lease.id).sort()).toEqual([hex(2)]);
    await expect
      .poll(() =>
        rig.fake
          .rpcRequests("agent_device.lease.release")
          .map((request) => request.params?.["leaseId"]),
      )
      .toContain(hex(1));
  });
});
