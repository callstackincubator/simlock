import { describe, expect, it } from "vitest";
import { tokenIdentity } from "../auth/testing.js";
import { WorkerView } from "../modules/index.js";
import { fakeGatewayContext } from "../modules/testing.js";
import { agentDeviceModule } from "./definition.js";
import {
  phoneSerial,
  setUpWithPhone,
  listed,
  tapDispatch,
  simlockPicks,
  idOf,
  batch,
  release,
} from "./test-edge.js";
import {
  secrets,
  adminSession,
  type Rig,
  setUp,
  envelopeOf,
  hex,
  granted,
  leases,
  refusal,
  runCommand,
  forwarded,
  refused,
} from "./test-support.js";
import { bothDrivers, commandsReceived, flagsOf } from "./test-edge-request-rules.js";

// why: the decomposed front's gateway adoption is exercised at its HTTP mount with a fake fleet view.
describe("the agent-device front's request rules", () => {
  describe("the devices filter", () => {
    const three = [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }];
    const listedIds = async (response: Response): Promise<unknown> => {
      const answer = await envelopeOf(response);
      const data = answer.result?.["data"] as { devices: { id: string }[] } | undefined;
      expect(Array.isArray(data?.devices), "expected a devices list in result.data").toBe(true);
      return data?.devices.map((device) => device.id);
    };

    it("`devices` before open answers an empty list while agent-device lists three devices; after open it answers only the leased device, without agent B's", async () => {
      const rig = await setUp();
      await granted(rig, 2, {}, { token: secrets.two });
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }]);
      const before = commandsReceived(rig).length;

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([]);
      expect(commandsReceived(rig)).toHaveLength(before);
      await granted(rig, 1);
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }, { id: idOf(rig, 1) }]);

      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);
    });

    it("`devices` for an agent holding two devices answers both, and after simlock released one of the two leases (no heartbeat sent since), only the other", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      await granted(rig, 2, { ttlMs: 600_000 });
      rig.fake.listDevices([...three, { id: idOf(rig, 1) }, { id: idOf(rig, 2) }]);

      expect(
        ((await listedIds(await runCommand(rig, "devices", undefined))) as string[]).sort(),
      ).toEqual([idOf(rig, 1), idOf(rig, 2)].sort());
      await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
      await expect.poll(() => listed(rig)).toEqual([hex(2)]);

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([idOf(rig, 2)]);
    });

    it("a `devices` error answer from agent-device passes unchanged; a success with no list at `data.devices`, a body over 1 MiB, a non-JSON body and a list holding a non-object each answer `could not read the device list from the worker holding lease <id>`", async () => {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);

      const failure = {
        error: {
          code: -32000,
          data: { code: "COMMAND_FAILED", message: "inventory down" },
          message: "inventory down",
        },
        id: 1,
        jsonrpc: "2.0",
      };
      rig.fake.answerDevicesWith(JSON.stringify(failure));
      expect(await envelopeOf(await runCommand(rig, "devices", 1))).toMatchObject({
        error: { message: "inventory down" },
      });
      const unusable = [
        JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            data: { devices: [{ id: idOf(rig, 1) }], pad: "x".repeat(1024 * 1024) },
            ok: true,
          },
        }),
        "not json",
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: { data: { devices: [{ id: idOf(rig, 1) }, "stray"] }, ok: true },
        }),
      ];
      for (const body of unusable) {
        rig.fake.answerDevicesWith(body);
        expect((await envelopeOf(await runCommand(rig, "devices", 1))).error).toMatchObject({
          data: {
            message: `could not read the device list from the worker holding lease ${hex(1)}`,
          },
        });
      }
    });

    // why: the agent-device CLI sets `meta.requestProgress: "command"` on every command it sends without `--json`.
    it("`devices` sent as the agent-device CLI sends it, with `meta.requestProgress`, answers an empty list before open and only the leased device after, without agent B's, and reaches agent-device without `requestProgress`, while another command keeps it", async () => {
      const rig = await setUp();
      await granted(rig, 2, {}, { token: secrets.two });
      const asTheCli = { meta: { requestProgress: "command" } };
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }]);

      expect(await listedIds(await runCommand(rig, "devices", undefined, asTheCli))).toEqual([]);
      await granted(rig, 1);
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }, { id: idOf(rig, 1) }]);
      const before = commandsReceived(rig).length;

      expect(await listedIds(await runCommand(rig, "devices", 1, asTheCli))).toEqual([
        idOf(rig, 1),
      ]);
      const sent = commandsReceived(rig)
        .slice(before)
        .map(
          (r) => (r.params?.["meta"] as Record<string, unknown> | undefined)?.["requestProgress"],
        );
      expect(sent).toEqual([undefined]);

      const beforeSnapshot = commandsReceived(rig).length;
      await runCommand(rig, "snapshot", 1, asTheCli);
      const kept = commandsReceived(rig)
        .slice(beforeSnapshot)
        .map(
          (r) => (r.params?.["meta"] as Record<string, unknown> | undefined)?.["requestProgress"],
        );
      expect(kept).toEqual(["command"]);
    });
  });

  describe("the token's leased devices", () => {
    it("a `test` shard fill whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again` and reaches nothing", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const tap = tapDispatch(rig);
      const sharded = () => runCommand(rig, "test", 1, { flags: { shardAll: 2 } });
      await forwarded(rig, sharded);
      tap.rejectNext("lease.list");
      const before = rig.fake.requests.length;

      const answer = await envelopeOf(await sharded());

      expect(answer.error).toMatchObject({
        data: {
          code: "COMMAND_FAILED",
          message: "could not check your leases; try again",
          details: { reason: "SIMLOCK_FAILED" },
          retriable: true,
        },
      });
      expect(rig.fake.requests.length).toBe(before);
    });

    it("a `devices` whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again`, not an empty list", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      const tap = tapDispatch(rig);
      tap.rejectNext("lease.list");

      const answer = await envelopeOf(await runCommand(rig, "devices", 1));

      expect(answer.error).toMatchObject({
        data: { code: "COMMAND_FAILED", message: "could not check your leases; try again" },
      });
    });

    it("a batch whose `batchSteps` is not a list is refused with `refused: malformed batchSteps`", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      await refused(
        rig,
        () => runCommand(rig, "batch", undefined, { flags: { batchSteps: "snapshot" } }),
        "refused: malformed batchSteps",
      );
    });

    it("a `flags`, `input` or `runtime` that is not an object, a batch step that is not an object or whose `command` is not a string, and a `meta.deviceKey` that is not a string are each refused with their `malformed` message", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: {} }));

      for (const key of ["flags", "input", "runtime"]) {
        await refused(
          rig,
          () => runCommand(rig, "snapshot", 1, { [key]: "text" }),
          `refused: malformed ${key}`,
        );
      }
      await refused(
        rig,
        () => batch(rig, 1, ["snapshot"] as unknown as Record<string, unknown>[]),
        "refused: malformed batchSteps",
      );
      await refused(rig, () => batch(rig, 1, [{ command: 5 }]), "refused: malformed command");
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: 5 } }),
        "refused: malformed deviceKey",
      );
    });
  });

  describe("rule 10, commands agent-device runs without a lease", () => {
    it("`capabilities` with no selector reaches agent-device with the leased device's id; from a token holding no device it is refused; `doctor` the same", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      for (const name of ["capabilities", "doctor"]) {
        const params = await forwarded(rig, () => runCommand(rig, name, 1));
        expect(flagsOf(params)["udid"]).toBe(idOf(rig, 1));
        await refused(
          rig,
          () => runCommand(rig, name, undefined, {}, { token: secrets.two }),
          "refused: name the device with --udid <id>; run devices to see yours",
        );
      }
    });

    it("`capabilities` naming no lease is filled with the token's only device; with two devices it is refused unless `platform` leaves one, and then it gets that device's `serial` on Android", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1, {}, { token: secrets.two });
      const only = await forwarded(rig, () =>
        runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
      );
      expect(flagsOf(only)["udid"]).toBe(idOf(rig, 1));

      await granted(rig, 2, { device: "Pixel 8", platform: "android" }, { token: secrets.two });
      await refused(
        rig,
        () => runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
        "refused: name the device with --udid <id>; run devices to see yours",
      );
      const android = await forwarded(rig, () =>
        runCommand(
          rig,
          "capabilities",
          undefined,
          { flags: { platform: "android" } },
          { token: secrets.two },
        ),
      );
      expect(flagsOf(android)["serial"]).toBe(idOf(rig, 2));
      expect(flagsOf(android)).not.toHaveProperty("udid");
    });
  });

  type BootScenario = {
    platform: string;
    model: string;
    kind: string;
    target: string;
    omitTarget?: boolean;
    flags: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    physical?: boolean;
  };
  type AdoptedScenario = {
    platform: "ios" | "android";
    model: string;
    deviceClass: string;
    physical: boolean;
    kind: string;
    target: string;
    address: string;
  };
  function bootFlagsFor(scenario: BootScenario, address: string): Record<string, unknown> {
    if ("udid" in scenario.flags) return { udid: address };
    if ("device" in scenario.flags) return { device: `simlock-${address}` };
    return scenario.flags;
  }
  function allocateFieldsFor(scenario: BootScenario): Record<string, unknown> {
    return {
      platform: scenario.platform,
      ...("omitTarget" in scenario ? {} : { target: scenario.target }),
      ...(scenario.physical ? { physical: true } : {}),
    };
  }
  async function bootsOnItsLease(scenario: BootScenario): Promise<void> {
    const rig: Rig = scenario.physical
      ? await setUpWithPhone()
      : await setUp({ drivers: bothDrivers });
    rig.fake.nameDeviceInNextReply("none");
    await granted(rig, 1, allocateFieldsFor(scenario));
    const address = scenario.physical ? phoneSerial : idOf(rig, 1);
    const answer = await envelopeOf(
      await runCommand(rig, "boot", 1, {
        flags: bootFlagsFor(scenario, address),
        ...(scenario.runtime && { runtime: scenario.runtime }),
      }),
    );
    expect(answer.result).toMatchObject({
      ok: true,
      data: {
        platform: scenario.platform,
        target: scenario.target,
        device: "device" in scenario.flags ? `simlock-${address}` : scenario.model,
        id: address,
        kind: scenario.kind,
        booted: true,
      },
    });
    expect(
      commandsReceived(rig).filter((request) => request.params?.["command"] === "boot"),
    ).toEqual([]);
  }
  async function bootsOnAdoptedLease(scenario: AdoptedScenario): Promise<void> {
    const leaseId = hex(1);
    const entry = {
      gatewayLeaseId: leaseId,
      workerLeaseId: leaseId,
      workerId: "w1",
      ownerId: "tok_one",
      requesterId: leaseId,
    };
    const view = {
      id: "w1",
      label: "w1",
      connection: "connected",
      drained: false,
      catalogReadAt: 1_000,
      lease: { maxTtlMs: 120_000 },
      catalog: [
        { platform: scenario.platform, modelClasses: { [scenario.model]: scenario.deviceClass } },
      ],
      leases: [{ id: leaseId, deviceId: "record", ttlMs: 120_000, ttlDeadline: 121_000 }],
    } as unknown as WorkerView;
    const { ctx, relayed } = await fakeGatewayContext(
      "agent-device",
      agentDeviceModule.config.defaults,
      { serving: [view] },
    );
    const loaded = await agentDeviceModule.loadGateway!();
    const module = loaded.createGateway({
      ...ctx,
      leases: { ...ctx.leases, all: () => [entry], resolve: () => entry },
      grantedDevices: () => [
        {
          id: "record",
          workerId: "w1",
          driverDeviceId: scenario.address,
          address: scenario.physical ? "not-the-phone-id" : scenario.address,
          physical: scenario.physical,
          spec: {
            platform: scenario.platform,
            model: scenario.model,
            physical: scenario.physical,
          },
        },
      ],
    } as never);
    const handle = module.mount!({
      dispatch: (() =>
        Promise.resolve({ leases: [{ id: leaseId, ttlDeadline: 121_000 }] })) as never,
    });
    const adopted = await envelopeOf(
      await handle(
        new Request("http://simlock.test/v1/agent-device/rpc", {
          method: "POST",
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "agent_device.command",
            params: { command: "boot", meta: { leaseId } },
          }),
        }),
        tokenIdentity("tok_one"),
      ),
    );
    expect(adopted.result).toMatchObject({
      ok: true,
      data: {
        platform: scenario.platform,
        target: scenario.target,
        device: scenario.model,
        id: scenario.address,
        kind: scenario.kind,
        booted: true,
      },
    });
    expect(relayed).toEqual([]);
  }
  it("A runner sends `boot` on its lease and simlock answers it; agent-device gets no `boot`", async () => {
    for (const scenario of [
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        omitTarget: true,
        flags: {},
      },
      { platform: "ios", model: "iPhone 16", kind: "simulator", target: "mobile", flags: {} },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { target: "tv" },
      },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: {},
        runtime: { udid: "another-device" },
      },
      { platform: "android", model: "Pixel 8", kind: "emulator", target: "mobile", flags: {} },
      { platform: "ios", model: "Apple TV 4K", kind: "simulator", target: "tv", flags: {} },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { udid: true },
      },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { device: true },
      },
      {
        platform: "android",
        model: "Pixel 8",
        kind: "device",
        target: "mobile",
        flags: {},
        physical: true,
      },
    ] satisfies BootScenario[]) {
      await bootsOnItsLease(scenario);
    }
    for (const scenario of [
      {
        platform: "ios",
        model: "Apple TV 4K",
        deviceClass: "tv",
        physical: false,
        kind: "simulator",
        target: "tv",
        address: "adopted-udid",
      },
      {
        platform: "ios",
        model: "iPhone",
        deviceClass: "phone",
        physical: true,
        kind: "device",
        target: "mobile",
        address: "iphone-id",
      },
      {
        platform: "android",
        model: "Pixel",
        deviceClass: "phone",
        physical: true,
        kind: "device",
        target: "mobile",
        address: "pixel-id",
      },
    ] satisfies AdoptedScenario[]) {
      await bootsOnAdoptedLease(scenario);
    }
  });
  it("A `boot` that names no lease, another token's lease, an ended lease or another device is refused", async () => {
    const rig = await setUp({ drivers: bothDrivers });
    await granted(rig, 1);
    await granted(rig, 2, {}, { token: secrets.two });
    expect((await envelopeOf(await runCommand(rig, "boot", 1))).result).toMatchObject({ ok: true });
    const tap = tapDispatch(rig);
    tap.rejectNext("lease.list");
    expect((await envelopeOf(await runCommand(rig, "boot", 1))).error?.data).toMatchObject({
      message: "could not check your leases; try again",
      retriable: true,
    });
    for (const [lease, fields, message] of [
      [undefined, {}, "refused: boot names no lease; open a device first"],
      [2, {}, simlockPicks],
      [1, { flags: { udid: idOf(rig, 2) } }, simlockPicks],
      [1, { flags: { platform: "android" } }, simlockPicks],
      [1, { input: { platform: "android" } }, simlockPicks],
      [1, { runtime: { platform: "android" } }, simlockPicks],
      [undefined, { flags: { udid: idOf(rig, 1) } }, simlockPicks],
    ] as const) {
      expect((await envelopeOf(await runCommand(rig, "boot", lease, fields))).error).toMatchObject(
        refusal(message),
      );
    }
    await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
    expect((await envelopeOf(await runCommand(rig, "boot", 1))).error).toMatchObject(
      refusal("lease ended by simlock; run disconnect, then open", "UNAUTHORIZED"),
    );
    await granted(rig, 3);
    await release(rig, 3);
    expect((await envelopeOf(await runCommand(rig, "boot", 3))).error).toMatchObject(
      refusal("refused: this lease has ended; open a device"),
    );
    for (const fields of [{}, { flags: { udid: true } }, { flags: { device: true } }]) {
      const expired = await setUp({ drivers: bothDrivers });
      await granted(expired, 4, { ttlMs: 5_000 });
      const address = idOf(expired, 4);
      const selector =
        "udid" in (fields.flags ?? {})
          ? { flags: { udid: address } }
          : "device" in (fields.flags ?? {})
            ? { flags: { device: `simlock-${address}` } }
            : {};
      expect((await envelopeOf(await runCommand(expired, "boot", 4))).result).toMatchObject({
        ok: true,
      });
      expired.clock.advance(5_001);
      await expect.poll(() => leases(expired)).toEqual([]);
      const before = commandsReceived(expired).length;
      expect(
        (await envelopeOf(await runCommand(expired, "boot", 4, selector))).error,
      ).toMatchObject(refusal("lease ended by simlock; run disconnect, then open", "UNAUTHORIZED"));
      expect(commandsReceived(expired)).toHaveLength(before);
    }
  });
});
