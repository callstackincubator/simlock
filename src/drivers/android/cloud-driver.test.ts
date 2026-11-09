import { describe, expect, it } from "vitest";

import { openMemoryState, describeDeviceDataTable } from "../../core/testing.js";
import {
  FakeClock,
  FakeHttpJsonRequester,
  FakeProcessSupervisor,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunOptions,
} from "../../ports/index.js";
import { createCloudAndroidDriver, cloudDeviceDataTable } from "./index.js";
import { promiseState } from "../../test-support/promise-state.js";

const API = "https://api.example.com";
const HOME = "/home/simlock";
const SERIAL = "127.0.0.1:49152";
const ACTIVE = {
  id: "lease_one",
  status: "active",
  started_at: "1970-01-01T00:00:00+00:00",
  expires_at: "1970-01-01T08:00:00+00:00",
  error: null,
};

class CloudAdbRunner extends ScriptedProcessRunner {
  online = true;

  constructor() {
    super([]);
  }

  override async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    const verb = args[0] === "-P" ? args[2] : args[0];
    let stdout = "";
    if (verb === "version") stdout = "Android Debug Bridge version 1.0.41";
    else if (verb === "connect") {
      this.online = true;
      stdout = "connected";
    } else if (verb === "disconnect") stdout = "disconnected";
    else if (verb === "-s" && args[4] === "get-state") {
      if (this.online === false) return { code: 1, stdout: "", stderr: "error: device offline" };
      stdout = "device";
    } else if (verb === "-s" && args[5] === "getprop") stdout = "1\n";
    else if (verb === "-s" && args[5] === "pm")
      stdout = "package:/system/framework/framework-res.apk";
    else throw new Error(`Unexpected fake ADB command: ${args.join(" ")}`);
    return { code: 0, stdout, stderr: "" };
  }
}

async function setup(config: Readonly<Record<string, string | number | boolean>> = {}) {
  const state = await openMemoryState([cloudDeviceDataTable]);
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(HOME);
  const record = JSON.stringify({ pid: 222, port: 5038, startedAt: 0 });
  await filesystem.writeFileAtomic(`${HOME}/adb-server.json`, record);
  const supervisor = new FakeProcessSupervisor([222]);
  supervisor.answerCommandLine(222, "adb -P 5038 nodaemon server");
  const http = new FakeHttpJsonRequester();
  http.answers.set(`POST ${API}/v1/leases`, { status: 201, body: ACTIVE });
  http.answers.set(`GET ${API}/v1/leases/lease_one`, { status: 200, body: ACTIVE });
  http.answers.set(`POST ${API}/v1/leases/lease_one/renew`, { status: 200, body: ACTIVE });
  http.answers.set(`DELETE ${API}/v1/leases/lease_one`, {
    status: 200,
    body: { ...ACTIVE, status: "released" },
  });
  const runner = new CloudAdbRunner();
  const clock = new FakeClock(1_000);
  const listeners = new FakeTcpListenerFactory();
  let nextId = 0;
  const options = {
    clock,
    database: state.database,
    driverConfig: { apiUrl: API, ...config },
    env: { ADC_API_KEY: "adc_test_secret", PATH: "/bin" },
    filesystem,
    idGenerator: {
      generate: () => {
        nextId += 1;
        return `allocation_${String(nextId)}`;
      },
    },
    instanceId: "worker_one",
    processRunner: runner,
    processSupervisor: supervisor,
    simlockHome: HOME,
    tcpProbe: new FakeTcpProbe([5038]),
    tcpListener: listeners,
    tcpStreamConnector: new FakeTcpStreamConnector(),
    http,
    webSockets: new FakeWebSocketClientConnector(),
  };
  const driver = await createCloudAndroidDriver(options);
  const spec = await driver.resolveSpec({ platform: "android", model: "ReDroid", osVersion: "34" });
  return { state, filesystem, supervisor, http, runner, clock, listeners, driver, spec, options };
}

describeDeviceDataTable("cloudDeviceDataTable", cloudDeviceDataTable, [
  { allocationId: "allocation_one" },
  { allocationId: "allocation_two" },
]);

