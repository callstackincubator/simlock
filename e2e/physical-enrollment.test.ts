import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION_RANGE } from "../src/contract/index.js";
import { NodeIpcTransport } from "../src/ports/index.js";
import { SimlockWire, WireCallError } from "../src/simlock-client/wire.js";
import type { FakeDriverRefusalReason } from "./fake-driver/types.js";
import {
  ALIAS,
  HttpDaemon,
  IPHONE,
  PIXEL,
  Row,
  UDID,
  add,
  bearer,
  httpDaemon,
  inspectCalls,
  leaseGrant,
  named,
  rows,
  startDaemon,
} from "./test-physical-enrollment.js";

const REFUSALS: readonly FakeDriverRefusalReason[] = [
  "not-connected",
  "network-only",
  "untrusted",
  "developer-mode-off",
  "os-too-old",
  "unsupported-kind",
  "locked",
  "unreadable",
  "virtual-device",
];

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly id?: string;
    readonly platform?: string;
    readonly reason?: string;
    readonly canonicalId?: string;
  };
}

async function postDevice(
  daemon: HttpDaemon,
  body: unknown,
): Promise<{ status: number; body: ErrorBody }> {
  const response = await fetch(`${daemon.base}/v1/devices`, {
    body: JSON.stringify(body),
    headers: await bearer(daemon.env, "operator"),
    method: "POST",
  });
  return { body: (await response.json()) as ErrorBody, status: response.status };
}

