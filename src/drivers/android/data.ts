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
