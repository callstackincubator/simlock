import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import {
  ANDROID,
  FIRST_SNAPSHOT,
  IOS,
  assertPinnedAgentDevice,
  cleanupAgents,
  failureText,
  freeLoopbackPort,
  hasIosRuntime,
  listDevices,
  listLeases,
  makeAgent,
  newAgentToken,
  ok,
  progress,
  setLimits,
  succeeds,
  waitFor,
  waitForFree,
  warmUp,
  withSharedDaemon,
  type Agent,
  type SharedTestEnv,
  type Target,
} from "./helpers/index.js";

const AGENT_DEVICE = process.env.SIMLOCK_E2E_AGENT_DEVICE;

const iosAvailable = hasIosRuntime();
const androidAvailable = succeeds("sh", ["-c", "command -v emulator && command -v adb"]);

const NO_WORKER = "no worker connected to this gateway can serve agent-device";

interface WorkerView {
  readonly connection: string;
  readonly capacity?: Readonly<Record<string, { readonly limit: number }>>;
  readonly capabilities?: readonly { readonly name: string; readonly state: string }[];
}

const GIB = 1024 ** 3;
const CHUNK = 1024 * 1024;

// why: AES in counter mode over zeros gives a 1 GiB body that needs no file on disk: each leg regenerates the same bytes chunk by chunk.
function* uploadChunks(): Generator<Buffer> {
  const cipher = createCipheriv("aes-128-ctr", Buffer.alloc(16, 7), Buffer.alloc(16));
  const zeros = Buffer.alloc(CHUNK);
  for (let offset = 0; offset < GIB; offset += CHUNK) yield cipher.update(zeros);
}

const uploadStream = (): ReadableStream<Uint8Array> => {
  const chunks = uploadChunks();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(new Uint8Array(next.value));
    },
  });
};

function uploadDigest(): string {
  const hash = createHash("sha256");
  for (const chunk of uploadChunks()) hash.update(chunk);
  return hash.digest("hex");
}

const sharedEnvs = new Set<SharedTestEnv>();
afterAll(async () => {
  await Promise.allSettled([...sharedEnvs].map((env) => env.teardown()));
  sharedEnvs.clear();
}, 120_000);

