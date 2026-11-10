import { describe, expect, it, vi } from "vitest";

import { openMemoryState, describeDeviceDataTable } from "../../../core/testing.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  FakeWebSocketClientConnector,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
} from "../../../ports/index.js";
import { FakeHttpJsonRequester, type HttpJsonRequest, type HttpJsonAnswer } from "./test-http.js";
import { cloudAndroidPrerequisites, createCloudAndroidDriver } from "./driver.js";
import { cloudDeviceDataTable } from "./data.js";
import { promiseState } from "../../../test-support/promise-state.js";

const API = "https://api.example.com";
const HOME = "/home/simlock";
const SERIAL = "127.0.0.1:49152";
const ACTIVE = {
  id: "lease_one",
  status: "active",
  error: null,
};

class CloudAdbRunner extends ScriptedProcessRunner {
  online = true;

  constructor(expectations: readonly ScriptedProcessExpectation[] = []) {
    super(expectations);
  }

  override async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    const verb = args[0] === "-P" ? args[2] : args[0];
    if (verb === "-s") return this.#deviceResult(args);
    const stdout = this.#hostOutput(verb, args);
    return { code: 0, stdout, stderr: "" };
  }

  #hostOutput(verb: string | undefined, args: readonly string[]): string {
    if (verb === "version") return "Android Debug Bridge version 1.0.41";
    if (verb === "connect") {
      this.online = true;
      return "connected";
    }
    if (verb === "disconnect") return "disconnected";
    const commandText = args.join(" ");
    throw new Error(`Unexpected fake ADB command: ${commandText}`);
  }

  #deviceResult(args: readonly string[]): ProcessResult {
    let stdout = "";
    if (args[4] === "get-state") {
      if (this.online === false) return { code: 1, stdout: "", stderr: "error: device offline" };
      stdout = "device";
    } else if (args[5] === "getprop") stdout = "1\n";
    else if (args[5] === "pm") stdout = "package:/system/framework/framework-res.apk";
    else {
      const commandText = args.join(" ");
      throw new Error(`Unexpected fake ADB command: ${commandText}`);
    }
    return { code: 0, stdout, stderr: "" };
  }
}

class CloudHttp extends FakeHttpJsonRequester {
  loseNextCreationReply = false;

  override async request(input: HttpJsonRequest): Promise<HttpJsonAnswer> {
    const answer = await super.request(input);
    if (input.method === "POST" && this.loseNextCreationReply) {
      this.loseNextCreationReply = false;
      throw new Error("creation response was lost");
    }
    return answer;
  }
}

