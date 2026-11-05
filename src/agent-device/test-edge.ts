import { expect } from "vitest";

import { FakeDriver } from "../core/testing.js";
import {
  scope,
  adminSession,
  type SetUpOptions,
  type Rig,
  sleep,
  setUp,
  type SendOptions,
  rpc,
  hex,
  command,
  leases,
  receivedAllocate,
  runCommand,
} from "./test-support.js";

export const phoneSerial = "R58Y61A60HN";

// why: one Android driver serving a virtual Pixel 8 and an enrolled, present phone, so a test can lease either through the same worker.
export async function setUpWithPhone(options: SetUpOptions = {}): Promise<Rig> {
  const rig = await setUp({
    ...options,
    drivers: (clock) => [
      new FakeDriver({
        availableOsVersions: ["35"],
        clock,
        defaultModels: { phone: ["Pixel 8"] },
        knownModels: ["Pixel 8"],
        modelClasses: { "Pixel 8": "phone" },
        physicalDevices: [
          { class: "phone", ids: [phoneSerial], model: "Pixel 8", osVersion: "15" },
        ],
        platform: "android",
      }),
    ],
  });
  await rig.daemon.dispatch("device.add", { id: phoneSerial, platform: "android" }, adminSession);
  rig.driver.setPhysicalPresence(phoneSerial, true);
  return rig;
}

export async function advance(rig: Rig, ms: number, step = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    rig.clock.advance(Math.min(step, ms - elapsed));
    await sleep(3);
  }
}

export function release(
  rig: Rig,
  n: number,
  options: Omit<SendOptions, "body"> = {},
): Promise<Response> {
  return rpc(rig, "agent_device.lease.release", { ...scope, leaseId: hex(n) }, options);
}

export async function devices(rig: Rig): Promise<
  readonly {
    readonly id: string;
    readonly state: string;
    readonly address?: string;
    readonly driverDeviceId?: string;
  }[]
> {
  return (await rig.daemon.dispatch("list.get", { kind: "devices" }, adminSession)) as never;
}

// why: a released device is deleted and its record stays listed, so only live devices count.
export async function liveStates(rig: Rig): Promise<readonly string[]> {
  return (await devices(rig)).map((device) => device.state).filter((state) => state !== "deleted");
}

export async function grantedDevice(rig: Rig) {
  const [device] = await devices(rig);
  expect(device?.address).toBeDefined();
  return device as { readonly address: string; readonly driverDeviceId?: string };
}

export function track<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly promise: Promise<T>;
} {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  return { done: () => settled, promise: tracked };
}

export async function listed(rig: Rig): Promise<readonly string[]> {
  return (await leases(rig)).map((lease) => lease.id);
}

export type RawDispatch = (operation: string, input: unknown, session: unknown) => Promise<unknown>;

export interface DispatchTap {
  readonly operations: string[];
  rejectNext(operation: string): void;
  afterNext(operation: string, run: () => Promise<void>): void;
}

// why: the front reaches simlock through `daemon.dispatch` looked up at call time, so a wrapper on the daemon object sits between the front and leasing.
export function tapDispatch(rig: Rig): DispatchTap {
  const daemon = rig.daemon as unknown as { dispatch: RawDispatch };
  const original = daemon.dispatch.bind(daemon);
  const operations: string[] = [];
  const rejections = new Set<string>();
  const afters = new Map<string, () => Promise<void>>();
  daemon.dispatch = async (operation, input, session) => {
    operations.push(operation);
    if (rejections.delete(operation)) throw new Error("simlock could not do that");
    const result = await original(operation, input, session);
    const after = afters.get(operation);
    afters.delete(operation);
    await after?.();
    return result;
  };
  return {
    afterNext: (operation, run) => afters.set(operation, run),
    operations,
    rejectNext: (operation) => rejections.add(operation),
  };
}

export async function runningCommand(rig: Rig, n: number, options: Omit<SendOptions, "body"> = {}) {
  rig.fake.holdCommand();
  const before = rig.fake.rpcRequests("agent_device.command").length;
  const running = track(command(rig, "snapshot", n, options));
  await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(before + 1);
  return running;
}

export const simlockPicks = "refused: simlock picks the device";

export function idOf(rig: Rig, n: number): string {
  const params = receivedAllocate(rig, n);
  return String(params["udid"] ?? params["serial"]);
}

export function batch(rig: Rig, n: number | undefined, steps: readonly Record<string, unknown>[]) {
  return runCommand(rig, "batch", n, { flags: { batchSteps: steps } });
}
