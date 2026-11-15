import type { DeviceRequest } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkOptions, type SimlockDevicesOptions } from "./options.js";
import { createProvider } from "./provider.js";

type Factory = typeof createAgentDeviceClient;
type Method = "allocate" | "heartbeat" | "release" | "install";
type Handler = (options: Record<string, unknown>, nth: number) => unknown;

interface Call {
  readonly method: Method;
  readonly config: Record<string, unknown>;
  readonly options: Record<string, unknown>;
}

const IOS_KEY = "ios:mobile:6B1E0000-AAAA-BBBB-CCCC-000000000001";
const ANDROID_KEY = "android:mobile:emulator-5554";

function grant(options: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    leaseId: options["leaseId"],
    tenantId: "tenant-of-lease",
    runId: options["runId"],
    backend: options["leaseBackend"],
    deviceKey: options["platform"] === "android" ? ANDROID_KEY : IOS_KEY,
    ...extra,
  };
}

function farm(script: Partial<Record<Method, Handler>> = {}) {
  const calls: Call[] = [];
  const counts: Record<Method, number> = { allocate: 0, heartbeat: 0, release: 0, install: 0 };
  const run = async (
    method: Method,
    config: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push({ method, config, options });
    const nth = counts[method]++;
    const handler = script[method];
    if (handler !== undefined) return handler(options, nth);
    return method === "allocate" ? grant(options) : {};
  };
  const factory = ((config: Record<string, unknown>) => ({
    leases: {
      allocate: (o: Record<string, unknown>) => run("allocate", config, o),
      heartbeat: (o: Record<string, unknown>) => run("heartbeat", config, o),
      release: (o: Record<string, unknown>) => run("release", config, o),
    },
    apps: { install: (o: Record<string, unknown>) => run("install", config, o) },
  })) as unknown as Factory;
  return {
    calls,
    load: () => Promise.resolve(factory),
    of: (method: Method) => calls.filter((call) => call.method === method),
  };
}

const GOOD = {
  url: "https://farm.example.com",
  token: "agent-token",
  platform: "ios",
  device: "iPhone 17 Pro",
} as const;

function provider(
  load: () => Promise<Factory>,
  patch: Record<string, unknown> = {},
): ReturnType<typeof createProvider> {
  return createProvider(checkOptions({ ...GOOD, ...patch } as SimlockDevicesOptions), load);
}

function request(patch: Partial<DeviceRequest> = {}): { request: DeviceRequest; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    request: {
      platform: "ios",
      runId: "0123456789abcdef-run",
      targetName: "ios",
      slot: 0,
      slots: 1,
      agentDeviceVersion: "0.21.37",
      projectRoot: "/project",
      env: {},
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
      ...patch,
    },
  };
}

// why: createProvider is the seam the spec names (I7): `simlockDevices` only adds the real agent-device loader, and a fake client here cannot be passed through index.ts.
describe("createProvider acquire", () => {
  it("asks the farm for one lease and returns a lease the worker can drive, or refuses what it cannot lease", async () => {
    const ios = farm();
    const first = request();
    const lease = await provider(ios.load).acquire(first.request);
    const [allocate] = ios.of("allocate");
    expect(allocate?.config).toMatchObject({
      daemonBaseUrl: "https://farm.example.com/v1/agent-device",
      daemonAuthToken: "agent-token",
      session: "e2e-0123456789ab-0",
    });
    expect(allocate?.options).toMatchObject({
      leaseId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      tenant: "simlock-e2e",
      runId: "0123456789abcdef-run",
      leaseBackend: "ios-instance",
      leaseProvider: "proxy",
      platform: "ios",
      target: "mobile",
      device: "iPhone 17 Pro",
      ttlMs: 180_000,
      retainOnClose: true,
    });
    for (const unset of ["osVersion", "imageTag", "deviceMode", "deviceBaseline"]) {
      expect(allocate?.options).not.toHaveProperty(unset);
    }
    const id = allocate?.options["leaseId"];
    expect(lease).toEqual({
      id,
      daemon: { baseUrl: "https://farm.example.com/v1/agent-device", authToken: "agent-token" },
      client: {
        tenant: "tenant-of-lease",
        runId: "0123456789abcdef-run",
        leaseId: id,
        leaseBackend: "ios-instance",
        leaseProvider: "proxy",
        clientId: allocate?.options["clientId"],
        deviceKey: IOS_KEY,
      },
      deviceId: "6B1E0000-AAAA-BBBB-CCCC-000000000001",
    });
    expect(first.lines).toEqual([
      expect.stringMatching(
        /^simlock: lease [0-9a-f]{32} granted in \d+ ms \(iPhone 17 Pro 6B1E0000-AAAA-BBBB-CCCC-000000000001\)$/u,
      ),
    ]);

    const android = farm();
    const droid = await provider(android.load, { platform: "android", device: "Pixel 6" }).acquire(
      request({ platform: "android" }).request,
    );
    expect(droid.deviceId).toBe("emulator-5554");
    expect(droid.client).toMatchObject({
      leaseBackend: "android-instance",
      deviceKey: ANDROID_KEY,
    });

    const tuned = farm();
    await provider(tuned.load, {
      osVersion: "26.0",
      imageTag: "google_apis",
      deviceMode: "full",
      deviceBaseline: "warm",
      ttlMs: 60_000,
    }).acquire(request().request);
    expect(tuned.of("allocate")[0]?.options).toMatchObject({
      osVersion: "26.0",
      imageTag: "google_apis",
      deviceMode: "full",
      deviceBaseline: "warm",
      ttlMs: 60_000,
    });

    const wrong = farm();
    await expect(
      provider(wrong.load).acquire(request({ platform: "android" }).request),
    ).rejects.toThrow("simlockDevices leases ios devices; the target asked for android");
    expect(wrong.calls).toEqual([]);

    const nameless = farm({
      allocate: (options) => ({ ...(grant(options) as object), deviceKey: undefined }),
    });
    await expect(provider(nameless.load).acquire(request().request)).rejects.toThrow(
      /^simlock: lease [0-9a-f]{32} names no device$/u,
    );
    const [asked] = nameless.of("allocate");
    expect(nameless.of("release").map((call) => call.options["leaseId"])).toEqual([
      asked?.options["leaseId"],
    ]);

    await expect(
      provider(() => Promise.reject(new Error("Cannot find package 'agent-device'"))).acquire(
        request().request,
      ),
    ).rejects.toThrow("simlock: the agent-device package is not installed; add it to your project");
  });
});