async function setup(config: Readonly<Record<string, string | number | boolean>> = {}) {
  const state = await openMemoryState([cloudDeviceDataTable]);
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(HOME);
  const record = JSON.stringify({ pid: 222, port: 5039, startedAt: 0 });
  await filesystem.writeFileAtomic(`${HOME}/adb-server-adc.json`, record);
  const supervisor = new FakeProcessSupervisor([222]);
  supervisor.answerCommandLine(222, "adb -P 5039 nodaemon server");
  const http = new CloudHttp();
  http.answers.set(`POST ${API}/v2/leases`, { status: 201, body: ACTIVE });
  http.answers.set(`GET ${API}/v2/leases/lease_one`, { status: 200, body: ACTIVE });
  http.answers.set(`DELETE ${API}/v2/leases/lease_one`, {
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
    tcpProbe: new FakeTcpProbe([5039]),
    tcpListener: listeners,
    tcpStreamConnector: new FakeTcpStreamConnector(),
    http,
    webSockets: new FakeWebSocketClientConnector(),
  };
  const driver = await createCloudAndroidDriver(options);
  const spec = await driver.resolveSpec({ platform: "android", model: "Android", osVersion: "34" });
  return { state, filesystem, supervisor, http, runner, clock, listeners, driver, spec, options };
}

async function leaveLocalAdbServer(h: Awaited<ReturnType<typeof setup>>) {
  h.supervisor.answerCommandLine(222, "unrelated process");
  h.supervisor.markDead(222);
  await h.driver.dispose?.();
  const record = JSON.stringify({ pid: 333, port: 5038, startedAt: 0 });
  await h.filesystem.writeFileAtomic(`${HOME}/adb-server.json`, record);
  await h.filesystem.mkdirp(`${HOME}/logs`);
  await h.filesystem.writeFileAtomic(`${HOME}/logs/adb-server.log`, "local emulator server log");
  h.supervisor.markAlive(333);
  h.supervisor.answerCommandLine(333, "adb -P 5038 nodaemon server");
  return record;
}

describeDeviceDataTable("cloudDeviceDataTable", cloudDeviceDataTable, [
  { allocationId: "allocation_one" },
  { allocationId: "allocation_two" },
]);

// why: the provider factory is the driver module boundary; its fake network and ADB peers exercise lifecycle and restart failures without a real cloud account.
describe("AgentDeviceCloud Android driver", () => {
  it.each([
    ["default", undefined, 5039],
    ["configured", 5040, 5040],
  ] as const)(
    "owns its %s ADB server without adopting or stopping the local backend's server",
    async (_kind, configuredPort, port) => {
      const h = await setup();
      const localRecord = await leaveLocalAdbServer(h);
      const probe = new FakeTcpProbe([5038]);
      const portText = String(port);
      const args = ["-P", portText, "nodaemon", "server"];
      const runner = new CloudAdbRunner([{ match: { command: "adb", args }, hangs: true }]);
      const spawn = runner.spawn.bind(runner);
      const spawnCalls = vi.spyOn(runner, "spawn");
      spawnCalls.mockImplementation((command, arguments_, options) => {
        const handle = spawn(command, arguments_, options);
        h.supervisor.markAlive(handle.pid);
        const argumentsText = arguments_.join(" ");
        h.supervisor.answerCommandLine(handle.pid, `${command} ${argumentsText}`);
        probe.startListening(port);
        return handle;
      });
      const signal = h.supervisor.signal.bind(h.supervisor);
      const signals = vi.spyOn(h.supervisor, "signal");
      signals.mockImplementation((pid, requestedSignal) => {
        signal(pid, requestedSignal);
        h.supervisor.markDead(pid);
      });
      const driverConfig: Record<string, string | number | boolean> = { ...h.options.driverConfig };
      if (configuredPort !== undefined) driverConfig.adbServerPort = configuredPort;
      const driver = await createCloudAndroidDriver({
        ...h.options,
        driverConfig,
        processRunner: runner,
        tcpProbe: probe,
      });
      const started = runner.calls.find((call) => call.args[2] === "nodaemon");
      expect(started?.args).toEqual(args);
      expect(started?.options.stdio).toEqual({ file: `${HOME}/logs/adb-server-adc.log` });
      const adcRecord = await h.filesystem.readFile(`${HOME}/adb-server-adc.json`);
      const parsedAdcRecord = JSON.parse(adcRecord);
      expect(parsedAdcRecord.port).toBe(port);
      await driver.dispose?.();
      const after = await h.filesystem.readFile(`${HOME}/adb-server.json`);
      const log = await h.filesystem.readFile(`${HOME}/logs/adb-server.log`);
      const localAlive = h.supervisor.isAlive(333);
      const spawned = runner.handles[0];
      expect(after).toBe(localRecord);
      expect(log).toBe("local emulator server log");
      expect(localAlive).toBe(true);
      expect(h.supervisor.signals).toEqual([{ pid: spawned?.pid, signal: "SIGTERM" }]);
      h.state.close();
    },
  );

  it("refuses an explicitly occupied local ADB port without adopting its record or killing its process", async () => {
    const h = await setup();
    const localRecord = await leaveLocalAdbServer(h);
    const probe = new FakeTcpProbe([5038]);
    const runner = new CloudAdbRunner();
    const unavailable = createCloudAndroidDriver({
      ...h.options,
      driverConfig: { ...h.options.driverConfig, adbServerPort: 5038 },
      processRunner: runner,
      tcpProbe: probe,
    });
    await expect(unavailable).rejects.toMatchObject({
      name: "BackendUnavailableError",
      rejection: {
        event: "driver.adb-server-rejected",
        platform: "android",
        reason: "occupied",
        payload: { port: 5038, reason: "occupied" },
      },
    });
    const after = await h.filesystem.readFile(`${HOME}/adb-server.json`);
    const localAlive = h.supervisor.isAlive(333);
    expect(after).toBe(localRecord);
    expect(localAlive).toBe(true);
    expect(h.supervisor.signals).toEqual([]);
    expect(runner.handles).toEqual([]);
    expect(h.http.requests).toEqual([]);
    h.state.close();
  });

  it("reports a missing configured account key as an unavailable backend and a prerequisite finding", async () => {
    const h = await setup();
    const changedOptions = {
      ...h.options,
      driverConfig: { ...h.options.driverConfig, apiKeyEnv: "PRIVATE_ADC_TOKEN" },
    };
    const unavailable = createCloudAndroidDriver(changedOptions);
    await expect(unavailable).rejects.toMatchObject({ name: "BackendUnavailableError" });
    const prerequisites = cloudAndroidPrerequisites(changedOptions);
    const findings = await prerequisites.check();
    expect(findings).toContainEqual({
      prerequisite: "adc-api-key",
      message: "AgentDeviceCloud requires PRIVATE_ADC_TOKEN",
      remedy: "Set PRIVATE_ADC_TOKEN in the worker environment and restart Simlock.",
    });
    expect(h.http.requests).toEqual([]);
    h.state.close();
  });

  it("refuses an API-origin switch before touching ADB or cloud devices and keeps the journal readable", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const httpCount = h.http.requests.length;
    const adbCount = h.runner.calls.length;
    const changedOptions = {
      ...h.options,
      driverConfig: { ...h.options.driverConfig, apiUrl: "https://other.example.com" },
    };
    const changed = createCloudAndroidDriver(changedOptions);
    await expect(changed).rejects.toThrow(`Restore drivers.android.apiUrl to ${API}`);
    expect(h.http.requests).toHaveLength(httpCount);
    expect(h.runner.calls).toHaveLength(adbCount);
    const observed = await h.driver.listManaged();
    expect(observed.devices).toEqual([
      { ...provisioned, backend: "adc", physical: false, runState: "stopped" },
    ]);
    const prerequisites = cloudAndroidPrerequisites(changedOptions);
    const findings = await prerequisites.check();
    expect(findings).toContainEqual({
      prerequisite: "adc-api-origin",
      message: `Recorded AgentDeviceCloud devices belong to ${API}`,
      remedy: `Restore drivers.android.apiUrl to ${API}, or use a fresh SIMLOCK_HOME.`,
    });
    await h.driver.destroy({ ...provisioned, backend: "adc", physical: false });
    h.state.close();
  });

  it("releases on shutdown and reboots the same local allocation as a fresh cloud device", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    const ready = await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    const firstRequest = h.http.requests[0]?.body;
    await h.driver.shutdown({ ...ready, backend: "adc", physical: false });
    const stopped = await h.driver.listManaged();
    expect(stopped.devices).toEqual([
      { ...ready, backend: "adc", physical: false, runState: "stopped" },
    ]);
    expect(stopped.processes).toEqual([]);
    const shutdownRequest = h.http.requests.at(-1);
    expect(shutdownRequest?.method).toBe("DELETE");
    expect(h.listeners.listeners[0]?.closed).toBe(true);
    const recoverStopped = h.driver.makeReady(device, { purpose: "recover", mode: "full" });
    await expect(recoverStopped).rejects.toThrow("cannot recover a device that was released");

    const nextLease = { ...ACTIVE, id: "lease_two" };
    h.http.answers.set(`POST ${API}/v2/leases`, { status: 201, body: nextLease });
    h.http.answers.set(`GET ${API}/v2/leases/lease_two`, { status: 200, body: nextLease });
    h.http.answers.set(`DELETE ${API}/v2/leases/lease_two`, {
      status: 200,
      body: { ...nextLease, status: "released" },
    });
    const rebooted = await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    expect(rebooted.deviceId).toBe(device.deviceId);
    expect(rebooted.address).toBe(ready.address);
    const creates = h.http.requests.filter((request) => request.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body).not.toEqual(firstRequest);
    expect(h.listeners.listeners[1]?.port).toBe(49_152);
    await h.driver.destroy(device);
    const requestsAfterDestroy = h.http.requests.length;
    await h.driver.destroy(device);
    expect(h.http.requests).toHaveLength(requestsAfterDestroy);
    const removed = await h.driver.listManaged();
    expect(removed.devices).toEqual([]);
    h.state.close();
  });

  it("recovers a lost creation response after restart by replaying the journaled activation key", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    h.http.loseNextCreationReply = true;
    const preparing = h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    await expect(preparing).rejects.toThrow("creation response was lost");
    h.supervisor.answerCommandLine(222, undefined);
    await h.driver.dispose?.();
    const restarted = await createCloudAndroidDriver(h.options);
    const observed = await restarted.listManaged();
    expect(observed.devices[0]?.runState).toBe("running");
    const creates = h.http.requests.filter((request) => request.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body).toEqual(creates[0]?.body);
    await restarted.destroy(device);
    const cleanupRequest = h.http.requests.at(-1);
    expect(cleanupRequest?.url).toBe(`${API}/v2/leases/lease_one`);
    expect(cleanupRequest?.method).toBe("DELETE");
    h.state.close();
  });

  it("keeps a four-month cloud device and refuses to replace it when recovery finds it ended", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    h.clock.advance(120 * 24 * 60 * 60 * 1_000);
    const observed = await h.driver.listManaged();
    expect(observed.devices[0]?.runState).toBe("running");
    h.http.answers.set(`GET ${API}/v2/leases/lease_one`, {
      status: 200,
      body: { ...ACTIVE, status: "released" },
    });
    const recovering = h.driver.makeReady(device, { purpose: "recover", mode: "full" });
    await expect(recovering).rejects.toThrow("lease is released");
    const creates = h.http.requests.filter((request) => request.method === "POST");
    expect(creates).toHaveLength(1);
    await h.driver.destroy(device);
    h.state.close();
  });

  it("destroys an unactivated local allocation without opening a cloud lease", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    const stopped = await h.driver.listManaged();
    expect(stopped.devices).toEqual([{ ...device, runState: "stopped" }]);
    await h.driver.destroy(device);
    const removed = await h.driver.listManaged();
    expect(removed.devices).toEqual([]);
    expect(h.http.requests).toEqual([]);
    h.state.close();
  });

  it("provisions, connects, scopes ADB, and releases an owned cloud device without local emulator tools", async () => {
    const h = await setup();
    const catalog = await h.driver.listCatalog();
    expect(catalog.modelRuntimes).toEqual({ Android: ["34"] });
    const provisioned = await h.driver.provision(h.spec);
    expect(h.http.requests).toEqual([]);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    const ready = await h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    expect(ready.address).toBe(SERIAL);
    expect(h.http.requests[0]?.body).toEqual({
      name: `simlock-${device.deviceId}`,
      purpose: "development",
      idempotency_key: expect.any(String),
    });
    const passthrough = await h.driver.passthrough?.(
      "adb",
      { ...ready, backend: "adc", physical: false },
      ["shell", "id"],
      { hasTerminal: false },
    );
    expect(passthrough).toEqual({
      command: "adb",
      args: ["-P", "5039", "-s", SERIAL, "shell", "id"],
      env: { ANDROID_ADB_SERVER_PORT: "5039" },
    });
    const connects = h.runner.calls.filter((call) => call.args[2] === "connect");
    expect(connects).toHaveLength(1);
    expect(connects[0]?.options.env?.ADC_API_KEY).toBeUndefined();
    await h.driver.destroy({ ...ready, backend: "adc", physical: false });
    const releaseRequest = h.http.requests.at(-1);
    expect(releaseRequest?.method).toBe("DELETE");
    expect(h.listeners.listeners[0]?.closed).toBe(true);
    const observed = await h.driver.listManaged();
    expect(observed.devices).toEqual([]);
    h.state.close();
  });

  it("restores only its recorded cloud leases after restart and treats an API outage as unreadable", async () => {
    const h = await setup();
    const device = await h.driver.provision(h.spec);
    const ready = await h.driver.makeReady(
      { ...device, backend: "adc", physical: false },
      { purpose: "prepare", mode: "full" },
    );
    h.supervisor.answerCommandLine(222, undefined);
    await h.driver.dispose?.();
    const restarted = await createCloudAndroidDriver(h.options);
    const observed = await restarted.listManaged();
    expect(observed.devices).toEqual([
      { ...ready, backend: "adc", physical: false, address: SERIAL, runState: "running" },
    ]);
    const getUrls = h.http.requests.filter((request) => request.method === "GET");
    const allScoped = getUrls.every((request) => request.url === `${API}/v2/leases/lease_one`);
    expect(allScoped).toBe(true);
    h.http.answers.set(`GET ${API}/v2/leases/lease_one`, {
      status: 503,
      body: { detail: "node unavailable" },
    });
    const unreadable = restarted.listManaged();
    await expect(unreadable).rejects.toThrow("HTTP 503");
    const restore = { status: 200, body: ACTIVE };
    h.http.answers.set(`GET ${API}/v2/leases/lease_one`, restore);
    const stillPresent = await restarted.listManaged();
    expect(stillPresent.devices).toHaveLength(1);
    await restarted.destroy({ ...device, backend: "adc", physical: false });
    h.state.close();
  });

  it("observes offline ADB and reconnects the same cloud lease on its saved local port", async () => {
    const h = await setup();
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
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
      (request) => request.method === "POST" && request.url === `${API}/v2/leases`,
    );
    expect(creates).toHaveLength(1);
    const restored = await h.driver.listManaged();
    expect(restored.devices[0]?.runState).toBe("running");
    await h.driver.destroy(device);
    h.state.close();
  });

  it("bounds a queued provisioning wait and leaves its allocation available for release", async () => {
    const h = await setup({ provisionTimeoutMs: 1_000 });
    const queued = { ...ACTIVE, status: "queued" };
    h.http.answers.set(`POST ${API}/v2/leases`, { status: 202, body: queued });
    h.http.answers.set(`GET ${API}/v2/leases/lease_one`, { status: 200, body: queued });
    const provisioned = await h.driver.provision(h.spec);
    const device = { ...provisioned, backend: "adc", physical: false as const };
    const waiting = h.driver.makeReady(device, { purpose: "prepare", mode: "full" });
    const outcome = promiseState(waiting);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    h.clock.advance(1_000);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(outcome.state).toBe("rejected");
    await expect(waiting).rejects.toThrow("provisioning timed out");
    await h.driver.destroy(device);
    const cancellationRequest = h.http.requests.at(-1);
    expect(cancellationRequest?.method).toBe("DELETE");
    h.state.close();
  });

  it("refuses unsupported models, image selection, baselines, raw ADB tunnels, and foreign allocations", async () => {
    const h = await setup();
    const valid = h.driver.resolveSpec({ platform: "android", model: "Android", osVersion: "34" });
    await expect(valid).resolves.toEqual(h.spec);
    const model = h.driver.resolveSpec({ platform: "android", model: "Pixel 9" });
    await expect(model).rejects.toThrow("Unknown android model");
    const image = h.driver.resolveSpec({
      platform: "android",
      model: "Android",
      imageTag: "google_apis",
    });
    await expect(image).rejects.toThrow("imageTag");
    const runtime = h.driver.resolveSpec({
      platform: "android",
      model: "Android",
      osVersion: "35",
    });
    await expect(runtime).rejects.toThrow("Runtime missing");
    const baseline = h.driver.provision(h.spec, { source: "baseline" });
    await expect(baseline).rejects.toThrow("saved baselines");
    const provisioned = await h.driver.provision(h.spec);
    const owned = { ...provisioned, backend: "adc", physical: false as const };
    const rawSupported = h.driver.deviceTcp?.supportsEmulatorPort?.(owned);
    expect(rawSupported).toBe(false);
    const foreign = { ...owned, deviceId: "foreign", driverData: { allocationId: "foreign" } };
    const requestCount = h.http.requests.length;
    const bootForeign = h.driver.makeReady(foreign, { purpose: "prepare", mode: "full" });
    await expect(bootForeign).rejects.toThrow("not owned by this worker");
    expect(h.http.requests).toHaveLength(requestCount);
    await h.driver.destroy(owned);
    h.state.close();
  });
});
