import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

/** Where a `withDaemon` env's Simlock keeps its iOS devices: its own device set (ADR 0001). */
export function iosDeviceSet(home: string): string {
  return join(home, "devices", "ios");
}

/**
 * `xcrun simctl --set <deviceSet> ...args`. Every simctl call against a Simlock device carries
 * `--set`, exactly as the driver's do: a device in a custom set is not addressable, or even
 * listable, without it.
 */
export async function simctlInSet(
  deviceSet: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<{ readonly stdout: string }> {
  return execFileAsync("xcrun", ["simctl", "--set", deviceSet, ...args], {
    timeout: options.timeoutMs ?? 0,
  });
}

/**
 * Per call while emptying a set. Teardown runs inside a 60s hook that already spends up to
 * ~25s stopping the daemon, so a hung simctl must give up rather than eat the rest of it --
 * the home's removal comes after.
 */
const EMPTY_SET_CALL_TIMEOUT_MS = 15_000;

/** Devices in one device set. */
export async function setDevices(
  deviceSet: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<SimctlDevice[]> {
  const { stdout } = await simctlInSet(deviceSet, ["list", "devices", "-j"], options);
  const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices).flat();
}

/**
 * Everything in the set, by membership rather than by name: the set is Simlock's own, so
 * nothing else can be in it, and CoreSimulator has to be told to forget these devices
 * before the temporary home holding them is removed.
 *
 * Shut down first, always. `simctl delete` refuses a booted device, and this runs on the
 * failure path too -- a `waitFor` that gave up leaves devices booted -- so deleting
 * without shutting down would leave a running `launchd_sim` attached to a set directory
 * that `withDaemon`'s teardown is about to remove recursively, and still writing into it
 * while it does (`ENOTEMPTY`).
 *
 * Devices are handled in parallel and every call is bounded, so emptying a set of any size
 * takes at most two `EMPTY_SET_CALL_TIMEOUT_MS`.
 */
export async function emptyDeviceSet(deviceSet: string): Promise<void> {
  const bounded = { timeoutMs: EMPTY_SET_CALL_TIMEOUT_MS };
  const devices = await setDevices(deviceSet, bounded).catch(() => []);
  await Promise.all(
    devices.map(async (device) => {
      await simctlInSet(deviceSet, ["shutdown", device.udid], bounded).catch(() => undefined);
      await simctlInSet(deviceSet, ["delete", device.udid], bounded).catch(() => undefined);
    }),
  );
}

/** Older than any run of a real-simctl lane can be. */
const STALE_SET_AGE_MS = 60 * 60 * 1000;

/**
 * Device sets left behind by a run that died before its own cleanup -- a killed vitest, a
 * crashed machine. Nothing else reclaims them now that the set lives inside a per-test
 * temporary home instead of the shared default set the old prefix sweep covered, so the
 * tens of gigabytes each holds would sit in `$TMPDIR` forever. Age-gated rather than
 * scoped to this run so it can never sweep a set out from under a live one, including a
 * sibling running in parallel.
 */
export async function sweepStaleDeviceSets(): Promise<void> {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("simlock-e2e-")) continue;
    const deviceSet = iosDeviceSet(join(tmpdir(), entry.name));
    const details = await stat(deviceSet).catch(() => undefined);
    if (details === undefined || Date.now() - details.mtimeMs < STALE_SET_AGE_MS) continue;
    await emptyDeviceSet(deviceSet);
    await rm(deviceSet, { force: true, recursive: true });
  }
}

/**
 * Host processes whose command line names a path inside `deviceSet`. A booted simulator runs a
 * `launchd_sim` (and its children) out of its device directory, so a non-empty result means a
 * simulator of that set is still running -- even after the set's directory is gone, which
 * `simctl --set` alone can no longer see. `$TMPDIR` lives under `/var`, a symlink to
 * `/private/var`, so the match drops that prefix: it then holds for either spelling.
 */
export async function processesInDeviceSet(deviceSet: string): Promise<string[]> {
  const needle = `${deviceSet.replace(/^\/private(?=\/)/, "")}/`;
  const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.includes(needle));
}