function failing(details: Record<string, unknown>): Error {
  return Object.assign(new Error("the farm said no"), { details });
}

const hang: Handler = (options) =>
  new Promise((_, reject) => {
    const signal = options["signal"] as AbortSignal;
    signal.addEventListener("abort", () => reject(signal.reason));
  });

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

const WAITING = "simlock: no free ios device on the farm; waiting for one";

// why: createProvider is the seam the spec names (I7); see the first describe.
describe("createProvider acquire on a full farm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits and asks again under a new lease id when the farm is full or cut the request, and throws at once on a refusal, an abort or the end of queueMs", async () => {
    for (const details of [
      { reason: "NO_DEVICE_IN_TIME", retriable: true },
      { reason: "SIMLOCK_UNAVAILABLE", retriable: true },
      { reason: "WORKER_UNREACHABLE", retriable: true },
      { reason: "daemon_response_invalid" },
      { reason: "daemon_transport_failure" },
    ]) {
      const waiting = farm({
        allocate: (options, nth) => {
          if (nth === 0) throw failing(details);
          return grant(options);
        },
      });
      const first = request();
      const pending = outcome(provider(waiting.load).acquire(first.request));
      await vi.advanceTimersByTimeAsync(15_000);
      const [one, two] = waiting.of("allocate");
      expect(await pending).toEqual({
        ok: true,
        value: expect.objectContaining({ id: two?.options["leaseId"] }),
      });
      expect(two?.options["leaseId"]).not.toBe(one?.options["leaseId"]);
      expect(waiting.of("release").map((call) => call.options["leaseId"])).toEqual([
        one?.options["leaseId"],
      ]);
      expect(first.lines.filter((line) => line === WAITING)).toHaveLength(1);
    }

    for (const details of [
      { reason: "REFUSED_BY_SIMLOCK", retriable: false },
      { reason: "UNAUTHORIZED" },
    ]) {
      const error = failing(details);
      const refused = farm({
        allocate: () => {
          throw error;
        },
      });
      expect(await outcome(provider(refused.load).acquire(request().request))).toEqual({
        ok: false,
        error,
      });
      expect(refused.of("allocate")).toHaveLength(1);
      expect(refused.of("release")).toEqual([]);
    }

    const retriable = { reason: "NO_DEVICE_IN_TIME", retriable: true };
    const interrupted = new Error("interrupted");
    const pausing = new AbortController();
    const full = farm({
      allocate: () => {
        throw failing(retriable);
      },
    });
    const inPause = outcome(
      provider(full.load).acquire(request({ signal: pausing.signal }).request),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    pausing.abort(interrupted);
    expect(await inPause).toEqual({ ok: false, error: interrupted });
    expect(full.of("allocate")).toHaveLength(1);

    const asking = new AbortController();
    const stuck = farm({ allocate: hang });
    const inAsk = outcome(provider(stuck.load).acquire(request({ signal: asking.signal }).request));
    await vi.advanceTimersByTimeAsync(0);
    asking.abort(interrupted);
    expect(await inAsk).toEqual({ ok: false, error: interrupted });
    expect(stuck.of("release").map((call) => call.options["leaseId"])).toEqual([
      stuck.of("allocate")[0]?.options["leaseId"],
    ]);

    const over = farm({ allocate: hang });
    const timedOut = outcome(provider(over.load, { queueMs: 60_000 }).acquire(request().request));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await timedOut).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "simlock: no free ios device on the farm within 1 min",
      }),
    });
    expect(over.of("release").map((call) => call.options["leaseId"])).toEqual([
      over.of("allocate")[0]?.options["leaseId"],
    ]);

    const instant = farm({
      allocate: (options, nth) => {
        if (nth < 2) throw failing(retriable);
        return grant(options);
      },
    });
    const twice = request();
    const done = outcome(provider(instant.load).acquire(twice.request));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(instant.of("allocate")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(instant.of("allocate")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await done).ok).toBe(true);
    expect(twice.lines.filter((line) => line === WAITING)).toHaveLength(1);
  });
});

