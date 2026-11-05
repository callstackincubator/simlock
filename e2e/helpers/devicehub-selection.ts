import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEVICEHUB_DEFAULTS = "com.apple.dt.Devices";

/**
 * why: DeviceHub keeps the UDID it was last told to select as quoted data under
 * `lastSelectedDeviceIdentifier`; `defaults read` prints only the first and last bytes of data that
 * long, so the exported plist is the whole value.
 */
export function selectedDeviceFromPlist(plist: string): string {
  const base64 =
    /<key>lastSelectedDeviceIdentifier<\/key>\s*<data>([^<]*)<\/data>/.exec(plist)?.[1] ?? "";
  return Buffer.from(base64.replaceAll(/\s/g, ""), "base64").toString("utf8").replaceAll('"', "");
}

/** why: reading the exported defaults needs no permission, unlike asking DeviceHub. */
export async function selectedInDeviceHub(): Promise<string> {
  const { stdout } = await execFileAsync("defaults", ["export", DEVICEHUB_DEFAULTS, "-"]);
  return selectedDeviceFromPlist(stdout);
}
