import { expect } from "vitest";

import type { FakeDriverRefusalReason, ScriptedPhysicalDevice } from "./fake-driver/types.js";
import { type TestEnv, waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";

export const UDID = "00008110-001A2B3C4D5E";

export const ALIAS = "7A1C0E52-6B7D-4F1E-9C1A-2D3E4F5A6B7C";

export const APPS = Array.from({ length: 12 }, (_, index) => `com.example.app${String(index)}`);

export const IPHONE: ScriptedPhysicalDevice = {
  apps: APPS,
  class: "phone",
  ids: [UDID, ALIAS],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};

export const PIXEL: ScriptedPhysicalDevice = {
  apps: ["com.example.mail"],
  class: "phone",
  ids: ["R58M123ABC"],
  model: "Pixel 9",
  osVersion: "15",
};

export const IOS_BASE = {
  availableOsVersions: ["18.4"],
  defaultModels: { phone: ["iPhone 16"] },
  knownModels: ["iPhone 16", "iPhone 15 Pro"],
  modelClasses: { "iPhone 15 Pro": "phone", "iPhone 16": "phone" },
} as const;

export const ANDROID_BASE = {
  availableOsVersions: ["35"],
  defaultModels: { phone: ["Pixel 9"] },
  knownModels: ["Pixel 9"],
  modelClasses: { "Pixel 9": "phone" },
} as const;

export interface Row {
  readonly id: string;
  readonly driverDeviceId?: string;
  readonly state: string;
  readonly physical: boolean;
  readonly class?: string;
  readonly workerId?: string;
  readonly spec: { readonly model: string; readonly platform: string; readonly osVersion: string };
}

export interface Added {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly platform: string;
  readonly model: string;
  readonly osVersion: string;
  readonly class: string;
  readonly appCount: number;
  readonly reenrolled: boolean;
}

export async function startDaemon(
  options: {
    readonly ios?: Record<string, unknown>;
    readonly android?: Record<string, unknown>;
    readonly platforms?: readonly ("ios" | "android")[];
    readonly http?: number;
  } = {},
): Promise<TestEnv> {
  return withDaemon(daemonOptions(options));
}

export function daemonOptions(options: Parameters<typeof startDaemon>[0] = {}) {
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

export async function rows(env: TestEnv): Promise<Row[]> {
  const result = await env.cli(["list", "--devices"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Row[];
}

export async function inspectCalls(env: TestEnv): Promise<readonly unknown[]> {
  return (await env.driverLog.calls()).filter((call) => call.operation === "inspectPhysical");
}

export async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

export async function add(env: TestEnv, platform: string, id: string): Promise<Added> {
  const result = await env.cli(["device", "add", "--platform", platform, id, "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Added;
}

export async function leaseGrant(
  env: TestEnv,
  platform: string,
  agent: string,
): Promise<{ device: { driverDeviceId: string; address: string } }> {
  const result = await env.cli(["lease", "--platform", platform, "--agent-id", agent, "--detach"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as { device: { driverDeviceId: string; address: string } };
}

export interface HttpDaemon {
  readonly env: TestEnv;
  readonly base: string;
}

export async function httpDaemon(options: {
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

export async function bearer(
  env: TestEnv,
  role: "agent" | "operator",
): Promise<Record<string, string>> {
  const created = await env.cli(["token", "create", "--role", role]);
  expect(created.code, created.stderr).toBe(0);
  return {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
}

export function refused(
  device: ScriptedPhysicalDevice,
  reason: FakeDriverRefusalReason,
): ScriptedPhysicalDevice {
  return { ...device, refusal: { message: `scripted ${reason} for ${device.ids[0]}`, reason } };
}