function defineSuite(target: Target): void {
  const platform = target.platform;
  let gateway: SharedTestEnv;
  let worker: SharedTestEnv;
  const restores: (() => Promise<void>)[] = [];

  const agent = (name: string): Promise<Agent> => makeAgent(gateway, name);
  // why: an open that fails answers within seconds, so it ends the test there instead of leaving the test to wait on a lease nobody holds.
  const open = async (who: Agent) => {
    const result = await who.run(["open", "--platform", platform], { timeout: 330_000 });
    if (result.code !== 0) {
      throw new Error(`open failed for ${who.name}: ${result.stdout}\n${result.stderr}`);
    }
    return result;
  };

  async function workerView(): Promise<WorkerView | undefined> {
    const listed = await gateway.cli(["worker", "list", "--json"], { timeout: 60_000 });
    expect(listed.code, `simlock worker list: ${listed.stderr}`).toBe(0);
    return (listed.json as { workers: WorkerView[] }).workers[0];
  }

  async function waitForWorker(
    label: string,
    expected: (view: WorkerView) => boolean,
    timeout: number,
  ): Promise<void> {
    let observed = "no worker listed";
    await waitFor(
      async () => {
        const view = await workerView();
        observed = JSON.stringify(view ?? null);
        return view !== undefined && expected(view);
      },
      { timeout, interval: 1_000, label: () => `${label}; last observed: ${observed}` },
    );
  }

  const agentDeviceState = (view: WorkerView): string | undefined =>
    view.capabilities?.find((entry) => entry.name === "agent-device")?.state;

  const waitForAvailable = () =>
    waitForWorker(
      "the gateway's worker list shows the worker connected with agent-device available",
      (view) => view.connection === "connected" && agentDeviceState(view) === "available",
      120_000,
    );

  // why: the test edits one daemon's config and restarts it; afterEach puts the original text back, so a failing test cannot leave the next one on a changed config.
  async function changeConfig(
    daemon: SharedTestEnv,
    change: (config: Record<string, Record<string, unknown>>) => void,
  ): Promise<void> {
    const original = await readFile(daemon.configPath, "utf8");
    restores.push(async () => {
      await writeFile(daemon.configPath, original, "utf8");
      await daemon.restart();
    });
    const config = JSON.parse(original) as Record<string, Record<string, unknown>>;
    change(config);
    await writeFile(daemon.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await daemon.restart();
  }

  beforeAll(async () => {
    const pinned = await assertPinnedAgentDevice(platform);
    const gatewayPort = await freeLoopbackPort();
    gateway = await withSharedDaemon({
      driver: "none",
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: gatewayPort },
        capabilities: { "agent-device": { enabled: true } },
      },
      role: "gateway",
    });
    sharedEnvs.add(gateway);
    const minted = await gateway.cli(["token", "create", "--role", "worker"], { timeout: 60_000 });
    expect(minted.code, minted.stderr).toBe(0);
    const { secret } = minted.json as { secret: string };

    worker = await withSharedDaemon({
      driver: "real",
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
        gateway: { label: "worker", token: secret, url: `ws://127.0.0.1:${gatewayPort}` },
        capabilities: { "agent-device": { enabled: true, command: pinned } },
        capacity: {
          config: { limits: { [platform]: { maxDevices: 1, maxRunning: 1 } } },
        },
      },
    });
    sharedEnvs.add(worker);
    await waitForAvailable();
    await warmUp(worker, target, 1);
  }, 420_000);

  afterAll(async () => {
    await Promise.allSettled([worker?.teardown(), gateway?.teardown()]);
    sharedEnvs.delete(worker);
    sharedEnvs.delete(gateway);
  }, 120_000);

  beforeEach((context) => {
    progress(`START ${platform} gateway: ${context.task.name.slice(0, 100)}`);
  });

  afterEach((context) => {
    progress(
      `END ${platform} gateway (${context.task.result?.state ?? "unknown"}): ${context.task.name.slice(0, 100)}`,
    );
  });

  afterEach(async () => {
    await cleanupAgents();
    for (const restore of restores.splice(0).reverse()) await restore();
    await waitForAvailable();
    const released = await gateway.cli(["release", "--all", "--yes"], { timeout: 60_000 });
    expect(released.code, released.stderr).toBe(0);
    await waitForFree(worker);
  }, 420_000);

  it(
    "through the gateway, an agent opens a device, installs the Appduct fixture app as an upload, opens it, takes a snapshot that shows tab-status, saves a PNG screenshot and closes; the device is free within 240 s and the lease is gone from the gateway's simlock list within 240 s",
    { timeout: 600_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      expect(await listLeases(gateway)).toHaveLength(1);
      ok(await a.run(["install", "Appduct", target.app]));
      ok(await a.run(["open", target.bundleId]));
      const snapshot = await a.run(["snapshot"], FIRST_SNAPSHOT);
      ok(snapshot);
      expect(snapshot.stdout).toContain("tab-status");
      const dir = await mkdtemp(join(tmpdir(), "simlock-ad-gw-shot-"));
      onTestFinished(() => rm(dir, { force: true, recursive: true }));
      const png = join(dir, "shot.png");
      ok(await a.run(["screenshot", png]));
      expect((await readFile(png)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      ok(await a.run(["close"]));
      await waitForFree(worker);
      await waitFor(async () => (await listLeases(gateway)).length === 0, {
        timeout: 240_000,
        interval: 1_000,
        label: "the lease is gone from the gateway's simlock list",
      });
    },
  );

  it(
    "with capabilities.agent-device.enabled unset on the gateway, its /v1/agent-device/health answers 404 where it answered something else while enabled",
    { timeout: 600_000 },
    async () => {
      const probe = await newAgentToken(gateway);
      const healthUrl = `http://127.0.0.1:${String(gateway.httpPort)}/v1/agent-device/health`;
      const headers = { authorization: `Bearer ${probe.secret}` };
      expect((await fetch(healthUrl, { headers })).status, "health while enabled").not.toBe(404);
      await changeConfig(gateway, (config) => {
        delete config["capabilities"]?.["agent-device"];
      });
      await waitForWorker(
        "the gateway's worker list shows the worker connected again",
        (view) => view.connection === "connected",
        120_000,
      );
      expect((await fetch(healthUrl, { headers })).status).toBe(404);
    },
  );

  it(
    "with the worker's capabilities.agent-device.enabled unset (the gateway's simlock worker list shows agent-device off), open through the gateway fails within 5 s with a message containing `no worker connected to this gateway can serve agent-device`, and no lease is made",
    { timeout: 600_000 },
    async () => {
      await changeConfig(worker, (config) => {
        delete config["capabilities"]?.["agent-device"];
      });
      await waitForWorker(
        "the gateway's worker list shows the worker connected with agent-device off",
        (view) => view.connection === "connected" && agentDeviceState(view) === "off",
        120_000,
      );
      const a = await agent("a");
      const startedAt = Date.now();
      const result = await a.run(["open", "--platform", platform], { timeout: 5_000 });
      expect(Date.now() - startedAt, "open took longer than 5 s").toBeLessThan(5_000);
      expect(result.code, "open was accepted").not.toBe(0);
      expect(failureText(result)).toContain(NO_WORKER);
      expect(await listLeases(gateway)).toEqual([]);
      expect(await listLeases(worker)).toEqual([]);
    },
  );

  it(
    "simlock worker list on the gateway shows the worker with agent-device available",
    { timeout: 600_000 },
    async () => {
      const listed = await gateway.cli(["worker", "list"], { timeout: 60_000 });
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stdout).toMatch(/^\S+ \(worker\): connected .* -- agent-device available$/m);
    },
  );

  // why: the preflight, the direct PUT and the finalize are what agent-device does for an upload; the time runs from the preflight to the finalize answer.
  async function timedUpload(
    baseUrl: string,
    token: string,
    leaseId: string,
    sha256: string,
  ): Promise<number> {
    const headers = {
      authorization: `Bearer ${token}`,
      "x-agent-device-lease-id": leaseId,
      "x-agent-device-token": token,
    };
    const started = performance.now();
    const preflight = await fetch(`${baseUrl}/upload/preflight`, {
      body: JSON.stringify({
        artifactType: "file",
        fileName: "payload.bin",
        sha256,
        sizeBytes: GIB,
        uploadAttemptId: randomUUID(),
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
    expect(preflight.status, "preflight").toBe(200);
    const ticket = (await preflight.json()) as {
      uploadId: string;
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await fetch(ticket.upload.url, {
      body: uploadStream(),
      duplex: "half",
      headers: { ...ticket.upload.headers, "x-agent-device-lease-id": leaseId },
      method: "PUT",
    } as RequestInit);
    expect(put.status, "direct upload").toBe(200);
    await put.arrayBuffer();
    const finalize = await fetch(`${baseUrl}/upload/finalize`, {
      body: JSON.stringify({ uploadId: ticket.uploadId }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
    expect(finalize.status, "finalize").toBe(200);
    await finalize.arrayBuffer();
    return performance.now() - started;
  }

  it.runIf(platform === "ios")(
    "a 1 GiB upload takes at most 1.5 times as long through the gateway as straight to the worker",
    { timeout: 1_800_000 },
    async () => {
      const sha256 = uploadDigest();
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
      const runs = async (who: Agent, env: SharedTestEnv) => {
        ok(await open(who));
        const [lease] = await listLeases(env);
        expect(lease, "the opened lease").toBeDefined();
        const base = `http://127.0.0.1:${String(env.httpPort)}/v1/agent-device`;
        const times: number[] = [];
        for (let run = 0; run < 3; run += 1) {
          times.push(await timedUpload(base, who.token, (lease as { id: string }).id, sha256));
        }
        ok(await who.run(["close"]));
        await waitForFree(worker);
        await waitFor(async () => (await listLeases(gateway)).length === 0, {
          timeout: 240_000,
          interval: 1_000,
          label: "the lease is gone from the gateway's simlock list",
        });
        return median(times);
      };

      const direct = await runs(await makeAgent(worker, "direct"), worker);
      const through = await runs(await agent("gateway"), gateway);

      expect(
        through / direct,
        `gateway ${String(through)} ms, worker ${String(direct)} ms`,
      ).toBeLessThanOrEqual(1.5);
    },
  );

  describe("with the device limit raised to 2", () => {
    const waitForCapacity = (limit: number) =>
      waitForWorker(
        `the gateway's worker list shows the worker available with capacity ${String(limit)}`,
        (view) =>
          view.connection === "connected" &&
          agentDeviceState(view) === "available" &&
          view.capacity?.[platform]?.limit === limit,
        420_000,
      );

    beforeAll(async () => {
      await setLimits(worker, target, 2);
      await warmUp(worker, target, 2);
      await waitForCapacity(2);
    }, 600_000);

    afterAll(async () => {
      await setLimits(worker, target, 1);
      await waitForCapacity(1);
    }, 420_000);

    it(
      "with the device limit raised to 2 and two devices ready, agent-device devices through the gateway after open lists exactly the agent's device",
      { timeout: 600_000 },
      async () => {
        const a = await agent("a");
        expect(
          (await listDevices(worker)).filter((device) => device.state === "ready"),
        ).toHaveLength(2);
        ok(await open(a));
        // why: the lease runs on the worker, so the device's address comes from the worker that owns it.
        const [lease] = await listLeases(worker);
        const bound = (await listDevices(worker)).find((device) => device.id === lease?.deviceId);
        const listed = await a.run(["devices"]);
        ok(listed);
        const devices = (listed.data as { devices?: { id: string }[] } | undefined)?.devices ?? [];
        expect(devices.map((device) => device.id)).toEqual([bound?.address]);
      },
    );
  });
}

describe.skipIf(AGENT_DEVICE === undefined || !iosAvailable)(
  "agent-device through a gateway (iOS)",
  { tags: ["slow", "ios"] },
  () => defineSuite(IOS),
);

describe.skipIf(AGENT_DEVICE === undefined || !androidAvailable)(
  "agent-device through a gateway (Android)",
  { tags: ["slow", "android"] },
  () => defineSuite(ANDROID),
);