describe("AgentDeviceCloud Android driver", () => {
  it("provisions, connects, scopes ADB, and releases an owned cloud device without local emulator tools", async () => {
    const h = await setup();
    const catalog = await h.driver.listCatalog();
    expect(catalog.modelRuntimes).toEqual({ ReDroid: ["34"] });
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, physical: false as const };
    const ready = await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    expect(ready.address).toBe(SERIAL);
    expect(h.http.requests[0]?.body).toEqual({
      name: `simlock-${device.deviceId}`,
      purpose: "development",
      ttl_seconds: 28_800,
      idempotency_key: device.deviceId,
    });
    const passthrough = await h.driver.passthrough?.(
      "adb",
      { ...ready, physical: false },
      ["shell", "id"],
      { hasTerminal: false },
    );
    expect(passthrough).toEqual({
      command: "adb",
      args: ["-P", "5038", "-s", SERIAL, "shell", "id"],
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    });
    const connects = h.runner.calls.filter((call) => call.args[2] === "connect");
    expect(connects).toHaveLength(1);
    expect(connects[0]?.options.env?.ADC_API_KEY).toBeUndefined();
    await h.driver.destroy({ ...ready, physical: false });
    expect(h.http.requests.at(-1)?.method).toBe("DELETE");
    expect(h.listeners.listeners[0]?.closed).toBe(true);
    const observed = await h.driver.listManaged();
    expect(observed.devices).toEqual([]);
    h.state.close();
  });

  it("restores only its recorded cloud leases after restart and treats an API outage as unreadable", async () => {
    const h = await setup();
    const device = await h.driver.provision(h.spec);
    const ready = await h.driver.makeReady(
      { ...device, physical: false },
      { purpose: "prepare", mode: "full" },
    );
    h.supervisor.answerCommandLine(222, undefined);
    await h.driver.dispose?.();
    const restarted = await createCloudAndroidDriver(h.options);
    const observed = await restarted.listManaged();
    expect(observed.devices).toEqual([
      { ...ready, physical: false, address: SERIAL, runState: "running" },
    ]);
    const getUrls = h.http.requests.filter((request) => request.method === "GET");
    expect(getUrls.every((request) => request.url === `${API}/v1/leases/lease_one`)).toBe(true);
    h.http.answers.set(`GET ${API}/v1/leases/lease_one`, {
      status: 503,
      body: { detail: "node unavailable" },
    });
    const unreadable = restarted.listManaged();
    await expect(unreadable).rejects.toThrow("HTTP 503");
    const restore = { status: 200, body: ACTIVE };
    h.http.answers.set(`GET ${API}/v1/leases/lease_one`, restore);
    const stillPresent = await restarted.listManaged();
    expect(stillPresent.devices).toHaveLength(1);
    await restarted.destroy({ ...device, physical: false });
    h.state.close();
  });

  it("observes offline ADB and reconnects the same cloud lease on its saved local port", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, physical: false as const };
    const prepared = await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    const healthy = await h.driver.listManaged();
    expect(healthy.devices[0]?.runState).toBe("running");
    h.runner.online = false;
    const offline = await h.driver.listManaged();
    expect(offline.devices[0]?.runState).toBe("stopped");
    const recovered = await h.driver.makeReady(device, { purpose: "recover", mode: "full" });
    expect(recovered.address).toBe(prepared.address);
    expect(h.listeners.listeners[0]?.closed).toBe(true);
    expect(h.listeners.listeners[1]?.port).toBe(49_152);
    const creates = h.http.requests.filter(
      (request) => request.method === "POST" && request.url === `${API}/v1/leases`,
    );
    expect(creates).toHaveLength(1);
    const restored = await h.driver.listManaged();
    expect(restored.devices[0]?.runState).toBe("running");
    await h.driver.destroy(device);
    h.state.close();
  });

  it("confirms remote renewals, exposes quota-shortened expiry, and rejects renewal beyond the activation limit", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, physical: false as const };
    await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    const initial = h.driver.maximumLeaseDeadline?.(device);
    expect(initial).toBe(28_800_000);
    h.http.answers.set(`POST ${API}/v1/leases/lease_one/renew`, {
      status: 200,
      body: { ...ACTIVE, expires_at: "1970-01-01T00:30:00+00:00" },
    });
    const deadline = await h.driver.renewLease?.(device, 3_601_000);
    expect(deadline).toBe(1_800_000);
    expect(h.http.requests.at(-1)?.body).toEqual({ ttl_seconds: 3_601 });
    const maximum = h.driver.maximumLeaseDeadline?.(device);
    expect(maximum).toBe(1_800_000);
    const requestCount = h.http.requests.length;
    const impossible = h.driver.renewLease?.(device, 28_800_001);
    await expect(impossible).rejects.toThrow("eight hours from activation");
    expect(h.http.requests).toHaveLength(requestCount);
    await h.driver.destroy(device);
    h.state.close();
  });

  it("bounds a queued provisioning wait and leaves its allocation available for release", async () => {
    const h = await setup({ provisionTimeoutMs: 1_000 });
    const queued = { ...ACTIVE, status: "queued", started_at: null, expires_at: null };
    h.http.answers.set(`POST ${API}/v1/leases`, { status: 202, body: queued });
    h.http.answers.set(`GET ${API}/v1/leases/lease_one`, { status: 200, body: queued });
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, physical: false as const };
    const waiting = h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    const outcome = promiseState(waiting);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    h.clock.advance(1_000);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(outcome.state).toBe("rejected");
    await expect(waiting).rejects.toThrow("provisioning timed out");
    await h.driver.destroy(device);
    expect(h.http.requests.at(-1)?.method).toBe("DELETE");
    h.state.close();
  });

  it("refuses unsupported models, image selection, baselines, stop, raw ADB tunnels, and foreign allocations", async () => {
    const h = await setup();
    const valid = h.driver.resolveSpec({ platform: "android", model: "ReDroid", osVersion: "34" });
    await expect(valid).resolves.toEqual(h.spec);
    const model = h.driver.resolveSpec({ platform: "android", model: "Pixel 9" });
    await expect(model).rejects.toThrow("Unknown android model");
    const image = h.driver.resolveSpec({
      platform: "android",
      model: "ReDroid",
      imageTag: "google_apis",
    });
    await expect(image).rejects.toThrow("imageTag");
    const runtime = h.driver.resolveSpec({
      platform: "android",
      model: "ReDroid",
      osVersion: "35",
    });
    await expect(runtime).rejects.toThrow("Runtime missing");
    const baseline = h.driver.provision(h.spec, { source: "baseline" });
    await expect(baseline).rejects.toThrow("saved baselines");
    const provisioned = await h.driver.provision(h.spec);
    const owned = { ...provisioned, physical: false as const };
    const rawSupported = h.driver.deviceTcp?.supportsEmulatorPort?.(owned);
    expect(rawSupported).toBe(false);
    const stopped = h.driver.shutdown(owned);
    await expect(stopped).rejects.toThrow("cannot be stopped");
    const foreign = { ...owned, deviceId: "foreign", driverData: { allocationId: "foreign" } };
    const requestCount = h.http.requests.length;
    const destroyForeign = h.driver.destroy(foreign);
    await expect(destroyForeign).rejects.toThrow("not owned by this worker");
    expect(h.http.requests).toHaveLength(requestCount);
    await h.driver.destroy(owned);
    h.state.close();
  });
});
