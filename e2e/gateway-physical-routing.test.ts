import { describe, expect, it } from "vitest";

import type { CliBackgroundHandle } from "./helpers/cli.js";
import type { FakeDriverPlatformScript, ScriptedPhysicalDevice } from "./fake-driver/types.js";
import {
  type CliResult,
  type TestEnv,
  waitFor,
  waitForDeviceState,
  withDaemon,
  withHttpDaemon,
} from "./helpers/index.js";

const FAST = { timeout: 20_000 };
const EXIT_NO_CAPACITY = 11;
const EXIT_UNSERVABLE = 12;

const UDID = "00008110-001A2B3C4D5E";
const SERIAL = "R58M123ABC";

const IPHONE: ScriptedPhysicalDevice = {
  apps: ["com.example.app0"],
  class: "phone",
  ids: [UDID],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};
const PIXEL: ScriptedPhysicalDevice = {
  apps: ["com.example.mail"],
  class: "phone",
  ids: [SERIAL],
  model: "Pixel 9",
  osVersion: "34",
};

const IOS_BASE = {
  availableOsVersions: ["18.4"],
  defaultModels: { phone: ["iPhone 16"] },
  knownModels: ["iPhone 16", "iPhone 15 Pro"],
  modelClasses: { "iPhone 15 Pro": "phone", "iPhone 16": "phone" },
} as const;
const ANDROID_BASE = {
  availableOsVersions: ["34"],
  defaultModels: { phone: ["Pixel 9"] },
  knownModels: ["Pixel 9"],
  modelClasses: { "Pixel 9": "phone" },
} as const;

interface WorkerSpec {
  readonly label: string;
  readonly ios?: readonly ScriptedPhysicalDevice[];
  readonly android?: readonly ScriptedPhysicalDevice[];
  readonly iosScript?: FakeDriverPlatformScript;
  readonly config?: Record<string, unknown>;
}

interface Grant {
  readonly lease: { readonly id: string; readonly worker?: { readonly label?: string } };
  readonly device: {
    readonly id: string;
    readonly physical?: boolean;
    readonly driverDeviceId: string;
  };
}

interface Fleet {
  readonly gateway: TestEnv;
  readonly workers: Readonly<Record<string, TestEnv>>;
  readonly baseUrl: string;
}

async function startFleet(specs: readonly WorkerSpec[]): Promise<Fleet> {
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    agentId: "fleet-agent",
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    role: "gateway",
    driver: "none",
  }));
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  expect(minted.code, minted.stderr).toBe(0);
  const { secret } = minted.json as { secret: string };

  const workers: Record<string, TestEnv> = {};
  let enrolled = 0;
  for (const spec of specs) {
    const worker = await withDaemon({
      configOverrides: {
        gateway: { label: spec.label, token: secret, url: `ws://127.0.0.1:${String(port)}` },
        ...spec.config,
      },
      driverScript: {
        android: { ...ANDROID_BASE, physicalDevices: spec.android ?? [] },
        ios: { ...IOS_BASE, ...spec.iosScript, physicalDevices: spec.ios ?? [] },
      },
    });
    workers[spec.label] = worker;
    for (const [platform, devices] of [
      ["ios", spec.ios ?? []],
      ["android", spec.android ?? []],
    ] as const) {
      for (const device of devices) {
        const added = await worker.cli([
          "device",
          "add",
          "--platform",
          platform,
          device.ids[0] ?? "",
        ]);
        expect(added.code, added.stderr).toBe(0);
        enrolled += 1;
      }
    }
  }

  await waitFor(
    async () => {
      const listed = await gateway.cli(["worker", "list", "--json"]);
      if (listed.code !== 0) return false;
      const views = (
        listed.json as { workers: { label?: string; connection: string; catalog: unknown[] }[] }
      ).workers;
      return specs.every((spec) =>
        views.some(
          (view) =>
            view.label === spec.label && view.connection === "connected" && view.catalog.length > 0,
        ),
      );
    },
    { label: "every worker connected with its catalog", timeout: 30_000 },
  );
  await waitFor(
    async () => {
      const status = (await gateway.cli(["status", "--json"])).json as {
        devices?: { physical?: boolean }[];
      };
      return (status.devices ?? []).filter((device) => device.physical === true).length >= enrolled;
    },
    { label: "the gateway lists every enrolled device", timeout: 30_000 },
  );
  return { baseUrl: `http://127.0.0.1:${String(port)}`, gateway, workers };
}