describe("simlock device add", () => {
  it("of a scripted device exits 0 and prints one line with its model, OS version, canonical ID and app count, and no again", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });

    const result = await env.cli(["device", "add", "--platform", "ios", UDID]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `Enrolled iPhone 15 Pro (iOS 18.4) as ${UDID}, 12 user apps recorded.\n`,
    );
  });

  it("lists the device ready and physical with its class, and records one device.enrolled with reenrolled false and the app count", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    await add(env, "ios", UDID);

    const status = await env.cli(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const devices = (status.json as { devices: Row[] }).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ class: "phone", physical: true, state: "ready" });

    const enrolled = await named(env, "device.enrolled");
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]?.payload).toMatchObject({
      appCount: 12,
      class: "phone",
      driverDeviceId: UDID,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      initiator: "operator",
      platform: "ios",
      reenrolled: false,
    });
  });

  it("with --json prints the registry ID, canonical ID, model, OS version, class, app count and reenrolled", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });

    const added = await add(env, "ios", UDID);

    expect(added).toEqual({
      appCount: 12,
      class: "phone",
      driverDeviceId: UDID,
      id: expect.stringMatching(/^dev_/),
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
      reenrolled: false,
    });
    expect((await rows(env)).map((row) => row.id)).toEqual([added.id]);
  });

  it("naming an enrolled device's alias keeps its registry ID, prints its line with again, emits device.enrolled with reenrolled true, and list --devices holds one non-deleted record with that canonical ID", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const first = await add(env, "ios", UDID);

    const again = await env.cli(["device", "add", "--platform", "ios", ALIAS]);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe(
      `Enrolled iPhone 15 Pro (iOS 18.4) as ${UDID} again, 12 user apps recorded.\n`,
    );
    const second = await add(env, "ios", ALIAS);
    expect(second).toMatchObject({ driverDeviceId: UDID, id: first.id, reenrolled: true });
    const enrolled = await named(env, "device.enrolled");
    expect(enrolled.map((entry) => (entry.payload as { reenrolled: boolean }).reenrolled)).toEqual([
      false,
      true,
      true,
    ]);
    const live = (await rows(env)).filter(
      (row) => row.driverDeviceId === UDID && row.state !== "deleted",
    );
    expect(live.map((row) => row.id)).toEqual([first.id]);
  });

  it.each(REFUSALS)(
    "of a device the driver refuses %s answers DEVICE_NOT_ENROLLABLE with that reason, the driver's message and the ID as typed, exits 12, and writes no record and no device.enrolled",
    async (reason) => {
      const daemon = await httpDaemon({
        ios: {
          physicalDevices: [
            { ids: ["REFUSED-1"], refusal: { message: `scripted ${reason} refusal`, reason } },
          ],
        },
      });

      const result = await daemon.env.cli(["device", "add", "--platform", "ios", "REFUSED-1"]);
      const http = await postDevice(daemon, { id: "REFUSED-1", platform: "ios" });

      expect(result.code, result.stderr).toBe(12);
      expect(result.error).toEqual({
        code: "DEVICE_NOT_ENROLLABLE",
        message: `scripted ${reason} refusal`,
      });
      expect(http.status).toBe(422);
      expect(http.body.error).toEqual({
        code: "DEVICE_NOT_ENROLLABLE",
        id: "REFUSED-1",
        message: `scripted ${reason} refusal`,
        platform: "ios",
        reason,
      });
      expect(await rows(daemon.env)).toEqual([]);
      expect(await named(daemon.env, "device.enrolled")).toEqual([]);
    },
  );

  it("by a client whose hello range ends at the previous protocol version is refused with PROTOCOL_VERSION_UNSUPPORTED, so it never sends device.add to a daemon that would answer UNKNOWN_REQUEST", async () => {
    const daemon = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });
    const previous = PROTOCOL_VERSION_RANGE.min - 1;
    const wire = new SimlockWire(await new NodeIpcTransport().connect(daemon.env.socketPath));

    try {
      const refused = await wire
        .call("hello", {
          clientVersion: "1.0.0",
          protocolRange: { max: previous, min: previous },
          protocolVersion: previous,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(refused).toBeInstanceOf(WireCallError);
      expect((refused as WireCallError).code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
      expect((refused as WireCallError).details).toMatchObject({
        client: { max: previous, min: previous },
        daemon: PROTOCOL_VERSION_RANGE,
      });
      expect(await rows(daemon.env)).toEqual([]);
    } finally {
      await wire.close();
    }
  });

  it("of an ID no scripted device lists answers DEVICE_NOT_ENROLLABLE not-connected", async () => {
    const daemon = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });

    const result = await daemon.env.cli(["device", "add", "--platform", "ios", "NOT-PLUGGED-IN"]);
    const http = await postDevice(daemon, { id: "NOT-PLUGGED-IN", platform: "ios" });

    expect(result.code, result.stderr).toBe(12);
    expect(result.error?.code).toBe("DEVICE_NOT_ENROLLABLE");
    expect(http.body.error).toMatchObject({
      code: "DEVICE_NOT_ENROLLABLE",
      id: "NOT-PLUGGED-IN",
      reason: "not-connected",
    });
    expect(await rows(daemon.env)).toEqual([]);
  });

  it("naming a Simlock simulator's driverDeviceId, or an emulator's driverDeviceId and, separately, its address, answers virtual-device and the driver log has no inspectPhysical call", async () => {
    const daemon = await httpDaemon({});
    const env = daemon.env;
    const simulator = await leaseGrant(env, "ios", "sim-agent");
    const emulator = await leaseGrant(env, "android", "emu-agent");
    await env.driverLog.clear();

    const refusals: { platform: string; id: string }[] = [
      { id: simulator.device.driverDeviceId, platform: "ios" },
      { id: emulator.device.driverDeviceId, platform: "android" },
      { id: emulator.device.address, platform: "android" },
    ];
    for (const { id, platform } of refusals) {
      const result = await env.cli(["device", "add", "--platform", platform, id]);
      expect(result.code, `${id}: ${result.stderr}`).toBe(12);
      expect(result.error?.code).toBe("DEVICE_NOT_ENROLLABLE");
      expect(result.error?.message).toContain("Simlock");
      const http = await postDevice(daemon, { id, platform });
      expect(http.status).toBe(422);
      expect(http.body.error).toMatchObject({
        code: "DEVICE_NOT_ENROLLABLE",
        id,
        reason: "virtual-device",
      });
    }
    expect(await inspectCalls(env)).toEqual([]);
  });

  it("of an ID enrolled as iOS, for --platform android, answers enrolled-on-other-platform with canonicalId set and leaves the iOS record as it was", async () => {
    const daemon = await httpDaemon({
      android: { physicalDevices: [{ ...PIXEL, ids: [UDID] }] },
      ios: { physicalDevices: [IPHONE] },
    });
    const enrolled = await add(daemon.env, "ios", UDID);

    const result = await daemon.env.cli(["device", "add", "--platform", "android", UDID]);
    const http = await postDevice(daemon, { id: UDID, platform: "android" });

    expect(result.code, result.stderr).toBe(12);
    expect(result.error?.code).toBe("DEVICE_NOT_ENROLLABLE");
    expect(http.status).toBe(422);
    expect(http.body.error).toMatchObject({
      canonicalId: UDID,
      code: "DEVICE_NOT_ENROLLABLE",
      id: UDID,
      platform: "android",
      reason: "enrolled-on-other-platform",
    });
    const records = await rows(daemon.env);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      driverDeviceId: UDID,
      id: enrolled.id,
      spec: { platform: "ios" },
      state: "ready",
    });
  });

  it("of a phone whose hardware serial another record holds answers enrolled-under-other-id with the message and the canonicalId that record holds, over the CLI and HTTP, and writes no second record", async () => {
    const network = "192.168.1.5:5555";
    const daemon = await httpDaemon({
      android: {
        physicalDevices: [PIXEL, { ...PIXEL, hardwareSerial: PIXEL.ids[0], ids: [network] }],
      },
    });
    const enrolled = await add(daemon.env, "android", PIXEL.ids[0] as string);
    const message = `this phone (hardware serial ${PIXEL.ids[0]}) is enrolled as ${PIXEL.ids[0]}; remove that record first`;

    const result = await daemon.env.cli(["device", "add", "--platform", "android", network]);
    const http = await postDevice(daemon, { id: network, platform: "android" });

    expect(result.code, result.stderr).toBe(12);
    expect(result.error).toEqual({ code: "DEVICE_NOT_ENROLLABLE", message });
    expect(http.status).toBe(422);
    expect(http.body.error).toEqual({
      canonicalId: PIXEL.ids[0],
      code: "DEVICE_NOT_ENROLLABLE",
      id: network,
      message,
      platform: "android",
      reason: "enrolled-under-other-id",
    });
    expect((await rows(daemon.env)).map((row) => row.id)).toEqual([enrolled.id]);
  });

  it("without --platform exits 2 with USAGE and the driver log has no inspectPhysical call", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    await env.driverLog.clear();

    const result = await env.cli(["device", "add", UDID]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.error?.code).toBe("USAGE");
    expect(result.error?.message).toContain("--platform");
    expect(await inspectCalls(env)).toEqual([]);
  });

  it("on a daemon with no Android driver answers NO_DRIVER for --platform android", async () => {
    const env = await startDaemon({ platforms: ["ios"] });

    const result = await env.cli(["device", "add", "--platform", "android", "R58M123ABC"]);

    expect(result.code, result.stderr).toBe(12);
    expect(result.error?.code).toBe("NO_DRIVER");
  });

  it("from an agent session answers FORBIDDEN, the driver log has no inspectPhysical call and the record is unchanged", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);
    await env.driverLog.clear();

    const added = await env.cli([
      "--token",
      "not-an-admin-credential",
      "device",
      "add",
      "--platform",
      "ios",
      ALIAS,
    ]);
    const removed = await env.cli(["--token", "not-an-admin-credential", "device", "remove", UDID]);

    for (const result of [added, removed]) {
      expect(result.code, result.stderr).toBe(1);
      expect(result.error?.code).toBe("FORBIDDEN");
    }
    expect(await inspectCalls(env)).toEqual([]);
    const records = await rows(env);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: enrolled.id, state: "ready" });
    expect(await named(env, "device.deleted")).toEqual([]);
  });
});