const UDID = "6B1E0000-AAAA-BBBB-CCCC-000000000001";

// why: createProvider is the seam the spec names (I7); see the first describe.
describe("createProvider acquire installs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs the app and each extra app on the leased device, reports installedApp only for a named app, and runs at most installConcurrency installs at once", async () => {
    const withApp = farm();
    const named = request({ appPath: "/p/Example.app", app: "com.example.app" });
    const lease = await provider(withApp.load, { extraApps: ["/x/a.app", "/x/b.app"] }).acquire(
      named.request,
    );
    const installs = withApp.of("install");
    expect(installs.map((call) => call.options)).toEqual([
      { platform: "ios", udid: UDID, appPath: "/p/Example.app", app: "com.example.app" },
      { platform: "ios", udid: UDID, appPath: "/x/a.app" },
      { platform: "ios", udid: UDID, appPath: "/x/b.app" },
    ]);
    expect(installs[0]?.config).toMatchObject({
      daemonBaseUrl: "https://farm.example.com/v1/agent-device",
      daemonAuthToken: "agent-token",
      session: "e2e-0123456789ab-0",
      tenant: "tenant-of-lease",
      runId: "0123456789abcdef-run",
      leaseId: lease.id,
      leaseBackend: "ios-instance",
      leaseProvider: "proxy",
      deviceKey: IOS_KEY,
    });
    expect(lease.installedApp).toBe("com.example.app");
    expect(named.lines.slice(1)).toEqual([
      expect.stringMatching(/^simlock: installed com\.example\.app in \d+ ms$/u),
      expect.stringMatching(/^simlock: installed \/x\/a\.app in \d+ ms$/u),
      expect.stringMatching(/^simlock: installed \/x\/b\.app in \d+ ms$/u),
    ]);

    const unnamed = farm();
    const bare = await provider(unnamed.load).acquire(
      request({ appPath: "/p/Example.app" }).request,
    );
    expect(unnamed.of("install").map((call) => call.options)).toEqual([
      { platform: "ios", udid: UDID, appPath: "/p/Example.app" },
    ]);
    expect(bare).not.toHaveProperty("installedApp");

    const extrasOnly = farm();
    const droid = await provider(extrasOnly.load, {
      platform: "android",
      extraApps: ["/x/a.apk"],
    }).acquire(request({ platform: "android" }).request);
    expect(extrasOnly.of("install").map((call) => call.options)).toEqual([
      { platform: "android", serial: "emulator-5554", appPath: "/x/a.apk" },
    ]);
    expect(droid).not.toHaveProperty("installedApp");

    let running = 0;
    let most = 0;
    const slow = farm({
      install: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        running -= 1;
      },
    });
    const limited = provider(slow.load, { installConcurrency: 3 });
    const slots = [0, 1, 2, 3, 4].map((slot) =>
      limited.acquire(request({ slot, slots: 5, appPath: "/p/Example.app" }).request),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await Promise.all(slots)).toHaveLength(5);
    expect(slow.of("install")).toHaveLength(5);
    expect(most).toBe(3);
  });

  it("sends an install again to the same device when simlock gave no answer or said retriable, at most three tries", async () => {
    const cuts = [
      failing({ reason: "daemon_transport_failure" }),
      failing({ retriable: true, reason: "SIMLOCK_UNAVAILABLE" }),
      new Error("Invalid upload response: error code: 524"),
    ];
    for (const cut of cuts) {
      const once = farm({
        install: (_options, nth) => {
          if (nth === 0) throw cut;
          return {};
        },
      });
      const pending = outcome(
        provider(once.load).acquire(request({ appPath: "/p/Example.app" }).request),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({
        ok: true,
        value: expect.objectContaining({ deviceId: UDID }),
      });
      expect(once.of("allocate")).toHaveLength(1);
      expect(once.of("install").map((call) => call.options["udid"])).toEqual([UDID, UDID]);
    }

    const last = failing({ reason: "daemon_response_invalid" });
    const always = farm({
      install: () => {
        throw last;
      },
    });
    const failed = outcome(
      provider(always.load).acquire(request({ appPath: "/p/Example.app" }).request),
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await failed).toEqual({ ok: false, error: last });
    expect(always.of("install")).toHaveLength(3);
    expect(always.of("allocate")).toHaveLength(1);
  });
});
