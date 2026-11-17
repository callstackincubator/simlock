import type { ProcessResult } from "../../ports/index.js";

const COMMAND_TIMEOUT_MS = 30_000;
const VOLUME_STATE_KEY = "com.apple.springboard.volumestate";
const DEVICEHUB_BUNDLE_ID = "com.apple.dt.Devices";
const SIMULATOR_APP_BUNDLE_ID = "com.apple.iphonesimulator";

export type ProcessOutcome =
  | { readonly kind: "finished"; readonly result: ProcessResult }
  | { readonly kind: "timed-out" };

export interface SilenceFailedFact {
  readonly deviceId: string;
  readonly detail: string;
}

export interface WindowFailedFact {
  readonly deviceId: string;
  readonly detail: string;
}

/** why: the driver's two calls, each bounded and scoped as the driver scopes its own. */
export interface BootCommands {
  readonly simctl: (args: readonly string[], timeoutMs: number) => Promise<ProcessOutcome>;
  readonly open: (args: readonly string[], timeoutMs: number) => Promise<ProcessOutcome>;
}

/** why: what a boot is followed by, in the order the driver runs it; each step only reports a failure. */
export interface AfterBoot {
  readonly silent: boolean;
  readonly headless: boolean;
  readonly commands: BootCommands;
  readonly onSilenceFailed: ((fact: SilenceFailedFact) => void) | undefined;
  readonly onWindowFailed: ((fact: WindowFailedFact) => void) | undefined;
}

export async function runAfterBoot(
  after: AfterBoot,
  udid: string,
  deviceId: string,
): Promise<void> {
  if (after.silent) {
    await silenceSimulator(after.commands, udid, deviceId, after.onSilenceFailed);
  }
  if (!after.headless) {
    await openSimulatorWindow(after.commands, udid, deviceId, after.onWindowFailed);
  }
}

/** why: `ios.simulator.audio: false`; the device stays in use when this fails, so it only reports. */
async function silenceSimulator(
  commands: BootCommands,
  udid: string,
  deviceId: string,
  onFailed: ((fact: SilenceFailedFact) => void) | undefined,
): Promise<void> {
  for (const command of [
    ["-s", VOLUME_STATE_KEY, "0"],
    ["-p", VOLUME_STATE_KEY],
  ]) {
    const detail = await failureDetail(() =>
      commands.simctl(["spawn", udid, "notifyutil", ...command], COMMAND_TIMEOUT_MS),
    );
    if (detail !== undefined) {
      onFailed?.({ deviceId, detail: detail.text });
      return;
    }
  }
}

/** why: `ios.simulator.headless: false`; a window is a courtesy to the operator, not a lease condition. */
async function openSimulatorWindow(
  commands: BootCommands,
  udid: string,
  deviceId: string,
  onFailed: ((fact: WindowFailedFact) => void) | undefined,
): Promise<void> {
  const open = (args: readonly string[]) =>
    failureDetail(() => commands.open(["-g", ...args], COMMAND_TIMEOUT_MS));
  const hub = await open([
    "-b",
    DEVICEHUB_BUNDLE_ID,
    "--args",
    "-shutdownStartedDevicesOnQuit",
    "NO",
  ]);
  // why: a non-zero exit means DeviceHub is not installed; any other failure leaves no window to fill.
  const hubMissing = hub?.refused === true;
  if (hub !== undefined && !hubMissing) {
    onFailed?.({ deviceId, detail: hub.text.trim() });
    return;
  }
  const window = hubMissing
    ? await open([
        "-b",
        SIMULATOR_APP_BUNDLE_ID,
        "--args",
        "-CurrentDeviceUDID",
        udid,
        "-DetachOnWindowClose",
        "YES",
        "-DetachOnAppQuit",
        "YES",
      ])
    : await open([`devices://manage/select?id=${udid}`]);
  if (window !== undefined) onFailed?.({ deviceId, detail: window.text.trim() });
}

/**
 * why: never throws; `refused` tells an app that exited non-zero from a call that did not finish,
 * and `undefined` is a command that exited 0.
 */
async function failureDetail(
  run: () => Promise<ProcessOutcome>,
): Promise<{ readonly text: string; readonly refused: boolean } | undefined> {
  try {
    const outcome = await run();
    if (outcome.kind === "timed-out") return { text: "timed out", refused: false };
    return outcome.result.code === 0 ? undefined : { text: outcome.result.stderr, refused: true };
  } catch (error: unknown) {
    return { text: error instanceof Error ? error.message : String(error), refused: false };
  }
}