describe("simlock device remove", () => {
  it("of a ready device exits 0 and prints one line saying it is no longer enrolled and nothing on the device changed, lists the record deleted, records device.deleted with initiator operator and physical true, and makes no driver call after it", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);
    await env.driverLog.clear();

    const result = await env.cli(["device", "remove", UDID]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `Removed ${UDID}. It is no longer enrolled; nothing on the device changed.\n`,
    );
    expect((await rows(env)).find((row) => row.id === enrolled.id)?.state).toBe("deleted");
    const deleted = await named(env, "device.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.payload).toEqual({
      deviceId: enrolled.id,
      initiator: "operator",
      physical: true,
    });
    expect(await env.driverLog.calls()).toEqual([]);
  });

  it("of an ID with no record, and of a removed device, answers UNKNOWN_DEVICE and exits 12", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });

    const never = await env.cli(["device", "remove", UDID]);
    await add(env, "ios", UDID);
    expect((await env.cli(["device", "remove", UDID])).code).toBe(0);
    const twice = await env.cli(["device", "remove", UDID]);

    for (const result of [never, twice]) {
      expect(result.code, result.stderr).toBe(12);
      expect(result.error?.code).toBe("UNKNOWN_DEVICE");
    }
  });

  it("then device add writes a new record with a new registry ID and reenrolled false, and the old record stays deleted", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const first = await add(env, "ios", UDID);
    expect((await env.cli(["device", "remove", UDID])).code).toBe(0);

    const second = await add(env, "ios", UDID);

    expect(second.id).not.toBe(first.id);
    expect(second.reenrolled).toBe(false);
    const byId = new Map((await rows(env)).map((row) => [row.id, row.state]));
    expect(byId.get(first.id)).toBe("deleted");
    expect(byId.get(second.id)).toBe("ready");
  });
});
