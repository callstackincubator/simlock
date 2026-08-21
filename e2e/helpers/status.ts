import type { TestEnv } from "./env.js";
import { waitFor } from "./wait.js";

interface DeviceRecord {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly state: string;
  readonly [key: string]: unknown;
}

interface LeaseRecord {
  readonly id: string;
  readonly requesterId: string;
  readonly [key: string]: unknown;
}

async function listDevices(env: TestEnv): Promise<DeviceRecord[]> {
  const result = await env.cli(["list", "--devices"]);
  if (result.code !== 0) throw new Error(`simlock list --devices failed: ${result.stderr}`);
  return result.json as DeviceRecord[];
}

async function listLeases(env: TestEnv): Promise<LeaseRecord[]> {
  const result = await env.cli(["list", "--leases"]);
  if (result.code !== 0) throw new Error(`simlock list --leases failed: ${result.stderr}`);
  return result.json as LeaseRecord[];
}

/**
 * Polls `simlock list --devices` until the device identified by `driverDeviceId`
 * (the driver-opaque id -- what a lease grant reports as `udid`/`device_id`, *not*
 * simlock's own registry device id) reaches `state`.
 */
export async function waitForDeviceState(
  env: TestEnv,
  driverDeviceId: string,
  state: string,
  options: { readonly timeout?: number } = {},
): Promise<void> {
  await waitFor(
    async () =>
      (await listDevices(env)).some(
        (device) => device.driverDeviceId === driverDeviceId && device.state === state,
      ),
    {
      timeout: options.timeout ?? 30_000,
      label: `device ${driverDeviceId} reaches state ${state}`,
    },
  );
}

/** Polls `simlock list --leases` until exactly `count` leases are active. */
export async function waitForLeaseCount(
  env: TestEnv,
  count: number,
  options: { readonly timeout?: number } = {},
): Promise<LeaseRecord[]> {
  let leases: LeaseRecord[] = [];
  await waitFor(
    async () => {
      leases = await listLeases(env);
      return leases.length === count;
    },
    { timeout: options.timeout ?? 30_000, label: `lease count reaches ${count}` },
  );
  return leases;
}
