export interface AndroidDriverData {
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
    typeof value.serial === "string"
  );
}
