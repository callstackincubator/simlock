import type { DeviceRequest } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";
import { describe, expect, it } from "vitest";

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
  it("leases one device from the farm and returns the lease the worker drives", async () => {
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
  });
});
