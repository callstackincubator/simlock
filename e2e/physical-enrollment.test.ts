import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION_RANGE } from "../src/contract/index.js";
import { NodeIpcTransport } from "../src/ports/index.js";
import { SimlockWire, WireCallError } from "../src/simlock-client/wire.js";
import type { FakeDriverRefusalReason, ScriptedPhysicalDevice } from "./fake-driver/types.js";
import { type TestEnv, waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";
import { observeFor } from "./helpers/physical-state.js";
import { readEnrolledApps } from "./helpers/state-db.js";

const UDID = "00008110-001A2B3C4D5E";
const ALIAS = "7A1C0E52-6B7D-4F1E-9C1A-2D3E4F5A6B7C";
const APPS = Array.from({ length: 12 }, (_, index) => `com.example.app${String(index)}`);

const IPHONE: ScriptedPhysicalDevice = {
  apps: APPS,
  class: "phone",
  ids: [UDID, ALIAS],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};

const PIXEL: ScriptedPhysicalDevice = {
  apps: ["com.example.mail"],
  class: "phone",
  ids: ["R58M123ABC"],
  model: "Pixel 9",
  osVersion: "15",
};

const IOS_BASE = {
  availableOsVersions: ["18.4"],
  defaultModels: { phone: ["iPhone 16"] },
  knownModels: ["iPhone 16", "iPhone 15 Pro"],
  modelClasses: { "iPhone 15 Pro": "phone", "iPhone 16": "phone" },
} as const;

const ANDROID_BASE = {
  availableOsVersions: ["35"],
  defaultModels: { phone: ["Pixel 9"] },
  knownModels: ["Pixel 9"],
  modelClasses: { "Pixel 9": "phone" },
} as const;

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

interface Row {
  readonly id: string;
  readonly driverDeviceId?: string;
  readonly state: string;
  readonly physical: boolean;
  readonly class?: string;
  readonly workerId?: string;
  readonly spec: { readonly model: string; readonly platform: string; readonly osVersion: string };
}

interface Added {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly platform: string;
  readonly model: string;
  readonly osVersion: string;
  readonly class: string;
  readonly appCount: number;
  readonly reenrolled: boolean;
}

async function startDaemon(
  options: {
    readonly ios?: Record<string, unknown>;
    readonly android?: Record<string, unknown>;
    readonly platforms?: readonly ("ios" | "android")[];
    readonly http?: number;
  } = {},
): Promise<TestEnv> {
  return withDaemon(daemonOptions(options));
}

function daemonOptions(options: Parameters<typeof startDaemon>[0] = {}) {
  return {
    ...(options.platforms === undefined ? {} : { fakeDriverPlatforms: options.platforms }),
    ...(options.http === undefined
      ? {}
      : { configOverrides: { http: { enabled: true, host: "127.0.0.1", port: options.http } } }),
    driverScript: {
      android: { ...ANDROID_BASE, ...options.android },
      ios: { ...IOS_BASE, ...options.ios },
    },
  };
}

async function rows(env: TestEnv): Promise<Row[]> {
  const result = await env.cli(["list", "--devices"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Row[];
}

async function inspectCalls(env: TestEnv): Promise<readonly unknown[]> {
  return (await env.driverLog.calls()).filter((call) => call.operation === "inspectPhysical");
}

async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

async function add(env: TestEnv, platform: string, id: string): Promise<Added> {
  const result = await env.cli(["device", "add", "--platform", platform, id, "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Added;
}

async function leaseGrant(
  env: TestEnv,
  platform: string,
  agent: string,
): Promise<{ device: { driverDeviceId: string; address: string } }> {
  const result = await env.cli(["lease", "--platform", platform, "--agent-id", agent, "--detach"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as { device: { driverDeviceId: string; address: string } };
}

interface HttpDaemon {
  readonly env: TestEnv;
  readonly base: string;
}

async function httpDaemon(options: {
  readonly ios?: Record<string, unknown>;
  readonly android?: Record<string, unknown>;
}): Promise<HttpDaemon> {
  const { env, port } = await withHttpDaemon((port) => daemonOptions({ ...options, http: port }));
  const base = `http://127.0.0.1:${String(port)}`;
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/v1/healthz`)).ok;
      } catch {
        return false;
      }
    },
    { label: "HTTP API accepting connections" },
  );
  return { base, env };
}

async function bearer(env: TestEnv, role: "agent" | "operator"): Promise<Record<string, string>> {
  const created = await env.cli(["token", "create", "--role", role]);
  expect(created.code, created.stderr).toBe(0);
  return {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
}

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
    const previous = PROTOCOL_VERSION_RANGE.max - 1;
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

describe("an enrolled physical device", () => {
  it("is not granted to a lease --platform ios: the lease gets a simulator", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);

    const grant = await env.cli(["lease", "--platform", "ios", "--agent-id", "sim", "--detach"]);

    expect(grant.code, grant.stderr).toBe(0);
    const device = (grant.json as { device: { id: string; physical: boolean } }).device;
    expect(device.physical).toBe(false);
    expect(device.id).not.toBe(enrolled.id);
  });

  it("shows its canonical ID as driverDeviceId in status --json from an operator and from an agent session and in list --devices, and a simulator's status entry has none", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    await add(env, "ios", UDID);
    const simulator = await leaseGrant(env, "ios", "sim-agent");

    const operator = await env.cli(["status", "--json"]);
    const agent = await env.cli(["--token", "not-an-admin-credential", "status", "--json"]);

    for (const status of [operator, agent]) {
      expect(status.code, status.stderr).toBe(0);
      const devices = (status.json as { devices: Row[] }).devices;
      const physical = devices.find((device) => device.physical);
      const virtual = devices.find((device) => !device.physical);
      expect(physical?.driverDeviceId).toBe(UDID);
      expect(virtual).toBeDefined();
      expect(virtual?.driverDeviceId).toBeUndefined();
    }
    const listed = (await rows(env)).find((row) => row.physical);
    expect(listed?.driverDeviceId).toBe(UDID);
    expect(simulator.device.driverDeviceId).not.toBe(UDID);
  });
});

describe("device add over HTTP", () => {
  it("POST /v1/devices with an operator token enrols the device; with an agent token it is 403 FORBIDDEN and no inspectPhysical call is made; a body with a worker field or any other unknown field is 400 BAD_REQUEST", async () => {
    const { base, env } = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });
    const agent = await bearer(env, "agent");
    const operator = await bearer(env, "operator");
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${base}/v1/devices`, { body: JSON.stringify(body), headers, method: "POST" });

    const refused = await post(agent, { id: UDID, platform: "ios" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(await inspectCalls(env)).toEqual([]);

    for (const extra of [{ worker: "w1" }, { nickname: "mine" }]) {
      const bad = await post(operator, { id: UDID, platform: "ios", ...extra });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    }
    expect(await inspectCalls(env)).toEqual([]);

    const accepted = await post(operator, { id: UDID, platform: "ios" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      appCount: 12,
      driverDeviceId: UDID,
      reenrolled: false,
    });
    expect((await rows(env)).filter((row) => row.state === "ready")).toHaveLength(1);
  });

  it("DELETE /v1/devices/<canonical ID> with an operator token unenrols the device; with an agent token it is 403 FORBIDDEN and the record stays ready", async () => {
    const { base, env } = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);
    const agent = await bearer(env, "agent");
    const operator = await bearer(env, "operator");
    const remove = (headers: Record<string, string>) =>
      fetch(`${base}/v1/devices/${encodeURIComponent(UDID)}`, { headers, method: "DELETE" });

    const refused = await remove(agent);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect((await rows(env)).find((row) => row.id === enrolled.id)?.state).toBe("ready");

    const accepted = await remove(operator);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ driverDeviceId: UDID, id: enrolled.id });
    expect((await rows(env)).find((row) => row.id === enrolled.id)?.state).toBe("deleted");
  });
});

describe("device add through a gateway", () => {
  async function fleet(): Promise<{ gateway: TestEnv; worker: TestEnv; workerId: string }> {
    const { env: gateway, port } = await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      role: "gateway",
      driver: "none",
    }));
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code, minted.stderr).toBe(0);
    const { secret } = minted.json as { secret: string };
    const worker = await withDaemon({
      configOverrides: { gateway: { label: "w1", token: secret, url: `ws://127.0.0.1:${port}` } },
      driverScript: { ios: { ...IOS_BASE, physicalDevices: [IPHONE] } },
    });
    let workerId = "";
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const workers = (listed.json as { workers?: { id: string; connection: string }[] } | null)
          ?.workers;
        const connected = workers?.find((entry) => entry.connection === "connected");
        workerId = connected?.id ?? "";
        return connected !== undefined;
      },
      { label: "the worker is connected to the gateway" },
    );
    return { gateway, worker, workerId };
  }

  it("shows a device enrolled on worker w1's own daemon in the gateway's list --devices on w1 with its driverDeviceId", async () => {
    const { gateway, worker, workerId } = await fleet();

    const added = await worker.cli(["device", "add", "--platform", "ios", UDID]);
    expect(added.code, added.stderr).toBe(0);

    await waitFor(
      async () => {
        const listed = await gateway.cli(["list", "--devices"]);
        const device = (listed.json as Row[] | null)?.find((row) => row.physical);
        return device?.workerId === workerId && device.driverDeviceId === UDID;
      },
      { label: "the gateway lists the enrolled device on w1" },
    );
  });

  it("answers device add and device remove with UNSUPPORTED_IN_GATEWAY_MODE and exit 2, saying to run the command on the worker the device is plugged into, and no worker's driver log has an inspectPhysical call", async () => {
    const { gateway, worker } = await fleet();
    await worker.driverLog.clear();

    const added = await gateway.cli(["device", "add", "--platform", "ios", UDID]);
    const removed = await gateway.cli(["device", "remove", UDID]);

    for (const result of [added, removed]) {
      expect(result.code, result.stderr).toBe(2);
      expect(result.error?.code).toBe("UNSUPPORTED_IN_GATEWAY_MODE");
      expect(result.error?.message).toContain("worker the device is plugged into");
    }
    expect(await inspectCalls(worker)).toEqual([]);
  });
});