function lease(gateway: TestEnv, agent: string, extra: readonly string[]): Promise<CliResult> {
  return gateway.cli(["lease", "--platform", "ios", "--agent-id", agent, ...extra], FAST);
}

async function granted(gateway: TestEnv, agent: string, extra: readonly string[]): Promise<Grant> {
  const result = await lease(gateway, agent, [...extra, "--detach"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

async function dispatchedEvents(gateway: TestEnv): Promise<unknown[]> {
  return (await gateway.events())
    .filter((entry) => entry.event === "request.dispatched")
    .map((entry) => entry.payload);
}

function expectFailure(result: CliResult, code: string, exit: number): void {
  expect(result.error, result.stderr).toMatchObject({ code });
  expect(result.code).toBe(exit);
}

function isQueuedAt(event: unknown, position: number): boolean {
  const record = event as Record<string, unknown>;
  return record["stage"] === "queued" && record["queuePosition"] === position;
}

async function queuedAt(handle: CliBackgroundHandle, position: number): Promise<void> {
  await waitFor(() => handle.progressEvents().some((event) => isQueuedAt(event, position)), {
    label: `a request queued at position ${String(position)}`,
    timeout: 30_000,
  });
}

async function agentAuth(gateway: TestEnv): Promise<Record<string, string>> {
  const created = await gateway.cli(["token", "create", "--role", "agent"]);
  expect(created.code, created.stderr).toBe(0);
  return {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
}

async function httpLease(
  baseUrl: string,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const created = await fetch(`${baseUrl}/v1/lease-requests`, {
    body: JSON.stringify(body),
    headers: auth,
    method: "POST",
  });
  expect(created.status).toBe(201);
  const requestId = ((await created.json()) as { request: { id: string } }).request.id;
  let leaseId = "";
  await waitFor(
    async () => {
      const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
        headers: auth,
      });
      const view = (await polled.json()) as { request: { state: string; lease?: { id: string } } };
      leaseId = view.request.lease?.id ?? "";
      return view.request.state === "granted";
    },
    { label: "the lease request is granted", timeout: 30_000 },
  );
  return leaseId;
}

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

async function readSse(response: Response): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (const raw of (await response.text()).split("\n\n")) {
    if (raw.trim() === "" || raw.startsWith(":")) continue;
    let event: string | undefined;
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event !== undefined) frames.push({ data: JSON.parse(data) as unknown, event });
  }
  return frames;
}

function stdoutOf(frames: readonly SseFrame[]): string {
  return frames
    .filter((frame) => frame.event === "output")
    .map((frame) => frame.data as { stream: string; chunk: string })
    .filter((data) => data.stream === "stdout")
    .map((data) => data.chunk)
    .join("");
}

