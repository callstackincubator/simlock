import type { ProcessHandle } from "../../ports/index.js";

export interface AndroidDriverData {
  /** why: a copy's own folder, `<root>/<device id>`; absent for a device made before copies, whose AVD is `<root>/<avdName>.avd`. */
  readonly avdHome?: string;
  readonly avdName: string;
  readonly configHash: string;
  readonly imageIdentity?: string;
  readonly port: number;
  readonly serial: string;
}

export function isAndroidDriverData(value: unknown): value is AndroidDriverData {
  return (
    typeof value === "object" &&
    value !== null &&
    "avdName" in value &&
    "configHash" in value &&
    "port" in value &&
    "serial" in value &&
    typeof value.avdName === "string" &&
    typeof value.configHash === "string" &&
    typeof value.port === "number" &&
    typeof value.serial === "string" &&
    (!("avdHome" in value) || value.avdHome === undefined || typeof value.avdHome === "string")
  );
}

export interface DeviceState {
  handle: ProcessHandle | undefined;
  imageIdentity: string;
  /**
   * why: The console port this process reserved for the device: taken at its first `prepare` boot
   * here, kept across its stops so no other device is handed the port its record names while
   * this process runs, and given back by `destroy`. Nothing persists it, so after a restart a
   * device holds none until it boots again (#52). A recovery boot reserves nothing.
   */
  port: number | undefined;
  /**
   * why: Set for a device this process never provisioned: after a restart an emulator it never
   * started may still run the AVD, so `destroy` looks for one.
   */
  restored?: boolean;
}

export interface SystemImage {
  readonly abi: string;
  readonly apiLevel: string;
  readonly path: string;
  readonly sourceApiLevel?: string | undefined;
  readonly tag: string;
  readonly tags: readonly string[];
  readonly version: string;
}