describe("android enrolment", () => {
  it("records the apps the driver lists and shows the device with its Android OS version", async () => {
    const env = await startDaemon({ android: { physicalDevices: [PIXEL] } });

    const result = await env.cli(["device", "add", "--platform", "android", "R58M123ABC"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Enrolled Pixel 9 (Android 15) as R58M123ABC, 1 user app recorded.\n",
    );
    expect(readEnrolledApps(env)).toEqual([["com.example.mail"]]);
  });
});

const AUTO_ENROLL = { devices: { autoEnroll: true }, health: { probeIntervalMs: 200 } };
const IPHONE_TWO: ScriptedPhysicalDevice = {
  apps: ["com.example.second"],
  class: "phone",
  ids: ["00008110-00FFEEDDCCBB"],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};

async function autoDaemon(
  options: {
    readonly ios?: Record<string, unknown>;
    readonly android?: Record<string, unknown>;
    readonly config?: Record<string, unknown>;
    readonly platforms?: readonly ("ios" | "android")[];
  } = {},
): Promise<TestEnv> {
  const base = daemonOptions(options);
  return withDaemon({
    ...base,
    configOverrides: { ...AUTO_ENROLL, ...options.config },
  });
}

async function plug(
  env: TestEnv,
  platform: "ios" | "android",
  devices: readonly ScriptedPhysicalDevice[],
): Promise<void> {
  await env.driverScript.merge({ [platform]: { physicalDevices: devices } });
}

async function autoEnrollLog(env: TestEnv): Promise<string[]> {
  const text = await readFile(env.logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => (JSON.parse(line) as { message: string }).message)
    .filter((message) => message.startsWith("auto-enroll:"));
}

function refused(
  device: ScriptedPhysicalDevice,
  reason: FakeDriverRefusalReason,
): ScriptedPhysicalDevice {
  return { ...device, refusal: { message: `scripted ${reason} for ${device.ids[0]}`, reason } };
}

describe("devices.autoEnroll", () => {
  it("enrols a phone plugged in, an iPhone, an Android phone and a phone attached before the daemon starts, each with one device.enrolled initiator auto and its installed apps as kept apps", async () => {
    const env = await autoDaemon({ ios: { physicalDevices: [IPHONE] } });

    await plug(env, "ios", [IPHONE, IPHONE_TWO]);
    await plug(env, "android", [PIXEL]);

    await waitFor(async () => (await named(env, "device.enrolled")).length === 3, {
      label: "the three phones are enrolled",
    });
    const enrolled = (await named(env, "device.enrolled")).map(
      (entry) => entry.payload as Added & { readonly initiator: string },
    );
    expect(
      enrolled.map((payload) => [payload.driverDeviceId, payload.initiator, payload.appCount]),
    ).toEqual(
      expect.arrayContaining([
        [UDID, "auto", 12],
        ["00008110-00FFEEDDCCBB", "auto", 1],
        ["R58M123ABC", "auto", 1],
      ]),
    );
    expect(enrolled.every((payload) => !payload.reenrolled)).toBe(true);
    expect(
      readEnrolledApps(env)
        .map((apps) => apps.length)
        .sort(),
    ).toEqual([1, 1, 12]);
    expect((await rows(env)).map((row) => row.state)).toEqual(["ready", "ready", "ready"]);
  });

  it("retries a phone that cannot be enrolled and logs one auto-enroll line each time its reason changes, word for word, then enrols it once unlocked", async () => {
    const env = await autoDaemon();
    const [a, b, c] = [IPHONE, { ...IPHONE, ids: ["PHONE-B"] }, IPHONE_TWO];
    const line = (device: ScriptedPhysicalDevice, reason: FakeDriverRefusalReason) =>
      `auto-enroll: ios ${device.ids[0]} not enrolled: scripted ${reason} for ${device.ids[0]}`;

    await plug(env, "ios", [
      refused(a, "locked"),
      refused(b, "untrusted"),
      refused(c, "untrusted"),
    ]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 3, { label: "three lines" });
    await observeFor(700, async () => {
      expect(await autoEnrollLog(env), "three runs at one reason write one line").toHaveLength(3);
    });
    await plug(env, "ios", [refused(a, "locked"), refused(b, "untrusted"), refused(c, "locked")]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 4, { label: "locked line" });
    await plug(env, "ios", [
      refused(a, "locked"),
      refused(b, "untrusted"),
      refused(c, "untrusted"),
    ]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 5, {
      label: "untrusted again",
    });
    await observeFor(700, async () => {
      expect(await autoEnrollLog(env)).toHaveLength(5);
    });
    await plug(env, "ios", [a, refused(b, "untrusted"), refused(c, "untrusted")]);
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the unlocked phone is enrolled",
    });

    const lines = await autoEnrollLog(env);
    expect(lines).toEqual(
      expect.arrayContaining([line(a, "locked"), line(b, "untrusted"), line(c, "untrusted")]),
    );
    expect(lines.filter((entry) => entry.includes(String(c.ids[0])))).toEqual([
      line(c, "untrusted"),
      line(c, "locked"),
      line(c, "untrusted"),
    ]);
    expect(lines.filter((entry) => entry.includes(UDID))).toEqual([line(a, "locked")]);
    expect((await named(env, "device.enrolled")).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
    ]);
  });

  it("keeps a phone out that was removed while plugged in until it has been missing two runs, while an operator's device add enrols it again", async () => {
    const phone = (id: string): ScriptedPhysicalDevice => ({ ...IPHONE, ids: [id] });
    const [removed, brief, long, added] = ["PHONE-1", "PHONE-2", "PHONE-3", "PHONE-4"].map(phone);
    const iphones = [removed, brief, long, added].filter((device) => device !== undefined);
    const pixel: ScriptedPhysicalDevice = { ...PIXEL, present: true };
    const env = await autoDaemon({
      android: {
        failures: { reclaim: { message: "scripted reclaim failure", type: "generic" } },
        physicalDevices: [pixel],
      },
      config: {
        health: { probeIntervalMs: 500 },
        warmPool: { quarantine: { maxRetries: 1, retryBackoffMs: 300, retryBackoffMultiplier: 1 } },
      },
      ios: { physicalDevices: iphones },
    });
    const enrolledOf = async (id: string) =>
      (await named(env, "device.enrolled"))
        .map((entry) => entry.payload as Added & { readonly initiator: string })
        .filter((payload) => payload.driverDeviceId === id);
    const runs = async (count: number) => {
      const lists = async () =>
        (await env.driverLog.calls()).filter(
          (call) => call.operation === "listAttachedPhysical" && call.platform === "ios",
        ).length;
      const before = await lists();
      await waitFor(async () => (await lists()) >= before + count, { interval: 20 });
    };
    await waitFor(async () => (await named(env, "device.enrolled")).length === 5, {
      label: "the five phones are enrolled",
    });
    const remove = async (id: string) => {
      const result = await env.cli(["device", "remove", id]);
      expect(result.code, result.stderr).toBe(0);
    };

    await remove("PHONE-1");
    const grant = await env.cli([
      "lease",
      "--platform",
      "android",
      "--physical",
      "--agent-id",
      "a",
      "--detach",
    ]);
    expect(grant.code, grant.stderr).toBe(0);
    const released = await env.cli(["release", (grant.json as { lease: { id: string } }).lease.id]);
    expect(released.code, released.stderr).toBe(0);
    await waitFor(async () => (await named(env, "device.quarantine-abandoned")).length === 1, {
      label: "the quarantine gives up and unenrols the Android phone",
    });
    await remove("PHONE-2");
    await remove("PHONE-3");
    await plug(env, "ios", [
      removed,
      { ...brief, present: false },
      { ...long, present: false },
      added,
    ]);
    await runs(1);
    await plug(env, "ios", [removed, brief, { ...long, present: false }, added]);
    await runs(1);
    await plug(env, "ios", iphones);
    await waitFor(async () => (await enrolledOf("PHONE-3")).length === 2, {
      label: "the phone missing two runs is enrolled again",
    });
    await remove("PHONE-4");
    const again = await env.cli(["device", "add", "--platform", "ios", "PHONE-4"]);
    expect(again.code, again.stderr).toBe(0);
    await runs(3);

    expect(
      (await enrolledOf("PHONE-1")).map((payload) => payload.initiator),
      "removed, plugged in",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf(pixel.ids[0] ?? "")).map((payload) => payload.initiator),
      "unenrolled after quarantine",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf("PHONE-2")).map((payload) => payload.initiator),
      "missing one run",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf("PHONE-3")).map((payload) => payload.initiator),
      "missing two runs",
    ).toEqual(["auto", "auto"]);
    expect(
      (await enrolledOf("PHONE-4")).map((payload) => payload.initiator),
      "device add while held out",
    ).toEqual(["auto", "operator"]);

    const slow = await autoDaemon({
      config: { health: { probeIntervalMs: 5000 } },
      ios: { physicalDevices: [IPHONE, refused({ ...IPHONE, ids: ["PHONE-Y"] }, "locked")] },
    });
    const slowEnrolled = async (id: string) =>
      (await named(slow, "device.enrolled"))
        .map((entry) => entry.payload as Added & { readonly initiator: string })
        .filter((payload) => payload.driverDeviceId === id);
    await waitFor(async () => (await slowEnrolled(UDID)).length === 1, {
      label: "the first run enrols the unlocked phone",
      timeout: 30_000,
    });
    const gone = await slow.cli(["device", "remove", UDID]);
    expect(gone.code, gone.stderr).toBe(0);
    await plug(slow, "ios", [IPHONE, { ...IPHONE, ids: ["PHONE-Y"] }]);
    await add(slow, "ios", "PHONE-Y");
    const goneToo = await slow.cli(["device", "remove", "PHONE-Y"]);
    expect(goneToo.code, goneToo.stderr).toBe(0);
    const listed = async () =>
      (await slow.driverLog.calls()).filter((call) => call.operation === "listAttachedPhysical")
        .length;
    const seen = await listed();
    await waitFor(async () => (await listed()) >= seen + 4, { interval: 50, timeout: 30_000 });

    expect(
      (await slowEnrolled(UDID)).map((payload) => payload.initiator),
      "removed before the next run",
    ).toEqual(["auto"]);
    expect(
      (await slowEnrolled("PHONE-Y")).map((payload) => payload.initiator),
      "added and removed between two runs",
    ).toEqual(["operator"]);
  });

  it("forgets which phones are held out when the daemon restarts, so a removed phone still plugged in is enrolled on the first run", async () => {
    const env = await autoDaemon({ ios: { physicalDevices: [IPHONE] } });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the phone is enrolled",
    });
    const removed = await env.cli(["device", "remove", UDID]);
    expect(removed.code, removed.stderr).toBe(0);

    await env.restartDaemon();

    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "the restarted daemon enrols the removed phone again",
    });
    expect((await named(env, "device.enrolled")).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
    ]);
  });

  it("skips a platform that cannot be listed for that run, still enrols the other platform, logs one line per error message, and logs nothing for a platform with no driver", async () => {
    const down = { listAttachedPhysical: { message: "adb is down", type: "generic" } } as const;
    const env = await autoDaemon({
      android: { physicalDevices: [PIXEL] },
      ios: { physicalDevices: [IPHONE] },
    });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "both phones are enrolled",
    });
    const removed = await env.cli(["device", "remove", "R58M123ABC"]);
    expect(removed.code, removed.stderr).toBe(0);
    const androidLists = async () =>
      (await env.driverLog.calls()).filter(
        (call) => call.operation === "listAttachedPhysical" && call.platform === "android",
      ).length;
    const runs = async (count: number) => {
      const before = await androidLists();
      await waitFor(async () => (await androidLists()) >= before + count, { interval: 20 });
    };
    const couldNotList = async () =>
      (await autoEnrollLog(env)).filter((line) => line.includes("could not list"));

    await env.driverScript.merge({ android: { failures: down } });
    await runs(4);
    await plug(env, "ios", [IPHONE, IPHONE_TWO]);
    await waitFor(async () => (await named(env, "device.enrolled")).length === 3, {
      label: "the iPhone plugged in while Android cannot be listed is enrolled",
    });

    expect(await couldNotList()).toEqual([
      "auto-enroll: could not list android phones: adb is down",
    ]);

    await env.driverScript.merge({ android: { failures: {} } });
    await runs(4);
    expect(
      (await named(env, "device.enrolled")).filter(
        (e) => (e.payload as Added).platform === "android",
      ),
      "held out across the failing runs",
    ).toHaveLength(1);
    await env.driverScript.merge({ android: { failures: down } });
    await runs(2);
    expect(await couldNotList(), "a list that succeeds resets the message").toHaveLength(2);

    const iosOnly = await autoDaemon({ ios: { physicalDevices: [IPHONE] }, platforms: ["ios"] });
    await waitFor(async () => (await named(iosOnly, "device.enrolled")).length === 1, {
      label: "the iPhone is enrolled on a worker with no Android driver",
    });
    expect(await autoEnrollLog(iosOnly)).toEqual([]);
  });

  it("grants a waiting physical request the auto-enrolled phone within one run, with no second request, and still fails a model with no record at once", async () => {
    const second: ScriptedPhysicalDevice = { ...PIXEL, ids: ["R58M456DEF"] };
    const env = await autoDaemon({ android: { physicalDevices: [PIXEL] } });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the first Pixel is enrolled",
    });
    const ask = (agent: string, model: string) => [
      "lease",
      "--platform",
      "android",
      "--physical",
      "--device",
      model,
      "--agent-id",
      agent,
    ];
    const first = await env.cli([...ask("agent-a", "Pixel 9"), "--detach"], { timeout: 30_000 });
    expect(first.code, first.stderr).toBe(0);
    const waiter = env.cliBackground(ask("agent-b", "Pixel 9"));
    await waitFor(async () => (await named(env, "lease.queued")).length === 1, {
      label: "the second request is queued",
    });

    await plug(env, "android", [PIXEL, second]);

    const grant = JSON.parse(await waiter.firstStdoutLine(30_000)) as {
      device: { driverDeviceId: string };
    };
    expect(grant.device.driverDeviceId).toBe("R58M456DEF");
    const unknown = await env.cli(ask("agent-c", "Galaxy S99"), { timeout: 30_000 });
    expect(unknown.error?.code).toBe("UNKNOWN_MODEL");
  });

  it("does nothing without the setting, unset or false: no device.enrolled and no inspectPhysical call after three runs", async () => {
    for (const devices of [undefined, { autoEnroll: false }]) {
      const env = await withDaemon({
        ...daemonOptions({ ios: { physicalDevices: [IPHONE] } }),
        configOverrides: {
          health: { probeIntervalMs: 200 },
          ...(devices === undefined ? {} : { devices }),
        },
      });
      await observeFor(700, async () => {
        expect(await named(env, "device.enrolled")).toEqual([]);
      });
      expect(await inspectCalls(env)).toEqual([]);
    }
  });

  it("leaves an enrolled phone alone in the states ready, absent and leased: no device.enrolled and the kept apps unchanged", async () => {
    const env = await autoDaemon({
      android: { physicalDevices: [PIXEL] },
      ios: { physicalDevices: [IPHONE] },
    });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "both phones are enrolled",
    });
    const keptApps = readEnrolledApps(env);
    const states = async () => (await rows(env)).map((row) => row.state).sort();
    const stays = async (label: string) => {
      await observeFor(700, async () => {
        expect(await named(env, "device.enrolled"), label).toHaveLength(2);
      });
      expect(readEnrolledApps(env), label).toEqual(keptApps);
    };

    await stays("ready");
    await plug(env, "ios", [{ ...IPHONE, present: false }]);
    await waitFor(async () => (await states()).includes("absent"), {
      label: "the iPhone is absent",
    });
    await stays("absent");
    const leased = await env.cli([
      "lease",
      "--platform",
      "android",
      "--physical",
      "--agent-id",
      "a",
      "--detach",
    ]);
    expect(leased.code, leased.stderr).toBe(0);
    expect(await states()).toContain("leased");
    await stays("leased");
  });
});