describe("a gateway routes a physical request by the enrolled devices its workers report", () => {
  it("--physical through a gateway is granted the enrolled iPhone on the worker that has it, not the worker with free simulator capacity and none enrolled", async () => {
    const { gateway } = await startFleet([
      { label: "worker-a" },
      { ios: [IPHONE], label: "worker-b" },
    ]);

    const grant = await granted(gateway, "agent-1", ["--physical"]);

    expect(grant.lease.worker?.label).toBe("worker-b");
    expect(grant.device).toMatchObject({ driverDeviceId: UDID, physical: true });
  });

  it("--physical --class tablet with only iPhones enrolled fails at once with UNKNOWN_MODEL, exit 12, and the worker's message, and no worker is asked", async () => {
    const { gateway } = await startFleet([{ ios: [IPHONE], label: "worker-b" }]);

    const result = await lease(gateway, "agent-1", ["--physical", "--class", "tablet"]);

    expectFailure(result, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
    expect(result.error?.message).toBe("no enrolled physical device can match ios class tablet");
    expect(await dispatchedEvents(gateway)).toEqual([]);
  });

  it("--platform android --physical with no Android device enrolled on any worker fails at once with UNKNOWN_MODEL", async () => {
    const { gateway } = await startFleet([
      { ios: [IPHONE], label: "worker-a" },
      { label: "worker-b" },
    ]);

    const result = await gateway.cli(
      ["lease", "--platform", "android", "--physical", "--agent-id", "agent-1"],
      FAST,
    );

    expectFailure(result, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
    expect(await dispatchedEvents(gateway)).toEqual([]);
  });

  it('--physical --device "iPhone 15 Pro" --os ">=18 <19" is granted the device matching both; with --os ">=17 <18", and with --os 18, and only an iOS 18.4 device enrolled, it fails at once with UNKNOWN_MODEL, and the --os 18 message names the range form', async () => {
    const { gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);

    const matching = await granted(gateway, "agent-1", [
      "--physical",
      "--device",
      "iPhone 15 Pro",
      "--os",
      ">=18 <19",
    ]);
    expect(matching.device.driverDeviceId).toBe(UDID);
    expect((await gateway.cli(["release", matching.lease.id], FAST)).code).toBe(0);

    const below = await lease(gateway, "agent-2", [
      "--physical",
      "--device",
      "iPhone 15 Pro",
      "--os",
      ">=17 <18",
    ]);
    expectFailure(below, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
    const exact = await lease(gateway, "agent-3", [
      "--physical",
      "--device",
      "iPhone 15 Pro",
      "--os",
      "18",
    ]);
    expectFailure(exact, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
    expect(exact.error?.message).toContain('--os ">=18 <19"');
    expect(await dispatchedEvents(gateway)).toHaveLength(1);
  });

  it("--physical --no-wait while the only enrolled match is leased fails with NO_CAPACITY, exit 11", async () => {
    const { gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);
    await granted(gateway, "agent-1", ["--physical"]);

    const refused = await lease(gateway, "agent-2", ["--physical", "--no-wait"]);

    expectFailure(refused, "NO_CAPACITY", EXIT_NO_CAPACITY);
  });

  it("a second --physical request for the only enrolled match waits, and is granted after the first lease is released and the device reclaimed", async () => {
    const { gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);
    const first = await granted(gateway, "agent-1", ["--physical"]);
    const waiter = gateway.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--physical",
      "--agent-id",
      "agent-2",
    ]);
    await queuedAt(waiter, 1);

    expect((await gateway.cli(["release", first.lease.id], FAST)).code).toBe(0);

    const second = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(second.device).toMatchObject({ driverDeviceId: UDID, physical: true });
  });

  it("a waiting --physical request fails with UNKNOWN_MODEL once simlock device remove <id>, run on the worker, unenrolls its last enrolled match", async () => {
    const { gateway, workers } = await startFleet([
      {
        config: { warmPool: { quarantine: { retryBackoffMs: 600_000 } } },
        iosScript: { failures: { reclaim: { message: "uninstall failed", type: "generic" } } },
        ios: [IPHONE],
        label: "worker-a",
      },
    ]);
    const worker = workers["worker-a"];
    if (worker === undefined) throw new Error("expected worker-a");
    const first = await granted(gateway, "agent-1", ["--physical"]);
    expect((await gateway.cli(["release", first.lease.id], FAST)).code).toBe(0);
    await waitForDeviceState(worker, UDID, "quarantined");
    const waiter = gateway.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--physical",
      "--agent-id",
      "agent-2",
    ]);
    await queuedAt(waiter, 1);

    const removed = await worker.cli(["device", "remove", UDID]);

    expect(removed.code, removed.stderr).toBe(0);
    const ended = await waiter.waitForExit(30_000);
    expectFailure(ended, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
  });

  it("--physical whose only enrolled match is on a drained worker fails at once with NO_CAPACITY", async () => {
    const { gateway } = await startFleet([
      { label: "worker-a" },
      { ios: [IPHONE], label: "worker-b" },
    ]);
    const listed = (await gateway.cli(["worker", "list", "--json"])).json as {
      workers: { id: string; label?: string }[];
    };
    const drained = listed.workers.find((worker) => worker.label === "worker-b");
    expect((await gateway.cli(["worker", "drain", drained?.id ?? ""])).code).toBe(0);

    const result = await lease(gateway, "agent-1", ["--physical"]);

    expectFailure(result, "NO_CAPACITY", EXIT_NO_CAPACITY);
  });

  it("a request without --physical on a gateway whose only worker has a ready enrolled iPhone is granted a simulator", async () => {
    const { gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);

    const grant = await granted(gateway, "agent-1", []);

    expect(grant.device.physical).toBe(false);
    expect(grant.device.driverDeviceId).not.toBe(UDID);
  });
});

describe("through a gateway, a physical lease is driven with the worker's tool, aimed at the leased device", () => {
  it("simlock adb --lease <id> on a physical Android lease runs on the worker, aimed at the leased serial, and exits with the tool's code", async () => {
    const { gateway } = await startFleet([{ android: [PIXEL], label: "worker-a" }]);
    const leased = await gateway.cli(
      ["lease", "--platform", "android", "--physical", "--detach"],
      FAST,
    );
    expect(leased.code, leased.stderr).toBe(0);
    const grant = leased.json as Grant;
    expect(grant.device.driverDeviceId).toBe(SERIAL);

    const exec = await gateway.cli(
      ["adb", "--lease", grant.lease.id, "devices", "--fake-exec-exit=3"],
      { input: "", timeout: 30_000 },
    );

    expect(exec.code, exec.stderr).toBe(3);
    expect((JSON.parse(exec.stdout) as { argv: string[] }).argv).toContain(SERIAL);
  });

  it("POST /v1/leases/{id}/exec with devicectl on a physical iOS lease streams output aimed at the leased UDID and its exit code", async () => {
    const { baseUrl, gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);
    const auth = await agentAuth(gateway);
    const leaseId = await httpLease(baseUrl, auth, { physical: true, platform: "ios" });

    const response = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({
        args: ["device", "info", "apps", "--fake-exec-exit=4"],
        tool: "devicectl",
      }),
      headers: auth,
      method: "POST",
    });

    expect(response.status).toBe(200);
    const frames = await readSse(response);
    expect(frames.at(-1)).toEqual({ data: { exitCode: 4 }, event: "exit" });
    expect((JSON.parse(stdoutOf(frames)) as { argv: string[] }).argv).toContain(UDID);
  });

  it("devicectl on a virtual lease and simctl on a physical lease are refused with the worker's code and HTTP status, and nothing runs", async () => {
    const { baseUrl, gateway } = await startFleet([{ ios: [IPHONE], label: "worker-a" }]);
    const auth = await agentAuth(gateway);
    const exec = (leaseId: string, tool: string) =>
      fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
        body: JSON.stringify({ args: ["list"], tool }),
        headers: auth,
        method: "POST",
      });
    const virtual = await httpLease(baseUrl, auth, { platform: "ios" });

    const devicectlOnVirtual = await exec(virtual, "devicectl");
    expect(devicectlOnVirtual.status).toBe(422);
    expect(((await devicectlOnVirtual.json()) as { error: { code: string } }).error.code).toBe(
      "PASSTHROUGH_REFUSED",
    );
    const simctlOnVirtual = await exec(virtual, "simctl");
    expect(simctlOnVirtual.status).toBe(200);
    await readSse(simctlOnVirtual);
    expect((await gateway.cli(["release", virtual], FAST)).code).toBe(0);

    const physical = await httpLease(baseUrl, auth, { physical: true, platform: "ios" });
    const simctlOnPhysical = await exec(physical, "simctl");
    expect(simctlOnPhysical.status).toBe(422);
    expect(((await simctlOnPhysical.json()) as { error: { code: string } }).error.code).toBe(
      "PASSTHROUGH_REFUSED",
    );
    const devicectlOnPhysical = await exec(physical, "devicectl");
    expect(devicectlOnPhysical.status).toBe(200);
    await readSse(devicectlOnPhysical);
  });
});
